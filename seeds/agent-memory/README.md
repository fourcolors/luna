# Seed agent memory

Vendored starter `MEMORY.md` files installed into the runtime location
`~/.luna/agent-memory/<agent-name>/MEMORY.md`. Checked into the repo so
new installs (or fresh container rebuilds) bootstrap with a non-empty
file the operator can immediately observe in Luna's system prompt.

## Installing

```bash
mkdir -p ~/.luna/agent-memory
cp -r seeds/agent-memory/* ~/.luna/agent-memory/
# Hot-loaded — no chat-server restart needed for subsequent edits, but
# the FIRST install takes effect on the next thread (chat-server reads
# MEMORY.md per-query, not at boot).
```

## What's here

- **`luna-main/MEMORY.md`** — Luna's main-thread observational memory.
  Loaded by `apps/server/src/agent-memory-loader.ts` and injected into
  the system prompt by `apps/server/src/chat-server.ts`, capped at the
  first 200 lines / 25 KB (matching the subagent-memory skill's harness
  cliff). Apply the discipline at
  `~/.claude/skills/subagent-memory/SKILL.md` — priority emojis,
  dated bullets, observer pass at task end, reflector pass at ~195 lines.

## What's NOT here

Subagent memory files. Those are auto-loaded by the Claude Agent SDK from
`~/.claude/agent-memory/<agent-name>/MEMORY.md` (note the `.claude` path)
when an agent declares `memory: user` in its frontmatter. The SDK manages
that path; we don't seed it because the operator's own skills CLI already
populates `~/.claude/` and we don't want to fight that surface.
