import type { Logger } from "../config/logger.ts";
import type { JobPayload } from "../jobs/types.ts";
import type { AppError } from "../types/errors.ts";
import type { AgentKind, WebhookEvent } from "../types/events.ts";
import type { Result } from "../types/result.ts";
import { ok } from "../types/result.ts";
import { isBotMentioned, parseAgentDirective } from "./mention.ts";

export interface RoutingConfig {
  readonly botUsername: string;
  readonly defaultAgent: AgentKind;
}

export type RoutingDecision =
  | {
      readonly kind: "enqueue";
      readonly payload: JobPayload;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: "ignore";
      readonly reason: string;
    };

function createMrReviewDecision(
  event: Extract<WebhookEvent, { readonly kind: "mr_opened" | "mr_updated" }>,
): RoutingDecision {
  const project = event.payload.project.path_with_namespace;
  const mrIid = event.payload.object_attributes.iid;
  const commitSha = event.payload.object_attributes.last_commit.id;

  return {
    kind: "enqueue",
    idempotencyKey: `mr:${project}:${mrIid}:commit:${commitSha}`,
    payload: {
      kind: "review_mr",
      project,
      mrIid,
    },
  };
}

export function routeEvent(
  event: WebhookEvent,
  config: RoutingConfig,
  logger: Logger,
): Result<RoutingDecision, AppError> {
  switch (event.kind) {
    case "note_on_issue": {
      if (!isBotMentioned(event.payload.object_attributes.note, config.botUsername)) {
        return ok({ kind: "ignore", reason: "Bot was not mentioned in issue note" });
      }

      const directive = parseAgentDirective(
        event.payload.object_attributes.note,
        config.defaultAgent,
      );
      logger.info(
        {
          project: event.payload.project.path_with_namespace,
          issueIid: event.payload.issue.iid,
          agentType: directive.agent,
        },
        "Routing issue note to mention job",
      );
      return ok({
        kind: "enqueue",
        idempotencyKey: `note:${event.payload.object_attributes.id}`,
        payload: {
          kind: "handle_mention",
          project: event.payload.project.path_with_namespace,
          noteId: event.payload.object_attributes.id,
          issueIid: event.payload.issue.iid,
          prompt: directive.prompt,
          agentType: directive.agent,
        },
      });
    }
    case "note_on_mr": {
      if (!isBotMentioned(event.payload.object_attributes.note, config.botUsername)) {
        return ok({ kind: "ignore", reason: "Bot was not mentioned in MR note" });
      }

      const directive = parseAgentDirective(
        event.payload.object_attributes.note,
        config.defaultAgent,
      );
      logger.info(
        {
          project: event.payload.project.path_with_namespace,
          mrIid: event.payload.merge_request.iid,
          agentType: directive.agent,
        },
        "Routing MR note to mention job",
      );
      return ok({
        kind: "enqueue",
        idempotencyKey: `mr-note:${event.payload.object_attributes.id}`,
        payload: {
          kind: "handle_mr_mention",
          project: event.payload.project.path_with_namespace,
          noteId: event.payload.object_attributes.id,
          mrIid: event.payload.merge_request.iid,
          prompt: directive.prompt,
          agentType: directive.agent,
        },
      });
    }
    case "mr_opened": {
      logger.info(
        {
          project: event.payload.project.path_with_namespace,
          mrIid: event.payload.object_attributes.iid,
        },
        "Routing opened MR to review job",
      );
      return ok(createMrReviewDecision(event));
    }
    case "mr_updated": {
      logger.info(
        {
          project: event.payload.project.path_with_namespace,
          mrIid: event.payload.object_attributes.iid,
        },
        "Routing updated MR to review job",
      );
      return ok(createMrReviewDecision(event));
    }
    case "ignored": {
      logger.debug({ reason: event.reason }, "Event ignored");
      return ok({ kind: "ignore", reason: event.reason });
    }
  }
}
