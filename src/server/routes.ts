import { rmSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { Config } from "../config/config.ts";
import { WEBHOOK_HEADER_EVENT, WEBHOOK_HEADER_IDEMPOTENCY } from "../config/constants.ts";
import type { Logger } from "../config/logger.ts";
import { parseWebhookPayload } from "../events/parser.ts";
import { type RoutingDecision, routeEvent } from "../events/router.ts";
import type { ReactionTarget } from "../gitlab/service.ts";
import { sanitizePathSegment } from "../index.ts";
import type { EnqueueJobInput } from "../jobs/queue.ts";
import type { Job } from "../jobs/types.ts";
import type { AppError } from "../types/errors.ts";
import type { EmojiName, WebhookEvent } from "../types/events.ts";
import type { Result, ResultAsync } from "../types/result.ts";
import { authMiddleware, requestIdMiddleware } from "./middleware.ts";

type DeliveryStore = Map<string, number>;

type AppOptions = {
  readonly dedupeTtlMs?: number;
  readonly now?: () => number;
};

export interface AppDependencies {
  readonly enqueueJob?: (input: EnqueueJobInput) => Result<Job, AppError>;
  readonly addReaction?: (
    target: ReactionTarget,
    emoji: EmojiName,
  ) => ResultAsync<number, AppError>;
  readonly closeSessionsByContext?: (
    contextKind: "issue" | "mr",
    project: string,
    iid: number,
  ) => Result<number, AppError>;
  readonly workDir?: string;
}

const DEFAULT_DEDUPE_TTL_MS = 60 * 60 * 1000;

function jsonResponse(
  requestId: string,
  statusCode: number,
  payload: Record<string, unknown>,
): Response {
  return Response.json(
    { ...payload, requestId },
    { status: statusCode, headers: { "x-request-id": requestId } },
  );
}

function getDeliveryKey(idempotencyKey: string, deliveryId: string): string {
  if (idempotencyKey.length > 0) {
    return idempotencyKey;
  }

  return deliveryId;
}

function pruneExpiredDeliveries(
  deliveryStore: DeliveryStore,
  now: number,
  dedupeTtlMs: number,
): void {
  for (const [deliveryKey, seenAt] of deliveryStore.entries()) {
    if (now - seenAt > dedupeTtlMs) {
      deliveryStore.delete(deliveryKey);
    }
  }
}

function errorResponse(requestId: string, statusCode: number, message: string): Response {
  return Response.json(
    {
      status: "error",
      error: { code: "internal_error", message },
      requestId,
    },
    { status: statusCode, headers: { "x-request-id": requestId } },
  );
}

function enqueueRoutedJob(
  requestId: string,
  routeResult: Extract<RoutingDecision, { readonly kind: "enqueue" }>,
  deliveryKey: string,
  deliveryStore: DeliveryStore,
  requestLogger: Logger,
  dependencies: AppDependencies,
): Response {
  if (dependencies.enqueueJob === undefined) {
    deliveryStore.delete(deliveryKey);
    requestLogger.error("Webhook route is missing an enqueue dependency");
    return errorResponse(requestId, 500, "Webhook route is not configured to enqueue jobs");
  }

  const enqueueResult = dependencies.enqueueJob({
    payload: routeResult.payload,
    idempotencyKey: routeResult.idempotencyKey,
  });
  if (enqueueResult.isErr()) {
    deliveryStore.delete(deliveryKey);
    requestLogger.error({ error: enqueueResult.error }, "Failed to enqueue webhook job");
    return errorResponse(requestId, 500, enqueueResult.error.message);
  }

  return Response.json(
    { status: "accepted", jobId: enqueueResult.value.id, requestId },
    { status: 202, headers: { "x-request-id": requestId } },
  );
}

function cleanupWorkspace(
  project: string,
  target: "issue" | "mr",
  iid: number,
  workDir: string,
  logger: Logger,
): void {
  const projectDir = sanitizePathSegment(project);
  const suffix = target === "issue" ? `issue-${iid}` : `mr-${iid}`;
  const workspacePath = join(workDir, projectDir, suffix);
  try {
    rmSync(workspacePath, { recursive: true, force: true });
    logger.info({ workspacePath }, "Workspace cleaned up");
  } catch (cause) {
    logger.warn({ workspacePath, error: cause }, "Failed to clean up workspace");
  }
}

async function handleBlockedDecision(
  requestId: string,
  decision: Extract<RoutingDecision, { readonly kind: "blocked" }>,
  requestLogger: Logger,
  dependencies: AppDependencies,
): Promise<Response> {
  requestLogger.info({ reason: decision.reason }, "Mention blocked on closed item");
  if (dependencies.addReaction !== undefined) {
    const reactionResult = await dependencies.addReaction(
      decision.target as ReactionTarget,
      "no_entry_sign",
    );
    if (reactionResult.isErr()) {
      requestLogger.warn({ error: reactionResult.error }, "Failed to add blocked reaction");
    }
  }
  return jsonResponse(requestId, 202, { status: "blocked", reason: decision.reason });
}

function handleCleanupDecision(
  requestId: string,
  decision: Extract<RoutingDecision, { readonly kind: "cleanup" }>,
  requestLogger: Logger,
  dependencies: AppDependencies,
): Response {
  requestLogger.info(
    { project: decision.project, target: decision.target, iid: decision.iid },
    "Running cleanup for closed item",
  );
  if (dependencies.workDir !== undefined) {
    cleanupWorkspace(
      decision.project,
      decision.target,
      decision.iid,
      dependencies.workDir,
      requestLogger,
    );
  }
  if (dependencies.closeSessionsByContext !== undefined) {
    const closeResult = dependencies.closeSessionsByContext(
      decision.target,
      decision.project,
      decision.iid,
    );
    if (closeResult.isErr()) {
      requestLogger.warn({ error: closeResult.error }, "Failed to close sessions");
    } else {
      requestLogger.info({ closed: closeResult.value }, "Sessions closed");
    }
  }
  return jsonResponse(requestId, 202, { status: "cleaned" });
}

function handleDecision(
  requestId: string,
  decision: RoutingDecision,
  deliveryKey: string,
  deliveryStore: DeliveryStore,
  requestLogger: Logger,
  dependencies: AppDependencies,
): Response | Promise<Response> {
  switch (decision.kind) {
    case "ignore":
      requestLogger.info({ reason: decision.reason }, "Webhook event ignored during routing");
      return jsonResponse(requestId, 202, { status: "ignored", reason: decision.reason });
    case "blocked":
      return handleBlockedDecision(requestId, decision, requestLogger, dependencies);
    case "cleanup":
      return handleCleanupDecision(requestId, decision, requestLogger, dependencies);
    case "enqueue":
      return enqueueRoutedJob(
        requestId,
        decision,
        deliveryKey,
        deliveryStore,
        requestLogger,
        dependencies,
      );
  }
}

function parseBody(
  requestId: string,
  eventType: string,
  body: unknown,
  requestLogger: Logger,
): Response | { readonly event: Exclude<WebhookEvent, { readonly kind: "ignored" }> } {
  const parseResult = parseWebhookPayload(eventType, body);
  if (parseResult.isErr()) {
    requestLogger.warn({ error: parseResult.error }, "Failed to parse webhook payload");
    return Response.json(
      {
        status: "error",
        error: { code: "invalid_payload", message: parseResult.error.message },
        requestId,
      },
      { status: 400, headers: { "x-request-id": requestId } },
    );
  }

  if (parseResult.value.kind === "ignored") {
    requestLogger.info({ reason: parseResult.value.reason }, "Webhook event ignored");
    return jsonResponse(requestId, 202, {
      status: "ignored",
      reason: parseResult.value.reason,
    });
  }

  return { event: parseResult.value };
}

export function createApp(
  config: Config,
  logger: Logger,
  deliveryStore: DeliveryStore = new Map(),
  options: AppOptions = {},
  dependencies: AppDependencies = {},
): Hono {
  const dedupeTtlMs = options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS;
  const now = options.now ?? Date.now;
  const app = new Hono();
  app.use("*", requestIdMiddleware(logger));

  app.get("/health", (c) => {
    return jsonResponse(c.var.requestId, 200, { status: "ok" });
  });

  const webhook = new Hono();
  webhook.use("*", authMiddleware(config.gitlabWebhookSecret, logger));

  webhook.post("/", async (c) => {
    const requestId = c.var.requestId;
    const deliveryId = c.var.deliveryId;
    const requestLogger = c.var.logger;
    const eventType = c.req.header(WEBHOOK_HEADER_EVENT) ?? "";
    const idempotencyKey = c.req.header(WEBHOOK_HEADER_IDEMPOTENCY) ?? "";

    requestLogger.info({ eventType, idempotencyKey }, "Processing webhook");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      requestLogger.warn("Webhook payload is not valid JSON");
      return jsonResponse(requestId, 400, {
        status: "error",
        error: { code: "invalid_payload", message: "Request body must be valid JSON" },
      });
    }

    const parsed = parseBody(requestId, eventType, body, requestLogger);
    if (parsed instanceof Response) {
      return parsed;
    }

    pruneExpiredDeliveries(deliveryStore, now(), dedupeTtlMs);

    const deliveryKey = getDeliveryKey(idempotencyKey, deliveryId);
    if (deliveryStore.has(deliveryKey)) {
      requestLogger.info({ deliveryKey }, "Duplicate webhook delivery ignored");
      return jsonResponse(requestId, 202, { status: "duplicate" });
    }
    deliveryStore.set(deliveryKey, now());

    const routeResult = routeEvent(
      parsed.event,
      { botUsername: config.botUsername, defaultAgent: config.defaultAgent },
      requestLogger,
    );
    if (routeResult.isErr()) {
      deliveryStore.delete(deliveryKey);
      requestLogger.error({ error: routeResult.error }, "Failed to route event");
      return errorResponse(requestId, 500, routeResult.error.message);
    }

    return handleDecision(
      requestId,
      routeResult.value,
      deliveryKey,
      deliveryStore,
      requestLogger,
      dependencies,
    );
  });

  app.route("/webhook", webhook);

  return app;
}
