import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pino from "pino";
import {
  acquireRuntimeLease,
  ensureDatabaseDirectory,
  ensureWorkDirectory,
  openDatabaseWithMigrations,
  recoverInterruptedJobs,
  registerShutdownHandlers,
  resolveMigrationsFolder,
  startWorkerLanes,
} from "../src/index.ts";
import { queueError } from "../src/types/errors.ts";
import { err, ok } from "../src/types/result.ts";

class FakeServer {
  readonly stopCalls: boolean[] = [];

  stop(closeActiveConnections?: boolean): void {
    this.stopCalls.push(closeActiveConnections ?? false);
  }
}

class FakeProcess {
  readonly handlers = new Map<"SIGINT" | "SIGTERM", () => void>();
  readonly exitCalls: number[] = [];

  on(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
    this.handlers.set(signal, listener);
  }

  exit(code: number): void {
    this.exitCalls.push(code);
  }

  emit(signal: "SIGINT" | "SIGTERM"): void {
    const listener = this.handlers.get(signal);
    if (listener !== undefined) {
      listener();
    }
  }
}

describe("resolveMigrationsFolder", () => {
  it("resolves to bundled migrations when running from dist", () => {
    expect(resolveMigrationsFolder("/workspace/project/dist")).toBe(
      join("/workspace/project", "dist", "db", "migrations"),
    );
  });

  it("resolves to colocated migrations when running from src", () => {
    expect(resolveMigrationsFolder("/workspace/project/src")).toBe(
      join("/workspace/project", "src", "db", "migrations"),
    );
  });
});

describe("registerShutdownHandlers", () => {
  it("waits for worker shutdown cleanup before exiting", async () => {
    const fakeProcess = new FakeProcess();
    const fakeServer = new FakeServer();
    let stopWorkersCalls = 0;
    let resolveStopWorkers: () => void = () => undefined;
    const stopWorkersPromise = new Promise<void>((resolve) => {
      resolveStopWorkers = resolve;
    });

    registerShutdownHandlers(
      {
        logger: pino({ enabled: false }),
        stopWorkers() {
          stopWorkersCalls += 1;
          return stopWorkersPromise;
        },
      },
      fakeServer,
      fakeProcess,
    );

    fakeProcess.emit("SIGINT");

    expect(stopWorkersCalls).toBe(1);
    expect(fakeServer.stopCalls).toEqual([true]);
    expect(fakeProcess.exitCalls).toEqual([]);

    resolveStopWorkers();
    await Promise.resolve();
    await Promise.resolve();

    expect(fakeProcess.exitCalls).toEqual([0]);
  });
});

describe("recoverInterruptedJobs", () => {
  it("requeues all processing jobs before worker lanes start", () => {
    const logger = pino({ enabled: false });
    const recoveryResult = recoverInterruptedJobs(
      {
        requeueProcessing() {
          return ok(2);
        },
      },
      logger,
    );

    expect(recoveryResult).toEqual(ok(2));
  });

  it("surfaces queue recovery failures", () => {
    const logger = pino({ enabled: false });
    const recoveryResult = recoverInterruptedJobs(
      {
        requeueProcessing() {
          return err(queueError("database locked"));
        },
      },
      logger,
    );

    expect(recoveryResult).toEqual(err(queueError("database locked")));
  });
});

describe("acquireRuntimeLease", () => {
  it("acquires a new lease when no other runtime owns it", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "glab-review-webhook-lease-"));
    const leasePath = join(tempRoot, "runtime.lock");

    const leaseResult = acquireRuntimeLease(leasePath, () => ok(false), 4321);
    expect(leaseResult.isOk()).toBe(true);
    if (leaseResult.isErr()) {
      rmSync(tempRoot, { force: true, recursive: true });
      return;
    }

    expect(readFileSync(leasePath, "utf8")).toBe("4321\n");
    expect(leaseResult.value.release()).toEqual(ok(undefined));
    expect(existsSync(leasePath)).toBe(false);

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it("rejects startup when another live runtime still owns the lease", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "glab-review-webhook-lease-"));
    const leasePath = join(tempRoot, "runtime.lock");
    Bun.write(leasePath, "9876\n");

    const leaseResult = acquireRuntimeLease(leasePath, (pid) => ok(pid === 9876), 4321);
    expect(leaseResult).toEqual(err(queueError("Another runtime instance is already active")));

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it("replaces a stale lease left behind by a dead runtime", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "glab-review-webhook-lease-"));
    const leasePath = join(tempRoot, "runtime.lock");
    Bun.write(leasePath, "9876\n");

    const leaseResult = acquireRuntimeLease(leasePath, () => ok(false), 4321);
    expect(leaseResult.isOk()).toBe(true);
    if (leaseResult.isErr()) {
      rmSync(tempRoot, { force: true, recursive: true });
      return;
    }

    expect(readFileSync(leasePath, "utf8")).toBe("4321\n");
    expect(leaseResult.value.release()).toEqual(ok(undefined));

    rmSync(tempRoot, { force: true, recursive: true });
  });
});

describe("ensureDatabaseDirectory", () => {
  it("creates the parent directory for a file-backed SQLite database", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "glab-review-webhook-db-dir-"));
    const databasePath = join(tempRoot, "nested", "glab-review.db");

    const prepareResult = ensureDatabaseDirectory(databasePath);
    expect(prepareResult).toEqual(ok(undefined));
    expect(existsSync(dirname(databasePath))).toBe(true);

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it("does nothing for in-memory SQLite", () => {
    const prepareResult = ensureDatabaseDirectory(":memory:");
    expect(prepareResult).toEqual(ok(undefined));
  });
});

describe("ensureWorkDirectory", () => {
  it("returns an error instead of throwing when the workspace root cannot be created", () => {
    const prepareResult = ensureWorkDirectory("/proc/glab-review-webhook-workspaces");

    expect(prepareResult.isErr()).toBe(true);
    if (prepareResult.isOk()) {
      return;
    }

    expect(prepareResult.error.kind).toBe("queue_error");
    expect(prepareResult.error.message).toContain("Failed to prepare workspace root");
  });
});

describe("openDatabaseWithMigrations", () => {
  it("returns an error instead of throwing when migrations cannot be loaded", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "glab-review-webhook-db-open-"));
    const databasePath = join(tempRoot, "glab-review.db");

    const databaseResult = openDatabaseWithMigrations(databasePath, join(tempRoot, "missing"));
    expect(databaseResult.isErr()).toBe(true);
    if (databaseResult.isOk()) {
      rmSync(tempRoot, { force: true, recursive: true });
      return;
    }

    expect(databaseResult.error.kind).toBe("queue_error");
    expect(databaseResult.error.message).toContain("Failed to initialize database");

    rmSync(tempRoot, { force: true, recursive: true });
  });
});

describe("startWorkerLanes", () => {
  it("polls for work without requeueing processing jobs while workers are live", async () => {
    let runNextJobCalls = 0;

    const stop = startWorkerLanes(
      {
        runNextJob() {
          runNextJobCalls += 1;
          return Promise.resolve(ok(null));
        },
        stop() {},
      },
      pino({ enabled: false }),
      [{ agent: "claude", count: 1 }],
      1,
    );

    await new Promise((resolve) => {
      globalThis.setTimeout(resolve, 10);
    });
    stop();

    expect(runNextJobCalls).toBeGreaterThan(0);
  });

  it("keeps polling after a thrown worker failure", async () => {
    let runNextJobCalls = 0;

    const stop = startWorkerLanes(
      {
        runNextJob() {
          runNextJobCalls += 1;
          if (runNextJobCalls === 1) {
            return Promise.reject(new Error("boom"));
          }

          return Promise.resolve(ok(null));
        },
        stop() {},
      },
      pino({ enabled: false }),
      [{ agent: "claude", count: 1 }],
      1,
    );

    await new Promise((resolve) => {
      globalThis.setTimeout(resolve, 10);
    });
    stop();

    expect(runNextJobCalls).toBeGreaterThan(1);
  });
});
