/**
 * SessionSync tests — TDD PING phase.
 *
 * SessionSync is a side-effect-only Layer.scoped that:
 *   1. Eagerly subscribes to ObservabilityService.subscribeEvents
 *   2. Runs a forkDaemon background fiber filtering for SessionStart/SessionEnd
 *   3. On SessionStart: INSERT OR IGNORE into sessions table (idempotent upsert)
 *   4. On SessionEnd: UPDATE sessions row — ended_at, duration_ms, status='closed'
 *   5. Schema migration applied at boot
 *   6. Write errors swallowed — observability must never kill the host
 *
 * Tests use:
 *   - ObservabilityService.Default (real in-memory PubSub)
 *   - Real makeDuckDbLayer with a temp file DB
 *   - Effect.sleep("10 millis") after emit to yield to the daemon fiber
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"

import { ObservabilityService } from "../observability/observability.js"
import { DuckDbError, DuckDbService, makeDuckDbLayer } from "../db/duckdb-service.js"
import { Clock } from "../clock.js"
import { SessionSync } from "./session-sync.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Unique temp DB file per test; cleaned up in finally. */
const withTempDb = <A>(fn: (dbPath: string) => Promise<A>): Promise<A> => {
  const dbPath = path.join(
    os.tmpdir(),
    `luna-session-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}.duckdb`,
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
 *   Clock.Default                — provides Clock
 *   makeDuckDbLayer              — provides DuckDbService (no Clock dep)
 *   ObservabilityService.Default — requires Clock
 *   SessionSync.makeLayer()      — requires ObservabilityService + DuckDbService + Clock
 */
const makeTestLayer = (dbPath: string) => {
  const clockLayer = Clock.Default
  const duckLayer = makeDuckDbLayer({ dbPath })
  const obsLayer = ObservabilityService.Default.pipe(Layer.provide(clockLayer))
  const sessionSyncLayer = SessionSync.makeLayer().pipe(
    Layer.provide(Layer.mergeAll(obsLayer, duckLayer, clockLayer)),
  )
  return Layer.mergeAll(clockLayer, duckLayer, obsLayer, sessionSyncLayer)
}

/** Run an effect inside a scoped managed runtime with the test layer. */
const runWithLayer =
  (dbPath: string) =>
  <A>(
    eff: Effect.Effect<A, unknown, ObservabilityService | DuckDbService>,
  ): Promise<A> => {
    const layer = makeTestLayer(dbPath)
    return Effect.runPromise(
      Effect.scoped(
        eff.pipe(
          Effect.provide(
            layer as Layer.Layer<
              ObservabilityService | DuckDbService,
              never,
              never
            >,
          ),
        ),
      ),
    )
  }

// ── Row type returned by queries ──────────────────────────────────────────────

interface SessionRow {
  id: string
  parent_id: string | null
  model: string
  title: string | null
  tags: string | null
  status: string
  created_at: string
  ended_at: string | null
  duration_ms: number | null
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SessionSync", () => {
  // ── 1. SessionStart creates a sessions row ────────────────────────────────

  it("SessionStart creates a sessions row with status='active'", async () => {
    await withTempDb(async (dbPath) => {
      const rows = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const db = yield* DuckDbService

          yield* obs.emit({
            ts: "2024-01-01T00:00:00.000Z",
            kind: "SessionStart",
            level: "info",
            sessionId: "sess-001",
            model: "claude-3-5-sonnet",
          })

          // Yield to allow the daemon fiber to process the event
          yield* Effect.sleep("10 millis")

          return yield* db.query(
            "SELECT id, model, status, created_at FROM sessions WHERE id = ?",
            ["sess-001"],
          )
        }),
      )

      expect(rows).toHaveLength(1)
      const row = rows[0] as SessionRow
      expect(row.id).toBe("sess-001")
      expect(row.model).toBe("claude-3-5-sonnet")
      expect(row.status).toBe("active")
      expect(row.created_at).toBe("2024-01-01T00:00:00.000Z")
    })
  })

  // ── 2. SessionStart with optional fields ──────────────────────────────────

  it("SessionStart with parentId, tags, title populates all optional columns", async () => {
    await withTempDb(async (dbPath) => {
      const rows = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const db = yield* DuckDbService

          yield* obs.emit({
            ts: "2024-01-02T00:00:00.000Z",
            kind: "SessionStart",
            level: "info",
            sessionId: "sess-002",
            model: "claude-opus-4",
            parentId: "sess-parent-99",
            tags: ["billing", "prod"],
            title: "My Session",
          })

          yield* Effect.sleep("10 millis")

          return yield* db.query(
            "SELECT id, parent_id, model, title, tags, status FROM sessions WHERE id = ?",
            ["sess-002"],
          )
        }),
      )

      expect(rows).toHaveLength(1)
      const row = rows[0] as SessionRow
      expect(row.id).toBe("sess-002")
      expect(row.parent_id).toBe("sess-parent-99")
      expect(row.model).toBe("claude-opus-4")
      expect(row.title).toBe("My Session")
      // tags stored as JSON array string
      expect(JSON.parse(row.tags as string)).toEqual(["billing", "prod"])
      expect(row.status).toBe("active")
    })
  })

  // ── 3. SessionEnd updates the row ─────────────────────────────────────────

  it("SessionEnd updates ended_at, duration_ms, and status to 'closed'", async () => {
    await withTempDb(async (dbPath) => {
      const rows = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const db = yield* DuckDbService

          yield* obs.emit({
            ts: "2024-01-03T00:00:00.000Z",
            kind: "SessionStart",
            level: "info",
            sessionId: "sess-003",
            model: "claude-3-5-haiku",
          })

          yield* Effect.sleep("10 millis")

          yield* obs.emit({
            ts: "2024-01-03T00:01:00.000Z",
            kind: "SessionEnd",
            level: "info",
            sessionId: "sess-003",
            durationMs: 60000,
          })

          yield* Effect.sleep("10 millis")

          return yield* db.query(
            "SELECT id, status, ended_at, duration_ms FROM sessions WHERE id = ?",
            ["sess-003"],
          )
        }),
      )

      expect(rows).toHaveLength(1)
      const row = rows[0] as SessionRow
      expect(row.id).toBe("sess-003")
      expect(row.status).toBe("closed")
      expect(row.ended_at).toBe("2024-01-03T00:01:00.000Z")
      expect(row.duration_ms).toBeCloseTo(60000)
    })
  })

  // ── 4. SessionEnd for unknown session is a no-op ──────────────────────────

  it("SessionEnd for unknown session is a no-op (no error, no row created)", async () => {
    await withTempDb(async (dbPath) => {
      const rows = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const db = yield* DuckDbService

          // Emit SessionEnd without a prior SessionStart
          yield* obs.emit({
            ts: "2024-01-04T00:01:00.000Z",
            kind: "SessionEnd",
            level: "info",
            sessionId: "sess-ghost",
            durationMs: 5000,
          })

          yield* Effect.sleep("10 millis")

          return yield* db.query("SELECT COUNT(*) AS n FROM sessions")
        }),
      )

      const count = (rows[0] as { n: number }).n
      expect(count).toBe(0)
    })
  })

  // ── 5. SessionStart is idempotent ─────────────────────────────────────────

  it("emitting SessionStart twice for the same sessionId yields only one row", async () => {
    await withTempDb(async (dbPath) => {
      const rows = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const db = yield* DuckDbService

          yield* obs.emit({
            ts: "2024-01-05T00:00:00.000Z",
            kind: "SessionStart",
            level: "info",
            sessionId: "sess-dupe",
            model: "claude-3-5-sonnet",
          })

          yield* Effect.sleep("10 millis")

          // Second emit — same sessionId
          yield* obs.emit({
            ts: "2024-01-05T00:00:01.000Z",
            kind: "SessionStart",
            level: "info",
            sessionId: "sess-dupe",
            model: "claude-3-5-sonnet",
          })

          yield* Effect.sleep("10 millis")

          return yield* db.query(
            "SELECT COUNT(*) AS n FROM sessions WHERE id = ?",
            ["sess-dupe"],
          )
        }),
      )

      const count = (rows[0] as { n: number }).n
      expect(count).toBe(1)
    })
  })

  // ── 6. Non-session events are ignored ────────────────────────────────────

  it("non-session events (ToolCall, Error) do not produce rows in sessions table", async () => {
    await withTempDb(async (dbPath) => {
      const rows = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const db = yield* DuckDbService

          yield* obs.emit({
            ts: "2024-01-06T00:00:00.000Z",
            kind: "ToolCall",
            level: "info",
            toolName: "Bash",
            durationMs: 50,
            status: "success",
          })

          yield* obs.emit({
            ts: "2024-01-06T00:00:01.000Z",
            kind: "Error",
            level: "error",
            errorTag: "SomeError",
            message: "oops",
          })

          yield* Effect.sleep("10 millis")

          return yield* db.query("SELECT COUNT(*) AS n FROM sessions")
        }),
      )

      const count = (rows[0] as { n: number }).n
      expect(count).toBe(0)
    })
  })

  // ── 7. Two independent sessions tracked ──────────────────────────────────

  it("two distinct sessionIds produce two independent rows", async () => {
    await withTempDb(async (dbPath) => {
      const rows = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const db = yield* DuckDbService

          yield* obs.emit({
            ts: "2024-01-07T00:00:00.000Z",
            kind: "SessionStart",
            level: "info",
            sessionId: "sess-alpha",
            model: "claude-3-5-sonnet",
          })

          yield* obs.emit({
            ts: "2024-01-07T00:00:01.000Z",
            kind: "SessionStart",
            level: "info",
            sessionId: "sess-beta",
            model: "claude-opus-4",
          })

          yield* Effect.sleep("30 millis")

          return yield* db.query(
            "SELECT id, model, status FROM sessions ORDER BY id",
          )
        }),
      )

      expect(rows).toHaveLength(2)
      const [alpha, beta] = rows as SessionRow[]
      expect(alpha.id).toBe("sess-alpha")
      expect(alpha.model).toBe("claude-3-5-sonnet")
      expect(alpha.status).toBe("active")
      expect(beta.id).toBe("sess-beta")
      expect(beta.model).toBe("claude-opus-4")
      expect(beta.status).toBe("active")
    })
  })

  // ── Health counters (issue #11) ──────────────────────────────────────────

  it("health() reports eventsReceived + eventsWritten after Start/End", async () => {
    await withTempDb(async (dbPath) => {
      const snap = await runWithLayer(dbPath)(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const sync = yield* SessionSync

          yield* obs.emit({
            ts: "2024-07-01T00:00:00.000Z",
            kind: "SessionStart",
            level: "info",
            sessionId: "sess-hs1",
            model: "claude-3-5-sonnet",
          })
          yield* obs.emit({
            ts: "2024-07-01T00:00:05.000Z",
            kind: "SessionEnd",
            level: "info",
            sessionId: "sess-hs1",
            durationMs: 5000,
          })
          // Non-session events MUST NOT count
          yield* obs.emit({
            ts: "2024-07-01T00:00:06.000Z",
            kind: "Error",
            level: "error",
            errorTag: "ignore",
            message: "x",
          })

          yield* Effect.sleep("20 millis")
          return yield* sync.health
        }),
      )

      expect(snap.eventsReceived).toBe(2)
      expect(snap.eventsWritten).toBe(2)
      expect(snap.writeFailures).toBe(0)
      expect(snap.lastWriteAt).toBe("2024-07-01T00:00:05.000Z")
    })
  })

  it("health() reports writeFailures when DuckDB write fails", async () => {
    await withTempDb(async (_dbPath) => {
      const failing = Layer.succeed(DuckDbService, {
        exec: () => Effect.void,
        write: () =>
          Effect.fail(new DuckDbError({ op: "write", message: "boom" })),
        query: () => Effect.succeed([]),
        migrate: () => Effect.void,
      })
      const clockLayer = Clock.Default
      const obsLayer = ObservabilityService.Default.pipe(Layer.provide(clockLayer))
      const sLayer = SessionSync.makeLayer().pipe(
        Layer.provide(Layer.mergeAll(obsLayer, failing, clockLayer)),
      )
      const composed = Layer.mergeAll(clockLayer, obsLayer, failing, sLayer)

      const snap = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const obs = yield* ObservabilityService
            const sync = yield* SessionSync

            yield* obs.emit({
              ts: "2024-07-02T00:00:00.000Z",
              kind: "SessionStart",
              level: "info",
              sessionId: "sess-fail",
              model: "claude-3-5-sonnet",
            })
            yield* Effect.sleep("20 millis")
            return yield* sync.health
          }).pipe(
            Effect.provide(
              composed as Layer.Layer<
                ObservabilityService | DuckDbService | SessionSync,
                never,
                never
              >,
            ),
          ),
        ),
      )

      expect(snap.eventsReceived).toBe(1)
      expect(snap.eventsWritten).toBe(0)
      expect(snap.writeFailures).toBe(1)
      expect(snap.lastFailureReason).toContain("boom")
    })
  })
})
