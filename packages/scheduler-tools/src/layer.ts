/**
 * SchedulerToolsLayer + helpers.
 *
 * Wires the three scheduler tools (schedule_create / schedule_list /
 * schedule_cancel) onto a live `JobsStore` and packages them as an SDK MCP
 * server config that can be plugged into `SessionOptions.sdkOptions.mcpServers`.
 *
 * V2-native: a schedule is a durable RECURRING `kind:"prompt"` row in the
 * `jobs` table. The V2 JobTicker (on by default; LUNA_SCHEDULER_V2_ENABLED=0
 * disables) reads the table every tick and re-fires the row, running the
 * PromptWorker which delivers the turn's result to the operator as an obs_note.
 * There is no in-process fiber to register and nothing to reload at boot — the
 * jobs table IS the durable state, so a restart looks like a zero-tick gap.
 *
 * (Earlier versions registered a V1 TriggerAgent cron whose fire was a no-op;
 * that delivered nothing. The ticker is now the single scheduler for these.)
 */
import { Effect, Layer } from "effect"
import { JobsStoreService, type JobsStoreApi } from "@luna/core"
import { makeSdkMcpServer } from "@luna/tools"
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"
import { makeSchedulerTools } from "./tools.js"
import type { SystemSchedule } from "./tools.js"

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
  "`mcp__scheduler__schedule_create(expr, prompt, label?)` to register a recurring " +
  "schedule (standard 5-field cron syntax, e.g. '0 9 * * 1' for every Monday at 9am). " +
  "IMPORTANT: cron times are interpreted in UTC, not the user's local timezone. " +
  "'0 9 * * 1' fires at 09:00 UTC. If the user asks for a local time, convert it " +
  "to UTC first (UTC has no daylight-saving shifts). The `prompt` is what you " +
  "will autonomously do on each fire — its result is delivered to the operator as " +
  "a note. " +
  "`mcp__scheduler__schedule_list()` shows all active schedules (yours plus read-only " +
  "system schedules like wake/dream), and " +
  "`mcp__scheduler__schedule_cancel(triggerId)` stops one of yours. " +
  "Do not call bare tool names such as `schedule_create`; use the `mcp__scheduler__...` " +
  "names. Use these when the user asks you to do something on a recurring schedule. " +
  "Schedules are PERSISTED to luna.db and survive restarts; schedule_cancel removes " +
  "the row, so a cancelled schedule does NOT come back."

export interface SchedulerToolsLayerOptions {
  /**
   * Read-only system schedules (e.g. wake/dream) surfaced by schedule_list so
   * the operator sees the whole picture. These cannot be cancelled via
   * schedule_cancel. Default: none.
   */
  readonly systemSchedules?: ReadonlyArray<SystemSchedule>
}

/**
 * Build the MCP server config exposing the three scheduler tools, given a
 * resolved JobsStoreApi and optional read-only system schedules.
 */
export const buildSchedulerMcpServer = (
  jobsStore: JobsStoreApi,
  systemSchedules: ReadonlyArray<SystemSchedule> = [],
): McpSdkServerConfigWithInstance => {
  const tools = makeSchedulerTools(
    jobsStore,
    systemSchedules,
  ) as unknown as ReadonlyArray<SdkMcpToolDefinition<AnyZodRawShape>>
  return makeSdkMcpServer("scheduler", "0.1.0", tools)
}

/**
 * SchedulerToolsLayer — top-level Layer factory the dev rig wires in.
 * Provides `SchedulerToolsService` carrying the SDK MCP server config and a
 * system-prompt addendum string.
 *
 * Requires JobsStoreService from the surrounding Layer graph. The chat-server
 * provides `JobsStoreService.makeLayer(lunaDbPath)`; tests can substitute
 * `JobsStoreService.Memory`.
 */
export const SchedulerToolsLayer = (
  opts?: SchedulerToolsLayerOptions,
): Layer.Layer<SchedulerToolsService, never, JobsStoreService> =>
  Layer.effect(
    SchedulerToolsService,
    Effect.gen(function* () {
      const jobsStore = yield* JobsStoreService
      const systemSchedules = opts?.systemSchedules ?? []
      const createConfig = (): SchedulerToolsSessionConfig => ({
        serverName: "scheduler" as const,
        server: buildSchedulerMcpServer(jobsStore, systemSchedules),
        systemPromptAddendum: SCHEDULER_SYSTEM_PROMPT_ADDENDUM,
      })
      const config = createConfig()
      return {
        ...config,
        createSessionBinding: createConfig,
      }
    }),
  )
