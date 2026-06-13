/**
 * Scheduler tools — three SDK MCP tool definitions exposed to the chat agent:
 *
 *   - schedule_create(expr, prompt, label?) → { triggerId, expr, registeredAt }
 *   - schedule_list()                       → { triggers: [...] }
 *   - schedule_cancel(triggerId)            → { cancelled: boolean }
 *
 * V2-native: a schedule is a durable RECURRING `kind:"prompt"` row in the
 * `jobs` table. The V2 JobTicker (on by default) re-fires it on each cron tick
 * and runs the PromptWorker, which executes the agent-authored `user_prompt`
 * and delivers the result to the operator as an obs_note. So a schedule
 * actually DOES something on fire (it used to fire a no-op).
 *
 * Persistence is automatic: the row lives in `jobs`, and the ticker reads the
 * table every tick — there is nothing to re-register at boot. schedule_cancel
 * deletes the row so it stops firing and does not come back.
 *
 * Note: on a LUNA_SCHEDULER_V2_ENABLED=0 deploy (the kill switch) the ticker is
 * not running, so the row persists but does not fire until V2 is re-enabled —
 * the schedule is captured durably either way.
 */
import { Cron, Effect, Either } from "effect"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import type { JobsStoreApi } from "@luna/core"

/**
 * A read-only "system" schedule (e.g. the wake / dream cycles) surfaced by
 * schedule_list so the operator sees the WHOLE schedule picture, not just the
 * agent-created crons. These are managed elsewhere and cannot be cancelled via
 * schedule_cancel.
 */
export interface SystemSchedule {
  readonly label: string
  readonly expr: string
}

/** Exactly 5 whitespace-separated fields (minute hour dom month dow). */
const isFiveFieldCron = (expr: string): boolean =>
  expr.trim().split(/\s+/).filter(Boolean).length === 5

/**
 * Next fire time for a 5-field cron, in UTC. Returns null when the expression
 * is unparseable OR has no upcoming match (so the caller can reject it instead
 * of persisting a schedule that never fires). Pins to UTC to match the ticker.
 */
const nextRunAtUtc = (expr: string): number | null => {
  const parsed = Cron.parse(expr, "UTC")
  if (Either.isLeft(parsed)) return null
  try {
    return Cron.next(parsed.right, new Date()).getTime()
  } catch {
    return null
  }
}

// Effectively-unique id: a ms timestamp (monotonic across restarts) + a random
// suffix, mirroring JobScheduler.genId. A process-local counter would reset on
// restart and could collide with an already-persisted schedule — record()
// rejects duplicate ids, so that would make schedule_create fail nondeterministically.
const nextScheduleId = (): string =>
  `sched-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

const createShape = {
  expr: z
    .string()
    .min(1)
    .refine(isFiveFieldCron, {
      message:
        "cron must have exactly 5 fields (minute hour day-of-month month day-of-week); " +
        "6-field syntax with a leading seconds field is not supported.",
    })
    .describe(
      "Standard 5-field cron expression (e.g. '0 9 * * 1' for every Monday at 9am). UTC.",
    ),
  prompt: z
    .string()
    .min(1)
    .describe(
      "What Luna should DO each time the schedule fires, as an instruction to " +
        "an autonomous agent turn (e.g. 'Remind me to review the deploy checklist'). " +
        "The result is delivered to the operator as a note.",
    ),
  label: z
    .string()
    .optional()
    .describe("Optional human-readable label for this schedule."),
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
 * Build the three scheduler tools bound to a `JobsStoreApi`. The handlers have
 * no Effect requirements — everything is closed over so the definitions are
 * self-contained at the SDK Promise boundary.
 *
 * `systemSchedules` are read-only entries (wake/dream) surfaced by
 * schedule_list alongside the agent-created schedules.
 */
export const makeSchedulerTools = (
  jobsStore: JobsStoreApi,
  systemSchedules: ReadonlyArray<SystemSchedule> = [],
) => {
  const create = defineTool({
    name: "schedule_create",
    description:
      "Register a recurring schedule. On each cron tick Luna runs an autonomous " +
      "agent turn driven by your `prompt` and delivers the result to the operator " +
      "as a note. Schedules are durable across restarts (persisted in luna.db). " +
      "Returns a triggerId you pass to schedule_cancel to stop it. Use standard " +
      "5-field cron syntax interpreted in UTC: minute hour day-of-month month day-of-week.",
    inputSchema: createShape,
    ...SCHEDULER_TOOL_DISCOVERY,
    handler: (args) =>
      Effect.gen(function* () {
        // Defend the handler boundary (tests + non-SDK callers bypass the zod
        // refine): Effect's Cron.parse silently accepts a 6-field expression,
        // so "*/5 * * * * *" would mean every 5 SECONDS. Require exactly 5.
        if (!isFiveFieldCron(args.expr)) {
          const fieldCount = args.expr.trim().split(/\s+/).filter(Boolean).length
          return yield* Effect.fail(
            new ToolError({
              tool: "schedule_create",
              op: "validate",
              cause:
                `cron must have exactly 5 fields (minute hour day-of-month month ` +
                `day-of-week); got ${fieldCount}. 6-field syntax with a seconds ` +
                `field is not supported.`,
            }),
          )
        }

        // Reject an unparseable / never-matching cron up front rather than
        // persisting a schedule that can never fire.
        const firstRunAt = nextRunAtUtc(args.expr)
        if (firstRunAt === null) {
          return yield* Effect.fail(
            new ToolError({
              tool: "schedule_create",
              op: "validate",
              cause: `cron "${args.expr}" is invalid or has no upcoming match`,
            }),
          )
        }

        const label = args.label ?? "scheduled-job"
        const id = nextScheduleId()

        // Durable RECURRING prompt job — the V2 ticker re-fires it each tick
        // (spec is non-empty, so it is NOT a one-shot) and the PromptWorker
        // delivers the turn's result to the operator as an obs_note.
        const job = yield* jobsStore
          .record({
            id,
            kind: "prompt",
            spec: args.expr,
            payload: {
              label,
              source: "scheduler-tools",
              user_prompt: args.prompt,
              deliver_to: { kind: "obs_note", kind_tag: "reminder" },
            },
            enabled: true,
            nextRunAt: firstRunAt,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ToolError({ tool: "schedule_create", op: "persist", cause }),
            ),
          )

        return {
          triggerId: id,
          expr: args.expr,
          registeredAt: new Date(job.createdAt).toISOString(),
        } as const
      }),
  })

  const list = defineTool({
    name: "schedule_list",
    description:
      "List active schedules. Includes the schedules you created with " +
      "schedule_create (cancellable: true) AND read-only system schedules such " +
      "as the wake/dream cycles (cancellable: false — managed elsewhere). Each " +
      "entry reports its id, cron expression (UTC), source ('agent' | 'system'), " +
      "and whether it is cancellable.",
    inputSchema: listShape,
    ...SCHEDULER_TOOL_DISCOVERY,
    handler: (_args) =>
      Effect.gen(function* () {
        const rows = yield* jobsStore
          .listAll()
          .pipe(
            Effect.mapError(
              (cause) =>
                new ToolError({ tool: "schedule_list", op: "list", cause }),
            ),
          )
        const agentEntries = rows
          .filter(
            // kind:"prompt" = current V2 schedules; kind:"cron" = LEGACY rows
            // persisted by the old V1 scheduler-tools (now no-ops). Surface both
            // so post-upgrade legacy schedules stay visible + cancellable rather
            // than stranded invisibly in the jobs table.
            (r) =>
              (r.kind === "prompt" || r.kind === "cron") &&
              r.payload.source === "scheduler-tools",
          )
          .map((r) => ({
            triggerId: r.id,
            kind: "cron" as const,
            expr: r.schedule ?? r.spec,
            registeredAt: new Date(r.createdAt).toISOString(),
            source: "agent" as const,
            cancellable: true as const,
            // `enabled: false` means the ticker quarantined it (e.g. its cron
            // later proved unschedulable) — it persists but no longer fires.
            enabled: r.enabled,
          }))
        const systemEntries = systemSchedules.map((s) => ({
          triggerId: `system:${s.label}`,
          kind: "cron" as const,
          expr: s.expr,
          registeredAt: null,
          source: "system" as const,
          cancellable: false as const,
          enabled: true as const,
        }))
        return { triggers: [...agentEntries, ...systemEntries] } as const
      }),
  })

  const cancel = defineTool({
    name: "schedule_cancel",
    description:
      "Cancel an active schedule by its triggerId. Deletes the persisted row so " +
      "it stops firing and does not come back. Returns { cancelled: true } if a " +
      "schedule was removed, { cancelled: false } if not found. System schedules " +
      "(source 'system') cannot be cancelled here.",
    inputSchema: cancelShape,
    ...SCHEDULER_TOOL_DISCOVERY,
    handler: (args) =>
      Effect.gen(function* () {
        // Scope the delete to agent-created scheduler rows ONLY. Without this
        // guard, schedule_cancel would DELETE any jobs row by id — e.g. a saved
        // kind:"workflow" job or a suggested-action one-shot keyed saj-<id> —
        // silently destroying durable state it does not own and reporting
        // {cancelled:true}. System schedules (system:* ids) are read-only here.
        if (args.triggerId.startsWith("system:")) {
          return { cancelled: false } as const
        }
        const row = yield* jobsStore
          .getById(args.triggerId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ToolError({ tool: "schedule_cancel", op: "lookup", cause }),
            ),
          )
        if (
          !row ||
          (row.kind !== "prompt" && row.kind !== "cron") ||
          row.payload.source !== "scheduler-tools"
        ) {
          return { cancelled: false } as const
        }
        const cancelled = yield* jobsStore
          .remove(args.triggerId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ToolError({ tool: "schedule_cancel", op: "delete", cause }),
            ),
          )
        return { cancelled } as const
      }),
  })

  return [create, list, cancel] as const
}
