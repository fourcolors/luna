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
 *   - pubsub: PubSub<ChatFrame>       — the wire-shape fan-out
 *   - scope: Scope.CloseableScope     — the per-thread sub-scope; closing it
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
 */
import {
  Chunk,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect"
import {
  SessionStore,
  Clock as CoreClock,
  ObservabilityService,
  TelemetryService,
  projectChatMessages,
  projectOne,
  type ChatMessage,
  type SessionSummary,
  type SessionOptions,
  type StoredMessage,
} from "@luna/core"
import { SDKAdapter } from "@luna/adapter-sdk"
import { MemoryRouterTag } from "@luna/memory"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  type ChatFrame,
  type ChatErrorKind,
  type CreateThreadOptions,
  type ThreadToolsProvider,
} from "./types.js"
import { extractArtifacts } from "./artifacts.js"
import {
  appendThreadSessionEntry,
  loadThreadSessionMap,
} from "./thread-session-map.js"

/* -------------------------------------------------------------------------- */
/* Internal per-thread state                                                  */
/* -------------------------------------------------------------------------- */

interface ThreadEntry {
  readonly inbox: Queue.Queue<SDKUserMessage>
  readonly pubsub: PubSub.PubSub<ChatFrame>
  readonly scope: Scope.CloseableScope
  /** Stable turn id of the in-flight assistant turn, or null if idle. */
  readonly inFlightTurnId: Ref.Ref<string | null>
  /** Cumulative assistant text within the in-flight turn (for delta snapshots). */
  readonly inFlightText: Ref.Ref<string>
}

/* -------------------------------------------------------------------------- */
/* SDK message shape probes (kept narrow — adapter is SDK source-of-truth).   */
/* -------------------------------------------------------------------------- */

const isObj = (v: unknown): v is Record<string, unknown> =>
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
import { applyClientMarker, type ClientMarkerInput } from "./client-marker.js"

/** Re-exported for callers that want the same shape. */
export type ClientHint = ClientMarkerInput

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

const LUNA_ALLOWED_MCP_TOOLS = [
  "mcp__memory__*",
  "mcp__scheduler__*",
  "mcp__observability__*",
  "mcp__local_shell__*",
  "mcp__secret_tools__*",
] as const

/**
 * Optional injection point for per-thread tool wiring. When provided, the
 * app supplies MCP servers + a merged system prompt + a post-create binding
 * callback that ChatService applies to EVERY thread creation. Resolved via
 * `Effect.serviceOption`, so omitting it leaves ChatService's prior
 * tool-free behavior intact (and existing consumers/tests need no change).
 *
 * This exists because tool wiring used to be an app-level wrapper around the
 * public `createThread`, which the internal subscribe()-restart-recovery
 * path bypassed — leaving resumed threads with `allowedTools` set but zero
 * MCP servers. Wiring at the service seam covers both paths.
 */
export const ThreadToolsProviderTag = Context.GenericTag<ThreadToolsProvider>(
  "luna/ThreadToolsProvider",
)

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

export class ChatService extends Effect.Service<ChatService>()(
  "luna/ChatService",
  {
    scoped: Effect.gen(function* () {
      const store = yield* SessionStore
      const adapter = yield* SDKAdapter
      const clock = yield* CoreClock
      const obs = yield* ObservabilityService
      const tel = yield* TelemetryService
      const memoryRouter = yield* MemoryRouterTag
      // Optional — when the app provides it, EVERY thread (new or resumed)
      // gets its MCP servers + merged system prompt + post-create binding.
      // Omitted in tests/headless that don't need tools.
      const threadToolsProvider = yield* Effect.serviceOption(
        ThreadToolsProviderTag,
      )
      const serviceScope = yield* Effect.scope

      const threads = yield* Ref.make<ReadonlyMap<string, ThreadEntry>>(new Map())

      const inc = (
        name: string,
        tags: Readonly<Record<string, string>> = {},
        n = 1,
      ): Effect.Effect<void, never> =>
        tel.inc(name, tags, n).pipe(Effect.catchAllCause(() => Effect.void))

      /** Generate a thread/session id. Format `thr_<base36 ts>_<rand>`. */
      const genThreadId = (): Effect.Effect<string> =>
        Effect.gen(function* () {
          const ts = yield* clock.nowMs()
          const r = Math.random().toString(36).slice(2, 8)
          return `thr_${ts.toString(36)}_${r}`
        })

      /**
       * Build the SessionOptions ChatService uses for every thread. Forces
       * `disableIdleTimeout: true` and `includePartialMessages: true` (the
       * caller can't override these — they are required for chat UX).
       */
      const buildSessionOptions = (
        opts: CreateThreadOptions,
      ): SessionOptions => {
        // Trusted-local default: when LUNA_TRUSTED_LOCAL=1, threads run with
        // bypassPermissions (no canUseTool prompts). Operator sets this in
        // his shell once. Without the env var, mode stays at SDK default
        // ("default" — prompts via canUseTool) so deployed configs cannot
        // accidentally inherit bypass.
        const defaultPermissionMode =
          process.env["LUNA_TRUSTED_LOCAL"] === "1"
            ? "bypassPermissions"
            : "default"
        const pathToClaudeCodeExecutable =
          process.env["LUNA_CLAUDE_CODE_EXECUTABLE"]?.trim()
        const sdkEnv: Record<string, string | undefined> = {
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          ...(process.env["CLAUDE_CONFIG_DIR"]?.trim()
            ? { CLAUDE_CONFIG_DIR: process.env["CLAUDE_CONFIG_DIR"] }
            : {}),
        }
        const sdkOptions: Record<string, unknown> = {
          includePartialMessages: true,
          // GAP#3: the SDK adapter routes by `sdkOptions.model` (the broker reads
          // it for provider selection AND the SDK uses it as the model). The
          // top-level `SessionOptions.model` below is consumed only by
          // merge-policy + session-service.fork() — it never reaches the SDK
          // call. Without this slot a caller-supplied model is silently dropped
          // and every thread routes to the broker's default (anthropic).
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          cwd:
            opts.cwd ??
            process.env["LUNA_REPO_ROOT"] ??
            process.cwd(),
          ...(pathToClaudeCodeExecutable
            ? { pathToClaudeCodeExecutable }
            : {}),
          // SDK isolation: Luna supplies identity, tools, and memory
          // programmatically. Do not inherit Claude Code filesystem settings
          // unless a caller explicitly opts in for a thread.
          settingSources: opts.settingSources ?? [],
          // Availability, not permission: `allowedTools` only pre-approves
          // calls. `tools: []` removes Claude Code built-ins (Task, WebFetch,
          // TodoWrite, Bash, etc.) while leaving Luna's MCP tools available.
          tools: [],
          // MCP tools still need SDK permission approval. Luna's own tool
          // handlers enforce their safety rules, so the SDK layer can
          // auto-approve these without reintroducing Claude Code built-ins.
          allowedTools: [...LUNA_ALLOWED_MCP_TOOLS],
          strictMcpConfig: true,
          env: sdkEnv,
          // SDK subprocess stderr → parent process stderr → journalctl.
          // Without this, the SDK's stderr was being routed to /dev/null,
          // so expired-OAuth retry-loops, network failures, and any
          // SDK-side error were invisible to operators. The callback
          // contract per @anthropic-ai/claude-agent-sdk v0.2.119 is
          // synchronous and chunk-string. Tag the prefix so operators can
          // grep journalctl for `[claude-sdk]` to isolate subprocess output.
          stderr: (data: string) => {
            process.stderr.write(`[claude-sdk] ${data}`)
          },
          permissionMode: opts.permissionMode ?? defaultPermissionMode,
          // Identity: forward caller-supplied systemPrompt INSIDE sdkOptions
          // so the SDK adapter actually sees it. The top-level
          // `SessionOptions.systemPrompt` field below is consumed only by
          // the merge-policy + session-service.fork() machinery — the
          // adapter feeds `sessionOptions.sdkOptions` (not the top-level
          // fields) into the SDK call. Without this slot, a caller-supplied
          // systemPrompt is silently dropped before reaching Claude.
          // DESIGN.md §2.1.5 (unified `systemPrompt` field on SDK Options).
          // Follow-up (Option B): accept full SystemPromptSpec shape
          // (string | string[] | preset) and reconcile the top-level
          // `SessionOptions.systemPrompt` typing in core/session/types.ts.
          ...(opts.systemPrompt !== undefined
            ? { systemPrompt: opts.systemPrompt }
            : {}),
          // Phase 30: forward caller-supplied MCP server registrations
          // through to the SDK. Values are opaque to chat-service — the
          // SDK adapter is the authority on shape.
          ...(opts.mcpServers !== undefined
            ? { mcpServers: opts.mcpServers }
            : {}),
        }
        return {
          model: opts.model,
          disableIdleTimeout: true,
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
          // Top-level systemPrompt mirror: retained for the merge-policy
          // (`replace`) + session-service.fork() child-override carry-over
          // consumers. The actual SDK plumbing happens via
          // sdkOptions.systemPrompt set above.
          ...(opts.systemPrompt !== undefined
            ? { systemPrompt: opts.systemPrompt }
            : {}),
          sdkOptions,
        }
      }

      /**
       * Spin up a thread: create the session row, allocate inbox + pubsub,
       * fork the adapter.query consumer into the thread's own sub-scope so
       * we can interrupt JUST this thread without touching others.
       */
      const createThread = (
        opts: CreateThreadOptions,
      ): Effect.Effect<SessionSummary, never> =>
        Effect.gen(function* () {
          const id = opts.threadIdOverride ?? (yield* genThreadId())
          const createdAt = yield* clock.nowMs()

          // Per-thread tool wiring. When the app provided a
          // ThreadToolsProvider, decorate THIS thread's options with its MCP
          // servers + merged system prompt before building sessionOptions.
          // Because this lives in the internal createThread, both new threads
          // and subscribe()-recovery (resume) threads get tools — the bug
          // was that tool wiring used to live in an app wrapper the resume
          // path bypassed.
          const binding = Option.map(threadToolsProvider, (p) =>
            p.decorate(opts),
          )
          const effectiveOpts: CreateThreadOptions = Option.match(binding, {
            onNone: () => opts,
            onSome: (b) => ({
              ...opts,
              mcpServers: { ...(opts.mcpServers ?? {}), ...b.mcpServers },
              ...(b.systemPrompt !== undefined
                ? { systemPrompt: b.systemPrompt }
                : {}),
            }),
          })
          const sessionOptions = buildSessionOptions(effectiveOpts)

          // Create the session row first — fail loudly if id collides.
          const summary = yield* store
            .create({ id, options: sessionOptions, createdAt })
            .pipe(Effect.orDie)

          // Session row exists → run the provider's post-create binding
          // (obs session tagging, local-shell attach, sandbox re-attach)
          // BEFORE the SDK query starts so tool servers know their session.
          Option.match(binding, {
            onNone: () => {},
            onSome: (b) => b.onBound(id),
          })

          // Emit SessionStart so the obs Events tab shows activity.
          yield* obs.emit({
            kind: "SessionStart",
            ts: new Date().toISOString(),
            level: "info",
            sessionId: id,
            model: opts.model ?? "unknown",
            ...(opts.parentSessionId !== undefined ? { parentId: opts.parentSessionId } : {}),
            ...(opts.tags !== undefined && opts.tags.length > 0 ? { tags: [...opts.tags] } : {}),
            ...(opts.title !== undefined ? { title: opts.title } : {}),
          })
          yield* inc("luna.chat.threads.created", {
            model: opts.model ?? "unknown",
          })

          const inbox = yield* Queue.unbounded<SDKUserMessage>()
          const pubsub = yield* PubSub.unbounded<ChatFrame>()
          const inFlightTurnId = yield* Ref.make<string | null>(null)
          const inFlightText = yield* Ref.make<string>("")

          // Per-thread sub-scope. `Scope.fork` makes a child that we can
          // close independently of the service scope. The service scope
          // still owns it transitively, so a service shutdown closes
          // everything via LIFO finalizers.
          const threadScope = yield* Scope.fork(
            serviceScope,
            // ParallelFinalizers — siblings finalize concurrently.
            { _tag: "Parallel" },
          )

          const promptStream: Stream.Stream<SDKUserMessage> =
            Stream.fromQueue(inbox)

          // When LUNA_HOME is set, persist `lunaThreadId → sdkSessionId` so a
          // chat-server restart can resume this thread via the SDK's
          // resume option (the SDK keeps conversation history per
          // sdkSessionId in JSONL files on disk).
          const lunaHome = process.env["LUNA_HOME"]
          const recordSdkSession: ((sdkSid: string) => void) | undefined =
            lunaHome !== undefined
              ? (sdkSid) => {
                  try {
                    appendThreadSessionEntry(lunaHome, id, sdkSid)
                  } catch {
                    // Best-effort persistence — must not break live chat.
                  }
                }
              : undefined

          // The adapter.query call is provided with the thread scope so its
          // AbortController + watchdog tear down when we close threadScope.
          const replies: Stream.Stream<SDKMessage, unknown> = yield* adapter
            .query({
              sessionId: id,
              prompt: promptStream,
              sessionOptions,
              // §0.2 sticky-pin: forward boundAccountId so WithBroker can
              // route this thread's queries to the caller-selected account.
              ...(opts.boundAccountId !== undefined
                ? { boundAccountId: opts.boundAccountId }
                : {}),
              ...(recordSdkSession !== undefined
                ? { onSdkSessionId: recordSdkSession }
                : {}),
              ...(opts.resumeFromSessionId !== undefined
                ? { resumeFromSessionId: opts.resumeFromSessionId }
                : {}),
              // §12.2 #2: the adapter mirrors every message to SessionStore
              // (the authoritative log). A write failure must not kill the
              // turn, but it must be OBSERVABLE — surface it on the obs stream
              // (Events tab) + a telemetry counter, not just the logger.
              onMirrorError: (_msg, cause) =>
                Effect.gen(function* () {
                  yield* inc("luna.chat.mirror_failures.total")
                  yield* obs.emit({
                    kind: "Error",
                    ts: new Date().toISOString(),
                    level: "error",
                    errorTag: "ChatMirrorAppendFailed",
                    message: `SessionStore mirror append failed: ${String(cause).slice(0, 200)}`,
                    context: { threadId: id },
                  })
                }).pipe(Effect.catchAllCause(() => Effect.void)),
            })
            .pipe(Scope.extend(threadScope), Effect.orDie)

          // Consumer: walk the reply Stream, push ChatFrames into the
          // per-thread PubSub. Runs forever (until threadScope closes or
          // the Stream errors out). Forked into the thread scope so it
          // tears down with the thread.
          yield* replies.pipe(
            Stream.runForEach((msg) =>
              handleSdkMessage({
                threadId: id,
                msg,
                pubsub,
                inFlightTurnId,
                inFlightText,
              }),
            ),
            Effect.catchAllCause((cause) => {
              const message = `adapter stream failed: ${cause.toString().slice(0, 200)}`
              return Effect.gen(function* () {
                yield* inc("luna.chat.adapter_stream.errors")
                yield* obs.emit({
                  kind: "Error",
                  ts: new Date().toISOString(),
                  level: "error",
                  errorTag: "ChatAdapterStreamFailed",
                  message,
                  context: { threadId: id },
                })
                yield* PubSub.publish(pubsub, {
                  type: "assistant-error",
                  threadId: id,
                  turnId: null,
                  error: {
                    kind: "sdk",
                    message,
                  },
                })
              })
            }),
            Effect.forkIn(threadScope),
          )

          // Track the entry. Removed from the map when the scope closes —
          // we add a finalizer that splices it out.
          const entry: ThreadEntry = {
            inbox,
            pubsub,
            scope: threadScope,
            inFlightTurnId,
            inFlightText,
          }
          yield* Ref.update(threads, (m) => {
            const next = new Map(m)
            next.set(id, entry)
            return next
          })
          yield* Scope.addFinalizer(
            threadScope,
            Ref.update(threads, (m) => {
              const next = new Map(m)
              next.delete(id)
              return next
            }),
          )

          return summary
        })

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
      }): Effect.Effect<void, never> =>
        Effect.gen(function* () {
          const t = (args.msg as { type?: string }).type
          if (t === "stream_event") {
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
                })
              }
            }
            return
          }
          // system / hook / status / stream_event-other
          // — not surfaced as chat frames or obs events.
        })

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
              const arr = Chunk.toReadonlyArray(chunk)
              for (let i = arr.length - 1; i >= 0; i--) {
                if (arr[i]!.id === messageId) return arr[i]!
              }
              return null
            }),
            Effect.catchAll(() => Effect.succeed(null as StoredMessage | null)),
          )

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
          const m = yield* Ref.get(threads)
          const entry = m.get(threadId)
          if (!entry) {
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
            return Option.none<ChatMessage>()
          }

          const ts = yield* clock.nowMs()
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
            .pipe(Effect.catchAll(() => Effect.succeed(null as StoredMessage | null)))
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

          // Offer is fire-and-forget; if the queue was shutdown (thread
          // closed mid-send), we silently drop.
          yield* Queue.offer(entry.inbox, userPayload).pipe(
            Effect.catchAllCause(() => Effect.void),
          )

          return projected !== null
            ? Option.some(projected)
            : Option.none<ChatMessage>()
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
            Effect.catchAll(() => Effect.void),
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
          yield* inc("luna.chat.interrupts.total")
        })

      /** Subscribe to a thread's live ChatFrame stream. The Stream emits
       *  exactly one `snapshot` frame first (the persisted history) then
       *  pipes through PubSub. Returns an empty Stream for unknown threadIds
       *  so callers don't need to handle the absent case before piping.
       *
       *  The PubSub subscription's Scope is tied to the Stream's own scope
       *  via `Stream.unwrapScoped` — when the consumer terminates the
       *  Stream, the subscription is released. Callers do NOT need a Scope
       *  in their Effect environment. */
      const subscribe = (
        threadId: string,
      ): Stream.Stream<ChatFrame, never> =>
        Stream.unwrapScoped(
          Effect.gen(function* () {
            const m = yield* Ref.get(threads)
            let entry = m.get(threadId)
            if (!entry) {
              // Cache-miss recovery: if the chat-server was restarted and
              // wiped its in-memory threads map, but the persisted
              // thread-session-map remembers this threadId's SDK session
              // id, transparently re-create the thread with the SDK's
              // resume flag set. The model retains conversation context
              // via the SDK's JSONL backing; the visual snapshot will be
              // empty until new messages arrive.
              const lunaHome = process.env["LUNA_HOME"]
              const persistedSdkId =
                lunaHome !== undefined
                  ? loadThreadSessionMap(lunaHome)[threadId]
                  : undefined
              if (persistedSdkId !== undefined) {
                yield* createThread({
                  model: "claude-sonnet-4-5",
                  threadIdOverride: threadId,
                  resumeFromSessionId: persistedSdkId,
                })
                const m2 = yield* Ref.get(threads)
                entry = m2.get(threadId)
              }
            }
            if (!entry) return Stream.empty as Stream.Stream<ChatFrame, never>

            // Subscribe FIRST (PubSub buffers from subscribe-time forward),
            // then read the snapshot, then concat in order. Client dedupes
            // via `seq <= throughSeq` if any frames overlap.
            const liveQueue = yield* PubSub.subscribe(entry.pubsub)
            const liveStream = Stream.fromQueue(liveQueue)

            const collected = yield* store
              .readMessages(threadId)
              .pipe(Stream.runCollect, Effect.orDie)
            const stored = Array.from(Chunk.toReadonlyArray(collected))
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
            return Stream.concat(Stream.make(snapshotFrame), liveStream)
          }),
        )

      /** Read-only sidebar projection. Returns most-recently-active first. */
      const listThreads = (limit = 50): Effect.Effect<
        ReadonlyArray<SessionSummary>,
        never
      > =>
        store
          .list({ orderBy: "lastMessageAt", limit })
          .pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray))

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
            .pipe(Effect.catchAll(() => Effect.void))
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
          const either = yield* Effect.either(collect)
          if (either._tag === "Left") {
            const err = either.left
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
          const hits = Array.from(either.right).map(({ record, score }) => ({
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

      return {
        createThread,
        send,
        interrupt,
        subscribe,
        listThreads,
        searchMemory,
        closeThread,
      } as const
    }),
  },
) {}

/** Re-export the chat-shaped projection helper from core for downstream
 *  consumers (ui-ws server, Tauri shell) that don't otherwise pull core. */
export { projectChatMessages, projectOne } from "@luna/core"
