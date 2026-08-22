/**
 * AnalyticsService integration tests — real DuckDbService (:memory:) backend.
 *
 * Each test inserts data via DuckDbService, then queries via AnalyticsService.
 * No mocks — real SQL against a real in-process SQLite-compatible store.
 *
 * BDD structure: Given / When / Then
 */

import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { AnalyticsService } from "./analytics.js"
import { DuckDbService, makeDuckDbLayer } from "../db/duckdb-service.js"

// ── Test layer helpers ────────────────────────────────────────────────────────

// A single shared DuckDb layer. Layer.effect means it's re-created per test
// run when we call makeTestLayer(). ":memory:" gives an isolated in-process DB.
const makeDuckDb = () => makeDuckDbLayer({ dbPath: ":memory:" })

// Composed layer: DuckDbService + AnalyticsService built on top of it.
// Layer.provide wires the DuckDbLayer as the requirement for AnalyticsLayer,
// but the DuckDbService is ALSO exposed in the output so test effects can use it.
const makeTestLayer = () => {
  const dbLayer = makeDuckDb()
  const analyticsLayer = AnalyticsService.makeLayer({ dbPath: ":memory:" }).pipe(
    Layer.provide(dbLayer),
  )
  // Merge both layers so both AnalyticsService and DuckDbService are in context
  return Layer.merge(analyticsLayer, dbLayer)
}

// Helper: run an effect with the full test layer (both AnalyticsService + DuckDbService)
const run = <A>(
  effect: Effect.Effect<A, unknown, AnalyticsService | DuckDbService>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(makeTestLayer()),
    ),
  )

// Helper: insert a session row
const insertSession = (
  id: string,
  opts: {
    model?: string
    created_at?: string
    ended_at?: string
    duration_ms?: number
    status?: string
  } = {},
) => {
  const model = opts.model ?? "claude-3-5-sonnet"
  const created_at = opts.created_at ?? new Date().toISOString()
  const ended_at = opts.ended_at ?? null
  const duration_ms = opts.duration_ms ?? null
  const status = opts.status ?? (ended_at ? "closed" : "active")

  return Effect.gen(function* () {
    const db = yield* DuckDbService
    yield* db.write(
      `INSERT OR IGNORE INTO sessions (id, model, status, created_at, ended_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, model, status, created_at, ended_at, duration_ms],
    )
  })
}

// Helper: insert an event row
const insertEvent = (
  sessionId: string,
  opts: {
    kind?: string
    tool_name?: string
    status?: string
    duration_ms?: number
  } = {},
) => {
  const id = crypto.randomUUID()
  const kind = opts.kind ?? "ToolCall"
  const tool_name = opts.tool_name ?? null
  const status = opts.status ?? "success"
  const duration_ms = opts.duration_ms ?? null

  return Effect.gen(function* () {
    const db = yield* DuckDbService
    yield* db.write(
      `INSERT OR IGNORE INTO events
         (id, ts, kind, level, session_id, tool_name, status, duration_ms, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        new Date().toISOString(),
        kind,
        "info",
        sessionId,
        tool_name,
        status,
        duration_ms,
        "{}",
      ],
    )
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AnalyticsService (real DuckDb)", () => {
  // ── querySessionMetrics ───────────────────────────────────────────────────

  describe("querySessionMetrics", () => {
    it("Given no data, When querying metrics, Then returns empty result", async () => {
      const result = await run(
        Effect.gen(function* () {
          const api = yield* AnalyticsService
          return yield* api.querySessionMetrics({ limit: 100 })
        }),
      )

      expect(result.sessions).toEqual([])
      expect(result.summary.totalSessions).toBe(0)
      expect(result.summary.totalMessages).toBe(0)
      expect(result.summary.errorRate).toBe(0)
    })

    it("Given a session with events, When querying metrics, Then returns aggregated data", async () => {
      const result = await run(
        Effect.gen(function* () {
          const api = yield* AnalyticsService

          // Given: one session with two ToolCall events
          yield* insertSession("sess-001")
          yield* insertEvent("sess-001", { kind: "ToolCall", tool_name: "Read", status: "success" })
          yield* insertEvent("sess-001", { kind: "ToolCall", tool_name: "Grep", status: "success" })

          // When: query all sessions
          return yield* api.querySessionMetrics({})
        }),
      )

      // Then: session is found with aggregated counts
      expect(result.sessions).toHaveLength(1)
      expect(result.sessions[0]?.sessionId).toBe("sess-001")
      expect(result.summary.totalSessions).toBe(1)
      expect(result.summary.totalToolUses).toBe(2)
    })

    it("Given multiple sessions, When filtering by sessionId, Then returns only that session", async () => {
      const result = await run(
        Effect.gen(function* () {
          const api = yield* AnalyticsService

          // Given: two sessions
          yield* insertSession("sess-filter-a")
          yield* insertSession("sess-filter-b")
          yield* insertEvent("sess-filter-a", { kind: "ToolCall", tool_name: "Read" })
          yield* insertEvent("sess-filter-b", { kind: "ToolCall", tool_name: "Write" })

          // When: filter by sessionId
          return yield* api.querySessionMetrics({ sessionId: "sess-filter-a" })
        }),
      )

      // Then: only session A is returned
      expect(result.sessions).toHaveLength(1)
      expect(result.sessions[0]?.sessionId).toBe("sess-filter-a")
      expect(result.summary.totalSessions).toBe(1)
    })

    it("Given sessions with events, When filtering by toolName, Then returns only sessions using that tool", async () => {
      const result = await run(
        Effect.gen(function* () {
          const api = yield* AnalyticsService

          // Given: two sessions — one uses Bash, one uses Read
          yield* insertSession("sess-tool-bash")
          yield* insertSession("sess-tool-read")
          yield* insertEvent("sess-tool-bash", { kind: "ToolCall", tool_name: "Bash" })
          yield* insertEvent("sess-tool-read", { kind: "ToolCall", tool_name: "Read" })

          // When: filter by tool_name = "Bash"
          return yield* api.querySessionMetrics({ toolName: "Bash" })
        }),
      )

      // Then: only the Bash session appears
      expect(result.sessions).toHaveLength(1)
      expect(result.sessions[0]?.sessionId).toBe("sess-tool-bash")
    })

    it("Given sessions, When filtering by time range, Then only sessions in range are returned", async () => {
      const past = "2024-01-01T00:00:00.000Z"
      const present = "2025-05-01T00:00:00.000Z"
      const future = "2026-12-31T00:00:00.000Z"

      const result = await run(
        Effect.gen(function* () {
          const api = yield* AnalyticsService

          // Given: two sessions at different times
          yield* insertSession("sess-time-old", { created_at: past })
          yield* insertSession("sess-time-new", { created_at: present })

          // When: query only from 2025 onward
          return yield* api.querySessionMetrics({ startTime: "2025-01-01T00:00:00.000Z", endTime: future })
        }),
      )

      // Then: only the 2025 session is returned
      const ids = result.sessions.map((s) => s.sessionId)
      expect(ids).toContain("sess-time-new")
      expect(ids).not.toContain("sess-time-old")
    })

    it("Summary metrics are consistent with session list totals", async () => {
      const result = await run(
        Effect.gen(function* () {
          const api = yield* AnalyticsService

          // Given: two sessions with different event counts
          yield* insertSession("sess-sum-1")
          yield* insertSession("sess-sum-2")
          yield* insertEvent("sess-sum-1", { kind: "ToolCall", tool_name: "Read" })
          yield* insertEvent("sess-sum-1", { kind: "ToolCall", tool_name: "Read" })
          yield* insertEvent("sess-sum-2", { kind: "ToolCall", tool_name: "Grep" })

          // When: query all sessions
          return yield* api.querySessionMetrics({})
        }),
      )

      // Then: summary counts match derived values
      expect(result.summary.totalSessions).toBe(result.sessions.length)
      const derivedMessages = result.sessions.reduce(
        (sum, s) => sum + s.messageCount,
        0,
      )
      expect(result.summary.totalMessages).toBe(derivedMessages)
    })
  })

  // ── explainSession ────────────────────────────────────────────────────────

  describe("explainSession", () => {
    it("Given a session with tool calls, When explaining, Then returns per-tool breakdown", async () => {
      const result = await run(
        Effect.gen(function* () {
          const api = yield* AnalyticsService

          // Given: a session with multiple tool calls
          yield* insertSession("sess-explain-1")
          yield* insertEvent("sess-explain-1", { kind: "ToolCall", tool_name: "Read", status: "success" })
          yield* insertEvent("sess-explain-1", { kind: "ToolCall", tool_name: "Read", status: "success" })
          yield* insertEvent("sess-explain-1", { kind: "ToolCall", tool_name: "Bash", status: "error" })

          // When: explain that session
          return yield* api.explainSession("sess-explain-1")
        }),
      )

      // Then: tool usage counts are correct
      expect(result.sessionId).toBe("sess-explain-1")
      expect(result.metrics.toolUsageCount["Read"]).toBe(2)
      expect(result.metrics.toolUsageCount["Bash"]).toBe(1)
      expect(result.metrics.errorCount).toBe(1)
      expect(result.metrics.successCount).toBe(2)
      expect(result.messageCount).toBe(3)
    })

    it("Given an unknown sessionId, When explaining, Then returns empty shell with zero counts", async () => {
      const result = await run(
        Effect.gen(function* () {
          const api = yield* AnalyticsService
          // No setup — session does not exist
          return yield* api.explainSession("sess-nonexistent-xyz")
        }),
      )

      expect(result.sessionId).toBe("sess-nonexistent-xyz")
      expect(result.messageCount).toBe(0)
      expect(result.metrics.errorCount).toBe(0)
      expect(result.metrics.toolUsageCount).toEqual({})
    })
  })

  // ── findAnomalies ─────────────────────────────────────────────────────────

  describe("findAnomalies", () => {
    it("Given a session with high error rate, When finding anomalies below threshold, Then it is returned", async () => {
      const now = new Date().toISOString()
      const ended = new Date(Date.now() + 1000).toISOString()

      const results = await run(
        Effect.gen(function* () {
          const api = yield* AnalyticsService

          // Given: one closed session with 2 errors out of 3 events (~66% error rate)
          yield* insertSession("sess-anomaly-high", {
            created_at: now,
            ended_at: ended,
            duration_ms: 1000,
            status: "closed",
          })
          yield* insertEvent("sess-anomaly-high", { kind: "ToolCall", tool_name: "Bash", status: "error" })
          yield* insertEvent("sess-anomaly-high", { kind: "ToolCall", tool_name: "Bash", status: "error" })
          yield* insertEvent("sess-anomaly-high", { kind: "ToolCall", tool_name: "Read", status: "success" })

          // When: find anomalies with errorRate threshold of 0.5
          return yield* api.findAnomalies({ errorRate: 0.5 })
        }),
      )

      // Then: the high-error session is returned
      const ids = results.map((r) => r.sessionId)
      expect(ids).toContain("sess-anomaly-high")
      const s = results.find((r) => r.sessionId === "sess-anomaly-high")
      expect(s?.metrics.errorCount).toBe(2)
    })

    it("Given a session with low error rate, When finding anomalies at high threshold, Then it is NOT returned", async () => {
      const now = new Date().toISOString()
      const ended = new Date(Date.now() + 1000).toISOString()

      const results = await run(
        Effect.gen(function* () {
          const api = yield* AnalyticsService

          // Given: one closed session with 1 error out of 10 events (10% error rate)
          yield* insertSession("sess-anomaly-low", {
            created_at: now,
            ended_at: ended,
            duration_ms: 1000,
            status: "closed",
          })
          for (let i = 0; i < 9; i++) {
            yield* insertEvent("sess-anomaly-low", { kind: "ToolCall", tool_name: "Read", status: "success" })
          }
          yield* insertEvent("sess-anomaly-low", { kind: "ToolCall", tool_name: "Bash", status: "error" })

          // When: find anomalies with errorRate threshold of 0.5 (50%)
          return yield* api.findAnomalies({ errorRate: 0.5 })
        }),
      )

      // Then: the low-error session is NOT returned
      const ids = results.map((r) => r.sessionId)
      expect(ids).not.toContain("sess-anomaly-low")
    })

    it("Given a long-running session, When finding anomalies by duration, Then it is returned", async () => {
      const now = new Date().toISOString()
      const ended = new Date(Date.now() + 1000).toISOString()

      const results = await run(
        Effect.gen(function* () {
          const api = yield* AnalyticsService

          // Given: one closed session with 4h duration
          yield* insertSession("sess-long", {
            created_at: now,
            ended_at: ended,
            duration_ms: 4 * 3600 * 1000, // 4 hours
            status: "closed",
          })
          yield* insertEvent("sess-long", { kind: "ToolCall", tool_name: "Read", status: "success" })

          // When: find anomalies with duration threshold of 3h — session exceeds it
          // Use a very high error rate so only duration triggers
          return yield* api.findAnomalies({
            errorRate: 0.99, // unreachable for success-only session
            duration: 3 * 3600 * 1000,
          })
        }),
      )

      // Then: the long session is found via duration trigger
      const ids = results.map((r) => r.sessionId)
      expect(ids).toContain("sess-long")
    })

    it("Given only active sessions (no ended_at), When finding anomalies, Then returns empty", async () => {
      const results = await run(
        Effect.gen(function* () {
          const api = yield* AnalyticsService

          // Given: active session with errors but not ended
          yield* insertSession("sess-active-only", { status: "active" })
          yield* insertEvent("sess-active-only", { kind: "ToolCall", tool_name: "Bash", status: "error" })

          // When: find anomalies (only closed sessions qualify)
          return yield* api.findAnomalies({ errorRate: 0.0 })
        }),
      )

      // Then: no results (WHERE ended_at IS NOT NULL filters them out)
      const ids = results.map((r) => r.sessionId)
      expect(ids).not.toContain("sess-active-only")
    })
  })
})
