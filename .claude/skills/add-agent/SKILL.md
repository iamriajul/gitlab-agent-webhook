---
name: add-agent
description: Guide for adding a new AI agent backend (beyond claude/codex/gemini). Use when asked to add support for a new AI CLI tool or agent backend.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

# Add a New AI Agent Backend

Follow these steps exactly. Run `bun run check` after each step.

## Step 1: Write Failing Tests

Create `tests/agents/<name>.test.ts` with:
- Test that the agent adapter builds correct CLI arguments
- Test that session ID is parsed from stdout
- Test timeout behavior

## Step 2: Create Agent Adapter

Create `src/agents/<name>.ts`:
```typescript
import type { AgentConfig } from "./types.ts";

export function buildArgs(config: AgentConfig): readonly string[] {
  // Return CLI arguments specific to this agent
}

export function parseSessionId(stdout: string): string | null {
  // Extract session ID from agent's output (for --resume support)
}
```

## Step 3: Update Type Definitions

In `src/types/events.ts`, add to `AgentKind`:
```typescript
export type AgentKind = "claude" | "codex" | "gemini" | "newagent";
```

In `src/agents/types.ts`, add to `AgentType`:
```typescript
export type AgentType = ... | { readonly kind: "newagent" };
```

## Step 4: Update Runner

In `src/agents/runner.ts`, add dispatch logic for the new agent kind.

## Step 5: Update Config

In `src/config/config.ts`, add `<name>Path` to `ConfigSchema`.
In `.env.example`, add `<NAME>_PATH=<name>`.

## Step 6: Update Mention Parser

In `src/events/mention.ts`, add to `AGENT_KEYWORDS` map:
```typescript
["newagent", "newagent"],
```

## Step 7: Verify

Run `bun run check`. All typecheck, lint, and tests must pass.
