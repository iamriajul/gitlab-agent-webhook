import { describe, expect, it } from "bun:test";
import { buildClaudeCommand, parseClaudeSessionId } from "../../src/agents/claude.ts";
import { buildCodexCommand, parseCodexSessionId } from "../../src/agents/codex.ts";
import { buildGeminiCommand, parseGeminiSessionId } from "../../src/agents/gemini.ts";
import type { AgentConfig } from "../../src/agents/types.ts";

function createConfig(overrides: Partial<AgentConfig> & Pick<AgentConfig, "agent">): AgentConfig {
  return {
    agent: overrides.agent,
    workDir: overrides.workDir ?? "/tmp/project",
    prompt: overrides.prompt ?? "Review the merge request",
    sessionId: overrides.sessionId,
    systemPrompt: overrides.systemPrompt ?? "System instructions",
    env: overrides.env ?? {},
    timeoutMs: overrides.timeoutMs ?? 30_000,
  };
}

describe("agent adapters", () => {
  it("builds a fresh Claude command with system prompt", () => {
    const command = buildClaudeCommand(
      createConfig({
        agent: { kind: "claude" },
        env: { CLAUDE_PATH: "/opt/bin/claude" },
      }),
    );

    expect(command.command).toBe("/opt/bin/claude");
    expect(command.args).toEqual([
      "-p",
      "--dangerously-skip-permissions",
      "--verbose",
      "--output-format",
      "stream-json",
      "--append-system-prompt",
      "System instructions",
      "--",
      "Review the merge request",
    ]);
  });

  it("builds a resumed Claude command without repeating the system prompt", () => {
    const command = buildClaudeCommand(
      createConfig({
        agent: { kind: "claude" },
        sessionId: "claude-session-1",
        env: { CLAUDE_PATH: "/opt/bin/claude" },
      }),
    );

    expect(command.command).toBe("/opt/bin/claude");
    expect(command.args).toEqual([
      "-p",
      "--dangerously-skip-permissions",
      "--verbose",
      "--output-format",
      "stream-json",
      "--resume",
      "claude-session-1",
      "--",
      "Review the merge request",
    ]);
  });

  it("delimits Claude prompts that start with dashes", () => {
    const command = buildClaudeCommand(
      createConfig({
        agent: { kind: "claude" },
        prompt: "--please-fix",
      }),
    );

    expect(command.args).toEqual([
      "-p",
      "--dangerously-skip-permissions",
      "--verbose",
      "--output-format",
      "stream-json",
      "--append-system-prompt",
      "System instructions",
      "--",
      "--please-fix",
    ]);
  });

  it("treats blank Claude session ids as a fresh run", () => {
    const emptyCommand = buildClaudeCommand(
      createConfig({
        agent: { kind: "claude" },
        sessionId: "",
      }),
    );
    const whitespaceCommand = buildClaudeCommand(
      createConfig({
        agent: { kind: "claude" },
        sessionId: "   ",
      }),
    );

    expect(emptyCommand.args).toContain("--append-system-prompt");
    expect(emptyCommand.args).not.toContain("--resume");
    expect(whitespaceCommand.args).toContain("--append-system-prompt");
    expect(whitespaceCommand.args).not.toContain("--resume");
  });

  it("extracts a Claude session id from stream-json output", () => {
    const output = '\n{"type":"message","content":"hi"}\n{"type":"session","id":"claude-123"}\n';

    expect(parseClaudeSessionId(output)).toBe("claude-123");
  });

  it("builds a fresh Codex command with developer instructions", () => {
    const command = buildCodexCommand(
      createConfig({
        agent: { kind: "codex" },
        env: { CODEX_PATH: "/opt/bin/codex" },
      }),
    );

    expect(command.command).toBe("/opt/bin/codex");
    expect(command.args).toEqual([
      "exec",
      "--full-auto",
      "--json",
      "--config",
      "developer_instructions=System instructions",
      "--",
      "Review the merge request",
    ]);
  });

  it("builds a resumed Codex command", () => {
    const command = buildCodexCommand(
      createConfig({
        agent: { kind: "codex" },
        sessionId: "codex-session-9",
        env: { CODEX_PATH: "/opt/bin/codex" },
      }),
    );

    expect(command.command).toBe("/opt/bin/codex");
    expect(command.args).toEqual([
      "exec",
      "resume",
      "codex-session-9",
      "--full-auto",
      "--json",
      "--",
      "Review the merge request",
    ]);
  });

  it("delimits Codex prompts that start with dashes", () => {
    const command = buildCodexCommand(
      createConfig({
        agent: { kind: "codex" },
        prompt: "--please-fix",
      }),
    );

    expect(command.args).toEqual([
      "exec",
      "--full-auto",
      "--json",
      "--config",
      "developer_instructions=System instructions",
      "--",
      "--please-fix",
    ]);
  });

  it("treats blank Codex session ids as a fresh run", () => {
    const emptyCommand = buildCodexCommand(
      createConfig({
        agent: { kind: "codex" },
        sessionId: "",
      }),
    );
    const whitespaceCommand = buildCodexCommand(
      createConfig({
        agent: { kind: "codex" },
        sessionId: "   ",
      }),
    );

    expect(emptyCommand.args).toContain("--config");
    expect(emptyCommand.args).not.toContain("resume");
    expect(whitespaceCommand.args).toContain("--config");
    expect(whitespaceCommand.args).not.toContain("resume");
  });

  it("extracts a Codex session id from json output", () => {
    const output = '{"type":"run.completed","session_id":"codex-456"}';

    expect(parseCodexSessionId(output)).toBe("codex-456");
  });

  it("extracts a Codex thread id from thread.started output", () => {
    const output = '{"type":"thread.started","thread_id":"thread-123"}';

    expect(parseCodexSessionId(output)).toBe("thread-123");
  });

  it("builds a Gemini command without forcing system-file mode by default", () => {
    const command = buildGeminiCommand(
      createConfig({
        agent: { kind: "gemini" },
        sessionId: "ignored-session",
        env: { GEMINI_PATH: "/opt/bin/gemini" },
      }),
    );

    expect(command.command).toBe("/opt/bin/gemini");
    expect(command.args).toEqual([
      "-p",
      "System instructions\n\nReview the merge request",
      "--yolo",
      "--output-format",
      "json",
    ]);
    expect(command.env).toEqual({});
  });

  it("uses configured GEMINI_SYSTEM_MD path when provided", () => {
    const command = buildGeminiCommand(
      createConfig({
        agent: { kind: "gemini" },
        env: {
          GEMINI_PATH: "/opt/bin/gemini",
          GEMINI_SYSTEM_MD: "/tmp/gemini-system.md",
        },
      }),
    );

    expect(command.args).toEqual([
      "-p",
      "System instructions\n\nReview the merge request",
      "--yolo",
      "--output-format",
      "json",
    ]);
    expect(command.env).toEqual({ GEMINI_SYSTEM_MD: "/tmp/gemini-system.md" });
  });

  it("never reports a resumable Gemini session id", () => {
    expect(parseGeminiSessionId('{"session_id":"gemini-ignored"}')).toBeNull();
  });
});
