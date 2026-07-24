// workflows-panel.jsx — Workflows / job gallery panel.
// React port of packages/ui-shared-solid/src/WorkflowGallery.tsx (PRD Part C / W3).
//
// Renders the unified workflow/job gallery: a list of WorkflowGalleryItem
// tiles (scheduled vs on-demand, enabled/paused, last status) with on-demand
// run history expansion when the user selects a tile.
//
// This component is presentational only — it takes its data and handlers as
// props (fed from ctx.state / ctx.send by the DEFS entry in final-app.jsx; see
// the integration spec returned alongside this file). It performs no fetching
// and owns no transport state, only the local `selectedId` UI toggle.
//
// Behaviour (ported 1:1 from the Solid original):
//   - Header: "Workflows" + count chip + "refresh" chip.
//   - Each tile is a div[role=button] (NOT <button>) so future nested chips
//     remain valid HTML — mirrors the ArtifactPanel pattern.
//   - Selecting a tile toggles selection; on a NEW selection it calls
//     onSelectRuns(id) so the parent can send workflow-runs-request.
//   - Run history (ctx.state.workflowRuns, keyed by job id) renders inline
//     below the selected tile: status, start time, duration, attempt, error.
//   - All epoch-ms timestamps are formatted defensively (null-guarded) — a
//     malformed/out-of-range value renders "—" instead of "Invalid Date" or
//     throwing.
//   - Run error text is rendered as plain text via JSX child interpolation
//     (auto-escaped, no dangerouslySetInnerHTML) — never raw HTML, never a
//     secret value.
//
// Astryx conversion (single-file scope):
//   - The header "refresh" chip is a clean 1:1 mapping onto Astryx's
//     <Button>: it's a plain synchronous action trigger with no nested
//     interactive children, so there's no button-in-button constraint. It
//     keeps the shared `chip small` className (see devops-panels.css: that
//     class is deliberately "byte-identical across porter outputs" and
//     still used by the not-yet-converted ArtifactsPanel) - Luna's CSS is
//     loaded unlayered while Astryx's own rules live in `@layer
//     astryx-base` (see main.tsx), so the chip look wins the cascade over
//     Astryx's default button chrome without a visual regression.
//   - The tile rows intentionally stay hand-rolled div[role=button] markup.
//     Astryx's nearest equivalent (ClickableCard) composes Card's own
//     visual system (padding/radius/variant tokens) and a different DOM
//     shape (a visually-hidden inner <button>/<a> for the accessible
//     name) - forcing it here would fork `.artifact-row` styling away from
//     the still-native ArtifactsPanel this file intentionally mirrors, for
//     a row type that (unlike ArtifactsPanel's pinned rows) has no nested
//     interactive child needing the shim in the first place. The existing
//     activateOnKey Enter/Space handler already covers keyboard
//     activation 1:1, so it's kept verbatim rather than forced onto an
//     Astryx component with no equivalent-looking output.
//   - Stays .jsx: studio-live-panels.jsx imports this module by its exact
//     "./workflows-panel.jsx" specifier (extension included, Vite does not
//     resolve across extensions) and is out of this conversion's
//     single-file scope, so renaming to .tsx would require an out-of-scope
//     edit for zero behavioural benefit. JSDoc types are added instead,
//     matching the convention already used by artifacts-panel.jsx.
import React, { useMemo, useState } from "react";
import { Button } from "./astryx-kit.tsx";

// ─── helpers (ported verbatim from WorkflowGallery.tsx) ────────────────────

/** Format an epoch-ms value as a locale date+time string. Returns "—" for null/0. */
function fmtTime(ms) {
  if (ms == null || ms === 0) return "—";
  // new Date(NaN | out-of-range).toLocaleString() returns the literal string
  // "Invalid Date" WITHOUT throwing — guard via getTime().
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** Format a duration in ms as "1.2s" or "823ms". Returns "—" when either end is missing. */
function fmtDuration(startMs, endMs) {
  if (startMs == null || endMs == null) return "—";
  const delta = endMs - startMs;
  if (delta < 0) return "—";
  if (delta >= 1000) return (delta / 1000).toFixed(1) + "s";
  return delta + "ms";
}

/** Colour hint for a status string. Returns a CSS color value. */
function statusColor(status) {
  if (!status) return "inherit";
  const s = status.toLowerCase();
  if (s === "success" || s === "ok" || s === "completed") return "var(--color-success, #4ade80)";
  if (s === "failed" || s === "error" || s === "cancelled" || s === "canceled") return "var(--color-danger, #f87171)";
  return "var(--color-muted, #888)";
}

/** Keyboard activation helper — mirrors ArtifactPanel.activateOnKey. */
function activateOnKey(fn) {
  return (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

// ─── component ─────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   kind: string,
 *   onDemand?: boolean,
 *   schedule?: string|null,
 *   enabled?: boolean,
 *   lastStatus?: string|null,
 *   nextRunAt?: number|null,
 * }} Workflow
 * @typedef {{
 *   id: string,
 *   status: string,
 *   startedAt?: number|null,
 *   finishedAt?: number|null,
 *   attempt?: number,
 *   error?: string|null,
 * }} WorkflowRun
 * @param {{
 *   workflows: ReadonlyArray<Workflow>|null|undefined,
 *   runs: ReadonlyMap<string, ReadonlyArray<WorkflowRun>>|null|undefined,
 *   onSelectRuns: (id: string) => void,
 *   onRefresh: () => void,
 * }} props
 */
export function WorkflowGallery({ workflows, runs, onSelectRuns, onRefresh }) {
  const list = workflows || [];
  const [selectedId, setSelectedId] = useState(null);

  function select(id) {
    const next = selectedId === id ? null : id;
    setSelectedId(next);
    if (next !== null) onSelectRuns(next);
  }

  const selectedRuns = useMemo(() => {
    if (selectedId == null) return [];
    return (runs && runs.get(selectedId)) || [];
  }, [selectedId, runs]);

  return (
    <aside className="artifact-panel">
      {/* Header */}
      <div className="artifact-head">
        <span>Workflows</span>
        <span className="muted small">{list.length}</span>
        <Button
          label="↻ refresh"
          className="chip small"
          style={{ marginLeft: "auto" }}
          onClick={onRefresh}
          tooltip="Re-fetch workflow list"
        />
      </div>

      {/* Tile list */}
      {list.length === 0 ? (
        <div className="muted small" style={{ padding: "0.5rem 0.75rem" }}>No workflows.</div>
      ) : (
        <div className="artifact-list">
          {list.map((wf) => {
            const isSelected = selectedId === wf.id;
            return (
              <React.Fragment key={wf.id}>
                <div
                  className={"artifact-row" + (isSelected ? " selected" : "")}
                  role="button"
                  tabIndex={0}
                  onClick={() => select(wf.id)}
                  onKeyDown={activateOnKey(() => select(wf.id))}
                >
                  {/* title + schedule/on-demand badge */}
                  <div className="artifact-title">
                    {wf.label}
                    <span className="chip small" style={{ marginLeft: "0.4rem", fontSize: "0.68rem" }}>
                      {wf.onDemand ? "on-demand" : "scheduled" + (wf.schedule ? ": " + wf.schedule : "")}
                    </span>
                  </div>

                  {/* meta line */}
                  <div className="artifact-meta muted small">
                    <span>{wf.kind}</span>
                    {!wf.enabled && <span className="muted"> · paused</span>}
                    {wf.lastStatus && (
                      <span style={{ color: statusColor(wf.lastStatus), marginLeft: "0.3rem" }}>
                        · {wf.lastStatus}
                      </span>
                    )}
                    {wf.nextRunAt != null && (
                      <span className="muted"> · next {fmtTime(wf.nextRunAt)}</span>
                    )}
                  </div>
                </div>

                {/* Inline run history (expanded when tile is selected) */}
                {isSelected && (
                  <div
                    style={{
                      borderLeft: "2px solid var(--color-border, #333)",
                      marginLeft: "0.75rem",
                      paddingLeft: "0.5rem",
                      marginBottom: "0.5rem",
                    }}
                  >
                    <div className="artifact-head" style={{ fontSize: "0.75rem", paddingTop: "0.2rem" }}>
                      <span className="muted small">Run history</span>
                      <span className="muted small">{selectedRuns.length}</span>
                    </div>
                    {selectedRuns.length === 0 ? (
                      <div className="muted small" style={{ padding: "0.25rem 0" }}>No runs yet.</div>
                    ) : (
                      selectedRuns.map((run) => (
                        <div
                          key={run.id}
                          className="artifact-row"
                          style={{ paddingTop: "0.2rem", paddingBottom: "0.2rem" }}
                        >
                          <div className="artifact-meta small">
                            <span style={{ color: statusColor(run.status), fontWeight: 500 }}>{run.status}</span>
                            <span className="muted"> · {fmtTime(run.startedAt)}</span>
                            <span className="muted"> · {fmtDuration(run.startedAt, run.finishedAt)}</span>
                            {run.attempt > 1 && <span className="muted"> · attempt {run.attempt}</span>}
                          </div>
                          {run.error && (
                            <div
                              className="muted small"
                              style={{
                                fontFamily: "monospace",
                                whiteSpace: "pre-wrap",
                                overflowWrap: "anywhere",
                                maxHeight: "4rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                color: "var(--color-danger, #f87171)",
                                marginTop: "0.15rem",
                              }}
                            >
                              {run.error}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      )}
    </aside>
  );
}
