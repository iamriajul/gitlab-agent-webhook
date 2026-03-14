import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { WEBHOOK_HEADER_TOKEN, WEBHOOK_HEADER_UUID } from "../config/constants.ts";
import type { Logger } from "../config/logger.ts";

export function authMiddleware(secret: string, logger: Logger) {
  return async (c: Context, next: Next): Promise<Response | undefined> => {
    const token = c.req.header(WEBHOOK_HEADER_TOKEN) ?? "";
    const encoder = new TextEncoder();
    const a = encoder.encode(token);
    const b = encoder.encode(secret);

    if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) {
      logger.warn("Webhook authentication failed: invalid token");
      return c.json({ error: "Unauthorized" }, 401);
    }

    await next();
    return;
  };
}

export function requestIdMiddleware(logger: Logger) {
  return async (c: Context, next: Next) => {
    const webhookUuid = c.req.header(WEBHOOK_HEADER_UUID) ?? "unknown";
    c.set("requestId", webhookUuid);
    logger.info(
      { requestId: webhookUuid, method: c.req.method, path: c.req.path },
      "Request received",
    );
    await next();
  };
}
