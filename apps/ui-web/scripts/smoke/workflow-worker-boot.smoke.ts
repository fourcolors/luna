/**
 * workflow-worker-boot.smoke.ts — P5 boot-risk verification.
 *
 * Proves that PromptWorkerLayer + WorkflowWorkerLayer compose cleanly via
 * Layer.merge and both register into the same WorkerRegistry. Mirrors the
 * prompt-worker-boot smoke pattern.
 *
 * Run: bun run apps/ui-web/scripts/smoke/workflow-worker-boot.smoke.ts
 */
import {
  AgentNotesService,
  Clock,
  JobTicker,
  JobTickerLayer,
  JobsStoreService,
  WorkerRegistry,
  makeWorkerRegistry,
} from "@luna/core"
import {
  PromptWorkerLayer,
  WorkflowWorkerLayer,
  SDKClient,
} from "@luna/adapter-sdk"
import type { Query } from "@luna/adapter-sdk"
import { Effect, Layer, ManagedRuntime } from "effect"

const sdkFake: Layer.Layer<SDKClient> = SDKClient.fake(() => {
  async function* gen(): AsyncGenerator<never> {}
  return gen() as unknown as Query
})

const workerRegistryL = Layer.merge(
  PromptWorkerLayer(),
  WorkflowWorkerLayer(),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      sdkFake,
      makeWorkerRegistry({}),
      AgentNotesService.Memory.pipe(Layer.provide(Clock.Default)),
    ),
  ),
)

const jobsStoreL = JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))

const layer = JobTickerLayer().pipe(
  Layer.provideMerge(
    Layer.mergeAll(jobsStoreL, workerRegistryL, Clock.Default),
  ),
)

const main = Effect.gen(function* () {
  const reg = yield* WorkerRegistry
  const kinds = yield* reg.listKinds
  console.log("[smoke] registered worker kinds:", [...kinds])
  for (const expected of ["prompt", "workflow"]) {
    if (!kinds.includes(expected)) {
      throw new Error(`[smoke] FAIL — '${expected}' not in kinds: ${JSON.stringify([...kinds])}`)
    }
  }
  const ticker = yield* JobTicker
  const summary = yield* ticker.drain
  console.log("[smoke] drained empty store; considered =", summary.considered)
})

const rt = ManagedRuntime.make(layer)
rt.runPromise(main)
  .then(() => rt.dispose())
  .then(() => {
    console.log("[smoke] PASS — PromptWorkerLayer + WorkflowWorkerLayer both register; JobTicker composes")
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error("[smoke] FAIL —", err)
    process.exit(1)
  })
