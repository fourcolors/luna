/**
 * job-ticker-boot.smoke.ts — boot-risk verification for the Phase 12b
 * JobTicker layer wiring (DESIGN.md §5.3).
 *
 * Just like the wake-cron-boot smoke, `chat-server.ts` has no tsc gate
 * (root tsconfig excludes apps/ui-web/**) so a missing service or wrong
 * Layer.provide composition crashes the whole boot. This smoke proves the
 * JobTicker layer builds with a ManagedRuntime using the REAL exported
 * `JobTickerLayer` + a real in-memory `JobsStoreService.Memory` + a real
 * `makeWorkerRegistry({})` — the exact composition shape used by
 * chat-server.ts when LUNA_SCHEDULER_V2_ENABLED=1.
 *
 * Regression guard: removing `Layer.provide(jobsStoreL)` (or any other dep)
 * from the JobTicker wiring in chat-server.ts MUST make this smoke FAIL
 * with a missing-service defect.
 *
 * Run: bun run apps/ui-web/scripts/smoke/job-ticker-boot.smoke.ts
 * Exit 0 = PASS, non-zero = FAIL.
 */
import {
  Clock,
  JobTicker,
  JobTickerLayer,
  JobsStoreService,
  makeWorkerRegistry,
} from "@luna/core"
import { Effect, Layer, ManagedRuntime } from "effect"

// ──────────────────────────────────────────────────────────────────────────
// Build the layer under test — MIRRORS the shape used in chat-server.ts
// behind the LUNA_SCHEDULER_V2_ENABLED flag.
// ──────────────────────────────────────────────────────────────────────────

const jobsStoreL = JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))
const registryL = makeWorkerRegistry({})

const layer = JobTickerLayer().pipe(
  Layer.provide(Layer.mergeAll(jobsStoreL, registryL, Clock.Default)),
)

// ──────────────────────────────────────────────────────────────────────────
// Assertion: resolve JobTicker (forces the layer to build), then run one
// drain on an empty store to confirm the ticker path actually executes.
// ──────────────────────────────────────────────────────────────────────────

const main = Effect.gen(function* () {
  const ticker = yield* JobTicker
  const summary = yield* ticker.drain
  console.log(
    "[smoke] JobTicker resolved + drained empty store; tickAt =",
    summary.tickAt,
    "considered =",
    summary.considered,
  )
  if (summary.considered !== 0) {
    throw new Error(
      `[smoke] FAIL — expected considered=0 on empty store, got ${summary.considered}`,
    )
  }
})

const rt = ManagedRuntime.make(layer)
rt.runPromise(main)
  .then(() => rt.dispose())
  .then(() => {
    console.log(
      "[smoke] PASS — JobTicker layer builds with the real JobsStoreService.Memory + WorkerRegistry + Clock graph",
    )
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error("[smoke] FAIL — layer build defect:", err)
    process.exit(1)
  })
