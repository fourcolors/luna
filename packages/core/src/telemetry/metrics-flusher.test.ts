/**
 * MetricsFlusher tests — TDD PING phase.
 *
 * MetricsFlusher is a Layer.scoped service that:
 *   1. Migrates the `metric_snapshots` DuckDB table at boot
 *   2. Runs a forkDaemon background fiber that polls TelemetryService.snapshot()
 *      on a Schedule.fixed interval
 *   3. On each flush: batch-inserts all CounterSnapshot rows into metric_snapshots
 *   4. Each flush shares a unique snapshot_run value (epoch ms from Clock)
 *   5. Write errors are swallowed (fire-and-forget)
 *   6. Empty snapshots are skipped (no rows written, no error)
 *   7. Exposes flush() so tests can trigger a flush without waiting for the timer
 *
 * Tests use:
 *   - TelemetryService.makeLayer() (real in-memory counters)
 *   - Real makeDuckDbLayer with a temp file DB
 *   - Clock.Test for deterministic epoch timestamps
 *   - Manual flush() calls rather than waiting for the scheduler
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"

import { TelemetryService } from "./telemetry.js"
import { DuckDbService, DuckDbError, makeDuckDbLayer } from "../db/duckdb-service.js"
import { Clock } from "../clock.js"
import { MetricsFlusher } from "./metrics-flusher.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Unique temp DB file per test; cleaned up in finally. */
const withTempDb = <A>(fn: (dbPath: string) => Promise<A>): Promise<A> => {
  const dbPath = path.join(
    os.tmpdir(),
    `luna-metrics-flusher-test-${Date.now()}-${Math.random().toString(36).slice(2)}.duckdb`,
  )
  return fn(dbPath).finally(() => {
    for (const suffix of ["", ".wal", ".lock"]) {
      try { fs.unlinkSync(dbPath + suffix) } catch { /* ignore */ }
    }
  })
}

/**
 * Build the composed layer for tests.
 *
 * Layer topology:
 *   clockLayer          — provides Clock (deterministic or real)
 *   duckLayer           — provides DuckDbService (no Clock dep)
 *   telemetryLayer      — provides TelemetryService (requires Clock)
 *   metricsFlusherLayer — provides MetricsFlusher (requires TelemetryService + DuckDbService + Clock)
 */
const makeTestLayer = (dbPath: string, fixedClockMs?: number) => {
  const clockLayer = fixedClockMs !== undefined
    ? Clock.Test(fixedClockMs)
    : Clock.Default
  const duckLayer = makeDuckDbLayer({ dbPath })
  const telemetryLayer = TelemetryService.makeLayer().pipe(
    Layer.provide(clockLayer),
  )
  const metricsFlusherLayer = MetricsFlusher.makeLayer().pipe(
    Layer.provide(Layer.mergeAll(telemetryLayer, duckLayer, clockLayer)),
  )
  return Layer.mergeAll(clockLayer, duckLayer, telemetryLayer, metricsFlusherLayer)
}

type TestServices = TelemetryService | DuckDbService | MetricsFlusher

/** Run an effect inside a scoped managed runtime with the test layer. */
const runWithLayer = (dbPath: string, fixedClockMs?: number) =>
  <A>(eff: Effect.Effect<A, unknown, TestServices>): Promise<A> => {
    const layer = makeTestLayer(dbPath, fixedClockMs)
    return Effect.runPromise(
      Effect.scoped(
        eff.pipe(
          Effect.provide(layer as Layer.Layer<TestServices, never, never>),
        ),
      ),
    )
  }

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MetricsFlusher", () => {
  // ── 1. flush() writes counters to metric_snapshots ───────────────────────

  it("flush() writes counters to metric_snapshots", async () => {
    await withTempDb(async (dbPath) => {
      const count = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const tel = yield* TelemetryService
          const db = yield* DuckDbService
          const flusher = yield* MetricsFlusher

          yield* tel.inc("requests.total")
          yield* tel.inc("errors.total")

          yield* flusher.flush

          const rows = yield* db.query("SELECT * FROM metric_snapshots")
          return rows.length
        }),
      )

      expect(count).toBe(2)
    })
  })

  // ── 2. flush() writes correct column values ──────────────────────────────

  it("flush() writes correct name, value, and tags_json columns", async () => {
    await withTempDb(async (dbPath) => {
      const rows = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const tel = yield* TelemetryService
          const db = yield* DuckDbService
          const flusher = yield* MetricsFlusher

          yield* tel.inc("tool.calls", {}, 5)

          yield* flusher.flush

          return yield* db.query(
            "SELECT name, value, tags_json FROM metric_snapshots WHERE name = ?",
            ["tool.calls"],
          )
        }),
      )

      expect(rows).toHaveLength(1)
      const row = rows[0] as { name: string; value: number; tags_json: string | null }
      expect(row.name).toBe("tool.calls")
      expect(row.value).toBe(5)
      // No tags → tags_json should be null or '{}'
      // We accept either null or an empty-object JSON string
      if (row.tags_json !== null) {
        expect(JSON.parse(row.tags_json)).toEqual({})
      }
    })
  })

  // ── 3. flush() groups rows by snapshot_run ───────────────────────────────

  it("flush() groups all rows from one flush with the same snapshot_run", async () => {
    const fixedMs = 1_700_000_000_000

    await withTempDb(async (dbPath) => {
      const rows = await runWithLayer(dbPath, fixedMs)(
        Effect.gen(function* () {
          const tel = yield* TelemetryService
          const db = yield* DuckDbService
          const flusher = yield* MetricsFlusher

          yield* tel.inc("alpha")
          yield* tel.inc("beta")
          yield* tel.inc("gamma")

          yield* flusher.flush

          return yield* db.query(
            "SELECT snapshot_run FROM metric_snapshots",
          )
        }),
      )

      expect(rows).toHaveLength(3)
      const runs = (rows as Array<{ snapshot_run: number }>).map((r) => r.snapshot_run)
      // All rows from the same flush share the same snapshot_run
      expect(new Set(runs).size).toBe(1)
      // snapshot_run should equal the fixed epoch ms
      expect(runs[0]).toBe(fixedMs)
    })
  })

  // ── 4. flush() on empty snapshot is a no-op ──────────────────────────────

  it("flush() on empty snapshot writes no rows and does not error", async () => {
    await withTempDb(async (dbPath) => {
      const count = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const db = yield* DuckDbService
          const flusher = yield* MetricsFlusher

          // No counters incremented — snapshot is empty
          yield* flusher.flush

          const rows = yield* db.query("SELECT COUNT(*) AS n FROM metric_snapshots")
          return (rows[0] as { n: number }).n
        }),
      )

      expect(count).toBe(0)
    })
  })

  // ── 5. flush() is cumulative (rows accumulate across flushes) ────────────

  it("flush() accumulates rows — second flush appends, does not replace", async () => {
    await withTempDb(async (dbPath) => {
      const count = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const tel = yield* TelemetryService
          const db = yield* DuckDbService
          const flusher = yield* MetricsFlusher

          // First flush: 2 counters
          yield* tel.inc("first.counter")
          yield* tel.inc("second.counter")
          yield* flusher.flush

          // Second flush: same 2 counters (still in TelemetryService state) plus 1 new
          yield* tel.inc("third.counter")
          yield* flusher.flush

          const rows = yield* db.query("SELECT COUNT(*) AS n FROM metric_snapshots")
          return (rows[0] as { n: number }).n
        }),
      )

      // First flush: 2 rows. Second flush: 3 rows (2 existing + 1 new). Total: 5
      expect(count).toBe(5)
    })
  })

  // ── 6. flush() swallows DuckDB write errors ──────────────────────────────

  it("flush() swallows DuckDB write errors — does not propagate", async () => {
    await withTempDb(async (_dbPath) => {
      // Stub DuckDbService that always fails on write (but not on migrate/query)
      const failingDuckDb = Layer.succeed(DuckDbService, {
        exec: (_sql: string) => Effect.void,
        write: (_sql: string, _params?: ReadonlyArray<unknown>) =>
          Effect.fail(new DuckDbError({ op: "write", message: "forced failure" })),
        query: (_sql: string, _params?: ReadonlyArray<unknown>) => Effect.succeed([]),
        migrate: (_component: string, _version: number, _sql: string) => Effect.void,
      })

      const clockLayer = Clock.Default
      const telemetryLayer = TelemetryService.makeLayer().pipe(
        Layer.provide(clockLayer),
      )
      const metricsFlusherLayer = MetricsFlusher.makeLayer().pipe(
        Layer.provide(Layer.mergeAll(telemetryLayer, failingDuckDb, clockLayer)),
      )

      const composedLayer = Layer.mergeAll(
        clockLayer,
        failingDuckDb,
        telemetryLayer,
        metricsFlusherLayer,
      )

      // Must not throw even though DB write always fails
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const tel = yield* TelemetryService
            const flusher = yield* MetricsFlusher

            yield* tel.inc("should.not.explode")

            // flush() must swallow the write error
            yield* flusher.flush
          }).pipe(
            Effect.provide(composedLayer as Layer.Layer<TelemetryService | MetricsFlusher, never, never>),
          ),
        ),
      )

      // If we reach here without throwing, the test passes
      expect(true).toBe(true)
    })
  })

  // ── 7. Tags are serialized to JSON ───────────────────────────────────────

  it("counter with tags serializes tags_json as a JSON object string", async () => {
    await withTempDb(async (dbPath) => {
      const rows = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const tel = yield* TelemetryService
          const db = yield* DuckDbService
          const flusher = yield* MetricsFlusher

          yield* tel.inc("tool.calls", { tool: "bash" }, 3)

          yield* flusher.flush

          return yield* db.query(
            "SELECT name, value, tags_json FROM metric_snapshots WHERE name = ?",
            ["tool.calls"],
          )
        }),
      )

      expect(rows).toHaveLength(1)
      const row = rows[0] as { name: string; value: number; tags_json: string }
      expect(row.name).toBe("tool.calls")
      expect(row.value).toBe(3)
      expect(typeof row.tags_json).toBe("string")
      expect(JSON.parse(row.tags_json)).toEqual({ tool: "bash" })
    })
  })
})
