// skills-panel.jsx — the Skills settings section (PRD Part B §12), ported
// from packages/ui-shared-solid/src/SkillsPanel.tsx to React idiom, then
// migrated onto @astryxdesign/core (feat/astryx-ui pilot).
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
//
// Astryx notes:
//   - Filter chips use standalone `ToggleButton` (not `ToggleButtonGroup`):
//     the group's single-select mode deselects (-> null) on a second click
//     of the already-active button, which would silently fall back to "all"
//     and change behavior. Standalone ToggleButton lets onPressedChange just
//     re-assert the clicked value, exactly like the original onClick.
//   - The enable/disable control uses Astryx `Switch`. Its `value` prop is
//     mirrored through `useOptimistic` internally, but that optimistic path
//     is only armed by a `changeAction` prop — we intentionally pass a plain
//     `onChange` instead, so `checked` stays a pure function of the `value`
//     prop and the control can never visually drift from (or need to be
//     manually snapped back to) confirmed server state. Verified by reading
//     node_modules/@astryxdesign/core Switch.tsx: setOptimisticValue is only
//     called inside the changeAction branch.
//   - `ToggleButton` and `Badge` are fully self-styled (ToggleButton doesn't
//     even forward `className`), so the legacy `.skills-chip` / `.skill-badge`
//     CSS in devops-panels.css no longer applies to those elements — that
//     CSS is shared with obs-panel.jsx and out of scope to edit here, so it
//     stays in place (dead for this component, still live for its sibling).
//     Layout classNames on plain wrapper elements (`.skills-panel`,
//     `.skill-row`, `.skill-meta`, etc.) are kept as-is.
import React, { useMemo, useState } from "react";
import { Badge, Switch, TextInput, ToggleButton } from "./astryx-kit.tsx";

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
        <TextInput
          label="Search skills"
          isLabelHidden
          size="sm"
          placeholder="Search skills…"
          value={query}
          onChange={(value) => setQuery(value)}
          hasClear
          width={220}
        />
      </div>
      <div className="skills-chips">
        {categories.map((c) => (
          <ToggleButton
            key={c}
            label={c}
            size="sm"
            isPressed={activeCategory === c}
            onPressedChange={() => setCategory(c)}
          />
        ))}
        <span className="skills-chip-sep" />
        {SOURCE_FILTERS.map((s) => (
          <ToggleButton
            key={s}
            label={s === "all" ? "any source" : s}
            size="sm"
            isPressed={source === s}
            onPressedChange={() => setSource(s)}
          />
        ))}
        <ToggleButton
          label="enabled only"
          size="sm"
          isPressed={enabledOnly}
          onPressedChange={(pressed) => setEnabledOnly(pressed)}
        />
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
                  <Badge variant={s.source === "user" ? "info" : "neutral"} label={s.source} />
                  <Badge variant="neutral" label={s.category} />
                </span>
                <span className="skill-desc">{s.description}</span>
              </div>
              <Switch
                label={s.enabled ? "on" : "off"}
                value={s.enabled}
                isDisabled={props.disabled === true}
                onChange={(checked) => props.onToggle(s.id, checked)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
