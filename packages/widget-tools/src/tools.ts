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
import { ArtifactStore } from "@luna/core"

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

export const makeWidgetTools = (store: (typeof ArtifactStore)["Service"]) => {
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
        return {
          artifactId: id,
          version: pinned.version,
          action: "created" as const,
        }
      }).pipe(
        // The store operations are infallible by type (E = never); a real disk
        // failure surfaces as a defect, which we convert to a clean ToolError
        // so the SDK reports it as an error result rather than crashing the turn.
        Effect.catchAllDefect((d) =>
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
  readonly open: (kind: string) => { readonly ok: boolean; readonly message: string }
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
    },
    alwaysLoad: true,
    searchHint:
      "Open or focus an app widget/settings panel window by name (summon UI on the user's screen).",
    handler: (args) =>
      Effect.sync(() => {
        const result = summoner.open(args.kind)
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
