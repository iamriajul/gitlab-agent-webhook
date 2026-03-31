---
name: agent-sync
description: Synchronize skills, agents, and guidance files across .claude/, .agents/, and .codex/ directories. Use after adding or modifying any skill, agent, or guidance file.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

# Agent & Skill Sync

Synchronize skills, agents, and guidance files across `.claude/`, `.agents/`, and `.codex/` directories.

## Directory Layout

```
CLAUDE.md              ← Guidance file (Claude)
AGENTS.md              ← Guidance file (Codex) — must be identical to CLAUDE.md
.claude/skills/*/      ← Claude skills (SKILL.md format)
.claude/agents/*.md    ← Claude sub-agents (markdown frontmatter format)
.agents/skills/*/      ← Codex skills (SKILL.md format) — mirrors .claude/skills/
.codex/config.toml     ← Codex agent registry
.codex/agents/*.toml   ← Codex sub-agents (TOML format)
```

## What is shared vs tool-specific

| Content | Shared? | Format |
|---------|---------|--------|
| Skills | Yes — identical copies | `SKILL.md` in both `.claude/skills/` and `.agents/skills/` |
| Agents | No — different formats | `.claude/agents/*.md` (markdown) vs `.codex/agents/*.toml` (TOML) |
| Guidance | Yes — identical copies | `CLAUDE.md` ↔ `AGENTS.md` |

## Sync Commands

### After editing CLAUDE.md or AGENTS.md
```bash
cp CLAUDE.md AGENTS.md   # or reverse direction
```

### After adding/modifying a skill
```bash
rsync -a --delete .claude/skills/ .agents/skills/
# or reverse: rsync -a --delete .agents/skills/ .claude/skills/
```

### After adding/modifying a Claude agent
Manually translate to Codex TOML format. See format reference below.

### After adding/modifying a Codex agent
Manually translate to Claude markdown format. See format reference below.

## Claude Agent Format (`.claude/agents/*.md`)

```markdown
---
name: agent-name
description: One-line description for agent selection.
tools: Read, Glob, Grep, Bash
model: sonnet
---

System prompt goes here as markdown body.
```

Fields: `name` (kebab-case), `description`, `tools` (comma-separated), `model` (haiku|sonnet|opus).

## Codex Agent Format (`.codex/agents/*.toml`)

```toml
model_reasoning_effort = "high"    # low | medium | high
sandbox_mode = "read-only"         # read-only | full
developer_instructions = """
System prompt goes here as a TOML multiline string.
"""
```

Also register in `.codex/config.toml`:
```toml
[agents.agent-name]
description = "One-line description."
config_file = "agents/agent-name.toml"
```

## Translation Rules: Claude → Codex

| Claude field | Codex equivalent |
|-------------|-----------------|
| `model: haiku` | `model_reasoning_effort = "medium"` |
| `model: sonnet` | `model_reasoning_effort = "high"` |
| `model: opus` | `model_reasoning_effort = "high"` |
| `tools: Read, Glob, Grep, Bash` | `sandbox_mode = "read-only"` |
| `tools: Read, Glob, Grep, Bash, Edit, Write` | `sandbox_mode = "full"` |
| Markdown body | `developer_instructions = """..."""` |

## Checklist

When adding or modifying any skill or agent:

1. [ ] Edit in the source directory (whichever you're working in)
2. [ ] Sync skills: `rsync -a --delete .claude/skills/ .agents/skills/`
3. [ ] If agent changed: translate to the other format (see tables above)
4. [ ] If Codex agent added: register in `.codex/config.toml` under `[agents.*]`
5. [ ] Sync guidance: `cp CLAUDE.md AGENTS.md`
6. [ ] Verify: `diff -rq .claude/skills/ .agents/skills/` (should show no differences)
