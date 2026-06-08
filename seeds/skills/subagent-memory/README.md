# subagent-memory

An observational memory discipline skill for autonomous subagents.

It teaches subagents to:
- Read `MEMORY.md` at task start to reload historical context, rules, and repository-specific patterns.
- Keep dated, chronological observations using priority emojis (`🔴` critical, `🟡` useful, `🟢` minor, `✅` completed).
- Run a reflection and compression pass before the file hits the 200-line CLI prompt injection limit to keep context clean.

---

## Installation

Install using the `skills` CLI:

```bash
# Project-scoped (recommended)
npx skills add fourcolors/skills --skill subagent-memory -a claude-code

# Global user-scoped
npx skills add fourcolors/skills --skill subagent-memory -g
```

---

## Usage in Custom Agents

Configure your custom agents (e.g., `.claude/agents/*.md`) to load this skill by declaring it in their frontmatter:

```yaml
---
name: my-subagent
description: A specialized subagent.
memory: project
skills:
  - subagent-memory
---
```

When the subagent is invoked, it will automatically load and follow the memory guidelines defined in this skill.
