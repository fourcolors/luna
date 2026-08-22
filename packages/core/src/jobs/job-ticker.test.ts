/**
 * JobTicker tests — deterministic via TestClock + Memory JobsStore + stub
 * WorkerRegistry. No SQLite, no real sleep, no real model calls.
 */
import { TestClock } from "effect/testing"
import { describe, expect, it, afterEach } from "vitest"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Deferred, Effect, Layer, Duration } from "effect"
import { Clock } from "../clock.js"
import { JobsStoreService } from "./jobs-store.js"
import { JobsStoreError, type JobsStoreApi } from "./jobs-store-types.js"
import { JobTicker, JobTickerLayer } from "./job-ticker.js"
import { CLEAN_SHUTDOWN_MARKER_NAME } from "./job-ticker-reconcile.js"
import {
  WorkerRegistry,
  WorkerError,
  makeWorkerRegistry,
  type Worker,
  type WorkerResult,
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
    // Tests dispose layers often; skip 90s production drain wait.
    shutdownDrainMs: 0,
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
      expect(out.forked).toBe(0)
      expect(out.failedInline).toBe(0)
    })
    await Effect.runPromise(prog.pipe(Effect.provide(buildStack({}))))
  })

  it("health is initializing before first drain, ok after drain", async () => {
    const prog = Effect.gen(function* () {
      const ticker = yield* JobTicker
      const before = yield* ticker.health
      expect(before.status).toBe("initializing")
      expect(before.lastTickAt).toBeNull()
      yield* ticker.drain
      const after = yield* ticker.health
      expect(after.status).toBe("ok")
      expect(after.lastTickAt).not.toBeNull()
      expect(after.lastTickAgeMs).not.toBeNull()
      expect(after.inFlight).toBe(0)
      expect(after.tickIntervalMs).toBe(60_000)
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

  it("boot reconcile: running orphan repairs last_status and pulls next_run_at forward", async () => {
    const noop: Worker = () => Effect.succeed({ outputText: null })
    const fixedNow = 1_700_000_000_000
    const farFuture = fixedNow + 86_400_000 * 30
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const clock = yield* Clock
      yield* store.record({
        id: "boot-run-orphan",
        kind: "wake",
        spec: "*/15 * * * *",
        payload: { label: "boot-run-orphan" },
      })
      yield* store.setV2Fields("boot-run-orphan", {
        schedule: "*/15 * * * *",
        enabled: true,
        nextRunAt: farFuture,
      })
      yield* store.touch("boot-run-orphan", {
        lastStatus: "running",
        lastRun: fixedNow - 60_000,
      })
      yield* store.recordRunStart({
        jobId: "boot-run-orphan",
        startedAt: fixedNow - 60_000,
      })

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

      const rows = yield* store.listRuns("boot-run-orphan", 10)
      expect(rows[0]?.status).toBe("cancelled")
      expect(rows[0]?.error ?? "").toContain("process restarted")

      const job = yield* store.getById("boot-run-orphan")
      expect(job?.lastStatus).toBe("errored")
      expect(job?.nextRunAt!).toBeGreaterThanOrEqual(fixedNow)
      expect(job?.nextRunAt!).toBeLessThanOrEqual(fixedNow + 60_000)
    })
    await Effect.runPromise(
      prog.pipe(
        Effect.provide(
          Layer.mergeAll(
            JobsStoreService.Memory.pipe(Layer.provide(Clock.Test(fixedNow))),
            Clock.Test(fixedNow),
          ),
        ),
      ),
    )
  })

  it("boot reconcile: waiting-only orphan does not pull next_run_at earlier", async () => {
    const noop: Worker = () => Effect.succeed({ outputText: null })
    const fixedNow = 1_700_000_000_000
    const farFuture = fixedNow + 86_400_000 * 30
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const clock = yield* Clock
      yield* store.record({
        id: "boot-wait-orphan",
        kind: "prompt",
        spec: "0 * * * *",
        payload: { label: "boot-wait-orphan" },
      })
      yield* store.setV2Fields("boot-wait-orphan", {
        schedule: "0 * * * *",
        enabled: true,
        nextRunAt: farFuture,
      })
      const run = yield* store.recordRunStart({
        jobId: "boot-wait-orphan",
        startedAt: fixedNow - 10_000,
      })
      yield* store.updateRunStatus(run.id, "waiting")

      const tickerL = JobTickerLayer({ autoStart: false }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(JobsStoreService, store),
            makeWorkerRegistry({ prompt: noop }),
            Layer.succeed(Clock, clock),
          ),
        ),
      )
      yield* Effect.scoped(Layer.build(tickerL)).pipe(Effect.asVoid)

      const rows = yield* store.listRuns("boot-wait-orphan", 10)
      expect(rows[0]?.status).toBe("cancelled")
      expect(rows[0]?.error ?? "").toContain("waiting")

      const job = yield* store.getById("boot-wait-orphan")
      expect(job?.nextRunAt).toBe(farFuture)
    })
    await Effect.runPromise(
      prog.pipe(
        Effect.provide(
          Layer.mergeAll(
            JobsStoreService.Memory.pipe(Layer.provide(Clock.Test(fixedNow))),
            Clock.Test(fixedNow),
          ),
        ),
      ),
    )
  })

  it("boot reconcile: sticky last_status=running with no open run is repaired", async () => {
    const noop: Worker = () => Effect.succeed({ outputText: null })
    const fixedNow = 1_700_000_000_000
    const farFuture = fixedNow + 86_400_000 * 30
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const clock = yield* Clock
      yield* store.record({
        id: "boot-sticky",
        kind: "dream",
        spec: "0 3 * * *",
        payload: { label: "boot-sticky" },
      })
      yield* store.setV2Fields("boot-sticky", {
        schedule: "0 3 * * *",
        enabled: true,
        nextRunAt: farFuture,
      })
      yield* store.touch("boot-sticky", { lastStatus: "running" })

      const tickerL = JobTickerLayer({ autoStart: false }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(JobsStoreService, store),
            makeWorkerRegistry({ dream: noop }),
            Layer.succeed(Clock, clock),
          ),
        ),
      )
      yield* Effect.scoped(Layer.build(tickerL)).pipe(Effect.asVoid)

      const job = yield* store.getById("boot-sticky")
      expect(job?.lastStatus).toBe("errored")
      expect(job?.nextRunAt!).toBeGreaterThanOrEqual(fixedNow)
      expect(job?.nextRunAt!).toBeLessThanOrEqual(fixedNow + 60_000)
    })
    await Effect.runPromise(
      prog.pipe(
        Effect.provide(
          Layer.mergeAll(
            JobsStoreService.Memory.pipe(Layer.provide(Clock.Test(fixedNow))),
            Clock.Test(fixedNow),
          ),
        ),
      ),
    )
  })

  it("boot reconcile: disabled one-shot sticky running is cleared but not re-enabled", async () => {
    const noop: Worker = () => Effect.succeed({ outputText: null })
    const fixedNow = 1_700_000_000_000
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const clock = yield* Clock
      yield* store.record({
        id: "boot-disabled-oneshot",
        kind: "wake",
        spec: "",
        payload: { label: "boot-disabled-oneshot" },
      })
      yield* store.setV2Fields("boot-disabled-oneshot", {
        enabled: false,
        nextRunAt: fixedNow + 99_000_000,
      })
      yield* store.touch("boot-disabled-oneshot", { lastStatus: "running" })

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

      const job = yield* store.getById("boot-disabled-oneshot")
      expect(job?.lastStatus).toBe("errored")
      expect(job?.enabled).toBe(false)
      expect(job?.nextRunAt).toBe(fixedNow + 99_000_000)
    })
    await Effect.runPromise(
      prog.pipe(
        Effect.provide(
          Layer.mergeAll(
            JobsStoreService.Memory.pipe(Layer.provide(Clock.Test(fixedNow))),
            Clock.Test(fixedNow),
          ),
        ),
      ),
    )
  })

  // S11a-wire: JobTickerLayer's boot reconcile now consumes the clean-shutdown
  // marker chat-server.ts writes on a deliberate stop, before wiring
  // cleanShutdown into store.reconcileAfterCrash. See job-ticker-reconcile.ts
  // for the consume-once contract and jobs-store.test.ts for the store-level
  // exemption behavior these tests build on top of.
  describe("boot reconcile: S11a clean-shutdown marker", () => {
    let lunaHome: string | undefined
    afterEach(() => {
      if (lunaHome) rmSync(lunaHome, { recursive: true, force: true })
    })

    const noopWorker: Worker = () => Effect.succeed({ outputText: null })

    const seedRunningOrphan = (
      store: JobsStoreApi,
      id: string,
      fixedNow: number,
      farFuture: number,
    ) =>
      Effect.gen(function* () {
        yield* store.record({
          id,
          kind: "wake",
          spec: "*/15 * * * *",
          payload: { label: id },
        })
        yield* store.setV2Fields(id, {
          schedule: "*/15 * * * *",
          enabled: true,
          nextRunAt: farFuture,
        })
        yield* store.touch(id, {
          lastStatus: "running",
          lastRun: fixedNow - 60_000,
        })
        yield* store.recordRunStart({ jobId: id, startedAt: fixedNow - 60_000 })
      })

    // Boots a JobTicker against an existing store + clock and runs its S11a
    // boot reconcile, then tears it down (autoStart:false, so this is a
    // single boot-reconcile pass, never a drain loop). Unlike `buildStack`
    // above, callers here need to seed the SAME store before the boot and
    // control each boot's `finishedAt` via `clockLayer`.
    const bootTicker = (
      store: JobsStoreApi,
      clockLayer: Layer.Layer<Clock>,
      home: string,
    ): Effect.Effect<void> =>
      Effect.scoped(
        Layer.build(
          JobTickerLayer({ autoStart: false, lunaHome: home }).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(JobsStoreService, store),
                makeWorkerRegistry({ wake: noopWorker }),
                clockLayer,
              ),
            ),
          ),
        ),
      ).pipe(Effect.asVoid)

    it("marker present: consumed (file removed) and the boot is exempted (orphanStreak stays 0) while next_run_at still pulls forward", async () => {
      lunaHome = mkdtempSync(join(tmpdir(), "luna-clean-shutdown-"))
      const markerPath = join(lunaHome, CLEAN_SHUTDOWN_MARKER_NAME)
      writeFileSync(markerPath, "")
      const fixedNow = 1_700_000_000_000
      const farFuture = fixedNow + 86_400_000 * 30
      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const clock = yield* Clock
        yield* seedRunningOrphan(store, "marker-present", fixedNow, farFuture)
        yield* bootTicker(store, Layer.succeed(Clock, clock), lunaHome!)

        expect(existsSync(markerPath)).toBe(false)
        const job = yield* store.getById("marker-present")
        expect(job?.lastStatus).toBe("errored")
        expect(job?.nextRunAt!).toBeGreaterThanOrEqual(fixedNow)
        expect(job?.nextRunAt!).toBeLessThan(farFuture)
        expect(job?.orphanStreak).toBe(0)
      })
      await Effect.runPromise(
        prog.pipe(
          Effect.provide(
            Layer.mergeAll(
              JobsStoreService.Memory.pipe(Layer.provide(Clock.Test(fixedNow))),
              Clock.Test(fixedNow),
            ),
          ),
        ),
      )
    })

    it("no marker: reconcile falls back to crash-counting and bumps orphanStreak (the pre-S11a default)", async () => {
      lunaHome = mkdtempSync(join(tmpdir(), "luna-clean-shutdown-"))
      const fixedNow = 1_700_000_000_000
      const farFuture = fixedNow + 86_400_000 * 30
      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const clock = yield* Clock
        yield* seedRunningOrphan(store, "no-marker", fixedNow, farFuture)
        yield* bootTicker(store, Layer.succeed(Clock, clock), lunaHome!)

        const job = yield* store.getById("no-marker")
        expect(job?.orphanStreak).toBe(1)
      })
      await Effect.runPromise(
        prog.pipe(
          Effect.provide(
            Layer.mergeAll(
              JobsStoreService.Memory.pipe(Layer.provide(Clock.Test(fixedNow))),
              Clock.Test(fixedNow),
            ),
          ),
        ),
      )
    })

    it("consume-once: a marker exempts exactly the boot that finds it; a later boot with no marker counts again", async () => {
      lunaHome = mkdtempSync(join(tmpdir(), "luna-clean-shutdown-"))
      const markerPath = join(lunaHome, CLEAN_SHUTDOWN_MARKER_NAME)
      writeFileSync(markerPath, "")
      // Two distinct boot clocks, provided directly to `bootTicker` (not via
      // the ambient-fetch pattern used above) since this test needs two
      // different `finishedAt` values across two sequential ticker boots
      // against the SAME store.
      const firstBoot = 1_700_000_000_000
      const secondBoot = 1_800_000_000_000
      const farFuture1 = firstBoot + 86_400_000 * 30
      const farFuture2 = secondBoot + 86_400_000 * 30
      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        yield* seedRunningOrphan(store, "consume-once", firstBoot, farFuture1)

        yield* bootTicker(store, Clock.Test(firstBoot), lunaHome!)
        expect(existsSync(markerPath)).toBe(false)
        const afterFirst = yield* store.getById("consume-once")
        expect(afterFirst?.orphanStreak).toBe(0)

        // The job fires normally and is rescheduled far out again, then a
        // SECOND, genuine crash happens with no marker present (the first
        // boot already consumed it) - this reconcile must count.
        yield* store.setV2Fields("consume-once", { nextRunAt: farFuture2 })
        yield* store.touch("consume-once", {
          lastStatus: "running",
          lastRun: secondBoot - 60_000,
        })
        yield* store.recordRunStart({
          jobId: "consume-once",
          startedAt: secondBoot - 60_000,
        })

        yield* bootTicker(store, Clock.Test(secondBoot), lunaHome!)
        const afterSecond = yield* store.getById("consume-once")
        expect(afterSecond?.orphanStreak).toBe(1)
        expect(afterSecond?.nextRunAt!).toBeLessThan(farFuture2)
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

    it("unlink failure degrades to crash-counting (fails toward the doctor, never away from it)", async () => {
      lunaHome = mkdtempSync(join(tmpdir(), "luna-clean-shutdown-"))
      const markerPath = join(lunaHome, CLEAN_SHUTDOWN_MARKER_NAME)
      // A directory at the marker path makes unlinkSync fail deterministically
      // on Linux (EISDIR, for any caller). On macOS/BSD this is EPERM for a
      // non-root caller only - `man 2 unlink` documents the superuser as
      // exempt from that check, so this trick is not root-safe on macOS; CI
      // and local dev here never run tests as root.
      mkdirSync(markerPath)
      const fixedNow = 1_700_000_000_000
      const farFuture = fixedNow + 86_400_000 * 30
      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const clock = yield* Clock
        yield* seedRunningOrphan(store, "unlink-fails", fixedNow, farFuture)
        yield* bootTicker(store, Layer.succeed(Clock, clock), lunaHome!)

        // Proves the code actually tried and failed to unlink, not that it
        // never looked (which would also leave orphanStreak at its
        // pre-wiring default of 1).
        expect(existsSync(markerPath)).toBe(true)
        const job = yield* store.getById("unlink-fails")
        expect(job?.orphanStreak).toBe(1)
      })
      await Effect.runPromise(
        prog.pipe(
          Effect.provide(
            Layer.mergeAll(
              JobsStoreService.Memory.pipe(Layer.provide(Clock.Test(fixedNow))),
              Clock.Test(fixedNow),
            ),
          ),
        ),
      )
    })
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
      expect(summary.forked).toBe(1)

      // issue #276: drain returns as soon as the dispatch is FORKED, not once
      // it finishes - await the executor before reading post-dispatch state.
      yield* ticker.awaitIdle

      // Worker saw the payload.
      expect(seen.length).toBe(1)
      expect(seen[0]?.jobId).toBe("wake-test")

      // job_runs row closed as success with the worker's outputText.
      const runs = yield* store.listRuns("wake-test")
      expect(runs.length).toBe(1)
      expect(runs[0]?.status).toBe("success")
      expect(runs[0]?.outputText).toBe("ran:wake-test")

      // jobs.last_status reset from claim()'s 'running' to the run outcome —
      // a recurring schedule must not read as perpetually 'running' between fires.
      const jobAfter = yield* store.getById("wake-test")
      expect(jobAfter?.lastStatus).toBe("fired")
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
      expect(summary.forked).toBe(1)
      yield* ticker.awaitIdle

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
      // issue #276: unknown-kind is closed INLINE by the producer (no worker
      // to dispatch, nothing to fork) - visible in `drain`'s own summary,
      // no `awaitIdle` needed.
      expect(summary.failedInline).toBe(1)
      expect(summary.forked).toBe(0)

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
      yield* ticker.awaitIdle
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

      // First drain: forks the worker once.
      const s1 = yield* ticker.drain
      expect(s1.forked).toBe(1)
      yield* ticker.awaitIdle
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
      expect(s1.forked).toBe(1)
      // issue #276: the one-shot's at-most-once disable is written
      // SYNCHRONOUSLY by the producer (before the fork), so it's already
      // visible without awaiting the executor - only the worker's own
      // execution (`count`) needs `awaitIdle`.
      const after = yield* store.getById("oneshot")
      expect(after?.enabled).toBe(false)
      yield* ticker.awaitIdle
      expect(count).toBe(1)

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
        // issue #276: must await idle INSIDE this scoped block - the layer's
        // Scope (and its `executors` FiberMap) closes when this Effect.gen
        // returns, which would interrupt a still-running executor fiber
        // before it gets to increment `runs`.
        yield* ticker.awaitIdle
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
      expect(s.forked).toBe(2)
      yield* ticker.awaitIdle
      // The defect was caught, the other due job still ran (a defecting
      // executor fiber cannot cascade to a sibling - FiberMap isolates them).
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
      expect(summary.forked).toBe(2)
      yield* ticker.awaitIdle
      // The hung worker was interrupted at the deadline and the other due job
      // still ran - a single stuck worker no longer blocks the tick (issue
      // #276: it never blocked the PRODUCER at all, only its own executor).
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

  // ── job-ticker-oban-deadlines ────────────────────────────────────────────

  it("Seam 4: bounded concurrency — a failing post-dispatch store write on one job does not block a sibling's in-flight dispatch from closing", async () => {
    const SLEEP_MS = 60
    const finished: string[] = []
    const worker: Worker = (_p, ctx) =>
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(SLEEP_MS))
        finished.push(ctx.jobId)
        return { outputText: "ok" }
      })

    const prog = Effect.gen(function* () {
      const real = yield* JobsStoreService
      // recordRunEnd fails ONLY for "flaky"'s run — simulates a storage blip
      // on its post-dispatch write. Keyed by runId -> jobId (recordRunEnd
      // itself only receives a runId). issue #276: the real-dispatch path now
      // goes through `claimAndStartRun`, NOT `recordRunStart` - the tap has
      // to sit on the method the producer actually calls, or `runIdToJobId`
      // is never populated and this whole test is a no-op silently.
      const runIdToJobId = new Map<number, string>()
      const wrapped: JobsStoreApi = {
        ...real,
        claimAndStartRun: (id, args) =>
          real.claimAndStartRun(id, args).pipe(
            Effect.tap((started) =>
              started
                ? Effect.sync(() => runIdToJobId.set(started.run.id, id))
                : Effect.void,
            ),
          ),
        recordRunEnd: (runId, end) =>
          runIdToJobId.get(runId) === "flaky"
            ? Effect.fail(
                new JobsStoreError({ op: "run_end", message: "simulated storage blip" }),
              )
            : real.recordRunEnd(runId, end),
      }

      yield* real.record({ id: "flaky", kind: "wake", spec: "*/5 * * * *", payload: { label: "f" } })
      yield* real.setV2Fields("flaky", { schedule: "*/5 * * * *", nextRunAt: 0 })
      yield* real.record({ id: "steady", kind: "wake", spec: "*/5 * * * *", payload: { label: "s" } })
      yield* real.setV2Fields("steady", { schedule: "*/5 * * * *", nextRunAt: 0 })

      const startedAt = Date.now()
      yield* Effect.gen(function* () {
        const ticker = yield* JobTicker
        yield* ticker.drain
        // issue #276: drain only FORKS the two dispatches now - measure
        // "drain + awaitIdle" for the concurrency assertion below, and await
        // idle INSIDE this scoped block so the layer's Scope doesn't close
        // (interrupting the executors) before they finish.
        yield* ticker.awaitIdle
      }).pipe(
        Effect.provide(
          JobTickerLayer({ autoStart: false, dispatchConcurrency: 2 }).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(JobsStoreService, wrapped),
                makeWorkerRegistry({ wake: worker }),
                Clock.Default,
              ),
            ),
          ),
        ),
      )
      const elapsedMs = Date.now() - startedAt

      // TRUE concurrency: two ~SLEEP_MS workers finish in ~SLEEP_MS wall-clock,
      // not ~2*SLEEP_MS — a regression to sequential-only dispatch (or a
      // fail-fast interruption cutting the run short) would show up here.
      expect(elapsedMs).toBeLessThan(SLEEP_MS * 1.8)
      expect(finished.sort()).toEqual(["flaky", "steady"])

      // "steady"'s run closed successfully DESPITE "flaky"'s recordRunEnd
      // failing concurrently — no fail-fast interruption of the sibling.
      const steadyRuns = yield* real.listRuns("steady", 1)
      expect(steadyRuns[0]?.status).toBe("success")
      expect(steadyRuns[0]?.finishedAt).not.toBeNull()

      // "flaky"'s own run stays 'running' (its recordRunEnd never landed) —
      // that's the pre-existing per-item error-isolation behavior (reaped by
      // boot reconcile on next restart); the point of this test is that its
      // failure did NOT also sink "steady".
      const flakyRuns = yield* real.listRuns("flaky", 1)
      expect(flakyRuns[0]?.status).toBe("running")
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

  it("Seam 3: a failed dispatch on a RECURRING job retries sooner than its natural cron fire, bumping retry_attempt", async () => {
    const hang: Worker = () => Effect.never
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const clock = yield* Clock
      const ticker = yield* JobTicker
      // A yearly cron: its natural next fire is always FAR in the future, so
      // the backoff-computed retryAt (default ~1 min) is unambiguously sooner
      // regardless of real wall-clock timing at test-run time.
      yield* store.record({ id: "retry-recurring", kind: "wake", spec: "0 0 1 1 *", payload: { label: "r" } })
      yield* store.setV2Fields("retry-recurring", { schedule: "0 0 1 1 *", nextRunAt: 0 })

      const beforeMs = yield* clock.nowMs()
      const summary = yield* ticker.drain
      expect(summary.forked).toBe(1)
      yield* ticker.awaitIdle

      const after = yield* store.getById("retry-recurring")
      expect(after?.retryAttempt).toBe(1)
      expect(after?.nextRunAt).not.toBeNull()
      // retryAt = observed POST-dispatch now + backoff(1) — strictly greater
      // than the PRE-dispatch clock read taken above (deadline_passed can
      // only fire after the worker deadline elapses).
      expect((after?.nextRunAt ?? 0) > beforeMs).toBe(true)
      // ...and sooner than the yearly cron's real next fire, proving the
      // retry path (not the cron-computed path) decided next_run_at.
      const wellPastRetryWindowMs = beforeMs + 24 * 3600 * 1000 * 300 // 300 days
      expect((after?.nextRunAt ?? Infinity) < wellPastRetryWindowMs).toBe(true)

      // A second drain does NOT re-fire it — the retry window (~1 min) has
      // not elapsed against the real clock yet.
      const s2 = yield* ticker.drain
      expect(s2.considered).toBe(0)
    })
    await Effect.runPromise(
      prog.pipe(
        Effect.provide(buildStack({ wake: hang }, { workerDeadline: Duration.millis(50) })),
      ),
    )
  })

  it("Seam 3: retry_attempt resets to 0 on the next success after a prior failure", async () => {
    let attempt = 0
    const flakyThenOk: Worker = () => {
      attempt++
      return attempt === 1
        ? Effect.fail(new WorkerError({ reason: "worker_failed", message: "transient" }))
        : Effect.succeed({ outputText: "recovered" })
    }
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({ id: "recovers", kind: "wake", spec: "0 0 1 1 *", payload: { label: "rec" } })
      yield* store.setV2Fields("recovers", { schedule: "0 0 1 1 *", nextRunAt: 0 })

      const s1 = yield* ticker.drain
      expect(s1.forked).toBe(1)
      yield* ticker.awaitIdle
      const afterFail = yield* store.getById("recovers")
      expect(afterFail?.retryAttempt).toBe(1)
      expect(afterFail?.nextRunAt).not.toBeNull()

      // Force the row due again right now (bypassing the real backoff wait,
      // which is the ticker's business, not this test's) so the retry fires.
      yield* store.setV2Fields("recovers", { nextRunAt: 0 })
      const s2 = yield* ticker.drain
      expect(s2.forked).toBe(1)
      yield* ticker.awaitIdle
      const afterSuccess = yield* store.getById("recovers")
      expect(afterSuccess?.retryAttempt).toBe(0)
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: flakyThenOk }))),
    )
  })

  it("Seam 3 guard: a one-shot job's failed dispatch is NEVER retried/rescheduled — it fires exactly once and stays disabled", async () => {
    const angry: Worker = () =>
      Effect.fail(new WorkerError({ reason: "worker_failed", message: "boom" }))
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({ id: "oneshot-fail", kind: "wake", spec: "", payload: { label: "o" } })
      yield* store.setV2Fields("oneshot-fail", { enabled: true, nextRunAt: 0 })

      const s1 = yield* ticker.drain
      expect(s1.forked).toBe(1)
      yield* ticker.awaitIdle

      const after = yield* store.getById("oneshot-fail")
      // One-shots never retry: retry_attempt stays 0 and the row is disabled
      // (the pre-existing one-shot guard) rather than rescheduled sooner.
      expect(after?.retryAttempt).toBe(0)
      expect(after?.enabled).toBe(false)

      // A second drain must not re-dispatch it — proving it was never
      // rescheduled by the Seam-3 retry path.
      const s2 = yield* ticker.drain
      expect(s2.considered).toBe(0)
      expect(s2.forked).toBe(0)
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: angry }))),
    )
  })

  it("Seam 1: a worker registered with defaultTimeoutMs gets `grace` added on top before the outer backstop fires", async () => {
    const hang: Worker = () => Effect.never
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({ id: "graced", kind: "dream", spec: "0 0 * * *", payload: { label: "g" } })
      yield* store.setV2Fields("graced", { schedule: "0 0 * * *", nextRunAt: 0 })

      const startedAt = Date.now()
      const summary = yield* ticker.drain
      expect(summary.forked).toBe(1)
      // issue #276: `drain` returns as soon as the dispatch is FORKED, so the
      // elapsed-time assertion below must measure "drain + awaitIdle", not
      // `drain` alone (which now returns near-instantly).
      yield* ticker.awaitIdle
      const elapsedMs = Date.now() - startedAt

      const runs = yield* store.listRuns("graced", 1)
      expect(runs[0]?.error ?? "").toMatch(/deadline/i)
      // defaultTimeoutMs(1100) is chosen ABOVE MIN_RESOLVED_TIMEOUT_MS(1000)
      // so the floor clamp cannot swallow the grace term (a prior version of
      // this test used numbers under the floor, so the backstop was actually
      // floor(1000) + grace regardless of the configured defaultTimeoutMs,
      // and the assertion below could not distinguish grace-added from
      // grace-absent). defaultTimeoutMs(1100) + grace(400) = 1500ms backstop;
      // with grace NOT added the backstop would be 1100ms, which fails this
      // assertion — so this test actually fails if `+ graceMs` is removed.
      expect(elapsedMs).toBeGreaterThanOrEqual(1400)
      expect(elapsedMs).toBeLessThan(2500)
    })
    const registry = makeWorkerRegistry({ dream: { run: hang, defaultTimeoutMs: 1100 } })
    const storeL = JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))
    const tickerL = JobTickerLayer({
      tickInterval: Duration.seconds(60),
      autoStart: false,
      workerDeadline: Duration.millis(10),
      grace: Duration.millis(400),
      maxWorkerDeadline: Duration.minutes(30),
    }).pipe(Layer.provideMerge(Layer.mergeAll(storeL, registry, Clock.Default)))
    await Effect.runPromise(prog.pipe(Effect.provide(tickerL)))
  })

  it("Seam 1: a worker that fails on its OWN inner timeout before the backstop closes as worker_failed, not deadline_passed (grace lets it self-report)", async () => {
    // Simulates a well-behaved worker (like the dream worker) that owns an
    // inner timeout shorter than its registered defaultTimeoutMs and fails
    // itself with a descriptive `worker_failed` error well before the
    // ticker's grace-inclusive backstop would fire.
    const selfTimingOut: Worker = () =>
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(60))
        return yield* Effect.fail(
          new WorkerError({
            reason: "worker_failed",
            message: "inner timeout: exceeded self-imposed 60ms chunk budget",
          }),
        )
      })
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({ id: "self-timeout", kind: "dream", spec: "0 0 * * *", payload: { label: "s" } })
      yield* store.setV2Fields("self-timeout", { schedule: "0 0 * * *", nextRunAt: 0 })

      const summary = yield* ticker.drain
      expect(summary.forked).toBe(1)
      yield* ticker.awaitIdle
      const runs = yield* store.listRuns("self-timeout", 1)
      // The worker's OWN error must win: `worker_failed`, not the ticker's
      // `deadline_passed` backstop — proving the grace window (defaultTimeoutMs
      // 1000ms below the 1000ms+grace backstop) gave the inner timeout room to
      // fire and be recorded on its own terms.
      expect(runs[0]?.error ?? "").toMatch(/inner timeout/i)
      expect(runs[0]?.error ?? "").not.toMatch(/deadline/i)
    })
    // defaultTimeoutMs(1000) + grace(2000) = 3000ms backstop, far past the
    // worker's own ~60ms self-inflicted failure — the backstop must never
    // fire for this dispatch.
    const registry = makeWorkerRegistry({ dream: { run: selfTimingOut, defaultTimeoutMs: 1000 } })
    const storeL = JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))
    const tickerL = JobTickerLayer({
      tickInterval: Duration.seconds(60),
      autoStart: false,
      workerDeadline: Duration.millis(10),
      grace: Duration.seconds(2),
      maxWorkerDeadline: Duration.minutes(30),
    }).pipe(Layer.provideMerge(Layer.mergeAll(storeL, registry, Clock.Default)))
    await Effect.runPromise(prog.pipe(Effect.provide(tickerL)))
  })

  it("Seam 1 back-compat: a bare-function registration (no defaultTimeoutMs) ignores `grace` entirely and uses workerDeadline exactly as before", async () => {
    const hang: Worker = () => Effect.never
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({ id: "bare", kind: "wake", spec: "0 0 * * *", payload: { label: "b" } })
      yield* store.setV2Fields("bare", { schedule: "0 0 * * *", nextRunAt: 0 })

      const startedAt = Date.now()
      yield* ticker.drain
      // issue #276: measure "drain + awaitIdle" - `drain` alone now returns
      // near-instantly (it only forks the dispatch).
      yield* ticker.awaitIdle
      const elapsedMs = Date.now() - startedAt

      // Even with a large `grace` configured, a bare-function registration
      // must fire at the global workerDeadline ALONE (30ms) — not
      // workerDeadline + grace (which would be ~2030ms).
      expect(elapsedMs).toBeLessThan(500)
    })
    await Effect.runPromise(
      prog.pipe(
        Effect.provide(
          buildStack(
            { wake: hang },
            { workerDeadline: Duration.millis(30), grace: Duration.seconds(2) },
          ),
        ),
      ),
    )
  })

  it("Seam 1: payload.timeout_ms overrides the worker's registered defaultTimeoutMs (highest-priority source)", async () => {
    const hang: Worker = () => Effect.never
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      // Worker registers defaultTimeoutMs=10ms (tiny); the payload asks for
      // far more (1200ms) — the payload override must win.
      yield* store.record({
        id: "payload-override",
        kind: "dream",
        spec: "0 0 * * *",
        payload: { label: "g", timeout_ms: 1200 },
      })
      yield* store.setV2Fields("payload-override", { schedule: "0 0 * * *", nextRunAt: 0 })

      const startedAt = Date.now()
      const summary = yield* ticker.drain
      expect(summary.forked).toBe(1)
      yield* ticker.awaitIdle
      const elapsedMs = Date.now() - startedAt

      // If the worker's defaultTimeoutMs(10) had won, this would fire in
      // well under 100ms — asserting >=1100 proves the payload override
      // (1200) was the effective timeout, not the worker default.
      expect(elapsedMs).toBeGreaterThanOrEqual(1100)
    })
    const registry = makeWorkerRegistry({ dream: { run: hang, defaultTimeoutMs: 10 } })
    const storeL = JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))
    const tickerL = JobTickerLayer({
      tickInterval: Duration.seconds(60),
      autoStart: false,
      workerDeadline: Duration.millis(10),
      grace: Duration.millis(0),
      maxWorkerDeadline: Duration.minutes(30),
    }).pipe(Layer.provideMerge(Layer.mergeAll(storeL, registry, Clock.Default)))
    await Effect.runPromise(prog.pipe(Effect.provide(tickerL)))
  })

  it("Seam 1: payload.timeout_ms is clamped at maxWorkerDeadline, not honoured unbounded", async () => {
    const hang: Worker = () => Effect.never
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({
        id: "clamp-huge",
        kind: "wake",
        spec: "0 0 * * *",
        payload: { label: "c", timeout_ms: 999_999_999 },
      })
      yield* store.setV2Fields("clamp-huge", { schedule: "0 0 * * *", nextRunAt: 0 })

      const startedAt = Date.now()
      const summary = yield* ticker.drain
      expect(summary.forked).toBe(1)
      yield* ticker.awaitIdle
      const elapsedMs = Date.now() - startedAt

      // An unbounded payload override would hang far past any reasonable
      // test duration; maxWorkerDeadline(150ms) must still cap it.
      expect(elapsedMs).toBeLessThan(500)
    })
    await Effect.runPromise(
      prog.pipe(
        Effect.provide(
          buildStack(
            { wake: hang },
            {
              workerDeadline: Duration.minutes(5),
              grace: Duration.millis(0),
              maxWorkerDeadline: Duration.millis(150),
            },
          ),
        ),
      ),
    )
  })

  it("Seam 1: garbage payload.timeout_ms (negative) falls through cleanly to the worker default, still floored at 1s", async () => {
    const hang: Worker = () => Effect.never
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({
        id: "garbage-timeout",
        kind: "dream",
        spec: "0 0 * * *",
        payload: { label: "g", timeout_ms: -50 },
      })
      yield* store.setV2Fields("garbage-timeout", { schedule: "0 0 * * *", nextRunAt: 0 })

      const startedAt = Date.now()
      const summary = yield* ticker.drain
      expect(summary.forked).toBe(1)
      yield* ticker.awaitIdle
      const elapsedMs = Date.now() - startedAt

      // A negative payload.timeout_ms must NOT be honoured (which would
      // otherwise produce a ~0ms or negative backstop) — it falls through to
      // the worker's defaultTimeoutMs(40), which is itself floored at 1s.
      expect(elapsedMs).toBeGreaterThanOrEqual(900)
      expect(elapsedMs).toBeLessThan(3000)
    })
    const registry = makeWorkerRegistry({ dream: { run: hang, defaultTimeoutMs: 40 } })
    const storeL = JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))
    const tickerL = JobTickerLayer({
      tickInterval: Duration.seconds(60),
      autoStart: false,
      workerDeadline: Duration.millis(10),
      grace: Duration.millis(0),
      maxWorkerDeadline: Duration.minutes(30),
    }).pipe(Layer.provideMerge(Layer.mergeAll(storeL, registry, Clock.Default)))
    await Effect.runPromise(prog.pipe(Effect.provide(tickerL)))
  })

  it("Seam 3: a bad_payload failure is NOT retried — retry_attempt stays 0 and next_run_at is left at the natural cron fire", async () => {
    const badPayload: Worker = () =>
      Effect.fail(new WorkerError({ reason: "bad_payload", message: "missing user_prompt" }))
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({
        id: "bad-payload-job",
        kind: "wake",
        spec: "0 0 1 1 *",
        payload: { label: "bp" },
      })
      yield* store.setV2Fields("bad-payload-job", { schedule: "0 0 1 1 *", nextRunAt: 0 })

      const summary = yield* ticker.drain
      expect(summary.forked).toBe(1)
      yield* ticker.awaitIdle

      const after = yield* store.getById("bad-payload-job")
      expect(after?.retryAttempt).toBe(0)
      // A yearly cron's natural next fire is always far in the future —
      // proving next_run_at was NOT pulled earlier by a (wrongly-granted)
      // retry.
      // Well past ANY retry backoff (max 30 min) but comfortably short of
      // the yearly cron's actual next fire (months away) — proving
      // next_run_at is the natural cron fire, not a retry nudge.
      const wellPastRetryWindowMs = Date.now() + 24 * 3600 * 1000 * 7
      expect((after?.nextRunAt ?? 0) > wellPastRetryWindowMs).toBe(true)

      // A second drain does not re-fire it — proving it was never
      // rescheduled sooner by the retry path.
      const s2 = yield* ticker.drain
      expect(s2.considered).toBe(0)
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: badPayload }))),
    )
  })

  it("Seam 3: exhausting maxAttempts stops retrying and resets retry_attempt (falls back to cron cadence)", async () => {
    const alwaysFail: Worker = () =>
      Effect.fail(new WorkerError({ reason: "worker_failed", message: "still broken" }))
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({ id: "exhaust", kind: "wake", spec: "0 0 1 1 *", payload: { label: "e" } })
      yield* store.setV2Fields("exhaust", { schedule: "0 0 1 1 *", nextRunAt: 0 })

      // First failure: attempt #1, under the ceiling (defaultMaxAttempts=2) — retried.
      const s1 = yield* ticker.drain
      expect(s1.forked).toBe(1)
      yield* ticker.awaitIdle
      const afterFirst = yield* store.getById("exhaust")
      expect(afterFirst?.retryAttempt).toBe(1)

      // Force it due again right now (bypassing the real backoff wait, which
      // is the ticker's business, not this test's).
      yield* store.setV2Fields("exhaust", { nextRunAt: 0 })

      // Second failure: attempt #2 reaches maxAttempts(2) — exhausted.
      const s2 = yield* ticker.drain
      expect(s2.forked).toBe(1)
      yield* ticker.awaitIdle
      const afterSecond = yield* store.getById("exhaust")
      expect(afterSecond?.retryAttempt).toBe(0)
      // Well past ANY retry backoff (max 30 min) but comfortably short of
      // the yearly cron's actual next fire (months away).
      const wellPastRetryWindowMs = Date.now() + 24 * 3600 * 1000 * 7
      expect((afterSecond?.nextRunAt ?? 0) > wellPastRetryWindowMs).toBe(true)

      // A third drain does not fire it either — proving exhaustion truly
      // fell back to the (far-future) natural cron cadence, not a fast retry.
      const s3 = yield* ticker.drain
      expect(s3.considered).toBe(0)
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: alwaysFail }, { defaultMaxAttempts: 2 }))),
    )
  })

  it("Seam 3: job_runs.attempt reflects the retry streak (1, 2, 3)", async () => {
    let calls = 0
    const failTwiceThenOk: Worker = () => {
      calls++
      return calls < 3
        ? Effect.fail(new WorkerError({ reason: "worker_failed", message: "flaky" }))
        : Effect.succeed({ outputText: "ok" })
    }
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      yield* store.record({
        id: "attempt-count",
        kind: "wake",
        spec: "0 0 1 1 *",
        payload: { label: "a" },
      })
      yield* store.setV2Fields("attempt-count", { schedule: "0 0 1 1 *", nextRunAt: 0 })

      // issue #276: await idle after EACH drain before forcing the row due
      // again - otherwise the manual `setV2Fields(nextRunAt:0)` below races
      // the still-in-flight executor's own retry-scheduling write.
      yield* ticker.drain
      yield* ticker.awaitIdle
      yield* store.setV2Fields("attempt-count", { nextRunAt: 0 })
      yield* ticker.drain
      yield* ticker.awaitIdle
      yield* store.setV2Fields("attempt-count", { nextRunAt: 0 })
      yield* ticker.drain
      yield* ticker.awaitIdle

      const runs = yield* store.listRuns("attempt-count", 10)
      // `id` is monotonically assigned at insertion (recordRunStart), so
      // sorting on it gives a deterministic chronological order even when
      // successive real-clock `startedAt` reads land in the same
      // millisecond (listRuns' `started_at DESC` ordering ties unreliably
      // in that case).
      const attempts = [...runs].sort((a, b) => a.id - b.id).map((r) => r.attempt)
      expect(attempts).toEqual([1, 2, 3])
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: failTwiceThenOk }, { defaultMaxAttempts: 5 }))),
    )
  })

  // ── issue #277 Seam A: WorkerResult.postCommit ─────────────────────────
  // Delivery moved OUT of the timed dispatch (Effect.timeoutFail) so a slow
  // sink can never race the backstop into discarding an already-committed
  // success and letting a Seam-3 retry re-run the turn and re-deliver. See
  // worker-registry.ts's WorkerResult.postCommit doc + job-ticker.ts's
  // handleJob for the ordering guarantee this section proves.
  describe("postCommit (issue #277)", () => {
    it("runs exactly once, strictly AFTER recordRunEnd durably wrote status=success", async () => {
      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const clock = yield* Clock

        // The worker closes over THIS resolved store instance (not
        // `yield* JobsStoreService`, which a registered Worker<never> can't
        // require) and reads job_runs from it inside postCommit - proving
        // postCommit observes what recordRunEnd already committed, not just
        // that it ran at some point.
        let calls = 0
        let observedStatus: string | null = null
        const worker: Worker = () =>
          Effect.succeed({
            outputText: "ok",
            postCommit: store.listRuns("postcommit-order", 1).pipe(
              Effect.tap((runs) =>
                Effect.sync(() => {
                  calls++
                  observedStatus = runs[0]?.status ?? null
                }),
              ),
              Effect.catch(() => Effect.void),
              Effect.asVoid,
            ),
          } satisfies WorkerResult)

        yield* store.record({
          id: "postcommit-order",
          kind: "wake",
          spec: "*/5 * * * *",
          payload: { label: "p" },
        })
        yield* store.setV2Fields("postcommit-order", {
          schedule: "*/5 * * * *",
          nextRunAt: 0,
        })

        const tickerL = JobTickerLayer({ autoStart: false }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(JobsStoreService, store),
              makeWorkerRegistry({ wake: worker }),
              Layer.succeed(Clock, clock),
            ),
          ),
        )
        // issue #276: build + drain + awaitIdle all inside ONE Effect.scoped
        // block - the layer's Scope (and its `executors` FiberMap) must stay
        // open through `awaitIdle`, or forking into an already-closing
        // FiberMap could interrupt the executor before postCommit runs.
        const summary = yield* Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(tickerL)
            const ticker = Context.get(ctx, JobTicker)
            const s = yield* ticker.drain
            yield* ticker.awaitIdle
            return s
          }),
        )
        expect(summary.forked).toBe(1)

        expect(calls).toBe(1)
        expect(observedStatus).toBe("success")
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

    it("a postCommit that fails or defects is caught, logged, and never affects the run's status, the tick summary, or sibling jobs", async () => {
      const seen: string[] = []
      const failingWorker: Worker = () =>
        Effect.succeed({
          outputText: "ok",
          // Casts around the WorkerResult contract deliberately - this
          // simulates a worker that failed to collapse its own typed error
          // channel to E=never (the documented contract on
          // WorkerResult.postCommit), proving the ticker's own
          // Effect.catch defends against it anyway.
          postCommit: Effect.fail(
            new Error("delivery boom"),
          ) as unknown as Effect.Effect<void>,
        } satisfies WorkerResult)
      const defectingWorker: Worker = () =>
        Effect.succeed({
          outputText: "ok",
          // Same idea for a synchronous defect (Effect.die) - covered by
          // the ticker's Effect.catchDefect.
          postCommit: Effect.die(
            new Error("delivery kaboom"),
          ) as unknown as Effect.Effect<void>,
        } satisfies WorkerResult)
      const okSibling: Worker = () =>
        Effect.sync(() => {
          seen.push("sibling-ran")
          return { outputText: "sibling-ok" } satisfies WorkerResult
        })

      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const ticker = yield* JobTicker

        yield* store.record({ id: "pc-fail", kind: "wake", spec: "*/5 * * * *", payload: { label: "f" } })
        yield* store.setV2Fields("pc-fail", { schedule: "*/5 * * * *", nextRunAt: 0 })
        yield* store.record({ id: "pc-defect", kind: "dream", spec: "*/5 * * * *", payload: { label: "d" } })
        yield* store.setV2Fields("pc-defect", { schedule: "*/5 * * * *", nextRunAt: 0 })
        yield* store.record({ id: "pc-sibling", kind: "workflow", spec: "*/5 * * * *", payload: { label: "s" } })
        yield* store.setV2Fields("pc-sibling", { schedule: "*/5 * * * *", nextRunAt: 0 })

        const summary = yield* ticker.drain
        expect(summary.claimed).toBe(3)
        expect(summary.forked).toBe(3)
        yield* ticker.awaitIdle
        // The sibling's own dispatch was never touched by the other two
        // jobs' postCommit blowing up - fiber isolation holds (a defect or
        // failure inside one executor's fiber cannot cascade to another's).
        expect(seen).toEqual(["sibling-ran"])

        const failRun = yield* store.listRuns("pc-fail")
        expect(failRun[0]?.status).toBe("success")
        const defectRun = yield* store.listRuns("pc-defect")
        expect(defectRun[0]?.status).toBe("success")
        const siblingRun = yield* store.listRuns("pc-sibling")
        expect(siblingRun[0]?.status).toBe("success")
      })
      await Effect.runPromise(
        prog.pipe(
          Effect.provide(
            buildStack({
              wake: failingWorker,
              dream: defectingWorker,
              workflow: okSibling,
            }),
          ),
        ),
      )
    })

    it("a worker that fails has no postCommit to run - Seam 3 retry scheduling is unaffected", async () => {
      const angry: Worker = () =>
        Effect.fail(new WorkerError({ reason: "worker_failed", message: "kaboom" }))
      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const ticker = yield* JobTicker
        yield* store.record({
          id: "fail-no-postcommit",
          kind: "wake",
          spec: "0 0 1 1 *",
          payload: { label: "f" },
        })
        yield* store.setV2Fields("fail-no-postcommit", {
          schedule: "0 0 1 1 *",
          nextRunAt: 0,
        })

        const summary = yield* ticker.drain
        expect(summary.forked).toBe(1)
        yield* ticker.awaitIdle

        // Seam A adds nothing to the failure path - retry scheduling from
        // #275 fires exactly as it did before postCommit existed.
        const after = yield* store.getById("fail-no-postcommit")
        expect(after?.retryAttempt).toBe(1)
      })
      await Effect.runPromise(prog.pipe(Effect.provide(buildStack({ wake: angry }))))
    })

    it("a SLOW postCommit does not trip the dispatch backstop - it runs strictly after dispatch already returned", async () => {
      // Deliberate, bounded exception to this file's "no real sleep"
      // header note: ordering alone is what makes this safe (postCommit is
      // OUTSIDE the Effect.timeoutFail-wrapped dispatch), so a short real
      // sleep that clears a tiny real backstop is enough to demonstrate it
      // without needing TestClock plumbing through Effect.timeout.
      const worker: Worker = () =>
        Effect.succeed({
          outputText: "ok",
          postCommit: Effect.sleep(Duration.millis(50)),
        } satisfies WorkerResult)
      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const ticker = yield* JobTicker
        yield* store.record({
          id: "slow-postcommit",
          kind: "wake",
          spec: "*/5 * * * *",
          payload: { label: "s" },
        })
        yield* store.setV2Fields("slow-postcommit", {
          schedule: "*/5 * * * *",
          nextRunAt: 0,
        })

        const summary = yield* ticker.drain
        expect(summary.forked).toBe(1)
        yield* ticker.awaitIdle

        const runs = yield* store.listRuns("slow-postcommit")
        expect(runs[0]?.status).toBe("success")
        expect(runs[0]?.error ?? "").not.toContain("deadline_passed")
      })
      await Effect.runPromise(
        prog.pipe(
          Effect.provide(
            buildStack(
              { wake: worker },
              { workerDeadline: Duration.millis(10), grace: Duration.millis(0) },
            ),
          ),
        ),
      )
    })
  })

  // ── job-ticker-producer-executor-276 - the producer/executor split ──────
  //
  // These use `Deferred` latches instead of real sleeps to control exactly
  // when a worker completes: a latched worker blocks on `Deferred.await`
  // until the test explicitly `Deferred.succeed`s it, which is what makes
  // "still running" a deterministic, race-free state to assert against
  // (rather than a timing guess).
  describe("producer/executor split (issue #276)", () => {
    it("a long-running dispatch does NOT block a later drain from claiming/forking a different due job", async () => {
      const latchA = Effect.runSync(Deferred.make<void>())
      const bDone = Effect.runSync(Deferred.make<void>())
      const worker: Worker = (_p, ctx) =>
        ctx.jobId === "long-a"
          ? Deferred.await(latchA).pipe(Effect.as({ outputText: "a-done" } satisfies WorkerResult))
          : Effect.gen(function* () {
              const result = { outputText: "b-done" } satisfies WorkerResult
              // Signal completion explicitly - proves B's dispatch actually
              // ran to completion, not merely that it was forked.
              yield* Deferred.succeed(bDone, undefined)
              return result
            })

      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const ticker = yield* JobTicker
        yield* store.record({ id: "long-a", kind: "wake", spec: "*/5 * * * *", payload: { label: "a" } })
        yield* store.setV2Fields("long-a", { schedule: "*/5 * * * *", nextRunAt: 0 })

        // First drain: forks "long-a", which immediately blocks on its latch.
        const s1 = yield* ticker.drain
        expect(s1.forked).toBe(1)

        // "quick-b" becomes due only now (simulating a row that becomes due
        // WHILE "long-a" is still dispatching).
        yield* store.record({ id: "quick-b", kind: "wake", spec: "*/5 * * * *", payload: { label: "b" } })
        yield* store.setV2Fields("quick-b", { schedule: "*/5 * * * *", nextRunAt: 0 })

        // Second drain, with "long-a" STILL latched (never released). If the
        // split regressed to the pre-#276 await-all model, this line would
        // hang forever (drain would try to await "long-a"'s dispatch) and the
        // test would time out. It doesn't - the producer only claims/forks.
        const s2 = yield* ticker.drain
        expect(s2.forked).toBe(1)

        // "quick-b" runs to completion despite "long-a" still being blocked -
        // proven via its own Deferred, not a race-prone poll.
        yield* Deferred.await(bDone).pipe(Effect.timeout(Duration.seconds(2)))

        // Cleanup: release "long-a" too and confirm it eventually finishes.
        yield* Deferred.succeed(latchA, undefined)
        yield* ticker.awaitIdle
        const aRuns = yield* store.listRuns("long-a", 1)
        expect(aRuns[0]?.status).toBe("success")
      })
      await Effect.runPromise(prog.pipe(Effect.provide(buildStack({ wake: worker }))))
    })

    it("in-flight uniqueness: a dispatch that outlives its cron period is not re-claimed while its executor is still running", async () => {
      const latch = Effect.runSync(Deferred.make<void>())
      const worker: Worker = () =>
        Deferred.await(latch).pipe(Effect.as({ outputText: "done" } satisfies WorkerResult))
      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const ticker = yield* JobTicker
        yield* store.record({ id: "outlives", kind: "wake", spec: "*/5 * * * *", payload: { label: "o" } })
        yield* store.setV2Fields("outlives", { schedule: "*/5 * * * *", nextRunAt: 0 })

        const s1 = yield* ticker.drain
        expect(s1.forked).toBe(1)

        // Force the row due again RIGHT NOW - simulating its cron period
        // having elapsed - while the FIRST dispatch is still latched/running.
        yield* store.setV2Fields("outlives", { nextRunAt: 0 })
        const s2 = yield* ticker.drain
        // The in-flight guard (FiberMap.has) skips it: NOT re-claimed, NOT
        // re-forked. This is the uniqueness the pre-split await-all loop got
        // for free by construction.
        expect(s2.considered).toBe(1)
        expect(s2.skippedInFlight).toBe(1)
        expect(s2.forked).toBe(0)

        // Exactly ONE open (running) job_runs row - no double-dispatch.
        const runsWhileRunning = yield* store.listRuns("outlives", 10)
        expect(runsWhileRunning.length).toBe(1)
        expect(runsWhileRunning[0]?.status).toBe("running")

        yield* Deferred.succeed(latch, undefined)
        yield* ticker.awaitIdle
        const runsAfter = yield* store.listRuns("outlives", 10)
        expect(runsAfter.length).toBe(1)
        expect(runsAfter[0]?.status).toBe("success")
      })
      await Effect.runPromise(prog.pipe(Effect.provide(buildStack({ wake: worker }))))
    })

    it("slot bound: dispatchConcurrency caps in-flight forks; the overflow row stays due (unclaimed) and forks next tick", async () => {
      const latch = Effect.runSync(Deferred.make<void>())
      const worker: Worker = () =>
        Deferred.await(latch).pipe(Effect.as({ outputText: "done" } satisfies WorkerResult))
      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const ticker = yield* JobTicker
        for (const id of ["slot-a", "slot-b", "slot-c"]) {
          yield* store.record({ id, kind: "wake", spec: "*/5 * * * *", payload: { label: id } })
          yield* store.setV2Fields(id, { schedule: "*/5 * * * *", nextRunAt: 0 })
        }

        const s1 = yield* ticker.drain
        expect(s1.considered).toBe(3)
        expect(s1.forked).toBe(2)
        expect(s1.skippedNoCapacity).toBe(1)

        // The overflow row was NOT claimed - `lastRun` is still null (claim()
        // would have set it), so it stays due for the next tick, no loss.
        const all = yield* store.listAll()
        const unclaimed = all.filter((j) => j.lastRun === null)
        expect(unclaimed.length).toBe(1)

        // Release the two in-flight dispatches, freeing their slots.
        yield* Deferred.succeed(latch, undefined)
        yield* ticker.awaitIdle

        // Next drain: the overflow row is claimed + forked now that a slot
        // freed up.
        const s2 = yield* ticker.drain
        expect(s2.considered).toBe(1)
        expect(s2.forked).toBe(1)
        expect(s2.skippedNoCapacity).toBe(0)
        expect(s2.skippedClaimLost).toBe(0)
      })
      await Effect.runPromise(
        prog.pipe(Effect.provide(buildStack({ wake: worker }, { dispatchConcurrency: 2 }))),
      )
    })

    it("teardown interrupts every in-flight executor; boot reconcile on the next start closes the orphaned run", async () => {
      const latch = Effect.runSync(Deferred.make<void>())
      const startedRunning = Effect.runSync(Deferred.make<void>())
      const worker: Worker = () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(startedRunning, undefined)
          // Never released within this test's own scope - the dispatch MUST
          // be INTERRUPTED by the Layer's Scope closing, not completed.
          yield* Deferred.await(latch)
          return { outputText: "should never get here" } satisfies WorkerResult
        })

      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const clock = yield* Clock
        yield* store.record({
          id: "teardown-victim",
          kind: "wake",
          spec: "*/5 * * * *",
          payload: { label: "t" },
        })
        yield* store.setV2Fields("teardown-victim", { schedule: "*/5 * * * *", nextRunAt: 0 })

        const tickerL = JobTickerLayer({ autoStart: false }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(JobsStoreService, store),
              makeWorkerRegistry({ wake: worker }),
              Layer.succeed(Clock, clock),
            ),
          ),
        )

        // Build, drain (forks the executor), wait until the worker has
        // GENUINELY started (not merely claimed), then let this
        // Effect.scoped block end - closing the layer's Scope (and its
        // `executors` FiberMap) WITHOUT ever releasing the latch.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(tickerL)
            const ticker = Context.get(ctx, JobTicker)
            const summary = yield* ticker.drain
            expect(summary.forked).toBe(1)
            yield* Deferred.await(startedRunning).pipe(Effect.timeout(Duration.seconds(2)))
          }),
        )
        // `Effect.scoped` does not return until every finalizer (including
        // the FiberMap's own teardown, which interrupts every live entry)
        // has completed - so by this point the executor is DEFINITELY gone.

        // Teardown interruption does NOT itself close the run row - that's
        // boot reconcile's job (verified next). It is left 'running'.
        const orphanedRuns = yield* store.listRuns("teardown-victim", 1)
        expect(orphanedRuns[0]?.status).toBe("running")

        // Booting a FRESH ticker against the SAME store reconciles it.
        const secondTickerL = JobTickerLayer({ autoStart: false }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(JobsStoreService, store),
              makeWorkerRegistry({ wake: worker }),
              Layer.succeed(Clock, clock),
            ),
          ),
        )
        yield* Effect.scoped(Layer.build(secondTickerL)).pipe(Effect.asVoid)
        const reconciled = yield* store.listRuns("teardown-victim", 1)
        expect(reconciled[0]?.status).toBe("cancelled")
        expect(reconciled[0]?.finishedAt).not.toBeNull()
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

    it("awaitIdle resolves only once EVERY forked executor has completed, not just one of several", async () => {
      const latchA = Effect.runSync(Deferred.make<void>())
      const latchB = Effect.runSync(Deferred.make<void>())
      const worker: Worker = (_p, ctx) =>
        ctx.jobId === "idle-a"
          ? Deferred.await(latchA).pipe(Effect.as({ outputText: "a" } satisfies WorkerResult))
          : Deferred.await(latchB).pipe(Effect.as({ outputText: "b" } satisfies WorkerResult))

      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const ticker = yield* JobTicker
        yield* store.record({ id: "idle-a", kind: "wake", spec: "*/5 * * * *", payload: { label: "a" } })
        yield* store.setV2Fields("idle-a", { schedule: "*/5 * * * *", nextRunAt: 0 })
        yield* store.record({ id: "idle-b", kind: "wake", spec: "*/5 * * * *", payload: { label: "b" } })
        yield* store.setV2Fields("idle-b", { schedule: "*/5 * * * *", nextRunAt: 0 })

        const s1 = yield* ticker.drain
        expect(s1.forked).toBe(2)

        // Release only "a" - awaitIdle must NOT resolve yet ("b" is still
        // in-flight). A short real timeout race is the deterministic way to
        // prove "did not resolve" (an unresolved Effect has no other signal).
        yield* Deferred.succeed(latchA, undefined)
        const raced = yield* ticker.awaitIdle.pipe(
          Effect.timeout(Duration.millis(150)),
          Effect.result,
        )
        expect(raced._tag).toBe("Failure")

        // Now release "b" too - awaitIdle resolves promptly.
        yield* Deferred.succeed(latchB, undefined)
        yield* ticker.awaitIdle.pipe(Effect.timeout(Duration.seconds(2)))

        const runsA = yield* store.listRuns("idle-a", 1)
        const runsB = yield* store.listRuns("idle-b", 1)
        expect(runsA[0]?.status).toBe("success")
        expect(runsB[0]?.status).toBe("success")
      })
      await Effect.runPromise(prog.pipe(Effect.provide(buildStack({ wake: worker }))))
    })
  })

  // ── Phase B1: doctor auto-enqueue ─────────────────────────────────────
  describe("doctor auto-enqueue (Phase B1)", () => {
    const doctorOpts = {
      failStreakThreshold: 2,
      orphanStreakThreshold: 2,
      maxHealAttempts: 3,
      cliPath: process.cwd() + "/apps/server/scripts/luna-doctor-workflow.ts",
    } as const

    it("after N consecutive failures on a prompt job (max_attempts=1), enqueues doctor and disables patient", async () => {
      const angry: Worker = () =>
        Effect.fail(new WorkerError({ reason: "worker_failed", message: "chronic" }))
      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const ticker = yield* JobTicker
        yield* store.record({
          id: "prompt-chronic",
          kind: "prompt",
          spec: "0 0 1 1 *",
          payload: { label: "p", max_attempts: 1 },
        })
        yield* store.setV2Fields("prompt-chronic", {
          schedule: "0 0 1 1 *",
          nextRunAt: 0,
        })

        yield* ticker.drain
        yield* ticker.awaitIdle
        const after1 = yield* store.getById("prompt-chronic")
        expect(after1?.failStreak).toBe(1)
        expect(after1?.healState).toBe("ok")
        expect(after1?.enabled).toBe(true)

        yield* store.setV2Fields("prompt-chronic", { nextRunAt: 0 })
        yield* ticker.drain
        yield* ticker.awaitIdle

        const patient = yield* store.getById("prompt-chronic")
        expect(patient?.failStreak).toBe(2)
        expect(patient?.enabled).toBe(false)
        expect(patient?.healState).toBe("healing")
        expect(patient?.healAttempts).toBe(1)

        const all = yield* store.listAll()
        const doctors = all.filter(
          (j) =>
            j.id.startsWith("doctor-") ||
            j.payload.source === "doctor-workflow",
        )
        expect(doctors.length).toBe(1)
        expect(doctors[0]?.kind).toBe("workflow")
        expect(doctors[0]?.enabled).toBe(true)
        expect(
          (doctors[0]?.payload as { finding?: { patient?: { id?: string } } })
            .finding?.patient?.id,
        ).toBe("prompt-chronic")
      })
      await Effect.runPromise(
        prog.pipe(
          Effect.provide(
            buildStack(
              { prompt: angry },
              { doctor: { ...doctorOpts } },
            ),
          ),
        ),
      )
    })

    it("dream/wake never enqueue doctor even after many failures", async () => {
      const angry: Worker = () =>
        Effect.fail(new WorkerError({ reason: "worker_failed", message: "nope" }))
      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const ticker = yield* JobTicker
        for (const [id, kind] of [
          ["dream-fail", "dream"],
          ["wake-fail", "wake"],
        ] as const) {
          yield* store.record({
            id,
            kind,
            spec: "0 0 1 1 *",
            payload: { label: id, max_attempts: 1 },
          })
          yield* store.setV2Fields(id, { schedule: "0 0 1 1 *", nextRunAt: 0 })
        }

        for (let i = 0; i < 3; i++) {
          yield* ticker.drain
          yield* ticker.awaitIdle
          yield* store.setV2Fields("dream-fail", { nextRunAt: 0 })
          yield* store.setV2Fields("wake-fail", { nextRunAt: 0 })
        }

        const dream = yield* store.getById("dream-fail")
        const wake = yield* store.getById("wake-fail")
        expect(dream?.failStreak).toBeGreaterThanOrEqual(2)
        expect(wake?.failStreak).toBeGreaterThanOrEqual(2)
        expect(dream?.healState).toBe("ok")
        expect(wake?.healState).toBe("ok")
        expect(dream?.enabled).toBe(true)
        expect(wake?.enabled).toBe(true)

        const all = yield* store.listAll()
        const doctors = all.filter((j) => j.id.startsWith("doctor-"))
        expect(doctors.length).toBe(0)
      })
      await Effect.runPromise(
        prog.pipe(
          Effect.provide(
            buildStack(
              { dream: angry, wake: angry },
              { doctor: { ...doctorOpts } },
            ),
          ),
        ),
      )
    })

    it("doctor-workflow jobs never enqueue doctor for themselves", async () => {
      const angry: Worker = () =>
        Effect.fail(new WorkerError({ reason: "worker_failed", message: "doc-fail" }))
      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const ticker = yield* JobTicker
        // Patient already healing under doctor — doctor one-shot fails.
        yield* store.record({
          id: "patient-under-care",
          kind: "prompt",
          spec: "0 0 1 1 *",
          payload: { label: "p" },
        })
        yield* store.setV2Fields("patient-under-care", {
          schedule: "0 0 1 1 *",
          enabled: false,
          healAttempts: 1,
          healState: "healing",
        })
        yield* store.record({
          id: "doctor-self-check-a1-x",
          kind: "workflow",
          spec: "",
          payload: {
            label: "doctor",
            source: "doctor-workflow",
            finding: {
              id: "f1",
              patient: { kind: "job", id: "patient-under-care" },
            },
            doctor_attempt: 1,
            max_attempts: 1,
          },
          enabled: true,
          nextRunAt: 0,
        })

        yield* ticker.drain
        yield* ticker.awaitIdle

        // Doctor failed → re-enqueues ANOTHER doctor for the patient (attempt 2),
        // but never treats the doctor row as a patient (no doctor-for-doctor).
        const all = yield* store.listAll()
        const doctorJobs = all.filter(
          (j) =>
            j.id.startsWith("doctor-") ||
            j.payload.source === "doctor-workflow",
        )
        // Original + one re-enqueue for patient, none nested on the doctor id.
        expect(doctorJobs.length).toBe(2)
        for (const d of doctorJobs) {
          const pid = (
            d.payload as { finding?: { patient?: { id?: string } } }
          ).finding?.patient?.id
          expect(pid).toBe("patient-under-care")
          expect(pid).not.toBe(d.id)
        }
        const patient = yield* store.getById("patient-under-care")
        expect(patient?.healAttempts).toBe(2)
        expect(patient?.healState).toBe("healing")
      })
      await Effect.runPromise(
        prog.pipe(
          Effect.provide(
            buildStack(
              { workflow: angry, prompt: angry },
              { doctor: { ...doctorOpts } },
            ),
          ),
        ),
      )
    })

    it("success resets fail/orphan/heal streaks", async () => {
      const ok: Worker = () => Effect.succeed({ outputText: "ok" })
      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const ticker = yield* JobTicker
        yield* store.record({
          id: "recover-streaks",
          kind: "prompt",
          spec: "*/5 * * * *",
          payload: { label: "r" },
        })
        yield* store.setV2Fields("recover-streaks", {
          schedule: "*/5 * * * *",
          nextRunAt: 0,
          failStreak: 4,
          orphanStreak: 2,
          healAttempts: 1,
          healState: "ok",
          retryAttempt: 2,
        })

        yield* ticker.drain
        yield* ticker.awaitIdle

        const after = yield* store.getById("recover-streaks")
        expect(after?.failStreak).toBe(0)
        expect(after?.orphanStreak).toBe(0)
        expect(after?.healAttempts).toBe(0)
        expect(after?.healState).toBe("ok")
        expect(after?.retryAttempt).toBe(0)
      })
      await Effect.runPromise(
        prog.pipe(
          Effect.provide(
            buildStack({ prompt: ok }, { doctor: { ...doctorOpts } }),
          ),
        ),
      )
    })

    it("after max heal attempts, escalate (no 4th doctor)", async () => {
      const angry: Worker = () =>
        Effect.fail(new WorkerError({ reason: "worker_failed", message: "still broken" }))
      const prog = Effect.gen(function* () {
        const store = yield* JobsStoreService
        const ticker = yield* JobTicker
        yield* store.record({
          id: "patient-maxed",
          kind: "prompt",
          spec: "0 0 1 1 *",
          payload: { label: "p" },
        })
        yield* store.setV2Fields("patient-maxed", {
          schedule: "0 0 1 1 *",
          enabled: false,
          healAttempts: 3,
          healState: "healing",
        })
        yield* store.record({
          id: "doctor-patient-maxed-a3-zz",
          kind: "workflow",
          spec: "",
          payload: {
            label: "doctor",
            source: "doctor-workflow",
            finding: {
              id: "f-max",
              patient: { kind: "job", id: "patient-maxed" },
            },
            doctor_attempt: 3,
            max_attempts: 1,
          },
          enabled: true,
          nextRunAt: 0,
        })

        yield* ticker.drain
        yield* ticker.awaitIdle

        const patient = yield* store.getById("patient-maxed")
        expect(patient?.healState).toBe("escalated")
        expect(patient?.enabled).toBe(false)
        expect(patient?.healAttempts).toBe(3)

        const all = yield* store.listAll()
        const doctors = all.filter(
          (j) =>
            j.id.startsWith("doctor-") ||
            j.payload.source === "doctor-workflow",
        )
        // Only the original doctor job — no 4th attempt enqueued.
        expect(doctors.length).toBe(1)
      })
      await Effect.runPromise(
        prog.pipe(
          Effect.provide(
            buildStack(
              { workflow: angry },
              { doctor: { ...doctorOpts, maxHealAttempts: 3 } },
            ),
          ),
        ),
      )
    })
  })
})
