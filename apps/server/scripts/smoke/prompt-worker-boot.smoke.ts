/**
 * prompt-worker-boot.smoke.ts — boot-risk verification for P4 (prompt worker)
 * registration into the V2 ticker's WorkerRegistry. Mirrors the
 * job-ticker-boot smoke pattern; this one additionally proves the
 * PromptWorkerLayer composes correctly with SDKClient + WorkerRegistry +
 * AgentNotesService and that the registered kind appears in listKinds.
 *
 * Run: bun run apps/server/scripts/smoke/prompt-worker-boot.smoke.ts
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
import { PromptWorkerLayer, SDKClient } from "@luna/adapter-sdk"
import type { Query } from "@luna/adapter-sdk"
import { Effect, Layer, ManagedRuntime } from "effect"

// SDK fake: never invoked (no jobs to drain), but must satisfy the type.
const sdkFake: Layer.Layer<SDKClient> = SDKClient.fake(() => {
  async function* gen(): AsyncGenerator<never> {}
  return gen() as unknown as Query
})

// Worker registry seeded by PromptWorkerLayer.
const workerRegistryL = PromptWorkerLayer().pipe(
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
  if (!kinds.includes("prompt")) {
    throw new Error(`[smoke] FAIL — 'prompt' not in kinds: ${JSON.stringify([...kinds])}`)
  }
  const ticker = yield* JobTicker
  const summary = yield* ticker.drain
  console.log("[smoke] drained empty store; considered =", summary.considered)
})

const rt = ManagedRuntime.make(layer)
rt.runPromise(main)
  .then(() => rt.dispose())
  .then(() => {
    console.log(
      "[smoke] PASS — PromptWorkerLayer registers 'prompt' worker into WorkerRegistry; JobTicker composes",
    )
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error("[smoke] FAIL —", err)
    process.exit(1)
  })
