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
 *   bun run --filter '@luna/ui-web' server:chat
 *
 * Phase 25b: this script is the first production caller of
 * AccountBroker. The Claude OAuth token is no longer pulled from
 * `CLAUDE_CODE_OAUTH_TOKEN` — instead, accounts seeded into
 * `~/.luna/luna.db` (§5.1 `accounts` table) hydrate at boot and the
 * SDKAdapter overlays the resolved token per-query (§0.2 rotation).
 *
 * Token resolution chain (DESIGN.md §2.2.11), Phase 25d:
 *   1. RoutedOpSecretProvider — wraps N single-account OnePassword
 *      backends, one per `luna.op.<label>` keychain entry found at
 *      boot. Refs are dispatched explicitly:
 *        op://<rest>                    only if exactly 1 account is
 *                                       registered (otherwise hard fail)
 *        luna-op://<label>/<rest>       routed only to <label>; no
 *                                       fall-through to other accounts
 *      Errors from a luna-op://<label>/... resolution are wrapped to
 *      include "(account=<label>)" — tokens never appear in messages.
 *   2. EnvSecretProvider — for `env:VARNAME` pointers (one colon).
 *
 * The 25c "iterate every OP token" composition is **superseded** by
 * this explicit routing (see HANDOFF.md drift note for 2026-04-28).
 * `OP_SERVICE_ACCOUNT_TOKEN` env-var fallback is dropped — keychain
 * is the single source of truth for service-account tokens.
 *
 * # Account Setup
 *
 * Before first run, seed at least one anthropic-kind account:
 *
 *   bun run --filter '@luna/agent-cli' luna-account add \
 *     --id default --label "Default" --kind anthropic \
 *     --secret-ref claude-code:login
 *
 * Then verify:
 *
 *   bun run --filter '@luna/agent-cli' luna-account list
 *
 * Pointer format (`secret_ref` column, DESIGN.md §2.2.11):
 *   - `op://<vault>/<item>/<field>` — 1Password (only when exactly 1
 *     OP account is registered; else hard fail)
 *   - `luna-op://<label>/<vault>/<item>/<field>` — explicit-account
 *     1Password routing
 *   - `env:<VARNAME>` — process env (one colon, no slashes)
 *   - `claude-code:login` — use the OAuth login in CLAUDE_CONFIG_DIR
 *
 * Examples (with primary + ops registered in keychain):
 *   - luna-op://primary/<vault-id>/<item-id>/credential
 *   - luna-op://ops/<vault>/<item>/<field>
 *
 * ## macOS Keychain entries (Phase 25c)
 *
 * For multi-account 1Password support, store each service-account
 * token in the macOS keychain. Add an entry with:
 *
 *   security add-generic-password -U \
 *     -s luna.op.<label> -a <label> -w '<ops_-prefixed-token>'
 *
 * Configure the labels this server reads with:
 *
 *   LUNA_OP_ACCOUNTS=primary,ops
 *
 * Each plain label maps to `luna.op.<label>` / `<label>`. For custom
 * keychain names, use:
 *
 *   LUNA_OP_ACCOUNTS=primary:com.example.luna.primary:svc-primary
 *
 * Missing entries are non-fatal — the layer is skipped and the boot
 * log lists only the labels that contributed.
 *
 * Entries are user-scoped: same-user reads do not prompt. Cross-user
 * or launchd-as-different-user execution would require additional ACL
 * setup (e.g. `-T <bun-binary>` at add-time, or "Always Allow" on
 * first prompt). That is out of scope for the dev rig.
 *
 * `OP_SERVICE_ACCOUNT_TOKEN` env-var fallback is no longer honored
 * (Phase 25d) — keychain is the single source of truth.
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
import { existsSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  applyRuntimePathEnvDefaults,
  resolveRuntimePaths,
} from "./runtime-paths.js"

// Load Luna's runtime .env before anything else so CLAUDE_CONFIG_DIR (and any
// other Luna env vars) are in process.env when the SDK initialises. LUNA_HOME
// makes the runtime portable; the default remains ~/.luna.
{
  const lunaEnv = resolveRuntimePaths().envFilePath
  if (existsSync(lunaEnv)) {
    for (const line of readFileSync(lunaEnv, "utf8").split("\n")) {
      const trimmed = line.trim()
      if (trimmed === "" || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1).trim()
      if (key && !(key in process.env)) process.env[key] = value
    }
  }
  applyRuntimePathEnvDefaults(resolveRuntimePaths())
}
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import {
  AccountBroker,
  AccountBrokerLayer,
  AgentNotesService,
  Clock,
  DEFAULT_UI_KINDS,
  EnvSecretProvider,
  NoopTracerLayer,
  ObservabilityService,
  OnePasswordSecretProvider,
  RoutedOpSecretProvider,
  SessionStore,
  TelemetryPlatform,
  TelemetryService,
  UIService,
  makeDuckDbLayer,
  makeTelemetrySqlite,
  readKeychainToken,
  secretProviderFirstOf,
  validateAccountsTableLabels,
} from "@luna/core"
import { loadDna } from "./dna-loader.js"
import { buildSessionMetadata } from "./runtime-metadata.js"
import {
  attachSandboxLocalShell,
  resolveSandboxLocalShell,
} from "./sandbox-local-shell.js"
export { loadDna } from "./dna-loader.js"
import { SDKAdapter, SDKClient } from "@luna/adapter-sdk"
import { ChatService } from "@luna/chat-service"
import { createLocalShellBridge, startUIWebSocketServer } from "@luna/ui-ws"
import { LunaSqliteBootstrapLive } from "@luna/memory"
import {
  MemoryToolsLayer,
  MemoryToolsService,
} from "@luna/memory-tools"
import {
  SchedulerToolsLayer,
  SchedulerToolsService,
} from "@luna/scheduler-tools"
import {
  ObsToolsLayer,
  ObsToolsService,
} from "@luna/observability-tools"
import {
  LocalShellToolsLayer,
  LocalShellToolsService,
} from "@luna/local-shell-tools"
import { startControlServer } from "@luna/control-server"
import { resolveOpAccounts } from "./op-accounts.js"
import { resolveUiWsToken } from "./ui-ws-token.js"

const TOKEN = resolveUiWsToken()
const BIND_HOST = process.env["LUNA_UI_WS_HOST"]?.trim() || undefined
const localShellBridge = createLocalShellBridge()

// ── Multi-account 1Password bootstrap (Phase 25c) ───────────────────────
//
// Operators opt in via LUNA_OP_ACCOUNTS. Each entry maps to a macOS
// keychain item. Missing entries are non-fatal — the layer is simply
// skipped and the boot log lists only the labels that contributed.
//
// Add a new entry with:
//   security add-generic-password -U \
//     -s luna.op.<label> -a <label> -w '<ops_-prefixed-token>'
const OP_ACCOUNTS = resolveOpAccounts()

interface DiscoveredOpToken {
  readonly label: string
  readonly token: string
}

/**
 * Resolve every OP token we can find from the macOS keychain.
 * Missing keychain entries are non-fatal — they yield None and are
 * filtered out before composition.
 *
 * Phase 25d: the OP_SERVICE_ACCOUNT_TOKEN env-var fallback is dropped.
 * Keychain is the single source of truth — using `env` as a label
 * would also collide with the reserved-label set in
 * RoutedOpSecretProvider.
 */
const discoverOpTokens: Effect.Effect<ReadonlyArray<DiscoveredOpToken>> =
  Effect.gen(function* () {
    const found: Array<DiscoveredOpToken> = []
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
// Phase 25d: SecretProvider chain is RoutedOpSecretProvider →
// EnvSecretProvider. Each registered OP account is a single-account
// OnePasswordSecretProvider built inline; the routed wrapper dispatches
// based on the ref scheme (op://, luna-op://<label>/...) per
// DESIGN.md §2.2.11. No fall-through across OP accounts.
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | any // TelemetryPlatform sinks + NoopTracerLayer + AgentNotesService are side-effect Layers
> => {
  const clockL = Clock.Default
  const paths = resolveRuntimePaths()
  const obsL = ObservabilityService.makeLayer({
    logToConsole: false,
    jsonlPath: paths.eventsJsonlPath,
  }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  const storeL = SessionStore.Default

  // Build one inner OP layer per discovered token, then wrap in the
  // routed dispatcher. The routed wrapper owns the op://-vs-luna-op://
  // grammar; the inner backends are pure 1Password readers.
  const routedAccounts = opTokens.map((t) => ({
    label: t.label,
    layer: OnePasswordSecretProvider.make({
      accountLabel: t.label,
      token: t.token,
    }).pipe(Layer.provide(clockL)),
  }))
  const routedOpL = RoutedOpSecretProvider.make({ accounts: routedAccounts })
  const envProviderL = EnvSecretProvider.Default
  const secretL = secretProviderFirstOf([routedOpL, envProviderL])

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
  // ── Self-observation platform (Phase 27b) ──────────────────────────────
  // TelemetryService: SQLite-backed counters so current counter state
  // survives restarts; MetricsFlusher snapshots them into analytics.duckdb.
  const telemetryL = makeTelemetrySqlite(paths.lunaDbPath).pipe(
    Layer.provide(clockL),
  )

  // DuckDbService: single connection to the analytics DB.
  // All writes are serialized through a bounded Queue.dropping fiber.
  const duckDbL = makeDuckDbLayer({ dbPath: paths.analyticsDbPath })

  // TelemetryPlatform: EventSink + SessionSync + MetricsFlusher, all wired
  // to the analytics DuckDB. Side-effect-only Layers — fire-and-forget.
  const telPlatformL = TelemetryPlatform.pipe(
    Layer.provide(Layer.mergeAll(obsL, duckDbL, telemetryL, clockL)),
  )

  // NoopTracerLayer: provides Tracer.Tracer as a no-op. Activates
  // Effect.withSpan() instrumentation without requiring @effect/opentelemetry
  // until M5. Structural only — no spans leave the process.
  const noopTracerL = NoopTracerLayer

  // AgentNotesService: SQLite-backed self-report stream. Shares luna.db
  // with AccountBroker + TelemetryService-sqlite (same file, separate tables).
  const agentNotesL = AgentNotesService.makeLayer(paths.lunaDbPath).pipe(
    Layer.provide(clockL),
    // LunaSqliteBootstrapLive provided at the bottom of buildServerLayer
    // (same pattern as all other SQLite layers in this server).
  )

  const chatL = Layer.provideMerge(
    ChatService.Default,
    Layer.mergeAll(sdkAdapterL, storeL, clockL, obsL, telemetryL),
  )

  return Layer.mergeAll(
    uiL,
    obsL,
    clockL,
    storeL,
    brokerL,
    sdkAdapterL,
    chatL,
    telPlatformL,
    noopTracerL,
    agentNotesL,
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
      const schedTools = yield* SchedulerToolsService
      const obsTools = yield* ObsToolsService
      const localShellTools = yield* LocalShellToolsService

      console.log("[luna/boot] MCP servers registered:", [
        memTools.serverName,
        schedTools.serverName,
        obsTools.serverName,
        localShellTools.serverName,
      ].join(", "))

      // Luna identity: load DNA.md at boot. This is Luna's "who am I, how
      // do I operate" prompt — prepended to every thread's systemPrompt so
      // Luna doesn't fall back to the underlying Claude model's default
      // identity (or, worse, leak Sol's identity from a stray ancestor
      // CLAUDE.md). Repo layout: this file is at
      // apps/ui-web/scripts/chat-server.ts → DNA.md is 3 levels up.
      // Read sync at Layer build (one-shot, fast, deterministic). If the
      // file is missing the boot fails loudly — that's correct: a Luna
      // boot without DNA.md is a misconfigured boot.
      const __scriptDir = dirname(fileURLToPath(import.meta.url))
      const dnaContent = loadDna(__scriptDir)

      // Session metadata injected into every thread so Luna knows which
      // runtime profile and server instance she is actually serving.
      const sessionMetadata = buildSessionMetadata()
      const sandboxLocalShell = resolveSandboxLocalShell()
      console.log(
        "[luna/boot] sandbox local shell:",
        sandboxLocalShell.enabled ? "enabled" : `disabled (${sandboxLocalShell.reason})`,
      )

      // Per-thread sandbox re-attach closures. The container sandbox owns
      // the local-shell slot at thread creation; an attached CLI with
      // --local-shell can take over (`replaceable: true`). When the CLI
      // releases (toggle off or disconnect), we re-run the original
      // attach so the agent doesn't lose local_shell access until /new.
      const sandboxReattachers = new Map<string, () => void>()
      const reattachSandbox = (threadId: string): void => {
        const reattach = sandboxReattachers.get(threadId)
        if (reattach !== undefined) reattach()
      }

      const chatWithTools: typeof chat = {
        ...chat,
        createThread: (opts) => {
          const memoryThreadTools = memTools.createSessionBinding()
          const schedulerThreadTools = schedTools.createSessionBinding()
          const obsThreadTools = obsTools.createSessionBinding()
          const localShellThreadTools = localShellTools.createSessionBinding()
          console.log("[luna/thread] createThread called — wiring MCP servers:", [
            memoryThreadTools.serverName,
            schedulerThreadTools.serverName,
            obsThreadTools.serverName,
            localShellThreadTools.serverName,
          ].join(", "))
          const mergedSystemPrompt = [
            dnaContent,
            sessionMetadata,
            opts.systemPrompt,
            memoryThreadTools.systemPromptAddendum,
            schedulerThreadTools.systemPromptAddendum,
            obsThreadTools.systemPromptAddendum,
            localShellThreadTools.systemPromptAddendum,
          ]
            .filter((s): s is string => typeof s === "string" && s.length > 0)
            .join("\n\n")
          const mergedMcp = {
            ...(opts.mcpServers ?? {}),
            [memoryThreadTools.serverName]: memoryThreadTools.server,
            [schedulerThreadTools.serverName]: schedulerThreadTools.server,
            [obsThreadTools.serverName]: obsThreadTools.server,
            [localShellThreadTools.serverName]: localShellThreadTools.server,
          }
          return chat
            .createThread({
              ...opts,
              systemPrompt: mergedSystemPrompt,
              mcpServers: mergedMcp,
            })
            .pipe(
              // Bind the new session id so obs_note auto-tags notes with the
              // current thread. SessionSummary.id is always present.
              Effect.tap((summary) => {
                obsThreadTools.bindSession(summary.id)
                localShellThreadTools.bindSession(summary.id)
                if (sandboxLocalShell.enabled) {
                  const reattach = () =>
                    attachSandboxLocalShell({
                      bridge: localShellBridge,
                      threadId: summary.id,
                      cwd: sandboxLocalShell.sandboxRoot,
                      sandboxRoot: sandboxLocalShell.sandboxRoot,
                      env: process.env,
                    })
                  reattach()
                  sandboxReattachers.set(summary.id, reattach)
                }
                console.log("[luna/thread] session bound:", summary.id, "— obs/local-shell tools active")
                return Effect.void
              }),
            )
        },
      }

      const broker = yield* AccountBroker

      // tRPC control server — port 4754, alongside the WebSocket server.
      // Exposes control.restart / control.status / control.version.
      yield* startControlServer(4754)

      return yield* startUIWebSocketServer({
        port: 4753,
        ...(BIND_HOST !== undefined ? { host: BIND_HOST } : {}),
        token: TOKEN,
        advertisedKinds: DEFAULT_UI_KINDS,
        pingIntervalMs: 5000,
        chatService: chatWithTools,
        accountBroker: broker,
        localShellBridge,
        onLocalShellRelease: reattachSandbox,
      })
    }),
  ).pipe(
    Layer.provide(MemoryToolsLayer()),
    Layer.provide(SchedulerToolsLayer()),
    Layer.provide(LocalShellToolsLayer({ bridge: localShellBridge })),
    // ObsToolsLayer provides ObsToolsService with 5 self-observation tools.
    // Requires Clock + LunaSqliteBootstrapLive (both provided below).
    Layer.provide(ObsToolsLayer()),
    Layer.provide(baseLayer),
    // Phase 27a: provide LunaSqliteBootstrapLive at the END of the chain
    // so it builds FIRST (Layer.provide is bottom-up — last listed wins
    // build order). Every store layer above declares LunaSqliteBootstrap
    // in its `R`, so this single line enforces the ordering: the
    // process-wide `Database.setCustomSQLite()` swap runs before the
    // very first `new Database()` in baseLayer/AccountBroker. Without
    // this, chat-server silently falls back to naive cosine ranking
    // (Phase 27 HNSW path dead) — see brief §0 for the original repro.
    Layer.provide(LunaSqliteBootstrapLive),
  ) as Layer.Layer<ServerHandle>

const SEED_HINT =
  "  bun run --filter '@luna/agent-cli' luna-account add \\\n" +
  "    --id default --label \"Default\" --kind anthropic \\\n" +
  "    --secret-ref claude-code:login"

const buildMain = (
  opLabelsRegistered: ReadonlyArray<string>,
): Effect.Effect<never, Error, AccountBroker | ServerHandle> =>
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

    // Phase 25d: warn on luna-op://<label>/... refs whose label is
    // not in the registered OP keychain set. Soft warning — operator
    // may add accounts later without rebooting.
    const refs = accounts.map((a) => a.secretRef)
    const dangling = validateAccountsTableLabels(refs, opLabelsRegistered)
    if (dangling.length > 0) {
      console.warn(`[op] dangling refs: ${dangling.length}`)
      for (const d of dangling) {
        console.warn(`  - ${d.ref} (label="${d.label}" not registered)`)
      }
    }

    const handle = yield* ServerHandle
    console.log(`✅ ui-ws chat server: ws://${handle.host}:${handle.port}/ui`)
    console.log(`🔑 token: configured`)
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
      `[op] 0 providers active — no luna.op.<label> keychain entries found`,
    )
  } else {
    console.log(
      `[op] ${opTokens.length} providers active: ${opTokens
        .map((t) => t.label)
        .join(", ")}`,
    )
  }
  const opLabelsRegistered = opTokens.map((t) => t.label)
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
  runtime.runPromise(buildMain(opLabelsRegistered)).catch((err) => {
    const msg = String(err)
    console.error("❌ chat server crashed:", err)
    if (msg.includes("OnePasswordSecretProvider") || msg.includes("'op'")) {
      console.error(
        "   hint: 1Password CLI not authenticated. Add a " +
          "luna.op.<label> keychain entry (see header comment) or run " +
          "`op signin` for interactive use, then restart.",
      )
    }
    process.exit(1)
  })
}

// Guard against running bootstrap when imported (e.g. from tests that
// import `loadDna`). `import.meta.main` is true only when this file is
// the direct entry point (bun run chat-server.ts).
if (import.meta.main) {
  void bootstrap()
}
