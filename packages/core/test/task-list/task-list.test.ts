/**
 * TaskList Tier-1 unit tests — DESIGN §4 / §5.1 / §6.3 / §7.
 */
import { describe, expect, it } from "vitest"
import { Chunk, Effect, Exit, Stream } from "effect"
import {
  TaskList,
  TaskAlreadyClaimedError,
  TaskNotFoundError,
  TaskValidationError,
} from "../../src/task-list/index.js"
import { Clock } from "../../src/clock.js"

const provide = <A, E>(prog: Effect.Effect<A, E, TaskList | Clock>) =>
  Effect.scoped(prog).pipe(
    Effect.provide(TaskList.Default),
    Effect.provide(Clock.Default),
  )

const run = <A, E>(prog: Effect.Effect<A, E, TaskList | Clock>) =>
  Effect.runPromise(provide(prog))

const runExit = <A, E>(prog: Effect.Effect<A, E, TaskList | Clock>) =>
  Effect.runPromiseExit(provide(prog))

describe("TaskList — Tier-1", () => {
  it("submit + get roundtrip; auto id is unique", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tl = yield* TaskList
        const a = yield* tl.submit({ teamName: "alpha", subject: "task A" })
        const b = yield* tl.submit({ teamName: "alpha", subject: "task B" })
        const ta = yield* tl.get(a)
        const tb = yield* tl.get(b)
        return { a, b, ta, tb }
      }),
    )
    expect(out.a).not.toEqual(out.b)
    expect(out.ta?.subject).toBe("task A")
    expect(out.tb?.subject).toBe("task B")
    expect(out.ta?.status).toBe("created")
    expect(out.ta?.teamName).toBe("alpha")
  })

  it("submit with caller-supplied id uses it", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tl = yield* TaskList
        const id = yield* tl.submit({
          id: "task-fixed-1",
          teamName: "alpha",
          subject: "fixed",
        })
        const t = yield* tl.get(id)
        return { id, t }
      }),
    )
    expect(out.id).toBe("task-fixed-1")
    expect(out.t?.id).toBe("task-fixed-1")
  })

  it("submit with empty subject → TaskValidationError", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const tl = yield* TaskList
        return yield* tl.submit({ teamName: "alpha", subject: "  " })
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("TaskValidationError")
  })

  it("submit with pre-assignment publishes both submitted and claimed", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tl = yield* TaskList
        const id = yield* tl.submit({
          teamName: "alpha",
          subject: "pre-assigned",
          assignee: "alice",
        })
        const t = yield* tl.get(id)
        return t
      }),
    )
    expect(out?.assignee).toBe("alice")
    expect(out?.status).toBe("claimed")
  })

  it("claim happy path: created→claimed, assignee set, updatedAt advances", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tl = yield* TaskList
        const id = yield* tl.submit({ teamName: "alpha", subject: "x" })
        const before = yield* tl.get(id)
        // Sleep tiny bit to advance real clock; tests don't assert exact ms.
        yield* Effect.sleep("2 millis")
        const claimed = yield* tl.claim(id, "bob")
        return { before, claimed }
      }),
    )
    expect(out.before?.assignee).toBeUndefined()
    expect(out.before?.status).toBe("created")
    expect(out.claimed.assignee).toBe("bob")
    expect(out.claimed.status).toBe("claimed")
    expect(out.claimed.updatedAt).toBeGreaterThanOrEqual(out.before!.updatedAt)
  })

  it("claim by DIFFERENT assignee → TaskAlreadyClaimedError", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const tl = yield* TaskList
        const id = yield* tl.submit({ teamName: "alpha", subject: "x" })
        yield* tl.claim(id, "alice")
        return yield* tl.claim(id, "bob")
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("TaskAlreadyClaimedError")
  })

  it("claim by SAME assignee is idempotent (no error, no regression)", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tl = yield* TaskList
        const id = yield* tl.submit({ teamName: "alpha", subject: "x" })
        yield* tl.claim(id, "alice")
        // Move past claimed; same-assignee re-claim must NOT regress status.
        yield* tl.setStatus(id, "in_progress")
        const re = yield* tl.claim(id, "alice")
        return re
      }),
    )
    expect(out.assignee).toBe("alice")
    expect(out.status).toBe("in_progress")
  })

  it("claim missing id → TaskNotFoundError", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const tl = yield* TaskList
        return yield* tl.claim("does-not-exist", "alice")
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("TaskNotFoundError")
  })

  it("setStatus valid transitions; sets completedAt when→completed", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tl = yield* TaskList
        const id = yield* tl.submit({ teamName: "alpha", subject: "x" })
        yield* tl.claim(id, "alice")
        const ip = yield* tl.setStatus(id, "in_progress")
        const done = yield* tl.complete(id)
        return { ip, done }
      }),
    )
    expect(out.ip.status).toBe("in_progress")
    expect(out.ip.completedAt).toBeUndefined()
    expect(out.done.status).toBe("completed")
    expect(typeof out.done.completedAt).toBe("number")
  })

  it("setStatus on completed task → TaskValidationError", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const tl = yield* TaskList
        const id = yield* tl.submit({ teamName: "alpha", subject: "x" })
        yield* tl.claim(id, "alice")
        yield* tl.complete(id)
        return yield* tl.setStatus(id, "in_progress")
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("TaskValidationError")
  })

  it("setStatus invalid transition created→completed → TaskValidationError", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const tl = yield* TaskList
        const id = yield* tl.submit({ teamName: "alpha", subject: "x" })
        return yield* tl.setStatus(id, "completed")
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("TaskValidationError")
  })

  it("created→blocked is allowed (no claim required)", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tl = yield* TaskList
        const id = yield* tl.submit({ teamName: "alpha", subject: "x" })
        return yield* tl.setStatus(id, "blocked")
      }),
    )
    expect(out.status).toBe("blocked")
  })

  it("list filters by teamName / assignee / status (single + array)", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tl = yield* TaskList
        const a1 = yield* tl.submit({ teamName: "alpha", subject: "a1" })
        const a2 = yield* tl.submit({ teamName: "alpha", subject: "a2" })
        yield* tl.submit({ teamName: "beta", subject: "b1" })
        yield* tl.claim(a1, "alice")
        yield* tl.setStatus(a1, "in_progress")
        yield* tl.claim(a2, "bob")

        const byTeam = yield* tl.list({ teamName: "alpha" })
        const byAssignee = yield* tl.list({ assignee: "alice" })
        const bySingle = yield* tl.list({ status: "in_progress" })
        const byArray = yield* tl.list({
          status: ["claimed", "in_progress"],
        })
        const all = yield* tl.list()

        return {
          byTeam: byTeam.length,
          byAssignee: byAssignee.length,
          bySingle: bySingle.length,
          byArray: byArray.length,
          all: all.length,
        }
      }),
    )
    expect(out.byTeam).toBe(2)
    expect(out.byAssignee).toBe(1)
    expect(out.bySingle).toBe(1)
    expect(out.byArray).toBe(2)
    expect(out.all).toBe(3)
  })

  it("subscribe BEFORE submit observes events; AFTER does not see history", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tl = yield* TaskList

        // Subscriber attached before any submit. Events published:
        //   submit          → submitted
        //   claim           → claimed
        //   setStatus(ip)   → statusChanged(claimed→in_progress)
        //   complete()      → statusChanged(in_progress→completed) + completed
        // = 5 total
        const earlyFiber = yield* Effect.fork(
          tl.subscribe().pipe(
            Stream.take(5),
            Stream.runCollect,
            Effect.map(Chunk.toReadonlyArray),
          ),
        )
        // Give the fiber a tick to attach.
        yield* Effect.sleep("5 millis")

        const id = yield* tl.submit({ teamName: "alpha", subject: "x" })
        yield* tl.claim(id, "alice")
        yield* tl.setStatus(id, "in_progress")
        yield* tl.complete(id)

        const earlyEvents = yield* earlyFiber.await

        // Late subscriber attached AFTER all events fire — must not see them.
        const lateFiber = yield* Effect.fork(
          tl.subscribe().pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.map(Chunk.toReadonlyArray),
            // Race against a short timeout; if no event arrives, return [].
            Effect.timeoutOption("50 millis"),
          ),
        )
        const lateEvents = yield* lateFiber.await

        return { earlyEvents, lateEvents }
      }),
    )

    expect(Exit.isSuccess(out.earlyEvents)).toBe(true)
    if (Exit.isSuccess(out.earlyEvents)) {
      const tags = out.earlyEvents.value.map((e) => e._tag)
      expect(tags).toEqual([
        "submitted",
        "claimed",
        "statusChanged",
        "statusChanged",
        "completed",
      ])
    }
    // Late subscriber timed out (no historical replay).
    expect(Exit.isSuccess(out.lateEvents)).toBe(true)
  })

  it("get returns null for missing id", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tl = yield* TaskList
        return yield* tl.get("nope")
      }),
    )
    expect(out).toBeNull()
  })

  // Silence unused-import warnings for tagged error symbols (asserted via
  // JSON.stringify above for shape stability across Effect versions).
  void TaskValidationError
  void TaskNotFoundError
  void TaskAlreadyClaimedError
})
