import type { Logger } from "../config/logger.ts";
import { REACTION_DONE, REACTION_FAILED, REACTION_SEEN } from "../config/constants.ts";
import type { ReactionTarget } from "../gitlab/service.ts";
import type { AgentSession, SessionContext, SessionManager } from "../sessions/manager.ts";
import { agentError } from "../types/errors.ts";
import type { AppError } from "../types/errors.ts";
import type { AgentKind, EmojiName } from "../types/events.ts";
import { err, fromPromise, ok, type Result, type ResultAsync } from "../types/result.ts";
import type { AgentConfig, AgentProcess, AgentResult, AgentType } from "../agents/types.ts";
import type { Job, JobPayload } from "./types.ts";
import type { JobQueue } from "./queue.ts";

export interface WorkerGitLabClient {
  addReaction(target: ReactionTarget, emoji: EmojiName): ResultAsync<number, AppError>;
  clearReaction(target: ReactionTarget, emoji: EmojiName): ResultAsync<void, AppError>;
  removeReaction(target: ReactionTarget, emoji: EmojiName, awardId: number): ResultAsync<void, AppError>;
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
  readonly prepareWorkspace: (payload: JobPayload, baseWorkDir: string) => Result<string, AppError>;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly spawnAgent: (config: AgentConfig) => Result<AgentProcess, AppError>;
}

export interface Worker {
  runNextJob(): Promise<Result<Job | null, AppError>>;
}

interface JobReactionState {
  readonly target: ReactionTarget;
  readonly awardId: number;
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
  readonly reaction: JobReactionState;
  readonly sessionUpdate: PendingSessionUpdate;
}

type CoordinationKey = string | null;

function mapAgentType(agentKind: AgentKind): AgentType {
  switch (agentKind) {
    case "claude":
      return { kind: "claude" };
    case "codex":
      return { kind: "codex" };
    case "gemini":
      return { kind: "gemini" };
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

function reactionTargetForPayload(payload: JobPayload): ReactionTarget {
  switch (payload.kind) {
    case "handle_mention":
      return {
        kind: "issue_note",
        project: payload.project,
        issueIid: payload.issueIid,
        noteId: payload.noteId,
      };
    case "handle_mr_mention":
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

function coordinationKeyForPayload(payload: JobPayload, agentKind: AgentKind): CoordinationKey {
  switch (payload.kind) {
    case "handle_mention":
      return `session:issue:${payload.project}:${payload.issueIid}:${agentKind}`;
    case "handle_mr_mention":
      return `session:mr:${payload.project}:${payload.mrIid}:${agentKind}`;
    case "review_mr":
      return `review:${payload.project}:${payload.mrIid}`;
  }
}

const DEFAULT_AGENT_ENV_KEYS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GITLAB_HOST",
  "GITLAB_TOKEN",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "HOME",
  "OPENAI_API_KEY",
  "PATH",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
];

function defaultAgentEnv(): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};

  for (const key of DEFAULT_AGENT_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  return env;
}

function buildAgentEnv(
  envOverride?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const env = defaultAgentEnv();
  if (envOverride === undefined) {
    return env;
  }

  return {
    ...env,
    ...envOverride,
  };
}

function buildSystemPrompt(payload: JobPayload): string {
  switch (payload.kind) {
    case "handle_mention":
      return [
        "You are an autonomous AI coding agent running in non-interactive mode.",
        "There is no user at the terminal. Do not wait for input.",
        `Project: ${payload.project}`,
        `Issue: #${payload.issueIid}`,
        "Create feature branches for code changes.",
        "Never push to protected branches.",
        "Use glab CLI for all GitLab interaction and post results back to GitLab.",
      ].join("\n");
    case "handle_mr_mention":
      return [
        "You are an autonomous AI coding agent running in non-interactive mode.",
        "There is no user at the terminal. Do not wait for input.",
        `Project: ${payload.project}`,
        `Merge request: !${payload.mrIid}`,
        "Create feature branches for code changes.",
        "Never push to protected branches.",
        "Use glab CLI for all GitLab interaction and post results back to GitLab.",
      ].join("\n");
    case "review_mr":
      return [
        "You are an autonomous AI coding agent running in non-interactive mode.",
        "There is no user at the terminal. Do not wait for input.",
        `Project: ${payload.project}`,
        `Merge request: !${payload.mrIid}`,
        "Create feature branches for code changes.",
        "Never push to protected branches.",
        "Use glab CLI for all GitLab interaction and post results back to GitLab.",
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

function startCommentBody(agentKind: AgentKind, resumed: boolean): string {
  return resumed ? `Agent resumed with ${agentKind}.` : `Agent started with ${agentKind}.`;
}

function successCommentBody(): string {
  return "Agent finished successfully.";
}

function failureCommentBody(error: AppError): string {
  return `Agent failed: ${formatAppError(error)}`;
}

function runAsyncResult<T>(result: ResultAsync<T, AppError>): Promise<Result<T, AppError>> {
  return result.match(
    (value) => ok(value),
    (error) => err(error),
  );
}

async function awaitAgentResult(
  process: AgentProcess,
  agentKind: AgentKind,
): Promise<Result<AgentResult, AppError>> {
  const awaitedResult = await fromPromise(
    process.result,
    () => agentError("Agent process promise rejected", agentKind, -1),
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

function validateAgentExit(result: AgentResult, agentKind: AgentKind): Result<AgentResult, AppError> {
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
    const reactionResult = await runAsyncResult(dependencies.gitlab.addReaction(target, REACTION_SEEN));
    if (reactionResult.isOk()) {
      return ok({
        target,
        awardId: reactionResult.value,
      });
    }

    switch (payload.kind) {
      case "review_mr": {
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
              originalError: reactionResult.error,
            },
            "Failed to clear stale acknowledgment reaction before retry",
          );
          return err(reactionResult.error);
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
        });
      }
      case "handle_mention":
        return err(reactionResult.error);
      case "handle_mr_mention":
        return err(reactionResult.error);
    }
  }

  async function transitionReaction(
    reaction: JobReactionState,
    emoji: EmojiName,
    jobId: Job["id"],
  ): Promise<void> {
    const removeResult = await runAsyncResult(
      dependencies.gitlab.removeReaction(reaction.target, REACTION_SEEN, reaction.awardId),
    );
    if (removeResult.isErr()) {
      dependencies.logger.warn(
        {
          error: removeResult.error,
          jobId,
          reaction: REACTION_SEEN,
          target: reaction.target,
        },
        "Failed to remove acknowledgment reaction",
      );
    }

    if (reaction.target.kind === "mr") {
      for (const terminalEmoji of [REACTION_DONE, REACTION_FAILED]) {
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
      canResumeExistingSession && reusableSession !== null
        ? reusableSession.agentSessionId
        : null;

    const reactionResult = await addAcknowledgmentReaction(payload, reactionTarget, job.id);
    if (reactionResult.isErr()) {
      return err(reactionResult.error);
    }
    const jobReaction = reactionResult.value;

    const prepareWorkspaceResult = dependencies.prepareWorkspace(payload, dependencies.workDir);
    if (prepareWorkspaceResult.isErr()) {
      await transitionReaction(jobReaction, REACTION_FAILED, job.id);
      return err(prepareWorkspaceResult.error);
    }

    const spawnConfigBase = {
      agent: mapAgentType(agentKind),
      workDir: prepareWorkspaceResult.value,
      prompt: buildUserPrompt(payload, agentKind, reusableSession),
      systemPrompt: buildSystemPrompt(payload),
      env: buildAgentEnv(dependencies.env),
      timeoutMs: dependencies.timeoutMs,
    };
    const spawnResult = dependencies.spawnAgent(
      resumeSessionId !== null
        ? { ...spawnConfigBase, sessionId: resumeSessionId }
        : spawnConfigBase,
    );
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

    const startedCommentResult = await postStatusComment(
      dependencies.gitlab,
      payload,
      startCommentBody(agentKind, resumeSessionId !== null),
    );
    if (startedCommentResult.isErr()) {
      const killResult = await fromPromise(
        Promise.resolve().then(() => spawnResult.value.kill()),
        () => agentError("Failed to terminate agent after startup status failure", agentKind, -1),
      ).match(
        () => ok(undefined),
        (error) => err(error),
      );
      if (killResult.isErr()) {
        dependencies.logger.warn(
          {
            error: killResult.error,
            jobId: job.id,
            pid: spawnResult.value.pid,
            originalError: startedCommentResult.error,
          },
          "Failed to wait for spawned agent shutdown after startup status failure",
        );
      }

      const exitResult = await awaitAgentResult(spawnResult.value, agentKind);
      if (exitResult.isErr()) {
        dependencies.logger.warn(
          {
            error: exitResult.error,
            jobId: job.id,
            pid: spawnResult.value.pid,
            originalError: startedCommentResult.error,
          },
          "Failed while waiting for spawned agent to exit after startup status failure",
        );
      }

      await transitionReaction(jobReaction, REACTION_FAILED, job.id);
      return err(startedCommentResult.error);
    }

    const agentResult = await awaitAgentResult(spawnResult.value, agentKind);
    const completedAgentResult = agentResult.andThen((result) => validateAgentExit(result, agentKind));
    if (completedAgentResult.isErr()) {
      let surfacedError: AppError = completedAgentResult.error;
      if (agentResult.isOk()) {
        const persistSessionResult = persistSessionUpdate(
          buildPendingSessionUpdate(payload, reusableSession, agentKind, context, agentResult.value),
        );
        if (persistSessionResult.isErr()) {
          surfacedError = persistSessionResult.error;
        }
      }

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

      await transitionReaction(jobReaction, REACTION_FAILED, job.id);
      return err(surfacedError);
    }

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

  return {
    async runNextJob() {
      const pendingJobsResult = dependencies.queue.listPending();
      if (pendingJobsResult.isErr()) {
        return err(pendingJobsResult.error);
      }

      for (const pendingJob of pendingJobsResult.value) {
        const agentKind = agentKindForPayload(pendingJob.payload, dependencies.defaultAgent);
        const runResult = await tryWithCoordinationLock(
          coordinationKeyForPayload(pendingJob.payload, agentKind),
          async () => {
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
              return markJobFailed(job, processResult.error);
            }

            const completeResult = dependencies.queue.complete(job.id);
            if (completeResult.isErr()) {
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

              await transitionReaction(processResult.value.reaction, REACTION_FAILED, job.id);
              return markJobTerminalFailure(job, completeResult.error);
            }

            const persistSessionResult = persistSessionUpdate(processResult.value.sessionUpdate);
            if (persistSessionResult.isErr()) {
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

              await transitionReaction(processResult.value.reaction, REACTION_FAILED, job.id);
              return markJobTerminalFailure(job, persistSessionResult.error);
            }

            await transitionReaction(processResult.value.reaction, REACTION_DONE, job.id);

            const successCommentResult = await postStatusComment(
              dependencies.gitlab,
              job.payload,
              successCommentBody(),
            );
            if (successCommentResult.isErr()) {
              dependencies.logger.warn(
                {
                  error: successCommentResult.error,
                  jobId: job.id,
                },
                "Final status comment failed after successful job",
              );
            }

            dependencies.logger.info({ jobId: job.id }, "Job completed");
            return ok(completeResult.value);
          },
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
  };
}
