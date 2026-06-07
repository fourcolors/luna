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
