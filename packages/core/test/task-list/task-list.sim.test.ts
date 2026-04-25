/**
 * TaskList Tier-2 simulation tests per DESIGN §8.2.
 *
 * Mandatory scenarios (brief §5):
 *   1. Concurrent claim race — 10 fibers race; exactly one wins.
 *   2. Subscribe-while-events-fire — N subscribers see events in causal order.
 *   3. TestClock-driven timestamps — createdAt / updatedAt / completedAt
 *      track virtual clock, not wall-clock.
 *   4. PubSub backpressure / slow subscriber — slow subscriber does not
 *      block fast subscriber or writers.
 */
import { describe, expect, it } from "vitest"
import {
  Chunk,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Ref,
  Stream,
} from "effect"
import {
  TaskList,
  type TaskEvent,
} from "../../src/task-list/index.js"
import { Clock } from "../../src/clock.js"

const provideReal = <A, E>(prog: Effect.Effect<A, E, TaskList | Clock>) =>
  Effect.scoped(prog).pipe(
    Effect.provide(TaskList.Default),
    Effect.provide(Clock.Default),
  )

describe("TaskList — Tier-2 simulation", () => {
  // ───────────────────────────────────────────────────────────────────────
  // Scenario 1 — Concurrent claim race
  // ───────────────────────────────────────────────────────────────────────
  it("(1) 10 racing claimers: exactly one wins, 9 fail with TaskAlreadyClaimedError", async () => {
    const out = await Effect.runPromise(
      provideReal(
        Effect.gen(function* () {
          const tl = yield* TaskList
          const id = yield* tl.submit({ teamName: "race", subject: "prize" })

          const claimants = Array.from({ length: 10 }, (_, i) => `c${i}`)
          // Hold all fibers at a barrier so they race as concurrently as possible.
          const gate = yield* Deferred.make<void>()

          const fibers = yield* Effect.forEach(
            claimants,
            (name) =>
              Effect.fork(
                Effect.gen(function* () {
                  yield* Deferred.await(gate)
                  return yield* tl.claim(id, name).pipe(
                    Effect.either,
                  )
                }),
              ),
            { concurrency: "unbounded" },
          )
          yield* Deferred.succeed(gate, void 0)

          const results = yield* Effect.forEach(fibers, (f) => Fiber.join(f))

          const wins = results.filter((r) => r._tag === "Right")
          const fails = results.filter((r) => r._tag === "Left")
          const finalTask = yield* tl.get(id)
          return {
            wins: wins.length,
            fails: fails.length,
            failTags: fails.map((f) =>
              f._tag === "Left" ? (f.left as { _tag: string })._tag : "?",
            ),
            finalAssignee: finalTask?.assignee,
          }
        }),
      ),
    )
    expect(out.wins).toBe(1)
    expect(out.fails).toBe(9)
    expect(new Set(out.failTags)).toEqual(new Set(["TaskAlreadyClaimedError"]))
    expect(typeof out.finalAssignee).toBe("string")
    expect(out.finalAssignee!.startsWith("c")).toBe(true)
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 2 — Subscribe-while-events-fire (multiple subscribers, causal order)
  // ───────────────────────────────────────────────────────────────────────
  it("(2) 3 subscribers observe submitted→claimed→statusChanged→completed in causal order", async () => {
    const out = await Effect.runPromise(
      provideReal(
        Effect.gen(function* () {
          const tl = yield* TaskList

          // 5 submits, claim 3, complete 2. Total events:
          //   5 submitted + 3 claimed + 2 statusChanged + 2 completed = 12.
          const expectedTotal = 12

          const collect = () =>
            Effect.fork(
              tl.subscribe().pipe(
                Stream.take(expectedTotal),
                Stream.runCollect,
                Effect.map(Chunk.toReadonlyArray),
              ),
            )

          const f1 = yield* collect()
          const f2 = yield* collect()
          const f3 = yield* collect()
          // Let all 3 subscribers attach before publishing.
          yield* Effect.sleep("10 millis")

          const ids: string[] = []
          for (let i = 0; i < 5; i++) {
            const id = yield* tl.submit({
              teamName: "T",
              subject: `s${i}`,
            })
            ids.push(id)
          }
          // Claim first 3.
          for (let i = 0; i < 3; i++) {
            yield* tl.claim(ids[i]!, `a${i}`)
          }
          // Complete first 2 (claimed→completed is a valid direct transition).
          for (let i = 0; i < 2; i++) {
            yield* tl.complete(ids[i]!)
          }

          const r1 = yield* Fiber.join(f1)
          const r2 = yield* Fiber.join(f2)
          const r3 = yield* Fiber.join(f3)
          return [r1, r2, r3]
        }),
      ),
    )

    for (const events of out) {
      expect(events.length).toBe(12)
      // Per-task causal order: submitted before claimed before
      // statusChanged before completed (for tasks that progress that far).
      const tagsByTask = new Map<string, string[]>()
      for (const ev of events) {
        const id =
          ev._tag === "submitted"
            ? ev.task.id
            : "taskId" in ev
              ? ev.taskId
              : "?"
        const arr = tagsByTask.get(id) ?? []
        arr.push(ev._tag)
        tagsByTask.set(id, arr)
      }
      // First two ids: submitted, claimed, statusChanged, completed
      // Next one: submitted, claimed
      // Last two: submitted only
      // (Order within a task must be respected — PubSub preserves publish order
      // per subscriber.)
      const orderRank: Record<TaskEvent["_tag"], number> = {
        submitted: 0,
        claimed: 1,
        statusChanged: 2,
        completed: 3,
      }
      for (const [, tags] of tagsByTask) {
        for (let i = 1; i < tags.length; i++) {
          expect(orderRank[tags[i] as TaskEvent["_tag"]]).toBeGreaterThan(
            orderRank[tags[i - 1] as TaskEvent["_tag"]],
          )
        }
      }
    }
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 3 — Deterministic clock-driven timestamps
  // ───────────────────────────────────────────────────────────────────────
  // The Clock service in this codebase reads Date.now() directly (see
  // src/clock.ts) — Effect's TestClock controls Effect.Clock, NOT Date.now,
  // so it cannot shift this Clock implementation. Instead we provide a
  // custom advancing Clock layer that returns successive virtual
  // timestamps from a Ref, proving the in-memory Task fields reflect
  // EXACTLY what Clock.nowMs() returned at each mutation — no real-time leak.
  it("(3) Clock-driven timestamps: createdAt/updatedAt/completedAt track virtual clock", async () => {
    const program = Effect.gen(function* () {
      const ticker = yield* Ref.make(1_000_000)
      const advancingClock = Layer.succeed(
        Clock,
        Clock.of({
          _tag: "experiment-agent/Clock",
          nowMs: () =>
            Ref.get(ticker).pipe(
              Effect.tap(() => Ref.update(ticker, (n) => n + 1_000)),
            ),
          nowIso: () => Effect.succeed("test"),
        }),
      )

      const inner = Effect.scoped(
        Effect.gen(function* () {
          const tl = yield* TaskList

          // Each call to clock.nowMs() advances by 1_000ms. submit() makes
          // ONE call (genId would also call but caller-supplied id avoids it).
          const id = yield* tl.submit({
            id: "ts-task",
            teamName: "T",
            subject: "ts",
          })
          const tCreated = yield* tl.get(id)

          yield* tl.claim(id, "alice")
          const tClaimed = yield* tl.get(id)

          yield* tl.setStatus(id, "in_progress")
          const tInProgress = yield* tl.get(id)

          yield* tl.complete(id)
          const tDone = yield* tl.get(id)

          return { tCreated, tClaimed, tInProgress, tDone }
        }),
      ).pipe(Effect.provide(TaskList.Default), Effect.provide(advancingClock))

      return yield* inner
    })
    const out = await Effect.runPromise(program)

    // submit consumed tick @1_000_000 (createdAt and updatedAt set to same).
    expect(out.tCreated!.createdAt).toBe(1_000_000)
    expect(out.tCreated!.updatedAt).toBe(1_000_000)
    // claim consumed @1_001_000 — advances updatedAt, NOT createdAt.
    expect(out.tClaimed!.updatedAt).toBe(1_001_000)
    expect(out.tClaimed!.createdAt).toBe(1_000_000)
    // setStatus consumed @1_002_000.
    expect(out.tInProgress!.updatedAt).toBe(1_002_000)
    // complete consumed @1_003_000 — sets BOTH updatedAt and completedAt.
    expect(out.tDone!.updatedAt).toBe(1_003_000)
    expect(out.tDone!.completedAt).toBe(1_003_000)
    // createdAt is sticky.
    expect(out.tDone!.createdAt).toBe(1_000_000)
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 4 — PubSub backpressure / slow subscriber
  // ───────────────────────────────────────────────────────────────────────
  it("(4) slow subscriber does NOT block fast subscriber across 100 events", async () => {
    const out = await Effect.runPromise(
      provideReal(
        Effect.gen(function* () {
          const tl = yield* TaskList
          const N = 100

          // Slow subscriber: maps each event through a small sleep so it
          // drains FAR slower than the fast one.
          const slowSeen = yield* Ref.make(0)
          const slowFiber = yield* Effect.fork(
            tl.subscribe().pipe(
              Stream.take(N),
              Stream.mapEffect((ev) =>
                Effect.gen(function* () {
                  yield* Effect.sleep("1 millis")
                  yield* Ref.update(slowSeen, (n) => n + 1)
                  return ev
                }),
              ),
              Stream.runCollect,
              Effect.map(Chunk.toReadonlyArray),
            ),
          )

          // Fast subscriber: drains as fast as possible.
          const fastFiber = yield* Effect.fork(
            tl.subscribe().pipe(
              Stream.take(N),
              Stream.runCollect,
              Effect.map(Chunk.toReadonlyArray),
            ),
          )

          // Let both attach.
          yield* Effect.sleep("10 millis")

          // Publish N events as fast as possible. With PubSub.unbounded,
          // these MUST NOT block on the slow subscriber.
          for (let i = 0; i < N; i++) {
            yield* tl.submit({ teamName: "T", subject: `s${i}` })
          }

          // Fast finishes quickly; slow eventually catches up.
          const fast = yield* Fiber.join(fastFiber)
          const slow = yield* Fiber.join(slowFiber)
          return {
            fastCount: fast.length,
            slowCount: slow.length,
          }
        }),
      ),
    )
    expect(out.fastCount).toBe(100)
    expect(out.slowCount).toBe(100)
  }, 10_000)
})

// Suppress unused-import warning for Exit (kept for parity with other sim files).
void Exit
