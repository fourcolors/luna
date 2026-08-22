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
 *   - The registry itself is a single Ref<Map<string, WorkerEntry>> per Layer
 *     scope. `register()` accepts either a bare `Worker` function or a
 *     `WorkerEntry` object (adds a per-kind `defaultTimeoutMs`) — see
 *     `WorkerEntry` below.
 *   - The JobTicker dispatches each worker bounded by
 *     `Effect.timeoutFail(...)` (per-kind `defaultTimeoutMs` + grace, or the
 *     ticker's global `workerDeadline` fallback) and wrapped in
 *     `Effect.catchDefect` so an overrun or a panicking worker is
 *     converted to a typed WorkerError and closed into job_runs — it cannot
 *     kill the ticker fiber. Since job-ticker-oban-deadlines, dispatches
 *     within a tick run with BOUNDED concurrency (`Effect.forEach(...,
 *     {concurrency: dispatchConcurrency})`), not strictly sequentially — the
 *     per-job Effect a worker runs inside is still wholly independent, so
 *     nothing here changes for a Worker implementation.
 *
 * Why not Tag-per-kind? The kind set is data-driven (new rows can introduce
 * new kinds at runtime, especially once `workflow` payloads embed `prompt`
 * sub-steps). A Map dispatched by string keeps that surface flat.
 */
import { Context, Data, Effect, Layer, Ref } from "effect"

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
  /**
   * issue #277 - deferred side effects (delivery sinks etc.) the ticker runs
   * AFTER the run is durably recorded as success - OUTSIDE the dispatch
   * backstop (`Effect.timeoutFail`), so a slow delivery can never turn a
   * completed turn into `deadline_passed` (the double-delivery race a
   * post-#275-retry review flagged: delivery run INSIDE the timed dispatch
   * could commit, then still lose the race to the backstop, discarding the
   * success value and letting a recurring job's retry re-run the whole turn
   * and re-deliver). Best-effort: failures (typed or defect) are logged,
   * never affect the run's terminal status, and are NOT retried - the worker
   * MUST collapse its own typed error channel to E=never before returning
   * this (the ticker's catchAll/catchAllDefect wrapping is runtime defense,
   * not a type escape hatch). The ticker also bounds it with its own
   * independent timeout (job-ticker.ts) - a worker cannot assume a delivery
   * sink is self-bounding (e.g. a chat-server WS post can still hang).
   */
  readonly postCommit?: Effect.Effect<void>
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

/**
 * job-ticker-oban-deadlines — a worker MAY register with its own per-kind
 * timeout ceiling instead of relying on the JobTicker's global
 * `workerDeadline`. `defaultTimeoutMs`, when present, becomes the
 * "effective" deadline the ticker builds its outer backstop from
 * (`effective + grace`, capped at `maxWorkerDeadline`) — giving a worker
 * with its OWN inner timeout (e.g. dream's per-chunk `LUNA_DREAM_TIMEOUT_MS`)
 * room to fail on its own typed WorkerError terms before the ticker's
 * `Effect.timeoutFail` fires as a true last-resort backstop. Leave it unset
 * for the back-compat path: the ticker's `workerDeadline` applies exactly as
 * it did before this option existed, with no grace added.
 */
export interface WorkerEntry<R = never> {
  readonly run: Worker<R>
  readonly defaultTimeoutMs?: number
}

/** Accepted at `register()` — a bare function is sugar for `{ run: fn }`. */
export type Registrable<R = never> = Worker<R> | WorkerEntry<R>

/**
 * Normalize the two accepted `register()` shapes into a `WorkerEntry`. A
 * bare function IS a `Worker` (an ordinary JS function), while the object
 * form is a plain object — `typeof` cleanly discriminates the two without
 * needing a tag. Shared by BOTH registry constructors below so `lookup` /
 * `lookupEntry` / `dispatch` agree no matter which one built the registry.
 */
const normalizeEntry = <R>(w: Registrable<R>): WorkerEntry<R> =>
  typeof w === "function" ? { run: w } : w

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
   * Register (or replace) the worker for `kind` — either a bare `Worker`
   * function (back-compat) or a `WorkerEntry` object that also carries a
   * per-kind `defaultTimeoutMs`. Returns the previous worker FUNCTION if any
   * existed under that key (never the wrapping entry — swap-tests compare
   * against the function they originally passed in).
   */
  readonly register: (
    kind: string,
    worker: Registrable<never>,
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
   * Look up the FULL registration entry (run fn + optional
   * `defaultTimeoutMs`) for `kind`. The JobTicker uses this instead of
   * `lookup` for its pre-screen so it can read `defaultTimeoutMs` when
   * computing the per-dispatch backstop deadline.
   */
  readonly lookupEntry: (
    kind: string,
  ) => Effect.Effect<WorkerEntry<never> | null>

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

export class WorkerRegistry extends Context.Service<WorkerRegistry, WorkerRegistryApi>()("luna/WorkerRegistry") {
  /**
   * Empty registry. Tests or chat-server boot composes additional Layers
   * that call `WorkerRegistry.register(kind, worker)` at construction time
   * (see `WorkerRegistry.withWorker` below) to populate it.
   */
  static Default: Layer.Layer<WorkerRegistry> = Layer.effect(
    WorkerRegistry,
    Effect.gen(function* () {
      const ref = yield* Ref.make<Map<string, WorkerEntry<never>>>(new Map())

      const register: WorkerRegistryApi["register"] = (kind, worker) =>
        Effect.gen(function* () {
          const entry = normalizeEntry(worker)
          const before = yield* Ref.get(ref).pipe(
            Effect.map((m) => m.get(kind) ?? null),
          )
          yield* Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(kind, entry)
            return next
          })
          return before?.run ?? null
        })

      const listKinds: WorkerRegistryApi["listKinds"] = Effect.gen(
        function* () {
          const m = yield* Ref.get(ref)
          return Array.from(m.keys()).sort()
        },
      )

      const lookupEntry: WorkerRegistryApi["lookupEntry"] = (kind) =>
        Effect.gen(function* () {
          const m = yield* Ref.get(ref)
          return m.get(kind) ?? null
        })

      const lookup: WorkerRegistryApi["lookup"] = (kind) =>
        lookupEntry(kind).pipe(Effect.map((entry) => entry?.run ?? null))

      const dispatch: WorkerRegistryApi["dispatch"] = (kind, payload, ctx) =>
        Effect.gen(function* () {
          const entry = yield* lookupEntry(kind)
          if (!entry) {
            return yield* Effect.fail(
              new WorkerError({
                reason: "unknown_kind",
                kind,
                message: `no worker registered for kind "${kind}"`,
              }),
            )
          }
          return yield* entry.run(payload, ctx)
        })

      return {
        register,
        listKinds,
        lookup,
        lookupEntry,
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
  initial: Record<string, Registrable<never>>,
): Layer.Layer<WorkerRegistry> =>
  Layer.effect(
    WorkerRegistry,
    Effect.gen(function* () {
      const ref = yield* Ref.make<Map<string, WorkerEntry<never>>>(
        new Map(
          Object.entries(initial).map(([kind, w]) => [kind, normalizeEntry(w)]),
        ),
      )

      const register: WorkerRegistryApi["register"] = (kind, worker) =>
        Effect.gen(function* () {
          const entry = normalizeEntry(worker)
          const before = yield* Ref.get(ref).pipe(
            Effect.map((m) => m.get(kind) ?? null),
          )
          yield* Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(kind, entry)
            return next
          })
          return before?.run ?? null
        })

      const listKinds: WorkerRegistryApi["listKinds"] = Effect.gen(function* () {
        const m = yield* Ref.get(ref)
        return Array.from(m.keys()).sort()
      })

      const lookupEntry: WorkerRegistryApi["lookupEntry"] = (kind) =>
        Effect.gen(function* () {
          const m = yield* Ref.get(ref)
          return m.get(kind) ?? null
        })

      const lookup: WorkerRegistryApi["lookup"] = (kind) =>
        lookupEntry(kind).pipe(Effect.map((entry) => entry?.run ?? null))

      const dispatch: WorkerRegistryApi["dispatch"] = (kind, payload, ctx) =>
        Effect.gen(function* () {
          const entry = yield* lookupEntry(kind)
          if (!entry) {
            return yield* Effect.fail(
              new WorkerError({
                reason: "unknown_kind",
                kind,
                message: `no worker registered for kind "${kind}"`,
              }),
            )
          }
          return yield* entry.run(payload, ctx)
        })

      return {
        register,
        listKinds,
        lookup,
        lookupEntry,
        dispatch,
      } satisfies WorkerRegistryApi
    }),
  )
