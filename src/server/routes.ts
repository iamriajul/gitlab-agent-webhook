import { Hono } from "hono";
import type { Config } from "../config/config.ts";
import { WEBHOOK_HEADER_EVENT, WEBHOOK_HEADER_IDEMPOTENCY } from "../config/constants.ts";
import type { Logger } from "../config/logger.ts";
import { parseWebhookPayload } from "../events/parser.ts";
import { routeEvent } from "../events/router.ts";
import { authMiddleware, requestIdMiddleware } from "./middleware.ts";

export function createApp(config: Config, logger: Logger): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  const webhook = new Hono();
  webhook.use("*", requestIdMiddleware(logger));
  webhook.use("*", authMiddleware(config.gitlabWebhookSecret, logger));

  webhook.post("/", async (c) => {
    const eventType = c.req.header(WEBHOOK_HEADER_EVENT) ?? "";
    const idempotencyKey = c.req.header(WEBHOOK_HEADER_IDEMPOTENCY) ?? "";
    const body: unknown = await c.req.json();

    logger.info({ eventType, idempotencyKey }, "Processing webhook");

    const parseResult = parseWebhookPayload(eventType, body);
    if (parseResult.isErr()) {
      logger.error({ error: parseResult.error }, "Failed to parse webhook payload");
      return c.json({ error: parseResult.error.message }, 400);
    }

    const routeResult = routeEvent(parseResult.value, logger);
    if (routeResult.isErr()) {
      logger.error({ error: routeResult.error }, "Failed to route event");
      return c.json({ error: routeResult.error.message }, 500);
    }

    const jobIdValue = routeResult.value;
    return c.json({ status: "accepted", jobId: jobIdValue }, 200);
  });

  app.route("/webhook", webhook);

  return app;
}
