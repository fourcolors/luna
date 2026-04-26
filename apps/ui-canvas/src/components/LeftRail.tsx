import { useEffect, useRef } from "react"
import {
  MarkdownView,
  deriveTitle,
  type ChatMessage,
  type SessionSummary,
  type ThreadView,
} from "@experiment-agent/ui-shared"

/**
 * LeftRail — renders the active thread as a single scrolling card
 * (matching the reference screenshot). The thread list collapses to a
 * subtle dropdown above so multi-thread still works without dominating
 * the rail.
 */
export function LeftRail({
  threads,
  threadViews,
  selectedId,
  selectedThread,
  onSelect,
  onNew,
}: {
  threads: ReadonlyArray<SessionSummary>
  threadViews: ReadonlyMap<string, ThreadView>
  selectedId: string | null
  selectedThread: ThreadView | null
  onSelect: (id: string) => void
  onNew: (() => void) | null
}) {
  return (
    <aside className="left-rail">
      <ThreadDropdown
        threads={threads}
        threadViews={threadViews}
        selectedId={selectedId}
        onSelect={onSelect}
        onNew={onNew}
      />
      <ConversationCard thread={selectedThread} />
    </aside>
  )
}

function ThreadDropdown({
  threads,
  threadViews,
  selectedId,
  onSelect,
  onNew,
}: {
  threads: ReadonlyArray<SessionSummary>
  threadViews: ReadonlyMap<string, ThreadView>
  selectedId: string | null
  onSelect: (id: string) => void
  onNew: (() => void) | null
}) {
  const current = threads.find((t) => t.id === selectedId) ?? null
  const currentTitle = current
    ? (deriveTitle(current, threadViews.get(current.id)) ?? "untitled")
    : threads.length > 0
      ? "select a thread"
      : "new conversation"

  return (
    <div className="thread-dropdown">
      <button className="thread-pill" title="Switch thread">
        ⋯ <span className="thread-pill-label">{currentTitle}</span>
      </button>
      {threads.length > 1 && (
        <div className="thread-popover" role="menu">
          {threads.map((t) => (
            <button
              key={t.id}
              role="menuitem"
              className={`thread-popover-row ${t.id === selectedId ? "selected" : ""}`}
              onClick={() => onSelect(t.id)}
            >
              {deriveTitle(t, threadViews.get(t.id)) ?? "untitled"}
            </button>
          ))}
        </div>
      )}
      {onNew !== null && (
        <button className="thread-new" onClick={onNew} title="Start new thread">
          +
        </button>
      )}
    </div>
  )
}

function ConversationCard({ thread }: { thread: ThreadView | null }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [thread?.messages.length, thread?.inFlight?.text])

  if (!thread) {
    // No empty-state copy here — the canvas already tells the user what
    // to do. A second message would just compete for attention.
    return <div className="conversation-card empty" />
  }

  return (
    <div className="conversation-card" ref={scrollRef}>
      {thread.messages.length === 0 && !thread.inFlight && null}
      {thread.messages.map((m) => (
        <MessageRow key={`${m.id}-${m.seq}`} message={m} />
      ))}
      {thread.inFlight && (
        <div className="msg assistant streaming">
          <div className="msg-text">{thread.inFlight.text}</div>
          <div className="muted small">streaming…</div>
        </div>
      )}
      {thread.lastError && (
        <div className="banner closed">
          {thread.lastError.kind}: {thread.lastError.message}
        </div>
      )}
    </div>
  )
}

function MessageRow({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="msg user">
        <div className="msg-bubble">{message.text}</div>
      </div>
    )
  }
  return (
    <div className="msg assistant">
      <MarkdownView text={message.text} />
      {message.toolUses.length > 0 && (
        <div className="tool-chips">
          {message.toolUses.map((tu) => (
            <span className="tool-chip" key={tu.id}>
              🛠 {tu.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
