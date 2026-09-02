/**
 * chatModel.ts - the chat transcript's source-of-truth data structure, as a
 * pure typed reducer. No DOM access anywhere in this module.
 *
 * Ported from chat.html's former inline `ChatState` object/`ChatRenderer._plan`
 * (the "CHAT MODEL" + planning half of "CHAT RENDERER" - see git history for
 * the pre-conversion inline script, stack23 S15). The wire-frame vocabulary
 * (applyDelta/applyToolCall/finishTurn/...) and the run-grouping/timeline
 * logic are unchanged; only the SHAPE changed, from a mutated singleton
 * object to a pure `(state, action) -> state` reducer plus pure selector
 * functions, so:
 *   - every prior mutation is now an immutable update (no input `state` or
 *     any of its nested objects/arrays is ever written to) - required for
 *     React's `useSyncExternalStore` bridge (MessageList.tsx) to memoize
 *     unchanged segments/turns by reference, and safe under StrictMode's
 *     double-invoke.
 *   - the reducer is trivially unit-testable with no jsdom/DOM at all.
 *
 * `createChatModelStore` is the plain (React-free) external-store wrapper:
 * `dispatch` updates the held state synchronously (so a caller reading
 * `store.getState().turns` immediately after a dispatch sees the latest
 * value - chat.html's frame handlers rely on this, e.g. checking
 * `turns.length === 0` right after `loadHistory`), while `notify()` is a
 * SEPARATE, explicit step - MessageList.tsx's legacy `ChatLoop` bridge calls
 * it (batched via rAF for `schedule()`, synchronously via `flushSync` for
 * `flush()`), mirroring the former ChatState/ChatLoop split exactly.
 */

// ============================================================================
// Types
// ============================================================================

export interface TextSegment {
  readonly kind: "text"
  readonly raw: string
  readonly done: boolean
}

export interface ToolResult {
  readonly ok: boolean
  readonly output: string
  readonly truncated: boolean
}

export interface ToolSegment {
  readonly kind: "tool"
  readonly id: string
  readonly name: string
  readonly input: unknown
  readonly result: ToolResult | null
  readonly parentToolUseId?: string
}

export type Segment = TextSegment | ToolSegment

export type TurnStatus = "streaming" | "done" | "error" | "banner"
export type TurnRole = "user" | "assistant"

export interface Preview {
  readonly kind: string
  readonly name: string
  readonly src: string | null
}

export interface Delivery {
  readonly source?: string
  readonly label?: string
  readonly [key: string]: unknown
}

export interface Turn {
  readonly key: string
  readonly role: TurnRole
  readonly status: TurnStatus
  readonly segments: readonly Segment[]
  readonly previews: readonly Preview[] | null
  readonly turnId?: string
  readonly errorText?: string
  readonly ts?: number
  readonly delivery?: Delivery | null
  /** Last-seen CUMULATIVE assistant text for this turn - see applyDelta's doc. */
  readonly _cumText?: string
  /** Explicit user pin overriding the settled-driven auto-collapse default. */
  readonly _timelineCollapsed?: boolean
  /** Set once `turn-complete` (the SDK `result`) settles this turn's run. */
  readonly _settled?: boolean
}

/** A `tool_use` block off a history message, plus the outcome the server
 *  folded back onto it (absent on an older server, or when the run's
 *  `tool_result` fell outside the snapshot window). Every field is optional
 *  because this is wire data, not our own construction. */
export interface HistoryToolUse {
  readonly id?: string
  readonly name?: string
  readonly input?: unknown
  readonly result?: { readonly ok?: boolean; readonly output?: string; readonly truncated?: boolean } | null
}

/** A file attachment off a history message. No filename survives the round
 *  trip - the SDK content block carries only a media type and base64 - so the
 *  chip label is derived from the media type. */
export interface HistoryAttachment {
  readonly mediaType?: string
  readonly data?: string
}

/**
 * One message from a `thread-snapshot` (or the per-thread cache, which stores
 * those same objects verbatim).
 *
 * `toolUses` / `attachments` are the whole point of this interface being
 * wider than role+text: the server has always sent them, and `load-history`
 * used to drop them on the floor, which is why a restored transcript rendered
 * as bare text bubbles while a live one grew a tool timeline, a star map and
 * attachment chips. They are optional so an older server still loads.
 */
export interface HistoryMessage {
  readonly role?: string
  readonly text?: string
  readonly ts?: number
  readonly delivery?: Delivery | null
  readonly toolUses?: readonly HistoryToolUse[]
  readonly attachments?: readonly HistoryAttachment[]
}

export interface DeliveredMessage {
  readonly text?: string
  readonly ts?: number
  readonly delivery?: Delivery | null
}

export interface ChatModelState {
  readonly turns: readonly Turn[]
}

export function createInitialChatModelState(): ChatModelState {
  return { turns: [] }
}

// ============================================================================
// Actions
// ============================================================================

export type ChatModelAction =
  | { readonly type: "reset" }
  | { readonly type: "load-history"; readonly messages: readonly HistoryMessage[] }
  | {
      readonly type: "append-user"
      readonly text: string
      readonly previews?: readonly Preview[] | null
      readonly ts?: number
    }
  | { readonly type: "append-banner"; readonly text: string }
  | { readonly type: "append-delivered"; readonly message: DeliveredMessage }
  | { readonly type: "begin-pending-assistant" }
  | { readonly type: "apply-delta"; readonly turnId: string; readonly text: string }
  | {
      readonly type: "apply-tool-call"
      readonly turnId: string
      readonly toolCallId: string
      readonly name: string
      readonly input: unknown
      readonly parentToolUseId?: string
    }
  | {
      readonly type: "apply-tool-result"
      readonly toolCallId: string
      readonly ok: boolean
      readonly output: string
      readonly truncated: boolean
    }
  | { readonly type: "finish-turn"; readonly turnId: string; readonly ts?: number }
  | { readonly type: "fail-turn"; readonly turnId: string; readonly errorText?: string }
  | { readonly type: "mark-run-settled" }
  | { readonly type: "drop-pending-assistant" }
  | { readonly type: "toggle-timeline"; readonly turnKey: string; readonly currentlyCollapsed: boolean }

// ============================================================================
// Internal helpers (pure)
// ============================================================================

/** One tool result off the wire, defensively narrowed. Returns null (which
 *  renders as a pending "…" step) rather than inventing an `ok:true` when the
 *  server sent nothing - claiming a tool succeeded is worse than admitting we
 *  do not know. */
function historyToolResult(raw: HistoryToolUse["result"]): ToolResult | null {
  if (!raw || typeof raw !== "object") return null
  return {
    // Only an explicit `false` means failure; an older server that omits the
    // flag entirely does not get its whole history painted red.
    ok: raw.ok !== false,
    output: typeof raw.output === "string" ? raw.output : "",
    truncated: raw.truncated === true,
  }
}

/** Rebuild the tool segments a live turn would have accumulated from its
 *  `tool-call` / `tool-result` frames. Blocks without both an id and a name
 *  are dropped - they cannot be keyed or labelled. `parentToolUseId` is never
 *  set here: subagent-internal calls are not projected into history at all,
 *  so every restored tool is top-level. */
function historyToolSegments(raw: readonly HistoryToolUse[] | undefined): ToolSegment[] {
  if (!Array.isArray(raw) || raw.length === 0) return []
  const out: ToolSegment[] = []
  for (const t of raw) {
    if (!t || typeof t !== "object") continue
    const id = typeof t.id === "string" ? t.id : ""
    const name = typeof t.name === "string" ? t.name : ""
    if (!id || !name) continue
    out.push({ kind: "tool", id, name, input: t.input, result: historyToolResult(t.result) })
  }
  return out
}

/** Label for an attachment chip. The composer's filename does not survive
 *  the send (an SDK content block carries only `media_type` + base64), so the
 *  media type is all we have; the chip's icon reads the extension off this. */
function historyAttachmentName(mediaType: string): string {
  if (mediaType === "application/pdf") return "document.pdf"
  const ext = mediaType.split("/")[1] || "bin"
  return "image." + (ext === "jpeg" ? "jpg" : ext)
}

/** Rebuild the preview chips the composer attached at send time, so a
 *  restored user turn still shows the image it was sent with. Returns null
 *  (not []) for none, matching what a text-only turn carries. */
function historyPreviews(raw: readonly HistoryAttachment[] | undefined): Preview[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: Preview[] = []
  for (const a of raw) {
    if (!a || typeof a !== "object") continue
    const mediaType = typeof a.mediaType === "string" ? a.mediaType : ""
    const data = typeof a.data === "string" ? a.data : ""
    if (!mediaType || !data) continue
    const isImage = mediaType.startsWith("image/")
    out.push({
      // "pdf" mirrors what the composer's own preview() emits, so the chip
      // renders through the identical branch in PreviewTray.
      kind: isImage ? "image" : mediaType === "application/pdf" ? "pdf" : "file",
      name: historyAttachmentName(mediaType),
      src: isImage ? `data:${mediaType};base64,${data}` : null,
    })
  }
  return out.length > 0 ? out : null
}

function findTurnIndexById(turns: readonly Turn[], turnId: string | undefined): number {
  if (!turnId) return -1
  const key = "t-" + turnId
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.key === key) return i
  }
  return -1
}

function findPendingIndex(turns: readonly Turn[]): number {
  const tail = turns[turns.length - 1]
  return tail && tail.key === "pending-assistant" ? turns.length - 1 : -1
}

/**
 * Resolve (creating if needed) the assistant turn a wire frame targets,
 * without mutating `turns`. Mirrors the former `beginAssistantTurn`: claims
 * the pending placeholder if present, else finds the existing turn by id,
 * else appends a fresh streaming turn.
 */
function withAssistantTurn(
  turns: readonly Turn[],
  turnId: string | undefined,
): { readonly turns: Turn[]; readonly index: number } {
  const tailIdx = turns.length - 1
  const tail = turns[tailIdx]
  if (turnId && tail && tail.key === "pending-assistant") {
    const claimed: Turn = { ...tail, key: "t-" + turnId, turnId: String(turnId) }
    const next = turns.slice()
    next[tailIdx] = claimed
    return { turns: next, index: tailIdx }
  }
  const existingIdx = findTurnIndexById(turns, turnId)
  if (existingIdx !== -1) {
    return { turns: turns.slice(), index: existingIdx }
  }
  const fresh: Turn = {
    key: turnId ? "t-" + turnId : "pending-assistant",
    role: "assistant",
    status: "streaming",
    segments: [],
    turnId: String(turnId || ""),
    previews: null,
  }
  const next = turns.slice()
  next.push(fresh)
  return { turns: next, index: next.length - 1 }
}

function closeOpenTextSegments(segments: readonly Segment[]): Segment[] {
  return segments.map((s) => (s.kind === "text" && !s.done ? { ...s, done: true } : s))
}

// ============================================================================
// Reducer
// ============================================================================

export function chatModelReducer(state: ChatModelState, action: ChatModelAction): ChatModelState {
  switch (action.type) {
    case "reset": {
      if (state.turns.length === 0) return state
      return { turns: [] }
    }

    case "load-history": {
      const turns: Turn[] = []
      let i = 0
      for (const msg of action.messages) {
        if (!msg) continue
        const role: TurnRole = msg.role === "user" ? "user" : "assistant"
        const text = msg.text ? String(msg.text) : ""
        const hasText = !!text.trim()
        // Tool blocks belong to assistant turns; attachments to user turns.
        // Reading each only where it can occur keeps a malformed frame from
        // growing a tool timeline on a user bubble.
        const toolSegments = role === "assistant" ? historyToolSegments(msg.toolUses) : []
        const previews = role === "user" ? historyPreviews(msg.attachments) : null
        // The old guard was `!text.trim() -> skip`, which silently DELETED
        // two real kinds of turn from every restored transcript: an assistant
        // step that only called tools, and a user message that was only an
        // image. Skip a turn only when it would render nothing at all.
        if (!hasText && toolSegments.length === 0 && !previews) continue
        // Text first, then tools: an SDK content array orders its text block
        // before the tool_use blocks it introduces, and the concatenated
        // `text` field has lost any finer interleaving. Getting this order
        // right is what puts a run's closing answer BELOW the timeline (see
        // planRun's lastToolIndex) instead of buried inside it.
        const segments: Segment[] = []
        if (hasText) segments.push({ kind: "text", raw: text, done: true })
        for (const seg of toolSegments) segments.push(seg)
        const turn: Turn = {
          key: "h-" + i++,
          role,
          status: "done",
          segments,
          previews,
          delivery: msg.delivery && typeof msg.delivery === "object" ? msg.delivery : null,
          ...(Number.isFinite(msg.ts) ? { ts: msg.ts as number } : {}),
          // History is by definition finished work. planRun reads `_settled`
          // off the LAST turn of a grouped run, so this is what makes a
          // restored timeline render collapsed with its star map instead of
          // a permanent "Working on it…". It cannot mislabel an in-flight
          // run either: if a live turn follows these (a snapshot landing
          // mid-turn), that live turn is the run's last and it is unsettled.
          ...(role === "assistant" ? { _settled: true } : {}),
        }
        turns.push(turn)
      }
      return { turns }
    }

    case "append-user": {
      const text = String(action.text ?? "")
      const stamp = Number.isFinite(action.ts) ? (action.ts as number) : Date.now()
      const turn: Turn = {
        key: "u-" + stamp + "-" + state.turns.length,
        role: "user",
        status: "done",
        segments: text ? [{ kind: "text", raw: text, done: true }] : [],
        previews: action.previews ?? null,
        ts: stamp,
      }
      return { turns: state.turns.concat(turn) }
    }

    case "append-banner": {
      const text = String(action.text ?? "")
      const turn: Turn = {
        key: "b-" + Date.now() + "-" + state.turns.length,
        role: "assistant",
        status: "banner",
        segments: text ? [{ kind: "text", raw: text, done: true }] : [],
        previews: null,
      }
      return { turns: state.turns.concat(turn) }
    }

    case "append-delivered": {
      const text = String(action.message?.text || "")
      if (!text.trim()) return state
      const msgTs = action.message?.ts
      const turn: Turn = {
        key: "d-" + Date.now() + "-" + state.turns.length,
        role: "assistant",
        status: "done",
        segments: [{ kind: "text", raw: text, done: true }],
        previews: null,
        ts: Number.isFinite(msgTs) ? (msgTs as number) : Date.now(),
        delivery:
          action.message?.delivery && typeof action.message.delivery === "object"
            ? action.message.delivery
            : { source: "background-job" },
        _settled: true,
      }
      return { turns: state.turns.concat(turn) }
    }

    case "begin-pending-assistant": {
      const tail = state.turns[state.turns.length - 1]
      if (tail && tail.key === "pending-assistant") return state
      const turn: Turn = {
        key: "pending-assistant",
        role: "assistant",
        status: "streaming",
        segments: [],
        turnId: "",
        previews: null,
      }
      return { turns: state.turns.concat(turn) }
    }

    case "apply-delta": {
      if (!action.text) return state
      const { turns, index } = withAssistantTurn(state.turns, action.turnId)
      const turn = turns[index]
      if (!turn) return state
      const prevCum = typeof turn._cumText === "string" ? turn._cumText : ""
      const text = action.text
      const incremental =
        text.length >= prevCum.length && text.startsWith(prevCum) ? text.slice(prevCum.length) : text
      if (!incremental) {
        turns[index] = { ...turn, _cumText: text }
        return { turns }
      }
      const segments = turn.segments.slice()
      const last = segments[segments.length - 1]
      if (last && last.kind === "text" && !last.done) {
        segments[segments.length - 1] = { ...last, raw: last.raw + incremental }
      } else {
        segments.push({ kind: "text", raw: incremental, done: false })
      }
      turns[index] = { ...turn, _cumText: text, segments }
      return { turns }
    }

    case "apply-tool-call": {
      const { turns, index } = withAssistantTurn(state.turns, action.turnId)
      const turn = turns[index]
      if (!turn) return state
      const segments = closeOpenTextSegments(turn.segments)
      const toolSeg: ToolSegment = {
        kind: "tool",
        id: String(action.toolCallId || ""),
        name: String(action.name || "tool"),
        input: action.input,
        result: null,
        ...(action.parentToolUseId ? { parentToolUseId: String(action.parentToolUseId) } : {}),
      }
      segments.push(toolSeg)
      turns[index] = { ...turn, segments }
      return { turns }
    }

    case "apply-tool-result": {
      const id = String(action.toolCallId || "")
      if (!id) return state
      const result: ToolResult = {
        ok: !!action.ok,
        output: String(action.output ?? ""),
        truncated: !!action.truncated,
      }
      let found = false
      const turns = state.turns.map((turn) => {
        if (found) return turn
        let changed = false
        const segments = turn.segments.map((seg) => {
          if (!found && seg.kind === "tool" && seg.id === id) {
            found = true
            changed = true
            return { ...seg, result }
          }
          return seg
        })
        return changed ? { ...turn, segments } : turn
      })
      return found ? { turns } : state
    }

    case "finish-turn": {
      let idx = findTurnIndexById(state.turns, action.turnId)
      if (idx === -1) idx = findPendingIndex(state.turns)
      if (idx === -1) return state
      const turn = state.turns[idx]
      if (!turn) return state
      const segments = closeOpenTextSegments(turn.segments)
      const turns = state.turns.slice()
      if (segments.length === 0) {
        // Drop the turn entirely if it has no visible content (zero text +
        // zero tools). Replaces the former sweepTrailingEmptyAssistantBubbles.
        turns.splice(idx, 1)
        return { turns }
      }
      turns[idx] = {
        ...turn,
        segments,
        status: "done",
        ...(Number.isFinite(action.ts) ? { ts: action.ts as number } : {}),
      }
      return { turns }
    }

    case "fail-turn": {
      let idx = findTurnIndexById(state.turns, action.turnId)
      if (idx === -1) idx = findPendingIndex(state.turns)
      let turns: Turn[]
      let turn: Turn
      if (idx === -1) {
        turn = {
          key: "err-" + Date.now() + "-" + state.turns.length,
          role: "assistant",
          status: "error",
          segments: [],
          turnId: "",
          previews: null,
        }
        turns = state.turns.concat(turn)
        idx = turns.length - 1
      } else {
        turns = state.turns.slice()
        const existing = turns[idx]
        if (!existing) return state
        turn = existing
      }
      const segments = closeOpenTextSegments(turn.segments)
      turns[idx] = {
        ...turn,
        segments,
        status: "error",
        errorText: String(action.errorText || "Unknown error"),
      }
      return { turns }
    }

    case "mark-run-settled": {
      const turns = state.turns.slice()
      let changed = false
      for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i]
        if (!t || t.role !== "assistant" || t.status === "banner" || t.status === "error") break
        // Skip turns already settled - a repeated dispatch on unchanged state
        // must return `state` by reference (this module's memoize-by-reference
        // contract, see the module doc), not churn every trailing turn's
        // identity for a no-op flag write.
        if (!t._settled) {
          turns[i] = { ...t, _settled: true }
          changed = true
        }
      }
      return changed ? { turns } : state
    }

    case "drop-pending-assistant": {
      const tail = state.turns[state.turns.length - 1]
      if (tail && tail.key === "pending-assistant") {
        return { turns: state.turns.slice(0, -1) }
      }
      return state
    }

    case "toggle-timeline": {
      const idx = state.turns.findIndex((t) => t.key === action.turnKey)
      if (idx === -1) return state
      const turns = state.turns.slice()
      const turn = turns[idx]
      if (!turn) return state
      turns[idx] = { ...turn, _timelineCollapsed: !action.currentlyCollapsed }
      return { turns }
    }

    default: {
      const _exhaustive: never = action
      void _exhaustive
      return state
    }
  }
}

// ============================================================================
// Selectors used by callers that used to poke the DOM/ChatState directly
// ============================================================================

/** True only for the still-unclaimed `pending-assistant` placeholder (zero
 * segments) - narrowed to that exact key so it stays 1:1 with
 * `drop-pending-assistant`, which only ever pops that key (a "claimed turn
 * with zero segments" can't arise: every reducer branch that claims a turn
 * via `withAssistantTurn` pushes a segment in that same dispatch). */
export function isTailStreamingEmpty(turns: readonly Turn[]): boolean {
  const tail = turns[turns.length - 1]
  return !!tail && tail.key === "pending-assistant" && tail.segments.length === 0
}

export function findPendingTurn(turns: readonly Turn[]): Turn | null {
  const idx = findPendingIndex(turns)
  return idx === -1 ? null : (turns[idx] ?? null)
}

// ============================================================================
// Planning / selectors for rendering - pure, no DOM. Mirrors the former
// ChatRenderer._plan / _planRun exactly (see chat.html git history).
// ============================================================================

export interface MergedStep {
  readonly seg: Segment
  readonly turn: Turn
}

export type PlannedItem =
  | { readonly key: string; readonly kind: "user"; readonly turn: Turn }
  | { readonly key: string; readonly kind: "banner"; readonly turn: Turn }
  | { readonly key: string; readonly kind: "error"; readonly turn: Turn }
  | { readonly key: string; readonly kind: "typing"; readonly turn: Turn }
  | { readonly key: string; readonly kind: "text"; readonly turn: Turn; readonly seg: TextSegment }
  | {
      readonly key: string
      readonly kind: "timeline"
      readonly turn: Turn
      readonly merged: readonly MergedStep[]
      readonly lastToolIndex: number
      readonly settled: boolean
    }
  /**
   * The star map, emitted as the LAST item of a run WHILE IT IS STILL RUNNING
   * (`!settled`) so it always sits at the bottom of the turn - a run has no
   * text item at all until the first token arrives, and the mark has to be
   * visible for the whole turn, so hanging it off the bubble would miss
   * exactly the phase it exists for. 0.0.73 tried putting it in the timeline's
   * summary row instead, which parked it to the RIGHT of "Working on it..."
   * - wrong then, because the row was still expanded and the mark read as
   * decoration on an in-progress label, not a record.
   *
   * Once the run SETTLES, this item is no longer planned at all: the timeline
   * item's own summary row (TimelineItem in MessageList.tsx) renders the same
   * star map inline instead, using the merged/lastToolIndex it already
   * carries. That is the summary pill the turn record lives in once the run
   * is done, rather than a permanent row under the answer.
   */
  | {
      readonly key: string
      readonly kind: "constellation"
      readonly turn: Turn
      readonly merged: readonly MergedStep[]
      readonly lastToolIndex: number
      readonly settled: boolean
    }

export function planChatItems(turns: readonly Turn[], opts: { readonly grouped: boolean }): PlannedItem[] {
  const out: PlannedItem[] = []
  let i = 0
  while (i < turns.length) {
    const turn = turns[i]
    if (!turn) {
      i++
      continue
    }
    if (turn.role === "user") {
      out.push({ key: turn.key + "|u", kind: "user", turn })
      i++
      continue
    }
    if (turn.status === "banner") {
      out.push({ key: turn.key + "|b", kind: "banner", turn })
      i++
      continue
    }
    if (turn.status === "error") {
      out.push({ key: turn.key + "|e", kind: "error", turn })
      i++
      continue
    }
    // #124: a background-DELIVERED result is a standalone answer, never part
    // of an agentic run - render it as its own single-turn run so its "from
    // a background task" chip always shows (never absorbed into a timeline).
    if (turn.delivery) {
      planRun([turn], out, false)
      i++
      continue
    }
    const grouped = opts.grouped
    const run: Turn[] = []
    if (grouped) {
      while (
        i < turns.length &&
        turns[i]?.role === "assistant" &&
        turns[i]?.status !== "banner" &&
        turns[i]?.status !== "error" &&
        !turns[i]?.delivery
      ) {
        const t = turns[i]
        if (t) run.push(t)
        i++
      }
    } else {
      run.push(turn)
      i++
    }
    planRun(run, out, grouped)
  }
  return out
}

function planRun(run: readonly Turn[], out: PlannedItem[], grouped: boolean): void {
  const anchor = run[0]
  if (!anchor) return
  const merged: MergedStep[] = []
  for (const t of run) {
    for (const s of t.segments) merged.push({ seg: s, turn: t })
  }
  if (merged.length === 0) {
    out.push({ key: anchor.key + "|typing", kind: "typing", turn: anchor })
    return
  }
  const last = run[run.length - 1]
  const settled = grouped ? last?._settled === true : last?.status === "done" || last?.status === "error"
  let lastToolIndex = -1
  for (let k = 0; k < merged.length; k++) {
    if (merged[k]?.seg.kind === "tool") lastToolIndex = k
  }
  if (lastToolIndex === -1) {
    for (let k = 0; k < merged.length; k++) {
      const m = merged[k]
      if (!m) continue
      out.push({ key: anchor.key + "|t" + k, kind: "text", turn: m.turn, seg: m.seg as TextSegment })
    }
    return
  }
  out.push({
    key: anchor.key + "|tl",
    kind: "timeline",
    turn: anchor,
    merged,
    lastToolIndex,
    settled,
  })
  for (let k = lastToolIndex + 1; k < merged.length; k++) {
    const m = merged[k]
    if (m && m.seg.kind === "text") {
      out.push({ key: anchor.key + "|t" + k, kind: "text", turn: m.turn, seg: m.seg })
    }
  }
  // LAST, and only while the run is still active: this is what puts the mark
  // below the answer instead of beside the activity header, for the phase
  // that has no text item yet. Once settled, TimelineItem renders the same
  // star map itself inside the summary row, so no trailing item is planned -
  // see the doc comment on the "constellation" union member.
  if (!settled) {
    out.push({
      key: anchor.key + "|cn",
      kind: "constellation",
      turn: anchor,
      merged,
      lastToolIndex,
      settled,
    })
  }
}

/** The collapsed/expanded value a timeline actually renders: an explicit
 * user pin (`_timelineCollapsed`) wins, else it follows `settled`. Shared by
 * MessageList's render path and the toggle handler so both agree. */
export function isTimelineEffectivelyCollapsed(turn: Turn, settled: boolean): boolean {
  return turn._timelineCollapsed !== undefined ? turn._timelineCollapsed : settled
}

/** True if the last top-level rendered item would show a `.typing-dots`
 * spinner - either the tail placeholder `isTailStreamingEmpty` covers, or an
 * unsettled trailing activity timeline (MessageList's TimelineItem renders
 * `.typing-dots` in its summary while `!settled`). Mirrors the vanilla
 * disconnect handler's `last.querySelector('.typing-dots')`, which matched
 * both shapes identically. */
export function hasVisibleTypingIndicator(turns: readonly Turn[], grouped: boolean): boolean {
  if (isTailStreamingEmpty(turns)) return true
  const items = planChatItems(turns, { grouped })
  // While a run is still active the constellation trails it and never carries
  // a spinner, so it is not "the last item" for this question. Skip past it
  // rather than reading items[length-1] blind: that read silently answered
  // `false` for every in-flight tool-bearing run the moment the star map
  // became its own trailing item. Settled runs no longer plan this item.
  let i = items.length - 1
  while (i >= 0 && items[i]?.kind === "constellation") i--
  const last = items[i]
  return !!last && last.kind === "timeline" && !last.settled
}

// ============================================================================
// Plain (React-free) external store
// ============================================================================

export interface ChatModelStore {
  getState: () => ChatModelState
  dispatch: (action: ChatModelAction) => void
  /** Register a listener for `notify()`. Returns an unsubscribe function. */
  subscribe: (listener: () => void) => () => void
  /** Explicitly wake subscribers - dispatch itself never does this (see
   * module doc: chat.html's ChatLoop bridge owns batching that call). */
  notify: () => void
}

export function createChatModelStore(initial: ChatModelState = createInitialChatModelState()): ChatModelStore {
  let state = initial
  const listeners = new Set<() => void>()

  return {
    getState: () => state,
    dispatch: (action) => {
      state = chatModelReducer(state, action)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    notify: () => {
      for (const listener of listeners) listener()
    },
  }
}
