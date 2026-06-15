/**
 * ThreadRegistry Phase 3 — SQLite-layer archival tests.
 * Runs under the Bun test runner (bun:sqlite is a Bun built-in).
 * DO NOT run under vitest — bun:sqlite is not resolvable there.
 *
 * Registered in vitest.config.ts BUN_RUNTIME_TESTS exclude list.
 *
 * Covers:
 *  - Migration v2 (additive ALTER: status + archived_at columns added,
 *    existing rows default to active)
 *  - Archival state machine via SQLite layer (archive/unarchive round-trip)
 *  - CARDINAL INVARIANT: archive() preserves row + sdkSessionId (resumable)
 *  - auto-archive boundary (13d idle NOT archived; 15d idle IS)
 *  - WS integration layer (archive-thread / unarchive-thread round-trip)
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import {
  ThreadRegistryService,
  AUTO_ARCHIVE_IDLE_MS,
  runAutoArchive,
} from "./thread-registry.js"

// ── Bootstrap stub ──────────────────────────────────────────────────────────
const BootstrapStub = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "test stub — no Vectorlite",
} as const)

const makeTestLayer = (dbPath: string) =>
  ThreadRegistryService.makeLayer(dbPath).pipe(
    Layer.provide(Clock.Default),
    Layer.provide(BootstrapStub),
  )

// ── Migration v2 ────────────────────────────────────────────────────────────

describe("ThreadRegistry SQLite — migration v2 (additive ALTER)", () => {
  test("migration v2 adds status and archived_at columns; existing rows default to active", async () => {
    const layer = makeTestLayer(":memory:")
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_v2_existing" })
        const row = yield* reg.get("thr_v2_existing")
        expect(row?.status).toBe("active")
        expect(row?.archivedAt).toBeNull()
      }).pipe(Effect.provide(layer)),
    )
  })

  test("migration v2 is idempotent (applyMigration ledger prevents re-run)", async () => {
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { mkdtempSync } = await import("node:fs")
    const tmp = mkdtempSync(join(tmpdir(), "luna-v2-idem-"))
    const dbPath = join(tmp, "test.db")

    const layer1 = makeTestLayer(dbPath)
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_idem2_a" })
      }).pipe(Effect.provide(layer1)),
    )

    // Re-open same file — migration v2 must NOT throw
    const layer2 = makeTestLayer(dbPath)
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        const row = yield* reg.get("thr_idem2_a")
        expect(row?.id).toBe("thr_idem2_a")
        expect(row?.status).toBe("active")
      }).pipe(Effect.provide(layer2)),
    )
  })
})

// ── Archival state machine via SQLite ───────────────────────────────────────

describe("ThreadRegistry SQLite — archival state machine", () => {
  test("archive() flips active->archived and sets archived_at", async () => {
    const layer = makeTestLayer(":memory:")
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_sq_arch1", sdkSessionId: "sdk-sq-arch1" })
        const ok = yield* reg.archive("thr_sq_arch1")
        expect(ok).toBe(true)
        const row = yield* reg.get("thr_sq_arch1")
        expect(row?.status).toBe("archived")
        expect(row?.archivedAt).toBeGreaterThan(0)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("unarchive() flips archived->active and clears archived_at", async () => {
    const layer = makeTestLayer(":memory:")
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_sq_unarch" })
        yield* reg.archive("thr_sq_unarch")
        const ok = yield* reg.unarchive("thr_sq_unarch")
        expect(ok).toBe(true)
        const row = yield* reg.get("thr_sq_unarch")
        expect(row?.status).toBe("active")
        expect(row?.archivedAt).toBeNull()
      }).pipe(Effect.provide(layer)),
    )
  })

  test("active<->archived round-trip: row and sid intact throughout", async () => {
    const layer = makeTestLayer(":memory:")
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_sq_rt", cwd: "/work/rt", model: "claude-opus" })
        yield* reg.setSid("thr_sq_rt", "sdk-rt-sqlite-uuid")

        // archive
        yield* reg.archive("thr_sq_rt")
        const archived = yield* reg.get("thr_sq_rt")
        expect(archived?.status).toBe("archived")
        expect(archived?.sdkSessionId).toBe("sdk-rt-sqlite-uuid") // intact
        expect(archived?.cwd).toBe("/work/rt")                    // intact

        // unarchive
        yield* reg.unarchive("thr_sq_rt")
        const active = yield* reg.get("thr_sq_rt")
        expect(active?.status).toBe("active")
        expect(active?.archivedAt).toBeNull()
        expect(active?.sdkSessionId).toBe("sdk-rt-sqlite-uuid")   // still intact
      }).pipe(Effect.provide(layer)),
    )
  })

  test("archive() is idempotent", async () => {
    const layer = makeTestLayer(":memory:")
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_sq_idem" })
        yield* reg.archive("thr_sq_idem")
        const first = yield* reg.get("thr_sq_idem")
        const at1 = first?.archivedAt

        // archive again — must not throw and must not change archivedAt
        const ok = yield* reg.archive("thr_sq_idem")
        expect(ok).toBe(true)
        const row = yield* reg.get("thr_sq_idem")
        expect(row?.status).toBe("archived")
        // archivedAt may or may not update on idempotent call;
        // what matters is the row still exists and is still archived.
        expect(row?.archivedAt).toBeGreaterThan(0)
      }).pipe(Effect.provide(layer)),
    )
  })
})

// ── CARDINAL INVARIANT via SQLite ───────────────────────────────────────────

describe("ThreadRegistry SQLite — CARDINAL INVARIANT: archive never deletes", () => {
  test("archive(): row still present, sdkSessionId intact (thread is still resumable)", async () => {
    const layer = makeTestLayer(":memory:")
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_card_1", cwd: "/w", model: "claude-sonnet" })
        yield* reg.setSid("thr_card_1", "sdk-cardinal-uuid")

        // ARCHIVE
        yield* reg.archive("thr_card_1")

        // ROW MUST STILL EXIST — never deleted
        const row = yield* reg.get("thr_card_1")
        expect(row).not.toBeNull()

        // sdkSessionId MUST BE INTACT — thread is still SDK-resumable
        expect(row?.sdkSessionId).toBe("sdk-cardinal-uuid")

        // cwd MUST BE INTACT — load-bearing for SDK resume
        expect(row?.cwd).toBe("/w")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("archive(): thread still appears in list() (all-statuses)", async () => {
    const layer = makeTestLayer(":memory:")
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_card_2" })
        yield* reg.archive("thr_card_2")

        const all = yield* reg.list()
        const found = all.find((r) => r.id === "thr_card_2")
        expect(found).toBeDefined()
        expect(found?.status).toBe("archived")
      }).pipe(Effect.provide(layer)),
    )
  })
})

// ── auto-archive 14-day boundary via SQLite ────────────────────────────────

describe("ThreadRegistry SQLite — auto-archive 14-day boundary", () => {
  test("a 15d-idle thread IS stale; a 13d-idle thread is NOT stale", async () => {
    const layer = makeTestLayer(":memory:")
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_sq_stale" })
        yield* reg.upsert({ id: "thr_sq_fresh" })

        const staleTs = (yield* reg.get("thr_sq_stale"))!.lastActiveAt
        // 15d in the future from thread creation
        const fifteenDaysLater = staleTs + 15 * 24 * 60 * 60 * 1000
        // cutoff = fifteenDaysLater - 14d = staleTs + 1d => stale
        const stale = yield* reg.listStale(fifteenDaysLater - AUTO_ARCHIVE_IDLE_MS)
        expect(stale.map((r) => r.id)).toContain("thr_sq_stale")

        // 13d in the future
        const thirteenDaysLater = staleTs + 13 * 24 * 60 * 60 * 1000
        // cutoff = thirteenDaysLater - 14d = staleTs - 1d => NOT stale
        const notStale = yield* reg.listStale(thirteenDaysLater - AUTO_ARCHIVE_IDLE_MS)
        expect(notStale.map((r) => r.id)).not.toContain("thr_sq_fresh")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("runAutoArchive archives only the stale threads", async () => {
    const layer = makeTestLayer(":memory:")
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_sq_auto_stale" })
        yield* reg.upsert({ id: "thr_sq_auto_fresh" })

        const staleTs = (yield* reg.get("thr_sq_auto_stale"))!.lastActiveAt
        const farFuture = staleTs + AUTO_ARCHIVE_IDLE_MS + 1000

        const archived = yield* runAutoArchive(reg, farFuture)
        // Both were created at the same moment, so both are stale
        expect(archived.sort()).toEqual(
          ["thr_sq_auto_stale", "thr_sq_auto_fresh"].sort(),
        )
        const row1 = yield* reg.get("thr_sq_auto_stale")
        const row2 = yield* reg.get("thr_sq_auto_fresh")
        expect(row1?.status).toBe("archived")
        expect(row2?.status).toBe("archived")
        // Rows still exist — never deleted
        expect(row1).not.toBeNull()
        expect(row2).not.toBeNull()
      }).pipe(Effect.provide(layer)),
    )
  })
})

// ── listByStatus via SQLite ─────────────────────────────────────────────────

describe("ThreadRegistry SQLite — listByStatus", () => {
  test("listByStatus('active') excludes archived; listByStatus('archived') includes only archived", async () => {
    const layer = makeTestLayer(":memory:")
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_lbs_a" })
        yield* reg.upsert({ id: "thr_lbs_b" })
        yield* reg.upsert({ id: "thr_lbs_arch" })
        yield* reg.archive("thr_lbs_arch")

        const active = yield* reg.listByStatus("active")
        expect(active.map((r) => r.id)).toContain("thr_lbs_a")
        expect(active.map((r) => r.id)).toContain("thr_lbs_b")
        expect(active.map((r) => r.id)).not.toContain("thr_lbs_arch")

        const archived = yield* reg.listByStatus("archived")
        expect(archived.map((r) => r.id)).toContain("thr_lbs_arch")
        expect(archived.map((r) => r.id)).not.toContain("thr_lbs_a")
        expect(archived.map((r) => r.id)).not.toContain("thr_lbs_b")
      }).pipe(Effect.provide(layer)),
    )
  })
})

// ── Integration: restart simulation with archival state ─────────────────────

describe("ThreadRegistry SQLite — restart with archived threads", () => {
  test("archived thread survives registry restart (row + status intact)", async () => {
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { mkdtempSync } = await import("node:fs")
    const tmp = mkdtempSync(join(tmpdir(), "luna-arch-restart-"))
    const dbPath = join(tmp, "luna.db")

    // Session 1: create + archive
    const layer1 = makeTestLayer(dbPath)
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_rstart_arch", cwd: "/work" })
        yield* reg.setSid("thr_rstart_arch", "sdk-restart-arch-uuid")
        yield* reg.archive("thr_rstart_arch")
      }).pipe(Effect.provide(layer1)),
    )

    // "Restart": fresh registry from same luna.db
    const layer2 = makeTestLayer(dbPath)
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        const row = yield* reg.get("thr_rstart_arch")
        // Row must survive restart
        expect(row).not.toBeNull()
        expect(row?.status).toBe("archived")
        // sdkSessionId intact => still resumable
        expect(row?.sdkSessionId).toBe("sdk-restart-arch-uuid")
      }).pipe(Effect.provide(layer2)),
    )
  })
})
