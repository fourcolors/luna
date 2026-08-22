/**
 * Account-rotation regression test (RED).
 *
 * BUG: the ORDINARY long-lived-query chat path (chat-service.ts:1238-1250)
 * makes exactly ONE `adapter.query()` call for a thread's entire life -
 * `prompt: promptStream` is `Stream.fromQueue(inbox)`, a queue-backed stream
 * (chat-service.ts:1035-1037). When the SDK subprocess behind that single
 * long-lived query dies on an early, rotatable throttle (a session-limit
 * error) BEFORE streaming any assistant content, `handleAdapterFailure`
 * (chat-service.ts:1145) is terminal: it logs, emits an `assistant-error`
 * frame, and drains the `pendingTurns` observation seed - but it never
 * restarts the query or re-offers the user's turn. The forked fiber
 * consuming `replies` (chat-service.ts:1250) simply ends. The user's
 * message is silently dropped; nothing ever answers it.
 *
 * THE FIX (per the agreed design) adds rotation to the ordinary path: on an
 * early, rotatable throttle with no assistant content yet streamed for the
 * in-flight turn, chat-service re-offers that turn's payload onto its OWN
 * `inbox` and restarts the session query on a fresh account - gated on
 * broker-active + failoverPossible + a rotatable cause + a turn in flight +
 * no assistant content + attempts remaining. This test proves the CURRENT
 * absence of that behavior and is written so the fix flips it green:
 *
 *   - `chat-service.ts:1238-1250` currently issues exactly one
 *     `adapter.query()` per thread. Adding the re-offer + restart there is
 *     what turns `invocationCount` from 1 into 2 below.
 *   - Restarting re-offers the SAME in-flight turn payload onto `inbox`, so
 *     the second `SDKClient.fake` invocation must pull the SAME user text
 *     off `p.prompt` - that is what turns
 *     `pulledTextsByInvocation[1]` from `undefined` into `[USER_TEXT]`.
 *   - Only with both of those does the user's turn ever get an assistant
 *     reply - that is what turns `assistantTexts` from `[]` into
 *     `["rotated-answer:...​"]`.
 *
 * Rotation is gated on `failoverPossible` (adapter.ts:404), which is only
 * ever computed `true` when a REAL `AccountBroker` sees ≥2 uncooled
 * same-kind accounts (packages/core/src/overflow-chain.ts:241-247) and no
 * `boundAccountId` pin - production always wires `SDKAdapter.WithBroker`
 * (apps/ui-web/scripts/chat-server.ts:2120-2126: "we MUST use WithBroker for
 * rotation to take effect"). So this test seeds a real two-account
 * `AccountBrokerLayer.fromAccounts` (not a fake - `SDKClient.fake` is the
 * ONLY fake here) instead of `SDKAdapter.Default`, which never computes
 * `failoverPossible` at all (adapter.ts:366: defaults `false`, only flips
 * inside `if (broker !== null)`) and so could never let this test go green.
 *
 * The error text is "session limit reached", matched by
 * packages/core/src/throttle-kind.ts's `classifyThrottleKind`:
 *   if (text.includes("session limit") || ...) return "session_limit"
 * so both `classifyThrottle` (adapter cooldown) and
 * `defaultIsRotatableError` (overflow-chain.ts:318, delegates to the same
 * table) agree this cause is rotatable.
 *
 * No thread is created through `ThreadToolsProviderTag` binding, so
 * `recallMemory` is undefined and the ORDINARY path executes (not the
 * per-turn recall path at chat-service.ts:1257-1279, whose finite
 * `Stream.make(turn.payload)` prompt is already replayable and cannot
 * reproduce this bug). The turn is driven through the real `ChatService`
 * (`chat.createThread` + `chat.send`) - the same calls the WS server makes -
 * never by poking `inbox` directly.
 */
import { afterAll, describe, expect, it } from "vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import { unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SessionStore,
  Clock as CoreClock,
  ObservabilityService,
  TelemetryService,
  AccountBroker,
  AccountBrokerLayer,
  EnvSecretProvider,
  extractText,
  type AccountSeed,
  type AccountBrokerApi,
} from "@luna/core"
import { SDKAdapter, SDKClient } from "@luna/adapter-sdk"
import { MemoryRouterTag, type MemoryRouter } from "@luna/memory"
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import {
  ChatService,
  ThreadToolsProviderTag,
  type ChatFrame,
  type ThreadToolsProvider,
} from "../src/index.js"

// Shared fake-Query wrapper - every test below needs the same control-method
// stub surface; factored out so each test's generator stays focused on the
// message sequence it actually cares about.
const wrapAsQuery = (iter: AsyncGenerator<SDKMessage, void>): Query =>
  Object.assign(iter, {
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    applyFlagSettings: async () => {},
    setMaxThinkingTokens: async () => {},
    supplyToolPermissionResponse: async () => {},
    mcpServerStatus: async () => ({}),
  } as Partial<Query>) as Query

// Pulls the plain-text content out of a fake-SDK user message the same way
// every generator below needs to (structured content never appears here).
const extractPromptText = (u: SDKUserMessage): string => {
  const content = (u as { message?: { content?: unknown } }).message?.content
  return typeof content === "string" ? content : "(structured)"
}

// A `system`/`init`-shaped message carrying a `session_id` - simulates the
// real SDK's init frame, which arrives BEFORE a session-limit error can fire
// and is what lets `activeSdkSessionId` become non-null on the very FIRST
// turn of a brand-new thread, before any turn has ever completed.
const makeSystemInitMessage = (sessionId: string): SDKMessage =>
  ({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    uuid: `init-${sessionId}`,
  }) as unknown as SDKMessage

// Inline fake-sdk message builders - duplicated from
// `chat-service.sim.test.ts` (itself duplicated from
// `packages/adapter-sdk/test/fake-sdk.ts` because adapter-sdk's
// package.json `exports` map only exposes the `.` entry).
const makeAssistantMessage = (
  sessionId: string,
  text: string,
  uuid: string,
): SDKMessage =>
  ({
    type: "assistant",
    session_id: sessionId,
    uuid,
    parent_tool_use_id: null,
    message: {
      id: uuid,
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }) as unknown as SDKMessage

const makeResultMessage = (sessionId: string, uuid: string): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    uuid,
    is_error: false,
    duration_ms: 10,
    duration_api_ms: 5,
    num_turns: 1,
    result: "ok",
  }) as unknown as SDKMessage

// Two same-kind ("anthropic") accounts, no LUNA_OVERFLOW_CHAINS configured -
// this is exactly the `pickLaneTarget` no-chain branch
// (overflow-chain.ts:234-254) whose `failoverPossible` is true whenever
// another uncooled same-kind account survives excluding the winner. With
// only ONE account, `failoverPossible` would stay false and rotation could
// never fire (BLOCKER #1 gate, adapter.ts:732) - two accounts is the
// minimum viable setup for this bug to be fixable at all.
process.env["LUNA_TEST_ROTATE_ACCT_A"] = "tok-rotate-acct-a"
process.env["LUNA_TEST_ROTATE_ACCT_B"] = "tok-rotate-acct-b"
const rotationSeeds: ReadonlyArray<AccountSeed> = [
  {
    id: "rotate-acct-a",
    kind: "anthropic",
    secretRef: "env:LUNA_TEST_ROTATE_ACCT_A",
  },
  {
    id: "rotate-acct-b",
    kind: "anthropic",
    secretRef: "env:LUNA_TEST_ROTATE_ACCT_B",
  },
]

// No-op MemoryRouter - required tag (not `serviceOption`), never exercised.
const noopMemoryRouter: MemoryRouter = {
  search: () => Stream.empty as ReturnType<MemoryRouter["search"]>,
  put: () => Effect.die("noopMemoryRouter.put"),
  get: () => Effect.die("noopMemoryRouter.get"),
  query: () => Stream.die("noopMemoryRouter.query"),
  delete: () => Effect.die("noopMemoryRouter.delete"),
  backendFor: () => {
    throw new Error("noopMemoryRouter.backendFor")
  },
  exportAll: () => Effect.die("noopMemoryRouter.exportAll"),
}

const testClock = CoreClock.Test(1_700_000_000_000)
const obsJsonlPath = join(
  tmpdir(),
  `luna-account-rotation-sim-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
)

afterAll(() => {
  try {
    unlinkSync(obsJsonlPath)
  } catch {
    /* ignore */
  }
})

const obsLayer = ObservabilityService.makeLayer({
  logToConsole: false,
  jsonlPath: obsJsonlPath,
}).pipe(Layer.provide(testClock))
const telemetryLayer = TelemetryService.makeLayer().pipe(
  Layer.provide(testClock),
)

// A REAL broker (not a fake) with a real, in-memory account pool - mirrors
// `packages/adapter-sdk/test/adapter-rotation.sim.test.ts`'s harness. The
// ONLY fake in this whole test is `SDKClient.fake` below.
const brokerLayer: Layer.Layer<AccountBroker> =
  AccountBrokerLayer.fromAccounts(rotationSeeds).pipe(
    Layer.provide(Layer.mergeAll(EnvSecretProvider.Default, testClock)),
  )

const baseLayer = Layer.mergeAll(
  SessionStore.Default,
  testClock,
  obsLayer,
  telemetryLayer,
  Layer.succeed(MemoryRouterTag, noopMemoryRouter),
  brokerLayer,
)

describe("account rotation on the ordinary long-lived-query path (RED)", () => {
  it(
    "an early session-limit throttle with no assistant content yet rotates to a fresh account and answers the SAME turn",
    async () => {
      const USER_TEXT = "please keep going, do not drop this message"

      let invocationCount = 0
      const pulledTextsByInvocation: Array<Array<string>> = []

      const fakeLayer = SDKClient.fake((p) => {
        invocationCount += 1
        const myInvocation = invocationCount
        pulledTextsByInvocation[myInvocation - 1] = []

        async function* gen(): AsyncGenerator<SDKMessage, void> {
          for await (const u of p.prompt as AsyncIterable<SDKUserMessage>) {
            // This is what actually drains chat-service's `inbox` Queue -
            // without pulling here, the bug (Defect #1: re-subscribing to
            // an already-drained queue) would never be exercised.
            const text =
              typeof u.message.content === "string"
                ? u.message.content
                : "(structured)"
            pulledTextsByInvocation[myInvocation - 1]!.push(text)

            if (myInvocation === 1) {
              // Fails BEFORE emitting any assistant content - an early
              // throttle mid-turn. "session limit" matches
              // throttle-kind.ts's `classifyThrottleKind` ("session_limit"
              // branch), so `defaultIsRotatableError` (overflow-chain.ts)
              // classifies this as rotatable.
              throw new Error(
                "Session limit reached for this account. Please wait and retry.",
              )
            }

            // Second (rotated) invocation succeeds normally.
            yield makeAssistantMessage(
              "sess-rotated",
              `rotated-answer:${text}`,
              `assistant-${myInvocation}`,
            )
            yield makeResultMessage("sess-rotated", `result-${myInvocation}`)
          }
        }
        const iter = gen()
        return Object.assign(iter, {
          interrupt: async () => {},
          setPermissionMode: async () => {},
          setModel: async () => {},
          applyFlagSettings: async () => {},
          setMaxThinkingTokens: async () => {},
          supplyToolPermissionResponse: async () => {},
          mcpServerStatus: async () => ({}),
        } as Partial<Query>) as Query
      })

      // SDKAdapter.WithBroker (NOT .Default) - production always wires
      // WithBroker; .Default never computes `failoverPossible` at all, so
      // it could never let this test's fix land.
      const layer = Layer.provideMerge(
        ChatService.Default,
        Layer.provideMerge(
          SDKAdapter.WithBroker,
          Layer.mergeAll(fakeLayer, baseLayer),
        ),
      )

      const assistantTexts = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const store = yield* SessionStore

            // No ThreadToolsProviderTag bound anywhere in `layer` above, so
            // `recallMemory` is undefined and the ORDINARY long-lived-query
            // path (chat-service.ts:1238-1250) executes - not the per-turn
            // recall path (1257-1279), which cannot show this bug.
            const thread = yield* chat.createThread({
              model: "claude-test",
              title: "account-rotation-red",
            })

            // Drive through the real send() API - the same call the WS
            // server makes. Never poke `inbox` directly.
            yield* chat.send(thread.id, USER_TEXT)

            // Give the throttle failure AND (once fixed) the rotated
            // second subprocess time to run to completion.
            yield* Effect.sleep("300 millis")

            const messages = yield* store
              .readMessages(thread.id)
              .pipe(Stream.runCollect)
            return Array.from(messages)
              .filter((m) => m.kind === "assistant")
              .map((m) => extractText(m.payload))
          }),
        ).pipe(Effect.provide(layer)),
      )

      // FALSIFIABILITY - the exact production lines this pins:
      //   chat-service.ts:1238-1250 (ordinary path: currently ONE
      //   adapter.query() for the thread's whole life). The fix adds:
      //   re-offer the in-flight turn's payload onto chat-service's own
      //   `inbox` and restart the session query on a fresh account when an
      //   early, rotatable throttle hits with no assistant content yet.
      // TODAY: invocationCount is 1 (the fake is built once; the failed
      // stream just ends, nothing restarts it) - these three assertions
      // fail. Once chat-service issues the second `adapter.query()` call
      // described above, invocationCount becomes 2, the second invocation's
      // `p.prompt` yields the re-offered SAME user text, and the turn is
      // finally answered.
      expect(invocationCount).toBe(2)
      expect(pulledTextsByInvocation[0]).toEqual([USER_TEXT])
      expect(pulledTextsByInvocation[1]).toEqual([USER_TEXT])

      // The user-observable consequence: the turn is answered, not
      // silently dropped forever.
      expect(assistantTexts).toEqual([`rotated-answer:${USER_TEXT}`])
    },
    { timeout: 10_000 },
  )
})

/**
 * BLOCKER #1 regression (prior-attempt rejection): the first RED test above
 * throws the throttle FROM INSIDE the SAME `for await (const u of p.prompt)`
 * loop that drains the input. That makes the `for await` loop's own
 * unwinding call `.return()` on `p.prompt`'s iterator when the throw
 * propagates out of it - which INTERRUPTS the dead attempt's SDK-input
 * bridge for us, for free. The REAL SDK never does this: `Query.streamInput`
 * (sdk.mjs:111) is an INDEPENDENT task, launched fire-and-forget
 * (`e.streamInput(r).catch(...)`, sdk.mjs:137), that keeps re-awaiting
 * `next()` after writing each message - it has no idea the OUTPUT side
 * (a completely separate stdout/API-driven stream) is about to throttle,
 * and nothing calls `.return()` on it when that happens. So a dead
 * attempt's input pump is left genuinely, indefinitely PARKED with an
 * outstanding pull - exactly the state that, against a shared-`inbox`
 * design, would let it silently steal the re-offered turn forever
 * (Defect #1, verbatim - the bug the ordinary path exists to fix).
 *
 * This test's fake reproduces that shape faithfully: an INDEPENDENT
 * fire-and-forget loop drains `p.prompt` (never throwing, never
 * `.return()`-ing), while a SEPARATE async generator supplies the OUTPUT
 * messages and throttles on its own schedule, never touching `p.prompt` at
 * all. If chat-service's per-attempt prompt source were ever shared
 * `inbox` directly (instead of a private per-attempt queue fed by a
 * forwarder WE fork and interrupt ourselves), this test's rotated
 * invocation would never see the turn: attempt 1's independent, un-
 * interrupted input pump would already be parked on `Queue.take(inbox)`
 * and would win the race for whatever gets offered to `inbox` next.
 */
describe("account rotation - realistic SDK input/output shape (regression: independent loops, no artificial .return() rescue)", () => {
  it(
    "the dead attempt's input pump stays genuinely parked (never interrupted) while the OUTPUT side throttles from a SEPARATE generator - the rotated invocation still receives the turn",
    async () => {
      const USER_TEXT =
        "please keep going - realistic SDK shape must not drop this"

      let invocationCount = 0
      const pulledTextsByInvocation: Array<Array<string>> = []
      // Resolved once invocation 1's INPUT PUMP has pulled the turn and
      // looped back to an outstanding `next()` call - the exact state the
      // real SDK's `streamInput` task sits in after writing a message to
      // stdin. Only once this is confirmed does the (entirely separate)
      // OUTPUT generator throw.
      let signalPulled: (() => void) | null = null
      const pulledGate = new Promise<void>((resolve) => {
        signalPulled = resolve
      })

      const fakeLayer = SDKClient.fake((p) => {
        invocationCount += 1
        const myInvocation = invocationCount
        pulledTextsByInvocation[myInvocation - 1] = []

        // INPUT PUMP: mirrors the real SDK's independent `streamInput` task.
        // Fire-and-forget (never awaited by, or synchronized with, the
        // output generator below other than via `pulledGate`). Drains
        // `p.prompt` in its OWN `for await` loop that NEVER throws and is
        // NEVER `.return()`-ed by anything in this test - on invocation 1 it
        // is left running, permanently parked on the next pull, for the
        // rest of the test.
        void (async () => {
          for await (const u of p.prompt as AsyncIterable<SDKUserMessage>) {
            const text = extractPromptText(u)
            pulledTextsByInvocation[myInvocation - 1]!.push(text)
            if (myInvocation === 1) signalPulled?.()
          }
        })()

        // OUTPUT GENERATOR: a SEPARATE mechanism (mirrors the real SDK's own
        // stdout/API-driven message stream). Throttles or succeeds on ITS
        // OWN schedule and never reads `p.prompt` - a throttle is a
        // server-side response, not something that comes from the
        // input-write loop.
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          if (myInvocation === 1) {
            await pulledGate
            throw new Error(
              "Session limit reached for this account. Please wait and retry.",
            )
          }
          yield makeAssistantMessage(
            "sess-realistic-rotated",
            `rotated-answer:${USER_TEXT}`,
            "a-realistic-1",
          )
          yield makeResultMessage("sess-realistic-rotated", "r-realistic-1")
        }
        return wrapAsQuery(gen())
      })

      const layer = Layer.provideMerge(
        ChatService.Default,
        Layer.provideMerge(
          SDKAdapter.WithBroker,
          Layer.mergeAll(fakeLayer, baseLayer),
        ),
      )

      const assistantTexts = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const store = yield* SessionStore
            const thread = yield* chat.createThread({
              model: "claude-test",
              title: "account-rotation-realistic-shape",
            })
            yield* chat.send(thread.id, USER_TEXT)
            yield* Effect.sleep("300 millis")
            const messages = yield* store
              .readMessages(thread.id)
              .pipe(Stream.runCollect)
            return Array.from(messages)
              .filter((m) => m.kind === "assistant")
              .map((m) => extractText(m.payload))
          }),
        ).pipe(Effect.provide(layer)),
      )

      expect(invocationCount).toBe(2)
      expect(pulledTextsByInvocation[0]).toEqual([USER_TEXT])
      // THE regression assertion: even with attempt 1's independent input
      // pump left genuinely, indefinitely parked on an outstanding `next()`
      // (never interrupted, never `.return()`-ed - it was never subscribed
      // to the SHARED `inbox`, only to its OWN private attempt queue), the
      // rotated invocation's OWN independent input pump still receives the
      // re-offered turn. A shared-`inbox`-backed implementation would leave
      // this `undefined` forever - the dead pump, parked FIRST on `inbox`,
      // would win the race and steal it.
      expect(pulledTextsByInvocation[1]).toEqual([USER_TEXT])
      expect(assistantTexts).toEqual([`rotated-answer:${USER_TEXT}`])
    },
    { timeout: 10_000 },
  )
})

/**
 * BLOCKER #2 regression (prior-attempt rejection): every rotation attempt
 * was scoped with `Scope.provide(threadScope)`, so a failed attempt's
 * finalizers - `abortController.abort()` (adapter.ts) and the broker
 * credential's `inFlight` release (documented in adapter.ts as attaching to
 * the query Scope) - never ran until the THREAD died. Each rotation
 * therefore orphaned a live SDK subprocess and permanently inflated the
 * inFlight count on the account that was just throttled, skewing the
 * broker's own pick logic against the very pool rotation depends on.
 *
 * The fix forks a CHILD scope per attempt (`Scope.fork(threadScope, ...)`)
 * and closes it explicitly with the attempt's Exit before rotating - this
 * test asserts the throttled account's `inFlight` count returns to its
 * pre-attempt baseline (0) immediately after rotation, while the thread is
 * still alive and the NEW account's `inFlight` is exactly 1 (still legitimately
 * in use by the now-long-lived rotated query).
 */
describe("account rotation - attempt-scoped resource release (BLOCKER #2)", () => {
  it(
    "the throttled account's inFlight count returns to 0 after rotation instead of leaking for the thread's whole life",
    async () => {
      const USER_TEXT = "blocker-2 scope leak regression"

      let invocationCount = 0
      const fakeLayer = SDKClient.fake((p) => {
        invocationCount += 1
        const myInvocation = invocationCount
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          for await (const u of p.prompt as AsyncIterable<SDKUserMessage>) {
            const text = extractPromptText(u)
            if (myInvocation === 1) {
              throw new Error(
                "Session limit reached for this account. Please wait and retry.",
              )
            }
            yield makeAssistantMessage(
              "sess-blocker2",
              `ans:${text}`,
              "a-blocker2-1",
            )
            yield makeResultMessage("sess-blocker2", "r-blocker2-1")
          }
        }
        return wrapAsQuery(gen())
      })

      const layer = Layer.provideMerge(
        ChatService.Default,
        Layer.provideMerge(
          SDKAdapter.WithBroker,
          Layer.mergeAll(fakeLayer, baseLayer),
        ),
      )

      const inFlightByAccount = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const broker = yield* AccountBroker
            const thread = yield* chat.createThread({
              model: "claude-test",
              title: "account-rotation-blocker2",
            })
            yield* chat.send(thread.id, USER_TEXT)
            yield* Effect.sleep("300 millis")
            const records = yield* broker._inspect()
            return new Map(records.map((r) => [r.id, r.inFlight]))
          }),
        ).pipe(Effect.provide(layer)),
      )

      expect(invocationCount).toBe(2)
      // The throttled account (rotate-acct-a) must be back to its
      // pre-attempt baseline - a leaked scope would leave this at 1
      // (or higher, across repeated rotations on a long-lived thread)
      // for as long as the thread stays alive.
      expect(inFlightByAccount.get("rotate-acct-a")).toBe(0)
      // The rotated-to account (rotate-acct-b) is still legitimately in
      // use: the ordinary path's query stays open for the thread's life.
      expect(inFlightByAccount.get("rotate-acct-b")).toBe(1)
    },
    { timeout: 10_000 },
  )
})

/**
 * BLOCKER #4 regression (prior-attempt rejection): `Effect.orDie` on the
 * ROTATION re-acquire converted a routine `AllAccountsExhaustedError` into
 * an unhandled defect. Rotation re-acquires at exactly the moment an
 * account was just cooled, so exhaustion (every OTHER candidate having
 * cooled too - e.g. a sibling lane sharing the pool, or simply a pool that
 * only had two accounts and both are now cooled) is an expected outcome,
 * not a bug. This test deterministically reproduces "the rotated-to pool is
 * exhausted right as the retry runs" via a broker-wrapping spy that cools
 * EVERY sibling account on the SECOND `acquireSession` call (the rotation's
 * own re-acquire) - the exact case the prior-attempt review flagged as
 * escaping `handleAdapterFailure` entirely (no error frame, no
 * `pendingTurns` drain, and the thread's consumer fiber dead for good).
 */
describe("account rotation - exhausted rotated-to pool (BLOCKER #4)", () => {
  it(
    "an AllAccountsExhaustedError on the rotation re-acquire surfaces as a normal assistant-error frame, not an unhandled defect",
    async () => {
      const USER_TEXT = "blocker-4 exhausted rotation retry"

      let invocationCount = 0
      const fakeLayer = SDKClient.fake((p) => {
        invocationCount += 1
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          for await (const _u of p.prompt as AsyncIterable<SDKUserMessage>) {
            // Every invocation throttles immediately - only invocation 1
            // (the initial acquire) is expected; the spy below makes the
            // ROTATION's re-acquire (call #2) fail before any second
            // invocation of this fake could even happen.
            throw new Error(
              "Session limit reached for this account. Please wait and retry.",
            )
          }
        }
        return wrapAsQuery(gen())
      })

      // Spy wraps the REAL broker's `acquireSession`: on the SECOND call
      // (chat-service's rotation re-acquire, immediately after attempt 1's
      // throttle cooled rotate-acct-a and the gate's re-check - a SEPARATE
      // `peekFailoverPossible` call this spy does not touch - correctly
      // still saw rotate-acct-b as viable), it cools rotate-acct-b TOO
      // before delegating, so the real `acquireSession` genuinely returns
      // `AllAccountsExhaustedError`. This proves the failure path (not a
      // forced/fake error) while remaining fully deterministic (no timing
      // race needed).
      let acquireCalls = 0
      const exhaustingSpyLayer: Layer.Layer<AccountBroker, never, AccountBroker> =
        Layer.effect(
          AccountBroker,
          Effect.gen(function* () {
            const inner = yield* AccountBroker
            const wrapped: AccountBrokerApi = {
              ...inner,
              acquireSession: (opts) =>
                Effect.gen(function* () {
                  acquireCalls += 1
                  if (acquireCalls === 2) {
                    yield* inner.report({
                      accountId: "rotate-acct-a",
                      kind: "session_limit",
                    })
                    yield* inner.report({
                      accountId: "rotate-acct-b",
                      kind: "session_limit",
                    })
                  }
                  return yield* inner.acquireSession(opts)
                }),
            }
            return wrapped
          }),
        )
      const spiedBrokerLayer = exhaustingSpyLayer.pipe(Layer.provide(brokerLayer))
      const exhaustedBaseLayer = Layer.mergeAll(
        SessionStore.Default,
        testClock,
        obsLayer,
        telemetryLayer,
        Layer.succeed(MemoryRouterTag, noopMemoryRouter),
        spiedBrokerLayer,
      )

      const layer = Layer.provideMerge(
        ChatService.Default,
        Layer.provideMerge(
          SDKAdapter.WithBroker,
          Layer.mergeAll(fakeLayer, exhaustedBaseLayer),
        ),
      )

      const frames: Array<ChatFrame> = []
      const secondSendResult = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const thread = yield* chat.createThread({
              model: "claude-test",
              title: "account-rotation-blocker4",
            })
            const collector = yield* Effect.forkChild(
              chat.subscribe(thread.id).pipe(
                Stream.runForEach((f) => Effect.sync(() => frames.push(f))),
              ),
            )
            yield* Effect.sleep("5 millis")
            yield* chat.send(thread.id, USER_TEXT)
            yield* Effect.sleep("300 millis")
            // The thread's consumer fiber has ended (a terminal adapter
            // failure - rotation-exhausted or not - has never restarted
            // consumption; this matches every other `handleAdapterFailure`
            // path, not something BLOCKER #4 changes). A later `send()`
            // must still be ACCEPTED (persisted, no crash, no unhandled
            // rejection) rather than the whole runtime dying from an
            // escaped defect - that is the concrete, provable half of the
            // prior review's ask this test can actually make good on.
            const second = yield* chat.send(thread.id, "a later message")
            yield* Effect.sleep("50 millis")
            yield* Fiber.interrupt(collector)
            return second
          }),
        ).pipe(Effect.provide(layer)),
      )

      // Exactly two acquireSession calls: attempt 1's initial acquire, and
      // the rotation's re-acquire that the spy sabotages. No THIRD attempt
      // (the exhaustion is terminal, not itself rotatable).
      expect(acquireCalls).toBe(2)
      // The SDK fake is only ever invoked once - the exhausted re-acquire
      // fails BEFORE a second `adapter.query()` could ever reach the fake.
      expect(invocationCount).toBe(1)
      const errorFrame = frames.find((f) => f.type === "assistant-error")
      expect(errorFrame).toBeDefined()
      // The SECOND send() is still accepted (persisted), proving no
      // unhandled defect took down the fiber/runtime.
      expect(secondSendResult._tag).toBe("Some")
    },
    { timeout: 10_000 },
  )
})

describe("account rotation - per-turn budget reset (regression: attemptNum was a thread-lifetime cap)", () => {
  it(
    "rotates on turn 1, completes turn 2 normally on the rotated account, then rotates again on turn 3 even though the budget was already spent once",
    async () => {
      // A pre-fix thread-lifetime `attemptNum < MAX_ORDINARY_ROTATION_ATTEMPTS`
      // check is exhausted by exactly 2 rotations, EVER, regardless of how
      // many turns cleanly completed in between. Four accounts force a THIRD
      // rotation (turn 3's) to prove the budget is per-turn: under the old
      // code this would be permanently blocked once attemptNum reached 3,
      // even though turn 2 completed cleanly right before it.
      process.env["LUNA_TEST_ROTATE_BUDGET_A"] = "tok-budget-a"
      process.env["LUNA_TEST_ROTATE_BUDGET_B"] = "tok-budget-b"
      process.env["LUNA_TEST_ROTATE_BUDGET_C"] = "tok-budget-c"
      process.env["LUNA_TEST_ROTATE_BUDGET_D"] = "tok-budget-d"
      const budgetSeeds: ReadonlyArray<AccountSeed> = [
        {
          id: "budget-a",
          kind: "anthropic",
          secretRef: "env:LUNA_TEST_ROTATE_BUDGET_A",
        },
        {
          id: "budget-b",
          kind: "anthropic",
          secretRef: "env:LUNA_TEST_ROTATE_BUDGET_B",
        },
        {
          id: "budget-c",
          kind: "anthropic",
          secretRef: "env:LUNA_TEST_ROTATE_BUDGET_C",
        },
        {
          id: "budget-d",
          kind: "anthropic",
          secretRef: "env:LUNA_TEST_ROTATE_BUDGET_D",
        },
      ]
      const tokenToAccountId: Record<string, string> = {
        "tok-budget-a": "budget-a",
        "tok-budget-b": "budget-b",
        "tok-budget-c": "budget-c",
        "tok-budget-d": "budget-d",
      }
      const budgetBrokerLayer: Layer.Layer<AccountBroker> =
        AccountBrokerLayer.fromAccounts(budgetSeeds).pipe(
          Layer.provide(Layer.mergeAll(EnvSecretProvider.Default, testClock)),
        )
      const budgetBaseLayer = Layer.mergeAll(
        SessionStore.Default,
        testClock,
        obsLayer,
        telemetryLayer,
        Layer.succeed(MemoryRouterTag, noopMemoryRouter),
        budgetBrokerLayer,
      )

      let invocationCount = 0
      const accountUsedByInvocation: Array<string> = []
      const pulledTextsByInvocation: Array<Array<string>> = []

      const fakeLayer = SDKClient.fake((p) => {
        invocationCount += 1
        const myInvocation = invocationCount
        pulledTextsByInvocation[myInvocation - 1] = []
        const env = (p.options as { env?: Record<string, string | undefined> } | undefined)
          ?.env
        const tok = env?.["CLAUDE_CODE_OAUTH_TOKEN"]
        accountUsedByInvocation[myInvocation - 1] =
          (tok !== undefined ? tokenToAccountId[tok] : undefined) ?? "unknown"

        let pulledInThisInvocation = 0
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          for await (const u of p.prompt as AsyncIterable<SDKUserMessage>) {
            pulledInThisInvocation += 1
            const text = extractPromptText(u)
            pulledTextsByInvocation[myInvocation - 1]!.push(text)

            // invocation1 fails on its 1st pull (turn 1); invocation2 fails
            // on its 2nd pull (turn 2, after turn 1 succeeded on it);
            // invocation3 fails on its 2nd pull (turn 3, after turn 2
            // succeeded on it). invocation4 always succeeds.
            const shouldFail =
              (myInvocation === 1 && pulledInThisInvocation === 1) ||
              (myInvocation === 2 && pulledInThisInvocation === 2) ||
              (myInvocation === 3 && pulledInThisInvocation === 2)
            if (shouldFail) {
              throw new Error(
                "Session limit reached for this account. Please wait and retry.",
              )
            }
            yield makeAssistantMessage(
              `sess-inv${myInvocation}`,
              `ans-inv${myInvocation}:${text}`,
              `a-${myInvocation}-${pulledInThisInvocation}`,
            )
            yield makeResultMessage(
              `sess-inv${myInvocation}`,
              `r-${myInvocation}-${pulledInThisInvocation}`,
            )
          }
        }
        return wrapAsQuery(gen())
      })

      const layer = Layer.provideMerge(
        ChatService.Default,
        Layer.provideMerge(
          SDKAdapter.WithBroker,
          Layer.mergeAll(fakeLayer, budgetBaseLayer),
        ),
      )

      const assistantTexts = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const store = yield* SessionStore
            const thread = yield* chat.createThread({
              model: "claude-test",
              title: "rotation-budget-reset",
            })

            yield* chat.send(thread.id, "turn one")
            yield* Effect.sleep("300 millis")
            yield* chat.send(thread.id, "turn two")
            yield* Effect.sleep("300 millis")
            yield* chat.send(thread.id, "turn three")
            yield* Effect.sleep("300 millis")

            const messages = yield* store
              .readMessages(thread.id)
              .pipe(Stream.runCollect)
            return Array.from(messages)
              .filter((m) => m.kind === "assistant")
              .map((m) => extractText(m.payload))
          }),
        ).pipe(Effect.provide(layer)),
      )

      // FALSIFIABILITY: a thread-lifetime `attemptNum` budget (the pre-fix
      // shape) is pinned at 3 after exactly 2 rotations, EVER - turn 3's
      // rotation (the 3rd rotation on this thread, but the FIRST rotation
      // attempted after 2 clean turn completions) would check `3 < 3`,
      // fail, and fall through to the terminal `handleAdapterFailure` path:
      // invocationCount would stop at 3 and turn 3 would never be answered.
      expect(invocationCount).toBe(4)
      expect(accountUsedByInvocation).toEqual([
        "budget-a",
        "budget-b",
        "budget-c",
        "budget-d",
      ])
      expect(assistantTexts).toEqual([
        "ans-inv2:turn one",
        "ans-inv3:turn two",
        "ans-inv4:turn three",
      ])
    },
    { timeout: 10_000 },
  )
})

describe("account rotation - inbox re-offer ordering (regression: tail-append inverted order)", () => {
  it(
    "re-offers the in-flight turn AHEAD of a turn already queued behind it, preserving reply order and observeTurn pairing",
    async () => {
      const TEXT_1 = "first back-to-back turn"
      const TEXT_2 = "second back-to-back turn"

      let invocationCount = 0
      const pulledTextsByInvocation: Array<Array<string>> = []
      let releaseThrow: (() => void) | null = null
      const throwGate = new Promise<void>((resolve) => {
        releaseThrow = resolve
      })

      const fakeLayer = SDKClient.fake((p) => {
        invocationCount += 1
        const myInvocation = invocationCount
        pulledTextsByInvocation[myInvocation - 1] = []

        async function* gen(): AsyncGenerator<SDKMessage, void> {
          for await (const u of p.prompt as AsyncIterable<SDKUserMessage>) {
            const text = extractPromptText(u)
            pulledTextsByInvocation[myInvocation - 1]!.push(text)

            if (myInvocation === 1) {
              // Blocks HERE, mid-turn, until the test has confirmed TEXT_2
              // is sitting genuinely unpulled in `inbox` - that is the exact
              // window in which a tail-append re-offer inverts the order.
              await throwGate
              throw new Error(
                "Session limit reached for this account. Please wait and retry.",
              )
            }

            yield makeAssistantMessage(
              "sess-order",
              `ans:${text}`,
              `a-${myInvocation}-${pulledTextsByInvocation[myInvocation - 1]!.length}`,
            )
            yield makeResultMessage(
              "sess-order",
              `r-${myInvocation}-${pulledTextsByInvocation[myInvocation - 1]!.length}`,
            )
          }
        }
        return wrapAsQuery(gen())
      })

      const observed: Array<{
        userText: string
        assistantText: string
        isError: boolean
      }> = []
      const provider: ThreadToolsProvider = {
        decorate: () => ({
          mcpServers: {},
          onBound: () => {},
          observeTurn: ({ userText, assistantText, isError }) =>
            Effect.sync(() => observed.push({ userText, assistantText, isError })),
        }),
      }

      const layer = Layer.provideMerge(
        ChatService.Default,
        Layer.provideMerge(
          SDKAdapter.WithBroker,
          Layer.mergeAll(
            fakeLayer,
            baseLayer,
            Layer.succeed(ThreadToolsProviderTag, provider),
          ),
        ),
      )

      const assistantTexts = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const store = yield* SessionStore
            const thread = yield* chat.createThread({
              model: "claude-test",
              title: "rotation-order",
            })

            yield* chat.send(thread.id, TEXT_1)
            // Let invocation1 pull TEXT_1 and start blocking on throwGate.
            yield* Effect.sleep("80 millis")
            yield* chat.send(thread.id, TEXT_2)
            // Let TEXT_2 land in `inbox`, genuinely unpulled, BEFORE the
            // throttle fires.
            yield* Effect.sleep("80 millis")
            yield* Effect.sync(() => releaseThrow!())
            yield* Effect.sleep("400 millis")

            const messages = yield* store
              .readMessages(thread.id)
              .pipe(Stream.runCollect)
            return Array.from(messages)
              .filter((m) => m.kind === "assistant")
              .map((m) => extractText(m.payload))
          }),
        ).pipe(Effect.provide(layer)),
      )

      expect(invocationCount).toBe(2)
      expect(pulledTextsByInvocation[0]).toEqual([TEXT_1])
      // ORDER, not just presence: the rotated query must see TEXT_1 BEFORE
      // TEXT_2, matching submission order. A single-slot, tail-appending
      // re-offer would instead leave `inbox` as [TEXT_2, TEXT_1] here,
      // since TEXT_2 was already queued when the re-offer ran.
      expect(pulledTextsByInvocation[1]).toEqual([TEXT_1, TEXT_2])
      expect(assistantTexts).toEqual([`ans:${TEXT_1}`, `ans:${TEXT_2}`])
      // observeTurn pairing must not be scrambled by the reordering either.
      expect(observed).toEqual([
        { userText: TEXT_1, assistantText: `ans:${TEXT_1}`, isError: false },
        { userText: TEXT_2, assistantText: `ans:${TEXT_2}`, isError: false },
      ])
    },
    { timeout: 10_000 },
  )
})

describe("account rotation - single-account pool has no viable failover", () => {
  it(
    "never rotates (and never re-invokes the SDK) when the pool has only one account",
    async () => {
      process.env["LUNA_TEST_ROTATE_SOLO"] = "tok-solo"
      const soloSeeds: ReadonlyArray<AccountSeed> = [
        {
          id: "solo-acct",
          kind: "anthropic",
          secretRef: "env:LUNA_TEST_ROTATE_SOLO",
        },
      ]
      const soloBrokerLayer: Layer.Layer<AccountBroker> =
        AccountBrokerLayer.fromAccounts(soloSeeds).pipe(
          Layer.provide(Layer.mergeAll(EnvSecretProvider.Default, testClock)),
        )
      const soloBaseLayer = Layer.mergeAll(
        SessionStore.Default,
        testClock,
        obsLayer,
        telemetryLayer,
        Layer.succeed(MemoryRouterTag, noopMemoryRouter),
        soloBrokerLayer,
      )

      let invocationCount = 0
      const fakeLayer = SDKClient.fake((p) => {
        invocationCount += 1
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          for await (const _u of p.prompt as AsyncIterable<SDKUserMessage>) {
            throw new Error(
              "Session limit reached for this account. Please wait and retry.",
            )
          }
        }
        return wrapAsQuery(gen())
      })

      const layer = Layer.provideMerge(
        ChatService.Default,
        Layer.provideMerge(
          SDKAdapter.WithBroker,
          Layer.mergeAll(fakeLayer, soloBaseLayer),
        ),
      )

      const frames: Array<ChatFrame> = []
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const thread = yield* chat.createThread({
              model: "claude-test",
              title: "rotation-solo",
            })
            const collector = yield* Effect.forkChild(
              chat.subscribe(thread.id).pipe(
                Stream.runForEach((f) => Effect.sync(() => frames.push(f))),
              ),
            )
            yield* Effect.sleep("5 millis")
            yield* chat.send(thread.id, "solo turn")
            yield* Effect.sleep("300 millis")
            yield* Fiber.interrupt(collector)
          }),
        ).pipe(Effect.provide(layer)),
      )

      // Defect #2 regression: with no failover target, the SAME (only)
      // account must never be re-acquired in a tight loop - exactly one
      // adapter.query() call, and the terminal failure path handles it.
      expect(invocationCount).toBe(1)
      const errorFrame = frames.find((f) => f.type === "assistant-error")
      expect(errorFrame).toBeDefined()
    },
    { timeout: 10_000 },
  )
})

describe("account rotation - history-drop notice gated on genuine history", () => {
  it(
    "suppresses the user-visible history-dropped frame when turn 1 of a brand-new thread rotates before any turn has completed",
    async () => {
      let invocationCount = 0
      const fakeLayer = SDKClient.fake((p) => {
        invocationCount += 1
        const myInvocation = invocationCount
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          for await (const u of p.prompt as AsyncIterable<SDKUserMessage>) {
            const text = extractPromptText(u)
            if (myInvocation === 1) {
              // Simulates the real SDK's init frame minting a session id
              // moments before the session-limit error fires - so
              // `activeSdkSessionId` becomes non-null with NOTHING behind
              // it yet (no turn has ever completed on this thread).
              yield makeSystemInitMessage("sess-d1-first")
              throw new Error(
                "Session limit reached for this account. Please wait and retry.",
              )
            }
            yield makeAssistantMessage("sess-d1-second", `ans:${text}`, "a1")
            yield makeResultMessage("sess-d1-second", "r1")
          }
        }
        return wrapAsQuery(gen())
      })

      const layer = Layer.provideMerge(
        ChatService.Default,
        Layer.provideMerge(
          SDKAdapter.WithBroker,
          Layer.mergeAll(fakeLayer, baseLayer),
        ),
      )

      const frames: Array<ChatFrame> = []
      const obsEvents: Array<{ kind: string; errorTag?: string }> = []
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const obs = yield* ObservabilityService
            const thread = yield* chat.createThread({
              model: "claude-test",
              title: "rotation-history-drop-first-turn",
            })
            const evStream = yield* obs.subscribeEvents
            const frameCollector = yield* Effect.forkChild(
              chat.subscribe(thread.id).pipe(
                Stream.runForEach((f) => Effect.sync(() => frames.push(f))),
              ),
            )
            const obsCollector = yield* Effect.forkChild(
              evStream.pipe(
                Stream.runForEach((e) =>
                  Effect.sync(() =>
                    obsEvents.push(e as { kind: string; errorTag?: string }),
                  ),
                ),
              ),
            )
            yield* Effect.sleep("5 millis")
            yield* chat.send(thread.id, "first ever turn")
            yield* Effect.sleep("300 millis")
            yield* Fiber.interrupt(frameCollector)
            yield* Fiber.interrupt(obsCollector)
          }),
        ).pipe(Effect.provide(layer)),
      )

      expect(invocationCount).toBe(2)
      // Traceability: the obs event still fires even though nothing
      // user-visible is shown - the drop is real (the SDK-side session id
      // truly cannot carry across accounts), only harmless here.
      const dropEvent = obsEvents.find(
        (e) => e.errorTag === "ChatRotationHistoryDropped",
      )
      expect(dropEvent).toBeDefined()
      // But the USER-VISIBLE frame must be absent: no turn had completed
      // yet on this thread, so no real conversation history was lost.
      const userVisibleDropFrame = frames.find(
        (f) =>
          f.type === "assistant-error" &&
          f.error.message.includes("Switched to another account"),
      )
      expect(userVisibleDropFrame).toBeUndefined()
    },
    { timeout: 10_000 },
  )

  it(
    "shows the user-visible history-dropped frame when rotation happens AFTER a turn has genuinely completed",
    async () => {
      let invocationCount = 0
      const fakeLayer = SDKClient.fake((p) => {
        invocationCount += 1
        const myInvocation = invocationCount
        let pulledInThisInvocation = 0
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          for await (const u of p.prompt as AsyncIterable<SDKUserMessage>) {
            pulledInThisInvocation += 1
            const text = extractPromptText(u)
            if (myInvocation === 1 && pulledInThisInvocation === 2) {
              // Turn 1 (this invocation's 1st pull, below) already
              // completed with a real session id; turn 2 (2nd pull) is
              // what throttles - REAL history now exists to drop.
              throw new Error(
                "Session limit reached for this account. Please wait and retry.",
              )
            }
            yield makeAssistantMessage(
              "sess-d2",
              `ans:${text}`,
              `a-${myInvocation}-${pulledInThisInvocation}`,
            )
            yield makeResultMessage(
              "sess-d2",
              `r-${myInvocation}-${pulledInThisInvocation}`,
            )
          }
        }
        return wrapAsQuery(gen())
      })

      const layer = Layer.provideMerge(
        ChatService.Default,
        Layer.provideMerge(
          SDKAdapter.WithBroker,
          Layer.mergeAll(fakeLayer, baseLayer),
        ),
      )

      const frames: Array<ChatFrame> = []
      const obsEvents: Array<{ kind: string; errorTag?: string }> = []
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const obs = yield* ObservabilityService
            const thread = yield* chat.createThread({
              model: "claude-test",
              title: "rotation-history-drop-after-completion",
            })
            const evStream = yield* obs.subscribeEvents
            const frameCollector = yield* Effect.forkChild(
              chat.subscribe(thread.id).pipe(
                Stream.runForEach((f) => Effect.sync(() => frames.push(f))),
              ),
            )
            const obsCollector = yield* Effect.forkChild(
              evStream.pipe(
                Stream.runForEach((e) =>
                  Effect.sync(() =>
                    obsEvents.push(e as { kind: string; errorTag?: string }),
                  ),
                ),
              ),
            )
            yield* Effect.sleep("5 millis")
            yield* chat.send(thread.id, "turn one, completes normally")
            yield* Effect.sleep("250 millis")
            yield* chat.send(thread.id, "turn two, throttles mid-session")
            yield* Effect.sleep("350 millis")
            yield* Fiber.interrupt(frameCollector)
            yield* Fiber.interrupt(obsCollector)
          }),
        ).pipe(Effect.provide(layer)),
      )

      expect(invocationCount).toBe(2)
      const dropEvent = obsEvents.find(
        (e) => e.errorTag === "ChatRotationHistoryDropped",
      )
      expect(dropEvent).toBeDefined()
      const userVisibleDropFrame = frames.find(
        (f) =>
          f.type === "assistant-error" &&
          f.error.message.includes("Switched to another account"),
      )
      expect(userVisibleDropFrame).toBeDefined()
    },
    { timeout: 10_000 },
  )
})

/**
 * `inFlightPrompts`/`seedTurns` desync regression (three tests below).
 *
 * BUG: a rotated attempt's carried-over turns (`seedTurns`) were offered ONLY
 * to the new attempt's private `attemptQueue` (chat-service.ts, the
 * `Queue.offerAll(attemptQueue, seedTurns)` line in `runOrdinaryQuery`) - the
 * `inFlightPrompts` tracking Ref that the rotation predicate reads was instead
 * unconditionally reset to `[]` right before the recursive call. Immediately
 * after a rotation, the new attempt is executing a turn the tracking list
 * says is NOT in flight. Two concrete consequences:
 *
 *   1. A SECOND consecutive rotation on the SAME still-unanswered turn reads
 *      `inFlight = []`, so the rotation predicate's `inFlight.length > 0`
 *      gate is false and the turn terminally fails instead of rotating
 *      again - even though `MAX_ORDINARY_ROTATION_ATTEMPTS = 3` is documented
 *      as "3 total attempts (2 rotations)". The existing "per-turn budget
 *      reset" test above never exercises this: it rotates turn 1, turn 2,
 *      turn 3 - three DIFFERENT turns, each rotating exactly once.
 *   2. Under pipelining (a turn N+1 sent before turn N's `result` arrives),
 *      the `result` handler's `xs.slice(1)` head-shift (chat-service.ts,
 *      `handleSdkMessage`'s `"result"` branch) assumes the head of
 *      `inFlightPrompts` is always the turn the next `result` closes. With
 *      the tracking Ref left empty across the rotation, a turn N+1 that
 *      arrives via the forwarder while the rotated attempt is still
 *      finishing turn N becomes the ONLY entry in `inFlightPrompts` - so
 *      turn N's `result` incorrectly pops turn N+1 off the head, leaving the
 *      list empty while turn N+1 is genuinely still in flight. A subsequent
 *      early throttle on turn N+1 then reads `inFlight = []` and terminally
 *      fails instead of rotating.
 *
 * THE FIX seeds `inFlightPrompts` with `seedTurns` in the SAME step
 * `attemptQueue` is seeded (`Ref.set(inFlightPrompts, seedTurns)` at the top
 * of `runOrdinaryQuery`), and removes the unconditional `Ref.set` that used
 * to clear it right before the recursive rotation call - so the tracking Ref
 * always mirrors exactly what the current attempt's queue holds, in the same
 * FIFO order.
 */
describe("account rotation - double rotation on a single turn (regression: inFlightPrompts/seedTurns desync)", () => {
  it(
    "rotates twice for the SAME still-unanswered turn when the first two accounts both throttle early, and the turn is finally answered by the third",
    async () => {
      const USER_TEXT = "please keep rotating until someone answers me"

      // Four accounts: the first two throttle (proving the SECOND
      // consecutive rotation on this one turn actually fires), the third
      // answers, and the fourth stays unused - just enough pool depth that
      // `failoverPossible` reads true at BOTH rotation points regardless of
      // exactly which account the broker's LRU pick lands on.
      process.env["LUNA_TEST_ROTATE_DBL_A"] = "tok-dbl-a"
      process.env["LUNA_TEST_ROTATE_DBL_B"] = "tok-dbl-b"
      process.env["LUNA_TEST_ROTATE_DBL_C"] = "tok-dbl-c"
      process.env["LUNA_TEST_ROTATE_DBL_D"] = "tok-dbl-d"
      const dblSeeds: ReadonlyArray<AccountSeed> = [
        {
          id: "dbl-a",
          kind: "anthropic",
          secretRef: "env:LUNA_TEST_ROTATE_DBL_A",
        },
        {
          id: "dbl-b",
          kind: "anthropic",
          secretRef: "env:LUNA_TEST_ROTATE_DBL_B",
        },
        {
          id: "dbl-c",
          kind: "anthropic",
          secretRef: "env:LUNA_TEST_ROTATE_DBL_C",
        },
        {
          id: "dbl-d",
          kind: "anthropic",
          secretRef: "env:LUNA_TEST_ROTATE_DBL_D",
        },
      ]
      const dblBrokerLayer: Layer.Layer<AccountBroker> =
        AccountBrokerLayer.fromAccounts(dblSeeds).pipe(
          Layer.provide(Layer.mergeAll(EnvSecretProvider.Default, testClock)),
        )
      const dblBaseLayer = Layer.mergeAll(
        SessionStore.Default,
        testClock,
        obsLayer,
        telemetryLayer,
        Layer.succeed(MemoryRouterTag, noopMemoryRouter),
        dblBrokerLayer,
      )

      let invocationCount = 0
      const pulledTextsByInvocation: Array<Array<string>> = []

      const fakeLayer = SDKClient.fake((p) => {
        invocationCount += 1
        const myInvocation = invocationCount
        pulledTextsByInvocation[myInvocation - 1] = []

        async function* gen(): AsyncGenerator<SDKMessage, void> {
          for await (const u of p.prompt as AsyncIterable<SDKUserMessage>) {
            const text = extractPromptText(u)
            pulledTextsByInvocation[myInvocation - 1]!.push(text)

            // Invocations 1 AND 2 both throttle early on the SAME turn -
            // the second-consecutive-rotation path the bug collapses.
            if (myInvocation === 1 || myInvocation === 2) {
              throw new Error(
                "Session limit reached for this account. Please wait and retry.",
              )
            }
            // Third invocation (third account) finally succeeds.
            yield makeAssistantMessage(
              "sess-dbl-rotated",
              `rotated-answer:${text}`,
              `a-dbl-${myInvocation}`,
            )
            yield makeResultMessage("sess-dbl-rotated", `r-dbl-${myInvocation}`)
          }
        }
        return wrapAsQuery(gen())
      })

      const layer = Layer.provideMerge(
        ChatService.Default,
        Layer.provideMerge(
          SDKAdapter.WithBroker,
          Layer.mergeAll(fakeLayer, dblBaseLayer),
        ),
      )

      const assistantTexts = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const store = yield* SessionStore
            const thread = yield* chat.createThread({
              model: "claude-test",
              title: "rotation-double-same-turn",
            })

            yield* chat.send(thread.id, USER_TEXT)
            yield* Effect.sleep("400 millis")

            const messages = yield* store
              .readMessages(thread.id)
              .pipe(Stream.runCollect)
            return Array.from(messages)
              .filter((m) => m.kind === "assistant")
              .map((m) => extractText(m.payload))
          }),
        ).pipe(Effect.provide(layer)),
      )

      // FALSIFIABILITY: pre-fix, `inFlightPrompts` is cleared to `[]` right
      // after the FIRST rotation and never re-seeded for the second attempt,
      // so the second throttle's `inFlight.length > 0` gate reads false and
      // the turn terminally fails right there - invocationCount stuck at 2,
      // no third invocation ever happens, and the turn is never answered.
      expect(invocationCount).toBe(3)
      expect(pulledTextsByInvocation[0]).toEqual([USER_TEXT])
      expect(pulledTextsByInvocation[1]).toEqual([USER_TEXT])
      expect(pulledTextsByInvocation[2]).toEqual([USER_TEXT])
      expect(assistantTexts).toEqual([`rotated-answer:${USER_TEXT}`])
    },
    { timeout: 10_000 },
  )
})

describe("account rotation - the rotation cap is a real bound in both directions (regression: MAX_ORDINARY_ROTATION_ATTEMPTS)", () => {
  it(
    "a THIRD consecutive throttle on the same turn terminally fails instead of producing a fourth attempt, even though a fourth account is still viable",
    async () => {
      const USER_TEXT = "three strikes on this turn, then stop rotating it"

      process.env["LUNA_TEST_ROTATE_CAP_A"] = "tok-cap-a"
      process.env["LUNA_TEST_ROTATE_CAP_B"] = "tok-cap-b"
      process.env["LUNA_TEST_ROTATE_CAP_C"] = "tok-cap-c"
      process.env["LUNA_TEST_ROTATE_CAP_D"] = "tok-cap-d"
      const capSeeds: ReadonlyArray<AccountSeed> = [
        {
          id: "cap-a",
          kind: "anthropic",
          secretRef: "env:LUNA_TEST_ROTATE_CAP_A",
        },
        {
          id: "cap-b",
          kind: "anthropic",
          secretRef: "env:LUNA_TEST_ROTATE_CAP_B",
        },
        {
          id: "cap-c",
          kind: "anthropic",
          secretRef: "env:LUNA_TEST_ROTATE_CAP_C",
        },
        // A FOURTH account that is NEVER used and NEVER throttled - it stays
        // uncooled for the whole test purely so `failoverPossible` reads
        // true right through the THIRD throttle. Without it, the third
        // rotation attempt would ALSO be refused because no account is
        // viable at all (every seeded account cooled) - which would prove
        // nothing about the BUDGET cap specifically. This account isolates
        // the assertion to the cap, not pool exhaustion.
        {
          id: "cap-d",
          kind: "anthropic",
          secretRef: "env:LUNA_TEST_ROTATE_CAP_D",
        },
      ]
      const capBrokerLayer: Layer.Layer<AccountBroker> =
        AccountBrokerLayer.fromAccounts(capSeeds).pipe(
          Layer.provide(Layer.mergeAll(EnvSecretProvider.Default, testClock)),
        )
      const capBaseLayer = Layer.mergeAll(
        SessionStore.Default,
        testClock,
        obsLayer,
        telemetryLayer,
        Layer.succeed(MemoryRouterTag, noopMemoryRouter),
        capBrokerLayer,
      )

      let invocationCount = 0
      const fakeLayer = SDKClient.fake((p) => {
        invocationCount += 1
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          for await (const _u of p.prompt as AsyncIterable<SDKUserMessage>) {
            // EVERY invocation throttles early on this one turn - proving
            // rotation stops at exactly 3 total attempts (2 rotations),
            // neither collapsing early (the pre-fix desync's failure mode)
            // nor continuing past the documented budget onto the still-
            // viable fourth account.
            throw new Error(
              "Session limit reached for this account. Please wait and retry.",
            )
          }
        }
        return wrapAsQuery(gen())
      })

      const layer = Layer.provideMerge(
        ChatService.Default,
        Layer.provideMerge(
          SDKAdapter.WithBroker,
          Layer.mergeAll(fakeLayer, capBaseLayer),
        ),
      )

      const frames: Array<ChatFrame> = []
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const thread = yield* chat.createThread({
              model: "claude-test",
              title: "rotation-cap-real-bound",
            })
            const collector = yield* Effect.forkChild(
              chat.subscribe(thread.id).pipe(
                Stream.runForEach((f) => Effect.sync(() => frames.push(f))),
              ),
            )
            yield* Effect.sleep("5 millis")
            yield* chat.send(thread.id, USER_TEXT)
            yield* Effect.sleep("400 millis")
            yield* Fiber.interrupt(collector)
          }),
        ).pipe(Effect.provide(layer)),
      )

      // MAX_ORDINARY_ROTATION_ATTEMPTS = 3 pins BOTH directions here: pre-fix
      // the desync collapses this to 2 (wrong - too few), and an unbounded
      // or miscounted budget would let it reach 4 via cap-d (wrong - too
      // many). Exactly 3 is the only value this fix should ever produce.
      expect(invocationCount).toBe(3)
      const errorFrame = frames.find(
        (f) =>
          f.type === "assistant-error" &&
          f.error.message.includes("Session limit reached"),
      )
      expect(errorFrame).toBeDefined()
      // This must be the ORDINARY terminal-failure frame, not the rotation
      // "switched accounts" history-drop notice - no turn ever completed on
      // this thread, so that notice is correctly suppressed regardless (see
      // the history-drop describe block above); asserting its absence here
      // pins that this really is the terminal give-up path.
      const rotationNoticeFrame = frames.find(
        (f) =>
          f.type === "assistant-error" &&
          f.error.message.includes("Switched to another account"),
      )
      expect(rotationNoticeFrame).toBeUndefined()
    },
    { timeout: 10_000 },
  )
})

describe("account rotation - pipelined rotation across turns (regression: result head-shift desync)", () => {
  it(
    "rotates a NEXT turn that arrived and throttled while the PRIOR turn's rotated attempt was still finishing, instead of terminally failing it",
    async () => {
      const TEXT_N = "turn N - will rotate once, then complete"
      const TEXT_N_PLUS_1 =
        "turn N+1 - sent before turn N's result, must also rotate"

      process.env["LUNA_TEST_ROTATE_PIPE_A"] = "tok-pipe-a"
      process.env["LUNA_TEST_ROTATE_PIPE_B"] = "tok-pipe-b"
      process.env["LUNA_TEST_ROTATE_PIPE_C"] = "tok-pipe-c"
      const pipeSeeds: ReadonlyArray<AccountSeed> = [
        {
          id: "pipe-a",
          kind: "anthropic",
          secretRef: "env:LUNA_TEST_ROTATE_PIPE_A",
        },
        {
          id: "pipe-b",
          kind: "anthropic",
          secretRef: "env:LUNA_TEST_ROTATE_PIPE_B",
        },
        {
          id: "pipe-c",
          kind: "anthropic",
          secretRef: "env:LUNA_TEST_ROTATE_PIPE_C",
        },
      ]
      const pipeBrokerLayer: Layer.Layer<AccountBroker> =
        AccountBrokerLayer.fromAccounts(pipeSeeds).pipe(
          Layer.provide(Layer.mergeAll(EnvSecretProvider.Default, testClock)),
        )
      const pipeBaseLayer = Layer.mergeAll(
        SessionStore.Default,
        testClock,
        obsLayer,
        telemetryLayer,
        Layer.succeed(MemoryRouterTag, noopMemoryRouter),
        pipeBrokerLayer,
      )

      let invocationCount = 0
      const pulledTextsByInvocation: Array<Array<string>> = []

      // Holds the SECOND invocation (the rotated attempt for turn N) mid-turn
      // - after it has pulled turn N's payload but BEFORE it yields turn N's
      // assistant/result messages - so the test can send turn N+1 into
      // `inbox` while turn N is still unresolved, exactly the pipelining
      // window Consequence 2 describes ("t6 arrives... before attempt 2
      // finishes t5").
      let releaseTurnNResult: (() => void) | null = null
      const turnNResultGate = new Promise<void>((resolve) => {
        releaseTurnNResult = resolve
      })

      const fakeLayer = SDKClient.fake((p) => {
        invocationCount += 1
        const myInvocation = invocationCount
        pulledTextsByInvocation[myInvocation - 1] = []
        let pulledInThisInvocation = 0

        async function* gen(): AsyncGenerator<SDKMessage, void> {
          for await (const u of p.prompt as AsyncIterable<SDKUserMessage>) {
            pulledInThisInvocation += 1
            const text = extractPromptText(u)
            pulledTextsByInvocation[myInvocation - 1]!.push(text)

            if (myInvocation === 1) {
              // Attempt 1 (account A): early throttle on turn N, before any
              // assistant content - rotates to account B.
              throw new Error(
                "Session limit reached for this account. Please wait and retry.",
              )
            }

            if (myInvocation === 2 && pulledInThisInvocation === 1) {
              // Attempt 2 (account B), rotated for turn N: hold here -
              // turn N's result has NOT been emitted yet - so the test can
              // send turn N+1 while turn N is still the thread's only
              // unresolved turn.
              await turnNResultGate
              yield makeAssistantMessage(
                "sess-pipe-b",
                `ans:${text}`,
                "a-pipe-b-1",
              )
              yield makeResultMessage("sess-pipe-b", "r-pipe-b-1")
              continue
            }

            if (myInvocation === 2 && pulledInThisInvocation === 2) {
              // The SAME still-live attempt 2 then pulls turn N+1 (offered
              // right after turn N's result closed it) and throttles again,
              // early, before any assistant content for THIS turn - must
              // rotate to account C.
              throw new Error(
                "Session limit reached for this account. Please wait and retry.",
              )
            }

            // Attempt 3 (account C), rotated for turn N+1: succeeds.
            yield makeAssistantMessage(
              "sess-pipe-c",
              `ans:${text}`,
              "a-pipe-c-1",
            )
            yield makeResultMessage("sess-pipe-c", "r-pipe-c-1")
          }
        }
        return wrapAsQuery(gen())
      })

      const layer = Layer.provideMerge(
        ChatService.Default,
        Layer.provideMerge(
          SDKAdapter.WithBroker,
          Layer.mergeAll(fakeLayer, pipeBaseLayer),
        ),
      )

      const assistantTexts = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const store = yield* SessionStore
            const thread = yield* chat.createThread({
              model: "claude-test",
              title: "rotation-pipelined",
            })

            yield* chat.send(thread.id, TEXT_N)
            // Let attempt 1 throttle, rotate, and let attempt 2 pull turn N
            // and start blocking on `turnNResultGate`.
            yield* Effect.sleep("120 millis")
            // Turn N+1 sent BEFORE turn N's result has arrived.
            yield* chat.send(thread.id, TEXT_N_PLUS_1)
            // Let the forwarder actually pull TEXT_N_PLUS_1 off `inbox` and
            // append it, so it is genuinely queued (not a race) before the
            // gate releases.
            yield* Effect.sleep("120 millis")
            yield* Effect.sync(() => releaseTurnNResult!())
            // Let turn N's result land, turn N+1's throttle fire, the
            // rotation to account C happen, and turn N+1 finish.
            yield* Effect.sleep("500 millis")

            const messages = yield* store
              .readMessages(thread.id)
              .pipe(Stream.runCollect)
            return Array.from(messages)
              .filter((m) => m.kind === "assistant")
              .map((m) => extractText(m.payload))
          }),
        ).pipe(Effect.provide(layer)),
      )

      // FALSIFIABILITY: pre-fix, `inFlightPrompts` is `[]` when attempt 2
      // starts (seedTurns only reached `attemptQueue`, never the tracking
      // Ref), so when turn N+1 arrives via the forwarder it becomes the
      // ONLY entry - `[TEXT_N_PLUS_1]`. Turn N's `result` then shifts THAT
      // off the head (the head-shift's FIFO assumption broken), leaving
      // `[]` while turn N+1 is genuinely still unresolved. Turn N+1's own
      // throttle then reads `inFlight = []` and terminally fails instead of
      // rotating: invocationCount stuck at 2, and only turn N is ever
      // answered.
      expect(invocationCount).toBe(3)
      expect(pulledTextsByInvocation[0]).toEqual([TEXT_N])
      expect(pulledTextsByInvocation[1]).toEqual([TEXT_N, TEXT_N_PLUS_1])
      expect(pulledTextsByInvocation[2]).toEqual([TEXT_N_PLUS_1])
      expect(assistantTexts).toEqual([`ans:${TEXT_N}`, `ans:${TEXT_N_PLUS_1}`])
    },
    { timeout: 10_000 },
  )
})
