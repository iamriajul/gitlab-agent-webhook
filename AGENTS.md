# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository.

> **Sync Rule:** AGENTS.md and CLAUDE.md must always have identical content. If you edit either file, immediately copy it to the other. Run: `cp AGENTS.md CLAUDE.md` or `cp CLAUDE.md AGENTS.md` as appropriate.

## Project Overview

**Glab Review Webhook** is a web service that handles GitLab webhooks for issues, comment mentions, and Merge Requests (MRs). It serves as an alternative to GitHub's Gemini Code Assist, but for GitLab.

- Origin: `https://gitlab.com/opensource/glab-review-webhook.git`
- Default branch: `main`

## Architecture

### Core Flow

1. **Webhook Listener** — Receives events from GitLab (MR created/updated, issue comments, mention events).
2. **Event Processor** — Parses and routes webhook payloads to the appropriate handler.
3. **Review Engine** — Triggers autonomous code reviews when an MR is created or a review scan is requested.
4. **GitLab Interaction** — Uses the `glab` CLI to post comments, submit reviews, and reply to existing threads.

### AI Review Backends

The service does **not** use direct AI APIs. Instead, it shells out to locally installed CLIs:
- **Claude Code CLI** (`claude`)
- **Codex CLI** (`codex`)
- **Gemini CLI** (`gemini`)

### Key Capabilities

- Automated MR code reviews triggered by webhook events
- Comment and status updates on GitLab via `glab` CLI
- Issue mention handling — developers can trigger MR creation from issue comments
