/**
 * defineWorkerLayer — the shared JobTicker worker-registration wrapper
 * (luna-next Stack 2, slice 9a).
 *
 * DreamWorkerLayer and WakeWorkerLayer grew as mirrored copies of the same
 * boot ceremony: capture the worker's service context at layer-build time,
 * build a `Worker<never>` by erasing R via `Effect.provide(ctx)`, map typed
 * failures to WorkerError so the ticker records a clean `job_runs` row,
 * resolve an env-overridable per-kind timeout, and `reg.register(kind, ...)`.
 * This module is that ceremony written once. Everything genuinely per-worker
 * stays in the worker file as one of three plug points:
 *
 *   - `run` — the cycle itself, including payload handling (dream ignores its
 *     payload; wake defensively parses `{workspaceSlug, workspacePath}`) and
 *     deadline threading (dream forwards `jobCtx.deadline` into runDream).
 *   - `defaultTimeoutMs` — a thunk, re-read at registration so env overrides
 *     (LUNA_DREAM_WORKER_TIMEOUT_MS / LUNA_WAKE_TIMEOUT_MS) keep working.
 *   - `augmentContext` — boot-time folding of OPTIONAL services read via
 *     `Effect.serviceOption` into the captured context WITHOUT growing the
 *     layer's R (dream's CalibrationStore / SuggestedActions / SkillRegistry).
 *
 * Dream/wake unification stops HERE (Operator adjudication, 2026-08): the
 * runtimes beneath these wrappers diverge on cardinality, storage home,
 * watermark vs stateless progress, DreamOp[] vs WakeDigest output, and
 * propagate-vs-swallow error policy — see DESIGN.md §5.3.6. If this helper
 * ever needs per-worker branching beyond the three plug points above, the
 * abstraction is wrong: stop and split the worker files again.
 */
import { Context, Effect, Layer } from "effect"
import {
  WorkerError,
  WorkerRegistry,
  type Worker,
  type WorkerContext,
  type WorkerResult,
} from "./worker-registry.js"

/**
 * Env-overridable per-kind timeout: trim → Number → finite-positive guard →
 * default (the idiom both worker files carried verbatim).
 */
export const resolveEnvTimeoutMs = (
  envVar: string,
  defaultMs: number,
): number => {
  const raw = process.env[envVar]?.trim()
  if (!raw) return defaultMs
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : defaultMs
}

export interface WorkerKindSpec<Ctx> {
  /** Default registry discriminant (layer callers may override per instance). */
  readonly kind: string
  /** Per-kind ticker ceiling; a thunk so env overrides are re-read at boot. */
  readonly defaultTimeoutMs: () => number
  /**
   * One cycle. `kind` is the REGISTERED discriminant (override-aware) so
   * payload guards and failure messages name the right kind. A typed failure
   * that is already a WorkerError passes through; anything else is wrapped as
   * `worker_failed`. Defects propagate untouched — the ticker converts them
   * to WorkerError({reason:"defect"}) itself.
   */
  readonly run: (
    kind: string,
    payload: unknown,
    jobCtx: WorkerContext,
  ) => Effect.Effect<WorkerResult, unknown, Ctx>
  /**
   * Optional boot-time fold of `Effect.serviceOption`'d sinks into the
   * captured context. Runs inside the layer-build Effect, so it sees any
   * optional services the boot composition happened to provide.
   */
  readonly augmentContext?: (
    base: Context.Context<Ctx>,
  ) => Effect.Effect<Context.Context<Ctx>>
}

export interface WorkerLayerOptions {
  /** Override the kind discriminant (e.g. tests registering "dream_nightly"). */
  readonly kind?: string
}

/**
 * Build a `Worker<never>` from a spec + the service context captured at
 * layer-build time. The captured context erases the worker's R to `never`
 * (via `Effect.provide`), satisfying the registry's `Worker<never>` contract.
 */
export const buildWorker = <Ctx>(
  spec: WorkerKindSpec<Ctx>,
  ctx: Context.Context<Ctx>,
  kind: string,
): Worker<never> => {
  return (payload, jobCtx) =>
    spec.run(kind, payload, jobCtx).pipe(
      Effect.provide(ctx),
      Effect.catch((e) =>
        e instanceof WorkerError
          ? Effect.fail(e)
          : Effect.fail(
              new WorkerError({
                reason: "worker_failed",
                kind,
                message: `${kind} worker failed: ${(e as { message?: string }).message ?? String(e)}`,
                cause: e,
              }),
            ),
      ),
    )
}

/**
 * Layer factory that registers the spec'd worker into the WorkerRegistry at
 * boot. Returns the same call shape the hand-written layers had:
 *
 *   export const DreamWorkerLayer = defineWorkerLayer(dreamSpec)
 *   // ... later, at boot or in tests:
 *   DreamWorkerLayer()                    // registers under spec.kind
 *   DreamWorkerLayer({ kind: "custom" })  // override discriminant
 */
export const defineWorkerLayer =
  <Ctx>(spec: WorkerKindSpec<Ctx>) =>
  (
    opts?: WorkerLayerOptions,
  ): Layer.Layer<never, never, Ctx | WorkerRegistry> => {
    const kind = opts?.kind ?? spec.kind
    return Layer.effectDiscard(
      Effect.gen(function* () {
        const reg = yield* WorkerRegistry
        const base = yield* Effect.context<Ctx>()
        const ctx = spec.augmentContext
          ? yield* spec.augmentContext(base)
          : base
        yield* reg.register(kind, {
          run: buildWorker(spec, ctx, kind),
          defaultTimeoutMs: spec.defaultTimeoutMs(),
        })
      }),
    )
  }
