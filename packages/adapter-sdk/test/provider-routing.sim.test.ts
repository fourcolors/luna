/**
 * provider-routing.sim.test.ts — proves the Slice-2 provider seam end-to-end
 * through the REAL broker + adapter (only the SDK itself is faked).
 *
 * The model string selects a ProviderProfile (resolveProfile, core); the broker
 * routes to an account of that profile's `kind`; the adapter injects the
 * profile's auth var (and base URL) into the SDK `options.env` at its single
 * secret-unwrap site. We capture that env from a fake SDK and assert:
 *   - gemini-* → google profile → ANTHROPIC_BASE_URL=<gateway> + ANTHROPIC_AUTH_TOKEN
 *   - *:cloud  → ollama-cloud   → ANTHROPIC_BASE_URL=https://ollama.com
 *   - claude-* → anthropic      → CLAUDE_CODE_OAUTH_TOKEN, NO base URL (back-compat)
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Stream } from "effect"
import {
  SessionStore,
  Clock as CoreClock,
  AccountBrokerLayer,
  EnvSecretProvider,
  type AccountSeed,
} from "@luna/core"
import { SDKAdapter, SDKClient } from "../src/index.js"
import type { Options, Query, SDKMessage, SDKUserMessage } from "../src/sdk-client.js"

// Provider routing reads these from process.env (resolveProfile) at query time.
process.env.LUNA_LLM_GATEWAY_URL = "http://gw-test:4000"
process.env.PROV_TOK_G = "tok-g"
process.env.PROV_TOK_O = "tok-o"
process.env.PROV_TOK_A = "tok-a"

const makeClosedQuery = (): Query => {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    return
  }
  return Object.assign(gen(), {
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    applyFlagSettings: async () => {},
    setMaxThinkingTokens: async () => {},
    supplyToolPermissionResponse: async () => {},
    mcpServerStatus: async () => ({}),
  } as Partial<Query>) as Query
}

const makeEnvCapturingFake = () => {
  const envsSeen: Array<Record<string, string | undefined>> = []
  const layer = SDKClient.fake((params) => {
    const env = (params.options as Options | undefined)?.env as
      | Record<string, string | undefined>
      | undefined
    envsSeen.push(env ?? {})
    return makeClosedQuery()
  })
  return { envsSeen, layer }
}

const baseLayer = Layer.mergeAll(SessionStore.Default, CoreClock.Default)

const buildLayer = (
  fake: ReturnType<typeof makeEnvCapturingFake>,
  seeds: ReadonlyArray<AccountSeed>,
) => {
  const brokerL = AccountBrokerLayer.fromAccounts(seeds).pipe(
    Layer.provide(Layer.mergeAll(EnvSecretProvider.Default, CoreClock.Default)),
  )
  return Layer.provideMerge(
    SDKAdapter.WithBroker,
    Layer.mergeAll(fake.layer, baseLayer, brokerL),
  )
}

const emptyPrompt: Stream.Stream<SDKUserMessage> = Stream.empty
let n = 0

const runOnce = (
  fake: ReturnType<typeof makeEnvCapturingFake>,
  seeds: ReadonlyArray<AccountSeed>,
  model: string,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SessionStore
      const adapter = yield* SDKAdapter
      const localSid = `prov-${n++}`
      yield* store.create({ id: localSid, options: { model }, createdAt: 0 })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const out = yield* adapter.query({
            sessionId: localSid,
            prompt: emptyPrompt,
            // The adapter routes on `sdkOptions.model` (the value that reaches
            // the SDK), NOT the session's display `model` — so set both.
            sessionOptions: { model, idleTimeoutMs: 5_000, sdkOptions: { model } },
          })
          yield* Stream.runDrain(out)
        }),
      )
    }).pipe(Effect.provide(buildLayer(fake, seeds))),
  )

const lastEnv = (fake: ReturnType<typeof makeEnvCapturingFake>) => {
  const env = fake.envsSeen[fake.envsSeen.length - 1]
  expect(env).toBeDefined()
  return env as Record<string, string | undefined>
}

describe("provider routing through the real broker + adapter", () => {
  it("gemini-* → google profile: ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN, no OAuth token", async () => {
    const fake = makeEnvCapturingFake()
    await runOnce(
      fake,
      [{ id: "g1", kind: "google", secretRef: "env:PROV_TOK_G" }],
      "gemini-2.5-flash",
    )
    const env = lastEnv(fake)
    expect(env["ANTHROPIC_BASE_URL"]).toBe("http://gw-test:4000")
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("tok-g")
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined()
  })

  it("*:cloud → ollama-cloud profile: ANTHROPIC_BASE_URL=https://ollama.com", async () => {
    const fake = makeEnvCapturingFake()
    await runOnce(
      fake,
      [{ id: "o1", kind: "ollama-cloud", secretRef: "env:PROV_TOK_O" }],
      "qwen3-coder:cloud",
    )
    const env = lastEnv(fake)
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://ollama.com")
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("tok-o")
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined()
  })

  it("claude-* → anthropic profile: CLAUDE_CODE_OAUTH_TOKEN, no base URL (back-compat)", async () => {
    const fake = makeEnvCapturingFake()
    await runOnce(
      fake,
      [{ id: "a1", kind: "anthropic", secretRef: "env:PROV_TOK_A" }],
      "claude-opus-4-8",
    )
    const env = lastEnv(fake)
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("tok-a")
    expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined()
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined()
  })
})
