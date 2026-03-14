import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { WEBHOOK_HEADER_TOKEN, WEBHOOK_HEADER_UUID } from "../config/constants.ts";
import type { Logger } from "../config/logger.ts";

const REQUEST_ID_HEADER = "x-request-id";

declare module "hono" {
  interface ContextVariableMap {
    readonly requestId: string;
    readonly logger: Logger;
  }
}

export function authMiddleware(secret: string, logger: Logger) {
  return async (c: Context, next: Next): Promise<Response | undefined> => {
    const token = c.req.header(WEBHOOK_HEADER_TOKEN) ?? "";
    const encoder = new TextEncoder();
    const a = encoder.encode(token);
    const b = encoder.encode(secret);
    const requestId = c.var.requestId;

    if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) {
      const requestLogger = c.var.logger ?? logger;
      requestLogger.warn("Webhook authentication failed: invalid token");
      return c.json(
        {
          status: "error",
          error: { code: "unauthorized", message: "Unauthorized" },
          requestId,
        },
        401,
      );
    }

    await next();
    return;
  };
}

export function requestIdMiddleware(logger: Logger) {
  return async (c: Context, next: Next): Promise<void> => {
    const requestId =
      c.req.header(REQUEST_ID_HEADER) ?? c.req.header(WEBHOOK_HEADER_UUID) ?? randomUUID();
    const requestLogger = logger.child({ requestId });
    c.set("requestId", requestId);
    c.set("logger", requestLogger);
    c.header(REQUEST_ID_HEADER, requestId);

    requestLogger.info({ method: c.req.method, path: c.req.path }, "Request received");
    await next();

    requestLogger.info({ statusCode: c.res.status }, "Request completed");
  };
}
