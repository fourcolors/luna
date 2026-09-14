/**
 * model.ts - pure, framework-free logic for the Briefing ("While you were
 * away" workflow digest) panel.
 *
 * Ported 1:1 (same branch order, same string outputs) from the vanilla
 * apps/ui-moon-tauri/frontend/panels/briefing.js module this React
 * implementation replaces, so every assertion the old
 * test/panel-briefing.test.ts made about grouping/sorting/formatting still
 * holds against these functions. Kept here as plain functions (no React, no
 * DOM) so the grouping/formatting logic stays unit-testable in isolation
 * from rendering - BriefingPanel.tsx is the only consumer.
 */
import type { WorkflowGalleryItem } from "@luna/ui-shared/core"
import { jobStatusClass, jobIsSettled, jobNeedsAttention } from "../job-status.js"

export type StatusDotClass = "waiting" | "failed" | "success" | "running" | "cancelled" | "queued"

/**
 * Null-guarded relative-time string: "just now" / "Xm ago" / "Xh ago" /
 * "Xd ago". Returns null for a falsy epoch (no lastRun/nextRunAt yet) -
 * ported verbatim from the vanilla module's `relativeTime()`.
 */
export function relativeTime(epochMs: number | null | undefined, now: number = Date.now()): string | null {
  if (!epochMs) return null
  const diff = Math.max(0, now - epochMs)
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return "just now"
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Terse meta line for a "Scheduled next" row: "0 3 * * * · next 2h ago"-shaped. */
export function scheduleLabel(
  wf: Pick<WorkflowGalleryItem, "schedule" | "nextRunAt">,
  now: number = Date.now(),
): string | null {
  const parts: string[] = []
  if (wf.schedule) parts.push(wf.schedule)
  if (wf.nextRunAt) {
    const rel = relativeTime(wf.nextRunAt, now)
    if (rel) parts.push(`next ${rel}`)
  }
  return parts.length > 0 ? parts.join(" · ") : null
}

/** Terse meta line for a "Needs attention" row. */
export function attentionMeta(
  wf: Pick<WorkflowGalleryItem, "lastStatus" | "lastRun">,
  now: number = Date.now(),
): string | null {
  const cls = jobStatusClass(wf.lastStatus)
  const parts: string[] = []
  if (cls === "waiting") parts.push("Waiting for input")
  else if (cls === "failed") parts.push("Failed")
  if (wf.lastRun) {
    const rel = relativeTime(wf.lastRun, now)
    if (rel) parts.push(rel)
  }
  return parts.length > 0 ? parts.join(" · ") : null
}

export function statusDotClass(status: string | null | undefined): StatusDotClass | null {
  // A job with no status at all renders no dot — unchanged, and NOT the same
  // thing as jobStatusClass's "never" (which also covers "scheduled").
  if (!status) return null
  const cls = jobStatusClass(status)
  // Briefing has no "never" swatch; "scheduled" has always shown as queued here.
  return cls === "never" ? "queued" : cls
}

export interface BriefingSections {
  readonly attention: ReadonlyArray<WorkflowGalleryItem>
  readonly recent: ReadonlyArray<WorkflowGalleryItem>
  readonly scheduled: ReadonlyArray<WorkflowGalleryItem>
}

/**
 * Groups workflows into the three digest sections and sorts each:
 *   - attention: waiting/failed, in server order (no re-sort - matches vanilla)
 *   - recent: success/cancelled, most-recent lastRun first (null last)
 *   - scheduled: has a schedule string, soonest nextRunAt first (null last)
 * A workflow can land in BOTH attention/recent AND scheduled (independent
 * membership tests) - matches the vanilla module exactly. Never mutates
 * the input array.
 */
export function groupWorkflows(workflows: ReadonlyArray<WorkflowGalleryItem>): BriefingSections {
  const attention: WorkflowGalleryItem[] = []
  const recent: WorkflowGalleryItem[] = []
  const scheduled: WorkflowGalleryItem[] = []

  for (const wf of workflows) {
    // THE 30-DAY BUG LIVED HERE. These two predicates used to inline their own
    // copy of the status vocabulary, which knew "failed"/"error" but not the
    // "fired"/"errored" the backend actually writes. A real job therefore
    // matched NEITHER, and fell out of the digest altogether rather than
    // landing in the wrong section — silent, not merely wrong.
    if (jobNeedsAttention(wf.lastStatus)) attention.push(wf)
    else if (jobIsSettled(wf.lastStatus)) recent.push(wf)

    if (wf.schedule) scheduled.push(wf)
  }

  const sortedRecent = [...recent].sort((a, b) => (b.lastRun || 0) - (a.lastRun || 0))
  const sortedScheduled = [...scheduled].sort((a, b) => {
    if (a.nextRunAt == null && b.nextRunAt == null) return 0
    if (a.nextRunAt == null) return 1
    if (b.nextRunAt == null) return -1
    return a.nextRunAt - b.nextRunAt
  })

  return { attention, recent: sortedRecent, scheduled: sortedScheduled }
}
