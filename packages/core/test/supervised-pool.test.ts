/**
 * Tier-2 simulations for `supervised-pool/` (Phase 11.5a helper extraction).
 *
 * Each test locks one invariant from the §4 brief:
 *   (1) happy-path + capacity
 *   (2) block policy — submit suspends when full
 *   (3) drop-newest — second submit rejected
 *   (4) drop-oldest — oldest evicted with Exit.isInterrupted in results
 *   (5) cascade-cancel — closing pool Scope interrupts all
 *   (6) supervisor-failure-no-auto-restart — failed job doesn't poison pool
 *   (7) post-shutdown submit — returns rejected-shutdown
 *   (8) LIFO finalizer order — queue stays open while fibers finalize
 *   (9) per-job scope isolation — job finalizer fires on job completion
 */
import { describe, expect, it } from "vitest"
import {
  Chunk,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Ref,
  Scope,
  Stream,
} from "effect"
import { makeSupervisedPool } from "../src/supervised-pool/index.js"
import type { PoolResult } from "../src/supervised-pool/index.js"

describe("supervised-pool (Phase 11.5a)", () => {
  // ──────────────────────────────────────────────────────────────────────
  // (1) Happy path + capacity
  // ──────────────────────────────────────────────────────────────────────
  it("(1) capacity=2: 5 jobs run (≤2 concurrent), all complete via results", async () => {
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pool = yield* makeSupervisedPool({
            capacity: 2,
            policy: "block",
          })
          const live = yield* Ref.make(0)
          const peak = yield* Ref.make(0)

          const job = (id: string) =>
            Effect.acquireUseRelease(
              Effect.gen(function* () {
                const n = yield* Ref.updateAndGet(live, (x) => x + 1)
                yield* Ref.update(peak, (p) => (n > p ? n : p))
                return id
              }),
              () => Effect.sleep(Duration.millis(30)),
              () => Ref.update(live, (x) => x - 1),
            )

          const collector = yield* Effect.fork(
            pool.results.pipe(
              Stream.take(5),
              Stream.runCollect,
              Effect.map(Chunk.toReadonlyArray),
            ),
          )

          for (const id of ["a", "b", "c", "d", "e"]) {
            yield* pool.submit({ id, run: job(id) })
          }

          const exit = yield* collector.await
          const results = Exit.isSuccess(exit) ? exit.value : []
          const peakN = yield* Ref.get(peak)
          return { results, peakN }
        }),
      ),
    )
    expect(out.results).toHaveLength(5)
    expect(out.results.every((r) => Exit.isSuccess(r.exit))).toBe(true)
    expect(out.peakN).toBeLessThanOrEqual(2)
    expect(out.peakN).toBeGreaterThanOrEqual(1)
  })

  // ──────────────────────────────────────────────────────────────────────
  // (2) Block policy — submit suspends
  // ──────────────────────────────────────────────────────────────────────
  it("(2) block policy: capacity=1, 3 submits all complete (suspending as needed)", async () => {
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pool = yield* makeSupervisedPool({
            capacity: 1,
            policy: "block",
          })

          const collector = yield* Effect.fork(
            pool.results.pipe(
              Stream.take(3),
              Stream.runCollect,
              Effect.map(Chunk.toReadonlyArray),
            ),
          )

          const forked = yield* Effect.forEach(
            ["x", "y", "z"],
            (id) =>
              Effect.fork(
                pool.submit({
                  id,
                  run: Effect.sleep(Duration.millis(20)).pipe(
                    Effect.as(id),
                  ),
                }),
              ),
            { concurrency: "unbounded" },
          )
          const outcomes = yield* Effect.forEach(forked, (f) => Fiber.join(f))
          const exit = yield* collector.await
          const results = Exit.isSuccess(exit) ? exit.value : []
          return { outcomes, results }
        }),
      ),
    )
    // All three accepted
    expect(out.outcomes.every((o) => o._tag === "accepted")).toBe(true)
    expect(out.results).toHaveLength(3)
    expect(out.results.every((r) => Exit.isSuccess(r.exit))).toBe(true)
  })

  // ──────────────────────────────────────────────────────────────────────
  // (3) drop-newest policy
  // ──────────────────────────────────────────────────────────────────────
  it("(3) drop-newest: A running, B rejected, A still completes", async () => {
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pool = yield* makeSupervisedPool({
            capacity: 1,
            policy: "drop-newest",
          })

          const slow = Effect.sleep(Duration.millis(50)).pipe(
            Effect.as("A-done"),
          )
          const a = yield* pool.submit({ id: "A", run: slow })
          // Give A a moment to enter FiberSet + running list.
          yield* Effect.sleep(Duration.millis(5))
          const b = yield* pool.submit({
            id: "B",
            run: Effect.succeed("B-done"),
          })

          const result = yield* pool.results.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.map(Chunk.toReadonlyArray),
            Effect.map((xs) => xs[0]!),
          )
          return { a, b, result }
        }),
      ),
    )
    expect(out.a._tag).toBe("accepted")
    expect(out.b._tag).toBe("rejected-full")
    expect(out.result.id).toBe("A")
    expect(Exit.isSuccess(out.result.exit)).toBe(true)
  })

  // ──────────────────────────────────────────────────────────────────────
  // (4) drop-oldest policy
  // ──────────────────────────────────────────────────────────────────────
  it("(4) drop-oldest: A evicted (interrupted in results), B completes", async () => {
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pool = yield* makeSupervisedPool({
            capacity: 1,
            policy: "drop-oldest",
          })

          const a = yield* pool.submit({ id: "A", run: Effect.never })
          yield* Effect.sleep(Duration.millis(5))
          const b = yield* pool.submit({
            id: "B",
            run: Effect.sleep(Duration.millis(20)).pipe(Effect.as("B-done")),
          })

          const results = yield* pool.results.pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.map(Chunk.toReadonlyArray),
          )
          return { a, b, results }
        }),
      ),
    )
    expect(out.a._tag).toBe("accepted")
    expect(out.b._tag).toBe("evicted")
    if (out.b._tag === "evicted") {
      expect(out.b.evictedId).toBe("A")
      expect(out.b.acceptedId).toBe("B")
    }
    const byId = new Map(out.results.map((r) => [r.id, r] as const))
    expect(Exit.isInterrupted(byId.get("A")!.exit)).toBe(true)
    expect(Exit.isSuccess(byId.get("B")!.exit)).toBe(true)
  })

  // ──────────────────────────────────────────────────────────────────────
  // (5) cascade-cancel — closing Scope interrupts every in-flight job
  // ──────────────────────────────────────────────────────────────────────
  it("(5) cascade-cancel: closing pool Scope → all jobs Exit.isInterrupted", async () => {
    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* Ref.make<
          ReadonlyArray<{ id: string; interrupted: boolean }>
        >([])
        const scope = yield* Scope.make()

        // Build a Layer that provides the pool service-object in this scope.
        const layer = Layer.scoped(
          SupervisedPoolTag,
          makeSupervisedPool({ capacity: 8, policy: "block" }),
        )
        const ctx = yield* Layer.buildWithScope(scope)(layer)

        const body = Effect.gen(function* () {
          const pool = yield* SupervisedPoolTag
          const drainer = yield* Effect.fork(
            pool.results.pipe(
              Stream.runForEach((r: PoolResult) =>
                Ref.update(sink, (xs) => [
                  ...xs,
                  { id: r.id, interrupted: Exit.isInterrupted(r.exit) },
                ]),
              ),
            ),
          )
          yield* pool.submit({ id: "L1", run: Effect.never })
          yield* pool.submit({ id: "L2", run: Effect.never })
          yield* pool.submit({ id: "L3", run: Effect.never })
          yield* Effect.sleep(Duration.millis(20))
          return drainer
        }).pipe(Effect.provide(ctx))

        const drainer = yield* body
        yield* Scope.close(scope, Exit.void)
        yield* Fiber.await(drainer)
        return yield* Ref.get(sink)
      }),
    )
    expect(collected).toHaveLength(3)
    expect(collected.every((r) => r.interrupted)).toBe(true)
    expect(collected.map((r) => r.id).sort()).toEqual(["L1", "L2", "L3"])
  })

  // ──────────────────────────────────────────────────────────────────────
  // (6) Supervisor-failure-no-auto-restart
  // ──────────────────────────────────────────────────────────────────────
  it("(6) failing job doesn't restart; pool stays operational; failure surfaces", async () => {
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pool = yield* makeSupervisedPool({
            capacity: 2,
            policy: "block",
          })

          yield* pool.submit({ id: "boom", run: Effect.fail("intentional") })
          const first = yield* pool.results.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.map(Chunk.toReadonlyArray),
            Effect.map((xs) => xs[0]!),
          )

          const reFire = yield* Effect.race(
            pool.results.pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.map(() => "re-fired" as const),
            ),
            Effect.sleep(Duration.millis(40)).pipe(
              Effect.map(() => "no-refire" as const),
            ),
          )

          yield* pool.submit({ id: "ok", run: Effect.succeed("ok") })
          const second = yield* pool.results.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.map(Chunk.toReadonlyArray),
            Effect.map((xs) => xs[0]!),
          )
          return { first, reFire, second }
        }),
      ),
    )
    expect(out.first.id).toBe("boom")
    expect(Exit.isFailure(out.first.exit)).toBe(true)
    expect(out.reFire).toBe("no-refire")
    expect(out.second.id).toBe("ok")
    expect(Exit.isSuccess(out.second.exit)).toBe(true)
  })

  // ──────────────────────────────────────────────────────────────────────
  // (7) post-shutdown submit → rejected-shutdown
  // ──────────────────────────────────────────────────────────────────────
  it("(7) submit after shutdown returns rejected-shutdown", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pool = yield* makeSupervisedPool({
            capacity: 2,
            policy: "block",
          })
          yield* pool.shutdown
          return yield* pool.submit({
            id: "late",
            run: Effect.succeed(null),
          })
        }),
      ),
    )
    expect(outcome._tag).toBe("rejected-shutdown")
    if (outcome._tag === "rejected-shutdown") {
      expect(outcome.id).toBe("late")
    }
  })

  // ──────────────────────────────────────────────────────────────────────
  // (8) LIFO finalizer order — queue stays open while FiberSet interrupts
  //
  // If the queue-shutdown finalizer ran BEFORE the FiberSet finalizer,
  // interrupted fibers' onExit `Queue.offer` would arrive to a shutdown
  // queue and be dropped — meaning no PoolResults for interrupted jobs.
  // We assert the opposite: ALL interrupted jobs surface in results.
  // This is behaviorally identical to scenario (5) but framed as the
  // explicit LIFO-ordering proof the brief asks for.
  // ──────────────────────────────────────────────────────────────────────
  it("(8) LIFO: queue open during FiberSet teardown → all interrupts surface", async () => {
    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* Ref.make<ReadonlyArray<PoolResult>>([])
        const scope = yield* Scope.make()
        const layer = Layer.scoped(
          SupervisedPoolTag,
          makeSupervisedPool({ capacity: 8, policy: "block" }),
        )
        const ctx = yield* Layer.buildWithScope(scope)(layer)

        const drainer = yield* Effect.gen(function* () {
          const pool = yield* SupervisedPoolTag
          const d = yield* Effect.fork(
            pool.results.pipe(
              Stream.runForEach((r) =>
                Ref.update(sink, (xs) => [...xs, r]),
              ),
            ),
          )
          yield* pool.submit({ id: "a", run: Effect.never })
          yield* pool.submit({ id: "b", run: Effect.never })
          yield* pool.submit({ id: "c", run: Effect.never })
          yield* Effect.sleep(Duration.millis(15))
          return d
        }).pipe(Effect.provide(ctx))

        yield* Scope.close(scope, Exit.void)
        yield* Fiber.await(drainer)
        return yield* Ref.get(sink)
      }),
    )
    // All three interrupts made it through the queue before shutdown.
    expect(collected).toHaveLength(3)
    expect(collected.every((r) => Exit.isInterrupted(r.exit))).toBe(true)
  })

  // ──────────────────────────────────────────────────────────────────────
  // (9) Per-job Scope isolation — job finalizer fires on job completion
  // ──────────────────────────────────────────────────────────────────────
  it("(9) per-job Scope: job finalizer fires on job completion, not pool close", async () => {
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pool = yield* makeSupervisedPool({
            capacity: 1,
            policy: "block",
          })
          const finalizerFiredAt = yield* Ref.make<number | null>(null)
          const afterSubmitAt = yield* Ref.make<number | null>(null)

          const tick = Ref.make(0)
          const clock = yield* tick
          const stamp = (ref: Ref.Ref<number | null>) =>
            Effect.gen(function* () {
              const n = yield* Ref.updateAndGet(clock, (x) => x + 1)
              yield* Ref.set(ref, n)
            })

          const job = Effect.gen(function* () {
            yield* Effect.addFinalizer(() => stamp(finalizerFiredAt))
            yield* Effect.sleep(Duration.millis(5))
            return "done"
          })
          yield* pool.submit({ id: "j1", run: job })
          // Wait for the first result — job has completed by now.
          yield* pool.results.pipe(
            Stream.take(1),
            Stream.runCollect,
          )
          yield* stamp(afterSubmitAt)

          const fin = yield* Ref.get(finalizerFiredAt)
          const after = yield* Ref.get(afterSubmitAt)
          return { fin, after }
        }),
      ),
    )
    // Finalizer must have fired BEFORE we stamped afterSubmitAt — proving
    // it ran at job completion, not deferred to pool Scope close.
    expect(out.fin).not.toBeNull()
    expect(out.after).not.toBeNull()
    expect(out.fin! < out.after!).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Test-local Tag used by scenarios (5) + (8) to plug the pool into a Layer
// we can explicitly buildWithScope / close. Using a generic Context Tag
// keeps the helper internal (no public export).
// ─────────────────────────────────────────────────────────────────────────
import { Context } from "effect"
import type { SupervisedPool } from "../src/supervised-pool/index.js"
const SupervisedPoolTag = Context.GenericTag<SupervisedPool>(
  "test/SupervisedPool",
)
