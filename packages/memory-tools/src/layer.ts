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
 *     daemon at construction; fails fast with EmbedderError if it can't
 *     reach 127.0.0.1:11434).
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
import { Effect, Layer } from "effect"
import {
  EmbedderService,
  LunaSqliteBootstrap,
  StubEmbedderLayer,
  makeOllamaEmbedderLayer,
  type EmbedderError,
  type MemoryBackendError,
} from "@luna/core"
import {
  MemoryLayer,
  MemoryRouterTag,
  SqliteVectorBackend,
} from "@luna/memory"
import { makeSdkMcpServer } from "@luna/tools"
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"
import { makeMemoryTools } from "./tools.js"

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

/**
 * Pick the embedder Layer based on `LUNA_EMBEDDER`. See module header for
 * the selection rules. Returns a Layer that produces `EmbedderService`;
 * the failure channel is `EmbedderError` for ollama (probe-on-init) and
 * `never` for stub.
 */
export function selectEmbedderLayer(): Layer.Layer<
  EmbedderService,
  EmbedderError
> {
  const choice = process.env["LUNA_EMBEDDER"]?.toLowerCase()
  if (choice === "ollama") {
    return makeOllamaEmbedderLayer()
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
): McpSdkServerConfigWithInstance => {
  // The tuple has heterogeneous shapes; widen to the SDK's catch-all
  // shape for the registry. Safe because makeSdkMcpServer treats the
  // schema field opaquely until the MCP server is actually serving.
  const tools = makeMemoryTools(router) as unknown as ReadonlyArray<
    SdkMcpToolDefinition<AnyZodRawShape>
  >
  return makeSdkMcpServer("memory", "0.1.0", tools)
}

/**
 * MemoryRouterLayer — provides MemoryRouter with a single rule routing
 * everything ("*") to a SqliteVectorBackend opened at `dbPath`.
 *
 * Composes: `EmbedderService` → `SqliteVectorBackend.fromPath(dbPath)`
 *   → `MemoryLayer({ rules: [{ pattern: "*", backend }] })`.
 */
export const MemoryRouterLayer = (dbPath: string) =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const backend = yield* SqliteVectorBackend
      return MemoryLayer({ rules: [{ pattern: "*", backend }] })
    }),
  ).pipe(Layer.provideMerge(SqliteVectorBackend.fromPath(dbPath)))

/**
 * MemoryToolsConfig — emitted by MemoryToolsLayer, carries the SDK MCP
 * server config the chat dev rig (or any caller) splats into
 * `sdkOptions.mcpServers`.
 */
export interface MemoryToolsConfig {
  readonly serverName: "memory"
  readonly server: McpSdkServerConfigWithInstance
  /** The system-prompt addendum the agent needs to know the tools exist. */
  readonly systemPromptAddendum: string
}

export class MemoryToolsService extends Effect.Tag(
  "luna/MemoryToolsService",
)<MemoryToolsService, MemoryToolsConfig>() {}

export const MEMORY_SYSTEM_PROMPT_ADDENDUM =
  "You have three memory tools (MCP server `memory`): " +
  "`memory_save(text, tags?, namespace?)` to remember a durable fact, " +
  "`memory_search(query, limit?, namespace?)` to recall prior context " +
  "before answering, and `memory_delete(id)` only when the user asks to " +
  "forget. Search before answering questions about the user. Save " +
  "preferences, decisions, and facts the user states about themselves."

export interface MemoryToolsLayerOptions {
  /** Override the sqlite-vector db path. Default: `resolveDbPath()`. */
  readonly dbPath?: string
  /** Override the embedder Layer. Default: `selectEmbedderLayer()`. */
  readonly embedder?: Layer.Layer<EmbedderService, EmbedderError>
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
  LunaSqliteBootstrap
> => {
  const dbPath = opts?.dbPath ?? resolveDbPath()
  const embedderL = opts?.embedder ?? selectEmbedderLayer()
  return Layer.scoped(
    MemoryToolsService,
    Effect.gen(function* () {
      const router = yield* MemoryRouterTag
      const server = buildMemoryMcpServer(router)
      return {
        serverName: "memory" as const,
        server,
        systemPromptAddendum: MEMORY_SYSTEM_PROMPT_ADDENDUM,
      }
    }),
  ).pipe(Layer.provide(MemoryRouterLayer(dbPath)), Layer.provide(embedderL))
}
