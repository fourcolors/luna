/**
 * Scheduler tools tests (V2-native).
 *
 * A schedule is a durable RECURRING `kind:"prompt"` row in the `jobs` table;
 * the V2 JobTicker re-fires it (firing is covered by job-ticker.test.ts). These
 * tests cover the agent-facing create / list / cancel surface against an
 * in-memory JobsStore — the same boundary the agent crosses.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Clock, JobsStoreService } from "@luna/core"
import { makeSchedulerTools } from "../src/tools.js"

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

/** Run a program with a JobsStore (Memory) in scope. */
const withScheduler = <A>(
  prog: Effect.Effect<A, unknown, JobsStoreService>,
) => prog.pipe(Effect.provide(JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))))

describe("scheduler tools — V2", () => {
  it("schedule_create persists a recurring prompt job and returns a triggerId", async () => {
    const result = await Effect.runPromise(
      withScheduler(
        Effect.gen(function* () {
          const jobsStore = yield* JobsStoreService
          const [createTool] = makeSchedulerTools(jobsStore)
          const out = yield* Effect.promise(() =>
            createTool.handler(
              { expr: "0 9 * * 1", prompt: "remind me about standup", label: "weekly-standup" },
              undefined,
            ),
          )
          const parsed = parseTextResult<{
            triggerId: string
            expr: string
            registeredAt: string
          }>(out as ToolCallResult)
          const job = yield* jobsStore.getById(parsed.triggerId)
          return { parsed, job }
        }),
      ),
    )
    expect(result.parsed.triggerId).toMatch(/^sched-/)
    expect(result.parsed.expr).toBe("0 9 * * 1")
    expect(typeof result.parsed.registeredAt).toBe("string")
    // A durable RECURRING prompt job was persisted (spec non-empty → not a
    // one-shot), enabled and due at the next cron match.
    expect(result.job?.kind).toBe("prompt")
    expect(result.job?.spec).toBe("0 9 * * 1")
    expect(result.job?.enabled).toBe(true)
    expect((result.job?.nextRunAt ?? 0) > 0).toBe(true)
    expect(result.job?.payload.user_prompt).toBe("remind me about standup")
    expect(result.job?.payload.source).toBe("scheduler-tools")
    expect((result.job?.payload as { deliver_to?: { kind?: string } }).deliver_to?.kind).toBe(
      "obs_note",
    )
  })

  it("schedule_create with an invalid cron returns a tool error", async () => {
    const result = await Effect.runPromise(
      withScheduler(
        Effect.gen(function* () {
          const jobsStore = yield* JobsStoreService
          const [createTool] = makeSchedulerTools(jobsStore)
          return yield* Effect.promise(() =>
            createTool.handler({ expr: "not a cron", prompt: "x" }, undefined),
          )
        }),
      ),
    )
    expect(parseErrorResult(result as ToolCallResult)).toContain("schedule_create")
  })

  it("schedule_create rejects an ambiguous 6-field cron (seconds field)", async () => {
    const result = await Effect.runPromise(
      withScheduler(
        Effect.gen(function* () {
          const jobsStore = yield* JobsStoreService
          const [createTool, listTool] = makeSchedulerTools(jobsStore)
          const created = yield* Effect.promise(() =>
            createTool.handler({ expr: "*/5 * * * * *", prompt: "x", label: "oops" }, undefined),
          )
          const afterList = yield* Effect.promise(() => listTool.handler({}, undefined))
          return { created, afterList }
        }),
      ),
    )
    expect(parseErrorResult(result.created as ToolCallResult)).toContain("schedule_create")
    const list = parseTextResult<{ triggers: unknown[] }>(result.afterList as ToolCallResult)
    expect(list.triggers).toHaveLength(0)
  })

  it("schedule_list surfaces read-only system schedules alongside agent schedules", async () => {
    const result = await Effect.runPromise(
      withScheduler(
        Effect.gen(function* () {
          const jobsStore = yield* JobsStoreService
          const [createTool, listTool] = makeSchedulerTools(jobsStore, [
            { label: "wake (workspace digest)", expr: "*/30 * * * *" },
          ])
          yield* Effect.promise(() =>
            createTool.handler({ expr: "0 9 * * 1", prompt: "standup", label: "standup" }, undefined),
          )
          return yield* Effect.promise(() => listTool.handler({}, undefined))
        }),
      ),
    )
    const parsed = parseTextResult<{
      triggers: Array<{
        triggerId: string
        expr: string | null
        cancellable: boolean
        source: string
      }>
    }>(result as ToolCallResult)
    const agent = parsed.triggers.find((t) => t.expr === "0 9 * * 1")
    const system = parsed.triggers.find((t) => t.expr === "*/30 * * * *")
    expect(agent?.cancellable).toBe(true)
    expect(agent?.source).toBe("agent")
    expect(system).toBeDefined()
    expect(system?.cancellable).toBe(false)
    expect(system?.source).toBe("system")
  })

  it("schedule_list returns empty when nothing is registered", async () => {
    const result = await Effect.runPromise(
      withScheduler(
        Effect.gen(function* () {
          const jobsStore = yield* JobsStoreService
          const [, listTool] = makeSchedulerTools(jobsStore)
          return yield* Effect.promise(() => listTool.handler({}, undefined))
        }),
      ),
    )
    expect(parseTextResult<{ triggers: unknown[] }>(result as ToolCallResult).triggers).toHaveLength(0)
  })

  it("schedule_list after schedule_create returns one cancellable agent entry", async () => {
    const result = await Effect.runPromise(
      withScheduler(
        Effect.gen(function* () {
          const jobsStore = yield* JobsStoreService
          const [createTool, listTool] = makeSchedulerTools(jobsStore)
          yield* Effect.promise(() =>
            createTool.handler({ expr: "*/5 * * * *", prompt: "poll", label: "poll" }, undefined),
          )
          return yield* Effect.promise(() => listTool.handler({}, undefined))
        }),
      ),
    )
    const parsed = parseTextResult<{
      triggers: Array<{ triggerId: string; expr: string | null; source: string; cancellable: boolean }>
    }>(result as ToolCallResult)
    expect(parsed.triggers).toHaveLength(1)
    expect(parsed.triggers[0]!.expr).toBe("*/5 * * * *")
    expect(parsed.triggers[0]!.source).toBe("agent")
    expect(parsed.triggers[0]!.cancellable).toBe(true)
    expect(parsed.triggers[0]!.triggerId).toMatch(/^sched-/)
  })

  it("schedule_cancel on a known id removes the row and returns cancelled:true", async () => {
    const result = await Effect.runPromise(
      withScheduler(
        Effect.gen(function* () {
          const jobsStore = yield* JobsStoreService
          const [createTool, listTool, cancelTool] = makeSchedulerTools(jobsStore)
          const created = parseTextResult<{ triggerId: string }>(
            (yield* Effect.promise(() =>
              createTool.handler({ expr: "0 * * * *", prompt: "hourly" }, undefined),
            )) as ToolCallResult,
          )
          const cancelResult = parseTextResult<{ cancelled: boolean }>(
            (yield* Effect.promise(() =>
              cancelTool.handler({ triggerId: created.triggerId }, undefined),
            )) as ToolCallResult,
          )
          const afterList = parseTextResult<{ triggers: unknown[] }>(
            (yield* Effect.promise(() => listTool.handler({}, undefined))) as ToolCallResult,
          )
          const row = yield* jobsStore.getById(created.triggerId)
          return { cancelResult, afterCount: afterList.triggers.length, row }
        }),
      ),
    )
    expect(result.cancelResult.cancelled).toBe(true)
    expect(result.afterCount).toBe(0)
    expect(result.row).toBeNull()
  })

  it("schedule_cancel on an unknown id returns cancelled:false", async () => {
    const result = await Effect.runPromise(
      withScheduler(
        Effect.gen(function* () {
          const jobsStore = yield* JobsStoreService
          const [, , cancelTool] = makeSchedulerTools(jobsStore)
          return yield* Effect.promise(() =>
            cancelTool.handler({ triggerId: "sched-does-not-exist" }, undefined),
          )
        }),
      ),
    )
    expect(parseTextResult<{ cancelled: boolean }>(result as ToolCallResult).cancelled).toBe(false)
  })

  it("schedule_cancel refuses to delete a non-scheduler jobs row (scoped) or a system id", async () => {
    const result = await Effect.runPromise(
      withScheduler(
        Effect.gen(function* () {
          const jobsStore = yield* JobsStoreService
          const [, , cancelTool] = makeSchedulerTools(jobsStore)
          // A durable job owned by something else (e.g. a suggested-action clone).
          yield* jobsStore.record({
            id: "saj-someaction",
            kind: "workflow",
            spec: "",
            payload: { label: "x", source: "suggested-action" },
          })
          const foreign = parseTextResult<{ cancelled: boolean }>(
            (yield* Effect.promise(() =>
              cancelTool.handler({ triggerId: "saj-someaction" }, undefined),
            )) as ToolCallResult,
          )
          const survived = yield* jobsStore.getById("saj-someaction")
          const sys = parseTextResult<{ cancelled: boolean }>(
            (yield* Effect.promise(() =>
              cancelTool.handler({ triggerId: "system:wake" }, undefined),
            )) as ToolCallResult,
          )
          return { foreign, survived, sys }
        }),
      ),
    )
    // The foreign row is NOT deleted, and the tool reports cancelled:false.
    expect(result.foreign.cancelled).toBe(false)
    expect(result.survived).not.toBeNull()
    expect(result.sys.cancelled).toBe(false)
  })

  it("schedule_list/cancel handle LEGACY kind:'cron' scheduler rows (upgrade continuity)", async () => {
    const result = await Effect.runPromise(
      withScheduler(
        Effect.gen(function* () {
          const jobsStore = yield* JobsStoreService
          const [, listTool, cancelTool] = makeSchedulerTools(jobsStore)
          // A legacy V1 row as the old scheduler-tools persisted it (kind:"cron").
          yield* jobsStore.record({
            id: "trigger-legacy-1",
            kind: "cron",
            spec: "0 9 * * 1",
            payload: { label: "old", source: "scheduler-tools" },
          })
          yield* jobsStore.setV2Fields("trigger-legacy-1", { enabled: false })
          const listed = parseTextResult<{
            triggers: Array<{ triggerId: string; expr: string | null; cancellable: boolean }>
          }>((yield* Effect.promise(() => listTool.handler({}, undefined))) as ToolCallResult)
          const cancelled = parseTextResult<{ cancelled: boolean }>(
            (yield* Effect.promise(() =>
              cancelTool.handler({ triggerId: "trigger-legacy-1" }, undefined),
            )) as ToolCallResult,
          )
          const gone = yield* jobsStore.getById("trigger-legacy-1")
          return { listed, cancelled, gone }
        }),
      ),
    )
    const entry = result.listed.triggers.find((t) => t.triggerId === "trigger-legacy-1")
    expect(entry).toBeDefined() // visible, not stranded
    expect(entry?.expr).toBe("0 9 * * 1")
    expect(entry?.cancellable).toBe(true)
    expect(result.cancelled.cancelled).toBe(true) // and removable
    expect(result.gone).toBeNull()
  })

  it("schedule_list reports each agent schedule's enabled flag (quarantined → enabled:false)", async () => {
    const result = await Effect.runPromise(
      withScheduler(
        Effect.gen(function* () {
          const jobsStore = yield* JobsStoreService
          const [createTool, listTool] = makeSchedulerTools(jobsStore)
          const created = parseTextResult<{ triggerId: string }>(
            (yield* Effect.promise(() =>
              createTool.handler({ expr: "0 9 * * 1", prompt: "standup", label: "s" }, undefined),
            )) as ToolCallResult,
          )
          const beforeList = parseTextResult<{ triggers: Array<{ enabled: boolean }> }>(
            (yield* Effect.promise(() => listTool.handler({}, undefined))) as ToolCallResult,
          )
          // Simulate the ticker quarantining it.
          yield* jobsStore.setV2Fields(created.triggerId, { enabled: false })
          const afterList = parseTextResult<{ triggers: Array<{ triggerId: string; enabled: boolean }> }>(
            (yield* Effect.promise(() => listTool.handler({}, undefined))) as ToolCallResult,
          )
          return { beforeList, afterList, id: created.triggerId }
        }),
      ),
    )
    expect(result.beforeList.triggers[0]!.enabled).toBe(true)
    const after = result.afterList.triggers.find((t) => t.triggerId === result.id)
    expect(after?.enabled).toBe(false)
  })
})
