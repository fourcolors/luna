# Seed agent definitions

These `.md` files are durable copies of Luna subagent definitions intended
to be installed into the runtime location `~/.luna/agents/`. They're
checked into the repo so they survive container rebuilds, fresh installs,
and cross-machine setups.

## Installing

```bash
mkdir -p ~/.luna/agents
cp seeds/agents/*.md ~/.luna/agents/
# Restart not required — agents are hot-loaded on every query.
```

## Invoking from chat

Once copied to `~/.luna/agents/`, these definitions become available as
`subagent_type` values in chat threads. Luna spawns them via the SDK's
built-in Task tool — pass the agent's `name` frontmatter value as
`subagent_type`, along with a `description` and `prompt`. The subagent
runs to completion and its report returns as the tool result. No restart
is needed beyond the `cp` above, but definitions load when a thread
starts: new chat threads see the new agent; already-open threads keep the
set they started with.

## What's here

- `dev-agent.md` — senior delivery engineer persona; ships PRs to `dev`
  by default, asks only on the narrow ask-list. See file head for the
  full contract.

## Authoring guidelines

Each agent file is a YAML front-matter block (`name`, `description`,
optional `model`) followed by free-form Markdown that becomes the
agent's system prompt when invoked via the `Agent` tool.

`description` is the **only** thing the parent model uses to decide
whether to invoke the agent — write it like a router, not a doc.

## Subagent observational memory (opt-in)

Subagents can persist observations across invocations. The Claude Agent SDK
auto-loads:

- `~/.claude/skills/<name>/SKILL.md` when the agent declares `skills: [<name>]`
- `~/.claude/agent-memory/<agent-name>/MEMORY.md` when the agent declares
  `memory: user`

This repo vendors the [`subagent-memory`](../skills/subagent-memory/SKILL.md)
skill from [fourcolors/skills](https://github.com/fourcolors/skills) at
`seeds/skills/subagent-memory/`. Install it once with:

```bash
bun run apps/ui-web/scripts/install-claude-skills.ts
```

Then any subagent can opt in by adding to its frontmatter:

```yaml
---
name: my-agent
description: "..."
memory: user
skills:
  - subagent-memory
---
```

The SDK loads the first 200 lines / 25 KB of `MEMORY.md` into the system
prompt at invocation. The skill defines the discipline (priority emojis,
date grouping, observer/reflector passes, compression cliff). The
subagent uses its own file tools (Write/Edit) to append observations at
task end.

For the `subagent-memory` repo this corresponds to:
[`skills/subagent-memory/SKILL.md`](https://github.com/fourcolors/skills/blob/main/skills/subagent-memory/SKILL.md).
