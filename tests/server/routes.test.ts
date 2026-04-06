import { describe, expect, it } from "bun:test";
import pino from "pino";
import type { Config } from "../../src/config/config.ts";
import {
  WEBHOOK_HEADER_EVENT,
  WEBHOOK_HEADER_IDEMPOTENCY,
  WEBHOOK_HEADER_TOKEN,
  WEBHOOK_HEADER_UUID,
} from "../../src/config/constants.ts";
import type { EnqueueJobInput } from "../../src/jobs/queue.ts";
import type { Job } from "../../src/jobs/types.ts";
import { createApp } from "../../src/server/routes.ts";
import { jobId } from "../../src/types/branded.ts";
import { ok } from "../../src/types/result.ts";

const config: Config = {
  gitlabWebhookSecret: "top-secret",
  botUsername: "agent",
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
    note: "@agent fix this bug",
    noteable_type: "Issue",
    noteable_id: 42,
    action: "create",
    url: "https://gitlab.example.com/team/project/issues/42#note_100",
    system: false,
  },
  issue: { id: 42, iid: 17, title: "Bug report", description: "It crashes", state: "opened" },
};

function createHeaders(overrides?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    [WEBHOOK_HEADER_TOKEN]: config.gitlabWebhookSecret,
    [WEBHOOK_HEADER_EVENT]: "Note Hook",
    [WEBHOOK_HEADER_UUID]: "req-123",
    [WEBHOOK_HEADER_IDEMPOTENCY]: "delivery-123",
    ...overrides,
  };
}

function createQueueDependencies() {
  let nextQueuedJob = 1;

  return {
    enqueueJob(input: EnqueueJobInput) {
      const jobNumber = nextQueuedJob;
      nextQueuedJob += 1;

      const job: Job = {
        id: jobId(`job-${jobNumber}`),
        payload: input.payload,
        status: "pending",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        startedAt: null,
        completedAt: null,
        error: null,
        idempotencyKey: input.idempotencyKey,
        retryCount: 0,
      };

      return ok(job);
    },
  };
}

describe("createApp", () => {
  it("returns health with request ID", async () => {
    const app = createApp(config, logger);

    const response = await app.request("/health", {
      headers: { "x-request-id": "health-123" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("health-123");
    expect(await response.json()).toMatchObject({
      status: "ok",
      requestId: "health-123",
    });
  });

  it("rejects webhook requests with an invalid token", async () => {
    const app = createApp(config, logger);

    const response = await app.request("/webhook", {
      method: "POST",
      headers: createHeaders({ [WEBHOOK_HEADER_TOKEN]: "wrong-secret" }),
      body: JSON.stringify(noteOnIssuePayload),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBe("req-123");
    expect(await response.json()).toEqual({
      status: "error",
      error: { code: "unauthorized", message: "Unauthorized" },
      requestId: "req-123",
    });
  });

  it("returns a stable parse error response for invalid JSON payloads", async () => {
    const app = createApp(config, logger);

    const response = await app.request("/webhook", {
      method: "POST",
      headers: createHeaders(),
      body: "{invalid-json",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      status: "error",
      error: { code: "invalid_payload", message: "Request body must be valid JSON" },
      requestId: "req-123",
    });
  });

  it("returns a stable parse error response for invalid webhook payloads", async () => {
    const app = createApp(config, logger);

    const response = await app.request("/webhook", {
      method: "POST",
      headers: createHeaders(),
      body: JSON.stringify({ object_kind: "note" }),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("req-123");
    expect(await response.json()).toMatchObject({
      status: "error",
      error: { code: "invalid_payload" },
      requestId: "req-123",
    });
  });

  it("returns ignored for unhandled events", async () => {
    const app = createApp(config, logger);

    const response = await app.request("/webhook", {
      method: "POST",
      headers: createHeaders({ [WEBHOOK_HEADER_EVENT]: "Push Hook" }),
      body: JSON.stringify({ object_kind: "push" }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "ignored",
      reason: "Unhandled event type: Push Hook",
      requestId: "req-123",
    });
  });

  it("accepts valid webhook events", async () => {
    const app = createApp(config, logger, new Map(), {}, createQueueDependencies());

    const response = await app.request("/webhook", {
      method: "POST",
      headers: createHeaders(),
      body: JSON.stringify(noteOnIssuePayload),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "accepted",
      jobId: "job-1",
      requestId: "req-123",
    });
  });

  it("returns ignored when a supported note does not mention the bot", async () => {
    const app = createApp(config, logger);

    const response = await app.request("/webhook", {
      method: "POST",
      headers: createHeaders({ "x-request-id": "no-mention" }),
      body: JSON.stringify({
        ...noteOnIssuePayload,
        object_attributes: {
          ...noteOnIssuePayload.object_attributes,
          note: "@alice please handle this",
        },
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "ignored",
      reason: "Bot was not mentioned in issue note",
      requestId: "no-mention",
    });
  });

  it("deduplicates repeated deliveries", async () => {
    const app = createApp(config, logger, new Map(), {}, createQueueDependencies());

    const firstResponse = await app.request("/webhook", {
      method: "POST",
      headers: createHeaders(),
      body: JSON.stringify(noteOnIssuePayload),
    });
    const secondResponse = await app.request("/webhook", {
      method: "POST",
      headers: createHeaders({ [WEBHOOK_HEADER_UUID]: "req-456" }),
      body: JSON.stringify(noteOnIssuePayload),
    });

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(await secondResponse.json()).toEqual({
      status: "duplicate",
      requestId: "req-456",
    });
  });

  it("deduplicates by webhook UUID when idempotency key is missing", async () => {
    const app = createApp(config, logger, new Map(), {}, createQueueDependencies());

    const firstResponse = await app.request("/webhook", {
      method: "POST",
      headers: createHeaders({
        [WEBHOOK_HEADER_IDEMPOTENCY]: "",
        [WEBHOOK_HEADER_UUID]: "gitlab-delivery-1",
        "x-request-id": "proxy-request-1",
      }),
      body: JSON.stringify(noteOnIssuePayload),
    });
    const secondResponse = await app.request("/webhook", {
      method: "POST",
      headers: createHeaders({
        [WEBHOOK_HEADER_IDEMPOTENCY]: "",
        [WEBHOOK_HEADER_UUID]: "gitlab-delivery-1",
        "x-request-id": "proxy-request-2",
      }),
      body: JSON.stringify(noteOnIssuePayload),
    });

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(await secondResponse.json()).toEqual({
      status: "duplicate",
      requestId: "proxy-request-2",
    });
  });

  it("expires old delivery keys after the dedupe window", async () => {
    let now = 10_000;
    const app = createApp(
      config,
      logger,
      new Map(),
      {
        dedupeTtlMs: 1_000,
        now: () => now,
      },
      createQueueDependencies(),
    );

    const firstResponse = await app.request("/webhook", {
      method: "POST",
      headers: createHeaders(),
      body: JSON.stringify(noteOnIssuePayload),
    });

    now += 1_001;

    const secondResponse = await app.request("/webhook", {
      method: "POST",
      headers: createHeaders({ "x-request-id": "after-ttl" }),
      body: JSON.stringify(noteOnIssuePayload),
    });

    expect(firstResponse.status).toBe(202);
    expect(await firstResponse.json()).toMatchObject({ status: "accepted" });
    expect(secondResponse.status).toBe(202);
    expect(await secondResponse.json()).toEqual({
      status: "accepted",
      jobId: "job-2",
      requestId: "after-ttl",
    });
  });
});
