// skills-panel.jsx — the Skills settings section (PRD Part B §12), ported
// from packages/ui-shared-solid/src/SkillsPanel.tsx to React idiom.
//
// Toggle · filter · search over the server-authored skill catalog:
//   - search: client-side full-text over name / description / tags
//   - filter chips: category, source, enabled-only — pure client state
//   - toggle: optimistic UI is deliberately NOT used; the row flips when
//     the server confirms (skill-status ok -> reducer updates state.skills).
//     The registry snapshot is synchronous server-side, so the round-trip
//     is fast enough that honest state beats optimistic complexity.
//
// Catalog rows are metadata-only by wire construction (no bodies, no
// secrets) — nothing here renders anything that isn't already safe to show.
//
// Gate rendering on `capabilities.skills` at the call site (see the
// integration spec returned alongside this file) — this component assumes
// the server supports the frames.
import React, { useMemo, useState } from "react";

const SOURCE_FILTERS = ["all", "builtin", "user"];

/**
 * @param {{
 *   skills: ReadonlyArray<import("@luna/ui-shared").SkillCatalogItem>,
 *   onToggle: (id: string, enabled: boolean) => void,
 *   disabled?: boolean,
 *   lastError?: string | null,
 * }} props
 */
export function SkillsPanel(props) {
  const skills = props.skills || [];
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [source, setSource] = useState("all");
  const [enabledOnly, setEnabledOnly] = useState(false);

  const categories = useMemo(() => {
    const set = new Set();
    for (const s of skills) set.add(s.category);
    return ["all", ...Array.from(set).sort()];
  }, [skills]);

  // A catalog refresh can remove the actively-filtered category (user skill
  // deleted on disk), leaving a filter no chip can represent and an
  // unexplained empty list. Resolve the EFFECTIVE category at read time — a
  // vanished selection falls back to "all".
  const activeCategory = categories.includes(category) ? category : "all";

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (activeCategory !== "all" && s.category !== activeCategory) return false;
      if (source !== "all" && s.source !== source) return false;
      if (enabledOnly && !s.enabled) return false;
      if (q.length === 0) return true;
      const hay = `${s.name} ${s.description} ${s.tags.join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }, [skills, activeCategory, source, enabledOnly, query]);

  const enabledCount = useMemo(() => skills.filter((s) => s.enabled).length, [skills]);

  return (
    <div className="skills-panel">
      <div className="skills-head">
        <span className="skills-title">
          Skills{" "}
          <span className="skills-count">
            {enabledCount}/{skills.length} enabled
          </span>
        </span>
        <input
          className="skills-search"
          type="search"
          placeholder="Search skills…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="skills-chips">
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            className={"skills-chip" + (activeCategory === c ? " on" : "")}
            aria-pressed={activeCategory === c}
            onClick={() => setCategory(c)}
          >
            {c}
          </button>
        ))}
        <span className="skills-chip-sep" />
        {SOURCE_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            className={"skills-chip" + (source === s ? " on" : "")}
            aria-pressed={source === s}
            onClick={() => setSource(s)}
          >
            {s === "all" ? "any source" : s}
          </button>
        ))}
        <button
          type="button"
          className={"skills-chip" + (enabledOnly ? " on" : "")}
          aria-pressed={enabledOnly}
          onClick={() => setEnabledOnly((v) => !v)}
        >
          enabled only
        </button>
      </div>
      {props.lastError && (
        <div className="skills-error" role="alert">
          {props.lastError}
        </div>
      )}
      <div className="skills-list">
        {visible.length === 0 ? (
          <div className="skills-empty">No skills match.</div>
        ) : (
          visible.map((s) => (
            <div key={s.id} className={"skill-row" + (s.enabled ? "" : " off")}>
              <div className="skill-meta">
                <span className="skill-name">
                  {s.name} <code className="skill-id">{s.id}</code>
                  <span className={`skill-badge src-${s.source}`}>{s.source}</span>
                  <span className="skill-badge cat">{s.category}</span>
                </span>
                <span className="skill-desc">{s.description}</span>
              </div>
              <label className="toggle skill-toggle" title={s.enabled ? "Disable" : "Enable"}>
                <input
                  type="checkbox"
                  checked={s.enabled}
                  disabled={props.disabled === true}
                  onChange={(e) => {
                    // No optimistic UI: a native checkbox flips its own DOM
                    // before onChange fires. Revert the DOM immediately and
                    // let the server's confirmed skill-status/skill-catalog
                    // drive the input via the `checked` prop above — on a
                    // failed toggle only skillError changes, so nothing else
                    // would re-sync it.
                    e.target.checked = s.enabled;
                    props.onToggle(s.id, !s.enabled);
                  }}
                />
                <span>{s.enabled ? "on" : "off"}</span>
              </label>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
