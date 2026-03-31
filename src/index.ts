import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { spawnAgent } from "./agents/runner.ts";
import type { Config } from "./config/config.ts";
import { loadConfig } from "./config/config.ts";
import { createLogger, type Logger } from "./config/logger.ts";
import { type AppDatabase, createDatabase } from "./db/database.ts";
import { GitLabService } from "./gitlab/service.ts";
import { createJobQueue, type JobQueue } from "./jobs/queue.ts";
import type { JobPayload } from "./jobs/types.ts";
import { createWorker, type Worker } from "./jobs/worker.ts";
import { createApp } from "./server/routes.ts";
import { createSessionManager, type SessionManager } from "./sessions/manager.ts";
import type { AppError } from "./types/errors.ts";
import { queueError } from "./types/errors.ts";
import type { AgentKind } from "./types/events.ts";
import { err, ok, type Result } from "./types/result.ts";

const WORKER_IDLE_DELAY_MS = 250;
const SHUTDOWN_SIGNALS: readonly ("SIGINT" | "SIGTERM")[] = ["SIGINT", "SIGTERM"];

export interface StoppableServer {
  stop(closeActiveConnections?: boolean): void;
}

export interface SignalRegistrar {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code: number): void;
}

export interface AppRuntime {
  readonly config: Config;
  readonly logger: Logger;
  readonly database: AppDatabase;
  readonly queue: JobQueue;
  readonly sessions: SessionManager;
  readonly gitlab: GitLabService;
  readonly worker: Worker;
  readonly app: ReturnType<typeof createApp>;
  readonly stopWorkers: () => Promise<void>;
}

export interface RuntimeLease {
  readonly path: string;
  release(): Result<void, AppError>;
}

type JobRecoveryQueue = Pick<JobQueue, "requeueProcessing">;
type ProcessAliveProbe = (pid: number) => Result<boolean, AppError>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function formatUnknownError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function errorCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return null;
  }

  const code = cause.code;
  return typeof code === "string" ? code : null;
}

function parseLeaseOwnerPid(contents: string): number | null {
  const trimmed = contents.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

export function resolveRuntimeLeasePath(databasePath: string): string {
  if (databasePath === ":memory:") {
    return join(process.cwd(), ".runtime.lock");
  }

  return `${databasePath}.runtime.lock`;
}

export function isProcessAlive(pid: number): Result<boolean, AppError> {
  try {
    process.kill(pid, 0);
    return ok(true);
  } catch (cause) {
    const code = errorCode(cause);
    if (code === "ESRCH") {
      return ok(false);
    }

    if (code === "EPERM") {
      return ok(true);
    }

    return err(queueError(`Failed to probe runtime owner process: ${formatUnknownError(cause)}`));
  }
}

export function acquireRuntimeLease(
  leasePath: string,
  processAlive: ProcessAliveProbe = isProcessAlive,
  ownerPid = process.pid,
): Result<RuntimeLease, AppError> {
  try {
    writeFileSync(leasePath, `${ownerPid}\n`, { flag: "wx" });
    return ok({
      path: leasePath,
      release() {
        try {
          const currentOwner = parseLeaseOwnerPid(readFileSync(leasePath, "utf8"));
          if (currentOwner !== ownerPid) {
            return ok(undefined);
          }

          unlinkSync(leasePath);
          return ok(undefined);
        } catch (cause) {
          if (errorCode(cause) === "ENOENT") {
            return ok(undefined);
          }

          return err(queueError(`Failed to release runtime lease: ${formatUnknownError(cause)}`));
        }
      },
    });
  } catch (cause) {
    if (errorCode(cause) !== "EEXIST") {
      return err(queueError(`Failed to acquire runtime lease: ${formatUnknownError(cause)}`));
    }
  }

  let existingOwnerPid: number | null = null;
  try {
    existingOwnerPid = parseLeaseOwnerPid(readFileSync(leasePath, "utf8"));
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") {
      return err(queueError(`Failed to inspect runtime lease: ${formatUnknownError(cause)}`));
    }
  }

  if (existingOwnerPid !== null) {
    const aliveResult = processAlive(existingOwnerPid);
    if (aliveResult.isErr()) {
      return err(aliveResult.error);
    }

    if (aliveResult.value) {
      return err(queueError("Another runtime instance is already active"));
    }
  }

  try {
    unlinkSync(leasePath);
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") {
      return err(queueError(`Failed to clear stale runtime lease: ${formatUnknownError(cause)}`));
    }
  }

  return acquireRuntimeLease(leasePath, processAlive, ownerPid);
}

export function workspaceSuffix(payload: JobPayload): string {
  switch (payload.kind) {
    case "handle_mention":
      return `issue-${payload.issueIid}`;
    case "handle_mr_mention":
      return `mr-${payload.mrIid}`;
    case "review_mr":
      return `mr-${payload.mrIid}`;
  }
}

function branchForPayload(payload: JobPayload): {
  readonly name: string;
  readonly create: boolean;
} {
  switch (payload.kind) {
    case "handle_mention":
      return { name: `agent/issue-${payload.issueIid}`, create: true };
    case "handle_mr_mention":
      return { name: payload.sourceBranch, create: false };
    case "review_mr":
      return { name: payload.sourceBranch, create: false };
  }
}

export function prepareWorkspace(
  payload: JobPayload,
  baseWorkDir: string,
  gitlabHost: string,
): Result<string, AppError> {
  try {
    const projectDir = sanitizePathSegment(payload.project);
    const workDir = join(baseWorkDir, projectDir, workspaceSuffix(payload));
    mkdirSync(workDir, { recursive: true });

    const gitDir = join(workDir, ".git");
    if (!existsSync(gitDir)) {
      const cloneResult = Bun.spawnSync(["glab", "repo", "clone", payload.project, "."], {
        cwd: workDir,
        env: { ...process.env, GITLAB_HOST: gitlabHost },
      });
      if (cloneResult.exitCode !== 0) {
        const stderr = cloneResult.stderr.toString().trim();
        return err(queueError(`Failed to clone repository: ${stderr || "unknown error"}`));
      }

      const branch = branchForPayload(payload);
      const checkoutArgs = branch.create
        ? ["git", "checkout", "-b", branch.name]
        : ["git", "checkout", branch.name];
      const checkoutResult = Bun.spawnSync(checkoutArgs, { cwd: workDir });
      if (checkoutResult.exitCode !== 0) {
        const stderr = checkoutResult.stderr.toString().trim();
        return err(
          queueError(`Failed to checkout branch ${branch.name}: ${stderr || "unknown error"}`),
        );
      }
    }

    return ok(workDir);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(queueError(`Failed to prepare workspace: ${message}`));
  }
}

function createWorkerEnv(config: Config): Readonly<Record<string, string>> {
  return {
    CLAUDE_PATH: config.claudePath,
    CODEX_PATH: config.codexPath,
    GEMINI_PATH: config.geminiPath,
    GITLAB_HOST: config.gitlabHost,
    GITLAB_TOKEN: config.gitlabToken,
  };
}

export function startWorkerLanes(
  worker: Worker,
  logger: Logger,
  agentLanes: ReadonlyArray<{ readonly agent: AgentKind; readonly count: number }>,
  idleDelayMs = WORKER_IDLE_DELAY_MS,
): () => Promise<void> {
  let active = true;
  const lanePromises: Promise<void>[] = [];

  async function runLane(lane: number, agentKind: AgentKind): Promise<void> {
    while (active) {
      let result: Awaited<ReturnType<Worker["runNextJob"]>>;
      try {
        result = await worker.runNextJob(agentKind);
      } catch (cause) {
        logger.error(
          { error: queueError(`Unhandled worker failure: ${formatUnknownError(cause)}`), lane },
          "Worker lane threw unexpectedly",
        );
        await sleep(idleDelayMs);
        continue;
      }

      if (result.isErr()) {
        logger.error({ error: result.error, lane }, "Worker lane failed");
        await sleep(idleDelayMs);
        continue;
      }

      if (result.value === null) {
        await sleep(idleDelayMs);
      }
    }
  }

  let laneIndex = 1;
  for (const { agent, count } of agentLanes) {
    for (let i = 0; i < count; i += 1) {
      lanePromises.push(runLane(laneIndex, agent));
      laneIndex += 1;
    }
  }

  return async () => {
    active = false;
    await Promise.all(lanePromises);
  };
}

export function resolveMigrationsFolder(runtimeDir: string): string {
  return join(runtimeDir, "db", "migrations");
}

export function registerShutdownHandlers(
  runtime: Pick<AppRuntime, "logger" | "stopWorkers">,
  server: StoppableServer,
  signalRegistrar: SignalRegistrar = process,
): void {
  let shuttingDown = false;

  for (const signal of SHUTDOWN_SIGNALS) {
    signalRegistrar.on(signal, () => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      runtime.logger.info({ signal }, "Stopping HTTP server and worker lanes");
      server.stop(true);
      void runtime.stopWorkers().finally(() => {
        signalRegistrar.exit(0);
      });
    });
  }
}

export function recoverInterruptedJobs(
  queue: JobRecoveryQueue,
  logger: Logger,
): Result<number, AppError> {
  const recoveryResult = queue.requeueProcessing();
  if (recoveryResult.isErr()) {
    return err(recoveryResult.error);
  }

  if (recoveryResult.value > 0) {
    logger.warn({ recoveredJobs: recoveryResult.value }, "Re-queued interrupted processing jobs");
  }

  return ok(recoveryResult.value);
}

export function ensureDatabaseDirectory(databasePath: string): Result<void, AppError> {
  if (databasePath === ":memory:") {
    return ok(undefined);
  }

  try {
    mkdirSync(dirname(databasePath), { recursive: true });
    return ok(undefined);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(queueError(`Failed to prepare database directory: ${message}`));
  }
}

export function ensureWorkDirectory(workDir: string): Result<void, AppError> {
  try {
    mkdirSync(workDir, { recursive: true });
    return ok(undefined);
  } catch (cause) {
    return err(queueError(`Failed to prepare workspace root: ${formatUnknownError(cause)}`));
  }
}

export function openDatabaseWithMigrations(
  databasePath: string,
  runtimeDir: string,
): Result<AppDatabase, AppError> {
  try {
    const database = createDatabase(databasePath);
    migrate(database, { migrationsFolder: resolveMigrationsFolder(runtimeDir) });
    return ok(database);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(queueError(`Failed to initialize database: ${message}`));
  }
}

export function createRuntime(config: Config): Result<AppRuntime, AppError> {
  const logger = createLogger(config.logLevel);
  const databaseDirectoryResult = ensureDatabaseDirectory(config.databasePath);
  if (databaseDirectoryResult.isErr()) {
    return err(databaseDirectoryResult.error);
  }

  const runtimeLeaseResult = acquireRuntimeLease(resolveRuntimeLeasePath(config.databasePath));
  if (runtimeLeaseResult.isErr()) {
    return err(runtimeLeaseResult.error);
  }

  const runtimeLease = runtimeLeaseResult.value;
  const releaseRuntimeLease = (): void => {
    const releaseResult = runtimeLease.release();
    if (releaseResult.isErr()) {
      logger.warn(
        { error: releaseResult.error, leasePath: runtimeLease.path },
        "Failed to release runtime lease",
      );
    }
  };

  const databaseResult = openDatabaseWithMigrations(config.databasePath, import.meta.dir);
  if (databaseResult.isErr()) {
    releaseRuntimeLease();
    return err(databaseResult.error);
  }

  const database = databaseResult.value;
  const queue = createJobQueue(database);
  const recoveryResult = recoverInterruptedJobs(queue, logger);
  if (recoveryResult.isErr()) {
    releaseRuntimeLease();
    return err(recoveryResult.error);
  }

  const sessions = createSessionManager(database);
  const gitlab = new GitLabService(
    config.gitlabToken,
    config.gitlabHost,
    logger,
    config.botUsername,
  );
  const workDir = join(process.cwd(), ".workspaces");
  const workDirectoryResult = ensureWorkDirectory(workDir);
  if (workDirectoryResult.isErr()) {
    releaseRuntimeLease();
    return err(workDirectoryResult.error);
  }

  process.once("exit", releaseRuntimeLease);

  const worker = createWorker({
    queue,
    sessions,
    gitlab,
    logger,
    defaultAgent: config.defaultAgent,
    workDir,
    gitlabHost: config.gitlabHost,
    prepareWorkspace,
    env: createWorkerEnv(config),
    timeoutMs: config.agentTimeoutMs,
    spawnAgent,
  });

  const app = createApp(
    config,
    logger,
    new Map(),
    {},
    {
      enqueueJob: queue.enqueue.bind(queue),
      addReaction: gitlab.addReaction.bind(gitlab),
      closeSessionsByContext: (contextKind, project, iid) =>
        sessions.closeByContext(contextKind, project, iid),
      workDir,
    },
  );
  const stopWorkerLanes = startWorkerLanes(worker, logger, [
    { agent: "claude", count: config.claudeConcurrency },
    { agent: "codex", count: config.codexConcurrency },
    { agent: "gemini", count: config.geminiConcurrency },
  ]);
  const stopWorkers = async () => {
    worker.stop();
    await stopWorkerLanes();
  };

  logger.info(
    {
      databasePath: config.databasePath,
      port: config.port,
      recoveredJobs: recoveryResult.value,
      claudeConcurrency: config.claudeConcurrency,
      codexConcurrency: config.codexConcurrency,
      geminiConcurrency: config.geminiConcurrency,
    },
    "Runtime initialized",
  );

  return ok({
    config,
    logger,
    database,
    queue,
    sessions,
    gitlab,
    worker,
    app,
    stopWorkers,
  });
}

if (import.meta.main) {
  const configResult = loadConfig();
  if (configResult.isErr()) {
    // biome-ignore lint/suspicious/noConsole: logger unavailable before config loads
    console.error(`Fatal: ${configResult.error.message}`);
    process.exit(1);
  }

  const runtimeResult = createRuntime(configResult.value);
  if (runtimeResult.isErr()) {
    // biome-ignore lint/suspicious/noConsole: logger unavailable before runtime initializes
    console.error(`Fatal: ${runtimeResult.error.message}`);
    process.exit(1);
  }

  const runtime = runtimeResult.value;
  const server = Bun.serve({
    port: runtime.config.port,
    fetch: runtime.app.fetch,
  });

  registerShutdownHandlers(runtime, server);
}
