/**
 * luna-dream-once — manually fire one Dream cycle outside the 3am cron.
 *
 * Use to:
 *   - Verify the dream pipeline is wired correctly after a deploy.
 *   - Inspect what the model proposes from the current SessionStore +
 *     MemoryRouter state (without waiting until tomorrow morning).
 *   - Debug a silent failure (this script's logs make a broken SDK
 *     binary, broken auth, or broken layer graph immediately visible —
 *     the cron path swallows the cause via Effect.either; this one
 *     surfaces the cause via runPromiseExit).
 *
 * Reads/writes the same SQLite stores the live server uses:
 *   - dream_audit + dream_state (lunaDbPath, /root/.luna/luna.db)
 *   - memory_keyed (resolveDbPath, /root/.luna/memory.db)
 *
 * Honors LUNA_DB_PATH / LUNA_MEMORY_DB / LUNA_HOME like chat-server.ts.
 * Uses the same LUNA_CLAUDE_CODE_EXECUTABLE the chat server reads so the
 * SDK can find the real Claude Code binary on the host.
 *
 * Note: SessionStore is in-memory (Ref-backed) in the live server, so a
 * fresh process here sees ZERO sessions — the reasoner is still called
 * (with empty inputs it typically returns []), proving the wiring works.
 * To exercise the reasoner with real content, seed a synthetic session
 * via sessions.create + sessions.appendMessage before calling runDream.
 *
 * Run (inside the luna-dev / luna-stable container):
 *   cd /root/luna/apps/ui-web && \
 *   set -a; . /root/.luna/.env; set +a; \
 *   /root/.bun/bin/bun run scripts/luna-dream-once.ts
 */
import { Effect, Layer, ManagedRuntime } from "effect"
import {
  Clock,
  DreamStore,
  SessionStore,
  runDream,
  AccountBrokerLayer,
  EnvSecretProvider,
} from "@luna/core"
import { DreamReasonerDefault, SDKClient } from "@luna/adapter-sdk"
import {
  MemoryRouterLayer,
  resolveDbPath,
  selectEmbedderLayer,
} from "@luna/memory-tools"
import { LunaSqliteBootstrapLive } from "@luna/memory"
import { resolveRuntimePaths } from "./runtime-paths.js"
import { ObservabilityService } from "@luna/core"

const paths = resolveRuntimePaths()
console.log("[luna-dream-once] paths:", {
  lunaDbPath: paths.lunaDbPath,
  memoryDbPath: resolveDbPath(),
})

const obsL = ObservabilityService.makeLayer({
  jsonlPath: paths.eventsJsonlPath,
})
const clockL = Clock.Default
const sessionStoreL: Layer.Layer<SessionStore> = SessionStore.Default
const memoryRouterL = MemoryRouterLayer(resolveDbPath()).pipe(
  Layer.provide(selectEmbedderLayer()),
  Layer.provide(obsL),
  Layer.provide(clockL),
)
const dreamStoreL = DreamStore.makeLayer(paths.lunaDbPath).pipe(
  Layer.provide(clockL),
)
const sdkClientL = SDKClient.Default

// A6: DreamReasonerDefault now requires AccountBroker — it acquires a credential
// per reason() through the provider seam (LUNA_DREAM_MODEL ?? LUNA_REASONER_MODEL).
// Build the SQL broker (the production path; this script runs under bun, so
// bun:sqlite is available) hydrated from the same accounts table the live server
// uses, honoring LUNA_DB_PATH. SecretProvider is EnvSecretProvider here (resolves
// `env:` refs); the canonical `claude-code:login` accounts skip secret resolution
// entirely, so with LUNA_DREAM_MODEL unset this reproduces today's ambient-login
// behavior. (Op-token routing is NOT mirrored here — see the chat-server boot for
// the full RoutedOp→Env chain; for this debug script env-only resolution suffices.)
const dbOverride = process.env["LUNA_DB_PATH"]
const brokerL = AccountBrokerLayer.fromSql(
  dbOverride !== undefined && dbOverride.length > 0 ? { dbPath: dbOverride } : {},
).pipe(Layer.provide(EnvSecretProvider.Default), Layer.provide(clockL))
const dreamReasonerL = DreamReasonerDefault.pipe(
  Layer.provide(sdkClientL),
  Layer.provide(memoryRouterL),
  Layer.provide(brokerL),
)
const base = Layer.mergeAll(
  clockL,
  sessionStoreL,
  memoryRouterL,
  dreamStoreL,
  dreamReasonerL,
).pipe(Layer.provide(LunaSqliteBootstrapLive))

const program = Effect.gen(function* () {
  const store = yield* DreamStore
  const wmBefore = yield* store.getWatermark
  console.log(`[luna-dream-once] watermark BEFORE: ${wmBefore ?? "null"}`)
  const now = Date.now()
  console.log(`[luna-dream-once] firing runDream(${now}) …`)
  const t0 = Date.now()
  yield* runDream(now)
  console.log(`[luna-dream-once] runDream resolved in ${Date.now() - t0}ms`)
  const wmAfter = yield* store.getWatermark
  const audit = yield* store.list({})
  console.log(`[luna-dream-once] watermark AFTER : ${wmAfter ?? "null"}`)
  console.log(`[luna-dream-once] dream_audit rows: ${audit.length}`)
  for (const row of audit) {
    console.log(`  • ${row.op} [${row.status}] tgt=${row.targetId}`)
    console.log(`    rationale: ${JSON.stringify(row.rationale).slice(0, 200)}`)
  }
})

const runtime = ManagedRuntime.make(base)
const exit = await runtime.runPromiseExit(program)
await runtime.dispose()
if (exit._tag === "Failure") {
  console.error("[luna-dream-once] FAIL")
  console.error(JSON.stringify(exit.cause, null, 2).slice(0, 4000))
  process.exit(1)
}
console.log("[luna-dream-once] PASS")
