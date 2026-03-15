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

const LEADING_MENTIONS_REGEX = /^(?:\s*@[\w.-]+\s*)+/;
const AGENT_DIRECTIVE_REGEX = /\buse\s+(claude|codex|gemini)\b/i;

function stripRoutingSyntax(note: string): string {
  return note
    .replace(LEADING_MENTIONS_REGEX, "")
    .replace(AGENT_DIRECTIVE_REGEX, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseAgentDirective(
  note: string,
  defaultAgent: AgentKind,
): { agent: AgentKind; prompt: string } {
  const directiveMatch = note.match(AGENT_DIRECTIVE_REGEX);
  if (directiveMatch !== null) {
    const matchedAgent = directiveMatch[1]?.toLowerCase();

    for (const [keyword, agent] of AGENT_KEYWORDS) {
      if (matchedAgent === keyword) {
        const strippedPrompt = stripRoutingSyntax(note);
        return {
          agent,
          prompt: strippedPrompt.length > 0 ? strippedPrompt : note.trim(),
        };
      }
    }
  }

  const strippedPrompt = stripRoutingSyntax(note);
  return {
    agent: defaultAgent,
    prompt: strippedPrompt.length > 0 ? strippedPrompt : note.trim(),
  };
}
