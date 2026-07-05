/**
 * JobsStore SQLite-layer tests — payload-parse resilience (issue #232).
 * Runs under the Bun test runner (bun:sqlite is a Bun built-in).
 * DO NOT run under vitest — bun:sqlite is not resolvable there.
 *
 * Registered in vitest.config.ts BUN_RUNTIME_TESTS exclude list.
 *
 * Covers: a row with unparseable payload_json must be SKIPPED (not throw)
 * by both listAll (the workflow gallery) and listDue (the JobTicker's due
 * read) — a single malformed row must never blank the gallery or stall
 * dispatch of every scheduled job.
 */
import { Database } from "bun:sqlite"
import { afterAll, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rmSync } from "node:fs"
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { JobsStoreService } from "./jobs-store.js"

const BootstrapStub = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "test stub — no Vectorlite",
} as const)

const makeTestLayer = (dbPath: string) =>
  JobsStoreService.makeLayer(dbPath).pipe(
    Layer.provide(Clock.Default),
    Layer.provide(BootstrapStub),
  )

const dbPath = join(tmpdir(), `jobs-store-parse-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(dbPath + suffix)
    } catch {
      /* best-effort cleanup */
    }
  }
})

// Insert a row with deliberately malformed payload_json via a raw connection,
// bypassing the store's JSON.stringify path so we can simulate on-disk
// corruption / a partially-written row.
const insertRawBadRow = (path: string, id: string, now: number) => {
  const raw = new Database(path)
  try {
    raw.run(
      `INSERT INTO jobs
         (id, kind, spec, next_run, last_run, last_status, payload_json,
          created_at, updated_at, schedule, enabled, next_run_at)
       VALUES (?, 'cron', '*/5 * * * *', NULL, NULL, NULL, ?, ?, ?, NULL, 1, NULL)`,
      [id, "{ this is not: valid json", now, now],
    )
  } finally {
    raw.close()
  }
}

describe("JobsStoreService (SQLite layer) — payload parse resilience", () => {
  test("listAll skips a row with unparseable payload_json instead of throwing", async () => {
    const layer = makeTestLayer(dbPath)
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({
        id: "good-1",
        kind: "cron",
        spec: "*/30 * * * *",
        payload: { label: "healthy" },
      })
      // Corrupt row lands directly on disk, same table.
      insertRawBadRow(dbPath, "bad-1", Date.now())

      const all = yield* store.listAll()
      const ids = all.map((j) => j.id)
      expect(ids).toContain("good-1")
      expect(ids).not.toContain("bad-1")
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer)))
  })

  test("listDue skips the malformed row and still surfaces due jobs", async () => {
    const layer = makeTestLayer(dbPath)
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const due = yield* store.listDue(Date.now())
      const ids = due.map((j) => j.id)
      // good-1 has next_run_at NULL → always due; bad-1 is corrupt → skipped.
      expect(ids).toContain("good-1")
      expect(ids).not.toContain("bad-1")
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer)))
  })

  test("getById returns null for a row with unparseable payload_json", async () => {
    const layer = makeTestLayer(dbPath)
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const got = yield* store.getById("bad-1")
      expect(got).toBeNull()
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer)))
  })
})
