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
  | { readonly kind: "issue"; readonly project: string; readonly issueIid: number }
  | { readonly kind: "mr"; readonly project: string; readonly mrIid: number };

interface ReactionMetadata {
  readonly id: number;
  readonly name: unknown;
  readonly username: unknown;
}

function toGitlabError(error: unknown): AppError {
  const e = error as Error;
  return gitlabError(e.message);
}

export class GitLabService {
  private readonly api: InstanceType<typeof Gitlab>;
  private readonly logger: Logger;
  private readonly botUsername: string;

  constructor(token: string, host: string, logger: Logger, botUsername: string) {
    this.api = new Gitlab({ host, token });
    this.logger = logger;
    this.botUsername = botUsername;
  }

  addReaction(target: ReactionTarget, emoji: EmojiName): ResultAsync<number, AppError> {
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
        ).andThen(extractAwardId);
      case "mr_note":
        return fromPromise(
          this.api.MergeRequestNoteAwardEmojis.award(
            target.project,
            target.mrIid,
            target.noteId,
            emoji,
          ),
          toGitlabError,
        ).andThen(extractAwardId);
      case "issue":
        return fromPromise(
          this.api.IssueAwardEmojis.award(target.project, target.issueIid, emoji),
          toGitlabError,
        ).andThen(extractAwardId);
      case "mr":
        return fromPromise(
          this.api.MergeRequestAwardEmojis.award(target.project, target.mrIid, emoji),
          toGitlabError,
        ).andThen(extractAwardId);
    }
  }

  clearReaction(target: ReactionTarget, emoji: EmojiName): ResultAsync<void, AppError> {
    this.logger.debug({ target, emoji }, "Clearing reaction");
    return fromPromise(
      (async () => {
        const reactions = await this.listReactions(target);

        for (const reaction of reactions) {
          const reactionMetadata = readReactionMetadata(reaction);
          if (reactionMetadata === null) {
            continue;
          }

          if (isOwnedReaction(reactionMetadata, emoji, this.botUsername)) {
            await this.removeReactionRaw(target, reactionMetadata.id);
          }
        }
      })(),
      toGitlabError,
    ).map(() => undefined);
  }

  removeReaction(
    target: ReactionTarget,
    emoji: EmojiName,
    awardId: number,
  ): ResultAsync<void, AppError> {
    this.logger.debug({ target, emoji, awardId }, "Removing reaction");
    return fromPromise(this.removeReactionRaw(target, awardId), toGitlabError).map(() => undefined);
  }

  private removeReactionRaw(target: ReactionTarget, awardId: number): Promise<unknown> {
    switch (target.kind) {
      case "issue_note":
        return this.api.IssueNoteAwardEmojis.remove(
          target.project,
          target.issueIid,
          target.noteId,
          awardId,
        );
      case "mr_note":
        return this.api.MergeRequestNoteAwardEmojis.remove(
          target.project,
          target.mrIid,
          target.noteId,
          awardId,
        );
      case "issue":
        return this.api.IssueAwardEmojis.remove(target.project, target.issueIid, awardId);
      case "mr":
        return this.api.MergeRequestAwardEmojis.remove(target.project, target.mrIid, awardId);
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

  private listReactions(target: ReactionTarget): Promise<readonly unknown[]> {
    switch (target.kind) {
      case "issue_note":
        return callListMethod(this.api.IssueNoteAwardEmojis, [
          target.project,
          target.issueIid,
          target.noteId,
        ]);
      case "mr_note":
        return callListMethod(this.api.MergeRequestNoteAwardEmojis, [
          target.project,
          target.mrIid,
          target.noteId,
        ]);
      case "issue":
        return callListMethod(this.api.IssueAwardEmojis, [target.project, target.issueIid]);
      case "mr":
        return callListMethod(this.api.MergeRequestAwardEmojis, [target.project, target.mrIid]);
    }
  }
}

function readReactionMetadata(reaction: unknown): ReactionMetadata | null {
  if (typeof reaction !== "object" || reaction === null) {
    return null;
  }

  const id = Reflect.get(reaction, "id");
  const name = Reflect.get(reaction, "name");
  const user = Reflect.get(reaction, "user");
  const username = typeof user === "object" && user !== null ? Reflect.get(user, "username") : null;

  if (typeof id !== "number") {
    return null;
  }

  return { id, name, username };
}

function isOwnedReaction(
  reaction: ReactionMetadata,
  emoji: EmojiName,
  botUsername: string,
): boolean {
  return reaction.name === emoji && reaction.username === botUsername;
}

function extractAwardId(value: unknown): ResultAsync<number, AppError> {
  const awardId = typeof value === "object" && value !== null ? Reflect.get(value, "id") : null;
  if (typeof awardId !== "number") {
    return fromPromise(Promise.reject(new Error("Missing reaction award id")), toGitlabError);
  }

  return fromPromise(Promise.resolve(awardId), toGitlabError);
}

function callListMethod(service: object, args: readonly unknown[]): Promise<readonly unknown[]> {
  const allMethod = Reflect.get(service, "all");
  if (typeof allMethod !== "function") {
    return Promise.reject(new Error("Reaction listing is unavailable"));
  }

  return Promise.resolve(Reflect.apply(allMethod, service, [...args])).then((value) => {
    if (!Array.isArray(value)) {
      throw new Error("Reaction listing returned a non-array response");
    }

    return value;
  });
}
