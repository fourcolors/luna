/**
 * flow-model.ts - pure, framework-free logic for the 'flow' panel (per-job
 * run inspector, PRD Part C W3).
 *
 * Ported 1:1 (same branch order, same string outputs) from the vanilla
 * apps/ui-moon-tauri/frontend/panels/flow.js module this React
 * implementation replaces. Kept here as plain functions (no React, no DOM)
 * so the status/format/bounds logic stays unit-testable in isolation from
 * rendering - mirrors the sibling Workflows gallery panel's
 * src/panels/workflows/model.ts split (see its module doc for the fuller
 * rationale: boundary validation against an untrusted WS peer belongs at
 * render time over the raw store slice, never in the shared reducer or the
 * store itself).
 *
 * NOTE ON STATUS VOCABULARY: this is deliberately a SEPARATE statusClass/
 * statusLabel from workflows/model.ts's, not a shared one - that module
 * classifies a job's `lastStatus` (raw values "fired"/"errored"/"scheduled"
 * from the jobs store), this one classifies a single *run's* `status`
 * (success/failed/running/waiting/cancelled/queued). Same shape, different
 * domain vocabulary; forcing one function over both would blur two distinct
 * wire contracts.
 */
import type { WorkflowGalleryItem, WorkflowRunItem } from "@luna/ui-shared/core"

export const MAX_RUNS = 500
export const MAX_ERROR_CHARS = 120

/** Past → "2h ago"; unset/invalid → "-". */
export function fmtRelative(epochMs: number | null | undefined): string {
  if (!epochMs) return "-"
  const d = new Date(epochMs)
  if (Number.isNaN(d.getTime())) return "-"
  const diffSec = Math.round((Date.now() - epochMs) / 1000)
  if (diffSec < 5) return "just now"
  if (diffSec < 60) return diffSec + "s ago"
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return diffMin + "m ago"
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return diffHr + "h ago"
  return Math.round(diffHr / 24) + "d ago"
}

/** "1m 5s" / "42s"; null when either endpoint is missing (still running). */
export function fmtDur(startMs: number | null | undefined, endMs: number | null | undefined): string | null {
  if (!startMs || !endMs) return null
  const s = Math.round((endMs - startMs) / 1000)
  if (s < 60) return s + "s"
  return Math.floor(s / 60) + "m " + (s % 60) + "s"
}

export type RunStatusClass = "success" | "failed" | "running" | "waiting" | "queued" | "cancelled"

export function statusClass(rawStatus: unknown): RunStatusClass {
  const s = String(rawStatus || "").toLowerCase()
  if (s === "success" || s === "ok" || s === "completed") return "success"
  if (s === "failed" || s === "fail" || s === "error") return "failed"
  if (s === "running" || s === "started") return "running"
  if (s === "waiting") return "waiting"
  if (s === "cancelled" || s === "canceled") return "cancelled"
  return "queued"
}

export function statusLabel(rawStatus: unknown): string {
  const cls = statusClass(rawStatus)
  if (cls === "queued" && rawStatus) return String(rawStatus)
  return cls
}

/**
 * Bound + sort run history against an untrusted WS peer: cap the row count,
 * drop rows without a usable numeric id, newest-started first - mirrors
 * workflows/model.ts's boundWorkflows/sortWorkflows discipline.
 */
export function boundRuns(raw: unknown): ReadonlyArray<WorkflowRunItem> {
  const arr = Array.isArray(raw) ? raw : []
  const filtered = (arr as ReadonlyArray<unknown>).filter(
    (r): r is WorkflowRunItem =>
      !!r && (typeof (r as { id?: unknown }).id === "number" || typeof (r as { id?: unknown }).id === "string"),
  )
  return filtered
    .slice(0, MAX_RUNS)
    .slice()
    .sort((a, b) => Number(b.startedAt) - Number(a.startedAt))
}

export interface SubtitleBadge {
  readonly kind: "scheduled" | "paused" | "on-demand"
  readonly text: string
}

export interface Subtitle {
  readonly label: string
  readonly badge: SubtitleBadge
}

/** Mirrors flow.js's renderSubtitle() branch order exactly. */
export function subtitleFor(
  jobId: string,
  wf: Pick<WorkflowGalleryItem, "label" | "enabled" | "schedule" | "onDemand" | "kind"> | null,
): Subtitle | null {
  if (!wf) return null
  const label = wf.label || jobId
  if (!wf.enabled) return { label, badge: { kind: "paused", text: "paused" } }
  if (wf.schedule) return { label, badge: { kind: "scheduled", text: "scheduled · " + wf.schedule } }
  if (wf.onDemand) return { label, badge: { kind: "on-demand", text: "on-demand" } }
  return { label, badge: { kind: "on-demand", text: wf.kind || "workflow" } }
}
