/**
 * TriggerAgent tests — focused on cron-expression validation at registration.
 * A parseable-but-unschedulable expression must be REJECTED at register time
 * rather than spawning a fiber that dies on its first Cron.next() and silently
 * stops firing.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { JobSchedulerLayer } from "./job-scheduler.js"
import { TriggerAgent, TriggerAgentLayer } from "./trigger-agent.js"

const stack = TriggerAgentLayer.Default.pipe(
  Layer.provide(JobSchedulerLayer.make({ capacity: 4 })),
  Layer.provide(Clock.Default),
)

describe("TriggerAgent cron validation", () => {
  it("rejects a parseable-but-unschedulable cron instead of spawning a dead fiber", async () => {
    const prog = Effect.gen(function* () {
      const trigger = yield* TriggerAgent
      // "0 0 30 2 *" parses fine, but Feb 30 never occurs → Cron.next throws.
      const result = yield* Effect.either(
        trigger.register({
          kind: "cron",
          expr: "0 0 30 2 *",
          build: () => ({ run: Effect.succeed("noop") }),
        }),
      )
      // Must be a typed failure (TriggerError), not a registered id.
      expect(result._tag).toBe("Left")
      // And it must NOT appear in the live registry.
      const list = yield* trigger.list
      expect(list.length).toBe(0)
    })
    await Effect.runPromise(Effect.scoped(prog).pipe(Effect.provide(stack)))
  })

  it("accepts a normal schedulable cron", async () => {
    const prog = Effect.gen(function* () {
      const trigger = yield* TriggerAgent
      const id = yield* trigger.register({
        kind: "cron",
        expr: "*/30 * * * *",
        build: () => ({ run: Effect.succeed("noop") }),
      })
      expect(typeof id).toBe("string")
      const list = yield* trigger.list
      expect(list.length).toBe(1)
      expect(list[0]?.expr).toBe("*/30 * * * *")
    })
    await Effect.runPromise(Effect.scoped(prog).pipe(Effect.provide(stack)))
  })
})
