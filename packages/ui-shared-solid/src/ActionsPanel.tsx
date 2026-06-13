/**
 * ActionsPanel (Solid) — suggested-actions panel for the web client.
 *
 * Renders the thread's suggested actions as a list of rows: title, status
 * badge, action type, optional rationale/detail, and — ONLY when
 * status === 'proposed' — Accept + Dismiss buttons (disabled when `disabled`).
 *
 * Structure/style mirrors WorkflowGallery.tsx (statusColor helper, artifact-*
 * CSS vocabulary) and VaultPanel.tsx (props-in / callbacks-out, `disabled`
 * gating).
 *
 * Gated on capabilities.suggestedActions in App.tsx — older servers hide it.
 */
import { For, Show, type Component } from "solid-js"
import type { SuggestedActionWire, SuggestedActionStatus } from "@luna/ui-shared/core"

export interface ActionsPanelProps {
  readonly actions: ReadonlyArray<SuggestedActionWire>
  readonly disabled?: boolean
  readonly onAccept: (id: string) => void
  readonly onDismiss: (id: string) => void
}

// ─── helpers ───────────────────────────────────────────────────────────────

/** CSS color for each action status. */
function statusColor(status: SuggestedActionStatus): string {
  switch (status) {
    case "proposed":    return "var(--color-accent, #60a5fa)"
    case "accepted":    return "var(--color-info, #818cf8)"
    case "in_progress": return "var(--color-warn, #facc15)"
    case "completed":   return "var(--color-success, #4ade80)"
    case "failed":      return "var(--color-danger, #f87171)"
    case "dismissed":   return "var(--color-muted, #888)"
    default:            return "inherit"
  }
}

/** Human-readable label for a status value. */
function statusLabel(status: SuggestedActionStatus): string {
  switch (status) {
    case "proposed":    return "proposed"
    case "accepted":    return "accepted"
    case "in_progress": return "in progress"
    case "completed":   return "completed"
    case "failed":      return "failed"
    case "dismissed":   return "dismissed"
    default:            return status
  }
}

/** Human-readable label for an action type. */
function typeLabel(actionType: SuggestedActionWire["actionType"]): string {
  switch (actionType) {
    case "task":            return "task"
    case "research":        return "research"
    case "create_skill":    return "create skill"
    case "create_workflow": return "create workflow"
    case "run_workflow":    return "run workflow"
    default:                return actionType
  }
}

// ─── component ─────────────────────────────────────────────────────────────

export const ActionsPanel: Component<ActionsPanelProps> = (props) => {
  return (
    <aside class="artifact-panel">
      {/* ── Header ── */}
      <div class="artifact-head">
        <span>Suggested Actions</span>
        <span class="muted small">{props.actions.length}</span>
      </div>

      {/* ── Action list ── */}
      <Show
        when={props.actions.length > 0}
        fallback={
          <div class="muted small" style={{ padding: "0.5rem 0.75rem" }}>
            No suggested actions.
          </div>
        }
      >
        <div class="artifact-list">
          <For each={props.actions}>
            {(action) => (
              <div class="artifact-row">
                {/* ── Title + status badge ── */}
                <div class="artifact-title">
                  {action.title}
                  <span
                    class="chip small"
                    style={{
                      "margin-left": "0.4rem",
                      "font-size": "0.68rem",
                      color: statusColor(action.status),
                    }}
                  >
                    {statusLabel(action.status)}
                  </span>
                  <span
                    class="chip small"
                    style={{ "margin-left": "0.3rem", "font-size": "0.68rem" }}
                  >
                    {typeLabel(action.actionType)}
                  </span>
                </div>

                {/* ── Rationale / detail ── */}
                <Show when={action.rationale}>
                  <div class="artifact-meta muted small" style={{ "margin-top": "0.15rem" }}>
                    {action.rationale}
                  </div>
                </Show>
                <Show when={action.detail && !action.rationale}>
                  <div class="artifact-meta muted small" style={{ "margin-top": "0.15rem" }}>
                    {action.detail}
                  </div>
                </Show>

                {/* ── Error (when failed) ── */}
                <Show when={action.status === "failed" && action.error}>
                  <div
                    class="muted small"
                    style={{
                      color: "var(--color-danger, #f87171)",
                      "font-family": "monospace",
                      "margin-top": "0.15rem",
                      "white-space": "pre-wrap",
                      "overflow-wrap": "anywhere",
                      "max-height": "3rem",
                      overflow: "hidden",
                    }}
                  >
                    {action.error}
                  </div>
                </Show>

                {/* ── Accept / Dismiss (proposed only) ── */}
                <Show when={action.status === "proposed"}>
                  <div
                    style={{
                      display: "flex",
                      gap: "0.4rem",
                      "margin-top": "0.4rem",
                    }}
                  >
                    <button
                      type="button"
                      class="chip small"
                      style={{ color: "var(--color-success, #4ade80)" }}
                      disabled={props.disabled === true}
                      onClick={() => props.onAccept(action.id)}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      class="chip small"
                      style={{ color: "var(--color-muted, #888)" }}
                      disabled={props.disabled === true}
                      onClick={() => props.onDismiss(action.id)}
                    >
                      Dismiss
                    </button>
                  </div>
                </Show>

                {/* ── Source badge ── */}
                <div class="artifact-meta muted small" style={{ "margin-top": "0.2rem" }}>
                  <span>from {action.source}</span>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </aside>
  )
}
