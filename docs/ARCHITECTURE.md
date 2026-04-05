# Architecture

`gitlab-agent-webhook` is a Bun service that receives GitLab webhooks, validates and routes them, persists queued work in SQLite, and executes that work through autonomous agent CLIs.

## Composition Root

[`src/index.ts`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/src/index.ts) is the runtime composition root.

At startup it:

1. Loads and validates environment configuration.
2. Creates the logger.
3. Opens SQLite and runs Drizzle migrations from [`src/db/migrations/`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/src/db/migrations).
4. Constructs the job queue and session manager.
5. Constructs the upper-layer GitLab service.
6. Constructs the worker with queue, session, GitLab, workspace, and agent-runner dependencies.
7. Creates the Hono app with an enqueue dependency.
8. Starts `WORKER_CONCURRENCY` polling lanes.
9. Starts the HTTP server with `Bun.serve()`.

The runtime also listens for `SIGINT` and `SIGTERM` and stops polling for new jobs. It does not currently implement a full graceful-drain protocol for in-flight agent processes.

## HTTP Layer

[`src/server/routes.ts`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/src/server/routes.ts) exposes:

- `GET /health`
- `POST /webhook`

[`src/server/middleware.ts`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/src/server/middleware.ts) adds:

- request IDs
- delivery IDs
- auth verification against `X-Gitlab-Token`
- request-scoped logging

`POST /webhook` follows this sequence:

1. Read and parse JSON.
2. Parse the payload with Zod schemas in [`src/events/parser.ts`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/src/events/parser.ts).
3. Ignore unsupported or intentionally ignored events.
4. Dedupe using `Idempotency-Key` or `X-Gitlab-Webhook-UUID`.
5. Route the event in [`src/events/router.ts`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/src/events/router.ts).
6. Enqueue a job in SQLite.
7. Return `202 Accepted` with the persisted `jobId`.

An accepted webhook now means a queue row exists. The route does not claim success before persistence.

## Routing

The router produces one of two outcomes:

- `ignore`
- `enqueue`

Currently implemented enqueue paths:

- issue note mentioning the bot -> `handle_mention`
- MR note mentioning the bot -> `handle_mr_mention`
- MR `open` -> `review_mr`
- MR `update` -> `review_mr`

Mention parsing lives in [`src/events/mention.ts`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/src/events/mention.ts). Only the first token after mention stripping can override the default agent.

## Persistence

SQLite is the only persistence layer.

[`src/db/schema.ts`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/src/db/schema.ts) defines:

- `jobs`
- `sessions`

### Jobs

[`src/jobs/queue.ts`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/src/jobs/queue.ts) stores queued work with:

- serialized payload
- status
- idempotency key
- timestamps
- retry/error metadata

Queue idempotency is enforced at the database layer through `idempotencyKey`.

### Sessions

[`src/sessions/manager.ts`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/src/sessions/manager.ts) persists resumable agent sessions for issue and MR conversations. Review jobs track review context separately from conversational MR note sessions.

## Worker Model

[`src/jobs/worker.ts`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/src/jobs/worker.ts) processes one queue item at a time per lane.

For each claimed job it:

1. Resolves the target GitLab reaction/comment surface.
2. Looks up a reusable session when the job kind supports it.
3. Adds an acknowledgment reaction.
4. Prepares a unique workspace directory under `.workspaces/`.
5. Spawns the selected agent through [`src/agents/runner.ts`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/src/agents/runner.ts).
6. Posts start / success / failure status comments through the upper-layer GitLab service.
7. Persists or updates the agent session when applicable.
8. Transitions the GitLab reaction from `eyes` to `white_check_mark` or `warning`.

The worker includes coordination locks so the same conversational context or MR review target is not processed concurrently by multiple lanes.

## GitLab Boundary

[`src/gitlab/service.ts`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/src/gitlab/service.ts) is intentionally narrow. It only handles:

- emoji reactions
- status comments

Everything content-aware stays in the spawned agent:

- diff inspection
- pipeline inspection
- discussion reconstruction
- review comments
- pushing changes

This keeps the service deterministic and avoids building duplicate GitLab automation logic above the agents.

## Agent Execution

[`src/agents/runner.ts`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/src/agents/runner.ts) dispatches to per-agent adapters:

- [`src/agents/claude.ts`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/src/agents/claude.ts)
- [`src/agents/codex.ts`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/src/agents/codex.ts)
- [`src/agents/gemini.ts`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/src/agents/gemini.ts)

The worker supplies:

- the workspace path
- the user prompt
- a system prompt describing the non-interactive GitLab workflow
- relevant environment variables such as `GITLAB_HOST`, `GITLAB_TOKEN`, and agent CLI paths

Claude and Codex support resumable sessions. Gemini does not, so follow-up prompts are reconstructed as fresh runs.

## Current Integration Coverage

Integration coverage now includes a webhook-to-queue path:

- [`tests/integration/webhook-queue.test.ts`](/var/tmp/vibe-kanban/worktrees/0a09-open-sourcing/glab-review-webhook/tests/integration/webhook-queue.test.ts)

That test sends a real webhook request through the Hono app, verifies `202 Accepted`, verifies a concrete `jobId`, and checks the persisted queue payload in a migrated SQLite database.
