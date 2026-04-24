# Experiment-Agent — Orchestrator Handoff

Continuity doc between orchestrator sessions. Keep it short and append-only at
the bottom so the next orchestrator can read the tail and resume.

## How to resume (for the next orchestrator)

1. Read this file end-to-end.
2. `cd /Users/sol/Projects/experiment-agent && git log --oneline -10`
3. Read `/Users/sol/Projects/experiment-agent/DESIGN.md` §15 (milestones) and
   the §-anchors noted under "Next phase required reading" below.
4. Read `BRIEF_TEMPLATE.md` — every subagent dispatch fills this template.
5. Resume with the next pending phase per TodoWrite.

## Execution model (locked)

- **Orchestrator** (you): reads DESIGN, consults advisor, dispatches subagents,
  verifies diffs, commits.
- **Subagent** (general-purpose): receives a filled BRIEF_TEMPLATE, writes
  code + tests, returns a six-item summary.
- **Advisor**: called BEFORE each dispatch (scope validation) and AFTER each
  subagent return (diff validation with §-anchor citations).
- **Verification gates** before every commit:
  1. `git diff --stat` — confirm no unexpected files touched
  2. `bun run test` — confirm numeric pass/fail
  3. `bun run typecheck` — zero errors
  4. Read one implementation file + one test file for sanity (~30s)
  5. Advisor verdict cites §-anchor respected (not just "looks good")

- **Realistic horizon per orchestrator session: 4–6 phases.** When the
  orchestrator context feels heavy (roughly after 5 phases, or when
  summaries start feeling longer than the work), stop, update this doc,
  commit, and hand off.

## Anti-patterns (watch every dispatch)

- Subagent summary says "tests pass" without numbers → reject, demand vitest tail
- Subagent modifies files outside its phase scope → revert, re-dispatch
- Advisor PROCEEDs without citing a §-anchor → reject, re-ask
- Orchestrator stops Reading diffs and trusts summaries → drift begins
- Brief divergence across phases → always fill BRIEF_TEMPLATE.md slots

## Frozen artifacts (do not modify without explicit Sterling approval)

- `packages/core/src/errors.ts` — error taxonomy (§6)
- `packages/core/src/messages.ts` — versioned envelope (§12.2 #6)
- `packages/adapter-sdk/src/adapter.ts` — SDK bridge (§12.2 invariants #1–#8)
- `DESIGN.md` — all §0 frozen decisions

## Session log (append at end)

### Session 2026-04-24 (orchestrator A)
- Shipped: Phases 0–5 (initial strategy: inline; too context-heavy)
- Last commit: `933a8ea` feat(memory): Phase 5 — plug-and-play memory …
- Strategy change: Sterling switched to orchestrator/subagent model mid-session
- Scaffolding created: BRIEF_TEMPLATE.md, HANDOFF.md
- Advisor verdict on strategy: MODIFY — realistic horizon 4–6 phases/session,
  subagents share DESIGN path (not pasted text), verification must cite §-anchors

### Session 2026-04-24 (orchestrator A, continued)
- Starting Phase 6: MCP Tool List + Custom Tool builder + Override Tools + built-in wrappers
- Next phase required reading for Phase 6:
  - DESIGN.md §2.1.4 (Tools), §7.3 (ToolRegistry), §12.2 #4 (permission eval order)
  - `packages/adapter-sdk/src/sdk-client.ts` (re-exported SDK tool types)
