/**
 * SkillsPanel — the Skills settings section (PRD Part B §12).
 *
 * Toggle · filter · search over the server-authored skill catalog:
 *   - search: client-side full-text over name / description / tags
 *   - filter chips: category, source, enabled-only — pure client state
 *   - toggle: optimistic UI is deliberately NOT used; the row flips when
 *     the server confirms (skill-status ok → reducer updates state.skills).
 *     The registry snapshot is synchronous server-side, so the round-trip
 *     is fast enough that honest state beats optimistic complexity.
 *
 * Catalog rows are metadata-only by wire construction (no bodies).
 * Gate rendering on `capabilities.skills` at the call site — this
 * component assumes the server supports the frames.
 */
import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import type { SkillCatalogItem } from "@luna/ui-shared"

export interface SkillsPanelProps {
  readonly skills: ReadonlyArray<SkillCatalogItem>
  readonly onToggle: (id: string, enabled: boolean) => void
  readonly disabled?: boolean
  /** Last toggle failure surfaced by a skill-status ok:false frame. */
  readonly lastError?: string | null
}

type SourceFilter = "all" | "builtin" | "user" | "installed"

export const SkillsPanel: Component<SkillsPanelProps> = (props) => {
  const [query, setQuery] = createSignal("")
  const [category, setCategory] = createSignal<string>("all")
  const [source, setSource] = createSignal<SourceFilter>("all")
  const [enabledOnly, setEnabledOnly] = createSignal(false)

  const categories = createMemo(() => {
    const set = new Set<string>()
    for (const s of props.skills) set.add(s.category)
    return ["all", ...Array.from(set).sort()]
  })

  // Review finding: a catalog refresh can remove the actively-filtered
  // category (user skill deleted on disk), leaving a filter no chip can
  // represent and an unexplained empty list. Resolve the EFFECTIVE
  // category at read time — a vanished selection falls back to "all".
  const activeCategory = createMemo(() =>
    categories().includes(category()) ? category() : "all",
  )

  const visible = createMemo(() => {
    const q = query().trim().toLowerCase()
    return props.skills.filter((s) => {
      if (activeCategory() !== "all" && s.category !== activeCategory()) return false
      if (source() !== "all" && s.source !== source()) return false
      if (enabledOnly() && !s.enabled) return false
      if (q.length === 0) return true
      const hay = `${s.name} ${s.description} ${s.tags.join(" ")}`.toLowerCase()
      return hay.includes(q)
    })
  })

  const enabledCount = createMemo(
    () => props.skills.filter((s) => s.enabled).length,
  )

  return (
    <div class="skills-panel">
      <div class="skills-head">
        <span class="skills-title">
          Skills{" "}
          <span class="skills-count">
            {enabledCount()}/{props.skills.length} enabled
          </span>
        </span>
        <input
          class="skills-search"
          type="search"
          placeholder="Search skills…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </div>
      <div class="skills-chips">
        <For each={categories()}>
          {(c) => (
            <button
              type="button"
              classList={{ "skills-chip": true, on: activeCategory() === c }}
              aria-pressed={activeCategory() === c}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          )}
        </For>
        <span class="skills-chip-sep" />
        <For each={["all", "builtin", "user"] as const}>
          {(s) => (
            <button
              type="button"
              classList={{ "skills-chip": true, on: source() === s }}
              onClick={() => setSource(s)}
            >
              {s === "all" ? "any source" : s}
            </button>
          )}
        </For>
        <button
          type="button"
          classList={{ "skills-chip": true, on: enabledOnly() }}
          onClick={() => setEnabledOnly(!enabledOnly())}
        >
          enabled only
        </button>
      </div>
      <Show when={props.lastError}>
        <div class="skills-error" role="alert">
          {props.lastError}
        </div>
      </Show>
      <div class="skills-list">
        <For
          each={visible()}
          fallback={<div class="skills-empty">No skills match.</div>}
        >
          {(s) => (
            <div classList={{ "skill-row": true, off: !s.enabled }}>
              <div class="skill-meta">
                <span class="skill-name">
                  {s.name} <code class="skill-id">{s.id}</code>
                  <span class={`skill-badge src-${s.source}`}>{s.source}</span>
                  <span class="skill-badge cat">{s.category}</span>
                </span>
                <span class="skill-desc">{s.description}</span>
              </div>
              <label class="toggle skill-toggle" title={s.enabled ? "Disable" : "Enable"}>
                <input
                  type="checkbox"
                  checked={s.enabled}
                  disabled={props.disabled === true}
                  onChange={(e) => {
                    // No optimistic UI: a native checkbox flips its own DOM
                    // before onChange, and Solid's checked={s.enabled} only
                    // re-syncs when the prop CHANGES — which it doesn't on a
                    // failed toggle (skill-status ok:false touches only
                    // skillError). Revert the DOM immediately and let the
                    // server's confirmed state drive the input.
                    e.currentTarget.checked = s.enabled
                    props.onToggle(s.id, !s.enabled)
                  }}
                />
                <span>{s.enabled ? "on" : "off"}</span>
              </label>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
