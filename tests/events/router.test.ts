import { describe, expect, it } from "bun:test";
import pino from "pino";
import type {
  MergeRequestPayload,
  NoteOnIssuePayload,
  NoteOnMRPayload,
} from "../../src/events/parser.ts";
import { type RoutingConfig, routeEvent } from "../../src/events/router.ts";
import type { WebhookEvent } from "../../src/types/events.ts";

const logger = pino({ enabled: false });

const routingConfig: RoutingConfig = {
  botUsername: "agent",
  defaultAgent: "claude",
};

const baseProject = {
  id: 5,
  path_with_namespace: "team/project",
  web_url: "https://gitlab.example.com/team/project",
  default_branch: "main",
};

const baseUser = { id: 1, username: "dev", name: "Developer" };

function createIssueNoteEvent(note: string): WebhookEvent {
  const payload: NoteOnIssuePayload = {
    object_kind: "note",
    user: baseUser,
    project: baseProject,
    object_attributes: {
      id: 100,
      note,
      noteable_type: "Issue",
      noteable_id: 42,
      action: "create",
      url: "https://gitlab.example.com/team/project/issues/42#note_100",
      system: false,
    },
    issue: {
      id: 42,
      iid: 17,
      title: "Bug report",
      description: "It crashes",
      state: "opened",
    },
  };

  return { kind: "note_on_issue", payload };
}

function createMrNoteEvent(note: string): WebhookEvent {
  const payload: NoteOnMRPayload = {
    object_kind: "note",
    user: baseUser,
    project: baseProject,
    object_attributes: {
      id: 300,
      note,
      noteable_type: "MergeRequest",
      noteable_id: 55,
      action: "create",
      url: "https://gitlab.example.com/team/project/-/merge_requests/19#note_300",
      system: false,
    },
    merge_request: {
      id: 55,
      iid: 19,
      title: "Add validation",
      description: "This adds input validation",
      state: "opened",
      source_branch: "feat/validation",
      target_branch: "main",
    },
  };

  return { kind: "note_on_mr", payload };
}

function createMergeRequestEvent(kind: "mr_opened" | "mr_updated"): WebhookEvent {
  const payload: MergeRequestPayload = {
    object_kind: "merge_request",
    user: baseUser,
    project: baseProject,
    object_attributes: {
      id: 93,
      iid: 16,
      title: "Add validation",
      description: "This adds input validation",
      state: "opened",
      source_branch: "feat/validation",
      target_branch: "main",
      draft: false,
      action: kind === "mr_opened" ? "open" : "update",
      url: "https://gitlab.example.com/team/project/-/merge_requests/16",
      last_commit: {
        id: "abc123",
        message: "Add validation",
        title: "Add validation",
        url: "https://gitlab.example.com/team/project/-/commit/abc123",
      },
    },
    reviewers: [],
    assignees: [],
  };

  return { kind, payload };
}

describe("routeEvent", () => {
  it("routes issue mentions into mention jobs", () => {
    const result = routeEvent(
      createIssueNoteEvent("@agent codex please fix the flaky test"),
      routingConfig,
      logger,
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value).toEqual({
      kind: "enqueue",
      idempotencyKey: "note:100",
      payload: {
        kind: "handle_mention",
        project: "team/project",
        noteId: 100,
        issueIid: 17,
        prompt: "please fix the flaky test",
        agentType: "codex",
        defaultBranch: "main",
      },
    });
  });

  it("routes MR mentions into MR mention jobs", () => {
    const result = routeEvent(
      createMrNoteEvent("@agent please investigate the review feedback"),
      routingConfig,
      logger,
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value).toEqual({
      kind: "enqueue",
      idempotencyKey: "mr-note:300",
      payload: {
        kind: "handle_mr_mention",
        project: "team/project",
        noteId: 300,
        mrIid: 19,
        prompt: "please investigate the review feedback",
        agentType: "claude",
        sourceBranch: "feat/validation",
      },
    });
  });

  it("ignores notes that do not mention the bot", () => {
    const result = routeEvent(
      createIssueNoteEvent("@alice can you handle this?"),
      routingConfig,
      logger,
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value).toEqual({
      kind: "ignore",
      reason: "Bot was not mentioned in issue note",
    });
  });

  it("routes MR opened events into review jobs", () => {
    const result = routeEvent(createMergeRequestEvent("mr_opened"), routingConfig, logger);

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value).toEqual({
      kind: "enqueue",
      idempotencyKey: "mr:team/project:16:commit:abc123",
      payload: {
        kind: "review_mr",
        project: "team/project",
        mrIid: 16,
        sourceBranch: "feat/validation",
      },
    });
  });

  it("routes MR updated events into review jobs", () => {
    const result = routeEvent(createMergeRequestEvent("mr_updated"), routingConfig, logger);

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value).toEqual({
      kind: "enqueue",
      idempotencyKey: "mr:team/project:16:commit:abc123",
      payload: {
        kind: "review_mr",
        project: "team/project",
        mrIid: 16,
        sourceBranch: "feat/validation",
      },
    });
  });
});
