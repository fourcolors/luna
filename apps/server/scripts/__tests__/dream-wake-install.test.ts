/**
 * dream-wake-install.test.ts — M4 (scheduler-v2 dream/wake migration).
 *
 * Asserts the install plan's ROW SHAPE and the UTC `next_run_at` invariant
 * WITHOUT touching any live DB: the plan/apply logic (dream-wake-install-lib.ts)
 * is driven against `JobsStoreService.Memory` (node-safe, no bun:sqlite), and
 * workspace enumeration is exercised through an injected fake `openDb` seam.
 *
 * Coverage:
 *   - planJobs: one dream row + one wake row per active workspace; correct
 *     kinds, stable ids, and the REQUIRED wake payload (workspaceSlug/Path).
 *   - applyPlan: rows land enabled=1 with schedule + next_run_at set; the
 *     next_run_at equals the cron's UTC firing instant regardless of host TZ.
 *   - idempotency: a second apply (no --force) is a no-op (skipped); --force
 *     replaces.
 *   - listActiveWorkspaces: active-only filter + graceful empty fallback.
 */
import { describe, expect, it } from "vitest"
import { Cron, Effect, Layer } from "effect"
import { Clock, JobsStoreService } from "@luna/core"
import type { JobsStoreApi } from "@luna/core"
import {
  applyPlan,
  computeNextRunAtUtc,
  listActiveWorkspaces,
  planJobs,
  wakeJobId,
  type MinimalReadOnlyDb,
} from "../dream-wake-install-lib.js"

const storeL = JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))

// A fixed instant: 2026-06-13T12:00:00Z. Both crons fire AFTER this within the
// same day so the expected next_run_at is unambiguous.
const NOW = Date.parse("2026-06-13T12:00:00.000Z")

const DREAM_CRON = "0 3 * * *" // 03:00 UTC daily
const WAKE_CRON = "*/30 * * * *" // every 30 min

const baseCfg = {
  dreamJobId: "dream-luna",
  dreamCron: DREAM_CRON,
  wakeJobPrefix: "wake",
  wakeCron: WAKE_CRON,
}

/** Expected next_run_at computed independently, with TZ forced to UTC, so the
 * assertion can't accidentally agree with a buggy local-TZ implementation. */
const expectedUtcNext = (expr: string, now: number): number => {
  const prev = process.env.TZ
  process.env.TZ = "UTC"
  try {
    const parsed = Cron.parse(expr)
    if (parsed._tag === "Failure") throw new Error(`bad cron ${expr}`)
    return Cron.next(parsed.success, new Date(now)).getTime()
  } finally {
    if (prev === undefined) delete process.env.TZ
    else process.env.TZ = prev
  }
}

describe("dream-wake-install — planJobs row shape", () => {
  it("plans one dream row + one wake row per active workspace", () => {
    const jobs = planJobs({
      ...baseCfg,
      wakeWorkspaces: [
        { slug: "luna", path: "/root/luna" },
        { slug: "moon", path: "/root/moon" },
      ],
    })

    expect(jobs).toHaveLength(3)

    const dream = jobs.find((j) => j.kind === "dream")
    expect(dream).toBeDefined()
    expect(dream!.id).toBe("dream-luna")
    expect(dream!.cron).toBe(DREAM_CRON)
    expect(dream!.payload.source).toBe("dream-wake-install")

    const wakes = jobs.filter((j) => j.kind === "wake")
    expect(wakes.map((w) => w.id)).toEqual([
      wakeJobId("wake", "luna"),
      wakeJobId("wake", "moon"),
    ])
    // wake payload MUST carry the per-workspace scope (parseWakePayload reads it)
    expect(wakes[0]!.payload["workspaceSlug"]).toBe("luna")
    expect(wakes[0]!.payload["workspacePath"]).toBe("/root/luna")
    expect(wakes[1]!.payload["workspaceSlug"]).toBe("moon")
    expect(wakes[1]!.payload["workspacePath"]).toBe("/root/moon")
  })

  it("--dream-only / --wake-only honour skip flags", () => {
    const ws = [{ slug: "luna", path: "/root/luna" }]
    const dreamOnly = planJobs({ ...baseCfg, wakeWorkspaces: ws, skipWake: true })
    expect(dreamOnly.map((j) => j.kind)).toEqual(["dream"])

    const wakeOnly = planJobs({ ...baseCfg, wakeWorkspaces: ws, skipDream: true })
    expect(wakeOnly.map((j) => j.kind)).toEqual(["wake"])
  })
})

describe("dream-wake-install — applyPlan writes UTC rows idempotently", () => {
  it("writes enabled=1 rows whose next_run_at is the cron's UTC instant", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const jobs = planJobs({
        ...baseCfg,
        wakeWorkspaces: [{ slug: "luna", path: "/root/luna" }],
      })

      const results = yield* applyPlan(store as JobsStoreApi, jobs, {
        force: false,
        now: NOW,
      })
      expect(results.every((r) => r.outcome === "installed")).toBe(true)

      const dreamRow = yield* store.getById("dream-luna")
      expect(dreamRow).not.toBeNull()
      expect(dreamRow!.kind).toBe("dream")
      expect(dreamRow!.enabled).toBe(true)
      expect(dreamRow!.schedule).toBe(DREAM_CRON)
      // next_run_at is the UTC firing instant — NOT the host-local one.
      expect(dreamRow!.nextRunAt).toBe(expectedUtcNext(DREAM_CRON, NOW))
      // sanity: 03:00 UTC the NEXT day (since now=12:00Z is past today's 03:00).
      expect(new Date(dreamRow!.nextRunAt!).toISOString()).toBe(
        "2026-06-14T03:00:00.000Z",
      )

      const wakeRow = yield* store.getById(wakeJobId("wake", "luna"))
      expect(wakeRow).not.toBeNull()
      expect(wakeRow!.kind).toBe("wake")
      expect(wakeRow!.enabled).toBe(true)
      expect(wakeRow!.nextRunAt).toBe(expectedUtcNext(WAKE_CRON, NOW))
      // every-30-min cron from 12:00:00Z → 12:30:00Z
      expect(new Date(wakeRow!.nextRunAt!).toISOString()).toBe(
        "2026-06-13T12:30:00.000Z",
      )
      // payload round-tripped the per-workspace scope
      expect(wakeRow!.payload["workspaceSlug"]).toBe("luna")
      expect(wakeRow!.payload["workspacePath"]).toBe("/root/luna")

      return { dreamRow, wakeRow }
    })

    await Effect.runPromise(program.pipe(Effect.provide(storeL)))
  })

  it("is idempotent: a second apply (no force) skips; force replaces", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const jobs = planJobs({
        ...baseCfg,
        wakeWorkspaces: [{ slug: "luna", path: "/root/luna" }],
      })

      yield* applyPlan(store as JobsStoreApi, jobs, { force: false, now: NOW })
      const second = yield* applyPlan(store as JobsStoreApi, jobs, {
        force: false,
        now: NOW + 60_000,
      })
      expect(second.every((r) => r.outcome === "skipped")).toBe(true)
      // skip left next_run_at untouched (still the FIRST apply's instant)
      const row = yield* store.getById("dream-luna")
      expect(row!.nextRunAt).toBe(expectedUtcNext(DREAM_CRON, NOW))

      // --force replaces (recomputes next_run_at against the new `now`)
      const forced = yield* applyPlan(store as JobsStoreApi, jobs, {
        force: true,
        now: NOW + 60_000,
      })
      expect(forced.every((r) => r.outcome === "replaced")).toBe(true)
      const after = yield* store.getById("dream-luna")
      expect(after!.nextRunAt).toBe(expectedUtcNext(DREAM_CRON, NOW + 60_000))

      // still exactly one dream + one wake row (no duplicates)
      const all = yield* store.listAll()
      expect(all.filter((r) => r.kind === "dream")).toHaveLength(1)
      expect(all.filter((r) => r.kind === "wake")).toHaveLength(1)
    })

    await Effect.runPromise(program.pipe(Effect.provide(storeL)))
  })
})

describe("dream-wake-install — listActiveWorkspaces", () => {
  // Build a fake bun:sqlite-shaped DB with a fixed workspaces row set.
  const fakeDb = (
    rows: Array<{ slug: string; path: string }>,
    opts: { hasTable?: boolean } = {},
  ): MinimalReadOnlyDb => ({
    query: (sql: string) => ({
      get: () => (opts.hasTable === false ? null : { x: 1 }),
      all: () => {
        if (!/FROM workspaces/i.test(sql)) return []
        return rows
      },
    }),
    close: () => {},
  })

  it("returns active workspaces from a present table", () => {
    // existsSync(__filename) is true → the loader proceeds to query the seam.
    const out = listActiveWorkspaces(__filename, () =>
      fakeDb([
        { slug: "luna", path: "/root/luna" },
        { slug: "moon", path: "/root/moon" },
      ]),
    )
    expect(out).toEqual([
      { slug: "luna", path: "/root/luna" },
      { slug: "moon", path: "/root/moon" },
    ])
  })

  it("returns [] when the workspaces table is missing (caller falls back)", () => {
    const out = listActiveWorkspaces(__filename, () =>
      fakeDb([], { hasTable: false }),
    )
    expect(out).toEqual([])
  })

  it("returns [] when luna.db does not exist", () => {
    const out = listActiveWorkspaces("/nonexistent/does-not-exist.db", () => {
      throw new Error("openDb should not be called for a missing file")
    })
    expect(out).toEqual([])
  })

  it("drops rows with empty slug/path", () => {
    const out = listActiveWorkspaces(__filename, () =>
      fakeDb([
        { slug: "luna", path: "/root/luna" },
        { slug: "", path: "/root/x" },
        { slug: "y", path: "" },
      ]),
    )
    expect(out).toEqual([{ slug: "luna", path: "/root/luna" }])
  })
})

describe("dream-wake-install — computeNextRunAtUtc", () => {
  it("is UTC-stable regardless of process.env.TZ", () => {
    const prev = process.env.TZ
    try {
      process.env.TZ = "America/Los_Angeles"
      const inLa = computeNextRunAtUtc(DREAM_CRON, NOW)
      process.env.TZ = "Asia/Tokyo"
      const inTokyo = computeNextRunAtUtc(DREAM_CRON, NOW)
      expect(inLa).toBe(inTokyo)
      expect(inLa).toBe(expectedUtcNext(DREAM_CRON, NOW))
      // restores TZ after each call
      expect(process.env.TZ).toBe("Asia/Tokyo")
    } finally {
      if (prev === undefined) delete process.env.TZ
      else process.env.TZ = prev
    }
  })

  it("returns null for an unparseable cron", () => {
    expect(computeNextRunAtUtc("not a cron", NOW)).toBeNull()
  })
})
