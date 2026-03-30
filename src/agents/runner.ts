import type { AppError } from "../types/errors.ts";
import { agentError } from "../types/errors.ts";
import type { Result } from "../types/result.ts";
import { err, fromPromise, fromThrowable, ok } from "../types/result.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { geminiAdapter } from "./gemini.ts";
import type {
  AgentAdapter,
  AgentCommand,
  AgentConfig,
  AgentProcess,
  AgentResult,
  SpawnedAgentHandle,
} from "./types.ts";

interface RunnerDependencies {
  readonly now: () => number;
  readonly spawn: (
    command: AgentCommand,
    config: AgentConfig,
  ) => Result<SpawnedAgentHandle, AppError>;
  readonly setTimeout: (handler: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (timeoutId: ReturnType<typeof setTimeout>) => void;
}

const BLOCKED_PARENT_ENV_KEYS: ReadonlySet<string> = new Set([
  "GITLAB_WEBHOOK_SECRET",
  "GITLAB_TOKEN",
  "BOT_USERNAME",
  "DATABASE_PATH",
  "DEFAULT_AGENT",
  "LOG_LEVEL",
  "WORKER_CONCURRENCY",
  "AGENT_TIMEOUT_MS",
  "PORT",
]);

function formatUnknownError(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }

  return String(cause);
}

function getAgentAdapter(config: AgentConfig): AgentAdapter {
  switch (config.agent.kind) {
    case "claude":
      return claudeAdapter;
    case "codex":
      return codexAdapter;
    case "gemini":
      return geminiAdapter;
  }
}

export function buildSpawnEnv(
  parentEnv: NodeJS.ProcessEnv,
  configEnv: Readonly<Record<string, string>>,
  commandEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const filteredParentEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value !== undefined && !BLOCKED_PARENT_ENV_KEYS.has(key)) {
      filteredParentEnv[key] = value;
    }
  }

  return {
    ...filteredParentEnv,
    ...configEnv,
    ...commandEnv,
  };
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Result<string, AppError>> {
  return fromPromise(new Response(stream).text(), (cause) =>
    agentError(`Failed to read agent output: ${formatUnknownError(cause)}`, "unknown", -1),
  );
}

async function collectResult(
  config: AgentConfig,
  adapter: AgentAdapter,
  handle: SpawnedAgentHandle,
  startTime: number,
  deps: RunnerDependencies,
): Promise<Result<AgentResult, AppError>> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutResult = new Promise<Result<AgentResult, AppError>>((resolve) => {
    timeoutId = deps.setTimeout(() => {
      handle.kill();
      resolve(
        err(agentError(`Agent timed out after ${config.timeoutMs}ms`, config.agent.kind, -1)),
      );
    }, config.timeoutMs);
  });

  const processResult = (async () => {
    // Drain output concurrently so child processes do not block on full pipe buffers.
    const stdoutPromise = readStream(handle.stdout);
    const stderrPromise = readStream(handle.stderr);

    const exitCode = await handle.exited;
    const stdoutResult = await stdoutPromise;
    if (stdoutResult.isErr()) {
      return err(agentError(stdoutResult.error.message, config.agent.kind, -1));
    }

    const stderrResult = await stderrPromise;
    if (stderrResult.isErr()) {
      return err(agentError(stderrResult.error.message, config.agent.kind, -1));
    }

    const combinedOutput = `${stdoutResult.value}\n${stderrResult.value}`;

    return ok({
      exitCode,
      sessionId: adapter.parseSessionId(combinedOutput),
      stdout: stdoutResult.value,
      stderr: stderrResult.value,
      durationMs: deps.now() - startTime,
    });
  })();

  return Promise.race([processResult, timeoutResult]).finally(() => {
    if (timeoutId !== null) {
      deps.clearTimeout(timeoutId);
    }
  });
}

const defaultDependencies: RunnerDependencies = {
  now: () => Date.now(),
  spawn(command, config) {
    return fromThrowable(
      () =>
        Bun.spawn([command.command, ...command.args], {
          cwd: config.workDir,
          env: buildSpawnEnv(process.env, config.env, command.env),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      (cause) => agentError(formatUnknownError(cause), config.agent.kind, -1),
    )().map((handle) => ({
      pid: handle.pid,
      exited: handle.exited,
      stdout: handle.stdout,
      stderr: handle.stderr,
      kill() {
        handle.kill();
      },
    }));
  },
  setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
  clearTimeout: (timeoutId) => globalThis.clearTimeout(timeoutId),
};

export function spawnAgent(
  config: AgentConfig,
  dependencies: RunnerDependencies = defaultDependencies,
): Result<AgentProcess, AppError> {
  const adapter = getAgentAdapter(config);
  const command = adapter.buildCommand(config);
  const startTime = dependencies.now();
  const spawnResult = dependencies.spawn(command, config);

  if (spawnResult.isErr()) {
    return err(spawnResult.error);
  }

  return ok({
    pid: spawnResult.value.pid,
    result: collectResult(config, adapter, spawnResult.value, startTime, dependencies),
    kill() {
      spawnResult.value.kill();
    },
  });
}
