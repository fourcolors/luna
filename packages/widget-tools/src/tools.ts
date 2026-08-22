/**
 * widget_write — describe-to-spawn authoring (PRD Part C / W4 §16).
 *
 * The agent authors a SELF-CONTAINED widget (HTML/JS) and writes it as a
 * `kind="widget"` pinned artifact. The agent picks a stable kebab-case slug;
 * calling widget_write again with the SAME slug appends a new version (the
 * surgical-diff iteration loop — "remove the background" patches the artifact),
 * with one-click time-travel revert for free via the artifact store's ledger.
 *
 * The widget BODY runs caged: an `<iframe sandbox="allow-scripts">` (no
 * same-origin, strict CSP, no network) whose only door is the cap-gated
 * `luna.*` bridge. This tool enforces the cap side: `bridge_caps` are filtered
 * to `obs:*` / `obs:<Kind>` entries only (fail-closed) so a widget can never
 * request a scope the bridge does not implement.
 */
import { Effect } from "effect"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import { ArtifactStore, deriveArtifactKind } from "@luna/core"
import type { ArtifactKind } from "@luna/core"

const WIDGET_TOOL_DISCOVERY = {
  alwaysLoad: true,
  searchHint:
    "Create or edit a live widget (a small self-contained HTML/JS panel the user can pop out as a window).",
} as const

const widgetWriteShape = {
  widgetId: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "lowercase letters, digits and hyphens only (a stable slug)",
    )
    .describe(
      "A stable kebab-case slug you choose for this widget (e.g. 'pr-99-tracker'). " +
        "Call widget_write again with the SAME widgetId to edit/iterate it — each " +
        "write is a new version, and old versions can be reverted to.",
    ),
  title: z
    .string()
    .min(1)
    .describe("Human-friendly title shown in the widget's title bar."),
  html: z
    .string()
    .min(1)
    .describe(
      "A SELF-CONTAINED HTML document. Inline <style> and <script> ONLY — it runs " +
        "in a no-network sandbox (no external scripts, no fetch). For live data use " +
        "window.luna.subscribe(kinds, cb) and window.luna.refresh(); nothing else " +
        "(no Tauri, no Node, no parent page) is reachable.",
    ),
  bridgeCaps: z
    .array(z.string())
    .optional()
    .describe(
      "Allowlist of obs-event kinds the widget may subscribe to, e.g. " +
        "['obs:ToolCall'] or ['obs:*'] for all. Omit for a static widget. " +
        "Entries that are not 'obs:*' or 'obs:<Kind>' are dropped.",
    ),
}

/** Keep only well-formed bridge scopes — fail closed. */
const sanitizeBridgeCaps = (
  caps: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | null => {
  if (!caps || caps.length === 0) return null
  const ok = caps.filter((c) => /^obs:(\*|[A-Za-z][A-Za-z0-9]*)$/.test(c))
  return ok.length > 0 ? ok : null
}

export const makeWidgetTools = (
  store: (typeof ArtifactStore)["Service"],
  summoner?: WidgetSummonerPort | null,
) => {
  const widgetWrite = defineTool({
    name: "widget_write",
    description:
      "Create or update a live WIDGET — a small self-contained HTML/JS panel " +
      "the user can pop out as a floating window. Pass a stable widgetId; " +
      "writing again with the same id iterates the widget as a new version. " +
      "The widget runs in a no-network sandbox whose only data door is " +
      "window.luna.subscribe()/refresh(), scoped by bridgeCaps. Returns the " +
      "artifact id + version.",
    inputSchema: widgetWriteShape,
    ...WIDGET_TOOL_DISCOVERY,
    handler: (args) =>
      Effect.gen(function* () {
        const id = `widget:${args.widgetId}`
        const bridgeCaps = sanitizeBridgeCaps(args.bridgeCaps)
        const existing = yield* store.get(id)
        if (existing) {
          // Iterate: a new version of the same widget (surgical diff edit). Pass
          // the sanitized caps so an iteration can widen/narrow/revoke them
          // (review G3); pass undefined when the caller omitted bridgeCaps so the
          // existing caps are left untouched.
          const updated = yield* store.update(
            id,
            args.html,
            "agent",
            args.bridgeCaps === undefined ? undefined : bridgeCaps,
          )
          return {
            artifactId: id,
            version: updated?.version ?? existing.version,
            action: "updated" as const,
          }
        }
        const pinned = yield* store.pin({
          id,
          kind: "widget",
          title: args.title,
          content: args.html,
          lang: "html",
          editedBy: "agent",
          ...(bridgeCaps ? { bridgeCaps } : {}),
        })
        // Auto-open the freshly created widget as a window (S2: "build a widget
        // → it opens"). Only on CREATE — iterations land in the `updated`
        // branch above and deliberately do NOT re-pop (the host focuses an
        // already-open window, but re-popping on every edit churns it).
        // Fire-and-forget: a missing/old host returns ok:false and never fails
        // the turn — the widget is pinned regardless and reopenable later.
        const opened = summoner
          ? summoner.openArtifact(id, args.title, "widget").ok
          : false
        return {
          artifactId: id,
          version: pinned.version,
          action: "created" as const,
          opened,
        }
      }).pipe(
        // The store operations are infallible by type (E = never); a real disk
        // failure surfaces as a defect, which we convert to a clean ToolError
        // so the SDK reports it as an error result rather than crashing the turn.
        Effect.catchDefect((d) =>
          Effect.fail(
            new ToolError({
              tool: "widget_write",
              op: "widget.write",
              cause: d instanceof Error ? d.message : String(d),
            }),
          ),
        ),
      ),
  })

  return [widgetWrite] as const
}

/**
 * mcp_app_write — describe-to-spawn for MCP APPS (Apps pillar v1, "Generate").
 *
 * The richer sibling of widget_write: instead of a static/event-only sandboxed
 * widget, the agent authors a `kind="mcp-app"` artifact whose HTML can PULL live
 * data by calling a curated, read-only Luna tool allowlist over the MCP Apps
 * protocol. The host injects a `window.mcp` client helper into the cage, so the
 * authored HTML just does `await window.mcp.call('pulse')`. Same id-iteration +
 * time-travel ledger as widget_write; auto-opens on create via the summoner.
 */
export const makeMcpAppTools = (
  store: (typeof ArtifactStore)["Service"],
  summoner?: WidgetSummonerPort | null,
) => {
  const mcpAppWrite = defineTool({
    name: "mcp_app_write",
    description:
      "Create or update an MCP APP — a self-contained interactive panel that " +
      "pulls LIVE data by calling a small set of read-only Luna tools over the " +
      "MCP Apps protocol. Use this (instead of widget_write) when the panel " +
      "needs to fetch/refresh data rather than render static markup. In the " +
      "HTML, call window.mcp.call('pulse') → {toolsCalled,errors,estimatedUsd," +
      "activeSessions}, window.mcp.call('list-artifacts') → [{id,title,kind," +
      "version,updatedAt}], window.mcp.call('memory-list', {namespace?,kind?," +
      "tag?,since?,limit?,offset?}) → {rows:[{id,namespace,kind,text,content," +
      "tags,createdAt,updatedAt,scope?}],limit,offset,hasMore} (exact-filter, " +
      "paginated browsing of long-term memory), window.mcp.call(" +
      "'memory-search', {query,namespace?,kind?,topK?}) → {rows:[{...same " +
      "shape as memory-list rows,score}],query,topK,error?:{kind:'no-vector-" +
      "backend'|'internal',message}} (hybrid BM25+vector top-K search; " +
      "error is set instead of throwing on backend failure — fall back to " +
      "memory-list when kind is 'no-vector-backend'), or window.mcp.call(" +
      "'memory-delete', {id}) → {deleted:boolean} (deletes one memory record " +
      "by id; restricted to the stable appId 'memory-browser', and the only " +
      "mutation exposed to apps — no edit/flag/bulk-delete). " +
      "window.mcp.ready resolves once connected (the helper " +
      "is injected for you — do not write your own protocol code). Pass a stable " +
      "appId; writing again with the same id iterates it as a new, revertable " +
      "version. Returns the artifact id + version.",
    inputSchema: {
      appId: z
        .string()
        .min(1)
        .regex(
          /^[a-z0-9][a-z0-9-]*$/,
          "lowercase letters, digits and hyphens only (a stable slug)",
        )
        .describe(
          "A stable kebab-case slug for this app (e.g. 'workspace-dashboard'). " +
            "Reuse the SAME appId to edit/iterate it.",
        ),
      title: z
        .string()
        .min(1)
        .describe("Human-friendly title shown in the app's title bar."),
      html: z
        .string()
        .min(1)
        .describe(
          "A SELF-CONTAINED HTML document (inline <style>/<script> only — no " +
            "network, no external scripts). Use window.mcp.call(toolName, args) " +
            "for live data and window.mcp.ready (a Promise) to wait for connect. " +
            "Available tools: 'pulse', 'list-artifacts', 'memory-list' " +
            "(paginated memory browsing), 'memory-search' (hybrid top-K memory " +
            "search, may return {error} instead of throwing), 'memory-delete' " +
            "({id} → {deleted}, available only to the stable appId " +
            "'memory-browser'; no edit/flag/bulk-delete). Nothing else (no " +
            "Tauri, no Node, no fetch) is " +
            "reachable.",
        ),
    },
    alwaysLoad: true,
    searchHint:
      "Create or edit a live MCP app panel — a richer widget that calls read-only Luna tools.",
    handler: (args) =>
      Effect.gen(function* () {
        const id = `mcp-app:${args.appId}`
        const existing = yield* store.get(id)
        if (existing) {
          const updated = yield* store.update(id, args.html, "agent")
          return {
            artifactId: id,
            version: updated?.version ?? existing.version,
            action: "updated" as const,
          }
        }
        const pinned = yield* store.pin({
          id,
          kind: "mcp-app",
          title: args.title,
          content: args.html,
          lang: "html",
          editedBy: "agent",
        })
        // Auto-open on CREATE only (mirrors widget_write — no re-pop on edit).
        const opened = summoner
          ? summoner.openArtifact(id, args.title, "mcp-app").ok
          : false
        return {
          artifactId: id,
          version: pinned.version,
          action: "created" as const,
          opened,
        }
      }).pipe(
        Effect.catchDefect((d) =>
          Effect.fail(
            new ToolError({
              tool: "mcp_app_write",
              op: "mcp-app.write",
              cause: d instanceof Error ? d.message : String(d),
            }),
          ),
        ),
      ),
  })

  return [mcpAppWrite] as const
}

/**
 * open_widget — summon-by-name (widget-system.md "Summon-by-name").
 *
 * Two verbs, deliberately distinct: widget_write CREATES sandboxed content;
 * open_widget SUMMONS an existing surface by its registry kind ("open the
 * voice settings"). The directory comes from the connected host client and
 * the host resolves kinds through its own shipped registry, so this tool can
 * summon UI but can never conjure a window the host didn't already ship —
 * and every mutation inside an opened panel remains a user gesture.
 */
export interface WidgetSummonerPort {
  readonly directory: () => ReadonlyArray<{
    readonly kind: string
    readonly title: string
    readonly description: string
  }>
  readonly open: (
    kind: string,
    params?: Readonly<Record<string, string | number | boolean>>,
  ) => { readonly ok: boolean; readonly message: string }
  /**
   * Pop a pinned CONTENT artifact into its own window (the content-tier
   * sibling of `open` — used by open_artifact and the widget_write/mcp_app_write
   * auto-open). No registry directory to validate against: the host renders it
   * sandboxed by id, so this can never open a system panel.
   */
  readonly openArtifact: (
    artifactId: string,
    title: string,
    kind: ArtifactKind,
  ) => { readonly ok: boolean; readonly message: string }
}

export const makeOpenWidgetTool = (summoner: WidgetSummonerPort) => {
  const openWidget = defineTool({
    name: "open_widget",
    description:
      "Open (or focus) one of the user's app widgets/panels by kind — e.g. " +
      "settings panels ('settings.voice', 'settings.connection'). Use when " +
      "the user asks to open/show a settings panel or named widget instead " +
      "of describing where to click. The window opens on their screen; you " +
      "do not see or operate its contents. Call with no/unknown kind to get " +
      "the list of available kinds in the error message.",
    inputSchema: {
      kind: z
        .string()
        .min(1)
        .describe(
          "The widget kind to open, e.g. 'settings.voice'. Kinds and their " +
            "descriptions come from the connected app's widget directory.",
        ),
      params: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe(
          "Optional instance params for parameterized widgets — e.g. " +
            "{thread: '<threadId>'} with kind 'chat' opens a DIRECT LINE " +
            "window pinned to that thread, or {jobId: '<id>'} with kind " +
            "'flow' opens that job's run history. Same params focus the " +
            "same window.",
        ),
    },
    alwaysLoad: true,
    searchHint:
      "Open or focus an app widget/settings panel window by name (summon UI on the user's screen).",
    handler: (args) =>
      Effect.sync(() => {
        const result = summoner.open(args.kind, args.params)
        if (!result.ok) {
          const dir = summoner
            .directory()
            .map((w) => `${w.kind} — ${w.description}`)
            .join("\n")
          return {
            ok: false,
            message: result.message,
            ...(dir ? { available: dir } : {}),
          }
        }
        return { ok: true, message: result.message }
      }),
  })

  return openWidget
}

/**
 * search_artifacts — find a previously-built artifact so it can be reopened
 * (widget-system.md S2 "search and reopen by asking").
 *
 * Reads the durable ArtifactStore (every widget_write / mcp_app_write / pinned
 * document) and filters by a case-insensitive title/id substring. Returns
 * METADATA ONLY — never the artifact content — so a large widget's HTML can
 * never flood the model context. The agent uses a hit's `id` with open_artifact.
 */
export const makeSearchArtifactsTool = (
  store: (typeof ArtifactStore)["Service"],
) =>
  defineTool({
    name: "search_artifacts",
    description:
      "Search the user's pinned artifacts — documents, widgets and MCP apps " +
      "built in earlier turns — by title. Use this to find something the user " +
      "asks to see again ('the PR tracker widget from before'), even after its " +
      "window was closed. Returns metadata only (id, title, kind, version); " +
      "pass a hit's id to open_artifact to pop it back onto their screen.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring matched against artifact titles and ids. " +
            "Omit to list all pinned artifacts, most-recently-updated first.",
        ),
      kind: z
        .enum(["code", "markdown", "html", "widget", "mcp-app"])
        .optional()
        .describe("Filter to a single artifact kind."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of results (default 25)."),
    },
    alwaysLoad: true,
    searchHint:
      "Find a previously built artifact / widget / app by title so it can be reopened.",
    handler: (args) =>
      Effect.gen(function* () {
        const all = yield* store.list()
        const q = (args.query ?? "").trim().toLowerCase()
        const limit = args.limit ?? 25
        const artifacts = all
          .filter((a) => {
            if (args.kind && a.kind !== args.kind) return false
            if (!q) return true
            return (
              a.title.toLowerCase().includes(q) ||
              a.id.toLowerCase().includes(q)
            )
          })
          .slice(0, limit)
          .map((a) => ({
            id: a.id,
            title: a.title,
            kind: a.kind,
            version: a.version,
            updatedAt: a.updatedAt,
          }))
        return { count: artifacts.length, artifacts }
      }).pipe(
        Effect.catchDefect((d) =>
          Effect.fail(
            new ToolError({
              tool: "search_artifacts",
              op: "artifact.search",
              cause: d instanceof Error ? d.message : String(d),
            }),
          ),
        ),
      ),
  })

/**
 * open_artifact — reopen a pinned artifact as its own window by id (the
 * content-tier counterpart of open_widget). Looks the artifact up to recover
 * its title + kind, then asks the host (via the summoner) to pop it. Returns
 * ok:false for an unknown id, or when no widget-capable client is connected.
 */
export const makeOpenArtifactTool = (
  store: (typeof ArtifactStore)["Service"],
  summoner: WidgetSummonerPort,
) =>
  defineTool({
    name: "open_artifact",
    description:
      "Open (or focus) a pinned artifact as its own window on the user's " +
      "screen — reopen a widget, app or document they ask to see again. Pass " +
      "the artifactId from search_artifacts. The window opens on their screen; " +
      "you do not see or operate its contents.",
    inputSchema: {
      artifactId: z
        .string()
        .min(1)
        .describe(
          "The artifact id to open, e.g. 'widget:pr-99-tracker'. Get it from " +
            "search_artifacts.",
        ),
    },
    alwaysLoad: true,
    searchHint:
      "Reopen a previously built artifact / widget / app window by its id.",
    handler: (args) =>
      Effect.gen(function* () {
        const art = yield* store.get(args.artifactId)
        if (!art) {
          return {
            ok: false,
            message:
              `No pinned artifact with id "${args.artifactId}". ` +
              "Use search_artifacts to find the right id.",
          }
        }
        const result = summoner.openArtifact(art.id, art.title, art.kind)
        return { ok: result.ok, message: result.message }
      }).pipe(
        Effect.catchDefect((d) =>
          Effect.fail(
            new ToolError({
              tool: "open_artifact",
              op: "artifact.open",
              cause: d instanceof Error ? d.message : String(d),
            }),
          ),
        ),
      ),
  })

/**
 * show_artifact — pin a CONTENT artifact (code / markdown / html) and open it
 * in a panel (widget-system.md S2, "show me that in a panel").
 *
 * The content-tier authoring sibling of widget_write: where widget_write
 * creates an executable sandboxed widget, show_artifact takes a plain
 * code/markdown/html body the agent already produced and (a) PINS it durably
 * — so it persists, versions, and is reopenable by id like any artifact — then
 * (b) opens it via the same summoner path both clients render by id. The kind
 * is derived from `lang` (never "widget"/"mcp-app" — those are the executable
 * kinds with their own verbs). A stable `artifactId` slug makes it idempotent:
 * reusing the same id appends a new version and re-opens, rather than forking.
 *
 * Summoner-gated (registered only when a host can receive opens), like
 * open_artifact. When a summoner is present but no host is connected the open
 * is buffered and replayed on reconnect (the bridge's open-intent replay).
 */
export const makeShowArtifactTool = (
  store: (typeof ArtifactStore)["Service"],
  summoner: WidgetSummonerPort,
) =>
  defineTool({
    name: "show_artifact",
    description:
      "Open a piece of CONTENT you produced — code, a markdown document, or an " +
      "HTML preview — in a panel on the user's screen. Pass the content inline; " +
      "it is pinned (so it persists and can be reopened later) and opened as its " +
      "own panel rendered for its kind (code → highlighted, markdown → formatted, " +
      "html → sandboxed preview). Use this for 'show me that in a panel' / to put " +
      "a result somewhere the user can see and keep it. For an INTERACTIVE or " +
      "live-data panel use widget_write / mcp_app_write instead. You only show " +
      "the content — you cannot read or operate the opened panel.",
    inputSchema: {
      artifactId: z
        .string()
        .min(1)
        .regex(
          /^[a-z0-9][a-z0-9-]*$/,
          "lowercase letters, digits and hyphens only (a stable slug)",
        )
        .describe(
          "A stable kebab-case slug for this content (e.g. 'auth-flow-notes'). " +
            "This is the doc's IDENTITY: reuse the SAME id to update/iterate it " +
            "(each call is a new, revertable version, and the title/format may " +
            "change); use a DIFFERENT id for a different document, or it replaces " +
            "the first.",
        ),
      title: z
        .string()
        .min(1)
        .describe("Human-friendly title shown in the panel's title bar."),
      content: z
        .string()
        .min(1)
        .describe("The raw content body — source code, markdown, or HTML."),
      lang: z
        .string()
        .optional()
        .describe(
          "Language/format hint that picks the renderer: a code language " +
            "('ts', 'python', …) renders highlighted; 'md'/'markdown' renders " +
            "formatted; 'html' renders as a sandboxed preview. Omit for plain code.",
        ),
    },
    alwaysLoad: true,
    searchHint:
      "Open a code / markdown / HTML result you wrote in a panel on the user's screen.",
    handler: (args) =>
      Effect.gen(function* () {
        const id = `doc:${args.artifactId}`
        const kind = deriveArtifactKind(args.lang, null)
        const pinNew = () =>
          store.pin({
            id,
            kind,
            title: args.title,
            content: args.content,
            lang: args.lang ?? null,
            editedBy: "agent",
          })

        const existing = yield* store.get(id)
        let version: number
        let action: "created" | "updated"
        if (existing) {
          // Iterate: append a version AND refresh the head's title/lang/kind so
          // re-showing the same slug can change its title or FORMAT (md→html)
          // and render correctly — not freeze to the first pin (review S2-F1).
          const updated = yield* store.update(id, args.content, "agent", undefined, {
            title: args.title,
            lang: args.lang ?? null,
            kind,
          })
          if (updated) {
            version = updated.version
            action = "updated"
          } else {
            // Raced with an unpin between get and update (review S2-F2): the head
            // vanished, so recreate it rather than silently dropping the content.
            const pinned = yield* pinNew()
            version = pinned.version
            action = "created"
          }
        } else {
          const pinned = yield* pinNew()
          version = pinned.version
          action = "created"
        }
        const opened = summoner.openArtifact(id, args.title, kind)
        return {
          artifactId: id,
          kind,
          version,
          action,
          opened: opened.ok,
          message: opened.message,
        }
      }).pipe(
        Effect.catchDefect((d) =>
          Effect.fail(
            new ToolError({
              tool: "show_artifact",
              op: "artifact.show",
              cause: d instanceof Error ? d.message : String(d),
            }),
          ),
        ),
      ),
  })
