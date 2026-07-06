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
 *                     to respect platform rate limits), finalize on
 *                     turn-complete with the complete text.
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
 * Build the step-indicator status line from active and completed tool calls.
 *
 * Active calls show as "⚙ tool_name…"; completed calls show as "✓ tool_name"
 * or "✗ tool_name" depending on status. Completed entries appear before active
 * ones so the user sees history at the top and current work at the bottom.
 *
 * Returns "" when there are no steps to report (no active, no completed).
 */
export const buildStatusLine = (
  active: ReadonlyMap<string, string>,
  completed: ReadonlyArray<{ readonly name: string; readonly ok: boolean }> = [],
): string => {
  const lines = [
    ...completed.map((t) => `${t.ok ? "✓" : "✗"} ${t.name}`),
    ...[...active.values()].map((name) => `⚙ ${name}…`),
  ]
  return lines.join("\n")
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
    // Active tool calls: toolCallId → tool name.
    const activeTools = yield* Ref.make<Map<string, string>>(new Map())
    // Completed tool calls this turn: { name, ok }.
    const completedTools = yield* Ref.make<Array<{ name: string; ok: boolean }>>([])
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
                // Record the active tool call and update the status display.
                yield* Ref.update(activeTools, (m) => {
                  const next = new Map(m)
                  next.set(frame.toolCallId, frame.name)
                  return next
                })
                const active = yield* Ref.get(activeTools)
                const completed = yield* Ref.get(completedTools)
                const statusLine = buildStatusLine(active, completed)
                yield* deliverStatusLine(statusLine)
                break
              }

              case "tool-result": {
                // Move the tool from active → completed and update the display.
                const active0 = yield* Ref.get(activeTools)
                const name = active0.get(frame.toolCallId) ?? "tool"
                yield* Ref.update(activeTools, (m) => {
                  const next = new Map(m)
                  next.delete(frame.toolCallId)
                  return next
                })
                yield* Ref.update(completedTools, (arr) => [
                  ...arr,
                  { name, ok: frame.status === "ok" },
                ])
                const active = yield* Ref.get(activeTools)
                const completed = yield* Ref.get(completedTools)
                const statusLine = buildStatusLine(active, completed)
                yield* deliverStatusLine(statusLine)
                break
              }

              case "assistant-error": {
                // Deliver an error notice. For stream-edit: edit the placeholder.
                // For others: no-op (the UI handles errors separately).
                if (capability === "stream-edit") {
                  const errText = "⚠ Something went wrong. Please try again."
                  yield* cancelPendingEdit
                  yield* deliverStreamEdit(errText, true)
                  yield* Ref.set(editStarted, false)
                  yield* Ref.set(currentDeltaText, "")
                  yield* Ref.set(lastEditedText, "")
                  yield* Ref.set(currentStatusLine, "")
                  yield* Ref.set(activeTools, new Map())
                  yield* Ref.set(completedTools, [])
                }
                break
              }

              case "turn-complete": {
                // Cancel any pending throttle fiber
                if (capability === "stream-edit") {
                  yield* cancelPendingEdit
                  // Final edit with complete turn text
                  const finalText = yield* Ref.get(currentDeltaText)
                  if (finalText.length > 0) {
                    const chunk = finalText.slice(0, maxLen)
                    yield* deliverStreamEdit(chunk, true)
                  } else {
                    const started = yield* Ref.get(editStarted)
                    if (started) {
                      const current = yield* renderCurrentEdit
                      if (current.length > 0) {
                        yield* deliverStreamEdit(current, true)
                      }
                    }
                  }
                  yield* Ref.set(editStarted, false)
                  yield* Ref.set(currentDeltaText, "")
                  yield* Ref.set(lastEditedText, "")
                  yield* Ref.set(currentStatusLine, "")
                  // Reset tool tracking state for the next turn.
                  yield* Ref.set(activeTools, new Map())
                  yield* Ref.set(completedTools, [])
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
