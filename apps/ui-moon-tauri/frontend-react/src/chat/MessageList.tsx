/**
 * MessageList.tsx - the chat transcript's React reconciler, replacing
 * chat.html's former ChatRenderer (pure DOM diff) + ChatLoop (rAF-coalesced
 * render scheduler) - see chatModel.ts's module doc for the reducer half of
 * this conversion (stack23 S15).
 *
 * Mounted into the SAME `#chat-messages` container the vanilla renderer used
 * to own (`mountMessageList`), so `.chat-messages > * { flex-shrink: 0; }`
 * (chat.html's scroll-container invariant - see message-list.css) still
 * holds: every top-level item below (.msg / .timeline) renders as a DIRECT
 * child of the mount container, matching the former `data-msg-key`-keyed
 * sibling scheme exactly (same key format, same className rules) so the
 * page's other delegated listeners (luna:// links, timeline-collapse toggle,
 * relative-time refresh - all in chat.html, outside this conversion) keep
 * working unchanged against this container.
 *
 * `mountMessageList` returns a `{ ChatState, ChatLoop }` pair with the exact
 * external method surface the former globals had, so chat.html's ~40 call
 * sites elsewhere in its inline script (WebSocketEngine/MoonFrames frame
 * handlers, the turn watchdog, ...) don't change at all beyond the handful
 * of call sites that used to read/write `#chat-messages` DOM directly - see
 * chat.html's own comments at those sites for why each one now goes through
 * this bridge instead.
 *
 * Markdown: every text/timeline-step body renders `window.LunaMarkdown`'s
 * output (the frozen, audited sanitizer - see luna-markdown.d.ts) via
 * `dangerouslySetInnerHTML`, unchanged from the vanilla renderer's own
 * `body.innerHTML = fn(seg.raw)`. `enhanceCodeBlocks` (hljs + copy buttons)
 * runs in a `useEffect` keyed on the rendered HTML, mirroring the former
 * "paint text, then enhanceCodeBlocks(node)" sequencing exactly.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import {
  createChatModelStore,
  hasVisibleTypingIndicator,
  isTimelineEffectivelyCollapsed,
  planChatItems,
  findPendingTurn,
  type ChatModelState,
  type ChatModelStore,
  type Delivery,
  type DeliveredMessage,
  type HistoryMessage,
  type MergedStep,
  type PlannedItem,
  type Preview,
  type Segment,
  type TextSegment,
  type ToolSegment,
  type Turn,
} from "./chatModel"

// ============================================================================
// window.__MoonInternals.buildMessageMeta bridge
//
// buildMessageMeta/buildMessageCopyButton/formatRelTime stay vanilla DOM
// builders in chat.html (defined well before the CHAT MODEL block this slice
// converts - see chat.html's own comment there), carrying real behavior this
// slice must not fork (clipboard write + a timed "copied" state). Reused
// here via the same window.__MoonInternals seam every other test-hook /
// cross-boundary reference in chat.html already goes through.
//
// NOT declared as a `declare global` Window augmentation: index.html's hub
// (MoonHubApp.tsx) already claims window.__MoonInternals with its own,
// unrelated shape for that page - the two documents are different Tauri
// webview realms (see MEMORY.md) that happen to share a TS project, and
// `declare global` merging requires every declaration of the same property
// to agree on one type. A local, narrowly-typed read avoids that clash.
// ============================================================================

type BuildMessageMeta = (text: string, ts: number | undefined, delivery: Delivery | null) => HTMLElement

function getBuildMessageMeta(): BuildMessageMeta | null {
  const internals = (window as unknown as { __MoonInternals?: { buildMessageMeta?: BuildMessageMeta } })
    .__MoonInternals
  const fn = internals?.buildMessageMeta
  return typeof fn === "function" ? fn : null
}

/** Imperatively hosts buildMessageMeta's built `.msg-meta` row. `display:
 * contents` on the host makes it participate in `.msg`'s flex layout as if
 * `.msg-meta` were a direct child (no extra box) - see .msg's align-items
 * rule in message-list.css. */
function MetaRow({ text, ts, delivery }: { text: string; ts: number | undefined; delivery: Delivery | null }) {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    const build = getBuildMessageMeta()
    if (!host || !build) return
    host.replaceChildren(build(text, ts, delivery))
    return () => {
      host.replaceChildren()
    }
  }, [text, ts, delivery])
  return <div ref={hostRef} style={{ display: "contents" }} />
}

// ============================================================================
// Markdown rendering (window.LunaMarkdown - frozen, see luna-markdown.d.ts)
// ============================================================================

function renderSegmentHtml(seg: TextSegment): string {
  const api = window.LunaMarkdown
  if (!api) return ""
  return (seg.done ? api.renderMarkdown : api.renderMarkdownStreaming)(seg.raw)
}

/** A markdown body: renders `html` via dangerouslySetInnerHTML, then runs
 * enhanceCodeBlocks (hljs + copy buttons) on the freshly-committed subtree -
 * the exact "paint, then enhance" order _paintText/_paintTimeline used.
 *
 * `streamRaw`, when given, stamps `data-stream-raw` on this node - only the
 * `.timeline-step-text` role needs that (vanilla `_paintTimeline` set it on
 * `.timeline-step-text` itself; `_paintText` set it on the BUBBLE, not on
 * the `.msg-body` this component renders there - see TextItem's own
 * `data-stream-raw`). Passing it for the `.msg-body` role would duplicate
 * the bubble-level attribute onto its child. */
function MarkdownBody({
  raw,
  done,
  className,
  streamRaw,
}: {
  raw: string
  done: boolean
  className: string
  streamRaw?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => renderSegmentHtml({ kind: "text", raw, done }), [raw, done])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    window.LunaMarkdown?.enhanceCodeBlocks(el)
  }, [html])
  return (
    <div
      className={className}
      ref={ref}
      {...(streamRaw !== undefined ? { "data-stream-raw": streamRaw } : {})}
      // Sanitized by the frozen window.LunaMarkdown pipeline (see module doc).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

// ============================================================================
// Attachment preview tray (_buildPreviewTray)
// ============================================================================

function PreviewTray({ previews, hasText }: { previews: readonly Preview[]; hasText: boolean }) {
  return (
    <div className="attachments-strip" style={{ marginTop: hasText ? "8px" : "0" }}>
      {previews.map((p, i) => (
        // Previews carry no stable id from the composer - index is fine here:
        // this array is fixed at send-time and never reorders/mutates after.
        // eslint-disable-next-line react/no-array-index-key
        <div className="attachment-chip" key={i}>
          {p.kind === "image" && p.src ? (
            <img className="att-thumb" src={p.src} alt={p.name} />
          ) : (
            <span className="att-icon">{(p.name.split(".").pop() || "file").slice(0, 4)}</span>
          )}
          <span className="att-name">{p.name}</span>
        </div>
      ))}
    </div>
  )
}

// ============================================================================
// Tool-call card (buildToolStep)
// ============================================================================

function readStringField(input: unknown, field: string): string | null {
  if (!input || typeof input !== "object") return null
  const v = (input as Record<string, unknown>)[field]
  return typeof v === "string" ? v : null
}

function clampedInputJson(input: unknown): string {
  const CLAMP = 400
  try {
    const clamped =
      input && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input as Record<string, unknown>).map(([k, v]) => {
              if (typeof v === "string" && v.length > CLAMP) {
                return [k, v.slice(0, CLAMP) + "… (+" + (v.length - CLAMP) + " chars)"]
              }
              return [k, v]
            }),
          )
        : input
    return JSON.stringify(clamped, null, 2) ?? String(input)
  } catch (_) {
    return String(input)
  }
}

interface ToolCardProps {
  seg: ToolSegment
  turnId: string | undefined
  onOpenAgentsPanel: () => void
}

function ToolCard({ seg, turnId, onOpenAgentsPanel }: ToolCardProps) {
  const isAgent = seg.name === "Agent" || seg.name === "Task"
  const agentDesc = isAgent ? readStringField(seg.input, "description") : null
  const subtype = isAgent ? readStringField(seg.input, "subagent_type") : null
  const nestPrefix = seg.parentToolUseId ? "↳ " : ""
  const statusClass = !seg.result
    ? "tool-card-status tool-card-status-pending"
    : seg.result.ok
      ? "tool-card-status tool-card-status-ok"
      : "tool-card-status tool-card-status-error"
  const statusGlyph = !seg.result ? "…" : seg.result.ok ? "✓" : "✗"

  return (
    <div className="tool-call-card" data-tool-call-id={seg.id || undefined} data-turn-id={turnId || undefined}>
      <details>
        <summary>
          <span className="tool-card-chevron">▸</span>
          {agentDesc ? (
            <>
              <span className="tool-card-name">
                {nestPrefix}Agent — {agentDesc}
              </span>
              {subtype && (
                <span className="tool-card-subtype" style={{ opacity: 0.55, fontSize: "0.85em", marginLeft: "0.4em" }}>
                  {subtype}
                </span>
              )}
            </>
          ) : (
            <span className="tool-card-name">
              {nestPrefix}
              {seg.name}
            </span>
          )}
          <span className={statusClass}>{statusGlyph}</span>
          {isAgent && !seg.parentToolUseId && (
            <button
              type="button"
              className="agent-view-link"
              title="Open the live agents panel"
              style={{
                marginLeft: "0.5em",
                fontSize: "0.82em",
                background: "none",
                border: "none",
                color: "var(--accent,#8ab4f8)",
                cursor: "pointer",
                padding: 0,
              }}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onOpenAgentsPanel()
              }}
            >
              view ↗
            </button>
          )}
        </summary>
        <div className="tool-card-body">
          <div className="tool-card-section-label">input</div>
          <pre className="tool-card-input">{clampedInputJson(seg.input)}</pre>
          {seg.result && (
            <>
              <div className="tool-card-section-label">result</div>
              <pre className="tool-card-output">{seg.result.output}</pre>
              {seg.result.truncated && <div className="tool-card-truncated">(output truncated)</div>}
            </>
          )}
        </div>
      </details>
    </div>
  )
}

// ============================================================================
// Top-level item components (_paintUser / _paintBanner / _paintError /
// _paintTyping / _paintText / _paintTimeline)
// ============================================================================

function joinText(segments: readonly Segment[]): string {
  let text = ""
  for (const s of segments) if (s.kind === "text") text += s.raw
  return text
}

function turnIdAttr(turn: Turn): string | undefined {
  return turn.turnId ? String(turn.turnId) : undefined
}

/** The `data-msg-key`/`data-turn-id` pair every top-level item component
 * stamps on its own root node - centralized here (rather than hand-typed at
 * each call site) so the orphan-prune effect's keyed-lookup invariant can't
 * silently drop out of a component that forgets to spread it. */
function itemRootAttrs(msgKey: string, turn: Turn): { "data-msg-key": string; "data-turn-id": string | undefined } {
  return { "data-msg-key": msgKey, "data-turn-id": turnIdAttr(turn) }
}

function UserItem({ msgKey, turn }: { msgKey: string; turn: Turn }) {
  const text = joinText(turn.segments)
  return (
    <div className="msg user" {...itemRootAttrs(msgKey, turn)}>
      <div className="msg-body">
        {text}
        {turn.previews && turn.previews.length > 0 && <PreviewTray previews={turn.previews} hasText={!!text} />}
      </div>
      {text && <MetaRow text={text} ts={turn.ts} delivery={null} />}
    </div>
  )
}

function BannerItem({ msgKey, turn }: { msgKey: string; turn: Turn }) {
  return (
    <div className="msg assistant" {...itemRootAttrs(msgKey, turn)}>
      <div className="msg-body">{joinText(turn.segments)}</div>
    </div>
  )
}

function ErrorItem({ msgKey, turn }: { msgKey: string; turn: Turn }) {
  return (
    <div className="msg assistant error" {...itemRootAttrs(msgKey, turn)}>
      <div className="msg-body">{"⚠️ Error: " + (turn.errorText || "")}</div>
    </div>
  )
}

function TypingItem({ msgKey, turn }: { msgKey: string; turn: Turn }) {
  return (
    <div className="msg assistant" {...itemRootAttrs(msgKey, turn)}>
      <div className="msg-body">
        <div className="typing-dots">
          <div className="dot" />
          <div className="dot" />
          <div className="dot" />
        </div>
      </div>
    </div>
  )
}

function TextItem({ msgKey, turn, seg }: { msgKey: string; turn: Turn; seg: TextSegment }) {
  return (
    <div
      className="msg assistant"
      {...itemRootAttrs(msgKey, turn)}
      // Legacy hook mirrored from the vanilla `_paintText`'s `node.dataset.streamRaw
      // = seg.raw` (on the BUBBLE itself, not its `.msg-body` child) - tests and any
      // other `data-stream-raw` snoop read it here, not on MarkdownBody's own div.
      data-stream-raw={seg.raw}
    >
      <MarkdownBody raw={seg.raw} done={seg.done} className="msg-body" />
      {seg.done && seg.raw && <MetaRow text={seg.raw} ts={turn.ts} delivery={turn.delivery ?? null} />}
    </div>
  )
}

interface TimelineItemProps {
  msgKey: string
  turn: Turn
  merged: readonly MergedStep[]
  lastToolIndex: number
  settled: boolean
  onOpenAgentsPanel: () => void
}

function TimelineItem({ msgKey, turn, merged, lastToolIndex, settled, onOpenAgentsPanel }: TimelineItemProps) {
  const collapsed = isTimelineEffectivelyCollapsed(turn, settled)
  return (
    <div
      className={collapsed ? "timeline collapsed" : "timeline"}
      {...itemRootAttrs(msgKey, turn)}
      data-turn-key={turn.key}
    >
      <div className="timeline-summary">
        <span className="timeline-chevron">▸</span>
        <span className="timeline-summary-label">
          {settled ? `Worked for ${lastToolIndex + 1} step${lastToolIndex + 1 === 1 ? "" : "s"}` : "Working on it…"}
        </span>
        {!settled && (
          <div className="typing-dots">
            <div className="dot" />
            <div className="dot" />
            <div className="dot" />
          </div>
        )}
      </div>
      {!collapsed && (
        <div className="timeline-body">
          {merged.slice(0, lastToolIndex + 1).map((m, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div className="timeline-step" key={i}>
              {m.seg.kind === "tool" ? (
                <>
                  <span className="timeline-step-icon">
                    <span
                      className={
                        "tl-dot " + (!m.seg.result ? "pending" : m.seg.result.ok ? "ok" : "error")
                      }
                    />
                  </span>
                  <div className="timeline-step-content">
                    <ToolCard seg={m.seg} turnId={m.turn.turnId} onOpenAgentsPanel={onOpenAgentsPanel} />
                  </div>
                </>
              ) : (
                <>
                  <span className="timeline-step-icon">{"🌙"}</span>
                  <div className="timeline-step-content">
                    <MarkdownBody raw={m.seg.raw} done={m.seg.done} className="timeline-step-text" streamRaw={m.seg.raw} />
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Every item component takes `msgKey={item.key}` explicitly (never
// re-derives its own `turn.key + "<suffix>"`) so the planner's key and the
// rendered `data-msg-key` can never drift apart - that single source is what
// the orphan-prune effect below relies on to never delete a live React node.
function renderItem(item: PlannedItem, onOpenAgentsPanel: () => void) {
  switch (item.kind) {
    case "user":
      return <UserItem key={item.key} msgKey={item.key} turn={item.turn} />
    case "banner":
      return <BannerItem key={item.key} msgKey={item.key} turn={item.turn} />
    case "error":
      return <ErrorItem key={item.key} msgKey={item.key} turn={item.turn} />
    case "typing":
      return <TypingItem key={item.key} msgKey={item.key} turn={item.turn} />
    case "text":
      return <TextItem key={item.key} msgKey={item.key} turn={item.turn} seg={item.seg} />
    case "timeline":
      return (
        <TimelineItem
          key={item.key}
          msgKey={item.key}
          turn={item.turn}
          merged={item.merged}
          lastToolIndex={item.lastToolIndex}
          settled={item.settled}
          onOpenAgentsPanel={onOpenAgentsPanel}
        />
      )
    default:
      return null
  }
}

// ============================================================================
// Top-level component
// ============================================================================

function useChatModelState(store: ChatModelStore): ChatModelState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

// Empty-transcript fallback (formerly chat.html's static pre-mount "Hey
// there!" markup at #chat-messages - see main-chat.tsx's call site). Kept as
// a PlannedItem (not a raw DOM string) so it flows through the same
// keyed-render / orphan-prune path as every other item instead of needing a
// special case.
const WELCOME_TURN: Turn = {
  key: "welcome",
  role: "assistant",
  status: "banner",
  segments: [
    {
      kind: "text",
      raw: "Hey there! I am your native macOS Luna companion. Drag me anywhere on your screens, or click me to toggle this chat widget!",
      done: true,
    },
  ],
  previews: null,
}
export const WELCOME_ITEM: PlannedItem = { key: WELCOME_TURN.key, kind: "banner", turn: WELCOME_TURN }

export interface MessageListProps {
  store: ChatModelStore
  /** `State.serverSupportsTurnComplete !== false`, read live at plan time -
   * mirrors the vanilla `_plan()`'s own live read of that same global. */
  getGrouped: () => boolean
  /** The tool-card "view ↗" affordance opens the live Agents panel for
   * the CURRENT thread at click time (Tauri invoke lives in chat.html, which
   * owns State.activeThreadId / PINNED_THREAD / window.__TAURI__). */
  onOpenAgentsPanel: () => void
  /** The `#chat-messages` element this list is mounted into - used only for
   * scroll anchoring (it is not part of what React renders). */
  container: HTMLElement
  /** Rendered in place of a genuinely empty transcript (zero turns) - e.g.
   * `WELCOME_ITEM` above. Optional and off by default so a caller that wants
   * a bare empty transcript (tests, other mounts) is unaffected. */
  emptyStateItem?: PlannedItem
}

export function MessageList({ store, getGrouped, onOpenAgentsPanel, container, emptyStateItem }: MessageListProps) {
  const state = useChatModelState(store)
  // Read live on every render (not just when getGrouped's own identity
  // changes, which never happens - main-chat.tsx creates it once) so the
  // memo keys on the FLAG'S VALUE, matching getGrouped's own doc comment.
  const grouped = getGrouped()
  const items = useMemo(() => {
    const planned = planChatItems(state.turns, { grouped })
    return planned.length > 0 || !emptyStateItem ? planned : [emptyStateItem]
  }, [state.turns, grouped, emptyStateItem])

  // Mirrors vanilla ChatRenderer.render()'s step 1: drop any child whose
  // data-msg-key isn't in the current plan (pinned by chat-window.test.ts's
  // typing-dots scenario).
  useLayoutEffect(() => {
    const wantedKeys = new Set(items.map((item) => item.key))
    for (let i = container.children.length - 1; i >= 0; i--) {
      const child = container.children[i] as HTMLElement
      const key = child.dataset.msgKey
      if (!key || !wantedKeys.has(key)) child.remove()
    }
  }, [items, container])

  // Scroll anchoring: stick to bottom only while the user was already near
  // it (<=40px) - matches ChatLoop._render's wasNearBottom exactly, tracked
  // via a live scroll listener instead of a before/after measurement pair
  // (function components have no synchronous "before this commit" hook -
  // see chatModel.ts's module doc / the S15 implementation notes) so an
  // expand/collapse of an OLDER item never yanks the viewport, and streaming
  // stays pinned since the user sits at the bottom while a turn streams.
  const stickToBottomRef = useRef(true)
  useEffect(() => {
    const onScroll = () => {
      stickToBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight <= 40
    }
    container.addEventListener("scroll", onScroll, { passive: true })
    return () => container.removeEventListener("scroll", onScroll)
  }, [container])

  useLayoutEffect(() => {
    if (stickToBottomRef.current) container.scrollTop = container.scrollHeight
  }, [items, container])

  return <>{items.map((item) => renderItem(item, onOpenAgentsPanel))}</>
}

// ============================================================================
// Legacy bridge - the exact ChatState / ChatLoop external API chat.html's
// inline script keeps calling (see this file's module doc).
// ============================================================================

export interface ChatStateBridge {
  readonly turns: readonly Turn[]
  reset(): void
  loadHistory(messages: readonly HistoryMessage[]): void
  appendUser(text: string, previews?: readonly Preview[] | null, ts?: number): void
  appendBanner(text: string): void
  appendDelivered(message: DeliveredMessage): void
  beginPendingAssistant(): void
  applyDelta(turnId: string, text: string): void
  applyToolCall(turnId: string, toolCallId: string, name: string, input: unknown, parentToolUseId?: string): void
  applyToolResult(toolCallId: string, ok: boolean, output: string, truncated: boolean): void
  finishTurn(turnId: string, fullText: string, ts?: number): void
  failTurn(turnId: string, errorText?: string): void
  markRunSettled(): void
  /** Returns whether a placeholder was actually removed (legacy parity - no
   * caller currently reads this, kept for signature fidelity). */
  dropPendingAssistant(): boolean
  toggleTimelineCollapsed(turnKey: string, currentlyCollapsed: boolean): void
  /** Replaces the former "read the DOM's last child for .typing-dots" check
   * (see chat.html's disconnect handlers) with the state-driven equivalent. */
  hasVisibleStreamingPlaceholder(): boolean
  _findPending(): Turn | null
}

export interface ChatLoopBridge {
  /** rAF-coalesced: idempotent within a frame. */
  schedule(): void
  /** Forces a synchronous render via flushSync, so DOM reads immediately
   * after `flush()` (e.g. `chatMessages.querySelector(...)`) see it. */
  flush(): void
}

function createChatStateBridge(store: ChatModelStore, getGrouped: () => boolean): ChatStateBridge {
  return {
    get turns() {
      return store.getState().turns
    },
    reset() {
      store.dispatch({ type: "reset" })
    },
    loadHistory(messages) {
      store.dispatch({ type: "load-history", messages: messages || [] })
    },
    appendUser(text, previews, ts) {
      store.dispatch({
        type: "append-user",
        text,
        previews: previews ?? null,
        ...(ts !== undefined ? { ts } : {}),
      })
    },
    appendBanner(text) {
      store.dispatch({ type: "append-banner", text })
    },
    appendDelivered(message) {
      store.dispatch({ type: "append-delivered", message })
    },
    beginPendingAssistant() {
      store.dispatch({ type: "begin-pending-assistant" })
    },
    applyDelta(turnId, text) {
      store.dispatch({ type: "apply-delta", turnId, text })
    },
    applyToolCall(turnId, toolCallId, name, input, parentToolUseId) {
      store.dispatch({
        type: "apply-tool-call",
        turnId,
        toolCallId,
        name,
        input,
        ...(parentToolUseId ? { parentToolUseId } : {}),
      })
    },
    applyToolResult(toolCallId, ok, output, truncated) {
      store.dispatch({ type: "apply-tool-result", toolCallId, ok, output, truncated })
    },
    finishTurn(turnId, _fullText, ts) {
      store.dispatch({ type: "finish-turn", turnId, ...(ts !== undefined ? { ts } : {}) })
    },
    failTurn(turnId, errorText) {
      store.dispatch({ type: "fail-turn", turnId, ...(errorText !== undefined ? { errorText } : {}) })
    },
    markRunSettled() {
      store.dispatch({ type: "mark-run-settled" })
    },
    dropPendingAssistant() {
      const before = store.getState().turns.length
      store.dispatch({ type: "drop-pending-assistant" })
      return store.getState().turns.length !== before
    },
    toggleTimelineCollapsed(turnKey, currentlyCollapsed) {
      store.dispatch({ type: "toggle-timeline", turnKey, currentlyCollapsed })
    },
    hasVisibleStreamingPlaceholder() {
      return hasVisibleTypingIndicator(store.getState().turns, getGrouped())
    },
    _findPending() {
      return findPendingTurn(store.getState().turns)
    },
  }
}

function createChatLoopBridge(store: ChatModelStore): ChatLoopBridge {
  // Mirrors the former ChatLoop exactly, including the sentinel-first
  // cancellation ordering (its own comment explains why: a synchronously-
  // firing rAF, as jsdom test mocks use, must clear the flag before the
  // outer assignment can stomp it).
  let pending = 0
  return {
    schedule() {
      if (pending) return
      pending = -1
      const id = requestAnimationFrame(() => {
        pending = 0
        store.notify()
      })
      if (pending === -1) pending = id || -1
    },
    flush() {
      if (pending && pending > 0) cancelAnimationFrame(pending)
      pending = 0
      flushSync(() => store.notify())
    },
  }
}

export interface ChatMessageListCtx {
  /** Injectable for tests; defaults to a fresh store. */
  store?: ChatModelStore
  getGrouped: () => boolean
  onOpenAgentsPanel: () => void
  /** Forwarded to MessageList's `emptyStateItem` prop - see its doc. */
  emptyStateItem?: PlannedItem
}

export interface ChatMessageListMount {
  ChatState: ChatStateBridge
  ChatLoop: ChatLoopBridge
}

/** Mounts the React message list into `container` (chat.html's
 * `#chat-messages`) and returns the legacy `{ ChatState, ChatLoop }` bridge -
 * matches every other mount*'s `if (host) ...` degrade-to-no-op guard (see
 * chat-chrome-mount.tsx). */
export function mountMessageList(container: HTMLElement | null, ctx: ChatMessageListCtx): ChatMessageListMount | null {
  if (!container) return null
  const store = ctx.store ?? createChatModelStore()
  createRoot(container).render(
    <MessageList
      store={store}
      getGrouped={ctx.getGrouped}
      onOpenAgentsPanel={ctx.onOpenAgentsPanel}
      container={container}
      {...(ctx.emptyStateItem !== undefined ? { emptyStateItem: ctx.emptyStateItem } : {})}
    />,
  )
  return {
    ChatState: createChatStateBridge(store, ctx.getGrouped),
    ChatLoop: createChatLoopBridge(store),
  }
}
