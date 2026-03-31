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
const LEADING_AGENT_SELECTOR_REGEX = /^[ \t]*(claude|codex|gemini)(:\S+?)?(?=\s|$)[ \t]*/i;

function normalizePrompt(note: string): string {
  return note.replace(/^\r?\n/, "").replace(/[ \t\r\n]+$/, "");
}

export interface AgentDirective {
  readonly agent: AgentKind;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly prompt: string;
}

function parseSuffix(suffix: string): {
  readonly model: string | undefined;
  readonly effort: string | undefined;
} {
  const parts = suffix.split(":");
  const model = parts[0] !== undefined && parts[0].length > 0 ? parts[0] : undefined;
  const effort = parts[1] !== undefined && parts[1].length > 0 ? parts[1] : undefined;
  return { model, effort };
}

function matchAgentKeyword(selectorMatch: RegExpMatchArray): {
  readonly agent: AgentKind;
  readonly model: string | undefined;
  readonly effort: string | undefined;
} | null {
  const matchedAgent = selectorMatch[1]?.toLowerCase();
  for (const [keyword, agent] of AGENT_KEYWORDS) {
    if (matchedAgent === keyword) {
      const rawSuffix = selectorMatch[2];
      const { model, effort } =
        rawSuffix !== undefined && rawSuffix.length > 1
          ? parseSuffix(rawSuffix.slice(1))
          : { model: undefined, effort: undefined };
      return { agent, model, effort };
    }
  }
  return null;
}

export function parseAgentDirective(note: string, defaultAgent: AgentKind): AgentDirective {
  const withoutMentions = note.replace(LEADING_MENTIONS_REGEX, "");
  const selectorMatch = withoutMentions.match(LEADING_AGENT_SELECTOR_REGEX);
  if (selectorMatch !== null) {
    const matched = matchAgentKeyword(selectorMatch);
    if (matched !== null) {
      const strippedPrompt = normalizePrompt(
        withoutMentions.replace(LEADING_AGENT_SELECTOR_REGEX, ""),
      );
      return {
        agent: matched.agent,
        model: matched.model,
        effort: matched.effort,
        prompt: strippedPrompt.length > 0 ? strippedPrompt : note.trim(),
      };
    }
  }

  const strippedPrompt = normalizePrompt(withoutMentions);
  return {
    agent: defaultAgent,
    prompt: strippedPrompt.length > 0 ? strippedPrompt : note.trim(),
  };
}
