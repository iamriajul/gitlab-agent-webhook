import { Hono } from "hono";
import type { Config } from "../config/config.ts";
import { WEBHOOK_HEADER_EVENT, WEBHOOK_HEADER_IDEMPOTENCY } from "../config/constants.ts";
import type { Logger } from "../config/logger.ts";
import { parseWebhookPayload } from "../events/parser.ts";
import { type RoutingDecision, routeEvent } from "../events/router.ts";
import type { EnqueueJobInput } from "../jobs/queue.ts";
import type { Job } from "../jobs/types.ts";
import type { AppError } from "../types/errors.ts";
import type { Result } from "../types/result.ts";
import { authMiddleware, requestIdMiddleware } from "./middleware.ts";

type DeliveryStore = Map<string, number>;

type AppOptions = {
  readonly dedupeTtlMs?: number;
  readonly now?: () => number;
};

export interface AppDependencies {
  readonly enqueueJob?: (input: EnqueueJobInput) => Result<Job, AppError>;
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

    pruneExpiredDeliveries(deliveryStore, now(), dedupeTtlMs);

    const deliveryKey = getDeliveryKey(idempotencyKey, deliveryId);
    if (deliveryStore.has(deliveryKey)) {
      requestLogger.info({ deliveryKey }, "Duplicate webhook delivery ignored");
      return jsonResponse(requestId, 202, { status: "duplicate" });
    }
    deliveryStore.set(deliveryKey, now());

    const routeResult = routeEvent(
      parseResult.value,
      {
        botUsername: config.botUsername,
        defaultAgent: config.defaultAgent,
      },
      requestLogger,
    );
    if (routeResult.isErr()) {
      deliveryStore.delete(deliveryKey);
      requestLogger.error({ error: routeResult.error }, "Failed to route event");
      return Response.json(
        {
          status: "error",
          error: { code: "internal_error", message: routeResult.error.message },
          requestId,
        },
        { status: 500, headers: { "x-request-id": requestId } },
      );
    }

    if (routeResult.value.kind === "ignore") {
      requestLogger.info(
        { reason: routeResult.value.reason },
        "Webhook event ignored during routing",
      );
      return jsonResponse(requestId, 202, {
        status: "ignored",
        reason: routeResult.value.reason,
      });
    }

    return enqueueRoutedJob(
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
