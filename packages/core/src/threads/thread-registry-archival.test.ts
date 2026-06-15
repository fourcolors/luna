/**
 * ThreadRegistry Phase 3 tests — archival state machine + auto-archive policy.
 * Covers Memory layer (deterministic, no SQLite).
 *
 * CARDINAL INVARIANT: archive() NEVER deletes the row or the SDK jsonl.
 * The row must remain present, and the sdkSessionId must remain intact
 * (= thread is still resumable) after archive.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import {
  ThreadRegistryService,
  AUTO_ARCHIVE_IDLE_MS,
  runAutoArchive,
} from "./thread-registry.js"

const TestLayer = ThreadRegistryService.Memory.pipe(Layer.provide(Clock.Default))

const run = <A>(effect: Effect.Effect<A, never, ThreadRegistryService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestLayer)))

// ── Helper: build a registry and upsert a thread ───────────────────────────

const withThread = (
  id: string,
  opts: { sdkSessionId?: string } = {},
) =>
  Effect.gen(function* () {
    const reg = yield* ThreadRegistryService
    yield* reg.upsert({ id, cwd: "/work", model: "claude-sonnet" })
    if (opts.sdkSessionId) {
      yield* reg.setSid(id, opts.sdkSessionId)
    }
    return reg
  })

// ── Archival state machine ─────────────────────────────────────────────────

describe("ThreadRegistry Phase 3 — archival state machine (Memory layer)", () => {
  it("newly created thread defaults to status=active, archivedAt=null", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* withThread("thr_p3_1")
        const row = yield* reg.get("thr_p3_1")
        expect(row).not.toBeNull()
        expect(row?.status).toBe("active")
        expect(row?.archivedAt).toBeNull()
      }),
    )
  })

  it("archive() flips status to archived and sets archivedAt", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* withThread("thr_p3_2")
        const ok = yield* reg.archive("thr_p3_2")
        expect(ok).toBe(true)
        const row = yield* reg.get("thr_p3_2")
        expect(row?.status).toBe("archived")
        expect(row?.archivedAt).toBeGreaterThan(0)
      }),
    )
  })

  it("unarchive() flips archived back to active and clears archivedAt", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* withThread("thr_p3_3")
        yield* reg.archive("thr_p3_3")
        const ok = yield* reg.unarchive("thr_p3_3")
        expect(ok).toBe(true)
        const row = yield* reg.get("thr_p3_3")
        expect(row?.status).toBe("active")
        expect(row?.archivedAt).toBeNull()
      }),
    )
  })

  it("archive() is idempotent (already archived -> returns true, row unchanged)", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* withThread("thr_p3_4")
        yield* reg.archive("thr_p3_4")
        const row1 = yield* reg.get("thr_p3_4")
        const archivedAt1 = row1?.archivedAt

        // archive again
        const ok = yield* reg.archive("thr_p3_4")
        expect(ok).toBe(true)
        const row2 = yield* reg.get("thr_p3_4")
        expect(row2?.status).toBe("archived")
        // archivedAt should not change on the second call
        expect(row2?.archivedAt).toBe(archivedAt1)
      }),
    )
  })

  it("unarchive() is idempotent (already active -> returns true)", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* withThread("thr_p3_5")
        // Thread is already active — unarchive should be a no-op
        const ok = yield* reg.unarchive("thr_p3_5")
        expect(ok).toBe(true)
        const row = yield* reg.get("thr_p3_5")
        expect(row?.status).toBe("active")
      }),
    )
  })

  it("archive() returns false for missing thread", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        const ok = yield* reg.archive("thr_p3_ghost")
        expect(ok).toBe(false)
      }),
    )
  })

  it("unarchive() returns false for missing thread", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        const ok = yield* reg.unarchive("thr_p3_ghost")
        expect(ok).toBe(false)
      }),
    )
  })

  it("active<->archived round-trip: row persists through both transitions", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* withThread("thr_p3_rt", { sdkSessionId: "sdk-rt-uuid" })

        // archive
        yield* reg.archive("thr_p3_rt")
        const archived = yield* reg.get("thr_p3_rt")
        expect(archived?.status).toBe("archived")
        expect(archived?.sdkSessionId).toBe("sdk-rt-uuid") // sid preserved
        expect(archived?.cwd).toBe("/work")                // cwd preserved

        // unarchive
        yield* reg.unarchive("thr_p3_rt")
        const active = yield* reg.get("thr_p3_rt")
        expect(active?.status).toBe("active")
        expect(active?.archivedAt).toBeNull()
        expect(active?.sdkSessionId).toBe("sdk-rt-uuid") // still intact
      }),
    )
  })
})

// ── CARDINAL INVARIANT: archive never deletes ──────────────────────────────

describe("ThreadRegistry Phase 3 — CARDINAL INVARIANT: archive never deletes", () => {
  it("after archive(), thread ROW still exists and is still queryable", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* withThread("thr_inv_1", { sdkSessionId: "sdk-inv-1" })
        yield* reg.archive("thr_inv_1")

        // ROW MUST STILL EXIST — the cardinal invariant
        const row = yield* reg.get("thr_inv_1")
        expect(row).not.toBeNull()
      }),
    )
  })

  it("after archive(), sdkSessionId is preserved (thread is still SDK-resumable)", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* withThread("thr_inv_2", { sdkSessionId: "sdk-resumable-uuid" })
        yield* reg.archive("thr_inv_2")

        const row = yield* reg.get("thr_inv_2")
        // sdkSessionId intact => thread can be resumed via SDK
        expect(row?.sdkSessionId).toBe("sdk-resumable-uuid")
      }),
    )
  })

  it("after archive(), thread still appears in list() (all-statuses list)", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* withThread("thr_inv_3")
        yield* reg.archive("thr_inv_3")

        const all = yield* reg.list()
        const found = all.find((r) => r.id === "thr_inv_3")
        // Must be in the full list — it was not deleted
        expect(found).toBeDefined()
        expect(found?.status).toBe("archived")
      }),
    )
  })

  it("archived thread disappears from listByStatus('active') but reappears in listByStatus('archived')", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_inv_4a" })
        yield* reg.upsert({ id: "thr_inv_4b" })
        yield* reg.archive("thr_inv_4a")

        const activeOnly = yield* reg.listByStatus("active")
        expect(activeOnly.map((r) => r.id)).not.toContain("thr_inv_4a")
        expect(activeOnly.map((r) => r.id)).toContain("thr_inv_4b")

        const archivedOnly = yield* reg.listByStatus("archived")
        expect(archivedOnly.map((r) => r.id)).toContain("thr_inv_4a")
        expect(archivedOnly.map((r) => r.id)).not.toContain("thr_inv_4b")
      }),
    )
  })
})

// ── Auto-archive 14-day cutoff ─────────────────────────────────────────────

describe("ThreadRegistry Phase 3 — auto-archive 14-day boundary", () => {
  const NOW = 1_700_000_000_000 // arbitrary reference timestamp

  it("a 15-day-idle thread IS archived by runAutoArchive", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        // Insert with a fake lastActiveAt = NOW - 15d
        const fifteenDaysAgo = NOW - 15 * 24 * 60 * 60 * 1000
        yield* reg.upsert({ id: "thr_stale_15" })
        // Manually adjust lastActiveAt by touching with a fake clock value.
        // The Memory layer's touch() uses the real clock; we work around this
        // by checking listStale directly with our reference timestamp.
        const stale = yield* reg.listStale(NOW - AUTO_ARCHIVE_IDLE_MS)
        // The thread we just created has lastActiveAt ~ now (real clock),
        // so it won't be in the stale list yet. Use a dedicated test that
        // manipulates the cutoff relative to the thread creation timestamp.
        // Strategy: thread was just created, so its lastActiveAt is ~now.
        // Use a future cutoff that includes it.
        const futureNow = (yield* reg.get("thr_stale_15"))!.lastActiveAt + AUTO_ARCHIVE_IDLE_MS + 1
        const stale2 = yield* reg.listStale(futureNow - AUTO_ARCHIVE_IDLE_MS)
        // Wait — we need last_active_at < cutoff. cutoff = futureNow - 14d.
        // Thread's lastActiveAt = ~now. futureNow = ~now + 14d + 1ms.
        // cutoff = futureNow - 14d = ~now + 1ms > thread.lastActiveAt => stale.
        expect(stale2.map((r) => r.id)).toContain("thr_stale_15")

        // runAutoArchive at futureNow should archive it
        const archived = yield* runAutoArchive(reg, futureNow)
        expect(archived).toContain("thr_stale_15")
        const row = yield* reg.get("thr_stale_15")
        expect(row?.status).toBe("archived")
      }),
    )
  })

  it("a 13-day-idle thread is NOT archived (boundary test: must be > 14d)", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_fresh_13" })

        const threadLastActive = (yield* reg.get("thr_fresh_13"))!.lastActiveAt
        // 13d after thread creation => thread was idle 1ms (just created)
        // Simulate: 13 days from now, thread's lastActiveAt is 1ms old.
        // We set "now" to 13 days in the future.
        const thirteenDaysFromNow = threadLastActive + 13 * 24 * 60 * 60 * 1000
        // cutoff = thirteenDaysFromNow - 14d = threadLastActive - 1d
        // thread.lastActiveAt > cutoff => NOT stale
        const stale = yield* reg.listStale(thirteenDaysFromNow - AUTO_ARCHIVE_IDLE_MS)
        expect(stale.map((r) => r.id)).not.toContain("thr_fresh_13")

        const archived = yield* runAutoArchive(reg, thirteenDaysFromNow)
        expect(archived).not.toContain("thr_fresh_13")
        const row = yield* reg.get("thr_fresh_13")
        expect(row?.status).toBe("active")
      }),
    )
  })

  it("a 14d + 1ms idle thread IS stale (exact boundary: strictly > 14d)", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_boundary" })

        const threadLastActive = (yield* reg.get("thr_boundary"))!.lastActiveAt
        // now = threadLastActive + 14d + 1ms => cutoff = threadLastActive + 1ms
        // thread.lastActiveAt < cutoff => stale
        const justOver14d = threadLastActive + AUTO_ARCHIVE_IDLE_MS + 1
        const stale = yield* reg.listStale(justOver14d - AUTO_ARCHIVE_IDLE_MS)
        expect(stale.map((r) => r.id)).toContain("thr_boundary")
      }),
    )
  })

  it("archived threads are NOT re-archived by runAutoArchive", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_already_archived" })
        yield* reg.archive("thr_already_archived")

        const threadLastActive = (yield* reg.get("thr_already_archived"))!.lastActiveAt
        const futureNow = threadLastActive + AUTO_ARCHIVE_IDLE_MS + 1
        // listStale only returns ACTIVE threads, so already-archived ones
        // must NOT appear.
        const stale = yield* reg.listStale(futureNow - AUTO_ARCHIVE_IDLE_MS)
        expect(stale.map((r) => r.id)).not.toContain("thr_already_archived")
      }),
    )
  })

  it("runAutoArchive returns only the ids that were archived in this run", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_batch_a" })
        yield* reg.upsert({ id: "thr_batch_b" })
        yield* reg.upsert({ id: "thr_batch_c" })

        const aLastActive = (yield* reg.get("thr_batch_a"))!.lastActiveAt
        // Run archive at a point that makes all 3 stale
        const farFuture = aLastActive + AUTO_ARCHIVE_IDLE_MS + 1000
        const archived = yield* runAutoArchive(reg, farFuture)
        expect(archived.sort()).toEqual(["thr_batch_a", "thr_batch_b", "thr_batch_c"].sort())
      }),
    )
  })
})

// ── listByStatus / listStale ───────────────────────────────────────────────

describe("ThreadRegistry Phase 3 — listByStatus + listStale", () => {
  it("listByStatus('active') returns only active threads", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_ls_a1" })
        yield* reg.upsert({ id: "thr_ls_a2" })
        yield* reg.upsert({ id: "thr_ls_arch" })
        yield* reg.archive("thr_ls_arch")

        const active = yield* reg.listByStatus("active")
        const ids = active.map((r) => r.id)
        expect(ids).toContain("thr_ls_a1")
        expect(ids).toContain("thr_ls_a2")
        expect(ids).not.toContain("thr_ls_arch")
        expect(active.every((r) => r.status === "active")).toBe(true)
      }),
    )
  })

  it("listByStatus('archived') returns only archived threads", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_ls_b1" })
        yield* reg.upsert({ id: "thr_ls_b_arch" })
        yield* reg.archive("thr_ls_b_arch")

        const archived = yield* reg.listByStatus("archived")
        const ids = archived.map((r) => r.id)
        expect(ids).toContain("thr_ls_b_arch")
        expect(ids).not.toContain("thr_ls_b1")
        expect(archived.every((r) => r.status === "archived")).toBe(true)
      }),
    )
  })

  it("listStale returns only ACTIVE threads below the cutoff", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_ls_fresh" })
        yield* reg.upsert({ id: "thr_ls_stale_candidate" })

        const ts = (yield* reg.get("thr_ls_stale_candidate"))!.lastActiveAt
        // cutoff = ts + 1ms => thread.lastActiveAt < cutoff => stale
        const stale = yield* reg.listStale(ts + 1)
        // Both threads were created at roughly the same time, both stale
        const ids = stale.map((r) => r.id)
        expect(ids).toContain("thr_ls_stale_candidate")
        expect(stale.every((r) => r.status === "active")).toBe(true)
      }),
    )
  })
})

// ── Liveness guard: no-open-work predicate ─────────────────────────────────

describe("ThreadRegistry Phase 3 — runAutoArchive liveness guard (isLive predicate)", () => {
  /**
   * The isLive predicate lets callers that have access to a live-thread set
   * (e.g. ChatService's in-flight turn Ref) skip archiving threads that are
   * currently active, even if they pass the 14-day time cutoff.
   *
   * Decision (audit fix #2): coupling the registry to ChatService internals is
   * impractical from the registry layer — the predicate is injected by the caller
   * that owns both. Absent: the 14-day `last_active_at` proxy suffices.
   */
  it("a stale thread IS archived when isLive returns false for it", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_guard_not_live" })

        const ts = (yield* reg.get("thr_guard_not_live"))!.lastActiveAt
        const futureNow = ts + AUTO_ARCHIVE_IDLE_MS + 1

        // isLive returns false => thread is idle => should be archived
        const isLive = (_id: string) => false
        const archived = yield* runAutoArchive(reg, futureNow, isLive)
        expect(archived).toContain("thr_guard_not_live")

        const row = yield* reg.get("thr_guard_not_live")
        expect(row?.status).toBe("archived")
      }),
    )
  })

  it("a stale >14d thread is SKIPPED by runAutoArchive when isLive returns true for it", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_guard_live" })

        const ts = (yield* reg.get("thr_guard_live"))!.lastActiveAt
        // Advance time past the 14-day cutoff so the thread IS stale by timestamp
        const futureNow = ts + AUTO_ARCHIVE_IDLE_MS + 1

        // isLive returns true for this thread => it has an in-flight turn =>
        // auto-archive must NOT archive it, even though it passed the time cutoff.
        const isLive = (id: string) => id === "thr_guard_live"
        const archived = yield* runAutoArchive(reg, futureNow, isLive)

        // Must not be in the archived list
        expect(archived).not.toContain("thr_guard_live")

        // Status must remain active (guard protected it)
        const row = yield* reg.get("thr_guard_live")
        expect(row?.status).toBe("active")
      }),
    )
  })

  it("runAutoArchive selectively archives non-live threads when some are live", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_guard_mix_live" })
        yield* reg.upsert({ id: "thr_guard_mix_idle" })

        const ts = (yield* reg.get("thr_guard_mix_live"))!.lastActiveAt
        const futureNow = ts + AUTO_ARCHIVE_IDLE_MS + 1

        // Only thr_guard_mix_live is marked as live
        const isLive = (id: string) => id === "thr_guard_mix_live"
        const archived = yield* runAutoArchive(reg, futureNow, isLive)

        expect(archived).not.toContain("thr_guard_mix_live")
        expect(archived).toContain("thr_guard_mix_idle")

        expect((yield* reg.get("thr_guard_mix_live"))?.status).toBe("active")
        expect((yield* reg.get("thr_guard_mix_idle"))?.status).toBe("archived")
      }),
    )
  })

  it("runAutoArchive with no isLive predicate archives stale threads (backward compat)", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_guard_no_pred" })

        const ts = (yield* reg.get("thr_guard_no_pred"))!.lastActiveAt
        const futureNow = ts + AUTO_ARCHIVE_IDLE_MS + 1

        // No predicate: falls back to timestamp-only guard
        const archived = yield* runAutoArchive(reg, futureNow)
        expect(archived).toContain("thr_guard_no_pred")
      }),
    )
  })
})
