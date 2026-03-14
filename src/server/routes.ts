import { Hono } from "hono";
import type { Config } from "../config/config.ts";
import { WEBHOOK_HEADER_EVENT, WEBHOOK_HEADER_IDEMPOTENCY } from "../config/constants.ts";
import type { Logger } from "../config/logger.ts";
import { parseWebhookPayload } from "../events/parser.ts";
import { routeEvent } from "../events/router.ts";
import { authMiddleware, requestIdMiddleware } from "./middleware.ts";

type DeliveryStore = Set<string>;

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

function getDeliveryKey(idempotencyKey: string, requestId: string): string {
  if (idempotencyKey.length > 0) {
    return idempotencyKey;
  }

  return requestId;
}

export function createApp(
  config: Config,
  logger: Logger,
  deliveryStore: DeliveryStore = new Set(),
): Hono {
  const app = new Hono();
  app.use("*", requestIdMiddleware(logger));

  app.get("/health", (c) => {
    return jsonResponse(c.var.requestId, 200, { status: "ok" });
  });

  const webhook = new Hono();
  webhook.use("*", authMiddleware(config.gitlabWebhookSecret, logger));

  webhook.post("/", async (c) => {
    const requestId = c.var.requestId;
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

    const deliveryKey = getDeliveryKey(idempotencyKey, requestId);
    if (deliveryStore.has(deliveryKey)) {
      requestLogger.info({ deliveryKey }, "Duplicate webhook delivery ignored");
      return jsonResponse(requestId, 202, { status: "duplicate" });
    }
    deliveryStore.add(deliveryKey);

    const routeResult = routeEvent(parseResult.value, requestLogger);
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

    const jobIdValue = routeResult.value;
    return Response.json(
      { status: "accepted", jobId: jobIdValue, requestId },
      { status: 202, headers: { "x-request-id": requestId } },
    );
  });

  app.route("/webhook", webhook);

  return app;
}
