/**
 * Scheduler tools — three SDK MCP tool definitions exposed to the chat agent:
 *
 *   - schedule_create(expr, label?) → { triggerId, expr, registeredAt }
 *   - schedule_list()               → { triggers: TriggerSummary[] }
 *   - schedule_cancel(triggerId)    → { cancelled: boolean }
 *
 * Implementation routes through TriggerAgentApi + a long-lived Scope + a
 * `JobsStoreApi` (persistence ledger). Cron registrations are durable across
 * chat-server restarts: the Layer reloads every `jobs` row at boot before
 * accepting new tool calls.
 *
 * Scope note: schedule_create extends each trigger registration into the
 * Layer-owned Scope so cron fibers live for the full session lifetime, not
 * just the instant of the tool call. schedule_cancel explicitly interrupts a
 * fiber early AND deletes the row. When the Layer Scope closes (process exit
 * / session teardown), all live fibers are interrupted but the rows remain
 * for the next boot to re-register.
 *
 * Stream-kind triggers are intentionally NOT persisted — Streams cannot be
 * serialized. The agent-facing tools here only expose cron, so this is
 * consistent. Future kinds (oneshot, file-watch) will plug into the same
 * JobsStore — same `jobs` table, different `kind` discriminator.
 *
 * Boot-reload + persistence layer wiring lives in `./layer.ts`.
 */
import { Effect } from "effect"
import * as ScopeImpl from "effect/Scope"
import type * as Scope from "effect/Scope"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import type { JobsStoreApi, TriggerAgentApi } from "@luna/core"

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

const SCHEDULER_TOOL_DISCOVERY = {
  alwaysLoad: true,
  searchHint:
    "Scheduler tools for creating, listing, and cancelling recurring cron reminders and background tasks.",
} as const

/**
 * Build the three scheduler tools bound to a resolved TriggerAgentApi, a
 * long-lived Layer Scope, and a JobsStoreApi for persistence.
 *
 * `register()`'s trigger fiber is extended into `layerScope` so cron fibers
 * outlive the tool call. After successful register, the row is recorded in
 * JobsStore. If recording fails, the trigger is cancelled (best-effort) and
 * the error propagates — partial-failure rollback so the next boot doesn't
 * see a phantom fiber-less row.
 *
 * Handlers have no Effect requirements — everything is closed over so the
 * definitions are self-contained at the SDK Promise boundary.
 */
export const makeSchedulerTools = (
  trigger: TriggerAgentApi,
  layerScope: Scope.Scope,
  jobsStore: JobsStoreApi,
) => {
  const create = defineTool({
    name: "schedule_create",
    description:
      "Register a recurring cron schedule. The agent submits a new job on " +
      "each cron tick. Schedules are durable across chat-server restarts " +
      "(persisted in luna.db jobs table per DESIGN.md §5.1). Returns a " +
      "triggerId you pass to schedule_cancel to stop it. Use standard " +
      "5-field cron syntax: minute hour day-of-month month day-of-week.",
    inputSchema: createShape,
    ...SCHEDULER_TOOL_DISCOVERY,
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

        // Persist the row. On failure, roll back the registration so the
        // jobs table stays in sync with what's actually running.
        const recordResult = yield* Effect.either(
          jobsStore.record({
            id: triggerId,
            kind: "cron",
            spec: args.expr,
            payload: { label, source: "scheduler-tools" },
          }),
        )
        if (recordResult._tag === "Left") {
          // Best-effort: cancel the registered trigger so we don't have a
          // running fiber that nobody knows about. Don't bubble up cancel
          // failures — the original record error is the user-visible one.
          yield* Effect.ignore(trigger.cancel(triggerId))
          return yield* Effect.fail(
            new ToolError({
              tool: "schedule_create",
              op: "persist",
              cause: recordResult.left,
            }),
          )
        }

        // Opt this V1 cron row out of the V2 JobTicker. V1 cron rows
        // (kind="cron") have no worker in WorkerRegistry, so leaving the
        // row enabled would cause the ticker to claim it every tick and
        // write a spurious failed/unknown_kind run into job_runs. V1 cron
        // continues to fire via the in-process TriggerAgent regardless of
        // the `enabled` flag, so this is purely a V2-ticker opt-out.
        // Soft failure: if setV2Fields can't run (e.g. DB error), the V1
        // cron still works; the V2 ticker will just be noisy. See #58.
        yield* Effect.ignore(
          jobsStore.setV2Fields(triggerId, { enabled: false }),
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
    ...SCHEDULER_TOOL_DISCOVERY,
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
      "Cancel an active schedule by its triggerId. Removes the persisted " +
      "row so it does not re-register on the next chat-server boot. Returns " +
      "{ cancelled: true } if the trigger was found and stopped, " +
      "{ cancelled: false } if not found.",
    inputSchema: cancelShape,
    ...SCHEDULER_TOOL_DISCOVERY,
    handler: (args) =>
      Effect.gen(function* () {
        const cancelled = yield* trigger.cancel(args.triggerId)
        // Always attempt the row delete even if the fiber was already gone —
        // covers the case where a previous restart left a row whose fiber
        // was re-spawned under a different triggerId. Best-effort: surface
        // store errors but don't override the cancellation outcome we
        // report to the agent (the trigger cancellation is the primary
        // signal the user cares about).
        yield* Effect.ignore(jobsStore.remove(args.triggerId))
        return { cancelled } as const
      }),
  })

  return [create, list, cancel] as const
}
