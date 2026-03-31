import type { AgentConfig, AgentProcess, AgentResult, AgentType } from "../agents/types.ts";
import {
  REACTION_DONE,
  REACTION_FAILED,
  REACTION_PROGRESS,
  REACTION_SEEN,
} from "../config/constants.ts";
import type { Logger } from "../config/logger.ts";
import type { ReactionTarget } from "../gitlab/service.ts";
import type { AgentSession, SessionContext, SessionManager } from "../sessions/manager.ts";
import type { AppError } from "../types/errors.ts";
import { agentError, queueError } from "../types/errors.ts";
import type { AgentKind, EmojiName } from "../types/events.ts";
import {
  err,
  fromPromise,
  fromThrowable,
  ok,
  type Result,
  type ResultAsync,
} from "../types/result.ts";
import type { JobQueue } from "./queue.ts";
import type { Job, JobPayload } from "./types.ts";

export interface WorkerGitLabClient {
  addReaction(target: ReactionTarget, emoji: EmojiName): ResultAsync<number, AppError>;
  clearReaction(target: ReactionTarget, emoji: EmojiName): ResultAsync<void, AppError>;
  removeReaction(
    target: ReactionTarget,
    emoji: EmojiName,
    awardId: number,
  ): ResultAsync<void, AppError>;
  postIssueComment(project: string, issueIid: number, body: string): ResultAsync<void, AppError>;
  postMRComment(project: string, mrIid: number, body: string): ResultAsync<void, AppError>;
}

export interface WorkerDependencies {
  readonly queue: JobQueue;
  readonly sessions: SessionManager;
  readonly gitlab: WorkerGitLabClient;
  readonly logger: Logger;
  readonly defaultAgent: AgentKind;
  readonly workDir: string;
  readonly gitlabHost: string;
  readonly prepareWorkspace: (
    payload: JobPayload,
    baseWorkDir: string,
    gitlabHost: string,
  ) => Result<string, AppError>;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly spawnAgent: (config: AgentConfig) => Result<AgentProcess, AppError>;
}

export interface Worker {
  runNextJob(agentFilter?: AgentKind): Promise<Result<Job | null, AppError>>;
  stop(): void;
  drain(): Promise<void>;
}

interface JobReactionState {
  readonly target: ReactionTarget;
  readonly awardId: number;
  readonly emoji: EmojiName;
}

type PendingSessionUpdate =
  | {
      readonly kind: "create";
      readonly agentType: AgentKind;
      readonly agentSessionId: string;
      readonly context: SessionContext;
    }
  | {
      readonly kind: "update";
      readonly sessionId: AgentSession["id"];
      readonly agentSessionId?: string | undefined;
    }
  | { readonly kind: "none" };

interface ProcessedJobState {
  readonly reaction: JobReactionState | null;
  readonly sessionUpdate: PendingSessionUpdate;
}

type CoordinationKey = string | null;

function formatUnknownError(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }

  return String(cause);
}

function mapAgentType(agentKind: AgentKind, model?: string, effort?: string): AgentType {
  switch (agentKind) {
    case "claude":
      return { kind: "claude", model, effort };
    case "codex":
      return { kind: "codex", model, effort };
    case "gemini":
      return { kind: "gemini", model, effort };
  }
}

function supportsResume(agentKind: AgentKind): boolean {
  switch (agentKind) {
    case "claude":
      return true;
    case "codex":
      return true;
    case "gemini":
      return false;
  }
}

function formatAppError(error: AppError): string {
  return `${error.kind}: ${error.message}`;
}

function contextForPayload(payload: JobPayload): SessionContext {
  switch (payload.kind) {
    case "handle_mention":
      return {
        kind: "issue",
        project: payload.project,
        issueIid: payload.issueIid,
      };
    case "handle_mr_mention":
      return {
        kind: "mr",
        project: payload.project,
        mrIid: payload.mrIid,
      };
    case "review_mr":
      return {
        kind: "mr_review",
        project: payload.project,
        mrIid: payload.mrIid,
      };
  }
}

function agentKindForPayload(payload: JobPayload, defaultAgent: AgentKind): AgentKind {
  switch (payload.kind) {
    case "handle_mention":
      return payload.agentType;
    case "handle_mr_mention":
      return payload.agentType;
    case "review_mr":
      return defaultAgent;
  }
}

function modelForPayload(payload: JobPayload): string | undefined {
  switch (payload.kind) {
    case "handle_mention":
      return payload.model;
    case "handle_mr_mention":
      return payload.model;
    case "review_mr":
      return undefined;
  }
}

function effortForPayload(payload: JobPayload): string | undefined {
  switch (payload.kind) {
    case "handle_mention":
      return payload.effort;
    case "handle_mr_mention":
      return payload.effort;
    case "review_mr":
      return undefined;
  }
}

function reactionTargetForPayload(payload: JobPayload): ReactionTarget | null {
  switch (payload.kind) {
    case "handle_mention":
      if (payload.noteId === 0) {
        return {
          kind: "issue",
          project: payload.project,
          issueIid: payload.issueIid,
        };
      }
      return {
        kind: "issue_note",
        project: payload.project,
        issueIid: payload.issueIid,
        noteId: payload.noteId,
      };
    case "handle_mr_mention":
      if (payload.noteId === 0) {
        return {
          kind: "mr",
          project: payload.project,
          mrIid: payload.mrIid,
        };
      }
      return {
        kind: "mr_note",
        project: payload.project,
        mrIid: payload.mrIid,
        noteId: payload.noteId,
      };
    case "review_mr":
      return {
        kind: "mr",
        project: payload.project,
        mrIid: payload.mrIid,
      };
  }
}

function coordinationKeyForPayload(payload: JobPayload): CoordinationKey {
  switch (payload.kind) {
    case "handle_mention":
      return `session:issue:${payload.project}:${payload.issueIid}`;
    case "handle_mr_mention":
      return `session:mr:${payload.project}:${payload.mrIid}`;
    case "review_mr":
      return `review:${payload.project}:${payload.mrIid}`;
  }
}

function buildAgentEnv(
  envOverride?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return envOverride ?? {};
}

const HEADLESS_PREAMBLE = [
  "You are an autonomous AI coding agent. You are running headless — there is",
  "no terminal, no user watching. Nobody sees your stdout.",
  "",
  "ALL communication with the user MUST go through GitLab comments.",
  "Use `glab` CLI for all GitLab interaction.",
].join("\n");

const QUESTION_RULES = [
  "- Prefer acting over asking. If you can make a reasonable decision, do it.",
  "- If you MUST ask questions, batch ALL questions into a single GitLab comment",
  "  as a numbered list. The user will reply with a numbered list of answers.",
  "  Do NOT use interactive tool-based question flows.",
].join("\n");

function buildSystemPrompt(payload: JobPayload): string {
  switch (payload.kind) {
    case "handle_mention":
      return [
        HEADLESS_PREAMBLE,
        "",
        `You are in a git clone of project ${payload.project} on branch agent/issue-${payload.issueIid}.`,
        "The repo is ready — do NOT clone again.",
        "",
        "Your workflow:",
        `1. Read the issue with \`glab issue view ${payload.issueIid}\` to understand context.`,
        `2. Read the full comment thread with \`glab api projects/:id/issues/${payload.issueIid}/notes\`.`,
        "3. Act on the user's request — implement, fix, or answer.",
        "4. For code changes: commit, push, and create an MR with `glab mr create`.",
        `5. Post a summary comment on the issue with \`glab issue note ${payload.issueIid} -m "..."\`.`,
        "",
        "Rules:",
        QUESTION_RULES,
        "- NEVER push to protected branches (main, master). You are on a feature branch.",
        "- Keep GitLab comments concise and actionable.",
      ].join("\n");
    case "handle_mr_mention":
      return [
        HEADLESS_PREAMBLE,
        "",
        `You are in a git clone of project ${payload.project} on the MR source branch (${payload.sourceBranch}).`,
        "The repo is ready — do NOT clone again.",
        "",
        "Your workflow:",
        `1. Read the MR with \`glab mr view ${payload.mrIid}\` to understand context.`,
        "2. Read the comment thread to understand what the user wants.",
        "3. Act on the user's request — implement changes, fix issues, review code.",
        "4. For code changes: commit and push to the current branch.",
        `5. Post a summary comment on the MR with \`glab mr note ${payload.mrIid} -m "..."\`.`,
        "",
        "Rules:",
        QUESTION_RULES,
        "- NEVER push to protected branches. You are on the MR source branch.",
      ].join("\n");
    case "review_mr":
      return [
        HEADLESS_PREAMBLE,
        "",
        `You are in a git clone of project ${payload.project} on branch ${payload.sourceBranch}.`,
        "The repo is ready — do NOT clone again.",
        "",
        `Your task: review merge request !${payload.mrIid}.`,
        "",
        "Your workflow:",
        `1. Read the MR with \`glab mr view ${payload.mrIid}\` and \`glab mr diff ${payload.mrIid}\`.`,
        "2. Analyze the changes for bugs, type safety, error handling, and style.",
        `3. Post your review as a comment on the MR with \`glab mr note ${payload.mrIid} -m "..."\`.`,
        "",
        "Rules:",
        "- Prefer acting over asking. If you can make a reasonable decision, do it.",
        "- Post actionable, specific feedback. Reference file paths and line numbers.",
        "- If the MR looks good, say so concisely.",
      ].join("\n");
  }
}

function buildGeminiFollowUpPrompt(
  payload: Extract<JobPayload, { readonly kind: "handle_mention" | "handle_mr_mention" }>,
  existingSession: AgentSession,
): string {
  switch (payload.kind) {
    case "handle_mention":
      return [
        `Issue follow-up for #${payload.issueIid}: ${payload.prompt}`,
        "",
        "This is a follow-up to an earlier Gemini attempt,",
        "but Gemini cannot resume headless sessions.",
        `Previous Gemini session id: ${existingSession.agentSessionId || "unavailable"}.`,
        "Before taking action, read the existing GitLab issue discussion",
        "and any prior agent comments to",
        "reconstruct the earlier context.",
      ].join("\n");
    case "handle_mr_mention":
      return [
        `Merge request follow-up for !${payload.mrIid}: ${payload.prompt}`,
        "",
        "This is a follow-up to an earlier Gemini attempt,",
        "but Gemini cannot resume headless sessions.",
        `Previous Gemini session id: ${existingSession.agentSessionId || "unavailable"}.`,
        "Before taking action, read the existing GitLab merge request",
        "discussion and any prior agent comments to reconstruct the",
        "earlier context.",
      ].join("\n");
  }
}

function buildUserPrompt(
  payload: JobPayload,
  agentKind: AgentKind,
  existingSession: AgentSession | null,
): string {
  if (agentKind === "gemini" && existingSession !== null) {
    switch (payload.kind) {
      case "handle_mention":
        return buildGeminiFollowUpPrompt(payload, existingSession);
      case "handle_mr_mention":
        return buildGeminiFollowUpPrompt(payload, existingSession);
      case "review_mr":
        break;
    }
  }

  switch (payload.kind) {
    case "handle_mention":
      return `Issue follow-up for #${payload.issueIid}: ${payload.prompt}`;
    case "handle_mr_mention":
      return `Merge request follow-up for !${payload.mrIid}: ${payload.prompt}`;
    case "review_mr":
      return `Review merge request !${payload.mrIid} in project ${payload.project}.`;
  }
}

function canReuseSession(payload: JobPayload): boolean {
  switch (payload.kind) {
    case "handle_mention":
      return true;
    case "handle_mr_mention":
      return true;
    case "review_mr":
      return true;
  }
}

function shouldPersistSession(payload: JobPayload): boolean {
  switch (payload.kind) {
    case "handle_mention":
      return true;
    case "handle_mr_mention":
      return true;
    case "review_mr":
      return true;
  }
}

function failureCommentBody(error: AppError): string {
  return `Agent failed: ${formatAppError(error)}`;
}

function runAsyncResult<T>(result: ResultAsync<T, AppError>): Promise<Result<T, AppError>> {
  return new Promise<Result<T, AppError>>((resolve, reject) => {
    result.then(resolve, reject);
  });
}

async function awaitAgentResult(
  process: AgentProcess,
  agentKind: AgentKind,
): Promise<Result<AgentResult, AppError>> {
  const awaitedResult = await fromPromise(process.result, () =>
    agentError("Agent process promise rejected", agentKind, -1),
  ).match(
    (value) => value,
    (error) => err(error),
  );

  return awaitedResult;
}

async function postStatusComment(
  gitlab: WorkerGitLabClient,
  payload: JobPayload,
  body: string,
): Promise<Result<void, AppError>> {
  switch (payload.kind) {
    case "handle_mention":
      return runAsyncResult(gitlab.postIssueComment(payload.project, payload.issueIid, body));
    case "handle_mr_mention":
      return runAsyncResult(gitlab.postMRComment(payload.project, payload.mrIid, body));
    case "review_mr":
      return runAsyncResult(gitlab.postMRComment(payload.project, payload.mrIid, body));
  }
}

function validateAgentExit(
  result: AgentResult,
  agentKind: AgentKind,
): Result<AgentResult, AppError> {
  if (result.exitCode === 0) {
    return ok(result);
  }

  const stderr = result.stderr.trim();
  return err(
    agentError(
      stderr.length > 0 ? stderr : `Agent exited with code ${result.exitCode}`,
      agentKind,
      result.exitCode,
    ),
  );
}

export function createWorker(dependencies: WorkerDependencies): Worker {
  const activeCoordinationKeys = new Set<string>();
  const activeJobs = new Map<Job["id"], AgentProcess>();
  const interruptedJobs = new Set<Job["id"]>();
  let shutdownRequested = false;

  function interruptForShutdown(jobId: Job["id"]): Result<never, AppError> {
    interruptedJobs.add(jobId);
    return err(queueError("Worker shutdown interrupted active job"));
  }

  async function tryWithCoordinationLock<T>(
    key: CoordinationKey,
    operation: () => Promise<T>,
  ): Promise<T | null> {
    if (key === null) {
      return operation();
    }

    if (activeCoordinationKeys.has(key)) {
      return null;
    }

    activeCoordinationKeys.add(key);

    try {
      return await operation();
    } finally {
      activeCoordinationKeys.delete(key);
    }
  }

  async function addAcknowledgmentReaction(
    payload: JobPayload,
    target: ReactionTarget,
    jobId: Job["id"],
  ): Promise<Result<JobReactionState, AppError>> {
    const reactionResult = await runAsyncResult(
      dependencies.gitlab.addReaction(target, REACTION_SEEN),
    );
    if (reactionResult.isOk()) {
      return ok({
        target,
        awardId: reactionResult.value,
        emoji: REACTION_SEEN,
      });
    }
    const originalReactionError = reactionResult.error;

    async function retryAfterClearingReaction(): Promise<Result<JobReactionState, AppError>> {
      const clearReactionResult = await runAsyncResult(
        dependencies.gitlab.clearReaction(target, REACTION_SEEN),
      );
      if (clearReactionResult.isErr()) {
        dependencies.logger.warn(
          {
            error: clearReactionResult.error,
            jobId,
            reaction: REACTION_SEEN,
            target,
            originalError: originalReactionError,
          },
          "Failed to clear stale acknowledgment reaction before retry",
        );
        return err(originalReactionError);
      }

      const retryReactionResult = await runAsyncResult(
        dependencies.gitlab.addReaction(target, REACTION_SEEN),
      );
      if (retryReactionResult.isErr()) {
        return err(retryReactionResult.error);
      }

      return ok({
        target,
        awardId: retryReactionResult.value,
        emoji: REACTION_SEEN,
      });
    }

    switch (payload.kind) {
      case "review_mr":
        return retryAfterClearingReaction();
      case "handle_mention":
        return retryAfterClearingReaction();
      case "handle_mr_mention":
        return retryAfterClearingReaction();
    }
  }

  async function removeAcknowledgmentReaction(
    reaction: JobReactionState | null,
    jobId: Job["id"],
  ): Promise<void> {
    if (reaction === null) {
      return;
    }
    const removeResult = await runAsyncResult(
      dependencies.gitlab.removeReaction(reaction.target, reaction.emoji, reaction.awardId),
    );
    if (removeResult.isErr()) {
      dependencies.logger.warn(
        {
          error: removeResult.error,
          jobId,
          reaction: reaction.emoji,
          target: reaction.target,
        },
        "Failed to remove acknowledgment reaction",
      );
    }
  }

  async function addTerminalReaction(
    reaction: JobReactionState | null,
    emoji: EmojiName,
    jobId: Job["id"],
  ): Promise<void> {
    if (reaction === null) {
      return;
    }
    if (reaction.target.kind === "mr") {
      for (const terminalEmoji of [REACTION_DONE, REACTION_FAILED, REACTION_PROGRESS]) {
        const clearResult = await runAsyncResult(
          dependencies.gitlab.clearReaction(reaction.target, terminalEmoji),
        );
        if (clearResult.isErr()) {
          dependencies.logger.warn(
            {
              error: clearResult.error,
              jobId,
              reaction: terminalEmoji,
              target: reaction.target,
            },
            "Failed to clear stale terminal reaction",
          );
        }
      }
    }

    const addResult = await runAsyncResult(dependencies.gitlab.addReaction(reaction.target, emoji));
    if (addResult.isErr()) {
      dependencies.logger.warn(
        {
          error: addResult.error,
          jobId,
          reaction: emoji,
          target: reaction.target,
        },
        "Failed to add terminal reaction",
      );
    }
  }

  async function transitionReaction(
    reaction: JobReactionState | null,
    emoji: EmojiName,
    jobId: Job["id"],
  ): Promise<void> {
    await removeAcknowledgmentReaction(reaction, jobId);
    await addTerminalReaction(reaction, emoji, jobId);
  }

  async function transitionToProgressReaction(
    reaction: JobReactionState,
    jobId: Job["id"],
  ): Promise<Result<JobReactionState, AppError>> {
    await removeAcknowledgmentReaction(reaction, jobId);
    const addResult = await runAsyncResult(
      dependencies.gitlab.addReaction(reaction.target, REACTION_PROGRESS),
    );
    if (addResult.isErr()) {
      dependencies.logger.warn(
        { error: addResult.error, jobId },
        "Failed to add progress reaction",
      );
      return ok(reaction); // Keep old state, non-fatal
    }
    return ok({
      target: reaction.target,
      awardId: addResult.value,
      emoji: REACTION_PROGRESS,
    });
  }

  async function markJobFailed(job: Job, error: AppError): Promise<Result<never, AppError>> {
    const failResult = dependencies.queue.fail(job.id, formatAppError(error));
    if (failResult.isErr()) {
      return err(failResult.error);
    }

    dependencies.logger.error({ error, jobId: job.id }, "Job failed");
    return err(error);
  }

  async function markJobTerminalFailure(
    job: Job,
    error: AppError,
  ): Promise<Result<never, AppError>> {
    const failResult = dependencies.queue.fail(job.id, formatAppError(error));
    if (failResult.isErr()) {
      return err(failResult.error);
    }

    dependencies.logger.error({ error, jobId: job.id }, "Job terminal update failed");
    return err(error);
  }

  function buildPendingSessionUpdate(
    payload: JobPayload,
    reusableSession: AgentSession | null,
    agentKind: AgentKind,
    context: SessionContext,
    result: AgentResult,
  ): PendingSessionUpdate {
    if (!shouldPersistSession(payload)) {
      return { kind: "none" };
    }

    if (reusableSession === null) {
      return {
        kind: "create",
        agentType: agentKind,
        agentSessionId: result.sessionId ?? "",
        context,
      };
    }

    return {
      kind: "update",
      sessionId: reusableSession.id,
      agentSessionId: result.sessionId ?? undefined,
    };
  }

  function persistSessionUpdate(sessionUpdate: PendingSessionUpdate): Result<void, AppError> {
    switch (sessionUpdate.kind) {
      case "none":
        return ok(undefined);
      case "create": {
        const createSessionResult = dependencies.sessions.create({
          agentType: sessionUpdate.agentType,
          agentSessionId: sessionUpdate.agentSessionId,
          context: sessionUpdate.context,
        });
        if (createSessionResult.isErr()) {
          return err(createSessionResult.error);
        }

        return ok(undefined);
      }
      case "update": {
        const updateSessionResult = dependencies.sessions.updateActivity(
          sessionUpdate.sessionId,
          sessionUpdate.agentSessionId,
        );
        if (updateSessionResult.isErr()) {
          return err(updateSessionResult.error);
        }

        return ok(undefined);
      }
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: worker orchestration is intentionally linear and covered by focused tests.
  async function processJob(job: Job): Promise<Result<ProcessedJobState, AppError>> {
    const payload = job.payload;
    const agentKind = agentKindForPayload(payload, dependencies.defaultAgent);
    const context = contextForPayload(payload);
    const reactionTarget = reactionTargetForPayload(payload);
    const existingSessionResult = canReuseSession(payload)
      ? dependencies.sessions.findByContext(context, agentKind)
      : ok(null);
    if (existingSessionResult.isErr()) {
      return err(existingSessionResult.error);
    }

    const reusableSession = existingSessionResult.value;
    const canResumeExistingSession =
      reusableSession !== null &&
      reusableSession.agentSessionId.length > 0 &&
      supportsResume(agentKind);
    const resumeSessionId =
      canResumeExistingSession && reusableSession !== null ? reusableSession.agentSessionId : null;

    let jobReaction: JobReactionState | null = null;
    if (reactionTarget !== null) {
      const reactionResult = await addAcknowledgmentReaction(payload, reactionTarget, job.id);
      if (reactionResult.isErr()) {
        return err(reactionResult.error);
      }
      jobReaction = reactionResult.value;
    }

    const prepareWorkspaceResult = dependencies.prepareWorkspace(
      payload,
      dependencies.workDir,
      dependencies.gitlabHost,
    );
    if (prepareWorkspaceResult.isErr()) {
      await transitionReaction(jobReaction, REACTION_FAILED, job.id);
      return err(prepareWorkspaceResult.error);
    }

    const spawnConfigBase = {
      agent: mapAgentType(agentKind, modelForPayload(payload), effortForPayload(payload)),
      workDir: prepareWorkspaceResult.value,
      prompt: buildUserPrompt(payload, agentKind, reusableSession),
      systemPrompt: buildSystemPrompt(payload),
      env: buildAgentEnv(dependencies.env),
      timeoutMs: dependencies.timeoutMs,
    };
    const spawnConfig =
      resumeSessionId !== null
        ? { ...spawnConfigBase, sessionId: resumeSessionId }
        : spawnConfigBase;

    let spawnedProcess: AgentProcess | null = null;
    if (payload.kind === "review_mr") {
      if (shutdownRequested) {
        await removeAcknowledgmentReaction(jobReaction, job.id);
        return interruptForShutdown(job.id);
      }

      const spawnResult = dependencies.spawnAgent(spawnConfig);
      if (spawnResult.isErr()) {
        const failureCommentResult = await postStatusComment(
          dependencies.gitlab,
          payload,
          `Agent failed: ${formatAppError(spawnResult.error)}`,
        );
        if (failureCommentResult.isErr()) {
          dependencies.logger.warn(
            {
              error: failureCommentResult.error,
              jobId: job.id,
              originalError: spawnResult.error,
            },
            "Failed to post agent startup failure status",
          );
        }

        await transitionReaction(jobReaction, REACTION_FAILED, job.id);
        return err(spawnResult.error);
      }

      const reviewProcess = spawnResult.value;
      spawnedProcess = reviewProcess;
      activeJobs.set(job.id, reviewProcess);
      if (jobReaction !== null) {
        const progressResult = await transitionToProgressReaction(jobReaction, job.id);
        if (progressResult.isOk()) {
          jobReaction = progressResult.value;
        }
      }
    } else {
      if (shutdownRequested) {
        await removeAcknowledgmentReaction(jobReaction, job.id);
        return interruptForShutdown(job.id);
      }

      const spawnResult = dependencies.spawnAgent(spawnConfig);
      if (spawnResult.isErr()) {
        const failureCommentResult = await postStatusComment(
          dependencies.gitlab,
          payload,
          `Agent failed: ${formatAppError(spawnResult.error)}`,
        );
        if (failureCommentResult.isErr()) {
          dependencies.logger.warn(
            {
              error: failureCommentResult.error,
              jobId: job.id,
              originalError: spawnResult.error,
            },
            "Failed to post agent startup failure status",
          );
        }

        await transitionReaction(jobReaction, REACTION_FAILED, job.id);
        return err(spawnResult.error);
      }

      activeJobs.set(job.id, spawnResult.value);
      if (jobReaction !== null) {
        const progressResult = await transitionToProgressReaction(jobReaction, job.id);
        if (progressResult.isOk()) {
          jobReaction = progressResult.value;
        }
      }
      spawnedProcess = spawnResult.value;
    }

    const agentResult = await awaitAgentResult(spawnedProcess, agentKind).finally(() => {
      activeJobs.delete(job.id);
    });
    const completedAgentResult = agentResult.andThen((result) =>
      validateAgentExit(result, agentKind),
    );
    if (completedAgentResult.isErr()) {
      if (agentResult.isOk()) {
        dependencies.logger.error(
          {
            jobId: job.id,
            agent: agentKind,
            exitCode: agentResult.value.exitCode,
            stdout: agentResult.value.stdout.slice(0, 2000),
            stderr: agentResult.value.stderr.slice(0, 2000),
            durationMs: agentResult.value.durationMs,
          },
          "Agent process failed",
        );
      }

      if (interruptedJobs.has(job.id)) {
        await removeAcknowledgmentReaction(jobReaction, job.id);
        return err(queueError("Worker shutdown interrupted active job"));
      }

      let surfacedError: AppError = completedAgentResult.error;
      if (agentResult.isOk()) {
        const persistSessionResult = persistSessionUpdate(
          buildPendingSessionUpdate(
            payload,
            reusableSession,
            agentKind,
            context,
            agentResult.value,
          ),
        );
        if (persistSessionResult.isErr()) {
          surfacedError = persistSessionResult.error;
        }
      }

      await removeAcknowledgmentReaction(jobReaction, job.id);
      const failureCommentResult = await postStatusComment(
        dependencies.gitlab,
        payload,
        failureCommentBody(surfacedError),
      );
      if (failureCommentResult.isErr()) {
        dependencies.logger.warn(
          {
            error: failureCommentResult.error,
            jobId: job.id,
            originalError: completedAgentResult.error,
          },
          "Failed to post agent failure status",
        );
      }

      await addTerminalReaction(jobReaction, REACTION_FAILED, job.id);
      return err(surfacedError);
    }

    interruptedJobs.delete(job.id);
    return ok({
      reaction: jobReaction,
      sessionUpdate: buildPendingSessionUpdate(
        payload,
        reusableSession,
        agentKind,
        context,
        completedAgentResult.value,
      ),
    });
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: queue claim and terminal state handling intentionally stay inline with the worker contract.
  async function claimAndRunPendingJob(pendingJob: Job): Promise<Result<Job | null, AppError>> {
    const claimResult = dependencies.queue.claimPending(pendingJob.id);
    if (claimResult.isErr()) {
      return err(claimResult.error);
    }

    const job = claimResult.value;
    if (job === null) {
      return ok(null);
    }

    const processResult = await processJob(job);
    if (processResult.isErr()) {
      if (interruptedJobs.has(job.id)) {
        interruptedJobs.delete(job.id);
        dependencies.logger.info({ jobId: job.id }, "Worker shutdown left job in processing");
        return ok(null);
      }

      return markJobFailed(job, processResult.error);
    }

    const completeResult = dependencies.queue.complete(job.id);
    if (completeResult.isErr()) {
      await removeAcknowledgmentReaction(processResult.value.reaction, job.id);
      const failureCommentResult = await postStatusComment(
        dependencies.gitlab,
        job.payload,
        failureCommentBody(completeResult.error),
      );
      if (failureCommentResult.isErr()) {
        dependencies.logger.warn(
          {
            error: failureCommentResult.error,
            jobId: job.id,
            originalError: completeResult.error,
          },
          "Failed to post terminal queue completion failure status",
        );
      }
      await addTerminalReaction(processResult.value.reaction, REACTION_FAILED, job.id);
      return markJobTerminalFailure(job, completeResult.error);
    }

    const persistSessionResult = persistSessionUpdate(processResult.value.sessionUpdate);
    if (persistSessionResult.isErr()) {
      await removeAcknowledgmentReaction(processResult.value.reaction, job.id);
      const failureCommentResult = await postStatusComment(
        dependencies.gitlab,
        job.payload,
        failureCommentBody(persistSessionResult.error),
      );
      if (failureCommentResult.isErr()) {
        dependencies.logger.warn(
          {
            error: failureCommentResult.error,
            jobId: job.id,
            originalError: persistSessionResult.error,
          },
          "Failed to post terminal session persistence failure status",
        );
      }
      await addTerminalReaction(processResult.value.reaction, REACTION_FAILED, job.id);
      return markJobTerminalFailure(job, persistSessionResult.error);
    }

    await transitionReaction(processResult.value.reaction, REACTION_DONE, job.id);

    dependencies.logger.info({ jobId: job.id }, "Job completed");
    return ok(completeResult.value);
  }

  return {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: agent filtering adds one branch to the existing claim-and-run loop.
    async runNextJob(agentFilter?: AgentKind) {
      if (shutdownRequested) {
        return ok(null);
      }

      const pendingJobsResult = dependencies.queue.listPending();
      if (pendingJobsResult.isErr()) {
        return err(pendingJobsResult.error);
      }

      for (const pendingJob of pendingJobsResult.value) {
        if (
          agentFilter !== undefined &&
          agentKindForPayload(pendingJob.payload, dependencies.defaultAgent) !== agentFilter
        ) {
          continue;
        }

        const runResult = await tryWithCoordinationLock(
          coordinationKeyForPayload(pendingJob.payload),
          async () => claimAndRunPendingJob(pendingJob),
        );

        if (runResult === null) {
          continue;
        }

        if (runResult.isErr()) {
          return runResult;
        }

        if (runResult.value !== null) {
          return ok(runResult.value);
        }
      }

      return ok(null);
    },

    stop() {
      shutdownRequested = true;
      for (const [jobId, process] of activeJobs.entries()) {
        interruptedJobs.add(jobId);
        const killResult = fromThrowable(
          () => process.kill(),
          (cause) =>
            agentError(
              `Failed to terminate agent during worker shutdown: ${formatUnknownError(cause)}`,
              "claude",
              -1,
            ),
        )();
        if (killResult.isErr()) {
          interruptedJobs.delete(jobId);
          dependencies.logger.warn(
            { error: killResult.error, jobId, pid: process.pid },
            "Failed to start agent shutdown during worker stop",
          );
          continue;
        }

        void Promise.resolve(killResult.value).catch((cause: unknown) => {
          interruptedJobs.delete(jobId);
          dependencies.logger.warn(
            {
              error: formatUnknownError(cause),
              jobId,
              pid: process.pid,
            },
            "Agent shutdown promise rejected during worker stop",
          );
        });
      }
    },

    async drain() {
      shutdownRequested = true;
      if (activeJobs.size === 0) {
        return;
      }
      dependencies.logger.info(
        { activeJobs: activeJobs.size },
        "Draining: waiting for active jobs to finish",
      );
      while (activeJobs.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      dependencies.logger.info("Drain complete: all active jobs finished");
    },
  };
}
