/**
 * JobsStore tests — covers Memory layer (deterministic, no SQLite).
 * SQLite-layer coverage rolls in via scheduler-tools' integration tests
 * which exercise the boot-reload path end-to-end with a real bun:sqlite DB.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { JobsStoreService } from "./jobs-store.js"

const TestLayer = JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))

describe("JobsStoreService (Memory layer)", () => {
  it("records and lists a cron job", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const job = yield* store.record({
        id: "trigger-1",
        kind: "cron",
        spec: "*/30 * * * *",
        payload: { label: "luna-self-dev", source: "scheduler-tools" },
      })
      expect(job.id).toBe("trigger-1")
      expect(job.spec).toBe("*/30 * * * *")
      expect(job.kind).toBe("cron")
      expect(job.payload).toEqual({
        label: "luna-self-dev",
        source: "scheduler-tools",
      })

      const all = yield* store.listAll()
      expect(all.length).toBe(1)
      expect(all[0]?.id).toBe("trigger-1")
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("getById returns null for missing rows", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const missing = yield* store.getById("nope")
      expect(missing).toBeNull()
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("rejects duplicate ids on record()", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({
        id: "dup",
        kind: "cron",
        spec: "0 * * * *",
        payload: { label: "first" },
      })
      const second = yield* Effect.either(
        store.record({
          id: "dup",
          kind: "cron",
          spec: "0 * * * *",
          payload: { label: "second" },
        }),
      )
      expect(second._tag).toBe("Left")
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("remove() deletes a row and returns true; idempotent on missing", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({
        id: "rm",
        kind: "cron",
        spec: "0 0 * * *",
        payload: { label: "doomed" },
      })
      const first = yield* store.remove("rm")
      expect(first).toBe(true)
      const second = yield* store.remove("rm")
      expect(second).toBe(false)
      const after = yield* store.listAll()
      expect(after.length).toBe(0)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("touch() updates opportunistic columns without bumping createdAt", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const original = yield* store.record({
        id: "t1",
        kind: "cron",
        spec: "*/5 * * * *",
        payload: { label: "ticky" },
      })
      const updated = yield* store.touch("t1", {
        nextRun: 1_000_000,
        lastRun: 999_000,
        lastStatus: "fired",
      })
      expect(updated).toBe(true)
      const re = yield* store.getById("t1")
      expect(re?.nextRun).toBe(1_000_000)
      expect(re?.lastRun).toBe(999_000)
      expect(re?.lastStatus).toBe("fired")
      expect(re?.createdAt).toBe(original.createdAt)
      // updatedAt must monotonically advance (or at least equal, given a deterministic Clock)
      expect((re?.updatedAt ?? 0) >= original.updatedAt).toBe(true)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("touch() on missing id returns false", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const result = yield* store.touch("ghost", { lastStatus: "x" })
      expect(result).toBe(false)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("listAll returns rows in createdAt ASC order", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      // The Clock from Clock.Default uses real wallclock; record three jobs
      // back-to-back. We expect insertion order to be preserved by ASC sort
      // because each record() takes a fresh nowMs() at least 0 ms after the
      // last. Insertion order ties are broken by Map insertion order, which
      // is consistent with createdAt monotonicity here.
      yield* store.record({
        id: "a",
        kind: "cron",
        spec: "0 1 * * *",
        payload: { label: "a" },
      })
      yield* store.record({
        id: "b",
        kind: "cron",
        spec: "0 2 * * *",
        payload: { label: "b" },
      })
      yield* store.record({
        id: "c",
        kind: "cron",
        spec: "0 3 * * *",
        payload: { label: "c" },
      })
      const all = yield* store.listAll()
      expect(all.map((j) => j.id)).toEqual(["a", "b", "c"])
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })
})
