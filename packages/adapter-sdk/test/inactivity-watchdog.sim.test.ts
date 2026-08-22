/**
 * Inactivity watchdog (interactive chat turns) — production bug fix.
 *
 * THE BUG (observed live): when a Claude *subscription* account hits its usage
 * limit, the spawned `claude` CLI subprocess hangs internally retrying the
 * throttle instead of surfacing a 429. The SDK iterator blocks (epoll on
 * api.anthropic.com) for 200-700s, never yields, never throws. Chat threads run
 * with `disableIdleTimeout: true` (user think-time between turns can be hours),
 * so the ONLY existing watchdog is off — the broker never sees a throttle,
 * never cools the account, never fails over, and the UI hangs forever on
 * "working on it".
 *
 * THE FIX (this watchdog): a TURN-AWARE inactivity timer, active ONLY on chat
 * threads (`disableIdleTimeout: true`). It is ARMED while a turn is in flight
 * (a user prompt was offered and no `result` frame has closed it yet) and
 * DISARMED between turns (so an hours-long think-time pause never trips). On
 * trip it (a) aborts the SDK query to kill the subprocess, (b) reports a
 * `rate_limit` to the broker so the account cools and the next message routes
 * elsewhere, and (c) fails the turn with a clean SDKError that chat-service
 * turns into an `assistant-error` ChatFrame.
 *
 * These tests use a fake SDK whose iterator HANGS after the turn's messages
 * (never yields, never returns) — the key fixture for reproducing the live
 * hang without the network.
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer, Queue, Scope, Stream } from "effect"
import {
  SessionStore,
  Clock as CoreClock,
  AccountBroker,
  AccountBrokerLayer,
  EnvSecretProvider,
  type AccountSeed,
  type UsageReport,
} from "@luna/core"
import { SDKAdapter, SDKClient } from "../src/index.js"
import type { Query, SDKMessage, SDKUserMessage } from "../src/sdk-client.js"
import { makeAssistantMessage, makeResultMessage } from "./fake-sdk.js"

const sid = "s-watchdog"

// Env tokens for the test accounts (mirrors adapter-rotation.sim.test.ts).
process.env.WD_TOK_A1 = "tok-wd1"
process.env.WD_TOK_A2 = "tok-wd2"

const twoAccounts: ReadonlyArray<AccountSeed> = [
  { id: "wd1", kind: "anthropic", secretRef: "env:WD_TOK_A1" },
  { id: "wd2", kind: "anthropic", secretRef: "env:WD_TOK_A2" },
]

const oneAccount: ReadonlyArray<AccountSeed> = [
  { id: "wd1", kind: "anthropic", secretRef: "env:WD_TOK_A1" },
]

const userMsg = (text: string): SDKUserMessage =>
  ({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  }) as SDKUserMessage

const controlMethods = {
  interrupt: async () => {},
  setPermissionMode: async () => {},
  setModel: async () => {},
  setMaxThinkingTokens: async () => {},
  supplyToolPermissionResponse: async () => {},
  mcpServerStatus: async () => ({}),
} as const

/**
 * Fake Query that drains the inbound prompt iterable and, for each user turn,
 * emits one assistant frame and then HANGS forever (never the result, never
 * returns) — reproducing the live "subprocess wedged retrying the throttle"
 * shape. Honors the AbortController so the producer's `for await` unblocks when
 * the watchdog aborts (the real SDK is expected to do the same).
 */
const makeHangingAfterFirstFrameQuery = (params: {
  readonly prompt: AsyncIterable<SDKUserMessage>
  readonly sessionId: string
  readonly signal?: AbortSignal
}): Query => {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    for await (const _u of params.prompt) {
      yield makeAssistantMessage(params.sessionId, "thinking…", `a-${Date.now()}`)
      // Wedge: never yield the result. Resolve only when aborted, so the
      // detached producer can exit instead of leaking for the whole suite.
      await new Promise<void>((resolve) => {
        if (params.signal) {
          if (params.signal.aborted) return resolve()
          params.signal.addEventListener("abort", () => resolve(), { once: true })
        }
      })
      return
    }
  }
  const iterator = gen()
  return Object.assign(iterator, controlMethods) as Query
}

/**
 * Fake Query that, for each user turn, streams `frames` assistant deltas
 * `gapMs` apart, then a result — a SLOW-but-ALIVE turn. Used to prove that
 * streaming activity keeps the watchdog from tripping even when the per-frame
 * gap individually approaches the inactivity window.
 */
const makeSlowAliveQuery = (params: {
  readonly prompt: AsyncIterable<SDKUserMessage>
  readonly sessionId: string
  readonly frames: number
  readonly gapMs: number
}): Query => {
  let turn = 0
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    for await (const _u of params.prompt) {
      turn += 1
      for (let i = 0; i < params.frames; i++) {
        await new Promise((r) => setTimeout(r, params.gapMs))
        yield makeAssistantMessage(params.sessionId, `chunk ${i}`, `a-${turn}-${i}`)
      }
      await new Promise((r) => setTimeout(r, params.gapMs))
      yield makeResultMessage(params.sessionId, `r-${turn}`)
    }
  }
  const iterator = gen()
  return Object.assign(iterator, controlMethods) as Query
}

// ── Broker spy (records report calls) — mirrors adapter-rotation.sim.test.ts ──
interface BrokerSpy {
  readonly reports: UsageReport[]
}
const reportSpyLayer = (
  spy: BrokerSpy,
): Layer.Layer<AccountBroker, never, AccountBroker> =>
  Layer.effect(
    AccountBroker,
    Effect.gen(function* () {
      const inner = yield* AccountBroker
      return {
        ...inner,
        report: (usage: UsageReport) => {
          spy.reports.push(usage)
          return inner.report(usage)
        },
      }
    }),
  )

const baseLayer = Layer.mergeAll(SessionStore.Default, CoreClock.Default)

/** Build a WithBroker adapter layer + broker spy over a given seed set. */
const buildBrokeredLayer = (
  build: (params: {
    prompt: AsyncIterable<SDKUserMessage>
    signal?: AbortSignal
  }) => Query,
  spy: BrokerSpy,
  seeds: ReadonlyArray<AccountSeed>,
) => {
  const sdkLayer = SDKClient.fake((p) =>
    build({
      prompt: p.prompt as AsyncIterable<SDKUserMessage>,
      signal: p.options?.abortController?.signal,
    }),
  )
  const brokerL = AccountBrokerLayer.fromAccounts(seeds).pipe(
    Layer.provide(Layer.mergeAll(EnvSecretProvider.Default, CoreClock.Default)),
  )
  const spiedBrokerL = reportSpyLayer(spy).pipe(Layer.provide(brokerL))
  return Layer.provideMerge(
    SDKAdapter.WithBroker,
    Layer.mergeAll(sdkLayer, baseLayer, spiedBrokerL),
  )
}

describe("SDKAdapter inactivity watchdog (chat threads)", () => {
  it(
    "(a) trips after the inactivity window when a turn hangs mid-stream, surfacing a clean SDKError",
    async () => {
      const spy: BrokerSpy = { reports: [] }
      const layer = buildBrokeredLayer(
        makeHangingAfterFirstFrameQuery as never,
        spy,
        twoAccounts,
      )

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SessionStore
            yield* store.create({ id: sid, options: { model: "m" }, createdAt: 0 })
            const inbox = yield* Queue.unbounded<SDKUserMessage>()
            const adapter = yield* SDKAdapter
            const out = yield* adapter.query({
              sessionId: sid,
              prompt: Stream.fromQueue(inbox),
              sessionOptions: {
                model: "m",
                disableIdleTimeout: true,
                // Short window so the test runs fast.
                turnInactivityTimeoutMs: 150,
                sdkOptions: { model: "m" },
              },
            })
            yield* Queue.offer(inbox, userMsg("big context turn"))
            // Drain: the assistant frame arrives, then the hang → watchdog trips.
            yield* Stream.runDrain(out)
          }),
        ).pipe(Effect.provide(layer)),
      )

      // The turn ends with a failure (NOT a hang — the test would time out).
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const j = JSON.stringify(exit.cause)
        expect(j).toContain("SDKError")
        // Operator-facing: account label + "resend" guidance.
        expect(j.toLowerCase()).toContain("stalled")
      }
    },
    { timeout: 10_000 },
  )

  it(
    "(c) on trip, the acquired account is cooled via broker.report({kind:'rate_limit'})",
    async () => {
      const spy: BrokerSpy = { reports: [] }
      const layer = buildBrokeredLayer(
        makeHangingAfterFirstFrameQuery as never,
        spy,
        twoAccounts,
      )

      await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SessionStore
            yield* store.create({ id: sid, options: { model: "m" }, createdAt: 0 })
            const inbox = yield* Queue.unbounded<SDKUserMessage>()
            const adapter = yield* SDKAdapter
            const out = yield* adapter.query({
              sessionId: sid,
              prompt: Stream.fromQueue(inbox),
              sessionOptions: {
                model: "m",
                disableIdleTimeout: true,
                turnInactivityTimeoutMs: 150,
                hangCooldownMs: 900_000,
                sdkOptions: { model: "m" },
              },
            })
            yield* Queue.offer(inbox, userMsg("hang me"))
            yield* Stream.runDrain(out)
          }),
        ).pipe(Effect.provide(layer)),
      )

      // Fire-and-forget report — give it a tick to flush.
      await new Promise((r) => setTimeout(r, 30))
      const rl = spy.reports.filter((r) => r.kind === "rate_limit")
      expect(rl.length).toBeGreaterThanOrEqual(1)
      const first = rl[0]
      if (first && first.kind === "rate_limit") {
        // The hang cooldown (15min default; 900_000 set above) is passed as
        // retryAfterMs so the broker cools for the long window, not the short
        // transient-429 default.
        expect(first.retryAfterMs).toBe(900_000)
      }
      // The cooled account is one of the pool's (acquired) ids.
      const cooledId = rl[0]?.accountId
      expect(["wd1", "wd2"]).toContain(cooledId)
    },
    { timeout: 10_000 },
  )

  it(
    "(c2) cools EVEN a single-account pool (hang is not a transient 429 — diverges from BLOCKER#1)",
    async () => {
      const spy: BrokerSpy = { reports: [] }
      const layer = buildBrokeredLayer(
        makeHangingAfterFirstFrameQuery as never,
        spy,
        oneAccount,
      )

      await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SessionStore
            yield* store.create({ id: sid, options: { model: "m" }, createdAt: 0 })
            const inbox = yield* Queue.unbounded<SDKUserMessage>()
            const adapter = yield* SDKAdapter
            const out = yield* adapter.query({
              sessionId: sid,
              prompt: Stream.fromQueue(inbox),
              sessionOptions: {
                model: "m",
                disableIdleTimeout: true,
                turnInactivityTimeoutMs: 150,
                sdkOptions: { model: "m" },
              },
            })
            yield* Queue.offer(inbox, userMsg("hang me"))
            yield* Stream.runDrain(out)
          }),
        ).pipe(Effect.provide(layer)),
      )

      await new Promise((r) => setTimeout(r, 30))
      const rl = spy.reports.filter((r) => r.kind === "rate_limit")
      // Unlike the 429 path (gated on failoverPossible), the hang path cools
      // even when there is no failover target — the turn is already dead.
      expect(rl.length).toBeGreaterThanOrEqual(1)
      expect(rl[0]?.accountId).toBe("wd1")
    },
    { timeout: 10_000 },
  )

  it(
    "(a2) on trip the SDK query is ABORTED so the wedged subprocess dies",
    async () => {
      const spy: BrokerSpy = { reports: [] }
      // Capture the abort signal the adapter wired into the query so we can
      // assert the watchdog fired it (requirement 2a — the live bug was the
      // subprocess NOT dying).
      let capturedSignal: AbortSignal | undefined
      const sdkLayer = SDKClient.fake((p) => {
        capturedSignal = p.options?.abortController?.signal
        return makeHangingAfterFirstFrameQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: sid,
          signal: capturedSignal,
        })
      })
      const brokerL = AccountBrokerLayer.fromAccounts(twoAccounts).pipe(
        Layer.provide(
          Layer.mergeAll(EnvSecretProvider.Default, CoreClock.Default),
        ),
      )
      const spiedBrokerL = reportSpyLayer(spy).pipe(Layer.provide(brokerL))
      const layer = Layer.provideMerge(
        SDKAdapter.WithBroker,
        Layer.mergeAll(sdkLayer, baseLayer, spiedBrokerL),
      )

      await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SessionStore
            yield* store.create({ id: sid, options: { model: "m" }, createdAt: 0 })
            const inbox = yield* Queue.unbounded<SDKUserMessage>()
            const adapter = yield* SDKAdapter
            const out = yield* adapter.query({
              sessionId: sid,
              prompt: Stream.fromQueue(inbox),
              sessionOptions: {
                model: "m",
                disableIdleTimeout: true,
                turnInactivityTimeoutMs: 150,
                sdkOptions: { model: "m" },
              },
            })
            yield* Queue.offer(inbox, userMsg("hang me"))
            yield* Stream.runDrain(out)
          }),
        ).pipe(Effect.provide(layer)),
      )

      expect(capturedSignal?.aborted).toBe(true)
    },
    { timeout: 10_000 },
  )

  it(
    "(b) a slow-but-ALIVE stream does NOT trip — streaming activity resets the window",
    async () => {
      const spy: BrokerSpy = { reports: [] }
      const layer = buildBrokeredLayer(
        ((p: { prompt: AsyncIterable<SDKUserMessage> }) =>
          makeSlowAliveQuery({
            prompt: p.prompt,
            sessionId: sid,
            frames: 5, // 5 deltas + 1 result
            gapMs: 60, // each gap < the 150ms window
          })) as never,
        spy,
        twoAccounts,
      )

      const collected = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SessionStore
            yield* store.create({ id: sid, options: { model: "m" }, createdAt: 0 })
            const inbox = yield* Queue.unbounded<SDKUserMessage>()
            const adapter = yield* SDKAdapter
            const out = yield* adapter.query({
              sessionId: sid,
              prompt: Stream.fromQueue(inbox),
              sessionOptions: {
                model: "m",
                disableIdleTimeout: true,
                // Total turn ≈ 6×60 = 360ms > the 150ms window, but each gap is
                // < window, so per-frame activity keeps it alive.
                turnInactivityTimeoutMs: 150,
                sdkOptions: { model: "m" },
              },
            })
            yield* Queue.offer(inbox, userMsg("slow but alive"))
            const c = yield* out.pipe(Stream.take(6), Stream.runCollect)
            return Array.from(c).length
          }),
        ).pipe(Effect.provide(layer)),
      )

      expect(collected).toBe(6) // 5 assistant deltas + 1 result, no trip
      expect(spy.reports.filter((r) => r.kind === "rate_limit").length).toBe(0)
    },
    { timeout: 10_000 },
  )

  it(
    "(b2) an inter-turn pause LONGER than the window does NOT trip (watchdog disarmed between turns)",
    async () => {
      const spy: BrokerSpy = { reports: [] }
      const layer = buildBrokeredLayer(
        ((p: { prompt: AsyncIterable<SDKUserMessage> }) =>
          makeSlowAliveQuery({
            prompt: p.prompt,
            sessionId: sid,
            frames: 1, // 1 delta + 1 result per turn
            gapMs: 10,
          })) as never,
        spy,
        twoAccounts,
      )

      const collected = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SessionStore
            yield* store.create({ id: sid, options: { model: "m" }, createdAt: 0 })
            const inbox = yield* Queue.unbounded<SDKUserMessage>()
            const adapter = yield* SDKAdapter
            const out = yield* adapter.query({
              sessionId: sid,
              prompt: Stream.fromQueue(inbox),
              sessionOptions: {
                model: "m",
                disableIdleTimeout: true,
                turnInactivityTimeoutMs: 120,
                sdkOptions: { model: "m" },
              },
            })

            const consumer = out.pipe(Stream.take(4), Stream.runCollect)
            const producer = Effect.gen(function* () {
              yield* Queue.offer(inbox, userMsg("first"))
              // Pause between turns far longer than the window — must NOT trip,
              // because the result frame DISARMS the watchdog.
              yield* Effect.sleep("300 millis")
              yield* Queue.offer(inbox, userMsg("second"))
              yield* Effect.sleep("50 millis")
              yield* Queue.end(inbox)
            })
            const [c] = yield* Effect.all([consumer, producer], {
              concurrency: 2,
            })
            return Array.from(c).length
          }),
        ).pipe(Effect.provide(layer)),
      )

      expect(collected).toBe(4) // 2 turns × (delta + result), no trip
      expect(spy.reports.filter((r) => r.kind === "rate_limit").length).toBe(0)
    },
    { timeout: 10_000 },
  )

  it(
    "(f) NON-chat caller (no disableIdleTimeout) is UNCHANGED — hang surfaces the original idle-timeout op, NOT the watchdog",
    async () => {
      const spy: BrokerSpy = { reports: [] }
      const layer = buildBrokeredLayer(
        makeHangingAfterFirstFrameQuery as never,
        spy,
        twoAccounts,
      )

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SessionStore
            yield* store.create({ id: sid, options: { model: "m" }, createdAt: 0 })
            const inbox = yield* Queue.unbounded<SDKUserMessage>()
            const adapter = yield* SDKAdapter
            const out = yield* adapter.query({
              sessionId: sid,
              prompt: Stream.fromQueue(inbox),
              sessionOptions: {
                model: "m",
                // NO disableIdleTimeout → the ORIGINAL always-on idle race.
                idleTimeoutMs: 150,
                // Even if a turn-watchdog value is present, it must be ignored
                // off the chat path.
                turnInactivityTimeoutMs: 10_000,
                sdkOptions: { model: "m" },
              },
            })
            yield* Queue.offer(inbox, userMsg("hang"))
            yield* Stream.runDrain(out)
          }),
        ).pipe(Effect.provide(layer)),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const j = JSON.stringify(exit.cause)
        // The ORIGINAL idle-timeout path fired — proving the new code did not
        // hijack the non-chat behavior. (The watchdog op never appears.)
        expect(j).toContain("idle-timeout")
        expect(j).not.toContain("inactivity-watchdog")
      }
      // Non-chat hang surfaces an `error` report (existing behavior), NOT the
      // watchdog's rate_limit cool.
      expect(spy.reports.filter((r) => r.kind === "rate_limit").length).toBe(0)
    },
    { timeout: 10_000 },
  )

  it(
    "(e) watchdog DISABLED when turnInactivityTimeoutMs=0 — a hang is NOT converted (legacy disableIdleTimeout behavior)",
    async () => {
      const spy: BrokerSpy = { reports: [] }
      const layer = buildBrokeredLayer(
        makeHangingAfterFirstFrameQuery as never,
        spy,
        twoAccounts,
      )

      const raced = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SessionStore
            yield* store.create({ id: sid, options: { model: "m" }, createdAt: 0 })
            const inbox = yield* Queue.unbounded<SDKUserMessage>()
            const adapter = yield* SDKAdapter
            const out = yield* adapter.query({
              sessionId: sid,
              prompt: Stream.fromQueue(inbox),
              sessionOptions: {
                model: "m",
                disableIdleTimeout: true,
                turnInactivityTimeoutMs: 0, // explicit disable
                sdkOptions: { model: "m" },
              },
            })
            yield* Queue.offer(inbox, userMsg("hang with watchdog off"))
            // With the watchdog OFF the drain would hang forever; race it
            // against a 400ms timer that wins → proves NO trip occurred.
            return yield* out.pipe(
              Stream.runDrain,
              Effect.timeoutTo({
                duration: "400 millis",
                onTimeout: () => "still-hanging" as const,
                onSuccess: () => "ended" as const,
              }),
            )
          }),
        ).pipe(Effect.provide(layer)),
      )

      expect(raced).toBe("still-hanging")
      expect(spy.reports.filter((r) => r.kind === "rate_limit").length).toBe(0)
    },
    { timeout: 10_000 },
  )
})

/* -------------------------------------------------------------------------- */
/* Subagent-aware window. While a Task/Agent tool_use is outstanding the      */
/* parent stream is legitimately silent for the subagent's whole model call,  */
/* so the watchdog widens to LUNA_TASK_INACTIVITY_TIMEOUT_MS (clamped to      */
/* never be tighter than the turn window) — and narrows back once the         */
/* settling tool_result lands. Still bounded: a wedge during a subagent trips */
/* after the task window.                                                     */
/* -------------------------------------------------------------------------- */

const makeAgentSpawnMessage = (
  sessionId: string,
  toolUseId: string,
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
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Agent",
          input: { description: "sub work", prompt: "do it" },
        },
      ],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }) as unknown as SDKMessage

const makeAgentResultMessage = (
  sessionId: string,
  toolUseId: string,
  uuid: string,
): SDKMessage =>
  ({
    type: "user",
    session_id: sessionId,
    uuid,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          is_error: false,
          content: [{ type: "text", text: "sub report" }],
        },
      ],
    },
  }) as unknown as SDKMessage

describe("SDKAdapter inactivity watchdog — subagent-aware window", () => {
  it(
    "(e) does NOT trip during a subagent silence longer than the turn window (but within the task window)",
    async () => {
      process.env.LUNA_TASK_INACTIVITY_TIMEOUT_MS = "2000"
      try {
        const spy: BrokerSpy = { reports: [] }
        // Fake: Agent spawn → 500ms silence (≫ 150ms turn window) →
        // settling tool_result → result. Without the task-aware window the
        // watchdog would trip during the silence.
        const build = (params: {
          prompt: AsyncIterable<SDKUserMessage>
          signal?: AbortSignal
        }): Query => {
          async function* gen(): AsyncGenerator<SDKMessage, void> {
            for await (const _u of params.prompt) {
              yield makeAgentSpawnMessage("s-sub-ok", "agent_tu_1", "a-spawn")
              await new Promise((r) => setTimeout(r, 500))
              yield makeAgentResultMessage("s-sub-ok", "agent_tu_1", "u-settle")
              yield makeResultMessage("s-sub-ok", "r-done")
              return
            }
          }
          return Object.assign(gen(), controlMethods) as Query
        }
        const layer = buildBrokeredLayer(build as never, spy, twoAccounts)

        const exit = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function* () {
              const store = yield* SessionStore
              yield* store.create({
                id: "s-sub-ok",
                options: { model: "m" },
                createdAt: 0,
              })
              const inbox = yield* Queue.unbounded<SDKUserMessage>()
              const adapter = yield* SDKAdapter
              const out = yield* adapter.query({
                sessionId: "s-sub-ok",
                prompt: Stream.fromQueue(inbox),
                sessionOptions: {
                  model: "m",
                  disableIdleTimeout: true,
                  turnInactivityTimeoutMs: 150,
                  sdkOptions: { model: "m" },
                },
              })
              yield* Queue.offer(inbox, userMsg("spawn a subagent"))
              // Take frames until the result lands, then stop draining (the
              // fake's iterator returns after the result).
              yield* Stream.runDrain(out)
            }),
          ).pipe(Effect.provide(layer)),
        )

        // The turn survives the subagent silence: clean end, no cooldown.
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(spy.reports.filter((r) => r.kind === "rate_limit").length).toBe(0)
      } finally {
        delete process.env.LUNA_TASK_INACTIVITY_TIMEOUT_MS
      }
    },
    { timeout: 10_000 },
  )

  it(
    "(f) still trips — bounded — when the silence exceeds the task window with a subagent outstanding",
    async () => {
      process.env.LUNA_TASK_INACTIVITY_TIMEOUT_MS = "300"
      try {
        const spy: BrokerSpy = { reports: [] }
        // Fake: Agent spawn → wedge forever (abort-aware).
        const build = (params: {
          prompt: AsyncIterable<SDKUserMessage>
          signal?: AbortSignal
        }): Query => {
          async function* gen(): AsyncGenerator<SDKMessage, void> {
            for await (const _u of params.prompt) {
              yield makeAgentSpawnMessage("s-sub-wedge", "agent_tu_2", "a-spawn2")
              await new Promise<void>((resolve) => {
                if (params.signal) {
                  if (params.signal.aborted) return resolve()
                  params.signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  })
                }
              })
              return
            }
          }
          return Object.assign(gen(), controlMethods) as Query
        }
        const layer = buildBrokeredLayer(build as never, spy, twoAccounts)

        const exit = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function* () {
              const store = yield* SessionStore
              yield* store.create({
                id: "s-sub-wedge",
                options: { model: "m" },
                createdAt: 0,
              })
              const inbox = yield* Queue.unbounded<SDKUserMessage>()
              const adapter = yield* SDKAdapter
              const out = yield* adapter.query({
                sessionId: "s-sub-wedge",
                prompt: Stream.fromQueue(inbox),
                sessionOptions: {
                  model: "m",
                  disableIdleTimeout: true,
                  turnInactivityTimeoutMs: 150,
                  sdkOptions: { model: "m" },
                },
              })
              yield* Queue.offer(inbox, userMsg("spawn and wedge"))
              yield* Stream.runDrain(out)
            }),
          ).pipe(Effect.provide(layer)),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const j = JSON.stringify(exit.cause)
          expect(j).toContain("SDKError")
          expect(j).toContain("subagent")
        }
        // Account still cooled on a real trip.
        expect(
          spy.reports.filter((r) => r.kind === "rate_limit").length,
        ).toBeGreaterThan(0)
      } finally {
        delete process.env.LUNA_TASK_INACTIVITY_TIMEOUT_MS
      }
    },
    { timeout: 10_000 },
  )
})
