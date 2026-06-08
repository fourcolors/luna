# Seed skills

Vendored Claude Agent SDK skills installable into the runtime location
`~/.claude/skills/<name>/`. Checked into the repo so they survive container
rebuilds and fresh installs.

## Installing

```bash
bun run apps/ui-web/scripts/install-claude-skills.ts
```

The installer mirrors `seeds/skills/` → `~/.claude/skills/` without
overwriting existing files (use `--force` to overwrite, `--dry-run` to
preview). Files already installed via the upstream
[`skills` CLI](https://skills.sh) (which writes to the same location)
are left alone.

## What's here

- **`subagent-memory/`** — observational memory discipline for subagents:
  dated bullets with priority emojis, an observer pass at task end, and a
  reflector pass that compresses the file when it hits the harness's
  200-line / 25 KB injection cliff. Vendored from
  [fourcolors/skills](https://github.com/fourcolors/skills/tree/main/skills/subagent-memory).
  Pair with `memory: user` in a subagent's frontmatter — see
  `seeds/agents/README.md`.

## Authoring & upstream

Skills follow the spec described at <https://skills.sh>. Each lives in
its own subdirectory with a `SKILL.md` (YAML frontmatter + markdown body)
and optional `templates/`. The SDK uses *progressive disclosure*: only
frontmatter metadata (`name`, `description`) is preloaded into each
session; the full body is fetched only when the agent's context matches.

If you add new vendored skills, drop the source attribution at the top
of the skill's own `SKILL.md` or `README.md` so future maintainers can
trace it back upstream.
