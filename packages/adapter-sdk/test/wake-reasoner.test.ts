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
  validateDigest,
  WAKE_DIGEST_SCHEMA,
} from "../src/wake-reasoner.js"
import { reasonerStructuredOutputEnabled } from "../src/brokered-turn.js"
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

  it("structuredOutputEnabled=false (default) keeps the full field-by-field Shape: listing", () => {
    const prompt = buildWakePrompt(baseInputs)
    expect(prompt).toContain("Shape:")
    expect(prompt).toContain('"picked_action_id": <number|null>')
  })

  it("structuredOutputEnabled=true drops the Shape: listing for a short instruction plus one worked example", () => {
    const prompt = buildWakePrompt(baseInputs, true)
    expect(prompt).not.toContain("Shape:")
    expect(prompt).not.toContain('"picked_action_id": <number|null>')
    expect(prompt).toContain("enforced automatically")
    expect(prompt).toContain('"picked_action_id": 1')
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
    const result = await Effect.runPromise(Effect.result(parseDigest("luna", text)))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(WakeError)
      expect(result.failure.op).toBe("wake/parse")
    }
  })

  it("fails with WakeError on non-JSON output", async () => {
    const result = await Effect.runPromise(
      Effect.result(parseDigest("luna", "not json at all")),
    )
    expect(result._tag).toBe("Failure")
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
      Effect.result(runReason(baseInputs, sdkLayer)),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(WakeError)
      expect(result.failure.op).toBe("wake/sdk-stream")
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
          Effect.result(runReason(baseInputs, sdkHang)),
        )
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(WakeError)
          expect(result.failure.op).toBe("wake/sdk-stream")
          expect(result.failure.message).toMatch(/timed out/)
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
          Effect.result(
            runReason(baseInputs, recordingClient(sink), anthropicOnlyBroker),
          ),
        )
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(WakeError)
          expect(result.failure.op).toBe("wake/acquire")
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

// ── structured-output path ────────────────────────────────────────────────
describe("validateDigest — schema-validated structured_output path", () => {
  it("accepts a well-formed already-parsed object (no JSON.parse, no fences)", async () => {
    const digest = await Effect.runPromise(
      validateDigest("ws", {
        observations: ["o1", "o2"],
        picked_action_id: 42,
        picked_reason: "because",
        proposed_actions: [
          { action: "do x", priority: 2, rationale: "r", goal_slug: null },
        ],
      }),
    )
    expect(digest.workspaceSlug).toBe("ws")
    expect(digest.pickedActionId).toBe(42)
    expect(digest.proposedActions).toHaveLength(1)
    expect(digest.proposedActions[0]?.goalSlug).toBeNull()
  })

  it("accepts null picked_action_id", async () => {
    const digest = await Effect.runPromise(
      validateDigest("ws", {
        observations: [],
        picked_action_id: null,
        picked_reason: "nothing actionable",
        proposed_actions: [],
      }),
    )
    expect(digest.pickedActionId).toBeNull()
  })

  it("rejects a malformed object with a WakeError (defense-in-depth)", async () => {
    const exit = await Effect.runPromiseExit(
      validateDigest("ws", {
        observations: "not-an-array",
        picked_action_id: 1,
        picked_reason: "x",
        proposed_actions: [],
      }),
    )
    expect(exit._tag).toBe("Failure")
  })
})

describe("reasonerStructuredOutputEnabled - capability-driven default + env override", () => {
  it("no override + capable lane (bare 'default' → anthropic) → ON", () => {
    expect(reasonerStructuredOutputEnabled(undefined, {})).toBe(true)
  })
  it("no override + capable lane (google) → ON", () => {
    expect(reasonerStructuredOutputEnabled("gemini-2.5-flash", {})).toBe(true)
  })
  it("no override + incapable lane (openai, structuredOutput=\"none\") → OFF", () => {
    expect(reasonerStructuredOutputEnabled("gpt-4o", {})).toBe(false)
  })
  it("no override + incapable lane (ollama-cloud) → OFF", () => {
    expect(reasonerStructuredOutputEnabled("qwen3:cloud", {})).toBe(false)
  })
  it("override 1/true/yes/on FORCES on even for an incapable lane (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " On "]) {
      expect(
        reasonerStructuredOutputEnabled("gpt-4o", {
          LUNA_REASONER_STRUCTURED_OUTPUT: v,
        }),
      ).toBe(true)
    }
  })
  it("override 0/false/no/off FORCES off even for a capable lane (the rollback lever)", () => {
    for (const v of ["0", "false", "no", "off"]) {
      expect(
        reasonerStructuredOutputEnabled(undefined, {
          LUNA_REASONER_STRUCTURED_OUTPUT: v,
        }),
      ).toBe(false)
    }
  })
  it("blank or unrecognized override value defers to the capability check", () => {
    expect(
      reasonerStructuredOutputEnabled(undefined, {
        LUNA_REASONER_STRUCTURED_OUTPUT: "",
      }),
    ).toBe(true)
    expect(
      reasonerStructuredOutputEnabled("gpt-4o", {
        LUNA_REASONER_STRUCTURED_OUTPUT: "maybe",
      }),
    ).toBe(false)
  })
})

// ── flag-ON layer-level end-to-end (the acknowledged follow-up) ─────────────
// Proves the WHOLE WakeReasonerDefault layer, not just the helpers in
// isolation: with LUNA_REASONER_STRUCTURED_OUTPUT=1 the reasoner (a) injects
// outputFormat:{type:"json_schema", schema:WAKE_DIGEST_SCHEMA} into the options
// it hands sdk.query, and (b) takes the validateDigest(structured_output) branch
// instead of parseDigest(text). The headline case deliberately serves a result
// frame whose TEXT is unparseable garbage but whose structured_output is valid —
// the exact "model wrapped its output despite the prompt" failure that the OLD
// text-parse path returned a WakeError on, now resolved cleanly.
describe("WakeReasonerDefault — structured output flag ON (end-to-end)", () => {
  /**
   * Recording fake: captures the options the reasoner builds AND lets the test
   * choose the result frame (so we can serve garbage text + valid structured).
   */
  const recordingClientWith = (
    sink: { last: { options: Record<string, unknown> } | null },
    frame: SDKMessage,
  ): Layer.Layer<SDKClient> =>
    SDKClient.fake((params) => {
      sink.last = { options: (params.options ?? {}) as Record<string, unknown> }
      return makeFakeQuery({ messages: [frame] }).query
    })

  const validDigest = {
    observations: ["one open action", "two goals"],
    picked_action_id: 1,
    picked_reason: "highest priority + actionable",
    proposed_actions: [
      { action: "file follow-up", priority: 2, rationale: "preventive", goal_slug: "g1" },
    ],
  }

  const withFlag = async (value: string | undefined, fn: () => Promise<void>) => {
    const prev = process.env["LUNA_REASONER_STRUCTURED_OUTPUT"]
    if (value === undefined) delete process.env["LUNA_REASONER_STRUCTURED_OUTPUT"]
    else process.env["LUNA_REASONER_STRUCTURED_OUTPUT"] = value
    try {
      await fn()
    } finally {
      if (prev === undefined) delete process.env["LUNA_REASONER_STRUCTURED_OUTPUT"]
      else process.env["LUNA_REASONER_STRUCTURED_OUTPUT"] = prev
    }
  }

  it("flag ON → injects outputFormat(json_schema, WAKE_DIGEST_SCHEMA) into the SDK options", async () => {
    const sink: { last: { options: Record<string, unknown> } | null } = { last: null }
    const frame = {
      ...makeResultMessage("sid", "uuid-so"),
      result: JSON.stringify(validDigest),
      structured_output: validDigest,
    } as unknown as SDKMessage
    await withFlag("1", async () => {
      await Effect.runPromise(runReason(baseInputs, recordingClientWith(sink, frame)))
    })
    const opts = sink.last!.options
    const outputFormat = opts["outputFormat"] as
      | { type?: string; schema?: unknown }
      | undefined
    expect(outputFormat).toBeDefined()
    expect(outputFormat!.type).toBe("json_schema")
    expect(outputFormat!.schema).toBe(WAKE_DIGEST_SCHEMA)
  })

  it("flag ON → consumes structured_output EVEN WHEN the text result is unparseable garbage (kills the wrapped-output failure class)", async () => {
    const sink: { last: { options: Record<string, unknown> } | null } = { last: null }
    // The model "wrapped" its output: the text result is prose, NOT JSON — the
    // exact case parseDigest(text) fails on. But structured_output is valid.
    const frame = {
      ...makeResultMessage("sid", "uuid-garbage"),
      result: "Sure! Here is the digest you asked for: (see attached)",
      structured_output: validDigest,
    } as unknown as SDKMessage

    // Control: the OLD text-parse path on that same garbage text DOES fail —
    // this is the failure class the structured path eliminates.
    const control = await Effect.runPromise(
      Effect.result(parseDigest("luna", "Sure! Here is the digest you asked for: (see attached)")),
    )
    expect(control._tag).toBe("Failure")

    await withFlag("1", async () => {
      const digest = await Effect.runPromise(
        runReason(baseInputs, recordingClientWith(sink, frame)),
      )
      // Resolved cleanly from structured_output despite the garbage text.
      expect(digest.workspaceSlug).toBe("luna")
      expect(digest.pickedActionId).toBe(1)
      expect(digest.pickedReason).toBe("highest priority + actionable")
      expect(digest.observations).toEqual(["one open action", "two goals"])
      expect(digest.proposedActions).toHaveLength(1)
      expect(digest.proposedActions[0]?.goalSlug).toBe("g1")
    })
  })

  it("no explicit override, default lane (anthropic - capability-driven) → outputFormat included by default", async () => {
    const sink: { last: { options: Record<string, unknown> } | null } = { last: null }
    const frame = {
      ...makeResultMessage("sid", "uuid-default-on"),
      result: JSON.stringify(validDigest),
    } as unknown as SDKMessage
    await withFlag(undefined, async () => {
      const digest = await Effect.runPromise(
        runReason(baseInputs, recordingClientWith(sink, frame)),
      )
      expect(digest.pickedActionId).toBe(1)
    })
    const opts = sink.last!.options
    const outputFormat = opts["outputFormat"] as
      | { type?: string; schema?: unknown }
      | undefined
    expect(outputFormat).toBeDefined()
    expect(outputFormat!.type).toBe("json_schema")
    expect(outputFormat!.schema).toBe(WAKE_DIGEST_SCHEMA)
    expect(opts["maxTurns"]).toBe(1)
  })

  it("explicit override OFF rolls back structured output even on a capable (anthropic) lane", async () => {
    const sink: { last: { options: Record<string, unknown> } | null } = { last: null }
    const frame = {
      ...makeResultMessage("sid", "uuid-forced-off"),
      result: JSON.stringify(validDigest),
    } as unknown as SDKMessage
    await withFlag("0", async () => {
      const digest = await Effect.runPromise(
        runReason(baseInputs, recordingClientWith(sink, frame)),
      )
      expect(digest.pickedActionId).toBe(1)
    })
    const opts = sink.last!.options
    expect("outputFormat" in opts).toBe(false)
    expect(opts["maxTurns"]).toBe(1)
  })

  it("no explicit override, incapable lane (openai, structuredOutput=\"none\") → NO outputFormat", async () => {
    const OPENAI_TOK_ENV = "WAKE_OPENAI_TOK"
    const openaiBroker: Layer.Layer<AccountBroker> = AccountBrokerLayer.fromAccounts([
      { id: "o1", kind: "openai", secretRef: `env:${OPENAI_TOK_ENV}` },
    ]).pipe(Layer.provide(EnvSecretProvider.Default), Layer.provide(Clock.Default))
    const sink: { last: { options: Record<string, unknown> } | null } = { last: null }
    const frame = {
      ...makeResultMessage("sid", "uuid-incapable"),
      result: JSON.stringify(validDigest),
    } as unknown as SDKMessage
    const prevModel = process.env["LUNA_WAKE_MODEL"]
    const prevTok = process.env[OPENAI_TOK_ENV]
    process.env["LUNA_WAKE_MODEL"] = "gpt-4o"
    process.env[OPENAI_TOK_ENV] = "openai-secret"
    try {
      await withFlag(undefined, async () => {
        const digest = await Effect.runPromise(
          runReason(baseInputs, recordingClientWith(sink, frame), openaiBroker),
        )
        expect(digest.pickedActionId).toBe(1)
      })
    } finally {
      if (prevModel === undefined) delete process.env["LUNA_WAKE_MODEL"]
      else process.env["LUNA_WAKE_MODEL"] = prevModel
      if (prevTok === undefined) delete process.env[OPENAI_TOK_ENV]
      else process.env[OPENAI_TOK_ENV] = prevTok
    }
    const opts = sink.last!.options
    expect("outputFormat" in opts).toBe(false)
  })
})
