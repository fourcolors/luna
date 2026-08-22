/**
 * LauncherPanel.tsx — Cmd+K quick-launcher palette.
 *
 * Two data sources merged into one flat, keyboard-navigable list:
 *   (a) System panels  — derived immediately from widget-registry.json via
 *       fetch('/vendor/widget-registry.json'). Rendered before WS connects so
 *       the palette is useful even offline. Kinds in EXCLUDED_KINDS are omitted
 *       because they require params ({jobId}/{thread}) and have no sensible
 *       paramless launch. Row action: ctx.invoke('open_widget', { kind }).
 *
 *   (b) Pinned artifacts — all kinds (widget, mcp-app, code, markdown, html).
 *       Loaded via the shared MoonStore + WS connection (same pattern as
 *       SettingsAppsPanel). Gated on hello's capabilities.artifacts; if absent,
 *       the artifacts section is simply hidden rather than blanking the whole
 *       panel. Row action: ctx.invoke('open_artifact_widget', { artifactId, title }).
 *
 * Interaction contract:
 *   - Single autofocused text input; substring filter (case-insensitive) over
 *     title + description + kind.
 *   - ArrowUp/ArrowDown navigate a highlight index; Enter activates; clicking
 *     also activates. Typing resets highlight to 0.
 *   - Esc, window blur, and any successful activation → close_widget.
 *   - NEVER hide instead of close: lifecycle.rs re-shows hidden dock windows.
 *
 * State model: pinnedArtifacts from the shared MoonStore reducer (same approach
 * SettingsAppsPanel.tsx uses). Panel-local state (query, highlightIndex,
 * registry rows) stays in plain useState — no server representation.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from "react"
import type { PinnedArtifactItem } from "@luna/ui-shared/core"
import { initialState } from "@luna/ui-shared/core"
import { createMoonStore, useMoonSelector } from "../../state/store"
import type { LunaFrameRegistry, PanelCtx } from "../panel-ctx"
import "./LauncherPanel.css"

// ── Excluded panel kinds ──────────────────────────────────────────────────────
// These three require params at open time and have no sensible paramless launch.
// Derived from a named const so new paramless-safe kinds appear for free.
const EXCLUDED_KINDS = new Set(["launcher", "flow", "agents", "actions"])

// ── Registry row type ─────────────────────────────────────────────────────────
interface RegistryWidget {
  kind: string
  title: string
  description?: string
  page?: string
}

// ── Unified list item ─────────────────────────────────────────────────────────
type LauncherSection = "panel" | "artifact"

interface LauncherItem {
  id: string          // kind for panels; artifactId for artifacts
  title: string
  badge: string       // kind badge text
  description: string
  section: LauncherSection
  artifactTitle?: string // only set for artifacts (for the invoke call)
}

declare global {
  interface Window {
    LunaWS?: {
      createFrameRegistry: () => LunaFrameRegistry
    }
  }
}

export interface LauncherPanelProps {
  readonly ctx: PanelCtx
}

/** Case-insensitive substring match over title + description + badge (kind). */
function matchesQuery(item: LauncherItem, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    item.title.toLowerCase().includes(q) ||
    item.description.toLowerCase().includes(q) ||
    item.badge.toLowerCase().includes(q)
  )
}

export function LauncherPanel({ ctx }: LauncherPanelProps) {
  // ── Shared store for artifact state (same pattern as SettingsAppsPanel) ──
  const storeRef = useRef<ReturnType<typeof createMoonStore> | null>(null)
  if (storeRef.current === null) storeRef.current = createMoonStore()
  const store = storeRef.current

  // null = hello not yet received; boolean = server's advertised capability.
  const artifactsCapable = useMoonSelector(store, (s) =>
    s.capabilities === initialState.capabilities ? null : !!s.capabilities.artifacts,
  )
  const pinnedArtifacts = useMoonSelector(
    store,
    (s) => s.pinnedArtifacts as ReadonlyArray<PinnedArtifactItem>,
  )

  // ── Registry rows (system panels) ────────────────────────────────────────
  const [registryWidgets, setRegistryWidgets] = useState<RegistryWidget[]>([])

  useEffect(() => {
    // `alive` guards against the classic unmount race: the panel closes (Esc,
    // blur, or an activation) while this fetch is still in flight, the promise
    // then resolves against a torn-down tree and React schedules work on a
    // component that no longer exists. In the app that is a warning; under
    // vitest the deferred work outlives the jsdom environment and surfaces as
    // an "Uncaught ReferenceError: window is not defined" attributed to
    // whichever test file happens to be running, failing CI with zero failed
    // tests. A launcher is dismissed fast and often, so this race is the
    // normal path here, not an edge case.
    let alive = true
    fetch("/vendor/widget-registry.json")
      .then((r) => r.json())
      .then((data: { widgets: RegistryWidget[] }) => {
        if (!alive) return
        setRegistryWidgets(
          // EXCLUDED_KINDS is the ONLY filter on purpose. An earlier cut also
          // required page.startsWith("panel.html"), which silently dropped
          // `chat` (page: chat.html) - the single most useful thing to launch.
          // Filtering by page shape would keep re-introducing that class of bug
          // as new non-panel pages land; filter by kind and nothing else.
          (data.widgets || []).filter((w) => !EXCLUDED_KINDS.has(w.kind)),
        )
      })
      .catch(() => {
        // Offline or test env — registry stays empty, artifacts-only view.
      })
    return () => {
      alive = false
    }
  }, [])

  // ── WebSocket connection (artifact list) ─────────────────────────────────
  const clientRef = useRef<ReturnType<NonNullable<PanelCtx["connectWs"]>> | null>(null)

  useEffect(() => {
    const lunaWs = window.LunaWS
    if (!ctx.connectWs || !lunaWs) return

    const registry = lunaWs.createFrameRegistry()
    registry.register("hello", (frame: any) => store.dispatch(frame))
    registry.register("artifact-list", (frame: any) => store.dispatch(frame))
    registry.register("artifact-update", (frame: any) => store.dispatch(frame))

    const client = ctx.connectWs(registry, { autoPong: true })
    clientRef.current = client

    return () => {
      client.close()
      clientRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ctx/store are stable per-mount
  }, [])

  // ── Merged, filtered item list ────────────────────────────────────────────
  const panelItems: LauncherItem[] = useMemo(
    () =>
      registryWidgets.map((w) => ({
        id: w.kind,
        title: w.title,
        badge: w.kind,
        description: w.description ?? "",
        section: "panel" as const,
      })),
    [registryWidgets],
  )

  const artifactItems: LauncherItem[] = useMemo(
    () =>
      pinnedArtifacts.map((a) => ({
        id: a.id,
        title: a.title,
        badge: a.kind,
        description: "",
        section: "artifact" as const,
        artifactTitle: a.title,
      })),
    [pinnedArtifacts],
  )

  // ── Search / navigation state ─────────────────────────────────────────────
  const [query, setQuery] = useState("")
  const [highlightIndex, setHighlightIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const filteredPanels = useMemo(
    () => panelItems.filter((i) => matchesQuery(i, query)),
    [panelItems, query],
  )

  const filteredArtifacts = useMemo(
    () =>
      // Only show artifacts section when capability is confirmed
      artifactsCapable === true
        ? artifactItems.filter((i) => matchesQuery(i, query))
        : [],
    [artifactItems, artifactsCapable, query],
  )

  // One flat keyboard-navigable list (panels first, then artifacts).
  const allItems = useMemo(
    () => [...filteredPanels, ...filteredArtifacts],
    [filteredPanels, filteredArtifacts],
  )

  // The highlight is reset to 0 on every keystroke by handleQueryChange; this
  // clamp covers the other way the list can shrink under it - an `artifact-list`
  // frame landing while the palette is already open.
  const clampedHighlight = Math.max(0, Math.min(highlightIndex, allItems.length - 1))

  // ── Close helper ─────────────────────────────────────────────────────────
  const close = useCallback(() => {
    if (ctx.label) {
      ;(ctx.invoke("close_widget", { label: ctx.label }) as Promise<unknown>).catch(() => {})
    }
  }, [ctx])

  // ── Activation ───────────────────────────────────────────────────────────
  const activate = useCallback(
    (item: LauncherItem) => {
      if (item.section === "panel") {
        ctx.invoke("open_widget", { kind: item.id }).catch(() => {})
      } else {
        ctx
          .invoke("open_artifact_widget", {
            artifactId: item.id,
            title: item.artifactTitle ?? item.title,
          })
          .catch(() => {})
      }
      close()
    },
    [ctx, close],
  )

  // ── Keyboard handler ──────────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault()
        close()
        return
      }
      // Both arrows step from clampedHighlight, NOT the raw highlightIndex.
      // An `artifact-list` frame can shrink the list under a stale-high index
      // while the palette is open; stepping from the raw value would wrap to 0
      // instead of advancing, costing the user a wasted keypress.
      if (e.key === "ArrowDown") {
        e.preventDefault()
        if (allItems.length === 0) return
        setHighlightIndex((clampedHighlight + 1) % allItems.length)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        if (allItems.length === 0) return
        setHighlightIndex((clampedHighlight - 1 + allItems.length) % allItems.length)
        return
      }
      if (e.key === "Enter") {
        e.preventDefault()
        const item = allItems[clampedHighlight]
        if (item) activate(item)
        return
      }
    },
    [allItems, clampedHighlight, activate, close],
  )

  // ── Window blur → close ───────────────────────────────────────────────────
  useEffect(() => {
    const handleBlur = () => close()
    window.addEventListener("blur", handleBlur)
    return () => window.removeEventListener("blur", handleBlur)
  }, [close])

  // ── Autofocus on mount ────────────────────────────────────────────────────
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // ── Keep the highlighted row visible ──────────────────────────────────────
  // ~16 panels plus artifacts overflow a 420px window, so arrowing past the
  // fold would otherwise move an invisible highlight. Queried rather than
  // ref-threaded so both section maps stay untouched. scrollIntoView is absent
  // in jsdom, hence the capability check.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const active = listRef.current?.querySelector(".launcher-row--active")
    if (active && typeof (active as HTMLElement).scrollIntoView === "function") {
      ;(active as HTMLElement).scrollIntoView({ block: "nearest" })
    }
  }, [clampedHighlight, allItems.length])

  // ── Query change: reset highlight ─────────────────────────────────────────
  const handleQueryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value)
    setHighlightIndex(0)
  }, [])

  // ── Render ────────────────────────────────────────────────────────────────
  const hasResults = allItems.length > 0

  // Flat index offset so we can compute per-section index in one pass.
  const panelCount = filteredPanels.length

  return (
    <div className="moon-astryx-root launcher-panel" data-testid="launcher-panel">
      <div className="launcher-search-wrap">
        <span className="launcher-search-icon" aria-hidden="true">⌘</span>
        <input
          ref={inputRef}
          className="launcher-search-input"
          type="text"
          placeholder="Search panels and apps…"
          value={query}
          onChange={handleQueryChange}
          onKeyDown={handleKeyDown}
          data-testid="launcher-search"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div ref={listRef} className="launcher-list" role="listbox" aria-label="Launcher results">
        {!hasResults && (
          <div className="launcher-empty" data-testid="launcher-empty">
            {query ? "No matches" : "No panels available"}
          </div>
        )}

        {filteredPanels.length > 0 && (
          <>
            <div className="launcher-section-label">Panels</div>
            {filteredPanels.map((item, localIdx) => {
              const flatIdx = localIdx
              const isActive = flatIdx === clampedHighlight
              return (
                <div
                  key={item.id}
                  role="option"
                  aria-selected={isActive}
                  className={`launcher-row${isActive ? " launcher-row--active" : ""}`}
                  data-testid={`launcher-row-${item.id}`}
                  onClick={() => activate(item)}
                >
                  <span className="launcher-row-badge">{item.badge}</span>
                  <div className="launcher-row-info">
                    <div className="launcher-row-title">{item.title}</div>
                    {item.description && (
                      <div className="launcher-row-desc">{item.description}</div>
                    )}
                  </div>
                </div>
              )
            })}
          </>
        )}

        {filteredArtifacts.length > 0 && (
          <>
            <div className="launcher-section-label">Your apps</div>
            {filteredArtifacts.map((item, localIdx) => {
              const flatIdx = panelCount + localIdx
              const isActive = flatIdx === clampedHighlight
              return (
                <div
                  key={item.id}
                  role="option"
                  aria-selected={isActive}
                  className={`launcher-row${isActive ? " launcher-row--active" : ""}`}
                  data-testid={`launcher-row-${item.id}`}
                  onClick={() => activate(item)}
                >
                  <span className="launcher-row-badge">{item.badge}</span>
                  <div className="launcher-row-info">
                    <div className="launcher-row-title">{item.title}</div>
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}
