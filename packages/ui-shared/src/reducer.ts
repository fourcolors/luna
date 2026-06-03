/**
 * Frame reducer: pure function from (state, frame) → next state.
 *
 * v2 adds chat. Each thread carries its own message list, an optional
 * in-flight assistant turn (turnId + cumulative text from delta frames),
 * and a `throughSeq` watermark so post-snapshot live frames with
 * `seq <= throughSeq` get deduped (covers reconnect-during-turn).
 *
 * Obs frames (event/drop/ping) keep working unchanged — chat is purely
 * additive and lives on a separate slice of state.
 */
import type {
  Artifact,
  ChatErrorKind,
  ChatMessage,
  ObsEvent,
  ObsEventKind,
  ServerFrame,
  SessionSummary,
} from "./wire.js"

export interface InFlightTurn {
  readonly turnId: string
  readonly text: string
}

export interface ThreadView {
  readonly summary: SessionSummary
  readonly messages: ReadonlyArray<ChatMessage>
  readonly throughSeq: number
  /** Cumulative assistant text for the in-flight turn, if any. */
  readonly inFlight: InFlightTurn | null
  readonly lastError: {
    readonly kind: ChatErrorKind
    readonly message: string
  } | null
  /** Artifacts extracted from finalized assistant turns, oldest-first. */
  readonly artifacts: ReadonlyArray<Artifact>
}

export interface UIState {
  readonly events: ReadonlyArray<ObsEvent>
  readonly seenKinds: ReadonlyArray<string>
  readonly advertisedKinds: ReadonlyArray<string>
  readonly droppedTotal: number
  readonly lastDrop: { readonly n: number; readonly since: string } | null
  readonly lastPingAt: string | null
  readonly closeReason: string | null
  /** Server-advertised capabilities. */
  readonly capabilities: { readonly chat: boolean; readonly streamingDeltas: boolean; readonly setup: boolean }
  /** Sidebar projection — most-recently-active first (server orders). */
  readonly threadList: ReadonlyArray<SessionSummary>
  /** Per-thread state, keyed by threadId. */
  readonly threads: ReadonlyMap<string, ThreadView>
  /** Currently-selected thread (chat panel renders this). */
  readonly selectedThreadId: string | null
  /** Available accounts from the server (public info only — no secrets). */
  readonly accounts: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly kind: string
    readonly health: string
  }>
  /** Currently-selected account id. null = use default broker rotation. */
  readonly selectedAccountId: string | null
}

export const initialState: UIState = {
  events: [],
  seenKinds: [],
  advertisedKinds: [],
  droppedTotal: 0,
  lastDrop: null,
  lastPingAt: null,
  closeReason: null,
  capabilities: { chat: false, streamingDeltas: false, setup: false },
  threadList: [],
  threads: new Map(),
  selectedThreadId: null,
  accounts: [],
  selectedAccountId: null,
}

const MAX_RETAINED = 500

const addKindIfNew = (
  list: ReadonlyArray<string>,
  kind: string,
): ReadonlyArray<string> => (list.includes(kind) ? list : [...list, kind])

const updateThread = (
  state: UIState,
  threadId: string,
  fn: (t: ThreadView) => ThreadView,
): UIState => {
  const cur = state.threads.get(threadId)
  if (!cur) return state
  const next = new Map(state.threads)
  next.set(threadId, fn(cur))
  return { ...state, threads: next }
}

const ensureSummary = (
  state: UIState,
  threadId: string,
): SessionSummary | null => {
  const t = state.threads.get(threadId)
  if (t) return t.summary
  // The thread might be in the list but not yet expanded.
  return state.threadList.find((s) => s.id === threadId) ?? null
}

/** Reduce a `UserMessage` ClientFrame's local optimistic state — used by
 *  the App when it sends a user-message before the server's user-accepted
 *  echo lands. We just pre-extend the in-flight turn with no text yet. */
export type ChatLocalAction =
  | { readonly tag: "select-thread"; readonly threadId: string | null }
  | { readonly tag: "select-account"; readonly accountId: string | null }
  | { readonly tag: "init-thread"; readonly summary: SessionSummary }
  | {
      readonly tag: "optimistic-user"
      readonly threadId: string
      readonly text: string
    }

export type Action = ServerFrame | ChatLocalAction

const isServerFrame = (a: Action): a is ServerFrame =>
  "type" in (a as Record<string, unknown>) &&
  typeof (a as { type: unknown }).type === "string"

export const reduce = (state: UIState, action: Action): UIState => {
  if (!isServerFrame(action)) {
    switch (action.tag) {
      case "select-thread":
        return { ...state, selectedThreadId: action.threadId }
      case "select-account":
        return { ...state, selectedAccountId: action.accountId }
      case "init-thread": {
        // Insert a placeholder ThreadView for a freshly-created thread
        // so the chat panel can render immediately even before the
        // first thread-snapshot arrives.
        if (state.threads.has(action.summary.id)) return state
        const next = new Map(state.threads)
        next.set(action.summary.id, {
          summary: action.summary,
          messages: [],
          throughSeq: -1,
          inFlight: null,
          lastError: null,
          artifacts: [],
        })
        const list = [
          action.summary,
          ...state.threadList.filter((s) => s.id !== action.summary.id),
        ]
        return { ...state, threads: next, threadList: list }
      }
      case "optimistic-user":
        // No-op visual marker for now — real "user-accepted" frame will
        // append the actual ChatMessage. Future: pending bubble.
        return state
    }
  }

  const frame = action
  switch (frame.type) {
    case "hello":
      return {
        ...state,
        advertisedKinds: frame.kinds,
        capabilities: frame.capabilities,
        closeReason: null,
      }
    case "event": {
      const next = [frame.event, ...state.events].slice(0, MAX_RETAINED)
      return {
        ...state,
        events: next,
        seenKinds: addKindIfNew(state.seenKinds, frame.event.kind),
      }
    }
    case "drop":
      return {
        ...state,
        droppedTotal: state.droppedTotal + frame.n,
        lastDrop: { n: frame.n, since: frame.since },
      }
    case "ping":
      return { ...state, lastPingAt: frame.ts }
    case "bye":
      return { ...state, closeReason: frame.reason }
    case "thread-list":
      return { ...state, threadList: frame.threads }
    case "thread-created": {
      // Server auto-subscribes; we'll get a thread-snapshot next.
      const next = new Map(state.threads)
      next.set(frame.thread.id, {
        summary: frame.thread,
        messages: [],
        throughSeq: -1,
        inFlight: null,
        lastError: null,
        artifacts: [],
      })
      const list = [
        frame.thread,
        ...state.threadList.filter((s) => s.id !== frame.thread.id),
      ]
      return {
        ...state,
        threads: next,
        threadList: list,
        selectedThreadId: frame.thread.id,
      }
    }
    case "thread-snapshot": {
      const summary = ensureSummary(state, frame.threadId)
      const placeholder: SessionSummary = summary ?? {
        id: frame.threadId,
        parentId: null,
        title: null,
        tags: [],
        createdAt: 0,
        endedAt: null,
        model: "",
        status: "active",
        lastMessageAt: null,
        lastMessagePreview: null,
      }
      const next = new Map(state.threads)
      const cur = state.threads.get(frame.threadId)
      next.set(frame.threadId, {
        summary: cur?.summary ?? placeholder,
        messages: frame.messages,
        throughSeq: frame.throughSeq,
        inFlight: cur?.inFlight ?? null,
        lastError: cur?.lastError ?? null,
        artifacts: cur?.artifacts ?? [],
      })
      return { ...state, threads: next }
    }
    case "user-accepted":
      return updateThread(state, frame.threadId, (t) => {
        if (frame.seq <= t.throughSeq) return t // dedupe
        return {
          ...t,
          messages: [...t.messages, frame.message],
          throughSeq: Math.max(t.throughSeq, frame.seq),
          lastError: null,
        }
      })
    case "assistant-delta":
      return updateThread(state, frame.threadId, (t) => ({
        ...t,
        inFlight: { turnId: frame.turnId, text: frame.text },
      }))
    case "assistant-done":
      return updateThread(state, frame.threadId, (t) => {
        if (frame.seq <= t.throughSeq) {
          return { ...t, inFlight: null }
        }
        return {
          ...t,
          messages: [...t.messages, frame.message],
          throughSeq: Math.max(t.throughSeq, frame.seq),
          inFlight: null,
        }
      })
    case "assistant-error":
      return updateThread(state, frame.threadId, (t) => ({
        ...t,
        inFlight: null,
        lastError: frame.error,
      }))
    case "artifacts-extracted":
      return updateThread(state, frame.threadId, (t) => {
        // Replace any prior artifacts for this messageId (idempotent
        // under reconnect-during-extraction) and append new ones.
        const filtered = t.artifacts.filter(
          (a) => !a.id.startsWith(frame.messageId + ":"),
        )
        return { ...t, artifacts: [...filtered, ...frame.artifacts] }
      })
    case "account-list": {
      return {
        ...state,
        accounts: frame.accounts,
        // selectedAccountId intentionally NOT changed here.
        // null = "Auto" (broker picks). User must explicitly select an account.
        // On reconnect, user's prior selection is preserved as-is.
      }
    }
    case "pty-output":
      // pty output is consumed by the setup terminal directly off the
      // transport (streamy frame), not folded into store state.
      return state
  }
}

export const filterEvents = (
  events: ReadonlyArray<ObsEvent>,
  selectedKinds: ReadonlySet<string>,
): ReadonlyArray<ObsEvent> => {
  if (selectedKinds.size === 0) return events
  return events.filter((e) => selectedKinds.has(e.kind))
}

export type { ObsEventKind }
