/**
 * useLunaInbox — the P3 INBOX seam (v1): an AGENT-MEDIATED projection over
 * the existing connectors + suggested-actions machinery, with ZERO net-new
 * server backend (see .scratch/luna-studio/INTEGRATION_SPEC.json,
 * seamWiring.inbox — there is no server-side inbox data model and nothing
 * polls Gmail/Calendar in the background; connectors only MOUNT tools into a
 * chat turn).
 *
 * How it works:
 *  1. If no connector instance is `connected` (state.connectorInstances),
 *     there is nothing to project — `items` stays `null` and FinalInbox
 *     renders an honest connection empty-state.
 *  2. Otherwise, on first availability (and on manual `refresh()`), this hub
 *     mints (once) or rediscovers a hidden, tagged "system" thread and sends
 *     it one instruction turn asking Luna to call whatever connector tools
 *     are mounted (e.g. mcp__google_workspace__*) and reply with ONLY a
 *     fenced JSON array of `{ who, subject, blocks }` entries.
 *  3. `turn-complete` — the ONLY true end-of-agentic-turn signal (protocol.ts;
 *     `assistant-done` alone fires per intermediate tool step too, so it
 *     cannot mark "the answer is ready") — is what tells us the turn settled;
 *     we then read the thread's last assistant message and parse it.
 *  4. A valid empty `[]` reply clears the inbox. Parse failures/timeouts retain
 *     the last valid projection rather than replacing it with fabricated data.
 *
 * This hook does NOT own a transport/socket — it rides useLunaData's single
 * connection via the `state`/`send`/`onServerFrame` escape hatch, so the
 * inbox projection and the user's live chat share one WebSocket.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ClientFrame, ServerFrame, UIState } from "@luna/ui-shared/core"

/** Mirrors data/useLunaData.ts's SYSTEM_THREAD_TAG — that hub filters any
 *  thread carrying this tag out of the design's thread list/sidebar and
 *  never auto-selects it as the active conversation. */
const SYSTEM_THREAD_TAG = "system"
const INBOX_THREAD_TAG = "inbox-projection"
const REQUEST_TIMEOUT_MS = 45_000

const CLIENT_INFO = { name: "luna-web-inbox", version: "0.0.1", platform: "browser" } as const

const PROJECTION_PROMPT = `You are projecting my connected accounts into an inbox feed for a UI. Call whichever connector tools are actually mounted on this turn (for example mcp__google_workspace__* for Gmail/Calendar, or any other connected connector tool) to find what genuinely needs my attention right now: unread or important email, upcoming calendar events, anything actionable. Do not fabricate content from tools you don't have.

Reply with ONLY a single fenced JSON code block, no prose before or after it, matching this shape (omit any field you have no real content for, and only include block types you have real content for: "quote", "detail", "callout", "list", "attach", "attendees"):

\`\`\`json
[
  {
    "who": "sender or event organizer name",
    "subject": "short title line",
    "kind": "email",
    "prio": "act",
    "blocks": [
      { "t": "quote", "who": "optional attribution", "html": "a short quoted snippet, plain text or simple <b> tags only" },
      { "t": "detail", "rows": [["Label", "value"]] }
    ]
  }
]
\`\`\`

"kind" is one of "email" | "todo" | "ping" | "calendar". "prio" is "act" | "soon", omit if neither applies. If you have no connected tools mounted, or genuinely nothing needs attention, reply with exactly: []`

export type InboxItemKind = "email" | "todo" | "ping" | "calendar"
export type InboxPriority = "act" | "soon"

export interface InboxDetailBlock {
  readonly t: "detail"
  readonly rows: ReadonlyArray<readonly [string, string, boolean?]>
}
export interface InboxQuoteBlock {
  readonly t: "quote"
  readonly who?: string
  readonly html: string
}
export interface InboxFigBlock {
  readonly t: "fig"
  readonly rows: ReadonlyArray<readonly [string, string, boolean?]>
}
export interface InboxCalloutBlock {
  readonly t: "callout"
  readonly html: string
}
export interface InboxListBlock {
  readonly t: "list"
  readonly items: ReadonlyArray<string>
}
export interface InboxAttachBlock {
  readonly t: "attach"
  readonly name: string
  readonly meta: string
}
export interface InboxThreadBlock {
  readonly t: "thread"
  readonly msgs: ReadonlyArray<{ readonly who: string; readonly html: string }>
}
export interface InboxAttendeesBlock {
  readonly t: "attendees"
  readonly label: string
  readonly names: ReadonlyArray<string>
  readonly colors: ReadonlyArray<string>
}
export type InboxBlock =
  | InboxDetailBlock
  | InboxQuoteBlock
  | InboxFigBlock
  | InboxCalloutBlock
  | InboxListBlock
  | InboxAttachBlock
  | InboxThreadBlock
  | InboxAttendeesBlock

export interface InboxOption {
  readonly name: string
  readonly meta: string
}

/** Shaped to match final-inbox.jsx's INBOX_SEED item exactly (studio-data.jsx). */
export interface InboxItem {
  readonly id: string
  readonly kind: InboxItemKind
  readonly from?: string
  readonly brain?: string
  readonly title: string
  readonly sub: string
  readonly time: string
  readonly prio?: InboxPriority
  readonly lead?: string
  readonly rich?: ReadonlyArray<InboxBlock>
  readonly options?: ReadonlyArray<InboxOption>
}

export interface UseLunaInboxParams {
  readonly state: UIState
  readonly send: (frame: ClientFrame) => void
  readonly onServerFrame: (listener: (frame: ServerFrame) => void) => () => void
  readonly connected: boolean
  readonly model: string
}

export interface LunaInbox {
  /** `null` = no real projection yet. An empty array is a valid inbox-zero. */
  readonly items: ReadonlyArray<InboxItem> | null
  /** At least one connected account can supply an inbox projection. */
  readonly available: boolean
  /** True while a projection turn is in flight. */
  readonly loading: boolean
  /** Kick off a fresh projection turn (no-op while one is already in flight
   *  or the transport isn't connected). */
  readonly refresh: () => void
}

const DEFAULT_ATTENDEE_COLORS = ["var(--wash-0)", "var(--wash-2)", "var(--wash-3)", "var(--wash-4)"]

function isStringTuple2Plus(x: unknown): x is [string, string, boolean?] {
  return Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "string"
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "")
}

function sanitizeBlock(raw: unknown): InboxBlock | null {
  if (!raw || typeof raw !== "object") return null
  const b = raw as Record<string, unknown>
  const t = b["t"]
  if (typeof t !== "string") return null
  switch (t) {
    case "detail":
    case "fig": {
      const rows = Array.isArray(b["rows"]) ? b["rows"].filter(isStringTuple2Plus) : []
      return rows.length ? { t, rows } : null
    }
    case "quote": {
      if (typeof b["html"] !== "string") return null
      const who = typeof b["who"] === "string" ? b["who"] : undefined
      return { t: "quote", html: b["html"], ...(who ? { who } : {}) }
    }
    case "callout":
      return typeof b["html"] === "string" ? { t: "callout", html: b["html"] } : null
    case "list": {
      const items = Array.isArray(b["items"])
        ? b["items"].filter((x): x is string => typeof x === "string")
        : []
      return items.length ? { t: "list", items } : null
    }
    case "attach":
      return typeof b["name"] === "string"
        ? { t: "attach", name: b["name"], meta: typeof b["meta"] === "string" ? b["meta"] : "" }
        : null
    case "thread": {
      const msgs = Array.isArray(b["msgs"])
        ? b["msgs"].filter(
            (m): m is { who: string; html: string } =>
              !!m &&
              typeof m === "object" &&
              typeof (m as Record<string, unknown>)["who"] === "string" &&
              typeof (m as Record<string, unknown>)["html"] === "string",
          )
        : []
      return msgs.length ? { t: "thread", msgs } : null
    }
    case "attendees": {
      const names = Array.isArray(b["names"])
        ? b["names"].filter((x): x is string => typeof x === "string")
        : []
      if (!names.length) return null
      const colors = Array.isArray(b["colors"])
        ? b["colors"].filter((x): x is string => typeof x === "string")
        : []
      const label = typeof b["label"] === "string" ? b["label"] : names.join(" + ")
      return { t: "attendees", label, names, colors: colors.length ? colors : DEFAULT_ATTENDEE_COLORS }
    }
    default:
      return null
  }
}

function summarize(blocks: ReadonlyArray<InboxBlock>): string {
  const first = blocks[0]
  if (!first) return ""
  if (first.t === "quote" || first.t === "callout") return stripHtml(first.html).slice(0, 96)
  if (first.t === "list" && first.items[0]) return stripHtml(first.items[0]).slice(0, 96)
  return ""
}

const VALID_KINDS: ReadonlySet<string> = new Set(["email", "todo", "ping", "calendar"])
const VALID_PRIOS: ReadonlySet<string> = new Set(["act", "soon"])

function mapProjectedItem(raw: unknown, idx: number): InboxItem | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const subject = typeof r["subject"] === "string" ? r["subject"].trim() : ""
  if (!subject) return null
  const who = typeof r["who"] === "string" && r["who"].trim() ? r["who"].trim() : undefined
  const blocks = (Array.isArray(r["blocks"]) ? r["blocks"] : [])
    .map(sanitizeBlock)
    .filter((b): b is InboxBlock => b !== null)
  const kindRaw = r["kind"]
  const kind: InboxItemKind =
    typeof kindRaw === "string" && VALID_KINDS.has(kindRaw)
      ? (kindRaw as InboxItemKind)
      : who
        ? "email"
        : "todo"
  const prioRaw = r["prio"]
  const prio: InboxPriority | undefined =
    typeof prioRaw === "string" && VALID_PRIOS.has(prioRaw) ? (prioRaw as InboxPriority) : undefined
  const options = (Array.isArray(r["options"]) ? r["options"] : [])
    .map((o): InboxOption | null =>
      o && typeof o === "object" && typeof (o as Record<string, unknown>)["name"] === "string"
        ? {
            name: (o as Record<string, unknown>)["name"] as string,
            meta:
              typeof (o as Record<string, unknown>)["meta"] === "string"
                ? ((o as Record<string, unknown>)["meta"] as string)
                : "",
          }
        : null,
    )
    .filter((o): o is InboxOption => o !== null)
  return {
    id: typeof r["id"] === "string" && r["id"] ? r["id"] : `proj-${idx}`,
    kind,
    ...(who ? { from: who } : {}),
    title: subject,
    sub: typeof r["sub"] === "string" ? r["sub"] : summarize(blocks),
    time: typeof r["time"] === "string" ? r["time"] : "now",
    ...(prio ? { prio } : {}),
    ...(typeof r["lead"] === "string" ? { lead: r["lead"] } : {}),
    ...(blocks.length ? { rich: blocks } : {}),
    ...(options.length ? { options } : {}),
  }
}

/** Pulls the JSON payload out of a reply that SHOULD be a bare fenced code
 *  block, but tolerates stray prose around it (models don't always obey). */
function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidate = fence ? fence[1]!.trim() : trimmed
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf("[")
    const end = candidate.lastIndexOf("]")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1))
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

function parseProjection(text: string): ReadonlyArray<InboxItem> | null {
  const parsed = extractJson(text)
  if (!Array.isArray(parsed)) return null
  return parsed.map((x, i) => mapProjectedItem(x, i)).filter((x): x is InboxItem => x !== null)
}

export function useLunaInbox(params: UseLunaInboxParams): LunaInbox {
  const { state, send, onServerFrame, connected, model } = params

  const [items, setItems] = useState<ReadonlyArray<InboxItem> | null>(null)
  const [loading, setLoading] = useState(false)

  const threadIdRef = useRef<string | null>(null)
  const creatingRef = useRef(false)
  const pendingRef = useRef(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Rediscover a previously-minted inbox-sync thread (survives reload/reconnect
  // — the server keeps the session row; only our in-memory ref is gone).
  useEffect(() => {
    if (threadIdRef.current) return
    const found = state.threadList.find((s) => s.tags.includes(INBOX_THREAD_TAG))
    if (found) threadIdRef.current = found.id
  }, [state.threadList])

  const connectorsAvailable = useMemo(
    () => state.connectorInstances.some((i) => i.status === "connected"),
    [state.connectorInstances],
  )

  const clearPending = useCallback(() => {
    pendingRef.current = false
    setLoading(false)
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const sendProjectionPrompt = useCallback(
    (threadId: string) => {
      send({ type: "subscribe", threadId })
      send({ type: "user-message", threadId, text: PROJECTION_PROMPT, client: CLIENT_INFO })
    },
    [send],
  )

  const refresh = useCallback((): void => {
    if (!connected || pendingRef.current) return
    pendingRef.current = true
    setLoading(true)
    timeoutRef.current = setTimeout(clearPending, REQUEST_TIMEOUT_MS)

    if (threadIdRef.current) {
      sendProjectionPrompt(threadIdRef.current)
    } else if (!creatingRef.current) {
      creatingRef.current = true
      send({
        type: "new-thread",
        model,
        title: "Inbox sync (system)",
        tags: [SYSTEM_THREAD_TAG, INBOX_THREAD_TAG],
      })
    }
  }, [connected, model, send, clearPending, sendProjectionPrompt])

  // Drive the projection off raw frames: thread-created resolves our pending
  // create (and fires the actual prompt once the thread exists); turn-complete
  // is the only true end-of-turn signal (assistant-done alone fires per
  // intermediate tool step too — reading the thread on that would race a
  // still-running tool call); assistant-error/thread-create-error give up
  // gracefully and leave whatever valid `items` already existed.
  useEffect(() => {
    return onServerFrame((frame: ServerFrame) => {
      if (frame.type === "thread-created" && creatingRef.current && frame.thread.tags.includes(INBOX_THREAD_TAG)) {
        creatingRef.current = false
        threadIdRef.current = frame.thread.id
        if (pendingRef.current) sendProjectionPrompt(frame.thread.id)
        return
      }
      if (frame.type === "thread-create-error" && creatingRef.current) {
        creatingRef.current = false
        clearPending()
        return
      }
      if (!pendingRef.current || !threadIdRef.current) return
      if (frame.type === "turn-complete" && frame.threadId === threadIdRef.current) {
        const view = state.threads.get(threadIdRef.current)
        const last = view?.messages[view.messages.length - 1]
        const text = last && last.role === "assistant" ? last.text : ""
        clearPending()
        const parsed = parseProjection(text)
        if (parsed !== null) setItems(parsed)
        // Parse failure: leave the prior valid projection intact.
        return
      }
      if (frame.type === "assistant-error" && frame.threadId === threadIdRef.current) {
        clearPending()
      }
    })
  }, [onServerFrame, clearPending, sendProjectionPrompt, state.threads])

  // Auto-run once connectors become available (covers "already connected at
  // boot" and "just finished OAuth connect mid-session"); never on a bare
  // transport reconnect while availability was already known.
  const wasAvailableRef = useRef(false)
  useEffect(() => {
    const becameAvailable = connectorsAvailable && !wasAvailableRef.current
    wasAvailableRef.current = connectorsAvailable
    if (connected && becameAvailable) refresh()
  }, [connected, connectorsAvailable, refresh])

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  return { items, available: connectorsAvailable, loading, refresh }
}
