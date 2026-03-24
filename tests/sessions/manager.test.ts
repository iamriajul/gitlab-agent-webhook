import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionManager } from "../../src/sessions/manager.ts";
import { createMigratedDatabase } from "../helpers/database.ts";

let databasePath = "";

beforeEach(() => {
  databasePath = join(tmpdir(), `glab-review-webhook-session-${crypto.randomUUID()}.sqlite`);
});

afterEach(() => {
  const cleanupPaths = [databasePath, `${databasePath}-shm`, `${databasePath}-wal`];

  for (const cleanupPath of cleanupPaths) {
    if (existsSync(cleanupPath)) {
      unlinkSync(cleanupPath);
    }
  }
});

describe("createSessionManager", () => {
  it("creates and looks up an issue session by context", () => {
    const database = createMigratedDatabase(databasePath);
    const manager = createSessionManager(database);

    const createResult = manager.create({
      agentType: "claude",
      agentSessionId: "claude-session-1",
      context: { kind: "issue", project: "team/project", issueIid: 17 },
    });

    expect(createResult.isOk()).toBe(true);
    if (createResult.isErr()) {
      return;
    }

    const lookupResult = manager.findByContext({
      kind: "issue",
      project: "team/project",
      issueIid: 17,
    });

    expect(lookupResult.isOk()).toBe(true);
    if (lookupResult.isErr()) {
      return;
    }

    expect(lookupResult.value).not.toBeNull();
    if (lookupResult.value === null) {
      return;
    }

    expect(lookupResult.value.id).toBe(createResult.value.id);
    expect(lookupResult.value.agentType).toBe("claude");
    expect(lookupResult.value.agentSessionId).toBe("claude-session-1");
    expect(lookupResult.value.status).toBe("active");
  });

  it("updates last activity and agent session id", () => {
    const database = createMigratedDatabase(databasePath);
    const manager = createSessionManager(database);

    const createResult = manager.create({
      agentType: "codex",
      agentSessionId: "",
      context: { kind: "mr", project: "team/project", mrIid: 22 },
    });

    expect(createResult.isOk()).toBe(true);
    if (createResult.isErr()) {
      return;
    }

    const touchResult = manager.updateActivity(createResult.value.id, "codex-resume-22");

    expect(touchResult.isOk()).toBe(true);
    if (touchResult.isErr()) {
      return;
    }

    expect(touchResult.value.agentSessionId).toBe("codex-resume-22");
    expect(touchResult.value.lastActivityAt.getTime()).toBeGreaterThanOrEqual(
      createResult.value.lastActivityAt.getTime(),
    );
  });

  it("marks a session with a final status", () => {
    const database = createMigratedDatabase(databasePath);
    const manager = createSessionManager(database);

    const createResult = manager.create({
      agentType: "gemini",
      agentSessionId: "gemini-1",
      context: { kind: "mr_review", project: "team/project", mrIid: 31 },
    });

    expect(createResult.isOk()).toBe(true);
    if (createResult.isErr()) {
      return;
    }

    const finalizeResult = manager.markFinalStatus(createResult.value.id, "failed");

    expect(finalizeResult.isOk()).toBe(true);
    if (finalizeResult.isErr()) {
      return;
    }

    expect(finalizeResult.value.status).toBe("failed");
    expect(finalizeResult.value.lastActivityAt.getTime()).toBeGreaterThanOrEqual(
      createResult.value.lastActivityAt.getTime(),
    );
  });

  it("returns null when no session exists for a context", () => {
    const database = createMigratedDatabase(databasePath);
    const manager = createSessionManager(database);

    const lookupResult = manager.findByContext({
      kind: "mr",
      project: "team/project",
      mrIid: 999,
    });

    expect(lookupResult.isOk()).toBe(true);
    if (lookupResult.isErr()) {
      return;
    }

    expect(lookupResult.value).toBeNull();
  });

  it("returns the most recent active session for a context", () => {
    const database = createMigratedDatabase(databasePath);
    const manager = createSessionManager(database);

    const activeResult = manager.create({
      agentType: "claude",
      agentSessionId: "claude-active",
      context: { kind: "mr", project: "team/project", mrIid: 50 },
    });
    expect(activeResult.isOk()).toBe(true);
    if (activeResult.isErr()) {
      return;
    }

    const failedResult = manager.create({
      agentType: "claude",
      agentSessionId: "claude-failed",
      context: { kind: "mr", project: "team/project", mrIid: 50 },
    });
    expect(failedResult.isOk()).toBe(true);
    if (failedResult.isErr()) {
      return;
    }

    const markFailedResult = manager.markFinalStatus(failedResult.value.id, "failed");
    expect(markFailedResult.isOk()).toBe(true);
    if (markFailedResult.isErr()) {
      return;
    }

    const lookupResult = manager.findByContext({
      kind: "mr",
      project: "team/project",
      mrIid: 50,
    });

    expect(lookupResult.isOk()).toBe(true);
    if (lookupResult.isErr()) {
      return;
    }

    expect(lookupResult.value).not.toBeNull();
    if (lookupResult.value === null) {
      return;
    }

    expect(lookupResult.value.id).toBe(activeResult.value.id);
    expect(lookupResult.value.status).toBe("active");
  });
});
