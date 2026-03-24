import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../src/config/logger.ts";
import type { ReactionTarget } from "../../src/gitlab/service.ts";
import { createJobQueue } from "../../src/jobs/queue.ts";
import { createWorker } from "../../src/jobs/worker.ts";
import type { JobQueue } from "../../src/jobs/queue.ts";
import type { Job } from "../../src/jobs/types.ts";
import { createSessionManager } from "../../src/sessions/manager.ts";
import type { SessionManager } from "../../src/sessions/manager.ts";
import { agentError, gitlabError, queueError } from "../../src/types/errors.ts";
import { jobId } from "../../src/types/branded.ts";
import { err, fromPromise, ok, okAsync, type Result, type ResultAsync } from "../../src/types/result.ts";
import type { AgentConfig, AgentProcess, AgentResult } from "../../src/agents/types.ts";
import type { AppError } from "../../src/types/errors.ts";
import type { EmojiName } from "../../src/types/events.ts";
import { createMigratedDatabase } from "../helpers/database.ts";

let databasePath = "";
const TEST_AGENT_ENV = {
  GITLAB_HOST: "https://gitlab.example.com",
  GITLAB_TOKEN: "gitlab-token",
  HOME: "/tmp/worker-home",
  PATH: "/usr/bin:/bin",
};

beforeEach(() => {
  databasePath = join(tmpdir(), `glab-review-webhook-worker-${crypto.randomUUID()}.sqlite`);
});

afterEach(() => {
  const cleanupPaths = [databasePath, `${databasePath}-shm`, `${databasePath}-wal`];

  for (const cleanupPath of cleanupPaths) {
    if (existsSync(cleanupPath)) {
      unlinkSync(cleanupPath);
    }
  }
});

type GitLabCall =
  | { readonly kind: "reaction"; readonly target: ReactionTarget; readonly emoji: EmojiName }
  | {
      readonly kind: "remove_reaction";
      readonly target: ReactionTarget;
      readonly emoji: EmojiName;
      readonly awardId: number;
    }
  | {
      readonly kind: "issue_comment";
      readonly project: string;
      readonly issueIid: number;
      readonly body: string;
    }
  | {
      readonly kind: "mr_comment";
      readonly project: string;
      readonly mrIid: number;
      readonly body: string;
    };

class FakeGitLabService {
  readonly calls: GitLabCall[] = [];
  private nextAwardId = 1;

  addReaction(target: ReactionTarget, emoji: EmojiName): ResultAsync<number, AppError> {
    this.calls.push({ kind: "reaction", target, emoji });
    const awardId = this.nextAwardId;
    this.nextAwardId += 1;
    return okAsync(awardId);
  }

  clearReaction(_target: ReactionTarget, _emoji: EmojiName): ResultAsync<void, AppError> {
    return okAsync(undefined);
  }

  removeReaction(target: ReactionTarget, emoji: EmojiName, awardId: number): ResultAsync<void, AppError> {
    this.calls.push({ kind: "remove_reaction", target, emoji, awardId });
    return okAsync(undefined);
  }

  postIssueComment(project: string, issueIid: number, body: string): ResultAsync<void, AppError> {
    this.calls.push({ kind: "issue_comment", project, issueIid, body });
    return okAsync(undefined);
  }

  postMRComment(project: string, mrIid: number, body: string): ResultAsync<void, AppError> {
    this.calls.push({ kind: "mr_comment", project, mrIid, body });
    return okAsync(undefined);
  }
}

function createAgentProcess(result: AgentResult): AgentProcess {
  return {
    pid: 4242,
    result: Promise.resolve(ok(result)),
    kill() {},
  };
}

function createDeferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve(value: T) {
      resolvePromise(value);
    },
    reject(reason?: unknown) {
      rejectPromise(reason);
    },
  };
}

function prepareWorkspace(
  _payload: Job["payload"],
  baseWorkDir: string,
  preparedWorkDir = baseWorkDir,
) {
  return ok(preparedWorkDir);
}

describe("createWorker", () => {
  it("handles an issue mention successfully and persists a resumable session", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);
    const gitlab = new FakeGitLabService();
    const spawnedConfigs: AgentConfig[] = [];
    const preparedWorkspaces: string[] = [];

    const enqueueResult = queue.enqueue({
      payload: {
        kind: "handle_mention",
        project: "team/project",
        noteId: 101,
        issueIid: 55,
        prompt: "Fix the flaky test",
        agentType: "codex",
      },
      idempotencyKey: "note:101",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab,
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      env: TEST_AGENT_ENV,
      timeoutMs: 60_000,
      prepareWorkspace(payload, baseWorkDir) {
        preparedWorkspaces.push(`${payload.project}::${baseWorkDir}`);
        return prepareWorkspace(payload, baseWorkDir, join(baseWorkDir, "prepared", "issue-55"));
      },
      spawnAgent(config) {
        spawnedConfigs.push(config);
        return ok(
          createAgentProcess({
            exitCode: 0,
            sessionId: "codex-session-1",
            stdout: "ok",
            stderr: "",
            durationMs: 250,
          }),
        );
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isOk()).toBe(true);
    if (runResult.isErr()) {
      return;
    }

    expect(runResult.value).not.toBeNull();
    if (runResult.value === null) {
      return;
    }

    expect(runResult.value.status).toBe("completed");
    expect(spawnedConfigs).toHaveLength(1);
    expect(spawnedConfigs[0]?.agent.kind).toBe("codex");
    expect(spawnedConfigs[0]?.workDir).toBe(join(process.cwd(), "prepared", "issue-55"));
    expect(spawnedConfigs[0]?.env).toEqual(TEST_AGENT_ENV);
    expect(spawnedConfigs[0]?.sessionId).toBeUndefined();
    expect(spawnedConfigs[0]?.prompt).toContain("Fix the flaky test");
    expect(spawnedConfigs[0]?.systemPrompt).not.toContain("Fix the flaky test");
    expect(spawnedConfigs[0]?.systemPrompt).toContain("Never push to protected branches.");
    expect(preparedWorkspaces).toEqual([`team/project::${process.cwd()}`]);

    const lookupSessionResult = sessions.findByContext({
      kind: "issue",
      project: "team/project",
      issueIid: 55,
    });
    expect(lookupSessionResult.isOk()).toBe(true);
    if (lookupSessionResult.isErr()) {
      return;
    }

    expect(lookupSessionResult.value).not.toBeNull();
    if (lookupSessionResult.value === null) {
      return;
    }

    expect(lookupSessionResult.value.agentType).toBe("codex");
    expect(lookupSessionResult.value.agentSessionId).toBe("codex-session-1");
    expect(lookupSessionResult.value.status).toBe("active");

    const storedJobResult = queue.findByIdempotencyKey("note:101");
    expect(storedJobResult.isOk()).toBe(true);
    if (storedJobResult.isErr()) {
      return;
    }

    expect(storedJobResult.value?.status).toBe("completed");
    expect(gitlab.calls).toEqual([
      {
        kind: "reaction",
        target: { kind: "issue_note", project: "team/project", issueIid: 55, noteId: 101 },
        emoji: "eyes",
      },
      {
        kind: "issue_comment",
        project: "team/project",
        issueIid: 55,
        body: "Agent started with codex.",
      },
      {
        kind: "remove_reaction",
        target: { kind: "issue_note", project: "team/project", issueIid: 55, noteId: 101 },
        emoji: "eyes",
        awardId: 1,
      },
      {
        kind: "reaction",
        target: { kind: "issue_note", project: "team/project", issueIid: 55, noteId: 101 },
        emoji: "white_check_mark",
      },
      {
        kind: "issue_comment",
        project: "team/project",
        issueIid: 55,
        body: "Agent finished successfully.",
      },
    ]);
  });

  it("handles an MR review with the default agent and persists a resumable session", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);
    const gitlab = new FakeGitLabService();
    const spawnedConfigs: AgentConfig[] = [];

    const enqueueResult = queue.enqueue({
      payload: { kind: "review_mr", project: "team/project", mrIid: 88 },
      idempotencyKey: "mr:team/project:88",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab,
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent(config) {
        spawnedConfigs.push(config);
        return ok(
          createAgentProcess({
            exitCode: 0,
            sessionId: "claude-review-88",
            stdout: "ok",
            stderr: "",
            durationMs: 500,
          }),
        );
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isOk()).toBe(true);
    if (runResult.isErr()) {
      return;
    }

    expect(runResult.value?.status).toBe("completed");
    expect(spawnedConfigs).toHaveLength(1);
    expect(spawnedConfigs[0]?.agent.kind).toBe("claude");
    expect(spawnedConfigs[0]?.prompt).toContain("Review merge request !88");

    const lookupSessionResult = sessions.findByContext({
      kind: "mr_review",
      project: "team/project",
      mrIid: 88,
    });
    expect(lookupSessionResult.isOk()).toBe(true);
    if (lookupSessionResult.isErr()) {
      return;
    }

    expect(lookupSessionResult.value).not.toBeNull();
    if (lookupSessionResult.value === null) {
      return;
    }

    expect(lookupSessionResult.value.agentType).toBe("claude");
    expect(lookupSessionResult.value.agentSessionId).toBe("claude-review-88");
    expect(lookupSessionResult.value.status).toBe("active");
    expect(gitlab.calls).toEqual([
      {
        kind: "reaction",
        target: { kind: "mr", project: "team/project", mrIid: 88 },
        emoji: "eyes",
      },
      {
        kind: "mr_comment",
        project: "team/project",
        mrIid: 88,
        body: "Agent started with claude.",
      },
      {
        kind: "remove_reaction",
        target: { kind: "mr", project: "team/project", mrIid: 88 },
        emoji: "eyes",
        awardId: 1,
      },
      {
        kind: "reaction",
        target: { kind: "mr", project: "team/project", mrIid: 88 },
        emoji: "white_check_mark",
      },
      {
        kind: "mr_comment",
        project: "team/project",
        mrIid: 88,
        body: "Agent finished successfully.",
      },
    ]);
  });

  it("recovers from a stale MR review acknowledgment reaction before spawning", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);
    const spawnedConfigs: AgentConfig[] = [];
    let addReactionCount = 0;
    const clearedReactions: EmojiName[] = [];

    const enqueueResult = queue.enqueue({
      payload: { kind: "review_mr", project: "team/project", mrIid: 89 },
      idempotencyKey: "mr:team/project:89",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab: {
        addReaction(_target, emoji) {
          addReactionCount += 1;
          if (emoji === "eyes" && addReactionCount === 1) {
            return fromPromise(
              Promise.reject(new Error("duplicate award emoji")),
              () => gitlabError("duplicate award emoji"),
            );
          }

          return okAsync(addReactionCount);
        },
        clearReaction(_target, emoji) {
          clearedReactions.push(emoji);
          return okAsync(undefined);
        },
        removeReaction() {
          return okAsync(undefined);
        },
        postIssueComment() {
          return okAsync(undefined);
        },
        postMRComment() {
          return okAsync(undefined);
        },
      },
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent(config) {
        spawnedConfigs.push(config);
        return ok(
          createAgentProcess({
            exitCode: 0,
            sessionId: "claude-review-89",
            stdout: "ok",
            stderr: "",
            durationMs: 500,
          }),
        );
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isOk()).toBe(true);
    if (runResult.isErr()) {
      return;
    }

    expect(runResult.value?.status).toBe("completed");
    expect(clearedReactions).toEqual(["eyes", "white_check_mark", "warning"]);
    expect(addReactionCount).toBe(3);
    expect(spawnedConfigs).toHaveLength(1);
  });

  it("clears prior terminal MR review reactions before adding the latest terminal reaction", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);
    const clearedReactions: EmojiName[] = [];
    const addedReactions: EmojiName[] = [];

    const enqueueResult = queue.enqueue({
      payload: { kind: "review_mr", project: "team/project", mrIid: 90 },
      idempotencyKey: "mr:team/project:90",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab: {
        addReaction(_target, emoji) {
          addedReactions.push(emoji);
          return okAsync(addedReactions.length);
        },
        clearReaction(_target, emoji) {
          clearedReactions.push(emoji);
          return okAsync(undefined);
        },
        removeReaction() {
          return okAsync(undefined);
        },
        postIssueComment() {
          return okAsync(undefined);
        },
        postMRComment() {
          return okAsync(undefined);
        },
      },
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return ok(
          createAgentProcess({
            exitCode: 0,
            sessionId: "claude-review-90",
            stdout: "ok",
            stderr: "",
            durationMs: 500,
          }),
        );
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isOk()).toBe(true);
    if (runResult.isErr()) {
      return;
    }

    expect(runResult.value?.status).toBe("completed");
    expect(clearedReactions).toEqual(["white_check_mark", "warning"]);
    expect(addedReactions).toEqual(["eyes", "white_check_mark"]);
  });

  it("processes an unrelated MR review while a same-MR follow-up stays pending", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);
    const gitlab = new FakeGitLabService();
    const firstAgentResult = createDeferred<Result<AgentResult, AppError>>();
    const secondAgentResult = createDeferred<Result<AgentResult, AppError>>();
    const spawnedConfigs: AgentConfig[] = [];

    const firstEnqueueResult = queue.enqueue({
      payload: { kind: "review_mr", project: "team/project", mrIid: 92 },
      idempotencyKey: "mr:team/project:92:sha-a",
    });
    expect(firstEnqueueResult.isOk()).toBe(true);
    if (firstEnqueueResult.isErr()) {
      return;
    }

    const secondEnqueueResult = queue.enqueue({
      payload: { kind: "review_mr", project: "team/project", mrIid: 92 },
      idempotencyKey: "mr:team/project:92:sha-b",
    });
    expect(secondEnqueueResult.isOk()).toBe(true);
    if (secondEnqueueResult.isErr()) {
      return;
    }

    const thirdEnqueueResult = queue.enqueue({
      payload: { kind: "review_mr", project: "team/project", mrIid: 93 },
      idempotencyKey: "mr:team/project:93:sha-a",
    });
    expect(thirdEnqueueResult.isOk()).toBe(true);
    if (thirdEnqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab,
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent(config) {
        spawnedConfigs.push(config);
        return ok({
          pid: 4242 + spawnedConfigs.length,
          result: spawnedConfigs.length === 1 ? firstAgentResult.promise : secondAgentResult.promise,
          kill() {},
        });
      },
    });

    const firstRunPromise = worker.runNextJob();
    const secondRunPromise = worker.runNextJob();

    await Promise.resolve();
    await Promise.resolve();
    expect(spawnedConfigs).toHaveLength(2);
    expect(spawnedConfigs[0]?.prompt).toContain("Review merge request !92");
    expect(spawnedConfigs[1]?.prompt).toContain("Review merge request !93");
    const waitingJobResult = queue.findByIdempotencyKey("mr:team/project:92:sha-b");
    expect(waitingJobResult.isOk()).toBe(true);
    if (waitingJobResult.isErr()) {
      return;
    }

    expect(waitingJobResult.value?.status).toBe("pending");

    secondAgentResult.resolve(
      ok({
        exitCode: 0,
        sessionId: "claude-review-93a",
        stdout: "ok",
        stderr: "",
        durationMs: 100,
      }),
    );

    const secondRunResult = await secondRunPromise;
    expect(secondRunResult.isOk()).toBe(true);
    if (secondRunResult.isErr()) {
      return;
    }

    firstAgentResult.resolve(
      ok({
        exitCode: 0,
        sessionId: "claude-review-92a",
        stdout: "ok",
        stderr: "",
        durationMs: 100,
      }),
    );

    const firstRunResult = await firstRunPromise;
    expect(firstRunResult.isOk()).toBe(true);
    if (firstRunResult.isErr()) {
      return;
    }

    expect(firstRunResult.value?.status).toBe("completed");
    expect(secondRunResult.value?.payload).toEqual({
      kind: "review_mr",
      project: "team/project",
      mrIid: 93,
    });
  });

  it("resumes and updates the session for repeated MR review jobs", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);
    const gitlab = new FakeGitLabService();
    const spawnedConfigs: AgentConfig[] = [];

    const createSessionResult = sessions.create({
      agentType: "claude",
      agentSessionId: "claude-old-review",
      context: { kind: "mr_review", project: "team/project", mrIid: 44 },
    });
    expect(createSessionResult.isOk()).toBe(true);
    if (createSessionResult.isErr()) {
      return;
    }

    const enqueueResult = queue.enqueue({
      payload: { kind: "review_mr", project: "team/project", mrIid: 44 },
      idempotencyKey: "mr:team/project:44:commit:abc123",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab,
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent(config) {
        spawnedConfigs.push(config);
        return ok(
          createAgentProcess({
            exitCode: 0,
            sessionId: "claude-new-review",
            stdout: "ok",
            stderr: "",
            durationMs: 400,
          }),
        );
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isOk()).toBe(true);
    if (runResult.isErr()) {
      return;
    }

    expect(runResult.value?.status).toBe("completed");
    expect(spawnedConfigs).toHaveLength(1);
    expect(spawnedConfigs[0]?.sessionId).toBe("claude-old-review");
    expect(gitlab.calls[1]).toEqual({
      kind: "mr_comment",
      project: "team/project",
      mrIid: 44,
      body: "Agent resumed with claude.",
    });

    const latestSessionResult = sessions.findByContext(
      {
        kind: "mr_review",
        project: "team/project",
        mrIid: 44,
      },
      "claude",
    );
    expect(latestSessionResult.isOk()).toBe(true);
    if (latestSessionResult.isErr()) {
      return;
    }

    expect(latestSessionResult.value).not.toBeNull();
    if (latestSessionResult.value === null) {
      return;
    }

    expect(latestSessionResult.value.id).toBe(createSessionResult.value.id);
    expect(latestSessionResult.value.agentSessionId).toBe("claude-new-review");
  });

  it("resumes an active matching session for follow-up MR mentions", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);
    const gitlab = new FakeGitLabService();
    const spawnedConfigs: AgentConfig[] = [];

    const createSessionResult = sessions.create({
      agentType: "claude",
      agentSessionId: "claude-resume-7",
      context: { kind: "mr", project: "team/project", mrIid: 7 },
    });
    expect(createSessionResult.isOk()).toBe(true);
    if (createSessionResult.isErr()) {
      return;
    }

    const enqueueResult = queue.enqueue({
      payload: {
        kind: "handle_mr_mention",
        project: "team/project",
        noteId: 301,
        mrIid: 7,
        prompt: "Please continue with the previous fixes",
        agentType: "claude",
      },
      idempotencyKey: "mr-note:301",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab,
      logger: createLogger("fatal"),
      defaultAgent: "codex",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent(config) {
        spawnedConfigs.push(config);
        return ok(
          createAgentProcess({
            exitCode: 0,
            sessionId: "claude-resume-7b",
            stdout: "ok",
            stderr: "",
            durationMs: 300,
          }),
        );
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isOk()).toBe(true);
    if (runResult.isErr()) {
      return;
    }

    expect(runResult.value?.status).toBe("completed");
    expect(spawnedConfigs[0]?.sessionId).toBe("claude-resume-7");

    const lookupSessionResult = sessions.findByContext({
      kind: "mr",
      project: "team/project",
      mrIid: 7,
    });
    expect(lookupSessionResult.isOk()).toBe(true);
    if (lookupSessionResult.isErr()) {
      return;
    }

    expect(lookupSessionResult.value?.id).toBe(createSessionResult.value.id);
    expect(lookupSessionResult.value?.agentSessionId).toBe("claude-resume-7b");
    expect(gitlab.calls[1]).toEqual({
      kind: "mr_comment",
      project: "team/project",
      mrIid: 7,
      body: "Agent resumed with claude.",
    });
  });

  it("leaves a blocked same-context follow-up pending until a later run can resume it", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);
    const gitlab = new FakeGitLabService();
    const spawnedConfigs: AgentConfig[] = [];
    const firstAgentResult = createDeferred<Result<AgentResult, AppError>>();
    const secondAgentResult = createDeferred<Result<AgentResult, AppError>>();

    const firstEnqueueResult = queue.enqueue({
      payload: {
        kind: "handle_mr_mention",
        project: "team/project",
        noteId: 301,
        mrIid: 93,
        prompt: "first follow-up",
        agentType: "codex",
      },
      idempotencyKey: "mr-note:301",
    });
    expect(firstEnqueueResult.isOk()).toBe(true);
    if (firstEnqueueResult.isErr()) {
      return;
    }

    const secondEnqueueResult = queue.enqueue({
      payload: {
        kind: "handle_mr_mention",
        project: "team/project",
        noteId: 302,
        mrIid: 93,
        prompt: "second follow-up",
        agentType: "codex",
      },
      idempotencyKey: "mr-note:302",
    });
    expect(secondEnqueueResult.isOk()).toBe(true);
    if (secondEnqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab,
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent(config) {
        spawnedConfigs.push(config);
        return ok({
          pid: 4300 + spawnedConfigs.length,
          result:
            spawnedConfigs.length === 1 ? firstAgentResult.promise : secondAgentResult.promise,
          kill() {},
        });
      },
    });

    const firstRunPromise = worker.runNextJob();
    const secondRunPromise = worker.runNextJob();

    await Promise.resolve();
    await Promise.resolve();
    expect(spawnedConfigs).toHaveLength(1);
    expect(spawnedConfigs[0]?.sessionId).toBeUndefined();
    const waitingJobResult = queue.findByIdempotencyKey("mr-note:302");
    expect(waitingJobResult.isOk()).toBe(true);
    if (waitingJobResult.isErr()) {
      return;
    }

    expect(waitingJobResult.value?.status).toBe("pending");

    const secondRunResult = await secondRunPromise;
    expect(secondRunResult.isOk()).toBe(true);
    if (secondRunResult.isErr()) {
      return;
    }

    expect(secondRunResult.value).toBeNull();
    expect(spawnedConfigs).toHaveLength(1);

    firstAgentResult.resolve(
      ok({
        exitCode: 0,
        sessionId: "codex-session-93a",
        stdout: "ok",
        stderr: "",
        durationMs: 100,
      }),
    );

    const firstRunResult = await firstRunPromise;
    expect(firstRunResult.isOk()).toBe(true);
    if (firstRunResult.isErr()) {
      return;
    }

    const thirdRunPromise = worker.runNextJob();
    await Promise.resolve();
    await Promise.resolve();
    expect(spawnedConfigs).toHaveLength(2);
    expect(spawnedConfigs[1]?.sessionId).toBe("codex-session-93a");

    secondAgentResult.resolve(
      ok({
        exitCode: 0,
        sessionId: "codex-session-93b",
        stdout: "ok",
        stderr: "",
        durationMs: 100,
      }),
    );

    const thirdRunResult = await thirdRunPromise;
    expect(thirdRunResult.isOk()).toBe(true);
    if (thirdRunResult.isErr()) {
      return;
    }

    const lookupSessionResult = sessions.findByContext(
      {
        kind: "mr",
        project: "team/project",
        mrIid: 93,
      },
      "codex",
    );
    expect(lookupSessionResult.isOk()).toBe(true);
    if (lookupSessionResult.isErr()) {
      return;
    }

    expect(lookupSessionResult.value).not.toBeNull();
    if (lookupSessionResult.value === null) {
      return;
    }

    expect(lookupSessionResult.value.agentSessionId).toBe("codex-session-93b");
  });

  it("marks the job failed and keeps the resumed session active when agent execution fails", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);
    const gitlab = new FakeGitLabService();

    const createSessionResult = sessions.create({
      agentType: "codex",
      agentSessionId: "codex-failing-session",
      context: { kind: "issue", project: "team/project", issueIid: 99 },
    });
    expect(createSessionResult.isOk()).toBe(true);
    if (createSessionResult.isErr()) {
      return;
    }

    const enqueueResult = queue.enqueue({
      payload: {
        kind: "handle_mention",
        project: "team/project",
        noteId: 909,
        issueIid: 99,
        prompt: "Try again",
        agentType: "codex",
      },
      idempotencyKey: "note:909",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab,
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return ok({
          pid: 11,
          result: Promise.resolve(err(agentError("agent crashed", "codex", 23))),
          kill() {},
        });
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isErr()).toBe(true);
    if (runResult.isOk()) {
      return;
    }

    expect(runResult.error).toEqual(agentError("agent crashed", "codex", 23));

    const storedJobResult = queue.findByIdempotencyKey("note:909");
    expect(storedJobResult.isOk()).toBe(true);
    if (storedJobResult.isErr()) {
      return;
    }

    expect(storedJobResult.value?.status).toBe("failed");
    expect(storedJobResult.value?.error).toBe("agent_error: agent crashed");

    const lookupSessionResult = sessions.findByContext({
      kind: "issue",
      project: "team/project",
      issueIid: 99,
    });
    expect(lookupSessionResult.isOk()).toBe(true);
    if (lookupSessionResult.isErr()) {
      return;
    }

    expect(lookupSessionResult.value).not.toBeNull();
    if (lookupSessionResult.value === null) {
      return;
    }

    expect(lookupSessionResult.value.id).toBe(createSessionResult.value.id);
    expect(lookupSessionResult.value.status).toBe("active");
    expect(lookupSessionResult.value.agentSessionId).toBe("codex-failing-session");
    expect(gitlab.calls.at(-2)).toEqual({
      kind: "issue_comment",
      project: "team/project",
      issueIid: 99,
      body: "Agent failed: agent_error: agent crashed",
    });
    expect(gitlab.calls.at(-1)).toEqual({
      kind: "reaction",
      target: { kind: "issue_note", project: "team/project", issueIid: 99, noteId: 909 },
      emoji: "warning",
    });
  });

  it("marks the job failed when GitLab acknowledgment fails before the agent starts", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);

    const enqueueResult = queue.enqueue({
      payload: { kind: "review_mr", project: "team/project", mrIid: 73 },
      idempotencyKey: "mr:73",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab: {
        addReaction() {
          return okAsync(1);
        },
        clearReaction() {
          return okAsync(undefined);
        },
        removeReaction() {
          return okAsync(undefined);
        },
        postIssueComment() {
          return okAsync(undefined);
        },
        postMRComment() {
          return fromPromise(
            Promise.reject(new Error("unreachable")),
            () => gitlabError("status comment rejected"),
          ).map(() => undefined);
        },
      },
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return err(agentError("should not spawn", "claude", 1));
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isErr()).toBe(true);
    if (runResult.isOk()) {
      return;
    }

    expect(runResult.error).toEqual(gitlabError("status comment rejected"));

    const storedJobResult = queue.findByIdempotencyKey("mr:73");
    expect(storedJobResult.isOk()).toBe(true);
    if (storedJobResult.isErr()) {
      return;
    }

    expect(storedJobResult.value?.status).toBe("failed");
    expect(storedJobResult.value?.error).toBe("gitlab_error: status comment rejected");
  });

  it("posts a failure status when agent startup fails", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);
    const gitlab = new FakeGitLabService();

    const enqueueResult = queue.enqueue({
      payload: {
        kind: "handle_mr_mention",
        project: "team/project",
        noteId: 808,
        mrIid: 52,
        prompt: "Take a look",
        agentType: "claude",
      },
      idempotencyKey: "mr-note:808",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab,
      logger: createLogger("fatal"),
      defaultAgent: "codex",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return err(agentError("claude binary missing", "claude", 127));
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isErr()).toBe(true);
    if (runResult.isOk()) {
      return;
    }

    expect(runResult.error).toEqual(agentError("claude binary missing", "claude", 127));

    const storedJobResult = queue.findByIdempotencyKey("mr-note:808");
    expect(storedJobResult.isOk()).toBe(true);
    if (storedJobResult.isErr()) {
      return;
    }

    expect(storedJobResult.value?.status).toBe("failed");
    expect(storedJobResult.value?.error).toBe("agent_error: claude binary missing");
    expect(gitlab.calls).toEqual([
      {
        kind: "reaction",
        target: { kind: "mr_note", project: "team/project", mrIid: 52, noteId: 808 },
        emoji: "eyes",
      },
      {
        kind: "mr_comment",
        project: "team/project",
        mrIid: 52,
        body: "Agent failed: agent_error: claude binary missing",
      },
      {
        kind: "remove_reaction",
        target: { kind: "mr_note", project: "team/project", mrIid: 52, noteId: 808 },
        emoji: "eyes",
        awardId: 1,
      },
      {
        kind: "reaction",
        target: { kind: "mr_note", project: "team/project", mrIid: 52, noteId: 808 },
        emoji: "warning",
      },
    ]);
  });

  it("kills the spawned agent when the started status comment fails", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);
    const killDeferred = createDeferred<void>();
    const exitDeferred = createDeferred<Result<AgentResult, AppError>>();
    let killCount = 0;

    const enqueueResult = queue.enqueue({
      payload: {
        kind: "handle_mention",
        project: "team/project",
        noteId: 818,
        issueIid: 52,
        prompt: "Take a look",
        agentType: "claude",
      },
      idempotencyKey: "note:818",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab: {
        addReaction() {
          return okAsync(1);
        },
        clearReaction() {
          return okAsync(undefined);
        },
        removeReaction() {
          return okAsync(undefined);
        },
        postIssueComment() {
          return fromPromise(
            Promise.reject(new Error("unreachable")),
            () => gitlabError("status comment rejected"),
          ).map(() => undefined);
        },
        postMRComment() {
          return okAsync(undefined);
        },
      },
      logger: createLogger("fatal"),
      defaultAgent: "codex",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return ok({
          pid: 18,
          result: exitDeferred.promise,
          kill() {
            killCount += 1;
            return killDeferred.promise;
          },
        });
      },
    });

    let settled = false;
    const runPromise = worker.runNextJob().then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(killCount).toBe(1);
    expect(settled).toBe(false);

    killDeferred.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    exitDeferred.resolve(err(agentError("killed after comment failure", "claude", -1)));

    const runResult = await runPromise;
    expect(runResult.isErr()).toBe(true);
    if (runResult.isOk()) {
      return;
    }

    expect(runResult.error).toEqual(gitlabError("status comment rejected"));
    expect(killCount).toBe(1);

    const storedJobResult = queue.findByIdempotencyKey("note:818");
    expect(storedJobResult.isOk()).toBe(true);
    if (storedJobResult.isErr()) {
      return;
    }

    expect(storedJobResult.value?.status).toBe("failed");
    expect(storedJobResult.value?.error).toBe("gitlab_error: status comment rejected");
  });

  it("handles a synchronous kill failure when the started status comment fails", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);

    const enqueueResult = queue.enqueue({
      payload: {
        kind: "handle_mention",
        project: "team/project",
        noteId: 819,
        issueIid: 53,
        prompt: "Take a look",
        agentType: "claude",
      },
      idempotencyKey: "note:819",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab: {
        addReaction() {
          return okAsync(1);
        },
        clearReaction() {
          return okAsync(undefined);
        },
        removeReaction() {
          return okAsync(undefined);
        },
        postIssueComment() {
          return fromPromise(
            Promise.reject(new Error("unreachable")),
            () => gitlabError("status comment rejected"),
          ).map(() => undefined);
        },
        postMRComment() {
          return okAsync(undefined);
        },
      },
      logger: createLogger("fatal"),
      defaultAgent: "codex",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return ok({
          pid: 19,
          result: Promise.resolve(err(agentError("already exited", "claude", -1))),
          kill() {
            throw new Error("kill failed");
          },
        });
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isErr()).toBe(true);
    if (runResult.isOk()) {
      return;
    }

    expect(runResult.error).toEqual(gitlabError("status comment rejected"));

    const storedJobResult = queue.findByIdempotencyKey("note:819");
    expect(storedJobResult.isOk()).toBe(true);
    if (storedJobResult.isErr()) {
      return;
    }

    expect(storedJobResult.value?.status).toBe("failed");
    expect(storedJobResult.value?.error).toBe("gitlab_error: status comment rejected");
  });

  it("fails the job when persisting failed-run session metadata fails", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const baseSessions = createSessionManager(database);
    const gitlab = new FakeGitLabService();

    const createSessionResult = baseSessions.create({
      agentType: "codex",
      agentSessionId: "codex-session-old",
      context: { kind: "issue", project: "team/project", issueIid: 18 },
    });
    expect(createSessionResult.isOk()).toBe(true);
    if (createSessionResult.isErr()) {
      return;
    }

    const sessions: SessionManager = {
      ...baseSessions,
      updateActivity() {
        return err(queueError("session update locked"));
      },
    };

    const enqueueResult = queue.enqueue({
      payload: {
        kind: "handle_mention",
        project: "team/project",
        noteId: 334,
        issueIid: 18,
        prompt: "run it again",
        agentType: "codex",
      },
      idempotencyKey: "note:334",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab,
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return ok(
          createAgentProcess({
            exitCode: 17,
            sessionId: "codex-session-334",
            stdout: "",
            stderr: "tests failed",
            durationMs: 220,
          }),
        );
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isErr()).toBe(true);
    if (runResult.isOk()) {
      return;
    }

    expect(runResult.error).toEqual(queueError("session update locked"));

    const storedJobResult = queue.findByIdempotencyKey("note:334");
    expect(storedJobResult.isOk()).toBe(true);
    if (storedJobResult.isErr()) {
      return;
    }

    expect(storedJobResult.value?.status).toBe("failed");
    expect(storedJobResult.value?.error).toBe("queue_error: session update locked");
    expect(gitlab.calls.at(-2)).toEqual({
      kind: "issue_comment",
      project: "team/project",
      issueIid: 18,
      body: "Agent failed: queue_error: session update locked",
    });
    expect(gitlab.calls.at(-1)).toEqual({
      kind: "reaction",
      target: { kind: "issue_note", project: "team/project", issueIid: 18, noteId: 334 },
      emoji: "warning",
    });
  });

  it("treats final status comment failures as non-fatal after agent success", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);
    let mrCommentCount = 0;

    const enqueueResult = queue.enqueue({
      payload: { kind: "review_mr", project: "team/project", mrIid: 64 },
      idempotencyKey: "mr:64",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab: {
        addReaction() {
          return okAsync(1);
        },
        clearReaction() {
          return okAsync(undefined);
        },
        removeReaction() {
          return okAsync(undefined);
        },
        postIssueComment() {
          return okAsync(undefined);
        },
        postMRComment() {
          mrCommentCount += 1;
          return mrCommentCount === 1
            ? okAsync(undefined)
            : fromPromise(
                Promise.reject(new Error("unreachable")),
                () => gitlabError("final status rejected"),
              ).map(() => undefined);
        },
      },
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return ok(
          createAgentProcess({
            exitCode: 0,
            sessionId: "claude-review-64",
            stdout: "ok",
            stderr: "",
            durationMs: 250,
          }),
        );
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isOk()).toBe(true);
    if (runResult.isErr()) {
      return;
    }

    expect(runResult.value?.status).toBe("completed");

    const storedJobResult = queue.findByIdempotencyKey("mr:64");
    expect(storedJobResult.isOk()).toBe(true);
    if (storedJobResult.isErr()) {
      return;
    }

    expect(storedJobResult.value?.status).toBe("completed");
    expect(storedJobResult.value?.error).toBeNull();
  });

  it("fails the job when session creation fails after successful agent work", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const baseSessions = createSessionManager(database);
    const sessions: SessionManager = {
      ...baseSessions,
      create() {
        return err(queueError("session insert locked"));
      },
    };

    const enqueueResult = queue.enqueue({
      payload: {
        kind: "handle_mention",
        project: "team/project",
        noteId: 820,
        issueIid: 64,
        prompt: "fix it",
        agentType: "codex",
      },
      idempotencyKey: "note:820",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab: new FakeGitLabService(),
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return ok(
          createAgentProcess({
            exitCode: 0,
            sessionId: "codex-session-64",
            stdout: "ok",
            stderr: "",
            durationMs: 120,
          }),
        );
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isErr()).toBe(true);
    if (runResult.isOk()) {
      return;
    }

    expect(runResult.error).toEqual(queueError("session insert locked"));

    const storedJobResult = queue.findByIdempotencyKey("note:820");
    expect(storedJobResult.isOk()).toBe(true);
    if (storedJobResult.isErr()) {
      return;
    }

    expect(storedJobResult.value?.status).toBe("failed");
    expect(storedJobResult.value?.error).toBe("queue_error: session insert locked");
  });

  it("fails the job when session update fails after successful resumed work", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const baseSessions = createSessionManager(database);

    const createSessionResult = baseSessions.create({
      agentType: "claude",
      agentSessionId: "claude-session-99",
      context: { kind: "mr", project: "team/project", mrIid: 99 },
    });
    expect(createSessionResult.isOk()).toBe(true);
    if (createSessionResult.isErr()) {
      return;
    }

    const sessions: SessionManager = {
      ...baseSessions,
      updateActivity() {
        return err(queueError("session update locked"));
      },
    };

    const enqueueResult = queue.enqueue({
      payload: {
        kind: "handle_mr_mention",
        project: "team/project",
        noteId: 899,
        mrIid: 99,
        prompt: "continue",
        agentType: "claude",
      },
      idempotencyKey: "mr-note:899",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab: new FakeGitLabService(),
      logger: createLogger("fatal"),
      defaultAgent: "codex",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return ok(
          createAgentProcess({
            exitCode: 0,
            sessionId: "claude-session-99b",
            stdout: "ok",
            stderr: "",
            durationMs: 140,
          }),
        );
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isErr()).toBe(true);
    if (runResult.isOk()) {
      return;
    }

    expect(runResult.error).toEqual(queueError("session update locked"));

    const storedJobResult = queue.findByIdempotencyKey("mr-note:899");
    expect(storedJobResult.isOk()).toBe(true);
    if (storedJobResult.isErr()) {
      return;
    }

    expect(storedJobResult.value?.status).toBe("failed");
    expect(storedJobResult.value?.error).toBe("queue_error: session update locked");
  });

  it("marks the job failed when queue completion fails after successful work", async () => {
    const job: Job = {
      id: jobId("job-complete-failure"),
      payload: {
        kind: "handle_mention",
        project: "team/project",
        noteId: 77,
        issueIid: 12,
        prompt: "Fix it",
        agentType: "codex",
      },
      status: "processing",
      createdAt: new Date("2026-03-21T00:00:00.000Z"),
      startedAt: new Date("2026-03-21T00:00:01.000Z"),
      completedAt: null,
      error: null,
      idempotencyKey: "note:77",
      retryCount: 0,
    };
    let claimCount = 0;
    let failMessage = "";

    const queue: JobQueue = {
      listPending() {
        return ok(claimCount === 0 ? [job] : []);
      },
      claimPending() {
        claimCount += 1;
        return ok(claimCount === 1 ? job : null);
      },
      claimNext() {
        claimCount += 1;
        return ok(claimCount === 1 ? job : null);
      },
      complete() {
        return err(queueError("database locked"));
      },
      enqueue(_input) {
        return ok(job);
      },
      fail(_id, message) {
        failMessage = message;
        return ok({
          ...job,
          status: "failed",
          completedAt: new Date("2026-03-21T00:00:02.000Z"),
          error: message,
          retryCount: 1,
        });
      },
      findByIdempotencyKey() {
        return ok(null);
      },
    };

    const worker = createWorker({
      queue,
      sessions: createSessionManager(createMigratedDatabase(databasePath)),
      gitlab: new FakeGitLabService(),
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return ok(
          createAgentProcess({
            exitCode: 0,
            sessionId: "codex-session-77",
            stdout: "ok",
            stderr: "",
            durationMs: 100,
          }),
        );
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isErr()).toBe(true);
    if (runResult.isOk()) {
      return;
    }

    expect(runResult.error).toEqual(queueError("database locked"));
    expect(failMessage).toBe("queue_error: database locked");
  });

  it("does not create a resumable session when queue completion fails", async () => {
    const job: Job = {
      id: jobId("job-session-create-delay"),
      payload: {
        kind: "handle_mention",
        project: "team/project",
        noteId: 78,
        issueIid: 13,
        prompt: "Fix it",
        agentType: "codex",
      },
      status: "processing",
      createdAt: new Date("2026-03-21T00:00:00.000Z"),
      startedAt: new Date("2026-03-21T00:00:01.000Z"),
      completedAt: null,
      error: null,
      idempotencyKey: "note:78",
      retryCount: 0,
    };

    const database = createMigratedDatabase(databasePath);
    const sessions = createSessionManager(database);

    const queue: JobQueue = {
      listPending() {
        return ok([job]);
      },
      claimPending() {
        return ok(job);
      },
      claimNext() {
        return ok(job);
      },
      complete() {
        return err(queueError("database locked"));
      },
      enqueue(_input) {
        return ok(job);
      },
      fail(_id, message) {
        return ok({
          ...job,
          status: "failed",
          completedAt: new Date("2026-03-21T00:00:02.000Z"),
          error: message,
          retryCount: 1,
        });
      },
      findByIdempotencyKey() {
        return ok(null);
      },
    };

    const worker = createWorker({
      queue,
      sessions,
      gitlab: new FakeGitLabService(),
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return ok(
          createAgentProcess({
            exitCode: 0,
            sessionId: "codex-session-78",
            stdout: "ok",
            stderr: "",
            durationMs: 100,
          }),
        );
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isErr()).toBe(true);
    if (runResult.isOk()) {
      return;
    }

    const lookupSessionResult = sessions.findByContext(
      {
        kind: "issue",
        project: "team/project",
        issueIid: 13,
      },
      "codex",
    );
    expect(lookupSessionResult.isOk()).toBe(true);
    if (lookupSessionResult.isErr()) {
      return;
    }

    expect(lookupSessionResult.value).toBeNull();
  });

  it("does not update a resumable session when queue completion fails", async () => {
    const job: Job = {
      id: jobId("job-session-update-delay"),
      payload: {
        kind: "handle_mr_mention",
        project: "team/project",
        noteId: 79,
        mrIid: 14,
        prompt: "continue",
        agentType: "claude",
      },
      status: "processing",
      createdAt: new Date("2026-03-21T00:00:00.000Z"),
      startedAt: new Date("2026-03-21T00:00:01.000Z"),
      completedAt: null,
      error: null,
      idempotencyKey: "mr-note:79",
      retryCount: 0,
    };

    const database = createMigratedDatabase(databasePath);
    const sessions = createSessionManager(database);
    const createSessionResult = sessions.create({
      agentType: "claude",
      agentSessionId: "claude-session-14",
      context: { kind: "mr", project: "team/project", mrIid: 14 },
    });
    expect(createSessionResult.isOk()).toBe(true);
    if (createSessionResult.isErr()) {
      return;
    }

    const queue: JobQueue = {
      listPending() {
        return ok([job]);
      },
      claimPending() {
        return ok(job);
      },
      claimNext() {
        return ok(job);
      },
      complete() {
        return err(queueError("database locked"));
      },
      enqueue(_input) {
        return ok(job);
      },
      fail(_id, message) {
        return ok({
          ...job,
          status: "failed",
          completedAt: new Date("2026-03-21T00:00:02.000Z"),
          error: message,
          retryCount: 1,
        });
      },
      findByIdempotencyKey() {
        return ok(null);
      },
    };

    const worker = createWorker({
      queue,
      sessions,
      gitlab: new FakeGitLabService(),
      logger: createLogger("fatal"),
      defaultAgent: "codex",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return ok(
          createAgentProcess({
            exitCode: 0,
            sessionId: "claude-session-14b",
            stdout: "ok",
            stderr: "",
            durationMs: 100,
          }),
        );
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isErr()).toBe(true);
    if (runResult.isOk()) {
      return;
    }

    const lookupSessionResult = sessions.findByContext(
      {
        kind: "mr",
        project: "team/project",
        mrIid: 14,
      },
      "claude",
    );
    expect(lookupSessionResult.isOk()).toBe(true);
    if (lookupSessionResult.isErr()) {
      return;
    }

    expect(lookupSessionResult.value).not.toBeNull();
    if (lookupSessionResult.value === null) {
      return;
    }

    expect(lookupSessionResult.value.id).toBe(createSessionResult.value.id);
    expect(lookupSessionResult.value.agentSessionId).toBe("claude-session-14");
  });

  it("does not post a success comment when queue completion fails", async () => {
    const job: Job = {
      id: jobId("job-success-comment-delay"),
      payload: {
        kind: "handle_mr_mention",
        project: "team/project",
        noteId: 87,
        mrIid: 31,
        prompt: "continue",
        agentType: "claude",
      },
      status: "processing",
      createdAt: new Date("2026-03-21T00:00:00.000Z"),
      startedAt: new Date("2026-03-21T00:00:01.000Z"),
      completedAt: null,
      error: null,
      idempotencyKey: "mr-note:87",
      retryCount: 0,
    };
    let failMessage = "";
    const gitlab = new FakeGitLabService();

    const queue: JobQueue = {
      listPending() {
        return ok([job]);
      },
      claimPending() {
        return ok(job);
      },
      claimNext() {
        return ok(job);
      },
      complete() {
        return err(queueError("database locked"));
      },
      enqueue(_input) {
        return ok(job);
      },
      fail(_id, message) {
        failMessage = message;
        return ok({
          ...job,
          status: "failed",
          completedAt: new Date("2026-03-21T00:00:02.000Z"),
          error: message,
          retryCount: 1,
        });
      },
      findByIdempotencyKey() {
        return ok(null);
      },
    };

    const worker = createWorker({
      queue,
      sessions: createSessionManager(createMigratedDatabase(databasePath)),
      gitlab,
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return ok(
          createAgentProcess({
            exitCode: 0,
            sessionId: "claude-session-31",
            stdout: "ok",
            stderr: "",
            durationMs: 100,
          }),
        );
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isErr()).toBe(true);
    if (runResult.isOk()) {
      return;
    }

    expect(runResult.error).toEqual(queueError("database locked"));
    expect(failMessage).toBe("queue_error: database locked");
    expect(gitlab.calls).toEqual([
      {
        kind: "reaction",
        target: { kind: "mr_note", project: "team/project", mrIid: 31, noteId: 87 },
        emoji: "eyes",
      },
      {
        kind: "mr_comment",
        project: "team/project",
        mrIid: 31,
        body: "Agent started with claude.",
      },
      {
        kind: "remove_reaction",
        target: { kind: "mr_note", project: "team/project", mrIid: 31, noteId: 87 },
        emoji: "eyes",
        awardId: 1,
      },
      {
        kind: "mr_comment",
        project: "team/project",
        mrIid: 31,
        body: "Agent failed: queue_error: database locked",
      },
      {
        kind: "reaction",
        target: { kind: "mr_note", project: "team/project", mrIid: 31, noteId: 87 },
        emoji: "warning",
      },
    ]);
  });

  it("preserves the startup agent error when the failure comment also fails", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);
    let mrCommentCount = 0;

    const enqueueResult = queue.enqueue({
      payload: {
        kind: "handle_mr_mention",
        project: "team/project",
        noteId: 901,
        mrIid: 19,
        prompt: "continue",
        agentType: "claude",
      },
      idempotencyKey: "mr-note:901",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab: {
        addReaction() {
          return okAsync(1);
        },
        clearReaction() {
          return okAsync(undefined);
        },
        removeReaction() {
          return okAsync(undefined);
        },
        postIssueComment() {
          return okAsync(undefined);
        },
        postMRComment() {
          mrCommentCount += 1;
          return mrCommentCount === 1
            ? okAsync(undefined)
            : fromPromise(
                Promise.reject(new Error("unreachable")),
                () => gitlabError("failure comment rejected"),
              ).map(() => undefined);
        },
      },
      logger: createLogger("fatal"),
      defaultAgent: "codex",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return err(agentError("claude binary missing", "claude", 127));
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isErr()).toBe(true);
    if (runResult.isOk()) {
      return;
    }

    expect(runResult.error).toEqual(agentError("claude binary missing", "claude", 127));

    const storedJobResult = queue.findByIdempotencyKey("mr-note:901");
    expect(storedJobResult.isOk()).toBe(true);
    if (storedJobResult.isErr()) {
      return;
    }

    expect(storedJobResult.value?.status).toBe("failed");
    expect(storedJobResult.value?.error).toBe("agent_error: claude binary missing");
  });

  it("preserves the runtime agent error when the failure comment also fails", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);
    let issueCommentCount = 0;

    const createSessionResult = sessions.create({
      agentType: "codex",
      agentSessionId: "codex-session-500",
      context: { kind: "issue", project: "team/project", issueIid: 500 },
    });
    expect(createSessionResult.isOk()).toBe(true);
    if (createSessionResult.isErr()) {
      return;
    }

    const enqueueResult = queue.enqueue({
      payload: {
        kind: "handle_mention",
        project: "team/project",
        noteId: 500,
        issueIid: 500,
        prompt: "continue",
        agentType: "codex",
      },
      idempotencyKey: "note:500",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab: {
        addReaction() {
          return okAsync(1);
        },
        clearReaction() {
          return okAsync(undefined);
        },
        removeReaction() {
          return okAsync(undefined);
        },
        postIssueComment() {
          issueCommentCount += 1;
          return issueCommentCount === 1
            ? okAsync(undefined)
            : fromPromise(
                Promise.reject(new Error("unreachable")),
                () => gitlabError("failure comment rejected"),
              ).map(() => undefined);
        },
        postMRComment() {
          return okAsync(undefined);
        },
      },
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return ok({
          pid: 55,
          result: Promise.resolve(err(agentError("agent crashed again", "codex", 22))),
          kill() {},
        });
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isErr()).toBe(true);
    if (runResult.isOk()) {
      return;
    }

    expect(runResult.error).toEqual(agentError("agent crashed again", "codex", 22));

    const storedJobResult = queue.findByIdempotencyKey("note:500");
    expect(storedJobResult.isOk()).toBe(true);
    if (storedJobResult.isErr()) {
      return;
    }

    expect(storedJobResult.value?.status).toBe("failed");
    expect(storedJobResult.value?.error).toBe("agent_error: agent crashed again");
  });

  it("fails the job when an agent reports a non-zero exit code in a successful result", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);
    const gitlab = new FakeGitLabService();

    const enqueueResult = queue.enqueue({
      payload: {
        kind: "handle_mention",
        project: "team/project",
        noteId: 333,
        issueIid: 17,
        prompt: "run it",
        agentType: "codex",
      },
      idempotencyKey: "note:333",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab,
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return ok(
          createAgentProcess({
            exitCode: 17,
            sessionId: "codex-session-333",
            stdout: "",
            stderr: "tests failed",
            durationMs: 220,
          }),
        );
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isErr()).toBe(true);
    if (runResult.isOk()) {
      return;
    }

    expect(runResult.error).toEqual(agentError("tests failed", "codex", 17));

    const storedJobResult = queue.findByIdempotencyKey("note:333");
    expect(storedJobResult.isOk()).toBe(true);
    if (storedJobResult.isErr()) {
      return;
    }

    expect(storedJobResult.value?.status).toBe("failed");
    expect(storedJobResult.value?.error).toBe("agent_error: tests failed");

    const lookupSessionResult = sessions.findByContext(
      {
        kind: "issue",
        project: "team/project",
        issueIid: 17,
      },
      "codex",
    );
    expect(lookupSessionResult.isOk()).toBe(true);
    if (lookupSessionResult.isErr()) {
      return;
    }

    expect(lookupSessionResult.value).not.toBeNull();
    if (lookupSessionResult.value === null) {
      return;
    }

    expect(lookupSessionResult.value.agentSessionId).toBe("codex-session-333");
    expect(lookupSessionResult.value.status).toBe("active");
    expect(gitlab.calls.at(-1)).toEqual({
      kind: "reaction",
      target: { kind: "issue_note", project: "team/project", issueIid: 17, noteId: 333 },
      emoji: "warning",
    });
  });

  it("reconstructs Gemini follow-up context in a fresh prompt", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);
    const gitlab = new FakeGitLabService();
    const spawnedConfigs: AgentConfig[] = [];

    const createSessionResult = sessions.create({
      agentType: "gemini",
      agentSessionId: "gemini-session-12",
      context: { kind: "mr", project: "team/project", mrIid: 12 },
    });
    expect(createSessionResult.isOk()).toBe(true);
    if (createSessionResult.isErr()) {
      return;
    }

    const enqueueResult = queue.enqueue({
      payload: {
        kind: "handle_mr_mention",
        project: "team/project",
        noteId: 612,
        mrIid: 12,
        prompt: "continue from the previous attempt",
        agentType: "gemini",
      },
      idempotencyKey: "mr-note:612",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab,
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent(config) {
        spawnedConfigs.push(config);
        return ok(
          createAgentProcess({
            exitCode: 0,
            sessionId: "gemini-session-13",
            stdout: "ok",
            stderr: "",
            durationMs: 150,
          }),
        );
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isOk()).toBe(true);
    if (runResult.isErr()) {
      return;
    }

    expect(spawnedConfigs).toHaveLength(1);
    expect(spawnedConfigs[0]?.sessionId).toBeUndefined();
    expect(spawnedConfigs[0]?.prompt).toContain("Gemini cannot resume headless sessions");
    expect(spawnedConfigs[0]?.prompt).toContain("read the existing GitLab merge request");
    expect(spawnedConfigs[0]?.prompt).toContain("continue from the previous attempt");
  });

  it("keeps the prior Gemini session active when a fresh follow-up attempt fails", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);

    const createSessionResult = sessions.create({
      agentType: "gemini",
      agentSessionId: "gemini-session-44",
      context: { kind: "issue", project: "team/project", issueIid: 44 },
    });
    expect(createSessionResult.isOk()).toBe(true);
    if (createSessionResult.isErr()) {
      return;
    }

    const enqueueResult = queue.enqueue({
      payload: {
        kind: "handle_mention",
        project: "team/project",
        noteId: 744,
        issueIid: 44,
        prompt: "continue from the previous attempt",
        agentType: "gemini",
      },
      idempotencyKey: "note:744",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab: new FakeGitLabService(),
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace,
      spawnAgent() {
        return ok({
          pid: 77,
          result: Promise.resolve(err(agentError("gemini crashed", "gemini", 9))),
          kill() {},
        });
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isErr()).toBe(true);
    if (runResult.isOk()) {
      return;
    }

    expect(runResult.error).toEqual(agentError("gemini crashed", "gemini", 9));

    const lookupSessionResult = sessions.findByContext(
      {
        kind: "issue",
        project: "team/project",
        issueIid: 44,
      },
      "gemini",
    );
    expect(lookupSessionResult.isOk()).toBe(true);
    if (lookupSessionResult.isErr()) {
      return;
    }

    expect(lookupSessionResult.value).not.toBeNull();
    if (lookupSessionResult.value === null) {
      return;
    }

    expect(lookupSessionResult.value.id).toBe(createSessionResult.value.id);
    expect(lookupSessionResult.value.status).toBe("active");
  });

  it("whitelists the inherited environment when worker env is omitted", async () => {
    const previousCodexApiKey = process.env["CODEX_API_KEY"];
    const previousToken = process.env["GITLAB_TOKEN"];
    const previousSecret = process.env["GITLAB_WEBHOOK_SECRET"];
    process.env["CODEX_API_KEY"] = "codex-api-key";
    process.env["GITLAB_TOKEN"] = "worker-token";
    process.env["GITLAB_WEBHOOK_SECRET"] = "webhook-secret";

    try {
      const database = createMigratedDatabase(databasePath);
      const queue = createJobQueue(database);
      const sessions = createSessionManager(database);
      const gitlab = new FakeGitLabService();
      const spawnedConfigs: AgentConfig[] = [];

      const enqueueResult = queue.enqueue({
        payload: {
          kind: "handle_mr_mention",
          project: "team/project",
          noteId: 999,
          mrIid: 22,
          prompt: "check env",
          agentType: "codex",
        },
        idempotencyKey: "mr-note:999",
      });
      expect(enqueueResult.isOk()).toBe(true);
      if (enqueueResult.isErr()) {
        return;
      }

      const worker = createWorker({
        queue,
        sessions,
        gitlab,
        logger: createLogger("fatal"),
        defaultAgent: "claude",
        workDir: process.cwd(),
        timeoutMs: 60_000,
        prepareWorkspace,
        spawnAgent(config) {
          spawnedConfigs.push(config);
          return ok(
            createAgentProcess({
              exitCode: 0,
              sessionId: "codex-env-22",
              stdout: "ok",
              stderr: "",
              durationMs: 100,
            }),
          );
        },
      });

      const runResult = await worker.runNextJob();
      expect(runResult.isOk()).toBe(true);
      if (runResult.isErr()) {
        return;
      }

      expect(spawnedConfigs).toHaveLength(1);
      expect(spawnedConfigs[0]?.env["CODEX_API_KEY"]).toBe("codex-api-key");
      expect(spawnedConfigs[0]?.env["GITLAB_TOKEN"]).toBe("worker-token");
      expect(spawnedConfigs[0]?.env["GITLAB_WEBHOOK_SECRET"]).toBeUndefined();
      expect(spawnedConfigs[0]?.env["PATH"]).toBe(process.env["PATH"]);
    } finally {
      if (previousCodexApiKey === undefined) {
        delete process.env["CODEX_API_KEY"];
      } else {
        process.env["CODEX_API_KEY"] = previousCodexApiKey;
      }

      if (previousToken === undefined) {
        delete process.env["GITLAB_TOKEN"];
      } else {
        process.env["GITLAB_TOKEN"] = previousToken;
      }

      if (previousSecret === undefined) {
        delete process.env["GITLAB_WEBHOOK_SECRET"];
      } else {
        process.env["GITLAB_WEBHOOK_SECRET"] = previousSecret;
      }
    }
  });

  it("merges custom worker env with the inherited whitelist", async () => {
    const previousCodexApiKey = process.env["CODEX_API_KEY"];
    const previousToken = process.env["GITLAB_TOKEN"];
    process.env["CODEX_API_KEY"] = "codex-api-key";
    process.env["GITLAB_TOKEN"] = "worker-token";

    try {
      const database = createMigratedDatabase(databasePath);
      const queue = createJobQueue(database);
      const sessions = createSessionManager(database);
      const gitlab = new FakeGitLabService();
      const spawnedConfigs: AgentConfig[] = [];

      const enqueueResult = queue.enqueue({
        payload: {
          kind: "handle_mr_mention",
          project: "team/project",
          noteId: 1001,
          mrIid: 23,
          prompt: "check merged env",
          agentType: "codex",
        },
        idempotencyKey: "mr-note:1001",
      });
      expect(enqueueResult.isOk()).toBe(true);
      if (enqueueResult.isErr()) {
        return;
      }

      const worker = createWorker({
        queue,
        sessions,
        gitlab,
        logger: createLogger("fatal"),
        defaultAgent: "claude",
        workDir: process.cwd(),
        timeoutMs: 60_000,
        env: {
          EXTRA_FLAG: "enabled",
        },
        prepareWorkspace,
        spawnAgent(config) {
          spawnedConfigs.push(config);
          return ok(
            createAgentProcess({
              exitCode: 0,
              sessionId: "codex-env-23",
              stdout: "ok",
              stderr: "",
              durationMs: 100,
            }),
          );
        },
      });

      const runResult = await worker.runNextJob();
      expect(runResult.isOk()).toBe(true);
      if (runResult.isErr()) {
        return;
      }

      expect(spawnedConfigs).toHaveLength(1);
      expect(spawnedConfigs[0]?.env["EXTRA_FLAG"]).toBe("enabled");
      expect(spawnedConfigs[0]?.env["CODEX_API_KEY"]).toBe("codex-api-key");
      expect(spawnedConfigs[0]?.env["GITLAB_TOKEN"]).toBe("worker-token");
      expect(spawnedConfigs[0]?.env["PATH"]).toBe(process.env["PATH"]);
    } finally {
      if (previousCodexApiKey === undefined) {
        delete process.env["CODEX_API_KEY"];
      } else {
        process.env["CODEX_API_KEY"] = previousCodexApiKey;
      }

      if (previousToken === undefined) {
        delete process.env["GITLAB_TOKEN"];
      } else {
        process.env["GITLAB_TOKEN"] = previousToken;
      }
    }
  });

  it("fails the job before spawning when workspace preparation fails", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const sessions = createSessionManager(database);
    const gitlab = new FakeGitLabService();
    let spawnCount = 0;

    const enqueueResult = queue.enqueue({
      payload: {
        kind: "review_mr",
        project: "team/project",
        mrIid: 91,
      },
      idempotencyKey: "mr:91",
    });
    expect(enqueueResult.isOk()).toBe(true);
    if (enqueueResult.isErr()) {
      return;
    }

    const worker = createWorker({
      queue,
      sessions,
      gitlab,
      logger: createLogger("fatal"),
      defaultAgent: "claude",
      workDir: process.cwd(),
      timeoutMs: 60_000,
      prepareWorkspace() {
        return err(queueError("workspace unavailable"));
      },
      spawnAgent() {
        spawnCount += 1;
        return ok(
          createAgentProcess({
            exitCode: 0,
            sessionId: "claude-review-91",
            stdout: "ok",
            stderr: "",
            durationMs: 100,
          }),
        );
      },
    });

    const runResult = await worker.runNextJob();
    expect(runResult.isErr()).toBe(true);
    if (runResult.isOk()) {
      return;
    }

    expect(runResult.error).toEqual(queueError("workspace unavailable"));
    expect(spawnCount).toBe(0);
    expect(gitlab.calls).toEqual([
      {
        kind: "reaction",
        target: { kind: "mr", project: "team/project", mrIid: 91 },
        emoji: "eyes",
      },
      {
        kind: "remove_reaction",
        target: { kind: "mr", project: "team/project", mrIid: 91 },
        emoji: "eyes",
        awardId: 1,
      },
      {
        kind: "reaction",
        target: { kind: "mr", project: "team/project", mrIid: 91 },
        emoji: "warning",
      },
    ]);

    const storedJobResult = queue.findByIdempotencyKey("mr:91");
    expect(storedJobResult.isOk()).toBe(true);
    if (storedJobResult.isErr()) {
      return;
    }

    expect(storedJobResult.value?.status).toBe("failed");
    expect(storedJobResult.value?.error).toBe("queue_error: workspace unavailable");
  });
});
