import { MENTION_REGEX } from "../config/constants.ts";
import type { AgentKind } from "../types/events.ts";

export function extractMentions(note: string): readonly string[] {
  return [...note.matchAll(MENTION_REGEX)].map((m) => m[1] as string);
}

export function isBotMentioned(note: string, botUsername: string): boolean {
  return extractMentions(note).includes(botUsername);
}

const AGENT_KEYWORDS: ReadonlyMap<string, AgentKind> = new Map([
  ["claude", "claude"],
  ["codex", "codex"],
  ["gemini", "gemini"],
]);

export function parseAgentDirective(
  note: string,
  defaultAgent: AgentKind,
): { agent: AgentKind; prompt: string } {
  const lowerNote = note.toLowerCase();

  for (const [keyword, agent] of AGENT_KEYWORDS) {
    if (lowerNote.includes(`use ${keyword}`)) {
      return { agent, prompt: note };
    }
  }

  return { agent: defaultAgent, prompt: note };
}
