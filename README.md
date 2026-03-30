# glab-review-webhook

GitLab webhook service that spawns autonomous AI coding agents (Claude, Codex, Gemini) for code reviews, issue resolution, and MR feedback.

## How It Works

1. GitLab sends webhook events to this service.
2. The service validates, parses, and routes events into a SQLite-backed job queue.
3. Worker lanes pick up jobs, clone the repo, checkout the right branch, and spawn an AI agent CLI.
4. The agent works autonomously — reading issues/MRs, writing code, pushing branches, creating MRs, and posting comments via `glab` CLI.

## Triggers

Enable these three webhooks in your GitLab project settings:

- **Comments** — `@agent` mentions in issue/MR comments
- **Issue events** — assignment to `@agent`, issue close (cleanup)
- **Merge request events** — MR open/update (auto-review), reviewer/assignee set to `@agent`, MR close/merge (cleanup)

## Event Flows

### Mention in a comment

When a comment mentions `@agent` (configurable via `BOT_USERNAME`):

```
@agent fix this bug
@agent codex refactor the auth module
@agent gemini review this MR
```

The first token after the mention can optionally select an agent (`claude`, `codex`, `gemini`). Otherwise the configured `DEFAULT_AGENT` is used.

### Issue assigned to @agent

The agent reads the issue, decides whether to implement directly or post a plan first, then creates an MR.

### MR opened or updated

Automatically triggers a code review by the default agent.

### @agent added as MR reviewer or assignee

Triggers a code review (with a unique idempotency key so it's not deduplicated against the auto-review).

### Issue or MR closed/merged

Workspace directory is deleted and sessions are marked completed. Further `@agent` mentions on closed items receive a blocked reaction.

## Workspace Management

Each issue/MR gets a stable workspace directory:

```
.workspaces/{project}/issue-{iid}/    # issues
.workspaces/{project}/mr-{iid}/       # merge requests
```

On first use, the repo is cloned via `glab repo clone` and the appropriate branch is checked out:
- **Issues:** `agent/issue-{iid}` (new branch from default)
- **MRs:** the MR source branch

Subsequent comments reuse the same clone. `--resume` works because the directory persists.

## Reactions

The service communicates status via emoji reactions on the triggering comment:

| Emoji | Meaning |
|-------|---------|
| Eyes | Job acknowledged, agent starting |
| Check mark | Agent finished successfully |
| X | Agent failed (failure comment also posted) |
| No entry | Mention blocked (issue/MR is closed) |

## Quick Start

```bash
cp .env.example .env
# Edit .env with your GitLab token, webhook secret, host, etc.

make start    # install deps, build, start with PM2
make logs     # tail logs
```

### Make Commands

| Command | What it does |
|---------|-------------|
| `make start` | Install + build + start with PM2 |
| `make stop` | Stop the process |
| `make restart` | Build + restart |
| `make deploy` | Build + restart (or start) + save PM2 state |
| `make logs` | Tail all logs |
| `make logs-err` | Tail stderr only |
| `make status` | Show PM2 process status |
| `make build` | Just build |
| `make clean` | Remove dist |

## Configuration

Required environment variables:

| Variable | Description |
|----------|-------------|
| `GITLAB_WEBHOOK_SECRET` | Secret token configured in GitLab webhook settings |
| `BOT_USERNAME` | GitLab username to listen for mentions (e.g., `agent`) |
| `GITLAB_TOKEN` | GitLab personal access token for API calls |
| `GITLAB_HOST` | GitLab instance URL (e.g., `https://gitlab.example.com`) |

Optional:

| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_AGENT` | `claude` | Agent CLI to use (`claude`, `codex`, `gemini`) |
| `PORT` | `3000` | HTTP server port |
| `DATABASE_PATH` | `./data/glab-review.db` | SQLite database path |
| `LOG_LEVEL` | `info` | Log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) |
| `WORKER_CONCURRENCY` | `2` | Number of parallel worker lanes |
| `AGENT_TIMEOUT_MS` | `600000` | Agent process timeout (10 minutes) |
| `CLAUDE_PATH` | `claude` | Path to Claude CLI binary |
| `CODEX_PATH` | `codex` | Path to Codex CLI binary |
| `GEMINI_PATH` | `gemini` | Path to Gemini CLI binary |

See `.env.example` for a template.

## Development

```bash
bun install
bun run dev       # start dev server
bun test          # run tests
bun run check     # typecheck + lint + test
bun run format    # auto-format with Biome
```

## Architecture

```
src/
  index.ts              Entry point (Bun.serve + workspace management)
  server/               HTTP layer: routes, middleware (auth, request-id)
  events/               Webhook parsing (Zod), routing, mention detection
  agents/               CLI spawning: runner, adapters (claude, codex, gemini)
  jobs/                 SQLite-backed queue + worker orchestration
  gitlab/               Service-level GitLab ops (reactions, comments via @gitbeaker/rest)
  sessions/             Agent session tracking for --resume support
  db/                   Drizzle ORM: schema, migrations
  config/               Zod-validated env config, constants, logger (pino)
  types/                Result types (neverthrow), errors, branded IDs
```

The service has two GitLab interaction layers:
- **Upper layer (this service):** Uses `@gitbeaker/rest` for reactions and status comments only.
- **Lower layer (spawned agents):** Uses `glab` CLI autonomously for all content work — reading diffs, posting reviews, pushing code, creating MRs.

## Requirements

- [Bun](https://bun.sh)
- Agent CLIs as needed: `claude`, `codex`, `gemini`
- [`glab`](https://gitlab.com/gitlab-org/cli) CLI configured with access to your GitLab instance
- SSH access for git clone (configured via `glab` git protocol settings)
