import type { AgentKind } from "../types/events.ts";

export type JobStatus = "pending" | "processing" | "completed" | "failed";

export type JobPayload =
  | {
      readonly kind: "review_mr";
      readonly project: string;
      readonly mrIid: number;
    }
  | {
      readonly kind: "handle_mention";
      readonly project: string;
      readonly noteId: number;
      readonly issueIid: number;
      readonly prompt: string;
      readonly agentType: AgentKind;
    }
  | {
      readonly kind: "handle_mr_mention";
      readonly project: string;
      readonly noteId: number;
      readonly mrIid: number;
      readonly prompt: string;
      readonly agentType: AgentKind;
    };

export interface Job {
  readonly id: string;
  readonly payload: JobPayload;
  readonly status: JobStatus;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly error: string | null;
  readonly idempotencyKey: string;
  readonly retryCount: number;
}
