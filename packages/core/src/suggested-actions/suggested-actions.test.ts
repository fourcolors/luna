// packages/core/src/suggested-actions/suggested-actions.test.ts
import { describe, expect, it } from "vitest"
import { Chunk, Effect, Fiber, Layer, Stream } from "effect"
import { Clock } from "../clock.js"
import { SuggestedActionsStore } from "./suggested-actions-store.js"
import { AcceptHandler, SuggestedActions } from "./suggested-actions.js"
import type { ProposeInput, SuggestedActionRow } from "./types.js"

const base = Layer.provideMerge(SuggestedActions.layer, SuggestedActionsStore.Memory)

const provide = <A, E>(eff: Effect.Effect<A, E, SuggestedActions | SuggestedActionsStore | Clock>) =>
  eff.pipe(Effect.provide(base), Effect.provide(Clock.Test(1000)))

const input = (over: Partial<ProposeInput> = {}): ProposeInput => ({
  threadId: "t1",
  source: "agent",
  actionType: "research",
  title: "Research the thing",
  payload: { prompt: "go" },
  ...over,
})

describe("SuggestedActions service", () => {
  it("propose persists a proposed row", async () => {
    const row = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const svc = yield* SuggestedActions
          return yield* svc.propose(input())
        }),
      ),
    )
    expect(row.status).toBe("proposed")
  })

  it("respond dismiss transitions the row to dismissed", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const svc = yield* SuggestedActions
          const row = yield* svc.propose(input())
          const r = yield* svc.respond({ threadId: "t1", actionId: row.id, decision: "dismiss" })
          return r
        }),
      ),
    )
    expect(out?.status).toBe("dismissed")
  })

  it("respond rejects a cross-thread response (per-thread guard)", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const svc = yield* SuggestedActions
          const row = yield* svc.propose(input({ threadId: "t1" }))
          const r = yield* svc.respond({ threadId: "t2", actionId: row.id, decision: "dismiss" })
          const cur = yield* svc.getById(row.id)
          return { r, status: cur?.status }
        }),
      ),
    )
    expect(out.r).toBeNull()
    expect(out.status).toBe("proposed") // untouched
  })

  it("respond accept (no handler) leaves the row accepted", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const svc = yield* SuggestedActions
          const row = yield* svc.propose(input())
          return yield* svc.respond({ threadId: "t1", actionId: row.id, decision: "accept" })
        }),
      ),
    )
    expect(out?.status).toBe("accepted")
  })

  it("propose emits the row on the changes stream", async () => {
    const collected = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const svc = yield* SuggestedActions
          // Start the subscription BEFORE proposing so we don't miss the publish.
          const fiber = yield* Stream.runCollect(Stream.take(svc.changes, 1)).pipe(
            Effect.forkChild,
          )
          // Let the subscriber register on the hub.
          yield* Effect.sleep("10 millis")
          yield* svc.propose(input())
          const chunk = yield* Fiber.join(fiber)
          return chunk
        }),
      ),
    )
    expect(collected).toHaveLength(1)
    expect(collected[0]?.status).toBe("proposed")
  })

  it("respond accept invokes a wired AcceptHandler", async () => {
    // A fake handler that moves the row to in_progress (what the real P6 handler does).
    const fakeHandler = Layer.effect(
      AcceptHandler,
      Effect.gen(function* () {
        const svc = yield* SuggestedActions
        return {
          accept: (row: SuggestedActionRow) =>
            svc.recordExecution(row.id, { kind: "job", id: "job-99" }).pipe(Effect.asVoid),
        }
      }),
    )
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SuggestedActions
        const row = yield* svc.propose(input())
        return yield* svc.respond({ threadId: "t1", actionId: row.id, decision: "accept" })
      }).pipe(
        Effect.provide(Layer.provideMerge(fakeHandler, base)),
        Effect.provide(Clock.Test(1000)),
      ),
    )
    expect(out?.status).toBe("in_progress")
    expect(out?.executionId).toBe("job-99")
  })
})
