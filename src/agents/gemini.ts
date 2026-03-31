import type { AgentAdapter, AgentCommand, AgentConfig } from "./types.ts";

function geminiPath(config: AgentConfig): string {
  return config.env["GEMINI_PATH"] ?? process.env["GEMINI_PATH"] ?? "gemini";
}

export function buildGeminiCommand(config: AgentConfig): AgentCommand {
  const systemPromptSelector = config.env["GEMINI_SYSTEM_MD"] ?? process.env["GEMINI_SYSTEM_MD"];
  const modelArgs: readonly string[] =
    config.agent.model !== undefined ? ["--model", config.agent.model] : [];
  const mergedPrompt = `${config.systemPrompt}\n\n${config.prompt}`;
  const env = systemPromptSelector === undefined ? {} : { GEMINI_SYSTEM_MD: systemPromptSelector };

  return {
    command: geminiPath(config),
    args: ["-p", mergedPrompt, "--yolo", "--output-format", "json", ...modelArgs],
    env,
  };
}

export function parseGeminiSessionId(_output: string): string | null {
  return null;
}

export const geminiAdapter: AgentAdapter = {
  buildCommand: buildGeminiCommand,
  parseSessionId: parseGeminiSessionId,
};
