/**
 * delivery.ts — THE adaptation module.
 *
 * Given a threadId and a ChannelAdapter, this module subscribes to
 * `chat.subscribe(threadId)`, consumes ChatFrames, and translates the
 * stream to the adapter's declared `DeliveryCapability`:
 *
 *   final-only      — buffer the whole turn, deliver once (split by
 *                     maxMessageLength at sensible boundaries).
 *
 *   discrete-chunks — deliver on natural boundaries (per assistant-done
 *                     message), each chunk split to maxMessageLength.
 *
 *   stream-edit     — deliver a placeholder on the first delta, then edit
 *                     it as more deltas arrive (throttled to ≤1 edit / 1.5s
 *                     to respect platform rate limits). Tool calls render a
 *                     live "Working on it…" step block below the streamed
 *                     text (Moon-timeline parity: chronological ✓/✗/active
 *                     steps, Agent description labels, ↳ nested calls). On
 *                     turn-complete the message finalizes as a collapsed
 *                     "Worked for N steps" summary (">! " expandable-quote
 *                     convention, see telegram-format.ts) above the full
 *                     text; answers longer than maxMessageLength continue
 *                     in follow-up messages (chunk 0 edits in place).
 *
 * The terminal signal is always `turn-complete` (the SDK's `result` frame
 * converted by ChatService). `assistant-done` marks one assistant message
 * within a possibly multi-step agentic turn.
 *
 * Chunking: `splitToChunks` splits on the maxMessageLength limit, preferring
 * paragraph (double-newline) and sentence (period/exclamation/question) breaks
 * over hard character cuts.
 *
 * This module does NOT create threads or modify ChatService — it is a
 * PURE DOWNSTREAM CONSUMER of chat.subscribe(), exactly as ui-ws is.
 */
import { Effect, Fiber, Ref, Schedule, Scope, Stream } from "effect"
import { ChatService } from "@luna/chat-service"
import type { ChannelAdapter, DeliveryTarget } from "./types.js"

/* -------------------------------------------------------------------------- */
/* Chunking utility                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Split `text` into chunks of at most `maxLength` characters.
 *
 * Splitting strategy (in order of preference):
 *   1. Paragraph break (double newline) — ideal for Markdown-heavy replies.
 *   2. Sentence end (. ! ?) followed by whitespace.
 *   3. Word boundary (space).
 *   4. Hard cut at maxLength (last resort for long unbroken strings).
 *
 * Returns `[""]` for empty input so callers can always send at least one
 * chunk without special-casing.
 */
export const splitToChunks = (text: string, maxLength: number): string[] => {
  if (maxLength <= 0) throw new Error("maxLength must be > 0")
  if (text.length === 0) return [""]
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }

    const window = remaining.slice(0, maxLength)

    // 1. Paragraph break (double newline)
    const paraIdx = window.lastIndexOf("\n\n")
    if (paraIdx > 0) {
      chunks.push(remaining.slice(0, paraIdx + 2))
      remaining = remaining.slice(paraIdx + 2)
      continue
    }

    // 2. Sentence boundary (. ! ?) followed by space or newline
    const sentenceMatch = [...window.matchAll(/[.!?](?=[\s])/g)]
    if (sentenceMatch.length > 0) {
      const last = sentenceMatch[sentenceMatch.length - 1]
      if (last !== undefined && last.index !== undefined) {
        const cut = last.index + 1
        if (cut > 0) {
          chunks.push(remaining.slice(0, cut))
          remaining = remaining.slice(cut).trimStart()
          continue
        }
      }
    }

    // 3. Word boundary (space)
    const spaceIdx = window.lastIndexOf(" ")
    if (spaceIdx > 0) {
      chunks.push(remaining.slice(0, spaceIdx))
      remaining = remaining.slice(spaceIdx + 1)
      continue
    }

    // 4. Hard cut
    chunks.push(remaining.slice(0, maxLength))
    remaining = remaining.slice(maxLength)
  }

  const filtered = chunks.filter((c) => c.length > 0)
  return filtered.length > 0 ? filtered : [""]
}

/* -------------------------------------------------------------------------- */
/* Step indicator helpers                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One tool invocation in the current agentic turn, tracked in invocation
 * order (chronological, mirroring Moon's timeline).
 *
 * `detail` carries the Agent/Task tool's `input.description` (the only
 * humanized label Moon renders); every other tool shows its raw name.
 * `nested` marks subagent-internal calls (frame.parentToolUseId set), shown
 * with Moon's "↳ " prefix.
 */
export interface ToolStep {
  readonly toolCallId: string
  readonly name: string
  readonly detail?: string
  readonly nested: boolean
  readonly status: "active" | "ok" | "error"
}

/** Max steps rendered in the live status block; older steps collapse. */
const MAX_STATUS_STEPS = 8
/** Max steps rendered in the final turn summary blockquote. */
const MAX_SUMMARY_STEPS = 30

/** Moon's step vocabulary: active spinner, ok check, error cross. */
const stepIcon = (status: ToolStep["status"]): string =>
  status === "active" ? "⚙" : status === "ok" ? "✓" : "✗"

/** "↳ Agent - Research lunar cycles…" — one rendered step line. */
const stepLabel = (step: ToolStep): string => {
  const prefix = step.nested ? "↳ " : ""
  const name = step.detail !== undefined ? `${step.name} - ${step.detail}` : step.name
  const suffix = step.status === "active" ? "…" : ""
  return `${stepIcon(step.status)} ${prefix}${name}${suffix}`
}

/**
 * Extract the display detail for a tool-call frame the way Moon does
 * (chat.html buildToolStep): only Agent/Task get a humanized label, taken
 * from input.description, with input untrusted and read defensively.
 */
export const toolStepDetail = (name: string, input: unknown): string | undefined => {
  if (name !== "Agent" && name !== "Task") return undefined
  if (typeof input !== "object" || input === null) return undefined
  const description = (input as Record<string, unknown>)["description"]
  return typeof description === "string" && description.length > 0 ? description : undefined
}

/**
 * Build the in-flight step-indicator block from the turn's steps, in
 * chronological order. When the list exceeds MAX_STATUS_STEPS, older steps
 * collapse into one "… +N earlier steps" line so long agentic turns can't
 * crowd out the streamed text.
 *
 * Returns "" when there are no steps to report.
 */
export const buildStatusLine = (steps: ReadonlyArray<ToolStep>): string => {
  if (steps.length === 0) return ""
  const overflow = steps.length - MAX_STATUS_STEPS
  const visible = overflow > 0 ? steps.slice(overflow) : steps
  const lines = visible.map(stepLabel)
  if (overflow > 0) lines.unshift(`… +${overflow} earlier step${overflow === 1 ? "" : "s"}`)
  return lines.join("\n")
}

/**
 * Build the completed-turn summary — the Telegram analog of Moon's collapsed
 * "Worked for N steps" timeline pill. Rendered as an EXPANDABLE blockquote
 * (each line prefixed ">! ", the internal channels convention understood by
 * telegram-format.ts): collapsed, Telegram shows just the first line — the
 * pill; tapping it expands the full step list.
 *
 * Returns "" for a turn with no tool steps (pure-text answers stay clean).
 */
export const buildTurnSummary = (steps: ReadonlyArray<ToolStep>): string => {
  if (steps.length === 0) return ""
  const n = steps.length
  const overflow = n - MAX_SUMMARY_STEPS
  const visible = overflow > 0 ? steps.slice(0, MAX_SUMMARY_STEPS) : steps
  const lines = [
    `⚙ Worked for ${n} step${n === 1 ? "" : "s"}`,
    ...visible.map(stepLabel),
  ]
  if (overflow > 0) lines.push(`… +${overflow} more step${overflow === 1 ? "" : "s"}`)
  return lines.map((l) => `>! ${l}`).join("\n")
}

/** Header line shown above the live step block (Moon: "Working on it…"). */
const WORKING_HEADER = "⏳ Working on it…"

/** Compose the live status block: working header + chronological steps. */
const buildWorkingBlock = (steps: ReadonlyArray<ToolStep>): string => {
  const status = buildStatusLine(steps)
  if (status.length === 0) return ""
  return `${WORKING_HEADER}\n${status.split("\n").map((l) => `> ${l}`).join("\n")}`
}

/**
 * Repair markdown code fences across chunk boundaries: when splitToChunks
 * cuts inside a fenced block, the open fence is closed at the chunk's end
 * and reopened at the start of the next chunk, so every delivered message
 * parses as complete markdown on its own.
 *
 * Fence tracking is MARKER-AWARE, mirroring the converter's semantics: a
 * block opened with ``` is only closed by a ``` line (a ~~~ line inside it
 * is content, and vice versa), and the close/reopen markers inserted at a
 * boundary always match the open block's own marker.
 */
export const repairSplitFences = (chunks: ReadonlyArray<string>): string[] => {
  const out: string[] = []
  let open: "```" | "~~~" | null = null
  for (const chunk of chunks) {
    let c: string = open !== null ? open + "\n" + chunk : chunk
    let state: "```" | "~~~" | null = null
    for (const line of c.split("\n")) {
      const m = line.match(/^\s*(`{3,}|~{3,})/)
      if (m === null) continue
      const marker = (m[1] ?? "").startsWith("`") ? ("```" as const) : ("~~~" as const)
      if (state === null) state = marker
      else if (state === marker) state = null
    }
    open = state
    if (open !== null) c = c + "\n" + open
    out.push(c)
  }
  return out
}

const buildStreamEditText = (
  currentText: string,
  statusLine: string,
  maxLength: number,
): string => {
  if (maxLength <= 0) return ""

  const clippedStatus = statusLine.slice(0, maxLength)
  if (currentText.length === 0) return clippedStatus
  if (clippedStatus.length === 0) return currentText.slice(0, maxLength)

  const separator = "\n\n"
  const availableText = maxLength - clippedStatus.length - separator.length
  if (availableText <= 0) return clippedStatus

  return `${currentText.slice(0, availableText)}${separator}${clippedStatus}`
}

/* -------------------------------------------------------------------------- */
/* Delivery helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Minimum ms between stream-edit updates to respect platform rate limits. */
const STREAM_EDIT_THROTTLE_MS = 1500

/**
 * Deliver a sequence of text chunks to the adapter.
 * Sets isPartial/isFinal/chunkIndex/totalChunks on each deliver call.
 */
const deliverChunks = (
  adapter: ChannelAdapter,
  target: DeliveryTarget,
  chunks: string[],
  isPartial: boolean,
): Effect.Effect<void> => {
  const total = chunks.length
  return Effect.forEach(
    chunks,
    (chunk, i) =>
      adapter.deliver(target, chunk, {
        isPartial,
        isFinal: !isPartial && i === total - 1,
        chunkIndex: i,
        totalChunks: total,
      }).pipe(Effect.catchAllCause(() => Effect.void)),
    { discard: true },
  )
}

/* -------------------------------------------------------------------------- */
/* Public: subscribeAndDeliver                                                 */
/* -------------------------------------------------------------------------- */

export const subscribeAndDeliver = (
  threadId: string,
  adapter: ChannelAdapter,
  target: DeliveryTarget,
  serviceScope: Scope.Scope,
): Effect.Effect<Fiber.RuntimeFiber<void, never>, never, ChatService> =>
  Effect.gen(function* () {
    const chat = yield* ChatService

    // Accumulated text for the current turn across all assistant-done messages.
    // Reset on turn-complete.
    const turnBuffer = yield* Ref.make<string>("")
    // Last text delivered in stream-edit mode (for throttle comparison).
    const lastEditedText = yield* Ref.make<string>("")
    // Current delta text (for stream-edit throttle).
    const currentDeltaText = yield* Ref.make<string>("")
    // Whether we have sent the initial placeholder in stream-edit mode.
    const editStarted = yield* Ref.make<boolean>(false)
    // Throttle fiber for stream-edit (we cancel and restart it on each delta).
    const throttleFiber = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)
    // Tool steps of the current turn, in invocation order (Moon's timeline).
    const toolSteps = yield* Ref.make<ReadonlyArray<ToolStep>>([])
    // Current rendered tool-status block for stream-edit adapters.
    const currentStatusLine = yield* Ref.make<string>("")

    const capability = adapter.capability
    const maxLen = adapter.maxMessageLength

    const cancelPendingEdit = Effect.gen(function* () {
      const prev = yield* Ref.get(throttleFiber)
      if (prev !== null) {
        yield* Fiber.interrupt(prev)
        yield* Ref.set(throttleFiber, null)
      }
    })

    const renderCurrentEdit = Effect.gen(function* () {
      const current = yield* Ref.get(currentDeltaText)
      const status = yield* Ref.get(currentStatusLine)
      return buildStreamEditText(current, status, maxLen)
    })

    const deliverStreamEdit = (content: string, isFinal: boolean): Effect.Effect<void> =>
      adapter
        .deliver(target, content.slice(0, maxLen), {
          isPartial: !isFinal,
          isFinal,
          chunkIndex: 0,
          totalChunks: 1,
        })
        .pipe(Effect.catchAllCause(() => Effect.void))

    const scheduleThrottledEdit = Effect.gen(function* () {
      yield* cancelPendingEdit

      const editFiber = yield* Effect.gen(function* () {
        yield* Effect.sleep(`${STREAM_EDIT_THROTTLE_MS} millis`)
        const current = yield* renderCurrentEdit
        const last = yield* Ref.get(lastEditedText)
        if (current !== last) {
          yield* deliverStreamEdit(current, false)
          yield* Ref.set(lastEditedText, current)
        }
      }).pipe(Effect.fork)

      yield* Ref.set(throttleFiber, editFiber as Fiber.RuntimeFiber<void, never>)
    })

    /**
     * Deliver a status-only update (tool steps). For stream-edit adapters:
     * edit the current placeholder message to show the status below accumulated
     * text. For other adapters: no-op (status indicators require edit capability).
     *
     * The first status creates the placeholder immediately; follow-up status
     * edits share the same throttle path as assistant deltas.
     */
    const deliverStatusLine = (statusLine: string): Effect.Effect<void> => {
      if (capability !== "stream-edit") return Effect.void
      if (statusLine.length === 0) return Effect.void
      return Effect.gen(function* () {
        yield* Ref.set(currentStatusLine, statusLine)
        const started = yield* Ref.get(editStarted)
        if (!started) {
          const content = yield* renderCurrentEdit
          yield* Ref.set(editStarted, true)
          yield* deliverStreamEdit(content, false)
          yield* Ref.set(lastEditedText, content)
        } else {
          yield* scheduleThrottledEdit
        }
      })
    }

    const fiber = yield* chat
      .subscribe(threadId)
      .pipe(
        Stream.runForEach((frame) =>
          Effect.gen(function* () {
            switch (frame.type) {
              case "assistant-delta": {
                const text = frame.text // cumulative

                if (capability === "stream-edit") {
                  yield* Ref.set(currentDeltaText, text)

                  // Send placeholder on first delta
                  const started = yield* Ref.get(editStarted)
                  if (!started) {
                    yield* Ref.set(editStarted, true)
                    yield* adapter
                      .deliver(target, "…", {
                        isPartial: true,
                        isFinal: false,
                        chunkIndex: 0,
                        totalChunks: 1,
                      })
                      .pipe(Effect.catchAllCause(() => Effect.void))
                    yield* Ref.set(lastEditedText, "…")
                  }

                  yield* scheduleThrottledEdit
                }
                // For final-only and discrete-chunks we wait for assistant-done
                break
              }

              case "assistant-done": {
                const text = frame.message.text

                if (capability === "final-only") {
                  yield* Ref.update(turnBuffer, (prev) =>
                    prev.length > 0 ? prev + "\n\n" + text : text,
                  )
                } else if (capability === "discrete-chunks") {
                  const chunks = splitToChunks(text, maxLen)
                  yield* deliverChunks(adapter, target, chunks, false)
                }
                break
              }

              case "tool-call": {
                // Record the step in invocation order and refresh the display.
                const detail = toolStepDetail(frame.name, frame.input)
                yield* Ref.update(toolSteps, (steps) => [
                  ...steps,
                  {
                    toolCallId: frame.toolCallId,
                    name: frame.name,
                    ...(detail !== undefined ? { detail } : {}),
                    nested: frame.parentToolUseId !== undefined,
                    status: "active" as const,
                  },
                ])
                const steps = yield* Ref.get(toolSteps)
                yield* deliverStatusLine(buildWorkingBlock(steps))
                break
              }

              case "tool-result": {
                // Settle the step in place (chronological order preserved).
                yield* Ref.update(toolSteps, (steps) =>
                  steps.map((s) =>
                    s.toolCallId === frame.toolCallId
                      ? { ...s, status: frame.status === "ok" ? ("ok" as const) : ("error" as const) }
                      : s,
                  ),
                )
                const steps = yield* Ref.get(toolSteps)
                yield* deliverStatusLine(buildWorkingBlock(steps))
                break
              }

              case "assistant-error": {
                // Deliver an error notice. For stream-edit: edit the placeholder.
                // For others: no-op (the UI handles errors separately).
                // A user Stop reads as "Stopped", not as a failure — and any
                // text streamed before the error is kept, not overwritten.
                if (capability === "stream-edit") {
                  const notice =
                    frame.error.kind === "interrupted"
                      ? "⏹ Stopped."
                      : "⚠ Something went wrong. Please try again."
                  yield* cancelPendingEdit
                  const partial = yield* Ref.get(currentDeltaText)
                  const errText = partial.length > 0 ? `${partial}\n\n${notice}` : notice
                  yield* deliverStreamEdit(errText.slice(0, maxLen), true)
                  yield* Ref.set(editStarted, false)
                  yield* Ref.set(currentDeltaText, "")
                  yield* Ref.set(lastEditedText, "")
                  yield* Ref.set(currentStatusLine, "")
                  yield* Ref.set(toolSteps, [])
                }
                break
              }

              case "turn-complete": {
                // Cancel any pending throttle fiber
                if (capability === "stream-edit") {
                  yield* cancelPendingEdit
                  // Final content: the collapsed step summary (Moon's
                  // "Worked for N steps" pill, as an expandable quote) above
                  // the complete turn text. Text-only turns get no summary.
                  const finalText = yield* Ref.get(currentDeltaText)
                  const steps = yield* Ref.get(toolSteps)
                  const summary = buildTurnSummary(steps)
                  const finalContent =
                    summary.length > 0 && finalText.length > 0
                      ? `${summary}\n\n${finalText}`
                      : finalText.length > 0
                        ? finalText
                        : summary
                  const started = yield* Ref.get(editStarted)
                  if (finalContent.length > 0 && (finalText.length > 0 || started)) {
                    // Long answers no longer truncate at maxMessageLength:
                    // chunk 0 edits the placeholder in place; follow-up
                    // chunks arrive as fresh messages (fence-repaired so
                    // split code blocks stay valid markdown per message).
                    // Multi-chunk splits leave 8 chars of headroom because
                    // fence repair can add "```\n" + "\n```" to one chunk.
                    const chunkLimit =
                      finalContent.length <= maxLen ? maxLen : Math.max(1, maxLen - 8)
                    const chunks = repairSplitFences(splitToChunks(finalContent, chunkLimit))
                    const total = chunks.length
                    yield* Effect.forEach(
                      chunks,
                      (chunk, idx) =>
                        adapter
                          .deliver(target, chunk, {
                            isPartial: false,
                            isFinal: idx === total - 1,
                            chunkIndex: idx,
                            totalChunks: total,
                          })
                          .pipe(Effect.catchAllCause(() => Effect.void)),
                      { discard: true },
                    )
                  }
                  yield* Ref.set(editStarted, false)
                  yield* Ref.set(currentDeltaText, "")
                  yield* Ref.set(lastEditedText, "")
                  yield* Ref.set(currentStatusLine, "")
                  // Reset tool tracking state for the next turn.
                  yield* Ref.set(toolSteps, [])
                } else if (capability === "final-only") {
                  const buffered = yield* Ref.get(turnBuffer)
                  if (buffered.length > 0) {
                    const chunks = splitToChunks(buffered, maxLen)
                    yield* deliverChunks(adapter, target, chunks, false)
                  }
                  yield* Ref.set(turnBuffer, "")
                } else if (capability === "discrete-chunks") {
                  yield* Ref.set(turnBuffer, "")
                }
                break
              }

              default:
                // snapshot, user-accepted, artifacts-extracted, suggested-action-* — not forwarded
                break
            }
          }),
        ),
        Effect.catchAllCause(() => Effect.void),
        Effect.forkIn(serviceScope),
      )

    return fiber as Fiber.RuntimeFiber<void, never>
  })
/* -------------------------------------------------------------------------- */
/* Stream-edit throttle schedule (exported for tests)                         */
/* -------------------------------------------------------------------------- */

export const streamEditThrottleMs = STREAM_EDIT_THROTTLE_MS

/** A Schedule that retries delivery with exponential backoff capped at 30s. */
export const deliveryRetrySchedule = Schedule.exponential("500 millis").pipe(
  Schedule.union(Schedule.spaced("30 seconds")),
  Schedule.upTo("5 minutes"),
)
