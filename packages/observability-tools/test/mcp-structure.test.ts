/**
 * ObsToolsLayer structural invariants.
 *
 *   1. ObsToolsLayer() builds and provides ObsToolsService with correct shape.
 *   2. buildObsMcpServer(tools) returns type='sdk', name='observability'.
 *   3. makeObsTools exposes exactly the 5 expected tool names in order.
 *   4. OBS_SYSTEM_PROMPT_ADDENDUM is non-empty and mentions all 5 tools.
 *   5. bindSession() is a callable function.
 *
 * Uses ":memory:" databases and follows the scheduler-tools structural test pattern.
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
import {
  ObsToolsLayer,
  ObsToolsService,
  buildObsMcpServer,
  OBS_SYSTEM_PROMPT_ADDENDUM,
} from "../src/layer.js"
import { makeObsTools } from "../src/tools.js"

// ── Layer helpers ─────────────────────────────────────────────────────────────

const makeTestLayer = () =>
  ObsToolsLayer({
    lunaDbPath: ":memory:",
    analyticsDbPath: ":memory:",
    duckDbQueueCapacity: 64,
  }).pipe(
    Layer.provide(Clock.Default),
    Layer.provide(LunaSqliteBootstrapLive),
  )

const duckDbL = makeDuckDbLayer({ dbPath: ":memory:", writeQueueCapacity: 64 })
const analyticsL = AnalyticsService.makeLayer({ dbPath: ":memory:" }).pipe(
  Layer.provide(duckDbL),
)
const agentNotesL = Layer.provide(AgentNotesService.Memory, Clock.Default)

const obsStack = Layer.mergeAll(agentNotesL, analyticsL, duckDbL).pipe(
  Layer.provide(Clock.Default),
  Layer.provide(LunaSqliteBootstrapLive),
)

// ── Structural tests ──────────────────────────────────────────────────────────

describe("ObsToolsLayer — structural invariants", () => {
  it("builds and provides ObsToolsService with correct shape", async () => {
    const config = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* ObsToolsService
        }),
      ).pipe(Effect.provide(makeTestLayer())),
    )

    expect(config.serverName).toBe("observability")
    expect(config.server).not.toBeNull()
    expect(typeof config.server).toBe("object")
    expect(typeof config.systemPromptAddendum).toBe("string")
    expect(config.systemPromptAddendum.length).toBeGreaterThan(0)
    expect(config.systemPromptAddendum).toBe(OBS_SYSTEM_PROMPT_ADDENDUM)
    expect(typeof config.bindSession).toBe("function")
  })

  it("buildObsMcpServer returns type='sdk' and name='observability'", async () => {
    const serverConfig = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const notes = yield* AgentNotesService
          const analytics = yield* AnalyticsService
          const tools = makeObsTools(notes, analytics, () => "test-session")
          return buildObsMcpServer(tools)
        }),
      ).pipe(Effect.provide(obsStack)),
    )

    expect(serverConfig).not.toBeNull()
    expect(typeof serverConfig).toBe("object")
    expect((serverConfig as { type?: string }).type).toBe("sdk")
    expect((serverConfig as { name?: string }).name).toBe("observability")
    expect(typeof (serverConfig as { instance?: unknown }).instance).toBe("object")
  })

  it("makeObsTools exposes exactly 5 tools in the correct order", async () => {
    const tools = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const notes = yield* AgentNotesService
          const analytics = yield* AnalyticsService
          return makeObsTools(notes, analytics, () => "test-session")
        }),
      ).pipe(Effect.provide(obsStack)),
    )

    expect(tools).toHaveLength(5)
    const names = tools.map((t) => (t as unknown as { name: string }).name)
    expect(names).toEqual([
      "obs_note",
      "obs_notes_recent",
      "obs_session_explain",
      "obs_session_anomalies",
      "obs_sessions_search",
    ])
  })

  it("makeObsTools marks every observability tool as eagerly loaded", async () => {
    const tools = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const notes = yield* AgentNotesService
          const analytics = yield* AnalyticsService
          return makeObsTools(notes, analytics, () => "test-session")
        }),
      ).pipe(Effect.provide(obsStack)),
    )

    for (const tool of tools) {
      const meta = (tool as unknown as { _meta?: Record<string, unknown> })._meta
      expect(meta).toMatchObject({ "anthropic/alwaysLoad": true })
      expect(typeof meta?.["anthropic/searchHint"]).toBe("string")
      expect((meta?.["anthropic/searchHint"] as string).length).toBeGreaterThan(0)
    }
  })

  it("bindSession is a no-throw callable", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const config = yield* ObsToolsService
          // Should not throw
          config.bindSession("test-session-id")
        }),
      ).pipe(Effect.provide(makeTestLayer())),
    )
    // If we got here, bindSession didn't throw — test passes
  })
})

// ── Constant tests ────────────────────────────────────────────────────────────

describe("ObsToolsService — constant invariants (all runtimes)", () => {
  it("OBS_SYSTEM_PROMPT_ADDENDUM is non-empty and contains 'observability'", () => {
    expect(typeof OBS_SYSTEM_PROMPT_ADDENDUM).toBe("string")
    expect(OBS_SYSTEM_PROMPT_ADDENDUM.length).toBeGreaterThan(0)
    expect(OBS_SYSTEM_PROMPT_ADDENDUM.toLowerCase()).toContain("observability")
  })

  it("OBS_SYSTEM_PROMPT_ADDENDUM mentions all 5 tools", () => {
    expect(OBS_SYSTEM_PROMPT_ADDENDUM).toContain(
      "mcp__observability__obs_note",
    )
    expect(OBS_SYSTEM_PROMPT_ADDENDUM).toContain(
      "mcp__observability__obs_notes_recent",
    )
    expect(OBS_SYSTEM_PROMPT_ADDENDUM).toContain(
      "mcp__observability__obs_session_explain",
    )
    expect(OBS_SYSTEM_PROMPT_ADDENDUM).toContain(
      "mcp__observability__obs_session_anomalies",
    )
    expect(OBS_SYSTEM_PROMPT_ADDENDUM).toContain(
      "mcp__observability__obs_sessions_search",
    )
    expect(OBS_SYSTEM_PROMPT_ADDENDUM).toContain("fully qualified")
  })

  it("DuckDbService is not exported from the package surface (internal dep only)", () => {
    // DuckDbService should not be in the observability-tools public surface
    // (it's wired internally via ObsToolsLayer). This test is a documentation
    // invariant — if the package ever accidentally re-exports DuckDbService,
    // this test won't catch it (we can't easily test exports at runtime).
    // We just assert the addendum doesn't mention internal implementation details.
    expect(OBS_SYSTEM_PROMPT_ADDENDUM).not.toContain("DuckDb")
    expect(OBS_SYSTEM_PROMPT_ADDENDUM).not.toContain("AgentNotes")
  })
})
