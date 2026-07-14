/**
 * WakeWorker — the V2 JobTicker worker kind for the every-30-minute wake cycle.
 *
 * Background (scheduler-v2 dream/wake migration): the generic `prompt` /
 * `workflow` workers are typed `Worker<never>` and close over only
 * `SDKClient` + `AgentNotesService` (prompt-worker.ts). They cannot carry the
 * wake cycle, which requires `WakeReasoner | WakeLogStore | AgentNotesService`.
 * So wake gets its OWN worker kind — exactly mirroring how `DreamWorkerLayer`
 * (dream-worker.ts) resolves real services at boot and registers a closed-over
 * `Worker<never>`.
 *
 * The wake LOGIC is reused wholesale: the worker simply runs
 * `runWake(now, opts)` (the same effect the legacy `registerWakeCron` cron
 * fired). Only the registration/dispatch wrapper is new. `now` is read from the
 * captured `Clock` service so the worker is deterministic in tests and shares
 * the boot clock identity.
 *
 * DIFFERENCE FROM DREAM — wake is PER-WORKSPACE. A dream cycle reads its window
 * from the watermark and ignores the job payload; a wake cycle, by contrast, is
 * scoped to ONE workspace, so the job row's `payload` MUST carry
 * `{ workspaceSlug, workspacePath }`. The install script writes one `wake` job
 * row per wake-enabled workspace, each with its own payload (M4). The worker
 * parses that payload defensively up front: a payload missing either field is a
 * typed `WorkerError({reason:"bad_payload"})` — a clean `job_runs` row, not a
 * defect and not a silent no-op that would hide a misconfigured row.
 *
 * runWake itself never fails (its E channel is `never` — any read/reason error
 * short-circuits to a wake_log row with outcome='error'), so once the payload
 * parses, the worker's only failure surface is the payload guard.
 */
import { Context, Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { AgentNotesService } from "../agent-notes/agent-notes.js"
import {
  WorkerError,
  WorkerRegistry,
  type Worker,
  type WorkerResult,
} from "../jobs/worker-registry.js"
import { WakeReasoner } from "./reasoner.js"
import { WakeLogStore } from "./wake-log-store.js"
import { runWake } from "./wake.js"
import type { WakeCronOptions } from "./wake.js"

/** The registry discriminant for the wake worker. */
export const WAKE_WORKER_KIND = "wake"

/**
 * Default outer JobTicker backstop for wake (matches wake-reasoner's inner
 * DEFAULT_QUERY_TIMEOUT_MS of 10 min). Overridable via LUNA_WAKE_TIMEOUT_MS.
 * Registered as defaultTimeoutMs so the ticker applies grace (not the bare
 * 5-min workerDeadline) — fixes the outer/inner timeout inversion.
 */
export const resolveWakeDefaultTimeoutMs = (): number => {
  const raw = process.env["LUNA_WAKE_TIMEOUT_MS"]?.trim()
  const n = raw ? Number(raw) : 10 * 60 * 1000
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 10 * 60 * 1000
}

/** The wake service environment a wake cycle requires (+ Clock for `now`). */
type WakeCtx = WakeReasoner | WakeLogStore | AgentNotesService | Clock

export interface WakeWorkerLayerOptions {
  /** Override the kind discriminant. Default "wake". */
  readonly kind?: string
}

/**
 * Defensively parse a wake job payload into WakeCronOptions. Wake is
 * per-workspace, so the row MUST carry non-empty `workspaceSlug` +
 * `workspacePath` strings. Returns the parsed opts on success, or a
 * descriptive reason string on failure (the worker maps that to a
 * `bad_payload` WorkerError).
 *
 * Accepts both camelCase (`workspaceSlug`/`workspacePath`) and the snake_case
 * (`workspace_slug`/`workspace_path`) a hand-written `jobs` row might use, so a
 * minor install-script discrepancy doesn't silently no-op the wake.
 */
export const parseWakePayload = (
  payload: unknown,
): { ok: true; opts: WakeCronOptions } | { ok: false; reason: string } => {
  if (payload === null || typeof payload !== "object") {
    return {
      ok: false,
      reason: `wake payload must be an object with workspaceSlug + workspacePath (got ${payload === null ? "null" : typeof payload})`,
    }
  }
  const p = payload as Record<string, unknown>
  const slugRaw = p["workspaceSlug"] ?? p["workspace_slug"]
  const pathRaw = p["workspacePath"] ?? p["workspace_path"]
  const slug = typeof slugRaw === "string" ? slugRaw.trim() : ""
  const path = typeof pathRaw === "string" ? pathRaw.trim() : ""
  if (slug.length === 0) {
    return { ok: false, reason: "wake payload missing non-empty workspaceSlug" }
  }
  if (path.length === 0) {
    return { ok: false, reason: "wake payload missing non-empty workspacePath" }
  }
  return { ok: true, opts: { workspaceSlug: slug, workspacePath: path } }
}

/**
 * Build a `Worker<never>` that runs one wake cycle against `ctx` — the wake
 * service environment captured at layer-build time. The captured context erases
 * the worker's R to `never` (via `Effect.provide`), satisfying the registry's
 * `Worker<never>` contract.
 *
 * The wake `payload` is REQUIRED (unlike dream): it scopes the cycle to one
 * workspace. A malformed payload fails fast with a `bad_payload` WorkerError
 * before any reasoning / disk I/O.
 */
export const buildWakeWorker = (
  ctx: Context.Context<WakeCtx>,
  kind: string,
): Worker<never> => {
  return (payload, _jobCtx) =>
    Effect.gen(function* () {
      const parsed = parseWakePayload(payload)
      if (!parsed.ok) {
        return yield* Effect.fail(
          new WorkerError({
            reason: "bad_payload",
            kind,
            message: `wake worker: ${parsed.reason}`,
          }),
        )
      }
      const clock = yield* Clock
      const now = yield* clock.nowMs()
      yield* runWake(now, parsed.opts)
      return {
        outputText: `wake cycle complete; workspace=${parsed.opts.workspaceSlug}`,
      } satisfies WorkerResult
    }).pipe(
      Effect.provide(ctx),
      // runWake's E is `never`, so the only typed failure is the payload guard
      // above (already a WorkerError). Map any residual typed failure to a
      // WorkerError so the ticker records a clean `job_runs` row; defects
      // propagate untouched — the ticker converts them to
      // WorkerError({reason:"defect"}) itself.
      Effect.catchAll((e) =>
        e instanceof WorkerError
          ? Effect.fail(e)
          : Effect.fail(
              new WorkerError({
                reason: "worker_failed",
                kind,
                message: `wake worker failed: ${(e as { message?: string }).message ?? String(e)}`,
                cause: e,
              }),
            ),
      ),
    )
}

/**
 * Layer that registers the wake worker into the WorkerRegistry at boot.
 * Requires the wake service environment + Clock + WorkerRegistry.
 *
 *   const wakeWorkerL = WakeWorkerLayer().pipe(
 *     Layer.provide(Layer.mergeAll(
 *       wakeReasonerL, wakeLogStoreL, agentNotesL, clockL, workerRegistryL,
 *     )),
 *   )
 */
export const WakeWorkerLayer = (
  opts?: WakeWorkerLayerOptions,
): Layer.Layer<
  never,
  never,
  WakeReasoner | WakeLogStore | AgentNotesService | Clock | WorkerRegistry
> => {
  const kind = opts?.kind ?? WAKE_WORKER_KIND
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const ctx = yield* Effect.context<WakeCtx>()
      const worker = buildWakeWorker(ctx, kind)
      // A2: register with defaultTimeoutMs so JobTicker outer backstop is
      // ~10m+grace, not the bare 5m workerDeadline (wake-reasoner inner is 10m).
      yield* reg.register(kind, {
        run: worker,
        defaultTimeoutMs: resolveWakeDefaultTimeoutMs(),
      })
    }),
  )
}
