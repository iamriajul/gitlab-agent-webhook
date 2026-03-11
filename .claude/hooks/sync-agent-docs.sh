#!/bin/bash

# Bidirectional sync between CLAUDE.md and AGENTS.md
# Runs as a PostToolUse hook after Edit/Write operations

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [[ "$FILE_PATH" == *"CLAUDE.md" ]]; then
  cp "$CLAUDE_PROJECT_DIR/CLAUDE.md" "$CLAUDE_PROJECT_DIR/AGENTS.md"
elif [[ "$FILE_PATH" == *"AGENTS.md" ]]; then
  cp "$CLAUDE_PROJECT_DIR/AGENTS.md" "$CLAUDE_PROJECT_DIR/CLAUDE.md"
fi

exit 0
