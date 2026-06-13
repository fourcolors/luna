/**
 * JobTicker tests — deterministic via TestClock + Memory JobsStore + stub
 * WorkerRegistry. No SQLite, no real sleep, no real model calls.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Duration } from "effect"
import { Clock } from "../clock.js"
import { JobsStoreService } from "./jobs-store.js"
import { JobsStoreError, type JobsStoreApi } from "./jobs-store-types.js"
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
const buildStack = (
  workers: Record<string, Worker>,
  tickerOpts?: Parameters<typeof JobTickerLayer>[0],
) => {
  const storeL = JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))
  const regL = makeWorkerRegistry(workers)
  // autoStart:false → no background loop racing the explicit `drain` in tests.
  return JobTickerLayer({
    tickInterval: Duration.seconds(60),
    autoStart: false,
    ...tickerOpts,
  }).pipe(Layer.provideMerge(Layer.mergeAll(storeL, regL, Clock.Default)))
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

  it("closes orphaned 'running' runs at boot (process-restart recovery)", async () => {
    const noop: Worker = () => Effect.succeed({ outputText: null })
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const clock = yield* Clock
      // Simulate a crash: a run left open (finished_at NULL) by a dead process.
      yield* store.record({ id: "crashed", kind: "wake", spec: "", payload: { label: "crashed" } })
      yield* store.setV2Fields("crashed", { enabled: false })
      const orphan = yield* store.recordRunStart({ jobId: "crashed", startedAt: 1000 })

      // Boot a ticker against the SAME live store — the boot reconcile must
      // close the orphan. Layer.succeed reuses the resolved store/clock so the
      // reconcile is deterministic (not racing the forked drain loop).
      const tickerL = JobTickerLayer({ autoStart: false }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(JobsStoreService, store),
            makeWorkerRegistry({ wake: noop }),
            Layer.succeed(Clock, clock),
          ),
        ),
      )
      yield* Effect.scoped(Layer.build(tickerL)).pipe(Effect.asVoid)

      const rows = yield* store.listRuns("crashed", 10)
      expect(rows[0]?.id).toBe(orphan.id)
      expect(rows[0]?.status).toBe("cancelled")
      expect(rows[0]?.finishedAt).not.toBeNull()
      expect(rows[0]?.error ?? "").toContain("orphan")
    })
    await Effect.runPromise(
      prog.pipe(
        Effect.provide(
          Layer.mergeAll(
            JobsStoreService.Memory.pipe(Layer.provide(Clock.Default)),
            Clock.Default,
          ),
        ),
      ),
    )
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

  it("a one-shot row (empty schedule) fires exactly once then disables itself", async () => {
    let count = 0
    const counting: Worker = () =>
      Effect.sync(() => {
        count++
        return { outputText: null }
      })
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      // Empty spec → no schedule expression → one-shot.
      yield* store.record({
        id: "oneshot",
        kind: "wake",
        spec: "",
        payload: { label: "oneshot" },
      })
      yield* store.setV2Fields("oneshot", { enabled: true, nextRunAt: 0 })

      const s1 = yield* ticker.drain
      expect(s1.succeeded).toBe(1)
      expect(count).toBe(1)

      // The one-shot guard disabled it — listDue no longer returns it.
      const after = yield* store.getById("oneshot")
      expect(after?.enabled).toBe(false)
      const s2 = yield* ticker.drain
      expect(s2.considered).toBe(0)
      expect(count).toBe(1)
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: counting }))),
    )
  })

  it("a failed retention prune does NOT advance lastPruneAt (retries on the next drain)", async () => {
    let pruneCalls = 0
    const prog = Effect.gen(function* () {
      const real = yield* JobsStoreService
      const wrapped: JobsStoreApi = {
        ...real,
        pruneRuns: () => {
          pruneCalls++
          return Effect.fail(new JobsStoreError({ op: "delete", message: "db down" }))
        },
      }
      yield* Effect.gen(function* () {
        const ticker = yield* JobTicker
        yield* ticker.drain
        yield* ticker.drain
      }).pipe(
        Effect.provide(
          JobTickerLayer({ autoStart: false }).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(JobsStoreService, wrapped),
                makeWorkerRegistry({}),
                Clock.Default,
              ),
            ),
          ),
        ),
      )
      // Failure didn't advance lastPruneAt, so BOTH drains attempted the prune.
      expect(pruneCalls).toBe(2)
    })
    await Effect.runPromise(
      prog.pipe(
        Effect.provide(
          Layer.mergeAll(
            JobsStoreService.Memory.pipe(Layer.provide(Clock.Default)),
            Clock.Default,
          ),
        ),
      ),
    )
  })

  it("a drain runs the retention sweep, pruning finished runs older than retentionMaxAge", async () => {
    const noop: Worker = () => Effect.succeed({ outputText: null })
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const clock = yield* Clock
      const ticker = yield* JobTicker
      const now = yield* clock.nowMs()
      // A disabled job so it never dispatches — we only exercise retention.
      yield* store.record({ id: "ret", kind: "wake", spec: "", payload: { label: "ret" } })
      yield* store.setV2Fields("ret", { enabled: false })

      // One stale finished run + one fresh finished run.
      const oldRun = yield* store.recordRunStart({ jobId: "ret", startedAt: 1000 })
      yield* store.recordRunEnd(oldRun.id, { finishedAt: 1000, status: "success" })
      const recentRun = yield* store.recordRunStart({ jobId: "ret", startedAt: now })
      yield* store.recordRunEnd(recentRun.id, { finishedAt: now, status: "success" })

      const summary = yield* ticker.drain
      expect(summary.pruned).toBe(1)

      const ids = (yield* store.listRuns("ret", 100)).map((r) => r.id)
      expect(ids).toContain(recentRun.id)
      expect(ids).not.toContain(oldRun.id)
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: noop }))),
    )
  })

  it("a one-shot does NOT re-fire when its disable persistently fails", async () => {
    let runs = 0
    const counting: Worker = () =>
      Effect.sync(() => {
        runs++
        return { outputText: null }
      })
    const prog = Effect.gen(function* () {
      const real = yield* JobsStoreService
      // Arm a one-shot through the REAL store (this write must succeed).
      yield* real.record({ id: "os", kind: "wake", spec: "", payload: { label: "os" } })
      yield* real.setV2Fields("os", { enabled: true, nextRunAt: 0 })

      // A store whose setV2Fields ALWAYS fails — simulates a storage outage
      // that prevents the one-shot from being durably marked done.
      const wrapped: JobsStoreApi = {
        ...real,
        setV2Fields: () =>
          Effect.fail(new JobsStoreError({ op: "update", message: "storage outage" })),
      }

      yield* Effect.gen(function* () {
        const ticker = yield* JobTicker
        yield* ticker.drain
        yield* ticker.drain
      }).pipe(
        Effect.provide(
          JobTickerLayer({ autoStart: false }).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(JobsStoreService, wrapped),
                makeWorkerRegistry({ wake: counting }),
                Clock.Default,
              ),
            ),
          ),
        ),
      )

      // Disable failed on every tick, yet the worker ran at most once.
      expect(runs).toBe(1)
    })
    await Effect.runPromise(
      prog.pipe(
        Effect.provide(
          Layer.mergeAll(
            JobsStoreService.Memory.pipe(Layer.provide(Clock.Default)),
            Clock.Default,
          ),
        ),
      ),
    )
  })

  it("a worker DEFECT is recorded as failed and does NOT abort the rest of the tick", async () => {
    let okRan = false
    const worker: Worker = (_p, ctx) =>
      ctx.jobId === "boom"
        ? // synchronous throw INSIDE the effect → a defect, not a typed WorkerError
          Effect.sync(() => {
            throw new Error("kaboom-defect")
          })
        : Effect.sync(() => {
            okRan = true
            return { outputText: "ok" }
          })
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({ id: "boom", kind: "wake", spec: "0 0 * * *", payload: { label: "b" } })
      yield* store.setV2Fields("boom", { schedule: "0 0 * * *", nextRunAt: 0 })
      yield* store.record({ id: "ok", kind: "wake", spec: "0 0 * * *", payload: { label: "o" } })
      yield* store.setV2Fields("ok", { schedule: "0 0 * * *", nextRunAt: 0 })

      const s = yield* ticker.drain
      // The defect was caught (failed=1), the other due job still ran.
      expect(s.failed).toBe(1)
      expect(s.succeeded).toBe(1)
      expect(okRan).toBe(true)
      const runs = yield* store.listRuns("boom", 1)
      expect(runs[0]?.status).toBe("failed")
      expect(runs[0]?.error ?? "").toMatch(/defect/i)
    })
    await Effect.runPromise(prog.pipe(Effect.provide(buildStack({ wake: worker }))))
  })

  it("bounds a hung worker by the deadline and still processes the other due jobs", async () => {
    // One worker fn for kind "wake": hangs forever for "hang", succeeds otherwise.
    const worker: Worker = (_p, ctx) =>
      ctx.jobId === "hang" ? Effect.never : Effect.succeed({ outputText: "ok" })
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({ id: "hang", kind: "wake", spec: "0 0 * * *", payload: { label: "h" } })
      yield* store.setV2Fields("hang", { schedule: "0 0 * * *", nextRunAt: 0 })
      yield* store.record({ id: "ok", kind: "wake", spec: "0 0 * * *", payload: { label: "o" } })
      yield* store.setV2Fields("ok", { schedule: "0 0 * * *", nextRunAt: 0 })

      const summary = yield* ticker.drain
      // The hung worker was interrupted at the deadline (failed) and the other
      // due job still ran — a single stuck worker no longer blocks the tick.
      expect(summary.failed).toBe(1)
      expect(summary.succeeded).toBe(1)
      const hangRuns = yield* store.listRuns("hang", 1)
      expect(hangRuns[0]?.status).toBe("failed")
      expect(hangRuns[0]?.error ?? "").toMatch(/deadline/i)
      const okRuns = yield* store.listRuns("ok", 1)
      expect(okRuns[0]?.status).toBe("success")
    })
    await Effect.runPromise(
      prog.pipe(
        Effect.provide(buildStack({ wake: worker }, { workerDeadline: Duration.millis(80) })),
      ),
    )
  })

  it("ignores V1 cron rows (kind='cron') even when left enabled and due", async () => {
    let runs = 0
    const counting: Worker = () =>
      Effect.sync(() => {
        runs++
        return { outputText: null }
      })
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      // A V1 cron row whose enabled=false opt-out "failed" → still enabled + due.
      yield* store.record({ id: "v1cron", kind: "cron", spec: "* * * * *", payload: { label: "v1" } })
      yield* store.setV2Fields("v1cron", { schedule: "* * * * *", nextRunAt: 0 })

      const s = yield* ticker.drain
      // Skipped structurally — a registered "cron" worker is NEVER invoked.
      expect(s.skippedV1Cron).toBe(1)
      expect(runs).toBe(0)
      // Untouched: no run row, not claimed.
      expect((yield* store.listRuns("v1cron", 10)).length).toBe(0)
      const after = yield* store.getById("v1cron")
      expect(after?.lastRun).toBeNull()
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ cron: counting, wake: counting }))),
    )
  })

  it("computes next_run_at in UTC regardless of the host timezone", async () => {
    const prevTz = process.env.TZ
    process.env.TZ = "America/Los_Angeles"
    try {
      const noop: Worker = () => Effect.succeed({ outputText: null })
      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const ticker = yield* JobTicker
        yield* store.record({ id: "midnight", kind: "wake", spec: "0 0 * * *", payload: { label: "m" } })
        yield* store.setV2Fields("midnight", { schedule: "0 0 * * *", nextRunAt: 0 })

        yield* ticker.drain
        const after = yield* store.getById("midnight")
        // A UTC midnight is an exact multiple of a day in epoch-ms. A host-TZ
        // (PT) interpretation of "0 0 * * *" lands at 07:00/08:00 UTC → a
        // non-zero remainder. So this asserts UTC interpretation specifically.
        expect(after?.nextRunAt).not.toBeNull()
        expect((after?.nextRunAt ?? 1) % 86_400_000).toBe(0)
      })
      await Effect.runPromise(prog.pipe(Effect.provide(buildStack({ wake: noop }))))
    } finally {
      if (prevTz === undefined) delete process.env.TZ
      else process.env.TZ = prevTz
    }
  })

  it("a malformed (unparseable) cron row is quarantined, not re-fired every tick", async () => {
    let runs = 0
    const counting: Worker = () =>
      Effect.sync(() => {
        runs++
        return { outputText: null }
      })
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({
        id: "bad-cron",
        kind: "wake",
        spec: "this is not a cron",
        payload: { label: "bad-cron" },
      })
      yield* store.setV2Fields("bad-cron", { schedule: "this is not a cron", nextRunAt: 0 })

      const s1 = yield* ticker.drain
      // A broken schedule must NOT run the worker, and must be disabled so it
      // does not stay due (the every-tick re-fire trap).
      expect(runs).toBe(0)
      const after = yield* store.getById("bad-cron")
      expect(after?.enabled).toBe(false)
      expect(s1.skippedUnknownKind).toBe(0)

      // Second drain ignores the now-disabled row entirely.
      const s2 = yield* ticker.drain
      expect(s2.considered).toBe(0)
      expect(runs).toBe(0)
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: counting }))),
    )
  })

  it("a parseable-but-unschedulable cron (no upcoming match) is also quarantined", async () => {
    let runs = 0
    const counting: Worker = () =>
      Effect.sync(() => {
        runs++
        return { outputText: null }
      })
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      // "0 0 30 2 *" parses fine but Feb 30 never occurs → Cron.next throws.
      yield* store.record({ id: "nomatch", kind: "wake", spec: "0 0 30 2 *", payload: { label: "nm" } })
      yield* store.setV2Fields("nomatch", { schedule: "0 0 30 2 *", nextRunAt: 0 })

      yield* ticker.drain
      expect(runs).toBe(0)
      const after = yield* store.getById("nomatch")
      expect(after?.enabled).toBe(false)
      // Not left stuck 'running' from the claim (it never ran).
      expect(after?.lastStatus).not.toBe("running")
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: counting }))),
    )
  })
})
