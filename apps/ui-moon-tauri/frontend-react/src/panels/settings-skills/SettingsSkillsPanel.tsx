/**
 * SettingsSkillsPanel.tsx - React/Astryx port of
 * apps/ui-moon-tauri/frontend/panels/settings-skills.js (registered there as
 * `LunaPanelTypes['settings.skills']`, PRD Part B §12).
 *
 * WS-backed: connects via ctx.connectWs, gates on the hello frame's
 * `capabilities.skills` flag, renders the server's skill catalog as toggle
 * rows with client-side search + category/source/enabled-only filter chips.
 * Faithfully ports SkillsEngine's behavior; the presentation layer moves
 * from hand-rolled DOM (watercolor "blot" divs, role="switch" rows) onto
 * real Astryx primitives:
 *   - TextInput for search, ToggleButton (standalone, not ToggleButtonGroup -
 *     see apps/ui-web/src/studio/skills-panel.jsx's module doc for why the
 *     group's single-select-with-deselect semantics are wrong here) for the
 *     filter chips, Badge for the source/category tags.
 *   - Switch (real role="switch" input, keyboard-native) replaces the
 *     vanilla row's hand-rolled role="switch"/tabIndex/keydown handling -
 *     strictly better accessibility for the same "flip one skill" action.
 *     Its `isLoading` prop maps to Astryx's own `aria-busy` + spinner, so
 *     the in-flight-toggle "pending" state (this module's local `pending`
 *     record, mirroring the vanilla `skillsPending` object) needs no manual
 *     ARIA wiring.
 *
 * STATE SOURCE: `skills` and `skillError` are shared domain state - read via
 * useMoonSelector off the store (see ../../state/store.ts) exactly like the
 * boot-layer scaffold proved out. This module's `reduce()` case already
 * exists (packages/ui-shared/src/reducer.ts's "skill-catalog"/"skill-status"
 * cases, covered by packages/ui-shared/src/skills.reducer.test.ts) - no
 * reducer changes were needed for this conversion.
 *
 * `pending` (in-flight toggle ids), `notice` (post-hello capability gate),
 * and the search/filter fields are local, panel-only UI state with no
 * representation in the shared reducer - same rationale
 * SettingsGeneralPanel.tsx documents for its own local state.
 *
 * CRITICAL: the WS frame registry handlers below only ever call
 * `store.dispatch(frame)` (shared state) or a React state setter (local
 * state) - never touch the DOM directly. This is what keeps state flowing
 * through the useSyncExternalStore-backed store/React render cycle instead
 * of the vanilla module's direct DOM pokes from transport callbacks.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { Action } from "@luna/ui-shared/core"
import { Badge, Switch, TextInput, ToggleButton } from "../../astryx-kit"
import { useMoonSelector, useMoonStore } from "../../state/store"
import type { PanelCtx } from "../panel-ctx"
import "./settings-skills.css"

export const SETTINGS_SKILLS_TITLE = "Skills"

const NOT_LISTED_NOTICE = "This server doesn't list skills."

type SourceFilter = "all" | "builtin" | "user"

/** Read a hello frame's `capabilities.skills` flag - mirrors
 *  vendor/moon-protocol.js's parseHelloCapabilities: absent/falsy on older
 *  servers coerces to false (fail-closed), never throws on a malformed frame. */
function helloHasSkills(frame: unknown): boolean {
  const f = frame as { capabilities?: { skills?: unknown } } | null | undefined
  return !!(f && f.capabilities && f.capabilities.skills)
}

export function SettingsSkillsPanel({ ctx }: { ctx: PanelCtx }) {
  const store = useMoonStore()
  const skills = useMoonSelector(store, (s) => s.skills)
  const skillError = useMoonSelector(store, (s) => s.skillError)

  const [query, setQuery] = useState("")
  const [category, setCategory] = useState("all")
  const [source, setSource] = useState<SourceFilter>("all")
  const [enabledOnly, setEnabledOnly] = useState(false)
  const [pending, setPending] = useState<Record<string, boolean>>({})
  // null = show controls (either not connected yet, or hello confirmed the
  // skills capability). Non-null = hello arrived WITHOUT the capability;
  // replace the whole panel with this notice, exactly like the vanilla
  // module's `el.replaceChildren(notice)`.
  const [notice, setNotice] = useState<string | null>(null)

  // Mirrors `pending` synchronously so the toggle guard (and the
  // skill-catalog "settle" pass) never reads a stale closure - the same
  // reason the vanilla module kept `skillsPending` as a plain outer-scope
  // object instead of relying on a callback's captured snapshot.
  const pendingRef = useRef<Record<string, boolean>>({})
  const wsClientRef = useRef<ReturnType<NonNullable<PanelCtx["connectWs"]>> | null>(null)

  useEffect(() => {
    if (!ctx.connectWs || !window.LunaWS) return
    const registry = window.LunaWS.createFrameRegistry()

    registry.register("hello", (frame) => {
      store.dispatch(frame as Action)
      pendingRef.current = {}
      setPending({})
      setNotice(helloHasSkills(frame) ? null : NOT_LISTED_NOTICE)
    })

    registry.register("skill-catalog", (frame) => {
      store.dispatch(frame as Action)
      const incoming = (frame as { skills?: ReadonlyArray<{ id: string; enabled: boolean }> }).skills
      const fresh = Array.isArray(incoming) ? incoming : []
      // Settle only confirmed in-flight toggles (preserves a concurrent
      // second toggle's pending state) - mirrors the vanilla applyCatalog.
      const settled: Record<string, boolean> = {}
      for (const id of Object.keys(pendingRef.current)) {
        const desired = pendingRef.current[id]
        const row = fresh.find((s) => s.id === id)
        if (row && desired !== undefined && row.enabled !== desired) settled[id] = desired
      }
      pendingRef.current = settled
      setPending(settled)
    })

    registry.register("skill-status", (frame) => {
      const f = frame as { id?: unknown }
      if (typeof f.id !== "string") return
      const next = { ...pendingRef.current }
      delete next[f.id]
      pendingRef.current = next
      setPending(next)
      store.dispatch(frame as Action)
    })

    const client = ctx.connectWs(registry, { autoPong: true })
    wsClientRef.current = client
    return () => {
      client.close()
      wsClientRef.current = null
    }
    // ctx/store are stable for the lifetime of this panel window (one
    // connection per mount, matching the vanilla module's single
    // `ctx.connectWs` call in `render()`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const doToggle = useCallback(
    (id: string, nextEnabled: boolean) => {
      if (id in pendingRef.current) return
      const next = { ...pendingRef.current, [id]: nextEnabled }
      pendingRef.current = next
      setPending(next)
      wsClientRef.current?.send({ type: "skill-toggle", id, enabled: nextEnabled })
    },
    [],
  )

  if (notice !== null) {
    return (
      <div className="moon-astryx-root settings-skills-panel" data-testid="settings-skills-panel">
        <div className="notice" data-testid="skills-notice">
          {notice}
        </div>
      </div>
    )
  }

  const categories = ["all", ...Array.from(new Set(skills.map((s) => s.category))).sort()]
  const activeCategory = categories.includes(category) ? category : "all"

  const visible = skills.filter((s) => {
    if (activeCategory !== "all" && s.category !== activeCategory) return false
    if (source !== "all" && s.source !== source) return false
    if (enabledOnly && !s.enabled) return false
    const q = query.trim().toLowerCase()
    if (!q) return true
    const hay = `${s.name} ${s.description} ${(s.tags ?? []).join(" ")}`.toLowerCase()
    return hay.includes(q)
  })

  const enabledCount = skills.filter((s) => s.enabled).length

  return (
    <div className="moon-astryx-root settings-skills-panel" data-testid="settings-skills-panel">
      <div className="skills-head">
        <span className="skills-title">Skills</span>
        <span className="skills-count" data-testid="skills-count">
          {skills.length > 0 ? `· ${enabledCount}/${skills.length} on` : ""}
        </span>
      </div>

      <TextInput
        label="Search skills"
        isLabelHidden
        size="sm"
        placeholder="Search skills…"
        value={query}
        onChange={(value: string) => setQuery(value)}
        hasClear
        data-testid="skills-search-input"
      />

      <div className="skills-chips" data-testid="skills-chips">
        {categories.map((c) => (
          <ToggleButton
            key={c}
            label={c}
            size="sm"
            isPressed={activeCategory === c}
            onPressedChange={() => setCategory(c)}
          />
        ))}
        <ToggleButton
          label="built-in"
          size="sm"
          isPressed={source === "builtin"}
          onPressedChange={() => setSource(source === "builtin" ? "all" : "builtin")}
        />
        <ToggleButton
          label="yours"
          size="sm"
          isPressed={source === "user"}
          onPressedChange={() => setSource(source === "user" ? "all" : "user")}
        />
        <ToggleButton
          label="enabled only"
          size="sm"
          isPressed={enabledOnly}
          onPressedChange={(pressed: boolean) => setEnabledOnly(pressed)}
        />
      </div>

      {skillError && (
        <div className="skills-error-line" role="alert" data-testid="skills-error">
          {skillError}
        </div>
      )}

      <div className="sp-skills-list" data-testid="skills-list">
        {visible.length === 0 ? (
          <span className="skills-empty">
            {skills.length
              ? "No skills match."
              : "Not connected — skills appear when the server sends its catalog."}
          </span>
        ) : (
          visible.map((s) => (
            <div
              key={s.id}
              className={"skill-row" + (s.enabled ? "" : " off")}
              data-testid={`skill-row-${s.id}`}
            >
              <div className="skill-row-info">
                <span className="skill-row-name">
                  {s.name}
                  <Badge
                    variant={s.source === "user" ? "info" : "neutral"}
                    label={s.source === "user" ? "yours" : s.source}
                  />
                  <Badge variant="neutral" label={s.category} />
                </span>
                <span className="skill-row-desc">{s.description}</span>
              </div>
              <Switch
                label={s.enabled ? `Disable ${s.name}` : `Enable ${s.name}`}
                isLabelHidden
                value={s.enabled}
                isLoading={s.id in pending}
                onChange={(checked: boolean) => doToggle(s.id, checked)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  )
}
