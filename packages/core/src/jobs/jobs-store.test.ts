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

  // ── Phase 12b: V2 fields + listDue + claim + job_runs ──────────────────

  it("setV2Fields updates schedule/enabled/nextRunAt partial-patch style", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({
        id: "v2-a",
        kind: "cron",
        spec: "*/5 * * * *",
        payload: { label: "v2-a" },
      })
      // Patch only `schedule`.
      const ok = yield* store.setV2Fields("v2-a", { schedule: "*/30 * * * *" })
      expect(ok).toBe(true)
      const after1 = yield* store.getById("v2-a")
      expect(after1?.schedule).toBe("*/30 * * * *")
      expect(after1?.enabled).toBe(true)
      expect(after1?.nextRunAt).toBeNull()

      // Patch only `nextRunAt`.
      yield* store.setV2Fields("v2-a", { nextRunAt: 1_234_567 })
      const after2 = yield* store.getById("v2-a")
      expect(after2?.schedule).toBe("*/30 * * * *")  // unchanged
      expect(after2?.nextRunAt).toBe(1_234_567)

      // Patch enabled=false.
      yield* store.setV2Fields("v2-a", { enabled: false })
      const after3 = yield* store.getById("v2-a")
      expect(after3?.enabled).toBe(false)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("listDue returns only enabled rows whose next_run_at is null or <= now", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({ id: "due-a", kind: "cron", spec: "*", payload: { label: "a" } })
      yield* store.record({ id: "due-b", kind: "cron", spec: "*", payload: { label: "b" } })
      yield* store.record({ id: "due-c", kind: "cron", spec: "*", payload: { label: "c" } })
      // due-a: enabled, no nextRunAt → due immediately.
      // due-b: enabled, nextRunAt=2000 → due when now>=2000.
      // due-c: disabled, would otherwise be due.
      yield* store.setV2Fields("due-b", { nextRunAt: 2000 })
      yield* store.setV2Fields("due-c", { enabled: false })

      const at1000 = yield* store.listDue(1000)
      const ids1000 = at1000.map((j) => j.id).sort()
      expect(ids1000).toEqual(["due-a"])

      const at2500 = yield* store.listDue(2500)
      const ids2500 = at2500.map((j) => j.id).sort()
      expect(ids2500).toEqual(["due-a", "due-b"])
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("claim succeeds when previousLastRun matches; fails when it does not (optimistic lock)", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({ id: "lock-a", kind: "cron", spec: "*", payload: { label: "a" } })

      // First claim: previousLastRun is null (matches the initial state).
      const ok1 = yield* store.claim("lock-a", {
        claimAt: 5000,
        nextRunAt: 5600,
        previousLastRun: null,
      })
      expect(ok1).toBe(true)
      const after1 = yield* store.getById("lock-a")
      expect(after1?.lastRun).toBe(5000)
      expect(after1?.lastStatus).toBe("running")
      expect(after1?.nextRunAt).toBe(5600)

      // Second claim with the WRONG previousLastRun (a competing tick) — fails.
      const ok2 = yield* store.claim("lock-a", {
        claimAt: 6000,
        nextRunAt: 6600,
        previousLastRun: null,                  // wrong; the row's lastRun is 5000 now
      })
      expect(ok2).toBe(false)

      // Third claim with the CORRECT previousLastRun — succeeds.
      const ok3 = yield* store.claim("lock-a", {
        claimAt: 6000,
        nextRunAt: 6600,
        previousLastRun: 5000,
      })
      expect(ok3).toBe(true)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("claim returns false on missing job (no row to lock)", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ok = yield* store.claim("ghost", {
        claimAt: 1,
        nextRunAt: null,
        previousLastRun: null,
      })
      expect(ok).toBe(false)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  // ── job-ticker-producer-executor-276 (codex amendment 4) ────────────────

  it("claimAndStartRun atomically claims + starts a run in one call", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({ id: "cs-a", kind: "wake", spec: "*", payload: { label: "a" } })

      const started = yield* store.claimAndStartRun("cs-a", {
        claimAt: 5000,
        nextRunAt: 5600,
        previousLastRun: null,
        startedAt: 5000,
        attempt: 1,
      })
      expect(started).not.toBeNull()
      expect(started?.run.jobId).toBe("cs-a")
      expect(started?.run.status).toBe("running")
      expect(started?.run.attempt).toBe(1)
      expect(started?.run.finishedAt).toBeNull()

      // The claim CAS landed exactly like a plain claim() would.
      const after = yield* store.getById("cs-a")
      expect(after?.lastRun).toBe(5000)
      expect(after?.lastStatus).toBe("running")
      expect(after?.nextRunAt).toBe(5600)

      // The run row is independently visible via listRuns.
      const runs = yield* store.listRuns("cs-a")
      expect(runs.length).toBe(1)
      expect(runs[0]?.id).toBe(started?.run.id)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("claimAndStartRun returns null (no run row written) when the claim CAS loses", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({ id: "cs-b", kind: "wake", spec: "*", payload: { label: "b" } })
      // Win the first claim so the row's lastRun is no longer null.
      yield* store.claim("cs-b", { claimAt: 1000, nextRunAt: 1600, previousLastRun: null })

      // A competing claimAndStartRun using the STALE previousLastRun loses.
      const started = yield* store.claimAndStartRun("cs-b", {
        claimAt: 2000,
        nextRunAt: 2600,
        previousLastRun: null, // wrong; the row's lastRun is 1000 now
        startedAt: 2000,
        attempt: 1,
      })
      expect(started).toBeNull()

      // No orphan run row was written for the lost claim.
      const runs = yield* store.listRuns("cs-b")
      expect(runs.length).toBe(0)
      // And the row's state is untouched by the losing call.
      const after = yield* store.getById("cs-b")
      expect(after?.lastRun).toBe(1000)
      expect(after?.nextRunAt).toBe(1600)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("claimAndStartRun returns null on missing job (no row to lock, no run row)", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const started = yield* store.claimAndStartRun("ghost-cs", {
        claimAt: 1,
        nextRunAt: null,
        previousLastRun: null,
        startedAt: 1,
        attempt: 1,
      })
      expect(started).toBeNull()
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("recordRunStart + recordRunEnd round-trip; listRuns returns ordered desc", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({ id: "run-a", kind: "cron", spec: "*", payload: { label: "a" } })

      const r1 = yield* store.recordRunStart({ jobId: "run-a", startedAt: 1000 })
      expect(r1.status).toBe("running")
      expect(r1.attempt).toBe(1)
      expect(r1.finishedAt).toBeNull()

      const r2 = yield* store.recordRunStart({
        jobId: "run-a",
        startedAt: 2000,
        attempt: 2,
      })
      expect(r2.attempt).toBe(2)
      expect(r2.id).not.toBe(r1.id)

      const closed = yield* store.recordRunEnd(r1.id, {
        finishedAt: 1500,
        status: "success",
        outputText: "ok",
      })
      expect(closed).toBe(true)

      const all = yield* store.listRuns("run-a")
      // Ordered by startedAt DESC: r2 (2000) before r1 (1000).
      expect(all.length).toBe(2)
      expect(all[0]?.id).toBe(r2.id)
      expect(all[1]?.id).toBe(r1.id)
      expect(all[1]?.status).toBe("success")
      expect(all[1]?.outputText).toBe("ok")
      expect(all[1]?.finishedAt).toBe(1500)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("recordRunEnd returns false for missing run id", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ok = yield* store.recordRunEnd(99_999, {
        finishedAt: 0,
        status: "failed",
        error: "n/a",
      })
      expect(ok).toBe(false)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("pruneRuns deletes finished runs older than the cutoff; keeps recent + unfinished", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({ id: "pr", kind: "prompt", spec: "", payload: { label: "pr" } })

      // old finished run — finished_at 1000
      const r1 = yield* store.recordRunStart({ jobId: "pr", startedAt: 100 })
      yield* store.recordRunEnd(r1.id, { finishedAt: 1000, status: "success" })
      // recent finished run — finished_at 6000
      const r2 = yield* store.recordRunStart({ jobId: "pr", startedAt: 5000 })
      yield* store.recordRunEnd(r2.id, { finishedAt: 6000, status: "success" })
      // unfinished run — must NEVER be pruned regardless of age
      const r3 = yield* store.recordRunStart({ jobId: "pr", startedAt: 200 })

      // Prune everything finished strictly before t=5000 → only r1.
      const deleted = yield* store.pruneRuns(5000)
      expect(deleted).toBe(1)

      const rows = yield* store.listRuns("pr", 100)
      const ids = rows.map((r) => r.id).sort((a, b) => a - b)
      expect(ids).toEqual([r2.id, r3.id].sort((a, b) => a - b))
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("listRuns respects the limit parameter", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({ id: "many", kind: "cron", spec: "*", payload: { label: "m" } })
      for (let i = 0; i < 5; i++) {
        yield* store.recordRunStart({ jobId: "many", startedAt: i * 100 })
      }
      const tail = yield* store.listRuns("many", 2)
      expect(tail.length).toBe(2)
      // Ordered by startedAt DESC → 400, 300
      expect(tail[0]?.startedAt).toBe(400)
      expect(tail[1]?.startedAt).toBe(300)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("listDue ordering: rows with smaller next_run_at come first", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({ id: "ord-a", kind: "cron", spec: "*", payload: { label: "a" } })
      yield* store.record({ id: "ord-b", kind: "cron", spec: "*", payload: { label: "b" } })
      yield* store.record({ id: "ord-c", kind: "cron", spec: "*", payload: { label: "c" } })
      yield* store.setV2Fields("ord-a", { nextRunAt: 3000 })
      yield* store.setV2Fields("ord-b", { nextRunAt: 1000 })
      yield* store.setV2Fields("ord-c", { nextRunAt: 2000 })
      const due = yield* store.listDue(10_000)
      const order = due.map((j) => j.id)
      expect(order).toEqual(["ord-b", "ord-c", "ord-a"])
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  // ── Phase 5 (widget-system.md): live-status flip running↔waiting ──────────

  it("updateRunStatus flips a LIVE run running→waiting→running without touching finishedAt", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({ id: "w", kind: "prompt", spec: "*", payload: { label: "w" } })
      const run = yield* store.recordRunStart({ jobId: "w", startedAt: 100 })

      const parked = yield* store.updateRunStatus(run.id, "waiting")
      expect(parked).toBe(true)
      let rows = yield* store.listRuns("w")
      expect(rows[0]?.status).toBe("waiting")
      expect(rows[0]?.finishedAt).toBeNull() // waiting is NOT an end state

      const resumed = yield* store.updateRunStatus(run.id, "running")
      expect(resumed).toBe(true)
      rows = yield* store.listRuns("w")
      expect(rows[0]?.status).toBe("running")
      expect(rows[0]?.finishedAt).toBeNull()

      // only recordRunEnd closes the row
      yield* store.recordRunEnd(run.id, { finishedAt: 500, status: "success" })
      rows = yield* store.listRuns("w")
      expect(rows[0]?.status).toBe("success")
      expect(rows[0]?.finishedAt).toBe(500)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("updateRunStatus refuses a CLOSED run (no zombie resurrection) and missing ids", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({ id: "z", kind: "prompt", spec: "*", payload: { label: "z" } })
      const run = yield* store.recordRunStart({ jobId: "z", startedAt: 100 })
      yield* store.recordRunEnd(run.id, { finishedAt: 200, status: "failed", error: "boom" })

      // a late flip-back (the tool resumed after the ticker closed the run)
      // must NOT overwrite the terminal status
      const flipped = yield* store.updateRunStatus(run.id, "running")
      expect(flipped).toBe(false)
      const rows = yield* store.listRuns("z")
      expect(rows[0]?.status).toBe("failed")
      expect(rows[0]?.finishedAt).toBe(200)

      // unknown run id → false, no throw
      const ghost = yield* store.updateRunStatus(424_242, "waiting")
      expect(ghost).toBe(false)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  // job-ticker-oban-deadlines — Oban-style retry counter (SCHEMA_V3).
  it("retryAttempt defaults to 0 on record() and round-trips through setV2Fields", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const job = yield* store.record({
        id: "retry-me",
        kind: "dream",
        spec: "0 3 * * *",
        payload: { label: "retry-me" },
      })
      expect(job.retryAttempt).toBe(0)
      const fresh = yield* store.getById("retry-me")
      expect(fresh?.retryAttempt).toBe(0)

      yield* store.setV2Fields("retry-me", { retryAttempt: 3 })
      const bumped = yield* store.getById("retry-me")
      expect(bumped?.retryAttempt).toBe(3)

      // An unrelated patch (no retryAttempt key) must NOT reset it — matches
      // the `!== undefined` omit semantics every other V2 field already has.
      yield* store.setV2Fields("retry-me", { enabled: false })
      const untouched = yield* store.getById("retry-me")
      expect(untouched?.retryAttempt).toBe(3)
      expect(untouched?.enabled).toBe(false)

      yield* store.setV2Fields("retry-me", { retryAttempt: 0 })
      const reset = yield* store.getById("retry-me")
      expect(reset?.retryAttempt).toBe(0)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

})

/* ────────────────────────────────────────────────────────────────────────────
 * SQLite layer — updateRunStatus only (the broader SQLite coverage rides on
 * scheduler-tools' integration tests). The `AND finished_at IS NULL` zombie
 * guard lives in SQL, so it needs a real bun:sqlite run, not just the Memory
 * mirror. Bun-gated like session-store-sqlite.test.ts: a non-bun runner
 * skips cleanly.
 * ────────────────────────────────────────────────────────────────────────── */

import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const dSqlite = isBun ? describe : describe.skip

const bootstrapStubL = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "jobs-store test — bootstrap stub",
} as const)

const SqliteTestLayer = JobsStoreService.makeLayer(":memory:").pipe(
  Layer.provide(Clock.Default),
  Layer.provide(bootstrapStubL),
)

dSqlite("JobsStoreService (SQLite layer) — updateRunStatus", () => {
  it("flips a live run, leaves finishedAt NULL, and refuses closed rows", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({ id: "sw", kind: "prompt", spec: "*", payload: { label: "sw" } })
      const run = yield* store.recordRunStart({ jobId: "sw", startedAt: 100 })

      expect(yield* store.updateRunStatus(run.id, "waiting")).toBe(true)
      let rows = yield* store.listRuns("sw")
      expect(rows[0]?.status).toBe("waiting")
      expect(rows[0]?.finishedAt).toBeNull()

      expect(yield* store.updateRunStatus(run.id, "running")).toBe(true)

      yield* store.recordRunEnd(run.id, { finishedAt: 900, status: "success" })
      // SQL guard: closed row is untouched by a late flip
      expect(yield* store.updateRunStatus(run.id, "waiting")).toBe(false)
      rows = yield* store.listRuns("sw")
      expect(rows[0]?.status).toBe("success")
      expect(rows[0]?.finishedAt).toBe(900)

      // unknown run id → false
      expect(yield* store.updateRunStatus(999_999, "waiting")).toBe(false)
    })
    await Effect.runPromise(
      Effect.scoped(program.pipe(Effect.provide(SqliteTestLayer))),
    )
  })
})

// job-ticker-producer-executor-276 (codex amendment 4) - the SQLite layer's
// claimAndStartRun wraps the claim CAS AND the job_runs insert in one BEGIN
// IMMEDIATE. This is the ONLY layer where an insert can actually fail after
// a successful claim (a Memory Map.set cannot throw), so the "roll back the
// claim too" guarantee can only be exercised here.
dSqlite("JobsStoreService (SQLite layer) - claimAndStartRun rollback", () => {
  it("rolls back the claim when the run_start insert fails, leaving the job unclaimed", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({ id: "cs-rollback", kind: "prompt", spec: "*", payload: { label: "r" } })

      // Force the job_runs INSERT to violate its `attempt INTEGER NOT NULL`
      // constraint (a deliberately invalid runtime value, cast around the
      // type system to reach the SQL layer). The claim CAS lands FIRST
      // inside the same BEGIN IMMEDIATE - if it were not rolled back
      // together with the failed insert, `jobs.last_run` would advance with
      // no `job_runs` row to show for it, exactly the orphan window this
      // method exists to close.
      const result = yield* Effect.either(
        store.claimAndStartRun("cs-rollback", {
          claimAt: 5000,
          nextRunAt: 5600,
          previousLastRun: null,
          startedAt: 5000,
          attempt: null as unknown as number,
        }),
      )
      expect(result._tag).toBe("Left")

      // The claim was rolled back - a subsequent claim with the ORIGINAL
      // previousLastRun (null) still succeeds, proving jobs.last_run was
      // never actually advanced by the failed call.
      const won = yield* store.claim("cs-rollback", {
        claimAt: 6000,
        nextRunAt: 6600,
        previousLastRun: null,
      })
      expect(won).toBe(true)

      // No job_runs row was left behind by the rolled-back insert.
      const runs = yield* store.listRuns("cs-rollback")
      expect(runs.length).toBe(0)
    })
    await Effect.runPromise(
      Effect.scoped(program.pipe(Effect.provide(SqliteTestLayer))),
    )
  })
})

dSqlite("JobsStoreService (SQLite layer) — null clears, undefined omits", () => {
  it("setV2Fields(null) clears the column; an omitted key leaves it untouched", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({ id: "nz", kind: "prompt", spec: "", payload: { label: "nz" } })

      // Arrange: set schedule + nextRunAt to non-null values.
      yield* store.setV2Fields("nz", { schedule: "*/30 * * * *", nextRunAt: 5000 })
      const set = yield* store.getById("nz")
      expect(set?.schedule).toBe("*/30 * * * *")
      expect(set?.nextRunAt).toBe(5000)

      // Act 1: clear nextRunAt with an explicit null (COALESCE bug leaves it 5000).
      yield* store.setV2Fields("nz", { nextRunAt: null })
      const cleared1 = yield* store.getById("nz")
      expect(cleared1?.nextRunAt).toBeNull()
      expect(cleared1?.schedule).toBe("*/30 * * * *") // omitted key → untouched

      // Act 2: clear schedule with an explicit null.
      yield* store.setV2Fields("nz", { schedule: null })
      const cleared2 = yield* store.getById("nz")
      expect(cleared2?.schedule).toBeNull()

      // Act 3: an omitted key still omits — an enabled-only patch leaves nextRunAt.
      yield* store.setV2Fields("nz", { nextRunAt: 7000 })
      yield* store.setV2Fields("nz", { enabled: false })
      const omit = yield* store.getById("nz")
      expect(omit?.nextRunAt).toBe(7000)
      expect(omit?.enabled).toBe(false)
    })
    await Effect.runPromise(
      Effect.scoped(program.pipe(Effect.provide(SqliteTestLayer))),
    )
  })

  it("touch(null) clears next_run on the SQLite layer; omitted keys untouched", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({ id: "tc", kind: "cron", spec: "*", payload: { label: "tc" } })
      yield* store.touch("tc", { nextRun: 123, lastRun: 456, lastStatus: "scheduled" })
      const set = yield* store.getById("tc")
      expect(set?.nextRun).toBe(123)
      expect(set?.lastRun).toBe(456)

      yield* store.touch("tc", { nextRun: null })
      const cleared = yield* store.getById("tc")
      expect(cleared?.nextRun).toBeNull()
      expect(cleared?.lastRun).toBe(456) // omitted key → untouched
    })
    await Effect.runPromise(
      Effect.scoped(program.pipe(Effect.provide(SqliteTestLayer))),
    )
  })

  // job-ticker-oban-deadlines — the setV2FieldsStmt CASE-WHEN sentinel gained
  // a 4th (retry_attempt) pair; a positional-bind slip here would silently
  // scramble ANY of the four columns (a classic off-by-position trap), so
  // this exercises every column touched in the SAME call, not in isolation.
  it("setV2Fields writes retry_attempt alongside the other V2 columns without cross-column corruption", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const job = yield* store.record({ id: "ra", kind: "dream", spec: "", payload: { label: "ra" } })
      expect(job.retryAttempt).toBe(0)

      yield* store.setV2Fields("ra", {
        schedule: "0 3 * * *",
        enabled: true,
        nextRunAt: 4321,
        retryAttempt: 2,
      })
      const all = yield* store.getById("ra")
      expect(all?.schedule).toBe("0 3 * * *")
      expect(all?.enabled).toBe(true)
      expect(all?.nextRunAt).toBe(4321)
      expect(all?.retryAttempt).toBe(2)

      // A retryAttempt-only patch must leave the sibling columns untouched.
      yield* store.setV2Fields("ra", { retryAttempt: 5 })
      const bumped = yield* store.getById("ra")
      expect(bumped?.retryAttempt).toBe(5)
      expect(bumped?.schedule).toBe("0 3 * * *")
      expect(bumped?.nextRunAt).toBe(4321)

      // An explicit reset back to 0 is a real write, not an omit.
      yield* store.setV2Fields("ra", { retryAttempt: 0 })
      const reset = yield* store.getById("ra")
      expect(reset?.retryAttempt).toBe(0)
    })
    await Effect.runPromise(
      Effect.scoped(program.pipe(Effect.provide(SqliteTestLayer))),
    )
  })
})

dSqlite("JobsStoreService (SQLite layer) — pruneRuns", () => {
  it("deletes finished runs older than the cutoff; keeps recent + unfinished", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({ id: "pr", kind: "prompt", spec: "", payload: { label: "pr" } })
      const r1 = yield* store.recordRunStart({ jobId: "pr", startedAt: 100 })
      yield* store.recordRunEnd(r1.id, { finishedAt: 1000, status: "success" })
      const r2 = yield* store.recordRunStart({ jobId: "pr", startedAt: 5000 })
      yield* store.recordRunEnd(r2.id, { finishedAt: 6000, status: "success" })
      const r3 = yield* store.recordRunStart({ jobId: "pr", startedAt: 200 })

      const deleted = yield* store.pruneRuns(5000)
      expect(deleted).toBe(1)

      const rows = yield* store.listRuns("pr", 100)
      const ids = rows.map((r) => r.id).sort((a, b) => a - b)
      expect(ids).toEqual([r2.id, r3.id].sort((a, b) => a - b))
    })
    await Effect.runPromise(
      Effect.scoped(program.pipe(Effect.provide(SqliteTestLayer))),
    )
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * job-ticker-oban-deadlines — SCHEMA_V3 migration on an EXISTING V2 database.
 * DESIGN.md §5.1's required regression guard: open a real on-disk DB that
 * already has V1+V2 applied and rows recorded (as a pre-upgrade deployment
 * would), THEN let makeLayer() apply only the new V3 migration, and assert
 * the pre-existing rows survive with retry_attempt defaulted to 0. This is
 * distinct from the other SQLite tests, which all build a fresh DB where
 * V1+V2+V3 apply together and never exercise the V2->V3 upgrade path on
 * already-populated data.
 * ────────────────────────────────────────────────────────────────────────── */

dSqlite("JobsStoreService (SQLite layer) — SCHEMA_V3 migration on existing V2 DB", () => {
  it("preserves pre-existing V2 rows and defaults retry_attempt=0 after the V3 ALTER", async () => {
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { mkdtempSync } = await import("node:fs")
    const { Database } = (await import(
      /* @vite-ignore */ "bun:sqlite"
    )) as { Database: new (p: string) => import("../db/schema-versions.js").BunDb }
    const { ensureSchemaVersions, applyMigration } = await import(
      "../db/schema-versions.js"
    )

    const tmp = mkdtempSync(join(tmpdir(), "luna-jobs-v2v3-"))
    const dbPath = join(tmp, "test.db")

    // Arrange: hand-build a V1+V2-only database (mirrors SCHEMA_V1/V2 in
    // jobs-store.ts) and insert a row exactly as a pre-upgrade deployment
    // would have — no retry_attempt column exists yet.
    const seedDb = new Database(dbPath)
    seedDb.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id           TEXT NOT NULL PRIMARY KEY,
        kind         TEXT NOT NULL,
        spec         TEXT NOT NULL,
        next_run     INTEGER,
        last_run     INTEGER,
        last_status  TEXT,
        payload_json TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_kind_created
        ON jobs(kind, created_at);
    `)
    seedDb.run(`
      ALTER TABLE jobs ADD COLUMN schedule    TEXT;
      ALTER TABLE jobs ADD COLUMN enabled     INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE jobs ADD COLUMN next_run_at INTEGER;
      CREATE INDEX IF NOT EXISTS idx_jobs_due
        ON jobs(enabled, next_run_at);

      CREATE TABLE IF NOT EXISTS job_runs (
        id           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        job_id       TEXT    NOT NULL,
        started_at   INTEGER NOT NULL,
        finished_at  INTEGER,
        status       TEXT    NOT NULL,
        attempt      INTEGER NOT NULL DEFAULT 1,
        output_text  TEXT,
        error        TEXT,
        steps_json   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_job_runs_job
        ON job_runs(job_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_job_runs_status
        ON job_runs(status, started_at DESC);
    `)
    ensureSchemaVersions(seedDb)
    applyMigration(seedDb, "jobs", 1, "SELECT 1", 1000) // ledger only; DDL already ran above
    applyMigration(seedDb, "jobs", 2, "SELECT 1", 1000)
    seedDb
      .query(
        `INSERT INTO jobs
           (id, kind, spec, next_run, last_run, last_status, payload_json, created_at, updated_at, schedule, enabled, next_run_at)
         VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "pre-v3-job",
        "cron",
        "*/15 * * * *",
        JSON.stringify({ label: "pre-v3-job" }),
        1000,
        1000,
        "*/15 * * * *",
        1,
        2000,
      )
    seedDb.close()

    // Act: re-open the same on-disk DB through makeLayer(). V1 and V2 are
    // already recorded in schema_versions, so only SCHEMA_V3's additive
    // ALTER should run.
    const layer = JobsStoreService.makeLayer(dbPath).pipe(
      Layer.provide(Clock.Default),
      Layer.provide(bootstrapStubL),
    )
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const row = yield* store.getById("pre-v3-job")
      expect(row).not.toBeNull()
      expect(row?.kind).toBe("cron")
      expect(row?.spec).toBe("*/15 * * * *")
      expect(row?.schedule).toBe("*/15 * * * *")
      expect(row?.enabled).toBe(true)
      expect(row?.nextRunAt).toBe(2000)
      expect(row?.payload).toEqual({ label: "pre-v3-job" })
      // The required regression guard: retry_attempt defaults to 0 on a row
      // that predates SCHEMA_V3.
      expect(row?.retryAttempt).toBe(0)
    })
    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))))
  })
})
