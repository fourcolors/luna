/**
 * bounded-query.test.ts — Tier-1 tests for the shared bounded SDK-query helper.
 *
 * The timeout test is the CANONICAL proof that `runBoundedQuery` interrupts a
 * wedged turn promptly AND fires the subprocess kill — the property all three
 * call sites (workflow prompt step, prompt-worker, dream-reasoner) depend on.
 * ZERO model calls.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { SDKClient, type SDKClientService } from "../src/sdk-client.js"
import { runBoundedQuery } from "../src/bounded-query.js"
import { makeFakeQuery, makeAssistantMessage } from "./fake-sdk.js"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

const resultMsg = (text: string): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    session_id: "s",
    uuid: "u",
    is_error: false,
    duration_ms: 5,
    duration_api_ms: 3,
    num_turns: 1,
    result: text,
  }) as unknown as SDKMessage

const runWith = <A>(
  sdkLayer: Layer.Layer<SDKClient>,
  body: (sdk: SDKClientService) => Effect.Effect<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sdk = yield* SDKClient
      return yield* body(sdk)
    }).pipe(Effect.provide(sdkLayer)),
  )

describe("runBoundedQuery — terminal outcomes", () => {
  it("result: folds to the type:result/subtype:success text", async () => {
    const sdkLayer = SDKClient.fake(() =>
      makeFakeQuery({ messages: [resultMsg("hello")] }).query,
    )
    const out = await runWith(sdkLayer, (sdk) => runBoundedQuery(sdk, { prompt: "x" }))
    expect(out._tag).toBe("result")
    if (out._tag === "result") expect(out.text).toBe("hello")
  })

  it("empty: stream ends with no success message → _tag='empty'", async () => {
    const sdkLayer = SDKClient.fake(() =>
      makeFakeQuery({ messages: [makeAssistantMessage("s", "thinking", "u1")] })
        .query,
    )
    const out = await runWith(sdkLayer, (sdk) => runBoundedQuery(sdk, { prompt: "x" }))
    expect(out._tag).toBe("empty")
  })

  it("error: producer throws → _tag='error' carries the cause", async () => {
    const sdkLayer = SDKClient.fake(() =>
      makeFakeQuery({
        messages: [makeAssistantMessage("s", "partial", "u1")],
        throwAfter: 1,
      }).query,
    )
    const out = await runWith(sdkLayer, (sdk) => runBoundedQuery(sdk, { prompt: "x" }))
    expect(out._tag).toBe("error")
    if (out._tag === "error") expect(String(out.cause)).toMatch(/simulated failure/)
  })

  it(
    "timeout: a wedged turn returns _tag='timeout' PROMPTLY and aborts the subprocess",
    async () => {
      let captured: AbortController | undefined

      // Faithful fake: yields nothing until its AbortController fires, then
      // ends. If runBoundedQuery's timeout failed to interrupt the wedged pull
      // or failed to abort, this would hang to the vitest deadline (red).
      const sdkLayer = SDKClient.fake((params) => {
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

      const started = Date.now()
      const out = await runWith(sdkLayer, (sdk) =>
        runBoundedQuery(sdk, { prompt: "hang" }, 50),
      )
      const elapsed = Date.now() - started

      expect(out._tag).toBe("timeout")
      if (out._tag === "timeout") expect(out.timeoutMs).toBe(50)
      expect(captured?.signal.aborted).toBe(true)
      // Prompt interruption — nowhere near the 30s fake gap.
      expect(elapsed).toBeLessThan(5_000)
    },
    10_000,
  )

  it("preserves caller options (maxTurns/model) while injecting abortController", async () => {
    let seen: { maxTurns?: number; model?: string; hasAbort: boolean } | undefined
    const sdkLayer = SDKClient.fake((params) => {
      seen = {
        maxTurns: params.options?.maxTurns,
        model: params.options?.model,
        hasAbort: params.options?.abortController instanceof AbortController,
      }
      return makeFakeQuery({ messages: [resultMsg("ok")] }).query
    })
    await runWith(sdkLayer, (sdk) =>
      runBoundedQuery(sdk, {
        prompt: "x",
        options: { maxTurns: 7, model: "claude-sonnet-4-5" },
      }),
    )
    expect(seen).toEqual({ maxTurns: 7, model: "claude-sonnet-4-5", hasAbort: true })
  })
})
