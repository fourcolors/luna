/**
 * ChatService — owns the per-thread Queue<SDKUserMessage>, the long-lived
 * adapter.query() call, and the PubSub fan-out to subscribers.
 *
 * Architecture (per advisor verdict on Commit 2):
 *
 *   ┌─────────────┐  send/interrupt  ┌──────────────┐  Queue.offer  ┌─────────────┐
 *   │ ui-ws conn  │ ────────────────►│ ChatService  │ ─────────────►│ adapter.query│
 *   │ (or Tauri)  │                  │  per-thread  │               │  per-thread  │
 *   │             │ ◄─── ChatFrame ──│  PubSub      │ ◄── SDKMsg ───│              │
 *   └─────────────┘   subscribe(id)  └──────────────┘   Stream      └─────────────┘
 *
 * Per-thread state lives in a `Ref<Map<threadId, ThreadEntry>>`. Each entry
 * carries:
 *   - inbox: Queue<SDKUserMessage>    — the prompt stream feeding adapter.query
 *   - pubsub: PubSub<ChatFrame>       — the wire-shape fan-out; a borrowed
 *                                       reference into the persistent
 *                                       per-thread-id `pubsubs` map, so
 *                                       subscriptions survive idle-reap →
 *                                       resume (see `pubsubs` below)
 *   - scope: Scope.Closeable     — the per-thread sub-scope; closing it
 *                                       interrupts the SDK subprocess for
 *                                       that thread only (Operator's "stop"
 *                                       button + thread deletion)
 *   - turnCounter: ref to next assistant turnId (uuid is fine, but a counter
 *                                       per thread is debuggable)
 *
 * Why we set `disableIdleTimeout: true` for every thread: chat is the
 * canonical case the flag exists for (commit 5e488d4). User think-time
 * between turns can be hours.
 *
 * Why we set `includePartialMessages: true`: ChatGPT-style streaming.
 * The SDK emits `stream_event` messages we synthesize into `assistant-delta`
 * frames; the final `assistant` message becomes `assistant-done`.
 *
 * Persistence: user turns are persisted by ChatService BEFORE offering to
 * the inbox (cannot rely on the adapter to mirror inbound user turns —
 * SDK-version dependent, and the in-memory fake doesn't echo). Adapter
 * mirrors all OUTBOUND messages (assistant/result/system/etc.) per §12.2 #2.
 *
 * MODULE SPLIT (this file is the service assembly): the SDK message → wire
 * translation lives in chat-service-sdk-messages.ts, thread creation +
 * Case A/B/C resume recovery lives in chat-service-thread-lifecycle.ts, the
 * ordinary path's account-rotation retry loop lives in chat-service-
 * account-rotation.ts, and the fixed MCP allowlist + ThreadToolsProvider
 * injection point live in chat-service-tools.ts. This file builds the
 * shared, service-lifetime resources (the `threads` map, the per-thread-id
 * `pubsubs` map, the resume semaphore, the deliveries hub) once and wires
 * them into those factories, then owns the rest of the public API (send,
 * subscribe, listThreads, …) directly.
 */
import {
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import {
  SessionStore,
  Clock as CoreClock,
  ObservabilityService,
  TelemetryService,
  extractText,
  projectChatMessages,
  projectOne,
  SuggestedActions,
  toView,
  ACTIVE_STATUSES,
  ThreadRegistryService,
  resolveKind,
  readProviderEnv,
  type ChatMessage,
  type SessionSummary,
  type StoredMessage,
} from "@luna/core"
import { SDKAdapter } from "@luna/adapter-sdk"
import { MemoryRouterTag } from "@luna/memory"
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  type ChatFrame,
  type DeliveryNotification,
  type ThreadToolsBinding,
} from "./types.js"
import { appendThreadConfigEntry } from "./thread-session-map.js"
import {
  clampEffort,
  isEffort,
  isUltracode,
  modelSupportsUltracode,
  ultracodeFlagSettings,
  ULTRACODE,
  type EffortOption,
} from "./effort.js"
import { applyClientMarker, stripClientMarker, type ClientMarkerInput } from "./client-marker.js"
import { ThreadToolsProviderTag } from "./chat-service-tools.js"
import { makeThreadLifecycle } from "./chat-service-thread-lifecycle.js"

/** Re-exported for callers that want the same shape. */
export type ClientHint = ClientMarkerInput

/* -------------------------------------------------------------------------- */
/* Internal per-thread state                                                  */
/* -------------------------------------------------------------------------- */

export interface TurnPrompt {
  readonly payload: SDKUserMessage
  readonly memoryContext: string | null
}

export interface ThreadEntry {
  readonly inbox: Queue.Queue<TurnPrompt>
  /** Wire-shape ChatFrame fan-out. NOT owned by this entry or its scope: it is
   *  a borrowed reference into the persistent per-thread-id `pubsubs` map, so
   *  subscriptions taken before an idle reap keep receiving frames after the
   *  thread is re-created. Never shut it down when the entry dies. */
  readonly pubsub: PubSub.PubSub<ChatFrame>
  readonly scope: Scope.Closeable
  /** Stable turn id of the in-flight assistant turn, or null if idle. */
  readonly inFlightTurnId: Ref.Ref<string | null>
  /** Cumulative assistant text within the in-flight turn (for delta snapshots). */
  readonly inFlightText: Ref.Ref<string>
  /** Epoch ms of the last activity (user send or any SDK message). Drives the
   *  idle reaper that releases the thread's `claude` subprocess after a quiet
   *  period — see the reaper near the service tail. */
  readonly lastActivity: Ref.Ref<number>
  readonly pendingTurns: Queue.Queue<{
    readonly userMessageId: string
    readonly userText: string
  }>
  readonly assistantText: Ref.Ref<string>
  readonly recallMemory?: ThreadToolsBinding["recallMemory"]
  readonly observeTurn?: ThreadToolsBinding["observeTurn"]
}

/* -------------------------------------------------------------------------- */
/* Idle-thread reaper — pure decision helpers (unit-tested in isolation)       */
/* -------------------------------------------------------------------------- */

/** Default idle window before a thread's `claude` subprocess is reaped: 30 min. */
export const DEFAULT_IDLE_REAP_MS = 1_800_000

/**
 * Parse the LUNA_CHAT_THREAD_IDLE_MS env override.
 *  - absent / non-numeric / negative → DEFAULT_IDLE_REAP_MS
 *  - `0` → 0 (explicitly disables the reaper)
 *  - any positive number → that many ms
 */
export const parseIdleReapMs = (raw: string | undefined): number => {
  // An absent OR empty/whitespace value means "unset" → default. (Number("")
  // is 0, which would otherwise silently disable the reaper.)
  if (raw === undefined || raw.trim() === "") return DEFAULT_IDLE_REAP_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_REAP_MS
}

/**
 * Default ceiling on inline query-time recall: 2.5s. Recall must inject before
 * the SDK turn, so it cannot be fully backgrounded like `observeTurn`. A slow or
 * hung embedder / vector search would otherwise stall the whole turn - the user's
 * message never reaches the SDK and the chat appears frozen. On expiry we degrade
 * to no recalled context and send the original payload.
 */
export const DEFAULT_RECALL_TIMEOUT_MS = 2_500

/**
 * Parse the LUNA_CHAT_RECALL_TIMEOUT_MS env override.
 *  - absent / empty / non-numeric / negative → DEFAULT_RECALL_TIMEOUT_MS
 *  - `0` → 0 (disables the bound; recall may block the turn indefinitely)
 *  - any positive number → that many ms
 */
export const parseRecallTimeoutMs = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === "") return DEFAULT_RECALL_TIMEOUT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RECALL_TIMEOUT_MS
}

/**
 * Default cap on how many of a thread's most-recent stored messages
 * subscribe() loads to build the initial `snapshot` ChatFrame: 500.
 *
 * Perf fix (2026-07-23): subscribe() used to call `store.readMessages()`
 * with NO bound, so every thread open/switch did a full `SELECT * FROM
 * messages WHERE session_id=? ORDER BY seq ASC` (including the heavy
 * `content_json` column) followed by `Stream.runCollect` + `projectOne`
 * over the ENTIRE history — cost scaled with total thread length, not with
 * what the UI actually renders on open. This bounds the snapshot to the
 * most recent N messages (by seq) while leaving `readMessages` itself
 * unbounded by default, so callers that legitimately need full history
 * (dream's gatherInputs distillation, findStoredById's by-id lookup) are
 * unaffected — only subscribe()'s initial-snapshot call opts in.
 *
 * Risk: a thread with more than this many stored messages will no longer
 * show its full history in the initial snapshot after this change — there
 * is currently no "load older messages" pagination endpoint, so anything
 * before the cutoff is not reachable from the UI until one is added. 500
 * is chosen to comfortably exceed a normal chat session; flagged as a
 * known limitation in the PR, not silently absorbed.
 */
export const DEFAULT_SNAPSHOT_MESSAGE_LIMIT = 500

/**
 * Parse the LUNA_CHAT_SNAPSHOT_MESSAGE_LIMIT env override.
 *  - absent / empty / non-numeric / negative → DEFAULT_SNAPSHOT_MESSAGE_LIMIT
 *  - `0` → 0 (disables the bound; subscribe() loads full history, legacy behavior)
 *  - any positive number → that many messages
 */
export const parseSnapshotMessageLimit = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SNAPSHOT_MESSAGE_LIMIT
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SNAPSHOT_MESSAGE_LIMIT
}

/**
 * Pure decision: should a thread be reaped right now? A thread is reapable iff
 * the reaper is enabled (idleReapMs > 0), it has no in-flight turn, and it has
 * been quiet for at least the idle window. Kept pure so the policy is tested
 * without standing up the whole ChatService.
 */
export const isThreadIdleReapable = (args: {
  readonly now: number
  readonly lastActivity: number
  readonly inFlightTurnId: string | null
  readonly idleReapMs: number
}): boolean =>
  args.idleReapMs > 0 &&
  args.inFlightTurnId === null &&
  args.now - args.lastActivity >= args.idleReapMs

/**
 * Derive a cheap, no-model-call title from the first user message text.
 * Takes the first line (up to the first newline), then trims whitespace and
 * truncates to 60 characters. Returns null when the result would be empty.
 *
 * Phase 3 — Claude-Code-style naming without a model call.
 * Two call sites, same heuristic: (1) at ingest, the title is set once on
 * the first turn via ThreadRegistry.upsert (skipped when the thread is
 * already titled); (2) at read time, listThreads derives one from the
 * stored first user message (client marker stripped) for legacy threads
 * that predate the heuristic, persisted via setTitleIfNull.
 */
export const deriveTitleFromMessage = (text: string): string | null => {
  const firstLine = text.split("\n")[0] ?? ""
  const trimmed = firstLine.trim()
  if (trimmed.length === 0) return null
  return trimmed.length <= 60 ? trimmed : trimmed.slice(0, 60)
}

/** Synthesize an SDKUserMessage envelope from text + optional file attachments.
 *
 * When attachments are present, we build a content-block array per the
 * Anthropic API spec: text block first (omitted if empty), then one block per
 * attachment in document order — an `image` block for the four image media
 * types, or a `document` block for `application/pdf` (verified to pass through
 * the Agent SDK to the model).
 *
 * The SDK accepts both:
 *   content: string                      (text-only shortcut)
 *   content: Array<ContentBlockParam>    (structured, required for attachments)
 */
const buildUserMessage = (
  text: string,
  attachments?: ReadonlyArray<{ readonly mediaType: string; readonly data: string }>,
): SDKUserMessage => {
  if (!attachments || attachments.length === 0) {
    return {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage
  }

  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
    | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } }

  const content: ContentBlock[] = []
  if (text.length > 0) {
    content.push({ type: "text", text })
  }
  for (const a of attachments) {
    if (a.mediaType === "application/pdf") {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: a.data },
      })
    } else {
      content.push({
        type: "image",
        source: { type: "base64", media_type: a.mediaType, data: a.data },
      })
    }
  }
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  } as SDKUserMessage
}

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

const makeChatService = Effect.gen(function* () {
      const store = yield* SessionStore
      const adapter = yield* SDKAdapter
      const clock = yield* CoreClock
      const obs = yield* ObservabilityService
      const tel = yield* TelemetryService
      const memoryRouter = yield* MemoryRouterTag
      // Ceiling on inline query-time recall so a hung embedder/vector search
      // can never stall a turn (0 disables). Read once at construction.
      const recallTimeoutMs: number = parseRecallTimeoutMs(
        process.env["LUNA_CHAT_RECALL_TIMEOUT_MS"],
      )
      // Perf fix (2026-07-23): bounds subscribe()'s initial-snapshot read —
      // see DEFAULT_SNAPSHOT_MESSAGE_LIMIT doc comment for rationale/risk.
      const snapshotMessageLimit: number = parseSnapshotMessageLimit(
        process.env["LUNA_CHAT_SNAPSHOT_MESSAGE_LIMIT"],
      )
      // Optional — when the app provides it, EVERY thread (new or resumed)
      // gets its MCP servers + merged system prompt + post-create binding.
      // Omitted in tests/headless that don't need tools.
      const threadToolsProvider = yield* Effect.serviceOption(
        ThreadToolsProviderTag,
      )

      // Optional — ThreadRegistry (luna.db durable index). When provided, it
      // is the source of truth for thread→SDK-session mapping across restarts.
      // When absent (tests/headless), the legacy JSON map path is used as
      // best-effort fallback for backward compat (read-only; no dual-write).
      const threadRegistry = yield* Effect.serviceOption(ThreadRegistryService)
      // Optional — the shared Suggested Actions service. When wired, propose()
      // (live tool + Dream) and respond() (ui-ws) mutate it; its `changes`
      // stream drives the per-thread frames below.
      const suggestedActions = yield* Effect.serviceOption(SuggestedActions)
      const serviceScope = yield* Effect.scope
      const runtime = yield* Effect.context<never>()

      const threads = yield* Ref.make<ReadonlyMap<string, ThreadEntry>>(new Map())

      // Per-thread ChatFrame fan-outs, keyed by thread id and deliberately
      // OUTSIDE ThreadEntry/threadScope. The idle reaper releases a thread's
      // RUNTIME (subprocess, inbox, consumer fiber) but subscribers hold
      // PubSub subscriptions taken BEFORE the reap; if resume minted a fresh
      // PubSub, every pre-reap subscriber would be orphaned — frames from
      // the recovered thread go to the new hub while the ui-ws forwarder
      // still waits on the old one, so the client sees no reply (and no
      // error) after an idle gap. get-or-create keyed by id keeps every
      // subscriber attached across evict → resume cycles. Entries are never
      // removed: a PubSub is a few hundred bytes and the map is bounded by
      // the number of distinct threads touched in this process's lifetime,
      // which the pre-existing design already accumulated (it leaked one
      // orphaned PubSub per re-create; now re-creates reuse the original).
      const pubsubs = yield* Ref.make(
        new Map<string, PubSub.PubSub<ChatFrame>>(),
      )
      const getOrCreatePubSub = (
        id: string,
      ): Effect.Effect<PubSub.PubSub<ChatFrame>, never> =>
        Effect.gen(function* () {
          const existing = (yield* Ref.get(pubsubs)).get(id)
          if (existing !== undefined) return existing
          const fresh = yield* PubSub.unbounded<ChatFrame>()
          return yield* Ref.modify(pubsubs, (m) => {
            // Concurrent-create guard: first writer wins so both callers
            // hand out the SAME hub (a second hub would re-introduce the
            // orphaned-subscriber split this map exists to prevent).
            const raced = m.get(id)
            if (raced !== undefined) return [raced, m] as const
            const next = new Map(m)
            next.set(id, fresh)
            return [fresh, next] as const
          })
        })

      // Guard for the get→create critical section inside ensureThreadLive.
      // Prevents two concurrent callers (e.g. two channel messages arriving
      // simultaneously for the same reaped thread) from both running createThread
      // and orphaning a subprocess. One permit, service-wide (threads are keyed
      // by id so contention is brief and infrequent).
      const resumeGate = yield* Semaphore.make(1)

      // Background-delivery notifications (#124). `deliverResult` publishes one
      // per delivered result; the WS layer runs `deliveries` once at boot and
      // broadcasts each to ALL connected clients as a "Luna finished X" toast —
      // surfacing the result even when its thread is not the one on screen.
      // Sliding so a burst of completions can never block the producer.
      const deliveriesHub = yield* PubSub.sliding<DeliveryNotification>(64)

      // Bridge the (frame-agnostic) Suggested Actions change-stream onto the
      // per-thread chat pubsubs: each changed ROW becomes a `suggested-action-
      // update` ChatFrame on its thread's stream. A row for a thread with no
      // live entry (e.g. an offline Dream proposal) is skipped — replay-on-
      // subscribe re-surfaces it when that thread is next opened. Forked into
      // the service scope so it lives for the ChatService lifetime.
      yield* Option.match(suggestedActions, {
        onNone: () => Effect.void,
        onSome: (sa) =>
          sa.changes.pipe(
            Stream.runForEach((row) =>
              Effect.gen(function* () {
                const m = yield* Ref.get(threads)
                const entry = m.get(row.threadId)
                if (!entry) return
                yield* PubSub.publish(entry.pubsub, {
                  type: "suggested-action-update",
                  threadId: row.threadId,
                  action: toView(row),
                })
              }),
            ),
            Effect.catchCause(() => Effect.void),
            Effect.forkIn(serviceScope),
            Effect.asVoid,
          ),
      })

      const inc = (
        name: string,
        tags: Readonly<Record<string, string>> = {},
        n = 1,
      ): Effect.Effect<void, never> =>
        tel.inc(name, tags, n).pipe(Effect.catchCause(() => Effect.void))

      // Thread creation + Case A/B/C resume recovery — see
      // chat-service-thread-lifecycle.ts. It shares the resources built
      // above (the threads map, the pubsubs get-or-create, the resume
      // semaphore, the service scope + runtime) via this deps object.
      const { createThread, ensureThreadLive } = makeThreadLifecycle({
        store,
        adapter,
        clock,
        obs,
        threadToolsProvider,
        threadRegistry,
        serviceScope,
        runtime,
        threads,
        getOrCreatePubSub,
        resumeGate,
        inc,
      })

      /**
       * Send a user turn. Persists it (so the sidebar preview updates and
       * the snapshot includes it) THEN offers it to the inbox. Returns the
       * persisted ChatMessage so the caller can render the user bubble
       * immediately without a snapshot round-trip.
       *
       * Returns Option.none if the thread is unknown.
       */
      const send = (
        threadId: string,
        text: string,
        attachments?: ReadonlyArray<{ readonly mediaType: string; readonly data: string }>,
        client?: ClientHint,
      ): Effect.Effect<Option.Option<ChatMessage>, never> =>
        Effect.gen(function* () {
          // Fast path: thread already live.
          let entry = (yield* Ref.get(threads)).get(threadId)

          // Slow path: thread was evicted by the idle reaper — attempt recovery
          // via ensureThreadLive (Case A/B/C, semaphore-guarded against races).
          if (!entry) {
            const recovered = yield* ensureThreadLive(threadId)
            if (Option.isNone(recovered)) {
              // Case C: genuinely unknown thread — emit the warning event.
              yield* inc("luna.chat.user_messages.rejected", {
                reason: "unknown_thread",
              })
              yield* obs.emit({
                kind: "Error",
                ts: new Date().toISOString(),
                level: "warn",
                errorTag: "ChatUnknownThread",
                message: `unknown thread: ${threadId}`,
                context: { threadId },
              })
              console.warn(`[chat] ChatUnknownThread: ${threadId}`)
              return Option.none<ChatMessage>()
            }
            entry = recovered.value
          }

          const ts = yield* clock.nowMs()
          // Mark activity up front so the idle reaper never releases a thread
          // that just received a user message but whose SDK reply is still pending.
          yield* Ref.set(entry.lastActivity, ts)
          const messageId = `usr_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}`
          const markedText = applyClientMarker(text, client)
          const userPayload = buildUserMessage(markedText, attachments)

          const stored = yield* store
            .appendMessage({
              sessionId: threadId,
              messageId,
              ts,
              parentId: null,
              kind: "user",
              payload: userPayload,
            })
            .pipe(Effect.catch(() => Effect.succeed(null as StoredMessage | null)))
          if (stored === null) {
            yield* inc("luna.chat.user_messages.rejected", {
              reason: "store_append_failed",
            })
            return Option.none<ChatMessage>()
          }

          const projected = projectOne(stored)

          // Publish `user-accepted` BEFORE handing the message to the SDK.
          // Otherwise the assistant turn (which the SDK can produce in
          // microseconds for fast/fake backends) may race ahead of the
          // user-accepted frame, leading to out-of-order frames on the
          // wire and a confused renderer.
          if (projected !== null) {
            yield* PubSub.publish(entry.pubsub, {
              type: "user-accepted",
              threadId,
              seq: stored.seq,
              message: projected,
            })
            yield* inc("luna.chat.user_messages.accepted", {
              attachments: String(attachments?.length ?? 0),
            })
          }

          // Recall runs after persistence so the canonical transcript never
          // contains injected context. A provider failure OR a timeout is
          // required to degrade to null; ChatService then sends the original
          // payload. The bound matters because recall must inject before the
          // SDK turn (it cannot be backgrounded like `observeTurn`), so a hung
          // embedder / vector search would otherwise freeze the whole turn.
          const recalled =
            entry.recallMemory === undefined
              ? null
              : yield* (() => {
                  const recall = entry.recallMemory({
                    sessionId: threadId,
                    userMessageId: messageId,
                    userText: text,
                  })
                  return recallTimeoutMs > 0
                    ? recall.pipe(
                        Effect.timeoutOrElse({
                          duration: Duration.millis(recallTimeoutMs),
                          orElse: () =>
                            inc("luna.chat.recall.timeouts").pipe(Effect.as(null)),
                        }),
                      )
                    : recall
                })()
          // Keep observation metadata in a parallel FIFO. SDK turns are
          // sequential per thread, so each exactly-once result consumes the
          // corresponding user seed. Queue shutdowns remain best-effort.
          yield* Queue.offer(entry.pendingTurns, {
            userMessageId: messageId,
            userText: text,
          }).pipe(Effect.catchCause(() => Effect.void))
          yield* Queue.offer(entry.inbox, {
            payload: userPayload,
            memoryContext: recalled,
          }).pipe(
            Effect.catchCause(() => Effect.void),
          )

          // Phase 3: bump last_active_at on every turn (best-effort, off hot path).
          // A DB failure here must never break live chat.
          if (Option.isSome(threadRegistry)) {
            yield* threadRegistry.value
              .touch(threadId)
              .pipe(Effect.catchCause(() => Effect.void))

            // Phase 3 title heuristic: on the first turn, if the thread has no
            // title yet, derive one from the user message text — first line,
            // trimmed, max 60 chars. No model call; cheap and always available.
            yield* Effect.gen(function* () {
              const existing = yield* threadRegistry.value.get(threadId)
              if (existing !== null && existing.title === null) {
                const derived = deriveTitleFromMessage(text)
                if (derived !== null) {
                  yield* threadRegistry.value.upsert({ id: threadId, title: derived })
                }
              }
            }).pipe(Effect.catchCause(() => Effect.void))
          }

          return projected !== null
            ? Option.some(projected)
            : Option.none<ChatMessage>()
        })

      /**
       * Deliver a FINISHED result into a thread as an assistant message (issue
       * #124's `chat_thread` delivery sink). Unlike `send`, this does NOT spin
       * an SDK turn — the text is already final. It:
       *   1. persists the message to the SessionStore (so a non-live thread
       *      replays it on next subscribe — the not-live case is handled for
       *      free by `subscribe`'s snapshot path),
       *   2. if the thread is live, publishes `assistant-done` + `turn-complete`
       *      so current subscribers render it immediately and Moon's grouped
       *      activity timeline settles, and
       *   3. publishes a cross-thread `DeliveryNotification` on `deliveries`
       *      (the WS layer turns it into a global toast).
       *
       * The message carries a persisted `luna_delivery` marker so the UI can
       * render it "from a background task" even after a reload. Best-effort:
       * if the thread has no session row (never created / deleted) the message
       * is dropped with a warning — the result still lives in
       * `job_runs.output_text`, matching the obs_note sink's drop-on-missing.
       */
      const deliverResult = (input: {
        readonly threadId: string
        readonly text: string
        readonly source: string
        readonly label?: string
      }): Effect.Effect<Option.Option<ChatMessage>, never> =>
        Effect.gen(function* () {
          // Empty/whitespace result → nothing to show. A successful turn can
          // still yield empty prose (the model emitted only tool calls, or just
          // whitespace); persisting an empty bubble + firing a "Luna finished"
          // toast that points at nothing is worse than silence. Drop both here,
          // at the single source of truth, so the message, the per-thread frame,
          // and the global toast stay consistent. The text is still preserved in
          // job_runs.output_text.
          if (!input.text || input.text.trim().length === 0) {
            yield* inc("luna.chat.deliveries.dropped", { reason: "empty" })
            return Option.none<ChatMessage>()
          }
          const ts = yield* clock.nowMs()
          const messageId = `ast_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}`
          const deliveryMarker = {
            source: input.source,
            ...(input.label ? { label: input.label } : {}),
          }
          const payload = {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: input.text }],
            },
            // Stamp the provenance marker; projectOne surfaces it onto
            // ChatMessage.delivery, and it survives restart/replay.
            luna_delivery: deliveryMarker,
          }

          const stored = yield* store
            .appendMessage({
              sessionId: input.threadId,
              messageId,
              ts,
              parentId: null,
              kind: "assistant",
              payload,
            })
            .pipe(Effect.catch(() => Effect.succeed(null as StoredMessage | null)))
          if (stored === null) {
            yield* inc("luna.chat.deliveries.dropped", { reason: "no_session" })
            yield* obs.emit({
              kind: "Error",
              ts: new Date().toISOString(),
              level: "warn",
              errorTag: "ChatDeliveryNoThread",
              message: `deliverResult: no session row for thread ${input.threadId}; dropping`,
              context: { threadId: input.threadId },
            })
            return Option.none<ChatMessage>()
          }

          const projected = projectOne(stored)
          if (projected === null) return Option.none<ChatMessage>()

          // Live thread → push to subscribers now. Non-live → the store write
          // above is enough; subscribe()'s snapshot replays it on next open.
          //
          // NOTE: we publish ONLY assistant-done, NOT turn-complete. A delivery
          // can land while the user has a live streaming turn in flight on this
          // same thread ("accept an action, keep chatting"). turn-complete
          // settles the trailing RUN of assistant turns in Moon's grouped
          // timeline — emitting it here would prematurely collapse that live
          // turn. The delivered bubble settles itself client-side (it arrives
          // complete, with no in-flight state to close).
          const m = yield* Ref.get(threads)
          const entry = m.get(input.threadId)
          if (entry) {
            yield* PubSub.publish(entry.pubsub, {
              type: "assistant-done",
              threadId: input.threadId,
              turnId: messageId,
              seq: stored.seq,
              message: projected,
            })
          }

          // Cross-thread notification (global toast) — best-effort.
          const preview = input.text.replace(/\s+/g, " ").trim().slice(0, 140)
          yield* PubSub.publish(deliveriesHub, {
            threadId: input.threadId,
            source: input.source,
            label: input.label ?? "a background task",
            preview,
            ts,
          }).pipe(Effect.asVoid)

          yield* inc("luna.chat.deliveries.posted", { source: input.source })
          return Option.some(projected)
        })

      /** Interrupt the thread's in-flight assistant turn (Stop button).
       *  Calls Query.interrupt() via the adapter; emits an `assistant-error`
       *  frame tagged `interrupted`. */
      const interrupt = (
        threadId: string,
      ): Effect.Effect<void, never> =>
        Effect.gen(function* () {
          const m = yield* Ref.get(threads)
          const entry = m.get(threadId)
          if (!entry) return
          const handle = yield* adapter.getQueryHandle(threadId)
          if (handle === null) return
          // Best-effort interrupt; SDK rejects mid-flight cancellation
          // sometimes — swallow.
          yield* Effect.tryPromise(() => handle.interrupt()).pipe(
            Effect.catch(() => Effect.void),
          )
          const turnId = yield* Ref.get(entry.inFlightTurnId)
          yield* PubSub.publish(entry.pubsub, {
            type: "assistant-error",
            threadId,
            turnId,
            error: { kind: "interrupted", message: "user interrupted" },
          })
          // Clear the in-flight turn state AFTER the error frame reads turnId.
          // An interrupted turn typically ends without a `result`/`assistant`
          // message, so without this reset the next turn's first delta would
          // append to this turn's leftover text under the stale turnId.
          yield* Ref.set(entry.inFlightTurnId, null)
          yield* Ref.set(entry.inFlightText, "")
          // Interrupted SDK turns normally emit no terminal result. Consume
          // the matching observation seed here so the next successful result
          // cannot be paired with stale user text. Candidate capture remains
          // useful for an interrupted turn and stays off the interrupt path.
          const pending = yield* Queue.poll(entry.pendingTurns)
          const assistantText = yield* Ref.getAndSet(entry.assistantText, "")
          if (Option.isSome(pending) && entry.observeTurn !== undefined) {
            yield* entry
              .observeTurn({
                sessionId: threadId,
                userMessageId: pending.value.userMessageId,
                userText: pending.value.userText,
                assistantText,
                isError: true,
              })
              .pipe(
                Effect.catchCause(() => Effect.void),
                Effect.forkIn(entry.scope),
              )
          }
          yield* inc("luna.chat.interrupts.total")
        })

      /**
       * Live model + effort update for an existing thread.
       *
       * Recovery contract matches send()/subscribe(): a thread evicted by the
       * idle reaper is resumed via ensureThreadLive before anything else, so
       * a switch on a quiet-but-real thread applies; only a genuinely unknown
       * thread rejects both fields with reason "unknown thread".
       *
       * - effort: clamped against the per-model matrix (effort.ts) FIRST —
       *   the reference model is the one this call switches to when
       *   provided, else the thread's current model. A model that takes no
       *   effort (e.g. haiku) → `rejected`; an unsupported level → clamped
       *   to the highest supported. Valid levels are applied live via
       *   `Query.applyFlagSettings` ("max" runs as "xhigh" — see the
       *   ThreadConfigFrame contract in protocol.ts).
       * - model: applied immediately via `Query.setModel` ONLY when the new
       *   model is in the same provider lane as the current model (resolveKind
       *   comparison). Cross-lane switches are deferred (queued for the next
       *   thread creation) because the SDK subprocess can't hot-swap its
       *   credential chain mid-session.
       *
       * `applied` is pushed ONLY after the live SDK call succeeds; a thrown
       * applyFlagSettings/setModel lands the field in `rejected` and skips
       * persistence (the ack never reports success on a failed switch).
       * Accepted changes persist via store.setOptions + appendThreadConfigEntry.
       * The ack object is returned for the WS handler to forward as a
       * `thread-config` frame to the requesting client.
       */
      const setThreadConfig = (opts: {
        readonly threadId: string
        readonly model?: string
        readonly effort?: EffortOption
      }): Effect.Effect<{
        readonly threadId: string
        readonly model?: string
        readonly effort?: EffortOption
        readonly applied: ReadonlyArray<"model" | "effort">
        readonly deferred: ReadonlyArray<"model" | "effort">
        readonly rejected?: ReadonlyArray<{ readonly field: "model" | "effort"; readonly reason: string }>
      }, never> =>
        Effect.gen(function* () {
          const { threadId, model, effort } = opts
          const applied: Array<"model" | "effort"> = []
          const deferred: Array<"model" | "effort"> = []
          const rejected: Array<{ field: "model" | "effort"; reason: string }> = []

          // Same recovery contract as send()/subscribe(): a thread evicted
          // by the idle reaper is NOT unknown — resume it via
          // ensureThreadLive so a model/effort switch on a quiet-but-real
          // thread applies instead of rejecting with "unknown thread".
          if (Option.isNone(yield* ensureThreadLive(threadId))) {
            // Genuinely unknown thread — reject everything gracefully
            if (model !== undefined) rejected.push({ field: "model", reason: "unknown thread" })
            if (effort !== undefined) rejected.push({ field: "effort", reason: "unknown thread" })
            return { threadId, applied, deferred, ...(rejected.length > 0 ? { rejected } : {}) }
          }

          const handle = yield* adapter.getQueryHandle(threadId)
          const providerEnv = readProviderEnv()

          // Pre-change options, read BEFORE any write: the effort clamp's
          // reference model and the lane guard both want the state as it was
          // when the request arrived. Persist steps below re-read fresh
          // state so the effort write isn't clobbered by the model merge.
          const preOptions = yield* store.getOptions(threadId)
          const currentModel = preOptions?.sdkOptions?.model as string | undefined

          // The effort echoed in the ack: the EFFECTIVE level when accepted
          // (clamping may adjust it), the requested level otherwise.
          let ackEffort = effort

          // ── Effort ──────────────────────────────────────────────────────────
          if (isUltracode(effort)) {
            // ── Ultracode ── a dropdown token, not an SDK effort. Enable the
            // mode on the SAME live control rail as effort (applyFlagSettings).
            // The Workflow TOOL is fixed at query construction, so the live
            // toggle turns the mode on now but full orchestration tooling lands
            // on the next thread rebuild (which reads the persisted token) — the
            // "live now, full effect on rebuild" contract Luna already uses for
            // cross-lane model switches.
            const referenceModel =
              typeof model === "string" && model.trim() !== ""
                ? model
                : currentModel
            if (!modelSupportsUltracode(referenceModel ?? "")) {
              // referenceModel undefined ⇒ the thread's current model is unknown
              // (default lane), NOT a model we know to be non-capable. Report
              // that explicitly so an operator doesn't chase a capability red
              // herring.
              const reason =
                referenceModel === undefined
                  ? "current model unknown — switch to an xhigh-capable model (Opus 4.7/4.8, Fable) to use ultracode"
                  : `model ${referenceModel} does not support ultracode`
              rejected.push({ field: "effort", reason })
              yield* Effect.logWarning(
                `[chat] set-thread-config: ultracode rejected — ${reason}`,
              )
            } else {
              let liveOk = true
              if (handle !== null) {
                liveOk = yield* Effect.tryPromise(() =>
                  handle.applyFlagSettings(ultracodeFlagSettings()),
                ).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)))
              }
              if (liveOk) {
                applied.push("effort")
                ackEffort = ULTRACODE
                // Persist token (thread-session-map → recovery) + SDK settings
                // (store snapshot), dropping any stale real effort so a rebuild
                // never feeds "ultracode" to Options.effort.
                const existingOpts = yield* store.getOptions(threadId)
                const mergedSdk: Record<string, unknown> = {
                  ...(existingOpts?.sdkOptions ?? {}),
                  settings: ultracodeFlagSettings(),
                }
                delete mergedSdk["effort"]
                yield* store
                  .setOptions(threadId, { sdkOptions: mergedSdk })
                  .pipe(Effect.catch(() => Effect.void))
                yield* Option.match(threadRegistry, {
                  onNone: () => {
                    const lunaHome = process.env["LUNA_HOME"]
                    if (lunaHome !== undefined) {
                      appendThreadConfigEntry(lunaHome, threadId, { effort: ULTRACODE })
                    }
                    return Effect.void
                  },
                  onSome: (reg) =>
                    reg
                      .setConfig(threadId, { effort: ULTRACODE })
                      .pipe(Effect.catchCause(() => Effect.void)),
                })
              } else {
                rejected.push({ field: "effort", reason: "live ultracode switch failed" })
                yield* Effect.logWarning(
                  "[chat] set-thread-config: applyFlagSettings failed — ultracode not applied",
                )
              }
            }
          } else if (effort !== undefined) {
            // Per-model clamp (the same matrix the hello advertises). The
            // reference is the model this call switches to when provided,
            // else the thread's current model — so an effort-only change on
            // a haiku thread is rejected, and sonnet+xhigh clamps to max.
            const referenceModel =
              typeof model === "string" && model.trim() !== ""
                ? model
                : currentModel
            const clamp = isEffort(effort)
              ? clampEffort(referenceModel, effort)
              : undefined
            if (clamp === undefined) {
              rejected.push({ field: "effort", reason: `unknown effort level: ${effort}` })
            } else if (clamp.dropped) {
              rejected.push({
                field: "effort",
                reason: `model ${referenceModel ?? "(default)"} takes no effort parameter`,
              })
              yield* Effect.logWarning(
                `[chat] set-thread-config: effort '${effort}' rejected — model '${referenceModel ?? "(default)"}' takes no effort parameter`,
              )
            } else {
              const effective = clamp.effort ?? effort
              if (effective !== effort) {
                yield* Effect.logWarning(
                  `[chat] set-thread-config: effort '${effort}' clamped to '${effective}' for model '${referenceModel ?? "(default)"}'`,
                )
              }
              // Live-switch via applyFlagSettings. "max" runs as "xhigh" on
              // the LIVE query only — Settings.effortLevel has no "max". Per
              // the ThreadConfigFrame contract (protocol.ts), the ack still
              // reports the accepted thread-level preference ("max"); the
              // persisted value applies exactly on the next rebuild
              // (recovery / new thread), which uses Options.effort.
              let liveOk = true
              if (handle !== null) {
                const settingsLevel: "low" | "medium" | "high" | "xhigh" =
                  effective === "max" ? "xhigh" : effective
                liveOk = yield* Effect.tryPromise(() =>
                  handle.applyFlagSettings({ effortLevel: settingsLevel }),
                ).pipe(
                  Effect.as(true),
                  Effect.catch(() => Effect.succeed(false)),
                )
              }
              if (liveOk) {
                // Confirmed (or no live handle — accepted as queued intent).
                applied.push("effort")
                ackEffort = effective
                // Persist: merge effort into the stored sdkOptions
                // (read-patch-write so other sdkOptions fields survive).
                const existingOpts = yield* store.getOptions(threadId)
                const mergedSdk = { ...(existingOpts?.sdkOptions ?? {}), effort: effective }
                yield* store.setOptions(threadId, { sdkOptions: mergedSdk }).pipe(
                  Effect.catch(() => Effect.void),
                )
                yield* Option.match(threadRegistry, {
                  onNone: () => {
                    const lunaHome = process.env["LUNA_HOME"]
                    if (lunaHome !== undefined) {
                      appendThreadConfigEntry(lunaHome, threadId, { effort: effective })
                    }
                    return Effect.void
                  },
                  onSome: (reg) =>
                    reg
                      .setConfig(threadId, { effort: effective })
                      .pipe(Effect.catchCause(() => Effect.void)),
                })
              } else {
                // The SDK call threw — the ack must NOT report success, and
                // the unapplied value must NOT persist.
                rejected.push({ field: "effort", reason: "live effort switch failed" })
                yield* Effect.logWarning(
                  "[chat] set-thread-config: applyFlagSettings failed — effort not applied",
                )
              }
            }
          }

          // ── Model ────────────────────────────────────────────────────────────
          if (model !== undefined) {
            if (typeof model !== "string" || model.trim() === "") {
              rejected.push({ field: "model", reason: "model id must be a non-empty string" })
            } else {
              // Same-lane check: compare provider kind of current vs next model.
              // If lanes differ, setModel mid-session would switch the SDK subprocess
              // to a provider it has no credential for → defer to next thread creation.
              const currentKind = currentModel !== undefined
                ? resolveKind(currentModel, providerEnv)
                : "anthropic" // default lane
              const nextKind = resolveKind(model, providerEnv)

              if (currentKind !== nextKind) {
                // Cross-lane: deferred (next thread creation uses the new model)
                deferred.push("model")
                yield* Option.match(threadRegistry, {
                  onNone: () => {
                    const lunaHome = process.env["LUNA_HOME"]
                    if (lunaHome !== undefined) {
                      appendThreadConfigEntry(lunaHome, threadId, { model })
                    }
                    return Effect.void
                  },
                  onSome: (reg) =>
                    reg
                      .setConfig(threadId, { model })
                      .pipe(Effect.catchCause(() => Effect.void)),
                })
              } else if (handle !== null) {
                // Same lane + live handle → hot-swap via setModel. Success-
                // gated: a thrown setModel lands in `rejected`, not `applied`,
                // and the unapplied value is not persisted.
                const liveOk = yield* Effect.tryPromise(() => handle.setModel(model)).pipe(
                  Effect.as(true),
                  Effect.catch(() => Effect.succeed(false)),
                )
                if (liveOk) {
                  applied.push("model")
                  // Persist: update both top-level model and sdkOptions.model
                  const existingOpts2 = yield* store.getOptions(threadId)
                  const mergedSdk2 = { ...(existingOpts2?.sdkOptions ?? {}), model }
                  yield* store.setOptions(threadId, { model, sdkOptions: mergedSdk2 }).pipe(
                    Effect.catch(() => Effect.void),
                  )
                  yield* Option.match(threadRegistry, {
                    onNone: () => {
                      const lunaHome = process.env["LUNA_HOME"]
                      if (lunaHome !== undefined) {
                        appendThreadConfigEntry(lunaHome, threadId, { model })
                      }
                      return Effect.void
                    },
                    onSome: (reg) =>
                      reg
                        .setConfig(threadId, { model })
                        .pipe(Effect.catchCause(() => Effect.void)),
                  })
                } else {
                  rejected.push({ field: "model", reason: "live model switch failed" })
                  yield* Effect.logWarning(
                    "[chat] set-thread-config: setModel failed — model not applied",
                  )
                }
              } else {
                // Same lane but no live handle (thread idle) → still accept
                applied.push("model")
                yield* Option.match(threadRegistry, {
                  onNone: () => {
                    const lunaHome = process.env["LUNA_HOME"]
                    if (lunaHome !== undefined) {
                      appendThreadConfigEntry(lunaHome, threadId, { model })
                    }
                    return Effect.void
                  },
                  onSome: (reg) =>
                    reg
                      .setConfig(threadId, { model })
                      .pipe(Effect.catchCause(() => Effect.void)),
                })
              }
            }
          }

          return {
            threadId,
            ...(model !== undefined ? { model } : {}),
            ...(ackEffort !== undefined ? { effort: ackEffort } : {}),
            applied: applied as ReadonlyArray<"model" | "effort">,
            deferred: deferred as ReadonlyArray<"model" | "effort">,
            ...(rejected.length > 0 ? { rejected: rejected as ReadonlyArray<{ readonly field: "model" | "effort"; readonly reason: string }> } : {}),
          }
        })

      /** Subscribe to a thread's live ChatFrame stream. The Stream emits
       *  exactly one `snapshot` frame first (the persisted history) then
       *  pipes through PubSub. Returns an empty Stream for unknown threadIds
       *  so callers don't need to handle the absent case before piping.
       *
       *  The PubSub subscription's Scope is tied to the Stream's own scope
       *  via `Stream.unwrap` — when the consumer terminates the
       *  Stream, the subscription is released. Callers do NOT need a Scope
       *  in their Effect environment. */
      /**
       * Build the one-shot `snapshot` (+ optional suggested-action-set) frames
       * for a live thread without opening a PubSub subscription.
       *
       * Used by `subscribe` (prefix before the live stream) and by
       * `snapshot` (re-emit on an already-subscribed connection so a client
       * that switched away and back can re-paint without dual live fibers).
       */
      const buildSnapshotFrames = (
        threadId: string,
      ): Effect.Effect<ReadonlyArray<ChatFrame>, never> =>
        Effect.gen(function* () {
          // Bounded read — only the most recent `snapshotMessageLimit`
          // messages are loaded to build the snapshot frame (0 = legacy
          // unbounded full-history load). Other readMessages callers
          // (findStoredById, dream's gatherInputs) pass no options and
          // keep full-history semantics.
          const collected = yield* store
            .readMessages(
              threadId,
              snapshotMessageLimit > 0 ? { limit: snapshotMessageLimit } : undefined,
            )
            .pipe(Stream.runCollect, Effect.orDie)
          const stored = Array.from(collected)
          const projected: ChatMessage[] = []
          let throughSeq = -1
          for (const s of stored) {
            const p = projectOne(s)
            if (p !== null) projected.push(p)
            if (s.seq > throughSeq) throughSeq = s.seq
          }
          const snapshotFrame: ChatFrame = {
            type: "snapshot",
            threadId,
            throughSeq,
            messages: projected,
          }

          // Replay-on-open: surface this thread's non-terminal suggested
          // actions (including any Dream proposed while no client was
          // attached) as ONE set frame right after the snapshot. Best-effort
          // — a store error must not break the subscribe / snapshot path.
          const frames: ChatFrame[] = [snapshotFrame]
          yield* Option.match(suggestedActions, {
            onNone: () => Effect.void,
            onSome: (sa) =>
              sa
                .listByThread(threadId, { status: ACTIVE_STATUSES })
                .pipe(
                  Effect.catch(() => Effect.succeed([] as const)),
                  Effect.map((rows) => {
                    if (rows.length > 0) {
                      frames.push({
                        type: "suggested-action-set",
                        threadId,
                        actions: rows.map(toView),
                      })
                    }
                  }),
                ),
          })
          return frames
        })

      /**
       * One-shot snapshot for an already-known thread — no live PubSub
       * subscription. Returns empty array when the thread cannot be
       * recovered (unknown / pruned). Callers (ui-ws re-subscribe) use this
       * to re-paint a client without dual-forking a live forwarder.
       */
      const snapshot = (
        threadId: string,
      ): Effect.Effect<ReadonlyArray<ChatFrame>, never> =>
        Effect.gen(function* () {
          const recovered = yield* ensureThreadLive(threadId)
          if (Option.isNone(recovered)) return [] as ReadonlyArray<ChatFrame>
          return yield* buildSnapshotFrames(threadId)
        })

      const subscribe = (
        threadId: string,
      ): Stream.Stream<ChatFrame, never> =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Cache-miss recovery: the chat-server was restarted (or the idle
            // reaper evicted this thread). ensureThreadLive handles Cases A/B/C
            // with a semaphore-guarded get→create so two concurrent subscribers
            // on the same reaped thread cannot both spawn SDK subprocesses.
            const recovered = yield* ensureThreadLive(threadId)
            if (Option.isNone(recovered)) return Stream.empty as Stream.Stream<ChatFrame, never>
            const entry = recovered.value

            // Subscribe FIRST (PubSub buffers from subscribe-time forward),
            // then read the snapshot, then concat in order. Client dedupes
            // via `seq <= throughSeq` if any frames overlap.
            const liveSub = yield* PubSub.subscribe(entry.pubsub)
            const liveStream = Stream.fromSubscription(liveSub)
            const prefix = yield* buildSnapshotFrames(threadId)

            return Stream.concat(
              Stream.fromIterable(prefix),
              liveStream,
            )
          }),
        )

      /**
       * Read-only sidebar projection. Returns most-recently-active first.
       *
       * The default 'active' projection only surfaces real conversations:
       * empty/probe threads (no top-level user message) and archived threads
       * are dropped in the store query BEFORE the limit (via `hasUserMessage`
       * and `excludeIds`), so a page never under-fills with threads the user
       * never typed in. A hidden empty thread reappears the moment its first
       * user message lands.
       *
       * Phase 3: when status='archived' and ThreadRegistry is wired,
       * returns archived threads from the registry (they may not have
       * SessionStore rows if archived before Phase 2, so the registry
       * is the authoritative list). For the default 'active' case the
       * SessionStore list is used, with per-row title resolution layered
       * on top (the SessionStore title column is write-once at INSERT,
       * so without it every row would project title=null): SessionStore
       * title wins, else the ThreadRegistry title (first-turn heuristic),
       * else derive-on-read from the first user message, persisted back
       * via setTitleIfNull so legacy threads are derived exactly once.
       */
      const listThreads = (
        limit = 50,
        status?: "active" | "archived",
      ): Effect.Effect<ReadonlyArray<SessionSummary>, never> => {
        // PR2: one involvement fetch per list call, mapped threadId → agent
        // names (most-recently-involved first — listInvolvement's order).
        // Best-effort: an involvement failure degrades to "no filter data",
        // never a broken sidebar.
        const involvementMap = (
          reg: Context.Service.Shape<typeof ThreadRegistryService>,
        ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>, never> =>
          reg.listInvolvement().pipe(
            Effect.map((rows) => {
              const m = new Map<string, string[]>()
              for (const r of rows) {
                const bucket = m.get(r.threadId)
                if (bucket) bucket.push(r.agentName)
                else m.set(r.threadId, [r.agentName])
              }
              return m
            }),
            Effect.catchCause(() =>
              Effect.succeed(new Map<string, ReadonlyArray<string>>()),
            ),
          )
        const attachInvolvement = (
          s: SessionSummary,
          m: ReadonlyMap<string, ReadonlyArray<string>>,
        ): SessionSummary => {
          const names = m.get(s.id)
          return names && names.length > 0 ? { ...s, involvedAgents: names } : s
        }

        // For archived threads, pull from ThreadRegistry (it owns status).
        if (status === "archived" && Option.isSome(threadRegistry)) {
          return Effect.all([
            threadRegistry.value.listByStatus("archived"),
            involvementMap(threadRegistry.value),
          ]).pipe(
            Effect.map(([rows, inv]) =>
              rows.slice(0, limit).map((r) => attachInvolvement({
                id: r.id,
                parentId: null,
                title: r.title,
                tags: [],
                createdAt: r.createdAt,
                endedAt: r.archivedAt,
                model: r.model ?? "unknown",
                status: "closed" as const,
                lastMessageAt: r.lastActiveAt,
                lastMessagePreview: null,
                // Agent sidebar S2: archived threads keep their section —
                // the registry row is the only source for these (some
                // archived threads have no SessionStore row at all).
                ...(r.agentName != null ? { agentName: r.agentName } : {}),
              }, inv)),
            ),
          )
        }
        // Default: active threads from SessionStore, filtered by ThreadRegistry
        // status when the registry is wired. Archived threads must NOT appear in
        // the default (active) sidebar — they are only returned when status='archived'.
        // Best-effort: if registry is absent, fall through without filtering.
        // Empty/probe threads (spawned but never typed in) are excluded at the
        // store BEFORE the limit via `hasUserMessage` - otherwise recent probes,
        // which sort by createdAt, crowd the top `limit` slots and evict real
        // conversations that would then never be fetched. A real sidebar thread
        // is one with at least one top-level user message; a thread is not a
        // conversation until the user types, so even explicitly-titled empties
        // are hidden. Archived threads are excluded the same way via
        // `excludeIds` - filtering them here (before the limit) rather than
        // post-filtering the limited page keeps the page from under-filling
        // when archived threads land in the top `limit` slots.
        const listActive = (
          excludeIds: ReadonlyArray<string>,
        ): Effect.Effect<ReadonlyArray<SessionSummary>, never> =>
          store
            .list({ orderBy: "lastMessageAt", limit, hasUserMessage: true, excludeIds })
            .pipe(Stream.runCollect)
        // Resolve a display title for each (already-real) row. Preference order:
        //   1. the SessionStore title (explicitly set at creation);
        //   2. the ThreadRegistry title (first-turn heuristic, Phase 3);
        //   3. derive-on-read from the first user message (threads predating the
        //      heuristic), persisted back to the registry so it runs once.
        // Every listed session is guaranteed to have a first top-level user
        // message (the store filtered on it), so the derive path always has raw
        // text to work from. The stored payload carries the client-identity
        // marker prepended at ingest, which the first-turn path never saw -
        // strip it so both derive paths agree. readFirstUserMessage is a bounded
        // LIMIT-1 query (never materializes the whole log), so it is cheap.
        const resolveTitles = (
          sessions: ReadonlyArray<SessionSummary>,
          regTitles: ReadonlyMap<string, string | null>,
          persist: ((id: string, title: string) => Effect.Effect<void, never>) | null,
        ): Effect.Effect<ReadonlyArray<SessionSummary>, never> =>
          Effect.forEach(
            sessions,
            (s): Effect.Effect<SessionSummary, never> => {
              if (s.title !== null && s.title !== "") return Effect.succeed(s)
              const regTitle = regTitles.get(s.id)
              if (regTitle) return Effect.succeed({ ...s, title: regTitle })
              // catchCause (not catch): readFirstUserMessage/rowToMessage
              // do a JSON.parse in Effect.sync, so a corrupt content_json is a
              // DEFECT, not a typed failure. catch misses defects — one bad
              // row would then abort the whole forEach and brick the sidebar
              // list. catchCause degrades that row to "untitled" instead.
              return store.readFirstUserMessage(s.id).pipe(
                Effect.catchCause(() => Effect.succeed(null)),
                Effect.flatMap((first): Effect.Effect<SessionSummary, never> => {
                  const text = first ? extractText(first.payload) : null
                  const derived = text
                    ? deriveTitleFromMessage(stripClientMarker(text))
                    : null
                  const persistEff =
                    derived && persist ? persist(s.id, derived) : Effect.void
                  return persistEff.pipe(
                    Effect.as(derived ? { ...s, title: derived } : s),
                  )
                }),
              )
            },
            { concurrency: 4 },
          )
        if (Option.isNone(threadRegistry)) {
          return listActive([]).pipe(
            Effect.flatMap((sessions) => resolveTitles(sessions, new Map(), null)),
          )
        }
        const reg = threadRegistry.value
        return Effect.gen(function* () {
          // Archived ids must resolve BEFORE the store list so they can be
          // excluded in-query (before the limit). The active-titles fetch has
          // no such dependency, so it still runs in parallel with store.list.
          // Archived exclusion is now the ONLY gate (in-query, before the
          // limit) — so treating an archive-read failure as "no archived
          // threads" would leak EVERY archived thread back into the active
          // sidebar. Fall back to deriving the archived set from the full
          // registry list; only if THAT also fails do we accept an empty set
          // (transient over-inclusion) rather than fail the whole sidebar.
          const archivedRows = yield* reg.listByStatus("archived").pipe(
            Effect.map((rows) => rows.map((r) => ({ id: r.id }))),
            Effect.catchCause(() =>
              reg.list().pipe(
                Effect.map((all) =>
                  all.filter((r) => r.status === "archived").map((r) => ({ id: r.id })),
                ),
                Effect.catchCause(() =>
                  Effect.succeed([] as ReadonlyArray<{ readonly id: string }>),
                ),
              ),
            ),
          )
          const archivedIds = new Set(archivedRows.map((r) => r.id))
          const [sessions, activeRows, inv] = yield* Effect.all([
            listActive([...archivedIds]),
            reg.listByStatus("active").pipe(
              Effect.catchCause(() =>
                Effect.succeed(
                  [] as readonly {
                    readonly id: string
                    readonly title: string | null
                    readonly agentName?: string | null
                  }[],
                ),
              ),
            ),
            involvementMap(reg),
          ])
          const regTitles = new Map(activeRows.map((r) => [r.id, r.title]))
          // Agent sidebar S2: section membership, layered onto the store
          // summaries the same way titles are — the registry is the only
          // holder of agent_name (write-once at INSERT).
          const regAgents = new Map(
            activeRows.map((r) => [r.id, r.agentName ?? null]),
          )
          // Persist derived titles so legacy threads are derived exactly once.
          // setTitleIfNull is clock-neutral: listing the sidebar is a read, so it
          // must never bump last_active_at (that would reset the 14-day
          // auto-archive idle clock for exactly the stale threads it retires).
          // It also never inserts and never changes archival status.
          const persist = (id: string, title: string) =>
            reg
              .setTitleIfNull(id, title)
              .pipe(Effect.asVoid, Effect.catchCause(() => Effect.void))
          const titled = yield* resolveTitles(sessions, regTitles, persist)
          return titled.map((s) => {
            const agentName = regAgents.get(s.id)
            const withAgent = agentName != null ? { ...s, agentName } : s
            return attachInvolvement(withAgent, inv)
          })
        })
      }

      /** Close a thread permanently (stop button + delete from sidebar).
       *  Closes the per-thread Scope which interrupts the SDK subprocess
       *  and removes the entry from the threads map (via the finalizer). */
      const closeThread = (threadId: string): Effect.Effect<void, never> =>
        Effect.gen(function* () {
          const m = yield* Ref.get(threads)
          const entry = m.get(threadId)
          if (!entry) return
          yield* Scope.close(entry.scope, Exit.void)
          yield* store
            .setStatus(threadId, "closed", yield* clock.nowMs())
            .pipe(Effect.catch(() => Effect.void))
        })

      /** Release a thread's RUNTIME only: close its scope (which interrupts the
       *  SDK subprocess + drops it from the threads map) WITHOUT marking the
       *  thread "closed" in the store. Unlike `closeThread`, the thread stays a
       *  normal, resumable session — `subscribe`'s cache-miss path (Case A)
       *  transparently re-creates it via `resumeFromSessionId` on the next open.
       *  The thread's ChatFrame PubSub lives in the persistent `pubsubs` map,
       *  not the scope, so subscribers attached before the release keep
       *  receiving frames after the resume.
       *  This is what the idle reaper uses to reclaim leaked subprocesses. */
      const releaseThreadRuntime = (
        threadId: string,
      ): Effect.Effect<void, never> =>
        Effect.gen(function* () {
          const m = yield* Ref.get(threads)
          const entry = m.get(threadId)
          if (!entry) return
          yield* Scope.close(entry.scope, Exit.void)
        })

      /** Read-only memory search delegating to the wired MemoryRouter.
       *  Errors are tagged in the result rather than failing the Effect,
       *  so the WS handler can pattern-match cleanly. */
      const searchMemory = (args: {
        readonly queryText: string
        readonly topK?: number
      }): Effect.Effect<
        | { readonly hits: ReadonlyArray<{ id: string; kind: string; content: string; score: number }> }
        | { readonly error: { readonly message: string; readonly kind: "no-vector-backend" | "internal" } },
        never
      > =>
        Effect.gen(function* () {
          const collect = Stream.runCollect(
            memoryRouter.search({ queryText: args.queryText, topK: args.topK ?? 10 }),
          )
          const outcome = yield* Effect.result(collect)
          if (outcome._tag === "Failure") {
            const err = outcome.failure
            // MemoryBackendError carries the underlying cause. Extract the
            // message by checking cause first (the real discriminating text
            // lives in cause.message), then fall back to err.message / String.
            const causeMsg =
              typeof (err as { cause?: unknown }).cause === "object" &&
              (err as { cause?: { message?: string } }).cause !== null
                ? (err as { cause?: { message?: string } }).cause?.message
                : typeof (err as { cause?: unknown }).cause === "string"
                ? (err as { cause: string }).cause
                : undefined
            const msg = causeMsg ?? (err instanceof Error ? err.message : String(err))
            const kind: "no-vector-backend" | "internal" = msg.includes("no vector backends")
              ? "no-vector-backend"
              : "internal"
            return { error: { message: msg, kind } }
          }
          const hits = Array.from(outcome.success).map(({ record, score }) => ({
            id: record.id,
            kind: record.kind,
            content:
              typeof record.content === "string"
                ? record.content
                : JSON.stringify(record.content),
            score,
          }))
          return { hits }
        })

      /**
       * Phase 3: Archive a thread (active->archived). NEVER deletes the row or
       * SDK jsonl — archive is a reversible status flip.
       * Returns true if the thread exists in the ThreadRegistry; false otherwise.
       * Best-effort: if ThreadRegistry is not wired, returns false.
       */
      const archiveThread = (threadId: string): Effect.Effect<boolean, never> =>
        Option.match(threadRegistry, {
          onNone: () => Effect.succeed(false),
          onSome: (reg) =>
            reg.archive(threadId).pipe(Effect.catchCause(() => Effect.succeed(false))),
        })

      /**
       * Phase 3: Unarchive a thread (archived->active). Clears archived_at.
       * Returns true if the thread exists; false otherwise.
       */
      const unarchiveThread = (threadId: string): Effect.Effect<boolean, never> =>
        Option.match(threadRegistry, {
          onNone: () => Effect.succeed(false),
          onSome: (reg) =>
            reg.unarchive(threadId).pipe(Effect.catchCause(() => Effect.succeed(false))),
        })

      // ── Idle-thread reaper ────────────────────────────────────────────────
      // Each live thread pins one `claude` subprocess to its threadScope. Until
      // now the only thing that closed a threadScope was full server shutdown,
      // so every thread leaked a subprocess that lived until `systemctl restart`
      // (observed: 45 orphaned `claude` procs after 3 days). The reaper releases
      // the runtime of any thread idle past LUNA_CHAT_THREAD_IDLE_MS (default
      // 30min; 0 disables) with no in-flight turn. Non-destructive: subscribe()'s
      // cache-miss path resumes the thread on next open.
      const idleReapMs: number = parseIdleReapMs(
        process.env["LUNA_CHAT_THREAD_IDLE_MS"],
      )

      /** Release every thread idle past the window (no in-flight turn). Returns
       *  the count reaped. Exposed so tests can drive a sweep deterministically
       *  instead of waiting on the background fiber's timer. */
      const reapIdleThreadsOnce = (): Effect.Effect<number, never> =>
        Effect.gen(function* () {
          if (idleReapMs <= 0) return 0
          const now = yield* clock.nowMs()
          const snapshot = yield* Ref.get(threads)
          let reaped = 0
          for (const [tid, e] of snapshot) {
            const inFlightTurnId = yield* Ref.get(e.inFlightTurnId)
            const last = yield* Ref.get(e.lastActivity)
            if (
              !isThreadIdleReapable({ now, lastActivity: last, inFlightTurnId, idleReapMs })
            )
              continue
            yield* Effect.logInfo("[chat] reaping idle thread", {
              threadId: tid,
              idleMs: now - last,
            })
            yield* inc("luna.chat.threads.reaped_idle")
            yield* releaseThreadRuntime(tid)
            reaped++
          }
          return reaped
        })

      // Arm the background sweep (skipped when disabled). Forked into the
      // service scope so it lives for the server's lifetime and is interrupted
      // cleanly on shutdown.
      if (idleReapMs > 0) {
        const sweepMs = Math.max(15_000, Math.min(idleReapMs, 60_000))
        yield* Effect.logInfo("[chat] idle-thread reaper armed", {
          idleReapMs,
          sweepMs,
        })
        yield* Effect.sleep(sweepMs).pipe(
          Effect.andThen(reapIdleThreadsOnce()),
          Effect.asVoid,
          Effect.forever,
          Effect.forkIn(serviceScope),
        )
      }

      return {
        createThread,
        send,
        deliverResult,
        interrupt,
        setThreadConfig,
        subscribe,
        /** One-shot snapshot without a live PubSub sub (re-paint on re-entry). */
        snapshot,
        listThreads,
        searchMemory,
        closeThread,
        reapIdleThreadsOnce,
        archiveThread,
        unarchiveThread,
        /** Cross-thread background-delivery notifications (#124). The WS layer
         *  runs this once at boot and broadcasts each item to all clients. */
        deliveries: Stream.fromPubSub(deliveriesHub),
      } as const
})

export class ChatService extends Context.Service<
  ChatService,
  Effect.Success<typeof makeChatService>
>()("luna/ChatService") {
  static readonly Default = Layer.effect(ChatService, makeChatService)
}

/** Re-export the chat-shaped projection helper from core for downstream
 *  consumers (ui-ws server, Tauri shell) that don't otherwise pull core. */
export { projectChatMessages, projectOne } from "@luna/core"

/** Re-exports so the public API is unchanged after the module split: these
 *  symbols used to be defined directly in this file. */
export { ThreadToolsProviderTag } from "./chat-service-tools.js"
export {
  normalizeToolResultContent,
  truncateOutput,
  formatStreamFailureReason,
} from "./chat-service-sdk-messages.js"
export { withTurnMemoryContext } from "./chat-service-thread-lifecycle.js"
