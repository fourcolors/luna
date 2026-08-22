/**
 * TeamBroker — Tier-2 simulation tests (Phase 11c).
 *
 * Real `Effect.sleep` with generous tolerances per brief §8 deviation note;
 * lag-threshold tests pick small wall-clock numbers (50–100 ms) and the
 * watchdog tick is set commensurately. Lead-scope-close test uses
 * `Layer.buildWithScope` + `Scope.close` (the standard Effect scope-teardown
 * pattern).
 */
import { describe, expect, it } from "vitest"
import {
  Chunk,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect"
import { Clock } from "../src/clock.js"
import { TaskList } from "../src/task-list/index.js"
import { TeamBroker } from "../src/team-broker/index.js"
import type {
  TeamEvent,
  TeamMsg,
  TeammateSpec,
} from "../src/team-broker/index.js"

// Compose all required layers under one Scope-managed program.
// Layer wiring: TeamBroker.Default requires Clock | TaskList;
// TaskList.Default requires Clock. Chain via Layer.provide so each
// layer gets its deps satisfied before being built.
const makeFullLayer = () => {
  const clockL = Clock.Default
  const taskL = TaskList.Default.pipe(Layer.provide(clockL))
  const teamL = TeamBroker.Default.pipe(
    Layer.provide(clockL),
    Layer.provide(taskL),
  )
  // Expose all three services to the test program.
  return Layer.mergeAll(teamL, taskL, clockL)
}

const provide = <A, E>(
  prog: Effect.Effect<A, E, TeamBroker | TaskList | Clock>,
) => Effect.scoped(prog.pipe(Effect.provide(makeFullLayer())))

const run = <A, E>(
  prog: Effect.Effect<A, E, TeamBroker | TaskList | Clock>,
) => Effect.runPromise(provide(prog))

// Spin up an event-collector fiber that captures all TeamEvents in a Ref.
// Uses forkDaemon so its interrupt (on scope close) doesn't surface as a
// failure in the outer scoped effect.
const startCollector = (broker: { events: Stream.Stream<TeamEvent> }) =>
  Effect.gen(function* () {
    const sink = yield* Ref.make<ReadonlyArray<TeamEvent>>([])
    const fiber = yield* Effect.forkDetach(
      broker.events.pipe(
        Stream.runForEach((e) => Ref.update(sink, (xs) => [...xs, e])),
      ),
    )
    return { sink, fiber }
  })

// A teammate loop that drains its mailbox into a sink Ref and (optionally)
// completes received tasks via the provided TaskList instance.
const recordingLoop = (
  sink: Ref.Ref<ReadonlyArray<TeamMsg>>,
  taskList: TaskList["Type"],
  options: { complete: boolean } = { complete: true },
): TeammateSpec["loop"] =>
  (mailbox) =>
    Effect.gen(function* () {
      while (true) {
        const msg = yield* Queue.take(mailbox)
        yield* Ref.update(sink, (xs) => [...xs, msg])
        if (options.complete && msg._tag === "task") {
          yield* taskList.setStatus(msg.taskId, "in_progress").pipe(
            Effect.ignore,
          )
          yield* taskList.complete(msg.taskId).pipe(Effect.ignore)
        }
      }
    })

describe("TeamBroker — Tier-2", () => {
  it("(1) happy path: spawn + dispatch → loop receives task, completes it", async () => {
    const out = await run(
      Effect.gen(function* () {
        const broker = yield* TeamBroker
        const tl = yield* TaskList
        const aliceSink = yield* Ref.make<ReadonlyArray<TeamMsg>>([])
        const bobSink = yield* Ref.make<ReadonlyArray<TeamMsg>>([])

        const { sink: events } = yield* startCollector(broker)

        yield* broker.spawn({
          name: "tA",
          orphanCheckIntervalMs: 1_000_000, // suppress watchdog ticks
          teammates: [
            { name: "alice", loop: recordingLoop(aliceSink, tl) },
            { name: "bob", loop: recordingLoop(bobSink, tl) },
          ],
        })

        const taskId = yield* tl.submit({
          teamName: "tA",
          subject: "do the thing",
        })
        yield* broker.dispatch("tA", "alice", taskId)

        // Wait for alice's loop to drain + complete task.
        yield* Effect.sleep(Duration.millis(40))

        const aliceMsgs = yield* Ref.get(aliceSink)
        const bobMsgs = yield* Ref.get(bobSink)
        const t = yield* tl.get(taskId)
        const evs = yield* Ref.get(events)
        return { aliceMsgs, bobMsgs, t, evs }
      }),
    )
    expect(out.aliceMsgs).toHaveLength(1)
    expect(out.aliceMsgs[0]).toEqual({ _tag: "task", taskId: expect.any(String) })
    expect(out.bobMsgs).toHaveLength(0)
    expect(out.t?.status).toBe("completed")
    // Only "started" events should have fired (no orphan/lag/stopped).
    const tags = out.evs.map((e) => e._tag).sort()
    expect(tags).toEqual(["started", "started"])
  })

  it("(2) reconcile on spawn: pre-claimed task does NOT spuriously orphan or lag", async () => {
    const out = await run(
      Effect.gen(function* () {
        const broker = yield* TeamBroker
        const tl = yield* TaskList
        // Pre-claim BEFORE broker spawn.
        const taskId = yield* tl.submit({
          teamName: "tB",
          subject: "pre-claimed",
          assignee: "alice",
        })
        yield* tl.setStatus(taskId, "in_progress")

        const aliceSink = yield* Ref.make<ReadonlyArray<TeamMsg>>([])
        const { sink: events } = yield* startCollector(broker)

        yield* broker.spawn({
          name: "tB",
          // High threshold so reconcile-time updatedAt isn't immediately lagging.
          lagThresholdMs: 5_000,
          orphanCheckIntervalMs: 20,
          teammates: [
            {
              name: "alice",
              // Don't auto-complete — we want to verify NO orphan/lag fires
              // even though task is held.
              loop: recordingLoop(aliceSink, tl, { complete: false }),
            },
          ],
        })
        // Let several watchdog ticks pass.
        yield* Effect.sleep(Duration.millis(80))
        const evs = yield* Ref.get(events)
        return evs
      }),
    )
    const tags = out.map((e) => e._tag).sort()
    expect(tags).toEqual(["started"])
  })

  it("(3) lag detection: dispatched task held → exactly ONE lag event (debounced)", async () => {
    const out = await run(
      Effect.gen(function* () {
        const broker = yield* TeamBroker
        const tl = yield* TaskList
        const aliceSink = yield* Ref.make<ReadonlyArray<TeamMsg>>([])
        const { sink: events } = yield* startCollector(broker)
        yield* broker.spawn({
          name: "tC",
          lagThresholdMs: 50,
          orphanCheckIntervalMs: 20,
          teammates: [
            {
              name: "alice",
              loop: recordingLoop(aliceSink, tl, { complete: false }),
            },
          ],
        })
        const taskId = yield* tl.submit({
          teamName: "tC",
          subject: "stuck task",
        })
        yield* broker.dispatch("tC", "alice", taskId)
        // Let many watchdog ticks fire past lag threshold.
        yield* Effect.sleep(Duration.millis(200))
        const evs = yield* Ref.get(events)
        return evs
      }),
    )
    const lagEvents = out.filter((e) => e._tag === "lag")
    expect(lagEvents).toHaveLength(1)
    if (lagEvents[0]?._tag === "lag") {
      expect(lagEvents[0].error._tag).toBe("TaskCompletionLagError")
    }
  })

  it("(4) lag clears on completion; new claim by same teammate can lag again", async () => {
    const out = await run(
      Effect.gen(function* () {
        const broker = yield* TeamBroker
        const tl = yield* TaskList
        const aliceSink = yield* Ref.make<ReadonlyArray<TeamMsg>>([])
        // Manual loop: receive + record but don't complete; we'll drive
        // completion from outside.
        const loop: TeammateSpec["loop"] = (mailbox) =>
          Effect.gen(function* () {
            while (true) {
              const m = yield* Queue.take(mailbox)
              yield* Ref.update(aliceSink, (xs) => [...xs, m])
            }
          })
        const { sink: events } = yield* startCollector(broker)
        yield* broker.spawn({
          name: "tD",
          lagThresholdMs: 50,
          orphanCheckIntervalMs: 20,
          teammates: [{ name: "alice", loop }],
        })
        // First task → lags → complete → no more lag for it.
        const t1 = yield* tl.submit({ teamName: "tD", subject: "t1" })
        yield* broker.dispatch("tD", "alice", t1)
        yield* Effect.sleep(Duration.millis(120))
        // Should have one lag for t1 by now.
        let evs = yield* Ref.get(events)
        const lag1 = evs.filter((e) => e._tag === "lag")
        // Mark complete; subscriber should clear bookkeeping.
        yield* tl.setStatus(t1, "in_progress")
        yield* tl.complete(t1)
        yield* Effect.sleep(Duration.millis(80))
        // No additional lag events for t1.
        evs = yield* Ref.get(events)
        const lagsForT1Phase2 = evs.filter(
          (e) =>
            e._tag === "lag" && e.error.taskId === t1,
        )
        // Now dispatch a second task → lags independently.
        const t2 = yield* tl.submit({ teamName: "tD", subject: "t2" })
        yield* broker.dispatch("tD", "alice", t2)
        yield* Effect.sleep(Duration.millis(120))
        evs = yield* Ref.get(events)
        return { lag1count: lag1.length, lagsForT1Phase2: lagsForT1Phase2.length, evs }
      }),
    )
    expect(out.lag1count).toBe(1)
    expect(out.lagsForT1Phase2).toBe(1) // unchanged from phase 1
    const lagsForT2 = out.evs.filter(
      (e) => e._tag === "lag" && e.error.taskId !== undefined,
    )
    // Just verify a NEW lag event with a different taskId fired.
    const distinctLagTaskIds = new Set(
      out.evs
        .filter((e) => e._tag === "lag")
        .map((e) => (e._tag === "lag" ? e.error.taskId : "")),
    )
    expect(distinctLagTaskIds.size).toBe(2)
    void lagsForT2
  })

  it("(5) lead-Scope close → orphan reason 'lead_exited'", async () => {
    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* Ref.make<ReadonlyArray<TeamEvent>>([])

        // Build all layers with correct dep wiring (same as makeFullLayer).
        const scope = yield* Scope.make()
        const clockL = Clock.Default
        const taskL = TaskList.Default.pipe(Layer.provide(clockL))
        const teamL = TeamBroker.Default.pipe(
          Layer.provide(clockL),
          Layer.provide(taskL),
        )
        const layer = Layer.mergeAll(teamL, taskL, clockL)
        const ctx = yield* Layer.buildWithScope(scope)(layer)

        const drainer = yield* Effect.gen(function* () {
          const broker = yield* TeamBroker
          const drainer = yield* Effect.forkDetach(
            broker.events.pipe(
              Stream.runForEach((e) => Ref.update(sink, (xs) => [...xs, e])),
              // ignore stream termination when queue shuts down
              Effect.catchCause(() => Effect.void),
            ),
          )
          const noopLoop: TeammateSpec["loop"] = () => Effect.never
          yield* broker.spawn({
            name: "tE",
            orphanCheckIntervalMs: 1_000_000,
            teammates: [
              { name: "alice", loop: noopLoop },
              { name: "bob", loop: noopLoop },
            ],
          })
          // Give the started events time to flush.
          yield* Effect.sleep(Duration.millis(20))
          return drainer
        }).pipe(Effect.provide(ctx))

        // Close the scope. Broker's layer finalizer tears down all teams
        // (emits orphan events) THEN shuts down the queue.
        yield* Scope.close(scope, Exit.void)
        // Wait for drainer to finish (it will when the queue shuts down).
        yield* Fiber.await(drainer)
        return yield* Ref.get(sink)
      }),
    )
    const orphans = collected.filter((e) => e._tag === "orphaned")
    expect(orphans).toHaveLength(2)
    expect(
      orphans.every(
        (e) => e._tag === "orphaned" && e.error.reason === "lead_exited",
      ),
    ).toBe(true)
  })

  it("(6) explicit dissolve → orphan reason 'scope_closed'", async () => {
    const out = await run(
      Effect.gen(function* () {
        const broker = yield* TeamBroker
        const { sink: events } = yield* startCollector(broker)
        const noopLoop: TeammateSpec["loop"] = () => Effect.never
        yield* broker.spawn({
          name: "tF",
          orphanCheckIntervalMs: 1_000_000,
          teammates: [
            { name: "alice", loop: noopLoop },
            { name: "bob", loop: noopLoop },
          ],
        })
        yield* Effect.sleep(Duration.millis(10))
        yield* broker.dissolve("tF")
        yield* Effect.sleep(Duration.millis(20))
        return yield* Ref.get(events)
      }),
    )
    const orphans = out.filter((e) => e._tag === "orphaned")
    expect(orphans).toHaveLength(2)
    expect(
      orphans.every(
        (e) => e._tag === "orphaned" && e.error.reason === "scope_closed",
      ),
    ).toBe(true)
  })

  it("(7) dispatch failure: claiming already-claimed task → IntegrityError, no mailbox push", async () => {
    const out = await run(
      Effect.gen(function* () {
        const broker = yield* TeamBroker
        const tl = yield* TaskList
        const aliceSink = yield* Ref.make<ReadonlyArray<TeamMsg>>([])
        const bobSink = yield* Ref.make<ReadonlyArray<TeamMsg>>([])
        yield* broker.spawn({
          name: "tG",
          orphanCheckIntervalMs: 1_000_000,
          teammates: [
            { name: "alice", loop: recordingLoop(aliceSink, tl, { complete: false }) },
            { name: "bob", loop: recordingLoop(bobSink, tl, { complete: false }) },
          ],
        })
        const taskId = yield* tl.submit({ teamName: "tG", subject: "x" })
        yield* broker.dispatch("tG", "alice", taskId)
        const exit = yield* broker.dispatch("tG", "bob", taskId).pipe(Effect.exit)
        yield* Effect.sleep(Duration.millis(20))
        const aliceMsgs = yield* Ref.get(aliceSink)
        const bobMsgs = yield* Ref.get(bobSink)
        return { exit, aliceMsgs, bobMsgs }
      }),
    )
    expect(Exit.isFailure(out.exit)).toBe(true)
    expect(JSON.stringify(out.exit)).toContain("IntegrityError")
    expect(out.aliceMsgs).toHaveLength(1)
    expect(out.bobMsgs).toHaveLength(0)
  })

  it("(8) idempotent dissolve: calling twice → no error, no double events", async () => {
    const out = await run(
      Effect.gen(function* () {
        const broker = yield* TeamBroker
        const { sink: events } = yield* startCollector(broker)
        const noopLoop: TeammateSpec["loop"] = () => Effect.never
        yield* broker.spawn({
          name: "tH",
          orphanCheckIntervalMs: 1_000_000,
          teammates: [{ name: "alice", loop: noopLoop }],
        })
        yield* Effect.sleep(Duration.millis(10))
        yield* broker.dissolve("tH")
        yield* broker.dissolve("tH")
        yield* broker.dissolve("tH")
        yield* Effect.sleep(Duration.millis(20))
        return yield* Ref.get(events)
      }),
    )
    const orphans = out.filter((e) => e._tag === "orphaned")
    expect(orphans).toHaveLength(1)
  })

  it("(9) send: raw payload reaches teammate as {_tag: 'raw'}", async () => {
    const out = await run(
      Effect.gen(function* () {
        const broker = yield* TeamBroker
        const tl = yield* TaskList
        const aliceSink = yield* Ref.make<ReadonlyArray<TeamMsg>>([])
        yield* broker.spawn({
          name: "tI",
          orphanCheckIntervalMs: 1_000_000,
          teammates: [
            { name: "alice", loop: recordingLoop(aliceSink, tl, { complete: false }) },
          ],
        })
        yield* broker.send("tI", "alice", { hello: "world" })
        yield* Effect.sleep(Duration.millis(20))
        return yield* Ref.get(aliceSink)
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ _tag: "raw", payload: { hello: "world" } })
  })

  // Suppress unused-import warning for Chunk (kept for future Stream-collect tests).
  void Chunk
})
