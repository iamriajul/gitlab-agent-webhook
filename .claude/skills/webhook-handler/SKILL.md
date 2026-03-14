---
name: webhook-handler
description: Guide for adding new GitLab webhook event handlers. Use when asked to handle a new webhook event type, add a new event handler, or extend webhook processing.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

# Add a New Webhook Event Handler

Follow these steps exactly. Do not skip any step.

## Step 1: Write Failing Tests

Create test file `tests/events/<handler-name>.test.ts` with test cases for:
- Valid payload parsing
- Invalid payload rejection (returns `err`)
- Edge cases (system notes, ignored actions)

Run `bun test` to confirm the tests fail.

## Step 2: Add Zod Schema

In `src/events/parser.ts`:
- Define the Zod schema for the new event payload
- Export the inferred TypeScript type

## Step 3: Add Event Variant

In `src/types/events.ts`:
- Add a new variant to the `WebhookEvent` discriminated union:
  ```typescript
  | { readonly kind: "new_event_name"; readonly payload: NewPayloadType }
  ```

## Step 4: Update Parser

In `src/events/parser.ts`:
- Add a new parsing function (e.g., `parseNewEventHook`)
- Add the event type check to `parseWebhookPayload`

## Step 5: Update Router

In `src/events/router.ts`:
- Add a new `case` to the `switch (event.kind)` block
- TypeScript will error until you handle the new variant (no `default` case)

## Step 6: Verify

Run `bun run check` (typecheck + lint + test). All must pass.

## Key Rules

- Every new event variant in the union MUST be handled in the router (exhaustive switch)
- Payloads MUST be validated through Zod schemas (never trust raw input)
- The parser function MUST return `Result<WebhookEvent, AppError>` (never throw)
