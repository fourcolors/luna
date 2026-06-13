// packages/core/src/suggested-actions/suggested-actions-store.test.ts
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { Clock } from "../clock.js"
import { SuggestedActionsStore } from "./suggested-actions-store.js"
import type { ProposeInput } from "./types.js"

const provide = <A, E>(eff: Effect.Effect<A, E, SuggestedActionsStore | Clock>) =>
  eff.pipe(Effect.provide(SuggestedActionsStore.Memory), Effect.provide(Clock.Test(1000)))

const input = (over: Partial<ProposeInput> = {}): ProposeInput => ({
  threadId: "t1",
  source: "agent",
  actionType: "research",
  title: "Research the thing",
  payload: { prompt: "go research the thing" },
  ...over,
})

describe("SuggestedActionsStore (Memory)", () => {
  it("propose stages a proposed row", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* SuggestedActionsStore
          const row = yield* s.propose(input())
          return row
        }),
      ),
    )
    expect(out.status).toBe("proposed")
    expect(out.threadId).toBe("t1")
    expect(out.actionType).toBe("research")
    expect(out.id).toMatch(/^sa-/)
  })

  it("propose is idempotent on (thread, type, title) — no duplicate", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* SuggestedActionsStore
          const a = yield* s.propose(input())
          const b = yield* s.propose(input()) // same content → same row
          const list = yield* s.listByThread("t1")
          return { a, b, list }
        }),
      ),
    )
    expect(out.a.id).toBe(out.b.id)
    expect(out.list).toHaveLength(1)
  })

  it("listByThread is per-thread and filters by status", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* SuggestedActionsStore
          yield* s.propose(input({ threadId: "t1", title: "A" }))
          const b = yield* s.propose(input({ threadId: "t1", title: "B" }))
          yield* s.propose(input({ threadId: "t2", title: "C" }))
          yield* s.markDismissed(b.id)
          const t1all = yield* s.listByThread("t1")
          const t1proposed = yield* s.listByThread("t1", { status: ["proposed"] })
          const t2 = yield* s.listByThread("t2")
          return { t1all, t1proposed, t2 }
        }),
      ),
    )
    expect(out.t1all).toHaveLength(2)
    expect(out.t1proposed).toHaveLength(1)
    expect(out.t1proposed[0]?.title).toBe("A")
    expect(out.t2).toHaveLength(1)
  })

  it("markAccepted is an atomic guard — a second accept loses (returns null)", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* SuggestedActionsStore
          const row = yield* s.propose(input())
          const first = yield* s.markAccepted(row.id)
          const second = yield* s.markAccepted(row.id) // already accepted → null
          return { first, second }
        }),
      ),
    )
    expect(out.first?.status).toBe("accepted")
    expect(out.second).toBeNull()
  })

  it("dismiss after accept is a no-op (cannot dismiss a non-proposed action)", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* SuggestedActionsStore
          const row = yield* s.propose(input())
          yield* s.markAccepted(row.id)
          const dismissed = yield* s.markDismissed(row.id)
          const cur = yield* s.getById(row.id)
          return { dismissed, status: cur?.status }
        }),
      ),
    )
    expect(out.dismissed).toBeNull()
    expect(out.status).toBe("accepted")
  })

  it("full lifecycle: proposed → accepted → in_progress → completed", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* SuggestedActionsStore
          const row = yield* s.propose(input())
          yield* s.markAccepted(row.id)
          const running = yield* s.recordExecution(row.id, { kind: "job", id: "job-7" })
          const inProgress = yield* s.listInProgress()
          const done = yield* s.recordTerminal(row.id, "completed")
          return { running, inProgress, done }
        }),
      ),
    )
    expect(out.running?.status).toBe("in_progress")
    expect(out.running?.executionKind).toBe("job")
    expect(out.running?.executionId).toBe("job-7")
    expect(out.inProgress).toHaveLength(1)
    expect(out.done?.status).toBe("completed")
  })

  it("recordExecution requires accepted (no-op from proposed)", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* SuggestedActionsStore
          const row = yield* s.propose(input())
          return yield* s.recordExecution(row.id, { kind: "job", id: "x" })
        }),
      ),
    )
    expect(out).toBeNull()
  })

  it("recordTerminal can fail an action and carry an error", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* SuggestedActionsStore
          const row = yield* s.propose(input())
          yield* s.markAccepted(row.id)
          yield* s.recordExecution(row.id, { kind: "job", id: "j" })
          return yield* s.recordTerminal(row.id, "failed", "boom")
        }),
      ),
    )
    expect(out?.status).toBe("failed")
    expect(out?.error).toBe("boom")
  })
})
