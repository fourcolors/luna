/**
 * JobTicker tests — deterministic via TestClock + Memory JobsStore + stub
 * WorkerRegistry. No SQLite, no real sleep, no real model calls.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Duration } from "effect"
import { Clock } from "../clock.js"
import { JobsStoreService } from "./jobs-store.js"
import { JobTicker, JobTickerLayer } from "./job-ticker.js"
import {
  WorkerRegistry,
  WorkerError,
  makeWorkerRegistry,
  type Worker,
} from "./worker-registry.js"

/** Build a test stack: ticker + memory jobs store + worker registry.
 *  Clock.Default is provided to BOTH the Memory store (its private dep) and
 *  exposed at the top so the ticker layer sees it too.
 */
const buildStack = (workers: Record<string, Worker>) => {
  const storeL = JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))
  const regL = makeWorkerRegistry(workers)
  return JobTickerLayer({ tickInterval: Duration.seconds(60) }).pipe(
    Layer.provideMerge(Layer.mergeAll(storeL, regL, Clock.Default)),
  )
}

describe("JobTicker", () => {
  it("drain on an empty store reports zeroes and no errors", async () => {
    const prog = Effect.gen(function* () {
      const ticker = yield* JobTicker
      const out = yield* ticker.drain
      expect(out.considered).toBe(0)
      expect(out.claimed).toBe(0)
      expect(out.succeeded).toBe(0)
      expect(out.failed).toBe(0)
    })
    await Effect.runPromise(prog.pipe(Effect.provide(buildStack({}))))
  })

  it("drain picks up a due row, dispatches the worker, writes job_runs", async () => {
    const seen: Array<{ jobId: string; payload: unknown }> = []
    const probeWorker: Worker = (payload, ctx) =>
      Effect.sync(() => {
        seen.push({ jobId: ctx.jobId, payload })
        return { outputText: `ran:${ctx.jobId}` }
      })

    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker

      // Seed a row that should be picked up.
      yield* store.record({
        id: "wake-test",
        kind: "wake",
        spec: "*/30 * * * *",
        payload: { label: "wake-test" },
      })
      yield* store.setV2Fields("wake-test", {
        schedule: "*/30 * * * *",
        nextRunAt: 0, // overdue forever
      })

      const summary = yield* ticker.drain
      expect(summary.considered).toBe(1)
      expect(summary.claimed).toBe(1)
      expect(summary.succeeded).toBe(1)
      expect(summary.failed).toBe(0)

      // Worker saw the payload.
      expect(seen.length).toBe(1)
      expect(seen[0]?.jobId).toBe("wake-test")

      // job_runs row closed as success with the worker's outputText.
      const runs = yield* store.listRuns("wake-test")
      expect(runs.length).toBe(1)
      expect(runs[0]?.status).toBe("success")
      expect(runs[0]?.outputText).toBe("ran:wake-test")
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: probeWorker }))),
    )
  })

  it("worker failure surfaces as job_runs.status='failed' + error column", async () => {
    const angry: Worker = () =>
      Effect.fail(
        new WorkerError({
          reason: "worker_failed",
          message: "kaboom",
        }),
      )
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({
        id: "boom",
        kind: "wake",
        spec: "*/5 * * * *",
        payload: { label: "boom" },
      })
      yield* store.setV2Fields("boom", { schedule: "*/5 * * * *", nextRunAt: 0 })

      const summary = yield* ticker.drain
      expect(summary.claimed).toBe(1)
      expect(summary.failed).toBe(1)
      expect(summary.succeeded).toBe(0)

      const runs = yield* store.listRuns("boom")
      expect(runs[0]?.status).toBe("failed")
      expect(runs[0]?.error).toContain("kaboom")
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: angry }))),
    )
  })

  it("unknown kind: row is claimed AND closed as failed with 'no worker registered'", async () => {
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({
        id: "no-worker",
        kind: "totally-unknown-kind",
        spec: "*/5 * * * *",
        payload: { label: "no-worker" },
      })
      yield* store.setV2Fields("no-worker", {
        schedule: "*/5 * * * *",
        nextRunAt: 0,
      })

      const summary = yield* ticker.drain
      expect(summary.skippedUnknownKind).toBe(1)
      expect(summary.failed).toBe(1)

      const runs = yield* store.listRuns("no-worker")
      expect(runs[0]?.status).toBe("failed")
      expect(runs[0]?.error).toContain("no worker registered")
    })
    await Effect.runPromise(prog.pipe(Effect.provide(buildStack({}))))
  })

  it("disabled jobs are NOT considered", async () => {
    const ran: string[] = []
    const probe: Worker = (_p, ctx) =>
      Effect.sync(() => {
        ran.push(ctx.jobId)
        return { outputText: "ok" }
      })
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({
        id: "on",
        kind: "wake",
        spec: "*/5 * * * *",
        payload: { label: "on" },
      })
      yield* store.record({
        id: "off",
        kind: "wake",
        spec: "*/5 * * * *",
        payload: { label: "off" },
      })
      yield* store.setV2Fields("on", { schedule: "*/5 * * * *", nextRunAt: 0 })
      yield* store.setV2Fields("off", {
        schedule: "*/5 * * * *",
        nextRunAt: 0,
        enabled: false,
      })

      const summary = yield* ticker.drain
      expect(summary.considered).toBe(1)
      expect(ran).toEqual(["on"])
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: probe }))),
    )
  })

  it("after a successful drain, the row's next_run_at advances per its cron", async () => {
    const noop: Worker = () => Effect.succeed({ outputText: null })
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({
        id: "advance",
        kind: "wake",
        spec: "*/30 * * * *",
        payload: { label: "advance" },
      })
      yield* store.setV2Fields("advance", {
        schedule: "*/30 * * * *",
        nextRunAt: 0,
      })

      yield* ticker.drain
      const after = yield* store.getById("advance")
      // The claim should have set next_run_at to a future timestamp, or null
      // (if cron parse failed). For a valid */30 it should be > 0.
      expect(after?.nextRunAt).not.toBeNull()
      expect((after?.nextRunAt ?? 0) > 0).toBe(true)
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: noop }))),
    )
  })

  it("second drain in the same tick does NOT double-fire a row that's now in the future", async () => {
    let count = 0
    const counting: Worker = () =>
      Effect.sync(() => {
        count++
        return { outputText: null }
      })
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({
        id: "once",
        kind: "wake",
        spec: "*/30 * * * *",
        payload: { label: "once" },
      })
      yield* store.setV2Fields("once", {
        schedule: "*/30 * * * *",
        nextRunAt: 0,
      })

      // First drain: fires the worker once.
      const s1 = yield* ticker.drain
      expect(s1.succeeded).toBe(1)
      expect(count).toBe(1)

      // Second drain — TestClock hasn't advanced enough to make next_run_at
      // due again. Row's next_run_at was set forward by the first claim.
      const s2 = yield* ticker.drain
      expect(s2.considered).toBe(0)
      expect(count).toBe(1)
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: counting }))),
    )
  })

  it("a row whose schedule fails to parse leaves next_run_at unchanged on claim", async () => {
    const noop: Worker = () => Effect.succeed({ outputText: null })
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({
        id: "bad-cron",
        kind: "wake",
        spec: "this is not a cron",
        payload: { label: "bad-cron" },
      })
      // schedule is null, spec is invalid → computeNextRunAt returns null →
      // claim sets nextRunAt=null. Row stays due, but the test only drains once.
      yield* store.setV2Fields("bad-cron", { nextRunAt: 0 })

      const summary = yield* ticker.drain
      // It IS claimed + dispatched (worker is registered for 'wake').
      expect(summary.claimed).toBe(1)
      expect(summary.succeeded).toBe(1)
      const after = yield* store.getById("bad-cron")
      // next_run_at stays null (no parse).
      expect(after?.nextRunAt).toBeNull()
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: noop }))),
    )
  })
})
