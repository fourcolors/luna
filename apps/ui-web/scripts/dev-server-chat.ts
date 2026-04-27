/**
 * Real-SDK chat dev rig: drives a long-lived chat conversation through
 * ChatService and exposes it on the ui-ws WebSocket so the web UI (or
 * any v2 protocol client) can subscribe / send / interrupt.
 *
 * Pairs with `dev-server-real.ts` (obs-event translator) — that script
 * remains the canonical end-to-end check that ObservabilityService
 * frames keep flowing from a real subprocess. This script is the same
 * idea but for the chat surface: full ChatService + ui-ws routing,
 * driven by a real Claude Agent SDK subprocess.
 *
 * Run:
 *   CLAUDE_CODE_OAUTH_TOKEN=... bun run --filter '@luna/ui-web' dev:server:chat
 *
 * Token + ws URL print on startup. The web UI will be able to:
 *   - send `{type:"new-thread", model:"claude-sonnet-4-5"}` to spawn a
 *     persistent thread (the server auto-subscribes the connection)
 *   - send `{type:"user-message", threadId, text}` for each turn
 *   - send `{type:"interrupt", threadId}` for the Stop button
 *   - send `{type:"list-threads"}` for the sidebar projection
 *
 * No hardcoded prompt — UI drives. SessionStart/SessionEnd obs events
 * still fire (chat-service forwards them to ObservabilityService when
 * mounted alongside it) so the obs panel stays useful.
 *
 * Architecture note: ChatService FORCES `disableIdleTimeout: true` and
 * `includePartialMessages: true` on every thread (commit 5e488d4). User
 * think-time between turns can be hours — chat is the canonical case
 * the flag exists for.
 */
import { Effect, Layer, ManagedRuntime } from "effect"
import {
  Clock,
  DEFAULT_UI_KINDS,
  ObservabilityService,
  SessionStore,
  UIService,
} from "@luna/core"
import { SDKAdapter, SDKClient } from "@luna/adapter-sdk"
import { ChatService } from "@luna/chat-service"
import { startUIWebSocketServer } from "@luna/ui-ws"

const TOKEN = "dev-ui-ws-token-do-not-ship"

const hasToken = Boolean(process.env["CLAUDE_CODE_OAUTH_TOKEN"])
if (!hasToken) {
  console.log(
    "ℹ️  CLAUDE_CODE_OAUTH_TOKEN not set — skipping real-SDK chat mode.\n" +
      "   Set the env var (1Password vault \"Mr Bot\") to drive a real chat.\n" +
      "   For offline UI iteration, run `bun run dev:server` (obs only).",
  )
  process.exit(0)
}

// ── Layer wiring ────────────────────────────────────────────────────────
const baseLayer = (() => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  const storeL = SessionStore.Default
  const sdkClientL = SDKClient.Default
  const sdkAdapterL = Layer.provideMerge(
    SDKAdapter.Default,
    Layer.mergeAll(sdkClientL, storeL),
  )
  const chatL = Layer.provideMerge(
    ChatService.Default,
    Layer.mergeAll(sdkAdapterL, storeL, clockL, obsL),
  )
  return Layer.mergeAll(uiL, obsL, clockL, storeL, sdkAdapterL, chatL)
})()

class ServerHandle extends Effect.Tag("dev/ChatServerHandle")<
  ServerHandle,
  { readonly port: number; readonly host: string }
>() {}

// Server reads ChatService from its env, then passes the resolved
// service handle to startUIWebSocketServer via config. This keeps the
// server effect's requirements narrow (it doesn't itself depend on
// ChatService — just receives the handle).
const serverLayer = Layer.scoped(
  ServerHandle,
  Effect.gen(function* () {
    const chat = yield* ChatService
    return yield* startUIWebSocketServer({
      port: 4753,
      token: TOKEN,
      advertisedKinds: DEFAULT_UI_KINDS,
      pingIntervalMs: 5000,
      chatService: chat,
    })
  }),
).pipe(Layer.provide(baseLayer))

const runtime = ManagedRuntime.make(Layer.mergeAll(serverLayer, baseLayer))

const main = Effect.gen(function* () {
  const handle = yield* ServerHandle
  console.log(`✅ ui-ws chat server: ws://${handle.host}:${handle.port}/ui`)
  console.log(`🔑 token: ${TOKEN}`)
  console.log(`🧠 chat enabled (capabilities.chat=true, streamingDeltas=true)`)
  console.log(`💡 web UI: bun run --filter '@luna/ui-web' dev`)
  console.log(`   token auto-fills via .env.development — start a thread`)
  console.log(`💤 idle until a client connects — Ctrl-C to exit`)
  // Park forever so the server scope stays open.
  yield* Effect.never
})

process.on("SIGINT", async () => {
  console.log("\n👋 shutting down")
  await runtime.dispose()
  process.exit(0)
})

// runPromise keeps the event loop alive until the effect resolves (which
// it never does because of Effect.never). runFork returns immediately,
// so without an explicit keep-alive the process exits.
runtime.runPromise(main).catch((err) => {
  console.error("❌ chat server crashed:", err)
  process.exit(1)
})
