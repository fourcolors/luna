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
 * Background job results (#124 `chat_thread` / issue #375): ChatService.
 * deliverResult publishes ONLY `assistant-done` (with `message.delivery`
 * set), never `turn-complete`, so a concurrent live turn is not collapsed.
 * Those frames are delivered as standalone one-shot finals for every
 * capability - including stream-edit (Telegram) and final-only - without
 * touching live stream-edit edit state.
 *
 * Chunking: `splitToChunks` splits on the maxMessageLength limit, preferring
 * paragraph (double-newline) and sentence (period/exclamation/question) breaks
 * over hard character cuts.
 *
 * This module does NOT create threads or modify ChatService - it is a
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
 * An open fenced block: the normalized 3-char marker plus the block's info
 * string (the language tag and any extra attributes, e.g.
 * `typescript title=example.ts`). The info string is what makes a reopened
 * continuation keep its syntax highlighting.
 */
interface OpenFence {
  readonly marker: "```" | "~~~"
  readonly info: string
}

/** Length of the normalized fence marker we emit ("```" / "~~~"). */
const FENCE_MARKER_LEN = 3

/**
 * Parse one line as a CommonMark code fence, or null if it is not one.
 *
 * A fence line is a run of 3+ backticks or tildes at (optionally indented)
 * line start; everything after the run is the info string.
 */
const parseFenceLine = (line: string): OpenFence | null => {
  const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
  if (m === null) return null
  return {
    marker: (m[1] ?? "").startsWith("`") ? "```" : "~~~",
    info: (m[2] ?? "").trim(),
  }
}

/** The text of the line that reopens `f` in a continuation chunk. */
const reopenLine = (f: OpenFence): string => f.marker + f.info

/**
 * Walk `text` line by line and return the fence still open at the end, or
 * null if the text is balanced.
 *
 * Two CommonMark rules are enforced here:
 *   1. MARKER ISOLATION — a ``` block is only closed by a ``` line (a ~~~
 *      line inside it is content), and vice versa.
 *   2. A CLOSING FENCE CARRIES NO INFO STRING — so a ```json line appearing
 *      inside an already-open ``` block is CONTENT, not a closer. This is
 *      what keeps "markdown about markdown" (which the agent writes
 *      constantly when explaining code) from being mis-parsed.
 */
const scanFences = (text: string): OpenFence | null => {
  let state: OpenFence | null = null
  for (const line of text.split("\n")) {
    const fence = parseFenceLine(line)
    if (fence === null) continue
    if (state === null) {
      state = fence
    } else if (fence.marker === state.marker && fence.info.length === 0) {
      state = null
    }
  }
  return state
}

/**
 * Repair markdown code fences across chunk boundaries: when splitToChunks
 * cuts inside a fenced block, the open fence is closed at the chunk's end
 * and reopened at the start of the next chunk, so every delivered message
 * parses as complete markdown on its own.
 *
 * The reopen carries the block's FULL info string (```typescript
 * title=example.ts, not a bare ```), so the second half of a split code
 * block keeps its syntax highlighting. The INSERTED CLOSER is always a bare
 * marker, because per CommonMark a closing fence must not carry an info
 * string.
 *
 * See `scanFences` for the tracking rules.
 */
export const repairSplitFences = (chunks: ReadonlyArray<string>): string[] => {
  const out: string[] = []
  let open: OpenFence | null = null
  for (const chunk of chunks) {
    let c: string = open !== null ? reopenLine(open) + "\n" + chunk : chunk
    open = scanFences(c)
    if (open !== null) c = c + "\n" + open.marker
    out.push(c)
  }
  return out
}

/**
 * Characters `repairSplitFences` may add to any ONE chunk of `text`, so the
 * caller can reserve exactly that much of the platform's message budget
 * before splitting.
 *
 * DERIVED, NOT A MAGIC NUMBER. Repair can add at most two things to a single
 * chunk: a reopen line (`reopenLine(f)` + "\n") at the front and a bare
 * closer ("\n" + marker) at the back. So the worst case is
 *
 *     longest possible reopen + 1 + 1 + FENCE_MARKER_LEN
 *
 * The bound on "longest possible reopen" is taken over every 3+ backtick /
 * tilde run ANYWHERE in the text, not just at line starts, because
 * splitToChunks is fence-blind and may cut mid-line: a chunk that begins
 * exactly at such a run turns it into a fence line whose info string is the
 * rest of that line. Scanning every run therefore covers every reopen the
 * repair could ever emit for this text, whatever the cut positions are.
 *
 * Consequences worth noting:
 *   - Text with no fence run at all reserves 0 — repair provably inserts
 *     nothing, so no budget need be spent.
 *   - For a bare ``` block this evaluates to 8 (3+1+1+3), which is exactly the
 *     constant this replaced. The old 8 was not wrong, it was the special case
 *     of an empty info string; a 40-char language tag needs 48 and would have
 *     overflowed the platform limit.
 */
const fenceRepairReserve = (text: string): number => {
  let longestReopen = 0
  for (const m of text.matchAll(/(?:`{3,}|~{3,})([^\n]*)/g)) {
    const candidate = FENCE_MARKER_LEN + (m[1] ?? "").trim().length
    if (candidate > longestReopen) longestReopen = candidate
  }
  if (longestReopen === 0) return 0
  return longestReopen + 1 + 1 + FENCE_MARKER_LEN
}

/**
 * The per-chunk length limit to hand `splitToChunks` so that, after
 * `repairSplitFences`, no chunk exceeds `maxLen`. That promise is proved below
 * for `maxLen >= 7`, and it is NOT made below that: see the NOTE in step 4,
 * where the band is recorded as degenerate rather than quietly worded around.
 *
 * The reserve is derived from the text (see `fenceRepairReserve`) rather than
 * fixed, so short answers keep essentially their whole budget and only a long
 * info string pays for itself. The reserve is honoured in full while it leaves
 * a usable body; past that it is CLAMPED at `bodyFloor`, so the limit never
 * collapses toward 1 and one answer never shatters into hundreds of tiny,
 * rate-limited messages. That collapse is reachable from ORDINARY prose,
 * because `fenceRepairReserve` is a worst case over cut positions (see its
 * comment: `splitToChunks` is fence-blind and cuts mid-line, so a mid-sentence
 * ``` mention really can become a chunk-leading fence) and is therefore
 * bounded only by a line length.
 *
 * The clamp is a POLICY choice, not an impossibility claim. A reserve of
 * 0.6 * maxLen could be honoured exactly, by splitting at 0.4 * maxLen; that
 * is simply not worth a 2.5x message count for a bound that, at that size, is
 * almost always an unrealised worst case over cut positions.
 *
 * THE FLOOR IS DERIVED, AND THE CLAMPED BAND IS PROVED — not sampled. When the
 * clamp binds, the reserve is by definition NOT paid in full, so the floor
 * itself has to carry the guarantee. It does:
 *
 *   1. `splitToChunks` emits chunks of at most `limit`, so every fence-line
 *      candidate inside a chunk is at most `limit` characters and the info
 *      string carried onto a reopen line is at most `limit - FENCE_MARKER_LEN`.
 *   2. `repairSplitFences` prepends `reopenLine(f) + "\n"`, which is at most
 *      `FENCE_MARKER_LEN + (limit - FENCE_MARKER_LEN) + 1 = limit + 1`, and
 *      appends a bare closer `"\n" + marker`, i.e. `1 + FENCE_MARKER_LEN`.
 *   3. A reopened chunk is therefore at most
 *          limit + 1 + limit + 1 + FENCE_MARKER_LEN  =  2 * limit + 5.
 *   4. Substituting the floor below, `limit = floor((maxLen - 5) / 2)`:
 *          2 * floor((maxLen - 5) / 2) + 5  <=  (maxLen - 5) + 5  =  maxLen
 *      for every integer `maxLen`. That is an identity, not a measurement, and
 *      the floor is the LARGEST integer satisfying it, so nothing is
 *      over-reserved: `2*b + 5 <= maxLen` iff `b <= (maxLen - 5) / 2`.
 *
 *      NOTE, RECORDED RATHER THAN WORDED AROUND: the identity governs the
 *      FLOOR TERM ONLY, not the value this function returns. `Math.max(1, ...)`
 *      dominates the floor for `maxLen <= 6`, where `floor((maxLen - 5) / 2)`
 *      is already `<= 0`. Whenever a fence is present at all the returned limit
 *      is then exactly 1, because any match forces `reserve >= 8` (a bare
 *      marker with an empty info string) and so `maxLen - reserve < 0` too; the
 *      bound of step 3 reads `7 > maxLen`. Steps 1 to 4 therefore prove nothing
 *      at those sizes, which is exactly why the headline above is qualified.
 *      (With no fence the limit is just `maxLen`, but then `repairSplitFences`
 *      prepends no reopen line and a chunk cannot exceed `maxLen` anyway.)
 *      Confirmed exhaustively over `maxLen` 1..8192: the bound is violated at
 *      1..6, first satisfied at 7, and holds from there.
 *
 *      Nothing is guaranteed in that band and nothing needs to be: a bare
 *      marker plus its closer is already
 *      `FENCE_MARKER_LEN + 1 + FENCE_MARKER_LEN` = 7 characters, so fence
 *      repair is degenerate below it. The `1` is a crash guard, not a bound
 *      (`splitToChunks` throws on `maxLength <= 0`), and no current caller can
 *      reach the band: the sole producer is `adapter.maxMessageLength`, and the
 *      only two shipping adapters are 2000 (discord.ts) and 4096 (telegram.ts).
 *      Left as prose deliberately. A runtime guard would be dead by
 *      construction and would put a branch in a function whose whole virtue is
 *      that it is four lines of provable arithmetic; a documented precondition
 *      would push a constraint into the public `ChannelAdapter` contract to
 *      serve a size at which the feature is meaningless anyway.
 *
 * The floor this replaced, `floor(maxLen / 2)`, makes step 4 read `maxLen + 5`.
 * Overflow was then REACHABLE whenever the clamp bound AND a fence-line
 * candidate filled the window. Clamp-binding alone is NECESSARY, NOT
 * SUFFICIENT, and the counterexample is already in the suite: the Slice 2b
 * shatter fixture at maxLen 2000 binds the clamp (measured reserve 1987, so
 * `maxLen - reserve` is 13 and the old floor of 1000 wins) yet its worst chunk
 * under that old floor is 998, well inside the limit. Where both conditions did
 * hold, the overflow was measured at exactly 5 characters over at maxLen 500,
 * 1000, 2000 and 4096 alike. Two claims in the comment this replaced were false
 * and are recorded here so they are not reintroduced. (a) A fence line longer
 * than the limit is hard-cut, and that does NOT make what ends up open shorter
 * than the bound assumes — it PINS the carried info string at exactly
 * `limit - FENCE_MARKER_LEN`, i.e. at the worst case. (b) Closing the gap does
 * not need a fence-aware splitter; it needs this one expression. A lower floor
 * is also not "stricter and therefore worse": it makes the clamp bind LATER
 * and reserves MORE, which is the safe direction, so the only question is what
 * it costs in message count — hence taking the largest floor that still proves.
 *
 * Cost: 997 rather than 1000 usable body characters at Discord's 2000, and the
 * floor only binds at all once the derived reserve already exceeds half the
 * budget. Inert on every ordinary path.
 */
const fenceRepairChunkLimit = (text: string, maxLen: number): number => {
  const reserve = fenceRepairReserve(text)
  const bodyFloor = Math.floor((maxLen - (1 + 1 + FENCE_MARKER_LEN)) / 2)
  return Math.max(1, maxLen - reserve, bodyFloor)
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
 * When `standalone` is true (background job delivery), adapters must not
 * mutate live stream-edit turn state (#375).
 */
const deliverChunks = (
  adapter: ChannelAdapter,
  target: DeliveryTarget,
  chunks: string[],
  isPartial: boolean,
  standalone = false,
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
        ...(standalone ? { standalone: true as const } : {}),
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

                // Background job / chat_thread delivery (#375): deliverResult
                // stamps message.delivery and never emits turn-complete. Fan
                // out immediately as a standalone final so stream-edit
                // (Telegram) and final-only adapters receive it without
                // waiting for turn-complete or mutating a live stream-edit.
                if (frame.message.delivery !== undefined) {
                  if (text.trim().length > 0) {
                    const chunks = splitToChunks(text, maxLen)
                    yield* deliverChunks(adapter, target, chunks, false, true)
                  }
                  break
                }

                if (capability === "final-only") {
                  yield* Ref.update(turnBuffer, (prev) =>
                    prev.length > 0 ? prev + "\n\n" + text : text,
                  )
                } else if (capability === "discrete-chunks") {
                  const chunks = splitToChunks(text, maxLen)
                  yield* deliverChunks(adapter, target, chunks, false)
                }
                // stream-edit: live turns wait for turn-complete (unchanged)
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
                    //
                    // Multi-chunk splits reserve exactly what fence repair
                    // can add to one chunk for THIS text — the reopen line
                    // (which carries the block's info string) plus the bare
                    // closer. It is DERIVED per content, not a constant: a
                    // bare ``` block needs 8, a ```typescript title=… block
                    // needs far more, and reserving a constant big enough
                    // for the latter would shatter short answers into tiny
                    // messages. Fence-free text reserves 0. See
                    // fenceRepairChunkLimit for the bound's proof.
                    const chunkLimit =
                      finalContent.length <= maxLen
                        ? maxLen
                        : fenceRepairChunkLimit(finalContent, maxLen)
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
