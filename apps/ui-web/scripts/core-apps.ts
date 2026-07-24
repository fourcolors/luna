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
import type { McpAppHostDeps, MemorySearchErrorKind } from "@luna/ui-ws"
import type { CounterSnapshot, FeedbackListRow } from "@luna/core"
import type { MemoryRecord, MemoryVisibility } from "@luna/memory"

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
 * so their tools come from a fixed CURATED registry (buildCuratedAppTools),
 * with an optional per-app gate for destructive capabilities. */

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

/* ── memory-list / memory-search / memory-delete: memory-browser curated
 * tools ───────────────────────────────────────────────────────────────────
 * Backs the Moon "memory browser" MCP app (Chairman-facing, ships alongside
 * this module). Three surfaces on top of the SAME MemoryRouter the memory_*
 * SDK tools already use (@luna/memory-tools tools.ts):
 *   - `memory-list`   → MemoryRouter.query() exact-filter listing, paginated
 *                        via limit/offset (MemoryQuery has no native offset,
 *                        so chat-server over-fetches offset+limit+1 rows and
 *                        slices — see the memoryList dep it injects below).
 *   - `memory-search` → MemoryRouter.search() hybrid BM25+vector top-K. On
 *                        backend failure (e.g. no vector backend configured)
 *                        the injected dep sets `error` on the returned page
 *                        instead of throwing, so the app can detect
 *                        "no-vector-backend" and fall back to memory-list.
 *   - `memory-delete` → MemoryRouter.get() + delete(), mirroring
 *                        memory_delete's scope re-check exactly. The ONLY
 *                        mutation exposed to the app surface — no edit/flag/
 *                        tag-patch (that needs a primitive that doesn't
 *                        exist; deliberately out of scope for v1).
 * Args arrive as `unknown` over the wire (an app is agent/user HTML, never
 * trusted) — validateMemoryListArgs/validateMemorySearchArgs/
 * validateMemoryDeleteArgs are the ONE validation choke point per tool, pure
 * + exported so they're unit-testable without a router. */

const MEMORY_LIST_DEFAULT_LIMIT = 25
const MEMORY_LIST_MAX_LIMIT = 100
const MEMORY_LIST_MAX_OFFSET = 2000
const MEMORY_SEARCH_DEFAULT_TOP_K = 10
const MEMORY_SEARCH_MAX_TOP_K = 50
const MEMORY_SEARCH_QUERY_MAX_LEN = 500
const MEMORY_DELETE_ID_MAX_LEN = 200

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
    readonly visibility: MemoryVisibility
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
  /** Set instead of throwing when the underlying search failed (e.g. no
   *  vector backend configured) — mirrors @luna/ui-ws's MemorySearchErrorKind
   *  so the memory-browser app can detect "no-vector-backend" specifically
   *  and fall back to memory-list rather than showing a dead-end error. rows
   *  is [] whenever error is set. */
  readonly error?: {
    readonly kind: MemorySearchErrorKind
    readonly message: string
  }
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

export interface ValidatedMemoryDeleteArgs {
  readonly id: string
}

/** Result of the `memory-delete` curated tool. `deleted:false` covers both
 *  "no such record" and "record exists but is outside the bound scope" —
 *  the caller can't distinguish a missing id from a scope refusal, which is
 *  the point (no oracle for cross-scope record existence). */
export interface MemoryDeleteResult {
  readonly deleted: boolean
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const asOptionalString = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined
  const trimmed = v.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

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

/** Validate/clamp raw `memory-delete` args off the wire. A missing/non-string
 *  id (or one that is all whitespace) normalizes to "" — the injected
 *  memoryDelete dep never sees raw wire input, and an empty id simply won't
 *  match any record (deleted:false), so this degrades safely rather than
 *  throwing. Length-capped defensively; real ids are short (`mem_<ts36>_
 *  <6 chars>`). */
export const validateMemoryDeleteArgs = (args: unknown): ValidatedMemoryDeleteArgs => {
  const a = isPlainObject(args) ? args : {}
  const rawId = typeof a["id"] === "string" ? a["id"].trim() : ""
  return { id: rawId.slice(0, MEMORY_DELETE_ID_MAX_LEN) }
}

/* ── feedback-list / feedback-set-status / feedback-create-job: feedback-queue
 * curated tools ────────────────────────────────────────────────────────────
 * Backs the on-demand `ui://luna/feedback-queue` core app and any
 * store-backed app that reads/triages/queues work on `ui_feedback` notes.
 * Reads (`feedback-list`) are shared with every store-backed app; mutations
 * (`feedback-set-status`, `feedback-create-job`) are gated by chat-server's
 * isToolAllowed to the reviewed `mcp-app:feedback-queue` artifact id,
 * mirroring memory-delete's gate. */

const FEEDBACK_LIST_DEFAULT_LIMIT = 25
const FEEDBACK_LIST_MAX_LIMIT = 100
const FEEDBACK_LIST_MAX_OFFSET = 2000
const FEEDBACK_STATUS_MAX_LEN = 64
const FEEDBACK_ID_MAX_LEN = 200
const FEEDBACK_RESOLVED_REF_MAX_LEN = 500
const FEEDBACK_STATUS_NOTES_MAX_LEN = 4000

export interface ValidatedFeedbackListArgs {
  readonly status?: string
  readonly limit: number
  readonly offset: number
}
export interface ValidatedFeedbackSetStatusArgs {
  readonly id: string
  readonly status: string
  readonly resolvedRef?: string
  readonly notes?: string
}
export interface FeedbackListPage {
  readonly rows: ReadonlyArray<FeedbackListRow>
  readonly limit: number
  readonly offset: number
  readonly hasMore: boolean
}

/** Validate/clamp raw `feedback-list` args off the wire. Never throws — a
 *  malformed call degrades to "list the first page of open items" rather
 *  than failing closed (mirrors validateMemoryListArgs). */
export const validateFeedbackListArgs = (args: unknown): ValidatedFeedbackListArgs => {
  const a = isPlainObject(args) ? args : {}
  return {
    status: asOptionalString(a["status"])?.slice(0, FEEDBACK_STATUS_MAX_LEN),
    limit: asClampedInt(a["limit"], FEEDBACK_LIST_DEFAULT_LIMIT, 1, FEEDBACK_LIST_MAX_LIMIT),
    offset: asClampedInt(a["offset"], 0, 0, FEEDBACK_LIST_MAX_OFFSET),
  }
}

export interface ValidatedFeedbackCreateJobArgs {
  readonly id: string
}

/** Validate/clamp raw `feedback-create-job` args off the wire. A missing/
 *  non-string id normalizes to "" — mirrors validateFeedbackSetStatusArgs'
 *  id handling exactly (same FEEDBACK_ID_MAX_LEN cap): the injected
 *  feedbackCreateJob dep never sees raw wire input, and an empty id simply
 *  fails closed ({ok:false, message:"unknown feedback id"}) rather than
 *  throwing here. Never throws. */
export const validateFeedbackCreateJobArgs = (
  args: unknown,
): ValidatedFeedbackCreateJobArgs => {
  const a = isPlainObject(args) ? args : {}
  const rawId = typeof a["id"] === "string" ? a["id"].trim() : ""
  return { id: rawId.slice(0, FEEDBACK_ID_MAX_LEN) }
}

/** Validate/clamp raw `feedback-set-status` args off the wire. A missing/
 *  non-string id normalizes to "" — the injected dep's store re-checks the
 *  id exists as a ui_feedback note before writing (defense in depth), so an
 *  empty id degrades safely to {ok:false} rather than throwing here. */
export const validateFeedbackSetStatusArgs = (
  args: unknown,
): ValidatedFeedbackSetStatusArgs => {
  const a = isPlainObject(args) ? args : {}
  const rawId = typeof a["id"] === "string" ? a["id"].trim() : ""
  const rawStatus = asOptionalString(a["status"]) ?? "open"
  const resolvedRef = asOptionalString(a["resolvedRef"])
  const notes = asOptionalString(a["notes"])
  return {
    id: rawId.slice(0, FEEDBACK_ID_MAX_LEN),
    status: rawStatus.slice(0, FEEDBACK_STATUS_MAX_LEN),
    ...(resolvedRef !== undefined
      ? { resolvedRef: resolvedRef.slice(0, FEEDBACK_RESOLVED_REF_MAX_LEN) }
      : {}),
    ...(notes !== undefined
      ? { notes: notes.slice(0, FEEDBACK_STATUS_NOTES_MAX_LEN) }
      : {}),
  }
}

/**
 * The `memory-delete` scope re-check, extracted as an Effect-free (Promise)
 * function so it's unit-testable without a real MemoryRouter — mirrors
 * @luna/memory-tools tools.ts' memory_delete handler (~258-288) exactly:
 * fetch the record, THEN verify scope, THEN delete. This is DEFENSE IN
 * DEPTH: chat-server's injected getRecord/deleteRecord are already scope-
 * bound (memoryBrowserScope), so matchesScope should never actually reject
 * anything getRecord returned — but deletion is destructive, so we re-check
 * anyway rather than trust a single layer. An empty id (validateMemory
 * DeleteArgs' safe default for malformed input) short-circuits to
 * `{deleted:false}` without calling getRecord at all.
 */
export const deleteMemoryRecordWithScopeCheck = async (
  args: ValidatedMemoryDeleteArgs,
  deps: {
    readonly getRecord: (id: string) => Promise<MemoryRecord | null>
    readonly deleteRecord: (id: string) => Promise<boolean>
    readonly matchesScope: (record: MemoryRecord) => boolean
  },
): Promise<MemoryDeleteResult> => {
  if (args.id.length === 0) return { deleted: false }
  const existing = await deps.getRecord(args.id)
  if (existing === null || !deps.matchesScope(existing)) {
    return { deleted: false }
  }
  const removed = await deps.deleteRecord(args.id)
  return { deleted: removed }
}

/** Best-effort preview text for a record: memory_save always writes
 *  `content: { text }`, but other producers (e.g. beliefs) store structured
 *  content — fall back to a JSON preview so the list view never shows "". */
const extractPreviewText = (content: unknown): string => {
  if (typeof content === "string") return content
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
 * one registry because they carry no server JS. Read tools are shared; the
 * optional isToolAllowed hook narrows destructive capabilities to reviewed
 * app identities. Unknown uris/apps/tools fail closed so a composed registry
 * can try the next provider.
 */
export const createStoreBackedAppRegistry = (deps: {
  readonly getAppHtml: (artifactId: string) => Promise<string | null>
  readonly curatedTools: Readonly<
    Record<string, (args: unknown) => Promise<unknown> | unknown>
  >
  /** Optional per-app gate for tools that are not safe to expose to every
   *  generated app (notably destructive mutations). Reads stay shared. */
  readonly isToolAllowed?: (artifactId: string, tool: string) => boolean
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
    if (deps.isToolAllowed !== undefined && !deps.isToolAllowed(id, tool)) {
      return { ok: false, message: `tool "${tool}" is not available to this app` }
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
 * The curated tool allowlist exposed to store-backed apps: workspace `pulse`
 * counters, a metadata-only `list-artifacts`, the memory-browser's
 * `memory-list` (exact-filter, paginated) / `memory-search` (hybrid top-K)
 * read pair and `memory-delete` mutation, plus the feedback-queue's
 * `feedback-list` read and `feedback-set-status` / `feedback-create-job`
 * mutations. Each mutation is gated by `isCuratedToolAllowed` to its reviewed
 * artifact id (`mcp-app:memory-browser` or `mcp-app:feedback-queue`).
 * (No edit/flag/tag-patch for memory; that needs a tag-patch primitive that
 * doesn't exist yet, deliberately out of scope for v1). Note the exact read
 * surface: `list-artifacts` is a GLOBAL enumeration of artifact metadata
 * (id/title/kind/version/updatedAt — never content, never origin);
 * `memory-list`/`memory-search`/`memory-delete` are scoped by the injected
 * deps (chat-server binds them to the OPERATOR_MEMORY_SCOPE, the same scope
 * memory_save/memory_search/memory_delete already use), which the caller
 * should keep in mind before any multi-tenant deployment. Safe in
 * single-tenant Luna (the operator owns every artifact and every memory, and
 * the sandboxed app has a strict no-network CSP).
 * Args are validated here (validateMemoryListArgs/validateMemorySearchArgs/
 * validateMemoryDeleteArgs/validateFeedbackListArgs/
 * validateFeedbackSetStatusArgs/validateFeedbackCreateJobArgs) before reaching
 * the injected deps — the deps never see unchecked wire input. `memory-delete`
 * additionally relies on its injected dep re-checking scope AFTER fetching the
 * record (defense in depth — see makeMemoryTools' memory_delete in
 * @luna/memory-tools for the pattern this mirrors), since arg validation alone
 * can't enforce that.
 */
export const buildCuratedAppTools = (deps: {
  readonly getPulse: () => Promise<PulseCounters>
  readonly listArtifacts: () => Promise<ReadonlyArray<CuratedArtifactRow>>
  readonly memoryList: (args: ValidatedMemoryListArgs) => Promise<MemoryListPage>
  readonly memorySearch: (args: ValidatedMemorySearchArgs) => Promise<MemorySearchPage>
  /** The injected dep is trusted to apply its OWN scope re-check (mirroring
   *  memory_delete's matchesMemoryScope guard in @luna/memory-tools) even
   *  though query-scoping should already prevent cross-scope reads from
   *  reaching here — deletion is destructive, so chat-server re-verifies
   *  scope defensively before calling router.delete. */
  readonly memoryDelete: (args: ValidatedMemoryDeleteArgs) => Promise<MemoryDeleteResult>
  /** feedback-queue: list `ui_feedback` notes + their triage status. Read —
   *  shared with every store-backed app, same as pulse/list-artifacts/memory-list. */
  readonly feedbackList: (args: ValidatedFeedbackListArgs) => Promise<FeedbackListPage>
  /** feedback-queue: set a note's triage status. Gated by chat-server's isToolAllowed
   *  to the reviewed `mcp-app:feedback-queue` artifact id (mirrors memory-delete). */
  readonly feedbackSetStatus: (
    args: ValidatedFeedbackSetStatusArgs,
  ) => Promise<{ readonly ok: boolean; readonly message?: string }>
  /** feedback-queue: the second mutation — spins up a durable one-shot job
   *  (@luna/core's feedback-job-bridge createFeedbackCreateJobDep) for a
   *  `ui_feedback` report. Gated by chat-server's isToolAllowed exactly like
   *  feedback-set-status (same reviewed `mcp-app:feedback-queue` artifact).
   *  OPTIONAL: omitted entirely (no `feedback-create-job` tool exposed) when
   *  the caller doesn't wire it, so existing callers built before this
   *  capability shipped keep their exact prior tool surface unchanged. */
  readonly feedbackCreateJob?: (
    args: ValidatedFeedbackCreateJobArgs,
  ) => Promise<{ readonly ok: boolean; readonly jobId?: string; readonly message?: string }>
}): Readonly<Record<string, (args: unknown) => Promise<unknown> | unknown>> => ({
  pulse: () => deps.getPulse(),
  "list-artifacts": () => deps.listArtifacts(),
  "memory-list": (args) => deps.memoryList(validateMemoryListArgs(args)),
  "memory-search": (args) => deps.memorySearch(validateMemorySearchArgs(args)),
  "memory-delete": (args) => deps.memoryDelete(validateMemoryDeleteArgs(args)),
  "feedback-list": (args) => deps.feedbackList(validateFeedbackListArgs(args)),
  "feedback-set-status": (args) => deps.feedbackSetStatus(validateFeedbackSetStatusArgs(args)),
  ...(deps.feedbackCreateJob
    ? {
        "feedback-create-job": (args: unknown) =>
          deps.feedbackCreateJob!(validateFeedbackCreateJobArgs(args)),
      }
    : {}),
})

/**
 * Every curated MUTATION's owning app identity, keyed by tool name. Adding a
 * new mutation to the curated registry REQUIRES a row here — a tool name
 * absent from this record is treated as a (dynamic) read and falls through
 * isCuratedToolAllowed's `true` default below. Read tools (pulse,
 * list-artifacts, memory-list, memory-search, feedback-list, …) must never
 * appear here.
 */
const MUTATION_OWNER: Readonly<Record<string, string>> = {
  "memory-delete": "mcp-app:memory-browser",
  "feedback-set-status": "mcp-app:feedback-queue",
  "feedback-create-job": "mcp-app:feedback-queue",
}

/**
 * The extracted per-app mutation gate: which curated tools a store-backed
 * app's identity (its own artifact id) is allowed to call. Every mutation in
 * the curated registry is scoped to exactly ONE reviewed artifact id (see
 * MUTATION_OWNER above) — no generated/user-authored app inherits a
 * destructive capability just because it can call the shared curated tool
 * set. A tool name MUTATION_OWNER doesn't recognize (every read tool) falls
 * through to `true` — unknown-to-this-gate is allowed, not denied, since the
 * read surface is dynamic and this gate exists only to narrow mutations.
 * Extracted out of chat-server.ts's inline `isToolAllowed` closure so it's
 * unit-testable without booting the server.
 */
export const isCuratedToolAllowed = (artifactId: string, tool: string): boolean => {
  const owner = MUTATION_OWNER[tool]
  return owner === undefined || owner === artifactId
}

/**
 * The Phase 1 on-demand feedback triage view — a STATIC core app (like
 * buildWorkspacePulseApp), NOT a runtime mcp_app_write artifact. See the
 * file-level comment in core-apps/feedback-queue.html for the full
 * rationale (also restated in this PR's body). Ships fully in this PR,
 * reuses the same feedback-list/feedback-set-status curated tools Phase 2's
 * live queue app will call.
 */
export const buildFeedbackQueueApp = (deps: {
  readonly feedbackList: (args: ValidatedFeedbackListArgs) => Promise<FeedbackListPage>
  readonly feedbackSetStatus: (
    args: ValidatedFeedbackSetStatusArgs,
  ) => Promise<{ readonly ok: boolean; readonly message?: string }>
  /** feedback-create-job: spin up the durable one-shot job that works a
   *  triaged report (@luna/core feedback-job-bridge). OPTIONAL so a caller
   *  that hasn't wired the jobs store keeps the prior read-only tool set;
   *  the "Create job" control in feedback-queue.html only appears when the
   *  panel actually advertises this tool. */
  readonly feedbackCreateJob?: (
    args: ValidatedFeedbackCreateJobArgs,
  ) => Promise<{ readonly ok: boolean; readonly jobId?: string; readonly message?: string }>
}): CoreApp => ({
  uri: "ui://luna/feedback-queue",
  html: readAppHtml("feedback-queue.html"),
  tools: {
    "feedback-list": (args) => deps.feedbackList(validateFeedbackListArgs(args)),
    "feedback-set-status": (args) => deps.feedbackSetStatus(validateFeedbackSetStatusArgs(args)),
    ...(deps.feedbackCreateJob
      ? {
          "feedback-create-job": (args: unknown) =>
            deps.feedbackCreateJob!(validateFeedbackCreateJobArgs(args)),
        }
      : {}),
  },
})
