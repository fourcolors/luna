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
import { Effect, Fiber, Ref, Schedule, Stream } from "effect"
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

  return chunks.filter((c) => c.length > 0) || [""]
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

/**
 * Subscribe to chat.subscribe(threadId) and forward assistant output to the
 * adapter according to its capability.
 *
 * Returns a Fiber that runs until the subscription stream ends (which happens
 * when the thread's Scope closes). Callers should interrupt the Fiber when
 * they no longer need delivery for this thread+adapter pair.
 *
 * Mirror of ui-ws's `subscribeChatThread` fiber — same subscription/teardown
 * discipline (Stream.unwrapScoped via chat.subscribe handles PubSub release).
 */
export const subscribeAndDeliver = (
  threadId: string,
  adapter: ChannelAdapter,
  target: DeliveryTarget,
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

    const capability = adapter.capability
    const maxLen = adapter.maxMessageLength

    const fiber = yield* chat
      .subscribe(threadId)
      .pipe(
        Stream.runForEach((frame) =>
          Effect.gen(function* () {
            // Skip non-output frames (snapshot, user-accepted, tool-call,
            // tool-result, artifacts-extracted). We only act on the frames
            // that carry assistant text or signal turn completion.
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

                  // Cancel any pending throttle fiber and schedule a new edit
                  const prev = yield* Ref.get(throttleFiber)
                  if (prev !== null) yield* Fiber.interrupt(prev)

                  const editFiber = yield* Effect.gen(function* () {
                    yield* Effect.sleep(`${STREAM_EDIT_THROTTLE_MS} millis`)
                    const current = yield* Ref.get(currentDeltaText)
                    const last = yield* Ref.get(lastEditedText)
                    if (current !== last) {
                      const chunk = current.slice(0, maxLen)
                      yield* adapter
                        .deliver(target, chunk, {
                          isPartial: true,
                          isFinal: false,
                          chunkIndex: 0,
                          totalChunks: 1,
                        })
                        .pipe(Effect.catchAllCause(() => Effect.void))
                      yield* Ref.set(lastEditedText, chunk)
                    }
                  }).pipe(Effect.fork)

                  yield* Ref.set(throttleFiber, editFiber as Fiber.RuntimeFiber<void, never>)
                }
                // For final-only and discrete-chunks we wait for assistant-done
                break
              }

              case "assistant-done": {
                // ChatMessage.text is the pre-projected concatenated text string
                // (see packages/core/src/session/projection.ts ChatMessage interface).
                const text = frame.message.text

                if (capability === "final-only") {
                  // Accumulate — deliver on turn-complete
                  yield* Ref.update(turnBuffer, (prev) =>
                    prev.length > 0 ? prev + "\n\n" + text : text,
                  )
                } else if (capability === "discrete-chunks") {
                  // Deliver this message now, split if needed
                  const chunks = splitToChunks(text, maxLen)
                  yield* deliverChunks(adapter, target, chunks, false)
                }
                // stream-edit: the final edit happens on turn-complete
                break
              }

              case "turn-complete": {
                // Cancel any pending throttle fiber
                if (capability === "stream-edit") {
                  const prev = yield* Ref.get(throttleFiber)
                  if (prev !== null) {
                    yield* Fiber.interrupt(prev)
                    yield* Ref.set(throttleFiber, null)
                  }
                  // Final edit with complete turn text
                  const finalText = yield* Ref.get(currentDeltaText)
                  if (finalText.length > 0) {
                    const chunk = finalText.slice(0, maxLen)
                    yield* adapter
                      .deliver(target, chunk, {
                        isPartial: false,
                        isFinal: true,
                        chunkIndex: 0,
                        totalChunks: 1,
                      })
                      .pipe(Effect.catchAllCause(() => Effect.void))
                  }
                  yield* Ref.set(editStarted, false)
                  yield* Ref.set(currentDeltaText, "")
                  yield* Ref.set(lastEditedText, "")
                } else if (capability === "final-only") {
                  // Deliver the buffered full turn
                  const buffered = yield* Ref.get(turnBuffer)
                  if (buffered.length > 0) {
                    const chunks = splitToChunks(buffered, maxLen)
                    yield* deliverChunks(adapter, target, chunks, false)
                  }
                  yield* Ref.set(turnBuffer, "")
                } else if (capability === "discrete-chunks") {
                  // discrete-chunks delivers eagerly on assistant-done;
                  // turn-complete is just a lifecycle signal — reset buffer.
                  yield* Ref.set(turnBuffer, "")
                }
                break
              }

              default:
                // snapshot, user-accepted, tool-call, tool-result,
                // assistant-error, artifacts-extracted — not forwarded
                break
            }
          }),
        ),
        Effect.catchAllCause(() => Effect.void),
        Effect.fork,
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
