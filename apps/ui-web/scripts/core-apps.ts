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

/* ── store-backed (generated / user-authored) MCP apps ─────────────────────
 * The Apps pillar v1 ("Generate + user-author"): a Luna-authored or user-saved
 * MCP app is a `kind:'mcp-app'` ArtifactStore row whose `content` is the app's
 * inline HTML. Its identity uri is DERIVED from the artifact id —
 * `ui://luna/app/<encodeURIComponent(id)>` — so the host can stamp tools/call
 * and the server can route + gate them. These apps cannot ship server-side JS,
 * so their tools are a fixed CURATED, read-only allowlist shared by all of them
 * (buildCuratedAppTools), NOT per-app handlers. */

/** The uri prefix for a store-backed app. The artifact id is percent-encoded
 *  into the uri (mirrors widget.html's derivation). */
export const STORE_APP_URI_PREFIX = "ui://luna/app/"

/** Recover the artifact id from a store-backed app uri, or null when the uri is
 *  not one (so a composed registry routes it to another provider). */
export const artifactIdFromAppUri = (uri: string): string | null => {
  if (typeof uri !== "string" || !uri.startsWith(STORE_APP_URI_PREFIX)) return null
  const enc = uri.slice(STORE_APP_URI_PREFIX.length)
  if (enc.length === 0) return null
  try {
    const id = decodeURIComponent(enc)
    return id.length > 0 ? id : null
  } catch {
    return null
  }
}

/** A metadata-only artifact row exposed by the `list-artifacts` curated tool. */
export interface CuratedArtifactRow {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly version: number
  readonly updatedAt: number
}

/**
 * A store-backed MCP-app registry. `readResource` resolves a store app uri to
 * its inline HTML (for the rare pointer-mode render — generated apps usually
 * render inline and never read the resource); `callTool` routes EVERY
 * store-app tool call to a fixed CURATED allowlist. Generated/user apps share
 * one allowlist because they carry no server JS — so the spec's same-server
 * rule degenerates to "is this a curated tool?" for this provider. Unknown
 * uris/apps/tools fail closed so a composed registry can try the next provider.
 */
export const createStoreBackedAppRegistry = (deps: {
  readonly getAppHtml: (artifactId: string) => Promise<string | null>
  readonly curatedTools: Readonly<
    Record<string, (args: unknown) => Promise<unknown> | unknown>
  >
}): McpAppHostDeps => ({
  async readResource(uri) {
    const id = artifactIdFromAppUri(uri)
    if (id === null) return { ok: false, message: `unknown app resource: ${uri}` }
    const html = await deps.getAppHtml(id)
    if (html === null) return { ok: false, message: `unknown app: ${uri}` }
    return { ok: true, mimeType: MCP_APP_MIME_TYPE, text: html }
  },
  async callTool(appUri, tool, args) {
    const id = artifactIdFromAppUri(appUri)
    if (id === null) return { ok: false, message: `unknown app: ${appUri}` }
    // Object.hasOwn (not a bare index) so prototype names can't resolve into a
    // tool — same guard as createCoreAppRegistry. The id is recovered above
    // only to confirm this is a store app; the curated set is shared, not
    // per-app, so a generated app can call any curated tool but nothing else.
    if (!Object.hasOwn(deps.curatedTools, tool)) {
      return { ok: false, message: `tool "${tool}" is not available to apps` }
    }
    try {
      const value = await deps.curatedTools[tool]!(args)
      return {
        ok: true,
        result: {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
        },
      }
    } catch {
      return { ok: false, message: `tool "${tool}" failed` }
    }
  },
})

/**
 * Compose several McpAppHostDeps behind one host: readResource + callTool try
 * each provider in order and return the FIRST ok result, else the last failure.
 * Safe because provider uri namespaces are disjoint (core apps =
 * `ui://luna/<name>`, store apps = `ui://luna/app/<id>`): a cross-namespace
 * appUri never resolves in the wrong provider, so a store app can never reach a
 * core app's per-app tools (and vice-versa).
 */
export const composeAppRegistries = (
  ...registries: ReadonlyArray<McpAppHostDeps>
): McpAppHostDeps => ({
  async readResource(uri) {
    let last: Awaited<ReturnType<McpAppHostDeps["readResource"]>> = {
      ok: false,
      message: `unknown app resource: ${uri}`,
    }
    for (const r of registries) {
      const res = await r.readResource(uri)
      if (res.ok) return res
      last = res
    }
    return last
  },
  async callTool(appUri, tool, args) {
    let last: Awaited<ReturnType<McpAppHostDeps["callTool"]>> = {
      ok: false,
      message: `unknown app: ${appUri}`,
    }
    for (const r of registries) {
      const res = await r.callTool(appUri, tool, args)
      if (res.ok) return res
      last = res
    }
    return last
  },
})

/**
 * The curated, READ-ONLY tool allowlist exposed to store-backed apps. Kept
 * deliberately tiny for v1: workspace `pulse` counters and a metadata-only
 * `list-artifacts`. No tool here writes state or returns secrets. Note the
 * exact read surface: `list-artifacts` is a GLOBAL enumeration of artifact
 * metadata (id/title/kind/version/updatedAt — never content, never origin),
 * which the caller should scope (e.g. to app/widget kinds) before any
 * multi-tenant deployment. Safe in single-tenant Luna (the operator owns every
 * artifact, and the sandboxed app has a strict no-network CSP — display-only).
 */
export const buildCuratedAppTools = (deps: {
  readonly getPulse: () => Promise<PulseCounters>
  readonly listArtifacts: () => Promise<ReadonlyArray<CuratedArtifactRow>>
}): Readonly<Record<string, (args: unknown) => Promise<unknown> | unknown>> => ({
  pulse: () => deps.getPulse(),
  "list-artifacts": () => deps.listArtifacts(),
})
