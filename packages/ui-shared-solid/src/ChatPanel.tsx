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
  type NewThreadFrame,
  type PendingAttachment,
  type ThreadView,
  type SuggestedActionWire,
} from "@luna/ui-shared/core"
import { MarkdownView } from "./MarkdownView.jsx"
import { MessageBubble } from "./MessageBubble.jsx"

/** Commands recognised in the composer (slash-prefixed). */
export type SlashCommand = "restart"

/** The five real SDK effort levels. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max"

/**
 * What a client may pick in the effort dropdown / carry on the wire: a real
 * effort level OR the "ultracode" token. ultracode is NOT a real SDK effort —
 * the server demuxes it into the SDK's ultracode mode (xhigh + standing
 * workflow orchestration). The web only renders + echoes the token; it never
 * feeds it to an SDK. Mirrors the server's effort.ts `EffortOption`.
 */
export type EffortOption = EffortLevel | "ultracode"

export interface AvailableModel {
  readonly id: string
  readonly label: string
  readonly efforts?: ReadonlyArray<EffortOption>
  /**
   * Effort a fresh thread should default to for this model when the client has
   * no persisted selection — server-advertised via the hello frame. Undefined
   * ⇒ no opinion; the dropdown then falls back to the weakest supported level.
   */
  readonly defaultEffort?: EffortOption
}

/**
 * Clamp a persisted effort against the SERVER-computed validity list for one
 * model. Returns the effort unchanged when `availableModels[modelId].efforts`
 * contains it; returns undefined otherwise (unknown model, no list, effort-less
 * model, or no server list at all). This only CONSUMES the server matrix —
 * clients never compute which efforts a model supports.
 *
 * Used by App.tsx for (review F5) gating `new-thread.effort` and (review F11)
 * dropping a stale persisted effort when the user switches model — mirroring
 * moon's `_selectModel` localStorage clear.
 */
export const clampEffortToModel = (
  availableModels: ReadonlyArray<AvailableModel> | null | undefined,
  modelId: string,
  effort: EffortOption | undefined,
): EffortOption | undefined => {
  if (effort === undefined || availableModels == null) return undefined
  const model = availableModels.find((m) => m.id === modelId)
  return model?.efforts?.includes(effort) ? effort : undefined
}

/**
 * Build a `new-thread` client frame from persisted config + server state
 * (review F5: ui-web previously dropped effort on every new thread).
 * `effort` is included ONLY when the server matrix lists it for the chosen
 * model — otherwise omitted so the server default applies (also the safe
 * behavior against old servers, where `availableModels` is null).
 * `accountId` is included only when non-null. Pure → unit-testable without
 * mounting the App shell.
 */
export const buildNewThreadFrame = (params: {
  readonly model: string
  readonly effort?: EffortOption | undefined
  readonly accountId?: string | null | undefined
  readonly availableModels?: ReadonlyArray<AvailableModel> | null | undefined
}): NewThreadFrame => {
  // With no persisted effort, fall back to the model's server-advertised
  // default (e.g. Sonnet 5 → "high") so a brand-new thread starts at the
  // intended level instead of being omitted (which lands on the SDK default).
  const modelDefaultEffort = params.availableModels?.find(
    (m) => m.id === params.model,
  )?.defaultEffort
  const effort = clampEffortToModel(
    params.availableModels,
    params.model,
    params.effort ?? modelDefaultEffort,
  )
  return {
    type: "new-thread",
    model: params.model,
    ...(effort !== undefined ? { effort } : {}),
    ...(params.accountId != null ? { accountId: params.accountId } : {}),
  }
}

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
  // ── model + effort config (§3C) ──────────────────────────────────────
  /**
   * Server-advertised model list. When null/absent the cluster is hidden.
   * null = server didn't send availableModels (old server); undefined = not yet wired.
   */
  readonly availableModels?: ReadonlyArray<AvailableModel> | null
  /** When true the server supports effort selection. Cluster hidden when false/absent/undefined. */
  readonly effortSelection?: boolean | undefined
  /** Currently selected model id for this thread. */
  readonly model?: string
  /** Currently selected effort level for this thread. */
  readonly effort?: EffortOption | undefined
  /** Called when the user picks a different model. */
  readonly onModelChange?: (threadId: string, model: string) => void
  /** Called when the user picks a different effort level. */
  readonly onEffortChange?: (threadId: string, effort: EffortOption) => void
  // ── Suggested actions inline chip ──────────────────────────────────────
  /** The active thread's suggested actions (from store.state.suggestedActions). */
  readonly suggestedActions?: ReadonlyArray<SuggestedActionWire>
  /** Called when the user accepts the inline suggestion. */
  readonly onAcceptSuggestion?: (id: string) => void
  /** Called when the user dismisses the inline suggestion. */
  readonly onDismissSuggestion?: (id: string) => void
  /** Called when the user clicks "see all" — opens the actions panel. */
  readonly onSeeAllSuggestions?: () => void
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
            {/* ── Suggested action inline chip ────────────────────────────
                Shows the NEWEST proposed action (highest createdAt) when
                handlers are wired in — matching Moon's chip. The store array is
                oldest-first, so we pick the max by createdAt rather than the
                first match. Stays purely presentational. */}
            <Show
              when={(() => {
                const actions = props.suggestedActions
                if (!actions || !props.onAcceptSuggestion || !props.onDismissSuggestion) return null
                let newest: SuggestedActionWire | null = null
                for (const a of actions) {
                  if (a.status !== "proposed") continue
                  if (newest === null || a.createdAt > newest.createdAt) newest = a
                }
                return newest
              })()}
            >
              {(action) => (
                <div
                  class="bubble assistant"
                  style={{
                    "border-left": "2px solid var(--color-accent, #60a5fa)",
                    "padding-left": "0.5rem",
                    "margin-top": "0.5rem",
                  }}
                  role="status"
                  aria-live="polite"
                >
                  <div class="bubble-role muted small">Luna suggested an action</div>
                  <div style={{ "font-weight": "500", margin: "0.2rem 0" }}>
                    {action().title}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: "0.4rem",
                      "flex-wrap": "wrap",
                      "margin-top": "0.3rem",
                    }}
                  >
                    <button
                      type="button"
                      class="chip small"
                      style={{ color: "var(--color-success, #4ade80)" }}
                      onClick={() => props.onAcceptSuggestion!(action().id)}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      class="chip small"
                      style={{ color: "var(--color-muted, #888)" }}
                      onClick={() => props.onDismissSuggestion!(action().id)}
                    >
                      Dismiss
                    </button>
                    <Show when={props.onSeeAllSuggestions}>
                      <button
                        type="button"
                        class="chip small"
                        onClick={() => props.onSeeAllSuggestions!()}
                      >
                        see all
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </Show>
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
            {/* Tier 1 — the input shell: a full-width textarea with the small
                watercolor send button nested inline at its bottom-right corner.
                While a turn is in flight that same inline slot becomes Stop. */}
            <div class="composer-input-wrap">
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
              <Show
                when={thread().inFlight}
                fallback={
                  <button
                    type="button"
                    class="send-btn"
                    onClick={submit}
                    disabled={!canSend()}
                    aria-label="Send message"
                    title="Send (Enter)"
                  >
                    {/* ↵ return/enter glyph — down-then-left + a left arrowhead. */}
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M19 7v4a2 2 0 0 1-2 2H6" />
                      <path d="M9 9l-4 4 4 4" />
                    </svg>
                  </button>
                }
              >
                <button
                  type="button"
                  class="send-btn stop"
                  onClick={() => props.onInterrupt(thread().summary.id)}
                  aria-label="Stop"
                  title="Stop"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="2.5" />
                  </svg>
                </button>
              </Show>
            </div>

            {/* Tier 2 — the control bar: attach on the left, the model/effort
                cluster on the right. The cluster shows only when the server
                advertises `availableModels` AND the thread is active; effort is
                additionally gated on `effortSelection` + a non-empty efforts
                array. Options come from props only — no client-side matrix. */}
            <div class="composer-bar">
              <div class="composer-bar-left">
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
                  type="button"
                  class="attach-btn"
                  onClick={() => fileInputEl?.click()}
                  disabled={props.disabled}
                  title="Attach image"
                  aria-label="Attach image"
                >
                  📎
                </button>
              </div>
              <Show when={props.availableModels != null && props.availableModels.length > 0 && props.thread}>
                {(thread) => {
                  const selectedModel = () =>
                    props.availableModels!.find((m) => m.id === props.model) ??
                    props.availableModels![0]!
                  const modelEfforts = () => selectedModel().efforts ?? []
                  const showEffort = () =>
                    props.effortSelection === true && modelEfforts().length > 0
                  // Display order only: surface "ultracode" (the headline mode)
                  // at the TOP, while the DATA order (modelEfforts) keeps it
                  // LAST so the select's no-effort default stays a real level
                  // and never auto-selects ultracode.
                  const effortOptions = () => {
                    const e = modelEfforts()
                    return [
                      ...e.filter((x) => x === "ultracode"),
                      ...e.filter((x) => x !== "ultracode"),
                    ]
                  }
                  return (
                    <div class="composer-config" role="group" aria-label="Model and effort">
                      <label class="composer-config-label">
                        <span class="muted small">Model</span>
                        <select
                          class="composer-config-select"
                          value={props.model ?? selectedModel().id}
                          onChange={(e) => {
                            props.onModelChange?.(thread().summary.id, e.currentTarget.value)
                          }}
                          disabled={props.disabled}
                          aria-label="Model"
                        >
                          <For each={props.availableModels}>
                            {(m) => <option value={m.id}>{m.label}</option>}
                          </For>
                        </select>
                      </label>
                      <Show when={showEffort()}>
                        <label class="composer-config-label">
                          <span class="muted small">Effort</span>
                          <select
                            class="composer-config-select"
                            value={
                              props.effort ??
                              selectedModel().defaultEffort ??
                              modelEfforts()[0]
                            }
                            onChange={(e) => {
                              props.onEffortChange?.(
                                thread().summary.id,
                                e.currentTarget.value as EffortOption,
                              )
                            }}
                            disabled={props.disabled}
                            aria-label="Effort"
                          >
                            <For each={effortOptions()}>
                              {(lv) => (
                                <option value={lv}>
                                  {lv === "ultracode" ? "⚡ Ultracode" : lv}
                                </option>
                              )}
                            </For>
                          </select>
                        </label>
                      </Show>
                    </div>
                  )
                }}
              </Show>
            </div>
          </div>
        </main>
      )}
    </Show>
  )
}
