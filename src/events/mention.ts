import { MENTION_REGEX } from "../config/constants.ts";
import type { AgentKind } from "../types/events.ts";

export function extractMentions(note: string): readonly string[] {
  return [...note.matchAll(MENTION_REGEX)].flatMap((match) => {
    const username = match[1];
    return username === undefined ? [] : [username];
  });
}

export function isBotMentioned(note: string, botUsername: string): boolean {
  return extractMentions(note).includes(botUsername);
}

const AGENT_KEYWORDS: ReadonlyMap<string, AgentKind> = new Map([
  ["claude", "claude"],
  ["codex", "codex"],
  ["gemini", "gemini"],
]);

const LEADING_MENTIONS_REGEX = /^(?:[ \t]*@[\w.-]+[ \t]*)+/;
const LEADING_AGENT_SELECTOR_REGEX = /^[ \t]*(claude|codex|gemini)\b[ \t]*/i;

function normalizePrompt(note: string): string {
  return note.replace(/^\r?\n/, "").replace(/[ \t\r\n]+$/, "");
}

export function parseAgentDirective(
  note: string,
  defaultAgent: AgentKind,
): { agent: AgentKind; prompt: string } {
  const withoutMentions = note.replace(LEADING_MENTIONS_REGEX, "");
  const selectorMatch = withoutMentions.match(LEADING_AGENT_SELECTOR_REGEX);
  if (selectorMatch !== null) {
    const matchedAgent = selectorMatch[1]?.toLowerCase();

    for (const [keyword, agent] of AGENT_KEYWORDS) {
      if (matchedAgent === keyword) {
        const strippedPrompt = normalizePrompt(
          withoutMentions.replace(LEADING_AGENT_SELECTOR_REGEX, ""),
        );
        return {
          agent,
          prompt: strippedPrompt.length > 0 ? strippedPrompt : note.trim(),
        };
      }
    }
  }

  const strippedPrompt = normalizePrompt(withoutMentions);
  return {
    agent: defaultAgent,
    prompt: strippedPrompt.length > 0 ? strippedPrompt : note.trim(),
  };
}
