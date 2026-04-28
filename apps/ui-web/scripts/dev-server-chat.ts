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
 *   bun run --filter '@luna/ui-web' dev:server:chat
 *
 * Phase 25b: this script is the first production caller of
 * AccountBroker. The Claude OAuth token is no longer pulled from
 * `CLAUDE_CODE_OAUTH_TOKEN` — instead, accounts seeded into
 * `~/.luna/luna.db` (§5.1 `accounts` table) hydrate at boot and the
 * SDKAdapter overlays the resolved token per-query (§0.2 rotation).
 *
 * Token resolution chain (§2.2.11):
 *   1. OnePasswordSecretProvider — resolves `op://VAULT/ITEM/FIELD
 *      pointers via the `op` CLI. Requires `OP_SERVICE_ACCOUNT_TOKEN`
 *      in env (preferred for headless dev/CI), or an active
 *      `op signin` session as a fallback for interactive use.
 *   2. EnvSecretProvider — fallback for `env:VARNAME` pointers (legacy).
 *
 * # Account Setup
 *
 * Before first run, seed at least one anthropic-kind account:
 *
 *   bun run --filter '@luna/agent-cli' luna-account add \
 *     --id sterling --label "Sterling" --kind anthropic \
 *     --secret-ref op://VAULT/ITEM/FIELD
 *
 * Then verify:
 *
 *   bun run --filter '@luna/agent-cli' luna-account list
 *
 * Pointer format (`secret_ref` column):
 *   - `op://<vault-uuid-or-name>/<item-uuid-or-name>/<field>` — 1Password
 *   - `env:<VARNAME>` — process env (legacy escape hatch)
 *
 * Hot-reload is NOT supported. AccountBroker hydrates the `accounts`
 * table once at Layer construction. To pick up new rows inserted via
 * `luna-account add`, RESTART this server.
 *
 * The web UI will be able to:
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
  AccountBroker,
  AccountBrokerLayer,
  Clock,
  DEFAULT_UI_KINDS,
  EnvSecretProvider,
  ObservabilityService,
  OnePasswordSecretProvider,
  SessionStore,
  UIService,
  secretProviderFirstOf,
} from "@luna/core"
import { SDKAdapter, SDKClient } from "@luna/adapter-sdk"
import { ChatService } from "@luna/chat-service"
import { startUIWebSocketServer } from "@luna/ui-ws"
import {
  MemoryToolsLayer,
  MemoryToolsService,
} from "@luna/memory-tools"

const TOKEN = "dev-ui-ws-token-do-not-ship"
const OP_VAULT = "Mr Bot"

// ── Layer wiring ────────────────────────────────────────────────────────
//
// Phase 25b: SecretProvider chain (1Password → env) feeds AccountBroker
// (SQL-hydrated from ~/.luna/luna.db). The broker is a Layer requirement
// of SDKAdapter (Phase 9.5) — providing it here causes acquireSession()
// to overlay the per-query Claude OAuth token automatically. No env-var
// bail; no plaintext token in this process beyond a short-lived
// Redacted<string> at acquire time.
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

  // SecretProvider chain: 1Password first, env fallback. Both
  // providers' miss-paths are ConfigError, so `firstOf` falls through
  // cleanly.
  const opProviderL = OnePasswordSecretProvider.make({ vault: OP_VAULT }).pipe(
    Layer.provide(clockL),
  )
  const envProviderL = EnvSecretProvider.Default
  const secretL = secretProviderFirstOf([opProviderL, envProviderL])

  // AccountBroker hydrates the §5.1 `accounts` table from the default
  // ~/.luna/luna.db. Failures here surface as ConfigError at boot —
  // see the catch in `main` below for the operator-friendly hint.
  // `LUNA_DB_PATH` env var overrides the default (dev-only escape hatch
  // mirroring the agent-cli's `--db-path`). Same env var is honored by
  // `luna-account` so seed + serve stay aligned in tests.
  const dbOverride = process.env["LUNA_DB_PATH"]
  const brokerL = AccountBrokerLayer.fromSql(
    dbOverride !== undefined && dbOverride.length > 0
      ? { dbPath: dbOverride }
      : {},
  ).pipe(Layer.provide(secretL), Layer.provide(clockL))

  const sdkClientL = SDKClient.Default
  // Phase 9.5: SDKAdapter.WithBroker wires AccountBroker into the
  // per-query env overlay. SDKAdapter.Default ignores the broker —
  // we MUST use WithBroker for rotation to take effect (§0.2).
  const sdkAdapterL = Layer.provideMerge(
    SDKAdapter.WithBroker,
    Layer.mergeAll(sdkClientL, storeL, brokerL),
  )
  const chatL = Layer.provideMerge(
    ChatService.Default,
    Layer.mergeAll(sdkAdapterL, storeL, clockL, obsL),
  )
  return Layer.mergeAll(
    uiL,
    obsL,
    clockL,
    storeL,
    brokerL,
    sdkAdapterL,
    chatL,
  )
})()

class ServerHandle extends Effect.Tag("dev/ChatServerHandle")<
  ServerHandle,
  { readonly port: number; readonly host: string }
>() {}

// Server reads ChatService from its env, then passes the resolved
// service handle to startUIWebSocketServer via config. This keeps the
// server effect's requirements narrow (it doesn't itself depend on
// ChatService — just receives the handle).
//
// Phase 30: also pull in MemoryToolsService and wrap chat.createThread
// so every new thread gets the memory MCP server registered + the
// system-prompt addendum appended. Wrapping at this seam (vs extending
// ChatService.CreateThreadOptions) is additive — no other call sites
// need to change.
const serverLayer = Layer.scoped(
  ServerHandle,
  Effect.gen(function* () {
    const chat = yield* ChatService
    const memTools = yield* MemoryToolsService

    const chatWithMemory: typeof chat = {
      ...chat,
      createThread: (opts) => {
        const mergedSystemPrompt =
          opts.systemPrompt !== undefined
            ? `${opts.systemPrompt}\n\n${memTools.systemPromptAddendum}`
            : memTools.systemPromptAddendum
        const mergedMcp = {
          ...(opts.mcpServers ?? {}),
          [memTools.serverName]: memTools.server,
        }
        return chat.createThread({
          ...opts,
          systemPrompt: mergedSystemPrompt,
          mcpServers: mergedMcp,
        })
      },
    }

    return yield* startUIWebSocketServer({
      port: 4753,
      token: TOKEN,
      advertisedKinds: DEFAULT_UI_KINDS,
      pingIntervalMs: 5000,
      chatService: chatWithMemory,
    })
  }),
).pipe(
  Layer.provide(MemoryToolsLayer()),
  Layer.provide(baseLayer),
)

const runtime = ManagedRuntime.make(Layer.mergeAll(serverLayer, baseLayer))

const SEED_HINT =
  "  bun run --filter '@luna/agent-cli' luna-account add \\\n" +
  "    --id sterling --label \"Sterling\" --kind anthropic \\\n" +
  "    --secret-ref op://VAULT/ITEM/FIELD"

const main = Effect.gen(function* () {
  // Operator-visible boot log: how many accounts hydrated, by kind.
  // Resolves nothing; just inspects the in-memory broker pool.
  const broker = yield* AccountBroker
  const accounts = yield* broker._inspect()
  if (accounts.length === 0) {
    console.error(
      "❌ ConfigError: no accounts seeded. Run the agent-cli to add one:\n\n" +
        SEED_HINT +
        "\n\nThen restart this server. (CLI inserts require a restart.)",
    )
    return yield* Effect.fail(
      new Error("no accounts seeded — see seed-CLI hint above"),
    )
  }
  const counts = new Map<string, number>()
  for (const a of accounts) {
    counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1)
  }
  const breakdown = Array.from(counts.entries())
    .map(([k, n]) => `${k}×${n}`)
    .join(", ")
  console.log(`[accounts] ${accounts.length} hydrated: ${breakdown}`)

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
//
// 1Password resolution failures surface lazily on the first
// acquireSession (the OnePasswordBackend resolves on demand, by
// design). When that happens, the broker emits a ConfigError into the
// SDKAdapter's error channel; the user-facing symptom is a ws-side
// error rather than a boot crash. Hint to set OP_SERVICE_ACCOUNT_TOKEN
// (preferred — headless service account) or run `op signin` (interactive
// fallback) if chat queries fail with a ConfigError tagged
// `OnePasswordSecretProvider`.
runtime.runPromise(main).catch((err) => {
  const msg = String(err)
  console.error("❌ chat server crashed:", err)
  if (msg.includes("OnePasswordSecretProvider") || msg.includes("'op'")) {
    console.error(
      "   hint: 1Password CLI not authenticated. Set " +
        "OP_SERVICE_ACCOUNT_TOKEN in this shell (preferred) or run " +
        "`op signin` for interactive use, then restart.",
    )
  }
  process.exit(1)
})
