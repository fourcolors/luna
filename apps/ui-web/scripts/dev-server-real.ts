/**
 * Real-SDK dev rig: same ui-ws server as `dev-server.ts`, but events are
 * translated from a *real* Claude Agent SDK query running through the
 * existing Effect Layer stack. Lets you watch a real agent stream into
 * the web UI as observability validation.
 *
 * Run:
 *   CLAUDE_CODE_OAUTH_TOKEN=... bun run dev:server:real
 *
 * Token is printed on startup; copy into the web UI.
 *
 * Architecture note (advisor pre-flight): the SDKAdapter does NOT emit
 * ObsEvents on its own — it mirrors SDKMessages to SessionStore. The
 * translator below (`emitForSdkMessage`) is the seam that turns
 * SDKMessage → ObsEvent → ObservabilityService.emit. Keep this in the
 * script (not the adapter) so the adapter stays clean.
 */
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import {
  Clock,
  DEFAULT_UI_KINDS,
  ObservabilityService,
  SessionStore,
  UIService,
} from "@experiment-agent/core"
import {
  SDKAdapter,
  SDKClient,
  type SDKMessage,
  type SDKUserMessage,
} from "@experiment-agent/adapter-sdk"
import { startUIWebSocketServer } from "@experiment-agent/ui-ws"

const TOKEN = "dev-ui-ws-token-do-not-ship"
const SESSION_ID = "real-dev"
const MODEL = "claude-sonnet-4-5"
const PROMPT = "List 3 fun facts about octopuses, in one sentence each."

const hasToken = Boolean(process.env["CLAUDE_CODE_OAUTH_TOKEN"])
if (!hasToken) {
  console.log(
    "ℹ️  CLAUDE_CODE_OAUTH_TOKEN not set — skipping real-SDK mode.\n" +
      "   Set the env var (1Password vault \"Mr Bot\") to run a real query.\n" +
      "   For offline UI iteration, run `bun run dev:server` instead.",
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
  const sdkL = Layer.provideMerge(
    SDKAdapter.Default,
    Layer.mergeAll(SDKClient.Default, SessionStore.Default),
  )
  return Layer.mergeAll(uiL, obsL, clockL, sdkL)
})()

class ServerHandle extends Effect.Tag("dev/ServerHandle")<
  ServerHandle,
  { readonly port: number; readonly host: string }
>() {}

const serverLayer = Layer.scoped(
  ServerHandle,
  startUIWebSocketServer({
    port: 4753,
    token: TOKEN,
    advertisedKinds: DEFAULT_UI_KINDS,
    pingIntervalMs: 5000,
  }),
).pipe(Layer.provide(baseLayer))

const runtime = ManagedRuntime.make(Layer.mergeAll(serverLayer, baseLayer))

// ── SDKMessage → ObsEvent translator ────────────────────────────────────

const nowIso = () => new Date().toISOString()

/**
 * Walk an SDKMessage and emit zero or more ObsEvents. Each call is
 * non-blocking: ObservabilityService.emit is fire-and-forget by design.
 */
const emitForSdkMessage = (
  obs: ObservabilityService["Type"],
  msg: SDKMessage,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const t = (msg as { type?: string }).type

    // Assistant turn: surface tool_use blocks as ToolCall events. We don't
    // know the duration here (the SDK doesn't split start/stop), so we use
    // 0 and let the UI's status="success" be the signal. A more refined
    // version could pair tool_use ↔ tool_result blocks across turns.
    if (t === "assistant") {
      const m = msg as {
        message?: { content?: ReadonlyArray<{ type?: string; name?: string }> }
        session_id?: string
      }
      const blocks = m.message?.content ?? []
      for (const b of blocks) {
        if (b.type === "tool_use" && typeof b.name === "string") {
          yield* obs.emit({
            kind: "ToolCall",
            ts: nowIso(),
            level: "info",
            sessionId: m.session_id ?? SESSION_ID,
            toolName: b.name,
            durationMs: 0,
            status: "success",
          })
        }
      }
      return
    }

    // Final result message — emit CostAccrued from usage + SessionEnd.
    if (t === "result") {
      const m = msg as {
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
        }
        total_cost_usd?: number
        duration_ms?: number
        session_id?: string
        is_error?: boolean
      }
      const u = m.usage ?? {}
      yield* obs.emit({
        kind: "CostAccrued",
        ts: nowIso(),
        level: "info",
        sessionId: m.session_id ?? SESSION_ID,
        tokensIn: u.input_tokens ?? 0,
        tokensOut: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        estimatedUsd: m.total_cost_usd ?? 0,
      })
      yield* obs.emit({
        kind: "SessionEnd",
        ts: nowIso(),
        level: m.is_error ? "error" : "info",
        sessionId: m.session_id ?? SESSION_ID,
        durationMs: m.duration_ms ?? 0,
      })
      return
    }

    // user / system / stream_event / hook / status — not surfaced as
    // ObsEvents in this minimal validator. They still flow into
    // SessionStore via the adapter's mirror.
  })

// ── Main ────────────────────────────────────────────────────────────────

const main = Effect.gen(function* () {
  const handle = yield* ServerHandle
  console.log(`✅ ui-ws dev server: ws://${handle.host}:${handle.port}/ui`)
  console.log(`🔑 token: ${TOKEN}`)
  console.log(`💡 web UI: cd apps/ui-web && bun run dev`)
  console.log(`   then paste the token into the UI`)
  console.log(`🤖 running real SDK query: "${PROMPT}"`)

  const obs = yield* ObservabilityService
  const adapter = yield* SDKAdapter
  const store = yield* SessionStore

  // Register the session before the adapter touches it.
  yield* store.create({
    id: SESSION_ID,
    options: { model: MODEL },
    createdAt: Date.now(),
  })

  yield* obs.emit({
    kind: "SessionStart",
    ts: nowIso(),
    level: "info",
    sessionId: SESSION_ID,
    model: MODEL,
  })

  // Single user message (forward-compat note: swap fromIterable → fromQueue
  // when adding two-way chat — this is the named local the advisor flagged).
  const promptStream: Stream.Stream<SDKUserMessage> = Stream.fromIterable([
    {
      type: "user",
      message: { role: "user", content: PROMPT },
      parent_tool_use_id: null,
    } as SDKUserMessage,
  ])

  const out = yield* adapter.query({
    sessionId: SESSION_ID,
    prompt: promptStream,
    sessionOptions: {
      model: MODEL,
      idleTimeoutMs: 60_000,
      sdkOptions: { maxTurns: 1 },
    },
  })

  // Drain the SDK stream, translating each message to ObsEvents. On
  // failure, surface as an Error event so the UI sees it (vs silent stop).
  yield* out.pipe(
    Stream.tap((msg) => emitForSdkMessage(obs, msg)),
    Stream.runDrain,
    Effect.catchAll((err) =>
      obs.emit({
        kind: "Error",
        ts: nowIso(),
        level: "error",
        errorTag: "SDKQueryFailed",
        message: String(err),
        context: { sessionId: SESSION_ID },
      }),
    ),
  )

  console.log(
    "\n✅ session complete; ws server still up — Ctrl-C to exit.",
  )
})

runtime.runFork(Effect.scoped(main))

process.on("SIGINT", async () => {
  console.log("\n👋 shutting down")
  await runtime.dispose()
  process.exit(0)
})
