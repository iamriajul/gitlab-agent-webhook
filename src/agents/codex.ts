import type { AgentAdapter, AgentCommand, AgentConfig } from "./types.ts";

function codexPath(config: AgentConfig): string {
  return config.env["CODEX_PATH"] ?? process.env["CODEX_PATH"] ?? "codex";
}

export function buildCodexCommand(config: AgentConfig): AgentCommand {
  const modelArgs: readonly string[] =
    config.agent.model !== undefined ? ["--model", config.agent.model] : [];
  const resumeSessionId = config.sessionId?.trim();

  if (resumeSessionId !== undefined && resumeSessionId.length > 0) {
    return {
      command: codexPath(config),
      args: [
        "exec",
        "resume",
        resumeSessionId,
        "--dangerously-bypass-approvals-and-sandbox",
        "--json",
        ...modelArgs,
        "--",
        config.prompt,
      ],
      env: {},
    };
  }

  return {
    command: codexPath(config),
    args: [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
      ...modelArgs,
      "--config",
      `developer_instructions=${config.systemPrompt}`,
      "--",
      config.prompt,
    ],
    env: {},
  };
}

export function parseCodexSessionId(output: string): string | null {
  const sessionMatch =
    /"thread[_-]?id"\s*:\s*"([^"]+)"/.exec(output) ??
    /"session[_-]?id"\s*:\s*"([^"]+)"/.exec(output) ??
    /"conversation[_-]?id"\s*:\s*"([^"]+)"/.exec(output);

  return sessionMatch?.[1] ?? null;
}

export const codexAdapter: AgentAdapter = {
  buildCommand: buildCodexCommand,
  parseSessionId: parseCodexSessionId,
};
