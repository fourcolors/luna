/**
 * DreamCronLayer — wires the nightly Dream cron into a layer graph, mirroring
 * SchedulerToolsLayer (scheduler-tools/src/layer.ts:100-129): a Layer.scoped
 * that provides its OWN JobScheduler + TriggerAgent, resolves TriggerAgent from
 * the built sub-graph, and calls registerDreamCron(trigger, expr) at layer-build
 * time. The cron fiber is forked into the Layer's ambient Scope (the caller's
 * Scope when used with Layer.scoped) so it outlives the build — exactly the
 * contract proved by dream-cron.test.ts.
 *
 * The dream DEPS (DreamStore, DreamReasoner, SessionStore, MemoryRouter, Clock)
 * flow in from R — the caller supplies real-or-Fake reasoner + real-or-Memory
 * store. Live boot uses DreamReasoner.Default; the boot smoke harness and this
 * unit test use FakeReasoner (spec-delta #1 — no model calls in smoke/test).
 *
 * Clock is intentionally left in R (not re-provided here) so the scheduler's
 * clock and the dream deps share the SAME clock instance — essential for
 * TestClock determinism and live-boot consistency.
 *
 * Produces a DreamCron marker tag so Layer.mergeAll is forced to build this
 * layer (and thereby register the cron) and tests have a service to resolve.
 */
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { JobSchedulerLayer } from "../jobs/job-scheduler.js"
import { TriggerAgent, TriggerAgentLayer } from "../jobs/trigger-agent.js"
import type { MemoryRouter } from "@luna/memory"
import { DreamStore } from "./dream-store.js"
import { DreamReasoner } from "./reasoner.js"
import { SessionStore } from "../session/session-store.js"
import { registerDreamCron } from "./dream.js"
import type { TriggerId } from "../jobs/trigger-agent.js"

export interface DreamCronApi {
  readonly expr: string
  readonly triggerId: TriggerId
}

export class DreamCron extends Effect.Tag("luna/DreamCron")<DreamCron, DreamCronApi>() {}

export interface DreamCronLayerOptions {
  readonly capacity?: number
  readonly offerPolicy?: "drop-newest" | "drop-oldest"
}

/**
 * Build a layer that registers a Dream cron at `expr`.
 *
 * Requires in R: DreamStore | DreamReasoner | SessionStore | MemoryRouter | Clock
 * Provides internally: JobScheduler + TriggerAgent (a second instance — harmless,
 * precedented by SchedulerToolsLayer's encapsulated instance and chat-server.ts's
 * second memoryRouterL).
 */
export const DreamCronLayer = (
  expr: string,
  opts?: DreamCronLayerOptions,
): Layer.Layer<
  DreamCron,
  never,
  DreamStore | DreamReasoner | SessionStore | MemoryRouter | Clock
> =>
  Layer.scoped(
    DreamCron,
    Effect.gen(function* () {
      const trigger = yield* TriggerAgent
      // registerDreamCron → trigger.register can fail with TriggerError only
      // if the cron expression is syntactically invalid. The expr is supplied
      // by the caller at layer-construction time (a programming-time constant,
      // not user input), so an invalid expr is a defect — sink it to die so
      // the E channel stays `never` and the layer composes cleanly.
      const triggerId = yield* registerDreamCron(trigger, expr).pipe(Effect.orDie)
      return { expr, triggerId } satisfies DreamCronApi
    }),
  ).pipe(
    Layer.provide(TriggerAgentLayer.Default),
    Layer.provide(
      JobSchedulerLayer.make({
        capacity: opts?.capacity ?? 16,
        offerPolicy: opts?.offerPolicy ?? "drop-newest",
      }),
    ),
    // Clock flows from R — do NOT re-provide Clock.Default here or the
    // scheduler clock will diverge from the dream-deps clock in TestClock tests.
  )
