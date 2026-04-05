import { afterEach, describe, expect, it } from "bun:test";
import { loadConfig } from "../../src/config/config.ts";

const REQUIRED_ENV_KEYS = [
  "GITLAB_WEBHOOK_SECRET",
  "BOT_USERNAME",
  "GITLAB_TOKEN",
  "GITLAB_HOST",
  "DEFAULT_AGENT",
  "PORT",
  "DATABASE_PATH",
  "LOG_LEVEL",
  "WORKER_CONCURRENCY",
  "AGENT_TIMEOUT_MS",
  "CLAUDE_PATH",
  "CODEX_PATH",
  "GEMINI_PATH",
] as const;

const originalEnv = new Map<string, string | undefined>(
  REQUIRED_ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of REQUIRED_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
});

describe("loadConfig", () => {
  it("uses the gitlab-agent-webhook database path by default", () => {
    process.env["GITLAB_WEBHOOK_SECRET"] = "secret";
    process.env["BOT_USERNAME"] = "agent";
    process.env["GITLAB_TOKEN"] = "token";
    process.env["GITLAB_HOST"] = "https://gitlab.example.com";
    delete process.env["DATABASE_PATH"];

    const result = loadConfig();

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.databasePath).toBe("./data/gitlab-agent-webhook.db");
  });
});
