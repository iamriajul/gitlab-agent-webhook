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

  describe("older GitLab version compatibility", () => {
    const baseMrAttributes = {
      id: 93,
      iid: 16,
      title: "Add validation",
      description: "This adds input validation",
      state: "opened",
      source_branch: "feat/validation",
      target_branch: "main",
      action: "open",
      url: "https://gitlab.example.com/team/project/-/merge_requests/16",
      last_commit: {
        id: "abc123",
        message: "Add validation",
        title: "Add validation",
        url: "https://gitlab.example.com/team/project/-/commit/abc123",
      },
    };

    it("accepts MR hook without draft field (pre-13.2)", () => {
      const payload = {
        object_kind: "merge_request",
        user: baseUser,
        project: baseProject,
        object_attributes: baseMrAttributes, // no draft field
      };
      const result = parseWebhookPayload("Merge Request Hook", payload);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.kind).toBe("mr_opened");
      }
    });

    it("accepts MR hook without last_commit (empty MR)", () => {
      const { last_commit: _, ...attrsWithoutCommit } = baseMrAttributes;
      const payload = {
        object_kind: "merge_request",
        user: baseUser,
        project: baseProject,
        object_attributes: attrsWithoutCommit,
      };
      const result = parseWebhookPayload("Merge Request Hook", payload);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.kind).toBe("mr_opened");
      }
    });

    it("accepts Note hook with unexpected action value (older GitLab)", () => {
      const payload = {
        object_kind: "note",
        user: baseUser,
        project: baseProject,
        object_attributes: {
          id: 100,
          note: "@bot fix this",
          noteable_type: "Issue",
          noteable_id: 42,
          action: "note", // old GitLab sent "note" instead of "create"
          url: "https://gitlab.example.com/team/project/issues/42#note_100",
          system: false,
        },
        issue: { id: 42, iid: 17, title: "Bug", description: null, state: "opened" },
      };
      const result = parseWebhookPayload("Note Hook", payload);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.kind).toBe("note_on_issue");
      }
    });

    it("accepts Note hook without action field", () => {
      const payload = {
        object_kind: "note",
        user: baseUser,
        project: baseProject,
        object_attributes: {
          id: 100,
          note: "@bot fix this",
          noteable_type: "Issue",
          noteable_id: 42,
          // no action field
          url: "https://gitlab.example.com/team/project/issues/42#note_100",
          system: false,
        },
        issue: { id: 42, iid: 17, title: "Bug", description: null, state: "opened" },
      };
      const result = parseWebhookPayload("Note Hook", payload);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.kind).toBe("note_on_issue");
      }
    });

    it("accepts commit note with null noteable_id and routes to ignored", () => {
      const payload = {
        object_kind: "note",
        user: baseUser,
        project: baseProject,
        object_attributes: {
          id: 200,
          note: "looks good",
          noteable_type: "Commit",
          noteable_id: null, // commits have no numeric DB id
          action: "create",
          url: "https://gitlab.example.com/team/project/-/commit/abc123#note_200",
          system: false,
        },
      };
      const result = parseWebhookPayload("Note Hook", payload);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.kind).toBe("ignored");
      }
    });

    it("accepts DiffNote noteable_type (GitLab 16+) and routes to ignored", () => {
      const payload = {
        object_kind: "note",
        user: baseUser,
        project: baseProject,
        object_attributes: {
          id: 201,
          note: "@bot check this line",
          noteable_type: "DiffNote", // added in GitLab 16
          noteable_id: null,
          action: "create",
          url: "https://gitlab.example.com/team/project/-/merge_requests/5#note_201",
          system: false,
        },
      };
      const result = parseWebhookPayload("Note Hook", payload);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.kind).toBe("ignored");
      }
    });

    it("treats MR reopen action as mr_opened", () => {
      const payload = {
        object_kind: "merge_request",
        user: baseUser,
        project: baseProject,
        object_attributes: {
          ...baseMrAttributes,
          action: "reopen",
        },
      };
      const result = parseWebhookPayload("Merge Request Hook", payload);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.kind).toBe("mr_opened");
      }
    });

    it("treats issue reopen action as issue_assigned", () => {
      const payload = {
        object_kind: "issue",
        user: baseUser,
        project: baseProject,
        object_attributes: {
          id: 10,
          iid: 3,
          title: "Reopened issue",
          description: null,
          state: "opened",
          action: "reopen",
        },
      };
      const result = parseWebhookPayload("Issue Hook", payload);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.kind).toBe("issue_assigned");
      }
    });

    it("normalizes pre-11.0 singular assignee into assignees array", () => {
      const payload = {
        object_kind: "merge_request",
        user: baseUser,
        project: baseProject,
        object_attributes: { ...baseMrAttributes, action: "update" },
        assignee: { id: 2, username: "agent", name: "Agent Bot" }, // pre-11.0 singular form
        // no assignees array
      };
      const result = parseWebhookPayload("Merge Request Hook", payload);
      expect(result.isOk()).toBe(true);
      if (result.isOk() && result.value.kind === "mr_updated") {
        expect(result.value.payload.assignees).toEqual([
          { id: 2, username: "agent", name: "Agent Bot" },
        ]);
      } else {
        expect(false).toBe(true); // should have been mr_updated
      }
    });

    it("accepts project without default_branch field", () => {
      const { default_branch: _, ...projectWithoutBranch } = baseProject;
      const payload = {
        object_kind: "note",
        user: baseUser,
        project: projectWithoutBranch,
        object_attributes: {
          id: 100,
          note: "@bot fix this",
          noteable_type: "Issue",
          noteable_id: 42,
          action: "create",
          url: "https://gitlab.example.com/team/project/issues/42#note_100",
          system: false,
        },
        issue: { id: 42, iid: 17, title: "Bug", description: null, state: "opened" },
      };
      const result = parseWebhookPayload("Note Hook", payload);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.kind).toBe("note_on_issue");
      }
    });
  });
});
