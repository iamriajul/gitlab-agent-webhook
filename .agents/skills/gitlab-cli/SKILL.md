---
name: gitlab-cli
description: Reference for GitLab operations. Use when implementing GitLab interactions (comments, reactions, reviews, MR diffs) or when spawned agents need glab CLI command syntax.
allowed-tools: Read, Bash, Grep
---

# GitLab Operations Reference

This project uses TWO approaches for GitLab interaction:

1. **Service layer** (`src/gitlab/service.ts`): Uses `@gitbeaker/rest` SDK for typed, performant API calls.
2. **Spawned AI agents**: Use `glab` CLI for posting comments and pushing code (non-interactive mode).

## Service Layer — @gitbeaker/rest

`GitLabService` is the single entry point. All methods return `ResultAsync<T, AppError>`.

```typescript
// Reactions
service.addReaction(target, "eyes");
service.removeReaction(target, "eyes", awardId);

// Comments
service.postIssueComment(project, issueIid, body);
service.postMRComment(project, mrIid, body);

// Inline diff review comments
service.postMRInlineComment(project, mrIid, body, {
  baseSha, startSha, headSha, oldPath, newPath, newLine, oldLine
});

// Get diff refs for inline comments
service.getMRDiffRefs(project, mrIid);
```

Never import `@gitbeaker/rest` outside of `src/gitlab/`.

## glab CLI — For Spawned Agents Only

Spawned agents (Claude, Codex, Gemini) use `glab` to post their results.

### Comments

```bash
glab issue note <iid> -m "Comment text"
glab mr note <iid> -m "Comment text"
glab mr note <iid> -m "Comment text" --unique    # idempotent
```

### Emoji Reactions

```bash
glab api projects/:fullpath/issues/:iid/notes/:note_id/award_emoji -f name="eyes"
glab api projects/:fullpath/merge_requests/:iid/award_emoji -f name="eyes"
# Common: eyes, thumbsup, white_check_mark, warning, rocket, hourglass
```

### Inline Diff Comments

```bash
# Get diff refs
glab api projects/:fullpath/merge_requests/:iid --jq '.diff_refs'

# Post inline comment
glab api projects/:fullpath/merge_requests/:iid/discussions -X POST \
  --raw-field 'body=Review comment' \
  --raw-field 'position[position_type]=text' \
  --raw-field 'position[base_sha]=<sha>' \
  --raw-field 'position[head_sha]=<sha>' \
  --raw-field 'position[start_sha]=<sha>' \
  --raw-field 'position[new_path]=src/file.ts' \
  --raw-field 'position[new_line]=42'
```

| Line Type | Parameters |
|-----------|-----------|
| Added (green) | `position[new_line]` only |
| Removed (red) | `position[old_line]` only |
| Unchanged | Both `position[new_line]` and `position[old_line]` |

### Discussions

```bash
glab api projects/:fullpath/merge_requests/:iid/discussions -f body="Thread"
glab api projects/:fullpath/merge_requests/:iid/discussions/:id/notes -f body="Reply"
glab mr note <iid> --resolve <discussion_id>
```

## Rules

- Service code: use `GitLabService` (`@gitbeaker/rest`). Never call `glab` from service code.
- Agent system prompts: use `glab` CLI. Agents cannot import TypeScript modules.
- `:fullpath` is URL-encoded project path (e.g., `team%2Fproject`).
