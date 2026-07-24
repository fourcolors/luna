/**
 * SettingsAppsPanel.tsx — React 19 + Astryx port of frontend/panels/settings-apps.js
 * (the Apps settings panel, PRD Part C §13): install/list/configure MCP-app
 * and widget artifacts.
 *
 * Behavioral contract ported 1:1 from the vanilla module (see the deleted
 * frontend/panels/settings-apps.js and its covering test,
 * test/panel-apps.test.ts, ported to test/panel-apps-react.test.ts):
 *   - Connects via ctx.connectWs (the same invoke/connect plumbing every
 *     still-vanilla panels/*.js module uses — see src/panels/panel-ctx.ts)
 *     and gates on the hello frame's `artifacts` capability.
 *   - hello without capabilities.artifacts → replaces the whole panel with a
 *     "doesn't support apps" notice.
 *   - artifact-list is filtered to kind === 'mcp-app' || kind === 'widget'
 *     (markdown/code/html pins are a different surface — the artifacts
 *     panel, not this one).
 *   - Open sends ctx.invoke('open_artifact_widget', { artifactId, title }),
 *     swallowing rejection (off-Tauri / no-op).
 *   - Delete sends { type: 'artifact-unpin', id }.
 *   - Save (create mode) generates a unique `kind:slug(title)` id (appending
 *     `-2`, `-3`, ... on collision) and sends artifact-pin.
 *   - Save (edit mode, entered via the Edit button) sends artifact-edit
 *     (content only) for the SAME id — never unpin+re-pin, which would
 *     destroy the version ledger and reset the widget's bridgeCaps. Title
 *     and kind are locked while editing for exactly that reason (rename =
 *     delete + re-create, or ask Luna to iterate).
 *
 * State model: unlike the vanilla module's hand-rolled `artifacts` variable +
 * imperative re-render, this dispatches every inbound frame into the SAME
 * shared reducer ui-web already relies on (@luna/ui-shared/core —
 * UIState.capabilities.artifacts / UIState.pinnedArtifacts, already modeled
 * for exactly this PRD slice) and reads it back out via useMoonSelector
 * (useSyncExternalStore underneath) — mirrors FlowPanel.tsx's identical
 * conversion. The WS registry callbacks below only ever call
 * `store.dispatch(frame)` or send a request — never touch the DOM directly;
 * React re-renders from the store subscription, per the conversion's
 * state-ownership rule. The composer's own draft fields (title/content/kind/
 * editTarget) are local, ephemeral UI state with no server representation —
 * exactly like SettingsGeneralPanel's local settings — so plain useState is
 * the right tool there, not the store.
 *
 * "Has hello arrived yet?" isn't a boolean the shared reducer tracks
 * explicitly; it identifies "not connected yet" by comparing the selected
 * capabilities object against @luna/ui-shared's own `initialState.capabilities`
 * by reference — the reducer always swaps in a brand-new object from the wire
 * on every hello, so this equality can only hold before the first one lands.
 * That keeps the distinction store-only (no parallel "have we connected"
 * useState) between the vanilla module's three renders: waiting-for-data,
 * gated-off, and live.
 *
 * Astryx mapping: TextInput (title) / TextArea (content) / Button (Open,
 * Edit, Delete, Save) / Badge (kind chip) are clean 1:1 mappings — each is a
 * controlled field or a plain synchronous action trigger with no nested
 * interactive children. The Kind picker stays a native <select>: Astryx's
 * Selector is a popover-based combobox (needs the Popover API / floating
 * positioning), not a drop-in for a native select, and this app's test
 * harness has no testing-library/jsdom popover shims to drive it — the exact
 * call apps/ui-web's settings-panel.jsx makes for its Model dropdown, and
 * FlowPanel.tsx's sibling conversion for its status chips. The list rows and
 * composer container stay hand-rolled div markup, same call
 * artifacts-panel.jsx (ui-web) makes for its own rows: Astryx has no
 * equivalent that produces this DOM shape (a row hosting several nested
 * interactive Buttons), and forcing a Card/ClickableCard here would fork
 * `.app-row` styling for a shape it isn't built for.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { ArtifactKind, PinnedArtifactItem } from "@luna/ui-shared/core"
import { initialState } from "@luna/ui-shared/core"
import { createMoonStore, useMoonSelector } from "../state/store"
import { Badge, Button, TextArea, TextInput } from "../astryx-kit"
import type { LunaFrameRegistry, PanelCtx } from "./panel-ctx"
import "./SettingsAppsPanel.css"

declare global {
  interface Window {
    __panelCtx?: PanelCtx
    LunaWS?: {
      createFrameRegistry: () => LunaFrameRegistry
    }
  }
}

export interface SettingsAppsPanelProps {
  readonly ctx: PanelCtx
}

const KIND_OPTIONS: ReadonlyArray<{ value: ArtifactKind; label: string }> = [
  { value: "mcp-app", label: "MCP app" },
  { value: "widget", label: "Widget" },
]

const CONTENT_PLACEHOLDER = [
  "HTML content for the app.",
  'MCP app: use window.mcp.call("pulse") or window.mcp.call("list-artifacts") to talk to Luna.',
  'Widget: use window.luna.subscribe("chat", fn) to receive live data.',
].join("\n")

/** Build a slug from a title string. Ported verbatim from settings-apps.js. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

/** Generate a unique id for a new artifact of a given kind + title. Ported
 *  verbatim from settings-apps.js. */
function uniqueId(kind: string, title: string, artifacts: ReadonlyArray<PinnedArtifactItem>): string {
  const base = kind + ":" + slugify(title)
  const existing = artifacts.map((a) => a.id)
  if (!existing.includes(base)) return base
  let n = 2
  while (existing.includes(base + "-" + n)) n++
  return base + "-" + n
}

function kindBadge(kind: ArtifactKind): string {
  return kind === "mcp-app" ? "app" : "widget"
}

export function SettingsAppsPanel({ ctx }: SettingsAppsPanelProps) {
  // One store per mounted panel instance (each Moon panel window is its own
  // document/JS realm — see boot.tsx's / FlowPanel.tsx's identical per-mount
  // rationale).
  const storeRef = useRef<ReturnType<typeof createMoonStore> | null>(null)
  if (storeRef.current === null) storeRef.current = createMoonStore()
  const store = storeRef.current

  // null = no hello frame received yet; boolean = the server's advertised
  // `artifacts` capability from the most recent hello. See the module doc.
  const artifactsCapable = useMoonSelector(store, (s) =>
    s.capabilities === initialState.capabilities ? null : !!s.capabilities.artifacts,
  )
  const pinnedArtifacts = useMoonSelector(
    store,
    (s) => s.pinnedArtifacts as ReadonlyArray<PinnedArtifactItem>,
  )
  const apps = useMemo(
    () => pinnedArtifacts.filter((a) => a.kind === "mcp-app" || a.kind === "widget"),
    [pinnedArtifacts],
  )

  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [kind, setKind] = useState<ArtifactKind>("mcp-app")
  const [editTarget, setEditTarget] = useState<string | null>(null)
  const isEditing = editTarget !== null

  const clientRef = useRef<ReturnType<NonNullable<PanelCtx["connectWs"]>> | null>(null)

  useEffect(() => {
    const lunaWs = window.LunaWS
    if (!ctx.connectWs || !lunaWs) return

    const registry = lunaWs.createFrameRegistry()
    registry.register("hello", (frame: any) => store.dispatch(frame))
    registry.register("artifact-list", (frame: any) => store.dispatch(frame))

    const client = ctx.connectWs(registry, { autoPong: true })
    clientRef.current = client

    return () => {
      client.close()
      clientRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ctx/store are stable per-mount
  }, [])

  function clearComposer(): void {
    setTitle("")
    setContent("")
    setKind("mcp-app")
    setEditTarget(null)
  }

  function handleEdit(a: PinnedArtifactItem): void {
    // Edit changes CONTENT only (store.update preserves title/kind/caps + the
    // version ledger). Lock title + kind so the UI doesn't imply they can
    // change here — rename = delete + re-create, or ask Luna to iterate.
    setTitle(a.title)
    setContent(a.content)
    setKind(a.kind)
    setEditTarget(a.id)
  }

  function handleOpen(a: PinnedArtifactItem): void {
    ctx.invoke("open_artifact_widget", { artifactId: a.id, title: a.title }).catch(() => {})
  }

  function handleDelete(a: PinnedArtifactItem): void {
    clientRef.current?.send({ type: "artifact-unpin", id: a.id })
  }

  function handleSave(): void {
    const trimmedTitle = title.trim()
    if (!trimmedTitle || !content) return
    if (!clientRef.current) return

    if (editTarget) {
      clientRef.current.send({ type: "artifact-edit", id: editTarget, content })
      clearComposer()
    } else {
      const newId = uniqueId(kind, trimmedTitle, pinnedArtifacts)
      clientRef.current.send({
        type: "artifact-pin",
        id: newId,
        title: trimmedTitle,
        content,
        kind,
      })
      clearComposer()
    }
  }

  if (artifactsCapable === false) {
    return <div className="notice">This server doesn&apos;t support apps.</div>
  }

  return (
    <div className="moon-astryx-root settings-apps-panel" data-testid="settings-apps-panel">
      <div className="apps-heading">
        <span className="apps-heading-label">Apps</span>
        <span className="apps-count" id="apps-count">
          {apps.length ? "· " + apps.length : ""}
        </span>
      </div>

      <div className="apps-list" id="apps-list">
        {pinnedArtifacts.length === 0 ? (
          <span className="apps-empty">Your apps appear here once Luna connects.</span>
        ) : apps.length === 0 ? (
          <span className="apps-empty">No apps yet — create one below.</span>
        ) : (
          apps.map((a) => (
            <div className="app-row" key={a.id} data-testid={`app-row-${a.id}`}>
              <div className="app-row-info">
                <div className="app-row-name">
                  <Badge className="app-kind-badge" variant="neutral" label={kindBadge(a.kind)} />
                  <span>{a.title}</span>
                  <span className="app-version">· v{a.version}</span>
                </div>
              </div>
              <div className="app-row-actions">
                <Button label="Open" className="app-btn" onClick={() => handleOpen(a)} />
                <Button label="Edit" className="app-btn" onClick={() => handleEdit(a)} />
                <Button label="Delete" className="app-btn delete" onClick={() => handleDelete(a)} />
              </div>
            </div>
          ))
        )}
      </div>

      <div className="apps-composer">
        <div className="apps-composer-title">{isEditing ? "Edit app" : "Create app"}</div>
        {isEditing && (
          <span className="apps-edit-label" id="apps-edit-label">
            Editing
          </span>
        )}

        <TextInput
          label="Title"
          isLabelHidden
          placeholder="Title"
          value={title}
          isDisabled={isEditing}
          onChange={setTitle}
          data-testid="apps-title-input"
        />

        <TextArea
          label="Content"
          isLabelHidden
          placeholder={CONTENT_PLACEHOLDER}
          value={content}
          rows={5}
          onChange={setContent}
          data-testid="apps-content-input"
        />

        <select
          className="apps-select"
          value={kind}
          disabled={isEditing}
          onChange={(e) => setKind(e.target.value as ArtifactKind)}
          data-testid="apps-kind-select"
        >
          {KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <Button label="Save" className="apps-save-btn" onClick={handleSave} data-testid="apps-save-btn" />
      </div>
    </div>
  )
}
