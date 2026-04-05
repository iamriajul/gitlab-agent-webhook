# CLAUDE.md

> **File constraint:** This file must stay under 200 lines (~150 target). Keep rules explicit and concise.

> **Sync rule:** CLAUDE.md and AGENTS.md must always be identical: `cp CLAUDE.md AGENTS.md`. Skills are shared: `rsync -a --delete .claude/skills/ .agents/skills/`. Agents are NOT shared — Claude uses `.claude/agents/*.md` (markdown), Codex uses `.codex/agents/*.toml` (TOML). When adding/modifying an agent, translate to the other format manually. Use the `agent-sync` skill for format reference, or invoke the `agent-sync` agent to auto-detect and fix drift. Pre-commit hooks verify guidance and skill sync.

## Project

**gitlab-agent-webhook** — GitLab webhook service that spawns AI coding agents (Claude, Codex, Gemini) for automated code reviews and issue resolution. Built with Bun + TypeScript + Hono + Drizzle/SQLite.

- Origin: `git@github.com:iamriajul/gitlab-agent-webhook.git`
- Default branch: `main`

## Development Flow

Every feature, fix, or change follows this exact sequence. Do not skip steps.

```
1. BRANCH        git checkout -b feat/<name> main
                       |
2. TEST (red)     Write failing test in tests/<module>/<name>.test.ts
                  Run: bun test → confirm it FAILS
                       |
3. IMPLEMENT      Write minimum code to make the test pass
                  Run: bun test → confirm it PASSES
                       |
4. VERIFY         Run: bun run check (typecheck + lint + test)
                  ALL must pass. If not, fix and re-run.
                       |
5. FORMAT         Run: bun run format
                       |
6. COMMIT         git add <files> && git commit
                  (pre-commit hook runs check automatically)
                       |
7. REPEAT         Go to step 2 for the next piece of work
                       |
8. PUSH           git push -u origin feat/<name>
                  (pre-push hook runs full check)
```

- Steps 2-3 are TDD: red → green → refactor. Never write code without a failing test first.
- Step 4 is the gate. Code that fails `bun run check` does not get committed.
- Step 6 triggers pre-commit hooks (typecheck + lint + test). If hooks fail, fix and re-commit.

## Commands

| Action | Command |
|--------|---------|
| Verify all code | `bun run check` — runs typecheck, lint, test. **Use before every commit.** |
| Type check | `bun run typecheck` |
| Lint | `bun run lint` |
| Format | `bun run format` |
| Test | `bun test` |
| Dev server | `bun run dev` |
| DB migrations | `bun run db:generate` then `bun run db:migrate` |
| Build | `bun run build` |

There is exactly ONE way to verify code: `bun run check`. No alternatives exist.

## Architecture

```
src/
  index.ts              Entry point (Bun.serve with Hono)
  server/               HTTP layer: routes.ts, middleware.ts (auth, request-id)
  events/               Webhook parsing: parser.ts (Zod), router.ts (discriminated union), mention.ts
  agents/               CLI spawning: runner.ts, types.ts (AgentType union)
  jobs/                 SQLite-backed queue: queue.ts, worker.ts, types.ts
  gitlab/               Service-level only: reactions + status comments (via @gitbeaker/rest)
  sessions/             Agent session tracking for resume: manager.ts
  db/                   Drizzle ORM: schema.ts, database.ts, migrations/
  config/               config.ts (Zod-validated env), constants.ts, logger.ts (pino)
  types/                result.ts (neverthrow re-export), errors.ts, events.ts, branded.ts
tests/                  Mirrors src/ structure
```

## Type System Rules

1. **No `any`.** Use `unknown` + Zod validation or type guards to narrow.
2. **No `as` type assertions** except in parser.ts for validated Zod output narrowing.
3. **No non-null assertions (`!`).** Use proper narrowing or Result types.
4. **No `throw`.** Every fallible operation returns `Result<T, AppError>` from neverthrow.
5. **Exhaustive switches.** All discriminated unions (`WebhookEvent`, `AppError`, `AgentType`, `JobPayload`) must be handled without a `default` case so TypeScript catches missing variants at compile time.
6. **Branded types.** Use `ProjectPath`, `IssueIid`, `MRIid`, `NoteId`, `JobId`, `SessionId` from `src/types/branded.ts` to prevent mixing up IDs.
7. **`process.env` access.** Always use bracket notation: `process.env["KEY"]` (required by `noPropertyAccessFromIndexSignature`).

## Error Handling

- Import `ok`, `err`, `Result` from `src/types/result.ts` (the ONE re-export point for neverthrow).
- Error types are in `src/types/errors.ts`. Use factory functions: `parseError()`, `authError()`, `gitlabError()`, `agentError()`, `queueError()`, `sessionError()`, `configError()`.
- Never catch and swallow errors. Always propagate via `Result` or log with context.
- **Every `Result` must be consumed.** Use `.match()`, `.andThen()`, `.unwrapOr()`, or return it. Never discard a Result in a void expression — the error path must always be handled or propagated.

## Code Style

- **Formatter:** Biome. 2-space indent, 100-char line width. Run `bun run format` to auto-fix.
- **Imports:** Biome organizes imports automatically. Use `import type` for type-only imports.
- **No `console.log`.** Use `logger` from `src/config/logger.ts` (pino).
- **No `forEach`.** Use `for...of` or `.map()/.filter()/.reduce()`.
- **Readonly by default.** All interface properties and type members use `readonly`.

## GitLab Interaction (Two-Layer Model)

- **Upper layer (this service):** Uses `GitLabService` (`src/gitlab/service.ts`) via `@gitbeaker/rest` for service-level operations only: emoji reactions (acknowledgment) and status comments ("Agent started", "Agent failed"). Never import `@gitbeaker/rest` outside of `src/gitlab/`. Do NOT pre-fetch context or attempt intent detection — the service layer has no NLP capability.
- **Lower layer (spawned agents):** Agents use `glab` CLI autonomously for ALL GitLab interaction — reading pipelines, fetching MR diffs, posting comments, pushing code. The agent decides what context it needs by reading the user's message. The security boundary is the GitLab token's scope.

## Agent Spawning

- ALL agent process spawning goes through `src/agents/runner.ts`.
- Agents are spawned via `Bun.spawn()` as child processes.
- Each agent type (claude, codex, gemini) has its own adapter file in `src/agents/`.
- System prompts instruct agents to use `glab` CLI for all GitLab interaction (non-interactive mode).
- Agent sessions are tracked in SQLite for `--resume` support on follow-up messages.
- **Agents run autonomously.** There is no user at the terminal. System prompts enforce: no waiting for input, post all output as GitLab comments, create feature branches only (never push to protected branches). See `docs/ARCHITECTURE.md` §4.4 for system prompt template and §4.6 for security boundaries.

## Testing (TDD)

1. Write a failing test FIRST in `tests/<module>/<name>.test.ts`.
2. Run `bun test` to confirm it fails.
3. Write the minimum code to make it pass.
4. Run `bun run check` to confirm everything passes.
5. Tests use `bun:test` (`describe`, `it`, `expect`). No other test framework.

## Git Conventions

- Branch naming: `feat/<name>`, `fix/<name>`, `chore/<name>`
- Commit messages: conventional commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`)
- Never use `--no-verify`. All commits must pass pre-commit hooks (typecheck + lint + format + test).
- Never commit code that fails `bun run check`.

## Environment Variables

Required: `GITLAB_WEBHOOK_SECRET`, `BOT_USERNAME`, `GITLAB_TOKEN`, `GITLAB_HOST`.
Optional: `DEFAULT_AGENT` (claude|codex|gemini, default: claude), `PORT` (default: 3000), `DATABASE_PATH`, `LOG_LEVEL`, `WORKER_CONCURRENCY`, `AGENT_TIMEOUT_MS`, `CLAUDE_PATH`, `CODEX_PATH`, `GEMINI_PATH`. See `.env.example`.

## Adding a New Webhook Event Handler

1. Add Zod schema in `src/events/parser.ts`.
2. Add variant to `WebhookEvent` union in `src/types/events.ts`.
3. Add case to `routeEvent()` in `src/events/router.ts` (compiler will error if missing).
4. Add handler function. Write tests in `tests/events/`.

## Adding a New Agent Backend

1. Create `src/agents/<name>.ts` implementing the same interface as existing adapters.
2. Add variant to `AgentKind` in `src/types/events.ts` and `AgentType` in `src/agents/types.ts`.
3. Update `src/agents/runner.ts` to dispatch to the new adapter.
4. Add `<NAME>_PATH` to config schema in `src/config/config.ts`. Write tests in `tests/agents/`.
