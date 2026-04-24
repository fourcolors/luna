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
  pipe,
} from "effect"
import {
  MESSAGE_ENVELOPE_VERSION,
  SDKError,
  SessionStore,
  type SessionOptions,
} from "@experiment-agent/core"
import { SDKClient, type QueryParams } from "./sdk-client.js"
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

const DEFAULT_IDLE_TIMEOUT_MS = 120_000

export interface QueryRequest {
  readonly sessionId: string
  readonly prompt: Stream.Stream<SDKUserMessage>
  readonly sessionOptions: SessionOptions
  /** If present, the SDK resumes this session id instead of starting fresh. */
  readonly resumeFromSessionId?: string
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

export class SDKAdapter extends Effect.Tag("experiment-agent/SDKAdapter")<
  SDKAdapter,
  SDKAdapterService
>() {
  static readonly Default: Layer.Layer<
    SDKAdapter,
    never,
    SDKClient | SessionStore
  > = Layer.scoped(
    SDKAdapter,
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
        cb: ReturnType<
          typeof Effect.runSync
        > extends never
          ? never
          :
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

          const runProducer = async () => {
            try {
              for await (const msg of handle as AsyncIterable<SDKMessage>) {
                await Effect.runPromise(
                  Queue.offer(queue, { _tag: "value", value: msg }),
                )
              }
              await Effect.runPromise(Queue.offer(queue, { _tag: "end" }))
            } catch (cause) {
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
          const pullOne: Effect.Effect<SDKMessage, Option.Option<SDKError>> =
            Queue.take(queue).pipe(
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

          // Mirror every message to SessionStore (§12.2 #2) before yielding.
          const mirrored: Stream.Stream<SDKMessage, SDKError> = consumer.pipe(
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
                .pipe(Effect.catchAll(() => Effect.void)),
            ),
          )

          return mirrored
        })

      return {
        query,
        registerHook,
        setPermissionCallback,
        getQueryHandle,
      } satisfies SDKAdapterService
    }),
  )
}

// Keep unused import pruner quiet — `pipe` and `MESSAGE_ENVELOPE_VERSION` and
// `sdkMessageSessionId` are exported helpers some tests/consumers will use.
void pipe
void MESSAGE_ENVELOPE_VERSION
void sdkMessageSessionId
