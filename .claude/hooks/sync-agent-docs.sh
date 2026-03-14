#!/bin/bash

# Bidirectional sync between Claude and Codex configurations
# Runs as a PostToolUse hook after Edit/Write operations
#
# Synced paths:
#   CLAUDE.md <-> AGENTS.md
#   .claude/skills/ <-> .agents/skills/
#
# NOT synced (different formats):
#   .claude/agents/ (markdown) vs .codex/agents/ (TOML)
#   These must be updated manually in both formats when adding/changing agents.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
DIR="$CLAUDE_PROJECT_DIR"

# Sync CLAUDE.md <-> AGENTS.md
if [[ "$FILE_PATH" == *"CLAUDE.md" ]]; then
  cp "$DIR/CLAUDE.md" "$DIR/AGENTS.md"
elif [[ "$FILE_PATH" == *"AGENTS.md" ]]; then
  cp "$DIR/AGENTS.md" "$DIR/CLAUDE.md"
fi

# Sync skills: .claude/skills/ <-> .agents/skills/
if [[ "$FILE_PATH" == *".claude/skills/"* ]]; then
  rsync -a --delete "$DIR/.claude/skills/" "$DIR/.agents/skills/"
elif [[ "$FILE_PATH" == *".agents/skills/"* ]]; then
  rsync -a --delete "$DIR/.agents/skills/" "$DIR/.claude/skills/"
fi

exit 0
