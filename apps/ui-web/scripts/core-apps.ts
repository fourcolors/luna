/**
 * core-apps.ts — Luna's in-process CORE APP REGISTRY (widget-system.md
 * Phase 7, "Widgets are MCP Apps" v1).
 *
 * The Luna server is the FIRST MCP-app provider: it serves `ui://luna/*`
 * resources (self-contained app HTML, `text/html;profile=mcp-app`) and an
 * allowlisted set of app tools, relayed to widget windows over the UI-WS
 * `mcp-resource-read` / `mcp-tool-call` frames (see @luna/ui-ws
 * createMcpAppHost). External MCP servers (a standing client relay) are a
 * documented follow-up that plugs in behind the same McpAppHostDeps seam.
 *
 * Security shape:
 *   - readResource validates the uri against the registry — unknown → ok:false
 *     (the relay can never become an arbitrary file/URL fetcher).
 *   - callTool enforces the SPEC'S SAME-SERVER RULE server-side: an app may
 *     only call tools registered ON ITS OWN app entry. A (appUri, tool) pair
 *     that crosses apps → ok:false, even if the tool name exists elsewhere.
 *   - Handler defects collapse to ok:false with a generic message — handler
 *     internals never reach the wire.
 *
 * Core app #1: ui://luna/workspace-pulse — the Phase 0.5 pulse probe
 * re-authored as a real MCP app. Its `pulse-snapshot` tool aggregates the
 * TelemetryService counters that EventCounter already mirrors from the obs
 * stream (luna.obs.tool_calls.total / errors.total / cost.usd_micros /
 * sessions.started|ended) — the cheapest REAL counter source in the server
 * (in-process for tests, SQLite-backed in chat-server, no new obs tap).
 */
import { readFileSync } from "node:fs"
import * as path from "node:path"
import type { McpAppHostDeps } from "@luna/ui-ws"
import type { CounterSnapshot } from "@luna/core"

/** The mimeType every MCP-app template is served under (SEP-1865). */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app"

/** One registered core app: a ui:// template + its app-visible tools. */
export interface CoreApp {
  /** The app's resource URI, e.g. "ui://luna/workspace-pulse". */
  readonly uri: string
  /** Self-contained app HTML (inline script speaking MCP Apps JSON-RPC). */
  readonly html: string
  /**
   * App tools, keyed by tool name. Handlers return a plain JSON value; the
   * registry wraps it spec-shaped ({ content, structuredContent }) so the
   * wire result is a standard CallToolResult.
   */
  readonly tools: Readonly<
    Record<string, (args: unknown) => Promise<unknown> | unknown>
  >
}

/** What the pulse-snapshot tool reports — mirrors the probe's four tiles. */
export interface PulseCounters {
  readonly toolsCalled: number
  readonly errors: number
  readonly estimatedUsd: number
  readonly activeSessions: number
}

/**
 * Aggregate a TelemetryService snapshot into the four pulse tiles. Pure —
 * exported for tests and for chat-server to compose with telemetry.snapshot.
 *
 * Counter names come from EventCounter (packages/core/src/telemetry/
 * event-counter.ts): tool_calls/errors are tagged (per tool / per errorTag),
 * so SUM across tag partitions; cost.usd_micros and the session counters are
 * untagged running totals. activeSessions = started − ended, clamped ≥ 0
 * (restart skew can leave more ended than started in the sqlite-backed store).
 */
export const pulseFromSnapshot = (
  snapshot: ReadonlyArray<CounterSnapshot>,
): PulseCounters => {
  let tools = 0
  let errors = 0
  let usdMicros = 0
  let started = 0
  let ended = 0
  for (const c of snapshot) {
    switch (c.name) {
      case "luna.obs.tool_calls.total":
        tools += c.value
        break
      case "luna.obs.errors.total":
        errors += c.value
        break
      case "luna.obs.cost.usd_micros":
        usdMicros += c.value
        break
      case "luna.obs.sessions.started":
        started += c.value
        break
      case "luna.obs.sessions.ended":
        ended += c.value
        break
    }
  }
  return {
    toolsCalled: tools,
    errors,
    estimatedUsd: usdMicros / 1_000_000,
    activeSessions: Math.max(0, started - ended),
  }
}

/** Read a core-app HTML template shipped next to this module. */
const readAppHtml = (file: string): string =>
  readFileSync(path.join(import.meta.dirname, "core-apps", file), "utf8")

/**
 * Build the workspace-pulse core app around an injected counters getter
 * (chat-server passes telemetry.snapshot → pulseFromSnapshot; tests pass a
 * stub). The HTML template lives in core-apps/workspace-pulse.html.
 */
export const buildWorkspacePulseApp = (
  getCounters: () => Promise<PulseCounters>,
): CoreApp => ({
  uri: "ui://luna/workspace-pulse",
  html: readAppHtml("workspace-pulse.html"),
  tools: {
    "pulse-snapshot": () => getCounters(),
  },
})

/**
 * Assemble the registry into the McpAppHostDeps seam (@luna/ui-ws
 * createMcpAppHost consumes this). Never rejects — every failure is ok:false.
 */
export const createCoreAppRegistry = (
  apps: ReadonlyArray<CoreApp>,
): McpAppHostDeps => {
  const byUri = new Map<string, CoreApp>()
  for (const app of apps) byUri.set(app.uri, app)

  return {
    async readResource(uri) {
      const app = byUri.get(uri)
      if (app === undefined) {
        return { ok: false, message: `unknown app resource: ${uri}` }
      }
      return { ok: true, mimeType: MCP_APP_MIME_TYPE, text: app.html }
    },

    async callTool(appUri, tool, args) {
      const app = byUri.get(appUri)
      if (app === undefined) {
        return { ok: false, message: `unknown app: ${appUri}` }
      }
      // The spec's same-server rule, enforced server-side: only tools
      // registered on THIS app are callable from it — Object.hasOwn (not a
      // bare index) so prototype names (toString, …) can't resolve.
      if (!Object.hasOwn(app.tools, tool)) {
        return { ok: false, message: `tool "${tool}" is not provided by ${appUri}` }
      }
      try {
        const value = await app.tools[tool]!(args)
        // Spec-shaped CallToolResult: text content + structuredContent.
        return {
          ok: true,
          result: {
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
          },
        }
      } catch {
        // Handler defect — generic line only; internals never reach the wire.
        return { ok: false, message: `tool "${tool}" failed` }
      }
    },
  }
}
