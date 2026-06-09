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
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect"
import {
  CLAUDE_CODE_LOGIN_SECRET_REF,
  SDKError,
  SessionStore,
  AccountBroker,
  profileForKind,
  readProviderEnv,
  resolveChain,
  readOverflowConfig,
  type AccountBrokerApi,
  type SessionOptions,
} from "@luna/core"
import { SDKClient, type QueryParams } from "./sdk-client.js"
import { buildBrokerEnvOverlay } from "./broker-env-overlay.js"
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
} from "./message-kind.js"
import { mergeOptionsLogged } from "./merge-options.js"
import { mergeEnvOverlayLogged } from "./merge-env.js"
import { loadAgents } from "./agent-loader.js"

const DEFAULT_IDLE_TIMEOUT_MS = 120_000

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
          // B9 gate (review BLOCKER #1): only cool-on-throttle when an overflow
          // chain exists for the lane (somewhere to fail over to). Set in the
          // acquire block below; defaults false so the no-chain path never cools.
          let throttleFailoverPossible = false
          if (broker !== null) {
            // Model string is used for broker policy routing; SDK uses
            // Options.model separately. Default when caller omitted it.
            const brokerModel =
              (req.sessionOptions.sdkOptions?.model as string | undefined) ??
              "default"
            // B9 gate: a configured chain means the operator opted into
            // failover, so cooling a throttled account (below) is desired. With
            // no chain, the old catch was a no-op and the transient simply
            // retried — preserve that to avoid a self-inflicted single-account
            // outage on a transient 429/529.
            throttleFailoverPossible =
              resolveChain(brokerModel, readOverflowConfig()) !== null
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
            // B7: the broker resolved the winning chain step's model — point the
            // SDK at it. `mergeOptions` lets overrides win. `acquiredModel` is
            // ALWAYS the winning model (used by the B4 result-frame pricing).
            acquiredModel = acq.model
            // Only WRITE overrides.model when the caller actually supplied a
            // model OR the chain changed it away from the lane default. This
            // keeps the no-chain + caller-omits-model path BYTE-IDENTICAL: today
            // that path leaves Options.model unset, so we must not inject
            // "default" here.
            const callerSuppliedModel =
              (req.sessionOptions.sdkOptions?.model as string | undefined) !==
              undefined
            if (callerSuppliedModel || acq.model !== brokerModel) {
              overrides.model = acq.model
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
                readProviderEnv(),
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
              const mergedEnv = yield* mergeEnvOverlayLogged(
                callerEnv,
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

          // Stream → AsyncIterable for the SDK to consume.
          const promptIterable = yield* Stream.toAsyncIterableEffect(req.prompt)

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
            const model = acquiredModel
            Effect.runPromise(
              broker.report({
                accountId: id,
                kind: "usage",
                model,
                tokensIn: u.input_tokens ?? 0,
                tokensOut: u.output_tokens ?? 0,
                cacheRead: u.cache_read_input_tokens ?? 0,
                cacheWrite: u.cache_creation_input_tokens ?? 0,
              }),
            ).catch(() => {})
          }

          /**
           * B9: if the terminal stream error looks like a throttle (HTTP 429,
           * "rate limit", "quota", "overloaded"), additionally report a
           * rate_limit so the broker cools the account down and the overflow
           * chain advances on the next acquire. Parses an optional retry-after
           * (seconds → ms) from the cause when present. Fire-and-forget.
           */
          const reportRateLimitIfThrottled = (cause: unknown) => {
            if (broker === null || acquiredAccountId === null) return
            // BLOCKER #1: only cool when failover is possible (a chain exists).
            // Without a chain, cooling the sole account on a transient throttle
            // manufactures a ~60s outage — strictly worse than the pre-change
            // no-op, and breaks no-config byte-identical behavior.
            if (!throttleFailoverPossible) return
            const text = String(
              (cause as { message?: unknown })?.message ?? cause,
            ).toLowerCase()
            // #5: word-boundary status codes + explicit throttle phrases, so
            // "11429 tokens" / "disk quota exceeded" don't false-positive into a
            // cooldown. Anthropic throttles surface as 429 (rate_limit_error) /
            // 529 (overloaded_error).
            const throttled =
              /\b(429|529)\b/.test(text) ||
              text.includes("rate limit") ||
              text.includes("rate_limit") ||
              text.includes("too many requests") ||
              text.includes("overloaded")
            if (!throttled) return
            // Best-effort retry-after parse: "retry-after: 30" / "retry after 30s".
            const m = text.match(/retry[-_ ]?after[^0-9]*([0-9]+)/)
            const retryAfterMs =
              m && m[1] ? Number(m[1]) * 1000 : undefined
            const id = acquiredAccountId
            Effect.runPromise(
              broker.report({
                accountId: id,
                kind: "rate_limit",
                ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
              }),
            ).catch(() => {})
          }

          const runProducer = async () => {
            try {
              for await (const msg of handle as AsyncIterable<SDKMessage>) {
                // B4: meter the turn at the result frame (fire-and-forget).
                reportUsage(msg)
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
              reportRateLimitIfThrottled(cause)
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

          // Consumer stream: repeatEffectOption to signal `done` via None.
          // When `disableIdleTimeout` is true (chat threads), we omit the
          // timeoutFail wrapper so user think-time between turns does not
          // trip §12.2 #5 — Queue.take just blocks until the next message.
          const takeFrame = idleTimeoutDisabled
            ? Queue.take(queue)
            : Queue.take(queue).pipe(
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
              )
          const pullOne: Effect.Effect<SDKMessage, Option.Option<SDKError>> =
            takeFrame.pipe(
              Effect.flatMap((frame) => {
                switch (frame._tag) {
                  case "value":
                    return Effect.succeed(frame.value)
                  case "end":
                    return Effect.fail(Option.none<SDKError>())
                  case "error":
                    return Effect.fail(Option.some(frame.err))
                }
              }),
            )

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
