import pino from "pino";

export function createLogger(level: string): pino.Logger {
  return pino({
    level,
    ...(process.env["NODE_ENV"] !== "production"
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {}),
  });
}

export type Logger = pino.Logger;
