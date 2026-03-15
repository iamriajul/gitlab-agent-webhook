import { describe, expect, it } from "bun:test";
import { extractMentions, isBotMentioned, parseAgentDirective } from "../../src/events/mention.ts";

describe("extractMentions", () => {
  it("extracts single mention", () => {
    expect(extractMentions("Hello @bot")).toEqual(["bot"]);
  });

  it("extracts multiple mentions", () => {
    expect(extractMentions("@alice and @bob please review")).toEqual(["alice", "bob"]);
  });

  it("returns empty array for no mentions", () => {
    expect(extractMentions("No mentions here")).toEqual([]);
  });

  it("handles usernames with dots and hyphens", () => {
    expect(extractMentions("@john.doe @jane-smith")).toEqual(["john.doe", "jane-smith"]);
  });
});

describe("isBotMentioned", () => {
  it("returns true when bot is mentioned", () => {
    expect(isBotMentioned("@review-bot fix this", "review-bot")).toBe(true);
  });

  it("returns false when bot is not mentioned", () => {
    expect(isBotMentioned("@alice please help", "review-bot")).toBe(false);
  });
});

describe("parseAgentDirective", () => {
  it("returns default agent when no directive", () => {
    const result = parseAgentDirective("@bot fix the login bug", "claude");
    expect(result.agent).toBe("claude");
    expect(result.prompt).toBe("fix the login bug");
  });

  it("parses 'use codex' directive", () => {
    const result = parseAgentDirective("@bot use codex to fix this", "claude");
    expect(result.agent).toBe("codex");
    expect(result.prompt).toBe("to fix this");
  });

  it("parses 'use gemini' directive", () => {
    const result = parseAgentDirective("@bot use gemini for review", "claude");
    expect(result.agent).toBe("gemini");
    expect(result.prompt).toBe("for review");
  });

  it("is case-insensitive", () => {
    const result = parseAgentDirective("@bot Use Codex to fix this", "claude");
    expect(result.agent).toBe("codex");
    expect(result.prompt).toBe("to fix this");
  });

  it("strips multiple mentions from the routed prompt", () => {
    const result = parseAgentDirective("@alice @bot please investigate this", "claude");
    expect(result.agent).toBe("claude");
    expect(result.prompt).toBe("please investigate this");
  });

  it("keeps the original note when stripping would empty the prompt", () => {
    const result = parseAgentDirective("@bot use codex", "claude");
    expect(result.agent).toBe("codex");
    expect(result.prompt).toBe("@bot use codex");
  });

  it("preserves multiline formatting while stripping routing syntax", () => {
    const note = "@bot use codex\n- investigate\n  - keep indentation\n\n```ts\nconst x = 1;\n```";
    const result = parseAgentDirective(note, "claude");

    expect(result.agent).toBe("codex");
    expect(result.prompt).toBe("- investigate\n  - keep indentation\n\n```ts\nconst x = 1;\n```");
  });
});
