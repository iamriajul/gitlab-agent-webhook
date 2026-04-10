# Deployment Guide

This guide covers:

- Tooling prerequisites
- Environment configuration
- Build and process management
- GitLab webhook setup (manual and scripted)
- Post-deploy verification

## 1. Prerequisites

Install these tools on the host:

- `bun` (runtime + package manager)
- `git`
- `pm2` (process manager; installed from project dependencies)
- `glab` (GitLab CLI, authenticated)

Agent CLIs you plan to run:

- `claude`
- `codex`
- `gemini`

Authenticate `glab` before running webhook automation:

```bash
glab auth login
```

## 2. Environment Setup

Create `.env` from `.env.example` and fill all required values:

```bash
cp .env.example .env
```

Required keys:

- `GITLAB_WEBHOOK_SECRET`
- `BOT_USERNAME`
- `GITLAB_TOKEN`
- `GITLAB_HOST`

Recommended for production:

- `DATABASE_PATH=./data/gitlab-agent-webhook.db`
- `LOG_LEVEL=info` (or `warn` in noisier environments)
- Concurrency keys: `CLAUDE_CONCURRENCY`, `CODEX_CONCURRENCY`, `GEMINI_CONCURRENCY`

## 3. Build and Start

Use the existing Make targets:

```bash
make start
```

This performs:

1. `bun install`
2. Build (`bun run build`)
3. Start app via PM2 using `ecosystem.config.cjs`

Useful operations:

```bash
make status
make logs
make restart
make deploy
```

## 4. Webhook Setup

Set your webhook endpoint to:

```text
https://<your-public-host>/webhook
```

The service expects:

- Header: `X-Gitlab-Token` (must match `GITLAB_WEBHOOK_SECRET`)
- JSON payloads from GitLab webhook events

### Option A: Manual (GitLab UI)

Project settings -> Webhooks:

- URL: `https://<your-public-host>/webhook`
- Secret token: value of `GITLAB_WEBHOOK_SECRET`
- Enable events:
  - Issue events
  - Merge request events
  - Comments

### Option B: Scripted (`scripts/setup-webhooks.ts`)

The repo includes a webhook automation script:

```bash
bun scripts/setup-webhooks.ts https://<your-public-host>/webhook
```

Prerequisite: `glab` CLI must be installed and authenticated.

Examples:

```bash
# dry-run across accessible projects
bun scripts/setup-webhooks.ts https://<your-public-host>/webhook --dry-run

# configure one project only (repo URL)
bun scripts/setup-webhooks.ts https://<your-public-host>/webhook https://gitlab.com/group/project

# configure one project only (path)
bun scripts/setup-webhooks.ts https://<your-public-host>/webhook group/project

# remove managed hooks
bun scripts/setup-webhooks.ts --remove group/project
```

Script behavior:

- Hook name: `gitlab-agent-webhook`
- Uses `GITLAB_HOST`, `GITLAB_TOKEN`, `GITLAB_WEBHOOK_SECRET`
- Creates/updates/removes project hooks via GitLab API

## 5. Verification Checklist

After deployment:

1. Health endpoint returns OK:

```bash
curl -sS http://127.0.0.1:3000/health
```

2. PM2 app is running:

```bash
make status
```

3. Webhook delivery in GitLab shows `2xx` responses.
4. Mention test works:
   - Comment on issue or MR with `@agent <prompt>`
   - Confirm job acknowledgment and follow-up status comment/reaction

## 6. Troubleshooting

- `Unauthorized` on webhook:
  - Check `GITLAB_WEBHOOK_SECRET` and webhook token in GitLab.
- Webhook accepted but no agent output:
  - Check logs (`make logs`) and verify agent CLI binaries are installed and in PATH.
- Hook script failures:
  - Confirm `GITLAB_TOKEN` has sufficient permissions and `GITLAB_HOST` is correct.
- PM2 starts but process exits:
  - Rebuild (`make build`) and inspect `logs/error.log`.
