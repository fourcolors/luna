# Observability self-audit — 2026-06-04

**Auditor:** Luna (self-audit, prompted by Operator)
**Trigger:** `obs_notes_recent()` returned `[]` when asked "what did you recently work on?", despite many sessions in history.
**Scope:** End-to-end pipeline from `ObservabilityService.emit` → `events.jsonl` → DuckDB → `obs_*` MCP tools, plus `AgentNotesService` → SQLite → `obs_note(s)` MCP tools.

## TL;DR

The observability pipeline has **three independent breaks** plus **one runtime-topology unknown**. Symptom: Luna can't reliably reconstruct what it has worked on, defeating the purpose of the system.

| # | Severity | Component | Symptom |
|---|----------|-----------|---------|
| 1 | High | `@luna/observability-tools` `obs_notes_recent` | Returns `[]` with no filters when current session has no notes, even if many notes exist elsewhere. |
| 2 | High | `@luna/core` telemetry (`EventSink` / `SessionSync`) | `events.jsonl` has 6,841 events including 842 ToolCalls; DuckDB `events`/`sessions`/`metric_snapshots` tables are empty. |
| 3 | High | `@luna/core` `AgentNotesService` | `agent_notes` table on host has 0 rows. Either no Luna has ever called `obs_note`, or the active server writes to a different DB path. |
| 4 | Unknown | Runtime topology | Session metadata claims `Runtime scope: incus-container`; no `incus` binary present, no OrbStack VMs running, no `bun chat-server` process. Yet `obs_sessions_search` returns rows — *something* is serving queries. |

## Evidence

### Host filesystem state at audit time

```
~/.luna/events.jsonl       6,841 lines (incl. 842 ToolCall, 1,928 SessionStart)
~/.luna/analytics.duckdb   schema applied 2026-05-24, rows: events=0, sessions=0, metric_snapshots=0
~/.luna/luna.db            agent_notes: 0 rows
```

DuckDB `schema_versions`:
```
event-sink           v1   2026-05-24
session-sync         v1   2026-05-24
metrics-flusher      v1   2026-05-24
analytics-sessions   v1   2026-05-24
analytics-events     v1   2026-05-24
```

### Code inspection

**Break 1** — `packages/observability-tools/src/tools.ts`, `obs_notes_recent` handler, `else` branch:
```ts
} else {
  // No filter — use current session if available, else all recent…
  const sid = currentSessionId()
  if (sid) {
    noteList = yield* notes.getRecent(sid, limit)
  } else {
    noteList = []
  }
}
```
When no filter is provided, the tool falls back to *current-session-only* — not "globally recent". A brand-new thread therefore returns `[]` even if hundreds of notes exist for prior sessions. This is the opposite of the stated purpose ("reconstruct context after a context-window reset"). Fix: when `sid` is present, query notes across all sessions with `LIMIT` newest-first; only filter by sessionId when the caller asks for it.

**Break 2** — `packages/core/src/telemetry/event-sink.ts` is wired into `TelemetryPlatform` and provided to `chat-server.ts` (line 716). It subscribes to `ObservabilityService.subscribeEvents` and writes normalized rows to DuckDB. Either:
- The host's chat-server hasn't run since 2026-05-24 (consistent with `analytics.duckdb` mtime), OR
- Writes are silently failing inside `Effect.catchAllCause(() => Effect.void)` and being swallowed.

Need to add an internal counter or a single observable health-event so silent failure can't hide.

**Break 3** — `agent_notes` empty on the host. `obs_note` calls in this session return a successful id, so the active server is writing *somewhere* — just not `~/.luna/luna.db` on the host. Confirms break 4 below: the host filesystem isn't the active backing store.

**Break 4** — Runtime topology: where does the chat-server actually live?
- `ps aux` shows only `Luna Moon.app` (Tauri UI). No `bun chat-server` process.
- `incus`: command not found. `orb list -f json`: `[]`. No VMs running.
- Yet MCP tool calls succeed and return data.
- Working theory: `Luna Moon.app` embeds the chat-server as a Tauri sidecar with its own `~/.luna` inside the app's sandbox. Needs to be verified and documented.

## Recommended fixes

1. **Tool semantics:** `obs_notes_recent` with no filters → globally recent. Add an integration test that writes notes to two sessions and asserts both appear when called without `session_id`.
2. **Pipeline health:** `EventSink` and `SessionSync` should track an internal counter (events seen / events written / write failures) exposed via a new `obs_pipeline_health` tool. Silent `catchAllCause` failures are a foot-gun.
3. **Storage discovery:** Document the active backing-store paths in `DNA.md` and surface them via an `obs_runtime` tool so future Luna instances can self-locate without ssh-ing into the host.
4. **Behavioral discipline:** Update `DNA.md` to make `obs_note` calls a hard expectation at session start (`goal_declared`), at decision points, and at session end (`reflection`). The current DNA only suggests it.

## Open questions for Operator

- Is the chat-server actually running inside `Luna Moon.app` (Tauri sidecar), or somewhere else?
- Are there multiple `~/.luna` directories in play (host + sandbox + container)? If so, which is canonical?

## Filed issues

- [#10](https://github.com/fourcolors/luna/issues/10) — `obs_notes_recent`: no-filter call returns empty instead of globally recent notes
- [#11](https://github.com/fourcolors/luna/issues/11) — EventSink/SessionSync: DuckDB empty despite events.jsonl having 6,841 events
- [#12](https://github.com/fourcolors/luna/issues/12) — Runtime topology: chat-server location unknown; `agent_notes` empty on host
- [#13](https://github.com/fourcolors/luna/issues/13) — DNA: enforce `obs_note` discipline
- [#14](https://github.com/fourcolors/luna/issues/14) — [tracking] Observability self-audit 2026-06-04
