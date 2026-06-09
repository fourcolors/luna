/**
 * wake-reasoner.test.ts — Tier-1 tests for WakeReasonerDefault + the pure
 * helpers (buildWakePrompt, parseDigest).
 *
 * All tests run with SDKClient.fake. ZERO network / model calls.
 * Covers:
 *   1. buildWakePrompt — deterministic, includes all input sections.
 *   2. parseDigest — well-formed JSON.
 *   3. parseDigest — fence-stripped JSON.
 *   4. parseDigest — null picked_action_id.
 *   5. parseDigest — invalid priority → WakeError.
 *   6. WakeReasonerDefault — end-to-end with fake SDK.
 *   7. WakeReasonerDefault — SDK with no success message → WakeError.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import {
  WakeError,
  WakeReasoner,
  AccountBroker,
  AccountBrokerLayer,
  EnvSecretProvider,
  Clock,
  CLAUDE_CODE_LOGIN_SECRET_REF,
} from "@luna/core"
import type { WakeInputs } from "@luna/core"
import { SDKClient } from "../src/sdk-client.js"
import {
  WakeReasonerDefault,
  buildWakePrompt,
  parseDigest,
} from "../src/wake-reasoner.js"
import {
  makeFakeQuery,
  makeAssistantMessage,
  makeResultMessage,
} from "./fake-sdk.js"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

// ---------------------------------------------------------------------------
// Fake AccountBroker (A8/test): WakeReasonerDefault now requires AccountBroker.
// Seed ONE google account (resolvable via env:WAKE_GOOGLE_TOK) + ONE anthropic
// login-ref account (the sentinel that skips the env overlay → back-compat).
// Built from in-memory `fromAccounts` (NO bun:sqlite) + EnvSecretProvider + Clock.
// ---------------------------------------------------------------------------
const GOOGLE_TOK_ENV = "WAKE_GOOGLE_TOK"
const brokerFake = (): Layer.Layer<AccountBroker> =>
  AccountBrokerLayer.fromAccounts([
    { id: "g1", kind: "google", secretRef: `env:${GOOGLE_TOK_ENV}` },
    { id: "a1", kind: "anthropic", secretRef: CLAUDE_CODE_LOGIN_SECRET_REF },
  ]).pipe(Layer.provide(EnvSecretProvider.Default), Layer.provide(Clock.Default))

const baseInputs: WakeInputs = {
  workspaceSlug: "luna",
  workspaceMd: "# luna workspace\nVocabulary: dev, stable.",
  openGoals: [
    { slug: "g1", title: "First goal", priority: 3 },
    { slug: "g2", title: "Second goal", priority: 1 },
  ],
  openNextActions: [
    {
      id: 1,
      goalSlug: "g1",
      action: "fix scheduling",
      priority: 5,
      status: "todo",
    },
    {
      id: 2,
      goalSlug: "g1",
      action: "write tests",
      priority: 3,
      status: "doing",
    },
  ],
  recentWakes: [
    { wokeAt: 1_700_000_000_000, summary: "no-op", outcome: "no-op" },
  ],
}

const fakeClientWithResult = (resultText: string): Layer.Layer<SDKClient> =>
  SDKClient.fake((_params) => {
    const resultMsg = {
      ...makeResultMessage("sid", "uuid-1"),
      result: resultText,
    }
    return makeFakeQuery({ messages: [resultMsg] }).query
  })

const fakeClientNoSuccess = (): Layer.Layer<SDKClient> =>
  SDKClient.fake((_params) => {
    const assistantMsg = makeAssistantMessage("sid", "some text", "uuid-2")
    return makeFakeQuery({ messages: [assistantMsg] }).query
  })

const runReason = (
  inputs: WakeInputs,
  sdkLayer: Layer.Layer<SDKClient>,
  brokerLayer: Layer.Layer<AccountBroker> = brokerFake(),
) =>
  Effect.gen(function* () {
    const r = yield* WakeReasoner
    return yield* r.reason(inputs)
  }).pipe(
    Effect.provide(WakeReasonerDefault),
    Effect.provide(sdkLayer),
    Effect.provide(brokerLayer),
  )

describe("buildWakePrompt", () => {
  it("includes workspace slug, md, goals, actions, wakes", () => {
    const prompt = buildWakePrompt(baseInputs)
    expect(prompt).toContain("Workspace: luna")
    expect(prompt).toContain("luna workspace")
    expect(prompt).toContain("g1: First goal")
    expect(prompt).toContain("#1 todo p5")
    expect(prompt).toContain("fix scheduling")
    expect(prompt).toContain("[no-op]")
  })

  it("is deterministic for identical inputs", () => {
    const a = buildWakePrompt(baseInputs)
    const b = buildWakePrompt(baseInputs)
    expect(a).toBe(b)
  })

  it("renders helpful placeholders when sections are empty", () => {
    const prompt = buildWakePrompt({
      workspaceSlug: "x",
      workspaceMd: "",
      openGoals: [],
      openNextActions: [],
      recentWakes: [],
    })
    expect(prompt).toContain("(no active goals)")
    expect(prompt).toContain("(no open next_actions)")
    expect(prompt).toContain("(no prior wakes)")
  })
})

describe("parseDigest", () => {
  it("parses a well-formed digest", async () => {
    const text = JSON.stringify({
      observations: ["one open action"],
      picked_action_id: 1,
      picked_reason: "highest priority",
      proposed_actions: [
        {
          action: "file follow-up",
          priority: 2,
          rationale: "preventive",
          goal_slug: "g1",
        },
      ],
    })
    const digest = await Effect.runPromise(parseDigest("luna", text))
    expect(digest.workspaceSlug).toBe("luna")
    expect(digest.observations).toEqual(["one open action"])
    expect(digest.pickedActionId).toBe(1)
    expect(digest.pickedReason).toBe("highest priority")
    expect(digest.proposedActions).toHaveLength(1)
    expect(digest.proposedActions[0]?.goalSlug).toBe("g1")
  })

  it("strips ```json fences if the model wraps despite the prompt", async () => {
    const text =
      "```json\n" +
      JSON.stringify({
        observations: [],
        picked_action_id: null,
        picked_reason: "nothing",
        proposed_actions: [],
      }) +
      "\n```"
    const digest = await Effect.runPromise(parseDigest("luna", text))
    expect(digest.pickedActionId).toBeNull()
  })

  it("accepts null picked_action_id", async () => {
    const text = JSON.stringify({
      observations: [],
      picked_action_id: null,
      picked_reason: "blocked",
      proposed_actions: [],
    })
    const digest = await Effect.runPromise(parseDigest("luna", text))
    expect(digest.pickedActionId).toBeNull()
  })

  it("normalizes goal_slug=null when omitted", async () => {
    const text = JSON.stringify({
      observations: [],
      picked_action_id: null,
      picked_reason: "x",
      proposed_actions: [
        { action: "do x", priority: 3, rationale: "because" },
      ],
    })
    const digest = await Effect.runPromise(parseDigest("luna", text))
    expect(digest.proposedActions[0]?.goalSlug).toBeNull()
  })

  it("fails with WakeError on invalid priority", async () => {
    const text = JSON.stringify({
      observations: [],
      picked_action_id: null,
      picked_reason: "x",
      proposed_actions: [
        { action: "do x", priority: 99, rationale: "huh" },
      ],
    })
    const result = await Effect.runPromise(Effect.either(parseDigest("luna", text)))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(WakeError)
      expect(result.left.op).toBe("wake/parse")
    }
  })

  it("fails with WakeError on non-JSON output", async () => {
    const result = await Effect.runPromise(
      Effect.either(parseDigest("luna", "not json at all")),
    )
    expect(result._tag).toBe("Left")
  })
})

describe("WakeReasonerDefault", () => {
  it("returns a digest end-to-end via the fake SDK", async () => {
    const sdkLayer = fakeClientWithResult(
      JSON.stringify({
        observations: ["one open action"],
        picked_action_id: 1,
        picked_reason: "highest priority + actionable",
        proposed_actions: [],
      }),
    )
    const digest = await Effect.runPromise(runReason(baseInputs, sdkLayer))
    expect(digest.pickedActionId).toBe(1)
    expect(digest.workspaceSlug).toBe("luna")
    expect(digest.proposedActions).toHaveLength(0)
  })

  it("fails with WakeError when SDK yields no success result", async () => {
    const sdkLayer = fakeClientNoSuccess()
    const result = await Effect.runPromise(
      Effect.either(runReason(baseInputs, sdkLayer)),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(WakeError)
      expect(result.left.op).toBe("wake/sdk-stream")
    }
  })

  it(
    "a hung reasoning turn → WakeError(wake/sdk-stream, timed out) + subprocess aborted",
    async () => {
      // Faithful hang: yields nothing until aborted. LUNA_WAKE_TIMEOUT_MS is
      // read at layer-build time, so set it before runReason and restore after.
      let captured: AbortController | undefined
      const sdkHang = SDKClient.fake((params) => {
        const ac = params.options?.abortController as
          | AbortController
          | undefined
        captured = ac
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          await new Promise<void>((resolve) => {
            if (ac?.signal.aborted) return resolve()
            ac?.signal.addEventListener("abort", () => resolve(), { once: true })
            setTimeout(resolve, 30_000).unref?.()
          })
        }
        return gen() as unknown as import("../src/sdk-client.js").Query
      })

      const prev = process.env["LUNA_WAKE_TIMEOUT_MS"]
      process.env["LUNA_WAKE_TIMEOUT_MS"] = "50"
      try {
        const result = await Effect.runPromise(
          Effect.either(runReason(baseInputs, sdkHang)),
        )
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(WakeError)
          expect(result.left.op).toBe("wake/sdk-stream")
          expect(result.left.message).toMatch(/timed out/)
        }
        expect(captured?.signal.aborted).toBe(true)
      } finally {
        if (prev === undefined) delete process.env["LUNA_WAKE_TIMEOUT_MS"]
        else process.env["LUNA_WAKE_TIMEOUT_MS"] = prev
      }
    },
    10_000,
  )

  // -------------------------------------------------------------------------
  // PROVIDER SEAM (A3): the wake cron acquires a credential per reason()
  // through the AccountBroker and routes the SDK at a cheap model via
  // LUNA_WAKE_MODEL. These tests capture the SDK `options` the reasoner builds.
  // -------------------------------------------------------------------------
  describe("provider seam (broker routing)", () => {
    /** Capture-only SDKClient.fake that records the last options it saw. */
    const recordingClient = (sink: {
      last: { options: Record<string, unknown> } | null
    }): Layer.Layer<SDKClient> =>
      SDKClient.fake((params) => {
        sink.last = { options: (params.options ?? {}) as Record<string, unknown> }
        const r = {
          ...makeResultMessage("sid", "uuid-cap"),
          result: JSON.stringify({
            observations: [],
            picked_action_id: null,
            picked_reason: "x",
            proposed_actions: [],
          }),
        }
        return makeFakeQuery({ messages: [r] }).query
      })

    it("(a) LUNA_WAKE_MODEL + a google account → options.env has the gateway overlay + options.model set", async () => {
      const sink: { last: { options: Record<string, unknown> } | null } = {
        last: null,
      }
      const prevModel = process.env["LUNA_WAKE_MODEL"]
      const prevTok = process.env[GOOGLE_TOK_ENV]
      process.env["LUNA_WAKE_MODEL"] = "gemini-2.5-flash"
      process.env[GOOGLE_TOK_ENV] = "google-secret-xyz"
      try {
        await Effect.runPromise(runReason(baseInputs, recordingClient(sink)))
      } finally {
        if (prevModel === undefined) delete process.env["LUNA_WAKE_MODEL"]
        else process.env["LUNA_WAKE_MODEL"] = prevModel
        if (prevTok === undefined) delete process.env[GOOGLE_TOK_ENV]
        else process.env[GOOGLE_TOK_ENV] = prevTok
      }
      const opts = sink.last!.options
      expect(opts["model"]).toBe("gemini-2.5-flash")
      const env = opts["env"] as Record<string, string> | undefined
      expect(env).toBeDefined()
      // google profile → ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL (gateway).
      expect(env!["ANTHROPIC_AUTH_TOKEN"]).toBe("google-secret-xyz")
      expect(env!["ANTHROPIC_BASE_URL"]).toBeDefined()
    })

    it("(b) BACK-COMPAT: no LUNA_WAKE_MODEL + login-ref anthropic account → options.env undefined AND options.model undefined", async () => {
      const sink: { last: { options: Record<string, unknown> } | null } = {
        last: null,
      }
      const prevModel = process.env["LUNA_WAKE_MODEL"]
      const prevReasoner = process.env["LUNA_REASONER_MODEL"]
      delete process.env["LUNA_WAKE_MODEL"]
      delete process.env["LUNA_REASONER_MODEL"]
      try {
        // Only the anthropic login-ref account is reachable (model "default" →
        // anthropic kind). No google account is picked.
        await Effect.runPromise(runReason(baseInputs, recordingClient(sink)))
      } finally {
        if (prevModel !== undefined) process.env["LUNA_WAKE_MODEL"] = prevModel
        if (prevReasoner !== undefined)
          process.env["LUNA_REASONER_MODEL"] = prevReasoner
      }
      const opts = sink.last!.options
      expect("model" in opts).toBe(false)
      expect("env" in opts).toBe(false)
      expect(opts["maxTurns"]).toBe(1)
    })

    it("(c) EXHAUSTION: broker with no matching account → reason() returns a WakeError (Left), does NOT throw", async () => {
      const sink: { last: { options: Record<string, unknown> } | null } = {
        last: null,
      }
      // Broker seeded ONLY with an anthropic account; ask for a google model →
      // no matching account → AllAccountsExhaustedError → mapped to WakeError.
      const anthropicOnlyBroker: Layer.Layer<AccountBroker> =
        AccountBrokerLayer.fromAccounts([
          { id: "a1", kind: "anthropic", secretRef: CLAUDE_CODE_LOGIN_SECRET_REF },
        ]).pipe(
          Layer.provide(EnvSecretProvider.Default),
          Layer.provide(Clock.Default),
        )
      const prevModel = process.env["LUNA_WAKE_MODEL"]
      process.env["LUNA_WAKE_MODEL"] = "gemini-2.5-flash"
      try {
        const result = await Effect.runPromise(
          Effect.either(
            runReason(baseInputs, recordingClient(sink), anthropicOnlyBroker),
          ),
        )
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(WakeError)
          expect(result.left.op).toBe("wake/acquire")
        }
        // The SDK was never invoked because acquire failed first.
        expect(sink.last).toBeNull()
      } finally {
        if (prevModel === undefined) delete process.env["LUNA_WAKE_MODEL"]
        else process.env["LUNA_WAKE_MODEL"] = prevModel
      }
    })
  })
})
