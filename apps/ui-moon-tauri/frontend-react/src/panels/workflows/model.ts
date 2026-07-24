/**
 * model.ts - pure, framework-free logic for the Workflows gallery panel.
 *
 * Ported 1:1 (same constants, same branch order, same string outputs) from
 * the vanilla apps/ui-moon-tauri/frontend/panels/workflows.js module that
 * this React implementation replaces. Kept here as plain functions (no
 * React, no DOM) so the sort/status/bounds logic stays unit-testable in
 * isolation from rendering - WorkflowsPanel.tsx is the only consumer.
 *
 * Boundary validation lives here rather than in the shared reducer
 * (packages/ui-shared/src/reducer.ts): the reducer's `workflow-list` case
 * replaces `state.workflows` wholesale with whatever the server sent (any
 * consumer's concern to bound), matching how every other reducer slice
 * stays a thin, untrusted mirror of the wire. The 500-row cap / 200-char
 * label clamp / malformed-id filter are THIS panel's rendering policy
 * against an untrusted remote peer, so they run here, at render time, over
 * the raw store slice - never mutating the store itself.
 */
import type { WorkflowGalleryItem } from "@luna/ui-shared/core"

export const MAX_ROWS = 500
export const MAX_LABEL = 200
export const MAX_META = 64

export function clampText(value: unknown, max: number): string {
  return String(value == null ? "" : value).slice(0, max)
}

/**
 * Past → "2h ago"; future → "in 2h"; invalid → null. Coerce first: a date
 * STRING would pass a `new Date()` guard but NaN the arithmetic.
 */
export function fmtRelative(epochMs: unknown): string | null {
  const n = Number(epochMs)
  if (!Number.isFinite(n) || n <= 0) return null
  const diffSec = Math.round((Date.now() - n) / 1000)
  const future = diffSec < 0
  const s = Math.abs(diffSec)
  let span: string
  if (s < 60) span = future ? "moments" : "just now"
  else if (s < 3600) span = Math.round(s / 60) + "m"
  else if (s < 86400) span = Math.round(s / 3600) + "h"
  else span = Math.round(s / 86400) + "d"
  if (!future) return s < 60 ? span : span + " ago"
  return "in " + span
}

/**
 * jobs.last_status arrives RAW from the backend: "fired" (ran ok),
 * "errored", "running", "scheduled". The run-status vocabulary
 * (success/failed/waiting/…) is accepted too as belt-and-suspenders for
 * servers that normalize before sending.
 */
export function statusClass(rawStatus: unknown): string {
  const s = String(rawStatus || "").toLowerCase()
  if (s === "fired" || s === "success" || s === "ok" || s === "completed") return "success"
  if (s === "errored" || s === "failed" || s === "fail" || s === "error") return "failed"
  if (s === "running" || s === "started") return "running"
  if (s === "waiting") return "waiting"
  if (s === "cancelled" || s === "canceled") return "cancelled"
  if (!rawStatus || s === "scheduled") return "never"
  return "queued"
}

/** Humanized meta copy - "fired" reads as "ok", "errored" as "failed". */
export function statusLabel(rawStatus: unknown): string | null {
  const cls = statusClass(rawStatus)
  if (cls === "success") return "ok"
  if (cls === "failed") return "failed"
  if (cls === "never") return null
  return clampText(rawStatus, MAX_META).toLowerCase()
}

/**
 * Sort rank: needs-attention first, then running, then everything else. A
 * paused job never runs again, so it never needs attention - its stale
 * lastStatus must not outrank live jobs (its badge already says paused).
 */
export function attentionRank(wf: Pick<WorkflowGalleryItem, "enabled" | "lastStatus">): number {
  if (!wf.enabled) return 2
  const c = statusClass(wf.lastStatus)
  if (c === "waiting" || c === "failed") return 0
  if (c === "running") return 1
  return 2
}

export interface DisplayBadge {
  readonly className: string
  readonly text: string
}

export function badgeFor(
  wf: Pick<WorkflowGalleryItem, "enabled" | "schedule" | "onDemand" | "kind">,
): DisplayBadge {
  if (!wf.enabled) return { className: "wfs-badge paused", text: "paused" }
  if (wf.schedule) return { className: "wfs-badge scheduled", text: clampText(wf.schedule, MAX_META) }
  if (wf.onDemand) return { className: "wfs-badge on-demand", text: "on-demand" }
  return { className: "wfs-badge on-demand", text: clampText(wf.kind, MAX_META) || "workflow" }
}

export function metaText(
  wf: Pick<WorkflowGalleryItem, "kind" | "lastStatus" | "lastRun" | "enabled" | "nextRunAt">,
): string {
  const parts = [clampText(wf.kind, MAX_META) || "job"]
  const label = statusLabel(wf.lastStatus)
  if (label) {
    const rel = fmtRelative(wf.lastRun)
    parts.push(label + (rel ? " " + rel : ""))
  } else {
    parts.push("never ran")
  }
  if (wf.enabled && wf.nextRunAt) {
    const next = fmtRelative(wf.nextRunAt)
    if (next) parts.push("next " + next)
  }
  return parts.join(" · ")
}

export function displayName(wf: Pick<WorkflowGalleryItem, "label" | "id">): string {
  return clampText(wf.label, MAX_LABEL) || wf.id
}

export interface BoundedWorkflows {
  readonly list: ReadonlyArray<WorkflowGalleryItem>
  readonly truncated: number
}

/**
 * Bounds on untrusted frame data (the WS peer is a remote server): cap the
 * row count and drop rows without a usable string id so a misbehaving
 * server cannot freeze the webview with a huge list, nor hand a garbage id
 * to open_widget/aria-label/the data-job-id attribute.
 */
export function boundWorkflows(raw: unknown): BoundedWorkflows {
  const arr = Array.isArray(raw) ? raw : []
  const filtered = (arr as ReadonlyArray<unknown>).filter(
    (wf): wf is WorkflowGalleryItem =>
      !!wf &&
      typeof (wf as { id?: unknown }).id === "string" &&
      (wf as { id: string }).id.length > 0 &&
      (wf as { id: string }).id.length <= 256,
  )
  const truncated = Math.max(0, filtered.length - MAX_ROWS)
  return { list: filtered.slice(0, MAX_ROWS), truncated }
}

/**
 * Sort: attention (waiting/errored) → running → lastRun desc → nulls last
 * → label tiebreak. Never mutates the input array.
 */
export function sortWorkflows(
  list: ReadonlyArray<WorkflowGalleryItem>,
): ReadonlyArray<WorkflowGalleryItem> {
  return [...list].sort((a, b) => {
    const ra = attentionRank(a)
    const rb = attentionRank(b)
    if (ra !== rb) return ra - rb
    const ta = Number(a.lastRun) || 0
    const tb = Number(b.lastRun) || 0
    if (ta !== tb) return tb - ta
    return String(a.label || a.id).localeCompare(String(b.label || b.id))
  })
}
