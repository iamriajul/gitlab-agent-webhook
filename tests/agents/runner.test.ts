import { describe, expect, it } from "bun:test";
import { buildSpawnEnv, spawnAgent } from "../../src/agents/runner.ts";
import type { AgentCommand, AgentConfig, SpawnedAgentHandle } from "../../src/agents/types.ts";
import { agentError } from "../../src/types/errors.ts";
import { err, ok, type Result } from "../../src/types/result.ts";

function createConfig(overrides: Partial<AgentConfig> & Pick<AgentConfig, "agent">): AgentConfig {
  return {
    agent: overrides.agent,
    workDir: overrides.workDir ?? "/tmp/project",
    prompt: overrides.prompt ?? "Fix the failing tests",
    sessionId: overrides.sessionId,
    systemPrompt: overrides.systemPrompt ?? "Autonomous instructions",
    env: overrides.env ?? {},
    timeoutMs: overrides.timeoutMs ?? 25,
  };
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function createHandle(
  exitCode: Promise<number>,
  stdout: string,
  stderr: string,
): SpawnedAgentHandle & { readonly killed: { value: boolean } } {
  const killed = { value: false };

  return {
    pid: 42,
    exited: exitCode,
    stdout: streamFromText(stdout),
    stderr: streamFromText(stderr),
    kill() {
      killed.value = true;
    },
    killed,
  };
}

describe("spawnAgent", () => {
  it("builds child env from an allowlist plus explicit overrides", () => {
    const env = buildSpawnEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/service",
        LANG: "en_US.UTF-8",
        http_proxy: "http://proxy.local:8080",
        https_proxy: "https://proxy.local:8443",
        no_proxy: "localhost,127.0.0.1",
        GITLAB_WEBHOOK_SECRET: "super-secret",
        DATABASE_URL: "sqlite:///tmp.db",
      },
      {
        GITLAB_TOKEN: "config-token",
        PATH: "/config/path",
      },
      {
        GEMINI_SYSTEM_MD: "1",
        PATH: "/command/path",
      },
    );

    expect(env).toEqual({
      PATH: "/command/path",
      HOME: "/home/service",
      LANG: "en_US.UTF-8",
      http_proxy: "http://proxy.local:8080",
      https_proxy: "https://proxy.local:8443",
      no_proxy: "localhost,127.0.0.1",
      GITLAB_TOKEN: "config-token",
      GEMINI_SYSTEM_MD: "1",
    });
    expect(env["GITLAB_WEBHOOK_SECRET"]).toBeUndefined();
    expect(env["DATABASE_URL"]).toBeUndefined();
  });

  it("returns command results for a successful run", async () => {
    const spawnedCommands: AgentCommand[] = [];
    let currentTime = 100;
    const handle = createHandle(
      Promise.resolve(0),
      '{"type":"session","id":"claude-session-7"}\nall done',
      "",
    );

    const processResult = spawnAgent(createConfig({ agent: { kind: "claude" } }), {
      now: () => {
        currentTime += 5;
        return currentTime;
      },
      spawn(command): Result<SpawnedAgentHandle, ReturnType<typeof agentError>> {
        spawnedCommands.push(command);
        return ok(handle);
      },
      setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
      clearTimeout: (timeoutId) => globalThis.clearTimeout(timeoutId),
    });

    expect(processResult.isOk()).toBe(true);
    if (processResult.isErr()) {
      return;
    }

    expect(spawnedCommands).toHaveLength(1);
    const recordedCommand = spawnedCommands[0];
    if (recordedCommand === undefined) {
      return;
    }

    expect(recordedCommand.command).toBe("claude");

    const result = await processResult.value.result;
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.exitCode).toBe(0);
    expect(result.value.sessionId).toBe("claude-session-7");
    expect(result.value.stdout).toContain("all done");
    expect(result.value.stderr).toBe("");
    expect(result.value.durationMs).toBeGreaterThan(0);
  });

  it("captures non-zero exit codes without discarding output", async () => {
    const handle = createHandle(Promise.resolve(23), "", "command failed");

    const processResult = spawnAgent(createConfig({ agent: { kind: "codex" } }), {
      now: () => 200,
      spawn: () => ok(handle),
      setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
      clearTimeout: (timeoutId) => globalThis.clearTimeout(timeoutId),
    });

    expect(processResult.isOk()).toBe(true);
    if (processResult.isErr()) {
      return;
    }

    const result = await processResult.value.result;
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.exitCode).toBe(23);
    expect(result.value.stderr).toBe("command failed");
  });

  it("returns an agent error when spawning fails", () => {
    const processResult = spawnAgent(createConfig({ agent: { kind: "gemini" } }), {
      now: () => 0,
      spawn: () => err(agentError("spawn failed", "gemini", -1)),
      setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
      clearTimeout: (timeoutId) => globalThis.clearTimeout(timeoutId),
    });

    expect(processResult.isErr()).toBe(true);
    if (processResult.isOk()) {
      return;
    }

    expect(processResult.error).toEqual(agentError("spawn failed", "gemini", -1));
  });

  it("kills the process and returns an error on timeout", async () => {
    let resolveExitCode = (_exitCode: number) => {};
    const exitCode = new Promise<number>((resolve) => {
      resolveExitCode = resolve;
    });
    const handle = createHandle(exitCode, "", "");

    const processResult = spawnAgent(createConfig({ agent: { kind: "claude" }, timeoutMs: 10 }), {
      now: () => 50,
      spawn: () => ok(handle),
      setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
      clearTimeout: (timeoutId) => globalThis.clearTimeout(timeoutId),
    });

    expect(processResult.isOk()).toBe(true);
    if (processResult.isErr()) {
      return;
    }

    const result = await processResult.value.result;
    resolveExitCode(0);

    expect(handle.killed.value).toBe(true);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }

    expect(result.error).toEqual(agentError("Agent timed out after 10ms", "claude", -1));
  });

  it("returns an error when output reading fails", async () => {
    const brokenStream = new ReadableStream<Uint8Array>({
      pull() {
        return Promise.reject(new Error("stream broke"));
      },
    });

    const handle: SpawnedAgentHandle = {
      pid: 99,
      exited: Promise.resolve(0),
      stdout: brokenStream,
      stderr: streamFromText(""),
      kill() {},
    };

    const processResult = spawnAgent(createConfig({ agent: { kind: "codex" } }), {
      now: () => 0,
      spawn: () => ok(handle),
      setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
      clearTimeout: (timeoutId) => globalThis.clearTimeout(timeoutId),
    });

    expect(processResult.isOk()).toBe(true);
    if (processResult.isErr()) {
      return;
    }

    const result = await processResult.value.result;
    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }

    expect(result.error).toEqual(
      agentError("Failed to read agent output: stream broke", "codex", -1),
    );
  });

  it("drains stdout before waiting for exit to avoid backpressure deadlocks", async () => {
    let resolveExitCode = (_exitCode: number) => {};
    const exitCode = new Promise<number>((resolve) => {
      resolveExitCode = resolve;
    });
    let readStarted = false;

    const stdout = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          readStarted = true;
          controller.enqueue(new TextEncoder().encode("stream output"));
          controller.close();
          resolveExitCode(0);
        },
      },
      { highWaterMark: 0 },
    );

    const handle: SpawnedAgentHandle = {
      pid: 123,
      exited: exitCode,
      stdout,
      stderr: streamFromText(""),
      kill() {},
    };

    const processResult = spawnAgent(createConfig({ agent: { kind: "claude" }, timeoutMs: 30 }), {
      now: () => 0,
      spawn: () => ok(handle),
      setTimeout: () => globalThis.setTimeout(() => {}, 60_000),
      clearTimeout: (timeoutId) => globalThis.clearTimeout(timeoutId),
    });

    expect(processResult.isOk()).toBe(true);
    if (processResult.isErr()) {
      return;
    }

    const pendingMarker = Symbol("pending");
    const raceResult = await Promise.race([
      processResult.value.result,
      new Promise<typeof pendingMarker>((resolve) => {
        globalThis.setTimeout(() => resolve(pendingMarker), 5);
      }),
    ]);

    expect(raceResult).not.toBe(pendingMarker);
    if (raceResult === pendingMarker) {
      expect(readStarted).toBe(true);
      return;
    }

    expect(raceResult.isOk()).toBe(true);
    if (raceResult.isErr()) {
      return;
    }

    expect(raceResult.value.exitCode).toBe(0);
    expect(raceResult.value.stdout).toContain("stream output");
  });

  it("keeps timeout active until stream draining completes", async () => {
    let timeoutHandler: (() => void) | null = null;
    let timeoutCleared = false;

    const blockedStdout = new ReadableStream<Uint8Array>({
      start() {},
    });

    const handle: SpawnedAgentHandle = {
      pid: 5,
      exited: Promise.resolve(0),
      stdout: blockedStdout,
      stderr: streamFromText(""),
      kill() {},
    };

    const processResult = spawnAgent(createConfig({ agent: { kind: "claude" }, timeoutMs: 10 }), {
      now: () => 0,
      spawn: () => ok(handle),
      setTimeout: (handler) => {
        timeoutHandler = handler;
        return globalThis.setTimeout(() => {}, 60_000);
      },
      clearTimeout: (timeoutId) => {
        timeoutCleared = true;
        globalThis.clearTimeout(timeoutId);
      },
    });

    expect(processResult.isOk()).toBe(true);
    if (processResult.isErr()) {
      return;
    }

    await Promise.resolve();
    expect(timeoutCleared).toBe(false);

    const triggerTimeout = timeoutHandler ?? (() => {});
    triggerTimeout();
    const result = await processResult.value.result;
    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }

    expect(result.error).toEqual(agentError("Agent timed out after 10ms", "claude", -1));
  });
});
