/**
 * SchedulerToolsLayer + helpers.
 *
 * Wires the three scheduler tools (schedule_create / schedule_list /
 * schedule_cancel) onto a live TriggerAgent + JobScheduler + JobsStore and
 * packages them as an SDK MCP server config that can be plugged into
 * `SessionOptions.sdkOptions.mcpServers`.
 *
 * The Layer's own Scope is threaded into makeSchedulerTools so cron trigger
 * fibers outlive individual tool calls and run for the full session lifetime.
 * When the Layer Scope closes (process exit / session teardown), the
 * TriggerAgent's supervised fibers are interrupted via the normal Effect
 * cascade (§3.4 #4); the persisted `jobs` rows remain so the next boot can
 * re-register them.
 *
 * Boot-reload (the key durability behavior): after the JobsStore and
 * TriggerAgent are both built, the Layer reads every `jobs` row with
 * `kind = 'cron'` and re-registers the trigger BEFORE returning the
 * SchedulerToolsService. Net effect: a chat-server restart looks like a
 * zero-tick gap to any agent — fixed-point cron triggers continue firing on
 * their next match.
 *
 * Capacity / policy:
 *   - Default capacity: 32 (generous for a chat session's cron jobs).
 *   - Default offer policy: "drop-newest" — if the queue is somehow full,
 *     new submissions are rejected rather than blocking the cron loop.
 */
import { Effect, Layer } from "effect"
import * as ScopeImpl from "effect/Scope"
import type * as Scope from "effect/Scope"
import {
  Clock,
  JobSchedulerLayer,
  JobsStoreService,
  TriggerAgent,
  TriggerAgentLayer,
  type JobsStoreApi,
  type TriggerAgentApi,
} from "@luna/core"
import { makeSdkMcpServer } from "@luna/tools"
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"
import { makeSchedulerTools } from "./tools.js"

/**
 * SchedulerToolsConfig — emitted by SchedulerToolsLayer, carries the SDK MCP
 * server config the chat dev rig (or any caller) splats into
 * `sdkOptions.mcpServers`.
 */
export interface SchedulerToolsSessionConfig {
  readonly serverName: "scheduler"
  readonly server: McpSdkServerConfigWithInstance
  /** The system-prompt addendum the agent needs to know the tools exist. */
  readonly systemPromptAddendum: string
}

export interface SchedulerToolsConfig extends SchedulerToolsSessionConfig {
  readonly createSessionBinding: () => SchedulerToolsSessionConfig
}

export class SchedulerToolsService extends Effect.Tag(
  "luna/SchedulerToolsService",
)<SchedulerToolsService, SchedulerToolsConfig>() {}

export const SCHEDULER_SYSTEM_PROMPT_ADDENDUM =
  "You have three scheduler tools on MCP server `scheduler`. Use their fully " +
  "qualified MCP tool names exactly: " +
  "`mcp__scheduler__schedule_create(expr, label?)` to register a recurring cron job " +
  "(standard 5-field cron syntax, e.g. '0 9 * * 1' for every Monday at 9am), " +
  "`mcp__scheduler__schedule_list()` to see all active schedules, and " +
  "`mcp__scheduler__schedule_cancel(triggerId)` to stop a schedule. " +
  "Do not call bare tool names such as `schedule_create`; use the `mcp__scheduler__...` " +
  "names. " +
  "Use these when the user asks you to do something on a recurring schedule. " +
  "Cron schedules are PERSISTED to luna.db (jobs table per DESIGN.md §5.1) " +
  "and re-registered at chat-server boot, so they survive restarts. " +
  "schedule_cancel removes the row, so a cancelled schedule does NOT come back."

export interface SchedulerToolsLayerOptions {
  /** Maximum concurrent jobs in the pool. Default: 32. */
  readonly capacity?: number
  /**
   * Backpressure policy when the pool is full.
   * Default: "drop-newest" — new cron submissions are rejected rather than
   * blocking the trigger loop.
   */
  readonly offerPolicy?: "block" | "drop-newest" | "drop-oldest"
}

/**
 * Build the MCP server config exposing the three scheduler tools, given a
 * resolved TriggerAgentApi, the layer-owned Scope, and a JobsStoreApi for
 * durable persistence.
 */
export const buildSchedulerMcpServer = (
  trigger: TriggerAgentApi,
  layerScope: Scope.Scope,
  jobsStore: JobsStoreApi,
): McpSdkServerConfigWithInstance => {
  const tools = makeSchedulerTools(
    trigger,
    layerScope,
    jobsStore,
  ) as unknown as ReadonlyArray<SdkMcpToolDefinition<AnyZodRawShape>>
  return makeSdkMcpServer("scheduler", "0.1.0", tools)
}

/**
 * Boot-reload: replay every persisted cron job into TriggerAgent so the
 * fiber-set for live triggers mirrors what the `jobs` table says should be
 * running. Failures are logged but never block boot — a malformed row is
 * isolated, the rest still come back.
 */
const reloadPersistedCrons = (
  trigger: TriggerAgentApi,
  layerScope: Scope.Scope,
  jobsStore: JobsStoreApi,
) =>
  Effect.gen(function* () {
    const rows = yield* jobsStore.listAll().pipe(
      Effect.catchAll((cause) => {
        console.warn("[scheduler/boot] could not list persisted jobs:", cause)
        return Effect.succeed([] as const)
      }),
    )
    let reloaded = 0
    let dropped = 0
    for (const row of rows) {
      if (row.kind !== "cron") continue
      const label = row.payload.label ?? "scheduled-job"
      const expr = row.spec
      const persistedId = row.id

      // Register into the layer scope. We deliberately let TriggerAgent
      // generate a fresh runtime triggerId rather than smuggling the
      // persisted id back in — the public API doesn't expose id forcing,
      // and the persisted id was only ever a handle for cancel(). On boot
      // we delete the old row and write a fresh one keyed by the new
      // runtime id so subsequent cancels work correctly.
      const result = yield* Effect.either(
        ScopeImpl.extend(layerScope)(
          trigger.register({
            kind: "cron",
            expr,
            build: () => ({
              id: `${label}-${Date.now()}`,
              run: Effect.succeed(`${label} tick`),
            }),
          }),
        ),
      )
      if (result._tag === "Left") {
        console.warn(
          `[scheduler/boot] failed to reload cron ${persistedId} (${expr}):`,
          result.left,
        )
        dropped++
        continue
      }
      const newId = result.right
      // Replace the row: remove old, record new keyed by the runtime id.
      yield* Effect.ignore(jobsStore.remove(persistedId))
      yield* Effect.ignore(
        jobsStore.record({
          id: newId,
          kind: "cron",
          spec: expr,
          payload: { label, source: row.payload.source ?? "scheduler-tools" },
        }),
      )
      // Opt the reloaded V1 cron row out of the V2 JobTicker. See the
      // matching comment in tools.ts schedule_create handler + issue #58.
      yield* Effect.ignore(jobsStore.setV2Fields(newId, { enabled: false }))
      reloaded++
    }
    if (reloaded > 0 || dropped > 0) {
      console.log(
        `[scheduler/boot] reloaded ${reloaded} persisted cron schedule(s)` +
          (dropped > 0 ? `, dropped ${dropped} malformed row(s)` : ""),
      )
    }
  })

/**
 * SchedulerToolsLayer — top-level Layer factory the dev rig wires in.
 * Provides `SchedulerToolsService` carrying the SDK MCP server config and a
 * system-prompt addendum string.
 *
 * Requires JobsStoreService from the surrounding Layer graph. The chat-server
 * provides `JobsStoreService.makeLayer(lunaDbPath)`; tests can substitute
 * `JobsStoreService.Memory`.
 *
 * Internally composes: Clock → JobScheduler → TriggerAgent → MCP server.
 */
export const SchedulerToolsLayer = (
  opts?: SchedulerToolsLayerOptions,
): Layer.Layer<SchedulerToolsService, never, JobsStoreService> =>
  Layer.scoped(
    SchedulerToolsService,
    Effect.gen(function* () {
      const trigger = yield* TriggerAgent
      const jobsStore = yield* JobsStoreService
      // Capture the Layer's own Scope so trigger registrations outlive calls.
      const layerScope = yield* Effect.scope
      // Boot-reload before exposing the MCP server. Any failures inside
      // reloadPersistedCrons are swallowed — boot must not fail because one
      // row in jobs is malformed.
      yield* reloadPersistedCrons(trigger, layerScope, jobsStore)
      const createConfig = (): SchedulerToolsSessionConfig => ({
        serverName: "scheduler" as const,
        server: buildSchedulerMcpServer(trigger, layerScope, jobsStore),
        systemPromptAddendum: SCHEDULER_SYSTEM_PROMPT_ADDENDUM,
      })
      const config = createConfig()
      return {
        ...config,
        createSessionBinding: createConfig,
      }
    }),
  ).pipe(
    Layer.provide(TriggerAgentLayer.Default),
    Layer.provide(
      JobSchedulerLayer.make({
        capacity: opts?.capacity ?? 32,
        offerPolicy: opts?.offerPolicy ?? "drop-newest",
      }),
    ),
    Layer.provide(Clock.Default),
  )
