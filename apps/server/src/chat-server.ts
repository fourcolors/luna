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
 *   bun run scripts/luna-chat-server-entry.ts
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
 *   - send `{type:"new-thread", model:"claude-sonnet-5"}` to spawn a
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
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { hostname, userInfo } from "node:os"
import { execFileSync, spawn } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  applyRuntimePathEnvDefaults,
  resolveRuntimePaths,
} from "./runtime-paths.js"
import { applyClaudeExecutablePreflight } from "./claude-executable.js"
import {
  notifyStopping,
  startSdWatchdog,
  type SdWatchdogHandle,
} from "./sd-notify.js"

/**
 * Setup-mode WS port. Single constant shared by buildSetupServerLayer's
 * default and the setup-mode watchdog probe so the two can never drift (a
 * drifted probe port would watchdog-kill a fresh credential-less install).
 */
const SETUP_WS_PORT = 4753

/**
 * Liveness ladder L1 handle, retained so self-initiated shutdowns can stop
 * the beat loop and send STOPPING=1 — without it, a slow graceful drain
 * (>WatchdogSec) would be SIGABRTed mid-shutdown by the still-armed watchdog
 * and recorded as a failure toward the start limit.
 */
let sdWatchdog: SdWatchdogHandle | undefined

/**
 * Absolute path to the macOS keychain CLI. Pinned rather than bare "security"
 * so PATH manipulation can never redirect us to an attacker-planted binary
 * while adding/deleting op-token material. Mirrors keychain-helper.ts, whose
 * shared helpers already pin the same SIP-protected system binary.
 */
const SECURITY_BIN = "/usr/bin/security"

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
  // Heal LUNA_CLAUDE_CODE_EXECUTABLE before the SDK adapter (or any thread) reads
  // it: a missing/stale pin (e.g. a container whose /usr/local/bin/claude was
  // never provisioned) otherwise makes `query()` throw ENOENT on every new
  // thread. Self-heals all start paths (autodeploy, manual restart, rebuild).
  applyClaudeExecutablePreflight()
}
import { Context, Effect, Layer, ManagedRuntime, Option, Redacted, Runtime, Stream } from "effect"
import {
  AccountBroker,
  AccountBrokerLayer,
  AgentNotesService,
  ArtifactStore,
  CLEAN_SHUTDOWN_MARKER_NAME,
  JobsStoreService,
  JobTicker,
  JobTickerLayer,
  WorkerRegistry,
  makeWorkerRegistry,
  WorkspaceRegistryService,
  AlignmentStore,
  BELIEF_KIND,
  BELIEF_NAMESPACE,
  BeliefWriter,
  BUILTIN_SKILLS,
  Clock,
  type ConfigError,
  DEFAULT_UI_KINDS,
  DreamStore,
  DreamWorkerLayer,
  WakeLogStore,
  WakeWorkerLayer,
  NoopTracerLayer,
  ObservabilityService,
  OnePasswordSecretProvider,
  scanUserSkills,
  SessionStore,
  makeSessionStoreSqlite,
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
  LunaVaultFile,
  resolveWriteTier,
  probeOnePassword,
  isReservedSecretName,
  type WriteTier,
  type OnePasswordProbe,
  type LunaSqliteBootstrap,
  validateAccountsTableLabels,
  openProviderSettingsStore,
  resolveAll,
  validateAndPrepare,
  resolveRoleModel,
  syncProviderAccountsToDb,
  ProviderAccountSyncError,
  type ProviderSettingsPayload,
  SuggestedActions,
  SuggestedActionsStore,
  AcceptHandler,
  AcceptHandlerLayer,
  ThreadRegistryService,
  importJsonMap,
  runAutoArchive,
  AUTO_ARCHIVE_IDLE_MS,
  MCPRegistry,
  openUiFeedbackStatusStore,
  UI_FEEDBACK_SENTINEL_SESSION,
  createFeedbackCreateJobDep,
  feedbackAutoJobEnabled,
  FeedbackJobObserverLayer,
  runFeedbackCreateJobNoThrow,
  type FeedbackListRow,
  type FeedbackJobsDep,
  type FeedbackSetStatusDep,
  MemoryReranker,
  BulletinWriter,
  shapeActivitySnapshot,
  buildBulletinInjectionBlock,
  estimateBulletinTokens,
  BULLETIN_MAX_THREADS,
  projectChatMessages,
  type BulletinThreadActivity,
  type ChatMessage,
  type MemoryBackendError,
  type EmbedderError,
  type ValidationError,
} from "@luna/core"
import { McpServerStore, syncMcpMounts, RESERVED_SLUGS } from "@luna/mcp-servers"
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
import { makeVaultSecretStore } from "./vault-secret-store.js"
import { makeScrubOpToken } from "./op-token-scrub.js"
import {
  assertVaultBootIntegrity,
  buildSecretChainLayer,
  buildStorageStatus,
  discoverOpTokens as discoverOpTokensChain,
  makeEnvSecretResolver,
  normalizeVaultStorageModeV2,
  type DiscoveredOpToken,
  type RoutedOpAccountLayer,
} from "./secret-chain.js"
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
  CrossEncoderRerankerLayer,
  BulletinWriterDefault,
} from "@luna/adapter-sdk"
import {
  ChatService,
  ThreadToolsProviderTag,
  effortOptionsForModel,
  defaultEffortForModel,
  type EffortOption,
  type ThreadToolsProvider,
  stripClientMarker,
} from "@luna/chat-service"
import {
  composeInterceptors,
  defaultSafetyInterceptors,
  mcpToolGate,
  buildMcpGateEntries,
  clearStaleUnmountableForLiveConnector,
  summarizeMountFailure,
  egressAllowlist,
  makeEgressPreToolUseHook,
  parseEgressAllowedHosts,
  type EgressDecision,
  type McpGateEntry,
} from "@luna/tools"
import {
  ChannelService,
  ChannelServiceLayer,
  ChannelSessionStore,
  InboundDedupStore,
  makeTelegramAdapter,
} from "@luna/channels"
import {
  createJobInputBridge,
  createLocalShellBridge,
  createMcpAppHost,
  createSecretRequestBridge,
  createSubagentTreeBridge,
  createWidgetSummonBridge,
  startUIWebSocketServer,
  type MemorySearchErrorKind,
} from "@luna/ui-ws"
import {
  LunaSqliteBootstrapLive,
  matchesMemoryScope,
  MemoryRouterTag,
  OPERATOR_MEMORY_SCOPE,
} from "@luna/memory"
import {
  MemoryRouterLayer,
  MemoryToolsLayer,
  MemoryToolsService,
  recallForTurn,
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
  tokenFilePathFor,
  tokenEnvVarFor,
} from "./op-accounts.js"
import {
  makeRegisterOpToken,
  type TokenCheck,
} from "./register-op-token.js"
import { resolveUiWsToken } from "./ui-ws-token.js"
import {
  buildCuratedAppTools,
  buildFeedbackQueueApp,
  buildWorkspacePulseApp,
  composeAppRegistries,
  createCoreAppRegistry,
  createStoreBackedAppRegistry,
  deleteMemoryRecordWithScopeCheck,
  isCuratedToolAllowed,
  pulseFromSnapshot,
  toCuratedMemoryRow,
  type FeedbackListPage,
  type MemoryDeleteResult,
  type MemoryListPage,
  type MemorySearchPage,
  type ValidatedFeedbackListArgs,
  type ValidatedFeedbackSetStatusArgs,
  type ValidatedMemoryDeleteArgs,
  type ValidatedMemoryListArgs,
  type ValidatedMemorySearchArgs,
} from "./core-apps.js"
import {
  connectExternalStdioServer,
  createExternalMcpAppRegistry,
  parseExternalMcpServersEnv,
  type LiveExternalServer,
} from "./external-mcp-app-registry.js"
import {
  ThreadToolsLayer,
  ThreadToolsService,
  ForkProposalStore,
  toForkProposalWire,
  FORK_CHILD_TAG,
} from "@luna/thread-tools"
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

/**
 * Resolve the semver of THIS server release, ONCE at process startup. Parallels
 * `resolveBuildSha()`. Resolution order:
 *   1. `LUNA_BUILD_VERSION` env var (set by release/install scripts) — trimmed;
 *      an empty value falls through.
 *   2. `git describe --tags --match 'server-v*' --abbrev=0` — strips to the
 *      bare semver (e.g. "server-v0.1.0" → "0.1.0"). Wrapped in try/catch so
 *      a missing .git, no matching tag, or git not on PATH never crashes boot.
 *   3. `undefined` on any failure/empty path — the wire field is documented as
 *      semver, so an unresolvable version OMITS the field (server.ts spreads
 *      `serverVersion` only when defined) rather than threading a fake
 *      "unknown" semver. Unlike buildSha, which keeps its "unknown" sentinel.
 */
const resolveBuildVersion = (): string | undefined => {
  const fromEnv = process.env["LUNA_BUILD_VERSION"]?.trim()
  if (fromEnv) return fromEnv
  try {
    const raw = execFileSync("git", ["describe", "--tags", "--match", "server-v*", "--abbrev=0"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
    if (!raw) return undefined
    // Strip the "server-v" prefix so the wire value is a bare semver string.
    return raw.startsWith("server-v") ? raw.slice("server-v".length) : raw
  } catch {
    return undefined
  }
}

/** Semver of this server release (or `undefined` when unresolvable) — computed
 *  once, threaded into the endpoints; `undefined` omits the wire field. */
const BUILD_VERSION = resolveBuildVersion()

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
  /** Effort a fresh thread should default to for this model when the client
   *  persists none — server-computed via defaultEffortForModel(). Omitted when
   *  the model has no opinion (clients then fall back to the weakest level). */
  readonly defaultEffort?: EffortOption
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
 * The first entry is the recommended default (server/operator-preferred, not
 * necessarily the highest-capability model). Efforts are attached server-side
 * via effortsForModel().
 */
const BASE_MODELS: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: "claude-sonnet-5",     label: "Claude Sonnet 5 — balanced default" },
  { id: "claude-fable-5",       label: "Fable 5 (1M context, xhigh reasoning)" },
  { id: "claude-mythos-5",      label: "Mythos 5 (1M context, first-party only)" },
  { id: "claude-opus-5",        label: "Opus 5 (1M context, xhigh reasoning)" },
  { id: "claude-opus-4-8",      label: "Claude Opus 4.8 — most capable" },
  { id: "claude-sonnet-4-6",   label: "Claude Sonnet 4.6 — prior gen" },
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
  // Attach the server-computed effort matrix AND per-model default effort to a
  // bare {id,label} entry. defaultEffort is omitted when the model has no
  // opinion (defaultEffortForModel → undefined) so the wire stays minimal.
  const withEffort = (m: { readonly id: string; readonly label: string }): UiModelEntry => {
    const defaultEffort = defaultEffortForModel(m.id)
    return {
      ...m,
      efforts: effortOptionsForModel(m.id),
      ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    }
  }
  const extras = parseUiModels(env["LUNA_UI_MODELS"])
  const seenIds = new Set(extras.map((e) => e.id))
  const deduped: Array<UiModelEntry> = extras.map(withEffort)
  for (const base of BASE_MODELS) {
    if (!seenIds.has(base.id)) {
      deduped.push(withEffort(base))
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

// 14-day auto-archive bridge: buildServerLayer's runAutoArchive loop calls this
// with the ids it archived, and ui-ws re-broadcasts a `thread-archived` frame
// for each to every connected client (same late-binding holder pattern as
// notifySkillCatalogChanged — producer and ui-ws hook live in different layer
// scopes of this boot script). Null until a WS server registers; every caller
// null-guards.
let notifyThreadsArchived: ((threadIds: ReadonlyArray<string>) => void) | null =
  null

// Luna Vault V3: same late-binding bridge for out-of-band vault-list
// broadcasts — the 1Password sync poll loop (buildServerLayer) calls it after
// a pass that changed registry rows, and ui-ws re-broadcasts the (wire-safe)
// list to every client. Null until a WS server registers.
let notifyVaultListChanged: (() => void) | null = null

// Slice C - MCP tool gate policy holder.
// Slice S11b (issue #445): a registered server that FAILS TO MOUNT (e.g. an
// unresolved secret-ref) must fail CLOSED at the gate, not defer. Populated
// once at boot from a single syncMcpMounts() report, folded through
// buildMcpGateEntries (packages/tools/src/interception.ts) - the ONE place
// a report becomes gate policy, shared with mcp-demo.ts. See
// McpServerUnmountable for the full fail-closed rationale. v1 does not
// re-sync live (see the boot comment in ThreadToolsProviderLayer below).
// mcpToolGate reads this map on EVERY tool call so allowTool / allowAllTools
// changes take effect without recomposing the boot-global permission
// callback.
const mcpToolPolicyHolder = new Map<string, McpGateEntry>()
const replaceMcpToolPolicy = (entries: ReadonlyMap<string, McpGateEntry>): void => {
  mcpToolPolicyHolder.clear()
  for (const [slug, entry] of entries) mcpToolPolicyHolder.set(slug, entry)
}

// Live check for whether a slug is currently mounted by a connector. Set
// once ThreadToolsProviderLayer's boot Effect.gen has run (below) and read
// on every gate call. A connector can mount AFTER boot (OAuth connect, or a
// reconnect following token rotation that excluded it from the boot mount
// snapshot) while mcpToolPolicyHolder is only ever rebuilt from the
// boot-time syncMcpMounts() report; consulting this LIVE view at
// gate-check time - rather than relying solely on the boot-time exclusion
// set baked into mcpToolPolicyHolder - keeps a since-mounted connector's
// tools from being denied by a stale `unmountable` marker left over from
// before it connected. Consulted only through
// clearStaleUnmountableForLiveConnector (packages/tools), which clears the
// marker case alone; a mounted server's own policy is never touched by
// connector liveness.
let isLiveConnectorMount: ((slug: string) => boolean) | null = null
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
 * @param memoryRerankerL - optional MemoryReranker layer (Phase 3 production
 *   reranker, PR #332 bench). When provided, BOTH memory_search
 *   (LUNA_MEMORY_RERANK=1) and per-turn recall (LUNA_RECALL_RERANK=1) CAN
 *   rerank - each still gated independently at call time. Composed directly
 *   onto both (a) MemoryToolsLayer() below and (b) this function's own
 *   Effect.gen, so `Effect.serviceOption(MemoryReranker)` resolves in both
 *   places. Default undefined: byte-identical to before this param existed -
 *   no reranker in context, both gates are no-ops regardless of env.
 */
export const ThreadToolsProviderLayer = (
  refreshIntervalMs: number = BELIEF_REFRESH_INTERVAL_MS,
  memoryRerankerL?: Layer.Layer<MemoryReranker, never, never>,
  // Hot-tier bulletin (BULLETIN.md): decorate() reads holder.current
  // synchronously, exactly like the beliefs holder above it - but the
  // REFRESH loop lives outside this layer (bulletinRefresherL in main),
  // because it needs ChatService + SessionStore, which are not in this
  // layer's dependency graph. Default undefined: byte-identical to before.
  bulletinHolder?: { readonly current: string },
) => {
  const base = Layer.scoped(
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
      const threadTools = yield* ThreadToolsService // fork_thread (#221)
      // PRD Part B (Skills): the managed skill catalog. decorate() reads
      // promptSnapshotSync() — synchronous and never stale (the registry
      // rebuilds it inside every mutation), so a settings toggle is
      // reflected in the very next thread without a restart or a tick.
      // (The ~/.luna/skills hot-load fiber lives in skillRegistryL, where
      // the prefs store is in scope for hydration/write-through.)
      const skillRegistry = yield* SkillRegistry
      // PRD Part A (Connectors): connected services' MCP servers. Same
      // sync-snapshot discipline — refreshMounts() rebuilds on connect/
      // disconnect (and on M2 token rotation); decorate() just spreads it.
      const connectorService = yield* ConnectorService
      // Live-read at gate-check time (see isLiveConnectorMount above) so a
      // connector that mounts AFTER this boot sync still defers correctly.
      isLiveConnectorMount = (slug) =>
        Object.hasOwn(connectorService.mountSnapshotSync(), slug)
      const bootMounts = Object.keys(connectorService.mountSnapshotSync())
      if (bootMounts.length > 0) {
        console.log("[luna/boot] connector mounts:", bootMounts.join(", "))
      }
      // Official MCP support: capture the runtime registry, then sync it ONCE at
      // boot from the durable store's enabled+trusted rows (resolving header
      // secret-refs; fail-closed skip on any unresolved ref). decorate() reads
      // mcpRegistry.snapshotSync() synchronously below - same instance, so the
      // boot-sync's registrations are visible to every thread. (Hot re-sync of
      // added-after-boot servers is a follow-up; v1 syncs at boot.)
      const mcpRegistry = yield* MCPRegistry
      // v1: operator MCP servers are synced ONCE at boot (boot-sync only).
      // Disable/remove revocations take effect at next boot - not live.
      // Pass the live connector mount keys as reserved so an operator row
      // with a colliding slug (e.g. "github") is skipped rather than
      // shadowing the connector or mis-routing gate policy.
      const mcpReservedSlugs = new Set(
        Object.keys(connectorService.mountSnapshotSync()),
      )
      const mcpMountReport = yield* syncMcpMounts({
        reservedSlugs: mcpReservedSlugs,
      })
      if (mcpMountReport.registered.length > 0 || mcpMountReport.skipped.length > 0) {
        console.log(
          "[luna/thread] MCP registry mounts:",
          `registered=[${mcpMountReport.registered.join(", ")}]`,
          mcpMountReport.skipped.length > 0
            ? `skipped=[${mcpMountReport.skipped.map((s) => s.slug).join(", ")}]`
            : "",
        )
      }
      // Operator decision (issue #445): a registered server that fails to
      // mount must fail CLOSED at the tool gate, not defer. buildMcpGateEntries
      // (packages/tools) is the ONE fold from report to gate policy, shared
      // with mcp-demo.ts, so the boot warning below and the gate's policy
      // map always agree on "which skip counts as a failure". excludedSlugs
      // = live connector mount keys (that namespace is actively served
      // elsewhere, already logged above) union RESERVED_SLUGS (those rows
      // are rejected before any mount attempt, never a genuine failure -
      // see buildMcpGateEntries).
      const mcpGateExcludedSlugs = new Set<string>([
        ...mcpReservedSlugs,
        ...RESERVED_SLUGS,
      ])
      const mcpGateEntries = buildMcpGateEntries(mcpMountReport, mcpGateExcludedSlugs)
      for (const [slug, entry] of mcpGateEntries) {
        if (!("unmountable" in entry)) continue
        // entry.reason may embed an operator-supplied raw header value
        // (mount-loader.ts's backward-compat branch); summarizeMountFailure
        // is the only safe-to-log form - never interpolate entry.reason here.
        console.warn(
          `[luna/thread] MCP server "${slug}" is registered but FAILED TO MOUNT - ` +
            `any of its tools the gate can address (mcp__${slug}__*) are now ` +
            `DENIED (fail-closed) until this is fixed. Reason: ${summarizeMountFailure(entry.reason)}`,
        )
      }
      replaceMcpToolPolicy(mcpGateEntries)

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
      // apps/server/src/chat-server.ts - DNA.md is 3 levels up.
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
      const autoRecallEnabled =
        process.env["LUNA_MEMORY_AUTO_RECALL"]?.trim() !== "0"
      // Phase 3 production reranker (PR #332 bench): resolved once at boot,
      // same lifetime as `mem` above. Effect.serviceOption -> R=never, so
      // this stays undefined (byte-identical to before) unless the caller
      // passed a `memoryRerankerL` that got composed onto THIS layer's own
      // pipe below (see the function's closing `.pipe(...)`). Actually
      // reranking recall is a SEPARATE gate (LUNA_RECALL_RERANK=1) from
      // memory_search's (LUNA_MEMORY_RERANK=1) - see recallForTurn below.
      const recallRerankerOpt = yield* Effect.serviceOption(MemoryReranker)
      const recallReranker = Option.getOrUndefined(recallRerankerOpt)
      const memObs = yield* ObservabilityService
      console.log(
        "[luna/memory] turn pipeline:",
        `recall=${autoRecallEnabled ? "on" : "off"}`,
        // Reflect the actual runtime gate (flag AND service), not mere layer
        // construction - "available" when the flag is off misread as enabled.
        `recallRerank=${
          process.env["LUNA_RECALL_RERANK"]?.trim() === "1" && recallReranker !== undefined
            ? "on"
            : "off"
        }`,
      )

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
          const forkThreadTools = threadTools.createSessionBinding()
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
              forkThreadTools.serverName,
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
            opts.channelMeta
              ? buildSessionMetadata({ channelContext: opts.channelMeta })
              : sessionMetadata,
            beliefsContent, // Phase 3 D5: ranked active beliefs section
            bulletinHolder?.current ?? "", // hot-tier recent-activity bulletin ("" until first refresh or when LUNA_BULLETIN is off - filtered below)
            skillRegistry.promptSnapshotSync(), // PRD Part B: enabled skills ("" when none — filtered below)
            opts.systemPrompt,
            memoryThreadTools.systemPromptAddendum,
            schedulerThreadTools.systemPromptAddendum,
            obsThreadTools.systemPromptAddendum,
            localShellThreadTools.systemPromptAddendum,
            secretThreadTools.systemPromptAddendum,
            suggestedActionThreadTools.systemPromptAddendum,
            forkThreadTools.systemPromptAddendum,
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
            [forkThreadTools.serverName]: forkThreadTools.server, // #221 fork_thread (propose sibling)
            ...connectorService.mountSnapshotSync(), // PRD A §07: connected services, hot per-thread
            // HOLE 1 FIX: operator MCP servers are only mounted when the
            // thread's permission gate (canUseTool) will actually run.
            // Under bypassPermissions (LUNA_TRUSTED_LOCAL=1 local-dev bypass)
            // the SDK skips canUseTool entirely — mcpToolGate never fires —
            // so mounting operator servers would expose all their tools with
            // zero opt-in.  Fail-closed: withhold the spread when the gate
            // is bypassed.  Built-in servers and connector mounts are
            // unaffected (they are mounted unconditionally above).
            // NOTE: per-server SDK tool policy (mode-independent projection)
            // is a documented follow-up; for now the gate is the only fence.
            ...(() => {
              const effectiveMode =
                opts.permissionMode ??
                (process.env["LUNA_TRUSTED_LOCAL"] === "1"
                  ? "bypassPermissions"
                  : "default")
              if (effectiveMode === "bypassPermissions") {
                const operatorMounts = mcpRegistry.snapshotSync()
                if (Object.keys(operatorMounts).length > 0) {
                  console.warn(
                    "[luna/thread] operator MCP servers withheld: permission gate (canUseTool) is bypassed for this thread (mode=" +
                      effectiveMode +
                      "); mount requires the gate.",
                  )
                }
                return {}
              }
              return mcpRegistry.snapshotSync()
            })(), // official MCP support: operator-registered servers (enabled+trusted+secret-resolved)
          }
          return {
            mcpServers,
            systemPrompt,
            ...(autoRecallEnabled
              ? {
                  recallMemory: ({ userText }: { userText: string }) =>
                    recallForTurn({
                      router: mem,
                      query: userText,
                      scope: {
                        observerId: OPERATOR_MEMORY_SCOPE.observerId,
                        subjectId: OPERATOR_MEMORY_SCOPE.subjectId,
                      },
                      ...(recallReranker !== undefined ? { reranker: recallReranker } : {}),
                      observability: memObs,
                    }).pipe(Effect.map((packed) => packed?.text ?? null)),
                }
              : {}),
            onBound: (sessionId: string) => {
              obsThreadTools.bindSession(sessionId)
              localShellThreadTools.bindSession(sessionId)
              secretThreadTools.bindSession(sessionId)
              suggestedActionThreadTools.bindSession(sessionId)
              // Fork-loop guard: threads tagged forked-from-parent cannot re-propose.
              forkThreadTools.bindSession(
                sessionId,
                opts.tags !== undefined ? { tags: opts.tags } : {},
              )
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
              forkThreadTools.clearSession(sessionId)
            },
          }
        },
      }
      return provider
    }),
  ).pipe(
    // rerankerLayer: undefined when the caller didn't pass memoryRerankerL -
    // MemoryToolsLayer treats that as "no reranker", byte-identical to
    // before this option existed.
    Layer.provide(
      MemoryToolsLayer(
        memoryRerankerL !== undefined ? { rerankerLayer: memoryRerankerL } : {},
      ),
    ),
    Layer.provide(
      // Surface the system-managed cycles (wake/dream) as read-only entries in
      // schedule_list so the operator sees the whole schedule picture, not just
      // agent-created schedules. Gating + exprs MIRROR dream-wake-install.ts so
      // the display matches what is actually installed: the dream row is always
      // installed (at LUNA_DREAM_CRON, default "0 3 * * *"); wake rows are
      // installed per workspace only when LUNA_WAKE_ENABLED!="0" (at
      // LUNA_WAKE_CRON_EXPR, default "*/30 * * * *"). Keep these resolutions in
      // lockstep with that script.
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
          {
            label: "dream (nightly consolidation)",
            expr: process.env["LUNA_DREAM_CRON"]?.trim() || "0 3 * * *",
          },
        ],
      }),
    ),
    Layer.provide(LocalShellToolsLayer({ bridge: localShellBridge })),
    Layer.provide(SecretToolsLayer({ bridge: secretRequestBridge })),
    Layer.provide(ObsToolsLayer({ runtimeProbe: buildChatServerRuntimeProbe })),
  )
  // Compose memoryRerankerL directly onto THIS layer's own Effect.gen too
  // (not just MemoryToolsLayer's, above) so the recallForTurn wiring's
  // `Effect.serviceOption(MemoryReranker)` inside `base` also resolves it.
  // Layer.provide is a no-op-safe merge when memoryRerankerL is undefined.
  return memoryRerankerL !== undefined
    ? base.pipe(Layer.provide(memoryRerankerL))
    : base
}

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

// ── Luna vault file (tiered-storage W2) ─────────────────────────────────
//
// ONE LunaVaultFile instance for the whole process, rooted at LUNA_HOME (or
// ~/.luna). It is the encrypted-at-rest tier consumed three ways: as a read
// backend in the `auto` SecretProvider chain, as a write/delete target for the
// Vault env-secret facade, and (standalone, no layer graph) as a source in
// op-token discovery + the boot integrity gate. Framework-free by design, so
// constructing it at module scope is safe (no Effect runtime needed).
const LUNA_HOME = resolveRuntimePaths().lunaHome
const lunaVaultFile = new LunaVaultFile({ _baseDir: LUNA_HOME })
const lunaVaultRead = (name: string): Promise<string | undefined> =>
  lunaVaultFile.readSecret(name)

/**
 * Keychain read adapter for op-token discovery (darwin only). Wraps
 * `readKeychainToken` (an Effect) as a Promise<string|undefined> so the moved
 * `discoverOpTokens` (secret-chain.ts) stays framework-free: a miss / non-darwin
 * hard-fail both resolve to undefined.
 */
const keychainOpTokenRead = (
  acct: import("./op-accounts.js").OpAccountConfig,
): Promise<string | undefined> =>
  Effect.runPromise(
    readKeychainToken({
      service: acct.keychainService,
      account: acct.keychainAccount,
    }).pipe(Effect.option),
  ).then((opt) => (Option.isSome(opt) ? opt.value : undefined))

/**
 * Resolve every OP token we can find. The precedence logic (keychain → env var
 * → luna vault → legacy file) lives in the moved `discoverOpTokens`
 * (secret-chain.ts); here we inject the real keychain/vault readers. Missing on
 * all sources → the account is skipped (non-fatal). The vault tier is new in
 * W2 and sits between the env var and the legacy plaintext file.
 */
const discoverOpTokens = (): Promise<ReadonlyArray<DiscoveredOpToken>> =>
  discoverOpTokensChain({
    accounts: OP_ACCOUNTS,
    keychainRead: keychainOpTokenRead,
    vaultRead: lunaVaultRead,
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

/**
 * Persist a runtime-written op token to keychain (darwin) or - W2 - the
 * encrypted Luna vault (linux/other), under the entry name `LUNA_OP_TOKEN_<LABEL>`
 * so op-token discovery finds it in its vault tier. This replaces the prior
 * plaintext `~/.luna/op-tokens/<label>` file for WRITES: a runtime op token no
 * longer lands in plaintext on a keychain-less host. Discovery still READS the
 * legacy file (last precedence) so any pre-W2 file keeps working forever.
 *
 * MODE-INDEPENDENT ON PURPOSE. Op-token storage is deliberately NOT driven by
 * `LUNA_VAULT_STORAGE` / `resolveWriteTier` (unlike env secrets): the tier is a
 * fixed platform split (darwin keychain, otherwise luna vault). Op tokens
 * authenticate the `op` CLI itself and must be available in EVERY mode, so they
 * never consult the storage-mode policy.
 */
const persistOpToken = (label: string, token: string): Promise<void> => {
  if (process.platform === "darwin") {
    return new Promise((resolve, reject) => {
      const child = spawn(
        SECURITY_BIN,
        ["add-generic-password", "-U", "-s", `luna.op.${label}`, "-a", label, "-w", token],
        { stdio: ["ignore", "ignore", "ignore"] },
      )
      child.on("error", reject)
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`security add-generic-password exited ${code}`)),
      )
    })
  }
  // Non-darwin: write into the encrypted Luna vault (was: plaintext file).
  return lunaVaultFile.writeSecret(tokenEnvVarFor(label), token)
}

/**
 * Delete the keychain op-token entry for a label (darwin only). Rejects on a
 * real `security` failure; a MISSING entry (`security` exit 44) resolves as
 * success. Never surfaces the token value.
 */
const deleteKeychainOpToken = (label: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      SECURITY_BIN,
      ["delete-generic-password", "-s", `luna.op.${label}`, "-a", label],
      { stdio: ["ignore", "ignore", "ignore"] },
    )
    child.on("error", reject)
    child.on("close", (code) =>
      code === 0 || code === 44
        ? resolve()
        : reject(new Error(`security delete-generic-password exited ${code}`)),
    )
  })

/**
 * Delete a stored op token (Vault remove). ANTI-RESURRECTION: op-token
 * discovery falls through keychain (darwin) → env var → luna vault → legacy
 * file, so a delete must scrub EVERY applicable persisted tier on EVERY
 * platform - not just the one this platform WRITES to. A darwin delete that
 * only cleared the keychain would leave a vault or legacy-file copy that
 * discovery re-adopts on the next boot; hence darwin scrubs the vault + file
 * too. This mirrors the env-secret DELETE contract in vault-secret-store.ts:
 * attempt every tier unconditionally, treat "not found" as success, collect
 * the tiers that genuinely FAILED, and if any failed throw an Error naming
 * them (never the token value) so a partial scrub is never silently swallowed.
 * Idempotent per tier: a missing keychain entry (`security` exit 44), a missing
 * vault name (deleteSecret returns false, no throw), and a missing legacy file
 * (unlink ENOENT) are all success.
 *
 * NOTE: this cannot scrub the `LUNA_OP_TOKEN_<LABEL>` process-env / env-file
 * tier by design - that tier is operator-provisioned (the supervisor owns that
 * env), so discovery may still find an env-var token after a delete. That is
 * intentional: the operator owns the env, and discovery re-adopting it after
 * restart is honest, not a resurrection bug.
 *
 * MODE-INDEPENDENT ON PURPOSE. Like persistOpToken, op-token deletion is NOT
 * driven by `LUNA_VAULT_STORAGE` / `resolveWriteTier`: op tokens authenticate
 * the `op` CLI itself and must be available in every mode, so both the write
 * split and this scrub ignore the storage-mode policy.
 *
 * The contract + collect-and-reject logic lives in op-token-scrub.ts (injectable
 * seams, unit-tested); here we only bind the real per-tier effects.
 */
const deleteOpToken = makeScrubOpToken({
  platform: process.platform,
  deleteKeychain: deleteKeychainOpToken,
  deleteVault: (label) => lunaVaultFile.deleteSecret(tokenEnvVarFor(label)),
  deleteLegacyFile: async (label) => {
    try {
      unlinkSync(tokenFilePathFor(label))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
    }
  },
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

/**
 * Count of NON-reserved names still present in ~/.luna/.env (the `envResidue`
 * status field). Reserved names (UI_WS_TOKEN / LUNA_*) legitimately live in
 * `.env` forever, so they are NOT residue; only operator/agent secrets that
 * could have moved to a secure tier count. Names only - never a value.
 */
const computeEnvResidue = (): number =>
  readEnvFileVarNames().filter((name) => !isReservedSecretName(name)).length

const CHAT_SERVICE_LABEL = "com.user.luna-chat-server"

/**
 * Trigger a supervised restart so `discoverOpTokens` re-runs with the new
 * token. The mechanism is platform-specific because the supervisors differ:
 *
 *   linux/incus — systemd `Restart=always` respawns on ANY exit, so a graceful
 *     self-SIGTERM (→ dispose → exit 0) is enough.
 *   darwin — the launchd plist uses `KeepAlive <true/>` (always respawn —
 *     clean exits included, matching Restart=always; the old
 *     `{SuccessfulExit=false}` treated a graceful exit 0 as "stay stopped",
 *     the Sol-autopsy clean-exit loophole). A self-SIGTERM would respawn too,
 *     but `launchctl kickstart -k` is kept: it is an immediate forced restart
 *     with no dependence on exit-status semantics, and it is idempotent with
 *     the guard below. control.restart's darwin branch does the same.
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
      } else if ((process.env["INVOCATION_ID"] ?? "") !== "") {
        // systemd Restart=always respawns the exit(0) from the SIGTERM
        // handler. INVOCATION_ID is systemd's own marker — without a
        // supervisor a self-SIGTERM is a permanent stop, not a restart
        // (control.restart applies the same gate).
        process.kill(process.pid, "SIGTERM")
      } else {
        console.warn(
          "scheduleServerRestart: no supervisor detected — restart skipped; restart manually to apply the change",
        )
        serverRestartScheduled = false
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

/** Minimal bun:sqlite Database shape for the synchronous inline
 *  `require("bun:sqlite")` opens below - narrow on purpose, matches what
 *  openProviderSettingsStore / openUiFeedbackStatusStore accept. */
type BunSqliteDb = new (p: string) => {
  run(sql: string): void
  query(sql: string): {
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
    run(...args: unknown[]): { changes: number }
  }
  close(): void
}

/**
 * Read the ProviderSettingsStore (if the DB exists and has config) and apply
 * the resolved ProviderEnv + OverflowConfig back into process.env so the
 * existing `readProviderEnv()` / `readOverflowConfig()` calls inside
 * AccountBrokerLayer.fromSql pick them up at layer-build time.
 *
 * STORE OVERRIDES ENV: the resolver merges env as the base and store config
 * wins on overlap. A store that is null (no saved config) is a no-op, leaving
 * env-derived defaults unchanged. Call BEFORE buildBaseLayer / ManagedRuntime.
 *
 * Uses bun:sqlite synchronously (chat-server runs under bun only). Any DB
 * error is caught and logged; boot continues with env defaults.
 */
const applyProviderSettingsToEnv = (dbPath: string): void => {
  try {
    // Synchronous bun:sqlite open — safe at module level under bun.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite") as {
      Database: BunSqliteDb
    }
    const db = new Database(dbPath)
    try {
      const store = openProviderSettingsStore(db)
      const storeConfig = store.read()
      if (storeConfig === null) return // no saved config — env defaults apply as-is

      const { providerEnv, overflowConfig } = resolveAll(storeConfig)

      // Write merged modelKindMap back as LUNA_MODEL_PROVIDER_MAP (model=kind,...)
      const mapEntries = Object.entries(providerEnv.modelKindMap)
      if (mapEntries.length > 0) {
        process.env["LUNA_MODEL_PROVIDER_MAP"] = mapEntries
          .map(([m, k]) => `${m}=${k}`)
          .join(",")
      }

      // Write merged overflow chains back as LUNA_OVERFLOW_CHAINS (JSON)
      const hasChains = Object.keys(overflowConfig.chains).length > 0
      if (hasChains) {
        process.env["LUNA_OVERFLOW_CHAINS"] = JSON.stringify(overflowConfig)
      }

      // Wire reasoner-lane model SELECTION: wake/dream resolve their model from
      // LUNA_WAKE_MODEL / LUNA_DREAM_MODEL (brokered-turn resolveReasonerModel).
      // Set them from the operator's role binding so the chosen model is actually
      // requested — and its failover chain (keyed by that model) fires. Only
      // override when the store has an explicit binding (never clobber operator env).
      for (const [role, varName] of [
        ["wake", "LUNA_WAKE_MODEL"],
        ["dream", "LUNA_DREAM_MODEL"],
      ] as const) {
        const hasBinding = (storeConfig.roleBindings ?? []).some(
          (b) => b.role === role && (b.preferenceList?.[0]?.model ?? "") !== "",
        )
        if (hasBinding) process.env[varName] = resolveRoleModel(role, storeConfig)
      }

      writeSync(
        1,
        `[luna/provider-settings] applied store config: ${mapEntries.length} model overrides, ${Object.keys(overflowConfig.chains).length} overflow chains\n`,
      )
    } finally {
      db.close()
    }
  } catch (err) {
    // Non-fatal: env defaults stay in place; warn so the operator can investigate.
    writeSync(1, `[luna/provider-settings] store read failed (env defaults apply): ${String(err)}\n`)
  }
}

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

// LUNA_VAULT_STORAGE selects the tiered-storage MODE (W2 v2 vocabulary):
//   `auto` (NEW DEFAULT) - darwin -> macOS Keychain, else -> encrypted Luna vault
//   `env`                - explicit plaintext `.env` escape hatch
//   `keychain-preferred`/`keychain-only` - darwin migration states
// The same mode drives the read-side provider chain in buildBaseLayer below, so
// write target and read source stay in lockstep.
const vaultStorageMode = normalizeVaultStorageModeV2(
  process.env["LUNA_VAULT_STORAGE"],
  process.platform,
)

// The concrete WRITE tier is resolvable at module scope: resolveWriteTier only
// depends on `mode` + `osKeychain` (1Password is a READ source, never a write
// target - see storage-policy.ts), and `osKeychain` is a synchronous platform
// check. The async `op` probe result is needed ONLY for the status snapshot
// (computed at boot), not for the write decision, so we pass a placeholder
// `onePassword` here.
const osKeychainAvailable = process.platform === "darwin"
const vaultWriteTier: WriteTier = resolveWriteTier(vaultStorageMode, {
  platform: process.platform,
  onePassword: "absent",
  osKeychain: osKeychainAvailable,
})

// Single write/delete facade the Vault env-secret paths funnel through
// (registerSecret + vault mutations). `writeEnv`/`removeEnv` retain the
// reserved-name gate + atomic .env IO; `writeKeychain`/`deleteKeychain` hit
// the keychain; `vaultFile` hits the encrypted Luna vault. WRITES route by
// tier; DELETES scrub every tier (the DELETE contract). process.env is mirrored
// on write either way so live resolution needs no restart.
const vaultSecretStore = makeVaultSecretStore({
  platform: process.platform,
  writeTier: vaultWriteTier,
  env: process.env,
  writeEnv: persistEnvSecret,
  removeEnv: removeEnvSecret,
  writeKeychain: writeKeychainEnvSecret,
  deleteKeychain: deleteKeychainEnvSecret,
  vaultFile: {
    writeSecret: (name, value) => lunaVaultFile.writeSecret(name, value),
    deleteSecret: (name) => lunaVaultFile.deleteSecret(name),
  },
})

// Tiered-storage status snapshot for the vault-list wire frame (W2). Assigned
// once in bootstrap() after the async `op` probe resolves (the probe result is
// status-only - it does NOT affect the write tier). The vault-list handle's
// `storage()` accessor returns this; null until boot computes it, so a pre-boot
// list frame simply omits the field (additive, backward compatible).
let vaultStorageStatus: ReturnType<typeof buildStorageStatus> | null = null

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

// The legacy `buildDreamCronLayer` factory (fiber-per-cron dream registration
// via TriggerAgent) was removed with the V1 scheduler. The nightly dream now
// runs exclusively through the V2 path: a `kind:"dream"` job row drained by the
// JobTicker into the DreamWorker registered in `buildWorkerRegistryLayer` below.

// ── Survey sub-layer factory (exported for boot smoke) ──────────────────
//
// Phase 3 D3: exported so the boot smoke can import THIS symbol and verify
// the real wiring shape.
//
// Survey.Default requires AlignmentStore + BeliefWriter + Clock + MemoryRouter.
// BeliefWriter.Default requires MemoryRouter + Clock.
// AlignmentStore.makeLayer(dbPath) requires Clock + LunaSqliteBootstrap.
//
// The smoke passes AlignmentStore.Memory (no SQLite) + a Ref-backed FakeMemory
// MemoryRouter while keeping the real Survey.Default so the real dep graph is
// proven composable. `as never` on the Memory double sidesteps the param-type
// narrowing.
export interface BuildSurveyLayerOpts {
  readonly alignmentStoreL: Layer.Layer<AlignmentStore, ConfigError, Clock | LunaSqliteBootstrap>
  readonly beliefWriterL: Layer.Layer<
    BeliefWriter,
    MemoryBackendError | EmbedderError,
    LunaSqliteBootstrap
  >
  readonly memoryRouterL: Layer.Layer<
    import("@luna/memory").MemoryRouter,
    MemoryBackendError | EmbedderError,
    LunaSqliteBootstrap
  >
  readonly clockL: Layer.Layer<Clock>
}

export const buildSurveyLayer = (opts: BuildSurveyLayerOpts) =>
  Survey.Default.pipe(
    Layer.provide(opts.alignmentStoreL),
    Layer.provide(opts.beliefWriterL),
    Layer.provide(opts.memoryRouterL),
    Layer.provide(opts.clockL),
  )

// The legacy `buildWakeCronLayer` factory (fiber-per-cron wake registration via
// TriggerAgent) was removed with the V1 scheduler. Wake (Path A: a single-shot
// WakeReasoner SDK call that inspects the workspace's open goals + next_actions
// + recent wakes and emits a JSON digest into the workspace's `wake_log` table)
// now runs exclusively through the V2 path: per-workspace `kind:"wake"` job rows
// drained by the JobTicker into the WakeWorker registered in
// `buildWorkerRegistryLayer` below.

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
// Optional deps (jobInputToolsL — the prompt/workflow request_input
// serviceOption provider) are folded in only when supplied.
export interface BuildWorkerRegistryLayerOpts {
  readonly clockL: Layer.Layer<Clock>
  readonly sdkClientL: Layer.Layer<SDKClient>
  readonly agentNotesL: Layer.Layer<AgentNotesService, ConfigError, LunaSqliteBootstrap>
  /** Optional per-run request_input provider (prompt/workflow serviceOption). */
  readonly jobInputToolsL?: Layer.Layer<
    import("@luna/adapter-sdk").JobRunToolsProvider,
    ConfigError,
    LunaSqliteBootstrap
  >
  /** Optional chat_thread delivery sink (#124) — prompt worker serviceOption. */
  readonly chatThreadPosterL?: Layer.Layer<
    import("@luna/adapter-sdk").ChatThreadPoster,
    ValidationError | MemoryBackendError | ConfigError | EmbedderError,
    LunaSqliteBootstrap
  >
  // dream leaf deps (DreamWorkerLayer R = DreamStore|DreamReasoner|SessionStore|MemoryRouter|Clock)
  readonly dreamStoreL: Layer.Layer<DreamStore, ConfigError, LunaSqliteBootstrap>
  readonly dreamReasonerL: Layer.Layer<
    import("@luna/core").DreamReasoner,
    MemoryBackendError | ConfigError | EmbedderError,
    LunaSqliteBootstrap
  >
  readonly sessionStoreL: Layer.Layer<SessionStore, never, LunaSqliteBootstrap>
  readonly memoryRouterL: Layer.Layer<
    import("@luna/memory").MemoryRouter,
    MemoryBackendError | EmbedderError,
    LunaSqliteBootstrap
  >
  /** Optional SuggestedActions (dream skill_improvement chips, serviceOption). */
  readonly suggestedActionsL?: Layer.Layer<
    import("@luna/core").SuggestedActions,
    ConfigError,
    LunaSqliteBootstrap
  >
  /** Optional SkillRegistry (dream skill catalog snapshot, serviceOption). */
  readonly skillRegistryL?: Layer.Layer<
    import("@luna/core").SkillRegistry,
    ValidationError | ConfigError,
    LunaSqliteBootstrap
  >
  // wake leaf deps (WakeWorkerLayer R = WakeReasoner|WakeLogStore|AgentNotesService|Clock)
  readonly wakeReasonerL: Layer.Layer<
    import("@luna/core").WakeReasoner,
    ConfigError,
    LunaSqliteBootstrap
  >
  readonly wakeLogStoreL: Layer.Layer<WakeLogStore, ConfigError>
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
  // #124 chat_thread delivery sink — folded in only when supplied, exactly like
  // jobInputToolsL above. PromptWorker resolves ChatThreadPosterTag via
  // serviceOption, so omitting it keeps the workers' R clean (no chat_thread
  // delivery, the pre-#124 behaviour).
  const withChatPoster =
    opts.chatThreadPosterL === undefined
      ? withJobTools
      : Layer.merge(withJobTools, opts.chatThreadPosterL)
  // Dream skill-improvement chips: fold SuggestedActions + SkillRegistry when
  // provided so DreamWorkerLayer's serviceOption resolves them at boot (same
  // instances the chat layer uses — Effect memoizes layers by reference).
  const withSuggestedActions =
    opts.suggestedActionsL === undefined
      ? withChatPoster
      : Layer.merge(withChatPoster, opts.suggestedActionsL)
  const withSkillRegistry =
    opts.skillRegistryL === undefined
      ? withSuggestedActions
      : Layer.merge(withSuggestedActions, opts.skillRegistryL)
  // provideMerge so the registry stays VISIBLE above this layer (JobTickerLayer
  // + the integration test both yield* WorkerRegistry from the result).
  return workers.pipe(Layer.provideMerge(withSkillRegistry))
}

// ── Layer wiring ────────────────────────────────────────────────────────
//
// Phase 25d: SecretProvider chain is RoutedOpSecretProvider →
// EnvSecretProvider. Each registered OP account is a single-account
// OnePasswordSecretProvider built inline; the routed wrapper dispatches
// based on the ref scheme (op://, luna-op://<label>/...) per
// DESIGN.md §2.2.11. No fall-through across OP accounts.
const buildRoutedOpAccountLayers = (
  opTokens: ReadonlyArray<DiscoveredOpToken>,
  clockL: Layer.Layer<Clock>,
): ReadonlyArray<RoutedOpAccountLayer> =>
  opTokens.map((t) => ({
    label: t.label,
    layer: OnePasswordSecretProvider.make({
      accountLabel: t.label,
      token: t.token,
    }).pipe(Layer.provide(clockL)),
  }))

export const buildBaseLayer = (
  opAccountLayers: ReadonlyArray<RoutedOpAccountLayer>,
): Layer.Layer<
  | UIService
  | ObservabilityService
  | Clock
  | SessionStore
  | AccountBroker
  | SDKAdapter
  | ChatService
  | ChannelService
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | any, // TelemetryPlatform sinks + NoopTracerLayer + AgentNotesService are side-effect Layers
  | ValidationError
  | ConfigError
  | MemoryBackendError
  | EmbedderError,
  LunaSqliteBootstrap
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
  // Phase 2 — durable SessionStore: SQLite-backed so a restart replays
  // the full transcript, not just the model's SDK context.
  // LunaSqliteBootstrap is satisfied at the bottom of buildServerLayer,
  // same as every other SQLite-backed layer here. Best-effort contract:
  // a disk failure at Layer init will propagate (per the jobs-store /
  // thread-registry precedent — the server does not start without its
  // stores). A failure on a per-append write is caught by the adapter's
  // onMirrorError hook and does NOT kill the live session.
  const storeL = makeSessionStoreSqlite(paths.lunaDbPath)

  // Compose the read chain per mode (W2). Composition lives in secret-chain.ts;
  // this only injects the platform, the discovered OP accounts, and the
  // standalone luna-vault reader. The load-bearing env tail + the per-mode chain
  // rationale (byte-compat for legacy modes, lunaVault inserted only in `auto`)
  // all travel with buildSecretChainLayer.
  const secretL = buildSecretChainLayer({
    mode: vaultStorageMode,
    platform: process.platform,
    opAccounts: opAccountLayers,
    lunaVaultRead,
  })

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
  // (the V2 ticker dispatches it) and forks the completion observer. Resolved
  // via serviceOption inside SuggestedActions.respond — present here means
  // accept actually runs.
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
  // 30s refresh, the beliefs-holder pattern) because it needs the prefs
  // store for hydration/write-through. New user skills register ENABLED
  // by default (Chairman decision, 2026-07-22, superseding the prior
  // quarantine-on-create policy — see user-skills-loader.ts docstring).
  // Catalog deltas ping notifySkillCatalogChanged so ui-ws broadcasts a
  // fresh catalog to long-lived clients.
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
        const summary = yield* syncUserSkills(registry, scan)
        if (summary.added + summary.updated + summary.removed > 0) {
          console.log(
            `[luna/skills] user skills synced: +${summary.added} ~${summary.updated} -${summary.removed}`,
          )
          // Long-lived clients (the Moon) must see hot-load deltas without
          // a reconnect — ui-ws registered this via skillsWsHandle.changes.
          notifySkillCatalogChanged?.()
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
  // Official MCP support: durable operator registry (mcp_servers in luna.db)
  // + the in-memory MCPRegistry runtime projection that decorate() reads.
  const mcpServerStoreL = McpServerStore.makeLayer(paths.lunaDbPath).pipe(
    Layer.provide(clockL),
  )
  const mcpRegistryL = MCPRegistry.Default
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

  // The deterministic, dependency-free cross-encoder is the only
  // MemoryReranker engine. ACTUAL reranking stays gated per-request by
  // LUNA_MEMORY_RERANK=1 / LUNA_RECALL_RERANK=1 (both DEFAULT OFF) inside
  // memory-tools.
  const memoryRerankerL = CrossEncoderRerankerLayer()
  // Hot-tier bulletin (BULLETIN.md): a plain mutable holder read
  // synchronously by decorate() (same doctrine as the beliefs holder), a
  // digest file next to luna.db for warm restarts, and a refresh loop that
  // lives in its own layer BELOW (bulletinRefresherL) because it needs
  // ChatService + SessionStore. Default OFF: everything is inert unless
  // LUNA_BULLETIN=1.
  const bulletinEnabled = process.env["LUNA_BULLETIN"]?.trim() === "1"
  const bulletinHolder = { current: "" }
  const bulletinFilePath = join(dirname(paths.lunaDbPath), "bulletin.md")
  const threadToolsL = ThreadToolsProviderLayer(
    BELIEF_REFRESH_INTERVAL_MS,
    memoryRerankerL,
    bulletinHolder,
  ).pipe(
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
    // #221 conversation forking: fork_thread MCP tool + in-memory proposal store.
    // provideMerge (not provide): ForkProposalStore must stay VISIBLE above this
    // layer — buildMain resolves it for the ui-ws threadForks handle. A plain
    // provide hid the store and crashed boot with
    // "Service not found: luna/ForkProposalStore" on every stable deploy after #355.
    Layer.provideMerge(ThreadToolsLayer),
    Layer.provide(connectorServiceL), // PRD Part A: mounts read by decorate()
    Layer.provide(mcpServerStoreL), // official MCP support: durable registry read by boot-sync
    Layer.provide(mcpRegistryL), // official MCP support: runtime projection read by decorate()
    Layer.provide(secretL), // official MCP support: resolves header secret-refs at mount
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

  // DreamStore (luna.db) for the V2 DreamWorker, wired into
  // buildWorkerRegistryLayer below. DreamReasonerDefault (from adapter-sdk)
  // closes over the boot's sdkClientL + memoryRouterL. LunaSqliteBootstrap is
  // satisfied at the bottom of buildServerLayer, same as every other
  // SQLite-backed layer here.
  const dreamStoreL = DreamStore.makeLayer(paths.lunaDbPath).pipe(Layer.provide(clockL))

  // Wake (Path A) workspace path: the V2 WakeWorker opens
  // <workspacePath>/.workspace/workspace.db (wakeWorkerLogStoreL below). Resolved
  // from LUNA_WAKE_WORKSPACE_PATH, falling back to LUNA_REPO_ROOT then cwd.
  const wakeWorkspacePath =
    process.env["LUNA_WAKE_WORKSPACE_PATH"]?.trim() ||
    process.env["LUNA_REPO_ROOT"]?.trim() ||
    process.cwd()

  // Scheduler V2 (DESIGN.md §5.3 / §5.3.5) is the only scheduler. A single
  // supervised JobTicker fiber drains the `jobs` table every 60 s, claims due
  // rows, and dispatches them through the WorkerRegistry — which registers the
  // prompt + workflow workers AND the dedicated dream + wake workers. The
  // nightly dream + per-workspace wake cycles run exclusively as `kind:"dream"` /
  // `kind:"wake"` job rows drained by the ticker (no legacy fiber-per-cron path).
  console.log(
    "[luna/sched] V2 ticker active — kinds=prompt,workflow,dream,wake",
  )
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

  // Hot-tier bulletin refresher (BULLETIN.md). Separate layer because it
  // needs ChatService + SessionStore + BulletinWriter; the holder is shared
  // by closure with ThreadToolsProviderLayer's decorate() above.
  // ACTIVITY-GATED: a tick only spends a writer call when some thread's
  // lastMessageAt moved past the last successful generation, so an idle
  // server costs nothing. Fail-safe: any tick failure keeps the previous
  // digest. Eligibility comes ENTIRELY from chat.listThreads (active
  // status), which already excludes archived, hidden, and empty-probe
  // threads (#306) - the exclusion the eval fixture's leak probes test.
  const bulletinRefresherL = !bulletinEnabled
    ? Layer.empty
    : Layer.scopedDiscard(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const store = yield* SessionStore
          const writer = yield* BulletinWriter
          const registry = yield* ThreadRegistryService
          const refreshMs = (() => {
            const raw = process.env["LUNA_BULLETIN_REFRESH_MS"]?.trim()
            const n = raw ? Number(raw) : 900_000
            return Number.isFinite(n) && n >= 60_000 ? n : 900_000
          })()
          let lastDigest: string | null = null
          let lastActivityMs = 0
          // Warm start: serve the persisted digest from t=0 after a restart,
          // and treat the file's mtime as the last-generation watermark so a
          // plain restart does not trigger a gratuitous regeneration.
          try {
            const text = readFileSync(bulletinFilePath, "utf8")
            if (text.trim().length > 0) {
              lastDigest = text
              lastActivityMs = statSync(bulletinFilePath).mtimeMs
              bulletinHolder.current = buildBulletinInjectionBlock(text)
              console.log(`[luna/bulletin] warm-started from ${bulletinFilePath}`)
            }
          } catch {
            // No persisted digest yet - first tick will write one.
          }

          const tick = Effect.gen(function* () {
            // FAIL-CLOSED eligibility (Codex review of #342): listThreads'
            // archived exclusion deliberately degrades OPEN under registry
            // read failures (an acceptable sidebar-UX tradeoff; a stale row
            // flashing in a list self-heals). The bulletin's privacy
            // guarantee cannot inherit that leniency - a leaked archived
            // thread would be summarized, persisted, and injected into every
            // session for a whole refresh cycle. So the tick requires a
            // POSITIVE active-status allowlist straight from the registry
            // and aborts (keeping the previous digest) when that read dies.
            // A thread not yet upserted into the registry is conservatively
            // excluded until its first turn registers it.
            const activeRows = yield* registry.listByStatus("active").pipe(
              Effect.catchAllDefect((defect) =>
                Effect.fail(
                  new Error(`registry active-list unavailable (fail-closed, keeping previous digest): ${String(defect)}`),
                ),
              ),
            )
            const activeIds = new Set(activeRows.map((r) => r.id))
            // DUAL eligibility (Codex round 2): registry-active alone is not
            // enough - closeThread() (the user's "remove from sidebar") only
            // sets the SessionStore status to "closed" and never tells the
            // registry, so a closed thread stays registry-active. Require
            // BOTH: registry says active (catches archived, fail-closed
            // above) AND the store status is a live one (catches
            // user-closed and errored threads). "idle" is a quiet-but-live
            // thread and legitimately included.
            const threads = (yield* chat.listThreads(50)).filter(
              (t) =>
                activeIds.has(t.id) &&
                (t.status === "active" || t.status === "idle"),
            )
            const maxActivity = threads.reduce(
              (m, t) => Math.max(m, t.lastMessageAt ?? 0),
              0,
            )
            if (maxActivity <= lastActivityMs) return
            const activity: BulletinThreadActivity[] = []
            for (const t of threads) {
              if (t.lastMessageAt === null) continue
              const msgs: ChatMessage[] = yield* projectChatMessages(
                store.readMessages(t.id),
              ).pipe(
                Stream.runCollect,
                Effect.map((c) => Array.from(c)),
                // A single unreadable thread must not sink the whole tick.
                Effect.catchAll(() => Effect.succeed([] as ChatMessage[])),
              )
              const texts = msgs
                .filter((m) => m.text.trim().length > 0)
                .map((m) => ({
                  ts: new Date(m.ts).toISOString(),
                  role: m.role,
                  text: stripClientMarker(m.text),
                }))
              if (texts.length === 0) continue
              activity.push({
                id: t.id,
                title: t.title ?? "(untitled)",
                lastMessageAt: new Date(t.lastMessageAt).toISOString(),
                messages: texts,
              })
              // Reading messages is the expensive part of a tick; stop once
              // we have more threads than the snapshot shaper will keep.
              if (activity.length >= BULLETIN_MAX_THREADS * 2) break
            }
            const snapshot = shapeActivitySnapshot(activity, Date.now())
            if (snapshot.length === 0) return
            const digest = yield* writer.write({
              nowIso: new Date().toISOString(),
              previousBulletin: lastDigest,
              activity: snapshot,
            })
            lastDigest = digest
            lastActivityMs = maxActivity
            bulletinHolder.current = buildBulletinInjectionBlock(digest)
            try {
              // Atomic persist (temp + rename): a crash mid-write must not
              // leave a torn file that warm-start would inject on restart.
              const tmp = `${bulletinFilePath}.${process.pid}.tmp`
              writeFileSync(tmp, digest)
              renameSync(tmp, bulletinFilePath)
            } catch (e) {
              console.warn("[luna/bulletin] persist failed (digest still live in-memory):", e)
            }
            console.log(
              `[luna/bulletin] refreshed: ~${estimateBulletinTokens(digest)} tokens from ${snapshot.length} thread(s)`,
            )
          }).pipe(
            Effect.catchAllCause((cause) =>
              Effect.sync(() =>
                console.warn(
                  "[luna/bulletin] tick failed (keeping previous digest):",
                  String(cause).slice(0, 300),
                ),
              ),
            ),
          )

          // First tick shortly after boot (let stores settle), then steady
          // cadence. forkScoped ties the fiber to this layer's Scope.
          yield* Effect.forkScoped(
            Effect.sleep("20 seconds").pipe(
              Effect.zipRight(tick),
              Effect.zipRight(
                Effect.forever(Effect.sleep(refreshMs).pipe(Effect.zipRight(tick))),
              ),
            ),
          )
          console.log(
            `[luna/bulletin] enabled: refresh every ${refreshMs}ms, persisted at ${bulletinFilePath}`,
          )
        }),
      ).pipe(
        Layer.provide(chatL),
        Layer.provide(storeL),
        Layer.provide(threadRegistryWithMigrationL),
        Layer.provide(
          BulletinWriterDefault.pipe(Layer.provide(sdkClientL), Layer.provide(brokerL)),
        ),
      )

  // V2 registry: ONE empty registry seeded with the prompt + workflow workers
  // (adapter-sdk) AND the dream + wake workers (scheduler-v2 dream/wake
  // migration, M1 + M2). buildWorkerRegistryLayer is the SAME factory the M3
  // integration test exercises with fakes, so the live boot and the test agree
  // on the kind set. provideMerge (inside the factory) keeps the registry
  // visible to JobTickerLayer above it. The #124 chat_thread delivery sink
  // (chatThreadPosterL) is threaded through so the prompt worker's
  // serviceOption resolves it at dispatch time — preserving deliver_to=chat_thread.
  //
  // dreamReasonerL / wakeReasonerL are what the dream / wake workers need
  // (DreamReasonerDefault needs SDKClient + MemoryRouter + AccountBroker;
  // WakeReasonerDefault needs SDKClient + AccountBroker), closing over the SAME
  // boot identities (sdkClientL, memoryRouterL, brokerL). wakeLogStoreL opens
  // the wake workspace's workspace.db at wakeWorkspacePath so the dream / wake
  // workers reach real services at dispatch time.
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
    suggestedActionsL,
    skillRegistryL,
    wakeReasonerL: wakeWorkerReasonerL,
    wakeLogStoreL: wakeWorkerLogStoreL,
  })
  // S11a: `lunaHome: LUNA_HOME` passes the SAME already-resolved constant
  // (module scope, above) that the shutdown handlers write the
  // clean-shutdown marker to - writer and reader read one variable, not two
  // independent env-var resolutions, so they can never disagree.
  const jobTickerL = JobTickerLayer({ lunaHome: LUNA_HOME }).pipe(
    Layer.provide(Layer.mergeAll(jobsStoreL, workerRegistryL, clockL)),
  )

  // Phase 3 D3: Survey layer for the WS-mediated check-in. AlignmentStore and
  // BeliefWriter both use memoryRouterL + clockL from the same boot identities
  // (so survey-activated beliefs + D5 injection read the SAME router).
  // LunaSqliteBootstrap satisfied at the bottom of buildServerLayer, same as
  // every other SQLite-backed layer here.
  const alignmentStoreL = AlignmentStore.makeLayer(paths.lunaDbPath).pipe(Layer.provide(clockL))
  const beliefWriterL = BeliefWriter.Default.pipe(Layer.provide(memoryRouterL), Layer.provide(clockL))
  const surveyL = buildSurveyLayer({ alignmentStoreL, beliefWriterL, memoryRouterL, clockL })

  // ── Communication channels (Telegram, …) ────────────────────────────────
  // @luna/channels bridges external chat platforms to ChatService as a pure
  // downstream consumer (subscribe → deliver), exactly like ui-ws. The two
  // durable stores reuse luna.db; LunaSqliteBootstrap is satisfied at the
  // bottom of buildServerLayer like every other SQLite-backed layer here.
  // ChannelServiceLayer is provided ChatService (chatL) by reference, so it
  // shares the SAME ChatService instance the WS server uses (Effect memoizes
  // layers by reference) — no second SDK runtime. Adapters are registered and
  // started in buildMain once the runtime is live.
  const channelSessionStoreL = ChannelSessionStore.makeLayer(paths.lunaDbPath).pipe(
    Layer.provide(clockL),
  )
  const channelDedupStoreL = InboundDedupStore.makeLayer(paths.lunaDbPath).pipe(
    Layer.provide(clockL),
  )
  const channelServiceL = ChannelServiceLayer.pipe(
    Layer.provide(Layer.mergeAll(channelSessionStoreL, channelDedupStoreL, chatL, clockL)),
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
    workspacesL,
    jobsStoreL,  // Phase 12a: persisted schedules (DESIGN §5.1 jobs table)
    jobTickerL, // V2 ticker: the only scheduler — drains the jobs table and drives prompt/workflow/dream/wake via job rows (DESIGN §5.3.5)
    surveyL,    // Phase 3 D3: Survey available for buildServerLayer to resolve + pass to the WS server
    suggestedActionsL, // Suggested Actions: buildServerLayer resolves it for the WS respond handle (same instance the chat layer uses)
    // Auto-execute + completion observer for accepted suggested actions. The V2
    // ticker dispatches the durable one-shot job AcceptHandler enqueues.
    acceptHandlerL,
    skillRegistryL, // PRD Part B: same instance as threadToolsL (memoized by reference) — buildServerLayer resolves it for the WS skill frames
    connectorServiceL, // PRD Part A: same instance as threadToolsL — M2's WS connector frames resolve it here
    artifactStoreL, // PRD Part C/W1: buildServerLayer resolves it for the WS artifact frames
    vaultStoreL, // Vault V1: buildServerLayer resolves it for the WS vault frames
    threadRegistryWithMigrationL, // Phase 1: durable thread index (luna.db threads table)
    channelServiceL, // Communication channels (Telegram, …): adapters registered + started in buildMain
    bulletinRefresherL, // Hot-tier bulletin (BULLETIN.md): Layer.empty unless LUNA_BULLETIN=1
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
//
// The clean-shutdown marker may only be written by a boot that actually RAN
// crash-reconcile (armed in buildMain after ServerHandle builds). Setup-mode
// boots and SIGTERMs during the lazy layer build never reconcile, so a marker
// from them would launder a PRECEDING genuine crash's orphans into an
// exempted boot - the fail-open the S11a invariant forbids.
let cleanShutdownMarkerArmed = false
const installShutdown = (rt: { dispose: () => Promise<unknown> }): void => {
  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    // Restart-aware orphan accounting (S11a): a plain sidecar marker,
    // written SYNCHRONOUSLY at handler entry - before dispose starts and
    // while the DB is still open - so a fast exit can't lose it and dispose
    // ordering can't race it. Its presence at next boot tells crash-reconcile
    // this was a deliberate shutdown (deploy, manual stop/restart), not a
    // genuine crash (watchdog kill, OOM, power loss); only the latter should
    // advance orphanStreak toward the doctor's pause threshold. The store
    // layer never touches the filesystem - the boot-reconcile call site
    // (job-ticker-reconcile.ts, wired via JobTickerLayer's `lunaHome`
    // option below) unlinks this marker exactly once. Best-effort: a
    // write failure fails TOWARD the doctor (no marker left -> next boot
    // counts as a crash), never away from the crash-reconcile repair that
    // always runs regardless of this marker.
    if (cleanShutdownMarkerArmed) {
      try {
        writeFileSync(join(LUNA_HOME, CLEAN_SHUTDOWN_MARKER_NAME), "")
      } catch {
        /* best-effort - see comment above */
      }
    }
    // Synchronous write to stdout fd — `console.log` to a PIPE (systemd
    // captures stdout via a pipe, not a TTY) is async, so the buffered
    // line is lost when `process.exit(0)` truncates it below. writeSync
    // flushes before the dispose/exit, so the shutdown is observable in
    // journald.
    writeSync(1, `\n👋 shutting down (${signal})\n`)
    // Deactivate the L1 watchdog BEFORE draining: stop the beat loop and tell
    // systemd we're STOPPING so the drain is judged by TimeoutStopSec, not
    // SIGABRTed by a watchdog window that no beats will ever refill.
    sdWatchdog?.stop()
    notifyStopping()
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
  wsPort: number = SETUP_WS_PORT,
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
        ...(BUILD_VERSION !== undefined ? { serverVersion: BUILD_VERSION } : {}),
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
        // No model-routing settings in setup-mode: the settings panel needs
        // an authenticated session to be useful anyway, and setup-mode has
        // no chat. Clients degrade gracefully when the capability is absent.
        modelRoutingService: null,
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

// PNG signature (8 bytes) — see readPngDimensions below.
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/**
 * Parse a PNG buffer's IHDR chunk for width/height — small, dependency-free
 * (avoids pulling in an image-decoding library just for two integers). The
 * PNG signature is 8 bytes, followed by a 4-byte chunk length, the 4-byte
 * "IHDR" tag, then width (4 bytes BE) at offset 16-19 and height (4 bytes
 * BE) at offset 20-23. Returns null on any signature mismatch or short
 * buffer — NEVER throws. Used by writeFeedbackScreenshot (Moon feedback-
 * screenshot + triage-queue, Phase 1) to record dimensions from the actual
 * decoded file rather than trusting client-reported values; a null result
 * still lets the screenshot file write succeed, just with width/height
 * recorded as 0 (dimension metadata is best-effort, separate from the "did
 * the file write succeed" gate). Exported for unit tests.
 */
export const readPngDimensions = (buf: Buffer): { width: number; height: number } | null => {
  try {
    if (buf.length < 24) return null
    if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null
    if (buf.toString("ascii", 12, 16) !== "IHDR") return null
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    if (width <= 0 || height <= 0) return null
    return { width, height }
  } catch {
    return null
  }
}

export interface FeedbackScreenshotMeta {
  readonly screenshotPath: string
  readonly width: number
  readonly height: number
  readonly bytes: number
  readonly captureMethod: "native-window"
}

/**
 * Decode a base64 PNG, write it to `<feedbackScreenshotsDir>/<id>.png`, and
 * return its metadata — or null on ANY failure (bad/empty base64, mkdir/
 * write error, …). Screenshot capture is ALWAYS best-effort: this function
 * must never throw, so feedbackSink.submit can proceed to record the note
 * with no screenshot metadata rather than fail the whole submission.
 * Exported for unit tests (chat-server.ts's own boot closure isn't
 * independently testable, but this pure disk-write step is).
 */
export const writeFeedbackScreenshot = (
  screenshotB64: string | undefined,
  id: string,
  feedbackScreenshotsDir: string,
): FeedbackScreenshotMeta | null => {
  if (typeof screenshotB64 !== "string" || screenshotB64.length === 0) return null
  try {
    const buf = Buffer.from(screenshotB64, "base64")
    if (buf.length === 0) return null
    mkdirSync(feedbackScreenshotsDir, { recursive: true })
    const screenshotPath = join(feedbackScreenshotsDir, `${id}.png`)
    writeFileSync(screenshotPath, buf)
    const dims = readPngDimensions(buf)
    return {
      screenshotPath,
      width: dims?.width ?? 0,
      height: dims?.height ?? 0,
      bytes: buf.length,
      captureMethod: "native-window",
    }
  } catch {
    return null
  }
}

/** Maps a client-supplied threadId to the session_id stored on a ui_feedback
 *  note. Empty string and missing values both fall back to the sentinel
 *  session so the note is never recorded with an empty session_id (which
 *  downstream deliver_to logic treats as "no real thread"). Exported for
 *  unit tests. */
export const resolveUiFeedbackSessionId = (threadId: string | undefined): string =>
  threadId || UI_FEEDBACK_SENTINEL_SESSION

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
      const agentNotes = yield* AgentNotesService // point-at-UI feedback sink
      const skillRegistryService = yield* SkillRegistry // PRD Part B
      const connectorServiceHandle = yield* ConnectorService // PRD Part A
      const artifactStoreService = yield* ArtifactStore // PRD Part C/W1
      const jobsStore = yield* JobsStoreService // PRD Part C/W3 (gallery source)
      const jobTicker = yield* JobTicker // /readyz.scheduler health (V2 ticker)
      const telemetry = yield* TelemetryService // Phase 7: pulse-snapshot source
      const suggestedActionsService = yield* SuggestedActions // suggest_action
      const mem = yield* MemoryRouterTag // memory-browser mcp-app tools (below)
      // Capture Effect runtime so the HTTP /readyz path can sync-read ticker
      // health without holding an Effect fiber (ui-ws is plain node:http).
      const effectRuntime = yield* Effect.runtime<JobTicker>()
      // AcceptHandler is always wired (see the merge above), so this resolves.
      // Kept as serviceOption for defensive symmetry with SuggestedActions.respond
      // (absent → accept would leave the action at `accepted`).
      const acceptHandlerOption = yield* Effect.serviceOption(AcceptHandler)

      // ── Phase 3: auto-archive wiring ────────────────────────────────────────
      //
      // runAutoArchive has NO production caller without this block — threads
      // would never auto-archive. This is the interim home; it can migrate to
      // the wake cycle later once wake redesign is complete.
      //
      // Strategy: run once at boot (best-effort, fire-and-forget so a DB hiccup
      // never blocks server start), then again every 24 hours in-process.
      //
      // Liveness predicate: ChatService's in-flight turn state is private (the
      // `threads` Ref is internal). Rather than coupling the registry to
      // ChatService's internals, we omit the predicate here and let the
      // 14-day `last_active_at` proxy serve as the guard. A thread that had a
      // live turn within the last 14 days will have its `last_active_at` updated
      // and will not appear in listStale(). This is conservative and safe.
      // (The `isLive` predicate in runAutoArchive's signature exists for callers
      // that DO have access to a live-thread set — e.g. integration tests.)
      const threadRegistryOption = yield* Effect.serviceOption(ThreadRegistryService)
      const runAutoArchiveBestEffort = (): void => {
        // NOTE: this is called from outside an Effect.gen generator (from a
        // setTimeout-like position), so plain Promise is fine here.
        if (Option.isNone(threadRegistryOption)) return
        const reg = threadRegistryOption.value
        const nowMs = Date.now()
        // Effect.either wraps errors so a failure in runAutoArchive can never
        // propagate out — this is the canonical best-effort escape hatch.
        Effect.runPromise(
          Effect.either(
            runAutoArchive(reg, nowMs).pipe(
              Effect.flatMap((archived) =>
                archived.length > 0
                  ? Effect.sync(() => {
                      console.log(
                        `[luna/thread-registry] auto-archived ${archived.length} idle thread(s): ${archived.join(", ")}`,
                      )
                      // Notify connected clients so an actively-viewed thread
                      // that just got auto-archived recovers gracefully instead
                      // of going silently stale. Null-guarded: no-op pre-server
                      // (e.g. the boot run before any WS client connects).
                      notifyThreadsArchived?.(archived)
                    })
                  : Effect.void,
              ),
            ),
          ),
        ).catch(() => {
          // Effect.either means errors appear as Left, not as Promise rejection.
          // This catch is a belt-and-suspenders guard; it should never fire.
        })
      }

      // Boot run: fire-and-forget, best-effort.
      runAutoArchiveBestEffort()

      // Daily interval: 24 h in-process. forkScoped ties the interval to the
      // server scope so it is cancelled cleanly on graceful shutdown.
      const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(TWENTY_FOUR_HOURS_MS).pipe(
            Effect.zipRight(Effect.sync(runAutoArchiveBestEffort)),
          ),
        ),
      )

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
      const discoveredOpTokens = yield* Effect.promise(() => discoverOpTokens())
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
        // W2 tiered-storage snapshot - attached to every vault-list frame so the
        // UI can render one "where secrets land" status line. Boot-computed
        // constant (metadata only, no names/values); null until bootstrap() sets
        // it, in which case the frame omits the field (additive).
        storage: () => vaultStorageStatus,
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
      // Moon memory-browser mcp-app tools (memory-list/memory-search): both
      // scope reads to OPERATOR_MEMORY_SCOPE — the same observer/subject the
      // memory_save/memory_search SDK tools already stamp/filter on — so the
      // curated app surface can never see another scope's records. `mem` is
      // the MemoryRouterTag resolved at the top of buildServerLayer, not the
      // ThreadToolsProviderLayer binding refreshBeliefs/recallForTurn use.
      const memoryBrowserScope = {
        observerId: OPERATOR_MEMORY_SCOPE.observerId,
        subjectId: OPERATOR_MEMORY_SCOPE.subjectId,
      }
      const getMemoryListPage = (
        args: ValidatedMemoryListArgs,
      ): Promise<MemoryListPage> =>
        Effect.runPromise(
          mem
            .query({
              ...(args.namespace !== undefined ? { namespace: args.namespace } : {}),
              ...(args.kind !== undefined ? { kind: args.kind } : {}),
              ...(args.tag !== undefined ? { tag: args.tag } : {}),
              ...(args.since !== undefined ? { since: args.since } : {}),
              // MemoryQuery has no native offset — over-fetch one page past the
              // requested window (+1) so hasMore is exact, then slice below.
              limit: args.offset + args.limit + 1,
              scope: memoryBrowserScope,
            })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => {
                const all = Array.from(chunk).sort((a, b) => b.updatedAt - a.updatedAt)
                const page = all.slice(args.offset, args.offset + args.limit)
                return {
                  rows: page.map(toCuratedMemoryRow),
                  limit: args.limit,
                  offset: args.offset,
                  hasMore: all.length > args.offset + args.limit,
                }
              }),
            ),
        )
      const getMemorySearchPage = (
        args: ValidatedMemorySearchArgs,
      ): Promise<MemorySearchPage> => {
        if (args.query.length === 0) {
          return Promise.resolve({ rows: [], query: args.query, topK: args.topK })
        }
        // Over-fetch when a kind filter is set (mirrors memory_search in
        // @luna/memory-tools tools.ts) so the post-filter still has enough
        // candidates to return `topK` matches.
        const fetchTopK =
          args.kind !== undefined ? Math.max(args.topK * 4, 20) : args.topK
        return Effect.runPromise(
          Effect.gen(function* () {
            // Tag the failure on the result instead of letting it throw
            // (mirrors ChatService.searchMemory in chat-service.ts
            // ~2701-2745) so the mcp-app callTool's generic catch-all never
            // swallows the ONE distinction the memory-browser panel needs:
            // "no vector backend configured" (safe to silently fall back to
            // memory-list) vs any other failure (a real error banner).
            const either = yield* Effect.either(
              Stream.runCollect(
                mem.search({
                  queryText: args.query,
                  topK: fetchTopK,
                  ...(args.namespace !== undefined ? { namespace: args.namespace } : {}),
                  mode: "hybrid",
                  scope: memoryBrowserScope,
                }),
              ),
            )
            if (either._tag === "Left") {
              const err = either.left as { cause?: unknown; message?: unknown }
              const causeMsg =
                typeof err.cause === "object" && err.cause !== null
                  ? (err.cause as { message?: string }).message
                  : typeof err.cause === "string"
                    ? err.cause
                    : undefined
              const msg =
                causeMsg ??
                (typeof err.message === "string" ? err.message : String(err))
              // Substring check on "no vector backend" (singular) so it
              // matches BOTH router messages: the per-namespace one ("no
              // vector backend for namespace X") and the fan-out one ("no
              // vector backends registered") — chat-service.ts's classifier
              // only checks the plural form and misses the namespaced case.
              const kind: MemorySearchErrorKind = msg.includes("no vector backend")
                ? "no-vector-backend"
                : "internal"
              return {
                rows: [],
                query: args.query,
                topK: args.topK,
                error: { kind, message: msg },
              }
            }
            const all = Array.from(either.right)
            const filtered =
              args.kind !== undefined
                ? all.filter((h) => h.record.kind === args.kind)
                : all
            const page = filtered.slice(0, args.topK)
            return {
              rows: page.map((h) => ({ ...toCuratedMemoryRow(h.record), score: h.score })),
              query: args.query,
              topK: args.topK,
            }
          }),
        )
      }
      // memory-delete: the ONE mutation exposed to the memory-browser app
      // surface. deleteMemoryRecordWithScopeCheck (core-apps.ts) fetches
      // THEN re-checks scope before deleting — the SAME defense-in-depth
      // pattern memory_delete uses in @luna/memory-tools tools.ts
      // (~258-288), even though memoryBrowserScope already bounds every
      // read/write these deps can reach.
      const getMemoryDelete = (
        args: ValidatedMemoryDeleteArgs,
      ): Promise<MemoryDeleteResult> =>
        deleteMemoryRecordWithScopeCheck(args, {
          getRecord: (id) => Effect.runPromise(mem.get(id)),
          deleteRecord: (id) => Effect.runPromise(mem.delete(id)),
          matchesScope: (record) => matchesMemoryScope(record, memoryBrowserScope),
        })

      // ── UI Feedback Triage Status (Moon feedback-screenshot + triage-
      // queue, Phase 1) ────────────────────────────────────────────────
      // Independent bun:sqlite connection to luna.db for the
      // ui_feedback_status companion table — mirrors modelRoutingService's
      // (below, ~3720) exact require("bun:sqlite") + try/catch shape: opens
      // its own handle, tolerates open failure (feature disabled, never
      // crashes the server), and closes via an Effect finalizer. Must be
      // defined BEFORE mcpAppHost below, since buildFeedbackQueueApp and the
      // curated feedback-list/feedback-set-status tools need these deps.
      let uiFeedbackStatusDbClose: (() => void) | null = null
      const uiFeedbackStatusStore = (() => {
        try {
          const ufsPaths = resolveRuntimePaths()
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { Database } = require("bun:sqlite") as {
            Database: BunSqliteDb
          }
          const ufsDb = new Database(ufsPaths.lunaDbPath)
          uiFeedbackStatusDbClose = () => ufsDb.close()
          return openUiFeedbackStatusStore(ufsDb)
        } catch (err) {
          writeSync(
            1,
            `[luna/ui-feedback] failed to open status store (feedback triage disabled): ${String(err)}\n`,
          )
          return null
        }
      })()
      if (uiFeedbackStatusDbClose !== null) {
        const closeUfsDb = uiFeedbackStatusDbClose
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              closeUfsDb()
            } catch {
              // best-effort: a failed close on shutdown must not throw.
            }
          }),
        )
      }
      // Tolerates a null store (feature disabled if it failed to open) —
      // degrades to an empty page / a friendly ok:false rather than crashing.
      const getFeedbackList = async (
        args: ValidatedFeedbackListArgs,
      ): Promise<FeedbackListPage> => {
        if (uiFeedbackStatusStore === null) {
          return { rows: [], limit: args.limit, offset: args.offset, hasMore: false }
        }
        const { rows, hasMore } = uiFeedbackStatusStore.list(args)
        return { rows, limit: args.limit, offset: args.offset, hasMore }
      }
      const getFeedbackSetStatus = async (
        args: ValidatedFeedbackSetStatusArgs,
      ): Promise<{ readonly ok: boolean; readonly message?: string }> => {
        if (uiFeedbackStatusStore === null) {
          return { ok: false, message: "feedback triage store unavailable" }
        }
        return uiFeedbackStatusStore.setStatus(args, Date.now())
      }

      // ── Feedback → durable job bridge (@luna/core feedback-job-bridge) ────
      // Reused by both the submit-time auto-enqueue below (feedbackSink) AND
      // the `feedback-create-job` curated tool (buildCuratedAppTools) — one
      // deps object, one createFeedbackCreateJobDep call. jobsStore is the
      // already-in-scope Effect-based JobsStoreService (~3153); adapted to
      // FeedbackJobsDep's plain-Promise shape with Effect.runPromise, the
      // same seam every other Promise-based dep in this file uses to reach
      // an Effect service (getMemoryDelete, getFeedbackList, …).
      const feedbackJobsDep: FeedbackJobsDep = {
        record: (input) => Effect.runPromise(jobsStore.record(input)),
        getById: (id) => Effect.runPromise(jobsStore.getById(id)),
      }
      const feedbackSetStatusDep: FeedbackSetStatusDep = async (args, nowMs) => {
        if (uiFeedbackStatusStore === null) {
          return { ok: false, message: "feedback triage store unavailable" }
        }
        return uiFeedbackStatusStore.setStatus(args, nowMs)
      }
      const feedbackCreateJob = createFeedbackCreateJobDep({
        store:
          uiFeedbackStatusStore !== null
            ? { getRow: (id) => uiFeedbackStatusStore.getRow(id) }
            : null,
        jobs: feedbackJobsDep,
        setStatus: feedbackSetStatusDep,
        nowMs: () => Date.now(),
      })

      // Completion observer: folds a feedback job's terminal run status back
      // onto the note (queued -> resolved | job-failed). Best-effort, forked
      // for the life of this Layer.scoped's Scope — mirrors AcceptHandler's
      // own completion observer (acceptHandlerL above). No-op (nothing to
      // observe) when the status store failed to open at boot.
      if (uiFeedbackStatusStore !== null) {
        const ufs = uiFeedbackStatusStore
        yield* Layer.build(
          FeedbackJobObserverLayer({
            listQueued: async (limit) => {
              const { rows } = ufs.list({ limit, offset: 0, status: "queued" })
              return rows.map((r) => ({ id: r.id, resolvedRef: r.resolvedRef }))
            },
            listRuns: (jobId, limit) => Effect.runPromise(jobsStore.listRuns(jobId, limit)),
            setStatus: feedbackSetStatusDep,
            nowMs: () => Date.now(),
          }),
        )
      }

      // ── G4 external MCP-app stdio relay (#161) ─────────────────────────────
      // Env-gated, default-off: LUNA_EXTERNAL_MCP_SERVERS unset/empty ⇒ no
      // subprocesses, inert third provider, production behavior unchanged.
      // Spec is a JSON array of { id, command, args?, env? }. Each server is
      // best-effort at boot (one bad connect does not fail the chat server);
      // every successful LiveExternalServer is closed on scope teardown so
      // subprocess handles do not leak across restarts.
      const externalMcpSpecs = parseExternalMcpServersEnv(
        process.env["LUNA_EXTERNAL_MCP_SERVERS"],
      )
      const liveExternalServers: LiveExternalServer[] = []
      if (externalMcpSpecs.length > 0) {
        writeSync(
          1,
          `[luna/mcp-apps] G4: connecting ${externalMcpSpecs.length} external MCP server(s) from LUNA_EXTERNAL_MCP_SERVERS\n`,
        )
        for (const spec of externalMcpSpecs) {
          const connected = yield* Effect.tryPromise({
            try: () => connectExternalStdioServer(spec),
            catch: (cause) =>
              new Error(
                `external MCP "${spec.id}" connect failed: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
              ),
          }).pipe(
            Effect.catchAll((err) => {
              writeSync(
                1,
                `[luna/mcp-apps] G4: ${err instanceof Error ? err.message : String(err)}\n`,
              )
              return Effect.succeed(null as LiveExternalServer | null)
            }),
          )
          if (connected !== null) {
            liveExternalServers.push(connected)
            writeSync(
              1,
              `[luna/mcp-apps] G4: connected "${connected.id}" ` +
                `(${connected.resourceUris.size} resource(s), ${connected.toolNames.size} tool(s))\n`,
            )
          }
        }
        if (liveExternalServers.length > 0) {
          const toClose = liveExternalServers.slice()
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              for (const s of toClose) {
                try {
                  await s.close()
                } catch {
                  // best-effort: a failed subprocess close on shutdown must not throw
                }
              }
            }),
          )
        }
      }
      const externalMcpAppRegistry = createExternalMcpAppRegistry(liveExternalServers)

      const mcpAppHost = createMcpAppHost(
        composeAppRegistries(
          // Static, compile-time core apps (the Luna server as first provider).
          createCoreAppRegistry([
            buildWorkspacePulseApp(getPulse),
            buildFeedbackQueueApp({
              feedbackList: getFeedbackList,
              feedbackSetStatus: getFeedbackSetStatus,
              feedbackCreateJob,
            }),
          ]),
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
              // memory-list / memory-search / memory-delete: OPERATOR-scoped
              // memory browsing (+ the one mutation, delete) for the Moon
              // "memory browser" mcp-app. Args arrive pre-validated
              // (buildCuratedAppTools validates before dispatch).
              memoryList: getMemoryListPage,
              memorySearch: getMemorySearchPage,
              memoryDelete: getMemoryDelete,
              // feedback-list / feedback-set-status: curated tools that back
              // the static ui://luna/feedback-queue app and are also available
              // to store-backed apps (Phase 2's live queue app).
              feedbackList: getFeedbackList,
              feedbackSetStatus: getFeedbackSetStatus,
              // feedback-create-job: optional manual re-run/queue of a durable
              // job for a `ui_feedback` report — same deps object the submit-
              // time auto-enqueue above uses, reused here rather than a second
              // createFeedbackCreateJobDep.
              feedbackCreateJob,
            }),
            // Reads are useful to generated memory/feedback views, but each
            // mutation is a privileged capability of its OWN reviewed artifact,
            // not something every generated app inherits.
            // isCuratedToolAllowed (core-apps.ts) is the extracted, tested
            // truth table — the live gate, not a hand-rolled duplicate of it.
            isToolAllowed: isCuratedToolAllowed,
          }),
          // G4 third-party relay: ui:// from external stdio MCP servers
          // (same-server tool rule enforced inside createExternalMcpAppRegistry).
          externalMcpAppRegistry,
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

      // #221 conversation forking: list/respond/changes for ui-ws.
      const forkStore = yield* ForkProposalStore
      const threadForksHandle = {
        listPending: (threadId: string) =>
          forkStore.listPendingByThread(threadId).pipe(
            Effect.map((rows) => rows.map(toForkProposalWire)),
          ),
        changes: Stream.map(forkStore.changes, toForkProposalWire),
        respond: (input: {
          readonly threadId: string
          readonly proposalId: string
          readonly decision: "accept" | "dismiss"
        }) =>
          Effect.gen(function* () {
            if (input.decision === "dismiss") {
              const dismissed = yield* forkStore.dismiss(
                input.proposalId,
                input.threadId,
              )
              return dismissed
                ? { ok: true as const }
                : { ok: false as const, message: "proposal not found or not pending" }
            }

            // Claim first (atomic pending → accepting) so a concurrent second
            // accept cannot create an orphaned empty thread.
            const claimed = yield* forkStore.claim(input.proposalId, input.threadId)
            if (claimed === null) {
              return {
                ok: false as const,
                message: "proposal not found or not pending",
              }
            }

            // Resume-fork: inherit parent SDK session when known.
            let resumeFromSessionId: string | undefined
            if (Option.isSome(threadRegistryOption)) {
              const row = yield* threadRegistryOption.value.get(input.threadId)
              if (row?.sdkSessionId) resumeFromSessionId = row.sdkSessionId
            }

            const child = yield* chat.createThread({
              title: claimed.title,
              parentSessionId: input.threadId,
              tags: [FORK_CHILD_TAG],
              ...(resumeFromSessionId !== undefined
                ? { resumeFromSessionId }
                : {}),
            })

            const accepted = yield* forkStore.completeAccept(
              claimed.id,
              input.threadId,
              child.id,
            )
            if (accepted === null) {
              return {
                ok: false as const,
                message: "proposal already resolved",
              }
            }

            // Seed the sibling so the agent turn starts on the pivoted topic.
            yield* chat.send(child.id, claimed.seed)

            // Parent breadcrumb: one-line note that the topic moved.
            yield* chat.deliverResult({
              threadId: input.threadId,
              text: `↪ Moved "${claimed.title}" to a new thread.`,
              source: "thread-fork",
              label: claimed.title,
            })

            // Telemetry for accept-rate gating of future auto-fork.
            // (EventSink is optional; best-effort via console when sparse.)
            writeSync(
              1,
              `[luna/thread-fork] accepted "${claimed.title}" → ${child.id} (from ${input.threadId})\n`,
            )

            return {
              ok: true as const,
              childThreadId: child.id,
            }
          }).pipe(
            // The E channel here is `never` (every yielded effect above is
            // infallible) - this handler can't actually run, but catchAll
            // still requires a total callback.
            Effect.catchAll((e) =>
              Effect.succeed({
                ok: false as const,
                message: String(e),
              }),
            ),
          ),
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

      // Capability layer (backend-advertised commands): the ui-ws handle
      // returns the plain WireCapabilityCatalog shape. The catalog is built
      // LITERALLY (no internal-state spread), mirroring the skill-catalog
      // body-strip discipline — nothing executable crosses the wire. v1 ships
      // one server-executed command: `interrupt` (the Stop button), which maps
      // to ChatService.interrupt(threadId).
      const capabilityWsHandle = {
        catalog: () =>
          Effect.succeed({
            generation: 1,
            agreedSchema: 1,
            capabilities: [
              {
                kind: "command",
                id: "interrupt",
                title: "Stop",
                description: "Stop the current assistant turn",
                executor: "server" as const,
                schemaVersion: 1,
              },
            ],
          }),
        execute: ({
          id,
          args,
        }: {
          kind: string
          id: string
          args?: Record<string, unknown>
        }) =>
          // ok:true means ACCEPTED (the interrupt was dispatched), not necessarily
          // "a turn was stopped" — ChatService.interrupt is a no-op on an idle/unknown
          // thread; the actual Stop surfaces via the thread's assistant-error(interrupted)
          // frame. Trust note: like the existing `interrupt` frame handler, this trusts
          // the client-supplied threadId — sound under Luna's single-operator-per-server
          // model; revisit (scope to subscribed threads) if a server ever serves multiple
          // principals. interrupt is low-stakes (only stops an in-flight turn).
          id === "interrupt"
            ? chat
                .interrupt(String(args?.threadId ?? ""))
                .pipe(Effect.as({ ok: true }))
            : Effect.succeed({
                ok: false,
                message: `unknown capability ${id}`,
              }),
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

      // Point-at-the-UI feedback sink. Persists each note straight into Jax's
      // ledger (agent_notes, kind='ui_feedback') so `obs_notes_recent` surfaces
      // it — no new table/DDL. `summary` is truncated for ledger legibility;
      // the full note + captured target/appearance live in payload_json. The
      // sessionId threads into the conversation ledger when the frame carries a
      // threadId, else a synthetic 'ui-feedback' stream (agent_notes.session_id
      // is NOT NULL). Errors resolve to { ok:false } so the ack is always honest
      // and never tears down the socket.
      const feedbackSink = {
        submit: (input: {
          readonly note: string
          readonly target?: unknown
          readonly page?: string
          readonly threadId?: string
          readonly appVersion?: string
          readonly appearance?: string
          readonly clientTs?: number
          /** Best-effort base64 PNG (no `data:` prefix) — see
           *  FeedbackSubmitFrame.screenshot / server.ts's SCREENSHOT_MAX_BASE64_CHARS
           *  guard. Decoded and written to disk BEFORE the agent_notes INSERT
           *  (Part D: record() now takes an optional caller id) because
           *  agent_notes is append-only — there is no UPDATE, so the full
           *  payload including screenshot metadata must be complete up front. */
          readonly screenshot?: string
        }): Effect.Effect<{ readonly ok: boolean; readonly message?: string }> => {
          const id = crypto.randomUUID()
          // Screenshot is ALWAYS best-effort — writeFeedbackScreenshot never
          // throws and returns null on any decode/mkdir/write failure, so
          // the note itself must never fail to record because of it.
          const screenshotMeta = writeFeedbackScreenshot(
            input.screenshot,
            id,
            join(LUNA_HOME, "feedback-screenshots"),
          )
          return agentNotes
            .record({
              id,
              sessionId: resolveUiFeedbackSessionId(input.threadId),
              kind: "ui_feedback",
              summary: input.note.slice(0, 200),
              payload: {
                note: input.note,
                target: input.target ?? null,
                page: input.page ?? null,
                appVersion: input.appVersion ?? null,
                appearance: input.appearance ?? null,
                clientTs: input.clientTs ?? null,
                // Purely additive: OMITTED (not null) when there's no
                // screenshot, so old/no-screenshot notes keep the exact
                // pre-this-feature payload shape (see FeedbackListRow's
                // projection in ui-feedback-status-store.ts, which must
                // treat this key as optional and never throw on its absence).
                ...(screenshotMeta !== null ? { screenshot: screenshotMeta } : {}),
              },
            })
            .pipe(
              // Auto-enqueue a durable one-shot job for this note at
              // SUBMIT time, default ON (LUNA_WAKE_ENABLED idiom: only
              // "0" turns it off). Best-effort: any failure here is
              // logged loudly but the note is already durably recorded,
              // so the ack must still be ok:true — a failed auto-job
              // just means the report waits for a manual
              // feedback-create-job retry instead of nothing at all.
              Effect.tap(() => {
                if (!feedbackAutoJobEnabled()) {
                  return Effect.void
                }
                return Effect.promise(() =>
                  runFeedbackCreateJobNoThrow(
                    feedbackCreateJob,
                    id,
                    (message) => writeSync(1, `[luna/ui-feedback] ${message}\n`),
                  ),
                ).pipe(Effect.catchAllCause(() => Effect.void))
              }),
              Effect.as({ ok: true as const }),
              Effect.catchAll(() =>
                Effect.succeed({
                  ok: false as const,
                  message: "Could not record feedback.",
                }),
              ),
            )
        },
      }

      // ── Model Routing Settings (PR 1) ───────────────────────────────────
      // Wire the ProviderSettingsStore to a modelRoutingService handle so the
      // WS server advertises capabilities.modelRouting, pushes model-routing-list
      // after hello, and routes model-routing-save to validate→persist→ack.
      // Activation requires restart (applyProviderSettingsToEnv runs at next
      // boot, feeding the broker with the new config). No secret values cross
      // the wire — credentialRef is an opaque pointer only.
      // Captured so the long-lived mrDb handle is closed on scope teardown.
      // Every other store in this layer routes close() through an Effect
      // finalizer; this one used to leak its bun:sqlite handle for the whole
      // process lifetime. Assigned inside the IIFE below; the finalizer that
      // calls it is registered immediately after.
      let mrDbClose: (() => void) | null = null
      const modelRoutingService = (() => {
        try {
          const mrPaths = resolveRuntimePaths()
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { Database } = require("bun:sqlite") as {
            Database: BunSqliteDb
          }
          const mrDb = new Database(mrPaths.lunaDbPath)
          mrDbClose = () => mrDb.close()
          const mrStore = openProviderSettingsStore(mrDb)
          return {
            list: (): import("@luna/ui-ws").ModelRoutingListFrame => {
              const cfg = mrStore.read()
              return {
                type: "model-routing-list" as const,
                providers: (cfg?.providers ?? []).map((p) => ({
                  kind: p.kind,
                  enabled: p.enabled,
                  ...(p.credentialRef !== undefined ? { credentialRef: p.credentialRef } : {}),
                  ...(p.monthlyCapUsd !== undefined ? { monthlyCapUsd: p.monthlyCapUsd } : {}),
                })),
                roleBindings: (cfg?.roleBindings ?? []).map((b) => ({
                  role: b.role,
                  preferenceList: b.preferenceList.map((pref) => ({
                    provider: pref.provider,
                    model: pref.model,
                  })),
                })),
              }
            },
            save: (input: {
              readonly providers: ReadonlyArray<import("@luna/ui-ws").ProviderSettingsItem>
              readonly roleBindings: ReadonlyArray<import("@luna/ui-ws").RoleBindingItem>
            }): { readonly ok: boolean; readonly message: string } => {
              try {
                // Sanitize client-supplied enums BEFORE casting: the wire types
                // are `string`, so an out-of-set kind/role would otherwise be
                // persisted and silently mis-route at boot. Reject unknowns.
                const KNOWN_KINDS = new Set([
                  "anthropic", "openai", "google", "ollama-cloud", "ollama-local",
                ])
                const KNOWN_ROLES = new Set(["advisor", "daily-driver", "wake", "dream"])
                for (const p of input.providers) {
                  if (!KNOWN_KINDS.has(p.kind)) {
                    return { ok: false, message: `Unknown provider kind: ${String(p.kind)}` }
                  }
                }
                for (const b of input.roleBindings) {
                  if (!KNOWN_ROLES.has(b.role)) {
                    return { ok: false, message: `Unknown role: ${String(b.role)}` }
                  }
                  for (const pref of b.preferenceList) {
                    if (!KNOWN_KINDS.has(pref.provider)) {
                      return { ok: false, message: `Unknown provider kind: ${String(pref.provider)}` }
                    }
                  }
                }
                const candidate: ProviderSettingsPayload = {
                  version: 1,
                  providers: input.providers.map((p) => ({
                    kind: p.kind as import("@luna/core").ProviderKind,
                    enabled: p.enabled,
                    ...(p.credentialRef !== undefined ? { credentialRef: p.credentialRef } : {}),
                    ...(p.monthlyCapUsd !== undefined ? { monthlyCapUsd: p.monthlyCapUsd } : {}),
                  })),
                  roleBindings: input.roleBindings.map((b) => ({
                    role: b.role as import("@luna/core").RoleName,
                    preferenceList: b.preferenceList.map((pref) => ({
                      provider: pref.provider as import("@luna/core").ProviderKind,
                      model: pref.model,
                    })),
                  })),
                }
                validateAndPrepare(candidate)
                // Enable + credentialRef must be enough on the CONNECTED
                // server: upsert settings-<kind> into accounts so the
                // operator never has to re-run `luna account add` on the
                // wrong box. Pointer only — raw keys rejected.
                try {
                  syncProviderAccountsToDb(mrDb, candidate.providers)
                } catch (syncErr) {
                  if (syncErr instanceof ProviderAccountSyncError) {
                    return { ok: false, message: syncErr.message }
                  }
                  throw syncErr
                }
                mrStore.write(candidate)
                return {
                  ok: true,
                  message:
                    "Model routing saved. Restarting server to apply — Moon will reconnect automatically.",
                }
              } catch (err) {
                const msg =
                  err instanceof Error ? err.message : String(err)
                return { ok: false, message: msg }
              }
            },
            scheduleRestart: scheduleServerRestart,
          }
        } catch (err) {
          writeSync(
            1,
            `[luna/model-routing] failed to open settings store (model-routing disabled): ${String(err)}\n`,
          )
          return null
        }
      })()

      // Close the model-routing bun:sqlite handle on scope teardown (parity
      // with every other store, which routes close() through a finalizer).
      // No-op when the store failed to open (mrDbClose stays null).
      if (mrDbClose !== null) {
        const closeMrDb = mrDbClose
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              closeMrDb()
            } catch {
              // best-effort: a failed close on shutdown must not throw.
            }
          }),
        )
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
        ...(BUILD_VERSION !== undefined ? { serverVersion: BUILD_VERSION } : {}),
        // JobTicker health for /readyz.scheduler (additive). Sync read via
        // captured runtime — HTTP handlers are not Effect fibers.
        getSchedulerHealth: () => {
          try {
            return Runtime.runSync(effectRuntime)(jobTicker.health)
          } catch {
            return null
          }
        },
        // Opt-in: LUNA_SCHEDULER_STRICT_READY=1 marks top-level /readyz status
        // degraded when the ticker is stale (default report-only).
        strictSchedulerReady: process.env["LUNA_SCHEDULER_STRICT_READY"] === "1",
        // Advertise the operator-configured + built-in model list so the UI
        // dropdown is driven by the server (LUNA_UI_MODELS overrides go first
        // and become the recommended default). Absent on older/setup-mode
        // servers — clients fall back to their hardcoded list gracefully.
        availableModels: buildAvailableModels(),
        chatService: chat,
        accountBroker: broker,
        survey: surveyHandle, // Phase 3 D3: resolved handle
        feedbackSink, // point-at-the-UI feedback → agent_notes (kind='ui_feedback')
        skillRegistry: skillsWsHandle, // PRD Part B: bodies pre-stripped
        capabilityRegistry: capabilityWsHandle, // Capability layer: backend-advertised commands (static catalog)
        // 14-day auto-archive → broadcast `thread-archived` to live clients.
        threadArchiveNotifier: {
          changes: (notify) => {
            notifyThreadsArchived = notify
          },
        },
        connectorService: connectorsWsHandle, // PRD Part A: instances pre-projected
        artifactStore: artifactsWsHandle, // PRD Part C/W1: pinned artifacts (wire-safe)
        workflowGallery: workflowGalleryHandle, // PRD Part C/W3: read-only jobs gallery
        suggestedActions: suggestedActionsHandle, // Suggested Actions: accept/dismiss routing
        threadForks: threadForksHandle, // #221 conversation forking: propose/accept
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
        // PR 1: model-routing settings (config surface only; cap enforcement PR 2).
        modelRoutingService,
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
  resolveEnvSecret: (
    name: string,
  ) => Promise<Redacted.Redacted<string> | undefined>,
  opLabelsRegistered: ReadonlyArray<string>,
  // Every yield in this generator is infallible (failures surface as
  // console.error side effects, not tracked Effect failures) - E is `never`,
  // not `Error`.
): Effect.Effect<never, never, AccountBroker | ServerHandle | ChannelService> =>
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
    // ServerHandle building transitively means JobTickerLayer's boot
    // reconcile ran - only now may a clean shutdown claim its exemption.
    cleanShutdownMarkerArmed = true
    // Liveness ladder L1: tell systemd we're READY (Type=notify holds the
    // unit in `activating` until this arrives) and start the gated
    // WATCHDOG=1 heartbeat. Inert no-op outside systemd (no NOTIFY_SOCKET).
    // `host` MUST be the real bind host — production listens on the Tailscale
    // IP only, so a loopback probe would fail every beat and watchdog-kill a
    // healthy server. Handle retained module-level for shutdown (STOPPING=1).
    yield* Effect.sync(() => {
      sdWatchdog = startSdWatchdog({
        port: handle.port,
        host: handle.host,
        lunaHome: LUNA_HOME,
      })
    })
    console.log(`✅ ui-ws chat server: ws://${handle.host}:${handle.port}/ui`)
    console.log(`🔑 token: configured`)
    console.log(`🧠 chat enabled (capabilities.chat=true, streamingDeltas=true)`)
    console.log(`💡 connect with Moon or agent-cli — Ctrl-C to exit`)

    // ── Communication channels: register + start adapters ────────────────────
    // Telegram is wired unconditionally; the bot token is the only requirement.
    // TELEGRAM_BOT_TOKEN resolves through the app SecretProvider chain
    // (keychain/vault/env by mode) and is passed as a Redacted value so it never
    // appears in logs/traces. With no token we skip registration (an
    // unstartable bot would just back off forever) and log a one-liner so
    // operators know how to enable it. startAdapters() forks each adapter into
    // the ChannelService's own (long-lived) scope, so it runs for the life of
    // the server; the trailing Effect.scoped only discharges the unused ambient
    // Scope requirement on the API signature.
    const channels = yield* ChannelService
    const tgSecret = yield* Effect.promise(() =>
      resolveEnvSecret("TELEGRAM_BOT_TOKEN"),
    )
    const tgToken =
      tgSecret === undefined ? undefined : Redacted.value(tgSecret).trim()
    // Inbound allowlist. LUNA_TELEGRAM_ALLOWED_SENDER_IDS is a comma-separated
    // list of Telegram ids that may reach Luna. Each id is EITHER a positive
    // user id (authorizes that user's DMs) OR a negative group/supergroup chat
    // id (authorizes every member of that group). Empty/unset → open (the bot
    // accepts anyone). See makeTelegramAdapter's allowedIds for the union gate.
    const tgAllowedIds = (process.env["LUNA_TELEGRAM_ALLOWED_SENDER_IDS"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (tgToken !== undefined && tgToken.length > 0) {
      yield* channels.registerAdapter(
        makeTelegramAdapter({
          id: "telegram-main",
          token: Redacted.make(tgToken),
          allowedIds: tgAllowedIds,
        }),
      )
      yield* channels.startAdapters().pipe(Effect.scoped)
      console.log(`📨 telegram channel: started (telegram-main)`)
      if (tgAllowedIds.length > 0) {
        console.log(
          `🔒 telegram allowlist: active (${tgAllowedIds.length} id(s) — users and/or groups)`,
        )
      } else {
        console.warn(
          `⚠️  telegram allowlist: OPEN — anyone can message the bot. ` +
            `Set LUNA_TELEGRAM_ALLOWED_SENDER_IDS to restrict access.`,
        )
      }
    } else {
      console.log(`📨 telegram channel: idle — set TELEGRAM_BOT_TOKEN to enable`)
    }

    // Park forever so the server scope stays open.
    return yield* Effect.never
  })

// Bootstrap: discover OP tokens (env + keychain) BEFORE building the
// runtime, so the SecretProvider chain is composed with all available
// providers up front. Keychain reads are <100ms and one-shot; we accept
// the synchronous-feeling startup latency.
export const bootstrap = async (): Promise<void> => {
  // W2 boot integrity gate: refuse to boot on a locked-out Luna vault (store
  // present but the key is missing / wrong / tampered) BEFORE any layer graph
  // or op-token discovery runs. A missing/empty store is fine (fresh install).
  // The gate only DENIES boot in `auto` mode - the only mode that reads the
  // vault tier; any other mode logs a loud warning and continues, so an
  // orphaned/corrupt vault never denies boot to an operator who never reads it.
  // Runs first because discovery itself now reads the vault (in auto).
  await assertVaultBootIntegrity(lunaVaultFile, vaultStorageMode, (msg) =>
    writeSync(2, `❌ ${msg}\n`),
  )

  const opTokens = await discoverOpTokens()
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

  // ── W2 tiered-storage status snapshot ────────────────────────────────────
  // Probe 1Password ONCE (bounded, non-blocking; `accountsConfigured` short-
  // circuits to "active" without shelling out when op accounts are wired) and
  // assemble the vault-list `storage` object. `envResidue` is a COUNT of
  // non-reserved `.env` names (never a name/value). The probe is status-only -
  // the write tier was already resolved synchronously at module scope.
  const onePasswordProbe: OnePasswordProbe = await probeOnePassword({
    accountsConfigured: opTokens.length > 0,
  })
  vaultStorageStatus = buildStorageStatus({
    mode: vaultStorageMode,
    writeTier: vaultWriteTier,
    probe: { onePassword: onePasswordProbe, osKeychain: osKeychainAvailable },
    envResidue: computeEnvResidue(),
  })

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
    // Liveness ladder L1: setup-mode is a legitimate long-lived state (the
    // unit's Type=notify + WatchdogSec apply here too), so READY + heartbeat
    // must fire once the setup WS server is listening. runPromise builds the
    // layer graph (which listens) BEFORE running the effect body, so the
    // sync callback below executes exactly at the accepting-connections
    // moment. Without this a fresh credential-less install would sit in
    // `activating` until TimeoutStartSec, fail, and restart-loop.
    setupRuntime
      .runPromise(
        Effect.sync(() => {
          sdWatchdog = startSdWatchdog({
            port: SETUP_WS_PORT,
            ...(BIND_HOST !== undefined ? { host: BIND_HOST } : {}),
            lunaHome: paths.lunaHome,
          })
        }).pipe(Effect.zipRight(Effect.never)),
      )
      .catch((err) => {
        console.error("❌ setup-mode server crashed:", err)
        process.exit(1)
      })
    return
  }

  // ── Normal mode ──────────────────────────────────────────────────────────
  // Apply any persisted ProviderSettings to process.env BEFORE the broker
  // layer is built, so readProviderEnv() / readOverflowConfig() inside
  // AccountBrokerLayer.fromSql pick up the store-resolved values.
  applyProviderSettingsToEnv(paths.lunaDbPath)

  const opAccountLayers = buildRoutedOpAccountLayers(opTokens, Clock.Default)
  const resolveEnvSecret = makeEnvSecretResolver({
    mode: vaultStorageMode,
    platform: process.platform,
    opAccounts: opAccountLayers,
    lunaVaultRead,
  })
  const baseLayer = buildBaseLayer(opAccountLayers)
  const serverLayer = buildServerLayer(baseLayer)
  // baseLayer is merged in directly (not just as buildServerLayer's internal
  // dependency) so its own LunaSqliteBootstrap requirement must be satisfied
  // here too. Effect memoizes LunaSqliteBootstrapLive by reference, so this
  // builds it once and shares it with the copy buildServerLayer already
  // provided.
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(serverLayer, baseLayer).pipe(Layer.provide(LunaSqliteBootstrapLive)),
  )

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
  // Tool ACL v1 (#247): egressAllowlist gates WebFetch/WebSearch and
  // network-classified MCP tools against LUNA_EGRESS_ALLOWED_HOSTS (defaults
  // in @luna/tools). PreToolUse hook covers auto-approved mcp__* tools that
  // skip canUseTool. Subject is main-thread for the live gate; subagent /
  // background-job deny-all is available when a subject is injected later.
  //
  // This is now the FIRST runPromise on the runtime, so it forces the layer
  // graph to build — a boot-time layer failure surfaces HERE, ahead of
  // buildMain's catch. Mirror that diagnostic so a fail-fast boot stays loud
  // instead of becoming a silent unhandled rejection.
  const egressAllowedHosts = parseEgressAllowedHosts(
    process.env["LUNA_EGRESS_ALLOWED_HOSTS"],
  )
  const egressOnDecision = (d: EgressDecision): void => {
    // Structured one-line audit into stdout (captured by journald / events
    // pipeline operators already scrape). Failures must never throw.
    try {
      writeSync(
        1,
        `[luna/tool-acl] ${d.decision} tool=${d.tool} target=${d.target ?? "-"} ` +
          `rule=${d.rule} subject=${d.subject}\n`,
      )
    } catch {
      /* best-effort */
    }
  }
  const egressOpts = {
    allowedHosts: egressAllowedHosts,
    subject: "main-thread" as const,
    onDecision: egressOnDecision,
  }
  writeSync(
    1,
    `[luna/tool-acl] egress allow-list active (${egressAllowedHosts.length === 1 && egressAllowedHosts[0] === "*" ? "ALLOW-ALL (*)" : `${egressAllowedHosts.length} host suffix(es)`}); override via LUNA_EGRESS_ALLOWED_HOSTS\n`,
  )

  await runtime
    .runPromise(
      Effect.gen(function* () {
        const adapter = yield* SDKAdapter
        yield* adapter.setPermissionCallback(
          composeInterceptors([
            // First-wins: egress deny must beat any later allow.
            egressAllowlist(egressOpts),
            ...defaultSafetyInterceptors(),
            mcpToolGate((slug) =>
              clearStaleUnmountableForLiveConnector(
                mcpToolPolicyHolder.get(slug),
                isLiveConnectorMount?.(slug) === true,
              ),
            ),
          ]),
        )
        // PreToolUse covers tools that never hit canUseTool (auto-approved
        // mcp__*, and calls under permission modes that skip the callback).
        // forkDaemon + scoped + never keeps the registration's Scope open for
        // the process lifetime so the hook is not torn down after install.
        yield* Effect.forkDaemon(
          Effect.scoped(
            Effect.gen(function* () {
              yield* adapter.registerHook(
                "PreToolUse",
                undefined,
                makeEgressPreToolUseHook(egressOpts) as never,
              )
              yield* Effect.never
            }),
          ),
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
  runtime.runPromise(buildMain(resolveEnvSecret, opLabelsRegistered)).catch((err) => {
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
