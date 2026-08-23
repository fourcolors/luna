/**
 * SDK stream/turn handling - split out of chat-service.ts along the seam its
 * own doc comments already named: translating one raw SDK message into the
 * ChatFrame wire shape, plus the narrow shape-probe helpers that decide how
 * to read an SDK message/cause. Moved verbatim from chat-service.ts - no
 * behavior change, no symbol renamed.
 *
 * `handleSdkMessage` already took every piece of per-thread state as an
 * explicit `args` object (it never closed over ChatService's per-thread Refs
 * directly), so the only closure it and `findStoredById` actually captured
 * from the service was `clock` / `inc` / `obs` / `store` - those four become
 * this module's `makeSdkMessageHandling` deps object, exactly the "deps
 * object" pattern used for the job-ticker split.
 */
import { Cause, Context, Effect, Option, PubSub, Queue, Ref, Scope, Stream } from "effect"
import {
  Clock as CoreClock,
  SessionStore,
  type ObservabilityApi,
  type StoredMessage,
  projectOne,
} from "@luna/core"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { type ChatFrame, type ThreadToolsBinding } from "./types.js"
import { extractArtifacts } from "./artifacts.js"
import type { TurnPrompt } from "./chat-service.js"

/* -------------------------------------------------------------------------- */
/* SDK message shape probes (kept narrow — adapter is SDK source-of-truth).   */
/* -------------------------------------------------------------------------- */

/** Exported: also used by chat-service-thread-lifecycle.ts's
 *  `stripNonPersistableOptions`. */
export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null

/** Pull turn-id (uuid) from an assistant or stream_event SDK message. */
const turnIdOf = (m: SDKMessage): string | null => {
  const mm = m as { uuid?: string; parent_tool_use_id?: string | null }
  return mm.uuid ?? null
}

/** Best-effort delta extraction from SDK `stream_event` (partial assistant
 *  text). The SDK's stream-event shape can vary between versions; we accept
 *  ANY {event:{delta:{text}}} or {event:{content_block_delta:{delta:{text}}}}
 *  shape and fall back to null otherwise. Null deltas are skipped. */
const extractStreamEventText = (m: SDKMessage): string | null => {
  if (!isObj(m)) return null
  const event = (m as Record<string, unknown>)["event"]
  if (!isObj(event)) return null
  // shape A: {event:{type:"content_block_delta", delta:{type:"text_delta", text}}}
  const delta = event["delta"]
  if (isObj(delta) && typeof delta["text"] === "string") return delta["text"]
  return null
}

const MAX_TOOL_OUTPUT_CHARS = 2048
const MAX_TOOL_OUTPUT_LINES = 40

/** Normalize an SDK tool_result `content` payload (string | block array |
 *  arbitrary object) into plain text. */
export const normalizeToolResultContent = (content: unknown): string => {
  // SDK `ToolResultBlockParam.content` is optional; a tool that succeeds with
  // no output yields `undefined`. Both null and undefined normalize to "".
  if (content == null) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts = content.map((b) =>
      isObj(b) && typeof b["text"] === "string"
        ? (b["text"] as string)
        : JSON.stringify(b),
    )
    return parts.join("\n")
  }
  return JSON.stringify(content)
}

/** Cap tool output to keep the wire small. Returns the (possibly clipped)
 *  text plus whether it was clipped. */
export const truncateOutput = (
  s: string,
): { readonly output: string; readonly truncated: boolean } => {
  let out = s
  let truncated = false
  const lines = out.split("\n")
  if (lines.length > MAX_TOOL_OUTPUT_LINES) {
    out = lines.slice(0, MAX_TOOL_OUTPUT_LINES).join("\n")
    truncated = true
  }
  if (out.length > MAX_TOOL_OUTPUT_CHARS) {
    out = out.slice(0, MAX_TOOL_OUTPUT_CHARS)
    truncated = true
  }
  if (truncated) out = out + "\n… (truncated)"
  return { output: out, truncated }
}

/** Max chars of failure detail surfaced in the user-facing assistant-error
 *  frame. The informative part (the underlying cause) leads, so this keeps the
 *  bubble bounded without losing the reason. */
const MAX_STREAM_FAILURE_CHARS = 400

/**
 * Render an adapter-stream failure `Cause` into a SHORT, user-facing reason —
 * the underlying SDK cause, never the opaque "An error has occurred".
 *
 * A typed failure (the common case: the adapter fails the stream with an
 * `SDKError`) has its `message` surfaced — `SDKError.message` now carries the
 * real cause (e.g. "native binary not found … pathToClaudeCodeExecutable").
 * A defect/interrupt with no typed failure falls back to the first line of the
 * pretty render (no full stack — that goes to the server log, not the user).
 */
export const formatStreamFailureReason = (
  cause: Cause.Cause<unknown>,
): string => {
  const failure = Cause.findErrorOption(cause)
  const reason = Option.match(failure, {
    onSome: (e) =>
      e instanceof Error && e.message.length > 0 ? e.message : String(e),
    onNone: () => Cause.pretty(cause).split("\n")[0] ?? "unknown error",
  })
  return reason.length > MAX_STREAM_FAILURE_CHARS
    ? reason.slice(0, MAX_STREAM_FAILURE_CHARS) + "…"
    : reason
}

/** Deps `handleSdkMessage` / `findStoredById` close over — everything else
 *  they need arrives as an explicit `args` object at the call site. */
export interface SdkMessageHandlingDeps {
  readonly clock: Context.Service.Shape<typeof CoreClock>
  readonly obs: ObservabilityApi
  readonly store: Context.Service.Shape<typeof SessionStore>
  readonly inc: (
    name: string,
    tags?: Readonly<Record<string, string>>,
    n?: number,
  ) => Effect.Effect<void, never>
  /**
   * Agent participation (PR2, codex review finding 1): fired once per
   * observed NAMED subagent spawn (an Agent/Task tool_use whose input
   * carries a non-blank `subagent_type`). Lives HERE — in the SDK
   * consumer that runs for every turn regardless of connected clients —
   * because the first cut recorded from the ui-ws subagent-tree bridge,
   * which only observes while a WebSocket subscriber is attached: close
   * Moon mid-turn and the involvement was silently, permanently lost.
   * Must be total (never) — a recording failure cannot fail the stream.
   */
  readonly onNamedDelegation?: (
    threadId: string,
    agentName: string,
  ) => Effect.Effect<void, never>
}

/** The SDK's subagent spawn tool, current and legacy wire names — mirrors
 *  ui-ws's subagent-tree bridge AGENT_TOOL_NAMES. */
const AGENT_SPAWN_TOOLS = new Set(["Agent", "Task"])

export const makeSdkMessageHandling = (deps: SdkMessageHandlingDeps) => {
  const { clock, obs, store, inc, onNamedDelegation } = deps

  /** Finding-1 tap: record a NAMED spawn. The two call sites below cover
   *  disjoint blocks (top-level spawns surface only in the final-turn
   *  emission; nested spawns only in the parented sub-block path), so a
   *  given tool_use is recorded at most once without extra dedupe. */
  const recordSpawn = (
    threadId: string,
    toolName: string,
    input: unknown,
  ): Effect.Effect<void, never> => {
    if (!onNamedDelegation || !AGENT_SPAWN_TOOLS.has(toolName)) return Effect.void
    const rawType = (input as { subagent_type?: unknown } | null | undefined)
      ?.subagent_type
    if (typeof rawType !== "string" || !rawType.trim()) return Effect.void
    return onNamedDelegation(threadId, rawType.trim())
  }

  /** Lookup helper: scan store messages for this session, return the
   *  envelope with matching id. The store keeps messages in insertion
   *  order; for chat threads the message we want is almost always the
   *  newest (just-mirrored), so reverse-scan would be ideal. The current
   *  store API only exposes Stream.runCollect — fine for v1, optimize
   *  when SQLite lands (§5.1). */
  const findStoredById = (
    sessionId: string,
    messageId: string,
  ): Effect.Effect<StoredMessage | null, never> =>
    store
      .readMessages(sessionId)
      .pipe(
        Stream.runCollect,
        Effect.map((chunk) => {
          const arr = Array.from(chunk)
          for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i]!.id === messageId) return arr[i]!
          }
          return null
        }),
        Effect.catch(() => Effect.succeed(null as StoredMessage | null)),
      )

  /**
   * Translate one SDK message into ChatFrames published to the thread's
   * pubsub. Pure-ish: only effect is PubSub.publish + Ref updates.
   */
  const handleSdkMessage = (args: {
    readonly threadId: string
    readonly msg: SDKMessage
    readonly pubsub: PubSub.PubSub<ChatFrame>
    readonly inFlightTurnId: Ref.Ref<string | null>
    readonly inFlightText: Ref.Ref<string>
    readonly lastActivity: Ref.Ref<number>
    readonly pendingTurns: Queue.Queue<{
      readonly userMessageId: string
      readonly userText: string
    }>
    readonly assistantText: Ref.Ref<string>
    /** Oldest entry shifted off here on `result` - see the
     *  `inFlightPrompts` decl above. */
    readonly inFlightPrompts: Ref.Ref<ReadonlyArray<TurnPrompt>>
    /** Reset to 0 here on `result` - see the `rotationAttempts` decl above. */
    readonly rotationAttempts: Ref.Ref<number>
    /** Set true here on `result` - see the `hasCompletedATurn` decl above. */
    readonly hasCompletedATurn: Ref.Ref<boolean>
    readonly observeTurn?: ThreadToolsBinding["observeTurn"]
    readonly threadScope: Scope.Closeable
  }): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      // Any SDK traffic counts as activity — keeps a thread "warm" during
      // its turn and resets the idle-reaper clock the moment a turn ends.
      yield* Ref.set(args.lastActivity, yield* clock.nowMs())
      const t = (args.msg as { type?: string }).type
      // Subagent linkage: the SDK forwards a subagent's tool_use /
      // tool_result blocks (and its seed prompt) onto the parent stream
      // with `parent_tool_use_id` set to the spawning Agent/Task call.
      // Parented traffic is NOT part of the top-level conversation — it
      // must never drive assistant-done, the in-flight turn state, or
      // user-message rendering. (Live-probed on SDK 0.3.175 with
      // forwardSubagentText unset: parented messages = the seed user
      // text + the subagent's own tool_use/tool_result blocks.)
      const parentToolUseId =
        (args.msg as { parent_tool_use_id?: string | null })
          .parent_tool_use_id ?? null
      if (t === "stream_event") {
        // Defensive: today no parented stream_events arrive (probed),
        // but if a future SDK forwards subagent deltas they must not be
        // appended to the PARENT's streaming bubble.
        if (parentToolUseId !== null) return
        const deltaText = extractStreamEventText(args.msg)
        if (deltaText === null) return
        yield* inc("luna.chat.assistant_deltas.total")
        // The SDK gives each stream_event its own uuid, so the wire
        // turn id is a Luna-stable id captured from the first delta and
        // kept until the final assistant message lands.
        const existingTurn = yield* Ref.get(args.inFlightTurnId)
        const turnId = existingTurn ?? turnIdOf(args.msg) ?? "unknown"
        if (existingTurn === null) {
          yield* Ref.set(args.inFlightTurnId, turnId)
          yield* Ref.set(args.inFlightText, deltaText)
        } else {
          yield* Ref.update(args.inFlightText, (s) => s + deltaText)
        }
        const cumulative = yield* Ref.get(args.inFlightText)
        yield* PubSub.publish(args.pubsub, {
          type: "assistant-delta",
          threadId: args.threadId,
          turnId,
          text: cumulative,
        })
        return
      }
      if (t === "assistant") {
        if (parentToolUseId !== null) {
          // Subagent-internal assistant message: by default the SDK
          // forwards only its tool_use blocks. Surface them as TAGGED
          // tool-call frames (clients nest/label them under the parent
          // Agent card; pre-subagent clients render them as ordinary
          // steps in the open timeline). Crucially: no assistant-done,
          // no in-flight reset, no store lookup — a parented message is
          // not a top-level turn, and the parent turn's streaming state
          // must survive it untouched.
          const subTurnId = turnIdOf(args.msg) ?? "unknown"
          const subBlocks = (
            args.msg as {
              message?: {
                content?: ReadonlyArray<{
                  type?: string
                  id?: string
                  name?: string
                  input?: unknown
                }>
              }
            }
          ).message?.content ?? []
          for (const b of subBlocks) {
            if (b.type === "tool_use" && typeof b.name === "string") {
              yield* inc("luna.chat.tool_uses.reported", { tool: b.name })
              yield* obs.emit({
                kind: "ToolCall",
                ts: new Date().toISOString(),
                level: "info",
                sessionId: args.threadId,
                toolName: b.name,
                durationMs: 0,
                status: "success",
              })
              yield* recordSpawn(args.threadId, b.name, b.input)
              if (typeof b.id === "string") {
                yield* PubSub.publish(args.pubsub, {
                  type: "tool-call",
                  threadId: args.threadId,
                  turnId: subTurnId,
                  toolCallId: b.id,
                  name: b.name,
                  input: b.input,
                  parentToolUseId,
                })
              }
            }
          }
          return
        }
        // Final assistant turn — adapter has already mirrored to store.
        // Pull the persisted seq via projectOne over a synthesized envelope:
        // we don't have the StoredMessage in hand here, so we read the
        // store for this session and grab the latest assistant by uuid.
        const storedTurnId = turnIdOf(args.msg) ?? "unknown"
        const wireTurnId =
          (yield* Ref.get(args.inFlightTurnId)) ?? storedTurnId
        const stored = yield* findStoredById(args.threadId, storedTurnId)
        if (stored === null) return
        const projected = projectOne(stored)
        if (projected === null) return
        // Emit the turn's `tool-call` frames (+ ToolCall obs events) BEFORE
        // `assistant-done`. Clients apply ChatState synchronously on frame
        // receipt; `assistant-done` forces an immediate render while
        // `tool-call` only schedules one — so publishing the tool-call
        // first guarantees the tool segment is present when the turn is
        // marked done, avoiding a one-frame text-bubble→timeline flash in
        // the moon's grouped activity timeline. durationMs is 0 (the SDK
        // gives no start/stop pairs here); status "success" — completed turn.
        const blocks = (
          args.msg as {
            message?: {
              content?: ReadonlyArray<{
                type?: string
                id?: string
                name?: string
                input?: unknown
              }>
            }
          }
        ).message?.content ?? []
        for (const b of blocks) {
          if (b.type === "tool_use" && typeof b.name === "string") {
            yield* inc("luna.chat.tool_uses.reported", { tool: b.name })
            yield* obs.emit({
              kind: "ToolCall",
              ts: new Date().toISOString(),
              level: "info",
              sessionId: args.threadId,
              toolName: b.name,
              durationMs: 0,
              status: "success",
            })
            yield* recordSpawn(args.threadId, b.name, b.input)
            // The frame links a call to its result by id; the SDK always
            // carries `id` on real tool_use blocks. (Some test fixtures
            // omit it — guard so the obs emit above still fires for them.)
            if (typeof b.id === "string") {
              yield* PubSub.publish(args.pubsub, {
                type: "tool-call",
                threadId: args.threadId,
                turnId: wireTurnId,
                toolCallId: b.id,
                name: b.name,
                input: b.input,
              })
            }
          }
        }
        yield* Ref.set(args.inFlightTurnId, null)
        yield* Ref.set(args.inFlightText, "")
        yield* PubSub.publish(args.pubsub, {
          type: "assistant-done",
          threadId: args.threadId,
          turnId: wireTurnId,
          seq: stored.seq,
          message: projected,
        })
        yield* inc("luna.chat.assistant_messages.completed")
        // Post-completion: extract artifacts (substantial code fences,
        // file-write tool uses) and publish a follow-up frame so the
        // UI can pin them into a side panel. Pure function — safe to
        // run inline; no extra fork needed.
        const artifacts = extractArtifacts(projected)
        if (artifacts.length > 0) {
          yield* PubSub.publish(args.pubsub, {
            type: "artifacts-extracted",
            threadId: args.threadId,
            messageId: projected.id,
            messageSeq: stored.seq,
            artifacts,
          })
        }
        if (projected.text.length > 0) {
          yield* Ref.update(args.assistantText, (current) =>
            current.length === 0
              ? projected.text
              : `${current}\n${projected.text}`,
          )
        }
        return
      }
      if (t === "result") {
        // Final result message — emit CostAccrued + SessionEnd. No ChatFrame
        // is published for result (it's metadata only), but obs consumers
        // (the Events tab) need these signals to show session lifecycle.
        //
        // A `result` reliably terminates a turn, so reset the in-flight turn
        // state here. The assistant branch also resets on its success path,
        // but turns that end WITHOUT a findable assistant message (aborted
        // turn, or a swallowed store-append) never reach that reset — and
        // then the next turn's first delta would append to this turn's
        // leftover text under a stale turnId. Resetting here closes that gap.
        yield* Ref.set(args.inFlightTurnId, null)
        yield* Ref.set(args.inFlightText, "")
        // The turn this `result` closes is no longer "in flight" for
        // rotation purposes - shift it off the head of the unresolved
        // list (FIFO: results close turns in submission order, the same
        // assumption `pendingTurns` below already relies on) so a
        // failure on the NEXT turn does not re-offer this one.
        yield* Ref.update(args.inFlightPrompts, (xs) => xs.slice(1))
        // Restore the FULL per-turn rotation budget for whatever turn
        // comes next - a completed turn proves the account just used is
        // healthy, so a rotation-worthy failure many turns later must not
        // be blocked by attempts spent rotating out of trouble earlier in
        // the thread's life (see the module doc + `rotationAttempts` decl).
        yield* Ref.set(args.rotationAttempts, 0)
        // Marks that real conversation history now exists on this thread
        // - gates the USER-VISIBLE history-dropped notice in
        // `runOrdinaryQuery` so a session id minted (by the SDK's own
        // init/system frame) moments before turn 1's own throttle never
        // reports history loss that never happened.
        yield* Ref.set(args.hasCompletedATurn, true)
        // `result` is the ONLY signal that fires exactly once at the true
        // end of an agentic turn (after every intermediate tool step). An
        // agentic turn is N SDK assistant messages, each its own wire turnId
        // → N `assistant-done` frames; per-message done can't tell the moon
        // "the whole turn is over". This `turn-complete` frame does — the
        // moon uses it to settle (collapse + relabel) its grouped activity
        // timeline. Additive: ui-web is seq-keyed and ignores it.
        yield* PubSub.publish(args.pubsub, {
          type: "turn-complete",
          threadId: args.threadId,
        })
        const m = args.msg as {
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_creation_input_tokens?: number
            cache_read_input_tokens?: number
          }
          total_cost_usd?: number
          duration_ms?: number
          is_error?: boolean
        }
        const u = m.usage ?? {}
        yield* inc("luna.chat.turns.completed", {
          is_error: String(m.is_error === true),
        })
        yield* obs.emit({
          kind: "CostAccrued",
          ts: new Date().toISOString(),
          level: "info",
          sessionId: args.threadId,
          tokensIn: u.input_tokens ?? 0,
          tokensOut: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          estimatedUsd: m.total_cost_usd ?? 0,
        })
        yield* obs.emit({
          kind: "SessionEnd",
          ts: new Date().toISOString(),
          level: m.is_error ? "error" : "info",
          sessionId: args.threadId,
          durationMs: m.duration_ms ?? 0,
        })
        const pending = yield* Queue.poll(args.pendingTurns)
        const assistantText = yield* Ref.getAndSet(args.assistantText, "")
        if (Option.isSome(pending) && args.observeTurn !== undefined) {
          yield* args
            .observeTurn({
              sessionId: args.threadId,
              userMessageId: pending.value.userMessageId,
              userText: pending.value.userText,
              assistantText,
              isError: m.is_error === true,
            })
            .pipe(
              Effect.catchCause(() => Effect.void),
              Effect.forkIn(args.threadScope),
            )
        }
        return
      }
      if (t === "user") {
        const content = (
          args.msg as {
            message?: {
              content?: ReadonlyArray<{
                type?: string
                tool_use_id?: string
                is_error?: boolean
                content?: unknown
              }>
            }
          }
        ).message?.content ?? []
        // Parented user messages also carry the subagent's SEED PROMPT as
        // a text block — the loop below ignores text blocks, so the seed
        // never renders. Only tool_result blocks surface, tagged with the
        // parent linkage when they came from inside a subagent.
        for (const b of content) {
          if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
            const { output, truncated } = truncateOutput(
              normalizeToolResultContent(b.content),
            )
            yield* PubSub.publish(args.pubsub, {
              type: "tool-result",
              threadId: args.threadId,
              toolCallId: b.tool_use_id,
              status: b.is_error === true ? "error" : "ok",
              output,
              truncated,
              ...(parentToolUseId !== null ? { parentToolUseId } : {}),
            })
          }
        }
        return
      }
      // system / hook / status / stream_event-other
      // — not surfaced as chat frames or obs events.
    })

  return { handleSdkMessage, findStoredById }
}
