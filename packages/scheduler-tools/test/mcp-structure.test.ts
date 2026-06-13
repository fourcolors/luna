/**
 * Scheduler tools MCP structural assertions (V2-native).
 *
 *   1. SchedulerToolsLayer() builds and provides SchedulerToolsService.
 *   2. buildSchedulerMcpServer(jobsStore) returns an SDK server named "scheduler".
 *   3. makeSchedulerTools(jobsStore) exposes exactly the three tools in order.
 *   4. SCHEDULER_SYSTEM_PROMPT_ADDENDUM is a non-empty string naming the tools.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Clock, JobsStoreService } from "@luna/core"
import {
  SchedulerToolsLayer,
  SchedulerToolsService,
  buildSchedulerMcpServer,
  SCHEDULER_SYSTEM_PROMPT_ADDENDUM,
} from "../src/layer.js"
import { makeSchedulerTools } from "../src/tools.js"

const jobsStoreStack = JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))

describe("SchedulerToolsLayer — structural invariants", () => {
  it("builds and provides SchedulerToolsService with the correct shape", async () => {
    const config = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* SchedulerToolsService
      }).pipe(
        Effect.provide(SchedulerToolsLayer()),
        Effect.provide(jobsStoreStack),
      ),
    )

    expect(config.serverName).toBe("scheduler")
    expect(config.server).not.toBeNull()
    expect(typeof config.systemPromptAddendum).toBe("string")
    expect(config.systemPromptAddendum).toBe(SCHEDULER_SYSTEM_PROMPT_ADDENDUM)
    expect(typeof config.createSessionBinding).toBe("function")

    const first = config.createSessionBinding()
    const second = config.createSessionBinding()
    expect(first.serverName).toBe("scheduler")
    expect(
      (first.server as { instance?: unknown }).instance,
    ).not.toBe((second.server as { instance?: unknown }).instance)
  })

  it("buildSchedulerMcpServer returns an SDK server named 'scheduler'", async () => {
    const serverConfig = await Effect.runPromise(
      Effect.gen(function* () {
        const jobsStore = yield* JobsStoreService
        return buildSchedulerMcpServer(jobsStore)
      }).pipe(Effect.provide(jobsStoreStack)),
    )
    expect((serverConfig as { type?: string }).type).toBe("sdk")
    expect((serverConfig as { name?: string }).name).toBe("scheduler")
    expect(typeof (serverConfig as { instance?: unknown }).instance).toBe("object")
  })

  it("makeSchedulerTools exposes exactly [schedule_create, schedule_list, schedule_cancel]", async () => {
    const tools = await Effect.runPromise(
      Effect.gen(function* () {
        const jobsStore = yield* JobsStoreService
        return makeSchedulerTools(jobsStore)
      }).pipe(Effect.provide(jobsStoreStack)),
    )
    expect(tools).toHaveLength(3)
    const names = tools.map((t) => (t as unknown as { name: string }).name)
    expect(names).toEqual(["schedule_create", "schedule_list", "schedule_cancel"])
  })

  it("marks every scheduler tool as eagerly loaded", async () => {
    const tools = await Effect.runPromise(
      Effect.gen(function* () {
        const jobsStore = yield* JobsStoreService
        return makeSchedulerTools(jobsStore)
      }).pipe(Effect.provide(jobsStoreStack)),
    )
    for (const tool of tools) {
      const meta = (tool as unknown as { _meta?: Record<string, unknown> })._meta
      expect(meta).toMatchObject({ "anthropic/alwaysLoad": true })
      expect(typeof meta?.["anthropic/searchHint"]).toBe("string")
    }
  })
})

describe("SCHEDULER_SYSTEM_PROMPT_ADDENDUM — constant invariants", () => {
  it("is a non-empty string naming the fully-qualified tools", () => {
    expect(SCHEDULER_SYSTEM_PROMPT_ADDENDUM.length).toBeGreaterThan(0)
    expect(SCHEDULER_SYSTEM_PROMPT_ADDENDUM.toLowerCase()).toContain("scheduler")
    expect(SCHEDULER_SYSTEM_PROMPT_ADDENDUM).toContain("mcp__scheduler__schedule_create")
    expect(SCHEDULER_SYSTEM_PROMPT_ADDENDUM).toContain("mcp__scheduler__schedule_list")
    expect(SCHEDULER_SYSTEM_PROMPT_ADDENDUM).toContain("mcp__scheduler__schedule_cancel")
    expect(SCHEDULER_SYSTEM_PROMPT_ADDENDUM).toContain("fully qualified")
    expect(SCHEDULER_SYSTEM_PROMPT_ADDENDUM).toContain("UTC")
  })
})
