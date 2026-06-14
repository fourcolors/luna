/**
 * dream-wake-install-lib — pure, testable building blocks for the M4
 * scheduler-v2 dream/wake install script (dream-wake-install.ts).
 *
 * Everything that decides WHAT rows to write (ids, payloads, cron exprs, the
 * one-row-per-active-workspace fan-out) and HOW to write them idempotently
 * lives here, with NO top-level side effects and NO bun:sqlite assumption — so
 * the M4 test imports this module directly and drives it against
 * `JobsStoreService.Memory` (node-safe) while injecting a fake `openDb` seam for
 * workspace enumeration. The thin entrypoint (dream-wake-install.ts) only reads
 * env/argv, builds the config, opens the SQLite store, and calls `applyPlan`.
 *
 * "Wake-enabled" workspace == an `active` row in luna.db's `workspaces` table —
 * the SAME set the boot-time workspaces-loader enumerates. There is no
 * per-workspace wake flag in the schema; the global LUNA_WAKE_ENABLED switch
 * (handled by the caller) gates the whole set. When luna.db has no active
 * workspaces the caller falls back to a single env-configured workspace (the
 * legacy boot's behaviour).
 */
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { Cron, Effect } from "effect"
import type { JobsStoreApi, JobsStoreError } from "@luna/core"

// ── Workspace enumeration (injectable bun:sqlite seam) ───────────────────────

/** Minimal bun:sqlite shape — just what this enumeration needs. */
export interface MinimalReadOnlyDb {
  query: (sql: string) => {
    get: (...p: unknown[]) => unknown
    all: (...p: unknown[]) => unknown[]
  }
  close: () => void
}

/** Factory the helper calls to open luna.db read-only. Injectable for tests. */
export type OpenDb = (dbPath: string) => MinimalReadOnlyDb

export interface ActiveWorkspace {
  readonly slug: string
  readonly path: string
}

const defaultOpenDb: OpenDb = (dbPath: string): MinimalReadOnlyDb => {
  const req = createRequire(import.meta.url)
  const mod = req("bun:sqlite") as {
    Database: new (p: string, opts?: { readonly?: boolean }) => MinimalReadOnlyDb
  }
  return new mod.Database(dbPath, { readonly: true })
}

/**
 * Return every `status='active'` workspace as { slug, path }, ordered by
 * updated_at DESC (same ordering as workspaces-loader.ts). Returns `[]` when
 * luna.db does not exist, the `workspaces` table is missing, or there are no
 * active rows — the caller then falls back to the single env-configured wake
 * workspace.
 */
export function listActiveWorkspaces(
  lunaDbPath: string,
  openDb: OpenDb = defaultOpenDb,
): ReadonlyArray<ActiveWorkspace> {
  if (!existsSync(lunaDbPath)) return []

  const db = openDb(lunaDbPath)
  try {
    const hasTable = db
      .query(
        "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='workspaces' LIMIT 1",
      )
      .get() as { x: number } | undefined | null
    if (hasTable == null) return []

    const rows = db
      .query(
        `SELECT slug, path
         FROM workspaces
         WHERE status = 'active'
         ORDER BY updated_at DESC`,
      )
      .all() as Array<{ slug: string; path: string }>

    return rows
      .filter(
        (r) =>
          typeof r.slug === "string" &&
          r.slug.length > 0 &&
          typeof r.path === "string" &&
          r.path.length > 0,
      )
      .map((r) => ({ slug: r.slug, path: r.path }))
  } finally {
    db.close()
  }
}

// ── Cron → UTC next_run_at ───────────────────────────────────────────────────

/**
 * Compute the next fire time AS IF the host were UTC.
 *
 * `effect/Cron`'s `Cron.next` interprets cron expressions using the host's
 * local timezone. The chat-server runs in UTC; this install script may run on a
 * developer's machine in a different TZ. We force UTC interpretation by
 * temporarily flipping `process.env.TZ` around the Cron call, then restoring it
 * — the result is the same epoch-ms the server computes on its next tick, so
 * the row is portable. Identical technique to daily-brief-install.ts. Returns
 * `null` when the expression fails to parse.
 */
export const computeNextRunAtUtc = (
  expr: string,
  now: number,
): number | null => {
  const prevTz = process.env.TZ
  process.env.TZ = "UTC"
  try {
    const parsed = Cron.parse(expr)
    if (parsed._tag === "Left") return null
    return Cron.next(parsed.right, new Date(now)).getTime()
  } finally {
    if (prevTz === undefined) delete process.env.TZ
    else process.env.TZ = prevTz
  }
}

// ── Plan: the set of rows the install wants ──────────────────────────────────

export type JobPayload = { readonly label: string; readonly source?: string } & Record<
  string,
  unknown
>

export interface PlannedJob {
  readonly id: string
  readonly kind: "dream" | "wake"
  readonly cron: string
  readonly payload: JobPayload
}

export interface PlanConfig {
  readonly dreamJobId: string
  readonly dreamCron: string
  readonly wakeJobPrefix: string
  readonly wakeCron: string
  /** Active workspaces to write wake rows for (already gated/fallback-resolved). */
  readonly wakeWorkspaces: ReadonlyArray<ActiveWorkspace>
  /** Skip the dream row (e.g. --wake-only). Default false. */
  readonly skipDream?: boolean
  /** Skip all wake rows (e.g. --dream-only OR LUNA_WAKE_ENABLED=0). Default false. */
  readonly skipWake?: boolean
}

/** Stable per-workspace wake row id (namespaced by prefix). */
export const wakeJobId = (prefix: string, slug: string): string =>
  `${prefix}-${slug}`

/**
 * Build the desired row set from config. The dream payload is metadata-only
 * (the dream worker reads its window from the watermark, not the row). Each
 * wake payload carries the REQUIRED `{ workspaceSlug, workspacePath }` the wake
 * worker parses up front (parseWakePayload in wake-worker.ts).
 */
export const planJobs = (cfg: PlanConfig): ReadonlyArray<PlannedJob> => {
  const jobs: PlannedJob[] = []
  if (!cfg.skipDream) {
    jobs.push({
      id: cfg.dreamJobId,
      kind: "dream",
      cron: cfg.dreamCron,
      payload: { label: "dream", source: "dream-wake-install" },
    })
  }
  if (!cfg.skipWake) {
    for (const ws of cfg.wakeWorkspaces) {
      jobs.push({
        id: wakeJobId(cfg.wakeJobPrefix, ws.slug),
        kind: "wake",
        cron: cfg.wakeCron,
        payload: {
          label: `wake-${ws.slug}`,
          source: "dream-wake-install",
          workspaceSlug: ws.slug,
          workspacePath: ws.path,
        },
      })
    }
  }
  return jobs
}

// ── Apply: write the plan idempotently ───────────────────────────────────────

export type ApplyOutcome = "installed" | "skipped" | "replaced"

export interface ApplyResult {
  readonly id: string
  readonly outcome: ApplyOutcome
  readonly nextRunAt: number
}

/**
 * Idempotently upsert every planned row into the store.
 *
 * Skip-if-exists by stable id unless `force`. Each written row is `enabled=1`
 * with a UTC `next_run_at` from `computeNextRunAtUtc`. Returns one result per
 * planned job. Pure w.r.t. the store interface, so the M4 test drives it with
 * `JobsStoreService.Memory`.
 */
export const applyPlan = (
  store: JobsStoreApi,
  jobs: ReadonlyArray<PlannedJob>,
  opts: { readonly force: boolean; readonly now: number },
): Effect.Effect<ReadonlyArray<ApplyResult>, JobsStoreError | Error> =>
  Effect.gen(function* () {
    const results: ApplyResult[] = []
    for (const job of jobs) {
      const existing = yield* store.getById(job.id)
      const nextRunAt = computeNextRunAtUtc(job.cron, opts.now)
      if (nextRunAt === null) {
        return yield* Effect.fail(
          new Error(
            `failed to parse cron "${job.cron}" for job '${job.id}'`,
          ),
        )
      }

      if (existing && !opts.force) {
        results.push({
          id: job.id,
          outcome: "skipped",
          nextRunAt: existing.nextRunAt ?? nextRunAt,
        })
        continue
      }
      if (existing && opts.force) {
        yield* store.remove(job.id)
      }

      yield* store.record({
        id: job.id,
        kind: job.kind,
        spec: job.cron,
        payload: job.payload,
      })
      yield* store.setV2Fields(job.id, {
        schedule: job.cron,
        enabled: true,
        nextRunAt,
      })
      results.push({
        id: job.id,
        outcome: existing ? "replaced" : "installed",
        nextRunAt,
      })
    }
    return results
  })

/**
 * Remove the dream row + every wake row (matched by kind OR id prefix, so
 * workspaces dropped from luna.db since install are still cleaned up). Returns
 * the count removed.
 */
export const uninstallPlan = (
  store: JobsStoreApi,
  cfg: { readonly dreamJobId: string; readonly wakeJobPrefix: string },
  opts: { readonly skipDream?: boolean; readonly skipWake?: boolean } = {},
): Effect.Effect<number, JobsStoreError> =>
  Effect.gen(function* () {
    let removed = 0
    if (!opts.skipDream) {
      if (yield* store.remove(cfg.dreamJobId)) removed++
    }
    if (!opts.skipWake) {
      const all = yield* store.listAll()
      for (const row of all) {
        if (row.kind === "wake" || row.id.startsWith(`${cfg.wakeJobPrefix}-`)) {
          if (yield* store.remove(row.id)) removed++
        }
      }
    }
    return removed
  })
