import type { AgentAdapter, AgentCommand, AgentConfig } from "./types.ts";

function claudePath(config: AgentConfig): string {
  return config.env["CLAUDE_PATH"] ?? process.env["CLAUDE_PATH"] ?? "claude";
}

export function buildClaudeCommand(config: AgentConfig): AgentCommand {
  const baseArgs = [
    "-p",
    "--dangerously-skip-permissions",
    "--verbose",
    "--output-format",
    "stream-json",
  ];
  const resumeSessionId = config.sessionId?.trim();

  const systemArgs = ["--append-system-prompt", config.systemPrompt];

  if (resumeSessionId !== undefined && resumeSessionId.length > 0) {
    return {
      command: claudePath(config),
      args: [...baseArgs, ...systemArgs, "--resume", resumeSessionId, "--", config.prompt],
      env: {},
    };
  }

  return {
    command: claudePath(config),
    args: [...baseArgs, ...systemArgs, "--", config.prompt],
    env: {},
  };
}

export function parseClaudeSessionId(output: string): string | null {
  const typedSessionMatch =
    /"type"\s*:\s*"session"[\s\S]*?"id"\s*:\s*"([^"]+)"/.exec(output) ??
    /"session[_-]?id"\s*:\s*"([^"]+)"/.exec(output);

  return typedSessionMatch?.[1] ?? null;
}

export const claudeAdapter: AgentAdapter = {
  buildCommand: buildClaudeCommand,
  parseSessionId: parseClaudeSessionId,
};
