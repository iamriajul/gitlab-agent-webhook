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

export type ReactionTarget =
  | {
      readonly kind: "issue_note";
      readonly project: string;
      readonly issueIid: number;
      readonly noteId: number;
    }
  | {
      readonly kind: "mr_note";
      readonly project: string;
      readonly mrIid: number;
      readonly noteId: number;
    };

export type RoutingDecision =
  | {
      readonly kind: "enqueue";
      readonly payload: JobPayload;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: "ignore";
      readonly reason: string;
    }
  | {
      readonly kind: "cleanup";
      readonly project: string;
      readonly target: "issue" | "mr";
      readonly iid: number;
    }
  | {
      readonly kind: "blocked";
      readonly target: ReactionTarget;
      readonly reason: string;
    };

function isUserInList(users: readonly { readonly username: string }[], username: string): boolean {
  return users.some((u) => u.username === username);
}

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
      sourceBranch: event.payload.object_attributes.source_branch,
    },
  };
}

function routeIssueNote(
  event: Extract<WebhookEvent, { readonly kind: "note_on_issue" }>,
  config: RoutingConfig,
  logger: Logger,
): RoutingDecision {
  if (!isBotMentioned(event.payload.object_attributes.note, config.botUsername)) {
    return { kind: "ignore", reason: "Bot was not mentioned in issue note" };
  }

  if (event.payload.issue.state === "closed") {
    return {
      kind: "blocked",
      target: {
        kind: "issue_note",
        project: event.payload.project.path_with_namespace,
        issueIid: event.payload.issue.iid,
        noteId: event.payload.object_attributes.id,
      },
      reason: "Issue is closed",
    };
  }

  const directive = parseAgentDirective(event.payload.object_attributes.note, config.defaultAgent);
  logger.info(
    {
      project: event.payload.project.path_with_namespace,
      issueIid: event.payload.issue.iid,
      agentType: directive.agent,
    },
    "Routing issue note to mention job",
  );
  return {
    kind: "enqueue",
    idempotencyKey: `note:${event.payload.object_attributes.id}`,
    payload: {
      kind: "handle_mention",
      project: event.payload.project.path_with_namespace,
      noteId: event.payload.object_attributes.id,
      issueIid: event.payload.issue.iid,
      prompt: directive.prompt,
      agentType: directive.agent,
      model: directive.model,
      effort: directive.effort,
      defaultBranch: event.payload.project.default_branch,
    },
  };
}

function routeMrNote(
  event: Extract<WebhookEvent, { readonly kind: "note_on_mr" }>,
  config: RoutingConfig,
  logger: Logger,
): RoutingDecision {
  if (!isBotMentioned(event.payload.object_attributes.note, config.botUsername)) {
    return { kind: "ignore", reason: "Bot was not mentioned in MR note" };
  }

  const mrState = event.payload.merge_request.state;
  if (mrState === "closed" || mrState === "merged" || mrState === "locked") {
    return {
      kind: "blocked",
      target: {
        kind: "mr_note",
        project: event.payload.project.path_with_namespace,
        mrIid: event.payload.merge_request.iid,
        noteId: event.payload.object_attributes.id,
      },
      reason: `MR is ${mrState}`,
    };
  }

  const directive = parseAgentDirective(event.payload.object_attributes.note, config.defaultAgent);
  logger.info(
    {
      project: event.payload.project.path_with_namespace,
      mrIid: event.payload.merge_request.iid,
      agentType: directive.agent,
    },
    "Routing MR note to mention job",
  );
  return {
    kind: "enqueue",
    idempotencyKey: `mr-note:${event.payload.object_attributes.id}`,
    payload: {
      kind: "handle_mr_mention",
      project: event.payload.project.path_with_namespace,
      noteId: event.payload.object_attributes.id,
      mrIid: event.payload.merge_request.iid,
      prompt: directive.prompt,
      agentType: directive.agent,
      model: directive.model,
      effort: directive.effort,
      sourceBranch: event.payload.merge_request.source_branch,
    },
  };
}

function routeMrUpdated(
  event: Extract<WebhookEvent, { readonly kind: "mr_updated" }>,
  config: RoutingConfig,
  logger: Logger,
): RoutingDecision {
  if (
    isUserInList(event.payload.reviewers, config.botUsername) ||
    isUserInList(event.payload.assignees, config.botUsername)
  ) {
    logger.info(
      {
        project: event.payload.project.path_with_namespace,
        mrIid: event.payload.object_attributes.iid,
      },
      "Routing MR assigned/reviewer to review job",
    );
    const project = event.payload.project.path_with_namespace;
    const mrIid = event.payload.object_attributes.iid;
    return {
      kind: "enqueue",
      idempotencyKey: `mr-assign:${project}:${mrIid}`,
      payload: {
        kind: "review_mr",
        project,
        mrIid,
        sourceBranch: event.payload.object_attributes.source_branch,
      },
    };
  }

  logger.info(
    {
      project: event.payload.project.path_with_namespace,
      mrIid: event.payload.object_attributes.iid,
    },
    "Routing updated MR to review job",
  );
  return createMrReviewDecision(event);
}

export function routeEvent(
  event: WebhookEvent,
  config: RoutingConfig,
  logger: Logger,
): Result<RoutingDecision, AppError> {
  switch (event.kind) {
    case "note_on_issue":
      return ok(routeIssueNote(event, config, logger));
    case "note_on_mr":
      return ok(routeMrNote(event, config, logger));
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
    case "mr_updated":
      return ok(routeMrUpdated(event, config, logger));
    case "issue_closed": {
      logger.info(
        {
          project: event.payload.project.path_with_namespace,
          issueIid: event.payload.object_attributes.iid,
        },
        "Routing closed issue to cleanup",
      );
      return ok({
        kind: "cleanup",
        project: event.payload.project.path_with_namespace,
        target: "issue",
        iid: event.payload.object_attributes.iid,
      });
    }
    case "mr_closed": {
      logger.info(
        {
          project: event.payload.project.path_with_namespace,
          mrIid: event.payload.object_attributes.iid,
        },
        "Routing closed/merged MR to cleanup",
      );
      return ok({
        kind: "cleanup",
        project: event.payload.project.path_with_namespace,
        target: "mr",
        iid: event.payload.object_attributes.iid,
      });
    }
    case "issue_assigned": {
      if (!isUserInList(event.payload.assignees, config.botUsername)) {
        return ok({ kind: "ignore", reason: "Bot was not assigned to issue" });
      }

      logger.info(
        {
          project: event.payload.project.path_with_namespace,
          issueIid: event.payload.object_attributes.iid,
        },
        "Routing issue assignment to mention job",
      );
      return ok({
        kind: "enqueue",
        idempotencyKey: `issue-assign:${event.payload.project.path_with_namespace}:${event.payload.object_attributes.iid}`,
        payload: {
          kind: "handle_mention",
          project: event.payload.project.path_with_namespace,
          noteId: 0,
          issueIid: event.payload.object_attributes.iid,
          prompt: [
            "You have been assigned to this issue. Read the issue description and comments carefully.",
            "If the task is clear and straightforward, implement it and create an MR.",
            "If the task is complex or ambiguous, post a plan as a comment first, then implement.",
          ].join("\n"),
          agentType: config.defaultAgent,
          defaultBranch: event.payload.project.default_branch,
        },
      });
    }
    case "mr_review_requested": {
      if (
        !isUserInList(event.payload.reviewers, config.botUsername) &&
        !isUserInList(event.payload.assignees, config.botUsername)
      ) {
        return ok({ kind: "ignore", reason: "Bot was not added as reviewer or assignee" });
      }

      logger.info(
        {
          project: event.payload.project.path_with_namespace,
          mrIid: event.payload.object_attributes.iid,
        },
        "Routing MR review request to review job",
      );
      const project = event.payload.project.path_with_namespace;
      const mrIid = event.payload.object_attributes.iid;
      return ok({
        kind: "enqueue",
        idempotencyKey: `mr-review:${project}:${mrIid}`,
        payload: {
          kind: "review_mr",
          project,
          mrIid,
          sourceBranch: event.payload.object_attributes.source_branch,
        },
      });
    }
    case "ignored": {
      logger.debug({ reason: event.reason }, "Event ignored");
      return ok({ kind: "ignore", reason: event.reason });
    }
  }
}
