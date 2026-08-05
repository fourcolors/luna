/**
 * dream-wake-install — install (or update) the V2 `dream` + `wake` job rows.
 *
 * M4 of the scheduler-v2 dream/wake migration (DESIGN.md §5.3.5). MIGRATES the
 * nightly dream cycle and the per-workspace wake cycle off the legacy
 * fiber-per-cron model (`buildDreamCronLayer` / `buildWakeCronLayer` in
 * chat-server.ts) onto durable `jobs` rows the Phase-12b JobTicker drains and
 * dispatches to the dedicated `dream` / `wake` worker kinds
 * (packages/core/src/{dream,wake}/*-worker.ts, M1-M3).
 *
 * What it writes (all the WHAT/HOW logic lives in dream-wake-install-lib.ts so
 * it stays unit-testable; this file is just the env/argv + SQLite-store shell):
 *   - ONE `kind="dream"` row. Nightly cron, REUSING dream's existing boot
 *     schedule ("0 3 * * *" — buildDreamCronLayer's call site). The dream worker
 *     ignores its payload (the cycle reads its window from the watermark), so
 *     the payload carries provenance metadata only.
 *   - ONE `kind="wake"` row PER wake-enabled workspace. "Wake-enabled" = an
 *     `active` row in luna.db's `workspaces` table (the SAME set the boot-time
 *     workspaces-loader enumerates); LUNA_WAKE_ENABLED="0" disables the whole
 *     set, mirroring the legacy boot gate. Each row carries
 *     `{ workspaceSlug, workspacePath }` (REQUIRED — the wake worker is
 *     per-workspace). When luna.db has no active workspaces (fresh box / test),
 *     it falls back to the SAME single workspace the legacy boot wakes
 *     (LUNA_WAKE_WORKSPACE_SLUG / LUNA_WAKE_WORKSPACE_PATH, default "luna").
 *
 * Each row is `enabled=1` with a UTC `next_run_at` from the shared effect/Cron
 * helper (forced UTC so the row is portable across the install host's TZ).
 *
 * IDEMPOTENT: re-running without --force is a no-op for any row that already
 * exists (skip-if-exists by stable id). The dream row id is LUNA_DREAM_JOB_ID
 * (default "dream-luna"); each wake row id is `${LUNA_WAKE_JOB_PREFIX}-${slug}`
 * (default prefix "wake"), so re-running after adding a workspace installs only
 * the new wake row.
 *
 * REQUIRES the V2 scheduler stack. The JobTicker (the only scheduler) drains
 * these rows automatically once installed — dream/wake run exclusively as these
 * job rows (the legacy cron layers were removed).
 *
 * Usage:
 *   bun run apps/server/scripts/dream-wake-install.ts
 *   bun run apps/server/scripts/dream-wake-install.ts --force        # replace existing rows
 *   bun run apps/server/scripts/dream-wake-install.ts --uninstall    # remove dream + all wake rows
 *   bun run apps/server/scripts/dream-wake-install.ts --dream-only   # skip wake rows
 *   bun run apps/server/scripts/dream-wake-install.ts --wake-only    # skip dream row
 *
 * Env honoured:
 *   LUNA_DB_PATH / LUNA_HOME    — same resolution as chat-server.ts
 *   LUNA_DREAM_JOB_ID           — dream row id. Default "dream-luna".
 *   LUNA_DREAM_CRON             — dream cron (server UTC). Default "0 3 * * *".
 *   LUNA_WAKE_JOB_PREFIX        — wake row id prefix. Default "wake".
 *   LUNA_WAKE_CRON_EXPR         — wake cron (server UTC). Default "*\/30 * * * *".
 *   LUNA_WAKE_ENABLED           — "0" suppresses ALL wake rows (global gate).
 *   LUNA_WAKE_WORKSPACE_SLUG    — fallback wake workspace slug. Default "luna".
 *   LUNA_WAKE_WORKSPACE_PATH    — fallback wake workspace path. Falls back to
 *                                 LUNA_REPO_ROOT then process.cwd().
 */
import { Effect, Layer, ManagedRuntime } from "effect"
import { Clock, JobsStoreService } from "@luna/core"
import { LunaSqliteBootstrapLive } from "@luna/memory"
import { resolveRuntimePaths } from "../src/runtime-paths.js"
import {
  applyPlan,
  listActiveWorkspaces,
  planJobs,
  uninstallPlan,
  type ActiveWorkspace,
} from "./dream-wake-install-lib.js"

const paths = resolveRuntimePaths()
console.log("[dream-wake-install] db paths:", { lunaDbPath: paths.lunaDbPath })

const args = new Set(process.argv.slice(2))
const FORCE = args.has("--force")
const UNINSTALL = args.has("--uninstall")
const DREAM_ONLY = args.has("--dream-only")
const WAKE_ONLY = args.has("--wake-only")

const DREAM_JOB_ID = process.env["LUNA_DREAM_JOB_ID"]?.trim() || "dream-luna"
const DREAM_CRON = process.env["LUNA_DREAM_CRON"]?.trim() || "0 3 * * *"
const WAKE_JOB_PREFIX = process.env["LUNA_WAKE_JOB_PREFIX"]?.trim() || "wake"
const WAKE_CRON = process.env["LUNA_WAKE_CRON_EXPR"]?.trim() || "*/30 * * * *"
const WAKE_ENABLED = process.env["LUNA_WAKE_ENABLED"]?.trim() !== "0"
const WAKE_FALLBACK_SLUG =
  process.env["LUNA_WAKE_WORKSPACE_SLUG"]?.trim() || "luna"
const WAKE_FALLBACK_PATH =
  process.env["LUNA_WAKE_WORKSPACE_PATH"]?.trim() ||
  process.env["LUNA_REPO_ROOT"]?.trim() ||
  process.cwd()

const jobsStoreL = JobsStoreService.makeLayer(paths.lunaDbPath).pipe(
  Layer.provide(Clock.Default),
  Layer.provide(LunaSqliteBootstrapLive),
)

// Resolve the wake workspace set: every active workspace, or the single
// env-configured fallback when luna.db has none (fresh box). The global
// LUNA_WAKE_ENABLED=0 switch is applied as skipWake below.
const resolveWakeWorkspaces = (): ReadonlyArray<ActiveWorkspace> => {
  const active = listActiveWorkspaces(paths.lunaDbPath)
  if (active.length > 0) return active
  console.log(
    `[dream-wake-install] no active workspaces in luna.db — falling back to single '${WAKE_FALLBACK_SLUG}' (${WAKE_FALLBACK_PATH})`,
  )
  return [{ slug: WAKE_FALLBACK_SLUG, path: WAKE_FALLBACK_PATH }]
}

const program = Effect.gen(function* () {
  const store = yield* JobsStoreService

  if (UNINSTALL) {
    const removed = yield* uninstallPlan(
      store,
      { dreamJobId: DREAM_JOB_ID, wakeJobPrefix: WAKE_JOB_PREFIX },
      { skipDream: WAKE_ONLY, skipWake: DREAM_ONLY },
    )
    console.log(`[dream-wake-install] uninstall complete (removed=${removed})`)
    return
  }

  const skipWake = DREAM_ONLY || !WAKE_ENABLED
  if (!WAKE_ENABLED && !DREAM_ONLY) {
    console.log("[dream-wake-install] LUNA_WAKE_ENABLED=0 — skipping ALL wake rows")
  }

  const jobs = planJobs({
    dreamJobId: DREAM_JOB_ID,
    dreamCron: DREAM_CRON,
    wakeJobPrefix: WAKE_JOB_PREFIX,
    wakeCron: WAKE_CRON,
    wakeWorkspaces: skipWake ? [] : resolveWakeWorkspaces(),
    skipDream: WAKE_ONLY,
    skipWake,
  })

  const results = yield* applyPlan(store, jobs, { force: FORCE, now: Date.now() })
  for (const r of results) {
    console.log(
      `[dream-wake-install] ${r.outcome.padEnd(9)} '${r.id}' next_run_at=${new Date(
        r.nextRunAt,
      ).toISOString()}`,
    )
  }
  console.log(
    `[dream-wake-install] done: ${results.filter((r) => r.outcome !== "skipped").length} written, ${results.filter((r) => r.outcome === "skipped").length} skipped`,
  )
})

const rt = ManagedRuntime.make(jobsStoreL)
rt.runPromiseExit(program)
  .then(async (exit) => {
    await rt.dispose()
    if (exit._tag === "Failure") {
      console.error("[dream-wake-install] FAILED:", exit.cause)
      process.exit(1)
    }
    console.log("[dream-wake-install] complete.")
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error("[dream-wake-install] FATAL:", err)
    process.exit(1)
  })
