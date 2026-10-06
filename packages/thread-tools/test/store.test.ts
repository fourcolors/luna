import { describe, expect, it } from "vitest"
import { Effect, Fiber, Stream } from "effect"
import { ForkProposalStore, toForkProposalWire } from "../src/store.js"

const run = <A>(effect: Effect.Effect<A, never, ForkProposalStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(ForkProposalStore.Memory)))

describe("ForkProposalStore", () => {
  it("propose → claim → completeAccept transitions once", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* ForkProposalStore
        const row = yield* store.propose({
          parentThreadId: "thr_parent",
          title: "Billing question",
          summary: "About the July invoice",
          seed: "Let's talk about the July invoice.",
          nowMs: 1000,
        })
        expect(row.status).toBe("pending")
        expect(row.id.startsWith("fork_")).toBe(true)

        const pending = yield* store.listPendingByThread("thr_parent")
        expect(pending).toHaveLength(1)

        const claimed = yield* store.claim(row.id, "thr_parent")
        expect(claimed?.status).toBe("accepting")
        // Concurrent claim loses.
        expect(yield* store.claim(row.id, "thr_parent")).toBeNull()

        const accepted = yield* store.completeAccept(
          row.id,
          "thr_parent",
          "thr_child",
        )
        expect(accepted?.newlyAccepted).toBe(true)
        expect(accepted?.proposal.status).toBe("accepted")
        expect(accepted?.proposal.childThreadId).toBe("thr_child")

        const pendingAfter = yield* store.listPendingByThread("thr_parent")
        expect(pendingAfter).toHaveLength(0)
      }),
    )
  })

  it("dismiss removes from pending; cross-thread accept fails", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* ForkProposalStore
        const row = yield* store.propose({
          parentThreadId: "thr_a",
          title: "X",
          summary: "Y",
          seed: "Z",
          nowMs: 1,
        })
        expect(yield* store.accept(row.id, "thr_other", "thr_c")).toBeNull()
        const dismissed = yield* store.dismiss(row.id, "thr_a")
        expect(dismissed?.status).toBe("dismissed")
        expect(yield* store.dismiss(row.id, "thr_a")).toBeNull()
      }),
    )
  })

  it("toForkProposalWire omits seed", () => {
    const wire = toForkProposalWire({
      id: "fork_1",
      parentThreadId: "thr_p",
      title: "T",
      summary: "S",
      seed: "SECRET SEED",
      mode: "propose",
      status: "pending",
      createdAt: 0,
    })
    expect(wire).toEqual({
      id: "fork_1",
      parentThreadId: "thr_p",
      title: "T",
      summary: "S",
      status: "pending",
      createdAt: 0,
    })
    expect("seed" in wire).toBe(false)
  })

  it("a create_thread proposal records mode \"create\" and goes out with autoOpen", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* ForkProposalStore
        const plain = yield* store.propose({
          parentThreadId: "thr_p", title: "A", summary: "A", seed: "s", nowMs: 1,
        })
        expect(plain.mode).toBe("propose")
        expect("autoOpen" in toForkProposalWire(plain)).toBe(false)
        const made = yield* store.propose({
          parentThreadId: "thr_p", title: "B", summary: "B", seed: "s", nowMs: 2, mode: "create",
        })
        expect(made.mode).toBe("create")
        expect(toForkProposalWire(made).autoOpen).toBe(true)
        expect("mode" in toForkProposalWire(made)).toBe(false)
      }),
    )
  })

  it("changes stream emits on propose", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* ForkProposalStore
        // Subscribe first, then propose, then take 1 — avoids a race where
        // the event fires before anyone is listening.
        const fiber = yield* Effect.forkChild(
          Stream.take(store.changes, 1).pipe(Stream.runCollect),
        )
        yield* Effect.sleep("20 millis")
        yield* store.propose({
          parentThreadId: "thr_p",
          title: "T",
          summary: "S",
          seed: "seed",
          nowMs: 42,
        })
        const collected = yield* Fiber.join(fiber)
        expect([...collected]).toHaveLength(1)
        expect([...collected][0]!.title).toBe("T")
      }),
    )
  })
})

describe("ForkProposalStore claim race and release", () => {
  it("exactly one of many concurrent first claims wins", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* ForkProposalStore
        const row = yield* store.propose({ parentThreadId: "p", title: "T", summary: "S", seed: "s", nowMs: 1 })
        const results = yield* Effect.all(
          Array.from({ length: 16 }, () => Effect.yieldNow.pipe(Effect.andThen(store.claim(row.id, "p")))),
          { concurrency: "unbounded" },
        )
        expect(results.filter((r) => r !== null)).toHaveLength(1)
      }),
    )
  })

  it("release returns a failed fork marker to pending and closes a failed create_thread", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* ForkProposalStore
        const fork = yield* store.propose({ parentThreadId: "p", title: "F", summary: "F", seed: "s", nowMs: 1 })
        yield* store.claim(fork.id, "p")
        expect((yield* store.release(fork.id, "p"))?.status).toBe("pending")
        const made = yield* store.propose({ parentThreadId: "p", title: "C", summary: "C", seed: "s", nowMs: 1, mode: "create" })
        yield* store.claim(made.id, "p")
        expect((yield* store.release(made.id, "p"))?.status).toBe("dismissed")
        // Not accepting -> no-op.
        expect(yield* store.release(made.id, "p")).toBeNull()
      }),
    )
  })
})
