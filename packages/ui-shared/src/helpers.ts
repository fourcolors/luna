/**
 * Pure helpers shared by App.tsx components — extracted so they can be
 * unit-tested without mounting React.
 *
 * - deriveTitle: human-friendly thread title fallback chain
 * - truncate:    string truncation with ellipsis
 * - formatBytes: human-readable byte count
 * - countLines:  line count that ignores a trailing newline
 */
import type { ThreadView } from "./reducer.js"
import type { SessionSummary } from "./wire.js"

export const truncate = (s: string, n: number): string =>
  s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…"

/** Derive a display title for a thread. Order:
 *    1. explicit summary.title
 *    2. first user message text (the most informative thing the human typed)
 *    3. lastMessagePreview (could be assistant text, but better than nothing)
 *    4. null → caller renders "untitled" */
export const deriveTitle = (
  summary: SessionSummary,
  view: ThreadView | undefined,
): string | null => {
  if (summary.title && summary.title.trim().length > 0) {
    return truncate(summary.title.trim(), 60)
  }
  const firstUser = view?.messages.find((m) => m.role === "user")
  if (firstUser && firstUser.text.trim().length > 0) {
    return truncate(firstUser.text.trim().replace(/\s+/g, " "), 50)
  }
  if (
    summary.lastMessagePreview &&
    summary.lastMessagePreview.trim().length > 0
  ) {
    return truncate(
      summary.lastMessagePreview.trim().replace(/\s+/g, " "),
      50,
    )
  }
  return null
}

export const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export const countLines = (s: string): number => {
  if (s.length === 0) return 0
  // Don't count a trailing newline as a separate empty line.
  return s.endsWith("\n") ? s.split("\n").length - 1 : s.split("\n").length
}
