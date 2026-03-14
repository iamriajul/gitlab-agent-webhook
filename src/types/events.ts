import type { MergeRequestPayload, NoteOnIssuePayload, NoteOnMRPayload } from "../events/parser.ts";

export type WebhookEvent =
  | { readonly kind: "note_on_issue"; readonly payload: NoteOnIssuePayload }
  | { readonly kind: "note_on_mr"; readonly payload: NoteOnMRPayload }
  | { readonly kind: "mr_opened"; readonly payload: MergeRequestPayload }
  | { readonly kind: "mr_updated"; readonly payload: MergeRequestPayload }
  | { readonly kind: "ignored"; readonly reason: string };

export type AgentKind = "claude" | "codex" | "gemini";

export type EmojiName =
  | "eyes"
  | "thumbsup"
  | "thumbsdown"
  | "white_check_mark"
  | "warning"
  | "hourglass"
  | "rocket";
