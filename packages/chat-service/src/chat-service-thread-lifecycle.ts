/**
 * Thread lifecycle - split out of chat-service.ts along the seam its own
 * doc comments already named: `createThread` (spin up a thread's inbox,
 * pubsub, per-thread sub-scope, and long-lived `adapter.query()` consumer)
 * and `ensureThreadLive`'s Case A/B/C recovery (resume a thread the idle
 * reaper evicted, or that a chat-server restart wiped from memory).
 *
 * Moved verbatim from chat-service.ts - no behavior change, no symbol
 * renamed. `buildSessionOptions`, `stripNonPersistableOptions`,
 * `withTurnMemoryContext`, and `genThreadId` move with `createThread`
 * because they exist only to serve it. The account-rotation retry loop
 * (`runOrdinaryQuery`) that used to be defined inline inside `createThread`
 * now lives in `chat-service-account-rotation.ts`; `createThread` builds its
 * deps object and calls it, unchanged in effect.
 *
 * CRITICAL (do not touch without re-reading PR #403): the Case A resume path
 * below deliberately OMITS `sdkSessionId` from the ThreadRegistry `upsert()`
 * call, `recordSdkSession` persists UNCONDITIONALLY, and a failed `setSid`
 * logs a warning + bumps a metric instead of swallowing it. That is the fix
 * for a six-week silent bug where resuming a thread wiped its own resume
 * pointer (45 of 94 live threads were affected). The comments inline at each
 * of those three points are load-bearing documentation, not incidental -
 * they are reproduced here verbatim from chat-service.ts.
 */
import {
  Cause,
  Context,
  Effect,
  Exit,
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
  type ObservabilityApi,
  type ThreadRegistryApi,
  type SessionSummary,
  type SessionOptions,
} from "@luna/core"
import type { SDKAdapterService } from "@luna/adapter-sdk"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  type ChatFrame,
  type CreateThreadOptions,
  type ThreadToolsBinding,
  type ThreadToolsProvider,
} from "./types.js"
import {
  appendThreadSessionEntry,
  appendThreadConfigEntry,
  loadThreadSessionMap,
} from "./thread-session-map.js"
import {
  clampEffort,
  defaultEffortForModel,
  isEffortOption,
  isUltracode,
  modelSupportsUltracode,
  ultracodeFlagSettings,
  ULTRACODE,
  type EffortLevel,
  type EffortOption,
} from "./effort.js"
import { LUNA_ALLOWED_MCP_TOOLS } from "./chat-service-tools.js"
import { isObj, formatStreamFailureReason, makeSdkMessageHandling } from "./chat-service-sdk-messages.js"
import { makeRunOrdinaryQuery } from "./chat-service-account-rotation.js"
import type { ThreadEntry, TurnPrompt } from "./chat-service.js"

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

/**
 * Add recall to the system prompt for one SDK query only.
 *
 * Recall-enabled threads run one finite SDK query per turn and resume the same
 * SDK transcript for the next turn. System prompts are query configuration,
 * not transcript messages, so the next query replaces this suffix instead of
 * retaining every previous `<memory_context>` block. The canonical user
 * payload therefore stays clean in both Luna's store and the SDK transcript.
 */
export const withTurnMemoryContext = (
  sessionOptions: SessionOptions,
  context: string | null,
): SessionOptions => {
  if (context === null || context.length === 0) return sessionOptions
  const sdkOptions = sessionOptions.sdkOptions ?? {}
  const basePrompt =
    typeof sdkOptions.systemPrompt === "string"
      ? sdkOptions.systemPrompt
      : sessionOptions.systemPrompt
  const systemPrompt =
    basePrompt === undefined || basePrompt.length === 0
      ? context
      : `${basePrompt}\n\n${context}`
  return {
    ...sessionOptions,
    systemPrompt,
    sdkOptions: {
      ...sdkOptions,
      systemPrompt,
    },
  }
}

/** Deps `createThread` / `ensureThreadLive` close over - the shared
 *  service-lifetime resources ChatService's scoped Effect.gen builds once
 *  and wires into every factory (the same pattern the job-ticker split
 *  uses: shared-resource construction stays in the composition root). */
export interface ThreadLifecycleDeps {
  readonly store: Context.Service.Shape<typeof SessionStore>
  readonly adapter: SDKAdapterService
  readonly clock: Context.Service.Shape<typeof CoreClock>
  readonly obs: ObservabilityApi
  readonly threadToolsProvider: Option.Option<ThreadToolsProvider>
  readonly threadRegistry: Option.Option<ThreadRegistryApi>
  readonly serviceScope: Scope.Scope
  readonly runtime: Context.Context<never>
  readonly threads: Ref.Ref<ReadonlyMap<string, ThreadEntry>>
  readonly getOrCreatePubSub: (
    id: string,
  ) => Effect.Effect<PubSub.PubSub<ChatFrame>, never>
  /** Guards ensureThreadLive's get→create critical section (one permit,
   *  service-wide) so two concurrent callers racing on the same reaped
   *  thread cannot both spawn a second SDK subprocess. */
  readonly resumeGate: Semaphore.Semaphore
  readonly inc: (
    name: string,
    tags?: Readonly<Record<string, string>>,
    n?: number,
  ) => Effect.Effect<void, never>
}

export const makeThreadLifecycle = (deps: ThreadLifecycleDeps) => {
  const {
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
  } = deps

  const { handleSdkMessage } = makeSdkMessageHandling({ clock, obs, store, inc })

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
                Effect.tapCause((cause) =>
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

      const inbox = yield* Queue.unbounded<TurnPrompt>()
      // Persistent fan-out: resume/recovery MUST reuse the thread's
      // original PubSub so subscriptions taken before an idle reap keep
      // receiving frames after the thread is re-created (see `pubsubs`).
      const pubsub = yield* getOrCreatePubSub(id)
      const inFlightTurnId = yield* Ref.make<string | null>(null)
      const inFlightText = yield* Ref.make<string>("")
      const lastActivity = yield* Ref.make<number>(yield* clock.nowMs())
      const pendingTurns = yield* Queue.unbounded<{
        readonly userMessageId: string
        readonly userText: string
      }>()
      const assistantText = yield* Ref.make("")
      // Account-rotation support (ordinary path only - the recall path's
      // per-turn `Stream.make(turn.payload)` prompt is already replayable
      // and needs no re-offer).
      //
      // A LIST, not a single slot: each attempt's "forwarder" fiber
      // (built fresh per attempt in `runOrdinaryQuery`, chat-service-
      // account-rotation.ts) appends every turn it pulls off the thread's
      // own `inbox` that has not yet been closed by a `result` message, in
      // pull order. A single-slot Ref would silently DROP an earlier
      // unresolved turn if a forwarder ever pulls more than one item ahead
      // of what the SDK has actually finished processing - the exact
      // failure mode rotation exists to prevent. `result` (handleSdkMessage,
      // chat-service-sdk-messages.ts) shifts off the OLDEST entry: results
      // close turns in the same order they were submitted (the same FIFO
      // assumption `pendingTurns` already relies on), so the head of this
      // list is always the turn the next `result` closes - which holds
      // across a rotation ONLY because `runOrdinaryQuery` seeds this Ref
      // with `seedTurns` (the carried-over unresolved turns) in the SAME
      // step it seeds the new attempt's own queue, rather than leaving it
      // empty while that attempt is already executing those turns.
      const inFlightPrompts = yield* Ref.make<ReadonlyArray<TurnPrompt>>([])
      // Per-turn rotation budget. Reset to 0 in the SAME `result` branch
      // that shifts `inFlightPrompts` - a turn that completes proves the
      // account is healthy again, so the NEXT turn deserves the full
      // burst budget, not whatever was left over from a rotation many
      // turns ago. Without this reset, `MAX_ORDINARY_ROTATION_ATTEMPTS`
      // (chat-service-account-rotation.ts) would be a THREAD-lifetime
      // ceiling instead of a per-turn one - a thread that rotated twice,
      // ever, would silently stop rotating for the rest of its life even
      // after many healthy turns in between (see that module's doc).
      const rotationAttempts = yield* Ref.make(0)
      // Whether ANY turn on this thread has ever reached a `result` -
      // set true in the same branch as the two Refs above, NEVER reset.
      // Used only to gate the USER-VISIBLE "history was dropped" notice
      // (see `runOrdinaryQuery`): a session id can be minted by the
      // SDK's own init/system frame before a session-limit error on the
      // very FIRST turn of a brand-new thread, and in that case there is
      // no real history to lose - the notice would be a false alarm.
      const hasCompletedATurn = yield* Ref.make(false)

      // Per-thread sub-scope. `Scope.fork` makes a child that we can
      // close independently of the service scope. The service scope
      // still owns it transitively, so a service shutdown closes
      // everything via LIFO finalizers.
      const threadScope = yield* Scope.fork(
        serviceScope,
        // Parallel finalizers — siblings finalize concurrently.
        "parallel",
      )

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

      // Upsert the thread row.
      //
      // NEVER pass `sdkSessionId: null` here. createThread is reused by
      // ensureThreadLive Case A to RESUME an existing thread, and upsert
      // treats an explicit null as "clear this column" (null !== undefined),
      // so passing null would wipe the very resume pointer we just read —
      // leaving the thread with a full on-screen transcript and an EMPTY
      // model context, silently, on the next open.
      //
      // We therefore OMIT the key entirely: on a genuine insert the column
      // defaults to NULL and onSdkSessionId fills it in; on a Case A resume
      // the existing value is preserved untouched.
      // True only when the registry actually stored the row (codex review
      // finding 5): the thread-created frame must never claim a filing that
      // a swallowed registry failure silently dropped — the next
      // list-threads would "move" the thread to General and the operator
      // would read it as data loss.
      const regPersisted = yield* Option.match(threadRegistry, {
        onNone: () => Effect.succeed(false),
        onSome: (reg) =>
          reg
            .upsert({
              id,
              cwd:
                (opts as { cwd?: string }).cwd ??
                process.env["LUNA_REPO_ROOT"] ??
                process.cwd(),
              // Seed an explicit creation title into the registry so the
              // archived list (registry-only) shows it rather than a later
              // derived title. Blank titles normalize to null in the
              // registry, so this is a no-op for the common no-title case.
              ...(opts.title !== undefined ? { title: opts.title } : {}),
              ...(opts.model !== undefined ? { model: opts.model } : {}),
              ...(persistEffort !== undefined
                ? { effort: persistEffort }
                : {}),
              // Agent sidebar S2: filing at creation. The registry applies
              // this on INSERT only, so a Case-A resume through this same
              // path can never re-file an existing thread.
              ...(opts.agentName !== undefined
                ? { agentName: opts.agentName }
                : {}),
            })
            .pipe(
              // PR2: being created under an agent IS involvement — the
              // click-an-agent lookup must include threads minted from the
              // agent's own "+", not only delegation-observed ones.
              // Best-effort tap: a participation miss must not fail create.
              Effect.tap(() =>
                opts.agentName !== undefined
                  ? reg
                      .recordInvolvement(id, opts.agentName)
                      .pipe(Effect.catchCause(() => Effect.succeed(false)))
                  : Effect.void,
              ),
              Effect.as(true),
              Effect.catchCause(() => Effect.succeed(false)),
            ),
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
      const persistSdkSession: ((sdkSid: string) => void) | undefined = (() => {
        // ThreadRegistry path (primary)
        if (Option.isSome(threadRegistry)) {
          const reg = threadRegistry.value
          return (sdkSid: string) => {
            // Best-effort background persist: run the Effect from this
            // synchronous callback using the captured runtime. A failure
            // must never break a live chat session — but it must not be
            // INVISIBLE either. This single UPDATE is the only thing that
            // lets a thread resume with its model context; when it fails or
            // matches no row, the user gets a full on-screen transcript in
            // front of an amnesiac model. That silence is why the
            // sdk_session_id clobber survived six weeks undetected.
            Effect.runForkWith(runtime)(
              reg.setSid(id, sdkSid).pipe(
                Effect.tap((ok) =>
                  ok
                    ? Effect.void
                    : Effect.logWarning(
                        `[chat] setSid(${id}) matched no row — this thread will lose model context on resume`,
                      ).pipe(Effect.andThen(inc("luna.chat.sdk_sid_persist.failures"))),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    `[chat] setSid(${id}) failed: ${Cause.pretty(cause)}`,
                  ).pipe(Effect.andThen(inc("luna.chat.sdk_sid_persist.failures"))),
                ),
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
      let activeSdkSessionId = opts.resumeFromSessionId ?? null
      const recordSdkSession = (sdkSid: string): void => {
        activeSdkSessionId = sdkSid
        // Persist UNCONDITIONALLY. This used to be gated on
        // `sdkSid !== activeSdkSessionId`, but activeSdkSessionId is seeded
        // from opts.resumeFromSessionId — so a resumed session re-announcing
        // its own (unchanged) id skipped the write entirely. That made an
        // already-NULL row unable to ever repair itself. setSid is an
        // idempotent single-row UPDATE, so the redundant write is cheap and
        // buys us self-healing on the next turn of any damaged thread.
        persistSdkSession?.(sdkSid)
      }

      const onMirrorError = (_msg: SDKMessage, cause: unknown) =>
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
        }).pipe(Effect.catchCause(() => Effect.void))

      const handleAdapterFailure = (cause: Cause.Cause<unknown>) => {
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
          // A failed adapter stream is terminal for the in-flight turn but
          // emits no `result`, so drain its observation seed here — exactly
          // as the interrupt path does. Without this poll the pendingTurns
          // FIFO stays one slot ahead of the terminal events and every
          // later turn's observeTurn is paired against stale user text.
          const pending = yield* Queue.poll(pendingTurns)
          const failedAssistantText = yield* Ref.getAndSet(assistantText, "")
          const observeTurn = Option.getOrUndefined(binding)?.observeTurn
          if (Option.isSome(pending) && observeTurn !== undefined) {
            yield* observeTurn({
              sessionId: id,
              userMessageId: pending.value.userMessageId,
              userText: pending.value.userText,
              assistantText: failedAssistantText,
              isError: true,
            }).pipe(
              Effect.catchCause(() => Effect.void),
              Effect.forkIn(threadScope),
            )
          }
        })
      }

      // Runs the replies stream to its Exit WITHOUT swallowing a failure
      // Cause - the account-rotation decision (below) must inspect the
      // Cause BEFORE it is handed to `handleAdapterFailure`, which is
      // terminal (drains `pendingTurns`, ends the turn for good). A
      // clean stream end (scope closed, queue never fails) is a Success
      // exit; an adapter-stream failure is captured, not thrown.
      const runReplies = (
        replies: Stream.Stream<SDKMessage, unknown>,
      ): Effect.Effect<Exit.Exit<void, unknown>, never> =>
        replies.pipe(
          Stream.runForEach((msg) =>
            handleSdkMessage({
              threadId: id,
              msg,
              pubsub,
              inFlightTurnId,
              inFlightText,
              lastActivity,
              pendingTurns,
              assistantText,
              inFlightPrompts,
              rotationAttempts,
              hasCompletedATurn,
              ...(Option.getOrUndefined(binding)?.observeTurn !== undefined
                ? {
                    observeTurn:
                      Option.getOrUndefined(binding)!.observeTurn!,
                  }
                : {}),
              threadScope,
            }),
          ),
          Effect.exit,
        )

      const consumeReplies = (
        replies: Stream.Stream<SDKMessage, unknown>,
      ): Effect.Effect<void, never> =>
        runReplies(replies).pipe(
          Effect.flatMap((exit) =>
            Exit.isFailure(exit)
              ? handleAdapterFailure(exit.cause)
              : Effect.void,
          ),
        )

      const queryBase = {
        sessionId: id,
        // §0.2 sticky-pin: forward boundAccountId so WithBroker can
        // route this thread's queries to the caller-selected account.
        ...(opts.boundAccountId !== undefined
          ? { boundAccountId: opts.boundAccountId }
          : {}),
        onSdkSessionId: recordSdkSession,
        // §12.2 #2: the adapter mirrors every message to SessionStore
        // (the authoritative log). A write failure must not kill the turn,
        // but it must be observable.
        onMirrorError,
      }

      const recallMemory = Option.getOrUndefined(binding)?.recallMemory
      if (recallMemory === undefined) {
        // Ordinary path: a long-lived query, restarted on-demand by the
        // account-rotation retry loop (chat-service-account-rotation.ts).
        // See that module's doc comment for the full rationale — this call
        // site only assembles the deps object and forks the first attempt.
        const runOrdinaryQuery = makeRunOrdinaryQuery({
          id,
          opts: {
            ...(opts.boundAccountId !== undefined
              ? { boundAccountId: opts.boundAccountId }
              : {}),
            ...(opts.resumeFromSessionId !== undefined
              ? { resumeFromSessionId: opts.resumeFromSessionId }
              : {}),
          },
          inbox,
          inFlightPrompts,
          rotationAttempts,
          hasCompletedATurn,
          assistantText,
          getActiveSdkSessionId: () => activeSdkSessionId,
          setActiveSdkSessionId: (sdkSessionId) => {
            activeSdkSessionId = sdkSessionId
          },
          obs,
          pubsub,
          threadScope,
          queryBase,
          sessionOptions,
          adapter,
          runReplies,
          handleAdapterFailure,
          inc,
        })
        yield* runOrdinaryQuery(1, []).pipe(Effect.forkIn(threadScope))
        // v4: forked fibers start on the next scheduler turn. Yield so the
        // query acquire (and SDKClient.fake capture) runs before createThread
        // returns — tests and onSdkSessionId callers rely on that ordering.
        yield* Effect.yieldNow
      } else {
        // Recall context cannot live in a long-lived prompt stream: every
        // injected user block would remain in the SDK conversation. Run a
        // finite query per turn instead. Each query resumes the same clean
        // transcript and supplies only that turn's memory as system-prompt
        // configuration, so prior context is replaced rather than retained.
        yield* Stream.fromQueue(inbox).pipe(
          Stream.runForEach((turn) =>
            Effect.scoped(
              adapter
                .query({
                  ...queryBase,
                  prompt: Stream.make(turn.payload),
                  sessionOptions: withTurnMemoryContext(
                    sessionOptions,
                    turn.memoryContext,
                  ),
                  ...(activeSdkSessionId !== null
                    ? { resumeFromSessionId: activeSdkSessionId }
                    : {}),
                })
                .pipe(
                  Effect.flatMap(consumeReplies),
                  Effect.catchCause(handleAdapterFailure),
                ),
            ),
          ),
          Effect.forkIn(threadScope),
        )
        yield* Effect.yieldNow
      }

      // Track the entry. Removed from the map when the scope closes —
      // we add a finalizer that splices it out.
      const entry: ThreadEntry = {
        inbox,
        pubsub,
        scope: threadScope,
        inFlightTurnId,
        inFlightText,
        lastActivity,
        pendingTurns,
        assistantText,
        ...(Option.getOrUndefined(binding)?.recallMemory !== undefined
          ? {
              recallMemory: Option.getOrUndefined(binding)!.recallMemory!,
            }
          : {}),
        ...(Option.getOrUndefined(binding)?.observeTurn !== undefined
          ? {
              observeTurn: Option.getOrUndefined(binding)!.observeTurn!,
            }
          : {}),
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

      // Agent sidebar S2: the SessionStore summary knows nothing of the
      // registry's agent_name, but the `thread-created` frame (built from
      // this return) must carry the section so the creating client files
      // the new row without a list-threads round-trip. Fresh creates only —
      // an existingRow (threadIdOverride resume) keeps whatever filing the
      // list projection will resolve from the registry — and only when the
      // registry write actually LANDED (regPersisted): a summary claiming a
      // filing that failed to persist would visibly "move" to General on
      // the next refresh.
      return existingRow === null && opts.agentName !== undefined && regPersisted
        ? { ...summary, agentName: opts.agentName }
        : summary
    })

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
                Effect.tapCause((cause) =>
                  Effect.logError(
                    `[chat] ensureThreadLive: ThreadRegistry.get(${threadId}) failed — treating as unknown: ${Cause.pretty(cause)}`,
                  ),
                ),
                Effect.catchCause(() => Effect.succeed(null)),
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
            return Option.fromNullishOr(m2.get(threadId) ?? null)
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
            return Option.fromNullishOr(m2.get(threadId) ?? null)
          }

          // Case C: not in registry or JSON map → unknown
          return Option.none<ThreadEntry>()
        }).pipe(
          // A failure ANYWHERE in the recovery path (registry lookup,
          // resume, re-create) must not crash the caller, but it also
          // must not masquerade as Case C silently: callers report
          // Option.none as "unknown thread", so without this log a
          // resume failure is indistinguishable from a missing row.
          Effect.tapCause((cause) =>
            Effect.logError(
              `[chat] ensureThreadLive: recovery for ${threadId} failed — reporting unknown thread: ${Cause.pretty(cause)}`,
            ),
          ),
          Effect.catchCause(() => Effect.succeed(Option.none<ThreadEntry>())),
        ),
      )
    })

  return { createThread, ensureThreadLive }
}
