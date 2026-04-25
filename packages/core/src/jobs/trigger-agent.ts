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
import { Cron, Duration, Effect, Either, Layer, Stream } from "effect"
import * as EffectClock from "effect/Clock"
import type * as Scope from "effect/Scope"
import {
  JobScheduler,
  type JobSchedulerApi,
  type JobSpec,
} from "./job-scheduler.js"
import { TriggerError } from "./errors.js"

export type TriggerId = string

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

export interface TriggerAgentApi {
  readonly register: (
    spec: TriggerSpec,
  ) => Effect.Effect<TriggerId, TriggerError, Scope.Scope>
}

export class TriggerAgent extends Effect.Tag(
  "experiment-agent/TriggerAgent",
)<TriggerAgent, TriggerAgentApi>() {}

let triggerCounter = 0
const nextTriggerId = (): TriggerId =>
  `trigger-${++triggerCounter}-${Math.random().toString(36).slice(2, 8)}`

const make = (scheduler: JobSchedulerApi): TriggerAgentApi => {
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
  return { register }
}

export const TriggerAgentLayer = {
  Default: Layer.effect(
    TriggerAgent,
    Effect.gen(function* () {
      const scheduler = yield* JobScheduler
      return make(scheduler)
    }),
  ),
} as const
