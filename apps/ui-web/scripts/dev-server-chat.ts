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
 * Token resolution chain (§2.2.11), Phase 25c:
 *   1. OP env-var layer — if `OP_SERVICE_ACCOUNT_TOKEN` is set, build
 *      an OnePasswordSecretProvider with it (preserves existing dev
 *      workflow for shells that already export the token).
 *   2. OP keychain layers — one per entry in OP_ACCOUNTS, each reading
 *      its token from the macOS keychain at boot. Missing keychain
 *      entries are non-fatal (the layer is simply skipped).
 *   3. EnvSecretProvider — fallback for `env:VARNAME` pointers (legacy).
 *
 * Each 1Password service-account token sees only its own account's
 * vaults, so `secretProviderFirstOf` IS the routing: wrong-token
 * attempts fail with ConfigError and fall through to the next provider.
 *
 * # Account Setup
 *
 * Before first run, seed at least one anthropic-kind account:
 *
 *   bun run --filter '@luna/agent-cli' luna-account add \
 *     --id sterling --label "Sterling" --kind anthropic \
 *     --secret-ref op://cdtygwycj55n4ewcnobycow7tu/eqvivujwp6ahevhkdao2vte35a/credential
 *
 * Then verify:
 *
 *   bun run --filter '@luna/agent-cli' luna-account list
 *
 * Pointer format (`secret_ref` column):
 *   - `op://<vault-uuid-or-name>/<item-uuid-or-name>/<field>` — 1Password
 *   - `env:<VARNAME>` — process env (legacy escape hatch)
 *
 * ## macOS Keychain entries (Phase 25c)
 *
 * For multi-account 1Password support, store each service-account
 * token in the macOS keychain. Add an entry with:
 *
 *   security add-generic-password -U \
 *     -s luna.op.<label> -a <label> -w '<ops_-prefixed-token>'
 *
 * The three labels this server reads (in priority order):
 *   - `luna.op.antmachine` / `antmachine`
 *   - `luna.op.mrbot`      / `mrbot`
 *   - `luna.op.flow`       / `flow`
 *
 * Missing entries are non-fatal — the layer is skipped and the boot
 * log lists only the labels that contributed.
 *
 * Entries are user-scoped: same-user reads do not prompt. Cross-user
 * or launchd-as-different-user execution would require additional ACL
 * setup (e.g. `-T <bun-binary>` at add-time, or "Always Allow" on
 * first prompt). That is out of scope for the dev rig.
 *
 * The `OP_SERVICE_ACCOUNT_TOKEN` env var still works as a fallback
 * (and takes priority over the keychain entries when set).
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
import { Effect, Layer, ManagedRuntime, Option } from "effect"
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
  readKeychainToken,
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

// ── Multi-account 1Password bootstrap (Phase 25c) ───────────────────────
//
// Hardcoded list of OP service-account tokens to try, in priority order.
// Each entry maps to a macOS keychain item. Missing entries are
// non-fatal — the layer is simply skipped and the boot log lists only
// the labels that contributed.
//
// Add a new entry with:
//   security add-generic-password -U \
//     -s luna.op.<label> -a <label> -w '<ops_-prefixed-token>'
const OP_ACCOUNTS = [
  { label: "antmachine", keychainService: "luna.op.antmachine", keychainAccount: "antmachine" },
  { label: "mrbot",      keychainService: "luna.op.mrbot",      keychainAccount: "mrbot" },
  { label: "flow",       keychainService: "luna.op.flow",       keychainAccount: "flow" },
] as const

interface DiscoveredOpToken {
  readonly label: string
  readonly token: string
}

/**
 * Resolve every OP token we can find: env first (preserves the
 * existing dev workflow), then each keychain entry in priority order.
 * Missing keychain entries are non-fatal — they yield None and are
 * filtered out before composition.
 */
const discoverOpTokens: Effect.Effect<ReadonlyArray<DiscoveredOpToken>> =
  Effect.gen(function* () {
    const found: Array<DiscoveredOpToken> = []
    const envTok = process.env["OP_SERVICE_ACCOUNT_TOKEN"]
    if (envTok !== undefined && envTok.length > 0) {
      found.push({ label: "env", token: envTok })
    }
    for (const acct of OP_ACCOUNTS) {
      const result = yield* readKeychainToken({
        service: acct.keychainService,
        account: acct.keychainAccount,
      }).pipe(Effect.option)
      if (Option.isSome(result)) {
        found.push({ label: acct.label, token: result.value })
      }
    }
    return found
  })

// ── Layer wiring ────────────────────────────────────────────────────────
//
// Phase 25b: SecretProvider chain (1Password → env) feeds AccountBroker
// (SQL-hydrated from ~/.luna/luna.db). The broker is a Layer requirement
// of SDKAdapter (Phase 9.5) — providing it here causes acquireSession()
// to overlay the per-query Claude OAuth token automatically. No env-var
// bail; no plaintext token in this process beyond a short-lived
// Redacted<string> at acquire time.
//
// Phase 25c: the SecretProvider chain now contains N OnePasswordSecret-
// Provider layers (one per discovered token) ahead of the legacy
// EnvSecretProvider for `env:VARNAME` refs. Each OP token sees only its
// own account's vaults, so `firstOf` IS the multi-account routing —
// wrong-token attempts fail with ConfigError and fall through cleanly.
const buildBaseLayer = (
  opTokens: ReadonlyArray<DiscoveredOpToken>,
): Layer.Layer<
  | UIService
  | ObservabilityService
  | Clock
  | SessionStore
  | AccountBroker
  | SDKAdapter
  | ChatService
> => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  const storeL = SessionStore.Default

  // One OnePasswordSecretProvider layer per discovered token. The
  // `vault` field is purely diagnostic — `op read` is driven by the
  // ref string itself; the token determines which account's vaults
  // are visible.
  const opLayers = opTokens.map((t) =>
    OnePasswordSecretProvider.make({
      vault: `${OP_VAULT} (${t.label})`,
      token: t.token,
    }).pipe(Layer.provide(clockL)),
  )
  const envProviderL = EnvSecretProvider.Default
  const secretL = secretProviderFirstOf([...opLayers, envProviderL])

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
}

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
const buildServerLayer = (
  baseLayer: ReturnType<typeof buildBaseLayer>,
): Layer.Layer<ServerHandle> =>
  Layer.scoped(
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
  ) as Layer.Layer<ServerHandle>

const SEED_HINT =
  "  bun run --filter '@luna/agent-cli' luna-account add \\\n" +
  "    --id sterling --label \"Sterling\" --kind anthropic \\\n" +
  "    --secret-ref op://cdtygwycj55n4ewcnobycow7tu/eqvivujwp6ahevhkdao2vte35a/credential"

const buildMain = (): Effect.Effect<
  never,
  Error,
  AccountBroker | ServerHandle
> =>
  Effect.gen(function* () {
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

// Bootstrap: discover OP tokens (env + keychain) BEFORE building the
// runtime, so the SecretProvider chain is composed with all available
// providers up front. Keychain reads are <100ms and one-shot; we accept
// the synchronous-feeling startup latency.
const bootstrap = async (): Promise<void> => {
  const opTokens = await Effect.runPromise(discoverOpTokens)
  // Log the OP provider count + LABELS up front (never the tokens) so
  // operators see the chain composition even if downstream layers
  // (e.g. AccountBroker) fail later in boot.
  if (opTokens.length === 0) {
    console.log(
      `[op] 0 providers active — no OP_SERVICE_ACCOUNT_TOKEN env and no keychain entries found`,
    )
  } else {
    console.log(
      `[op] ${opTokens.length} providers active: ${opTokens
        .map((t) => t.label)
        .join(", ")}`,
    )
  }
  const baseLayer = buildBaseLayer(opTokens)
  const serverLayer = buildServerLayer(baseLayer)
  const runtime = ManagedRuntime.make(Layer.mergeAll(serverLayer, baseLayer))

  process.on("SIGINT", () => {
    console.log("\n👋 shutting down")
    void runtime.dispose().then(() => process.exit(0))
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
  // (preferred — headless service account) or add a `luna.op.<label>`
  // keychain entry if chat queries fail with a ConfigError tagged
  // `OnePasswordSecretProvider`.
  runtime.runPromise(buildMain()).catch((err) => {
    const msg = String(err)
    console.error("❌ chat server crashed:", err)
    if (msg.includes("OnePasswordSecretProvider") || msg.includes("'op'")) {
      console.error(
        "   hint: 1Password CLI not authenticated. Set " +
          "OP_SERVICE_ACCOUNT_TOKEN in this shell, add a luna.op.<label> " +
          "keychain entry, or run `op signin` for interactive use, then restart.",
      )
    }
    process.exit(1)
  })
}

void bootstrap()
