/**
 * ThreadRegistry SQLite-layer tests.
 * Runs under the Bun test runner (bun:sqlite is a Bun built-in).
 * DO NOT run under vitest — bun:sqlite is not resolvable there.
 *
 * Registered in vitest.config.ts BUN_RUNTIME_TESTS exclude list.
 *
 * Covers:
 *  - Migration ledger (schema_versions row recorded)
 *  - CRUD via SQLite layer
 *  - Idempotent migration (applyMigration called twice)
 *  - Integration: simulate restart — same luna.db, new registry build, thread resolves
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ThreadRegistryService } from "./thread-registry.js"

// ── Bootstrap stub ──────────────────────────────────────────────────────────
// The SQLite layer requires LunaSqliteBootstrap (the vectorlite marker).
// In tests we just provide a dummy "ok" value — there is no Vectorlite here.
const BootstrapStub = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "test stub — no Vectorlite",
} as const)

const makeTestLayer = (dbPath: string) =>
  ThreadRegistryService.makeLayer(dbPath).pipe(
    Layer.provide(Clock.Default),
    Layer.provide(BootstrapStub),
  )

describe("ThreadRegistryService (SQLite layer)", () => {
  test("creates threads table and records migration", async () => {
    const layer = makeTestLayer(":memory:")
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      // Should be able to list with no rows
      const all = yield* reg.list()
      expect(all).toEqual([])
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer)))
  })

  // REGRESSION: the SQL update guard binds `input.sdkSessionId !== undefined`,
  // which was TRUE for an explicit null and ran
  // `SET sdk_session_id = CASE WHEN 1=1 THEN NULL END`, clobbering a live id.
  // Omitting the key must bind 0 and preserve the column.
  test("upsert preserves an existing sdk session id when the key is omitted", async () => {
    const layer = makeTestLayer(":memory:")
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      yield* reg.upsert({ id: "thr_sq_sidkeep", sdkSessionId: "sdk-sq-keep" })
      yield* reg.upsert({ id: "thr_sq_sidkeep", cwd: "/moved", model: "claude-y" })
      const row = yield* reg.get("thr_sq_sidkeep")
      expect(row?.sdkSessionId).toBe("sdk-sq-keep")
      expect(row?.cwd).toBe("/moved")
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer)))
  })

  test("upsert + get round-trip", async () => {
    const layer = makeTestLayer(":memory:")
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      const row = yield* reg.upsert({
        id: "thr_sqlite_1",
        cwd: "/test/dir",
        model: "claude-sonnet",
      })
      expect(row.id).toBe("thr_sqlite_1")
      expect(row.sdkSessionId).toBeNull()
      expect(row.cwd).toBe("/test/dir")

      const fetched = yield* reg.get("thr_sqlite_1")
      expect(fetched?.id).toBe("thr_sqlite_1")
      expect(fetched?.cwd).toBe("/test/dir")
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer)))
  })

  test("setSid persists the sdk session id", async () => {
    const layer = makeTestLayer(":memory:")
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      yield* reg.upsert({ id: "thr_sqlite_2" })
      const ok = yield* reg.setSid("thr_sqlite_2", "sdk-uuid-abc")
      expect(ok).toBe(true)
      const row = yield* reg.get("thr_sqlite_2")
      expect(row?.sdkSessionId).toBe("sdk-uuid-abc")
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer)))
  })

  test("setConfig partial patch (model only)", async () => {
    const layer = makeTestLayer(":memory:")
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      yield* reg.upsert({ id: "thr_sqlite_3", effort: "max" })
      yield* reg.setConfig("thr_sqlite_3", { model: "claude-opus" })
      const row = yield* reg.get("thr_sqlite_3")
      expect(row?.model).toBe("claude-opus")
      expect(row?.effort).toBe("max") // unchanged
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer)))
  })

  test("setTitleIfNull writes only when title is NULL and never bumps last_active_at", async () => {
    const layer = makeTestLayer(":memory:")
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      const row0 = yield* reg.upsert({ id: "thr_sqlite_title", nowMs: 1_000 })
      expect(row0.title).toBeNull()
      expect(row0.lastActiveAt).toBe(1_000)

      const wrote = yield* reg.setTitleIfNull("thr_sqlite_title", "Derived title")
      expect(wrote).toBe(true)
      const row1 = yield* reg.get("thr_sqlite_title")
      expect(row1?.title).toBe("Derived title")
      expect(row1?.lastActiveAt).toBe(1_000) // clock-neutral: no bump

      // Already titled → no-op
      const again = yield* reg.setTitleIfNull("thr_sqlite_title", "Other")
      expect(again).toBe(false)
      const row2 = yield* reg.get("thr_sqlite_title")
      expect(row2?.title).toBe("Derived title")
      expect(row2?.lastActiveAt).toBe(1_000)

      // Missing row → no-op, never inserts
      const ghost = yield* reg.setTitleIfNull("thr_sqlite_ghost", "Nope")
      expect(ghost).toBe(false)
      const ghostRow = yield* reg.get("thr_sqlite_ghost")
      expect(ghostRow).toBeNull()
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer)))
  })

  test("upsert normalizes a blank title to null; setTitleIfNull rejects a blank input", async () => {
    const layer = makeTestLayer(":memory:")
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      const row = yield* reg.upsert({ id: "thr_sqlite_blank", title: "   ", nowMs: 1_000 })
      expect(row.title).toBeNull() // never stored as ""
      // A blank derived title is never persisted; a real one backfills.
      expect(yield* reg.setTitleIfNull("thr_sqlite_blank", "  ")).toBe(false)
      expect(yield* reg.setTitleIfNull("thr_sqlite_blank", "Real")).toBe(true)
      const after = yield* reg.get("thr_sqlite_blank")
      expect(after?.title).toBe("Real")
      expect(after?.lastActiveAt).toBe(1_000) // clock-neutral
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer)))
  })

  test("list returns all rows (3 inserted)", async () => {
    const layer = makeTestLayer(":memory:")
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      yield* reg.upsert({ id: "thr_sqlite_a" })
      yield* reg.upsert({ id: "thr_sqlite_b" })
      yield* reg.upsert({ id: "thr_sqlite_c" })
      const all = yield* reg.list()
      expect(all.length).toBe(3)
      const ids = all.map((r) => r.id).sort()
      expect(ids).toEqual(["thr_sqlite_a", "thr_sqlite_b", "thr_sqlite_c"])
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer)))
  })

  test("migration is idempotent — schema_versions prevents re-run", async () => {
    // Build the layer twice against the same :memory: db.
    // The second build would fail if migration ran twice (CREATE TABLE IF NOT EXISTS
    // is safe but the schema_versions INSERT would collide).
    // Since :memory: is per-connection, we use a temp file to share.
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { mkdtempSync } = await import("node:fs")
    const tmp = mkdtempSync(join(tmpdir(), "luna-thread-reg-test-"))
    const dbPath = join(tmp, "test.db")

    const layer1 = makeTestLayer(dbPath)
    const program1 = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      yield* reg.upsert({ id: "thr_idem_1" })
    })
    await Effect.runPromise(program1.pipe(Effect.provide(layer1)))

    // Re-open the same file — migration must NOT throw
    const layer2 = makeTestLayer(dbPath)
    const program2 = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      const row = yield* reg.get("thr_idem_1")
      expect(row?.id).toBe("thr_idem_1")
    })
    await Effect.runPromise(program2.pipe(Effect.provide(layer2)))
  })

  test("integration: restart simulation — thread resolves from same luna.db", async () => {
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { mkdtempSync } = await import("node:fs")
    const tmp = mkdtempSync(join(tmpdir(), "luna-thread-reg-restart-"))
    const dbPath = join(tmp, "luna.db")

    // Session 1: create thread + capture sid
    const layer1 = makeTestLayer(dbPath)
    const program1 = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      yield* reg.upsert({ id: "thr_restart_1", cwd: "/work", model: "claude-sonnet" })
      yield* reg.setSid("thr_restart_1", "sdk-session-restart-uuid")
    })
    await Effect.runPromise(program1.pipe(Effect.provide(layer1)))

    // "Restart": build a FRESH registry from the same luna.db
    const layer2 = makeTestLayer(dbPath)
    const program2 = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      const row = yield* reg.get("thr_restart_1")
      // Thread must resolve — "unknown thread" is the failure mode we're guarding
      expect(row).not.toBeNull()
      expect(row?.sdkSessionId).toBe("sdk-session-restart-uuid")
      expect(row?.cwd).toBe("/work")
      expect(row?.model).toBe("claude-sonnet")
    })
    await Effect.runPromise(program2.pipe(Effect.provide(layer2)))
  })

  test("sid-less known thread is present in registry (for degradation path)", async () => {
    // This test covers the case where a thread exists but onSdkSessionId never fired
    // (e.g. server restarted before first turn). The registry returns a row with
    // sdkSessionId=null — the chat-service's subscribe() recovery detects this
    // and re-creates live with a warning rather than returning "unknown thread".
    const layer = makeTestLayer(":memory:")
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      // Insert a thread without a sid (as happens on thread creation before first turn)
      yield* reg.upsert({ id: "thr_nosid_1", cwd: "/work", model: "claude-opus" })
      const row = yield* reg.get("thr_nosid_1")
      expect(row).not.toBeNull()
      expect(row?.sdkSessionId).toBeNull()
      expect(row?.cwd).toBe("/work")
      // Caller (chat-service subscribe) detects sdkSessionId === null and re-creates live
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer)))
  })
})
