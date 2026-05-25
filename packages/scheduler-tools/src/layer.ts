/**
 * SchedulerToolsLayer + helpers.
 *
 * Wires the three scheduler tools (schedule_create / schedule_list /
 * schedule_cancel) onto a live TriggerAgent + JobScheduler and packages them
 * as an SDK MCP server config that can be plugged into
 * `SessionOptions.sdkOptions.mcpServers`.
 *
 * The Layer's own Scope is threaded into makeSchedulerTools so cron trigger
 * fibers outlive individual tool calls and run for the full session lifetime.
 * When the Layer Scope closes, the TriggerAgent's supervised fibers are all
 * interrupted via the normal Effect cascade (§3.4 #4).
 *
 * Capacity / policy:
 *   - Default capacity: 32 (generous for a chat session's cron jobs).
 *   - Default offer policy: "drop-newest" — if the queue is somehow full,
 *     new submissions are rejected rather than blocking the cron loop.
 */
import { Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import {
  Clock,
  JobSchedulerLayer,
  TriggerAgent,
  TriggerAgentLayer,
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
export interface SchedulerToolsConfig {
  readonly serverName: "scheduler"
  readonly server: McpSdkServerConfigWithInstance
  /** The system-prompt addendum the agent needs to know the tools exist. */
  readonly systemPromptAddendum: string
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
  "Schedules persist for the session but do not survive process restarts."

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
 * resolved TriggerAgentApi and the layer-owned Scope.
 */
export const buildSchedulerMcpServer = (
  trigger: TriggerAgentApi,
  layerScope: Scope.Scope,
): McpSdkServerConfigWithInstance => {
  const tools = makeSchedulerTools(trigger, layerScope) as unknown as ReadonlyArray<
    SdkMcpToolDefinition<AnyZodRawShape>
  >
  return makeSdkMcpServer("scheduler", "0.1.0", tools)
}

/**
 * SchedulerToolsLayer — top-level Layer factory the dev rig wires in.
 * Provides `SchedulerToolsService` carrying the SDK MCP server config and a
 * system-prompt addendum string.
 *
 * Internally composes: Clock → JobScheduler → TriggerAgent → MCP server.
 */
export const SchedulerToolsLayer = (
  opts?: SchedulerToolsLayerOptions,
): Layer.Layer<SchedulerToolsService> =>
  Layer.scoped(
    SchedulerToolsService,
    Effect.gen(function* () {
      const trigger = yield* TriggerAgent
      // Capture the Layer's own Scope so trigger registrations outlive calls.
      const layerScope = yield* Effect.scope
      const server = buildSchedulerMcpServer(trigger, layerScope)
      return {
        serverName: "scheduler" as const,
        server,
        systemPromptAddendum: SCHEDULER_SYSTEM_PROMPT_ADDENDUM,
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
