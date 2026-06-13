/**
 * WorkerRegistry — the Phase-12b scheduler's worker dispatch table.
 *
 * The JobTicker reads `jobs` rows whose `next_run_at` has elapsed, atomically
 * claims them, then dispatches the row's payload to a worker registered
 * under the row's `kind`. The registry IS the kind discriminant — no Effect
 * codepath knows about specific job kinds. New worker kinds compose via
 * `Layer.mergeAll`; tests stub workers by composing an alternative layer.
 *
 * Contract (DESIGN.md §5.3.3):
 *   Worker<R> = (payload, ctx) => Effect.Effect<WorkerResult, WorkerError, R>
 *
 *   register(kind, worker) — record/replace the worker for `kind`.
 *   dispatch(kind, payload, ctx) — look up + invoke; fail
 *     `WorkerError({_tag:"unknown_kind"})` if no worker registered.
 *
 * Lifetime:
 *   - The registry itself is a single Ref<Map<string, Worker>> per Layer scope.
 *   - Workers' own scope is inherited from the caller (the JobTicker forks each
 *     dispatch into its own sub-Scope so a panicking worker can't kill the
 *     ticker fiber).
 *
 * Why not Tag-per-kind? The kind set is data-driven (new rows can introduce
 * new kinds at runtime, especially once `workflow` payloads embed `prompt`
 * sub-steps). A Map dispatched by string keeps that surface flat.
 */
import { Data, Effect, Layer, Ref } from "effect"

// ── Public types ────────────────────────────────────────────────────────────

/**
 * Per-dispatch metadata: id correlation, attempt counter, deadline guard.
 * Workers SHOULD honour `deadline` for graceful cleanup, but the JobTicker now
 * ENFORCES it: a dispatch that overruns `deadline` is interrupted and closed as
 * a `deadline_passed` failure, so a stuck worker can't block the ticker.
 */
export interface WorkerContext {
  readonly jobId: string
  readonly runId: number
  readonly attempt: number
  /** Hard deadline in epoch-ms — the ticker interrupts the worker past it. */
  readonly deadline: number
}

/**
 * Worker output. `outputText` lands in `job_runs.output_text`; `stepsJson`
 * is reserved for `kind="workflow"` (per-step status array as JSON).
 */
export interface WorkerResult {
  readonly outputText: string | null
  readonly stepsJson?: string
}

/**
 * Worker — the function dispatched per claimed job. R is the worker's own
 * service requirement set (e.g. SDKClient for the `prompt` worker).
 *
 * Errors are surfaced as the typed `WorkerError` channel; defects (uncaught
 * throws) are converted by the ticker into a `WorkerError({_tag:"defect"})`
 * before writing the `job_runs` row.
 */
export type Worker<R = never> = (
  payload: unknown,
  ctx: WorkerContext,
) => Effect.Effect<WorkerResult, WorkerError, R>

export class WorkerError extends Data.TaggedError("WorkerError")<{
  readonly reason:
    | "unknown_kind"
    | "bad_payload"
    | "worker_failed"
    | "deadline_passed"
    | "defect"
  readonly kind?: string
  readonly message: string
  readonly cause?: unknown
  /**
   * Partial output the worker assembled before failing. Workflow workers
   * pass their `steps_json` here on halt so the ticker can persist the
   * per-step audit trail into `job_runs.steps_json` even on failure.
   * Other worker kinds may leave this undefined.
   */
  readonly stepsJson?: string
}> {}

export interface WorkerRegistryApi {
  /**
   * Register (or replace) the worker for `kind`. Returns the previous
   * worker if any existed under that key.
   */
  readonly register: (
    kind: string,
    worker: Worker<never>,
  ) => Effect.Effect<Worker<never> | null>

  /** Snapshot of registered kinds (sorted for determinism in tests). */
  readonly listKinds: Effect.Effect<ReadonlyArray<string>>

  /**
   * Look up the worker for `kind`. Returns null when unregistered (the
   * ticker maps that to `WorkerError({_tag:"unknown_kind"})`).
   */
  readonly lookup: (
    kind: string,
  ) => Effect.Effect<Worker<never> | null>

  /**
   * Look up + invoke. Convenience for the ticker. If `kind` is unregistered,
   * fails with `WorkerError({_tag:"unknown_kind"})`.
   */
  readonly dispatch: (
    kind: string,
    payload: unknown,
    ctx: WorkerContext,
  ) => Effect.Effect<WorkerResult, WorkerError>
}

// ── Tag + Layer ─────────────────────────────────────────────────────────────

export class WorkerRegistry extends Effect.Tag("luna/WorkerRegistry")<
  WorkerRegistry,
  WorkerRegistryApi
>() {
  /**
   * Empty registry. Tests or chat-server boot composes additional Layers
   * that call `WorkerRegistry.register(kind, worker)` at construction time
   * (see `WorkerRegistry.withWorker` below) to populate it.
   */
  static Default: Layer.Layer<WorkerRegistry> = Layer.effect(
    WorkerRegistry,
    Effect.gen(function* () {
      const ref = yield* Ref.make<Map<string, Worker<never>>>(new Map())

      const register: WorkerRegistryApi["register"] = (kind, worker) =>
        Effect.gen(function* () {
          const before = yield* Ref.get(ref).pipe(
            Effect.map((m) => m.get(kind) ?? null),
          )
          yield* Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(kind, worker)
            return next
          })
          return before
        })

      const listKinds: WorkerRegistryApi["listKinds"] = Effect.gen(
        function* () {
          const m = yield* Ref.get(ref)
          return Array.from(m.keys()).sort()
        },
      )

      const lookup: WorkerRegistryApi["lookup"] = (kind) =>
        Effect.gen(function* () {
          const m = yield* Ref.get(ref)
          return m.get(kind) ?? null
        })

      const dispatch: WorkerRegistryApi["dispatch"] = (kind, payload, ctx) =>
        Effect.gen(function* () {
          const worker = yield* lookup(kind)
          if (!worker) {
            return yield* Effect.fail(
              new WorkerError({
                reason: "unknown_kind",
                kind,
                message: `no worker registered for kind "${kind}"`,
              }),
            )
          }
          return yield* worker(payload, ctx)
        })

      return {
        register,
        listKinds,
        lookup,
        dispatch,
      } satisfies WorkerRegistryApi
    }),
  )
}

/**
 * Make a WorkerRegistry layer seeded with an initial worker map. Use this at
 * boot to pre-register kinds without a follow-on Effect:
 *
 *   const workersL = makeWorkerRegistry({
 *     prompt:   promptWorker,
 *     workflow: workflowWorker,
 *   })
 *
 * Tests can either compose this with stub workers, OR start from
 * `WorkerRegistry.Default` (empty) and call `register()` at runtime to
 * exercise the dynamic-register path.
 */
export const makeWorkerRegistry = (
  initial: Record<string, Worker<never>>,
): Layer.Layer<WorkerRegistry> =>
  Layer.effect(
    WorkerRegistry,
    Effect.gen(function* () {
      const ref = yield* Ref.make<Map<string, Worker<never>>>(
        new Map(Object.entries(initial)),
      )

      const register: WorkerRegistryApi["register"] = (kind, worker) =>
        Effect.gen(function* () {
          const before = yield* Ref.get(ref).pipe(
            Effect.map((m) => m.get(kind) ?? null),
          )
          yield* Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(kind, worker)
            return next
          })
          return before
        })

      const listKinds: WorkerRegistryApi["listKinds"] = Effect.gen(function* () {
        const m = yield* Ref.get(ref)
        return Array.from(m.keys()).sort()
      })

      const lookup: WorkerRegistryApi["lookup"] = (kind) =>
        Effect.gen(function* () {
          const m = yield* Ref.get(ref)
          return m.get(kind) ?? null
        })

      const dispatch: WorkerRegistryApi["dispatch"] = (kind, payload, ctx) =>
        Effect.gen(function* () {
          const worker = yield* lookup(kind)
          if (!worker) {
            return yield* Effect.fail(
              new WorkerError({
                reason: "unknown_kind",
                kind,
                message: `no worker registered for kind "${kind}"`,
              }),
            )
          }
          return yield* worker(payload, ctx)
        })

      return {
        register,
        listKinds,
        lookup,
        dispatch,
      } satisfies WorkerRegistryApi
    }),
  )
