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
import { WakeError, WakeReasoner } from "@luna/core"
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

const runReason = (inputs: WakeInputs, sdkLayer: Layer.Layer<SDKClient>) =>
  Effect.gen(function* () {
    const r = yield* WakeReasoner
    return yield* r.reason(inputs)
  }).pipe(Effect.provide(WakeReasonerDefault), Effect.provide(sdkLayer))

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
})
