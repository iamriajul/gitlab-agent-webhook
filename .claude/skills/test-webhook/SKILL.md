---
name: test-webhook
description: Test webhook payloads locally against the dev server. Use when asked to test a webhook, simulate a GitLab event, or debug webhook processing.
allowed-tools: Read, Bash, Grep
---

# Test Webhook Payloads Locally

## Prerequisites

1. Server must be running: `bun run dev`
2. Set env vars in `.env` (copy from `.env.example`)

## Send a Test Note Hook (Issue Comment)

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
    "object_attributes": {"id": 100, "note": "@review-bot fix this bug", "noteable_type": "Issue", "noteable_id": 42, "action": "create", "url": "https://gitlab.example.com/team/project/issues/42#note_100", "system": false},
    "issue": {"id": 42, "iid": 17, "title": "Bug report", "description": "Crashes on login", "state": "opened"}
  }' | jq .
```

## Send a Test MR Hook

```bash
curl -s -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-Gitlab-Event: Merge Request Hook" \
  -H "X-Gitlab-Token: $GITLAB_WEBHOOK_SECRET" \
  -H "X-Gitlab-Webhook-UUID: test-$(date +%s)" \
  -d '{
    "object_kind": "merge_request",
    "user": {"id": 1, "username": "dev", "name": "Developer"},
    "project": {"id": 5, "path_with_namespace": "team/project", "web_url": "https://gitlab.example.com/team/project", "default_branch": "main"},
    "object_attributes": {"id": 93, "iid": 16, "title": "Add feature", "description": "New feature", "state": "opened", "source_branch": "feat/new", "target_branch": "main", "draft": false, "action": "open", "url": "https://gitlab.example.com/-/merge_requests/16", "last_commit": {"id": "abc123", "message": "commit", "title": "commit", "url": "https://gitlab.example.com/-/commit/abc123"}}
  }' | jq .
```

## Test Auth Rejection

```bash
curl -s -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-Gitlab-Event: Note Hook" \
  -H "X-Gitlab-Token: wrong-token" \
  -d '{}' | jq .
# Expected: {"error":"Unauthorized"} with 401 status
```

## Health Check

```bash
curl -s http://localhost:3000/health | jq .
```
