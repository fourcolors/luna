/**
 * brokered-turn.test.ts — Tier-1 tests for the shared reasoner-turn helper.
 *
 * Covers the two review fixes this module carries:
 *   - resolveReasonerModel: a set-but-BLANK primary env var falls through to
 *     LUNA_REASONER_MODEL (the `('' ?? x)` short-circuit bug).
 *   - usage / rate-limit reporting: a brokered reasoner turn meters its token
 *     usage into the spend meter (budget cooldown included) and cools the
 *     account on a throttle-classified terminal error ONLY when the broker
 *     said failover is viable. Pre-fix the reasoners reported nothing, so
 *     chain budgets / 429 failover never applied to the wake/dream lanes.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  AccountBroker,
  AccountBrokerLayer,
  EnvSecretProvider,
  Clock,
} from "@luna/core"
import { SDKClient } from "../src/sdk-client.js"
import {
  resolveReasonerModel,
  runBrokeredReasonerTurn,
} from "../src/brokered-turn.js"
import { makeFakeQuery, makeResultMessage } from "./fake-sdk.js"

// ── resolveReasonerModel ─────────────────────────────────────────────────────

describe("resolveReasonerModel", () => {
  it("primary var wins when set", () => {
    expect(
      resolveReasonerModel("LUNA_WAKE_MODEL", {
        LUNA_WAKE_MODEL: "gemini-2.5-flash",
        LUNA_REASONER_MODEL: "claude-haiku-4",
      }),
    ).toBe("gemini-2.5-flash")
  })

  it("a set-but-BLANK primary falls through to LUNA_REASONER_MODEL (systemd `Environment=VAR=` idiom)", () => {
    expect(
      resolveReasonerModel("LUNA_WAKE_MODEL", {
        LUNA_WAKE_MODEL: "",
        LUNA_REASONER_MODEL: "gemini-2.5-flash",
      }),
    ).toBe("gemini-2.5-flash")
  })

  it("whitespace-only values are blank; both unset ⇒ undefined", () => {
    expect(
      resolveReasonerModel("LUNA_DREAM_MODEL", {
        LUNA_DREAM_MODEL: "   ",
        LUNA_REASONER_MODEL: " \t",
      }),
    ).toBeUndefined()
    expect(resolveReasonerModel("LUNA_DREAM_MODEL", {})).toBeUndefined()
  })
})

// ── runBrokeredReasonerTurn reporting ───────────────────────────────────────

const GOOGLE_TOK_ENV = "BROKERED_TURN_GOOGLE_TOK"

const brokerWith = (budgetUsd?: number): Layer.Layer<AccountBroker> =>
  AccountBrokerLayer.fromAccounts([
    {
      id: "g1",
      kind: "google",
      secretRef: `env:${GOOGLE_TOK_ENV}`,
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    },
  ]).pipe(Layer.provide(EnvSecretProvider.Default), Layer.provide(Clock.Default))

const resultWithUsage = (
  text: string,
  modelUsage?: Record<string, object>,
): SDKMessage =>
  ({
    ...(makeResultMessage("sid", "u1") as object),
    result: text,
    usage: {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    ...(modelUsage !== undefined ? { modelUsage } : {}),
  }) as unknown as SDKMessage

const sdkWith = (messages: ReadonlyArray<SDKMessage>): Layer.Layer<SDKClient> =>
  SDKClient.fake((_params) => makeFakeQuery({ messages }).query)

const throwing429Sdk = (): Layer.Layer<SDKClient> =>
  SDKClient.fake((_params) => {
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      throw new Error("API Error: 429 rate_limit_error, retry-after: 30")
    }
    return gen() as unknown as Query
  })

const ERRORS = {
  acquire: (cause: unknown) => new Error(`acquire: ${String(cause)}`),
  timeout: (ms: number) => new Error(`timeout: ${ms}`),
  streamError: (cause: unknown) => new Error(`stream: ${String(cause)}`),
  empty: () => new Error("empty"),
}

const runTurn = (model: string) =>
  Effect.gen(function* () {
    const sdk = yield* SDKClient
    const broker = yield* AccountBroker
    const text = yield* runBrokeredReasonerTurn({
      sdk,
      broker,
      model,
      prompt: "p",
      baseOptions: { maxTurns: 1 },
      timeoutMs: 5_000,
      errors: ERRORS,
    }).pipe(Effect.either)
    const accounts = yield* broker._inspect()
    return { text, accounts }
  })

describe("runBrokeredReasonerTurn — spend metering (B4 parity)", () => {
  it("meters the result frame's usage into the broker (gemini pricing) and cools at a budget", async () => {
    process.env[GOOGLE_TOK_ENV] = "tok"
    try {
      const out = await Effect.runPromise(
        runTurn("gemini-2.5-flash").pipe(
          Effect.provide(sdkWith([resultWithUsage("ok")])),
          // $0.30/M input on gemini-2.5-flash; budget $0.10 → exhausted.
          Effect.provide(brokerWith(0.1)),
        ),
      )
      expect(out.text._tag).toBe("Right")
      const g1 = out.accounts.find((a) => a.id === "g1")
      // 1M input tokens at gemini-2.5-flash's $0.30/M.
      expect(g1?.usage?.spentUsd).toBeCloseTo(0.3, 5)
      // Crossed the $0.10 budget → cooled to the cycle boundary.
      expect(g1?.cooldownUntilMs).toBeGreaterThan(0)
    } finally {
      delete process.env[GOOGLE_TOK_ENV]
    }
  })

  it("prices against the modelUsage-reported REAL model when the lane is an alias", async () => {
    process.env[GOOGLE_TOK_ENV] = "tok"
    try {
      // Lane string "gemini-future-pro" matches no RATE_TABLE prefix → would
      // price at the google kind-default floor (0.30/M). But the result frame
      // reports the single model that ACTUALLY served the turn —
      // gemini-3.5-flash (1.50/M) — and that must win the pricing.
      const out = await Effect.runPromise(
        runTurn("gemini-future-pro").pipe(
          Effect.provide(
            sdkWith([
              resultWithUsage("ok", { "gemini-3.5-flash": { inputTokens: 1 } }),
            ]),
          ),
          Effect.provide(brokerWith()),
        ),
      )
      expect(out.text._tag).toBe("Right")
      const g1 = out.accounts.find((a) => a.id === "g1")
      // 1M input tokens at the REAL model's $1.50/M — not the floor's $0.30.
      expect(g1?.usage?.spentUsd).toBeCloseTo(1.5, 5)
    } finally {
      delete process.env[GOOGLE_TOK_ENV]
    }
  })

  it("falls back to the lane model when modelUsage reports MULTIPLE models", async () => {
    process.env[GOOGLE_TOK_ENV] = "tok"
    try {
      const out = await Effect.runPromise(
        runTurn("gemini-2.5-flash").pipe(
          Effect.provide(
            sdkWith([
              resultWithUsage("ok", {
                "gemini-3.5-flash": { inputTokens: 1 },
                "gemini-2.5-flash": { inputTokens: 1 },
              }),
            ]),
          ),
          Effect.provide(brokerWith()),
        ),
      )
      expect(out.text._tag).toBe("Right")
      const g1 = out.accounts.find((a) => a.id === "g1")
      // Mixed-model turn → lane model's rate (0.30/M), not either real id.
      expect(g1?.usage?.spentUsd).toBeCloseTo(0.3, 5)
    } finally {
      delete process.env[GOOGLE_TOK_ENV]
    }
  })
})

describe("runBrokeredReasonerTurn — throttle reporting (B9 parity)", () => {
  it("does NOT cool the account on a 429 when failover is not viable (sole account, no chain)", async () => {
    process.env[GOOGLE_TOK_ENV] = "tok"
    try {
      const out = await Effect.runPromise(
        runTurn("gemini-2.5-flash").pipe(
          Effect.provide(throwing429Sdk()),
          Effect.provide(brokerWith()),
        ),
      )
      // The turn still fails with the caller-mapped stream error …
      expect(out.text._tag).toBe("Left")
      // … but the sole account is NOT cooled (failoverPossible=false), so the
      // next tick can retry instead of self-inflicting an outage.
      const g1 = out.accounts.find((a) => a.id === "g1")
      expect(g1?.cooldownUntilMs).toBeUndefined()
    } finally {
      delete process.env[GOOGLE_TOK_ENV]
    }
  })
})

describe("runBrokeredReasonerTurn — throttle reporting with viable failover", () => {
  it("cools the account on a 429 when the lane's chain has another viable target", async () => {
    process.env[GOOGLE_TOK_ENV] = "tok"
    const prevChains = process.env["LUNA_OVERFLOW_CHAINS"]
    process.env["LUNA_OVERFLOW_CHAINS"] = JSON.stringify({
      "wake-lane": [
        { kind: "google", accountId: "g1", model: "gemini-2.5-flash" },
        { kind: "google", accountId: "g2", model: "gemini-2.5-flash" },
      ],
    })
    try {
      const broker2 = AccountBrokerLayer.fromAccounts([
        { id: "g1", kind: "google", secretRef: `env:${GOOGLE_TOK_ENV}` },
        { id: "g2", kind: "google", secretRef: `env:${GOOGLE_TOK_ENV}` },
      ]).pipe(
        Layer.provide(EnvSecretProvider.Default),
        Layer.provide(Clock.Default),
      )
      const out = await Effect.runPromise(
        runTurn("wake-lane").pipe(
          Effect.provide(throwing429Sdk()),
          Effect.provide(broker2),
        ),
      )
      expect(out.text._tag).toBe("Left")
      // failoverPossible=true (g2 survives g1's exclusion) → the 429 cools g1
      // with the parsed retry-after, so the next tick advances the chain.
      const g1 = out.accounts.find((a) => a.id === "g1")
      expect(g1?.cooldownUntilMs).toBeGreaterThan(0)
    } finally {
      if (prevChains === undefined) delete process.env["LUNA_OVERFLOW_CHAINS"]
      else process.env["LUNA_OVERFLOW_CHAINS"] = prevChains
      delete process.env[GOOGLE_TOK_ENV]
    }
  })
})
