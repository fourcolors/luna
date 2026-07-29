/**
 * SDKAdapter — the Effect ↔ Anthropic Claude Agent SDK bridge.
 *
 * Implements DESIGN.md §12: single source of truth for SDK invocation.
 * Owns invariants #1–#8 of §12.2; mitigations §12.4.
 *
 * High-level flow of `query()`:
 *   1. Caller supplies `Stream<SDKUserMessage>` + `SessionOptions`.
 *   2. We convert the Stream → AsyncIterable (so the SDK can consume it)
 *      inside the calling Scope (invariant #1).
 *   3. We build SDK `Options`: merge-guarded (invariant #7), adapter-owned
 *      hooks/canUseTool/abortController/resume.
 *   4. We invoke `SDKClient.query()` which returns a `Query` handle.
 *   5. We stash the Query in a session-scoped Ref (invariant #8).
 *   6. We wrap the Query's async-iterable face in a Stream, tap it to
 *      mirror messages to SessionStore (invariant #2), and apply the idle
 *      timeout race (invariant #5).
 *   7. On Scope close: AbortController fires, idle timer cancelled, Query
 *      handle dropped from Ref.
 */
import {
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect"
import {
  ANTHROPIC_KIND,
  CLAUDE_CODE_LOGIN_SECRET_REF,
  SDKError,
  SessionStore,
  AccountBroker,
  profileForKind,
  readProviderEnv,
  resolveRoleModel,
  toWireModel,
  type AccountBrokerApi,
  type SessionOptions,
} from "@luna/core"
import { SDKClient, type QueryParams } from "./sdk-client.js"
import {
  buildBrokerBaseEnv,
  buildBrokerEnvOverlay,
} from "./broker-env-overlay.js"
import { classifyThrottle } from "./throttle.js"
import type {
  SDKMessage,
  SDKUserMessage,
  Options,
  Query,
  HookEvent,
  HookCallback,
  HookCallbackMatcher,
  CanUseTool,
  PermissionResult,
} from "./sdk-client.js"
import {
  sdkMessageKind,
  sdkMessageId,
  sdkMessageParentId,
  sdkMessageSessionId,
  sdkAgentSpawnIds,
  sdkToolResultIds,
} from "./message-kind.js"
import { mergeOptionsLogged } from "./merge-options.js"
import { mergeEnvOverlayLogged } from "./merge-env.js"
import { loadAgents } from "./agent-loader.js"

const DEFAULT_IDLE_TIMEOUT_MS = 120_000

/**
 * Model the "default" lane PREFERS when it lands on a native Anthropic
 * account (#253): the daily-driver role default (claude-sonnet-5). Resolved
 * through the same table chat-server's role priming uses so the two cannot
 * drift. This is a default-lane RESOLUTION preference, not a pre-stamp:
 * threads with no model still acquire the broker's "default" lane, so a
 * configured default overflow chain always wins and a deployment with no
 * Anthropic account keeps its chain/no-chain behavior unchanged.
 */
const DEFAULT_LANE_PREFERRED_MODEL = resolveRoleModel("daily-driver", null)

/**
 * Turn-aware inactivity watchdog (chat threads). When a chat turn streams no
 * SDK message for this long, the subprocess is presumed wedged (the live bug:
 * a usage-limited subscription account makes the `claude` CLI hang internally
 * retrying the throttle instead of returning a 429). 300s, not tighter: while
 * an in-process MCP tool executes (e.g. a multi-minute local-shell command)
 * the subprocess legitimately streams NOTHING between the tool_use frame and
 * its tool_result, so the window must clear real tool latencies — a wedge is
 * still converted from "hangs forever" into a bounded trip + failover.
 * (Follow-up refinement: suspend the watchdog between tool_use and
 * tool_result — in-process tool execution can't wedge on the model API.)
 * Env override: `LUNA_TURN_INACTIVITY_TIMEOUT_MS`; `0` disables.
 */
const DEFAULT_TURN_INACTIVITY_TIMEOUT_MS = 300_000

/**
 * Inactivity window used INSTEAD of the turn window while ≥1 Task/Agent
 * subagent call is outstanding. While the parent waits on a subagent, the
 * stream legitimately goes silent for the subagent's whole model call
 * (live-probed: nothing flows between `task_started` and the settling
 * tool_result unless the subagent itself uses tools) — a long-thinking
 * subagent would trip the 300s window and cost a 15-min account cooldown.
 * Still bounded: a genuinely wedged subprocess trips after this window.
 * Never shorter than the turn window. Env override:
 * `LUNA_TASK_INACTIVITY_TIMEOUT_MS`.
 */
const DEFAULT_TASK_INACTIVITY_TIMEOUT_MS = 1_800_000

/**
 * Cooldown parked on the acquired account when the inactivity watchdog trips,
 * so the next message fails over to a healthy account instead of re-wedging on
 * the same usage-limited one. 15 min ≫ a transient 429's retry-after — a hang
 * is not transient (observed 200-700s, SIGKILL-only). Env override:
 * `LUNA_HANG_COOLDOWN_MS`.
 */
const DEFAULT_HANG_COOLDOWN_MS = 900_000

/**
 * Parse a non-negative-ms env var (watchdog window: `0` is a meaningful
 * "disable", so an explicit 0 is honored; absent/non-numeric ⇒ fallback).
 */
const readNonNegativeMsEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback
}

/** Parse a strictly-positive-ms env var (cooldown; 0/negative ⇒ fallback). */
const readPositiveMsEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback
}

export interface QueryRequest {
  readonly sessionId: string
  readonly prompt: Stream.Stream<SDKUserMessage>
  readonly sessionOptions: SessionOptions
  /** If present, the SDK resumes this session id instead of starting fresh. */
  readonly resumeFromSessionId?: string
  /**
   * §0.2 sticky-pin. If set, the broker is asked to acquire this specific
   * account (preserves SDK cache warmth). Only honored when the broker is
   * bound via `SDKAdapter.WithBroker`; ignored by `SDKAdapter.Default`.
   */
  readonly boundAccountId?: string
  /**
   * Invoked at most once per query with the SDK's own session id, captured
   * from the first message that carries one. Used by the chat-server to
   * persist a `lunaThreadId → sdkSessionId` mapping so threads can be
   * resumed across server restarts via `resumeFromSessionId`.
   *
   * Callback is best-effort: errors must not poison the message stream.
   */
  readonly onSdkSessionId?: (sdkSessionId: string) => void
  /**
   * Invoked when the §12.2 #2 SessionStore mirror write fails for a message.
   * The stream still yields the message — a mirror-write failure must not kill
   * the user's turn — but the loss is no longer swallowed silently. Defaults to
   * logging the cause via `Effect.logError`. Best-effort: must not fail.
   */
  readonly onMirrorError?: (
    msg: SDKMessage,
    cause: unknown,
  ) => Effect.Effect<void>
  /**
   * Invoked at least once per query, immediately after broker account
   * acquisition, surfacing which account was picked and whether the broker
   * sees a viable failover target for it (the same `failoverPossible` the
   * BLOCKER #1 cooldown gate below uses - see `throttleFailoverPossible`).
   * Chat-service's per-turn rotation loop needs this BEFORE any message
   * streams: a `boundAccountId` pin or a single-account pool must never
   * spawn a rotation retry that just re-acquires the same exhausted
   * account. Never fired when no broker is bound (`SDKAdapter.Default`).
   *
   * RE-FIRED with a FRESHLY recomputed `failoverPossible` immediately before
   * a throttle-classified terminal failure is surfaced (see
   * `reportRateLimitIfThrottled` below). This matters because the ordinary
   * chat path keeps ONE query alive for a thread's whole life - the acquire
   * that fired the FIRST call can be arbitrarily old by the time a failure
   * happens, and the pool's cooldown state moves on in the meantime. A
   * caller using this callback to decide whether to rotate must always read
   * the LATEST invocation's value, never cache the first one.
   *
   * Best-effort: errors must not poison the query.
   */
  readonly onAccountAcquired?: (info: {
    readonly accountId: string
    readonly failoverPossible: boolean
  }) => void
}

interface HookRegistration {
  readonly event: HookEvent
  readonly matcher: string | RegExp | undefined
  readonly handler: HookCallback
}

export interface SDKAdapterService {
  /**
   * Primary entry: Stream in, Stream out. The returned Stream is scoped —
   * closing the Scope aborts the underlying subprocess.
   */
  readonly query: (
    req: QueryRequest,
  ) => Effect.Effect<Stream.Stream<SDKMessage, SDKError>, SDKError, Scope.Scope>

  /** Register a hook callback. Callback returns typed hook output. */
  readonly registerHook: (
    event: HookEvent,
    matcher: string | RegExp | undefined,
    handler: HookCallback,
  ) => Effect.Effect<void, never, Scope.Scope>

  /** Install the permission callback applied to future queries. */
  readonly setPermissionCallback: (
    cb: (
      toolName: string,
      input: Record<string, unknown>,
    ) => Effect.Effect<PermissionResult, never>,
  ) => Effect.Effect<void, never>

  /** Retrieve the live Query handle for a session (for interrupt / ask-flows). */
  readonly getQueryHandle: (
    sessionId: string,
  ) => Effect.Effect<Query | null, never>
}

/**
 * Default mirror-failure handler: log the loss instead of swallowing it.
 * Overridable per-query via `QueryRequest.onMirrorError`.
 */
const defaultMirrorError = (
  msg: SDKMessage,
  cause: unknown,
): Effect.Effect<void> =>
  Effect.logError(
    `[SDKAdapter] SessionStore mirror append failed (message ${sdkMessageId(
      msg,
    )}); message was streamed but NOT persisted: ${String(cause)}`,
  )

/**
 * Shared adapter body. The only thing that differs between `Default` and
 * `WithBroker` is whether `AccountBroker` is acquired and whether the
 * env-overlay step runs. We pass the optional broker handle in via the
 * helper signature so the two layer factories share one implementation.
 */
const makeAdapter = (broker: AccountBrokerApi | null) =>
  Effect.gen(function* () {
      const client = yield* SDKClient
      const store = yield* SessionStore

      // Provider env (gateway URLs + LUNA_MODEL_PROVIDER_MAP) is immutable for
      // the process — parse once at layer build instead of per turn.
      const providerEnv = readProviderEnv()

      // Turn-inactivity watchdog process defaults (immutable for the process —
      // read once here; a per-query sessionOptions value overrides them).
      const envTurnInactivityMs = readNonNegativeMsEnv(
        "LUNA_TURN_INACTIVITY_TIMEOUT_MS",
        DEFAULT_TURN_INACTIVITY_TIMEOUT_MS,
      )
      const envHangCooldownMs = readPositiveMsEnv(
        "LUNA_HANG_COOLDOWN_MS",
        DEFAULT_HANG_COOLDOWN_MS,
      )
      const envTaskInactivityMs = readPositiveMsEnv(
        "LUNA_TASK_INACTIVITY_TIMEOUT_MS",
        DEFAULT_TASK_INACTIVITY_TIMEOUT_MS,
      )

      const hooksRef = yield* Ref.make<ReadonlyArray<HookRegistration>>([])
      const permissionCbRef = yield* Ref.make<
        | ((
            toolName: string,
            input: Record<string, unknown>,
          ) => Effect.Effect<PermissionResult, never>)
        | null
      >(null)
      const handlesRef = yield* Ref.make<ReadonlyMap<string, Query>>(new Map())

      const registerHook = (
        event: HookEvent,
        matcher: string | RegExp | undefined,
        handler: HookCallback,
      ): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function* () {
          const reg: HookRegistration = { event, matcher, handler }
          yield* Ref.update(hooksRef, (prev) => [...prev, reg])
          yield* Effect.addFinalizer(() =>
            Ref.update(hooksRef, (prev) => prev.filter((r) => r !== reg)),
          )
        })

      const setPermissionCallback: SDKAdapterService["setPermissionCallback"] =
        (cb) => Ref.set(permissionCbRef, cb)

      const getQueryHandle = (
        sessionId: string,
      ): Effect.Effect<Query | null, never> =>
        Ref.get(handlesRef).pipe(
          Effect.map((m) => m.get(sessionId) ?? null),
        )

      /**
       * Build the `hooks` SDK field from our registered hooks.
       * SDK shape: `Partial<Record<HookEvent, HookCallbackMatcher[]>>`.
       */
      const buildHooksField = (
        regs: ReadonlyArray<HookRegistration>,
      ): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
        const grouped: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {}
        for (const r of regs) {
          const matcherStr =
            typeof r.matcher === "string"
              ? r.matcher
              : r.matcher instanceof RegExp
                ? r.matcher.source
                : undefined
          const entry: HookCallbackMatcher = matcherStr
            ? { matcher: matcherStr, hooks: [r.handler] }
            : { hooks: [r.handler] }
          const bucket = grouped[r.event] ?? []
          bucket.push(entry)
          grouped[r.event] = bucket
        }
        return grouped
      }

      const buildCanUseTool = (
        cb:
          | ((
              toolName: string,
              input: Record<string, unknown>,
            ) => Effect.Effect<PermissionResult, never>)
          | null,
      ): CanUseTool | undefined => {
        if (!cb) return undefined
        return async (toolName, input) =>
          Effect.runPromise(cb(toolName, input))
      }

      const query: SDKAdapterService["query"] = (req) =>
        Effect.gen(function* () {
          const abortController = new AbortController()
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => abortController.abort()),
          )

          const hookRegs = yield* Ref.get(hooksRef)
          const permCb = yield* Ref.get(permissionCbRef)

          const overrides: Partial<Options> = {
            abortController,
            hooks: buildHooksField(hookRegs),
          }
          const maybeCanUseTool = buildCanUseTool(permCb)
          if (maybeCanUseTool) overrides.canUseTool = maybeCanUseTool
          if (req.resumeFromSessionId)
            overrides.resume = req.resumeFromSessionId

          /**
           * Broker integration (§0.2 / §3.1 / §6.1). Acquire the credential
           * INSIDE this Effect.gen so the credential's inFlight finalizer
           * attaches to the query Scope (§3.4 #1). Build the env overlay
           * from the broker-owned token set and slot it into `overrides`.
           *
           * `acquiredAccountId` is captured so the producer below can emit
           * `broker.report({kind: "success" | "error"})` per stream
           * outcome — see lifecycle comment near `runProducer`.
           */
          let acquiredAccountId: string | null = null
          // B4: the winning chain step's model, captured so the result-frame
          // usage report can price the turn against the model actually used.
          let acquiredModel: string | null = null
          // B4: the winning step's effective budget, echoed into the usage
          // report so the meter enforces the PER-STEP overflow-chain budget.
          let acquiredBudgetUsd: number | null = null
          // B9 gate (review BLOCKER #1): only cool-on-throttle when the broker
          // says failover is VIABLE — the chain can yield a different account
          // if this one cools. Set from the acquire below; defaults false so
          // the no-chain path never cools.
          let throttleFailoverPossible = false
          // Lane string used by `reportRateLimitIfThrottled`'s read-only
          // re-check (below) to recompute failoverPossible AT FAILURE TIME
          // instead of trusting the acquire-time snapshot above, via the
          // broker's `peekFailoverPossible` (the CANONICAL `pickLaneTarget`
          // selection, never a private re-derivation - see that method's
          // doc comment). Only set when a broker is bound AND the request
          // is unbound/Auto - a `boundAccountId` pin never rotates, so no
          // re-check is needed.
          let recheckLane: string | null = null
          if (broker !== null) {
            // Model string is used for broker policy routing; SDK uses
            // Options.model separately. Default when caller omitted it.
            const brokerModel =
              (req.sessionOptions.sdkOptions?.model as string | undefined) ??
              "default"
            const acquireOpts: {
              model: string
              boundAccountId?: string
            } = { model: brokerModel }
            if (req.boundAccountId !== undefined) {
              acquireOpts.boundAccountId = req.boundAccountId
            }
            const acq = yield* broker
              .acquireSession(acquireOpts)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new SDKError({
                      op: "acquire-session",
                      sessionId: req.sessionId,
                      cause,
                    }),
                ),
              )
            acquiredAccountId = acq.credential.accountId
            if (req.boundAccountId === undefined) {
              recheckLane = brokerModel
            }
            // B7: the broker resolved the winning chain step's model — point the
            // SDK at it. `mergeOptions` lets overrides win. `acquiredModel` is
            // ALWAYS the winning model (used by the B4 result-frame pricing).
            acquiredModel = acq.model
            acquiredBudgetUsd = acq.budgetUsd ?? null
            // BLOCKER #1, deepened: the broker computed failover VIABILITY at
            // pick time (chain exists AND another un-cooled target remains with
            // this account excluded). Chain existence alone was not enough — a
            // one-account chain cooled its sole account on a transient 429,
            // manufacturing the exact outage the gate was added to prevent, and
            // starving the wake/dream lanes sharing that account.
            throttleFailoverPossible = acq.failoverPossible === true
            if (req.onAccountAcquired !== undefined) {
              try {
                req.onAccountAcquired({
                  accountId: acq.credential.accountId,
                  failoverPossible: throttleFailoverPossible,
                })
              } catch {
                // Best-effort - callback failures must not break the stream.
              }
            }
            // Only WRITE overrides.model when the caller actually supplied a
            // model OR the chain changed it away from the lane default. This
            // keeps the no-chain + caller-omits-model path BYTE-IDENTICAL: today
            // that path leaves Options.model unset, so we must not inject
            // "default" here. The literal "default" is the broker's default-lane
            // SENTINEL (same convention as the reasoners' model gate) — it is
            // never a real model id, so it must not reach the SDK even when a
            // caller (e.g. a forked recovery thread) supplied it explicitly.
            const callerSuppliedModel =
              (req.sessionOptions.sdkOptions?.model as string | undefined) !==
              undefined
            if (
              (callerSuppliedModel || acq.model !== brokerModel) &&
              acq.model !== "default"
            ) {
              // Strip luna's routing token (`local/` / `:cloud`) from the wire
              // model — the SELECTOR string is not a name the ollama endpoints
              // know. acquiredModel (line above) keeps acq.model for B4 pricing;
              // only the SDK-bound value is normalized.
              overrides.model = toWireModel(acq.model, acq.credential.kind)
            } else if (
              acq.model === "default" &&
              acq.credential.kind === ANTHROPIC_KIND
            ) {
              // Default-lane preference (#253): the lane resolved to the bare
              // "default" sentinel (no overflow-chain step redirected it) on a
              // NATIVE Anthropic account — Sonnet 5 is available, so prefer the
              // daily-driver default over the SDK's own default model. Gated on
              // the credential KIND: a default lane an operator mapped to a
              // non-Anthropic provider (LUNA_MODEL_PROVIDER_MAP "default=...")
              // keeps Options.model unset — that provider decides its default.
              // acquiredModel follows so the B4 usage report prices the model
              // the turn actually ran on, not the "default" alias tier.
              overrides.model = DEFAULT_LANE_PREFERRED_MODEL
              acquiredModel = DEFAULT_LANE_PREFERRED_MODEL
            }
            // B8: the broker advanced past a previously-used chain step → log a
            // warning so an operator sees budget/throttle-driven failover. (The
            // adapter has no Observability dependency, so this is a log line, not
            // an emitted AccountSwitch event.) Only fires when a chain is
            // configured AND the winning step differs from the lane's last.
            if (
              acq.advancedFrom !== undefined &&
              acq.advancedFrom !== acq.stepIndex
            ) {
              yield* Effect.logWarning(
                `[SDKAdapter] overflow chain advanced for lane "${brokerModel}": ` +
                  `step ${acq.advancedFrom} → ${acq.stepIndex} ` +
                  `(now using account ${acq.credential.accountId}, model ${acq.model})`,
              )
            }
            if (acq.credential.secretRef !== CLAUDE_CODE_LOGIN_SECRET_REF) {
              // PROVIDER ROUTING: the credential's KIND (the broker's routing
              // key for the winning chain step) selects a ProviderProfile that
              // decides which env var the secret is injected into and whether to
              // point the SDK at a non-Anthropic base URL. Building from the
              // credential's kind (NOT resolveProfile(brokerModel)) makes the
              // overlay follow the account the chain actually picked. The native
              // Anthropic profile (authVar=CLAUDE_CODE_OAUTH_TOKEN, no baseUrl)
              // reproduces the prior behavior exactly for anthropic accounts.
              const profile = profileForKind(
                acq.credential.kind,
                providerEnv,
              )
              // SECRET HYGIENE: the secret is unwrapped ONLY inside
              // `buildBrokerEnvOverlay` — the single `Redacted.value` site
              // (grep-gated). The profile selects the auth-var NAME and adds
              // non-secret base-URL / extra env; the plaintext is handed
              // straight to the SDK Options env and never stored/logged.
              const brokerOwnedEnv = buildBrokerEnvOverlay(
                profile,
                acq.credential.resolvedSecret,
              )
              const callerEnv = req.sessionOptions.sdkOptions?.env as
                | Readonly<Record<string, string | undefined>>
                | undefined
              // SDK Options.env is REPLACE, not merge: the subprocess sees
              // ONLY what we pass. Base = inherited process.env with auth
              // vars scrubbed, caller env on top; broker overlay above both
              // (collision warnings still fire for caller-set broker keys).
              const mergedEnv = yield* mergeEnvOverlayLogged(
                buildBrokerBaseEnv(callerEnv),
                brokerOwnedEnv,
              )
              overrides.env = mergedEnv
            }
          }

          const agentDefs = loadAgents()
          if (Object.keys(agentDefs).length > 0) {
            overrides.agents = agentDefs
          }

          const mergedOpts = yield* mergeOptionsLogged(
            req.sessionOptions.sdkOptions,
            overrides,
          )
          // "default" is the broker's default-lane SENTINEL, never a real model
          // id. A caller-persisted "default" (ui-web custom-model field, a
          // forked recovery thread) must run on the SDK's own default model —
          // exactly the pre-provider-seam behavior — not be sent verbatim.
          if ((mergedOpts as { model?: unknown }).model === "default") {
            delete (mergedOpts as { model?: unknown }).model
          }

          /**
           * Turn-aware inactivity watchdog state (chat threads only — see the
           * consumer below). `turnInFlight` is the ARM bit: true while we are
           * mid-turn (a user prompt was offered and no `result` frame has
           * closed it), false between turns. The prompt-tap arms it; the
           * consumer disarms it on a `result` frame. JS is single-threaded and
           * the producer/consumer/prompt-tap all run inside this query Scope,
           * so a plain mutable object is race-free (same convention as the
           * `acquiredAccountId` / `reportedSdkSessionId` locals above).
           */
          const watchdog = {
            turnInFlight: false,
            /**
             * tool_use ids of Task/Agent subagent calls that have NOT yet
             * received their tool_result. While non-empty, the consumer's
             * inactivity window widens to `taskInactivityMs` (a subagent's
             * model call legitimately streams nothing on the parent stream).
             * Same single-threaded-Scope convention as `turnInFlight`.
             */
            pendingTaskIds: new Set<string>(),
          }

          // Stream → AsyncIterable for the SDK to consume. Tap each outbound
          // user prompt to ARM the watchdog: a freshly-submitted turn is now
          // expecting a response. The tap is a pass-through — it never alters
          // or drops the message handed to the SDK.
          const promptIterable = yield* Stream.toAsyncIterableEffect(
            req.prompt.pipe(
              Stream.tap(() =>
                Effect.sync(() => {
                  watchdog.turnInFlight = true
                }),
              ),
            ),
          )

          const params: QueryParams = {
            prompt: promptIterable,
            options: mergedOpts,
          }

          const handle = yield* client.query(params).pipe(
            Effect.mapError((cause) =>
              new SDKError({ op: "query", sessionId: req.sessionId, cause }),
            ),
          )

          yield* Ref.update(handlesRef, (m) => {
            const next = new Map(m)
            next.set(req.sessionId, handle)
            return next
          })
          yield* Effect.addFinalizer(() =>
            Ref.update(handlesRef, (m) => {
              const next = new Map(m)
              next.delete(req.sessionId)
              return next
            }),
          )

          const idleMs =
            req.sessionOptions.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
          const idleTimeoutDisabled =
            req.sessionOptions.disableIdleTimeout === true
          const sessionIdForErr = req.sessionId

          /**
           * Turn-inactivity watchdog config. ONLY engaged on the
           * `disableIdleTimeout` path (chat threads) — the always-on idle
           * timeout already covers every other caller (reasoner lanes use
           * runBoundedQuery, not this adapter, so they are untouched either
           * way). sessionOptions wins over the process-env default; `0`
           * disables (legacy behavior — a hang is not converted). Active only
           * when both the chat opt-out is set AND the window is positive.
           */
          const turnInactivityMs =
            req.sessionOptions.turnInactivityTimeoutMs ?? envTurnInactivityMs
          const hangCooldownMs =
            req.sessionOptions.hangCooldownMs ?? envHangCooldownMs
          const watchdogActive = idleTimeoutDisabled && turnInactivityMs > 0
          // Subagent-aware window: while a Task/Agent call is outstanding the
          // window is this instead of turnInactivityMs. Clamped to never be
          // shorter than the turn window (an operator who widened the turn
          // window must not get a TIGHTER one during subagents).
          const taskInactivityMs = Math.max(turnInactivityMs, envTaskInactivityMs)

          /**
           * Producer pattern: a detached async function pushes from the SDK's
           * AsyncIterable into an Effect Queue. The Stream consumer reads
           * from the Queue — a Queue.take IS interruptible, so `timeoutFail`
           * can fire even when the upstream promise is wedged.
           *
           * The producer runs as a bare Promise (not an Effect) so the
           * hanging `for await` doesn't poison the fiber; we detach it via
           * the AbortController — when the Scope closes we abort, and the
           * SDK's own abort plumbing is expected to unblock the iterator.
           * If the SDK DOES NOT honor the abort (known risk), the producer
           * promise is orphaned; acceptable because the Queue is GC'd.
           */
          type Frame =
            | { readonly _tag: "value"; readonly value: SDKMessage }
            | { readonly _tag: "end" }
            | { readonly _tag: "error"; readonly err: SDKError }

          const queue = yield* Queue.unbounded<Frame>()

          /**
           * `broker.report` is fire-and-forget at stream lifecycle edges.
           * We do NOT attach it to the Scope finalizer because Scope close
           * does not distinguish success from error; we want kind="success"
           * on clean end and kind="error" on terminal stream error.
           */
          const reportSuccess = () => {
            if (broker !== null && acquiredAccountId !== null) {
              const id = acquiredAccountId
              Effect.runPromise(
                broker.report({ accountId: id, kind: "success" }),
              ).catch(() => {})
            }
          }
          const reportError = () => {
            if (broker !== null && acquiredAccountId !== null) {
              const id = acquiredAccountId
              Effect.runPromise(
                broker.report({ accountId: id, kind: "error" }),
              ).catch(() => {})
            }
          }

          /**
           * B4: spend-meter usage report at the SDK `result` frame. The result
           * message carries the whole-turn token totals under `.usage` (same
           * field names chat-service reads). We price the turn against the model
           * the broker actually picked (`acquiredModel`) and fire-and-forget the
           * report — same pattern as reportSuccess (errors swallowed; a metering
           * failure must never poison the user's turn).
           */
          const reportUsage = (msg: SDKMessage) => {
            if (
              broker === null ||
              acquiredAccountId === null ||
              acquiredModel === null
            ) {
              return
            }
            if (sdkMessageKind(msg) !== "result") return
            const u = (msg as { usage?: {
              input_tokens?: number
              output_tokens?: number
              cache_creation_input_tokens?: number
              cache_read_input_tokens?: number
            } }).usage
            if (!u) return
            const id = acquiredAccountId
            // Price against the model that ACTUALLY served the turn when the
            // result frame's modelUsage reports exactly one (alias lanes like
            // "default"/"opus" otherwise price at a tier default).
            // Multi-model turns (a Task subagent on a different model):
            // report ONE usage per modelUsage entry, each priced at its own
            // model, instead of collapsing the aggregate onto the lane model
            // — a haiku-lane thread spawning an opus subagent must not bill
            // opus tokens at haiku rates against the account budget. The
            // entries partition the turn's tokens, so the spend-meter's
            // accumulated total matches the old aggregate count.
            const mu = (msg as { modelUsage?: Record<string, {
              inputTokens?: number
              outputTokens?: number
              cacheReadInputTokens?: number
              cacheCreationInputTokens?: number
            }> }).modelUsage
            const muKeys = mu ? Object.keys(mu) : []
            if (mu && muKeys.length > 1) {
              for (const [model, pm] of Object.entries(mu)) {
                Effect.runPromise(
                  broker.report({
                    accountId: id,
                    kind: "usage",
                    model,
                    tokensIn: pm.inputTokens ?? 0,
                    tokensOut: pm.outputTokens ?? 0,
                    cacheRead: pm.cacheReadInputTokens ?? 0,
                    cacheWrite: pm.cacheCreationInputTokens ?? 0,
                    ...(acquiredBudgetUsd !== null
                      ? { budgetUsd: acquiredBudgetUsd }
                      : {}),
                  }),
                ).catch(() => {})
              }
              return
            }
            const model =
              muKeys.length === 1 ? muKeys[0]! : acquiredModel
            Effect.runPromise(
              broker.report({
                accountId: id,
                kind: "usage",
                model,
                tokensIn: u.input_tokens ?? 0,
                tokensOut: u.output_tokens ?? 0,
                cacheRead: u.cache_read_input_tokens ?? 0,
                cacheWrite: u.cache_creation_input_tokens ?? 0,
                ...(acquiredBudgetUsd !== null
                  ? { budgetUsd: acquiredBudgetUsd }
                  : {}),
              }),
            ).catch(() => {})
          }

          /**
           * B9: if the terminal stream error classifies as a throttle (shared
           * `classifyThrottle` — 429/529, rate-limit/overload phrasing, clamped
           * retry-after), additionally report a rate_limit so the broker cools
           * the account down and the overflow chain advances on the next
           * acquire.
           *
           * AWAITED by the caller (unlike reportSuccess/reportError/reportUsage
           * above, which stay fire-and-forget) - a rotation-driven retry
           * re-acquires immediately after the caller's `await` returns, so the
           * cooldown write here MUST be committed first. Fire-and-forget would
           * let the re-acquire race the in-flight `broker.report` Promise and
           * possibly re-pick the very account that just got throttled.
           *
           * After the cooldown commits, ALSO does a READ-ONLY
           * `broker.peekFailoverPossible` call (never mutates the pool - no
           * acquire, no inFlight bump, no lastUsedMs touch) purely to find
           * out whether a DIFFERENT viable account exists RIGHT NOW, and
           * re-fires `onAccountAcquired` with that fresh reading - see the
           * doc comment on `onAccountAcquired`. `peekFailoverPossible` reuses
           * the SAME `pickLaneTarget`/`pickChainTarget` selection
           * `acquireSession` runs (never a private re-derivation off
           * `list()` - a prior kind-filtered `list().some(...)` re-check
           * drifted from the canonical predicate on both a cross-kind
           * `LUNA_OVERFLOW_CHAINS` step and a pinned+off-chain-sibling case).
           * Deliberately NOT a speculative `acquireSession`: an acquire+
           * release still WRITES `lastUsedMs` on whichever account it picks
           * (the release only undoes the `inFlight` bump), so a throwaway
           * viability check would silently perturb the broker's real
           * round-robin ordering for the account it happens to touch -
           * bumping it to the back of the LRU queue for no traffic reason.
           * `peekFailoverPossible` only reads the pool Ref, so this check
           * can never change which account the REAL rotation acquire below
           * actually picks.
           */
          const reportRateLimitIfThrottled = async (
            cause: unknown,
          ): Promise<void> => {
            if (broker === null || acquiredAccountId === null) return
            // BLOCKER #1: only cool when failover is VIABLE (another un-cooled
            // chain target exists — broker-computed at pick time). Otherwise
            // cooling the sole account on a transient throttle manufactures a
            // ~60s outage — strictly worse than the pre-change no-op, and
            // breaks no-config byte-identical behavior.
            if (!throttleFailoverPossible) return
            const cls = classifyThrottle(cause)
            if (!cls.throttled) return
            const id = acquiredAccountId
            await Effect.runPromise(
              broker.report({
                accountId: id,
                kind: cls.kind ?? "rate_limit",
                ...(cls.retryAfterMs !== undefined
                  ? { retryAfterMs: cls.retryAfterMs }
                  : {}),
              }),
            ).catch(() => {})
            if (req.onAccountAcquired === undefined || recheckLane === null) {
              return
            }
            const freshFailoverPossible = await Effect.runPromise(
              broker.peekFailoverPossible({ model: recheckLane }),
            ).catch(() => false)
            try {
              req.onAccountAcquired({
                accountId: id,
                failoverPossible: freshFailoverPossible,
              })
            } catch {
              // Best-effort - callback failures must not break the stream.
            }
          }

          /**
           * Inactivity-watchdog trip: cool the acquired account so the NEXT
           * message fails over to a healthy one. Fire-and-forget (a metering
           * failure must not poison the already-dead turn).
           *
           * UNLIKE the B9 throttle path, this does NOT gate on
           * `throttleFailoverPossible`. A hang is categorically different from
           * a transient 429: the turn is already dead (no retry is in flight),
           * so cooling a sole account cannot make things worse — it only stops
           * the next turn from re-picking the same wedged account. With no
           * failover target the next acquire surfaces AllAccountsExhausted (a
           * clean error), which is strictly better than another silent hang.
           */
          const reportHangCooldown = () => {
            if (broker === null || acquiredAccountId === null) return
            const id = acquiredAccountId
            Effect.runPromise(
              broker.report({
                accountId: id,
                kind: "rate_limit",
                retryAfterMs: hangCooldownMs,
              }),
            ).catch(() => {})
          }

          const runProducer = async () => {
            try {
              for await (const msg of handle as AsyncIterable<SDKMessage>) {
                // B4: meter the turn at the result frame (fire-and-forget).
                reportUsage(msg)
                // Subagent tracking for the watchdog window: an assistant
                // message opens a pending Task per Agent/Task tool_use; a
                // user message's tool_result blocks settle them. Parented
                // (subagent-internal) spawns count too — a nested Task keeps
                // the turn legitimately silent the same way.
                for (const id of sdkAgentSpawnIds(msg)) {
                  watchdog.pendingTaskIds.add(id)
                }
                for (const id of sdkToolResultIds(msg)) {
                  watchdog.pendingTaskIds.delete(id)
                }
                // Watchdog DISARM: a `result` frame closes the turn. After it,
                // the stream waits for the NEXT user prompt (inter-turn
                // think-time), which must NOT trip the inactivity watchdog. The
                // prompt-tap re-arms on the next submitted turn. Pending Task
                // ids are cleared too: an aborted turn must not leak a wide
                // window into the next one. (Interrupt is covered: live-probed
                // on SDK 0.3.175, Query.interrupt() mid-Task emits a synthetic
                // settling tool_result AND a result/error_during_execution
                // frame, so both clear paths fire.)
                if (sdkMessageKind(msg) === "result") {
                  watchdog.turnInFlight = false
                  watchdog.pendingTaskIds.clear()
                }
                await Effect.runPromise(
                  Queue.offer(queue, { _tag: "value", value: msg }),
                )
              }
              reportSuccess()
              await Effect.runPromise(Queue.offer(queue, { _tag: "end" }))
            } catch (cause) {
              reportError()
              // B9: classify a 429 / quota / overloaded terminal failure and
              // additionally report it as a rate_limit so the broker cools the
              // account down (the chain advances on the next acquire). Best-
              // effort: a classification miss just skips the extra report.
              //
              // AWAITED (unlike reportError above): the cooldown write and the
              // fresh failoverPossible re-check it enables (see the doc
              // comment on `reportRateLimitIfThrottled`) must both land BEFORE
              // the error frame below reaches the caller - otherwise a
              // rotation-driven retry can race the cooldown write and re-pick
              // the account that just got throttled.
              await reportRateLimitIfThrottled(cause)
              await Effect.runPromise(
                Queue.offer(queue, {
                  _tag: "error",
                  err: new SDKError({
                    op: "iterate",
                    sessionId: sessionIdForErr,
                    cause,
                  }),
                }),
              ).catch(() => {})
            }
          }
          // Fire-and-forget. Orphan is fine; Scope-tied AbortController
          // signals the SDK to stop, and if it doesn't, the Queue is
          // isolated and will be GC'd once the Scope's Ref releases it.
          void runProducer()

          // Decode one Queue frame into the repeatEffectOption shape: a value,
          // `None` for clean end, or `Some(err)` for a terminal error.
          const decodeFrame = (
            frame: Frame,
          ): Effect.Effect<SDKMessage, Option.Option<SDKError>> => {
            switch (frame._tag) {
              case "value":
                return Effect.succeed(frame.value)
              case "end":
                return Effect.fail(Option.none<SDKError>())
              case "error":
                return Effect.fail(Option.some(frame.err))
            }
          }

          /**
           * Consumer take, three modes:
           *
           *  1. NON-chat (idle timeout on): the original §12.2 #5 idle race —
           *     every Queue.take is bounded by `idleMs`, resets on each
           *     message. Byte-identical to before.
           *
           *  2. Chat + watchdog OFF (`turnInactivityTimeoutMs`/env = 0): a
           *     plain blocking take — legacy `disableIdleTimeout` behavior, a
           *     hang is NOT converted.
           *
           *  3. Chat + watchdog ON: the TURN-AWARE inactivity watchdog. Each
           *     take is raced against `turnInactivityMs`. On expiry we re-read
           *     the arm bit: if a turn is STILL in flight (no `result` closed
           *     it), the subprocess is presumed wedged → abort it, cool the
           *     account, and fail the turn with a clean SDKError. If the turn
           *     already ended (disarmed — we are between turns waiting on the
           *     next prompt), the expiry is benign: loop and block again, so
           *     hours-long think-time never trips. Activity (any frame) lands
           *     in the Queue and satisfies the take, resetting the window.
           */
          const pullOne: Effect.Effect<
            SDKMessage,
            Option.Option<SDKError>
          > = !idleTimeoutDisabled
            ? Queue.take(queue).pipe(
                Effect.timeoutFail({
                  onTimeout: (): Option.Option<SDKError> =>
                    Option.some(
                      new SDKError({
                        op: "idle-timeout",
                        sessionId: sessionIdForErr,
                        cause: `no message for ${idleMs}ms`,
                      }),
                    ),
                  duration: idleMs,
                }),
                Effect.flatMap(decodeFrame),
              )
            : !watchdogActive
              ? Queue.take(queue).pipe(Effect.flatMap(decodeFrame))
              : Effect.gen(function* () {
                  // Loop so a benign (disarmed) expiry re-blocks instead of
                  // tripping — only an expiry WHILE a turn is in flight is a
                  // hang.
                  while (true) {
                    // Window picked per take: while ≥1 subagent (Task/Agent
                    // call) is outstanding the parent stream is legitimately
                    // silent for the subagent's whole model call, so the
                    // wider task window applies. Re-evaluated every loop —
                    // the set shrinks as results land, restoring the tight
                    // window for the rest of the turn.
                    const windowMs =
                      watchdog.pendingTaskIds.size > 0
                        ? taskInactivityMs
                        : turnInactivityMs
                    const taken = yield* Queue.take(queue).pipe(
                      Effect.timeoutOption(Duration.millis(windowMs)),
                    )
                    if (Option.isSome(taken)) {
                      return yield* decodeFrame(taken.value)
                    }
                    if (!watchdog.turnInFlight) {
                      // Between turns — not a hang. Block again.
                      continue
                    }
                    if (
                      watchdog.pendingTaskIds.size > 0 &&
                      windowMs < taskInactivityMs
                    ) {
                      // A Task started DURING this take's tight window — the
                      // silence may be the subagent working, not a wedge.
                      // Re-take under the wide window before declaring a hang.
                      continue
                    }
                    // TRIP: a turn streamed nothing for the whole window.
                    // Kill the wedged subprocess so it stops burning the
                    // usage-limited account (the Scope finalizer also aborts,
                    // but we do it eagerly at trip time).
                    abortController.abort()
                    // Cool the account so the NEXT message fails over.
                    reportHangCooldown()
                    return yield* Effect.fail(
                      Option.some(
                        new SDKError({
                          op: "inactivity-watchdog",
                          sessionId: sessionIdForErr,
                          cause:
                            `model call stalled (no response for ` +
                            `${windowMs}ms` +
                            (watchdog.pendingTaskIds.size > 0
                              ? ` with ${watchdog.pendingTaskIds.size} subagent(s) outstanding`
                              : "") +
                            `; suspected usage limit on ` +
                            `account ${acquiredAccountId ?? "unknown"}). The ` +
                            `account was cooled — your next message will use ` +
                            `another account. Please resend.`,
                        }),
                      ),
                    )
                  }
                })

          const consumer: Stream.Stream<SDKMessage, SDKError> =
            Stream.repeatEffectOption(pullOne)

          // Capture the SDK's own session_id from the first message that
          // carries one. Fires the optional onSdkSessionId callback exactly
          // once per query so the caller can persist the
          // `lunaThreadId → sdkSessionId` mapping for resume.
          let reportedSdkSessionId = false
          const reportSdkSessionId = (msg: SDKMessage): void => {
            if (reportedSdkSessionId || req.onSdkSessionId === undefined) return
            const sid = sdkMessageSessionId(msg)
            if (sid === null) return
            reportedSdkSessionId = true
            try {
              req.onSdkSessionId(sid)
            } catch {
              // Best-effort — callback failures must not break the stream.
            }
          }

          // Mirror every message to SessionStore (§12.2 #2) before yielding.
          const mirrored: Stream.Stream<SDKMessage, SDKError> = consumer.pipe(
            Stream.tap((msg) =>
              Effect.sync(() => reportSdkSessionId(msg)),
            ),
            Stream.tap((msg) =>
              store
                .appendMessage({
                  sessionId: req.sessionId,
                  messageId: sdkMessageId(msg),
                  ts: Date.now(),
                  parentId: sdkMessageParentId(msg),
                  kind: sdkMessageKind(msg),
                  payload: msg,
                })
                // The mirror is the authoritative log (§12.2 #2). A write
                // failure must NOT kill the user's turn (the message is still
                // streamed), but it must NOT be swallowed silently either —
                // surface it to onMirrorError (default: Effect.logError).
                .pipe(
                  Effect.catchAll((cause) =>
                    (req.onMirrorError ?? defaultMirrorError)(msg, cause),
                  ),
                ),
            ),
          )

          return mirrored
        }).pipe(
          Effect.withSpan("luna.sdk_adapter.query", {
            attributes: {
              "session.id": req.sessionId,
              "session.model": String(
                req.sessionOptions.sdkOptions?.model ?? "default",
              ),
            },
          }),
        )

      return {
        query,
        registerHook,
        setPermissionCallback,
        getQueryHandle,
      } satisfies SDKAdapterService
    })

export class SDKAdapter extends Effect.Tag("luna/SDKAdapter")<
  SDKAdapter,
  SDKAdapterService
>() {
  /**
   * Default layer — no broker integration. Preserves existing behavior:
   * the caller is responsible for providing `CLAUDE_CODE_OAUTH_TOKEN`
   * (or any other env) via `sessionOptions.sdkOptions.env` directly.
   */
  static readonly Default: Layer.Layer<
    SDKAdapter,
    never,
    SDKClient | SessionStore
  > = Layer.scoped(SDKAdapter, makeAdapter(null))

  /**
   * WithBroker layer — adds AccountBroker as a required dependency and
   * wires per-query rotation via the env-overlay mechanism (§0.2). The
   * credential's `inFlight` finalizer attaches to the query Scope
   * (§3.1 / §3.4 #1).
   */
  static readonly WithBroker: Layer.Layer<
    SDKAdapter,
    never,
    SDKClient | SessionStore | AccountBroker
  > = Layer.scoped(
    SDKAdapter,
    Effect.gen(function* () {
      const brokerApi = yield* AccountBroker
      return yield* makeAdapter(brokerApi)
    }),
  )
}
