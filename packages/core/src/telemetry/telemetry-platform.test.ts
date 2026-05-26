/**
 * TelemetryPlatform integration tests — TDD PING phase.
 *
 * TelemetryPlatform is a pure composition Layer (Layer.mergeAll) that wires
 * together EventCounter + EventSink + SessionSync + MetricsFlusher. No logic
 * of its own — tests confirm that all sinks fire when composed together.
 *
 * Tests:
 *   1. TelemetryPlatform composes all three sinks — emit SessionStart + inc a
 *      counter + flush() → events row, sessions row, metric_snapshots rows.
 *   2. Non-session event → events has 1 row, sessions empty, counters flushed.
 *
 * Layer topology:
 *   Clock.Default              — provides Clock
 *   makeDuckDbLayer            — provides DuckDbService
 *   ObservabilityService.makeLayer — requires Clock
 *   TelemetryService.makeLayer() — requires Clock
 *   TelemetryPlatform            — requires ObservabilityService | DuckDbService |
 *                                    TelemetryService | Clock
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"

import { ObservabilityService } from "../observability/observability.js"
import { DuckDbService, makeDuckDbLayer } from "../db/duckdb-service.js"
import { Clock } from "../clock.js"
import { TelemetryService } from "./telemetry.js"
import { MetricsFlusher } from "./metrics-flusher.js"
import { TelemetryPlatform } from "./telemetry-platform.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Unique temp DB file per test; cleaned up in finally. */
const withTempDb = <A>(fn: (dbPath: string) => Promise<A>): Promise<A> => {
  const dbPath = path.join(
    os.tmpdir(),
    `luna-telemetry-platform-test-${Date.now()}-${Math.random().toString(36).slice(2)}.duckdb`,
  )
  return fn(dbPath).finally(() => {
    for (const suffix of ["", ".wal", ".lock", ".events.jsonl"]) {
      try { fs.unlinkSync(dbPath + suffix) } catch { /* ignore */ }
    }
  })
}

/**
 * Build the full composed layer for TelemetryPlatform tests.
 *
 * Provides all dependencies that TelemetryPlatform's constituent sinks need:
 *   ObservabilityService | DuckDbService | TelemetryService | Clock
 *
 * TelemetryPlatform is provided on top, so MetricsFlusher (and its flush()
 * method) is available via yield* MetricsFlusher.
 */
const makeTestLayer = (dbPath: string) => {
  const clockLayer = Clock.Default
  const duckLayer = makeDuckDbLayer({ dbPath })
  const obsLayer = ObservabilityService.makeLayer({
    logToConsole: false,
    jsonlPath: `${dbPath}.events.jsonl`,
  }).pipe(Layer.provide(clockLayer))
  const telLayer = TelemetryService.makeLayer().pipe(Layer.provide(clockLayer))

  // TelemetryPlatform requires all four dependencies
  const platformLayer = TelemetryPlatform.pipe(
    Layer.provide(Layer.mergeAll(obsLayer, duckLayer, telLayer, clockLayer)),
  )

  return Layer.mergeAll(clockLayer, duckLayer, obsLayer, telLayer, platformLayer)
}

type TestServices = ObservabilityService | DuckDbService | TelemetryService | MetricsFlusher

const runWithLayer = (dbPath: string) =>
  <A>(eff: Effect.Effect<A, unknown, TestServices>): Promise<A> => {
    const layer = makeTestLayer(dbPath)
    return Effect.runPromise(
      Effect.scoped(
        eff.pipe(
          Effect.provide(layer as Layer.Layer<TestServices, never, never>),
        ),
      ),
    )
  }

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TelemetryPlatform", () => {
  // ── 1. All three sinks fire together ─────────────────────────────────────

  it("composes all three sinks — SessionStart lands in events + sessions + metric_snapshots", async () => {
    await withTempDb(async (dbPath) => {
      const result = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const db = yield* DuckDbService
          const tel = yield* TelemetryService
          const flusher = yield* MetricsFlusher

          // Emit a SessionStart — triggers EventSink AND SessionSync
          yield* obs.emit({
            ts: "2024-01-01T00:00:00.000Z",
            kind: "SessionStart",
            level: "info",
            sessionId: "plat-sess-001",
            model: "claude-3-5-sonnet",
          })

          // Yield to daemon fibers
          yield* Effect.sleep("30 millis")

          // Increment a counter and flush — triggers MetricsFlusher
          yield* tel.inc("platform.test.counter")
          yield* flusher.flush

          const eventsCount = yield* db.query("SELECT COUNT(*) AS n FROM events")
          const sessionsCount = yield* db.query("SELECT COUNT(*) AS n FROM sessions")
          const metricsCount = yield* db.query("SELECT COUNT(*) AS n FROM metric_snapshots")

          return {
            events: (eventsCount[0] as { n: number }).n,
            sessions: (sessionsCount[0] as { n: number }).n,
            metrics: (metricsCount[0] as { n: number }).n,
          }
        }),
      )

      // EventSink: the SessionStart event
      expect(result.events).toBe(1)
      // SessionSync: the SessionStart row in sessions
      expect(result.sessions).toBe(1)
      // MetricsFlusher: the manual counter plus EventCounter's SessionStart counters.
      expect(result.metrics).toBe(3)
    })
  })

  // ── 2. Non-session event + no counters → only events table gets a row ────

  it("non-session event lands in events and telemetry counters, while sessions remain empty", async () => {
    await withTempDb(async (dbPath) => {
      const result = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const db = yield* DuckDbService
          const flusher = yield* MetricsFlusher

          // Emit a non-session event (Error) — EventSink handles it, SessionSync ignores it
          yield* obs.emit({
            ts: "2024-01-01T00:00:00.000Z",
            kind: "Error",
            level: "error",
            errorTag: "TestError",
            message: "non-session event",
          })

          yield* Effect.sleep("30 millis")

          // EventCounter mirrors this event into TelemetryService; flushing
          // persists that counter while SessionSync still ignores it.
          yield* flusher.flush

          const eventsCount = yield* db.query("SELECT COUNT(*) AS n FROM events")
          const sessionsCount = yield* db.query("SELECT COUNT(*) AS n FROM sessions")
          const metricsCount = yield* db.query("SELECT COUNT(*) AS n FROM metric_snapshots")

          return {
            events: (eventsCount[0] as { n: number }).n,
            sessions: (sessionsCount[0] as { n: number }).n,
            metrics: (metricsCount[0] as { n: number }).n,
          }
        }),
      )

      // EventSink: 1 row for the Error event
      expect(result.events).toBe(1)
      // SessionSync: 0 rows — only handles SessionStart/SessionEnd
      expect(result.sessions).toBe(0)
      // MetricsFlusher: EventCounter records the generic event and the error tag.
      expect(result.metrics).toBe(2)
    })
  })

  it("emitted observability events are mirrored into telemetry counters", async () => {
    await withTempDb(async (dbPath) => {
      const rows = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const db = yield* DuckDbService
          const flusher = yield* MetricsFlusher

          yield* obs.emit({
            ts: "2024-01-01T00:00:00.000Z",
            kind: "SessionStart",
            level: "info",
            sessionId: "counter-sess-001",
            model: "claude-test",
          })

          yield* Effect.sleep("30 millis")
          yield* flusher.flush

          return yield* db.query(
            "SELECT name, tags_json, value FROM metric_snapshots WHERE name = ?",
            ["luna.obs.events.total"],
          )
        }),
      )

      expect(rows).toHaveLength(1)
      const row = rows[0] as { name: string; tags_json: string; value: number }
      expect(row.name).toBe("luna.obs.events.total")
      expect(JSON.parse(row.tags_json)).toEqual({
        kind: "SessionStart",
        level: "info",
      })
      expect(row.value).toBe(1)
    })
  })
})
