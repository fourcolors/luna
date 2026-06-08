// packages/core/src/wake/wake-cron-layer.ts
//
// WakeCronLayer — wires a wake cron into a layer graph, mirroring
// DreamCronLayer (packages/core/src/dream/dream-cron-layer.ts).
//
// Provides its OWN JobScheduler + TriggerAgent so wake fires are independent
// of any other cron fiber-set (dream, scheduler-tools, etc.). The Layer
// captures WakeReasoner + WakeLogStore from R at build time.
//
// Clock stays in R (not re-provided) so TestClock-based unit tests use the
// same clock instance as the scheduler — essential for deterministic fire
// counting.
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { JobSchedulerLayer } from "../jobs/job-scheduler.js"
import { TriggerAgent, TriggerAgentLayer } from "../jobs/trigger-agent.js"
import type { TriggerId } from "../jobs/trigger-agent.js"
import { AgentNotesService } from "../agent-notes/agent-notes.js"
import { WakeReasoner } from "./reasoner.js"
import { WakeLogStore } from "./wake-log-store.js"
import { registerWakeCron } from "./wake.js"
import type { WakeCronOptions } from "./wake.js"

export interface WakeCronApi {
  readonly expr: string
  readonly workspaceSlug: string
  readonly triggerId: TriggerId
}

export class WakeCron extends Effect.Tag("luna/WakeCron")<
  WakeCron,
  WakeCronApi
>() {}

export interface WakeCronLayerOptions {
  readonly capacity?: number
  readonly offerPolicy?: "drop-newest" | "drop-oldest"
}

/**
 * Build a Layer registering a wake cron at `expr` for the workspace `opts`.
 *
 * Requires in R: WakeReasoner | WakeLogStore | AgentNotesService | Clock
 * Provides internally: JobScheduler + TriggerAgent (independent instance,
 * same as DreamCronLayer).
 */
export const WakeCronLayer = (
  expr: string,
  opts: WakeCronOptions,
  layerOpts?: WakeCronLayerOptions,
): Layer.Layer<WakeCron, never, WakeReasoner | WakeLogStore | AgentNotesService | Clock> =>
  Layer.scoped(
    WakeCron,
    Effect.gen(function* () {
      const trigger = yield* TriggerAgent
      // An invalid expr is a programmer error (config string, not user input)
      // — sink it to die so the E channel stays `never`. Same pattern as
      // DreamCronLayer.
      const triggerId = yield* registerWakeCron(trigger, expr, opts).pipe(
        Effect.orDie,
      )
      return {
        expr,
        workspaceSlug: opts.workspaceSlug,
        triggerId,
      } satisfies WakeCronApi
    }),
  ).pipe(
    Layer.provide(TriggerAgentLayer.Default),
    Layer.provide(
      JobSchedulerLayer.make({
        capacity: layerOpts?.capacity ?? 16,
        offerPolicy: layerOpts?.offerPolicy ?? "drop-newest",
      }),
    ),
    // Clock flows from R — do NOT re-provide Clock.Default here.
  )
