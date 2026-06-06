/**
 * SessionSync — Phase 14c.
 *
 * A side-effect-only Layer.scoped service that subscribes to ObservabilityService
 * and keeps the DuckDB `sessions` table in sync with session lifecycle events.
 *
 * Architecture:
 *   - At boot, eagerly subscribes via ObservabilityService.subscribeEvents
 *     (Scope-pinned; no events are missed after this resolves).
 *   - Runs a forkDaemon background fiber (per DESIGN §3.4 #1: no cross-Scope
 *     refs) that filters for ONLY SessionStart and SessionEnd events.
 *   - SessionStart: INSERT OR IGNORE (idempotent — duplicate emits are safe).
 *   - SessionEnd:   UPDATE sessions SET ended_at, duration_ms, status='closed'
 *                   for the matching id. No-op if the session row doesn't exist.
 *   - All write errors are swallowed (fire-and-forget) — observability must
 *     never bring down the host.
 *   - Schema migration applied at boot via DuckDbService.migrate().
 *
 * Service value: void — purely a side-effect Layer.
 *
 * Invariants:
 *   §3.4 #1  — daemon fiber (forkDaemon), not forkScoped.
 *   §3.4 #4  — Layer.scoped scope handles subscription cleanup via addFinalizer
 *               (inside subscribeEvents).
 *   §16      — SessionSync emits NO observability events itself.
 */
import { Effect, Layer, Ref, Stream } from "effect"
import { Clock } from "../clock.js"
import { DuckDbService } from "../db/duckdb-service.js"
import { ObservabilityService } from "../observability/observability.js"
import type { ObsEvent } from "../observability/types.js"

// ── Schema ────────────────────────────────────────────────────────────────────

const SESSIONS_SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT NOT NULL PRIMARY KEY,
    parent_id   TEXT,
    model       TEXT NOT NULL,
    title       TEXT,
    tags        TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TEXT NOT NULL,
    ended_at    TEXT,
    duration_ms REAL
  )
`

// ── SQL statements ─────────────────────────────────────────────────────────────

const INSERT_SESSION_SQL = `
  INSERT OR IGNORE INTO sessions
    (id, parent_id, model, title, tags, status, created_at)
  VALUES (?, ?, ?, ?, ?, 'active', ?)
`

const UPDATE_SESSION_SQL = `
  UPDATE sessions
  SET ended_at    = ?,
      duration_ms = ?,
      status      = 'closed'
  WHERE id = ?
`

// ── Health counters ───────────────────────────────────────────────────────────

/**
 * Snapshot of the SessionSync's internal state. Exposed via the
 * `SessionSync.health` Effect for self-introspection (issue #11). Only
 * SessionStart / SessionEnd events are processed; `eventsReceived` counts
 * those two kinds, NOT every observability event seen on the stream.
 */
export interface SessionSyncHealth {
  readonly eventsReceived: number
  readonly eventsWritten: number
  readonly writeFailures: number
  readonly lastWriteAt: string | null
  readonly lastFailureReason: string | null
}

interface SessionSyncApi {
  readonly health: Effect.Effect<SessionSyncHealth>
}

// ── Service ───────────────────────────────────────────────────────────────────

export class SessionSync extends Effect.Tag("luna/SessionSync")<
  SessionSync,
  SessionSyncApi
>() {
  static makeLayer(): Layer.Layer<
    SessionSync,
    never,
    ObservabilityService | DuckDbService | Clock
  > {
    return Layer.scoped(
      SessionSync,
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        const db = yield* DuckDbService

        // ── 0. Health counters ──────────────────────────────────────────────
        // See EventSink.makeLayer for the rationale.
        const stateRef = yield* Ref.make<SessionSyncHealth>({
          eventsReceived: 0,
          eventsWritten: 0,
          writeFailures: 0,
          lastWriteAt: null,
          lastFailureReason: null,
        })
        const firstFailureLoggedRef = yield* Ref.make(false)

        // Helper: count a write attempt, log first failure once.
        const recordWrite = (
          writeEff: Effect.Effect<unknown, unknown>,
          ts: string,
        ) =>
          Ref.update(stateRef, (h) => ({
            ...h,
            eventsReceived: h.eventsReceived + 1,
          })).pipe(
            Effect.zipRight(writeEff),
            Effect.tap(() =>
              Ref.update(stateRef, (h) => ({
                ...h,
                eventsWritten: h.eventsWritten + 1,
                lastWriteAt: ts,
              })),
            ),
            Effect.catchAllCause((cause) =>
              Effect.gen(function* () {
                const reason = cause.toString().slice(0, 240)
                yield* Ref.update(stateRef, (h) => ({
                  ...h,
                  writeFailures: h.writeFailures + 1,
                  lastFailureReason: reason,
                }))
                const already = yield* Ref.getAndSet(
                  firstFailureLoggedRef,
                  true,
                )
                if (!already) {
                  yield* Effect.logError(
                    "SessionSync: first DuckDB write failure (subsequent silently counted)",
                    { reason },
                  )
                }
              }),
            ),
          )

        // ── 1. Run schema migration at boot ─────────────────────────────────
        yield* db.migrate("session-sync", 1, SESSIONS_SCHEMA_V1).pipe(
          Effect.catchAllCause(() => Effect.void),
        )

        // ── 2. Eagerly subscribe (Scope-pinned) ──────────────────────────────
        // subscribeEvents requires a Scope; Layer.scoped provides one.
        // Any events emitted after this resolves are guaranteed to be delivered.
        const stream = yield* obs.subscribeEvents

        // ── 3. Background daemon fiber ───────────────────────────────────────
        // forkDaemon per §3.4 #1 (not forkScoped).
        // Only handles SessionStart and SessionEnd; all other events fall through.
        // Write errors are swallowed — fire-and-forget per §16.
        yield* Effect.forkDaemon(
          stream.pipe(
            Stream.runForEach((event: ObsEvent) => {
              if (event.kind === "SessionStart") {
                const tagsJson =
                  event.tags !== undefined
                    ? JSON.stringify(event.tags)
                    : null

                return recordWrite(
                  db.write(INSERT_SESSION_SQL, [
                    event.sessionId,
                    event.parentId ?? null,
                    event.model,
                    event.title ?? null,
                    tagsJson,
                    event.ts,
                  ]),
                  event.ts,
                )
              }

              if (event.kind === "SessionEnd") {
                return recordWrite(
                  db.write(UPDATE_SESSION_SQL, [
                    event.ts,
                    event.durationMs,
                    event.sessionId,
                  ]),
                  event.ts,
                )
              }

              // All other event kinds — ignore (not counted).
              return Effect.void
            }),
            Effect.catchAllCause(() => Effect.void),
          ),
        )

        return {
          health: Ref.get(stateRef),
        } satisfies SessionSyncApi
      }),
    )
  }
}
