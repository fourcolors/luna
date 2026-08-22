/**
 * Real gateway adapter Stream.callback yield/end coverage.
 *
 * Uses the stdio adapter with an injected Readable — not the in-memory
 * GatewayService queue stub — so a Stream.callback that ends immediately
 * after setup (zero items) fails this suite.
 */
import { describe, expect, it } from "vitest"
import { PassThrough } from "node:stream"
import {
  Duration,
  Effect,
  Fiber,
  Stream,
} from "effect"
import { makeStdioAdapter } from "../src/gateway/adapters/stdio.js"

describe("gateway adapters (Stream.callback)", () => {
  it("stdio: yields a line then completes on input end", async () => {
    const input = new PassThrough()
    const adapter = makeStdioAdapter({
      input,
      output: () => undefined,
    })

    const collected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            Stream.runCollect(adapter.messages),
          )

          // If Stream.callback ended on setup completion, runCollect would
          // already be done with [] before we write — assert it is still live.
          yield* Effect.sleep(Duration.millis(30))
          expect(fiber.pollUnsafe()).toBeUndefined()

          input.write("hello from stdio\n")
          // Allow readline + Queue.offer to land before closing.
          yield* Effect.sleep(Duration.millis(30))
          input.end()

          return yield* Fiber.join(fiber)
        }),
      ),
    )

    expect(collected.length).toBe(1)
    expect(collected[0]?.text).toBe("hello from stdio")
    expect(collected[0]?.transport).toBe("cli")
    expect(collected[0]?.channelId).toBe("stdio")
    expect(collected[0]?.senderId).toBe("user")
  })
})
