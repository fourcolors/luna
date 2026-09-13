/**
 * Integration test: fail-streak alerting for doctor-EXEMPT jobs.
 *
 * Context (see job-ticker-executor.ts's `computeFailStreakBucket` doc + the
 * PR that introduced this file): `dream-luna` failed 90 consecutive times
 * over ~30 days and nothing notified anyone, because `dream`/`wake` are
 * doctor-EXEMPT kinds (`isDoctorExemptKind`, doctor-enqueue.ts) — the
 * `exempt_kind` short-circuit in `maybeEnqueueDoctor` discards the streak
 * and enqueues nothing. This suite proves the executor's fail-streak note
 * closes that hole via the existing agent-notes/daily-brief rail, without
 * double-notifying kinds the doctor rail already owns.
 *
 * Uses Memory JobsStore + Memory AgentNotesService (real dedupe/fingerprint
 * behavior, not a stub) + JobTickerLayer({ autoStart: false }), mirroring
 * outcome-health-integration.test.ts's harness.
 */
import { describe, expect, it } from "vitest"
import { Duration, Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { JobsStoreService } from "./jobs-store.js"
import type { JobsStoreApi } from "./jobs-store-types.js"
import { JobTicker, JobTickerLayer, type JobTickerApi } from "./job-ticker.js"
import { makeWorkerRegistry, WorkerError, type Worker } from "./worker-registry.js"
import { AgentNotesService } from "../agent-notes/agent-notes.js"
import type { AgentNote, AgentNotesApi } from "../agent-notes/types.js"

// ── buildStack helper ────────────────────────────────────────────────────────

function buildStack(
  workers: Record<string, Worker>,
  tickerOpts?: Parameters<typeof JobTickerLayer>[0],
  notesLayer?: Layer.Layer<AgentNotesService>,
) {
  const storeL = JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))
  const regL = makeWorkerRegistry(workers)
  const notesL = notesLayer ?? AgentNotesService.Memory.pipe(Layer.provide(Clock.Default))
  const base = Layer.mergeAll(storeL, regL, notesL, Clock.Default)
  return JobTickerLayer({
    tickInterval: Duration.seconds(60),
    autoStart: false,
    shutdownDrainMs: 0,
    ...tickerOpts,
  }).pipe(Layer.provideMerge(base))
}

/** A notes layer whose `recordIfChanged` throws SYNCHRONOUSLY — simulates
 *  the worst case (a defect, not a typed NoteError) to prove the executor's
 *  wrapping (`Effect.promise` + `Effect.catch` + `Effect.catchDefect`) never
 *  lets a broken notes sink turn a job failure into a worse failure. */
function makePoisonNotesLayer(): Layer.Layer<AgentNotesService> {
  const api = {
    recordIfChanged: () => {
      throw new Error("notes service exploded")
    },
    record: () => Effect.die("stub: record not implemented"),
    getRecent: () => Effect.succeed([]),
    getRecentAcrossSessions: () => Effect.succeed([]),
    getChain: () => Effect.succeed([]),
    getByKind: () => Effect.succeed([]),
    getById: () => Effect.succeed(null),
    deleteForSession: () => Effect.succeed(0),
  } as unknown as AgentNotesApi
  return Layer.succeed(AgentNotesService, api)
}

const angry = (message: string): Worker => () =>
  Effect.fail(new WorkerError({ reason: "worker_failed", message }))

/** Fail-once-and-reset helper: fail `n` times on `id`, resetting
 *  `nextRunAt` to 0 between drains (mirrors job-ticker.test.ts's doctor
 *  auto-enqueue suite) so each drain re-dispatches the same recurring job. */
const failNTimes = (
  store: JobsStoreApi,
  ticker: JobTickerApi,
  id: string,
  n: number,
) =>
  Effect.gen(function* () {
    for (let i = 0; i < n; i++) {
      yield* ticker.drain
      yield* ticker.awaitIdle
      yield* store.setV2Fields(id, { nextRunAt: 0 })
    }
  })

describe("fail-streak alerting for doctor-exempt jobs", () => {
  it("below threshold: a doctor-exempt job failing emits no note", async () => {
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      const notes = yield* AgentNotesService

      yield* store.record({
        id: "dream-below",
        kind: "dream",
        spec: "0 0 1 1 *",
        payload: { label: "dream-below", max_attempts: 1 },
      })
      yield* store.setV2Fields("dream-below", { schedule: "0 0 1 1 *", nextRunAt: 0 })

      // threshold=5 (default), fail 3 times — stays below.
      yield* failNTimes(store, ticker, "dream-below", 3)

      const job = yield* store.getById("dream-below")
      expect(job?.failStreak).toBe(3)

      const jobNotes = yield* notes.getByKind("job-fail-streak:dream-below")
      expect(jobNotes.length).toBe(0)
      const anyNotes = yield* notes.getRecentAcrossSessions(50)
      expect(anyNotes.filter((n: AgentNote) => n.kind.startsWith("job-fail-streak:"))).toHaveLength(0)
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ dream: angry("still asleep") }))),
    )
  })

  it("doctor-exempt job crossing the fail-streak threshold emits one per-job note", async () => {
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      const notes = yield* AgentNotesService

      yield* store.record({
        id: "dream-cross",
        kind: "dream",
        spec: "0 0 1 1 *",
        payload: { label: "dream-cross", max_attempts: 1 },
      })
      yield* store.setV2Fields("dream-cross", { schedule: "0 0 1 1 *", nextRunAt: 0 })

      // threshold override = 2 for a fast test.
      yield* failNTimes(store, ticker, "dream-cross", 2)

      const job = yield* store.getById("dream-cross")
      expect(job?.failStreak).toBe(2)

      const jobNotes = yield* notes.getByKind("job-fail-streak:dream-cross")
      expect(jobNotes.length).toBe(1)
      const note = jobNotes[0]!
      expect(note.summary).toContain("dream-cross")
      expect(note.summary).toContain("kind=dream")
      expect(note.summary).toContain("2 times")
      expect(note.summary).toContain("boiling over")
    })
    await Effect.runPromise(
      prog.pipe(
        Effect.provide(
          buildStack(
            { dream: angry("boiling over") },
            { doctor: { failStreakThreshold: 2, orphanStreakThreshold: 2 } },
          ),
        ),
      ),
    )
  })

  it("a NON-exempt kind does NOT get the fail-streak note (the doctor rail owns it)", async () => {
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      const notes = yield* AgentNotesService

      yield* store.record({
        id: "prompt-chronic-notify-test",
        kind: "prompt",
        spec: "0 0 1 1 *",
        payload: { label: "p", max_attempts: 1 },
      })
      yield* store.setV2Fields("prompt-chronic-notify-test", {
        schedule: "0 0 1 1 *",
        nextRunAt: 0,
      })

      yield* failNTimes(store, ticker, "prompt-chronic-notify-test", 2)

      const job = yield* store.getById("prompt-chronic-notify-test")
      expect(job?.failStreak).toBe(2)
      // Doctor rail should have taken over (non-exempt kind, over threshold).
      expect(job?.healState).toBe("healing")

      const jobNotes = yield* notes.getByKind(
        "job-fail-streak:prompt-chronic-notify-test",
      )
      expect(jobNotes.length).toBe(0)
      const anyNotes = yield* notes.getRecentAcrossSessions(50)
      expect(
        anyNotes.filter((n: AgentNote) => n.kind.startsWith("job-fail-streak:")),
      ).toHaveLength(0)
    })
    await Effect.runPromise(
      prog.pipe(
        Effect.provide(
          buildStack(
            { prompt: angry("chronic") },
            {
              doctor: {
                failStreakThreshold: 2,
                orphanStreakThreshold: 2,
                // Explicit, matching job-ticker.test.ts's doctor auto-enqueue
                // suite — the doctor rail must actually enqueue here (not
                // skip on `cli_unreachable`) so the "doctor rail owns it"
                // assertion below is meaningful.
                cliPath: process.cwd() + "/apps/server/scripts/luna-doctor-workflow.ts",
              },
            },
          ),
        ),
      ),
    )
  })

  it("streak bucketing: crossing a later bucket re-notifies; a repeat within the same bucket does not", async () => {
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      const notes = yield* AgentNotesService

      yield* store.record({
        id: "dream-bucket",
        kind: "dream",
        spec: "0 0 1 1 *",
        payload: { label: "dream-bucket", max_attempts: 1 },
      })
      yield* store.setV2Fields("dream-bucket", { schedule: "0 0 1 1 *", nextRunAt: 0 })

      // threshold=2 → buckets double as 2, 4, 8, ...
      // streak 1: below threshold, no note.
      // streak 2: bucket 2 → note #1.
      // streak 3: still bucket 2 → suppressed (no new note).
      // streak 4: bucket 4 → note #2 (re-notify, worsening).
      yield* failNTimes(store, ticker, "dream-bucket", 4)

      const job = yield* store.getById("dream-bucket")
      expect(job?.failStreak).toBe(4)

      const jobNotes = yield* notes.getByKind("job-fail-streak:dream-bucket")
      expect(jobNotes.length).toBe(2)
      // getByKind returns newest-first.
      const [newest, oldest] = jobNotes
      expect(oldest!.summary).toContain("2 times")
      expect(newest!.summary).toContain("4 times")
    })
    await Effect.runPromise(
      prog.pipe(
        Effect.provide(
          buildStack(
            { dream: angry("bucket test") },
            { doctor: { failStreakThreshold: 2, orphanStreakThreshold: 2 } },
          ),
        ),
      ),
    )
  })

  it("ADR 0002 dedupe trap: two different doctor-exempt jobs failing alternately BOTH get their own notes", async () => {
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker
      const notes = yield* AgentNotesService

      for (const [id, kind] of [
        ["dream-alt", "dream"],
        ["wake-alt", "wake"],
      ] as const) {
        yield* store.record({
          id,
          kind,
          spec: "0 0 1 1 *",
          payload: { label: id, max_attempts: 1 },
        })
        yield* store.setV2Fields(id, { schedule: "0 0 1 1 *", nextRunAt: 0 })
      }

      // Both jobs are due every tick, so each drain fails BOTH concurrently
      // — exactly the shape that alternates a SHARED note kind forever
      // (ADR 0002) and starves whichever job loses the race. A per-job kind
      // must not have that problem.
      for (let i = 0; i < 2; i++) {
        yield* ticker.drain
        yield* ticker.awaitIdle
        yield* store.setV2Fields("dream-alt", { nextRunAt: 0 })
        yield* store.setV2Fields("wake-alt", { nextRunAt: 0 })
      }

      const dream = yield* store.getById("dream-alt")
      const wake = yield* store.getById("wake-alt")
      expect(dream?.failStreak).toBe(2)
      expect(wake?.failStreak).toBe(2)

      const dreamNotes = yield* notes.getByKind("job-fail-streak:dream-alt")
      const wakeNotes = yield* notes.getByKind("job-fail-streak:wake-alt")
      expect(dreamNotes.length).toBe(1)
      expect(wakeNotes.length).toBe(1)
      expect(dreamNotes[0]!.summary).toContain("dream-alt")
      expect(wakeNotes[0]!.summary).toContain("wake-alt")
    })
    await Effect.runPromise(
      prog.pipe(
        Effect.provide(
          buildStack(
            { dream: angry("dream down"), wake: angry("wake down") },
            { doctor: { failStreakThreshold: 2, orphanStreakThreshold: 2 } },
          ),
        ),
      ),
    )
  })

  it("a note-write failure (defect from the notes sink) does not change the run's terminal status", async () => {
    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker

      yield* store.record({
        id: "dream-poison",
        kind: "dream",
        spec: "0 0 1 1 *",
        payload: { label: "dream-poison", max_attempts: 1 },
      })
      yield* store.setV2Fields("dream-poison", { schedule: "0 0 1 1 *", nextRunAt: 0 })

      // Cross the threshold — this WOULD emit a note, but the notes sink
      // throws synchronously on every call.
      yield* failNTimes(store, ticker, "dream-poison", 2)

      const job = yield* store.getById("dream-poison")
      // The failStreak bump happens BEFORE the notify attempt and must be
      // unaffected by the notes sink exploding.
      expect(job?.failStreak).toBe(2)
      expect(job?.lastStatus).toBe("errored")

      const runs = yield* store.listRuns("dream-poison", 1)
      expect(runs[0]?.status).toBe("failed")
    })
    await Effect.runPromise(
      prog.pipe(
        Effect.provide(
          buildStack(
            { dream: angry("poisoned") },
            { doctor: { failStreakThreshold: 2, orphanStreakThreshold: 2 } },
            makePoisonNotesLayer(),
          ),
        ),
      ),
    )
  })
})
