/**
 * WorkflowGallery (Solid) — PRD Part C / W3.
 *
 * Renders the unified workflow / job gallery: a list of WorkflowGalleryItem
 * tiles (scheduled vs on-demand, enabled/paused, last status) with on-demand
 * run history expansion when the user selects a tile.
 *
 * Behaviour:
 *   - Header: "Workflows" + count chip + "refresh" chip.
 *   - Each tile is a div[role=button] (NOT <button>) so future nested chips
 *     remain valid HTML — mirrors the ArtifactPanel pattern.
 *   - Selecting a tile calls onSelectRuns(id) to fetch run history, then
 *     renders runs inline below the tile list.
 *   - Run history shows status, start time, duration, and truncated error.
 *   - All epoch-ms timestamps are formatted defensively (null-guarded).
 *
 * Style classes reused from the artifact-panel/skills-panel vocabulary:
 *   artifact-panel, artifact-head, artifact-list, artifact-row, artifact-title,
 *   artifact-meta, chip, muted, small, selected.
 * Status colouring is carried inline (no new CSS class required).
 */
import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import type { WorkflowGalleryItem, WorkflowRunItem } from "@luna/ui-shared/core"

export interface WorkflowGalleryProps {
  readonly workflows: ReadonlyArray<WorkflowGalleryItem>
  readonly runs: ReadonlyMap<string, ReadonlyArray<WorkflowRunItem>>
  /** Called when the user selects a tile — parent sends workflow-runs-request. */
  readonly onSelectRuns: (jobId: string) => void
  /** Called when the user clicks the refresh chip — parent sends workflow-refresh. */
  readonly onRefresh: () => void
}

// ─── helpers ───────────────────────────────────────────────────────────────

/** Format an epoch-ms value as a locale date+time string. Returns "—" for null/0. */
function fmtTime(ms: number | null | undefined): string {
  if (ms == null || ms === 0) return "—"
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return "—"
  }
}

/** Format a duration in ms as "1.2s" or "823ms". Returns "—" when either end is missing. */
function fmtDuration(startMs: number | null | undefined, endMs: number | null | undefined): string {
  if (startMs == null || endMs == null) return "—"
  const delta = endMs - startMs
  if (delta < 0) return "—"
  if (delta >= 1000) return `${(delta / 1000).toFixed(1)}s`
  return `${delta}ms`
}

/** Colour hint for a status string. Returns a CSS color value. */
function statusColor(status: string | null | undefined): string {
  if (!status) return "inherit"
  const s = status.toLowerCase()
  if (s === "success" || s === "ok" || s === "completed") return "var(--color-success, #4ade80)"
  if (s === "failed" || s === "error" || s === "cancelled" || s === "canceled") return "var(--color-danger, #f87171)"
  return "var(--color-muted, #888)"
}

/** Keyboard activation helper — mirrors ArtifactPanel.activateOnKey. */
const activateOnKey = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault()
    fn()
  }
}

// ─── component ─────────────────────────────────────────────────────────────

export const WorkflowGallery: Component<WorkflowGalleryProps> = (props) => {
  const [selectedId, setSelectedId] = createSignal<string | null>(null)

  const select = (id: string) => {
    const next = selectedId() === id ? null : id
    setSelectedId(next)
    if (next !== null) props.onSelectRuns(next)
  }

  const selectedRuns = createMemo<ReadonlyArray<WorkflowRunItem>>(() => {
    const id = selectedId()
    if (id == null) return []
    return props.runs.get(id) ?? []
  })

  return (
    <aside class="artifact-panel">
      {/* ── Header ── */}
      <div class="artifact-head">
        <span>Workflows</span>
        <span class="muted small">{props.workflows.length}</span>
        <button
          class="chip small"
          style={{ "margin-left": "auto" }}
          onClick={() => props.onRefresh()}
          title="Re-fetch workflow list"
        >
          ↻ refresh
        </button>
      </div>

      {/* ── Tile list ── */}
      <Show
        when={props.workflows.length > 0}
        fallback={<div class="muted small" style={{ padding: "0.5rem 0.75rem" }}>No workflows.</div>}
      >
        <div class="artifact-list">
          <For each={props.workflows}>
            {(wf) => {
              const isSelected = () => selectedId() === wf.id
              return (
                <>
                  <div
                    class={`artifact-row${isSelected() ? " selected" : ""}`}
                    role="button"
                    tabindex={0}
                    onClick={() => select(wf.id)}
                    onKeyDown={activateOnKey(() => select(wf.id))}
                  >
                    {/* title + schedule/on-demand badge */}
                    <div class="artifact-title">
                      {wf.label}
                      <span
                        class="chip small"
                        style={{ "margin-left": "0.4rem", "font-size": "0.68rem" }}
                      >
                        {wf.onDemand ? "on-demand" : `scheduled${wf.schedule ? `: ${wf.schedule}` : ""}`}
                      </span>
                    </div>

                    {/* meta line */}
                    <div class="artifact-meta muted small">
                      <span>{wf.kind}</span>
                      <Show when={!wf.enabled}>
                        <span class="muted"> · paused</span>
                      </Show>
                      <Show when={wf.lastStatus}>
                        <span style={{ color: statusColor(wf.lastStatus), "margin-left": "0.3rem" }}>
                          · {wf.lastStatus}
                        </span>
                      </Show>
                      <Show when={wf.nextRunAt != null}>
                        <span class="muted"> · next {fmtTime(wf.nextRunAt)}</span>
                      </Show>
                    </div>
                  </div>

                  {/* ── Inline run history (expanded when tile is selected) ── */}
                  <Show when={isSelected()}>
                    <div
                      style={{
                        "border-left": "2px solid var(--color-border, #333)",
                        "margin-left": "0.75rem",
                        "padding-left": "0.5rem",
                        "margin-bottom": "0.5rem",
                      }}
                    >
                      <div class="artifact-head" style={{ "font-size": "0.75rem", "padding-top": "0.2rem" }}>
                        <span class="muted small">Run history</span>
                        <span class="muted small">{selectedRuns().length}</span>
                      </div>
                      <Show
                        when={selectedRuns().length > 0}
                        fallback={
                          <div class="muted small" style={{ padding: "0.25rem 0" }}>
                            No runs yet.
                          </div>
                        }
                      >
                        <For each={selectedRuns()}>
                          {(run) => (
                            <div
                              class="artifact-row"
                              style={{ "padding-top": "0.2rem", "padding-bottom": "0.2rem" }}
                            >
                              <div class="artifact-meta small">
                                <span style={{ color: statusColor(run.status), "font-weight": "500" }}>
                                  {run.status}
                                </span>
                                <span class="muted"> · {fmtTime(run.startedAt)}</span>
                                <span class="muted"> · {fmtDuration(run.startedAt, run.finishedAt)}</span>
                                <Show when={run.attempt > 1}>
                                  <span class="muted"> · attempt {run.attempt}</span>
                                </Show>
                              </div>
                              <Show when={run.error}>
                                <div
                                  class="muted small"
                                  style={{
                                    "font-family": "monospace",
                                    "white-space": "pre-wrap",
                                    "overflow-wrap": "anywhere",
                                    "max-height": "4rem",
                                    overflow: "hidden",
                                    "text-overflow": "ellipsis",
                                    color: "var(--color-danger, #f87171)",
                                    "margin-top": "0.15rem",
                                  }}
                                >
                                  {run.error}
                                </div>
                              </Show>
                            </div>
                          )}
                        </For>
                      </Show>
                    </div>
                  </Show>
                </>
              )
            }}
          </For>
        </div>
      </Show>
    </aside>
  )
}
