import { z } from "zod/v4";
import type { AppError } from "../types/errors.ts";
import { configError } from "../types/errors.ts";
import type { Result } from "../types/result.ts";
import { err, ok } from "../types/result.ts";

const ConfigSchema = z.object({
  gitlabWebhookSecret: z.string().min(1),
  botUsername: z.string().min(1),
  gitlabToken: z.string().min(1),
  gitlabHost: z.string().url().default("https://gitlab.com"),
  defaultAgent: z.enum(["claude", "codex", "gemini"]).default("claude"),
  port: z.coerce.number().int().positive().default(3000),
  databasePath: z.string().default("./data/glab-review.db"),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  claudeConcurrency: z.coerce.number().int().nonnegative().default(2),
  codexConcurrency: z.coerce.number().int().nonnegative().default(1),
  geminiConcurrency: z.coerce.number().int().nonnegative().default(1),
  agentTimeoutMs: z.coerce.number().int().positive().default(600_000),
  claudePath: z.string().default("claude"),
  codexPath: z.string().default("codex"),
  geminiPath: z.string().default("gemini"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Result<Config, AppError> {
  const raw = {
    gitlabWebhookSecret: process.env["GITLAB_WEBHOOK_SECRET"],
    botUsername: process.env["BOT_USERNAME"],
    gitlabToken: process.env["GITLAB_TOKEN"],
    gitlabHost: process.env["GITLAB_HOST"],
    defaultAgent: process.env["DEFAULT_AGENT"],
    port: process.env["PORT"],
    databasePath: process.env["DATABASE_PATH"],
    logLevel: process.env["LOG_LEVEL"],
    claudeConcurrency: process.env["CLAUDE_CONCURRENCY"],
    codexConcurrency: process.env["CODEX_CONCURRENCY"],
    geminiConcurrency: process.env["GEMINI_CONCURRENCY"],
    agentTimeoutMs: process.env["AGENT_TIMEOUT_MS"],
    claudePath: process.env["CLAUDE_PATH"],
    codexPath: process.env["CODEX_PATH"],
    geminiPath: process.env["GEMINI_PATH"],
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return err(configError(`Invalid configuration: ${issues}`));
  }

  return ok(result.data);
}
