import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../src/db/database.ts";
import { createJobQueue } from "../../src/jobs/queue.ts";

let databasePath = "";

beforeEach(() => {
  databasePath = join(tmpdir(), `glab-review-webhook-queue-${crypto.randomUUID()}.sqlite`);
});

afterEach(() => {
  const cleanupPaths = [databasePath, `${databasePath}-shm`, `${databasePath}-wal`];

  for (const cleanupPath of cleanupPaths) {
    if (existsSync(cleanupPath)) {
      unlinkSync(cleanupPath);
    }
  }
});

describe("createJobQueue", () => {
  it("enqueues and finds a job by idempotency key", () => {
    const database = createDatabase(databasePath);
    const queue = createJobQueue(database);

    const enqueueResult = queue.enqueue({
      payload: { kind: "review_mr", project: "team/project", mrIid: 17 },
      idempotencyKey: "mr:team/project:17",
    });

    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const lookupResult = queue.findByIdempotencyKey("mr:team/project:17");

    expect(lookupResult.isOk()).toBe(true);
    if (lookupResult.isErr()) {
      return;
    }

    expect(lookupResult.value).not.toBeNull();
    if (lookupResult.value === null) {
      return;
    }

    expect(lookupResult.value.id).toBe(enqueueResult.value.id);
    expect(lookupResult.value.payload.kind).toBe("review_mr");
    expect(lookupResult.value.status).toBe("pending");
    expect(lookupResult.value.startedAt).toBeNull();
    expect(lookupResult.value.completedAt).toBeNull();
    expect(lookupResult.value.error).toBeNull();
    expect(lookupResult.value.retryCount).toBe(0);
  });

  it("returns the existing job for a duplicate idempotency key", () => {
    const database = createDatabase(databasePath);
    const queue = createJobQueue(database);

    const firstResult = queue.enqueue({
      payload: {
        kind: "handle_mention",
        project: "team/project",
        noteId: 200,
        issueIid: 18,
        prompt: "fix it",
        agentType: "codex",
      },
      idempotencyKey: "note:200",
    });
    const secondResult = queue.enqueue({
      payload: {
        kind: "handle_mention",
        project: "team/project",
        noteId: 200,
        issueIid: 18,
        prompt: "fix it",
        agentType: "codex",
      },
      idempotencyKey: "note:200",
    });

    expect(firstResult.isOk()).toBe(true);
    expect(secondResult.isOk()).toBe(true);
    if (firstResult.isErr() || secondResult.isErr()) {
      return;
    }

    expect(secondResult.value.id).toBe(firstResult.value.id);

    const claimResult = queue.claimNext();
    expect(claimResult.isOk()).toBe(true);
    if (claimResult.isErr()) {
      return;
    }

    expect(claimResult.value).not.toBeNull();
    if (claimResult.value === null) {
      return;
    }

    expect(claimResult.value.id).toBe(firstResult.value.id);
  });

  it("claims the oldest pending job and marks it as processing", () => {
    const database = createDatabase(databasePath);
    const queue = createJobQueue(database);

    queue.enqueue({
      payload: { kind: "review_mr", project: "team/project", mrIid: 10 },
      idempotencyKey: "mr:10",
    });
    queue.enqueue({
      payload: { kind: "review_mr", project: "team/project", mrIid: 11 },
      idempotencyKey: "mr:11",
    });

    const claimResult = queue.claimNext();

    expect(claimResult.isOk()).toBe(true);
    if (claimResult.isErr()) {
      return;
    }

    expect(claimResult.value).not.toBeNull();
    if (claimResult.value === null) {
      return;
    }

    expect(claimResult.value.payload.kind).toBe("review_mr");
    if (claimResult.value.payload.kind !== "review_mr") {
      return;
    }

    expect(claimResult.value.payload.mrIid).toBe(10);
    expect(claimResult.value.status).toBe("processing");
    expect(claimResult.value.startedAt instanceof Date).toBe(true);
  });

  it("completes a claimed job", () => {
    const database = createDatabase(databasePath);
    const queue = createJobQueue(database);

    queue.enqueue({
      payload: { kind: "review_mr", project: "team/project", mrIid: 12 },
      idempotencyKey: "mr:12",
    });

    const claimResult = queue.claimNext();
    expect(claimResult.isOk()).toBe(true);
    if (claimResult.isErr() || claimResult.value === null) {
      return;
    }

    const completeResult = queue.complete(claimResult.value.id);
    expect(completeResult.isOk()).toBe(true);
    if (completeResult.isErr()) {
      return;
    }

    expect(completeResult.value.status).toBe("completed");
    expect(completeResult.value.completedAt instanceof Date).toBe(true);
    expect(completeResult.value.error).toBeNull();
  });

  it("fails a claimed job and increments retry count", () => {
    const database = createDatabase(databasePath);
    const queue = createJobQueue(database);

    queue.enqueue({
      payload: {
        kind: "handle_mr_mention",
        project: "team/project",
        noteId: 300,
        mrIid: 42,
        prompt: "investigate",
        agentType: "gemini",
      },
      idempotencyKey: "mr-note:300",
    });

    const claimResult = queue.claimNext();
    expect(claimResult.isOk()).toBe(true);
    if (claimResult.isErr() || claimResult.value === null) {
      return;
    }

    const failResult = queue.fail(claimResult.value.id, "agent exited");
    expect(failResult.isOk()).toBe(true);
    if (failResult.isErr()) {
      return;
    }

    expect(failResult.value.status).toBe("failed");
    expect(failResult.value.error).toBe("agent exited");
    expect(failResult.value.retryCount).toBe(1);
    expect(failResult.value.completedAt instanceof Date).toBe(true);
  });

  it("returns null when there are no pending jobs to claim", () => {
    const database = createDatabase(databasePath);
    const queue = createJobQueue(database);

    const claimResult = queue.claimNext();

    expect(claimResult.isOk()).toBe(true);
    if (claimResult.isErr()) {
      return;
    }

    expect(claimResult.value).toBeNull();
  });
});
