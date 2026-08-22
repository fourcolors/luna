/**
 * EventSink — Phase 14b.
 *
 * A side-effect-only Layer.effect service that subscribes to ObservabilityService
 * and persists every ObsEvent to the DuckDB `events` table via DuckDbService.
 *
 * Architecture:
 *   - At boot, eagerly subscribes via ObservabilityService.subscribeEvents
 *     (Scope-pinned; no events are missed after this resolves).
 *   - Runs a forkDaemon background fiber (per DESIGN §3.4 #1: no cross-Scope
 *     refs) that drains the subscription stream indefinitely.
 *   - For each ObsEvent, normalizes it into a flat row and calls
 *     DuckDbService.write(). Write errors are swallowed
 *     (Effect.catchCause(() => Effect.void)) — observability must never
 *     kill the host.
 *   - Schema migration is applied at boot via DuckDbService.migrate().
 *
 * Service value: void — this is a side-effect-only Layer. Consumers provide
 * it to inject the background sink behavior; they never call methods on it.
 *
 * Invariants:
 *   §3.4 #1  — daemon fiber (forkDaemon), not forkScoped.
 *   §3.4 #4  — Layer.effect scope handles subscription cleanup via addFinalizer.
 *   §16      — EventSink emits NO observability events itself (no circular loop).
 */
import { Context, Effect, Layer, Ref, Stream } from "effect"
import { Clock } from "../clock.js"
import { DuckDbService } from "../db/duckdb-service.js"
import { ObservabilityService } from "../observability/observability.js"
import type { ObsEvent } from "../observability/types.js"

// ── Schema ────────────────────────────────────────────────────────────────────

const EVENTS_SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS events (
    id            TEXT NOT NULL PRIMARY KEY,
    ts            TEXT NOT NULL,
    kind          TEXT NOT NULL,
    level         TEXT NOT NULL,
    session_id    TEXT,
    team          TEXT,
    workflow_id   TEXT,
    tool_name     TEXT,
    duration_ms   REAL,
    status        TEXT,
    estimated_usd REAL,
    tokens_in     INTEGER,
    tokens_out    INTEGER,
    error_tag     TEXT,
    raw_json      TEXT NOT NULL
  )
`

// ── Normalization ─────────────────────────────────────────────────────────────

interface EventRow {
  id: string
  ts: string
  kind: string
  level: string
  session_id: string | null
  team: string | null
  workflow_id: string | null
  tool_name: string | null
  duration_ms: number | null
  status: string | null
  estimated_usd: number | null
  tokens_in: number | null
  tokens_out: number | null
  error_tag: string | null
  raw_json: string
}

const normalizeEvent = (event: ObsEvent): EventRow => {
  const base: EventRow = {
    id: crypto.randomUUID(),
    ts: event.ts,
    kind: event.kind,
    level: event.level,
    session_id: null,
    team: null,
    workflow_id: null,
    tool_name: null,
    duration_ms: null,
    status: null,
    estimated_usd: null,
    tokens_in: null,
    tokens_out: null,
    error_tag: null,
    raw_json: JSON.stringify(event),
  }

  switch (event.kind) {
    case "SessionStart":
      return { ...base, session_id: event.sessionId }
    case "SessionEnd":
      return {
        ...base,
        session_id: event.sessionId,
        duration_ms: event.durationMs,
      }
    case "ToolCall":
      return {
        ...base,
        session_id: event.sessionId ?? null,
        tool_name: event.toolName,
        duration_ms: event.durationMs,
        status: event.status,
      }
    case "CostAccrued":
      return {
        ...base,
        session_id: event.sessionId ?? null,
        estimated_usd: event.estimatedUsd,
        tokens_in: event.tokensIn,
        tokens_out: event.tokensOut,
      }
    case "TeammateStart":
    case "TeammateIdle":
    case "TeammateStop":
      return { ...base, team: event.team }
    case "WorkflowTransition":
      return { ...base, workflow_id: event.workflowId }
    case "Error":
      return { ...base, error_tag: event.errorTag }
    default:
      // HookFire, PermissionDecision, AccountSwitch — no extra columns
      return base
  }
}

// ── INSERT SQL ────────────────────────────────────────────────────────────────

const INSERT_SQL = `
  INSERT INTO events
    (id, ts, kind, level, session_id, team, workflow_id, tool_name,
     duration_ms, status, estimated_usd, tokens_in, tokens_out, error_tag, raw_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`

// ── Health counters ───────────────────────────────────────────────────────────

/**
 * Snapshot of the EventSink's internal state. Exposed via the
 * `EventSink.health` Effect for self-introspection (issue #11: silent
 * failure invisible). `eventsReceived` counts every event that came off
 * the subscription stream; `eventsWritten` counts successful DuckDB
 * inserts; `writeFailures` counts swallowed errors. `lastWriteAt` and
 * `lastFailureReason` are tracked across the process lifetime.
 */
export interface EventSinkHealth {
  readonly eventsReceived: number
  readonly eventsWritten: number
  readonly writeFailures: number
  readonly lastWriteAt: string | null
  readonly lastFailureReason: string | null
}

interface EventSinkApi {
  readonly health: Effect.Effect<EventSinkHealth>
}

// ── Service ───────────────────────────────────────────────────────────────────

export class EventSink extends Context.Service<EventSink, EventSinkApi>()("luna/EventSink") {
  static makeLayer(): Layer.Layer<
    EventSink,
    never,
    ObservabilityService | DuckDbService | Clock
  > {
    return Layer.effect(
      EventSink,
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        const db = yield* DuckDbService

        // ── 0. Health counters ──────────────────────────────────────────────
        // Tracked across the process lifetime so the operator can ask
        // "are events actually landing in DuckDB?" via the obs_pipeline_health
        // tool, instead of having to side-channel ssh and run COUNT(*).
        const stateRef = yield* Ref.make<EventSinkHealth>({
          eventsReceived: 0,
          eventsWritten: 0,
          writeFailures: 0,
          lastWriteAt: null,
          lastFailureReason: null,
        })
        const firstFailureLoggedRef = yield* Ref.make(false)

        // ── 1. Run schema migration at boot ─────────────────────────────────
        yield* db.migrate("event-sink", 1, EVENTS_SCHEMA_V1).pipe(
          Effect.catchCause(() => Effect.void),
        )

        // ── 2. Eagerly subscribe (Scope-pinned) ──────────────────────────────
        // subscribeEvents requires a Scope; Layer.effect provides one.
        // Any events emitted after this resolves are guaranteed to be delivered.
        const stream = yield* obs.subscribeEvents

        // ── 3. Background daemon fiber ───────────────────────────────────────
        // forkDaemon per §3.4 #1 (not forkScoped).
        // Write errors are swallowed — fire-and-forget per §16 — but we now
        // count them and log the FIRST failure once per process so a broken
        // pipeline is at least visible in stderr.
        yield* Effect.forkDetach(
          stream.pipe(
            Stream.runForEach((event: ObsEvent) => {
              const row = normalizeEvent(event)
              return Ref.update(stateRef, (h) => ({
                ...h,
                eventsReceived: h.eventsReceived + 1,
              })).pipe(
                Effect.andThen(
                  db.write(INSERT_SQL, [
                    row.id,
                    row.ts,
                    row.kind,
                    row.level,
                    row.session_id,
                    row.team,
                    row.workflow_id,
                    row.tool_name,
                    row.duration_ms,
                    row.status,
                    row.estimated_usd,
                    row.tokens_in,
                    row.tokens_out,
                    row.error_tag,
                    row.raw_json,
                  ]),
                ),
                Effect.tap(() =>
                  Ref.update(stateRef, (h) => ({
                    ...h,
                    eventsWritten: h.eventsWritten + 1,
                    lastWriteAt: row.ts,
                  })),
                ),
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    const reason = cause.toString().slice(0, 240)
                    yield* Ref.update(stateRef, (h) => ({
                      ...h,
                      writeFailures: h.writeFailures + 1,
                      lastFailureReason: reason,
                    }))
                    const alreadyLogged = yield* Ref.getAndSet(
                      firstFailureLoggedRef,
                      true,
                    )
                    if (!alreadyLogged) {
                      yield* Effect.logError(
                        "EventSink: first DuckDB write failure (subsequent silently counted)",
                        { reason },
                      )
                    }
                  }),
                ),
              )
            }),
            Effect.catchCause(() => Effect.void),
          ),
        )

        return {
          health: Ref.get(stateRef),
        } satisfies EventSinkApi
      }),
    )
  }
}
