/**
 * DreamWorker — the V2 JobTicker worker kind for the nightly dream cycle.
 *
 * Background (scheduler-v2 dream/wake migration): the generic `prompt` /
 * `workflow` workers are typed `Worker<never>` and close over only
 * `SDKClient` + `AgentNotesService` (prompt-worker.ts). They cannot carry the
 * dream cycle, which requires `DreamStore | DreamReasoner | SessionStore |
 * MemoryRouter | Clock` (+ an OPTIONAL `CalibrationStore`). So dream gets its
 * OWN worker kind — exactly mirroring how `PromptWorkerLayer` resolves real
 * services at boot and registers a closed-over `Worker<never>`.
 *
 * The dream LOGIC is reused wholesale: the worker simply runs `runDream(now)`
 * (the same effect the legacy `registerDreamCron` cron fired). Only the
 * registration/dispatch wrapper is new. `now` is read from the captured `Clock`
 * service so the worker is deterministic in tests and shares the boot clock
 * identity (the watermark's crash-recovery determinism depends on a single
 * clock — see runDream's idempotency notes).
 *
 * CalibrationStore is preserved as an OPTIONAL dependency: read via
 * `Effect.serviceOption` (same pattern PromptWorkerLayer uses for JobRunTools)
 * and, when present, folded into the captured context so `applyOps`' calibration
 * instrumentation keeps writing ECE rows. Absent → applyOps logs its existing
 * "CalibrationStore not provided" warning and the dream turn is unaffected.
 */
import { Context, Effect, Layer, Option } from "effect"
import type { MemoryRouter } from "@luna/memory"
import { Clock } from "../clock.js"
import { CalibrationStore } from "../alignment/calibration-store.js"
import { SessionStore } from "../session/session-store.js"
import {
  WorkerError,
  WorkerRegistry,
  type Worker,
  type WorkerResult,
} from "../jobs/worker-registry.js"
import { DreamStore } from "./dream-store.js"
import { DreamReasoner } from "./reasoner.js"
import { runDream } from "./dream.js"

/** The registry discriminant for the dream worker. */
export const DREAM_WORKER_KIND = "dream"

// job-ticker-oban-deadlines (Seam 2 boot wiring) — the whole-dispatch ceiling
// registered with the WorkerRegistry (see DreamWorkerLayer below). This is
// DISTINCT from `LUNA_DREAM_TIMEOUT_MS` (dream-reasoner.ts's per-SDK-call
// inner ceiling, default 10 min): a dream cycle draining a multi-day backlog
// legitimately spans MANY inner calls, so the outer registered default is
// wider (15 min) — and still just the "well-behaved" ceiling; the ticker's
// `grace` window on top of it is the true last-resort backstop, and a large
// backlog hitting THAT is the expected, retry-recoverable terminal (Seam 3).
// Overridable via env so operators can widen it without a redeploy.
const DEFAULT_DREAM_WORKER_TIMEOUT_MS = 15 * 60 * 1000 // 15 min
const dreamWorkerDefaultTimeoutMs = (): number => {
  const raw = process.env["LUNA_DREAM_WORKER_TIMEOUT_MS"]?.trim()
  if (!raw) return DEFAULT_DREAM_WORKER_TIMEOUT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_DREAM_WORKER_TIMEOUT_MS
}

/** The (non-optional) dream service environment a dream cycle requires. */
type DreamCtx = DreamStore | DreamReasoner | SessionStore | MemoryRouter | Clock

export interface DreamWorkerLayerOptions {
  /** Override the kind discriminant. Default "dream". */
  readonly kind?: string
}

/**
 * Build a `Worker<never>` that runs one dream cycle against `ctx` — the dream
 * service environment captured at layer-build time. The captured context erases
 * the worker's R to `never` (via `Effect.provide`), satisfying the registry's
 * `Worker<never>` contract. `ctx` may additionally carry a `CalibrationStore`
 * (folded in by `DreamWorkerLayer`); providing a wider context is harmless.
 *
 * The dream `payload` is intentionally ignored — a dream cycle reads its window
 * from the watermark + SessionStore, not from the job row. The payload column
 * stays available for future tuning without changing this contract.
 */
export const buildDreamWorker = (
  ctx: Context.Context<DreamCtx>,
): Worker<never> => {
  return (_payload, jobCtx) =>
    Effect.gen(function* () {
      const clock = yield* Clock
      const now = yield* clock.nowMs()
      // Thread the ticker's hard deadline into runDream's deadline-aware stop so
      // a long night stops CLEANLY between chunks instead of being interrupted
      // mid-chunk. `deadline` is epoch-ms; 0 (or any non-positive value) is the
      // generic WorkerContext "no deadline" sentinel, mapped to null so the
      // chunk gate never trips on it.
      const deadlineAt = jobCtx.deadline > 0 ? jobCtx.deadline : null
      const summary = yield* runDream(now, { deadlineAt })
      // Surface the RunDreamSummary in outputText (→ job_runs.output_text) so a
      // deadline-truncated cycle is visible without reading dream_audit.
      return {
        outputText:
          `dream cycle complete; chunks=${summary.chunksProcessed}; ` +
          `sessions=${summary.sessionsProcessed}; stoppedEarly=${summary.stoppedEarly}; ` +
          `watermark=${summary.watermark}`,
      } satisfies WorkerResult
    }).pipe(
      Effect.provide(ctx),
      // Map any typed dream failure to a WorkerError so the ticker records a
      // clean `job_runs` row. Defects propagate untouched — the ticker converts
      // them to WorkerError({reason:"defect"}) itself.
      Effect.catchAll((e) =>
        Effect.fail(
          new WorkerError({
            reason: "worker_failed",
            kind: DREAM_WORKER_KIND,
            message: `dream worker failed: ${(e as { message?: string }).message ?? String(e)}`,
            cause: e,
          }),
        ),
      ),
    )
}

/**
 * Layer that registers the dream worker into the WorkerRegistry at boot.
 * Requires the dream service environment + WorkerRegistry; reads an OPTIONAL
 * CalibrationStore via serviceOption (so the layer's R does not grow and
 * compositions without it — tests, smokes — keep working).
 *
 *   const dreamWorkerL = DreamWorkerLayer().pipe(
 *     Layer.provide(Layer.mergeAll(
 *       dreamStoreL, dreamReasonerL, sessionStoreL, memoryRouterL, clockL,
 *       workerRegistryL, calibrationStoreL /* optional *\/,
 *     )),
 *   )
 */
export const DreamWorkerLayer = (
  opts?: DreamWorkerLayerOptions,
): Layer.Layer<
  never,
  never,
  DreamStore | DreamReasoner | SessionStore | MemoryRouter | Clock | WorkerRegistry
> => {
  const kind = opts?.kind ?? DREAM_WORKER_KIND
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const base = yield* Effect.context<DreamCtx>()
      // Preserve calibration instrumentation when the sink is wired (advisor
      // change 3). serviceOption keeps CalibrationStore OUT of the layer's R.
      const calOpt = yield* Effect.serviceOption(CalibrationStore)
      // Fold the optional CalibrationStore into the captured context so
      // applyOps' serviceOption(CalibrationStore) resolves it at dispatch time.
      // The cast narrows the (wider) Context<DreamCtx | CalibrationStore> back
      // to the worker's declared input — safe: a superset context only ever
      // satisfies MORE requirements.
      const ctx = Option.isSome(calOpt)
        ? (Context.add(base, CalibrationStore, calOpt.value) as Context.Context<DreamCtx>)
        : base
      const worker = buildDreamWorker(ctx)
      yield* reg.register(kind, {
        run: worker,
        defaultTimeoutMs: dreamWorkerDefaultTimeoutMs(),
      })
    }),
  )
}
