# gitlab-agent-webhook

`gitlab-agent-webhook` turns GitLab webhooks into autonomous agent work.

Open a merge request and it can review. Mention `@agent` on an issue or MR note and it can pick up the task, resume context, and reply through GitLab. The service stays small on purpose: webhook in, job queued, agent spawned, results posted back.

## Why It Exists

GitLab teams should not need a custom UI or direct LLM API integration just to run coding agents against issues and merge requests. This project keeps the control plane simple:

- GitLab sends webhooks.
- This service validates, routes, and persists jobs.
- Agents run through local CLIs like `claude`, `codex`, and `gemini`.
- Agents use `glab` for GitLab-native interaction.

That means you can self-host the automation layer, choose your preferred agent backend, and keep the actual GitLab actions in the same place developers already work.

## What It Does

- Auto-reviews merge requests on open and update events
- Responds to issue and MR mentions like `@agent fix this flaky test`
- Supports agent selection from the mention prefix: `@agent codex ...`
- Tracks resumable agent sessions in SQLite
- Uses a queue + worker model so webhook responses stay fast
- Posts acknowledgements and status updates back to GitLab

## Supported Agent Backends

- `claude`
- `codex`
- `gemini`

Each backend is executed through its local CLI. The service does not call model APIs directly.

## Architecture

The flow is intentionally narrow:

1. GitLab sends a webhook to `POST /webhook`.
2. The payload is validated and routed into a job.
3. A worker claims the job and spawns the selected agent CLI.
4. The agent uses `glab` to comment, react, inspect context, and push changes if asked.
5. Session state is stored so follow-up mentions can resume the same thread of work.

## Mention Examples

- `@agent fix the broken test`
- `@agent codex please investigate this regression`
- `@agent gemini summarize the failing pipeline and propose a fix`

Only a leading selector token changes the agent. Mid-sentence names stay part of the prompt.

## Stack

- Bun
- TypeScript
- Hono
- Drizzle ORM
- SQLite
- `glab`

## Quick Start

1. Copy the environment template and set `BOT_USERNAME=agent`.
2. Install the required CLIs you want to use: `claude`, `codex`, and/or `gemini`.
3. Install dependencies.
4. Run migrations.
5. Start the server and point a GitLab webhook at `/webhook`.

```bash
bun install
bun run db:migrate
bun run dev
```

## Configuration

Required environment variables:

- `GITLAB_WEBHOOK_SECRET`
- `BOT_USERNAME`
- `GITLAB_TOKEN`
- `GITLAB_HOST`

Optional environment variables include `DEFAULT_AGENT`, `DATABASE_PATH`, `WORKER_CONCURRENCY`, `AGENT_TIMEOUT_MS`, and agent CLI path overrides.

See `.env.example`.

## Development

The project follows strict TDD and a single verification gate:

```bash
bun test
bun run check
```

`bun run check` runs typecheck, lint, and test. No alternative verification path exists in this repo.

## TODO

- OpenCode support
- Publish an npm package for `npx` / `bunx` usage
- Publish a Docker image
