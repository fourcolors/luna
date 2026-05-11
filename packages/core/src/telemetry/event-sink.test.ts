/**
 * EventSink tests — TDD PING phase.
 *
 * EventSink is a side-effect-only Layer.scoped that:
 *   1. Eagerly subscribes to ObservabilityService.subscribeEvents
 *   2. Runs a background daemon fiber draining the subscription stream
 *   3. Normalizes each ObsEvent into a flat row and calls DuckDbService.write()
 *   4. Runs a schema migration at boot (events table)
 *   5. Swallows write errors — observability must never kill the host
 *
 * Tests use:
 *   - ObservabilityService.Default (real in-memory PubSub)
 *   - Real makeDuckDbLayer with a temp file DB
 *   - Effect.sleep("10 millis") after emit to yield to the daemon fiber
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Exit } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"

import { ObservabilityService } from "../observability/observability.js"
import { DuckDbService, DuckDbError, makeDuckDbLayer } from "../db/duckdb-service.js"
import { Clock } from "../clock.js"
import { EventSink } from "./event-sink.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Unique temp DB file per test; cleaned up in finally. */
const withTempDb = <A>(fn: (dbPath: string) => Promise<A>): Promise<A> => {
  const dbPath = path.join(
    os.tmpdir(),
    `luna-event-sink-test-${Date.now()}-${Math.random().toString(36).slice(2)}.duckdb`,
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
 *   Clock.Default              — provides Clock
 *   makeDuckDbLayer            — provides DuckDbService (no Clock dep)
 *   ObservabilityService.Default — requires Clock → provided by clockLayer
 *   EventSink.makeLayer()      — requires ObservabilityService + DuckDbService + Clock
 *
 * All wired explicitly so there is only one instance of each service
 * (prevents lock-file conflicts from duplicate DuckDb instances).
 */
const makeTestLayer = (dbPath: string) => {
  const clockLayer = Clock.Default
  const duckLayer = makeDuckDbLayer({ dbPath })
  const obsLayer = ObservabilityService.Default.pipe(Layer.provide(clockLayer))
  const eventSinkLayer = EventSink.makeLayer().pipe(
    Layer.provide(Layer.mergeAll(obsLayer, duckLayer, clockLayer)),
  )
  return Layer.mergeAll(clockLayer, duckLayer, obsLayer, eventSinkLayer)
}

/** Run an effect inside a scoped managed runtime with the test layer. */
const runWithLayer = (dbPath: string) =>
  <A>(eff: Effect.Effect<A, DuckDbError, ObservabilityService | DuckDbService>): Promise<A> => {
    const layer = makeTestLayer(dbPath)
    return Effect.runPromise(
      Effect.scoped(
        eff.pipe(
          Effect.provide(layer as Layer.Layer<ObservabilityService | DuckDbService, never, never>),
        ),
      ),
    )
  }

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("EventSink", () => {
  // ── 1. SessionStart flows into DuckDB ─────────────────────────────────────

  it("SessionStart event lands in the events table with correct columns", async () => {
    await withTempDb(async (dbPath) => {
      const rows = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const db = yield* DuckDbService

          yield* obs.emit({
            ts: "2024-01-01T00:00:00.000Z",
            kind: "SessionStart",
            level: "info",
            sessionId: "sess-abc-123",
            model: "claude-3-5-sonnet",
          })

          // Yield to allow the daemon fiber to process the event
          yield* Effect.sleep("10 millis")

          return yield* db.query(
            "SELECT kind, session_id, level FROM events WHERE kind = ?",
            ["SessionStart"],
          )
        }),
      )

      expect(rows).toHaveLength(1)
      const row = rows[0] as { kind: string; session_id: string; level: string }
      expect(row.kind).toBe("SessionStart")
      expect(row.session_id).toBe("sess-abc-123")
      expect(row.level).toBe("info")
    })
  })

  // ── 2. ToolCall maps tool_name and status ────────────────────────────────

  it("ToolCall event maps tool_name, status, and duration_ms", async () => {
    await withTempDb(async (dbPath) => {
      const rows = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const db = yield* DuckDbService

          yield* obs.emit({
            ts: "2024-01-01T00:00:01.000Z",
            kind: "ToolCall",
            level: "info",
            sessionId: "sess-tool-test",
            toolName: "Bash",
            durationMs: 150,
            status: "success",
          })

          yield* Effect.sleep("10 millis")

          return yield* db.query(
            "SELECT kind, session_id, tool_name, duration_ms, status FROM events WHERE kind = ?",
            ["ToolCall"],
          )
        }),
      )

      expect(rows).toHaveLength(1)
      const row = rows[0] as {
        kind: string
        session_id: string
        tool_name: string
        duration_ms: number
        status: string
      }
      expect(row.kind).toBe("ToolCall")
      expect(row.session_id).toBe("sess-tool-test")
      expect(row.tool_name).toBe("Bash")
      expect(row.duration_ms).toBeCloseTo(150)
      expect(row.status).toBe("success")
    })
  })

  // ── 3. CostAccrued maps financial columns ────────────────────────────────

  it("CostAccrued event maps estimated_usd, tokens_in, tokens_out", async () => {
    await withTempDb(async (dbPath) => {
      const rows = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const db = yield* DuckDbService

          yield* obs.emit({
            ts: "2024-01-01T00:00:02.000Z",
            kind: "CostAccrued",
            level: "info",
            sessionId: "sess-cost-test",
            tokensIn: 500,
            tokensOut: 200,
            cacheRead: 0,
            cacheWrite: 0,
            estimatedUsd: 0.0045,
          })

          yield* Effect.sleep("10 millis")

          return yield* db.query(
            "SELECT kind, session_id, estimated_usd, tokens_in, tokens_out FROM events WHERE kind = ?",
            ["CostAccrued"],
          )
        }),
      )

      expect(rows).toHaveLength(1)
      const row = rows[0] as {
        kind: string
        session_id: string
        estimated_usd: number
        tokens_in: number
        tokens_out: number
      }
      expect(row.kind).toBe("CostAccrued")
      expect(row.session_id).toBe("sess-cost-test")
      expect(row.tokens_in).toBe(500)
      expect(row.tokens_out).toBe(200)
      expect(row.estimated_usd).toBeCloseTo(0.0045)
    })
  })

  // ── 4. Multiple events all land ──────────────────────────────────────────

  it("five events of different kinds all land in the events table", async () => {
    await withTempDb(async (dbPath) => {
      const count = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const db = yield* DuckDbService

          yield* obs.emit({
            ts: "2024-01-01T00:00:00.000Z",
            kind: "SessionStart",
            level: "info",
            sessionId: "sess-multi-1",
            model: "claude-3-5-sonnet",
          })
          yield* obs.emit({
            ts: "2024-01-01T00:00:01.000Z",
            kind: "ToolCall",
            level: "info",
            toolName: "Read",
            durationMs: 10,
            status: "success",
          })
          yield* obs.emit({
            ts: "2024-01-01T00:00:02.000Z",
            kind: "CostAccrued",
            level: "info",
            tokensIn: 100,
            tokensOut: 50,
            cacheRead: 0,
            cacheWrite: 0,
            estimatedUsd: 0.001,
          })
          yield* obs.emit({
            ts: "2024-01-01T00:00:03.000Z",
            kind: "Error",
            level: "error",
            errorTag: "SomeError",
            message: "something went wrong",
          })
          yield* obs.emit({
            ts: "2024-01-01T00:00:04.000Z",
            kind: "SessionEnd",
            level: "info",
            sessionId: "sess-multi-1",
            durationMs: 4000,
          })

          // Yield more generously for 5 events
          yield* Effect.sleep("30 millis")

          const rows = yield* db.query("SELECT COUNT(*) AS n FROM events")
          return (rows[0] as { n: number }).n
        }),
      )

      expect(count).toBe(5)
    })
  })

  // ── 5. Write errors are swallowed — layer stays up ───────────────────────

  it("write errors are swallowed — layer stays up and obs still emits", async () => {
    // No real DB needed — we use a stub DuckDbService that always fails on write.
    // dbPath is only needed for withTempDb's cleanup pattern; we don't use it.
    await withTempDb(async (_dbPath) => {
      // Stub DuckDbService that always fails on write
      const failingDuckDb = Layer.succeed(DuckDbService, {
        exec: (_sql: string) => Effect.void,
        write: (_sql: string, _params?: ReadonlyArray<unknown>) =>
          Effect.fail(new DuckDbError({ op: "write", message: "forced failure" })),
        query: (_sql: string, _params?: ReadonlyArray<unknown>) => Effect.succeed([]),
        migrate: (_component: string, _version: number, _sql: string) => Effect.void,
      })

      const clockLayer = Clock.Default
      const obsLayer = ObservabilityService.Default.pipe(Layer.provide(clockLayer))
      const eventSinkLayer = EventSink.makeLayer().pipe(
        Layer.provide(Layer.mergeAll(obsLayer, failingDuckDb, clockLayer)),
      )

      const composedLayer = Layer.mergeAll(clockLayer, obsLayer, failingDuckDb, eventSinkLayer)

      // Should not throw — write errors must be swallowed
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const obs = yield* ObservabilityService

            yield* obs.emit({
              ts: "2024-01-01T00:00:00.000Z",
              kind: "SessionStart",
              level: "info",
              sessionId: "sess-fire-forget",
              model: "claude-3-5-sonnet",
            })

            // Give the daemon fiber time to attempt (and swallow) the write
            yield* Effect.sleep("10 millis")

            // Emit another — should still work (layer is still up)
            yield* obs.emit({
              ts: "2024-01-01T00:00:01.000Z",
              kind: "Error",
              level: "error",
              errorTag: "test",
              message: "still alive",
            })
          }).pipe(
            Effect.provide(composedLayer as Layer.Layer<ObservabilityService | DuckDbService, never, never>),
          ),
        ),
      )
      // If we get here without throwing, the test passes
      expect(true).toBe(true)
    })
  })

  // ── 6. raw_json contains the full event ──────────────────────────────────

  it("raw_json column contains the full serialized event", async () => {
    await withTempDb(async (dbPath) => {
      const rows = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const db = yield* DuckDbService

          const originalEvent = {
            ts: "2024-06-15T12:34:56.789Z",
            kind: "WorkflowTransition" as const,
            level: "info" as const,
            workflowId: "wf-xyz-999",
            from: "idle",
            to: "running",
          }

          yield* obs.emit(originalEvent)

          yield* Effect.sleep("10 millis")

          return yield* db.query(
            "SELECT raw_json FROM events WHERE kind = ?",
            ["WorkflowTransition"],
          )
        }),
      )

      expect(rows).toHaveLength(1)
      const row = rows[0] as { raw_json: string }
      expect(typeof row.raw_json).toBe("string")

      const parsed = JSON.parse(row.raw_json) as Record<string, unknown>
      expect(parsed.kind).toBe("WorkflowTransition")
      expect(parsed.workflowId).toBe("wf-xyz-999")
      expect(parsed.from).toBe("idle")
      expect(parsed.to).toBe("running")
      expect(parsed.ts).toBe("2024-06-15T12:34:56.789Z")
    })
  })
})
