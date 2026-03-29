# glab-review-webhook

GitLab webhook service for handing issue mentions and merge request reviews off to autonomous AI CLIs.

## What It Does

- Accepts GitLab `Note Hook` events on issues and merge requests.
- Accepts GitLab `Merge Request Hook` events for MR `open` and `update`.
- Verifies the webhook secret, parses the payload with Zod, routes supported events, and enqueues a SQLite-backed job.
- Starts worker lanes on boot. Workers acknowledge work with GitLab reactions/comments, spawn the selected agent CLI, and persist resumable sessions.

The service itself only performs service-level GitLab actions through `@gitbeaker/rest`:

- emoji reactions
- status comments

Spawned agents are responsible for content-level GitLab work through `glab`:

- reading diffs
- reading discussion context
- posting review output
- pushing feature-branch changes

## Supported Event Flows

### Issue or MR mentions

When a note mentions `@BOT_USERNAME`, the router:

1. Strips the mention and optional leading agent selector.
2. Builds a queued job.
3. Returns `202 Accepted` with the queued `jobId`.

Examples:

- `@review-bot fix this`
- `@review-bot codex fix this`
- `@review-bot gemini review this MR`

Agent selection only applies when it is the first token after mention stripping. Otherwise the configured default agent is used.

### Merge request review hooks

`Merge Request Hook` payloads with action `open` or `update` enqueue MR review jobs keyed by project, MR IID, and commit SHA.

## Runtime Behavior

- Startup creates the logger, opens SQLite, runs Drizzle migrations, constructs queue/session services, creates the GitLab service, and boots worker lanes.
- Webhook delivery dedupe uses `Idempotency-Key` when present, otherwise `X-Gitlab-Webhook-UUID`.
- `GET /health` returns `{ "status": "ok", "requestId": "..." }`.
- `POST /webhook` returns:
  - `202` with `status: "accepted"` and a concrete `jobId` when work is queued
  - `202` with `status: "ignored"` for supported-but-ignored events
  - `202` with `status: "duplicate"` for duplicate deliveries
  - `400` for invalid JSON or invalid payloads
  - `401` for invalid webhook secrets

On `SIGINT` and `SIGTERM`, the process stops polling for new work. It does not currently wait for already-running agent processes to drain before exit.

## Requirements

- Bun
- Agent CLIs installed locally as needed: `claude`, `codex`, `gemini`
- `glab` available to spawned agents

## Configuration

Required:

- `GITLAB_WEBHOOK_SECRET`
- `BOT_USERNAME`
- `GITLAB_TOKEN`
- `GITLAB_HOST`

Optional:

- `DEFAULT_AGENT`
- `PORT`
- `DATABASE_PATH`
- `LOG_LEVEL`
- `WORKER_CONCURRENCY`
- `AGENT_TIMEOUT_MS`
- `CLAUDE_PATH`
- `CODEX_PATH`
- `GEMINI_PATH`

See [`.env.example`](/var/tmp/vibe-kanban/worktrees/1df9-task-06-integrat/glab-review-webhook/.env.example) if present in your checkout and [`src/config/config.ts`](/var/tmp/vibe-kanban/worktrees/1df9-task-06-integrat/glab-review-webhook/src/config/config.ts).

## Development

Install dependencies, then:

```bash
bun run dev
```

Useful commands:

- `bun test`
- `bun run check`
- `bun run format`
- `bun run build`

## Testing Webhooks Locally

Issue note example:

```bash
curl -s -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-Gitlab-Event: Note Hook" \
  -H "X-Gitlab-Token: $GITLAB_WEBHOOK_SECRET" \
  -H "X-Gitlab-Webhook-UUID: test-$(date +%s)" \
  -H "Idempotency-Key: test-idempotency-$(date +%s)" \
  -d '{
    "object_kind": "note",
    "user": {"id": 1, "username": "dev", "name": "Developer"},
    "project": {"id": 5, "path_with_namespace": "team/project", "web_url": "https://gitlab.example.com/team/project", "default_branch": "main"},
    "object_attributes": {"id": 100, "note": "@review-bot codex fix this bug", "noteable_type": "Issue", "noteable_id": 42, "action": "create", "url": "https://gitlab.example.com/team/project/issues/42#note_100", "system": false},
    "issue": {"id": 42, "iid": 17, "title": "Bug report", "description": "Crashes on login", "state": "opened"}
  }'
```

Health check:

```bash
curl -s http://localhost:3000/health
```
