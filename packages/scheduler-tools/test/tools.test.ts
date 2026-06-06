/**
 * Scheduler tools Tier-1 tests.
 *
 *   1. schedule_create with valid cron returns triggerId
 *   2. schedule_create with invalid cron returns tool error
 *   3. schedule_list returns empty array initially
 *   4. schedule_list after schedule_create returns 1 entry
 *   5. schedule_cancel on known id returns { cancelled: true }
 *   6. schedule_cancel on unknown id returns { cancelled: false }
 *
 * Tests invoke the SDK tool handlers directly — same boundary the agent
 * crosses — and exercise the full Effect → SDK promise translation.
 *
 * The TriggerAgent + JobScheduler + Clock stack is provided via a shared
 * Effect.scoped program helper so all handlers in a single test share the
 * same live service instances.
 */
import { describe, expect, it } from "vitest"
import { Effect, Fiber, Layer, Ref } from "effect"
import {
  Clock,
  JobSchedulerLayer,
  JobsStoreService,
  TriggerAgent,
  TriggerAgentLayer,
} from "@luna/core"
import { makeSchedulerTools } from "../src/tools.js"
import type * as Scope from "effect/Scope"

interface ToolCallResult {
  readonly content?: ReadonlyArray<{ type: string; text: string }>
  readonly isError?: boolean
}

function parseTextResult<T>(r: ToolCallResult): T {
  expect(r.isError).toBeFalsy()
  const first = r.content?.[0]
  expect(first?.type).toBe("text")
  return JSON.parse((first as { text: string }).text) as T
}

function parseErrorResult(r: ToolCallResult): string {
  expect(r.isError).toBe(true)
  return r.content?.[0]?.text ?? ""
}

/** Run a program with TriggerAgent + JobScheduler + Clock + JobsStore in scope. */
const withScheduler = <A>(
  prog: Effect.Effect<A, unknown, TriggerAgent | Clock | JobsStoreService | Scope.Scope>,
) =>
  Effect.scoped(
    prog.pipe(
      Effect.provide(TriggerAgentLayer.Default),
      Effect.provide(JobSchedulerLayer.make({ capacity: 16, offerPolicy: "drop-newest" })),
      Effect.provide(JobsStoreService.Memory),
      Effect.provide(Clock.Default),
    ),
  )

describe("scheduler tools — Tier 1", () => {
  it("schedule_create with valid cron returns triggerId and expr", async () => {
    const result = await Effect.runPromise(
      withScheduler(
        Effect.gen(function* () {
          const trigger = yield* TriggerAgent
          const jobsStore = yield* JobsStoreService
          const layerScope = yield* Effect.scope
          const [createTool] = makeSchedulerTools(trigger, layerScope, jobsStore)
          return yield* Effect.promise(() =>
            createTool.handler(
              { expr: "0 9 * * 1", label: "weekly-standup" },
              undefined,
            ),
          )
        }),
      ),
    )
    const parsed = parseTextResult<{
      triggerId: string
      expr: string
      registeredAt: string
    }>(result)
    expect(typeof parsed.triggerId).toBe("string")
    expect(parsed.triggerId).toMatch(/^trigger-/)
    expect(parsed.expr).toBe("0 9 * * 1")
    expect(typeof parsed.registeredAt).toBe("string")
  })

  it("schedule_create with invalid cron returns tool error", async () => {
    const result = await Effect.runPromise(
      withScheduler(
        Effect.gen(function* () {
          const trigger = yield* TriggerAgent
          const jobsStore = yield* JobsStoreService
          const layerScope = yield* Effect.scope
          const [createTool] = makeSchedulerTools(trigger, layerScope, jobsStore)
          return yield* Effect.promise(() =>
            createTool.handler({ expr: "not-a-cron-expr" }, undefined),
          )
        }),
      ),
    )
    const msg = parseErrorResult(result)
    expect(msg).toContain("schedule_create")
  })

  it("schedule_list returns empty array when no schedules registered", async () => {
    const result = await Effect.runPromise(
      withScheduler(
        Effect.gen(function* () {
          const trigger = yield* TriggerAgent
          const jobsStore = yield* JobsStoreService
          const layerScope = yield* Effect.scope
          const [, listTool] = makeSchedulerTools(trigger, layerScope, jobsStore)
          return yield* Effect.promise(() => listTool.handler({}, undefined))
        }),
      ),
    )
    const parsed = parseTextResult<{ triggers: unknown[] }>(result)
    expect(parsed.triggers).toHaveLength(0)
  })

  it("schedule_list after schedule_create returns 1 entry with correct fields", async () => {
    const result = await Effect.runPromise(
      withScheduler(
        Effect.gen(function* () {
          const trigger = yield* TriggerAgent
          const jobsStore = yield* JobsStoreService
          const layerScope = yield* Effect.scope
          const [createTool, listTool] = makeSchedulerTools(trigger, layerScope, jobsStore)
          yield* Effect.promise(() =>
            createTool.handler({ expr: "*/5 * * * *", label: "poll" }, undefined),
          )
          return yield* Effect.promise(() => listTool.handler({}, undefined))
        }),
      ),
    )
    const parsed = parseTextResult<{
      triggers: Array<{
        triggerId: string
        kind: string
        expr: string | null
        registeredAt: string
      }>
    }>(result)
    expect(parsed.triggers).toHaveLength(1)
    expect(parsed.triggers[0]!.kind).toBe("cron")
    expect(parsed.triggers[0]!.expr).toBe("*/5 * * * *")
    expect(typeof parsed.triggers[0]!.registeredAt).toBe("string")
  })

  it("schedule_cancel on known id returns { cancelled: true } and removes from list", async () => {
    const result = await Effect.runPromise(
      withScheduler(
        Effect.gen(function* () {
          const trigger = yield* TriggerAgent
          const jobsStore = yield* JobsStoreService
          const layerScope = yield* Effect.scope
          const [createTool, listTool, cancelTool] = makeSchedulerTools(trigger, layerScope, jobsStore)
          const created = parseTextResult<{ triggerId: string }>(
            yield* Effect.promise(() =>
              createTool.handler({ expr: "0 * * * *" }, undefined),
            ),
          )
          const cancelResult = parseTextResult<{ cancelled: boolean }>(
            yield* Effect.promise(() =>
              cancelTool.handler({ triggerId: created.triggerId }, undefined),
            ),
          )
          const afterList = parseTextResult<{ triggers: unknown[] }>(
            yield* Effect.promise(() => listTool.handler({}, undefined)),
          )
          return { cancelResult, afterCount: afterList.triggers.length }
        }),
      ),
    )
    expect(result.cancelResult.cancelled).toBe(true)
    expect(result.afterCount).toBe(0)
  })

  it("schedule_cancel on unknown id returns { cancelled: false }", async () => {
    const result = await Effect.runPromise(
      withScheduler(
        Effect.gen(function* () {
          const trigger = yield* TriggerAgent
          const jobsStore = yield* JobsStoreService
          const layerScope = yield* Effect.scope
          const [, , cancelTool] = makeSchedulerTools(trigger, layerScope, jobsStore)
          return yield* Effect.promise(() =>
            cancelTool.handler(
              { triggerId: "trigger-does-not-exist" },
              undefined,
            ),
          )
        }),
      ),
    )
    const parsed = parseTextResult<{ cancelled: boolean }>(result)
    expect(parsed.cancelled).toBe(false)
  })
})

// Suppress unused-import warnings from type-only imports used in generics.
const _: [typeof Fiber, typeof Layer, typeof Ref] | null = null
void _
