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
import type { MemoryRecord } from "@luna/memory"

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

/* ── memory-list / memory-search: read-only memory-browser curated tools ───
 * Backs the Moon "memory browser" MCP app (Chairman-facing, ships alongside
 * this module). Two surfaces on top of the SAME MemoryRouter the memory_*
 * SDK tools already use (@luna/memory-tools tools.ts):
 *   - `memory-list`   → MemoryRouter.query() exact-filter listing, paginated
 *                        via limit/offset (MemoryQuery has no native offset,
 *                        so chat-server over-fetches offset+limit+1 rows and
 *                        slices — see the memoryList dep it injects below).
 *   - `memory-search` → MemoryRouter.search() hybrid BM25+vector top-K.
 * Both are READ-ONLY: no save/delete tool is exposed to the app surface.
 * Args arrive as `unknown` over the wire (an app is agent/user HTML, never
 * trusted) — validateMemoryListArgs/validateMemorySearchArgs are the ONE
 * validation choke point, pure + exported so they're unit-testable without a
 * router. */

const MEMORY_LIST_DEFAULT_LIMIT = 25
const MEMORY_LIST_MAX_LIMIT = 100
const MEMORY_LIST_MAX_OFFSET = 2000
const MEMORY_SEARCH_DEFAULT_TOP_K = 10
const MEMORY_SEARCH_MAX_TOP_K = 50
const MEMORY_SEARCH_QUERY_MAX_LEN = 500

/** The wire shape of one memory record surfaced to a curated app tool —
 *  mirrors the memory_search SDK tool's projection (id/tags/kind/namespace/
 *  createdAt/updatedAt/scope) plus the raw `content` (a detail view can
 *  render non-text records, e.g. beliefs, without a second round trip). */
export interface CuratedMemoryRow {
  readonly id: string
  readonly namespace: string
  readonly kind: string
  readonly text: string
  readonly content: unknown
  readonly tags: ReadonlyArray<string>
  readonly createdAt: number
  readonly updatedAt: number
  readonly scope?: {
    readonly observerId: string
    readonly subjectId: string
    readonly visibility: string
  }
}

export interface CuratedMemorySearchRow extends CuratedMemoryRow {
  readonly score: number
}

export interface MemoryListPage {
  readonly rows: ReadonlyArray<CuratedMemoryRow>
  readonly limit: number
  readonly offset: number
  readonly hasMore: boolean
}

export interface MemorySearchPage {
  readonly rows: ReadonlyArray<CuratedMemorySearchRow>
  readonly query: string
  readonly topK: number
}

export interface ValidatedMemoryListArgs {
  readonly namespace?: string
  readonly kind?: string
  readonly tag?: string
  readonly since?: number
  readonly limit: number
  readonly offset: number
}

export interface ValidatedMemorySearchArgs {
  readonly query: string
  readonly namespace?: string
  readonly kind?: string
  readonly topK: number
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const asOptionalString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v : undefined

const asOptionalFiniteNumber = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined

const asClampedInt = (
  v: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback
  return Math.min(max, Math.max(min, n))
}

/** Validate/clamp raw `memory-list` args off the wire. Never throws — every
 *  field falls back to a safe default so a malformed call degrades to "list
 *  the first page" rather than failing closed. */
export const validateMemoryListArgs = (args: unknown): ValidatedMemoryListArgs => {
  const a = isPlainObject(args) ? args : {}
  return {
    namespace: asOptionalString(a["namespace"]),
    kind: asOptionalString(a["kind"]),
    tag: asOptionalString(a["tag"]),
    since: asOptionalFiniteNumber(a["since"]),
    limit: asClampedInt(a["limit"], MEMORY_LIST_DEFAULT_LIMIT, 1, MEMORY_LIST_MAX_LIMIT),
    offset: asClampedInt(a["offset"], 0, 0, MEMORY_LIST_MAX_OFFSET),
  }
}

/** Validate/clamp raw `memory-search` args off the wire. A blank/whitespace
 *  query is normalized to "" — the injected memorySearch dep short-circuits
 *  to an empty page rather than issuing a vacuous vector search. */
export const validateMemorySearchArgs = (args: unknown): ValidatedMemorySearchArgs => {
  const a = isPlainObject(args) ? args : {}
  const rawQuery = typeof a["query"] === "string" ? a["query"].trim() : ""
  return {
    query: rawQuery.slice(0, MEMORY_SEARCH_QUERY_MAX_LEN),
    namespace: asOptionalString(a["namespace"]),
    kind: asOptionalString(a["kind"]),
    topK: asClampedInt(a["topK"], MEMORY_SEARCH_DEFAULT_TOP_K, 1, MEMORY_SEARCH_MAX_TOP_K),
  }
}

/** Best-effort preview text for a record: memory_save always writes
 *  `content: { text }`, but other producers (e.g. beliefs) store structured
 *  content — fall back to a JSON preview so the list view never shows "". */
const extractPreviewText = (content: unknown): string => {
  if (
    content !== null &&
    typeof content === "object" &&
    "text" in content &&
    typeof (content as { text: unknown }).text === "string"
  ) {
    return (content as { text: string }).text
  }
  try {
    return JSON.stringify(content) ?? ""
  } catch {
    return ""
  }
}

/** Project a MemoryRecord to the curated wire shape. Pure — exported so
 *  chat-server's memoryList/memorySearch deps (and tests) can reuse it. */
export const toCuratedMemoryRow = (rec: MemoryRecord): CuratedMemoryRow => ({
  id: rec.id,
  namespace: rec.namespace,
  kind: rec.kind,
  text: extractPreviewText(rec.content),
  content: rec.content,
  tags: rec.tags,
  createdAt: rec.createdAt,
  updatedAt: rec.updatedAt,
  ...(rec.scope !== undefined
    ? {
        scope: {
          observerId: rec.scope.observerId,
          subjectId: rec.scope.subjectId,
          visibility: rec.scope.visibility,
        },
      }
    : {}),
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
 * The curated, READ-ONLY tool allowlist exposed to store-backed apps:
 * workspace `pulse` counters, a metadata-only `list-artifacts`, and the
 * memory-browser's `memory-list` (exact-filter, paginated) / `memory-search`
 * (hybrid top-K) pair. No tool here writes state, deletes anything, or
 * returns secrets. Note the exact read surface: `list-artifacts` is a GLOBAL
 * enumeration of artifact metadata (id/title/kind/version/updatedAt — never
 * content, never origin); `memory-list`/`memory-search` are scoped by the
 * injected deps (chat-server binds them to the OPERATOR_MEMORY_SCOPE, the
 * same scope memory_search/memory_save already use), which the caller should
 * keep in mind before any multi-tenant deployment. Safe in single-tenant
 * Luna (the operator owns every artifact and every memory, and the sandboxed
 * app has a strict no-network CSP — display-only). Args are validated here
 * (validateMemoryListArgs/validateMemorySearchArgs) before reaching the
 * injected deps — the deps never see unchecked wire input.
 */
export const buildCuratedAppTools = (deps: {
  readonly getPulse: () => Promise<PulseCounters>
  readonly listArtifacts: () => Promise<ReadonlyArray<CuratedArtifactRow>>
  readonly memoryList: (args: ValidatedMemoryListArgs) => Promise<MemoryListPage>
  readonly memorySearch: (args: ValidatedMemorySearchArgs) => Promise<MemorySearchPage>
}): Readonly<Record<string, (args: unknown) => Promise<unknown> | unknown>> => ({
  pulse: () => deps.getPulse(),
  "list-artifacts": () => deps.listArtifacts(),
  "memory-list": (args) => deps.memoryList(validateMemoryListArgs(args)),
  "memory-search": (args) => deps.memorySearch(validateMemorySearchArgs(args)),
})
