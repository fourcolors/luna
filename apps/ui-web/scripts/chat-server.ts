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
 *      backends, one per LUNA_OP_ACCOUNTS label whose token resolved at
 *      boot (keychain-first, LUNA_OP_TOKEN_<LABEL> fallback). Refs are
 *      dispatched explicitly:
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
 * Service-account tokens are discovered per-label: the macOS keychain
 * first, then a `LUNA_OP_TOKEN_<LABEL>` env var as a fallback. The bare
 * `OP_SERVICE_ACCOUNT_TOKEN` env var is NOT used (it collided with the
 * reserved `env` label).
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
 * ## Service-account tokens (per-label, keychain-first)
 *
 * Configure the labels this server reads with a comma-separated list:
 *
 *   LUNA_OP_ACCOUNTS=primary,ops
 *
 * Each label deterministically derives BOTH token backends, so the two
 * never drift. The label is the single source of truth:
 *
 *   macOS keychain (preferred) — service `luna.op.<label>`, account `<label>`:
 *     security add-generic-password -U \
 *       -s luna.op.<label> -a <label> -w '<ops_-prefixed-token>'
 *
 *   Linux / fallback env var — `LUNA_OP_TOKEN_<LABEL>` (uppercase, '-'→'_'):
 *     LUNA_OP_TOKEN_PRIMARY=ops_xxxxxxxx
 *
 * `discoverOpTokens` reads the keychain first and falls back to the env
 * var on a miss (the keychain hard-fails on non-darwin, so Linux always
 * uses the env var). Accounts with neither source are non-fatal — the
 * layer is skipped and the boot log lists only contributing labels.
 *
 * Keychain entries are user-scoped: same-user reads do not prompt.
 * Cross-user or launchd-as-different-user execution would require
 * additional ACL setup (e.g. `-T <bun-binary>` at add-time, or
 * "Always Allow" on first prompt). Out of scope for the dev rig.
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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { hostname, userInfo } from "node:os"
import { execFileSync, spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  applyRuntimePathEnvDefaults,
  resolveRuntimePaths,
} from "./runtime-paths.js"

// Load Luna's runtime .env before anything else so CLAUDE_CONFIG_DIR (and any
// other Luna env vars) are in process.env when the SDK initialises. LUNA_HOME
// makes the runtime portable; the default remains ~/.luna.
//
// `bootShadowedEnvKeys` records .env keys that were ALREADY set in process.env
// (supervisor/unit-defined) — those definitions win over ~/.luna/.env, so a
// Vault edit to the file is silently ineffective for them. The Vault list
// surfaces this as a `shadowed` badge instead of showing a value that isn't
// the effective one.
const bootShadowedEnvKeys = new Set<string>()
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
      else if (key) bootShadowedEnvKeys.add(key)
    }
  }
  applyRuntimePathEnvDefaults(resolveRuntimePaths())
}
import { Context, Effect, Layer, ManagedRuntime, Option, Runtime, Stream } from "effect"
import {
  AccountBroker,
  AccountBrokerLayer,
  AgentNotesService,
  ArtifactStore,
  JobsStoreService,
  JobTickerLayer,
  WorkerRegistry,
  makeWorkerRegistry,
  WorkspaceRegistryService,
  AlignmentStore,
  BELIEF_KIND,
  BELIEF_NAMESPACE,
  BeliefWriter,
  BUILTIN_SKILLS,
  CalibrationStore,
  Clock,
  DEFAULT_UI_KINDS,
  DreamCronLayer,
  DreamStore,
  DreamWorkerLayer,
  WakeCronLayer,
  WakeLogStore,
  WakeWorkerLayer,
  EnvSecretProvider,
  NoopTracerLayer,
  ObservabilityService,
  OnePasswordSecretProvider,
  RoutedOpSecretProvider,
  scanUserSkills,
  SessionStore,
  SkillPrefsStore,
  SkillRegistry,
  syncUserSkills,
  Survey,
  TelemetryPlatform,
  TelemetryService,
  UIService,
  composeBeliefsSection,
  makeDuckDbLayer,
  makeTelemetrySqlite,
  readKeychainToken,
  writeKeychainSecret,
  deleteKeychainSecret,
  keychainVaultQueryForEnvName,
  KeychainEnvSecretProvider,
  secretProviderFirstOf,
  JobsStoreService,
  validateAccountsTableLabels,
  SuggestedActions,
  SuggestedActionsStore,
  AcceptHandler,
  AcceptHandlerLayer,
  ThreadRegistryService,
  importJsonMap,
} from "@luna/core"
import { createDnaLoader, loadDna } from "./dna-loader.js"
import { loadSystem } from "./system-loader.js"
import { loadWorkspaces } from "./workspaces-loader.js"
import {
  buildMainMemoryBlock,
  loadMainMemory,
  resolveMainMemoryPath,
} from "./agent-memory-loader.js"
import { buildSessionMetadata } from "./runtime-metadata.js"
import {
  attachSandboxLocalShell,
  resolveSandboxLocalShell,
} from "./sandbox-local-shell.js"
import {
  makeVaultSecretStore,
  normalizeVaultStorageMode,
} from "./vault-secret-store.js"
export { createDnaLoader, loadDna } from "./dna-loader.js"
export { loadSystem } from "./system-loader.js"
export { loadWorkspaces } from "./workspaces-loader.js"
export {
  buildMainMemoryBlock,
  loadMainMemory,
  resolveMainMemoryPath,
} from "./agent-memory-loader.js"
import {
  DreamReasonerDefault,
  SDKAdapter,
  SDKClient,
  WakeReasonerDefault,
  PromptWorkerLayer,
  WorkflowWorkerLayer,
  JobRunToolsProviderTag,
  ChatThreadPosterTag,
} from "@luna/adapter-sdk"
import {
  ChatService,
  ThreadToolsProviderTag,
  effortOptionsForModel,
  type EffortOption,
  type ThreadToolsProvider,
} from "@luna/chat-service"
import { composeInterceptors, defaultSafetyInterceptors } from "@luna/tools"
import {
  createJobInputBridge,
  createLocalShellBridge,
  createMcpAppHost,
  createSecretRequestBridge,
  createSubagentTreeBridge,
  createWidgetSummonBridge,
  startUIWebSocketServer,
} from "@luna/ui-ws"
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
import {
  SecretToolsLayer,
  SecretToolsService,
  makeRegisterSecret,
  type SecretDestination,
} from "@luna/secret-tools"
import { SkillToolsLayer, SkillToolsService } from "@luna/skill-tools"
import {
  SuggestedActionToolsLayer,
  SuggestedActionToolsService,
} from "@luna/suggested-actions-tools"
import { WidgetToolsLayer, WidgetToolsService } from "@luna/widget-tools"
import { createJobInputToolsProvider } from "@luna/job-input-tools"
import {
  BUILTIN_CONNECTORS,
  ConnectorError,
  ConnectorInstanceStore,
  ConnectorService,
  ConnectorServiceLayer,
} from "@luna/connectors"
import { makeOAuthClient } from "@luna/oauth"
import {
  VaultStore,
  makeVaultMutations,
  makeVaultOpSync,
  reconcileVaultItems,
  shouldAttemptSync,
  toWireVaultItem,
  type VaultItem,
  type VaultSyncConfig,
} from "@luna/vault"
import { startControlServer } from "@luna/control-server"
import {
  resolveOpAccounts,
  envTokenFor,
  fileTokenFor,
  tokenFilePathFor,
} from "./op-accounts.js"
import {
  makeRegisterOpToken,
  type TokenCheck,
} from "./register-op-token.js"
import { resolveUiWsToken } from "./ui-ws-token.js"
import {
  buildCuratedAppTools,
  buildWorkspacePulseApp,
  composeAppRegistries,
  createCoreAppRegistry,
  createStoreBackedAppRegistry,
  pulseFromSnapshot,
} from "./core-apps.js"
import { decideMode, probeCredentialReadiness, probeAuthLoggedIn } from "./credential-readiness.js"
import { spawnSetupPty } from "./setup-pty.js"
import { onLoginAttemptComplete } from "./setup-login.js"
import type { PtyOutputFrame } from "@luna/ui-ws"

const TOKEN = resolveUiWsToken()
const BIND_HOST = process.env["LUNA_UI_WS_HOST"]?.trim() || undefined

/**
 * Resolve the git short-SHA of THIS build, ONCE at process startup. Surfaced
 * at runtime (/readyz, hello frame, control.status) so any operator can tell
 * which commit a running server is. Resolution order:
 *   1. LUNA_BUILD_SHA env var (set by deploy scripts / containers where .git
 *      may be absent) — trimmed; an empty value falls through.
 *   2. `git rev-parse --short HEAD` — wrapped in try/catch so a missing .git
 *      (or git not on PATH) never crashes boot.
 *   3. literal "unknown" on any failure.
 */
const resolveBuildSha = (): string => {
  const fromEnv = process.env["LUNA_BUILD_SHA"]?.trim()
  if (fromEnv) return fromEnv
  try {
    // Fixed argv (no shell, no interpolation) — execFileSync throws on a
    // missing .git or git-not-on-PATH, which the catch turns into "unknown".
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
    return sha || "unknown"
  } catch {
    return "unknown"
  }
}

/** Git short-SHA of this build — computed once, threaded into the endpoints. */
const BUILD_SHA = resolveBuildSha()

/* ── UI model-list helpers ───────────────────────────────────────────────────
 *
 * `parseUiModels` parses the LUNA_UI_MODELS env var (comma-separated
 * `id=label` pairs) into an ordered array of {id, label} entries that
 * appear FIRST in the UI's model-switcher dropdown.  Defensive parsing:
 * malformed input is silently skipped so a misconfigured env var never
 * crashes the server.
 *
 * `buildAvailableModels` merges operator-configured extras (from
 * LUNA_UI_MODELS) with the built-in base list, deduping by model id with
 * extras taking precedence (they come first in the output, so the client
 * treats the first entry as the recommended default).
 *
 * Both functions are exported so the test suite can import them directly
 * without running bootstrap() (the import.meta.main guard).
 */

/**
 * Effort matrix — the definitions live in @luna/chat-service (effort.ts),
 * the single source of truth shared by this hello-frame builder AND the
 * chat-service enforcement points (createThread + setThreadConfig clamp the
 * same matrix, so the advertised efforts and the accepted efforts can never
 * drift). Re-exported here so the dev-rig tests and any script-level callers
 * keep one import site.
 */
export {
  clampEffort,
  effortsForModel,
  EFFORT_LEVELS as ALL_EFFORTS,
} from "@luna/chat-service"
export type { EffortLevel as Effort } from "@luna/chat-service"

/** A single selectable model entry (with server-computed effort matrix). */
export interface UiModelEntry {
  readonly id: string
  readonly label: string
  /** Effort options for this model — server-computed. See effortOptionsForModel().
   *  Includes the "ultracode" token for xhigh-capable models. */
  readonly efforts?: readonly EffortOption[]
}

/**
 * Parse `LUNA_UI_MODELS`-format text into {id, label} entries.
 *
 * Format: comma-separated `id=label` pairs.  Examples:
 *   - `gemini-2.5-flash=Gemini 2.5 Flash`
 *   - `local/qwen2.5:14b=Qwen 14B (local)`
 *   - `my-model` (no `=` → id is used as label)
 *
 * Rules:
 *   - Whitespace around entries and around `=` is trimmed.
 *   - Empty entries (stray commas) are silently skipped.
 *   - An entry with no `=` uses the id as its label.
 *   - An entry whose id is empty after trimming is silently skipped.
 *   - Malformed input NEVER throws — always returns a (possibly empty) array.
 */
export const parseUiModels = (raw: string | undefined): ReadonlyArray<UiModelEntry> => {
  if (!raw) return []
  const out: Array<UiModelEntry> = []
  try {
    for (const part of raw.split(",")) {
      const trimmed = part.trim()
      if (trimmed === "") continue
      const eq = trimmed.indexOf("=")
      const id = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim()
      if (id === "") continue // no id, skip
      const label = eq === -1 ? id : trimmed.slice(eq + 1).trim() || id
      out.push({ id, label })
    }
  } catch {
    // Defensive: never propagate parse errors — a misconfigured env var
    // must not crash the server.
  }
  return out
}

/**
 * The built-in base list of selectable models shown when the operator has
 * not overridden via LUNA_UI_MODELS. This list is the recommended default
 * capability spread; entries are deduped (extras-first) in buildAvailableModels.
 * The first entry is the recommended default (highest capability or operator-
 * preferred). Efforts are attached server-side via effortsForModel().
 */
const BASE_MODELS: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: "claude-sonnet-4-6",   label: "Claude Sonnet 4.6 — balanced" },
  { id: "claude-fable-5",       label: "Fable 5 (1M context)" },
  { id: "claude-opus-4-8",      label: "Claude Opus 4.8 — most capable" },
  { id: "claude-haiku-4-5",     label: "Claude Haiku 4.5 — fastest" },
]

/**
 * Build the full available-model list to advertise in the `hello` frame.
 *
 * Operator-configured extras (from LUNA_UI_MODELS) come FIRST in the
 * output, making them the UI's recommended default.  The built-in base
 * models follow, deduped by id (an extra that overrides a base model id
 * keeps the extra's label and position). Efforts are attached to every entry
 * via effortsForModel() so clients never compute the matrix themselves.
 *
 * Accepts an optional `env` parameter (defaults to `process.env`) so unit
 * tests can inject a synthetic environment without touching process.env.
 */
export const buildAvailableModels = (env: NodeJS.ProcessEnv = process.env): Array<UiModelEntry> => {
  const extras = parseUiModels(env["LUNA_UI_MODELS"])
  const seenIds = new Set(extras.map((e) => e.id))
  const deduped: Array<UiModelEntry> = extras.map((e) => ({
    ...e,
    efforts: effortOptionsForModel(e.id),
  }))
  for (const base of BASE_MODELS) {
    if (!seenIds.has(base.id)) {
      deduped.push({ ...base, efforts: effortOptionsForModel(base.id) })
    }
  }
  return deduped
}

const localShellBridge = createLocalShellBridge()

// Per-thread sandbox re-attach closures. Module scope (single-process boot)
// so both the ThreadToolsProvider (which registers a reattacher in onBound)
// and the WS server (which calls it via onLocalShellRelease) can share it.
// The container sandbox owns the local-shell slot at thread creation; an
// attached CLI with --local-shell takes over (`replaceable: true`); when it
// releases, we re-run the original attach so the agent keeps local_shell.
const sandboxReattachers = new Map<string, () => void>()

// PRD Part B: bridge between skillRegistryL's hot-load fiber (buildBaseLayer)
// and the ui-ws broadcast hook (buildServerLayer wires it via
// skillsWsHandle.changes). Module-level holder because the two live in
// different layer scopes of this same boot script. Null until a WS server
// registers; the fiber null-guards every call.
let notifySkillCatalogChanged: (() => void) | null = null

// Luna Vault V3: same late-binding bridge for out-of-band vault-list
// broadcasts — the 1Password sync poll loop (buildServerLayer) calls it after
// a pass that changed registry rows, and ui-ws re-broadcasts the (wire-safe)
// list to every client. Null until a WS server registers.
let notifyVaultListChanged: (() => void) | null = null
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
      const secretTools = yield* SecretToolsService
      const skillTools = yield* SkillToolsService
      const widgetTools = yield* WidgetToolsService // PRD Part C/W4: widget_write
      const suggestedActionTools = yield* SuggestedActionToolsService // suggest_action
      // PRD Part B (Skills): the managed skill catalog. decorate() reads
      // promptSnapshotSync() — synchronous and never stale (the registry
      // rebuilds it inside every mutation), so a settings toggle is
      // reflected in the very next thread without a restart or a tick.
      // (The ~/.luna/skills hot-load fiber lives in skillRegistryL, where
      // the prefs store is in scope for the new-skill quarantine.)
      const skillRegistry = yield* SkillRegistry
      // PRD Part A (Connectors): connected services' MCP servers. Same
      // sync-snapshot discipline — refreshMounts() rebuilds on connect/
      // disconnect (and on M2 token rotation); decorate() just spreads it.
      const connectorService = yield* ConnectorService
      const bootMounts = Object.keys(connectorService.mountSnapshotSync())
      if (bootMounts.length > 0) {
        console.log("[luna/boot] connector mounts:", bootMounts.join(", "))
      }

      const bootSkills = yield* skillRegistry.catalog()
      console.log(
        "[luna/boot] skills registered:",
        bootSkills.length,
        `(${bootSkills.filter((s) => s.enabled).length} enabled,`,
        `${bootSkills.filter((s) => s.source === "user").length} user)`,
      )

      console.log("[luna/boot] MCP servers registered:", [
        memTools.serverName,
        schedTools.serverName,
        obsTools.serverName,
        localShellTools.serverName,
        secretTools.serverName,
      ].join(", "))

      // Luna identity: resolve script dir once at boot (immutable — import.meta.url
      // never changes). Validate that at least one DNA source exists so a
      // misconfigured boot fails loudly rather than silently. The *content* is
      // intentionally NOT cached here; decorate() reloads it per-thread so that
      // updates to ~/.luna/DNA.md take effect on the next new thread without a
      // server restart. Repo layout: this file is at
      // apps/ui-web/scripts/chat-server.ts → DNA.md is 3 levels up.
      const __scriptDir = dirname(fileURLToPath(import.meta.url))
      // loadDnaCached() seeds the cache on first call (throws if neither source
      // exists — loud boot failure). On subsequent calls it returns last-good
      // content if the files have been deleted mid-run, logging a console.error
      // so the operator has a visible signal. See dna-loader.ts:createDnaLoader.
      const loadDnaCached = createDnaLoader(__scriptDir)
      loadDnaCached() // boot guard: throws if neither ~/.luna/DNA.md nor repo DNA.md exists
      // SYSTEM.md describes Luna's runtime mechanics (workspaces, paths,
      // memory, observability). Absence is non-fatal — boot continues
      // with identity-only context. See system-loader.ts for resolution.
      const systemContent = loadSystem(__scriptDir)
      // Workspaces inject: query luna.db for active workspaces and
      // inline each one's workspace.md so Luna always has the source
      // of truth in her system prompt (not optional shell-read).
      // Returns null when no active workspaces are registered; the
      // .filter() below drops it cleanly in that case.
      const workspacesContent = loadWorkspaces(resolveRuntimePaths().lunaDbPath)
      // Luna's main-thread observational memory. Symmetric to subagent
      // memory but loaded explicitly here (the SDK only auto-loads
      // `memory: user` on AgentDefinitions, not the top-level session).
      // Path: $LUNA_HOME/agent-memory/luna-main/MEMORY.md. Absent file →
      // null → filtered out below; the discipline (see SKILL.md) only
      // applies when there's something to read.
      const mainMemoryPath = resolveMainMemoryPath()
      const mainMemoryContent = (() => {
        try {
          const raw = loadMainMemory(mainMemoryPath)
          return buildMainMemoryBlock(raw, mainMemoryPath)
        } catch (err) {
          console.warn(
            `[luna/boot] failed to load main memory at ${mainMemoryPath}:`,
            err,
          )
          return null
        }
      })()
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
          const secretThreadTools = secretTools.createSessionBinding()
          const skillThreadTools = skillTools.createSessionBinding()
          const widgetThreadTools = widgetTools.createSessionBinding()
          const suggestedActionThreadTools =
            suggestedActionTools.createSessionBinding()
          console.log(
            "[luna/thread] wiring MCP servers:",
            [
              memoryThreadTools.serverName,
              schedulerThreadTools.serverName,
              obsThreadTools.serverName,
              localShellThreadTools.serverName,
              secretThreadTools.serverName,
              skillThreadTools.serverName,
              widgetThreadTools.serverName,
            ].join(", "),
          )
          // Sync read of the live-refresh holder — refreshed every
          // refreshIntervalMs by the background fiber above. Returns "" when
          // no active beliefs (the .filter(length>0) below drops it cleanly).
          // DNA is reloaded from disk per-thread so ~/.luna/DNA.md changes
          // (e.g. the operator giving Luna a different identity) take effect without a restart.
          const dnaContent = loadDnaCached()
          const systemPrompt = [
            dnaContent,
            systemContent, // SYSTEM.md: runtime mechanics (workspaces, paths)
            workspacesContent, // active workspaces' workspace.md inlined at boot
            mainMemoryContent, // Luna main thread observational memory
            sessionMetadata,
            beliefsContent, // Phase 3 D5: ranked active beliefs section
            skillRegistry.promptSnapshotSync(), // PRD Part B: enabled skills ("" when none — filtered below)
            opts.systemPrompt,
            memoryThreadTools.systemPromptAddendum,
            schedulerThreadTools.systemPromptAddendum,
            obsThreadTools.systemPromptAddendum,
            localShellThreadTools.systemPromptAddendum,
            secretThreadTools.systemPromptAddendum,
            suggestedActionThreadTools.systemPromptAddendum,
          ]
            .filter((s): s is string => typeof s === "string" && s.length > 0)
            .join("\n\n")
          const mcpServers = {
            ...(opts.mcpServers ?? {}),
            [memoryThreadTools.serverName]: memoryThreadTools.server,
            [schedulerThreadTools.serverName]: schedulerThreadTools.server,
            [obsThreadTools.serverName]: obsThreadTools.server,
            [localShellThreadTools.serverName]: localShellThreadTools.server,
            [secretThreadTools.serverName]: secretThreadTools.server,
            [skillThreadTools.serverName]: skillThreadTools.server, // PRD B §11: skill_load (tier-2 disclosure)
            [widgetThreadTools.serverName]: widgetThreadTools.server, // PRD C §16: widget_write (describe-to-spawn)
            [suggestedActionThreadTools.serverName]: suggestedActionThreadTools.server, // suggest_action (propose follow-ups)
            ...connectorService.mountSnapshotSync(), // PRD A §07: connected services, hot per-thread
          }
          return {
            mcpServers,
            systemPrompt,
            onBound: (sessionId: string) => {
              obsThreadTools.bindSession(sessionId)
              localShellThreadTools.bindSession(sessionId)
              secretThreadTools.bindSession(sessionId)
              suggestedActionThreadTools.bindSession(sessionId)
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
            onUnbound: (sessionId: string) => {
              // Symmetric teardown for onBound (thread scope close). Without
              // this, `sandboxReattachers` — a module-scope Map — grows one
              // retained closure per historical thread for the process
              // lifetime, an unbounded leak on a long-lived server.
              // delete() on an absent key (sandbox disabled) is a safe no-op.
              sandboxReattachers.delete(sessionId)
              localShellThreadTools.clearSession(sessionId)
            },
          }
        },
      }
      return provider
    }),
  ).pipe(
    Layer.provide(MemoryToolsLayer()),
    Layer.provide(
      // Surface the system-managed cycles (wake/dream) as read-only entries in
      // schedule_list so the operator sees the whole schedule picture, not just
      // agent-created crons. Exprs mirror the wake/dream cron wiring below.
      SchedulerToolsLayer({
        systemSchedules: [
          ...(process.env["LUNA_WAKE_ENABLED"]?.trim() !== "0"
            ? [
                {
                  label: "wake (workspace digest)",
                  expr: process.env["LUNA_WAKE_CRON_EXPR"]?.trim() || "*/30 * * * *",
                },
              ]
            : []),
          { label: "dream (nightly consolidation)", expr: "0 3 * * *" },
        ],
      }),
    ),
    Layer.provide(LocalShellToolsLayer({ bridge: localShellBridge })),
    Layer.provide(SecretToolsLayer({ bridge: secretRequestBridge })),
    Layer.provide(ObsToolsLayer({ runtimeProbe: buildChatServerRuntimeProbe })),
  )

// Build a fresh RuntimeSnapshot per `obs_runtime` call (issue #12). Reads
// from process.env so it reflects whatever the chat-server's resolved
// paths are at call time, not a stale snapshot from boot. `scope` falls
// back to "unknown" because reliable in-process auto-detection of
// incus-container vs tauri-sidecar vs host is fragile; operators set
// LUNA_SCOPE explicitly in their deploy unit.
const CHAT_SERVER_BOOTED_AT_ISO = new Date().toISOString()
const buildChatServerRuntimeProbe = () => {
  const paths = resolveRuntimePaths()
  return {
    scope: process.env["LUNA_SCOPE"] ?? "unknown",
    server: "luna-chat-server",
    pid: process.pid,
    hostname: hostname(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    bunVersion: process.versions.bun ?? null,
    startedAt: CHAT_SERVER_BOOTED_AT_ISO,
    dbPaths: {
      luna: paths.lunaDbPath,
      memory: paths.memoryDbPath,
      analytics: paths.analyticsDbPath,
      jsonl: paths.eventsJsonlPath,
    },
  }
}

// ── Multi-account 1Password bootstrap ───────────────────────────────────
//
// Operators opt in via LUNA_OP_ACCOUNTS (comma-separated labels). Each
// label resolves keychain-first, then a `LUNA_OP_TOKEN_<LABEL>` env var.
// Missing on both → non-fatal: the layer is skipped and the boot log
// lists only the labels that contributed. Add a token with either:
//   security add-generic-password -U \
//     -s luna.op.<label> -a <label> -w '<ops_-prefixed-token>'   (macOS)
//   LUNA_OP_TOKEN_<LABEL>=ops_xxxxxxxx                           (Linux/fallback)
const OP_ACCOUNTS = resolveOpAccounts()

interface DiscoveredOpToken {
  readonly label: string
  readonly token: string
}

/**
 * Resolve every OP token we can find, in precedence order
 * keychain → env var → runtime file. Missing sources are non-fatal — an
 * account with no token in any source is simply skipped.
 *
 * macOS resolves via the Keychain and never consults the others. Linux
 * containers (no Keychain — `readKeychainToken` hard-fails on non-darwin)
 * fall through to `LUNA_OP_TOKEN_<LABEL>`, then to the runtime token file
 * `~/.luna/op-tokens/<label>` written by the Moon secure-entry form.
 *
 * Phase 25d dropped the single bare `OP_SERVICE_ACCOUNT_TOKEN` env
 * fallback (it collided with the reserved `env` label); per-account
 * sources keyed off the registered label avoid that collision and
 * preserve the multi-account model. The file is LAST so a runtime-set
 * token never shadows an operator-provisioned keychain/env token.
 */
const discoverOpTokens: Effect.Effect<ReadonlyArray<DiscoveredOpToken>> =
  Effect.gen(function* () {
    const found: Array<DiscoveredOpToken> = []
    for (const acct of OP_ACCOUNTS) {
      const keychain = yield* readKeychainToken({
        service: acct.keychainService,
        account: acct.keychainAccount,
      }).pipe(Effect.option)
      const token = Option.isSome(keychain)
        ? keychain.value
        : envTokenFor(acct) ?? fileTokenFor(acct)
      if (token !== undefined) {
        found.push({ label: acct.label, token })
      }
    }
    return found
  })

// ── Moon secure-entry: register-op-token handler ────────────────────────
//
// Verifies a 1Password service-account token with `op whoami`, persists it to
// the platform's preferred store, then self-SIGTERMs so the existing graceful-
// shutdown handler disposes the runtime and exits 0 — the supervisor
// (systemd `Restart=always` / launchd `KeepAlive`) relaunches and
// `discoverOpTokens` re-runs with the new token live. The orchestration
// (validate → persist → restart, with a bad token NEVER reaching the restart)
// lives in the unit-tested `makeRegisterOpToken`; here we inject the real
// effectful steps. The token is never logged.

/** Verify the token authenticates by spawning `op whoami` with it in env. */
const opWhoami = (token: string): Promise<TokenCheck> =>
  new Promise((resolve) => {
    let settled = false
    const done = (r: TokenCheck): void => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }
    const child = spawn("op", ["whoami"], {
      env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token },
      stdio: ["ignore", "ignore", "ignore"],
    })
    child.on("error", (err: NodeJS.ErrnoException) => {
      done(
        err.code === "ENOENT"
          ? { ok: false, message: "1Password CLI ('op') is not installed on the server." }
          : { ok: false, message: "Could not run 'op' on the server." },
      )
    })
    child.on("close", (code) => {
      done(
        code === 0
          ? { ok: true }
          : { ok: false, message: "1Password rejected this token." },
      )
    })
  })

/** Persist to keychain (darwin) or an atomic 0600 file (linux/other). */
const persistOpToken = (label: string, token: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if (process.platform === "darwin") {
      const child = spawn(
        "security",
        ["add-generic-password", "-U", "-s", `luna.op.${label}`, "-a", label, "-w", token],
        { stdio: ["ignore", "ignore", "ignore"] },
      )
      child.on("error", reject)
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`security add-generic-password exited ${code}`)),
      )
      return
    }
    try {
      const path = tokenFilePathFor(label)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const tmp = `${path}.tmp-${process.pid}`
      writeFileSync(tmp, token, { mode: 0o600 })
      renameSync(tmp, path)
      chmodSync(path, 0o600) // writeFileSync mode is pre-umask; force 0600
      resolve()
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })

/**
 * Delete a stored op token (Vault remove). Mirrors `persistOpToken`'s platform
 * split: darwin keychain entry, linux/other the 0600 runtime file. Idempotent —
 * a missing entry/file is success (`security` exits 44 for item-not-found;
 * unlink swallows ENOENT). NOTE: a token defined via `LUNA_OP_TOKEN_<LABEL>`
 * cannot be deleted here (the supervisor owns that env) — discovery re-finds it
 * after restart and the Vault reconciler re-adopts the row, which is honest.
 */
const deleteOpToken = (label: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if (process.platform === "darwin") {
      const child = spawn(
        "security",
        ["delete-generic-password", "-s", `luna.op.${label}`, "-a", label],
        { stdio: ["ignore", "ignore", "ignore"] },
      )
      child.on("error", reject)
      child.on("close", (code) =>
        code === 0 || code === 44
          ? resolve()
          : reject(new Error(`security delete-generic-password exited ${code}`)),
      )
      return
    }
    try {
      unlinkSync(tokenFilePathFor(label))
      resolve()
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === "ENOENT") resolve()
      else reject(err instanceof Error ? err : new Error(String(err)))
    }
  })

/**
 * Real `op` runner for makeVaultOpSync (Vault V3 — 1Password sync). Mirrors
 * opWhoami's spawn style: the service-account token rides ONLY in the child
 * env (`input.env` merged over process.env), outbound item values ride ONLY
 * on stdin (the `op item create -` JSON template). NOTHING here is logged —
 * stdin/stdout/stderr can all carry secrets; op-sync sanitizes before any
 * string escapes (lastError = operation + exit code only).
 */
const runOpForVaultSync = (input: {
  readonly args: ReadonlyArray<string>
  readonly env?: Readonly<Record<string, string>>
  readonly stdin?: string
}): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    let settled = false
    const done = (r: { code: number; stdout: string; stderr: string }): void => {
      if (!settled) {
        settled = true
        clearTimeout(killTimer)
        resolve(r)
      }
    }
    const fail = (err: Error): void => {
      if (!settled) {
        settled = true
        clearTimeout(killTimer)
        reject(err)
      }
    }
    let stdout = ""
    let stderr = ""
    // B3: 60s hard kill-timer — a hung `op` invocation must not wedge the sync
    // loop forever. On timeout we SIGKILL the child and resolve {code:-1} so
    // the engine's exit-code check sanitizes the result to a non-throws failure.
    // First-settle-wins: close/error handlers call done/fail first if the child
    // exits before the timer fires.
    // eslint-disable-next-line prefer-const
    let killTimer: ReturnType<typeof setTimeout>
    try {
      const child = spawn("op", [...input.args], {
        env: { ...process.env, ...(input.env ?? {}) },
        stdio: [input.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      })
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL") } catch { /* already exited */ }
        done({ code: -1, stdout: "", stderr: "" })
      }, 60_000)
      killTimer.unref()
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString("utf8")
      })
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8")
      })
      // Reject on spawn errors (e.g. ENOENT when `op` is not installed).
      // The engine's catch branch sanitizes to "op item list failed (spawn error)",
      // so no raw error message or path reaches lastError.
      child.on("error", (err: Error) => fail(err))
      child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }))
      if (input.stdin !== undefined && child.stdin !== null) {
        child.stdin.on("error", () => undefined) // EPIPE on a fast exit must not crash
        child.stdin.write(input.stdin)
        child.stdin.end()
      }
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)))
    }
  })

/**
 * Var NAMES currently present in ~/.luna/.env — for the Vault reconciler
 * (adopting pre-Vault secrets into the registry). Names only; values are
 * never read into the result.
 */
const readEnvFileVarNames = (): ReadonlyArray<string> => {
  const envPath = resolveRuntimePaths().envFilePath
  let lines: ReadonlyArray<string>
  try {
    lines = readFileSync(envPath, "utf8").split("\n")
  } catch {
    return []
  }
  const names: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (t === "" || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq === -1) continue
    const key = t.slice(0, eq).trim()
    if (key) names.push(key)
  }
  return names
}

const CHAT_SERVICE_LABEL = "com.user.luna-chat-server"

/**
 * Trigger a supervised restart so `discoverOpTokens` re-runs with the new
 * token. The mechanism is platform-specific because the supervisors differ:
 *
 *   linux/incus — systemd `Restart=always` respawns on ANY exit, so a graceful
 *     self-SIGTERM (→ dispose → exit 0) is enough.
 *   darwin — the launchd plist uses `KeepAlive { SuccessfulExit = false }`,
 *     which DELIBERATELY does NOT respawn a clean exit 0 (anti-restart-loop).
 *     A self-SIGTERM there would leave the server dead. So force a restart with
 *     `launchctl kickstart -k` — exactly what control.restart does.
 */
// Process-wide idempotency: this is invoked from several independent paths
// (the Settings register-op-token handler, and the secret bridge's per-thread
// deferred activation). Two triggers within the ~300ms window must NOT each
// fire a restart — on darwin a second `launchctl kickstart -k` arriving just
// after the first can kill the freshly respawned process mid-boot (during
// discoverOpTokens / broker hydration), delaying recovery. First call wins.
let serverRestartScheduled = false
const scheduleServerRestart = (): void => {
  if (serverRestartScheduled) return
  serverRestartScheduled = true
  setTimeout(() => {
    try {
      if (process.platform === "darwin") {
        const uid = userInfo().uid
        spawn("launchctl", ["kickstart", "-k", `gui/${uid}/${CHAT_SERVICE_LABEL}`], {
          stdio: "ignore",
          detached: true,
        }).unref()
      } else {
        // systemd Restart=always respawns the exit(0) from the SIGTERM handler.
        process.kill(process.pid, "SIGTERM")
      }
    } catch {
      process.exit(0)
    }
  }, 300)
}

const registerOpTokenHandler = makeRegisterOpToken({
  isLabelRegistered: (label) => OP_ACCOUNTS.some((a) => a.label === label),
  validateToken: opWhoami,
  persist: persistOpToken,
  // Defer so the register-op-token-status frame flushes before the socket drops.
  scheduleRestart: scheduleServerRestart,
  log: (msg) => writeSync(1, `${msg}\n`),
})

/**
 * Persist an env-var secret: atomic upsert of `NAME=value` into `~/.luna/.env`
 * (0600), mirroring the boot loader's parsing (first `=`, trimmed key), then set
 * `process.env[NAME]` live (EnvSecretProvider reads process.env per-resolve).
 * The deferred restart covers account-broker hydration. The value is never
 * logged. Callers pre-validate (makeRegisterSecret, setClientCredentials), but
 * the no-newline invariant is ALSO enforced here so every writer — present and
 * future — is covered (review M2.6: an interior \n in a value would inject an
 * extra line into ~/.luna/.env).
 */
/**
 * Defense-in-depth reserved-name predicate (mirrors isEnvDenied in
 * @luna/vault/src/internal.ts). Inlined so persistEnvSecret stays
 * self-contained. Check is CASE-INSENSITIVE (audit finding).
 *
 * CONNECTOR BYPASS: the connector OAuth path (storeSecret) writes
 * LUNA_CONNECTOR_* vars intentionally — those are legitimate internal
 * machinery (the agent has zero control over their names; they are
 * synthesised from the connector definition id). The guard is therefore
 * applied ONLY to registerSecret-reachable paths (operator/agent input).
 * The connector's storeSecret passes allowReserved=true to opt out.
 */
const _isEnvReservedLocal = (varName: string): boolean => {
  const upper = varName.toUpperCase()
  return upper === "UI_WS_TOKEN" || upper.startsWith("LUNA_")
}

const persistEnvSecret = (varName: string, value: string, allowReserved = false): Promise<void> =>
  new Promise((resolve, reject) => {
    try {
      if (/[=\r\n]/.test(varName)) {
        reject(new Error("env var name must not contain '=' or line breaks"))
        return
      }
      if (/[\r\n]/.test(value)) {
        reject(new Error("env secret value must not contain line breaks"))
        return
      }
      // SECURITY (audit finding, defense-in-depth): a second reserved-name
      // gate so any future writer that calls persistEnvSecret directly
      // (bypassing makeRegisterSecret) cannot overwrite Luna internals.
      // The connector OAuth path passes allowReserved=true — see comment above.
      if (!allowReserved && _isEnvReservedLocal(varName)) {
        reject(new Error(`env var name "${varName}" is reserved for Luna internals`))
        return
      }
      const envPath = resolveRuntimePaths().envFilePath
      let lines: ReadonlyArray<string> = []
      try {
        lines = readFileSync(envPath, "utf8").split("\n")
      } catch {
        lines = []
      }
      let replaced = false
      const out = lines.map((line) => {
        const t = line.trim()
        if (t === "" || t.startsWith("#")) return line
        const eq = t.indexOf("=")
        if (eq !== -1 && t.slice(0, eq).trim() === varName) {
          replaced = true
          return `${varName}=${value}`
        }
        return line
      })
      const body = replaced ? out : [...out]
      if (!replaced) {
        while (body.length > 0 && body[body.length - 1]!.trim() === "") body.pop()
        body.push(`${varName}=${value}`)
      }
      const content = `${body.join("\n")}\n`
      mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 })
      const tmp = `${envPath}.tmp-${process.pid}`
      writeFileSync(tmp, content, { mode: 0o600 })
      renameSync(tmp, envPath)
      chmodSync(envPath, 0o600) // writeFileSync mode is pre-umask; force 0600
      process.env[varName] = value
      resolve()
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })

/**
 * Remove a var from ~/.luna/.env + process.env (connector disconnect drops
 * its revoked refresh token — review G2). Atomic rewrite, 0600, best-effort
 * (a missing file/var is a no-op). Mirrors persistEnvSecret's IO posture.
 */
const removeEnvSecret = (varName: string): Promise<void> =>
  new Promise((resolve, reject) => {
    try {
      delete process.env[varName]
      const envPath = resolveRuntimePaths().envFilePath
      let lines: ReadonlyArray<string>
      try {
        lines = readFileSync(envPath, "utf8").split("\n")
      } catch {
        resolve() // no file → nothing to remove
        return
      }
      const kept = lines.filter((line) => {
        const t = line.trim()
        if (t === "" || t.startsWith("#")) return true
        const eq = t.indexOf("=")
        return !(eq !== -1 && t.slice(0, eq).trim() === varName)
      })
      while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop()
      const content = kept.length > 0 ? `${kept.join("\n")}\n` : ""
      const tmp = `${envPath}.tmp-${process.pid}`
      writeFileSync(tmp, content, { mode: 0o600 })
      renameSync(tmp, envPath)
      chmodSync(envPath, 0o600)
      resolve()
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })

// ── Vault keychain storage (Darwin opt-in) ──────────────────────────────
//
// Keychain write/delete adapters for env-secret values. They map an env var
// NAME to its `luna.vault.<NAME>` keychain entry. Only ever invoked when the
// facade's effective mode is a keychain mode (Darwin) — on Linux/non-Darwin the
// facade short-circuits to `.env` and these are never called.
const writeKeychainEnvSecret = (varName: string, value: string): Promise<void> =>
  Effect.runPromise(
    writeKeychainSecret(keychainVaultQueryForEnvName(varName), value),
  )

const deleteKeychainEnvSecret = (varName: string): Promise<void> =>
  Effect.runPromise(
    deleteKeychainSecret(keychainVaultQueryForEnvName(varName)),
  )

// LUNA_VAULT_STORAGE selects where env-secret VALUES land: `.env` (default),
// or — on Darwin only — the macOS keychain. Resolved once at boot. The same
// mode also drives the read-side provider chain in buildBaseLayer below, so
// write target and read source stay in lockstep.
const vaultStorageMode = normalizeVaultStorageMode(
  process.env["LUNA_VAULT_STORAGE"],
  process.platform,
)

// Single write/delete facade the Vault env-secret paths funnel through
// (registerSecret + vault mutations). `writeEnv`/`removeEnv` retain the
// reserved-name gate + atomic .env IO; `writeKeychain`/`deleteKeychain` hit
// the keychain. process.env is mirrored either way so live resolution needs
// no restart.
const vaultSecretStore = makeVaultSecretStore({
  platform: process.platform,
  mode: vaultStorageMode,
  env: process.env,
  writeEnv: persistEnvSecret,
  removeEnv: removeEnvSecret,
  writeKeychain: writeKeychainEnvSecret,
  deleteKeychain: deleteKeychainEnvSecret,
})

// ── Moon agent-summoned secure secret entry ─────────────────────────────
//
// The `request_secret` tool (in @luna/secret-tools) calls
// `secretRequestBridge.request(...)`, which summons a secure field in Moon,
// awaits the operator's value, hands it to `registerSecret` for storage, and
// returns ONLY {ok,message} (the value never leaves the bridge). On a
// successful store the bridge DEFERS activation to the requesting thread's
// `turn-complete` (so the restart never kills the calling turn).
//
// `registerSecret` reuses the same effectful primitives as the Settings
// `register-op-token` path (op whoami + persistOpToken) plus persistEnvSecret.
// Supports `op-token` and `env-secret`; an account-pointer destination is
// added in a later slice. (`file-secret` is intentionally unsupported —
// FileSecretProvider is not wired into the prod chain.)
const registerSecret = makeRegisterSecret({
  isLabelRegistered: (label) => OP_ACCOUNTS.some((a) => a.label === label),
  validateOpToken: async (token) => {
    const c = await opWhoami(token)
    return c.ok ? { ok: true, message: "" } : { ok: false, message: c.message }
  },
  persistOpToken,
  // Vault env-secrets funnel through the storage-mode facade so a keychain
  // mode (Darwin) writes the value to luna.vault.<NAME> instead of plaintext
  // .env. Default `env` mode is byte-identical to the prior direct call.
  persistEnvSecret: vaultSecretStore.persistEnvSecret,
  log: (msg) => writeSync(1, `${msg}\n`),
})

// Vault registry hook — assigned inside buildServerLayer once the VaultStore
// resolves (same late-binding pattern as `notifySkillCatalogChanged`). Both
// secret WRITE paths that bypass the Vault UI (the agent's request_secret and
// the Settings register-op-token form) call it after a successful store so
// every captured credential appears in the Vault registry. Fire-and-forget:
// a hook failure must never fail the store that already succeeded.
//
// V3 outbound sync: the hook ALSO receives the captured VALUE so env-secret
// captures can be pushed to 1Password when sync is enabled (op-token captures
// never push). The value stays inside the hook's closure — it is never
// logged, never stored in the registry, and only ever handed to
// opSync.createItem (which moves it to `op` via a stdin JSON template).
let vaultCaptureHook:
  | ((destination: SecretDestination, source: "agent" | "manual", value: string) => void)
  | null = null

// Summon-by-name (widget-system.md): the Moon announces its widget
// directory after hello; the agent's open_widget tool sends widget-open
// frames back through this bridge. Constructed before the tool layers so
// the open_widget tool and the WS server share the instance.
const widgetSummonBridge = createWidgetSummonBridge()

// Live Agents view (S4): folds each thread's subagent tool frames into a tree
// and broadcasts it to every client. Process-wide (shared across connections)
// so one thread's tree is consistent no matter which window observes it.
const subagentTreeBridge = createSubagentTreeBridge()

// Job-summoned operator input (widget-system.md Phase 5): a running job's
// `request_input` tool broadcasts a question to every connected client and
// awaits the first answer (the run parks in job_runs.status='waiting'
// meanwhile). Constructed before the worker layers so the request_input
// provider and the WS server share the instance — same shape as the
// widget-summon bridge above. The answer is operator input, not a secret,
// but the log dep still only ever sees request metadata, never the text.
const jobInputBridge = createJobInputBridge({
  log: (msg) => writeSync(1, `${msg}\n`),
})

const secretRequestBridge = createSecretRequestBridge({
  persistSecret: async (destination, secret) => {
    const result = await registerSecret(destination as SecretDestination, secret)
    if (result.ok) {
      try {
        vaultCaptureHook?.(destination as SecretDestination, "agent", secret)
      } catch {
        // Registry bookkeeping must never fail a store that succeeded.
      }
    }
    return result
  },
  // Activation = the same supervised restart the Settings path uses, so token
  // discovery + account-broker hydration re-run with the stored secret. Fired
  // by the bridge at turn-complete (or its long fallback), never mid-turn.
  scheduleActivation: scheduleServerRestart,
  log: (msg) => writeSync(1, `${msg}\n`),
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
   * AccountBroker layer. A5/A6: DreamReasonerDefault now requires AccountBroker
   * (it acquires a credential per reason() through the provider seam so the
   * nightly Dream can run on a cheap model via LUNA_DREAM_MODEL). The live boot
   * passes the same `brokerL` (AccountBrokerLayer.fromSql) it wires into the
   * chat adapter; the boot smoke passes a seeded fake broker (fromAccounts) so
   * the graph still composes without a missing-service defect.
   */
  readonly brokerL: Layer.Layer<AccountBroker>
  /**
   * DreamStore layer to use. The live boot passes
   * `DreamStore.makeLayer(paths.lunaDbPath).pipe(Layer.provide(clockL))`
   * (which requires LunaSqliteBootstrap, satisfied at the bottom of
   * buildServerLayer). The boot smoke passes `DreamStore.Memory` (no SQLite
   * needed) to keep the smoke node-runnable.
   */
  readonly dreamStoreL: Layer.Layer<DreamStore>
  /**
   * MEASURE-ONLY calibration sink (Slices A/3/B). OPTIONAL by design — both
   * consumers read it via Effect.serviceOption, so it must be present in the
   * cron fiber's RUNTIME CONTEXT (provided into this composition) to do
   * anything: applyOps records calibration rows, and the reasoner runs its
   * N-pass sampling extras ONLY when the sink is present (no sink = extras
   * skipped, no SDK cost). Omitting it keeps the old graph byte-identical;
   * applyOps then logs a warning per belief proposal so an unwired sink is
   * visible in the dream logs. The live boot passes
   * `CalibrationStore.makeLayer(paths.lunaDbPath).pipe(Layer.provide(clockL))`.
   */
  readonly calibrationStoreL?: Layer.Layer<
    CalibrationStore,
    import("effect").ConfigError,
    import("@luna/memory").LunaSqliteBootstrap
  >
  /**
   * M5 cutover (scheduler-v2 dream/wake migration, DESIGN.md §5.3.5). When
   * TRUE, this factory registers NO legacy dream cron — it returns an empty
   * Layer so `registerDreamCron` is never called and no fiber-per-cron trigger
   * is installed. The nightly dream then runs EXCLUSIVELY through the V2 path
   * (the `dream` job row drained by the JobTicker into the dream worker), so
   * the cycle can never double-run. The live boot passes the SAME
   * `LUNA_SCHEDULER_V2_ENABLED=1` flag that turns the V2 ticker on, so the boot
   * graph contains EITHER the legacy cron OR the V2 ticker, never both.
   * Reversible: flip the flag off and the legacy cron re-registers unchanged.
   */
  readonly schedulerV2Enabled?: boolean
}

export const buildDreamCronLayer = (opts: BuildDreamCronLayerOpts) => {
  // M5 cutover gate: under V2, the dream job row drives the cycle — register
  // no legacy cron trigger here (return early, BEFORE building the sub-graph,
  // so registerDreamCron is never reached). Layer.empty contributes nothing to
  // the boot mergeAll. See BuildDreamCronLayerOpts.schedulerV2Enabled.
  if (opts.schedulerV2Enabled === true) {
    return Layer.empty
  }
  const { expr, sdkClientL, memoryRouterL, storeL, clockL, dreamStoreL, brokerL } =
    opts
  // DreamReasonerDefault requires SDKClient, MemoryRouter AND AccountBroker
  // (closes over all three at build time so reason()'s R channel is never).
  // SDKClient is the real dependency this smoke proves is satisfiable —
  // SDKClient.fake keeps it real while making zero model calls. brokerL is the
  // provider-seam dependency (A5): the reasoner acquires a credential per turn.
  const dreamReasonerL = DreamReasonerDefault.pipe(
    Layer.provide(sdkClientL),
    Layer.provide(memoryRouterL),
    Layer.provide(brokerL),
  )
  const base = DreamCronLayer(expr).pipe(
    Layer.provide(dreamStoreL),
    Layer.provide(dreamReasonerL),
    Layer.provide(storeL),
    Layer.provide(memoryRouterL),
    Layer.provide(clockL),
  )
  // serviceOption deps must be IN the composition (not merely somewhere in the
  // server) for the forked cron fiber to inherit them.
  return opts.calibrationStoreL === undefined
    ? base
    : base.pipe(Layer.provide(opts.calibrationStoreL))
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

// ── Wake sub-layer factory ──────────────────────────────────────────────
//
// Path A (per Luna self-dev workspace decision log entry "Path A chosen"):
// at each cron tick, a single-shot WakeReasoner SDK call inspects the
// workspace's open goals + next_actions + recent wakes and emits a JSON
// digest into the workspace's `wake_log` table. No autonomous execution
// — operator (or future Path B multi-turn agent) acts on the digest.
//
// Inputs from outside:
//   - expr            — cron expression for the wake cycle (e.g. "*/30 * * * *").
//   - workspaceSlug   — slug of the workspace this wake watches.
//   - workspacePath   — absolute path to that workspace's repo root.
//                       Reader opens <path>/.workspace/workspace.db.
//   - sdkClientL      — shared SDKClient layer (real on live boot, fake in smokes).
//   - clockL          — shared Clock layer (same instance as scheduler clock).
//
// WakeReasonerDefault requires SDKClient. WakeLogStore.makeLayer opens
// workspace.db (which must exist; bootstrap-workspace.ts creates it).
// WakeCronLayer encapsulates its own JobScheduler+TriggerAgent (same as
// DreamCronLayer — independent fiber-set keeps wake fires isolated).
export interface BuildWakeCronLayerOpts {
  readonly expr: string
  readonly workspaceSlug: string
  readonly workspacePath: string
  readonly sdkClientL: Layer.Layer<SDKClient>
  readonly clockL: Layer.Layer<Clock>
  /**
   * AgentNotesService layer. Each wake fire is mirrored into agent_notes
   * (kind='wake_digest', sessionId='wake-cron') so the operator sees
   * recent wake reasoning in obs_notes_recent without querying the
   * workspace-scoped wake_log table directly.
   */
  readonly agentNotesL: Layer.Layer<AgentNotesService>
  /**
   * AccountBroker layer. A5/A6: WakeReasonerDefault now requires AccountBroker
   * (it acquires a credential per reason() through the provider seam so the
   * wake cron can run on a cheap model via LUNA_WAKE_MODEL). The live boot
   * passes the same `brokerL` it wires into the chat adapter; the boot smoke
   * passes a seeded fake broker (fromAccounts) so the graph still composes.
   */
  readonly brokerL: Layer.Layer<AccountBroker>
  /**
   * M5 cutover (scheduler-v2 dream/wake migration, DESIGN.md §5.3.5). When
   * TRUE, this factory registers NO legacy wake cron — it returns an empty
   * Layer so `registerWakeCron` is never called and no fiber-per-cron trigger
   * is installed. The wake cycle then runs EXCLUSIVELY through the V2 path (the
   * per-workspace `wake` job rows drained by the JobTicker into the wake
   * worker), so it can never double-run. The live boot passes the SAME
   * `LUNA_SCHEDULER_V2_ENABLED=1` flag that turns the V2 ticker on, so the boot
   * graph contains EITHER the legacy cron OR the V2 ticker, never both.
   * Reversible: flip the flag off and the legacy cron re-registers unchanged.
   */
  readonly schedulerV2Enabled?: boolean
}

export const buildWakeCronLayer = (opts: BuildWakeCronLayerOpts) => {
  // M5 cutover gate: under V2, the per-workspace wake job rows drive the cycle
  // — register no legacy cron trigger here (return early, BEFORE building the
  // sub-graph, so registerWakeCron is never reached). Layer.empty contributes
  // nothing to the boot mergeAll. See BuildWakeCronLayerOpts.schedulerV2Enabled.
  if (opts.schedulerV2Enabled === true) {
    return Layer.empty
  }
  const wakeReasonerL = WakeReasonerDefault.pipe(
    Layer.provide(opts.sdkClientL),
    Layer.provide(opts.brokerL),
  )
  const wakeLogStoreL = WakeLogStore.makeLayer(
    `${opts.workspacePath}/.workspace/workspace.db`,
  )
  return WakeCronLayer(opts.expr, {
    workspaceSlug: opts.workspaceSlug,
    workspacePath: opts.workspacePath,
  }).pipe(
    Layer.provide(wakeReasonerL),
    Layer.provide(wakeLogStoreL),
    Layer.provide(opts.agentNotesL),
    Layer.provide(opts.clockL),
  )
}

// ── V2 worker registry factory (M3 boot wiring) ────────────────────────
//
// Compose the V2 JobTicker's WorkerRegistry, seeded with ALL worker kinds the
// chat-server ships: the generic `prompt` + `workflow` workers (adapter-sdk)
// AND the dedicated `dream` + `wake` workers (scheduler-v2 dream/wake
// migration, M1 + M2). A JobTicker draining the `jobs` table dispatches a
// claimed row to the worker registered under its `kind`, so dream/wake rows are
// runnable iff their kinds are registered here.
//
// Exported (and used BY buildBaseLayer) so the live boot and the M3 integration
// test share ONE code path: the test builds this with fake/in-memory leaf
// layers and asserts listKinds superset {prompt, workflow, dream, wake}.
//
// Leaf deps are passed in (already built by the caller) so this stays a pure
// composition with no SDKClient / SQLite / workspace.db assumptions of its own.
// Optional deps (calibrationStoreL — dream's ECE serviceOption sink;
// jobInputToolsL — the prompt/workflow request_input serviceOption provider) are
// folded in only when supplied, exactly mirroring the prior inline wiring +
// buildDreamCronLayer's optional-calibration handling.
export interface BuildWorkerRegistryLayerOpts {
  readonly clockL: Layer.Layer<Clock>
  readonly sdkClientL: Layer.Layer<SDKClient>
  readonly agentNotesL: Layer.Layer<AgentNotesService>
  /** Optional per-run request_input provider (prompt/workflow serviceOption). */
  readonly jobInputToolsL?: Layer.Layer<import("@luna/adapter-sdk").JobRunToolsProvider>
  /** Optional chat_thread delivery sink (#124) — prompt worker serviceOption. */
  readonly chatThreadPosterL?: Layer.Layer<import("@luna/adapter-sdk").ChatThreadPoster>
  // dream leaf deps (DreamWorkerLayer R = DreamStore|DreamReasoner|SessionStore|MemoryRouter|Clock)
  readonly dreamStoreL: Layer.Layer<DreamStore, import("effect").ConfigError, import("@luna/memory").LunaSqliteBootstrap>
  readonly dreamReasonerL: Layer.Layer<import("@luna/core").DreamReasoner>
  readonly sessionStoreL: Layer.Layer<SessionStore>
  readonly memoryRouterL: Layer.Layer<import("@luna/memory").MemoryRouter, import("effect").ConfigError, import("@luna/memory").LunaSqliteBootstrap>
  /** Optional ECE calibration sink (dream serviceOption). */
  readonly calibrationStoreL?: Layer.Layer<CalibrationStore, import("effect").ConfigError, import("@luna/memory").LunaSqliteBootstrap>
  // wake leaf deps (WakeWorkerLayer R = WakeReasoner|WakeLogStore|AgentNotesService|Clock)
  readonly wakeReasonerL: Layer.Layer<import("@luna/core").WakeReasoner>
  readonly wakeLogStoreL: Layer.Layer<WakeLogStore, import("effect").ConfigError>
}

export const buildWorkerRegistryLayer = (
  opts: BuildWorkerRegistryLayerOpts,
) => {
  // The four worker-registration layers. Each yields WorkerRegistry + its own
  // service deps and registers a closed-over Worker<never> at build time.
  const workers = Layer.mergeAll(
    PromptWorkerLayer(),
    WorkflowWorkerLayer(),
    DreamWorkerLayer(),
    WakeWorkerLayer(),
  )
  // Shared base: ONE empty registry + every leaf dep the four workers reach.
  // Optional deps are merged only when provided (serviceOption keeps the
  // workers' R from growing, so omitting them is safe).
  const base = Layer.mergeAll(
    makeWorkerRegistry({}),
    opts.sdkClientL,
    opts.agentNotesL,
    opts.dreamStoreL,
    opts.dreamReasonerL,
    opts.sessionStoreL,
    opts.memoryRouterL,
    opts.wakeReasonerL,
    opts.wakeLogStoreL,
    opts.clockL,
  )
  const withJobTools =
    opts.jobInputToolsL === undefined
      ? base
      : Layer.merge(base, opts.jobInputToolsL)
  const withCalibration =
    opts.calibrationStoreL === undefined
      ? withJobTools
      : Layer.merge(withJobTools, opts.calibrationStoreL)
  // #124 chat_thread delivery sink — folded in only when supplied, exactly like
  // jobInputToolsL above. PromptWorker resolves ChatThreadPosterTag via
  // serviceOption, so omitting it keeps the workers' R clean (no chat_thread
  // delivery, the pre-#124 behaviour).
  const withChatPoster =
    opts.chatThreadPosterL === undefined
      ? withCalibration
      : Layer.merge(withCalibration, opts.chatThreadPosterL)
  // provideMerge so the registry stays VISIBLE above this layer (JobTickerLayer
  // + the integration test both yield* WorkerRegistry from the result).
  return workers.pipe(Layer.provideMerge(withChatPoster))
}

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
  // Vault keychain migration: on a Darwin keychain mode, resolve `env:*` from
  // luna.vault.<NAME> keychain entries FIRST, then fall through to `.env`.
  // Both keychain modes keep the `.env` reader as the final fallback — it is
  // load-bearing for names that are NEVER migrated to the keychain: reserved
  // refs (connector OAuth `env:LUNA_CONNECTOR_*`, `UI_WS_TOKEN`) live only in
  // `.env` (the migration planner skips reserved names). Dropping the env
  // reader would strand every connector (review finding).
  //
  // The difference between the two keychain modes is OPERATIONAL, not in the
  // read chain: `keychain-preferred` is the pre-prune dual-read state where
  // `.env` still holds the migrated values (so `LUNA_VAULT_STORAGE=env`
  // rollback works); `keychain-only` is the post-prune state where the prune
  // step has removed the MIGRATED (non-reserved) values from `.env`, so they
  // resolve from the keychain only — the env tail then serves reserved refs
  // alone and can never resurrect a migrated secret. Linux/non-Darwin never reaches a
  // keychain mode (normalizeVaultStorageMode forces env), so the chain is
  // unchanged there.
  const keychainEnvProviderL = KeychainEnvSecretProvider.make()
  const secretL =
    vaultStorageMode === "keychain-preferred" ||
    vaultStorageMode === "keychain-only"
      ? secretProviderFirstOf([routedOpL, keychainEnvProviderL, envProviderL])
      : secretProviderFirstOf([routedOpL, envProviderL])

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

  // WorkspaceRegistryService: SQLite-backed table of known workspaces
  // (slug/path/summary/status) in luna.db. Side-effect Layer at boot — it
  // forces the `workspaces` table migration to run so SYSTEM.md §Workspaces
  // discovery (`SELECT … FROM workspaces`) actually returns rows.
  // LunaSqliteBootstrap is satisfied at the bottom of buildServerLayer,
  // same as every other SQLite-backed layer here.
  const workspacesL = WorkspaceRegistryService.makeLayer(paths.lunaDbPath).pipe(
    Layer.provide(clockL),
  )

  // JobsStoreService: SQLite-backed `jobs` table (DESIGN.md §5.1) in luna.db.
  // Required by SchedulerToolsLayer: a schedule created via
  // mcp__scheduler__schedule_create is a durable `jobs` row, and the V2
  // JobTicker reads it via listDue every tick — so a chat-server restart is a
  // zero-tick gap with nothing to re-register. LunaSqliteBootstrap satisfied at
  // the bottom of buildServerLayer, same pattern as agent-notes / workspaces.
  const jobsStoreL = JobsStoreService.makeLayer(paths.lunaDbPath).pipe(
    Layer.provide(clockL),
  )

  // Suggested Actions: the durable per-thread store + the shared service the
  // live `suggest_action` tool, Dream, and the ui-ws respond handle all use.
  // Define ONCE and reuse by reference (Layer memoization) so the chat
  // changes-consumer, the thread tool, and the accept handle hit the SAME
  // instance — otherwise the change-stream never reaches the chat layer.
  const suggestedActionsStoreL = SuggestedActionsStore.makeLayer(
    paths.lunaDbPath,
  ).pipe(Layer.provide(clockL))
  const suggestedActionsL = SuggestedActions.layer.pipe(
    Layer.provide(suggestedActionsStoreL),
  )
  // AcceptHandler: auto-executes an accepted action as a durable one-shot job
  // (the V2 ticker dispatches it — on by default; LUNA_SCHEDULER_V2_ENABLED=0
  // disables) and forks the completion observer. Resolved via serviceOption
  // inside SuggestedActions.respond — present here means accept actually runs.
  const acceptHandlerL = AcceptHandlerLayer().pipe(
    Layer.provide(suggestedActionsL),
    Layer.provide(jobsStoreL),
    Layer.provide(clockL),
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

  // PRD Part B: the skill catalog, seeded with the in-repo built-ins and
  // hydrated from the skill_preferences table (delta-only: absent row =
  // enabled). Toggles write through to the store BEFORE the in-memory
  // flip, so memory and disk can never disagree. Defined once and reused
  // by reference (Layer memoization) so the thread-tools wiring and the
  // ui-ws skill frames see the SAME registry instance.
  //
  // This layer also OWNS the ~/.luna/skills hot-load fiber (boot scan +
  // 30s refresh, the beliefs-holder pattern) because the quarantine needs
  // the prefs store: a NEVER-DECIDED user skill registers DISABLED until
  // the operator enables it in the Skills tab (review finding: the agent
  // can write ~/.luna/skills via local-shell, so auto-enabling new files
  // would be a persistent prompt-injection channel). Catalog deltas ping
  // notifySkillCatalogChanged so ui-ws broadcasts a fresh catalog to
  // long-lived clients.
  // LunaSqliteBootstrap flows up from the prefs store and is satisfied at
  // the bottom of buildServerLayer, same as every other SQLite layer here.
  const skillPrefsL = SkillPrefsStore.makeLayer(paths.lunaDbPath).pipe(
    Layer.provide(clockL),
  )
  const skillRegistryL = Layer.scoped(
    SkillRegistry,
    Effect.gen(function* () {
      const prefs = yield* SkillPrefsStore
      const disabled = yield* prefs.disabledIds()
      if (disabled.length > 0) {
        console.log(
          "[luna/boot] skill_preferences hydrated:",
          disabled.length,
          "disabled —",
          disabled.join(", "),
        )
      }
      const ctx = yield* Layer.build(
        SkillRegistry.layer({
          seeds: BUILTIN_SKILLS,
          initialDisabled: disabled,
          onToggle: (id, enabled) => prefs.setEnabled(id, enabled),
          // PRD B §11 (S4): index disclosure — the system prompt carries a
          // one-line index of enabled skills; bodies load on demand via the
          // skill_tools.skill_load MCP tool. Keeps 100+ enabled skills from
          // bloating every turn's context.
          disclosure: "index",
        }),
      )
      const registry = Context.get(ctx, SkillRegistry)

      const userSkillsDir = join(resolveRuntimePaths().lunaHome, "skills")
      const refreshUserSkills = Effect.gen(function* () {
        const scan = scanUserSkills(userSkillsDir)
        const approvedIds = new Set(yield* prefs.knownIds())
        const summary = yield* syncUserSkills(registry, scan, { approvedIds })
        if (summary.added + summary.updated + summary.removed > 0) {
          console.log(
            `[luna/skills] user skills synced: +${summary.added} ~${summary.updated} -${summary.removed}`,
          )
          // Long-lived clients (the Moon) must see hot-load deltas without
          // a reconnect — ui-ws registered this via skillsWsHandle.changes.
          notifySkillCatalogChanged?.()
        }
        if (summary.quarantined.length > 0) {
          console.warn(
            "[luna/skills] NEW user skill(s) found and DISABLED pending your approval " +
              "(enable in Settings → Skills):",
            summary.quarantined.join(", "),
          )
        }
        if (summary.conflicts.length > 0) {
          console.warn(
            "[luna/skills] user skills shadowing built-ins were SKIPPED:",
            summary.conflicts.join(", "),
          )
        }
        for (const w of scan.warnings) console.warn("[luna/skills]", w)
      }).pipe(
        // Never take the boot/loop down — but never swallow silently either
        // (review finding): squashed causes get an operator-visible line.
        Effect.catchAllCause((cause) =>
          Effect.sync(() =>
            console.warn("[luna/skills] user-skill sync failed:", String(cause)),
          ),
        ),
      )
      yield* refreshUserSkills
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(30_000).pipe(Effect.zipRight(refreshUserSkills)),
        ),
      )

      return registry
    }),
  ).pipe(Layer.provide(skillPrefsL))

  // Per-thread tool wiring, provided INTO ChatService so both new and
  // resumed threads get tools (the resume path bypasses any outer wrapper).
  // LunaSqliteBootstrap flows up and is satisfied at the bottom of
  // buildServerLayer, same as every other SQLite-backed layer here.
  // PRD Part A: connector instances (luna.db) + the service whose sync
  // mount snapshot decorate() spreads into every thread's mcpServers.
  // Defined once and merged into the base layer too (memoized by
  // reference) so the WS frames talk to the SAME instance.
  const connectorStoreL = ConnectorInstanceStore.makeLayer(paths.lunaDbPath).pipe(
    Layer.provide(clockL),
  )
  // PRD Part C/W1: durable pinned-artifact store (artifacts + artifact_versions
  // in luna.db). Resolved by buildServerLayer for the ui-ws artifact frames.
  const artifactStoreL = ArtifactStore.makeLayer(paths.lunaDbPath).pipe(
    Layer.provide(clockL),
  )
  // Vault V1: credential REGISTRY (vault_items + vault_sync_config in luna.db).
  // Pointers/metadata only — values stay in the existing backends (~/.luna/.env,
  // keychain luna.op.*, op-token files). Resolved by buildServerLayer for the
  // ui-ws vault frames; LunaSqliteBootstrap bubbles up like every store here.
  const vaultStoreL = VaultStore.makeLayer(paths.lunaDbPath).pipe(
    Layer.provide(clockL),
  )
  const connectorServiceL = ConnectorServiceLayer({
    definitions: BUILTIN_CONNECTORS,
    // PRD A §09: the OAuth half. storeSecret persists the refresh token
    // to ~/.luna/.env (0600, atomic) AND sets process.env so the
    // EnvSecretProvider resolves it immediately — no restart. The
    // per-operator client id/secret resolve from process.env (operator
    // setup step, PRD §23).
    oauth: {
      client: makeOAuthClient(),
      storeSecret: (varName, value) =>
        Effect.tryPromise({
          try: async () => {
            process.env[varName] = value
            // allowReserved=true: connector var names (LUNA_CONNECTOR_*) are
            // legitimate internal machinery — their names are synthesised from
            // the connector definition id, not controlled by operator/agent.
            await persistEnvSecret(varName, value, true)
            return `env:${varName}`
          },
          catch: (e) =>
            new ConnectorError({
              op: "storeSecret",
              message: `failed to persist the token: ${String(e)}`,
            }),
        }),
      // Disconnect drops the revoked refresh token from ~/.luna/.env +
      // process.env (review G2). Best-effort — never fails disconnect.
      clearSecret: (varName) =>
        Effect.promise(() => removeEnvSecret(varName).catch(() => undefined)),
      env: process.env,
    },
  }).pipe(
    Layer.provide(connectorStoreL),
    Layer.provide(secretL),
    Layer.provide(clockL),
  )

  const threadToolsL = ThreadToolsProviderLayer().pipe(
    Layer.provide(memoryRouterL), // REQUIRED: satisfies MemoryRouterTag inside the layer (siblings don't cross-wire)
    // PRD Part B: skill_tools (skill_load) + the registry snapshot read by
    // decorate(). SkillToolsLayer requires SkillRegistry, so order matters:
    // provide the tools layer first, then the registry satisfies both it
    // and the provider (Layer.provide composes bottom-up).
    Layer.provide(SkillToolsLayer()),
    Layer.provide(skillRegistryL),
    // PRD Part C/W4: widget_tools (widget_write) — describe-to-spawn authoring.
    // WidgetToolsLayer requires ArtifactStore; provide the tools layer first,
    // then artifactStoreL satisfies both it and the WS handle (memoized).
    Layer.provide(WidgetToolsLayer(widgetSummonBridge)),
    Layer.provide(artifactStoreL),
    // Suggested Actions: suggest_action MCP tool. SuggestedActionToolsLayer
    // requires the shared SuggestedActions service; provide the tool layer then
    // the service (same memoized instance the chat layer + accept handle use).
    Layer.provide(SuggestedActionToolsLayer),
    Layer.provide(suggestedActionsL),
    Layer.provide(connectorServiceL), // PRD Part A: mounts read by decorate()
    Layer.provide(obsL),
    Layer.provide(clockL),
    // JobsStore required by SchedulerToolsLayer for durable cron persistence
    // (DESIGN.md §5.1). Same cross-sibling-wiring lesson as telPlatformL below.
    Layer.provide(jobsStoreL),
    // Phase 14b (commit 57def9d) added EventSink + SessionSync as deps of
    // ObsToolsLayer (for the obs_pipeline_health tool's live counters).
    // ThreadToolsProviderLayer transitively pulls ObsToolsService, so those
    // requirements bubble up here too. telPlatformL outputs the EventSink +
    // SessionSync services; provide it explicitly to threadToolsL so the
    // top-level Layer.mergeAll doesn't need to play dependency-router across
    // siblings (mergeAll deliberately doesn't cross-wire — that's the
    // failure mode that left a fresh boot crashing with
    // "Service not found: luna/EventSink" on every restart from
    // c5dc3b3 onward, with the running long-lived process hiding the
    // regression in-memory).
    Layer.provide(telPlatformL),
  )

  // Phase 3 D1: nightly Dream cron. DreamCronLayer provides its OWN
  // JobScheduler+TriggerAgent (a second instance — harmless, like memoryRouterL).
  // DreamReasonerDefault (from adapter-sdk) requires both SDKClient + MemoryRouter;
  // we close over the boot's sdkClientL + memoryRouterL. DreamStore uses luna.db.
  // LunaSqliteBootstrap is satisfied at the bottom of buildServerLayer, same as
  // every other SQLite-backed layer here.
  const dreamStoreL = DreamStore.makeLayer(paths.lunaDbPath).pipe(Layer.provide(clockL))
  // MEASURE-ONLY calibration sink (PR #100): same luna.db, additive
  // calibration_log table. Presence of this layer is what turns the
  // instrumentation ON (rows recorded + reasoner sampling extras run);
  // see BuildDreamCronLayerOpts.calibrationStoreL.
  const calibrationStoreL = CalibrationStore.makeLayer(paths.lunaDbPath).pipe(
    Layer.provide(clockL),
  )

  // Scheduler V2 cutover flag (DESIGN.md §5.3 / §5.3.5). Computed HERE — before
  // the dream / wake cron layers — because the M5 cutover gates BOTH legacy
  // cron factories on it: when V2 is enabled the dream + wake cycles run
  // EXCLUSIVELY through their V2 job rows (the JobTicker dispatches them to the
  // dedicated dream / wake worker kinds), so the legacy fiber-per-cron layers
  // must register nothing or the cycles would double-run. The boot graph thus
  // contains EITHER the legacy crons OR the V2 ticker for dream/wake, never
  // both. Reversible: flip the flag off and the legacy crons re-register.
  const schedulerV2Enabled =
    process.env["LUNA_SCHEDULER_V2_ENABLED"]?.trim() === "1"

  const dreamCronL = buildDreamCronLayer({
    expr: "0 3 * * *",
    sdkClientL,
    memoryRouterL,
    storeL,
    clockL,
    dreamStoreL,
    calibrationStoreL,
    // A5: same broker the chat adapter uses — DreamReasonerDefault acquires a
    // credential per reason() through the provider seam (LUNA_DREAM_MODEL).
    brokerL,
    // M5 cutover: under V2 the dream job row drives the cycle — register no
    // legacy cron (buildDreamCronLayer returns Layer.empty when this is true).
    schedulerV2Enabled,
  })

  // Wake cron (Path A): WakeReasoner inspects the workspace state at each
  // tick and emits a JSON digest into <workspace>/.workspace/workspace.db's
  // wake_log table. Controlled by env so operators can disable / retune
  // without redeploying:
  //   LUNA_WAKE_ENABLED        — "0" disables the cron entirely (default: enabled)
  //   LUNA_WAKE_CRON_EXPR      — cron expression (default: "*/30 * * * *")
  //   LUNA_WAKE_WORKSPACE_SLUG — slug of the workspace to wake (default: "luna")
  //   LUNA_WAKE_WORKSPACE_PATH — repo root path; falls back to LUNA_REPO_ROOT
  //                              then process.cwd().
  // When disabled or the workspace path can't be resolved, the layer is
  // simply omitted from the mergeAll (no fiber registered).
  const wakeEnabled = process.env["LUNA_WAKE_ENABLED"]?.trim() !== "0"
  const wakeExpr =
    process.env["LUNA_WAKE_CRON_EXPR"]?.trim() || "*/30 * * * *"
  const wakeWorkspaceSlug =
    process.env["LUNA_WAKE_WORKSPACE_SLUG"]?.trim() || "luna"
  const wakeWorkspacePath =
    process.env["LUNA_WAKE_WORKSPACE_PATH"]?.trim() ||
    process.env["LUNA_REPO_ROOT"]?.trim() ||
    process.cwd()
  const wakeCronL = wakeEnabled
    ? buildWakeCronLayer({
        expr: wakeExpr,
        workspaceSlug: wakeWorkspaceSlug,
        workspacePath: wakeWorkspacePath,
        sdkClientL,
        clockL,
        agentNotesL,
        // A5: same broker the chat adapter uses — WakeReasonerDefault acquires a
        // credential per reason() through the provider seam (LUNA_WAKE_MODEL).
        brokerL,
        // M5 cutover: under V2 the per-workspace wake job rows drive the cycle —
        // register no legacy cron (buildWakeCronLayer returns Layer.empty when
        // this is true).
        schedulerV2Enabled,
      })
    : null


  // Phase 12b (scheduler-rebuild) — DESIGN.md §5.3 / §5.3.5. Behind the
  // `LUNA_SCHEDULER_V2_ENABLED` flag (computed above). With the flag OFF
  // (default), the V2 ticker layer is omitted from the layer graph — no fiber
  // forked, no DB queries per minute — and the legacy dream / wake cron layers
  // register as before. With the flag ON, a single supervised JobTicker fiber
  // drains the `jobs` table every 60 s, claims due rows, and dispatches them
  // through the WorkerRegistry — which registers the prompt + workflow workers
  // AND the dedicated dream + wake workers (M1-M3). The M5 cutover (above) makes
  // buildDreamCronLayer / buildWakeCronLayer register NOTHING under the same
  // flag, so dream/wake run EXCLUSIVELY via their V2 job rows and never
  // double-fire. EITHER legacy crons OR the V2 ticker drive dream/wake — never
  // both.
  if (schedulerV2Enabled) {
    console.log(
      "[luna/sched] V2 ticker ENABLED (LUNA_SCHEDULER_V2_ENABLED=1) — kinds=prompt,workflow,dream,wake registered; legacy dream/wake cron layers DISABLED (run via V2 job rows)",
    )
  }
  // Phase 5 (widget-system.md): per-run request_input tool for the job
  // workers. The provider closes over the jobs store (to flip the run
  // running↔waiting) and the broadcast jobInputBridge (to reach connected
  // clients). The workers read the Tag via Effect.serviceOption, so this
  // layer is purely additive — omit it and they run tool-free as before.
  const jobInputToolsL = Layer.effect(
    JobRunToolsProviderTag,
    Effect.gen(function* () {
      const store = yield* JobsStoreService
      const runtime = yield* Effect.runtime<never>()
      const runPromise = Runtime.runPromise(runtime)
      return createJobInputToolsProvider({
        bridge: jobInputBridge,
        // Best-effort flip: a store failure resolves false (the tool treats
        // it as a no-op) — it must never fail the job's model turn.
        setRunStatus: (runId, status) =>
          runPromise(
            store
              .updateRunStatus(runId, status)
              .pipe(Effect.catchAll(() => Effect.succeed(false))),
          ),
      })
    }),
  ).pipe(Layer.provide(jobsStoreL))

  // ThreadRegistry: durable `threads` table in luna.db (Phase 1).
  // Replaces thread-session-map.json as the source of truth for
  // thread→SDK-session mapping across restarts. ChatService resolves this
  // via Effect.serviceOption — absent falls back to the legacy JSON map
  // path for backward compat.
  // LunaSqliteBootstrap is satisfied at the bottom of buildServerLayer,
  // same as every other SQLite-backed layer here.
  const threadRegistryL = ThreadRegistryService.makeLayer(paths.lunaDbPath).pipe(
    Layer.provide(clockL),
  )

  // Boot migration: one-shot import from the legacy JSON map into the
  // ThreadRegistry. Runs once at server boot (inside the ThreadRegistry's
  // Layer.scoped, so it's part of the boot sequence). Idempotent — existing
  // rows are skipped.
  const threadRegistryWithMigrationL = Layer.scoped(
    ThreadRegistryService,
    Effect.gen(function* () {
      // Build the SQLite-backed registry (which runs the migration DDL).
      // We acquire it via Context.get from the inner layer build.
      const ctx = yield* Layer.build(threadRegistryL)
      const reg = Context.get(ctx, ThreadRegistryService)

      // Run the JSON map import best-effort (don't fail boot on import error).
      const lunaHome = process.env["LUNA_HOME"]
      if (lunaHome !== undefined) {
        const defaultCwd =
          process.env["LUNA_REPO_ROOT"] ?? process.cwd()
        const nowMs = Date.now()
        // NOTE: this runs inside an Effect.gen generator (function*), so the
        // async importJsonMap must be awaited via Effect.tryPromise + yield*,
        // NOT a bare `await` (which is a syntax error in a non-async generator
        // and only slips past tsc's top-level-await handling).
        const importResult = yield* Effect.either(
          Effect.tryPromise({
            try: () =>
              importJsonMap(reg, lunaHome, defaultCwd, nowMs, {
                log: (level, msg) => {
                  if (level === "warn") console.warn(msg)
                  else console.log(msg)
                },
              }),
            catch: (e) => e as Error,
          }),
        )
        if (importResult._tag === "Right") {
          const result = importResult.right
          if (result.inserted > 0) {
            console.log(
              `[luna/thread-registry] boot import: inserted=${result.inserted} skippedNoSid=${result.skippedNoSid} skippedClaudeTest=${result.skippedClaudeTest} skippedAlreadyPresent=${result.skippedAlreadyPresent}`,
            )
          }
        } else {
          console.warn(
            `[luna/thread-registry] boot import failed (best-effort): ${String(importResult.left)}`,
          )
        }
      }

      return reg
    }),
  )

  // ChatService — hoisted above the worker registry so the chat_thread
  // delivery poster (#124) can be provided ChatService. Effect layers are
  // memoized by reference, so reusing this same `chatL` variable in both
  // `chatThreadPosterL` below and the final mergeAll instantiates ChatService
  // exactly once.
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
      // ChatService resolves SuggestedActions via Effect.serviceOption — wire
      // it so the change-stream consumer + replay-on-subscribe activate.
      suggestedActionsL,
      // ThreadRegistry: durable thread index. ChatService resolves via
      // Effect.serviceOption — absent falls back to legacy JSON map.
      threadRegistryWithMigrationL,
    ),
  )

  // #124: the chat_thread delivery sink. PromptWorker resolves
  // ChatThreadPosterTag via Effect.serviceOption; this layer provides it,
  // bridging the worker's finished result back into ChatService.deliverResult
  // (which persists it + pushes a frame to live subscribers + emits a global
  // toast notification). Same Effect.runtime/runPromise escape hatch as
  // jobInputToolsL above. Provided `chatL` so it can resolve ChatService.
  const chatThreadPosterL = Layer.effect(
    ChatThreadPosterTag,
    Effect.gen(function* () {
      const chat = yield* ChatService
      const runtime = yield* Effect.runtime<never>()
      const runPromise = Runtime.runPromise(runtime)
      return {
        post: (delivery) =>
          // Best-effort: deliverResult never fails (returns Option.none on a
          // missing thread), and we swallow anything else so a delivery hiccup
          // can never fail the job's run.
          Effect.promise(() =>
            runPromise(
              chat
                .deliverResult({
                  threadId: delivery.threadId,
                  text: delivery.text,
                  source: delivery.source ?? "background-job",
                  ...(delivery.label ? { label: delivery.label } : {}),
                })
                .pipe(Effect.asVoid, Effect.catchAllCause(() => Effect.void)),
            ),
          ),
      }
    }),
  ).pipe(Layer.provide(chatL))

  // V2 registry: ONE empty registry seeded with the prompt + workflow workers
  // (adapter-sdk) AND the dream + wake workers (scheduler-v2 dream/wake
  // migration, M1 + M2). buildWorkerRegistryLayer is the SAME factory the M3
  // integration test exercises with fakes, so the live boot and the test agree
  // on the kind set. provideMerge (inside the factory) keeps the registry
  // visible to JobTickerLayer above it. The #124 chat_thread delivery sink
  // (chatThreadPosterL) is threaded through so the prompt worker's
  // serviceOption resolves it at dispatch time — preserving deliver_to=chat_thread.
  //
  // dreamReasonerL / wakeReasonerL mirror what buildDreamCronLayer /
  // buildWakeCronLayer build internally (DreamReasonerDefault needs SDKClient +
  // MemoryRouter + AccountBroker; WakeReasonerDefault needs SDKClient +
  // AccountBroker), closing over the SAME boot identities (sdkClientL,
  // memoryRouterL, brokerL). wakeLogStoreL opens the wake workspace's
  // workspace.db at the same path the wake cron uses. These are built here (not
  // reused from the cron-layer factories, which keep them local) so the dream /
  // wake workers reach real services at dispatch time.
  const dreamWorkerReasonerL = DreamReasonerDefault.pipe(
    Layer.provide(sdkClientL),
    Layer.provide(memoryRouterL),
    Layer.provide(brokerL),
  )
  const wakeWorkerReasonerL = WakeReasonerDefault.pipe(
    Layer.provide(sdkClientL),
    Layer.provide(brokerL),
  )
  const wakeWorkerLogStoreL = WakeLogStore.makeLayer(
    `${wakeWorkspacePath}/.workspace/workspace.db`,
  )
  const workerRegistryL = buildWorkerRegistryLayer({
    clockL,
    sdkClientL,
    agentNotesL,
    jobInputToolsL,
    chatThreadPosterL,
    dreamStoreL,
    dreamReasonerL: dreamWorkerReasonerL,
    sessionStoreL: storeL,
    memoryRouterL,
    calibrationStoreL,
    wakeReasonerL: wakeWorkerReasonerL,
    wakeLogStoreL: wakeWorkerLogStoreL,
  })
  const jobTickerL = schedulerV2Enabled
    ? JobTickerLayer().pipe(
        Layer.provide(
          Layer.mergeAll(jobsStoreL, workerRegistryL, clockL),
        ),
      )
    : null

  // Phase 3 D3: Survey layer for the WS-mediated check-in. AlignmentStore and
  // BeliefWriter both use memoryRouterL + clockL from the same boot identities
  // (so survey-activated beliefs + D5 injection read the SAME router).
  // LunaSqliteBootstrap satisfied at the bottom of buildServerLayer, same as
  // every other SQLite-backed layer here.
  const alignmentStoreL = AlignmentStore.makeLayer(paths.lunaDbPath).pipe(Layer.provide(clockL))
  const beliefWriterL = BeliefWriter.Default.pipe(Layer.provide(memoryRouterL), Layer.provide(clockL))
  const surveyL = buildSurveyLayer({ alignmentStoreL, beliefWriterL, memoryRouterL, clockL })

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
    workspacesL,
    jobsStoreL,  // Phase 12a: persisted cron schedules (DESIGN §5.1 jobs table)
    dreamCronL, // Phase 3 D1: nightly dream cron (Layer.empty under V2 — M5 cutover; the dream job row drives the cycle instead)
    wakeCronL ?? Layer.empty, // wake cron: workspace digest each tick (Layer.empty under V2 — M5 cutover; disabled if LUNA_WAKE_ENABLED=0)
    jobTickerL ?? Layer.empty, // Phase 12b V2 ticker: enabled via LUNA_SCHEDULER_V2_ENABLED=1 — drives dream/wake via job rows (DESIGN §5.3.5)
    surveyL,    // Phase 3 D3: Survey available for buildServerLayer to resolve + pass to the WS server
    suggestedActionsL, // Suggested Actions: buildServerLayer resolves it for the WS respond handle (same instance the chat layer uses)
    // Auto-execute + completion observer — wired whenever the V2 ticker is on
    // (the default). Without the ticker a job can never dispatch, so on a
    // LUNA_SCHEDULER_V2_ENABLED=0 deploy we omit AcceptHandler and accept simply
    // leaves the action at `accepted` (respond resolves it via serviceOption —
    // absent → no exec) rather than stranding it in `in_progress` forever.
    schedulerV2Enabled ? acceptHandlerL : Layer.empty,
    skillRegistryL, // PRD Part B: same instance as threadToolsL (memoized by reference) — buildServerLayer resolves it for the WS skill frames
    connectorServiceL, // PRD Part A: same instance as threadToolsL — M2's WS connector frames resolve it here
    artifactStoreL, // PRD Part C/W1: buildServerLayer resolves it for the WS artifact frames
    vaultStoreL, // Vault V1: buildServerLayer resolves it for the WS vault frames
    threadRegistryWithMigrationL, // Phase 1: durable thread index (luna.db threads table)
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
      yield* startControlServer(controlPort, TOKEN, BUILD_SHA)
      yield* startUIWebSocketServer({
        port: wsPort,
        ...(BIND_HOST !== undefined ? { host: BIND_HOST } : {}),
        token: TOKEN,
        advertisedKinds: DEFAULT_UI_KINDS,
        pingIntervalMs: 5000,
        buildSha: BUILD_SHA,
        chatService: null,
        accountBroker: null,
        survey: null,
        skillRegistry: null,
        connectorService: null,
        artifactStore: null,
        workflowGallery: null,
        // No vault in setup-mode: the registry layer isn't built here, and a
        // fresh server has nothing to list until real boot.
        vaultService: null,
        localShellBridge: null,
        // No chat in setup-mode → the request_secret tool is never bound, so the
        // secret bridge has nothing to drive. Disabled here.
        secretBridge: null,
        // No job workers in setup-mode → request_input is never bound either.
        jobInputBridge: null,
        // No MCP-app provider in setup-mode (no telemetry/registry layers).
        mcpAppHost: null,
        setupPty: resolvedSetupPty,
        // Allow OP-token entry in setup-mode too — useful when LUNA_OP_ACCOUNTS
        // is configured but the account still needs its token. The handler
        // rejects labels not in LUNA_OP_ACCOUNTS, so an unconfigured fresh
        // server gets an honest "add it to LUNA_OP_ACCOUNTS first" message.
        registerOpToken: registerOpTokenHandler,
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
      const skillRegistryService = yield* SkillRegistry // PRD Part B
      const connectorServiceHandle = yield* ConnectorService // PRD Part A
      const artifactStoreService = yield* ArtifactStore // PRD Part C/W1
      const jobsStore = yield* JobsStoreService // PRD Part C/W3 (gallery source)
      const telemetry = yield* TelemetryService // Phase 7: pulse-snapshot source
      const suggestedActionsService = yield* SuggestedActions // suggest_action
      // Optional — present whenever the V2 ticker is on (the default; absent
      // only on a LUNA_SCHEDULER_V2_ENABLED=0 deploy, see the gated merge
      // above). Absent → accept leaves the action at `accepted`.
      const acceptHandlerOption = yield* Effect.serviceOption(AcceptHandler)

      // PRD A §08: access tokens live ~1h; refresh AHEAD of expiry so the
      // mount snapshot's bearer never goes stale mid-conversation. The
      // service refreshes only tokens within their margin, under its
      // single-flight gate — this tick is cheap when nothing is expiring.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(10 * 60 * 1000).pipe(
            Effect.zipRight(
              connectorServiceHandle.refreshMounts().pipe(
                Effect.catchAllCause((cause) =>
                  Effect.sync(() =>
                    console.warn("[luna/connectors] mount refresh failed:", String(cause)),
                  ),
                ),
              ),
            ),
          ),
        ),
      )

      // Wire-safety adapter (PRD §18): instances are projected to status +
      // metadata — no secretRef (pointer or not, clients don't need it),
      // no accountKind. Tokens never exist on instances at all.
      const toWireInstance = (i: {
        readonly id: string
        readonly definitionId: string
        readonly label: string
        readonly status: "connected" | "needs-reauth" | "error" | "disconnected"
        readonly grantedScopes: ReadonlyArray<string>
        readonly createdAt: number
        readonly lastHealthyAt: number | null
      }) => ({
        id: i.id,
        definitionId: i.definitionId,
        label: i.label,
        status: i.status,
        grantedScopes: i.grantedScopes,
        createdAt: i.createdAt,
        lastHealthyAt: i.lastHealthyAt,
      })
      const connectorsWsHandle = {
        catalog: () => connectorServiceHandle.catalog(),
        list: () =>
          connectorServiceHandle.list().pipe(
            Effect.map((xs) => xs.map(toWireInstance)),
          ),
        beginAuth: (input: {
          readonly definitionId: string
          readonly label: string
          readonly capabilityIds?: ReadonlyArray<string>
          readonly loopbackPort: number
        }) => connectorServiceHandle.beginAuth(input),
        completeAuth: (input: {
          readonly pendingId: string
          readonly code: string
          readonly state: string
        }) =>
          connectorServiceHandle.completeAuth(input).pipe(Effect.map(toWireInstance)),
        connect: (input: {
          readonly definitionId: string
          readonly label: string
          readonly secretRef?: string
          readonly capabilityIds?: ReadonlyArray<string>
        }) => connectorServiceHandle.connect(input).pipe(Effect.map(toWireInstance)),
        disconnect: (instanceId: string) =>
          connectorServiceHandle.disconnect(instanceId),
        setClientCredentials: (input: {
          readonly definitionId: string
          readonly clientId: string
          readonly clientSecret?: string
        }) => connectorServiceHandle.setClientCredentials(input),
      }

      // ── Vault V1 ─────────────────────────────────────────────────────
      // Registry over the EXISTING secret backends. The store holds pointers
      // (name/kind/ref/source) — values stay in ~/.luna/.env, the keychain,
      // and op-token files, written/removed by the same primitives the
      // request_secret + register-op-token paths already use.
      const vaultStoreService = yield* VaultStore

      // makeVaultMutations is plain-async (unit-tested in @luna/vault, like
      // makeRegisterSecret) — adapt the Effect store to its Promise facade.
      // The resolved handle's effects carry no remaining requirements.
      const vaultStoreFacade = {
        list: () => Effect.runPromise(vaultStoreService.list()),
        upsertByName: (item: VaultItem) =>
          Effect.runPromise(vaultStoreService.upsertByName(item)),
        getById: (id: string) => Effect.runPromise(vaultStoreService.getById(id)),
        remove: (id: string) => Effect.runPromise(vaultStoreService.remove(id)),
      }

      // V3 sync facade: the op-sync engine needs the sync-config row too.
      const vaultSyncStoreFacade = {
        ...vaultStoreFacade,
        getSyncConfig: () => Effect.runPromise(vaultStoreService.getSyncConfig()),
        setSyncConfig: (cfg: VaultSyncConfig) =>
          Effect.runPromise(vaultStoreService.setSyncConfig(cfg)),
      }

      const vaultMutations = makeVaultMutations({
        registerSecret,
        // Vault delete routes through the facade so a keychain-mode delete
        // scrubs the value from BOTH luna.vault.<NAME> and the .env line — an
        // explicit delete must stay deleted across restarts (the .env rollback
        // copy is for copy-only migration, not for deletes). Default `env`
        // mode deletes from .env as before.
        removeEnvSecret: vaultSecretStore.removeEnvSecret,
        deleteOpToken,
        store: vaultStoreFacade,
        now: () => Date.now(),
        log: (msg) => writeSync(1, `${msg}\n`),
      })

      // Boot-discovered op tokens, shared by the reconciler below and the
      // V3 sync engine's tokenForLabel. The map living until restart is
      // correct: every op-token change schedules a supervised restart, so
      // discovery re-runs with the fresh token.
      const discoveredOpTokens = yield* discoverOpTokens
      const opTokenByLabel = new Map(discoveredOpTokens.map((t) => [t.label, t.token]))

      // Boot reconcile: adopt pre-Vault secrets (env var NAMES from
      // ~/.luna/.env, op-token labels with a discoverable token) into the
      // registry so the Vault shows the truth on first run. Best-effort —
      // an adoption failure must never block server start.
      yield* Effect.gen(function* () {
        const existing = yield* vaultStoreService.list()
        const { toAdopt } = reconcileVaultItems({
          envVarNames: readEnvFileVarNames(),
          opTokenLabels: discoveredOpTokens.map((t) => t.label),
          existing,
          now: Date.now(),
        })
        for (const item of toAdopt) {
          yield* vaultStoreService.upsertByName(item)
        }
        if (toAdopt.length > 0) {
          console.log(`[luna/vault] adopted ${toAdopt.length} pre-existing credential(s) into the registry`)
        }
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.sync(() =>
            console.warn("[luna/vault] boot reconcile failed:", String(cause)),
          ),
        ),
      )

      // ── Vault V3: 1Password two-way sync engine ──────────────────────
      // All decision logic lives unit-tested in @luna/vault's makeVaultOpSync;
      // here we inject the real spawn runner + the boot-discovered token map.
      // Token → child env only; values → stdin template only; lastError is
      // sanitized to operation + exit code inside the engine.
      const opSync = makeVaultOpSync({
        runOp: runOpForVaultSync,
        tokenForLabel: (label) => opTokenByLabel.get(label),
        store: vaultSyncStoreFacade,
        now: () => Date.now(),
        log: (msg) => writeSync(1, `${msg}\n`),
      })

      /**
       * Outbound push of a freshly stored env-secret to 1Password (when sync
       * is enabled). The VALUE lives only in this call chain — it goes to
       * opSync.createItem (stdin template) and nowhere else. Failures degrade
       * gracefully: the item stays local-only and a sanitized line is logged.
       * Rows already pushed (opItemId set) are skipped — op item create would
       * duplicate them (op item edit is a future slice).
       */
      const pushEnvSecretTo1P = async (varName: string, value: string): Promise<void> => {
        const cfg = await vaultSyncStoreFacade.getSyncConfig()
        if (cfg === null || !cfg.enabled) return
        const ref = `env:${varName.trim()}`
        const item = (await vaultStoreFacade.list()).find((i) => i.ref === ref)
        if (item === undefined || item.opItemId !== null) return
        const res = await opSync.createItem({
          title: item.name,
          value,
          category: "API_CREDENTIAL",
        })
        if (res.ok && res.itemId !== undefined) {
          await vaultStoreFacade.upsertByName({
            ...item,
            opItemId: res.itemId,
            updatedAt: Date.now(),
          })
        } else {
          // res.message is sanitized by the engine (op + exit code only).
          writeSync(1, `[luna/vault] outbound 1Password push failed: ${res.message}\n`)
        }
      }

      // Late-bind the capture hook (module scope, same pattern as
      // notifySkillCatalogChanged): agent request_secret captures and the
      // Settings register-op-token form now land in the registry too.
      // Fire-and-forget — registry bookkeeping never fails a finished store.
      // V3: env-secret captures (NOT op-tokens) also push outbound to
      // 1Password when sync is enabled; the value stays in this closure.
      vaultCaptureHook = (destination, source, value) => {
        const args =
          destination.kind === "op-token"
            ? { kind: "op-token" as const, label: destination.label, source }
            : { kind: "env-secret" as const, varName: destination.varName, source }
        void vaultMutations
          .recordCapture(args)
          .then(async () => {
            if (destination.kind !== "env-secret") return
            await pushEnvSecretTo1P(destination.varName, value)
            // Out-of-band registry change (no client request to ack) — let
            // ui-ws broadcast the refreshed list/synced badges.
            notifyVaultListChanged?.()
          })
          .catch(() => undefined)
      }

      // ── Vault V3: inbound poll loop ──────────────────────────────────
      // Effect.forkScoped like the connector refreshMounts loop: a cheap 30s
      // tick; an actual `op item list` runs only when the configured poll
      // interval (floor 60s, default 300s ≈ 288 reads/day against the
      // personal-plan ~1000/day budget) has elapsed since the last SUCCESSFUL
      // sync — and, after failures, only when the exponential backoff window
      // (doubling per consecutive failure, cap 1h) has elapsed since the last
      // ATTEMPT. setSyncConfig (enable) resets both gates for an immediate
      // first pass.
      let vaultSyncConsecutiveFailures = 0
      let vaultSyncLastAttemptAt = 0
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(30 * 1000).pipe(
            Effect.zipRight(
              Effect.promise(async () => {
                const cfg = await vaultSyncStoreFacade.getSyncConfig()
                if (cfg === null || !cfg.enabled) return
                const nowMs = Date.now()
                if (
                  !shouldAttemptSync({
                    nowMs,
                    lastSyncedAt: cfg.lastSyncedAt ?? null,
                    lastAttemptAt: vaultSyncLastAttemptAt === 0 ? null : vaultSyncLastAttemptAt,
                    consecutiveFailures: vaultSyncConsecutiveFailures,
                    pollSeconds: cfg.pollSeconds,
                  })
                ) return
                vaultSyncLastAttemptAt = nowMs
                const r = await opSync.syncOnce()
                if (r.ok) {
                  vaultSyncConsecutiveFailures = 0
                  // Mutation-driven vault-list pushes come from ui-ws; a poll
                  // pass has no requesting client, so nudge the broadcast hook.
                  if (r.changed > 0) notifyVaultListChanged?.()
                } else {
                  vaultSyncConsecutiveFailures += 1
                  // r.message is sanitized by the engine — safe to log.
                  writeSync(
                    1,
                    `[luna/vault] sync failed (${vaultSyncConsecutiveFailures} consecutive): ${r.message}\n`,
                  )
                }
              }).pipe(Effect.catchAllCause(() => Effect.void)),
            ),
          ),
        ),
      )

      // Wire-safety projection: pointers + metadata only — `synced` and
      // `shadowed` are derived flags, never values. (Refs ARE names — e.g.
      // `env:NOTION_API_KEY` — disclosing them is the Vault's purpose.)
      // toWireVaultItem is imported from @luna/vault (wire-projection.ts),
      // bound to bootShadowedEnvKeys here so the list() closure stays simple.
      const wireItem = (i: VaultItem) => toWireVaultItem(i, bootShadowedEnvKeys)

      const vaultWsHandle = {
        list: () =>
          vaultStoreFacade.list().then((items) => items.map(wireItem)),
        syncState: async () => {
          const cfg = await Effect.runPromise(vaultStoreService.getSyncConfig())
          return cfg === null
            ? null
            : {
                enabled: cfg.enabled,
                opLabel: cfg.opLabel,
                opVault: cfg.opVault,
                lastSyncedAt: cfg.lastSyncedAt,
                lastError: cfg.lastError,
                pollSeconds: Math.max(60, cfg.pollSeconds ?? 300),
              }
        },
        put: async (f: {
          readonly name: string
          readonly kind: "env-secret" | "op-token"
          readonly varName?: string
          readonly label?: string
          readonly value: string
          readonly description?: string
        }) => {
          const r = await vaultMutations.put({
            name: f.name,
            kind: f.kind,
            ...(f.varName !== undefined ? { varName: f.varName } : {}),
            ...(f.label !== undefined ? { label: f.label } : {}),
            value: f.value,
            ...(f.description !== undefined ? { description: f.description } : {}),
          })
          // op-token activation needs token discovery + broker hydration to
          // re-run — same immediate supervised restart as register-op-token
          // (its 300ms delay lets the status/list frames flush first).
          if (r.restartNeeded) scheduleServerRestart()
          // V3 outbound: a freshly stored env-secret also lands in 1Password
          // when sync is enabled. Awaited inline so the vault-list ui-ws
          // pushes right after this carries the `synced` badge; a push
          // failure degrades gracefully (item stays local, message unchanged).
          if (r.ok && f.kind === "env-secret" && f.varName !== undefined) {
            try {
              await pushEnvSecretTo1P(f.varName, f.value)
            } catch {
              // Push problems must never fail a put that already succeeded.
            }
          }
          return { ok: r.ok, message: r.message }
        },
        remove: async (f: { readonly id: string }) => {
          const r = await vaultMutations.remove(f.id)
          if (r.restartNeeded) scheduleServerRestart()
          return { ok: r.ok, message: r.message }
        },
        setSyncConfig: async (f: {
          readonly enabled: boolean
          readonly opLabel?: string
          readonly opVault?: string
          readonly pollSeconds?: number
        }) => {
          // Enabling requires a registered label so "enabled" is never a lie
          // the sync engine later trips over.
          if (f.enabled) {
            const label = (f.opLabel ?? "").trim()
            if (label === "" || !OP_ACCOUNTS.some((a) => a.label === label)) {
              return {
                ok: false,
                message: `"${label || "(none)"}" isn't a registered 1Password account label — add it to LUNA_OP_ACCOUNTS and store its token first.`,
              }
            }
          }
          const prev = await Effect.runPromise(vaultStoreService.getSyncConfig())
          await Effect.runPromise(
            vaultStoreService.setSyncConfig({
              enabled: f.enabled,
              opLabel: f.opLabel?.trim() || prev?.opLabel || "",
              opVault: f.opVault?.trim() || prev?.opVault || "Luna",
              pollSeconds: Math.max(60, f.pollSeconds ?? prev?.pollSeconds ?? 300),
              // Enable nudge: a null lastSyncedAt (plus reset backoff gates)
              // makes the next 30s poll tick sync immediately instead of
              // waiting out a stale interval.
              lastSyncedAt: f.enabled ? null : (prev?.lastSyncedAt ?? null),
              lastError: f.enabled ? null : (prev?.lastError ?? null),
            }),
          )
          if (f.enabled) {
            vaultSyncConsecutiveFailures = 0
            vaultSyncLastAttemptAt = 0
          }
          return {
            ok: true,
            message: f.enabled
              ? "1Password sync enabled."
              : "1Password sync disabled.",
          }
        },
        importItems: async (f: {
          readonly items: ReadonlyArray<{
            readonly title: string
            readonly url?: string
            readonly username?: string
            readonly password: string
            readonly notes?: string
          }>
        }) => {
          // Guard here too (the engine re-checks): with sync off, the honest
          // failure message explains WHY import is unavailable.
          const cfg = await vaultSyncStoreFacade.getSyncConfig()
          if (cfg === null || !cfg.enabled) {
            return {
              ok: false,
              message:
                "Importing passwords requires 1Password sync, which isn't active yet on this server.",
            }
          }
          const r = await opSync.importLogins(f.items)
          // ui-ws pushes vault-list only on ok — a PARTIAL import (rows
          // created, then a hard failure) still changed the registry, so
          // nudge the out-of-band broadcast.
          if (!r.ok && r.created > 0) notifyVaultListChanged?.()
          return { ok: r.ok, message: r.message }
        },
        // Out-of-band registry changes (sync poll loop, capture-hook pushes)
        // → ui-ws broadcasts a fresh vault-list to every connected client
        // (same pattern as notifySkillCatalogChanged).
        changes: (notify: () => void) => {
          notifyVaultListChanged = notify
        },
      }

      // PRD Part C/W1: the artifact store's PinnedArtifact is already wire-safe
      // (metadata + content, no secrets) — project to the wire PinnedArtifactItem
      // shape explicitly so a future store-internal field can't silently leak.
      const toWireArtifact = (a: import("@luna/core").PinnedArtifact) => ({
        id: a.id,
        kind: a.kind,
        title: a.title,
        lang: a.lang,
        content: a.content,
        origin: a.origin,
        version: a.version,
        pinnedAt: a.pinnedAt,
        updatedAt: a.updatedAt,
        bridgeCaps: a.bridgeCaps,
      })
      // Phase 7 (widget-system.md "Widgets are MCP Apps" v1): the in-process
      // CoreAppRegistry makes the Luna server the FIRST MCP-app provider.
      // pulse-snapshot aggregates the TelemetryService counters EventCounter
      // already mirrors from the obs stream (sqlite-backed here, so the tiles
      // show running totals that survive restarts) — no new obs tap needed.
      // The workspace pulse counters, shared by the static pulse app AND the
      // curated `pulse` tool offered to store-backed apps.
      const getPulse = () =>
        Effect.runPromise(telemetry.snapshot).then(pulseFromSnapshot)
      const mcpAppHost = createMcpAppHost(
        composeAppRegistries(
          // Static, compile-time core apps (the Luna server as first provider).
          createCoreAppRegistry([buildWorkspacePulseApp(getPulse)]),
          // Generated / user-authored apps: ui://luna/app/<id> resolves to a
          // pinned mcp-app artifact's HTML, tools/call gated by the curated set.
          createStoreBackedAppRegistry({
            getAppHtml: (artifactId) =>
              Effect.runPromise(
                artifactStoreService
                  .get(artifactId)
                  .pipe(
                    Effect.map((a) =>
                      a && a.kind === "mcp-app" ? a.content : null,
                    ),
                  ),
              ),
            curatedTools: buildCuratedAppTools({
              getPulse,
              // Narrowed to APP/WIDGET kinds only — a curated app sees the
              // other apps/widgets, NOT the titles of chat-pinned documents
              // (defense-in-depth: keep the read surface tight even though Luna
              // is single-tenant and the sandbox has no network).
              listArtifacts: () =>
                Effect.runPromise(
                  artifactStoreService.list().pipe(
                    Effect.map((xs) =>
                      xs
                        .filter((a) => a.kind === "widget" || a.kind === "mcp-app")
                        .map((a) => ({
                          id: a.id,
                          title: a.title,
                          kind: a.kind,
                          version: a.version,
                          updatedAt: a.updatedAt,
                        })),
                    ),
                  ),
                ),
            }),
          }),
        ),
      )

      const artifactsWsHandle = {
        list: () =>
          artifactStoreService.list().pipe(Effect.map((xs) => xs.map(toWireArtifact))),
        pin: (input: {
          readonly id: string
          readonly title: string
          readonly content: string
          readonly lang?: string | null
          readonly kind?: import("@luna/core").ArtifactKind
          readonly origin?: string | null
        }) => artifactStoreService.pin(input).pipe(Effect.map(toWireArtifact)),
        unpin: (id: string) => artifactStoreService.unpin(id),
        // Edit = append a version via the store's update (NOT unpin+re-pin):
        // preserves the time-travel ledger and leaves bridgeCaps untouched.
        update: (id: string, content: string) =>
          artifactStoreService
            .update(id, content, "user")
            .pipe(Effect.map((a) => (a ? toWireArtifact(a) : null))),
        // Out-of-band agent edits (widget_write / mcp_app_write / show_artifact
        // call the store directly, bypassing the inline pin-broadcast) → the
        // server re-broadcasts a fresh artifact-list so every connected client
        // (web panel, Moon overlay) learns of the new/changed pin.
        //
        // NOTE: a *client-initiated* pin/unpin/edit therefore broadcasts twice —
        // once inline (server.ts artifact-pin/unpin/edit handlers) and once via
        // this hook. Deliberate and harmless: both run AFTER the mutation commits
        // and carry identical state, so the second is an idempotent full-list
        // replace. We keep the inline broadcasts because `changes` is OPTIONAL on
        // the server's artifactStore contract — a rig that omits it must still
        // broadcast user pins. The common automated case (agent-tool pin) has no
        // inline path and so fires exactly once, here.
        changes: (notify: () => void) => artifactStoreService.changes(notify),
      }

      // PRD Part C/W3: the workflow gallery is a READ-ONLY, wire-safe projection
      // of the persisted jobs store. A job is "on-demand" when it has no
      // schedule; the run-error is truncated and the (potentially large /
      // sensitive) outputText + stepsJson never cross the wire. A failed fetch
      // degrades to an empty list — it must not break the connection.
      const toGalleryItem = (j: import("@luna/core").PersistedJob) => ({
        id: j.id,
        kind: j.kind,
        label: j.payload.label,
        source: j.payload.source ?? null,
        // Legacy rows have schedule=null and carry the cron in `spec` (review
        // G3) — fall back so a scheduled job shows its cron, not a blank.
        schedule: j.schedule ?? j.spec,
        // Badge by KIND, not the nullable schedule column: a `oneshot` is
        // on-demand; cron/prompt/workflow/file-watch are scheduled/triggered.
        onDemand: j.kind === "oneshot",
        enabled: j.enabled,
        nextRunAt: j.nextRunAt ?? j.nextRun,
        lastRun: j.lastRun,
        lastStatus: j.lastStatus,
        createdAt: j.createdAt,
      })
      const toRunItem = (r: import("@luna/core").JobRun) => ({
        id: r.id,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        status: r.status,
        attempt: r.attempt,
        error: r.error ? r.error.slice(0, 200) : null,
      })
      const workflowGalleryHandle = {
        list: () =>
          jobsStore.listAll().pipe(
            Effect.map((jobs) => jobs.map(toGalleryItem)),
            // Degrade to empty so the connection survives, but LOG first — a
            // chronically-failing jobs DB must be observable (review G3).
            Effect.catchAll((e) =>
              Effect.sync(() => {
                console.warn("[luna/workflows] gallery list failed:", String(e))
                return [] as ReturnType<typeof toGalleryItem>[]
              }),
            ),
          ),
        runs: (jobId: string, limit?: number) =>
          jobsStore.listRuns(jobId, limit ?? 25).pipe(
            Effect.map((runs) => runs.map(toRunItem)),
            Effect.catchAll((e) =>
              Effect.sync(() => {
                console.warn("[luna/workflows] gallery runs failed:", String(e))
                return [] as ReturnType<typeof toRunItem>[]
              }),
            ),
          ),
      }

      // Suggested Actions: the ui-ws respond handle. `respond` runs in the
      // ui-ws runtime, so the AcceptHandler (resolved by SuggestedActions.respond
      // via serviceOption) must be PROVIDED into the returned Effect here —
      // otherwise accept would silently skip execution. Errors are logged and
      // swallowed so a bad respond never breaks the connection.
      const suggestedActionsHandle = {
        respond: (input: {
          readonly threadId: string
          readonly actionId: string
          readonly decision: "accept" | "dismiss"
        }) => {
          // Provide AcceptHandler only when it's wired (scheduler V2 on); when
          // off, respond still works — accept just transitions to `accepted`
          // without creating a job (serviceOption in respond resolves None).
          const base = suggestedActionsService.respond(input)
          const withHandler = Option.isSome(acceptHandlerOption)
            ? base.pipe(Effect.provideService(AcceptHandler, acceptHandlerOption.value))
            : base
          return withHandler.pipe(
            Effect.asVoid,
            Effect.catchAll((e) =>
              Effect.sync(() => {
                console.warn("[luna/suggested-actions] respond failed:", String(e))
              }),
            ),
          )
        },
      }

      // Wire-safety adapter (PRD §12): the ui-ws handle receives catalog
      // entries with the `body` ALREADY stripped. Bodies are prompt content
      // for the agent — they never reach clients, and stripping here (not
      // in ui-ws) means a ui-ws logging/serialization bug cannot leak them.
      const skillsWsHandle = {
        catalog: () =>
          skillRegistryService.catalog().pipe(
            Effect.map((entries) =>
              entries.map(({ body: _body, ...meta }) => meta),
            ),
          ),
        setEnabled: (id: string, enabled: boolean) =>
          skillRegistryService.setEnabled(id, enabled),
        // Out-of-band catalog changes (the ~/.luna/skills hot-load fiber)
        // → ui-ws broadcasts a fresh catalog to every connected client.
        changes: (notify: () => void) => {
          notifySkillCatalogChanged = notify
        },
      }

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
      // Exposes control.restart / control.status / control.version. Bound to
      // loopback + gated by the same bearer token as the WS server (TOKEN).
      yield* startControlServer(4754, TOKEN, BUILD_SHA)

      return yield* startUIWebSocketServer({
        port: 4753,
        ...(BIND_HOST !== undefined ? { host: BIND_HOST } : {}),
        token: TOKEN,
        advertisedKinds: DEFAULT_UI_KINDS,
        pingIntervalMs: 5000,
        buildSha: BUILD_SHA,
        // Advertise the operator-configured + built-in model list so the UI
        // dropdown is driven by the server (LUNA_UI_MODELS overrides go first
        // and become the recommended default). Absent on older/setup-mode
        // servers — clients fall back to their hardcoded list gracefully.
        availableModels: buildAvailableModels(),
        chatService: chat,
        accountBroker: broker,
        survey: surveyHandle, // Phase 3 D3: resolved handle
        skillRegistry: skillsWsHandle, // PRD Part B: bodies pre-stripped
        connectorService: connectorsWsHandle, // PRD Part A: instances pre-projected
        artifactStore: artifactsWsHandle, // PRD Part C/W1: pinned artifacts (wire-safe)
        workflowGallery: workflowGalleryHandle, // PRD Part C/W3: read-only jobs gallery
        suggestedActions: suggestedActionsHandle, // Suggested Actions: accept/dismiss routing
        vaultService: vaultWsHandle, // Vault V1: registry CRUD (values never cross down)
        localShellBridge,
        onLocalShellRelease: reattachSandbox,
        // Wrapped so a Settings-form token ALSO lands in the Vault registry
        // (source 'manual'). The wrap never changes the handler's result.
        registerOpToken: async (input) => {
          const result = await registerOpTokenHandler(input)
          if (result.ok) {
            try {
              // The hook receives the token for signature consistency, but
              // op-token captures NEVER push to 1Password (only env-secret
              // captures do) — it stays inside the hook's closure.
              vaultCaptureHook?.({ kind: "op-token", label: input.label }, "manual", input.token)
            } catch {
              // Registry bookkeeping must never fail a store that succeeded.
            }
          }
          return result
        },
        secretBridge: secretRequestBridge,
        widgetSummoner: widgetSummonBridge,
        subagentTree: subagentTreeBridge,
        // Phase 5 (widget-system.md): job-summoned operator input. Every
        // connection registers with the broadcast bridge; the job workers'
        // request_input tool drives it (see jobInputToolsL above).
        jobInputBridge,
        // Phase 7 (widget-system.md): MCP Apps relay — ui:// resource reads +
        // same-app tool calls against the in-process CoreAppRegistry.
        mcpAppHost,
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
      `[op] 0 providers active — no keychain entry or LUNA_OP_TOKEN_<LABEL> found for any configured label`,
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

  // Install Luna's default agent permission policy on the shared SDKAdapter
  // BEFORE the WS server accepts connections, so every thread's queries use it.
  // Default-ALLOW (agents never stall on a permission prompt in this headless
  // server); the canUseTool rail DENIES reads/writes of secret paths (.env,
  // secrets/, key files) for the file built-ins, plus a defense-in-depth
  // destructive-command rail (agents run shell through the sandboxed
  // mcp__local_shell__*, not raw Bash). It only fires under permissionMode
  // "default"; LUNA_TRUSTED_LOCAL=1 (bypassPermissions) skips canUseTool
  // entirely — the explicit full-trust opt-in (no rails).
  //
  // This is now the FIRST runPromise on the runtime, so it forces the layer
  // graph to build — a boot-time layer failure surfaces HERE, ahead of
  // buildMain's catch. Mirror that diagnostic so a fail-fast boot stays loud
  // instead of becoming a silent unhandled rejection.
  await runtime
    .runPromise(
      Effect.gen(function* () {
        const adapter = yield* SDKAdapter
        yield* adapter.setPermissionCallback(
          composeInterceptors(defaultSafetyInterceptors()),
        )
      }),
    )
    .catch((err) => {
      console.error(
        "❌ chat server failed to boot (permission policy install):",
        err,
      )
      const msg = String(err)
      if (msg.includes("OnePasswordSecretProvider") || msg.includes("'op'")) {
        console.error(
          "   hint: 1Password CLI not authenticated. Add a " +
            "luna.op.<label> keychain entry or set LUNA_OP_TOKEN_<LABEL>, then restart.",
        )
      }
      process.exit(1)
    })

  // runPromise keeps the event loop alive until the effect resolves (which
  // it never does because of Effect.never). runFork returns immediately,
  // so without an explicit keep-alive the process exits.
  //
  // 1Password resolution failures surface lazily on the first
  // acquireSession (the OnePasswordBackend resolves on demand, by
  // design). When that happens, the broker emits a ConfigError into the
  // SDKAdapter's error channel; the user-facing symptom is a ws-side
  // error rather than a boot crash. Hint to add a `luna.op.<label>`
  // keychain entry or set `LUNA_OP_TOKEN_<LABEL>` if chat queries fail
  // with a ConfigError tagged `OnePasswordSecretProvider`.
  runtime.runPromise(buildMain(opLabelsRegistered)).catch((err) => {
    const msg = String(err)
    console.error("❌ chat server crashed:", err)
    if (msg.includes("OnePasswordSecretProvider") || msg.includes("'op'")) {
      console.error(
        "   hint: 1Password CLI not authenticated. Add a " +
          "luna.op.<label> keychain entry or set LUNA_OP_TOKEN_<LABEL> " +
          "(see header comment), then restart.",
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
