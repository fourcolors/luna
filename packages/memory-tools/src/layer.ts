/**
 * MemoryToolsLayer + helpers.
 *
 * Wires the three memory tools (save/search/delete) onto a resolved
 * MemoryRouter and packages them as an SDK MCP server config that can
 * be plugged into `SessionOptions.sdkOptions.mcpServers`.
 *
 * Embedder selection:
 *   - default → StubEmbedderLayer (deterministic, no I/O — safe for tests
 *     and for offline dev rigs where Ollama isn't running).
 *   - `LUNA_EMBEDDER=ollama` → makeOllamaEmbedderLayer() (probes the
 *     daemon at construction with bounded retry; fails with EmbedderError
 *     if it still can't reach 127.0.0.1:11434 once retries are exhausted
 *     and the dimension isn't already known - see `selectEmbedderLayer`
 *     for the degrade-on-probe-failure opt-in and its env knobs).
 *   - any other value → silently falls back to Stub. We don't fail open
 *     because a typo shouldn't break the dev rig.
 *
 * DB path:
 *   - default → `~/.luna/memory.db` (mkdirp'd on the way in)
 *   - override → `LUNA_MEMORY_DB`
 *   - `:memory:` is honored verbatim (used by tests).
 */
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Context, Effect, Layer, Option } from "effect"
import {
  Clock,
  EmbedderService,
  LunaSqliteBootstrap,
  MemoryReranker,
  ObservabilityService,
  StubEmbedderLayer,
  makeOllamaEmbedderLayer,
  type EmbedderError,
  type MemoryBackendError,
  type MemoryRerankerApi,
  type ObservabilityApi,
} from "@luna/core"
import {
  MemoryLayer,
  MemoryRouterTag,
  SqliteVectorBackend,
  type MemoryRouter,
  type MemoryVectorBackend,
} from "@luna/memory"
import { defineToolPackage } from "@luna/tools"
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"
import { makeMemoryTools, type MakeMemoryToolsOptions } from "./tools.js"

/**
 * Resolve the on-disk path for the sqlite-vector store. `:memory:` skips
 * the mkdirp; any other path has its parent directory created (recursive,
 * mode 0o700 — this is local user data).
 */
export function resolveDbPath(): string {
  const override = process.env["LUNA_MEMORY_DB"]
  const path =
    override && override.length > 0
      ? override
      : join(homedir(), ".luna", "memory.db")
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  }
  return path
}

function parsePositiveIntegerEnv(name: string): number | undefined {
  const value = process.env[name]
  if (value === undefined || value.trim() === "") return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Pick the embedder Layer based on `LUNA_EMBEDDER`. See module header for
 * the selection rules. Returns a Layer that produces `EmbedderService`;
 * the failure channel is `EmbedderError` for ollama (probe-on-init) and
 * `never` for stub.
 *
 * For ollama, always passes `degradeOnProbeFailure: true` so the chat-server
 * deploy path boots non-fatally once probe retries are exhausted, provided
 * the dimension is already known via `LUNA_OLLAMA_EMBED_DIMENSION`. Probe
 * retry is tunable via `LUNA_OLLAMA_PROBE_ATTEMPTS` (clamped to 5) and
 * `LUNA_OLLAMA_PROBE_BACKOFF_MS`.
 */
export function selectEmbedderLayer(): Layer.Layer<
  EmbedderService,
  EmbedderError
> {
  const choice = process.env["LUNA_EMBEDDER"]?.toLowerCase()
  if (choice === "ollama") {
    const dimension = parsePositiveIntegerEnv("LUNA_OLLAMA_EMBED_DIMENSION")
    const probeTimeoutMs = parsePositiveIntegerEnv(
      "LUNA_OLLAMA_PROBE_TIMEOUT_MS",
    )
    // Clamped at 5: a high value could hide a persistently-flaky link and
    // eat the ~60s boot readiness budget the deploy gate relies on.
    const probeAttemptsRaw = parsePositiveIntegerEnv("LUNA_OLLAMA_PROBE_ATTEMPTS")
    const maxProbeAttempts =
      probeAttemptsRaw !== undefined ? Math.min(probeAttemptsRaw, 5) : undefined
    const probeBackoffMs = parsePositiveIntegerEnv("LUNA_OLLAMA_PROBE_BACKOFF_MS")
    return makeOllamaEmbedderLayer({
      ...(process.env["LUNA_OLLAMA_EMBED_MODEL"] !== undefined
        ? { model: process.env["LUNA_OLLAMA_EMBED_MODEL"] }
        : {}),
      ...(process.env["LUNA_OLLAMA_BASE_URL"] !== undefined
        ? { baseUrl: process.env["LUNA_OLLAMA_BASE_URL"] }
        : process.env["OLLAMA_HOST"] !== undefined
          ? { baseUrl: process.env["OLLAMA_HOST"] }
          : {}),
      ...(dimension !== undefined ? { dimension } : {}),
      ...(probeTimeoutMs !== undefined ? { probeTimeoutMs } : {}),
      ...(maxProbeAttempts !== undefined ? { maxProbeAttempts } : {}),
      ...(probeBackoffMs !== undefined ? { probeBackoffMs } : {}),
      degradeOnProbeFailure: true,
    })
  }
  return StubEmbedderLayer
}

/**
 * Build the MCP server config exposing the three memory tools, given a
 * resolved MemoryRouter handle. Pure data — safe to splat into
 * `sdkOptions.mcpServers["memory"]`.
 */
export const buildMemoryMcpServer = (
  router: Parameters<typeof makeMemoryTools>[0],
  toolOptions?: MakeMemoryToolsOptions,
): McpSdkServerConfigWithInstance => {
  // The tuple has heterogeneous shapes; widen to the SDK's catch-all
  // shape for the registry. Safe because defineToolPackage treats the
  // schema field opaquely until the MCP server is actually serving.
  const tools = makeMemoryTools(
    router,
    undefined,
    toolOptions,
  ) as unknown as ReadonlyArray<SdkMcpToolDefinition<AnyZodRawShape>>
  return defineToolPackage({ name: "memory", tools }).server
}

/**
 * makeMemoryRouterLayer - generic MemoryRouter composition: resolves
 * `backendTag` out of an already-built `backendLayer` and routes everything
 * ("*") to it. This is the seam a different memory backend swaps in through
 * (a different Tag + Layer pair) without touching the router or any caller
 * above it. `MemoryRouterLayer` below is the sqlite convenience wrapper most
 * callers want.
 *
 * `BackendApi` must satisfy `MemoryVectorBackend` (put/get/query/delete/
 * exportAll/importAll plus `search`). This composition always builds a
 * single-rule `"*"` router, so a search-less backend would make every
 * `memory_search` call fail with "no vector backend for namespace X" - the
 * constraint below turns that dead config into a compile error instead of a
 * runtime surprise.
 */
export const makeMemoryRouterLayer = <
  BackendId,
  BackendApi extends MemoryVectorBackend,
  E,
  R,
>(
  backendLayer: Layer.Layer<BackendId, E, R>,
  backendTag: Context.Tag<BackendId, BackendApi>,
) =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const backend = yield* backendTag
      return MemoryLayer({ rules: [{ pattern: "*", backend }] })
    }),
  ).pipe(Layer.provideMerge(backendLayer))

/**
 * MemoryRouterLayer — provides MemoryRouter with a single rule routing
 * everything ("*") to a SqliteVectorBackend opened at `dbPath`.
 *
 * Composes: `EmbedderService` → `SqliteVectorBackend.fromPath(dbPath)`
 *   → `MemoryLayer({ rules: [{ pattern: "*", backend }] })`.
 */
export const MemoryRouterLayer = (dbPath: string) =>
  makeMemoryRouterLayer(SqliteVectorBackend.fromPath(dbPath), SqliteVectorBackend)

/**
 * MemoryToolsConfig — emitted by MemoryToolsLayer, carries the SDK MCP
 * server config the chat dev rig (or any caller) splats into
 * `sdkOptions.mcpServers`.
 */
export interface MemoryToolsSessionConfig {
  readonly serverName: "memory"
  readonly server: McpSdkServerConfigWithInstance
  /** The system-prompt addendum the agent needs to know the tools exist. */
  readonly systemPromptAddendum: string
}

export interface MemoryToolsConfig extends MemoryToolsSessionConfig {
  readonly createSessionBinding: () => MemoryToolsSessionConfig
}

export class MemoryToolsService extends Effect.Tag(
  "luna/MemoryToolsService",
)<MemoryToolsService, MemoryToolsConfig>() {}

export const MEMORY_SYSTEM_PROMPT_ADDENDUM =
  "You have three memory tools on MCP server `memory`. Use their fully " +
  "qualified MCP tool names exactly: " +
  "`mcp__memory__memory_save(text, kind?, tags?, namespace?)` to remember a durable fact, " +
  "`mcp__memory__memory_search(query, kind?, limit?, namespace?)` to recall prior context " +
  "before answering, and `mcp__memory__memory_delete(id)` only when the user asks to " +
  "forget. Do not call bare tool names such as `memory_search`; use the `mcp__memory__...` " +
  "names. Search before answering questions about the user. Save preferences, decisions, " +
  "and facts the user states about themselves. The `kind` field is a memory-type tag — " +
  "conventional values are \"semantic\" (durable facts, the default), \"episodic\" " +
  "(time-stamped events), \"procedural\" (how-to / skills), and \"prospective\" " +
  "(future intentions). Search hits include `kind`, `namespace`, `createdAt`, and " +
  "`updatedAt` (epoch ms) so you can reason about recency."

export interface MemoryToolsLayerOptions {
  /** Override the sqlite-vector db path. Default: `resolveDbPath()`. */
  readonly dbPath?: string
  /** Override the embedder Layer. Default: `selectEmbedderLayer()`. */
  readonly embedder?: Layer.Layer<EmbedderService, EmbedderError>
  /**
   * Optional MemoryReranker layer (e.g. adapter-sdk's MemoryRerankerDefault).
   * When provided, memory_search CAN rerank - actually doing so is still
   * gated per-request by LUNA_MEMORY_RERANK=1 (see tools.ts). DEFAULT
   * undefined: today's un-reranked behavior with zero wiring changes
   * required. Kept SDK-free here (memory-tools does not depend on
   * adapter-sdk) - the caller builds the SDK-backed layer and passes it in.
   */
  readonly rerankerLayer?: Layer.Layer<MemoryReranker, never, never>
  /**
   * Override the MemoryRouter Layer entirely. When provided, `MemoryToolsLayer`
   * uses it INSTEAD of `MemoryRouterLayer(dbPath)` - this is the seam a
   * caller swaps a different memory backend through (e.g.
   * `makeMemoryRouterLayer(otherBackendLayer, otherBackendTag)`) without
   * editing this file; `dbPath` is ignored when set. DEFAULT undefined:
   * `MemoryRouterLayer(dbPath)`, today's sqlite-vector-only behavior,
   * unchanged.
   */
  readonly routerLayer?: Layer.Layer<
    MemoryRouter,
    MemoryBackendError,
    EmbedderService | LunaSqliteBootstrap | ObservabilityService | Clock
  >
}

/**
 * MemoryToolsLayer — top-level Layer factory the dev rig wires in.
 * Provides `MemoryToolsService` carrying the SDK MCP server config and a
 * system-prompt addendum string. Internally composes Embedder →
 * SqliteVectorBackend → MemoryRouter → MCP server.
 *
 * Defaults are env-driven (LUNA_MEMORY_DB / LUNA_EMBEDDER); overrides are
 * provided primarily for tests.
 */
export const MemoryToolsLayer = (
  opts?: MemoryToolsLayerOptions,
): Layer.Layer<
  MemoryToolsService,
  MemoryBackendError | EmbedderError,
  LunaSqliteBootstrap | ObservabilityService | Clock
> => {
  const embedderL = opts?.embedder ?? selectEmbedderLayer()
  const createConfig = (
    router: Parameters<typeof buildMemoryMcpServer>[0],
    reranker: MemoryRerankerApi | undefined,
    observability: ObservabilityApi,
  ): MemoryToolsSessionConfig => ({
    serverName: "memory" as const,
    server: buildMemoryMcpServer(router, {
      ...(reranker !== undefined ? { reranker } : {}),
      observability,
    }),
    systemPromptAddendum: MEMORY_SYSTEM_PROMPT_ADDENDUM,
  })
  const base = Layer.scoped(
    MemoryToolsService,
    Effect.gen(function* () {
      const router = yield* MemoryRouterTag
      const observability = yield* ObservabilityService
      // Effect.serviceOption -> R=never (does NOT add MemoryReranker to this
      // layer's declared requirements above). Resolves only when
      // opts.rerankerLayer was composed directly below via Layer.provide, so
      // callers who never pass a rerankerLayer see byte-identical behavior:
      // reranker stays undefined and tools.ts never calls it.
      const rerankerOpt = yield* Effect.serviceOption(MemoryReranker)
      const reranker = Option.getOrUndefined(rerankerOpt)
      const config = createConfig(router, reranker, observability)
      return {
        ...config,
        createSessionBinding: () => createConfig(router, reranker, observability),
      }
    }),
  ).pipe(
    // `resolveDbPath()` mkdirp's the on-disk db dir as a side effect - only
    // called when actually needed, so passing `routerLayer` never touches
    // the filesystem for a path that would end up unused.
    Layer.provide(
      opts?.routerLayer ?? MemoryRouterLayer(opts?.dbPath ?? resolveDbPath()),
    ),
    Layer.provide(embedderL),
  )
  return opts?.rerankerLayer !== undefined
    ? base.pipe(Layer.provide(opts.rerankerLayer))
    : base
}
