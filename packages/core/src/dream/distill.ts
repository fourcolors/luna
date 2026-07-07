/**
 * Dream input distillation — Phase 1 fix for issue #255 ("Prompt is too
 * long"). The old `gatherInputs` (dream.ts) handed the reasoner every raw
 * `StoredMessage` in the window and the reasoner JSON.stringify'd whole
 * payloads; a single busy session could blow the prompt budget.
 *
 * This module is PURE (no Effect, no IO): given messages/summaries/options it
 * derives short text excerpts, applying message-granularity windowing (only
 * messages inside (watermark, now] survive) and a hard per-scope char budget
 * with newest-first retention on overflow.
 */
import type { StoredMessage } from "../messages.js"
import type { SessionSummary } from "../session/types.js"

/** Per-scope character budgets the distiller enforces. */
export interface DistillOptions {
  /** Hard cap on a single distilled message line (S1e). */
  readonly perMessageChars: number
  /** Hard cap on one session's joined excerpt (S2i). */
  readonly perSessionChars: number
  /** Reserved for the memories-block budget (not exercised by this module's own tests). */
  readonly memoriesChars: number
}

export const DEFAULT_DISTILL_OPTIONS: DistillOptions = {
  perMessageChars: 1500,
  perSessionChars: 30_000,
  memoriesChars: 40_000,
}

/** Rough token ceiling for the whole dream prompt (chars/4 heuristic, see estimateTokens). */
export const DREAM_PROMPT_TOKEN_BUDGET = 120_000

/** Cheap token estimate: Math.ceil(text.length / 4). No tokenizer dependency. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/** Kinds that never carry surfaceable turn text; dropped from every excerpt. */
const NOISE_KINDS: ReadonlySet<StoredMessage["kind"]> = new Set([
  "stream_event",
  "system",
  "result",
  "hook",
  "status",
  "other",
])

/** Appended when a single line is cut to perMessageChars (S1e). */
const MESSAGE_TRUNCATION_MARKER = "… [truncated]"

/** Tool input/result renderings are capped independently of the line budget. */
const TOOL_FIELD_CHARS = 200

/** Concatenate the `text` of text blocks; non-text blocks contribute nothing. */
const flattenTextBlocks = (blocks: ReadonlyArray<Record<string, unknown>>): string =>
  blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")

/**
 * Render one SDK content block, or null if it carries no surfaceable text.
 * tool_use/tool_result fields are capped at TOOL_FIELD_CHARS (S1b).
 */
const renderBlock = (block: Record<string, unknown>): string | null => {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : null
    case "tool_use": {
      const name = typeof block.name === "string" ? block.name : "unknown"
      const input = JSON.stringify(block.input ?? null).slice(0, TOOL_FIELD_CHARS)
      return `[tool_use ${name}] ${input}`
    }
    case "tool_result": {
      const raw = block.content
      const flat = typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? flattenTextBlocks(raw as ReadonlyArray<Record<string, unknown>>)
          : JSON.stringify(raw ?? null)
      return `[tool_result] ${flat.slice(0, TOOL_FIELD_CHARS)}`
    }
    default:
      return null
  }
}

/**
 * Extract the surfaceable body of an SDK-shaped payload ({ message: { content } }),
 * or null when the payload is not SDK-shaped (caller falls back to JSON.stringify).
 */
const extractSdkBody = (payload: unknown): string | null => {
  if (typeof payload !== "object" || payload === null) return null
  const message = (payload as { message?: unknown }).message
  if (typeof message !== "object" || message === null) return null
  const content = (message as { content?: unknown }).content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((b) => renderBlock(b as Record<string, unknown>))
      .filter((part): part is string => part !== null)
      .join("")
  }
  return null
}

/**
 * Distill one StoredMessage into a single text line, or null if the message
 * is noise (kind) or carries no surfaceable text. See distill.test.ts S1 for
 * the exact payload-shape contract (SDK string/array content, tool_use,
 * tool_result, and the JSON.stringify fallback for non-SDK-shaped payloads).
 */
export const distillMessage = (
  msg: StoredMessage,
  opts: DistillOptions = DEFAULT_DISTILL_OPTIONS,
): string | null => {
  if (NOISE_KINDS.has(msg.kind)) return null

  const sdkBody = extractSdkBody(msg.payload)
  // JSON.stringify(undefined) is undefined (not a string) — coalesce so the
  // fallback stays total even for a payload the envelope should never hold.
  const body = sdkBody ?? JSON.stringify(msg.payload) ?? "null"
  if (body.trim() === "") return null

  const line = `[${msg.kind}] ${body}`
  if (line.length <= opts.perMessageChars) return line
  return (
    line.slice(0, opts.perMessageChars - MESSAGE_TRUNCATION_MARKER.length) +
    MESSAGE_TRUNCATION_MARKER
  )
}

export interface DistilledSession {
  readonly summary: SessionSummary
  /** Joined, budget-capped excerpt text for this session (S2). */
  readonly excerpt: string
  /** Total messages in the session, regardless of window or kind. */
  readonly messageCount: number
  /** Messages whose ts falls inside (window.watermark, window.now]. */
  readonly windowMessageCount: number
}

/**
 * Distill one session's messages into a bounded excerpt. Only messages
 * strictly inside (window.watermark, window.now] are considered; among
 * those, noise kinds are dropped from the excerpt (but still counted in
 * windowMessageCount). See distill.test.ts S2 for the overflow/truncation
 * contract (oldest-first drop, "[… N earlier messages truncated]" marker).
 */
export const distillSession = (
  summary: SessionSummary,
  messages: ReadonlyArray<StoredMessage>,
  window: { readonly watermark: number; readonly now: number },
  opts: DistillOptions = DEFAULT_DISTILL_OPTIONS,
): DistilledSession => {
  // (watermark, now]: strictly after the watermark, up to and including now.
  const inWindow = messages.filter(
    (m) => m.ts > window.watermark && m.ts <= window.now,
  )

  const lines = [...inWindow]
    .sort((a, b) => a.seq - b.seq)
    .map((m) => distillMessage(m, opts))
    .filter((line): line is string => line !== null)

  return {
    summary,
    excerpt: capExcerpt(lines, opts.perSessionChars),
    messageCount: messages.length,
    windowMessageCount: inWindow.length,
  }
}

/**
 * Join lines within perSessionChars. On overflow, drop the oldest lines first
 * and prepend a "[… N earlier messages truncated]" marker (S2i).
 *
 * Suffix lengths are tracked arithmetically (one subtraction per dropped
 * line) and the surviving lines are joined exactly once — a shift/rejoin
 * loop here is O(n²) over a session's line count, which a #255-scale
 * backlog session (tens of thousands of messages) turns into real minutes.
 */
const capExcerpt = (lines: ReadonlyArray<string>, perSessionChars: number): string => {
  const joined = lines.join("\n")
  if (joined.length <= perSessionChars) return joined

  // Length of lines[dropped..] joined with "\n", maintained incrementally:
  // dropping line i removes its chars plus one separator (none for the last).
  let suffixLen = joined.length
  for (let dropped = 1; dropped <= lines.length; dropped++) {
    suffixLen -= lines[dropped - 1]!.length + (dropped < lines.length ? 1 : 0)
    const marker = `[… ${dropped} earlier messages truncated]`
    const candidateLen =
      dropped === lines.length ? marker.length : marker.length + 1 + suffixLen
    if (candidateLen <= perSessionChars) {
      return dropped === lines.length
        ? marker
        : `${marker}\n${lines.slice(dropped).join("\n")}`
    }
  }
  return `[… ${lines.length} earlier messages truncated]`
}
