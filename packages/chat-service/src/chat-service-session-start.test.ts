/**
 * SessionStartEvent — optional fields extension (Task 3).
 *
 * Tests:
 *   1. Schema ACCEPTS SessionStart with new optional fields populated.
 *   2. Schema ACCEPTS SessionStart WITHOUT new optional fields (backward compat).
 *   3. Schema REJECTS SessionStart with `tags` as a non-array (e.g. a string).
 *   4. decodeObsEvent correctly decodes a SessionStart with all new fields.
 *   5. Integration: emit() with all new fields passes them through subscribeEvents.
 */
import { describe, expect, it } from "vitest"
import { Chunk, Duration, Effect, Fiber, Layer, Result, Stream } from "effect"
import { Clock, ObservabilityService, decodeObsEvent } from "@luna/core"

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const makeLayer = () =>
  ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(Clock.Default),
  )

const run = <A, E>(prog: Effect.Effect<A, E, ObservabilityService | Clock>) =>
  Effect.runPromise(
    Effect.scoped(prog.pipe(Effect.provide(makeLayer()))),
  )

/* -------------------------------------------------------------------------- */
/* Schema unit tests                                                            */
/* -------------------------------------------------------------------------- */

describe("SessionStartEvent schema — optional fields", () => {
  it("accepts a SessionStart with all new optional fields populated", () => {
    const event = {
      ts: new Date().toISOString(),
      kind: "SessionStart",
      level: "info",
      sessionId: "sess-001",
      model: "claude-3-5-sonnet",
      optionsDigest: "abc123",
      parentId: "sess-000",
      tags: ["prod", "chat"],
      title: "My session",
    }
    const result = decodeObsEvent(event)
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      const ev = result.success
      if (ev.kind === "SessionStart") {
        expect(ev.parentId).toBe("sess-000")
        expect(ev.tags).toEqual(["prod", "chat"])
        expect(ev.title).toBe("My session")
      }
    }
  })

  it("accepts a SessionStart WITHOUT the new optional fields (backward compat)", () => {
    const event = {
      ts: new Date().toISOString(),
      kind: "SessionStart",
      level: "info",
      sessionId: "sess-002",
      model: "claude-3-5-sonnet",
    }
    const result = decodeObsEvent(event)
    expect(Result.isSuccess(result)).toBe(true)
  })

  it("rejects a SessionStart with `tags` as a string (not an array)", () => {
    const event = {
      ts: new Date().toISOString(),
      kind: "SessionStart",
      level: "info",
      sessionId: "sess-003",
      model: "claude-3-5-sonnet",
      tags: "not-an-array",
    }
    const result = decodeObsEvent(event)
    expect(Result.isFailure(result)).toBe(true)
  })

  it("decodeObsEvent correctly decodes SessionStart with all new fields", () => {
    const event = {
      ts: "2026-05-08T10:00:00.000Z",
      kind: "SessionStart",
      level: "info",
      sessionId: "sess-decode-001",
      model: "claude-opus-4",
      parentId: "parent-sess-001",
      tags: ["alpha", "beta"],
      title: "Decode test session",
    }
    const result = decodeObsEvent(event)
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      const ev = result.success
      expect(ev.kind).toBe("SessionStart")
      if (ev.kind === "SessionStart") {
        expect(ev.sessionId).toBe("sess-decode-001")
        expect(ev.model).toBe("claude-opus-4")
        expect(ev.parentId).toBe("parent-sess-001")
        expect(ev.tags).toEqual(["alpha", "beta"])
        expect(ev.title).toBe("Decode test session")
      }
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Integration: emit() passes new fields through subscribeEvents               */
/* -------------------------------------------------------------------------- */

describe("SessionStartEvent — ObservabilityService integration", () => {
  it("emit() with parentId, tags, title passes them through subscribeEvents", async () => {
    const collected = await run(
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        const stream = yield* obs.subscribeEvents
        const fiber = yield* Effect.forkChild(
          stream.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.map(Chunk.toReadonlyArray),
          ),
        )
        yield* Effect.sleep(Duration.millis(10))

        yield* obs.emit({
          kind: "SessionStart",
          ts: new Date().toISOString(),
          level: "info",
          sessionId: "sess-integration-001",
          model: "claude-opus-4",
          parentId: "parent-sess-001",
          tags: ["integration", "test"],
          title: "Integration test session",
        })

        return yield* Fiber.join(fiber)
      }),
    )

    expect(collected).toHaveLength(1)
    const ev = collected[0]
    expect(ev?.kind).toBe("SessionStart")
    if (ev?.kind === "SessionStart") {
      expect(ev.parentId).toBe("parent-sess-001")
      expect(ev.tags).toEqual(["integration", "test"])
      expect(ev.title).toBe("Integration test session")
    }
  })

  it("emit() without new optional fields still passes the event through", async () => {
    const collected = await run(
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        const stream = yield* obs.subscribeEvents
        const fiber = yield* Effect.forkChild(
          stream.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.map(Chunk.toReadonlyArray),
          ),
        )
        yield* Effect.sleep(Duration.millis(10))

        yield* obs.emit({
          kind: "SessionStart",
          ts: new Date().toISOString(),
          level: "info",
          sessionId: "sess-integration-002",
          model: "claude-sonnet-4-5",
        })

        return yield* Fiber.join(fiber)
      }),
    )

    expect(collected).toHaveLength(1)
    const ev = collected[0]
    expect(ev?.kind).toBe("SessionStart")
    if (ev?.kind === "SessionStart") {
      expect(ev.parentId).toBeUndefined()
      expect(ev.tags).toBeUndefined()
      expect(ev.title).toBeUndefined()
    }
  })
})
