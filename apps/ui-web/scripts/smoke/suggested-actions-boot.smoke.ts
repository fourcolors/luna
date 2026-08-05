/**
 * suggested-actions-boot.smoke.ts — P9 boot-risk verification.
 *
 * chat-server.ts (apps/server/src, S09) now has a tsc gate, but tsc cannot see
 * whether the Suggested Actions graph it wires by hand actually resolves at
 * runtime: SuggestedActionsStore (SQLite) → SuggestedActions →
 * AcceptHandler (+ forked completion observer) + SuggestedActionToolsLayer, with
 * the same memoized SuggestedActions instance shared across all three. This
 * smoke builds that exact sub-graph under a real ManagedRuntime (so bun:sqlite +
 * LunaSqliteBootstrap run) and exercises the accept path end-to-end:
 *   propose → respond(accept) with AcceptHandler provided → in_progress + a
 *   durable one-shot job recorded.
 *
 * Run: bun run apps/ui-web/scripts/smoke/suggested-actions-boot.smoke.ts
 */
import {
  AcceptHandler,
  AcceptHandlerLayer,
  Clock,
  JobsStoreService,
  SuggestedActions,
  SuggestedActionsStore,
} from "@luna/core"
import {
  SuggestedActionToolsLayer,
  SuggestedActionToolsService,
} from "@luna/suggested-actions-tools"
import { LunaSqliteBootstrapLive } from "@luna/memory"
import { Effect, Layer, ManagedRuntime } from "effect"

const clockL = Clock.Default

// SAME shape as chat-server.ts buildServerLayer: store → service → accept +
// tools, sharing ONE memoized SuggestedActions instance (the `saL` const).
const storeL = SuggestedActionsStore.makeLayer(":memory:").pipe(
  Layer.provide(clockL),
  Layer.provide(LunaSqliteBootstrapLive),
)
const saL = SuggestedActions.layer.pipe(Layer.provide(storeL))
const jobsL = JobsStoreService.makeLayer(":memory:").pipe(
  Layer.provide(clockL),
  Layer.provide(LunaSqliteBootstrapLive),
)
const acceptL = AcceptHandlerLayer().pipe(
  Layer.provide(saL),
  Layer.provide(jobsL),
  Layer.provide(clockL),
)
const toolsL = SuggestedActionToolsLayer.pipe(Layer.provide(saL))

const layer = Layer.mergeAll(saL, acceptL, toolsL, jobsL)

const main = Effect.gen(function* () {
  const sa = yield* SuggestedActions
  const acceptHandler = yield* AcceptHandler
  const tools = yield* SuggestedActionToolsService
  if (tools.serverName !== "suggested_actions") {
    throw new Error(`[smoke] FAIL — unexpected tool server name: ${tools.serverName}`)
  }
  console.log("[smoke] graph composed; tool server =", tools.serverName)

  // propose → accept (with AcceptHandler provided exactly like the ui-ws handle).
  const row = yield* sa.propose({
    threadId: "thr_smoke",
    source: "agent",
    actionType: "research",
    title: "smoke research",
    payload: { prompt: "go" },
  })
  const result = yield* sa
    .respond({ threadId: "thr_smoke", actionId: row.id, decision: "accept" })
    .pipe(Effect.provideService(AcceptHandler, acceptHandler))
  if (result?.status !== "in_progress") {
    throw new Error(`[smoke] FAIL — expected in_progress after accept, got ${result?.status}`)
  }

  const jobs = yield* JobsStoreService
  const job = yield* jobs.getById(`saj-${row.id}`)
  if (!job) throw new Error("[smoke] FAIL — no durable job recorded for accepted action")
  if (job.kind !== "prompt" || job.enabled !== true || job.spec !== "") {
    throw new Error(
      `[smoke] FAIL — unexpected job shape: kind=${job.kind} enabled=${job.enabled} spec="${job.spec}"`,
    )
  }
  console.log(
    "[smoke] accept → durable one-shot job:",
    job.id,
    "kind=" + job.kind,
    "enabled=" + job.enabled,
  )
})

const rt = ManagedRuntime.make(layer)
rt.runPromise(main)
  .then(() => rt.dispose())
  .then(() => {
    console.log(
      "[smoke] PASS — SuggestedActions store+service+accept-handler+tools compose; accept auto-executes a one-shot job",
    )
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error("[smoke] FAIL —", err)
    process.exit(1)
  })
