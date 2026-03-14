import { describe, expect, it } from "bun:test";
import { parseWebhookPayload } from "../../src/events/parser.ts";

const baseProject = {
  id: 5,
  path_with_namespace: "team/project",
  web_url: "https://gitlab.example.com/team/project",
  default_branch: "main",
};

const baseUser = { id: 1, username: "dev", name: "Developer" };

describe("parseWebhookPayload", () => {
  it("parses a valid Note Hook on issue", () => {
    const payload = {
      object_kind: "note",
      user: baseUser,
      project: baseProject,
      object_attributes: {
        id: 100,
        note: "@bot fix this bug",
        noteable_type: "Issue",
        noteable_id: 42,
        action: "create",
        url: "https://gitlab.example.com/team/project/issues/42#note_100",
        system: false,
      },
      issue: { id: 42, iid: 17, title: "Bug report", description: "It crashes", state: "opened" },
    };

    const result = parseWebhookPayload("Note Hook", payload);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("note_on_issue");
    }
  });

  it("ignores system notes", () => {
    const payload = {
      object_kind: "note",
      user: baseUser,
      project: baseProject,
      object_attributes: {
        id: 100,
        note: "assigned to @dev",
        noteable_type: "Issue",
        noteable_id: 42,
        action: "create",
        url: "https://gitlab.example.com/team/project/issues/42#note_100",
        system: true,
      },
      issue: { id: 42, iid: 17, title: "Bug", description: null, state: "opened" },
    };

    const result = parseWebhookPayload("Note Hook", payload);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("ignored");
    }
  });

  it("parses MR opened event", () => {
    const payload = {
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
        action: "open",
        url: "https://gitlab.example.com/team/project/-/merge_requests/16",
        last_commit: {
          id: "abc123",
          message: "Add validation",
          title: "Add validation",
          url: "https://gitlab.example.com/team/project/-/commit/abc123",
        },
      },
    };

    const result = parseWebhookPayload("Merge Request Hook", payload);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("mr_opened");
    }
  });

  it("returns ignored for unknown event types", () => {
    const result = parseWebhookPayload("Push Hook", {});
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("ignored");
    }
  });

  it("returns error for invalid payload", () => {
    const result = parseWebhookPayload("Note Hook", { object_kind: "note" });
    expect(result.isErr()).toBe(true);
  });
});
