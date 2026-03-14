import type { AgentKind } from "../types/events.ts";

export type SessionContext =
  | { readonly kind: "issue"; readonly project: string; readonly issueIid: number }
  | { readonly kind: "mr"; readonly project: string; readonly mrIid: number }
  | { readonly kind: "mr_review"; readonly project: string; readonly mrIid: number };

export interface AgentSession {
  readonly id: string;
  readonly agentType: AgentKind;
  readonly agentSessionId: string;
  readonly context: SessionContext;
  readonly status: "active" | "completed" | "failed";
  readonly createdAt: Date;
  readonly lastActivityAt: Date;
}

// TODO: Implement session manager with SQLite persistence
