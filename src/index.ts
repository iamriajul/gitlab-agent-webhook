import { loadConfig } from "./config/config.ts";
import { createLogger } from "./config/logger.ts";
import { createApp } from "./server/routes.ts";

const configResult = loadConfig();
if (configResult.isErr()) {
  // biome-ignore lint/suspicious/noConsole: logger unavailable before config loads
  console.error(`Fatal: ${configResult.error.message}`);
  process.exit(1);
}

const config = configResult.value;
const logger = createLogger(config.logLevel);
const app = createApp(config, logger);

logger.info({ port: config.port }, "Starting glab-review-webhook server");

export default {
  port: config.port,
  fetch: app.fetch,
};
