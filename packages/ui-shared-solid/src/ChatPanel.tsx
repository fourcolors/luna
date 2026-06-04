/**
 * ChatPanel (Solid) — transcript + composer for a single thread.
 *
 * Solid port of apps/ui-web/src/App.tsx ChatPanel (line ~590). Behavior
 * parity:
 *   - empty state when thread is null (different copy for disabled)
 *   - transcript: all messages → MessageBubble; in-flight assistant
 *     turn rendered as plain streaming text; lastError as banner
 *   - auto-scroll to bottom on message-count or in-flight-text change
 *   - composer: textarea + paste + drag-drop + file picker
 *   - submit on Send / ⌘+Enter / (optionally) plain Enter
 *   - in-flight ⇒ Send becomes Stop (interrupt)
 *   - revoke object URLs on remove + on unmount
 *
 * Differences from React:
 *   - Solid uses class (not className), and accessing `props.x` inside
 *     the JSX keeps reactivity — destructuring would break it
 *   - createEffect tracks reads; the auto-scroll effect reads
 *     `thread.messages.length` and `thread.inFlight?.text`
 *   - onCleanup replaces the unmount useEffect for URL revocation
 */
import {
  type Component,
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js"
import {
  ALLOWED_ATTACH_TYPES,
  closeOpenFences,
  deriveTitle,
  fileToAttachment,
  type ChatAttachment,
  type PendingAttachment,
  type ThreadView,
} from "@luna/ui-shared/core"
import { MarkdownView } from "./MarkdownView.jsx"
import { MessageBubble } from "./MessageBubble.jsx"

/** Commands recognised in the composer (slash-prefixed). */
export type SlashCommand = "restart"

export interface ChatPanelProps {
  readonly thread: ThreadView | null
  readonly onSend: (
    threadId: string,
    text: string,
    attachments?: ReadonlyArray<ChatAttachment>,
  ) => void
  readonly onInterrupt: (threadId: string) => void
  /** Called when the user submits a recognised slash command. */
  readonly onCommand?: (threadId: string, command: SlashCommand) => void
  readonly disabled: boolean
  readonly enterToSend: boolean
}

export const ChatPanel: Component<ChatPanelProps> = (props) => {
  const [draft, setDraft] = createSignal("")
  const [attachments, setAttachments] = createSignal<PendingAttachment[]>([])
  const [attachError, setAttachError] = createSignal<string | null>(null)
  const [isDragOver, setIsDragOver] = createSignal(false)
  let fileInputEl: HTMLInputElement | undefined
  let transcriptEl: HTMLDivElement | undefined

  // Auto-scroll on new messages or in-flight delta updates. Reading
  // these reactive properties registers the effect's dependencies.
  createEffect(() => {
    const t = props.thread
    if (!t || !transcriptEl) return
    // Touch the reactive sources so this effect re-runs on changes.
    void t.messages.length
    void t.inFlight?.text
    transcriptEl.scrollTop = transcriptEl.scrollHeight
  })

  // Revoke any outstanding object URLs on unmount (thread switch,
  // disconnect). Without this, each attached image leaks its blob.
  onCleanup(() => {
    for (const a of attachments()) URL.revokeObjectURL(a.previewUrl)
  })

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    setAttachError(null)
    const arr = Array.from(files)
    const results = await Promise.allSettled(arr.map(fileToAttachment))
    const added: PendingAttachment[] = []
    const errors: string[] = []
    for (const r of results) {
      if (r.status === "fulfilled") added.push(r.value)
      else errors.push((r.reason as Error).message)
    }
    if (added.length > 0) setAttachments((prev) => [...prev, ...added])
    if (errors.length > 0) setAttachError(errors.join(" · "))
  }

  const removeAttachment = (id: string): void => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.id === id)
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      return prev.filter((a) => a.id !== id)
    })
  }

  const submit = (): void => {
    const t = props.thread
    if (!t) return
    const text = draft().trim()
    const atts = attachments()

    // Slash-command dispatch — recognised before regular send so commands
    // with attachments are also caught (attachments are cleared below).
    if (text === "/restart") {
      props.onCommand?.(t.summary.id, "restart")
      setDraft("")
      for (const a of atts) URL.revokeObjectURL(a.previewUrl)
      setAttachments([])
      setAttachError(null)
      return
    }

    if (!text && atts.length === 0) return
    props.onSend(
      t.summary.id,
      text,
      atts.length > 0
        ? atts.map((a) => ({ mediaType: a.mediaType, data: a.data }))
        : undefined,
    )
    setDraft("")
    for (const a of atts) URL.revokeObjectURL(a.previewUrl)
    setAttachments([])
    setAttachError(null)
  }

  const handlePaste = (e: ClipboardEvent): void => {
    if (!e.clipboardData) return
    const imageItems = Array.from(e.clipboardData.items).filter((item) =>
      ALLOWED_ATTACH_TYPES.has(item.type),
    )
    if (imageItems.length === 0) return
    e.preventDefault()
    const files = imageItems
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null)
    if (files.length > 0) void addFiles(files)
  }

  const handleDrop = (e: DragEvent): void => {
    e.preventDefault()
    setIsDragOver(false)
    if (!e.dataTransfer) return
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      ALLOWED_ATTACH_TYPES.has(f.type),
    )
    if (files.length > 0) void addFiles(files)
  }

  const placeholder = (): string =>
    props.disabled
      ? "Disconnected"
      : props.enterToSend
        ? "Type a message — Enter to send, Shift+Enter for newline"
        : "Type a message — ⌘/Ctrl+Enter to send"

  const canSend = (): boolean =>
    !props.disabled && (draft().trim().length > 0 || attachments().length > 0)

  /** Commands that should surface in the autocomplete hint. */
  const SLASH_COMMANDS: ReadonlyArray<{ cmd: string; desc: string }> = [
    { cmd: "/restart", desc: "Start a new thread" },
  ]

  /**
   * When the user has typed a bare `/` prefix, surface a pop-over listing
   * matching commands so they know what's available. We match the current
   * trimmed draft against the command list — partial matches work too
   * (`/r` surfaces `/restart`).
   */
  const slashHints = (): ReadonlyArray<{ cmd: string; desc: string }> => {
    const t = draft()
    if (!t.startsWith("/")) return []
    const needle = t.toLowerCase()
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(needle))
  }

  return (
    <Show
      when={props.thread}
      fallback={
        <main class="chat-panel">
          <div class="empty-state">
            <p class="muted">
              {props.disabled
                ? "Connect to a chat-capable server, then start a thread."
                : "Select a thread or start a new one."}
            </p>
          </div>
        </main>
      }
    >
      {(thread) => (
        <main class="chat-panel">
          <div class="chat-head">
            <div class="chat-title">
              {deriveTitle(thread().summary, thread()) ?? <em>untitled</em>}
            </div>
            <div class="muted small">
              {thread().summary.model || "—"} · {thread().messages.length} msg
            </div>
          </div>
          <div class="transcript" ref={transcriptEl}>
            <Show
              when={thread().messages.length === 0 && !thread().inFlight}
            >
              <div class="empty-state">
                <p class="muted">
                  No messages yet — say hello to get started.
                </p>
              </div>
            </Show>
            <For each={thread().messages}>
              {(m) => <MessageBubble message={m} />}
            </For>
            <Show when={thread().inFlight}>
              {(inFlight) => (
                <div class="bubble assistant in-flight">
                  <div class="bubble-role">assistant</div>
                  {/*
                    Stream markdown live: closeOpenFences() auto-completes
                    an unclosed ``` so the in-progress code block renders as
                    a code block instead of flickering into prose. Inline
                    emphasis (**bold**, *italic*, `code`) self-balances on
                    the next delta — we accept the brief raw-character
                    window as the cost of not over-engineering.
                  */}
                  <MarkdownView text={closeOpenFences(inFlight().text)} />
                  <div class="muted small">streaming…</div>
                </div>
              )}
            </Show>
            <Show when={thread().lastError}>
              {(err) => (
                <div class="banner closed">
                  error ({err().kind}): {err().message}
                </div>
              )}
            </Show>
          </div>
          <div
            class={`composer${isDragOver() ? " drag-over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault()
              setIsDragOver(true)
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
          >
            <Show when={attachments().length > 0}>
              <div class="attach-strip">
                <For each={attachments()}>
                  {(a) => (
                    <div class="attach-thumb">
                      <img src={a.previewUrl} alt={a.name} />
                      <button
                        class="attach-remove"
                        onClick={() => removeAttachment(a.id)}
                        title="Remove"
                      >
                        ×
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show when={attachError()}>
              {(msg) => <div class="attach-error">{msg()}</div>}
            </Show>
            <Show when={slashHints().length > 0}>
              <div class="slash-hints" role="listbox" aria-label="Slash commands">
                <For each={slashHints()}>
                  {(h) => (
                    <button
                      class="slash-hint-row"
                      role="option"
                      onClick={() => { setDraft(h.cmd); submit() }}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      <span class="slash-hint-cmd">{h.cmd}</span>
                      <span class="slash-hint-desc muted small">{h.desc}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <textarea
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              placeholder={placeholder()}
              disabled={props.disabled}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                // ⌘/Ctrl+Enter always submits.
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault()
                  submit()
                  return
                }
                // Plain Enter submits ONLY when enterToSend is on AND
                // no modifier is held. Shift+Enter falls through.
                if (
                  props.enterToSend &&
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.metaKey &&
                  !e.ctrlKey &&
                  !e.altKey
                ) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
            <div class="composer-actions">
              <input
                ref={fileInputEl}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  const target = e.currentTarget
                  if (target.files) void addFiles(target.files)
                  target.value = ""
                }}
              />
              <button
                class="attach-btn"
                onClick={() => fileInputEl?.click()}
                disabled={props.disabled}
                title="Attach image"
              >
                📎
              </button>
              <Show
                when={thread().inFlight}
                fallback={
                  <button onClick={submit} disabled={!canSend()}>
                    Send
                  </button>
                }
              >
                <button onClick={() => props.onInterrupt(thread().summary.id)}>
                  Stop
                </button>
              </Show>
            </div>
          </div>
        </main>
      )}
    </Show>
  )
}
