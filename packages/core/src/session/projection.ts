/**
 * Pure projection: opaque `StoredMessage` envelopes → `ChatMessage` view model
 * the chat UI renders.
 *
 * Why a pure module (no Effect.Service): Per advisor verdict (Commit 1) and
 * §12.2 #2/#6, SessionStore is the authoritative log. The projection here is
 * a one-way derivation from that log — no DI, no services, just functions
 * the WS layer + tests can call freely. If projection logic grows
 * (artifact extraction, citation linking, etc.) it stays pure; the WS layer
 * orchestrates.
 *
 * Payload shape contract (best-effort, SDK is source of truth):
 *   user:      { message: { role: "user",      content: string | Array<{type,text?}> } }
 *   assistant: { message: { role: "assistant", content: Array<{type:"text"|"tool_use"|"thinking", ...}> } }
 *   result:    { result: string, ... }
 *   others:    opaque — not surfaced by projection
 *
 * Anything that doesn't match these shapes returns `null` (filtered out by
 * `projectChatMessages`) rather than throwing — at-rest data may have come
 * from an older SDK version per §12.2 #6.
 */
import { Stream } from "effect"
import type { StoredMessage } from "../messages.js"

/** A flattened tool-use block as it appears inside an assistant turn. */
export interface ChatToolUse {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

/**
 * A file attachment on a user turn. Images use the four base64 image media
 * types (stored as `image` content blocks); PDFs use `application/pdf` (stored
 * as `document` blocks). `data` is raw base64 (no `data:` URI prefix).
 */
export interface ChatAttachment {
  readonly mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "application/pdf"
  readonly data: string
}

/** A single rendered chat turn, role + text + optional tool_use blocks. */
export interface ChatMessage {
  readonly id: string
  readonly seq: number
  readonly ts: number
  readonly role: "user" | "assistant"
  /** Concatenated text content. May be empty if the turn was attachment-only. */
  readonly text: string
  /** Tool-use blocks in document order. Empty array if none. */
  readonly toolUses: ReadonlyArray<ChatToolUse>
  /** Image attachments on user turns. Empty array if none. */
  readonly attachments: ReadonlyArray<ChatAttachment>
}

const MAX_PREVIEW_CHARS = 140

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null

const collapseWhitespace = (s: string): string =>
  s.replace(/\s+/g, " ").trim()

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…"

/**
 * Pull a one-line text excerpt out of a stored payload. Returns null when
 * the payload doesn't carry surfaceable text (tool-use-only assistant turn,
 * structured user content with no text blocks, etc.). The sidebar treats
 * null as "leave the previous preview alone."
 *
 * For user turns that carry only image attachments (no text), returns a
 * synthetic "[image]" preview so the sidebar doesn't go blank.
 */
export function extractTextPreview(payload: unknown): string | null {
  const text = extractText(payload)
  if (text === null) return null
  const cleaned = collapseWhitespace(text)
  if (cleaned.length === 0) {
    // Check if this is an image-only user turn and surface a placeholder.
    const attachments = extractAttachments(payload)
    if (attachments.length > 0) {
      return attachments.length === 1 ? "[image]" : `[${attachments.length} images]`
    }
    return null
  }
  return truncate(cleaned, MAX_PREVIEW_CHARS)
}

/**
 * Extract concatenated text from a user/assistant payload. Walks both the
 * string-content shortcut and the structured content-block array. Returns
 * null only when the shape is unrecognized; returns empty string for
 * tool-use-only assistant turns (callers can distinguish).
 */
function extractText(payload: unknown): string | null {
  if (!isObj(payload)) return null
  const msg = payload["message"]
  if (!isObj(msg)) return null
  const content = msg["content"]
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (!isObj(block)) continue
      if (block["type"] === "text" && typeof block["text"] === "string") {
        parts.push(block["text"])
      }
      // thinking/tool_use/tool_result blocks contribute no chat text
    }
    return parts.join("")
  }
  return null
}

/**
 * Pull tool_use blocks out of an assistant payload's content array. Empty
 * array for non-assistant or non-tool-bearing payloads.
 */
function extractToolUses(payload: unknown): ReadonlyArray<ChatToolUse> {
  if (!isObj(payload)) return []
  const msg = payload["message"]
  if (!isObj(msg)) return []
  const content = msg["content"]
  if (!Array.isArray(content)) return []
  const out: ChatToolUse[] = []
  for (const block of content) {
    if (!isObj(block)) continue
    if (block["type"] !== "tool_use") continue
    const id = typeof block["id"] === "string" ? block["id"] : ""
    const name = typeof block["name"] === "string" ? block["name"] : ""
    if (!id || !name) continue
    out.push({ id, name, input: block["input"] })
  }
  return out
}

const ALLOWED_MEDIA_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

/**
 * Pull file attachment blocks out of a user payload's content array: base64
 * `image` blocks (allow-listed image media types) and base64 `document` blocks
 * (`application/pdf`). Empty array for non-user or non-attachment-bearing payloads.
 */
function extractAttachments(payload: unknown): ReadonlyArray<ChatAttachment> {
  if (!isObj(payload)) return []
  const msg = payload["message"]
  if (!isObj(msg)) return []
  const content = msg["content"]
  if (!Array.isArray(content)) return []
  const out: ChatAttachment[] = []
  for (const block of content) {
    if (!isObj(block)) continue
    const type = block["type"]
    if (type !== "image" && type !== "document") continue
    const source = block["source"]
    if (!isObj(source)) continue
    if (source["type"] !== "base64") continue
    const mt = source["media_type"]
    const data = source["data"]
    if (typeof mt !== "string" || typeof data !== "string") continue
    if (type === "image") {
      if (!ALLOWED_MEDIA_TYPES.has(mt)) continue
    } else {
      // document block — PDFs only
      if (mt !== "application/pdf") continue
    }
    out.push({ mediaType: mt as ChatAttachment["mediaType"], data })
  }
  return out
}

/**
 * Project a single stored envelope into a ChatMessage. Returns null for
 * messages we don't surface (system/result/stream_event/hook/status/other,
 * or malformed user/assistant payloads).
 */
export function projectOne(stored: StoredMessage): ChatMessage | null {
  if (stored.kind !== "user" && stored.kind !== "assistant") return null
  const text = extractText(stored.payload)
  if (text === null) return null
  const toolUses = extractToolUses(stored.payload)
  const attachments = stored.kind === "user" ? extractAttachments(stored.payload) : []
  // Skip wholly-empty user turns only when there are no attachments either
  // (defensive). Keep empty-text assistant turns when they carry tool_use
  // blocks (caller will render the tools).
  if (stored.kind === "user" && text.length === 0 && attachments.length === 0) return null
  return {
    id: stored.id,
    seq: stored.seq,
    ts: stored.ts,
    role: stored.kind,
    text,
    toolUses,
    attachments,
  }
}

/**
 * Stream-level projector: drop in front of `SessionStore.readMessages(id)`
 * to get a `Stream<ChatMessage>` ready for the WS layer to fan out.
 */
export function projectChatMessages<E>(
  src: Stream.Stream<StoredMessage, E>,
): Stream.Stream<ChatMessage, E> {
  return src.pipe(
    Stream.map(projectOne),
    Stream.filter((m): m is ChatMessage => m !== null),
  )
}
