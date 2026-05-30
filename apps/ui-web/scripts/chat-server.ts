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
import { existsSync, readFileSync, writeSync } from "node:fs"
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
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect"
import {
  AccountBroker,
  AccountBrokerLayer,
  AgentNotesService,
  AlignmentStore,
  BELIEF_KIND,
  BELIEF_NAMESPACE,
  BeliefWriter,
  Clock,
  DEFAULT_UI_KINDS,
  DreamCronLayer,
  DreamStore,
  EnvSecretProvider,
  NoopTracerLayer,
  ObservabilityService,
  OnePasswordSecretProvider,
  RoutedOpSecretProvider,
  SessionStore,
  Survey,
  TelemetryPlatform,
  TelemetryService,
  UIService,
  composeBeliefsSection,
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
import { DreamReasonerDefault, SDKAdapter, SDKClient } from "@luna/adapter-sdk"
import {
  ChatService,
  ThreadToolsProviderTag,
  type ThreadToolsProvider,
} from "@luna/chat-service"
import { createLocalShellBridge, startUIWebSocketServer } from "@luna/ui-ws"
import { LunaSqliteBootstrapLive, MemoryRouterTag } from "@luna/memory"
import {
  MemoryRouterLayer,
  MemoryToolsLayer,
  MemoryToolsService,
  resolveDbPath,
  selectEmbedderLayer,
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
import { decideMode, probeCredentialReadiness, probeAuthLoggedIn } from "./credential-readiness.js"
import { spawnSetupPty } from "./setup-pty.js"
import { onLoginAttemptComplete } from "./setup-login.js"
import type { PtyOutputFrame } from "@luna/ui-ws"

const TOKEN = resolveUiWsToken()
const BIND_HOST = process.env["LUNA_UI_WS_HOST"]?.trim() || undefined
const localShellBridge = createLocalShellBridge()

// Per-thread sandbox re-attach closures. Module scope (single-process boot)
// so both the ThreadToolsProvider (which registers a reattacher in onBound)
// and the WS server (which calls it via onLocalShellRelease) can share it.
// The container sandbox owns the local-shell slot at thread creation; an
// attached CLI with --local-shell takes over (`replaceable: true`); when it
// releases, we re-run the original attach so the agent keeps local_shell.
const sandboxReattachers = new Map<string, () => void>()
const reattachSandbox = (threadId: string): void => {
  const reattach = sandboxReattachers.get(threadId)
  if (reattach !== undefined) reattach()
}

/** How often the belief-injection holder refreshes from the MemoryRouter (ms).
 *  30 s in production; callers may pass a smaller value for smoke tests. */
const BELIEF_REFRESH_INTERVAL_MS = 30_000

/**
 * ThreadToolsProviderLayer — the single source of per-thread tool wiring.
 *
 * Provides `ThreadToolsProviderTag`, which ChatService applies to EVERY
 * thread creation (new threads AND subscribe()-restart-recovery resumes).
 * This replaces the old `chatWithTools` createThread wrapper, which only
 * intercepted the public createThread and so left resumed threads tool-less.
 *
 * `decorate(opts)` builds fresh per-session MCP bindings, the merged system
 * prompt (DNA + runtime metadata + tool addenda + caller prompt), and an
 * onBound callback that binds the session id into obs/local-shell tools and
 * (when enabled) attaches the sandbox local-shell + registers its reattacher.
 *
 * @param refreshIntervalMs - how often to re-query active beliefs (default
 *   BELIEF_REFRESH_INTERVAL_MS = 30 s). Pass a small value in smoke tests.
 */
export const ThreadToolsProviderLayer = (refreshIntervalMs: number = BELIEF_REFRESH_INTERVAL_MS) =>
  Layer.scoped(
    ThreadToolsProviderTag,
    Effect.gen(function* () {
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

      // Luna identity: load DNA.md at boot (prepended to every thread's
      // system prompt so Luna keeps her identity instead of falling back to
      // the underlying model's default). Missing file → loud boot failure.
      // Repo layout: this file is at
      // apps/ui-web/scripts/chat-server.ts → DNA.md is 3 levels up.
      const __scriptDir = dirname(fileURLToPath(import.meta.url))
      const dnaContent = loadDna(__scriptDir)
      const sessionMetadata = buildSessionMetadata()
      const sandboxLocalShell = resolveSandboxLocalShell()
      console.log(
        "[luna/boot] sandbox local shell:",
        sandboxLocalShell.enabled
          ? "enabled"
          : `disabled (${sandboxLocalShell.reason})`,
      )

      // Phase 3 D5 → T3b: live belief-injection refresh holder.
      //
      // decorate() is SYNCHRONOUS (chat-service/src/types.ts — decorate
      // returns a value, cannot yield/await). We keep the sync read via a
      // plain mutable closure variable that a background fiber refreshes.
      //
      // Design:
      //   - `let beliefsContent = ""` — the holder; decorate() reads it
      //     directly (safe: JS is single-threaded, no torn reads).
      //   - `refreshBeliefs` queries MemoryRouter, renders the section,
      //     and assigns `beliefsContent = rendered` (closes over the `let`).
      //   - Run refreshBeliefs ONCE at boot (correct from t=0).
      //   - Fork a supervised loop: sleep(interval) → refreshBeliefs, forever.
      //     forkScoped ties the fiber to THIS layer's Scope (Layer.scoped
      //     provides the Scope; it is interrupted on layer release — no
      //     unmanaged/leaked fiber). Layer.scoped is required; Layer.effect
      //     does not supply a Scope and forkScoped would fail to build.
      //
      // Net: a belief activated by a survey appears in the NEXT thread
      // WITHOUT a server restart (within ~refreshIntervalMs, default 30s).
      const mem = yield* MemoryRouterTag

      // Plain mutable holder — read synchronously by decorate().
      let beliefsContent = ""

      // Effect that re-queries and re-renders the active beliefs section.
      const refreshBeliefs = Effect.gen(function* () {
        const chunk = yield* mem
          .query({ namespace: BELIEF_NAMESPACE, kind: BELIEF_KIND })
          .pipe(Stream.runCollect)
        const records = Array.from(chunk)
        beliefsContent = composeBeliefsSection(records, Date.now())
        console.log(
          "[luna/beliefs] refreshed:",
          records.filter(
            (r) => (r.content as { status?: string }).status === "active",
          ).length,
          "active belief(s)",
        )
      })

      // Boot: run once so the holder is populated before any thread starts.
      yield* refreshBeliefs

      // Fork the refresh loop into the layer scope — supervised, cleaned
      // up when the layer releases. No bare Effect.runFork (would leak).
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(refreshIntervalMs).pipe(Effect.zipRight(refreshBeliefs)),
        ),
      )

      const provider: ThreadToolsProvider = {
        decorate: (opts) => {
          const memoryThreadTools = memTools.createSessionBinding()
          const schedulerThreadTools = schedTools.createSessionBinding()
          const obsThreadTools = obsTools.createSessionBinding()
          const localShellThreadTools = localShellTools.createSessionBinding()
          console.log(
            "[luna/thread] wiring MCP servers:",
            [
              memoryThreadTools.serverName,
              schedulerThreadTools.serverName,
              obsThreadTools.serverName,
              localShellThreadTools.serverName,
            ].join(", "),
          )
          // Sync read of the live-refresh holder — refreshed every
          // refreshIntervalMs by the background fiber above. Returns "" when
          // no active beliefs (the .filter(length>0) below drops it cleanly).
          const systemPrompt = [
            dnaContent,
            sessionMetadata,
            beliefsContent, // Phase 3 D5: ranked active beliefs section
            opts.systemPrompt,
            memoryThreadTools.systemPromptAddendum,
            schedulerThreadTools.systemPromptAddendum,
            obsThreadTools.systemPromptAddendum,
            localShellThreadTools.systemPromptAddendum,
          ]
            .filter((s): s is string => typeof s === "string" && s.length > 0)
            .join("\n\n")
          const mcpServers = {
            ...(opts.mcpServers ?? {}),
            [memoryThreadTools.serverName]: memoryThreadTools.server,
            [schedulerThreadTools.serverName]: schedulerThreadTools.server,
            [obsThreadTools.serverName]: obsThreadTools.server,
            [localShellThreadTools.serverName]: localShellThreadTools.server,
          }
          return {
            mcpServers,
            systemPrompt,
            onBound: (sessionId: string) => {
              obsThreadTools.bindSession(sessionId)
              localShellThreadTools.bindSession(sessionId)
              if (sandboxLocalShell.enabled) {
                const reattach = () =>
                  attachSandboxLocalShell({
                    bridge: localShellBridge,
                    threadId: sessionId,
                    cwd: sandboxLocalShell.sandboxRoot,
                    sandboxRoot: sandboxLocalShell.sandboxRoot,
                    env: process.env,
                  })
                reattach()
                sandboxReattachers.set(sessionId, reattach)
              }
              console.log(
                "[luna/thread] session bound:",
                sessionId,
                "— obs/local-shell tools active",
              )
            },
          }
        },
      }
      return provider
    }),
  ).pipe(
    Layer.provide(MemoryToolsLayer()),
    Layer.provide(SchedulerToolsLayer()),
    Layer.provide(LocalShellToolsLayer({ bridge: localShellBridge })),
    Layer.provide(ObsToolsLayer()),
  )

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

// ── Dream cron sub-layer factory (exported for boot smoke) ──────────────
//
// Phase 3 D1: exported so the boot smoke can import THIS symbol and verify
// the real wiring shape — NOT a hand-copied mirror. The smoke uses node-
// runnable doubles (DreamStore.Memory, FakeMemoryRouter, SessionStore.Default,
// SDKClient.fake, Clock.Default) while keeping DreamReasonerDefault (real)
// so the SDKClient+MemoryRouter requirements are preserved in the proof.
//
// DreamReasonerDefault requires BOTH SDKClient AND MemoryRouter (it closes
// over both at build time so reason()'s R channel is never).
export interface BuildDreamCronLayerOpts {
  readonly expr: string
  readonly sdkClientL: Layer.Layer<SDKClient>
  readonly memoryRouterL: Layer.Layer<import("@luna/memory").MemoryRouter>
  readonly storeL: Layer.Layer<SessionStore>
  readonly clockL: Layer.Layer<Clock>
  /**
   * DreamStore layer to use. The live boot passes
   * `DreamStore.makeLayer(paths.lunaDbPath).pipe(Layer.provide(clockL))`
   * (which requires LunaSqliteBootstrap, satisfied at the bottom of
   * buildServerLayer). The boot smoke passes `DreamStore.Memory` (no SQLite
   * needed) to keep the smoke node-runnable.
   */
  readonly dreamStoreL: Layer.Layer<DreamStore>
}

export const buildDreamCronLayer = (opts: BuildDreamCronLayerOpts) => {
  const { expr, sdkClientL, memoryRouterL, storeL, clockL, dreamStoreL } = opts
  // DreamReasonerDefault requires BOTH SDKClient AND MemoryRouter (closes over
  // both at build time so reason()'s R channel is never). SDKClient is the real
  // dependency this smoke proves is satisfiable — SDKClient.fake keeps it real
  // while making zero model calls.
  const dreamReasonerL = DreamReasonerDefault.pipe(
    Layer.provide(sdkClientL),
    Layer.provide(memoryRouterL),
  )
  return DreamCronLayer(expr).pipe(
    Layer.provide(dreamStoreL),
    Layer.provide(dreamReasonerL),
    Layer.provide(storeL),
    Layer.provide(memoryRouterL),
    Layer.provide(clockL),
  )
}

// ── Survey sub-layer factory (exported for boot smoke) ──────────────────
//
// Phase 3 D3: exported so the boot smoke can import THIS symbol and verify
// the real wiring shape. Mirrors buildDreamCronLayer's shape exactly.
//
// Survey.Default requires AlignmentStore + BeliefWriter + Clock + MemoryRouter.
// BeliefWriter.Default requires MemoryRouter + Clock.
// AlignmentStore.makeLayer(dbPath) requires Clock + LunaSqliteBootstrap.
//
// The smoke passes AlignmentStore.Memory (no SQLite) + a Ref-backed FakeMemory
// MemoryRouter while keeping the real Survey.Default so the real dep graph is
// proven composable. `as never` on the Memory double sidesteps the param-type
// narrowing (same pattern as dream-cron-boot.smoke.ts).
export interface BuildSurveyLayerOpts {
  readonly alignmentStoreL: Layer.Layer<AlignmentStore, import("effect").ConfigError, Clock | import("@luna/memory").LunaSqliteBootstrap>
  readonly beliefWriterL: Layer.Layer<BeliefWriter, import("effect").ConfigError, import("@luna/memory").LunaSqliteBootstrap>
  readonly memoryRouterL: Layer.Layer<import("@luna/memory").MemoryRouter, import("effect").ConfigError, import("@luna/memory").LunaSqliteBootstrap>
  readonly clockL: Layer.Layer<Clock>
}

export const buildSurveyLayer = (opts: BuildSurveyLayerOpts) =>
  Survey.Default.pipe(
    Layer.provide(opts.alignmentStoreL),
    Layer.provide(opts.beliefWriterL),
    Layer.provide(opts.memoryRouterL),
    Layer.provide(opts.clockL),
  )

// ── Layer wiring ────────────────────────────────────────────────────────
//
// Phase 25d: SecretProvider chain is RoutedOpSecretProvider →
// EnvSecretProvider. Each registered OP account is a single-account
// OnePasswordSecretProvider built inline; the routed wrapper dispatches
// based on the ref scheme (op://, luna-op://<label>/...) per
// DESIGN.md §2.2.11. No fall-through across OP accounts.
export const buildBaseLayer = (
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

  // MemoryRouter for ChatService.searchMemory (the WS-mediated context
  // panel). ChatService.Default `yield*`s MemoryRouterTag, so the router
  // MUST be in its layer graph or the runtime build fails at boot — which
  // takes down the whole chatWithTools wiring (every MCP tool with it).
  // Point it at the same db path the memory MCP tools use (resolveDbPath /
  // LUNA_MEMORY_DB) so the panel reads the rows the agent persists.
  // LunaSqliteBootstrap stays in R and is satisfied at the bottom of
  // buildServerLayer, same as every other SQLite-backed layer here.
  const memoryRouterL = MemoryRouterLayer(resolveDbPath()).pipe(
    Layer.provide(selectEmbedderLayer()),
    Layer.provide(obsL),
    Layer.provide(clockL),
  )

  // Per-thread tool wiring, provided INTO ChatService so both new and
  // resumed threads get tools (the resume path bypasses any outer wrapper).
  // LunaSqliteBootstrap flows up and is satisfied at the bottom of
  // buildServerLayer, same as every other SQLite-backed layer here.
  const threadToolsL = ThreadToolsProviderLayer().pipe(
    Layer.provide(memoryRouterL), // REQUIRED: satisfies MemoryRouterTag inside the layer (siblings don't cross-wire)
    Layer.provide(obsL),
    Layer.provide(clockL),
  )

  // Phase 3 D1: nightly Dream cron. DreamCronLayer provides its OWN
  // JobScheduler+TriggerAgent (a second instance — harmless, like memoryRouterL).
  // DreamReasonerDefault (from adapter-sdk) requires both SDKClient + MemoryRouter;
  // we close over the boot's sdkClientL + memoryRouterL. DreamStore uses luna.db.
  // LunaSqliteBootstrap is satisfied at the bottom of buildServerLayer, same as
  // every other SQLite-backed layer here.
  const dreamStoreL = DreamStore.makeLayer(paths.lunaDbPath).pipe(Layer.provide(clockL))
  const dreamCronL = buildDreamCronLayer({
    expr: "0 3 * * *",
    sdkClientL,
    memoryRouterL,
    storeL,
    clockL,
    dreamStoreL,
  })

  // Phase 3 D3: Survey layer for the WS-mediated check-in. AlignmentStore and
  // BeliefWriter both use memoryRouterL + clockL from the same boot identities
  // (so survey-activated beliefs + D5 injection read the SAME router).
  // LunaSqliteBootstrap satisfied at the bottom of buildServerLayer, same as
  // every other SQLite-backed layer here.
  const alignmentStoreL = AlignmentStore.makeLayer(paths.lunaDbPath).pipe(Layer.provide(clockL))
  const beliefWriterL = BeliefWriter.Default.pipe(Layer.provide(memoryRouterL), Layer.provide(clockL))
  const surveyL = buildSurveyLayer({ alignmentStoreL, beliefWriterL, memoryRouterL, clockL })

  const chatL = Layer.provideMerge(
    ChatService.Default,
    Layer.mergeAll(
      sdkAdapterL,
      storeL,
      clockL,
      obsL,
      telemetryL,
      memoryRouterL,
      threadToolsL,
    ),
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
    dreamCronL, // Phase 3 D1: forces the cron to register at boot
    surveyL,    // Phase 3 D3: Survey available for buildServerLayer to resolve + pass to the WS server
  )
}

class ServerHandle extends Effect.Tag("dev/ChatServerHandle")<
  ServerHandle,
  { readonly port: number; readonly host: string }
>() {}

// ── Graceful shutdown helper ─────────────────────────────────────────────
//
// Factored out so both normal-mode and setup-mode boots share the same
// SIGINT/SIGTERM wiring without code duplication. The `rt` arg is any
// object with a `dispose()` method — works for ManagedRuntime.
const installShutdown = (rt: { dispose: () => Promise<unknown> }): void => {
  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    // Synchronous write to stdout fd — `console.log` to a PIPE (systemd
    // captures stdout via a pipe, not a TTY) is async, so the buffered
    // line is lost when `process.exit(0)` truncates it below. writeSync
    // flushes before the dispose/exit, so the shutdown is observable in
    // journald.
    writeSync(1, `\n👋 shutting down (${signal})\n`)
    void rt.dispose().then(() => process.exit(0))
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

// ── Setup-mode minimal layer ──────────────────────────────────────────────
//
// Started when the boot-time credential gate decides mode === "setup":
// no accounts seeded, or the claude-code:login token is lapsed. Serves
// only the WS server (advertising setup:true, chat:false) + the control
// server so the UI can guide the user through login. No chat/dream/
// survey/memory/SDK layers are constructed — so this layer starts even
// without a configured luna.db.
//
// Layer requirement chain:
//   startUIWebSocketServer → UIService → ObservabilityService → Clock
//   startControlServer     → (none — pure Bun.serve call)
//
// `wsPort`/`controlPort` default to the production ports. Pass 0 in
// tests/smokes to let the OS pick an ephemeral port (avoids conflicts).
//
// Task 1b: `setupPtyFactory` is a test seam. Production passes NO arg
// (undefined) → the real factory built from CLAUDE_EXE + paths.lunaDbPath is
// used. Pass an explicit factory in tests/smokes to avoid spawning real
// `claude` / calling real process.exit; pass `null` to wire no pty at all.
export const buildSetupServerLayer = (
  wsPort: number = 4753,
  controlPort: number = 4754,
  setupPtyFactory?: {
    onConnect: (send: (frame: PtyOutputFrame) => void) => {
      write: (utf8: string) => void
      resize: (cols: number, rows: number) => void
      close: () => void
    }
  } | null,
): Layer.Layer<never, Error> => {
  const clockL = Clock.Default
  const paths = resolveRuntimePaths()
  const obsL = ObservabilityService.makeLayer({
    logToConsole: false,
    jsonlPath: paths.eventsJsonlPath,
  }).pipe(Layer.provide(clockL))
  const uiL = UIService.makeLayer().pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )

  // Build the per-connection pty factory that runs `claude setup-token` and,
  // on exit, checks login status → seeds the account row → restarts (exit 0).
  // When a factory is explicitly passed (test seam), use it as-is.
  // When undefined (production), build the real one from the environment.
  // When null, wire no setupPty (explicit opt-out for callers that want setup-
  // mode without a pty — e.g. smoke tests that don't want to spawn claude).
  const CLAUDE_EXE = process.env["LUNA_CLAUDE_CODE_EXECUTABLE"]?.trim() || "claude"
  const resolvedSetupPty =
    setupPtyFactory !== undefined
      ? setupPtyFactory   // caller-supplied (or explicit null)
      : {
          onConnect: (send: (frame: PtyOutputFrame) => void) => {
            const pty = spawnSetupPty({
              // Single-quote-escape so a path with spaces is safe inside the shell string.
              command: `'${CLAUDE_EXE.replace(/'/g, "'\\''")}' setup-token`,
              onData: (b64) => send({ type: "pty-output", data: b64 }),
              onExit: () => {
                onLoginAttemptComplete({
                  send,
                  checkLoggedIn: () => probeAuthLoggedIn(CLAUDE_EXE),
                  dbPath: paths.lunaDbPath,
                })
              },
            })
            return { write: pty.write, resize: pty.resize, close: pty.close }
          },
        }

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      yield* startControlServer(controlPort)
      yield* startUIWebSocketServer({
        port: wsPort,
        ...(BIND_HOST !== undefined ? { host: BIND_HOST } : {}),
        token: TOKEN,
        advertisedKinds: DEFAULT_UI_KINDS,
        pingIntervalMs: 5000,
        chatService: null,
        accountBroker: null,
        survey: null,
        localShellBridge: null,
        setupPty: resolvedSetupPty,
      })
    }),
  ).pipe(Layer.provide(uiL))
}

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
      // ChatService already has per-thread tool wiring baked in via the
      // ThreadToolsProvider (see buildBaseLayer). Both new threads and
      // resume-recovery threads get MCP servers + system prompt + session
      // binding, so the WS server can use the service handle directly.
      const chat = yield* ChatService
      const broker = yield* AccountBroker
      const surveyService = yield* Survey // Phase 3 D3

      // Phase 3 D3: build the SurveyWsHandle adapter. SurveyApi has
      // pendingSurvey + processVerdict; SurveyWsHandle needs pendingSurvey +
      // submitVerdicts. submitVerdicts pins every verdict's `at` to `issuedAt`
      // (D-LOCK-5) and processes them sequentially.
      const surveyHandle = {
        pendingSurvey: (now: number) => surveyService.pendingSurvey(now),
        submitVerdicts: (
          _surveyId: string,
          issuedAt: number,
          verdicts: ReadonlyArray<import("@luna/core").SurveyVerdict>,
        ) =>
          Effect.forEach(verdicts, (v) => surveyService.processVerdict({ ...v, at: issuedAt }), {
            discard: true,
          }),
      }

      // tRPC control server — port 4754, alongside the WebSocket server.
      // Exposes control.restart / control.status / control.version.
      yield* startControlServer(4754)

      return yield* startUIWebSocketServer({
        port: 4753,
        ...(BIND_HOST !== undefined ? { host: BIND_HOST } : {}),
        token: TOKEN,
        advertisedKinds: DEFAULT_UI_KINDS,
        pingIntervalMs: 5000,
        chatService: chat,
        accountBroker: broker,
        survey: surveyHandle, // Phase 3 D3: resolved handle
        localShellBridge,
        onLocalShellRelease: reattachSandbox,
      })
    }),
  ).pipe(
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
        "⚠️ normal-mode reached with 0 accounts — readiness gate bypassed; restart to enter setup-mode",
      )
    }
    const counts = new Map<string, number>()
    for (const a of accounts) {
      counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1)
    }
    const breakdown = Array.from(counts.entries())
      .map(([k, n]) => `${k}×${n}`)
      .join(", ")
    console.log(`[accounts] ${accounts.length} hydrated: ${breakdown || "none"}`)

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

  // ── Boot-time credential gate ────────────────────────────────────────────
  // Probe credential readiness BEFORE building any chat layers. If the gate
  // says "setup" (no accounts, or the claude-code:login token is lapsed),
  // start a minimal WS+control layer that serves the setup UI without
  // attempting to build chat/dream/survey/memory/SDK layers. The UI guides
  // the operator through login; a restart re-decides the mode.
  const paths = resolveRuntimePaths()
  const claudeExe = process.env["LUNA_CLAUDE_CODE_EXECUTABLE"]?.trim() || "claude"
  const mode = decideMode(probeCredentialReadiness({ dbPath: paths.lunaDbPath, claudeExe }))
  if (mode === "setup") {
    writeSync(1, "\n🔧 setup-mode: model credential not usable — serving setup UI (log in to continue)\n")
    const setupRuntime = ManagedRuntime.make(buildSetupServerLayer())
    installShutdown(setupRuntime)
    setupRuntime.runPromise(Effect.never).catch((err) => {
      console.error("❌ setup-mode server crashed:", err)
      process.exit(1)
    })
    return
  }

  // ── Normal mode ──────────────────────────────────────────────────────────
  const baseLayer = buildBaseLayer(opTokens)
  const serverLayer = buildServerLayer(baseLayer)
  const runtime = ManagedRuntime.make(Layer.mergeAll(serverLayer, baseLayer))

  // Graceful shutdown on BOTH signals. Interactive use sends SIGINT;
  // systemd `stop`/`restart` sends SIGTERM. Both must run runtime.dispose()
  // so the ManagedRuntime releases its layer scope finalizers — notably
  // db.close(), which is what makes vectorlite serialize the HNSW sidecar
  // (memory.db.hnsw.bin) and re-chmod it 0o600. Without a SIGTERM handler the
  // process is hard-killed under systemd, db.close() never runs, the sidecar
  // is never written, and every boot pays the full backfill cost again.
  // The guard makes a second signal (or SIGINT-then-SIGTERM) a no-op so
  // dispose() can't run twice.
  installShutdown(runtime)

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
