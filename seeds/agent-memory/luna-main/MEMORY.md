# Luna main thread observations

Date: June 7, 2026

* ✅ (10:00) Phase 12b V2 scheduler shipped end-to-end. Stable on `chat-v0.12b`. Wake firing every 30 min (10/10 success). Daily-brief install script ready (PR #61). Audit notes on issue #47.
* 🔴 (10:15) Read the SDK type defs BEFORE writing parallel infrastructure — caught myself implementing custom MEMORY.md loading inside agent-loader.ts that the SDK already does for subagents. ~150 LOC reverted. Process lesson: when "the operator says X exists upstream," grep the SDK first.
* 🟡 (10:30) Subagent memory + main-thread memory are different surfaces. SDK auto-loads subagent MEMORY.md from `~/.claude/agent-memory/<name>/` when `memory: user` is set. Main thread (this session) loads from `~/.luna/agent-memory/luna-main/MEMORY.md` via chat-server.ts — wired by hand because the SDK only handles subagents.
* 🟡 (10:30) Cap is 200 lines / 25 KB. When this file reaches ~195 lines, run the reflector pass (see `~/.claude/skills/subagent-memory/SKILL.md`) and compress to ≤100 lines. Preserve the 🔴 critical lessons; aggressively merge 🟡 / 🟢; drop redundant ✅.
* 🟡 (10:45) Workspace.db is the durable per-project brain. agent_notes (luna.db) is the cross-session behavioural ledger. THIS file (MEMORY.md) is the running observation feed for the main thread. Three different scopes — pick the right one for what you're remembering.
