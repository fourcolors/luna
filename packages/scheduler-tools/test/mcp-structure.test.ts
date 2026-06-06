/**
 * §4.3 Scheduler tools MCP structural assertions.
 *
 * Asserts structural invariants at build time:
 *
 *   1. SchedulerToolsLayer() builds successfully and provides a
 *      SchedulerToolsService with the expected shape.
 *   2. buildSchedulerMcpServer(trigger, scope) returns an object with
 *      type "sdk" and name "scheduler".
 *   3. makeSchedulerTools(trigger, scope) exposes exactly
 *      ["schedule_create", "schedule_list", "schedule_cancel"] in that order.
 *   4. SCHEDULER_SYSTEM_PROMPT_ADDENDUM is a non-empty string containing
 *      the word "scheduler".
 *
 * Tests 1-3 require a running TriggerAgent + JobScheduler stack.
 * Test 4 is a constant check that runs everywhere.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import {
  Clock,
  JobSchedulerLayer,
  JobsStoreService,
  TriggerAgent,
  TriggerAgentLayer,
} from "@luna/core"
import {
  SchedulerToolsLayer,
  SchedulerToolsService,
  buildSchedulerMcpServer,
  SCHEDULER_SYSTEM_PROMPT_ADDENDUM,
} from "../src/layer.js"
import { makeSchedulerTools } from "../src/tools.js"

/** Minimal stack: TriggerAgent + JobScheduler + Clock. */
const schedulerStack = Layer.provide(
  TriggerAgentLayer.Default,
  Layer.provide(
    JobSchedulerLayer.make({ capacity: 8, offerPolicy: "drop-newest" }),
    Clock.Default,
  ),
)

const jobsStoreStack = Layer.provide(
  JobsStoreService.Memory,
  Clock.Default,
)

describe("§4.3 SchedulerToolsLayer — structural invariants", () => {
  it("SchedulerToolsLayer() builds and provides SchedulerToolsService with correct shape", async () => {
    const config = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* SchedulerToolsService
        }),
      ).pipe(
        Effect.provide(SchedulerToolsLayer()),
        Effect.provide(jobsStoreStack),
      ),
    )

    expect(config.serverName).toBe("scheduler")
    expect(config.server).not.toBeNull()
    expect(typeof config.server).toBe("object")
    expect(typeof config.systemPromptAddendum).toBe("string")
    expect(config.systemPromptAddendum.length).toBeGreaterThan(0)
    expect(config.systemPromptAddendum).toBe(SCHEDULER_SYSTEM_PROMPT_ADDENDUM)
    expect(typeof config.createSessionBinding).toBe("function")

    const first = config.createSessionBinding()
    const second = config.createSessionBinding()
    expect(first.serverName).toBe("scheduler")
    expect(second.serverName).toBe("scheduler")
    expect(first.server).not.toBe(second.server)
    expect(
      (first.server as { instance?: unknown }).instance,
    ).not.toBe((second.server as { instance?: unknown }).instance)
  })

  it("buildSchedulerMcpServer returns object with type='sdk' and name='scheduler'", async () => {
    const serverConfig = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const trigger = yield* TriggerAgent
          const jobsStore = yield* JobsStoreService
          const layerScope = yield* Effect.scope
          return buildSchedulerMcpServer(trigger, layerScope, jobsStore)
        }),
      ).pipe(
        Effect.provide(schedulerStack),
        Effect.provide(jobsStoreStack),
      ),
    )

    expect(serverConfig).not.toBeNull()
    expect(typeof serverConfig).toBe("object")
    expect((serverConfig as { type?: string }).type).toBe("sdk")
    expect((serverConfig as { name?: string }).name).toBe("scheduler")
    expect(typeof (serverConfig as { instance?: unknown }).instance).toBe("object")
  })

  it("makeSchedulerTools exposes exactly [schedule_create, schedule_list, schedule_cancel]", async () => {
    const tools = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const trigger = yield* TriggerAgent
          const jobsStore = yield* JobsStoreService
          const layerScope = yield* Effect.scope
          return makeSchedulerTools(trigger, layerScope, jobsStore)
        }),
      ).pipe(
        Effect.provide(schedulerStack),
        Effect.provide(jobsStoreStack),
      ),
    )

    expect(tools).toHaveLength(3)
    const names = tools.map((t) => (t as unknown as { name: string }).name)
    expect(names).toEqual(["schedule_create", "schedule_list", "schedule_cancel"])
  })

  it("makeSchedulerTools marks every scheduler tool as eagerly loaded", async () => {
    const tools = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const trigger = yield* TriggerAgent
          const jobsStore = yield* JobsStoreService
          const layerScope = yield* Effect.scope
          return makeSchedulerTools(trigger, layerScope, jobsStore)
        }),
      ).pipe(
        Effect.provide(schedulerStack),
        Effect.provide(jobsStoreStack),
      ),
    )

    for (const tool of tools) {
      const meta = (tool as unknown as { _meta?: Record<string, unknown> })._meta
      expect(meta).toMatchObject({ "anthropic/alwaysLoad": true })
      expect(typeof meta?.["anthropic/searchHint"]).toBe("string")
      expect((meta?.["anthropic/searchHint"] as string).length).toBeGreaterThan(0)
    }
  })
})

describe("§4.3 SchedulerToolsService — constant invariants (all runtimes)", () => {
  it("SCHEDULER_SYSTEM_PROMPT_ADDENDUM is a non-empty string containing 'scheduler'", () => {
    expect(typeof SCHEDULER_SYSTEM_PROMPT_ADDENDUM).toBe("string")
    expect(SCHEDULER_SYSTEM_PROMPT_ADDENDUM.length).toBeGreaterThan(0)
    expect(SCHEDULER_SYSTEM_PROMPT_ADDENDUM.toLowerCase()).toContain("scheduler")
    expect(SCHEDULER_SYSTEM_PROMPT_ADDENDUM).toContain(
      "mcp__scheduler__schedule_create",
    )
    expect(SCHEDULER_SYSTEM_PROMPT_ADDENDUM).toContain(
      "mcp__scheduler__schedule_list",
    )
    expect(SCHEDULER_SYSTEM_PROMPT_ADDENDUM).toContain(
      "mcp__scheduler__schedule_cancel",
    )
    expect(SCHEDULER_SYSTEM_PROMPT_ADDENDUM).toContain("fully qualified")
  })
})
