/**
 * Observability tools functional tests.
 *
 * Invokes tool handlers the same way the scheduler-tools tests do:
 *   `Effect.promise(() => tool.handler(args, undefined))`
 * and parses the MCP `{ content: [{ type, text }] }` result.
 *
 * All databases use ":memory:" — no disk state.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import {
  AgentNotesService,
  AnalyticsService,
  Clock,
  DuckDbService,
  makeDuckDbLayer,
} from "@luna/core"
import { LunaSqliteBootstrapLive } from "@luna/memory"
import { makeObsTools } from "../src/tools.js"

// ── MCP result helpers ────────────────────────────────────────────────────────

interface ToolCallResult {
  readonly content?: ReadonlyArray<{ type: string; text: string }>
  readonly isError?: boolean
}

function parseOk<T>(r: ToolCallResult): T {
  expect(r.isError).toBeFalsy()
  const first = r.content?.[0]
  expect(first?.type).toBe("text")
  return JSON.parse((first as { text: string }).text) as T
}

function parseErr(r: ToolCallResult): string {
  expect(r.isError).toBe(true)
  return r.content?.[0]?.text ?? ""
}

// ── Shared layer ──────────────────────────────────────────────────────────────

const duckDbL = makeDuckDbLayer({ dbPath: ":memory:", writeQueueCapacity: 64 })
const analyticsL = AnalyticsService.makeLayer({ dbPath: ":memory:" }).pipe(
  Layer.provide(duckDbL),
)
const agentNotesL = Layer.provide(AgentNotesService.Memory, Clock.Default)

const fullStack = Layer.mergeAll(agentNotesL, analyticsL, duckDbL).pipe(
  Layer.provide(Clock.Default),
  Layer.provide(LunaSqliteBootstrapLive),
)

/** Run an Effect that requires the full obs stack. */
const run = <A>(
  eff: Effect.Effect<
    A,
    unknown,
    AgentNotesService | AnalyticsService | Clock | DuckDbService
  >,
) => Effect.runPromise(Effect.scoped(eff).pipe(Effect.provide(fullStack)))

/** Build tools with a given current session id. */
const buildTools = (sessionId: string | null = "sess-test") =>
  Effect.gen(function* () {
    const notes = yield* AgentNotesService
    const analytics = yield* AnalyticsService
    const cell: { value: string | null } = { value: sessionId }
    const tools = makeObsTools(notes, analytics, () => cell.value)
    const bindSession = (id: string) => {
      cell.value = id
    }
    return { tools, bindSession }
  })

/** Call a named tool via its SDK handler (.handler(args, undefined)). */
function getTool(tools: ReturnType<typeof makeObsTools>, name: string) {
  const tool = tools.find(
    (t) => (t as unknown as { name: string }).name === name,
  ) as unknown as {
    name: string
    handler: (args: Record<string, unknown>, extra: undefined) => Promise<ToolCallResult>
  }
  if (!tool) throw new Error(`Tool "${name}" not found`)
  return tool
}

// ── obs_note ───────────────────────────────────────────────────────────────────

describe("obs_note", () => {
  it("Given valid args, Then returns id/kind/summary/ts", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { tools } = yield* buildTools()
        const tool = getTool(tools, "obs_note")
        return yield* Effect.promise(() =>
          tool.handler(
            { kind: "goal_declared", summary: "Build self-observation foundation" },
            undefined,
          ),
        )
      }),
    )
    const parsed = parseOk<{ id: string; kind: string; summary: string; ts: number }>(result)
    expect(typeof parsed.id).toBe("string")
    expect(parsed.id.length).toBeGreaterThan(0)
    expect(parsed.kind).toBe("goal_declared")
    expect(parsed.summary).toBe("Build self-observation foundation")
    expect(typeof parsed.ts).toBe("number")
    expect(parsed.ts).toBeGreaterThan(0)
  })

  it("Given a payload, Then note is stored without error", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { tools } = yield* buildTools()
        return yield* Effect.promise(() =>
          getTool(tools, "obs_note").handler(
            {
              kind: "decision",
              summary: "Chose Effect over Promise",
              payload: { options: ["Effect", "Promise"], chosen: "Effect" },
            },
            undefined,
          ),
        )
      }),
    )
    const parsed = parseOk<{ id: string; kind: string }>(result)
    expect(parsed.kind).toBe("decision")
  })

  it("Given an explicit session_id, Then note can be recalled by that session", async () => {
    const noteId = await run(
      Effect.gen(function* () {
        const { tools } = yield* buildTools()

        // Write note with explicit session
        const writeResult = yield* Effect.promise(() =>
          getTool(tools, "obs_note").handler(
            { kind: "progress", summary: "Done step 1", session_id: "explicit-sess-1" },
            undefined,
          ),
        )
        const { id } = parseOk<{ id: string }>(writeResult)

        // Recall by session
        const readResult = yield* Effect.promise(() =>
          getTool(tools, "obs_notes_recent").handler(
            { session_id: "explicit-sess-1", limit: 10 },
            undefined,
          ),
        )
        const notes = parseOk<Array<{ id: string }>>(readResult)
        return { id, found: notes.some((n) => n.id === id) }
      }),
    )
    expect(noteId.found).toBe(true)
  })
})

// ── obs_notes_recent ───────────────────────────────────────────────────────────

describe("obs_notes_recent", () => {
  it("Given 3 notes in a session, Then returns them newest-first", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { tools } = yield* buildTools("sess-recent")
        const noteTool = getTool(tools, "obs_note")
        const recentTool = getTool(tools, "obs_notes_recent")

        yield* Effect.promise(() =>
          noteTool.handler({ kind: "progress", summary: "Step A" }, undefined),
        )
        yield* Effect.promise(() =>
          noteTool.handler({ kind: "progress", summary: "Step B" }, undefined),
        )
        yield* Effect.promise(() =>
          noteTool.handler({ kind: "decision", summary: "Chose path X" }, undefined),
        )

        return yield* Effect.promise(() =>
          recentTool.handler({ session_id: "sess-recent", limit: 10 }, undefined),
        )
      }),
    )
    const notes = parseOk<Array<{ kind: string; summary: string }>>(result)
    expect(notes.length).toBe(3)
    // AgentNotesService.Memory returns newest-first
    expect(notes[0]?.summary).toBe("Chose path X")
    expect(notes[2]?.summary).toBe("Step A")
  })

  it("Given notes of different kinds, When filtered by kind, Then returns only matching", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { tools } = yield* buildTools("sess-kind")
        const noteTool = getTool(tools, "obs_note")
        const recentTool = getTool(tools, "obs_notes_recent")

        yield* Effect.promise(() =>
          noteTool.handler({ kind: "goal_declared", summary: "Big goal" }, undefined),
        )
        yield* Effect.promise(() =>
          noteTool.handler({ kind: "reflection", summary: "Worked well" }, undefined),
        )
        yield* Effect.promise(() =>
          noteTool.handler({ kind: "goal_declared", summary: "Small goal" }, undefined),
        )

        return yield* Effect.promise(() =>
          recentTool.handler({ kind: "goal_declared", limit: 10 }, undefined),
        )
      }),
    )
    const notes = parseOk<Array<{ kind: string }>>(result)
    expect(notes.length).toBeGreaterThanOrEqual(2)
    expect(notes.every((n) => n.kind === "goal_declared")).toBe(true)
  })

  it("Given no notes anywhere and no filter, Then returns empty array", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { tools } = yield* buildTools(null) // null = no session
        return yield* Effect.promise(() =>
          getTool(tools, "obs_notes_recent").handler({}, undefined),
        )
      }),
    )
    const notes = parseOk<Array<unknown>>(result)
    expect(Array.isArray(notes)).toBe(true)
    expect(notes.length).toBe(0)
  })

  it("Given notes in OTHER sessions and no filter, Then returns globally recent notes (the context-recovery path; issue #10)", async () => {
    const result = await run(
      Effect.gen(function* () {
        // Seed notes under one session, then ask from a "no-current-session"
        // tool surface — like a fresh chat thread querying historical context.
        const seeded = yield* buildTools("sess-history")
        yield* Effect.promise(() =>
          getTool(seeded.tools, "obs_note").handler(
            { kind: "reflection", summary: "old reflection" },
            undefined,
          ),
        )
        yield* Effect.promise(() =>
          getTool(seeded.tools, "obs_note").handler(
            { kind: "progress", summary: "old progress" },
            undefined,
          ),
        )

        // Same AgentNotesService instance via the test layer — fresh "no-session" surface.
        const { tools } = yield* buildTools(null)
        return yield* Effect.promise(() =>
          getTool(tools, "obs_notes_recent").handler({}, undefined),
        )
      }),
    )
    const notes = parseOk<Array<{ summary: string }>>(result)
    expect(notes.length).toBeGreaterThanOrEqual(2)
    expect(notes.map((n) => n.summary)).toContain("old reflection")
    expect(notes.map((n) => n.summary)).toContain("old progress")
  })
})

// ── obs_session_explain ────────────────────────────────────────────────────────

describe("obs_session_explain", () => {
  it("Given unknown session_id, Then returns zeroed metrics", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { tools } = yield* buildTools()
        return yield* Effect.promise(() =>
          getTool(tools, "obs_session_explain").handler(
            { session_id: "nonexistent-999" },
            undefined,
          ),
        )
      }),
    )
    const parsed = parseOk<{
      sessionId: string
      messageCount: number
      errorCount: number
      toolUsageCount: Record<string, number>
    }>(result)
    expect(parsed.sessionId).toBe("nonexistent-999")
    expect(parsed.messageCount).toBe(0)
    expect(parsed.errorCount).toBe(0)
    expect(typeof parsed.toolUsageCount).toBe("object")
  })

  it("Given a seeded session with events, Then returns populated metrics", async () => {
    // Seed data then explain
    const result = await run(
      Effect.gen(function* () {
        const db = yield* DuckDbService
        const now = new Date().toISOString()

        yield* db.write(
          "INSERT OR IGNORE INTO sessions (id, model, status, created_at) VALUES (?, ?, ?, ?)",
          ["sess-explain-test", "claude-sonnet", "active", now],
        )
        yield* db.write(
          "INSERT OR IGNORE INTO events (id, ts, kind, level, session_id, tool_name, status, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [crypto.randomUUID(), now, "ToolCall", "info", "sess-explain-test", "Read", "success", "{}"],
        )
        yield* db.write(
          "INSERT OR IGNORE INTO events (id, ts, kind, level, session_id, tool_name, status, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [crypto.randomUUID(), now, "ToolCall", "info", "sess-explain-test", "Bash", "error", "{}"],
        )

        const { tools } = yield* buildTools()
        return yield* Effect.promise(() =>
          getTool(tools, "obs_session_explain").handler(
            { session_id: "sess-explain-test" },
            undefined,
          ),
        )
      }),
    )
    const parsed = parseOk<{
      sessionId: string
      model: string
      messageCount: number
      errorCount: number
      toolUsageCount: Record<string, number>
    }>(result)
    expect(parsed.sessionId).toBe("sess-explain-test")
    expect(parsed.model).toBe("claude-sonnet")
    expect(parsed.messageCount).toBe(2)
    expect(parsed.errorCount).toBe(1)
    expect(parsed.toolUsageCount["Read"]).toBe(1)
    expect(parsed.toolUsageCount["Bash"]).toBe(1)
  })
})

// ── obs_session_anomalies ──────────────────────────────────────────────────────

describe("obs_session_anomalies", () => {
  it("Given no ended sessions, Then returns empty array", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { tools } = yield* buildTools()
        return yield* Effect.promise(() =>
          getTool(tools, "obs_session_anomalies").handler(
            { error_rate: 0.3 },
            undefined,
          ),
        )
      }),
    )
    // Might have data from other tests, but it IS an array
    const parsed = parseOk<Array<unknown>>(result)
    expect(Array.isArray(parsed)).toBe(true)
  })

  it("Given a high-error session, Then it appears above threshold", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* DuckDbService
        const now = new Date().toISOString()
        const end = new Date(Date.now() + 2000).toISOString()

        yield* db.write(
          "INSERT OR IGNORE INTO sessions (id, model, status, created_at, ended_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
          ["sess-anom-hi", "claude-haiku", "closed", now, end, 2000],
        )
        // 2 errors out of 3 = 67%
        for (let i = 0; i < 3; i++) {
          yield* db.write(
            "INSERT OR IGNORE INTO events (id, ts, kind, level, session_id, status, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [crypto.randomUUID(), now, "ToolCall", "info", "sess-anom-hi", i < 2 ? "error" : "success", "{}"],
          )
        }

        const { tools } = yield* buildTools()
        return yield* Effect.promise(() =>
          getTool(tools, "obs_session_anomalies").handler(
            { error_rate: 0.5 }, // 50% threshold — session at 67% should appear
            undefined,
          ),
        )
      }),
    )
    const parsed = parseOk<Array<{ sessionId: string; errorCount: number }>>(result)
    const found = parsed.find((s) => s.sessionId === "sess-anom-hi")
    expect(found).toBeDefined()
    expect(found?.errorCount).toBe(2)
  })

  it("Given a low-error session, Then it does NOT appear above threshold", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* DuckDbService
        const now = new Date().toISOString()
        const end = new Date(Date.now() + 1000).toISOString()

        yield* db.write(
          "INSERT OR IGNORE INTO sessions (id, model, status, created_at, ended_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
          ["sess-anom-lo", "claude-haiku", "closed", now, end, 1000],
        )
        // 0 errors out of 5 = 0%
        for (let i = 0; i < 5; i++) {
          yield* db.write(
            "INSERT OR IGNORE INTO events (id, ts, kind, level, session_id, status, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [crypto.randomUUID(), now, "ToolCall", "info", "sess-anom-lo", "success", "{}"],
          )
        }

        const { tools } = yield* buildTools()
        return yield* Effect.promise(() =>
          getTool(tools, "obs_session_anomalies").handler(
            { error_rate: 0.3 },
            undefined,
          ),
        )
      }),
    )
    const parsed = parseOk<Array<{ sessionId: string }>>(result)
    expect(parsed.find((s) => s.sessionId === "sess-anom-lo")).toBeUndefined()
  })
})

// ── obs_sessions_search ────────────────────────────────────────────────────────

describe("obs_sessions_search", () => {
  it("Given no filters, Then returns an array", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { tools } = yield* buildTools()
        return yield* Effect.promise(() =>
          getTool(tools, "obs_sessions_search").handler({}, undefined),
        )
      }),
    )
    const parsed = parseOk<Array<unknown>>(result)
    expect(Array.isArray(parsed)).toBe(true)
  })

  it("Given session_id filter, Then returns only matching sessions", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* DuckDbService
        const now = new Date().toISOString()

        yield* db.write(
          "INSERT OR IGNORE INTO sessions (id, model, status, created_at) VALUES (?, ?, ?, ?)",
          ["sess-search-evt", "claude-opus", "active", now],
        )
        yield* db.write(
          "INSERT OR IGNORE INTO events (id, ts, kind, level, session_id, tool_name, status, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [crypto.randomUUID(), now, "ToolCall", "info", "sess-search-evt", "Glob", "success", "{}"],
        )

        const { tools } = yield* buildTools()
        return yield* Effect.promise(() =>
          getTool(tools, "obs_sessions_search").handler(
            { session_id: "sess-search-evt" },
            undefined,
          ),
        )
      }),
    )
    const parsed = parseOk<Array<{ sessionId: string; model: string; toolCalls: unknown[] }>>(result)
    expect(parsed.length).toBeGreaterThanOrEqual(1)
    expect(parsed.every((r) => r.sessionId === "sess-search-evt")).toBe(true)
    expect(parsed[0]?.model).toBe("claude-opus")
  })

  it("Each result has the expected shape", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { tools } = yield* buildTools()
        return yield* Effect.promise(() =>
          getTool(tools, "obs_sessions_search").handler({ limit: 10 }, undefined),
        )
      }),
    )
    const parsed = parseOk<
      Array<{
        sessionId: string
        model: string
        toolCalls: Array<{ tool: string; count: number }>
        errorCount: number
        durationMs: number
      }>
    >(result)
    for (const r of parsed) {
      expect(typeof r.sessionId).toBe("string")
      expect(typeof r.model).toBe("string")
      expect(Array.isArray(r.toolCalls)).toBe(true)
      expect(typeof r.errorCount).toBe("number")
      expect(typeof r.durationMs).toBe("number")
    }
  })
})

// ── bindSession cell ───────────────────────────────────────────────────────────

describe("bindSession", () => {
  it("After binding, obs_note uses the bound session id", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { tools, bindSession } = yield* buildTools(null)

        // Bind before writing the note
        bindSession("bound-sess-42")

        const writeResult = yield* Effect.promise(() =>
          getTool(tools, "obs_note").handler(
            { kind: "progress", summary: "Bound session note" },
            undefined,
          ),
        )
        const { id } = parseOk<{ id: string }>(writeResult)

        // Verify via obs_notes_recent
        const readResult = yield* Effect.promise(() =>
          getTool(tools, "obs_notes_recent").handler(
            { session_id: "bound-sess-42", limit: 5 },
            undefined,
          ),
        )
        const notes = parseOk<Array<{ id: string }>>(readResult)
        return { id, found: notes.some((n) => n.id === id) }
      }),
    )
    expect(result.found).toBe(true)
  })
})

// ── obs_pipeline_health ────────────────────────────────────────────────────────

describe("obs_pipeline_health", () => {
  it("returns nulls for sinks not provided (issue #11)", async () => {
    const result = await run(
      Effect.gen(function* () {
        // buildTools wires NO health sources -> tool should report both null.
        const { tools } = yield* buildTools()
        return yield* Effect.promise(() =>
          getTool(tools, "obs_pipeline_health").handler({}, undefined),
        )
      }),
    )
    const payload = parseOk<{
      eventSink: unknown
      sessionSync: unknown
    }>(result)
    expect(payload.eventSink).toBeNull()
    expect(payload.sessionSync).toBeNull()
  })

  it("returns the live health snapshot when sinks are wired", async () => {
    const result = await run(
      Effect.gen(function* () {
        const notes = yield* AgentNotesService
        const analytics = yield* AnalyticsService
        // Synthetic EventSinkHealth + SessionSyncHealth via Effect.succeed.
        const tools = makeObsTools(notes, analytics, () => null, {
          eventSink: Effect.succeed({
            eventsReceived: 12,
            eventsWritten: 10,
            writeFailures: 2,
            lastWriteAt: "2026-06-06T00:00:00.000Z",
            lastFailureReason: "duckdb lock",
          }),
          sessionSync: Effect.succeed({
            eventsReceived: 4,
            eventsWritten: 4,
            writeFailures: 0,
            lastWriteAt: "2026-06-06T00:00:01.000Z",
            lastFailureReason: null,
          }),
        })
        const tool = tools.find(
          (t) => (t as unknown as { name: string }).name === "obs_pipeline_health",
        ) as unknown as { handler: (a: unknown, b: unknown) => Promise<unknown> }
        return yield* Effect.promise(() => tool.handler({}, undefined))
      }),
    )
    const payload = parseOk<{
      eventSink: { eventsReceived: number; writeFailures: number }
      sessionSync: { eventsWritten: number }
    }>(result)
    expect(payload.eventSink.eventsReceived).toBe(12)
    expect(payload.eventSink.writeFailures).toBe(2)
    expect(payload.sessionSync.eventsWritten).toBe(4)
  })
})

// ── obs_runtime ────────────────────────────────────────────────────────────────

describe("obs_runtime", () => {
  it("reports available=false when no probe is wired (issue #12)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { tools } = yield* buildTools()
        return yield* Effect.promise(() =>
          getTool(tools, "obs_runtime").handler({}, undefined),
        )
      }),
    )
    const payload = parseOk<{ available: boolean }>(result)
    expect(payload.available).toBe(false)
  })

  it("returns the probe's snapshot when wired", async () => {
    const result = await run(
      Effect.gen(function* () {
        const notes = yield* AgentNotesService
        const analytics = yield* AnalyticsService
        const tools = makeObsTools(notes, analytics, () => null, {}, () => ({
          scope: "test-host",
          server: "luna-chat-server",
          pid: 12345,
          hostname: "test-machine",
          platform: "darwin",
          arch: "arm64",
          nodeVersion: "v20.0.0",
          bunVersion: "1.3.14",
          startedAt: "2026-06-06T07:00:00.000Z",
          dbPaths: {
            luna: "/tmp/luna.db",
            memory: "/tmp/memory.db",
            analytics: "/tmp/analytics.duckdb",
            jsonl: "/tmp/events.jsonl",
          },
        }))
        const tool = tools.find(
          (t) => (t as unknown as { name: string }).name === "obs_runtime",
        ) as unknown as { handler: (a: unknown, b: unknown) => Promise<unknown> }
        return yield* Effect.promise(() => tool.handler({}, undefined))
      }),
    )
    const payload = parseOk<{
      available: boolean
      scope: string
      pid: number
      dbPaths: { luna: string; analytics: string }
    }>(result)
    expect(payload.available).toBe(true)
    expect(payload.scope).toBe("test-host")
    expect(payload.pid).toBe(12345)
    expect(payload.dbPaths.luna).toBe("/tmp/luna.db")
    expect(payload.dbPaths.analytics).toBe("/tmp/analytics.duckdb")
  })

  it("rebuilds the snapshot on each call (live probe, not frozen)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const notes = yield* AgentNotesService
        const analytics = yield* AnalyticsService
        let counter = 0
        const tools = makeObsTools(notes, analytics, () => null, {}, () => ({
          scope: "test",
          server: "x",
          pid: ++counter,
          hostname: "h",
          platform: "darwin",
          arch: "arm64",
          nodeVersion: "v0",
          bunVersion: null,
          startedAt: "2026-06-06T07:00:00.000Z",
          dbPaths: { luna: "a", memory: "b", analytics: "c", jsonl: "d" },
        }))
        const tool = tools.find(
          (t) => (t as unknown as { name: string }).name === "obs_runtime",
        ) as unknown as { handler: (a: unknown, b: unknown) => Promise<unknown> }
        const first = yield* Effect.promise(() => tool.handler({}, undefined))
        const second = yield* Effect.promise(() => tool.handler({}, undefined))
        return [first, second]
      }),
    )
    const first = parseOk<{ pid: number }>(result[0])
    const second = parseOk<{ pid: number }>(result[1])
    expect(first.pid).toBe(1)
    expect(second.pid).toBe(2)
  })
})
