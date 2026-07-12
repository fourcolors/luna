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
  Cause,
  Chunk,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Runtime,
  Scope,
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
  type DeliveryNotification,
  type ThreadToolsProvider,
} from "./types.js"
import { extractArtifacts } from "./artifacts.js"
import {
  appendThreadSessionEntry,
  appendThreadConfigEntry,
  loadThreadSessionMap,
} from "./thread-session-map.js"
import {
  clampEffort,
  defaultEffortForModel,
  isEffort,
  isEffortOption,
  isUltracode,
  modelSupportsUltracode,
  ultracodeFlagSettings,
  ULTRACODE,
  type EffortLevel,
  type EffortOption,
} from "./effort.js"
import {
  resolveKind,
  readProviderEnv,
} from "@luna/core"

/* -------------------------------------------------------------------------- */
/* Internal per-thread state                                                  */
/* -------------------------------------------------------------------------- */

interface ThreadEntry {
  readonly inbox: Queue.Queue<SDKUserMessage>
  /** Wire-shape ChatFrame fan-out. NOT owned by this entry or its scope: it is
   *  a borrowed reference into the persistent per-thread-id `pubsubs` map, so
   *  subscriptions taken before an idle reap keep receiving frames after the
   *  thread is re-created. Never shut it down when the entry dies. */
  readonly pubsub: PubSub.PubSub<ChatFrame>
  readonly scope: Scope.CloseableScope
  /** Stable turn id of the in-flight assistant turn, or null if idle. */
  readonly inFlightTurnId: Ref.Ref<string | null>
  /** Cumulative assistant text within the in-flight turn (for delta snapshots). */
  readonly inFlightText: Ref.Ref<string>
  /** Epoch ms of the last activity (user send or any SDK message). Drives the
   *  idle reaper that releases the thread's `claude` subprocess after a quiet
   *  period — see the reaper near the service tail. */
  readonly lastActivity: Ref.Ref<number>
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

/* -------------------------------------------------------------------------- */
/* SDK message shape probes (kept narrow — adapter is SDK source-of-truth).   */
/* -------------------------------------------------------------------------- */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null

/**
 * Return a copy of `SessionOptions` safe to persist in the durable session
 * row, with non-serializable LIVE handles removed.
 *
 * `decorate()` injects in-process MCP server objects into
 * `sdkOptions.mcpServers` (memory/scheduler/observability/local_shell/secret/
 * skill/widget + connector mounts). Those objects carry cyclic references, so
 * `JSON.stringify`-ing the whole options blob — which the SQLite SessionStore
 * does to fill `options_json` — threw `cannot serialize cyclic structures`,
 * which `Effect.orDie` converted into a silently-dropped defect that hung every
 * new-thread request.
 *
 * The mcpServers belong ONLY to the in-memory `sdkOptions` handed to the SDK
 * adapter for the live query; they are re-wired fresh by `decorate()` on every
 * (re)build / resume and are never read back from the persisted row. So we drop
 * `mcpServers` (both the top-level mirror and the `sdkOptions` copy) from the
 * persisted snapshot while the live `sessionOptions` still flows unchanged to
 * `adapter.query`.
 */
const stripNonPersistableOptions = (opts: SessionOptions): SessionOptions => {
  const sdk = opts.sdkOptions
  // Drop sdkOptions.mcpServers (the live, cyclic handles).
  const sanitizedSdk =
    isObj(sdk) && "mcpServers" in sdk
      ? (() => {
          const { mcpServers: _drop, ...rest } = sdk as Record<string, unknown>
          return rest
        })()
      : sdk
  // Drop any top-level mcpServers mirror too. It is typed via the loose
  // CreateThreadOptions surface and may have been merged onto the blob.
  const { mcpServers: _topDrop, ...restTop } = opts as SessionOptions & {
    mcpServers?: unknown
  }
  return {
    ...restTop,
    ...(sanitizedSdk !== undefined ? { sdkOptions: sanitizedSdk } : {}),
  }
}

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
  const failure = Cause.failureOption(cause)
  const reason = Option.match(failure, {
    onSome: (e) =>
      e instanceof Error && e.message.length > 0 ? e.message : String(e),
    onNone: () => Cause.pretty(cause).split("\n")[0] ?? "unknown error",
  })
  return reason.length > MAX_STREAM_FAILURE_CHARS
    ? reason.slice(0, MAX_STREAM_FAILURE_CHARS) + "…"
    : reason
}

/**
 * Derive a cheap, no-model-call title from the first user message text.
 * Takes the first line (up to the first newline), then trims whitespace and
 * truncates to 60 characters. Returns null when the result would be empty.
 *
 * Phase 3 — Claude-Code-style naming without a model call.
 * The title is set once on the first turn via ThreadRegistry.upsert; if the
 * thread already has a title this path is skipped.
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
import { applyClientMarker, stripClientMarker, type ClientMarkerInput } from "./client-marker.js"

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
  // skill_tools (skill_load) + widget_tools (widget_write) are mounted into
  // every thread's mcpServers by decorate(), so the agent SEES them — but
  // without pre-approval each first call stalls on the SDK permission prompt
  // in a headless server ("the skill needs permission — skip it"). Pre-approve
  // them so the agent can load skills + author widgets autonomously.
  "mcp__skill_tools__*",
  "mcp__widget_tools__*",
  // suggest_action — same pre-approval rationale (mounted by decorate()).
  "mcp__suggested_actions__*",
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
      const runtime = yield* Effect.runtime<never>()

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
      const resumeGate = yield* Effect.makeSemaphore(1)

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
            Effect.catchAllCause(() => Effect.void),
            Effect.forkIn(serviceScope),
            Effect.asVoid,
          ),
      })

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
        // The SDK uses this object as the ENTIRE subprocess env (no
        // process.env merge). Forward basic process identity so the CLI can
        // resolve its config dir and credentials on a local Mac (HOME drives
        // ~/.claude + Keychain lookup; PATH lets it spawn helpers like
        // /usr/bin/security). Without these, local keychain logins report
        // "Not logged in" while CLAUDE_CONFIG_DIR-pinned deploys still work.
        const sdkEnv: Record<string, string | undefined> = {
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          ...(["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR"] as const)
            .filter((k) => process.env[k]?.trim())
            .reduce<Record<string, string>>((acc, k) => {
              acc[k] = process.env[k] as string
              return acc
            }, {}),
          ...(process.env["CLAUDE_CONFIG_DIR"]?.trim()
            ? { CLAUDE_CONFIG_DIR: process.env["CLAUDE_CONFIG_DIR"] }
            : {}),
        }
        // Per-model effort clamp (effort.ts effortsForModel — the same matrix
        // the hello frame advertises). This is the enforcement point for
        // every createThread caller (ui-ws new-thread, subscribe()-recovery,
        // direct API): an invalid combo from a stale or hand-rolled client
        // (e.g. haiku+max) never reaches the SDK options. createThread logs
        // when the clamp drops or adjusts the level.
        //
        // Ultracode demux: "ultracode" is a menu/wire token, NOT an SDK effort.
        // When the thread requests it AND the model can run it (xhigh-capable),
        // the mode is enabled below (sdkOptions.settings + the Workflow tool)
        // instead of being routed through the effort clamp — the token must
        // never reach clampEffort or Options.effort. A token on a non-capable
        // model is only reachable from a stale client (the menu hides it); it
        // falls through as "no effort" and createThread logs it.
        const ultracodeOn =
          isUltracode(opts.effort) && modelSupportsUltracode(opts.model ?? "")
        const effortClamp = isUltracode(opts.effort)
          ? { effort: undefined as EffortLevel | undefined, dropped: false }
          : clampEffort(opts.model, opts.effort)
        const sdkOptions: Record<string, unknown> = {
          includePartialMessages: true,
          // GAP#3: the SDK adapter routes by `sdkOptions.model` (the broker reads
          // it for provider selection AND the SDK uses it as the model). The
          // top-level `SessionOptions.model` below is consumed only by
          // merge-policy + session-service.fork() — it never reaches the SDK
          // call. Without this slot a caller-supplied model is silently dropped
          // and every thread routes to the broker's default (anthropic).
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          // Effort level: the clamped value (see effortClamp above) — never
          // the raw wire value. A dropped effort is omitted entirely.
          ...(effortClamp.effort !== undefined
            ? { effort: effortClamp.effort }
            : {}),
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
          // Availability, not permission: the `tools` array is what the agent
          // CAN call; `allowedTools` only pre-approves (skips canUseTool).
          //
          // Luna agents do real research-and-fix work, so they get the
          // research/fix built-ins: web research (WebFetch/WebSearch) and
          // filesystem (Read/Edit/Write/Grep/Glob), plus "Task", the
          // subagent-spawn tool (emitted wire name "Agent"; "Task" is the
          // options-layer alias the SDK accepts). A subagent inherits the
          // parent's tool set, so this is also what every spawned agent gets.
          //
          // SHELL runs through the pre-approved `mcp__local_shell__*` tool, NOT
          // the SDK's raw `Bash` built-in. local_shell scrubs secret env vars
          // (TOKEN/SECRET/API_KEY/…) and can be OS-sandboxed; raw Bash would
          // inherit the server's full process.env (live model keys / OAuth
          // token) with no scrub and bypass the canUseTool rail's value, so
          // Bash — and TodoWrite et al. — stay OUT. (Both security reviews of
          // this change flagged raw Bash as the dominant risk.)
          //
          // The file built-ins are NOT in allowedTools: under permissionMode
          // "default" each routes through the canUseTool callback chat-server
          // installs at boot (composeInterceptors / @luna/tools) — default-
          // allow, but DENY reads/writes of secret paths (.env, secrets/, key
          // files). HONEST SCOPE: these rails are a best-effort accident guard,
          // NOT a sandbox; and WEB EGRESS (WebFetch/WebSearch) is NOT railed —
          // combined with local read that is an exfiltration path, so treat the
          // box as one where the agent can read non-rail-blocked files and send
          // them outbound.
          tools: [
            "Task",
            "WebFetch",
            "WebSearch",
            "Read",
            "Edit",
            "Write",
            "Grep",
            "Glob",
            // Ultracode only: the Workflow built-in (multi-agent orchestration).
            // settings.enableWorkflows gates the FEATURE; this `tools` list gates
            // AVAILABILITY — without it the model cannot call Workflow even with
            // the mode on. The tool set is fixed at query construction, so a
            // mid-thread ultracode toggle gets the tool only on the next rebuild.
            ...(ultracodeOn ? ["Workflow"] : []),
          ],
          // Luna's MCP tools are pre-approved (availability already granted via
          // mcpServers): their own handlers enforce safety, so the SDK layer
          // auto-approves them without a canUseTool round-trip. "Task" is
          // pre-approved belt-and-braces: live probes show the SDK executes it
          // under permissionMode "default" without canUseTool, but pre-approval
          // keeps that working if a future CLI tightens it.
          allowedTools: [
            ...LUNA_ALLOWED_MCP_TOOLS,
            "Task",
            // Pre-approve Workflow so ultracode orchestration isn't gated by a
            // canUseTool round-trip (parity with "Task" above).
            ...(ultracodeOn ? ["Workflow"] : []),
          ],
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
          // Ultracode: enable the SDK Workflows feature + the mode for this
          // session via Options.settings (sdk.d.ts: `string | Settings`). WHICH
          // Settings keys is decided by effort.ts ultracodeFlagSettings. Set
          // only when the model supports ultracode — never on an incapable
          // model, and never as a plain Options.effort.
          ...(ultracodeOn ? { settings: ultracodeFlagSettings() } : {}),
        }
        return {
          // Top-level model is consumed by merge-policy / fork / display only
          // (never the SDK call — that's sdkOptions.model above). "default" is
          // the broker's default-lane sentinel; the adapter and fork strip it
          // before the SDK sees it.
          model: opts.model ?? "default",
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
          const decorated: CreateThreadOptions = Option.match(binding, {
            onNone: () => opts,
            onSome: (b) => ({
              ...opts,
              mcpServers: { ...(opts.mcpServers ?? {}), ...b.mcpServers },
              ...(b.systemPrompt !== undefined
                ? { systemPrompt: b.systemPrompt }
                : {}),
            }),
          })
          // Per-model default effort: when the caller supplies none, fall back
          // to the model's default (defaultEffortForModel — e.g. Sonnet 5 →
          // "high") so a fresh thread starts at the intended level even for
          // clients that omit effort. Resolved ONCE here so buildSessionOptions
          // (the SDK options) and createClamp below (logging + persistence)
          // agree on the applied value. Never yields the "ultracode" token
          // (defaultEffortForModel returns a real EffortLevel or undefined), so
          // the ultracode demux is unaffected. Only rebuilds the options object
          // when a default is actually injected (opts.effort was absent).
          const resolvedEffort: EffortOption | undefined =
            opts.effort ?? defaultEffortForModel(opts.model ?? "")
          // Rebuild the options object only when a default was actually injected
          // (opts.effort was absent and the model has one). The `!== undefined`
          // clause also narrows resolvedEffort so the `effort` key is never
          // assigned `undefined` under exactOptionalPropertyTypes.
          const effectiveOpts: CreateThreadOptions =
            resolvedEffort !== undefined && resolvedEffort !== opts.effort
              ? { ...decorated, effort: resolvedEffort }
              : decorated
          const sessionOptions = buildSessionOptions(effectiveOpts)

          // Per-model clamp result for logging + eager persistence below.
          // The same pure clamp already ran inside buildSessionOptions —
          // recomputing it here avoids widening that function's return type.
          // Mirror the ultracode demux: keep the token out of the clamp. Clamp
          // the RESOLVED effort (post default-injection) so the persisted value
          // matches what the SDK actually ran on.
          const createClamp = isUltracode(effectiveOpts.effort)
            ? { effort: undefined as EffortLevel | undefined, dropped: false }
            : clampEffort(opts.model, effectiveOpts.effort)
          if (isUltracode(opts.effort)) {
            if (!modelSupportsUltracode(opts.model ?? "")) {
              // Distinguish "no model selected (default lane)" from a model
              // that is definitively not xhigh-capable — same `opts.model ?? ""`
              // but very different root causes for an operator.
              yield* Effect.logWarning(
                opts.model === undefined
                  ? `[chat] createThread: ultracode requested but no model was selected (default lane) — ignored; ultracode needs an xhigh-capable model (Opus 4.7/4.8, Fable)`
                  : `[chat] createThread: ultracode requested but model '${opts.model}' is not xhigh-capable — ignored`,
              )
            }
          } else if (opts.effort !== undefined && createClamp.dropped) {
            yield* Effect.logWarning(
              `[chat] createThread: effort '${opts.effort}' dropped — model '${opts.model ?? "(default)"}' takes no effort parameter`,
            )
          } else if (
            opts.effort !== undefined &&
            createClamp.effort !== opts.effort
          ) {
            yield* Effect.logWarning(
              `[chat] createThread: effort '${opts.effort}' clamped to '${createClamp.effort}' for model '${opts.model ?? "(default)"}'`,
            )
          }

          // Create the session row first — fail loudly if id collides.
          //
          // PERSISTENCE BOUNDARY: the durable row must hold only a
          // *serializable* options snapshot. `decorate()` injects LIVE
          // in-process MCP server objects into `sdkOptions.mcpServers`
          // (memory/scheduler/observability/local_shell/secret/skill/widget +
          // connector mounts); those objects carry cyclic references, so
          // serializing them threw `JSON.stringify cannot serialize cyclic
          // structures` inside the SQLite store's INSERT — which `Effect.orDie`
          // turned into a defect that the ui-ws handler dropped silently,
          // hanging every new-thread request. The live `sessionOptions` still
          // flows UNCHANGED to `adapter.query` below (so the SDK gets its
          // tools); only the persisted copy is sanitized. The mcpServers are
          // re-wired fresh by decorate() on every (re)build / resume and are
          // never read back from this row.
          const persistOptions = stripNonPersistableOptions(sessionOptions)

          // Recovery tolerance: when `threadIdOverride` is set the caller is
          // the subscribe() cache-miss path restoring an existing thread. If
          // the session-store ALREADY has a row for this id (inconsistent
          // state: ThreadRegistry has sdkSessionId=null but the store row
          // exists from the original createThread), reuse the persisted row
          // instead of colliding on store.create(). Without this guard,
          // store.create() returns an IntegrityError that Effect.orDie turns
          // into a defect, killing the fiber before any snapshot is emitted —
          // the client's subscribe watchdog times out with "Reattach stalled".
          //
          // New-thread path (no threadIdOverride, or fresh id with no existing
          // row) is unchanged: store.create() fails loudly on a real collision.
          const existingRow =
            opts.threadIdOverride !== undefined
              ? yield* store.get(id)
              : null
          const summary =
            existingRow !== null
              ? existingRow
              : yield* store
                  .create({ id, options: persistOptions, createdAt })
                  // Surface the typed failure at its source before converting to a
                  // defect — the silent-failure gap that hid the cyclic-serialize
                  // bug. The ui-ws new-thread handler additionally catches the
                  // resulting cause and sends the client a `thread-create-error`
                  // frame (server.ts), so the user is never left hanging.
                  .pipe(
                    Effect.tapErrorCause((cause) =>
                      Effect.logError(
                        `[chat] createThread: session store create failed for ${id}: ${Cause.pretty(cause)}`,
                      ),
                    ),
                    Effect.orDie,
                  )

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
          // Persistent fan-out: resume/recovery MUST reuse the thread's
          // original PubSub so subscriptions taken before an idle reap keep
          // receiving frames after the thread is re-created (see `pubsubs`).
          const pubsub = yield* getOrCreatePubSub(id)
          const inFlightTurnId = yield* Ref.make<string | null>(null)
          const inFlightText = yield* Ref.make<string>("")
          const lastActivity = yield* Ref.make<number>(yield* clock.nowMs())

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

          // Persist creation-time metadata in ThreadRegistry (when available)
          // so a chat-server restart can resume this thread. The SDK session id
          // arrives asynchronously via onSdkSessionId, so the initial upsert
          // has sid=null; the later setSid() call fills it in.
          //
          // When ThreadRegistry is absent (tests/headless), fall back to the
          // legacy JSON map — WRITE ONLY as fallback (no dual-write when the
          // registry is present).
          const lunaHome = process.env["LUNA_HOME"]

          // Persist the ultracode TOKEN when the mode is on; else the clamped effort.
          const persistEffort: EffortOption | undefined =
            isUltracode(opts.effort) && modelSupportsUltracode(opts.model ?? "")
              ? ULTRACODE
              : createClamp.effort

          // Upsert the thread row (sid comes later via onSdkSessionId).
          yield* Option.match(threadRegistry, {
            onNone: () => Effect.void,
            onSome: (reg) =>
              reg
                .upsert({
                  id,
                  sdkSessionId: null,
                  cwd:
                    (opts as { cwd?: string }).cwd ??
                    process.env["LUNA_REPO_ROOT"] ??
                    process.cwd(),
                  ...(opts.model !== undefined ? { model: opts.model } : {}),
                  ...(persistEffort !== undefined
                    ? { effort: persistEffort }
                    : {}),
                })
                .pipe(Effect.catchAllCause(() => Effect.void)),
          })

          // Legacy fallback: when no ThreadRegistry, write the JSON map.
          if (Option.isNone(threadRegistry) && lunaHome !== undefined) {
            if (opts.model !== undefined || persistEffort !== undefined) {
              try {
                appendThreadConfigEntry(lunaHome, id, {
                  ...(opts.model !== undefined ? { model: opts.model } : {}),
                  ...(persistEffort !== undefined
                    ? { effort: persistEffort }
                    : {}),
                })
              } catch {
                // Best-effort persistence — must not break live chat.
              }
            }
          }

          // onSdkSessionId: fires when the SDK allocates a session UUID.
          // Primary path: persist via ThreadRegistry. Fallback: JSON map.
          const recordSdkSession: ((sdkSid: string) => void) | undefined = (() => {
            // ThreadRegistry path (primary)
            if (Option.isSome(threadRegistry)) {
              const reg = threadRegistry.value
              return (sdkSid: string) => {
                // Best-effort background persist: run the Effect from this
                // synchronous callback using the captured runtime. Errors are
                // swallowed so a DB glitch never breaks a live chat session.
                Runtime.runFork(runtime)(
                  reg.setSid(id, sdkSid).pipe(
                    Effect.catchAllCause(() => Effect.void),
                  ),
                )
              }
            }
            // Legacy JSON map fallback (no ThreadRegistry provided)
            if (lunaHome !== undefined) {
              return (sdkSid: string) => {
                try {
                  appendThreadSessionEntry(lunaHome, id, sdkSid)
                } catch {
                  // Best-effort persistence — must not break live chat.
                }
              }
            }
            return undefined
          })()

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
                lastActivity,
              }),
            ),
            Effect.catchAllCause((cause) => {
              const message = `adapter stream failed: ${formatStreamFailureReason(cause)}`
              return Effect.gen(function* () {
                // Server-side log with the FULL cause (incl. stack) — this path
                // previously emitted nothing to stdout/stderr, so a fatal
                // adapter failure (e.g. a stale pathToClaudeCodeExecutable) left
                // zero diagnostic trail in the logs. The user frame + obs event
                // carry the bounded reason; the log carries everything.
                yield* Effect.logError(
                  `[chat] adapter stream failed for ${id}: ${Cause.pretty(cause)}`,
                )
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
            lastActivity,
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
          // Symmetric teardown for the provider's onBound binding: release any
          // per-session state it registered (sandbox re-attach closures, tool
          // session cells). Without this, a module-scope map in the provider
          // grows one entry per historical thread for the process lifetime —
          // an unbounded leak on a long-lived server.
          yield* Scope.addFinalizer(
            threadScope,
            Effect.sync(() =>
              Option.match(binding, {
                onNone: () => {},
                onSome: (b) => b.onUnbound?.(id),
              }),
            ),
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
        readonly lastActivity: Ref.Ref<number>
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
       * Ensure a thread is live in the in-memory map, recovering from the idle
       * reaper evicting it. Mirrors the cache-miss recovery in subscribe() but
       * is shared so BOTH send() and subscribe() benefit from one consistent
       * implementation with a semaphore-guarded get→create critical section.
       *
       * Three cases (A/B/C as in subscribe's original comment):
       *   (A) thread in ThreadRegistry with sdk_session_id → resume via SDK
       *   (B) thread in ThreadRegistry without sdk_session_id → re-create live
       *   (C) not in registry at all → Option.none (unknown thread)
       *
       * The semaphore (one permit, service-wide) closes the double-create race:
       * after acquiring the permit, we re-check m.get(threadId) — if a concurrent
       * caller already recreated it, we return that entry immediately without
       * spawning a second SDK subprocess.
       */
      const ensureThreadLive = (
        threadId: string,
      ): Effect.Effect<Option.Option<ThreadEntry>, never> =>
        Effect.gen(function* () {
          // Fast path: thread already live.
          const m0 = yield* Ref.get(threads)
          const existing = m0.get(threadId)
          if (existing) return Option.some(existing)

          // Slow path: acquire permit, then re-check to guard against
          // concurrent callers who raced here simultaneously.
          return yield* resumeGate.withPermits(1)(
            Effect.gen(function* () {
              const m1 = yield* Ref.get(threads)
              const raceWinner = m1.get(threadId)
              if (raceWinner) return Option.some(raceWinner)

              // Lookup in ThreadRegistry (or legacy JSON map).
              let persistedSdkId: string | undefined
              let savedModel: string | undefined
              let savedEffort: string | undefined
              let savedCwd: string | undefined
              let knownButNoSid = false

              if (Option.isSome(threadRegistry)) {
                // A registry read failure must be visible: swallowing it
                // silently made a DB glitch indistinguishable from a
                // genuinely unknown thread ("unknown thread" to the user).
                const row = yield* threadRegistry.value
                  .get(threadId)
                  .pipe(
                    Effect.tapErrorCause((cause) =>
                      Effect.logError(
                        `[chat] ensureThreadLive: ThreadRegistry.get(${threadId}) failed — treating as unknown: ${Cause.pretty(cause)}`,
                      ),
                    ),
                    Effect.catchAllCause(() => Effect.succeed(null)),
                  )
                if (row !== null) {
                  savedCwd = row.cwd ?? undefined
                  if (row.sdkSessionId !== null) {
                    persistedSdkId = row.sdkSessionId
                    savedModel = row.model ?? undefined
                    savedEffort = row.effort ?? undefined
                  } else {
                    knownButNoSid = true
                    savedModel = row.model ?? undefined
                    savedEffort = row.effort ?? undefined
                  }
                }
                // row === null → Case C, not known
              } else {
                // Legacy fallback: JSON map (read-only)
                const lunaHome = process.env["LUNA_HOME"]
                const persistedEntry =
                  lunaHome !== undefined
                    ? loadThreadSessionMap(lunaHome)[threadId]
                    : undefined
                if (persistedEntry !== undefined) {
                  const sid =
                    typeof persistedEntry === "string"
                      ? persistedEntry
                      : persistedEntry.sid
                  if (sid !== undefined) {
                    persistedSdkId = sid
                    savedModel =
                      typeof persistedEntry === "object" && persistedEntry !== null
                        ? persistedEntry.model
                        : undefined
                    savedEffort =
                      typeof persistedEntry === "object" && persistedEntry !== null
                        ? persistedEntry.effort
                        : undefined
                  } else {
                    knownButNoSid = true
                    savedModel =
                      typeof persistedEntry === "object" && persistedEntry !== null
                        ? persistedEntry.model
                        : undefined
                    savedEffort =
                      typeof persistedEntry === "object" && persistedEntry !== null
                        ? persistedEntry.effort
                        : undefined
                  }
                }
              }

              // Case B: known thread, no sdk_session_id → re-create live
              if (knownButNoSid) {
                yield* Effect.logWarning(
                  `[chat] ensureThreadLive: thread ${threadId} is known but has no sdk_session_id — re-creating live with empty history`,
                )
                const validEffort =
                  savedEffort !== undefined && isEffortOption(savedEffort)
                    ? savedEffort
                    : undefined
                yield* createThread({
                  threadIdOverride: threadId,
                  ...(savedModel !== undefined ? { model: savedModel } : {}),
                  ...(validEffort !== undefined ? { effort: validEffort } : {}),
                  ...(savedCwd !== undefined ? { cwd: savedCwd } : {}),
                })
                const m2 = yield* Ref.get(threads)
                return Option.fromNullable(m2.get(threadId) ?? null)
              }

              // Case A: known + has sdk_session_id → resume via SDK
              if (persistedSdkId !== undefined) {
                if (savedCwd === undefined) {
                  yield* Effect.logWarning(
                    `[chat] ensureThreadLive: thread ${threadId} has no persisted cwd — resuming with default cwd`,
                  )
                }
                const validEffort =
                  savedEffort !== undefined && isEffortOption(savedEffort)
                    ? savedEffort
                    : undefined
                yield* createThread({
                  threadIdOverride: threadId,
                  resumeFromSessionId: persistedSdkId,
                  ...(savedModel !== undefined ? { model: savedModel } : {}),
                  ...(validEffort !== undefined ? { effort: validEffort } : {}),
                  ...(savedCwd !== undefined ? { cwd: savedCwd } : {}),
                })
                const m2 = yield* Ref.get(threads)
                return Option.fromNullable(m2.get(threadId) ?? null)
              }

              // Case C: not in registry or JSON map → unknown
              return Option.none<ThreadEntry>()
            }).pipe(
              // A failure ANYWHERE in the recovery path (registry lookup,
              // resume, re-create) must not crash the caller, but it also
              // must not masquerade as Case C silently: callers report
              // Option.none as "unknown thread", so without this log a
              // resume failure is indistinguishable from a missing row.
              Effect.tapErrorCause((cause) =>
                Effect.logError(
                  `[chat] ensureThreadLive: recovery for ${threadId} failed — reporting unknown thread: ${Cause.pretty(cause)}`,
                ),
              ),
              Effect.catchAllCause(() => Effect.succeed(Option.none<ThreadEntry>())),
            ),
          )
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

          // Phase 3: bump last_active_at on every turn (best-effort, off hot path).
          // A DB failure here must never break live chat.
          if (Option.isSome(threadRegistry)) {
            yield* threadRegistry.value
              .touch(threadId)
              .pipe(Effect.catchAllCause(() => Effect.void))

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
            }).pipe(Effect.catchAllCause(() => Effect.void))
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
            .pipe(Effect.catchAll(() => Effect.succeed(null as StoredMessage | null)))
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
                ).pipe(Effect.as(true), Effect.catchAll(() => Effect.succeed(false)))
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
                  .pipe(Effect.catchAll(() => Effect.void))
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
                      .pipe(Effect.catchAllCause(() => Effect.void)),
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
                  Effect.catchAll(() => Effect.succeed(false)),
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
                  Effect.catchAll(() => Effect.void),
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
                      .pipe(Effect.catchAllCause(() => Effect.void)),
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
                      .pipe(Effect.catchAllCause(() => Effect.void)),
                })
              } else if (handle !== null) {
                // Same lane + live handle → hot-swap via setModel. Success-
                // gated: a thrown setModel lands in `rejected`, not `applied`,
                // and the unapplied value is not persisted.
                const liveOk = yield* Effect.tryPromise(() => handle.setModel(model)).pipe(
                  Effect.as(true),
                  Effect.catchAll(() => Effect.succeed(false)),
                )
                if (liveOk) {
                  applied.push("model")
                  // Persist: update both top-level model and sdkOptions.model
                  const existingOpts2 = yield* store.getOptions(threadId)
                  const mergedSdk2 = { ...(existingOpts2?.sdkOptions ?? {}), model }
                  yield* store.setOptions(threadId, { model, sdkOptions: mergedSdk2 }).pipe(
                    Effect.catchAll(() => Effect.void),
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
                        .pipe(Effect.catchAllCause(() => Effect.void)),
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
                      .pipe(Effect.catchAllCause(() => Effect.void)),
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
       *  via `Stream.unwrapScoped` — when the consumer terminates the
       *  Stream, the subscription is released. Callers do NOT need a Scope
       *  in their Effect environment. */
      const subscribe = (
        threadId: string,
      ): Stream.Stream<ChatFrame, never> =>
        Stream.unwrapScoped(
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

            // Replay-on-open: surface this thread's non-terminal suggested
            // actions (including any Dream proposed while no client was
            // attached) as ONE set frame right after the snapshot, before the
            // live stream. Best-effort — a store error must not break the
            // subscribe.
            const replayFrames: ChatFrame[] = []
            yield* Option.match(suggestedActions, {
              onNone: () => Effect.void,
              onSome: (sa) =>
                sa
                  .listByThread(threadId, { status: ACTIVE_STATUSES })
                  .pipe(
                    Effect.catchAll(() => Effect.succeed([] as const)),
                    Effect.map((rows) => {
                      if (rows.length > 0) {
                        replayFrames.push({
                          type: "suggested-action-set",
                          threadId,
                          actions: rows.map(toView),
                        })
                      }
                    }),
                  ),
            })

            return Stream.concat(
              Stream.make(snapshotFrame, ...replayFrames),
              liveStream,
            )
          }),
        )

      /**
       * Read-only sidebar projection. Returns most-recently-active first.
       *
       * Phase 3: when status='archived' and ThreadRegistry is wired,
       * returns archived threads from the registry (they may not have
       * SessionStore rows if archived before Phase 2, so the registry
       * is the authoritative list). For the default 'active' case the
       * SessionStore list is used (same as pre-Phase-3 behaviour).
       */
      const listThreads = (
        limit = 50,
        status?: "active" | "archived",
      ): Effect.Effect<ReadonlyArray<SessionSummary>, never> => {
        // For archived threads, pull from ThreadRegistry (it owns status).
        if (status === "archived" && Option.isSome(threadRegistry)) {
          return threadRegistry.value.listByStatus("archived").pipe(
            Effect.map((rows) =>
              rows.slice(0, limit).map((r) => ({
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
              })),
            ),
          )
        }
        // Default: active threads from SessionStore, filtered by ThreadRegistry
        // status when the registry is wired. Archived threads must NOT appear in
        // the default (active) sidebar — they are only returned when status='archived'.
        // Best-effort: if registry is absent, fall through without filtering.
        const sessionList = store
          .list({ orderBy: "lastMessageAt", limit })
          .pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray))
        // Derive a display title from the thread's FIRST top-level user message
        // (same heuristic the first-turn path uses). The stored payload carries
        // the client-identity marker prepended at ingest, which the first-turn
        // path never saw — strip it so both paths derive from the raw user
        // text. Null when the thread has no user message yet or the store read
        // fails — the client shows its own untitled fallback then.
        const deriveFirstMessageTitle = (
          sessionId: string,
        ): Effect.Effect<string | null, never> =>
          store.readMessages(sessionId).pipe(
            Stream.filter((m) => m.kind === "user" && m.parentId === null),
            Stream.take(1),
            Stream.runCollect,
            Effect.map((chunk) => {
              const first = Chunk.head(chunk)
              if (Option.isNone(first)) return null
              const text = extractText(first.value.payload)
              return text ? deriveTitleFromMessage(stripClientMarker(text)) : null
            }),
            Effect.catchAll(() => Effect.succeed(null)),
          )
        // Overlay display titles onto summaries that lack one. The SessionStore
        // `title` column is write-once at INSERT (Moon never sends one), while
        // the first-turn heuristic writes derived titles to the ThreadRegistry —
        // so without this overlay every active row projects title=null and the
        // sidebar renders "untitled". Preference order per row:
        //   1. the SessionStore title (explicitly set at creation);
        //   2. the ThreadRegistry title (first-turn heuristic, Phase 3);
        //   3. derive-on-read from the first user message (threads predating the
        //      heuristic), persisted back to the registry so it runs once.
        const resolveTitles = (
          sessions: ReadonlyArray<SessionSummary>,
          regTitles: ReadonlyMap<string, string | null>,
          persist: ((id: string, title: string) => Effect.Effect<void, never>) | null,
        ): Effect.Effect<ReadonlyArray<SessionSummary>, never> =>
          Effect.forEach(
            sessions,
            (s) => {
              if (s.title !== null && s.title !== "") return Effect.succeed(s)
              const regTitle = regTitles.get(s.id)
              if (regTitle) return Effect.succeed({ ...s, title: regTitle })
              return deriveFirstMessageTitle(s.id).pipe(
                Effect.tap((derived) =>
                  derived && persist ? persist(s.id, derived) : Effect.void,
                ),
                Effect.map((derived) => (derived ? { ...s, title: derived } : s)),
              )
            },
            { concurrency: 4 },
          )
        if (Option.isNone(threadRegistry)) {
          return sessionList.pipe(
            Effect.flatMap((sessions) => resolveTitles(sessions, new Map(), null)),
          )
        }
        const reg = threadRegistry.value
        return Effect.gen(function* () {
          const [sessions, archivedRows, activeRows] = yield* Effect.all([
            sessionList,
            reg.listByStatus("archived").pipe(
              Effect.catchAllCause(() => Effect.succeed([] as readonly { readonly id: string }[])),
            ),
            reg.listByStatus("active").pipe(
              Effect.catchAllCause(() =>
                Effect.succeed([] as readonly { readonly id: string; readonly title: string | null }[]),
              ),
            ),
          ])
          const archivedIds = new Set(archivedRows.map((r) => r.id))
          const regTitles = new Map(activeRows.map((r) => [r.id, r.title]))
          const visible = sessions.filter((s) => !archivedIds.has(s.id))
          // Persist derived titles so legacy threads are derived exactly once.
          // setTitleIfNull is clock-neutral: listing the sidebar is a read, so it
          // must never bump last_active_at (that would reset the 14-day
          // auto-archive idle clock for exactly the stale threads it retires).
          // It also never inserts and never changes archival status.
          const persist = (id: string, title: string) =>
            reg
              .setTitleIfNull(id, title)
              .pipe(Effect.asVoid, Effect.catchAllCause(() => Effect.void))
          return yield* resolveTitles(visible, regTitles, persist)
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
            .pipe(Effect.catchAll(() => Effect.void))
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
            reg.archive(threadId).pipe(Effect.catchAllCause(() => Effect.succeed(false))),
        })

      /**
       * Phase 3: Unarchive a thread (archived->active). Clears archived_at.
       * Returns true if the thread exists; false otherwise.
       */
      const unarchiveThread = (threadId: string): Effect.Effect<boolean, never> =>
        Option.match(threadRegistry, {
          onNone: () => Effect.succeed(false),
          onSome: (reg) =>
            reg.unarchive(threadId).pipe(Effect.catchAllCause(() => Effect.succeed(false))),
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
          Effect.zipRight(reapIdleThreadsOnce()),
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
    }),
  },
) {}

/** Re-export the chat-shaped projection helper from core for downstream
 *  consumers (ui-ws server, Tauri shell) that don't otherwise pull core. */
export { projectChatMessages, projectOne } from "@luna/core"
