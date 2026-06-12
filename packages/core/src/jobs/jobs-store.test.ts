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
