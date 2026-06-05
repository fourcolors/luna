/**
 * copy.ts — pure helpers for the /copy slash command.
 *
 * `selectForCopy` turns a Timeline + target spec into a single string that
 * can be handed to `writeToClipboard`. No IO here; the IO side lives in
 * `clipboard.ts`.
 *
 * Design choices:
 *   - "last" copies the most recent assistant message *body only*, with no
 *     decoration. This is the common case ("share what Luna just said") and
 *     keeps the clipboard contents pasteable as-is.
 *   - "messages N" and "thread" both copy in chronological order with simple
 *     labels (`> user`, `assistant:`, `[tool ...]`) so the result is
 *     readable when pasted back into chat or a markdown doc.
 *   - Tool blocks are summarized, not dumped verbatim — copying a 64KB tool
 *     output is rarely what the operator wants.
 */
import type { Block, Timeline } from "./timeline.js"

export type CopyTarget =
  | { readonly target: "last"; readonly count: 1 }
  | { readonly target: "messages"; readonly count: number }
  | { readonly target: "thread"; readonly count: 0 }

const renderBlockLabeled = (b: Block): string => {
  if (b.kind === "user") return `> ${b.text}`
  if (b.kind === "assistant") return b.text
  // tool
  const status = b.status === "ok" ? "ok" : b.status === "error" ? "error" : "running"
  return `[tool ${b.name}: ${status}]`
}

export const selectForCopy = (timeline: Timeline, spec: CopyTarget): string => {
  if (timeline.length === 0) return ""

  if (spec.target === "last") {
    // Walk backwards for the most recent assistant block with non-empty text.
    for (let i = timeline.length - 1; i >= 0; i--) {
      const b = timeline[i]!
      if (b.kind === "assistant" && b.text.length > 0) return b.text
    }
    return ""
  }

  if (spec.target === "thread") {
    return timeline.map(renderBlockLabeled).join("\n\n")
  }

  // "messages" — last N blocks, chronological.
  const n = Math.min(spec.count, timeline.length)
  return timeline.slice(timeline.length - n).map(renderBlockLabeled).join("\n\n")
}
