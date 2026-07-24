/* ──────────────────────────────────────────────────────────────────────────
 * Integration coverage for the ui_feedback -> durable job bridge, wired to
 * the REAL stores rather than the fakes feedback-job-bridge.test.ts uses.
 *
 * The unit tests pin the bridge's contract against injected doubles, which
 * cannot answer the two questions that decide whether this feature works at
 * all in production:
 *
 *   1. Does `openUiFeedbackStatusStore.getRow`'s real projection actually
 *      satisfy FeedbackJobLookupRow (kind + sessionId included)? A fake
 *      lookup satisfies the interface by construction, so only the real
 *      store can prove the seam is inhabited.
 *   2. Does the row the bridge writes become DUE for the ticker? `record()`
 *      defaults `nextRunAt` to null, so a job that is never selected by
 *      JobsStore.listDue would look perfectly correct in every unit test and
 *      still never run.
 *
 * Requires bun:sqlite for both stores, so the whole block skips visibly
 * under vitest/node (mirrors ui-feedback-status-store.test.ts's posture).
 * ────────────────────────────────────────────────────────────────────────── */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { Clock } from "../clock.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { JobsStoreService } from "../jobs/jobs-store.js"
import { createJobFromFeedback, feedbackJobIdFor } from "./feedback-job-bridge.js"
import { pollFeedbackJobsOnce } from "./feedback-job-observer.js"
import { openUiFeedbackStatusStore } from "./ui-feedback-status-store.js"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const dIntegration = isBun ? describe : describe.skip

/** Minimal mirror of agent-notes.ts's SCHEMA_V1 (the parent table the
 *  ui_feedback_status FK references), same deliberate copy as
 *  ui-feedback-status-store.test.ts. */
const AGENT_NOTES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_notes (
    id           TEXT NOT NULL PRIMARY KEY,
    session_id   TEXT NOT NULL,
    parent_id    TEXT,
    kind         TEXT NOT NULL,
    summary      TEXT NOT NULL,
    payload_json TEXT,
    ts           INTEGER NOT NULL
  );
`

type BunDb = {
  run: (sql: string, params?: unknown[]) => unknown
  query: (sql: string) => { get: (...p: unknown[]) => unknown }
  close: () => void
}

const bootstrapStubL = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "feedback-job-bridge integration test",
} as const)

/** Open one temp on-disk DB shared by both stores, exactly as production
 *  does (chat-server points the status store and the jobs store at the same
 *  luna.db). Returns everything the cases need plus a disposer. */
async function openFixture(): Promise<{
  db: BunDb
  dir: string
  statusStore: ReturnType<typeof openUiFeedbackStatusStore>
  dbPath: string
} | null> {
  const mod = await import("bun:sqlite" as string)
  const Database = (mod as { Database?: new (p: string) => BunDb }).Database
  if (!Database) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-fbjob-int-"))
  const dbPath = path.join(dir, "luna.db")
  const db = new Database(dbPath)
  db.run("PRAGMA journal_mode = WAL")
  db.run(AGENT_NOTES_SCHEMA)
  return { db, dir, dbPath, statusStore: openUiFeedbackStatusStore(db) }
}

const insertNote = (db: BunDb, id: string, sessionId: string, note: string): void => {
  db.run(
    `INSERT INTO agent_notes (id, session_id, kind, summary, payload_json, ts)
     VALUES (?, ?, 'ui_feedback', ?, ?, ?)`,
    [id, sessionId, note.slice(0, 200), JSON.stringify({ note }), Date.now()],
  )
}

dIntegration("feedback-job bridge (real stores)", () => {
  it("enqueues a job the ticker will actually dispatch, and links it to the note", async (ctx) => {
    const fx = await openFixture()
    if (!fx) return ctx.skip()
    const { db, dir, dbPath, statusStore } = fx
    const NOTE = "note-int-1"
    const THREAD = "thr_real_thread"
    insertNote(db, NOTE, THREAD, "the copy button does nothing")

    const program = Effect.gen(function* () {
      const jobs = yield* JobsStoreService
      const deps = {
        getFeedbackRow: async (id: string) => statusStore.getRow(id),
        jobs: {
          record: (input: Parameters<typeof jobs.record>[0]) =>
            Effect.runPromise(jobs.record(input)),
          getById: (id: string) => Effect.runPromise(jobs.getById(id)),
        },
        setStatus: async (args: Parameters<typeof statusStore.setStatus>[0], nowMs: number) =>
          statusStore.setStatus(args, nowMs),
      }

      const res = yield* Effect.promise(() =>
        createJobFromFeedback({ id: NOTE }, deps, Date.now()),
      )
      expect(res.ok).toBe(true)
      expect(res.jobId).toBe(feedbackJobIdFor(NOTE))

      const persisted = yield* jobs.getById(feedbackJobIdFor(NOTE))
      expect(persisted?.kind).toBe("prompt")
      expect(persisted?.enabled).toBe(true)
      const payload = (persisted?.payload ?? {}) as Record<string, unknown>
      expect(payload["user_prompt"]).toContain("the copy button does nothing")
      expect(payload["deliver_to"]).toEqual({ kind: "chat_thread", thread_id: THREAD })

      // The check no fake can make: `record()` leaves next_run_at null, so
      // this asserts the ticker's own due-selection really returns the row.
      const due = yield* jobs.listDue(Date.now())
      expect(due.map((j) => j.id)).toContain(feedbackJobIdFor(NOTE))

      const linked = statusStore.getRow(NOTE)
      expect(linked?.status).toBe("queued")
      expect(linked?.resolvedRef).toBe(feedbackJobIdFor(NOTE))

      // Re-submitting the same note must not mint a second job.
      const again = yield* Effect.promise(() =>
        createJobFromFeedback({ id: NOTE }, deps, Date.now()),
      )
      expect(again.ok).toBe(true)
      const count = (
        db.query(`SELECT COUNT(*) AS c FROM jobs WHERE id = ?`).get(feedbackJobIdFor(NOTE)) as {
          c: number
        }
      ).c
      expect(count).toBe(1)
    })

    try {
      await Effect.runPromise(
        program.pipe(
          Effect.provide(
            JobsStoreService.makeLayer(dbPath).pipe(
              Layer.provide(Clock.Default),
              Layer.provide(bootstrapStubL),
            ),
          ),
        ) as Effect.Effect<void, unknown, never>,
      )
    } finally {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("folds terminal runs back onto the note without clobbering a human's status", async (ctx) => {
    const fx = await openFixture()
    if (!fx) return ctx.skip()
    const { db, dir, dbPath, statusStore } = fx
    const OK_NOTE = "note-int-ok"
    const FAIL_NOTE = "note-int-fail"
    const HUMAN_NOTE = "note-int-human"
    insertNote(db, OK_NOTE, "ui-feedback", "first report")
    insertNote(db, FAIL_NOTE, "ui-feedback", "second report")
    insertNote(db, HUMAN_NOTE, "ui-feedback", "third report")

    const program = Effect.gen(function* () {
      const jobs = yield* JobsStoreService
      const setStatus = async (
        args: Parameters<typeof statusStore.setStatus>[0],
        nowMs: number,
      ) => statusStore.setStatus(args, nowMs)
      const deps = {
        getFeedbackRow: async (id: string) => statusStore.getRow(id),
        jobs: {
          record: (input: Parameters<typeof jobs.record>[0]) =>
            Effect.runPromise(jobs.record(input)),
          getById: (id: string) => Effect.runPromise(jobs.getById(id)),
        },
        setStatus,
      }
      const observerDeps = {
        listQueued: async (limit: number) => {
          const { rows } = statusStore.list({ limit, offset: 0, status: "queued" })
          return rows.map((r) => ({ id: r.id, resolvedRef: r.resolvedRef }))
        },
        listRuns: (jobId: string, limit: number) => Effect.runPromise(jobs.listRuns(jobId, limit)),
        setStatus,
        nowMs: () => Date.now(),
      }

      for (const id of [OK_NOTE, FAIL_NOTE, HUMAN_NOTE]) {
        yield* Effect.promise(() => createJobFromFeedback({ id }, deps, Date.now()))
      }

      // A note with no originating thread must carry no deliver_to at all.
      const sentinelJob = yield* jobs.getById(feedbackJobIdFor(OK_NOTE))
      expect("deliver_to" in ((sentinelJob?.payload ?? {}) as Record<string, unknown>)).toBe(false)

      const okRun = yield* jobs.recordRunStart({
        jobId: feedbackJobIdFor(OK_NOTE),
        startedAt: Date.now(),
      })
      yield* jobs.recordRunEnd(okRun.id, { finishedAt: Date.now(), status: "success" })
      const failRun = yield* jobs.recordRunStart({
        jobId: feedbackJobIdFor(FAIL_NOTE),
        startedAt: Date.now(),
      })
      yield* jobs.recordRunEnd(failRun.id, {
        finishedAt: Date.now(),
        status: "failed",
        error: "boom",
      })

      // A human triaged this one while its job was running: the observer
      // must leave both the status and the notes alone.
      statusStore.setStatus(
        { id: HUMAN_NOTE, status: "triaged", notes: "human already looked" },
        Date.now(),
      )
      const humanRun = yield* jobs.recordRunStart({
        jobId: feedbackJobIdFor(HUMAN_NOTE),
        startedAt: Date.now(),
      })
      yield* jobs.recordRunEnd(humanRun.id, { finishedAt: Date.now(), status: "success" })

      yield* Effect.promise(() => pollFeedbackJobsOnce(observerDeps))

      expect(statusStore.getRow(OK_NOTE)?.status).toBe("resolved")
      expect(statusStore.getRow(OK_NOTE)?.resolvedRef).toBe(feedbackJobIdFor(OK_NOTE))
      expect(statusStore.getRow(FAIL_NOTE)?.status).toBe("job-failed")
      expect(statusStore.getRow(HUMAN_NOTE)?.status).toBe("triaged")
      expect(statusStore.getRow(HUMAN_NOTE)?.statusNotes).toBe("human already looked")
    })

    try {
      await Effect.runPromise(
        program.pipe(
          Effect.provide(
            JobsStoreService.makeLayer(dbPath).pipe(
              Layer.provide(Clock.Default),
              Layer.provide(bootstrapStubL),
            ),
          ),
        ) as Effect.Effect<void, unknown, never>,
      )
    } finally {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("fails closed on a note that is not ui_feedback, minting no job", async (ctx) => {
    const fx = await openFixture()
    if (!fx) return ctx.skip()
    const { db, dir, dbPath, statusStore } = fx
    db.run(
      `INSERT INTO agent_notes (id, session_id, kind, summary, payload_json, ts)
       VALUES ('note-obs', 's', 'obs_note', 'not feedback', '{}', ?)`,
      [Date.now()],
    )

    const program = Effect.gen(function* () {
      const jobs = yield* JobsStoreService
      const res = yield* Effect.promise(() =>
        createJobFromFeedback(
          { id: "note-obs" },
          {
            getFeedbackRow: async (id: string) => statusStore.getRow(id),
            jobs: {
              record: (input: Parameters<typeof jobs.record>[0]) =>
                Effect.runPromise(jobs.record(input)),
              getById: (id: string) => Effect.runPromise(jobs.getById(id)),
            },
            setStatus: async (
              args: Parameters<typeof statusStore.setStatus>[0],
              nowMs: number,
            ) => statusStore.setStatus(args, nowMs),
          },
          Date.now(),
        ),
      )
      expect(res.ok).toBe(false)
      expect(yield* jobs.getById(feedbackJobIdFor("note-obs"))).toBeNull()
    })

    try {
      await Effect.runPromise(
        program.pipe(
          Effect.provide(
            JobsStoreService.makeLayer(dbPath).pipe(
              Layer.provide(Clock.Default),
              Layer.provide(bootstrapStubL),
            ),
          ),
        ) as Effect.Effect<void, unknown, never>,
      )
    } finally {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
