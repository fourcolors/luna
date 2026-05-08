/**
 * Scheduler tools — three SDK MCP tool definitions exposed to the chat agent:
 *
 *   - schedule_create(kind, expr, label?) → { triggerId, expr, registeredAt }
 *   - schedule_list()                     → { triggers: TriggerSummary[] }
 *   - schedule_cancel(triggerId)          → { cancelled: boolean }
 *
 * Implementation routes through TriggerAgentApi + a long-lived Scope — both
 * are resolved by SchedulerToolsLayer before these tool definitions are built,
 * so the handlers are self-contained at the SDK boundary (no Effect requirements
 * beyond what's closed over).
 *
 * Scope note: schedule_create extends each trigger registration into the
 * Layer-owned Scope so cron fibers live for the full session lifetime, not just
 * the instant of the tool call. schedule_cancel explicitly interrupts a fiber
 * early. When the Layer Scope closes (process exit / session teardown), all
 * remaining triggers are interrupted.
 *
 * Persistence across restarts is out of scope for v1 (DESIGN.md §5.1 jobs
 * table is a future phase).
 */
import { Effect } from "effect"
import * as ScopeImpl from "effect/Scope"
import type * as Scope from "effect/Scope"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import type { TriggerAgentApi } from "@luna/core"

const createShape = {
  expr: z
    .string()
    .min(1)
    .describe(
      "Standard 5-field cron expression (e.g. '0 9 * * 1' for every Monday at 9am).",
    ),
  label: z
    .string()
    .optional()
    .describe(
      "Optional human-readable label for this schedule (used as job id prefix).",
    ),
}

const listShape = {}

const cancelShape = {
  triggerId: z
    .string()
    .min(1)
    .describe("The triggerId returned by schedule_create."),
}

/**
 * Build the three scheduler tools bound to a resolved TriggerAgentApi and a
 * long-lived Layer Scope.
 *
 * The `layerScope` parameter is the SchedulerToolsLayer's own Scope — cron
 * trigger fibers are extended into it so they survive beyond the individual
 * tool-call invocation.
 *
 * Handlers have no Effect requirements — everything is closed over so the
 * definitions are self-contained at the SDK Promise boundary.
 */
export const makeSchedulerTools = (
  trigger: TriggerAgentApi,
  layerScope: Scope.Scope,
) => {
  const create = defineTool({
    name: "schedule_create",
    description:
      "Register a recurring cron schedule. The agent will submit a new job " +
      "on each cron tick for as long as the session is active. Returns a " +
      "triggerId you can pass to schedule_cancel to stop it. " +
      "Use standard 5-field cron syntax: minute hour day-of-month month day-of-week.",
    inputSchema: createShape,
    handler: (args) =>
      Effect.gen(function* () {
        const label = args.label ?? "scheduled-job"
        // Extend the trigger registration into the layer-owned Scope so the
        // cron fiber outlives this tool call. ScopeImpl.extend(layerScope)
        // provides the scope without closing it when the effect resolves.
        const triggerId = yield* ScopeImpl.extend(layerScope)(
          trigger.register({
            kind: "cron",
            expr: args.expr,
            build: () => ({
              id: `${label}-${Date.now()}`,
              run: Effect.succeed(`${label} tick`),
            }),
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ToolError({
                tool: "schedule_create",
                op: "register",
                cause,
              }),
          ),
        )
        // Retrieve the summary to return registeredAt.
        const summaries = yield* trigger.list
        const summary = summaries.find((s) => s.id === triggerId)
        return {
          triggerId,
          expr: args.expr,
          registeredAt: summary?.registeredAt ?? new Date().toISOString(),
        } as const
      }),
  })

  const list = defineTool({
    name: "schedule_list",
    description:
      "List all currently active schedules. Returns an array of trigger " +
      "summaries including their id, cron expression, and registration time.",
    inputSchema: listShape,
    handler: (_args) =>
      Effect.gen(function* () {
        const triggers = yield* trigger.list
        return {
          triggers: triggers.map((t) => ({
            triggerId: t.id,
            kind: t.kind,
            expr: t.expr ?? null,
            registeredAt: t.registeredAt,
          })),
        } as const
      }),
  })

  const cancel = defineTool({
    name: "schedule_cancel",
    description:
      "Cancel an active schedule by its triggerId. Returns { cancelled: true } " +
      "if the trigger was found and stopped, { cancelled: false } if not found.",
    inputSchema: cancelShape,
    handler: (args) =>
      Effect.gen(function* () {
        const cancelled = yield* trigger.cancel(args.triggerId)
        return { cancelled } as const
      }),
  })

  return [create, list, cancel] as const
}
