import { z } from "zod/v4";
import type { AppError } from "../types/errors.ts";
import { parseError } from "../types/errors.ts";
import type { WebhookEvent } from "../types/events.ts";
import type { Result } from "../types/result.ts";
import { err, ok } from "../types/result.ts";

const UserSchema = z.object({
  id: z.number(),
  username: z.string(),
  name: z.string(),
});

const ProjectSchema = z.object({
  id: z.number(),
  path_with_namespace: z.string(),
  web_url: z.string(),
  default_branch: z.string().optional(),
});

const IssueSchema = z.object({
  id: z.number(),
  iid: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  state: z.string(),
});

const MergeRequestInNoteSchema = z.object({
  id: z.number(),
  iid: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  state: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
});

const NoteAttributesSchema = z.object({
  id: z.number(),
  note: z.string(),
  noteable_type: z.string(), // kept as string for forward-compat (DiffNote added in 16, future types possible)
  noteable_id: z.number().nullable(), // null for commit notes (commits have no numeric DB id)
  action: z.string().optional(),
  url: z.string(),
  system: z.boolean(),
});

const NoteHookPayload = z.object({
  object_kind: z.literal("note"),
  user: UserSchema,
  project: ProjectSchema,
  object_attributes: NoteAttributesSchema,
  issue: IssueSchema.optional(),
  merge_request: MergeRequestInNoteSchema.optional(),
});

const LastCommitSchema = z.object({
  id: z.string(),
  message: z.string(),
  title: z.string(),
  url: z.string(),
});

const MRAttributesSchema = z.object({
  id: z.number(),
  iid: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  state: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  draft: z.boolean().optional().default(false),
  action: z.string(),
  url: z.string(),
  last_commit: LastCommitSchema.optional(),
});

const MergeRequestHookPayload = z
  .object({
    object_kind: z.literal("merge_request"),
    user: UserSchema,
    project: ProjectSchema,
    object_attributes: MRAttributesSchema,
    assignee: UserSchema.optional(), // pre-11.0 singular form; normalized to assignees below
    reviewers: z.array(UserSchema).optional().default([]),
    assignees: z.array(UserSchema).optional().default([]),
  })
  .transform(({ assignee, ...rest }) => ({
    ...rest,
    // When the array is absent (pre-11.0), promote the singular field into the array
    assignees:
      rest.assignees.length > 0 ? rest.assignees : assignee !== undefined ? [assignee] : [],
  }));

const IssueAttributesSchema = z.object({
  id: z.number(),
  iid: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  state: z.string(),
  action: z.string(),
});

const IssueHookPayloadSchema = z.object({
  object_kind: z.literal("issue").optional(),
  user: UserSchema,
  project: ProjectSchema,
  object_attributes: IssueAttributesSchema,
  assignees: z.array(UserSchema).optional().default([]),
});

export type NoteOnIssuePayload = z.infer<typeof NoteHookPayload> & {
  readonly object_attributes: { readonly noteable_type: "Issue" };
  readonly issue: z.infer<typeof IssueSchema>;
};

export type NoteOnMRPayload = z.infer<typeof NoteHookPayload> & {
  readonly object_attributes: { readonly noteable_type: "MergeRequest" };
  readonly merge_request: z.infer<typeof MergeRequestInNoteSchema>;
};

export type MergeRequestPayload = z.infer<typeof MergeRequestHookPayload>;
export type IssueHookPayload = z.infer<typeof IssueHookPayloadSchema>;

function parseNoteHook(body: unknown): Result<WebhookEvent, AppError> {
  const result = NoteHookPayload.safeParse(body);
  if (!result.success) {
    return err(parseError(`Invalid Note Hook payload: ${result.error.message}`));
  }
  const data = result.data;

  if (data.object_attributes.system) {
    return ok({ kind: "ignored", reason: "System-generated note" });
  }

  if (data.object_attributes.noteable_type === "Issue" && data.issue !== undefined) {
    return ok({ kind: "note_on_issue", payload: data as NoteOnIssuePayload });
  }

  if (data.object_attributes.noteable_type === "MergeRequest" && data.merge_request !== undefined) {
    return ok({ kind: "note_on_mr", payload: data as NoteOnMRPayload });
  }

  return ok({
    kind: "ignored",
    reason: `Unhandled noteable_type: ${data.object_attributes.noteable_type}`,
  });
}

function parseMergeRequestHook(body: unknown): Result<WebhookEvent, AppError> {
  const result = MergeRequestHookPayload.safeParse(body);
  if (!result.success) {
    return err(parseError(`Invalid Merge Request Hook payload: ${result.error.message}`));
  }
  const action = result.data.object_attributes.action;

  if (action === "open" || action === "reopen") {
    return ok({ kind: "mr_opened", payload: result.data });
  }
  if (action === "update") {
    return ok({ kind: "mr_updated", payload: result.data });
  }
  if (action === "close" || action === "merge") {
    return ok({ kind: "mr_closed", payload: result.data });
  }

  return ok({ kind: "ignored", reason: `Unhandled MR action: ${action}` });
}

function parseIssueHook(body: unknown): Result<WebhookEvent, AppError> {
  const result = IssueHookPayloadSchema.safeParse(body);
  if (!result.success) {
    return err(parseError(`Invalid Issue Hook payload: ${result.error.message}`));
  }
  const action = result.data.object_attributes.action;

  if (action === "close") {
    return ok({ kind: "issue_closed", payload: result.data });
  }
  if (action === "open" || action === "reopen" || action === "update") {
    return ok({ kind: "issue_assigned", payload: result.data });
  }

  return ok({ kind: "ignored", reason: `Unhandled issue action: ${action}` });
}

export function parseWebhookPayload(
  eventType: string,
  body: unknown,
): Result<WebhookEvent, AppError> {
  if (eventType === "Note Hook") {
    return parseNoteHook(body);
  }
  if (eventType === "Merge Request Hook") {
    return parseMergeRequestHook(body);
  }
  if (eventType === "Issue Hook") {
    return parseIssueHook(body);
  }
  return ok({ kind: "ignored", reason: `Unhandled event type: ${eventType}` });
}
