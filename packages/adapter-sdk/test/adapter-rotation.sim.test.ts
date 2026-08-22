/**
 * SDKAdapter rotation simulation (§8.2).
 *
 * Drives the broker-bound adapter through multiple sequential queries
 * with a fake SDK that records the env tokens it sees. Validates:
 *   - Round-robin spread across 3 accounts (per rotation-policy).
 *   - All-exhausted → SDKError with AllAccountsExhaustedError cause.
 *   - Scope alignment: open Scope ⇒ inFlight=1; close Scope ⇒ inFlight=0.
 *   - Sticky-pin (boundAccountId) honored.
 *   - broker.report({kind:"success"}) on clean stream end;
 *     broker.report({kind:"error"}) on terminal stream error.
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer, Logger, Scope, Stream } from "effect"
import {
  SessionStore,
  Clock as CoreClock,
  AccountBroker,
  AccountBrokerLayer,
  CLAUDE_CODE_LOGIN_SECRET_REF,
  EnvSecretProvider,
  type AccountSeed,
  type UsageReport,
  AllAccountsExhaustedError,
} from "@luna/core"
import { SDKAdapter, SDKClient } from "../src/index.js"
import type { Options, Query, SDKMessage, SDKUserMessage } from "../src/sdk-client.js"

const sid = "s-rot"

// Set up env tokens for the three test accounts.
process.env.ROT_TOK_A1 = "tok-a1"
process.env.ROT_TOK_A2 = "tok-a2"
process.env.ROT_TOK_A3 = "tok-a3"

const seeds: ReadonlyArray<AccountSeed> = [
  { id: "a1", kind: "anthropic", secretRef: "env:ROT_TOK_A1" },
  { id: "a2", kind: "anthropic", secretRef: "env:ROT_TOK_A2" },
  { id: "a3", kind: "anthropic", secretRef: "env:ROT_TOK_A3" },
]

const tokenById: Record<string, string> = {
  "tok-a1": "a1",
  "tok-a2": "a2",
  "tok-a3": "a3",
}

// Build a fake Query that closes immediately. Optionally throws.
const makeFakeIterable = (throwOnIterate: boolean): Query => {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    if (throwOnIterate) throw new Error("fake-sdk: simulated terminal failure")
    return
  }
  const iterator = gen()
  return Object.assign(iterator, {
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    applyFlagSettings: async () => {},
    setMaxThinkingTokens: async () => {},
    supplyToolPermissionResponse: async () => {},
    mcpServerStatus: async () => ({}),
  } as Partial<Query>) as Query
}

// Fake Query that throws immediately with a message `classifyThrottle`
// recognizes (BLOCKER #3 tests below need a THROTTLE-classified failure so
// `reportRateLimitIfThrottled` actually runs the re-check, not just any
// terminal error).
const makeThrottleIterable = (message: string): Query => {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    throw new Error(message)
  }
  const iterator = gen()
  return Object.assign(iterator, {
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    applyFlagSettings: async () => {},
    setMaxThinkingTokens: async () => {},
    supplyToolPermissionResponse: async () => {},
    mcpServerStatus: async () => ({}),
  } as Partial<Query>) as Query
}

/** Fake Query that yields ONE result message carrying turn-level token usage. */
const makeResultWithUsage = (usage: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}): Query => {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    yield {
      type: "result",
      subtype: "success",
      session_id: "sid",
      uuid: "u-result",
      is_error: false,
      duration_ms: 10,
      duration_api_ms: 5,
      num_turns: 1,
      result: "ok",
      usage,
    } as unknown as SDKMessage
  }
  const iterator = gen()
  return Object.assign(iterator, {
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    applyFlagSettings: async () => {},
    setMaxThinkingTokens: async () => {},
    supplyToolPermissionResponse: async () => {},
    mcpServerStatus: async () => ({}),
  } as Partial<Query>) as Query
}

interface FakeRecorder {
  readonly tokensSeen: string[]
  readonly layer: Layer.Layer<SDKClient>
  setThrowOnIterate: (v: boolean) => void
}
const makeRecordingFake = (): FakeRecorder => {
  const tokensSeen: string[] = []
  const cfg = { throwOnIterate: false }
  const layer = SDKClient.fake((params) => {
    const env = (params.options as Options | undefined)?.env as
      | Record<string, string | undefined>
      | undefined
    const tok = env?.CLAUDE_CODE_OAUTH_TOKEN
    if (typeof tok === "string") tokensSeen.push(tok)
    return makeFakeIterable(cfg.throwOnIterate)
  })
  return {
    tokensSeen,
    layer,
    setThrowOnIterate: (v) => (cfg.throwOnIterate = v),
  }
}

// Spy wrapper around AccountBroker that records `report` calls.
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

const baseLayer = Layer.mergeAll(
  SessionStore.Default,
  CoreClock.Default,
)

const buildLayer = (
  recorder: FakeRecorder,
  spy: BrokerSpy,
  accountSeeds: ReadonlyArray<AccountSeed> = seeds,
) => {
  const brokerL = AccountBrokerLayer.fromAccounts(accountSeeds).pipe(
    Layer.provide(Layer.mergeAll(EnvSecretProvider.Default, CoreClock.Default)),
  )
  const spiedBrokerL = reportSpyLayer(spy).pipe(Layer.provide(brokerL))
  return Layer.provideMerge(
    SDKAdapter.WithBroker,
    Layer.mergeAll(recorder.layer, baseLayer, spiedBrokerL),
  )
}

const emptyPrompt: Stream.Stream<SDKUserMessage> = Stream.empty

let sidCounter = 0
const runOneQuery = (
  adapter: typeof SDKAdapter.Service,
  store: typeof SessionStore.Service,
  boundAccountId?: string,
  /** When set, threads `sdkOptions.model` so the broker routes by this lane. */
  lane?: string,
) =>
  Effect.gen(function* () {
    const localSid = `${sid}-${sidCounter++}`
    yield* store.create({
      id: localSid,
      options: { model: "m" },
      createdAt: 0,
    })
    const out = yield* adapter.query({
      sessionId: localSid,
      prompt: emptyPrompt,
      sessionOptions: {
        model: "m",
        idleTimeoutMs: 5_000,
        ...(lane !== undefined ? { sdkOptions: { model: lane } } : {}),
      },
      ...(boundAccountId !== undefined ? { boundAccountId } : {}),
    })
    yield* Stream.runDrain(out)
  })

describe("SDKAdapter rotation simulation (WithBroker)", () => {
  it("6 sequential queries → all 3 accounts used (round-robin)", async () => {
    const recorder = makeRecordingFake()
    const spy: BrokerSpy = { reports: [] }
    const layer = buildLayer(recorder, spy)

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* SDKAdapter
        const store = yield* SessionStore
        for (let i = 0; i < 6; i++) {
          // Reset session row each iteration to keep store happy.
          yield* Effect.scoped(runOneQuery(adapter, store, undefined))
        }
      }).pipe(Effect.provide(layer)),
    )

    // Map each token back to its account id.
    const accountsUsed = recorder.tokensSeen.map((t) => tokenById[t])
    expect(new Set(accountsUsed)).toEqual(new Set(["a1", "a2", "a3"]))
    // 6 queries, expected balanced load (2 each by round-robin).
    expect(recorder.tokensSeen).toHaveLength(6)
  })

  it("all accounts in cooldown → SDKError(op:'acquire-session') wrapping AllAccountsExhausted", async () => {
    const recorder = makeRecordingFake()
    const spy: BrokerSpy = { reports: [] }
    const layer = buildLayer(recorder, spy)

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        const adapter = yield* SDKAdapter
        const store = yield* SessionStore
        // Place every account in cooldown.
        for (const id of ["a1", "a2", "a3"]) {
          yield* broker.report({
            accountId: id,
            kind: "rate_limit",
            retryAfterMs: 60_000,
          })
        }
        yield* Effect.scoped(runOneQuery(adapter, store, undefined))
      }).pipe(Effect.provide(layer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      expect(j).toContain("SDKError")
      expect(j).toContain("acquire-session")
      expect(j).toContain("AllAccountsExhausted")
    }
    // Sanity: AllAccountsExhaustedError class still exists in core.
    expect(AllAccountsExhaustedError).toBeDefined()
  })

  it("Scope alignment: open Scope → inFlight=1; close → inFlight=0", async () => {
    const recorder = makeRecordingFake()
    const spy: BrokerSpy = { reports: [] }
    const layer = buildLayer(recorder, spy)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* SDKAdapter
        const store = yield* SessionStore
        const broker = yield* AccountBroker
        const localSid = `${sid}-scope-${sidCounter++}`
        yield* store.create({ id: localSid, options: { model: "m" }, createdAt: 0 })

        // Open a Scope manually. Don't drain the stream — just hold the
        // credential lifetime open and inspect.
        const scope = yield* Scope.make()
        const out = yield* adapter
          .query({
            sessionId: localSid,
            prompt: emptyPrompt,
            sessionOptions: { model: "m", idleTimeoutMs: 5_000 },
          })
          .pipe(Scope.provide(scope))
        // Touching the stream value to keep the lint quiet.
        void out

        const mid = yield* broker._inspect()
        const sumInFlightMid = mid.reduce((s, a) => s + a.inFlight, 0)
        // Close the Scope → finalizers run.
        yield* Scope.close(scope, Exit.void)

        const after = yield* broker._inspect()
        const sumInFlightAfter = after.reduce((s, a) => s + a.inFlight, 0)
        return { sumInFlightMid, sumInFlightAfter }
      }).pipe(Effect.provide(layer)),
    )
    expect(result.sumInFlightMid).toBe(1)
    expect(result.sumInFlightAfter).toBe(0)
  })

  it("sticky-pin: boundAccountId='a2' uses a2 regardless of rotation order", async () => {
    const recorder = makeRecordingFake()
    const spy: BrokerSpy = { reports: [] }
    const layer = buildLayer(recorder, spy)

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* SDKAdapter
        const store = yield* SessionStore
        // First, run one normal query so a2 is NOT next in round-robin.
        yield* Effect.scoped(runOneQuery(adapter, store, undefined))
        // Reset recorder to focus only on the pinned query.
        recorder.tokensSeen.length = 0
        yield* Effect.scoped(runOneQuery(adapter, store, "a2"))
      }).pipe(Effect.provide(layer)),
    )
    expect(recorder.tokensSeen).toEqual(["tok-a2"])
  })

  it("claude-code:login account does not inject CLAUDE_CODE_OAUTH_TOKEN", async () => {
    const recorder = makeRecordingFake()
    const spy: BrokerSpy = { reports: [] }
    const layer = buildLayer(recorder, spy, [
      {
        id: "login",
        kind: "anthropic",
        secretRef: CLAUDE_CODE_LOGIN_SECRET_REF,
      },
    ])

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* SDKAdapter
        const store = yield* SessionStore
        yield* Effect.scoped(runOneQuery(adapter, store, undefined))
      }).pipe(Effect.provide(layer)),
    )

    expect(recorder.tokensSeen).toEqual([])
  })

  it("clean stream end → broker.report({kind:'success'}); error → kind:'error'", async () => {
    // Clean end.
    {
      const recorder = makeRecordingFake()
      const spy: BrokerSpy = { reports: [] }
      const layer = buildLayer(recorder, spy)
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* SDKAdapter
          const store = yield* SessionStore
          yield* Effect.scoped(runOneQuery(adapter, store, undefined))
        }).pipe(Effect.provide(layer)),
      )
      // Producer is fire-and-forget; give it a tick to flush the report.
      await new Promise((r) => setTimeout(r, 20))
      const successReports = spy.reports.filter((r) => r.kind === "success")
      expect(successReports.length).toBeGreaterThanOrEqual(1)
    }

    // Error end — fake SDK throws on iterate.
    {
      const recorder = makeRecordingFake()
      recorder.setThrowOnIterate(true)
      const spy: BrokerSpy = { reports: [] }
      const layer = buildLayer(recorder, spy)
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const adapter = yield* SDKAdapter
          const store = yield* SessionStore
          yield* Effect.scoped(runOneQuery(adapter, store, undefined))
        }).pipe(Effect.provide(layer)),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      await new Promise((r) => setTimeout(r, 20))
      const errorReports = spy.reports.filter((r) => r.kind === "error")
      expect(errorReports.length).toBeGreaterThanOrEqual(1)
    }
  })

  // ── B4: usage reported at the SDK result frame with the WINNING model ──────
  it("B4: result frame → broker.report({kind:'usage'}) with winning model + token totals", async () => {
    const spy: BrokerSpy = { reports: [] }
    // A fake SDK that yields a result message with usage; the env recorder is
    // not needed here, so build a minimal SDKClient.fake directly.
    const sdkLayer = SDKClient.fake(() =>
      makeResultWithUsage({
        input_tokens: 1234,
        output_tokens: 56,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 8,
      }),
    )
    const brokerL = AccountBrokerLayer.fromAccounts(seeds).pipe(
      Layer.provide(Layer.mergeAll(EnvSecretProvider.Default, CoreClock.Default)),
    )
    const spiedBrokerL = reportSpyLayer(spy).pipe(Layer.provide(brokerL))
    const layer = Layer.provideMerge(
      SDKAdapter.WithBroker,
      Layer.mergeAll(sdkLayer, baseLayer, spiedBrokerL),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* SDKAdapter
        const store = yield* SessionStore
        // The broker routes by `sdkOptions.model` (NOT the top-level model), so
        // set it there to assert the winning model precisely.
        const localSid = `${sid}-usage-${sidCounter++}`
        yield* store.create({
          id: localSid,
          options: { model: "claude-sonnet-4-5" },
          createdAt: 0,
        })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const out = yield* adapter.query({
              sessionId: localSid,
              prompt: emptyPrompt,
              sessionOptions: {
                model: "claude-sonnet-4-5",
                idleTimeoutMs: 5_000,
                sdkOptions: { model: "claude-sonnet-4-5" },
              },
            })
            yield* Stream.runDrain(out)
          }),
        )
      }).pipe(Effect.provide(layer)),
    )
    // Fire-and-forget — give the producer a tick to flush the usage report.
    await new Promise((r) => setTimeout(r, 20))
    const usageReports = spy.reports.filter((r) => r.kind === "usage")
    expect(usageReports.length).toBe(1)
    const u = usageReports[0]
    if (u && u.kind === "usage") {
      expect(u.model).toBe("claude-sonnet-4-5")
      expect(u.tokensIn).toBe(1234)
      expect(u.tokensOut).toBe(56)
      expect(u.cacheRead).toBe(7)
      expect(u.cacheWrite).toBe(8)
    }
  })

  // ── B4b: multi-model turn (Task subagent on another model) → one usage
  // report PER modelUsage entry, each priced at its own model — never the
  // aggregate collapsed onto the lane model. ──────────────────────────────
  it("B4b: multi-model result → per-model usage reports (subagent pricing)", async () => {
    const spy: BrokerSpy = { reports: [] }
    const makeMultiModelResult = (): Query => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: "result",
          subtype: "success",
          session_id: "sid",
          uuid: "u-result-mm",
          is_error: false,
          duration_ms: 10,
          duration_api_ms: 5,
          num_turns: 1,
          result: "ok",
          usage: {
            input_tokens: 1100,
            output_tokens: 220,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          modelUsage: {
            "claude-haiku-4-5-20251001": {
              inputTokens: 1000,
              outputTokens: 200,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
            "claude-opus-4-8": {
              inputTokens: 100,
              outputTokens: 20,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          },
        } as unknown as SDKMessage
      }
      const iterator = gen()
      return Object.assign(iterator, {
        interrupt: async () => {},
        setPermissionMode: async () => {},
        setModel: async () => {},
        applyFlagSettings: async () => {},
        setMaxThinkingTokens: async () => {},
        supplyToolPermissionResponse: async () => {},
        mcpServerStatus: async () => ({}),
      } as Partial<Query>) as Query
    }
    const sdkLayer = SDKClient.fake(() => makeMultiModelResult())
    const brokerL = AccountBrokerLayer.fromAccounts(seeds).pipe(
      Layer.provide(Layer.mergeAll(EnvSecretProvider.Default, CoreClock.Default)),
    )
    const spiedBrokerL = reportSpyLayer(spy).pipe(Layer.provide(brokerL))
    const layer = Layer.provideMerge(
      SDKAdapter.WithBroker,
      Layer.mergeAll(sdkLayer, baseLayer, spiedBrokerL),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* SDKAdapter
        const store = yield* SessionStore
        const localSid = `${sid}-mmusage-${sidCounter++}`
        yield* store.create({
          id: localSid,
          options: { model: "claude-haiku-4-5-20251001" },
          createdAt: 0,
        })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const out = yield* adapter.query({
              sessionId: localSid,
              prompt: emptyPrompt,
              sessionOptions: {
                model: "claude-haiku-4-5-20251001",
                idleTimeoutMs: 5_000,
                sdkOptions: { model: "claude-haiku-4-5-20251001" },
              },
            })
            yield* Stream.runDrain(out)
          }),
        )
      }).pipe(Effect.provide(layer)),
    )
    await new Promise((r) => setTimeout(r, 20))
    const usageReports = spy.reports.filter((r) => r.kind === "usage")
    expect(usageReports.length).toBe(2)
    const byModel = new Map(
      usageReports.flatMap((r) =>
        r.kind === "usage" ? [[r.model, r] as const] : [],
      ),
    )
    const haiku = byModel.get("claude-haiku-4-5-20251001")
    const opus = byModel.get("claude-opus-4-8")
    expect(haiku?.kind === "usage" ? haiku.tokensIn : -1).toBe(1000)
    expect(haiku?.kind === "usage" ? haiku.tokensOut : -1).toBe(200)
    expect(opus?.kind === "usage" ? opus.tokensIn : -1).toBe(100)
    expect(opus?.kind === "usage" ? opus.tokensOut : -1).toBe(20)
  })

  // ── B8: chain advance emits the warn alert ────────────────────────────────
  it("B8: overflow chain advance logs a warn alert (step 0 cooled → step 1)", async () => {
    const chains = {
      chains: {
        "chat-lane": [
          { kind: "anthropic", accountId: "a1", model: "claude-sonnet-4-5" },
          { kind: "anthropic", accountId: "a2", model: "claude-sonnet-4-5" },
        ],
      },
    }
    const prevChains = process.env["LUNA_OVERFLOW_CHAINS"]
    process.env["LUNA_OVERFLOW_CHAINS"] = JSON.stringify(chains)
    try {
      const recorder = makeRecordingFake()
      const spy: BrokerSpy = { reports: [] }
      const layer = buildLayer(recorder, spy)

      // Capture warn-level log messages emitted during the run. `message` may
      // be a single value or an array depending on the call — stringify both.
      const warns: string[] = []
      const captureLogger = Logger.make(({ logLevel, message }) => {
        if (String(logLevel) !== "Warn") return
        const text = Array.isArray(message)
          ? message.map((m) => String(m)).join(" ")
          : String(message)
        warns.push(text)
      })

      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* SDKAdapter
          const store = yield* SessionStore
          const broker = yield* AccountBroker
          // (1) First acquire on the lane → lands step 0 (a1), sets lastStep=0.
          yield* Effect.scoped(runOneQuery(adapter, store, undefined, "chat-lane"))
          // Cool a1 so the next acquire must advance to step 1.
          yield* broker.report({
            accountId: "a1",
            kind: "rate_limit",
            retryAfterMs: 60_000,
          })
          // (2) Second acquire → advances to step 1 (a2), advancedFrom=0 → warn.
          yield* Effect.scoped(runOneQuery(adapter, store, undefined, "chat-lane"))
        }).pipe(
          Effect.provide(layer),
          Effect.provide(Logger.layer([captureLogger])),
        ),
      )

      const advanceWarn = warns.find((w) =>
        w.includes("overflow chain advanced"),
      )
      expect(advanceWarn).toBeDefined()
      expect(advanceWarn).toContain("step 0 → 1")
    } finally {
      if (prevChains === undefined) delete process.env["LUNA_OVERFLOW_CHAINS"]
      else process.env["LUNA_OVERFLOW_CHAINS"] = prevChains
    }
  })

  // ── BLOCKER #3 regression: the re-fired `onAccountAcquired` at throttle
  // time must use the broker's canonical `pickLaneTarget`/`pickChainTarget`
  // selection (via `peekFailoverPossible`), never a private kind-filtered
  // `broker.list(kind).some(...)` re-derivation - that re-derivation cannot
  // see a chain step on a DIFFERENT provider kind. ─────────────────────────
  it("BLOCKER #3a: cross-kind overflow chain - re-fired failoverPossible is true (a different-kind step is still viable)", async () => {
    process.env["ROT_TOK_CROSS_A"] = "tok-cross-a"
    process.env["ROT_TOK_CROSS_O"] = "tok-cross-o"
    const chains = {
      chains: {
        "cross-lane": [
          { kind: "anthropic", accountId: "cross-a", model: "claude-sonnet-4-5" },
          { kind: "openai", accountId: "cross-o", model: "gpt-5" },
        ],
      },
    }
    const prevChains = process.env["LUNA_OVERFLOW_CHAINS"]
    process.env["LUNA_OVERFLOW_CHAINS"] = JSON.stringify(chains)
    try {
      const crossSeeds: ReadonlyArray<AccountSeed> = [
        { id: "cross-a", kind: "anthropic", secretRef: "env:ROT_TOK_CROSS_A" },
        { id: "cross-o", kind: "openai", secretRef: "env:ROT_TOK_CROSS_O" },
      ]
      const sdkLayer = SDKClient.fake(() =>
        makeThrottleIterable("session limit reached, please retry"),
      )
      const brokerL = AccountBrokerLayer.fromAccounts(crossSeeds).pipe(
        Layer.provide(Layer.mergeAll(EnvSecretProvider.Default, CoreClock.Default)),
      )
      const layer = Layer.provideMerge(
        SDKAdapter.WithBroker,
        Layer.mergeAll(sdkLayer, baseLayer, brokerL),
      )

      const acquiredCalls: Array<{
        accountId: string
        failoverPossible: boolean
      }> = []
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* SDKAdapter
          const store = yield* SessionStore
          const localSid = `${sid}-cross-${sidCounter++}`
          yield* store.create({
            id: localSid,
            options: { model: "cross-lane" },
            createdAt: 0,
          })
          yield* Effect.scoped(
            Effect.gen(function* () {
              const out = yield* adapter.query({
                sessionId: localSid,
                prompt: emptyPrompt,
                sessionOptions: {
                  model: "cross-lane",
                  idleTimeoutMs: 5_000,
                  sdkOptions: { model: "cross-lane" },
                },
                onAccountAcquired: (info) => acquiredCalls.push(info),
              })
              yield* Stream.runDrain(out).pipe(Effect.result)
            }),
          )
        }).pipe(Effect.provide(layer)),
      )

      // First call: acquire-time snapshot for the winning step (cross-a).
      expect(acquiredCalls[0]?.accountId).toBe("cross-a")
      // Second (RE-FIRED) call: freshly recomputed AT THROTTLE TIME, after
      // cross-a was just cooled by the report above. The chain's step-1
      // target (cross-o, a DIFFERENT provider kind) is still viable - a
      // kind-filtered `list("anthropic")` re-check is blind to it and would
      // wrongly report `false` here, silently dropping the user's turn for
      // every cross-kind LUNA_OVERFLOW_CHAINS deployment.
      expect(acquiredCalls).toHaveLength(2)
      expect(acquiredCalls[1]?.accountId).toBe("cross-a")
      expect(acquiredCalls[1]?.failoverPossible).toBe(true)
    } finally {
      if (prevChains === undefined) delete process.env["LUNA_OVERFLOW_CHAINS"]
      else process.env["LUNA_OVERFLOW_CHAINS"] = prevChains
    }
  })

  it("BLOCKER #3b: pinned single-step chain + off-chain same-kind sibling - cool-on-throttle gate correctly stays closed (no re-fire, no rotation invitation)", async () => {
    process.env["ROT_TOK_PIN_A"] = "tok-pin-a"
    process.env["ROT_TOK_PIN_SIB"] = "tok-pin-sib"
    const chains = {
      chains: {
        "pinned-lane": [{ accountId: "pin-a", model: "claude-sonnet-4-5" }],
      },
    }
    const prevChains = process.env["LUNA_OVERFLOW_CHAINS"]
    process.env["LUNA_OVERFLOW_CHAINS"] = JSON.stringify(chains)
    try {
      const pinnedSeeds: ReadonlyArray<AccountSeed> = [
        { id: "pin-a", kind: "anthropic", secretRef: "env:ROT_TOK_PIN_A" },
        // Off-chain sibling: SAME kind as pin-a, but never named by the
        // chain (no step pins to it, no step's resolved kind alone would
        // route here since the ONLY step is pinned to "pin-a" specifically).
        { id: "pin-sib", kind: "anthropic", secretRef: "env:ROT_TOK_PIN_SIB" },
      ]
      const sdkLayer = SDKClient.fake(() =>
        makeThrottleIterable("session limit reached, please retry"),
      )
      const brokerL = AccountBrokerLayer.fromAccounts(pinnedSeeds).pipe(
        Layer.provide(Layer.mergeAll(EnvSecretProvider.Default, CoreClock.Default)),
      )
      const layer = Layer.provideMerge(
        SDKAdapter.WithBroker,
        Layer.mergeAll(sdkLayer, baseLayer, brokerL),
      )

      const acquiredCalls: Array<{
        accountId: string
        failoverPossible: boolean
      }> = []
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* SDKAdapter
          const store = yield* SessionStore
          const localSid = `${sid}-pinned-${sidCounter++}`
          yield* store.create({
            id: localSid,
            options: { model: "pinned-lane" },
            createdAt: 0,
          })
          yield* Effect.scoped(
            Effect.gen(function* () {
              const out = yield* adapter.query({
                sessionId: localSid,
                prompt: emptyPrompt,
                sessionOptions: {
                  model: "pinned-lane",
                  idleTimeoutMs: 5_000,
                  sdkOptions: { model: "pinned-lane" },
                },
                onAccountAcquired: (info) => acquiredCalls.push(info),
              })
              yield* Stream.runDrain(out).pipe(Effect.result)
            }),
          )
        }).pipe(Effect.provide(layer)),
      )

      expect(acquiredCalls[0]?.accountId).toBe("pin-a")
      // Acquire-time: the chain's ONLY step is pinned to "pin-a" - excluding
      // pin-a leaves nowhere for that pin to route to, so failoverPossible
      // is correctly false even before any throttle. Because that gates
      // BLOCKER #1's cool-on-throttle check (`if (!throttleFailoverPossible)
      // return` in `reportRateLimitIfThrottled`), the account is never
      // cooled and `onAccountAcquired` is never re-fired for this turn - a
      // SINGLE call, still reporting `false`. (The canonical-vs-naive
      // divergence this scenario exists to catch is proven directly against
      // `peekFailoverPossible` in account-broker.test.ts, where it's
      // reachable without needing a real throttle to also clear this gate.)
      expect(acquiredCalls[0]?.failoverPossible).toBe(false)
      expect(acquiredCalls).toHaveLength(1)
    } finally {
      if (prevChains === undefined) delete process.env["LUNA_OVERFLOW_CHAINS"]
      else process.env["LUNA_OVERFLOW_CHAINS"] = prevChains
    }
  })
})
