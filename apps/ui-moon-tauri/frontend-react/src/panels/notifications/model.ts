/**
 * panels/notifications/model.ts - pure presentation helpers for the
 * Notifications panel, kept out of the component for the same reason
 * panels/briefing/model.ts is: they are the part worth unit-testing, and a
 * component that only maps state to JSX stays trivially reviewable.
 *
 * Deliberately NOT importing briefing/model.ts's near-identical
 * `relativeTime`: that module is typed against WorkflowGalleryItem and owned
 * by a different panel's contract. A dozen duplicated lines are cheaper than
 * a coupling that makes either panel's formatting unsafe to change.
 */
import type { NotificationEntry } from "../../notifications/log"

/** "just now" / "12m ago" / "3h ago" / "2d ago". Null for a missing stamp. */
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

/**
 * Human name for the server's `source` discriminant. Unknown values pass
 * through rather than being swallowed - a new server-side source should show
 * up as itself, not silently render as blank.
 */
export function sourceLabel(source: string | null | undefined): string | null {
  if (!source) return null
  switch (source) {
    case "background-job":
      return "Background job"
    case "suggested-action":
      return "Suggested action"
    case "schedule":
      return "Schedule"
    default:
      return source
  }
}

/** Title line for a row: the task's label when known, else its source. */
export function entryTitle(entry: Pick<NotificationEntry, "label" | "source">): string {
  return entry.label || sourceLabel(entry.source) || "Luna finished a task"
}

/** Terse "Background job · 12m ago" meta line. Null when neither is known. */
export function entryMeta(entry: Pick<NotificationEntry, "label" | "source" | "ts">, now: number = Date.now()): string | null {
  const parts: string[] = []
  // Only show the source separately when the label already took the title
  // slot, so an unlabeled row doesn't print its source twice.
  const src = sourceLabel(entry.source)
  if (src && entry.label) parts.push(src)
  const when = relativeTime(entry.ts, now)
  if (when) parts.push(when)
  return parts.length ? parts.join(" · ") : null
}
