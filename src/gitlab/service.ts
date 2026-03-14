import { Gitlab } from "@gitbeaker/rest";
import type { Logger } from "../config/logger.ts";
import type { AppError } from "../types/errors.ts";
import { gitlabError } from "../types/errors.ts";
import type { EmojiName } from "../types/events.ts";
import type { ResultAsync } from "../types/result.ts";
import { fromPromise } from "../types/result.ts";

/**
 * Upper-layer GitLab operations only.
 * This service handles service-level concerns: acknowledgment (emoji reactions)
 * and status updates (comments). It does NOT pre-fetch context or detect intent.
 * All content-level GitLab interaction (reading diffs, pipelines, posting reviews)
 * is handled by spawned agents via glab CLI.
 */

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
    }
  | { readonly kind: "mr"; readonly project: string; readonly mrIid: number };

function toGitlabError(error: unknown): AppError {
  const e = error as Error;
  return gitlabError(e.message);
}

export class GitLabService {
  private readonly api: InstanceType<typeof Gitlab>;
  private readonly logger: Logger;

  constructor(token: string, host: string, logger: Logger) {
    this.api = new Gitlab({ host, token });
    this.logger = logger;
  }

  addReaction(target: ReactionTarget, emoji: EmojiName): ResultAsync<void, AppError> {
    this.logger.debug({ target, emoji }, "Adding reaction");
    switch (target.kind) {
      case "issue_note":
        return fromPromise(
          this.api.IssueNoteAwardEmojis.award(
            target.project,
            target.issueIid,
            target.noteId,
            emoji,
          ),
          toGitlabError,
        ).map(() => undefined);
      case "mr_note":
        return fromPromise(
          this.api.MergeRequestNoteAwardEmojis.award(
            target.project,
            target.mrIid,
            target.noteId,
            emoji,
          ),
          toGitlabError,
        ).map(() => undefined);
      case "mr":
        return fromPromise(
          this.api.MergeRequestAwardEmojis.award(target.project, target.mrIid, emoji),
          toGitlabError,
        ).map(() => undefined);
    }
  }

  removeReaction(
    target: ReactionTarget,
    emoji: EmojiName,
    awardId: number,
  ): ResultAsync<void, AppError> {
    this.logger.debug({ target, emoji, awardId }, "Removing reaction");
    switch (target.kind) {
      case "issue_note":
        return fromPromise(
          this.api.IssueNoteAwardEmojis.remove(
            target.project,
            target.issueIid,
            target.noteId,
            awardId,
          ),
          toGitlabError,
        ).map(() => undefined);
      case "mr_note":
        return fromPromise(
          this.api.MergeRequestNoteAwardEmojis.remove(
            target.project,
            target.mrIid,
            target.noteId,
            awardId,
          ),
          toGitlabError,
        ).map(() => undefined);
      case "mr":
        return fromPromise(
          this.api.MergeRequestAwardEmojis.remove(target.project, target.mrIid, awardId),
          toGitlabError,
        ).map(() => undefined);
    }
  }

  postIssueComment(project: string, issueIid: number, body: string): ResultAsync<void, AppError> {
    this.logger.debug({ project, issueIid }, "Posting issue comment");
    return fromPromise(this.api.IssueNotes.create(project, issueIid, body), toGitlabError).map(
      () => undefined,
    );
  }

  postMRComment(project: string, mrIid: number, body: string): ResultAsync<void, AppError> {
    this.logger.debug({ project, mrIid }, "Posting MR comment");
    return fromPromise(this.api.MergeRequestNotes.create(project, mrIid, body), toGitlabError).map(
      () => undefined,
    );
  }
}
