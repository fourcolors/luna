/**
 * MetricsFlusher — Phase 19.
 *
 * A Layer.effect service that periodically flushes TelemetryService counter
 * snapshots into the DuckDB `metric_snapshots` table.
 *
 * Architecture:
 *   - At boot, migrates the `metric_snapshots` table via DuckDbService.migrate.
 *   - Runs a forkDaemon background fiber that polls TelemetryService.snapshot()
 *     on a Schedule.fixed interval (default 60 seconds, configurable).
 *   - Each flush reads all CounterSnapshot rows and batch-inserts them into
 *     DuckDB. Each flush shares a unique `snapshot_run` value (epoch ms from
 *     Clock) so rows from the same flush are groupable.
 *   - Write errors are swallowed (fire-and-forget) — metrics persistence must
 *     never kill the host.
 *   - Empty snapshots are skipped (no DB writes, no error).
 *   - flush() is exposed on the service API so tests and operators can trigger
 *     a flush manually without waiting for the scheduler to fire.
 *
 * §3.4 #1  — daemon fiber (forkDaemon), not forkScoped.
 * §16      — MetricsFlusher emits NO observability events itself.
 */
import { Context, Effect, Layer, Schedule } from "effect"
import { Clock } from "../clock.js"
import { DuckDbService } from "../db/duckdb-service.js"
import { TelemetryService } from "./telemetry.js"
import type { CounterSnapshot } from "./types.js"

// ── Schema ─────────────────────────────────────────────────────────────────────

const METRIC_SNAPSHOTS_SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS metric_snapshots (
    ts            TEXT NOT NULL,
    name          TEXT NOT NULL,
    tags_json     TEXT,
    value         REAL NOT NULL,
    snapshot_run  INTEGER NOT NULL
  )
`

// ── INSERT SQL ────────────────────────────────────────────────────────────────

const INSERT_SQL = `
  INSERT INTO metric_snapshots (ts, name, tags_json, value, snapshot_run)
  VALUES (?, ?, ?, ?, ?)
`

// ── Config ────────────────────────────────────────────────────────────────────

export interface MetricsFlusherConfig {
  readonly flushIntervalMs?: number // default 60_000
}

// ── Service API ───────────────────────────────────────────────────────────────

interface MetricsFlusherApi {
  /** Trigger a flush immediately. Exposed for tests and manual invocation. */
  readonly flush: Effect.Effect<void, never>
}

// ── Service tag ───────────────────────────────────────────────────────────────

export class MetricsFlusher extends Context.Service<MetricsFlusher, MetricsFlusherApi>()("luna/MetricsFlusher") {
  static makeLayer(config?: MetricsFlusherConfig): Layer.Layer<
    MetricsFlusher,
    never,
    TelemetryService | DuckDbService | Clock
  > {
    const flushIntervalMs = config?.flushIntervalMs ?? 60_000

    return Layer.effect(
      MetricsFlusher,
      Effect.gen(function* () {
        const tel = yield* TelemetryService
        const db = yield* DuckDbService
        const clock = yield* Clock

        // ── 1. Schema migration at boot ──────────────────────────────────────
        yield* db.migrate("metrics-flusher", 1, METRIC_SNAPSHOTS_SCHEMA_V1).pipe(
          Effect.catchCause(() => Effect.void),
        )

        // ── 2. Core flush logic ───────────────────────────────────────────────
        // Reads snapshot, skips if empty, batch-inserts rows, swallows errors.
        const flush: Effect.Effect<void, never> = Effect.gen(function* () {
          const snapshots: CounterSnapshot[] = yield* tel.snapshot
          if (snapshots.length === 0) return

          const snapshotRun = yield* clock.nowMs()
          const nowIso = yield* clock.nowIso()

          for (const snap of snapshots) {
            const tagsJson = Object.keys(snap.tags).length > 0
              ? JSON.stringify(snap.tags)
              : null

            yield* db.write(INSERT_SQL, [nowIso, snap.name, tagsJson, snap.value, snapshotRun]).pipe(
              Effect.catchCause(() => Effect.void),
            )
          }
        }).pipe(Effect.catchCause(() => Effect.void))

        // ── 3. Background daemon fiber ────────────────────────────────────────
        // Polls on a fixed interval. Delay the first tick so Layer build does
        // not race a flush against test setup (v4 forkDetach schedules the
        // initial Effect.repeat body immediately).
        yield* Effect.forkDetach(
          Effect.sleep(flushIntervalMs).pipe(
            Effect.andThen(
              flush.pipe(
                Effect.repeat(Schedule.fixed(flushIntervalMs)),
                Effect.catchCause(() => Effect.void),
              ),
            ),
          ),
        )

        return { flush } satisfies MetricsFlusherApi
      }),
    )
  }
}
