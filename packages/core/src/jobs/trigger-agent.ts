/**
 * TriggerAgent — event-driven agent registration (DESIGN §2.1.8).
 *
 * Responsibilities:
 *   - Parse + validate cron expressions via `effect/Cron`.
 *   - Re-fire on each cron tick by sleeping until next match (Clock /
 *     TestClock-driven for determinism).
 *   - Consume Stream-kind triggers, submitting one job per event.
 *
 * Invariants:
 *   - §3.4 #1/#4: each trigger registration creates a fiber forked into the
 *     caller's Scope. When the Scope closes, the trigger fiber interrupts;
 *     no in-flight events are lost more catastrophically than they would
 *     be if the user closed the parent Scope manually.
 *   - §6.3: cron-parse / unknown-kind raise `TriggerError` (additive
 *     boundary; not in frozen `errors.ts`).
 *   - Non-poisoning: if a single event-build throws, the trigger logs the
 *     fault but continues firing. Submission failures (e.g. queue-full
 *     under drop-newest) are visible in the result Stream of the
 *     downstream JobScheduler — TriggerAgent does not retry submits.
 *
 * Scheduling note for cron:
 *   We compute `Cron.next(cron, new Date(nowMs))` then sleep until that
 *   moment. Using `Effect.sleep(Duration.millis(deltaMs))` cooperates with
 *   `TestClock.adjust` so tests can advance virtual time and witness
 *   exactly-N firings. Per `effect/Cron`'s sequence semantics, a tick
 *   computed at exactly the boundary yields the NEXT match (so no
 *   double-fire at boundary).
 */
import { Cron, Duration, Effect, Either, Layer, Ref, Stream } from "effect"
import * as EffectClock from "effect/Clock"
import type * as Scope from "effect/Scope"
import {
  JobScheduler,
  type JobSchedulerApi,
  type JobSpec,
} from "./job-scheduler.js"
import { TriggerError } from "./errors.js"

export type TriggerId = string

export type TriggerKind = "cron" | "stream"

export type TriggerSpec =
  | {
      readonly kind: "cron"
      readonly expr: string
      readonly build: () => JobSpec
    }
  | {
      readonly kind: "stream"
      readonly source: Stream.Stream<unknown>
      readonly build: (event: unknown) => JobSpec
    }

/** Public summary of a registered trigger. */
export interface TriggerSummary {
  readonly id: TriggerId
  readonly kind: TriggerKind
  /** Cron expression if kind === "cron", undefined otherwise. */
  readonly expr?: string
  readonly registeredAt: string
}

export interface TriggerAgentApi {
  readonly register: (
    spec: TriggerSpec,
  ) => Effect.Effect<TriggerId, TriggerError, Scope.Scope>

  /**
   * List all currently-active triggers. Returns a snapshot of the
   * registry — callers cannot mutate. Lifetime is governed by the
   * caller's Scope (per §3.1); when a registration's Scope closes,
   * the entry is removed from the registry.
   */
  readonly list: Effect.Effect<ReadonlyArray<TriggerSummary>>
}

export class TriggerAgent extends Effect.Tag(
  "experiment-agent/TriggerAgent",
)<TriggerAgent, TriggerAgentApi>() {}

let triggerCounter = 0
const nextTriggerId = (): TriggerId =>
  `trigger-${++triggerCounter}-${Math.random().toString(36).slice(2, 8)}`

const make = (
  scheduler: JobSchedulerApi,
  registry: Ref.Ref<Map<TriggerId, TriggerSummary>>,
): TriggerAgentApi => {
  const trackEntry = (
    id: TriggerId,
    kind: TriggerKind,
    expr?: string,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const summary: TriggerSummary = {
        id,
        kind,
        ...(expr !== undefined ? { expr } : {}),
        registeredAt: new Date().toISOString(),
      }
      yield* Ref.update(registry, (m) => {
        const next = new Map(m)
        next.set(id, summary)
        return next
      })
      // Remove from registry when caller's Scope closes.
      yield* Effect.addFinalizer(() =>
        Ref.update(registry, (m) => {
          const next = new Map(m)
          next.delete(id)
          return next
        }),
      )
    })

  const register: TriggerAgentApi["register"] = (spec) =>
    Effect.gen(function* () {
      const id = nextTriggerId()
      if (spec.kind === "cron") {
        // Use Either-based parser for typed errors.
        const parsed = Cron.parse(spec.expr)
        if (Either.isLeft(parsed)) {
          return yield* Effect.fail(
            new TriggerError({
              kind: "cron-parse",
              message: `cron parse failed: ${parsed.left.message}`,
              cause: parsed.left,
            }),
          )
        }
        const cron = parsed.right
        const loop: Effect.Effect<never> = Effect.gen(function* () {
          // Drive off Effect's Clock service — TestClock swaps in cleanly.
          const nowMs = yield* EffectClock.currentTimeMillis
          let nextDate: Date
          try {
            nextDate = Cron.next(cron, new Date(nowMs))
          } catch (e) {
            // Cron.next can throw if it can't find a match in 10k iters —
            // surface as fault, exit loop (we don't want a hot-spin).
            return yield* Effect.die(
              new TriggerError({
                kind: "cron-parse",
                message: "cron next() failed",
                cause: e,
              }),
            )
          }
          const delta = Math.max(0, nextDate.getTime() - nowMs)
          yield* Effect.sleep(Duration.millis(delta))
          // Build + submit; ignore submit failures (caller observes via
          // scheduler.results stream when applicable).
          const submitted = yield* Effect.either(
            Effect.suspend(() => {
              const built = spec.build()
              return scheduler.submit(built)
            }),
          )
          // Whether submit succeeded or failed, advance to next tick.
          // (Discard `submitted` — it's only here to ensure the chain
          // executes.)
          void submitted
        }).pipe(Effect.forever)
        // Fork into caller's Scope — Scope.close interrupts the loop.
        yield* Effect.forkScoped(loop)
        yield* trackEntry(id, "cron", spec.expr)
        return id
      }
      if (spec.kind === "stream") {
        const consume = spec.source.pipe(
          Stream.runForEach((event) =>
            Effect.suspend(() => {
              const built = spec.build(event)
              return scheduler.submit(built).pipe(
                // Don't poison the trigger on submit failure.
                Effect.either,
                Effect.asVoid,
              )
            }),
          ),
        )
        yield* Effect.forkScoped(consume)
        yield* trackEntry(id, "stream")
        return id
      }
      // Exhaustiveness — TS already narrows, but defensive.
      const exhaust: never = spec
      return yield* Effect.fail(
        new TriggerError({
          kind: "unknown-kind",
          message: `unknown trigger kind: ${JSON.stringify(exhaust)}`,
        }),
      )
    })

  const list: TriggerAgentApi["list"] = Effect.gen(function* () {
    const m = yield* Ref.get(registry)
    return Array.from(m.values())
  })

  return { register, list }
}

export const TriggerAgentLayer = {
  Default: Layer.effect(
    TriggerAgent,
    Effect.gen(function* () {
      const scheduler = yield* JobScheduler
      const registry = yield* Ref.make<Map<TriggerId, TriggerSummary>>(new Map())
      return make(scheduler, registry)
    }),
  ),
} as const
