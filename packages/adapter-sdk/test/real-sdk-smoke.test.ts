/**
 * Tier-4 real-SDK smoke test — skipIf no OAuth token is set.
 *
 * Runs dormant in CI; fires locally when `CLAUDE_CODE_OAUTH_TOKEN` is
 * present. This is the minimal "does the adapter actually drive the SDK"
 * check; full parity corpus lives in Phase 24.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Stream } from "effect"
import { SessionStore } from "@experiment-agent/core"
import { SDKAdapter, SDKClient } from "../src/index.js"
import type { SDKUserMessage } from "../src/sdk-client.js"

const hasToken = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN)

describe.skipIf(!hasToken)("SDKAdapter (real SDK smoke)", () => {
  it(
    "runs a single trivial query end-to-end",
    async () => {
      const prompt: Stream.Stream<SDKUserMessage> = Stream.fromIterable([
        {
          type: "user",
          message: { role: "user", content: "Say exactly: pong" },
          parent_tool_use_id: null,
        } as SDKUserMessage,
      ])

      const messages = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SessionStore
            yield* store.create({
              id: "real-smoke",
              options: { model: "claude-sonnet-4-5" },
              createdAt: Date.now(),
            })
            const adapter = yield* SDKAdapter
            const out = yield* adapter.query({
              sessionId: "real-smoke",
              prompt,
              sessionOptions: {
                model: "claude-sonnet-4-5",
                idleTimeoutMs: 60_000,
                sdkOptions: { maxTurns: 1 },
              },
            })
            const chunk = yield* Stream.runCollect(out)
            return Array.from(chunk).length
          }),
        ).pipe(
          Effect.provide(
            Layer.provideMerge(
              SDKAdapter.Default,
              Layer.mergeAll(SDKClient.Default, SessionStore.Default),
            ),
          ),
        ),
      )

      expect(messages).toBeGreaterThan(0)
    },
    { timeout: 120_000 },
  )
})
