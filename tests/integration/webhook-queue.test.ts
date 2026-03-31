import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { Config } from "../../src/config/config.ts";
import {
  WEBHOOK_HEADER_EVENT,
  WEBHOOK_HEADER_IDEMPOTENCY,
  WEBHOOK_HEADER_TOKEN,
  WEBHOOK_HEADER_UUID,
} from "../../src/config/constants.ts";
import { createJobQueue } from "../../src/jobs/queue.ts";
import { createApp } from "../../src/server/routes.ts";
import { createMigratedDatabase } from "../helpers/database.ts";

const config: Config = {
  gitlabWebhookSecret: "top-secret",
  botUsername: "review-bot",
  gitlabToken: "token",
  gitlabHost: "https://gitlab.example.com",
  defaultAgent: "claude",
  port: 3000,
  databasePath: ":memory:",
  logLevel: "info",
  claudeConcurrency: 2,
  codexConcurrency: 1,
  geminiConcurrency: 1,
  agentTimeoutMs: 600_000,
  claudePath: "claude",
  codexPath: "codex",
  geminiPath: "gemini",
};

const logger = pino({ enabled: false });

const noteOnIssuePayload = {
  object_kind: "note",
  user: { id: 1, username: "dev", name: "Developer" },
  project: {
    id: 5,
    path_with_namespace: "team/project",
    web_url: "https://gitlab.example.com/team/project",
    default_branch: "main",
  },
  object_attributes: {
    id: 100,
    note: "@review-bot codex fix this bug",
    noteable_type: "Issue",
    noteable_id: 42,
    action: "create",
    url: "https://gitlab.example.com/team/project/issues/42#note_100",
    system: false,
  },
  issue: { id: 42, iid: 17, title: "Bug report", description: "It crashes", state: "opened" },
};

let databasePath = "";

beforeEach(() => {
  databasePath = join(tmpdir(), `glab-review-webhook-webhook-${crypto.randomUUID()}.sqlite`);
});

afterEach(() => {
  const cleanupPaths = [databasePath, `${databasePath}-shm`, `${databasePath}-wal`];

  for (const cleanupPath of cleanupPaths) {
    if (existsSync(cleanupPath)) {
      unlinkSync(cleanupPath);
    }
  }
});

describe("webhook queue integration", () => {
  it("enqueues a mention job and returns its job ID", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const app = createApp(config, logger, new Map(), {}, { enqueueJob: queue.enqueue.bind(queue) });

    const response = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_HEADER_TOKEN]: config.gitlabWebhookSecret,
        [WEBHOOK_HEADER_EVENT]: "Note Hook",
        [WEBHOOK_HEADER_UUID]: "req-123",
        [WEBHOOK_HEADER_IDEMPOTENCY]: "delivery-123",
      },
      body: JSON.stringify(noteOnIssuePayload),
    });

    expect(response.status).toBe(202);

    const responseBody: unknown = await response.json();

    expect(responseBody).toMatchObject({
      status: "accepted",
      requestId: "req-123",
    });
    if (
      typeof responseBody !== "object" ||
      responseBody === null ||
      !("jobId" in responseBody) ||
      typeof responseBody.jobId !== "string"
    ) {
      return;
    }

    const pendingJobsResult = queue.listPending();
    expect(pendingJobsResult.isOk()).toBe(true);
    if (pendingJobsResult.isErr()) {
      return;
    }

    expect(pendingJobsResult.value).toHaveLength(1);
    expect(String(pendingJobsResult.value[0]?.id)).toBe(responseBody.jobId);
    expect(pendingJobsResult.value[0]?.payload).toEqual({
      kind: "handle_mention",
      project: "team/project",
      noteId: 100,
      issueIid: 17,
      prompt: "fix this bug",
      agentType: "codex",
      defaultBranch: "main",
    });
  });

  it("re-enqueues a replayed delivery after the earlier job has failed", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const app = createApp(config, logger, new Map(), {}, { enqueueJob: queue.enqueue.bind(queue) });

    const firstResponse = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_HEADER_TOKEN]: config.gitlabWebhookSecret,
        [WEBHOOK_HEADER_EVENT]: "Note Hook",
        [WEBHOOK_HEADER_UUID]: "req-123",
        [WEBHOOK_HEADER_IDEMPOTENCY]: "delivery-123",
      },
      body: JSON.stringify(noteOnIssuePayload),
    });
    expect(firstResponse.status).toBe(202);

    const claimedJobResult = queue.claimNext();
    expect(claimedJobResult.isOk()).toBe(true);
    if (claimedJobResult.isErr() || claimedJobResult.value === null) {
      return;
    }

    const failResult = queue.fail(claimedJobResult.value.id, "temporary failure");
    expect(failResult.isOk()).toBe(true);
    if (failResult.isErr()) {
      return;
    }

    const replayResponse = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_HEADER_TOKEN]: config.gitlabWebhookSecret,
        [WEBHOOK_HEADER_EVENT]: "Note Hook",
        [WEBHOOK_HEADER_UUID]: "req-456",
        [WEBHOOK_HEADER_IDEMPOTENCY]: "delivery-456",
      },
      body: JSON.stringify(noteOnIssuePayload),
    });
    expect(replayResponse.status).toBe(202);

    const pendingJobsResult = queue.listPending();
    expect(pendingJobsResult.isOk()).toBe(true);
    if (pendingJobsResult.isErr()) {
      return;
    }

    expect(pendingJobsResult.value).toHaveLength(1);
    expect(pendingJobsResult.value[0]?.payload).toEqual({
      kind: "handle_mention",
      project: "team/project",
      noteId: 100,
      issueIid: 17,
      prompt: "fix this bug",
      agentType: "codex",
      defaultBranch: "main",
    });
  });

  it("preserves completed jobs for replayed deliveries", async () => {
    const database = createMigratedDatabase(databasePath);
    const queue = createJobQueue(database);
    const app = createApp(config, logger, new Map(), {}, { enqueueJob: queue.enqueue.bind(queue) });

    const firstResponse = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_HEADER_TOKEN]: config.gitlabWebhookSecret,
        [WEBHOOK_HEADER_EVENT]: "Note Hook",
        [WEBHOOK_HEADER_UUID]: "req-123",
        [WEBHOOK_HEADER_IDEMPOTENCY]: "delivery-123",
      },
      body: JSON.stringify(noteOnIssuePayload),
    });
    expect(firstResponse.status).toBe(202);

    const firstBody: unknown = await firstResponse.json();
    if (
      typeof firstBody !== "object" ||
      firstBody === null ||
      !("jobId" in firstBody) ||
      typeof firstBody.jobId !== "string"
    ) {
      return;
    }

    const claimedJobResult = queue.claimNext();
    expect(claimedJobResult.isOk()).toBe(true);
    if (claimedJobResult.isErr() || claimedJobResult.value === null) {
      return;
    }

    const completeResult = queue.complete(claimedJobResult.value.id);
    expect(completeResult.isOk()).toBe(true);
    if (completeResult.isErr()) {
      return;
    }

    const replayResponse = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_HEADER_TOKEN]: config.gitlabWebhookSecret,
        [WEBHOOK_HEADER_EVENT]: "Note Hook",
        [WEBHOOK_HEADER_UUID]: "req-456",
        [WEBHOOK_HEADER_IDEMPOTENCY]: "delivery-456",
      },
      body: JSON.stringify(noteOnIssuePayload),
    });
    expect(replayResponse.status).toBe(202);
    expect(await replayResponse.json()).toEqual({
      status: "accepted",
      jobId: firstBody.jobId,
      requestId: "req-456",
    });

    const pendingJobsResult = queue.listPending();
    expect(pendingJobsResult.isOk()).toBe(true);
    if (pendingJobsResult.isErr()) {
      return;
    }

    expect(pendingJobsResult.value).toHaveLength(0);
  });
});
