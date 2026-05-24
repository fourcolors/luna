/**
 * ObsToolsLayer + helpers.
 *
 * Wires the five observability tools (obs_note / obs_notes_recent /
 * obs_session_explain / obs_session_anomalies / obs_sessions_search) onto
 * resolved AgentNotesService + AnalyticsService handles and packages them
 * as an SDK MCP server config.
 *
 * Layer topology (bottom-up build order):
 *   Clock
 *     └─ AgentNotesService.makeLayer(lunaDbPath)   (SQLite, luna.db)
 *   DuckDbService (makeDuckDbLayer)
 *     └─ AnalyticsService.makeLayer()              (DuckDB, analytics.duckdb)
 *   ObsToolsService (this Layer)                   (MCP server wrapper)
 *
 * Both database paths default to the standard Luna home locations and can
 * be overridden via environment variables for tests:
 *   LUNA_DB_PATH          → luna.db path (AgentNotes)
 *   LUNA_ANALYTICS_DB_PATH → analytics.duckdb path (AnalyticsService)
 *
 * Current-session binding:
 *   `currentSessionId` is a mutable cell (a plain object with a `value`
 *   field) that the caller can update after thread creation. ObsToolsLayer
 *   closes over the cell so obs_note can tag notes with the live session id
 *   without needing to thread it through every tool call.
 *
 *   Usage in chat-server.ts:
 *     const obsTools = yield* ObsToolsService
 *     // When a new thread is created:
 *     obsTools.bindSession(thread.id)
 *
 * This follows the same pattern as scheduler-tools (layerScope cell) and
 * memory-tools (router handle) — service handles are resolved at Layer
 * construction and closed over in the tool definitions.
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import {
  AgentNotesService,
  AnalyticsService,
  Clock,
  ConfigError,
  DuckDbService,
  LunaSqliteBootstrap,
  makeDuckDbLayer,
} from "@luna/core"
import { makeSdkMcpServer } from "@luna/tools"
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"
import { makeObsTools } from "./tools.js"

// ── Config ─────────────────────────────────────────────────────────────────────

const lunaHome = join(homedir(), ".luna")

export function resolveAnalyticsDbPath(): string {
  const override = process.env["LUNA_ANALYTICS_DB_PATH"]
  return override && override.length > 0
    ? override
    : join(lunaHome, "analytics.duckdb")
}

export function resolveLunaDbPath(): string {
  const override = process.env["LUNA_DB_PATH"]
  return override && override.length > 0
    ? override
    : join(lunaHome, "luna.db")
}

// ── Service config ─────────────────────────────────────────────────────────────

/**
 * ObsToolsConfig — emitted by ObsToolsLayer, carries the SDK MCP server
 * config and a system-prompt addendum string.
 */
export interface ObsToolsConfig {
  readonly serverName: "observability"
  readonly server: McpSdkServerConfigWithInstance
  /** The system-prompt addendum the agent needs to know the tools exist. */
  readonly systemPromptAddendum: string
  /**
   * Bind the current session id so obs_note can tag notes automatically.
   * Call this after a new thread is created.
   */
  readonly bindSession: (sessionId: string) => void
}

export class ObsToolsService extends Effect.Tag("luna/ObsToolsService")<
  ObsToolsService,
  ObsToolsConfig
>() {}

export const OBS_SYSTEM_PROMPT_ADDENDUM =
  "You have five observability tools (MCP server `observability`) for self-observation " +
  "and self-improvement:\n" +
  "- `obs_note(kind, summary, payload?, session_id?)` — write a durable behavioral note " +
  "  (goal, progress, decision, reflection, obstacle). Call this when Operator states intent, " +
  "  at key milestones, when choosing between approaches, and at session end.\n" +
  "- `obs_notes_recent(session_id?, kind?, limit?)` — recall recent notes. Use FIRST when " +
  "  resuming work after a context reset ('what was I doing?').\n" +
  "- `obs_session_explain(session_id)` — detailed breakdown of one session: tools used, " +
  "  error/success counts, duration. Use for targeted self-improvement.\n" +
  "- `obs_session_anomalies(error_rate?, duration_ms?)` — find sessions with high error rates " +
  "  or long duration. Entry point for daily feedback loops.\n" +
  "- `obs_sessions_search(session_id?, tool_name?, start_time?, end_time?, limit?)` — " +
  "  search session history; returns session-level summaries (tool call counts, error/success " +
  "  counts, duration). Use for general-purpose session search and pattern detection."

// ── MCP server builder ─────────────────────────────────────────────────────────

export const buildObsMcpServer = (
  tools: ReturnType<typeof makeObsTools>,
): McpSdkServerConfigWithInstance => {
  const widened = tools as unknown as ReadonlyArray<
    SdkMcpToolDefinition<AnyZodRawShape>
  >
  return makeSdkMcpServer("observability", "0.1.0", widened)
}

// ── Layer factory ──────────────────────────────────────────────────────────────

export interface ObsToolsLayerOptions {
  /** Override the AgentNotes SQLite db path. Default: resolves from env/home. */
  readonly lunaDbPath?: string
  /** Override the analytics DuckDB path. Default: resolves from env/home. */
  readonly analyticsDbPath?: string
  /**
   * Write-queue capacity for DuckDbService. Default: 512.
   * In tests, use a smaller value (e.g. 64) to keep memory low.
   */
  readonly duckDbQueueCapacity?: number
}

/**
 * ObsToolsLayer — top-level Layer factory.
 *
 * Provides `ObsToolsService` carrying:
 *   - The SDK MCP server config (5 tools)
 *   - The system-prompt addendum
 *   - `bindSession(id)` for attaching the current thread id
 *
 * Requires in context:
 *   - `Clock` (for AgentNotesService timestamps)
 *   - `LunaSqliteBootstrap` (for the bun:sqlite extension path — same
 *     requirement as all other SQLite-backed services in Luna)
 *
 * DuckDbService and AnalyticsService are wired internally.
 */
export const ObsToolsLayer = (
  opts?: ObsToolsLayerOptions,
): Layer.Layer<
  ObsToolsService,
  ConfigError,
  Clock | LunaSqliteBootstrap
> => {
  const lunaDbPath = opts?.lunaDbPath ?? resolveLunaDbPath()
  const analyticsDbPath = opts?.analyticsDbPath ?? resolveAnalyticsDbPath()
  const duckDbQueueCapacity = opts?.duckDbQueueCapacity ?? 512

  // Internal DuckDbService scoped to this layer.
  const duckDbL = makeDuckDbLayer({
    dbPath: analyticsDbPath,
    writeQueueCapacity: duckDbQueueCapacity,
  })

  // AnalyticsService requires DuckDbService.
  const analyticsL = AnalyticsService.makeLayer({ dbPath: analyticsDbPath }).pipe(
    Layer.provide(duckDbL),
  )

  // AgentNotesService requires Clock + LunaSqliteBootstrap.
  const agentNotesL = AgentNotesService.makeLayer(lunaDbPath)

  return Layer.scoped(
    ObsToolsService,
    Effect.gen(function* () {
      const notes = yield* AgentNotesService
      const analytics = yield* AnalyticsService

      // Mutable session-id cell. Closed over by all tool handlers.
      const sessionCell: { value: string | null } = { value: null }
      const currentSessionId = () => sessionCell.value
      const bindSession = (id: string) => {
        sessionCell.value = id
      }

      const tools = makeObsTools(notes, analytics, currentSessionId)
      const server = buildObsMcpServer(tools)

      return {
        serverName: "observability" as const,
        server,
        systemPromptAddendum: OBS_SYSTEM_PROMPT_ADDENDUM,
        bindSession,
      }
    }),
  ).pipe(
    Layer.provide(analyticsL),
    Layer.provide(agentNotesL),
  )
}
