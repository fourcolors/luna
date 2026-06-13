/**
 * AcceptHandler — turns an ACCEPTED suggested action into a durable, one-shot
 * background job (the auto-execute path, locked decision #4 + #2).
 *
 * Every action type lands on the SAME durable substrate — a `jobs` row picked
 * up by the V2 JobTicker (requires LUNA_SCHEDULER_V2_ENABLED=1). The four
 * "subagent" types (task / research / create_skill / create_workflow) become a
 * `kind:'prompt'` job that spawns a subagent driven by the agent-authored
 * prompt; `run_workflow` clones an EXISTING saved `kind:'workflow'` job into a
 * fresh one-shot (so the saved job is never mutated). Jobs are created with an
 * EMPTY schedule so the ticker fires them exactly once (see the one-shot guard
 * in job-ticker.ts — an empty-schedule job is disabled after its single claim).
 *
 * This module also forks the COMPLETION OBSERVER: the durable jobs path has no
 * push-notify, so a background fiber polls `JobsStore.listRuns(executionId)`
 * for each in-progress suggestion and folds the terminal run status back onto
 * the action (→ completed | failed), which re-emits a status frame to the UI.
 */
import { Duration, Effect, Layer, Schedule } from "effect"
import { Clock } from "../clock.js"
import { JobsStoreService } from "../jobs/jobs-store.js"
import type { JobKind } from "../jobs/jobs-store-types.js"
import { AcceptHandler, SuggestedActions } from "./suggested-actions.js"
import type { AcceptHandlerApi } from "./suggested-actions.js"
import { SuggestedActionsError } from "./types.js"
import type {
  PromptActionPayload,
  RunWorkflowPayload,
  SuggestedActionRow,
} from "./types.js"

/** Default completion-poll cadence (no push-notify on the durable jobs path). */
const DEFAULT_POLL_INTERVAL = Duration.seconds(10)

/** A jobs-store `record()` input minus the caller-supplied id. */
export interface JobRecordSpec {
  readonly kind: JobKind
  readonly spec: string
  readonly payload: { readonly label: string; readonly source?: string } & Record<
    string,
    unknown
  >
}

/** Short per-type framing prepended to the agent-authored prompt. */
const PROMPT_PREFACE: Record<string, string> = {
  task: "",
  research: "Research task — investigate thoroughly and report findings.",
  create_skill:
    "Create a new Luna skill: author a SKILL.md under ~/.luna/skills/<slug>/ " +
    "following the skill format. It will be registered DISABLED (quarantined) " +
    "until the operator enables it.",
  create_workflow:
    "Create and work through a workflow to accomplish the following.",
}

/** The durable execution id for an accepted action (deterministic). */
export const executionIdFor = (actionId: string): string => `saj-${actionId}`

/**
 * Pure builder: a prompt-style action → a one-shot `kind:'prompt'` job spec.
 * Exported for tests (mirrors prompt-worker's `parsePromptPayload` test seam).
 * `spec` is empty → the ticker fires it exactly once. NOTE: no `permission_mode`
 * is set, so the spawned subagent uses the prompt-worker's default posture
 * (destructive sub-tools still hit `canUseTool`); the payload cannot grant
 * bypass.
 */
export const buildPromptJobSpec = (row: SuggestedActionRow): JobRecordSpec => {
  const payload = row.payload as PromptActionPayload
  const preface = PROMPT_PREFACE[row.actionType] ?? ""
  const userPrompt = preface ? `${preface}\n\n${payload.prompt}` : payload.prompt
  return {
    kind: "prompt",
    spec: "",
    payload: {
      label: row.title,
      source: "suggested-action",
      user_prompt: userPrompt,
      ...(payload.allowedTools && payload.allowedTools.length > 0
        ? { allowed_tools: [...payload.allowedTools] }
        : {}),
      ...(payload.model ? { model: payload.model } : {}),
    },
  }
}

export interface AcceptHandlerOptions {
  /** Completion-poll cadence. Default 10s. */
  readonly pollInterval?: Duration.DurationInput
}

/**
 * AcceptHandler layer + forked completion observer. Requires the durable
 * JobsStore + the SuggestedActions service + Clock. Wire it alongside
 * SuggestedActions in the boot graph so `respond({decision:'accept'})`
 * auto-executes.
 */
export const AcceptHandlerLayer = (
  options?: AcceptHandlerOptions,
): Layer.Layer<
  AcceptHandler,
  never,
  JobsStoreService | SuggestedActions | Clock
> => {
  const pollInterval = options?.pollInterval ?? DEFAULT_POLL_INTERVAL
  return Layer.scoped(
    AcceptHandler,
    Effect.gen(function* () {
      const jobs = yield* JobsStoreService
      const sa = yield* SuggestedActions
      const clock = yield* Clock

      const toErr = (op: string) => (cause: unknown) =>
        new SuggestedActionsError({
          op,
          message: `accept ${op} failed: ${String(cause)}`,
          cause,
        })

      const accept: (row: SuggestedActionRow) => Effect.Effect<void, SuggestedActionsError> = (
        row,
      ) =>
        Effect.gen(function* () {
          const jobId = executionIdFor(row.id)
          const now = yield* clock.nowMs()

          if (row.actionType === "run_workflow") {
            const { jobId: sourceJobId } = row.payload as RunWorkflowPayload
            const existing = yield* jobs
              .getById(sourceJobId)
              .pipe(Effect.mapError(toErr("lookup")))
            if (!existing || existing.kind !== "workflow") {
              return yield* Effect.fail(
                new SuggestedActionsError({
                  op: "accept",
                  message: `no saved workflow job "${sourceJobId}" to run`,
                }),
              )
            }
            // Clone the saved workflow's payload into a fresh one-shot — never
            // mutate the saved job.
            yield* jobs
              .record({
                id: jobId,
                kind: "workflow",
                spec: "",
                payload: {
                  ...existing.payload,
                  label: row.title,
                  source: "suggested-action",
                },
              })
              .pipe(Effect.mapError(toErr("record")))
          } else {
            const spec = buildPromptJobSpec(row)
            yield* jobs
              .record({ id: jobId, kind: spec.kind, spec: spec.spec, payload: spec.payload })
              .pipe(Effect.mapError(toErr("record")))
          }

          // Enable + make due now → the ticker dispatches it once.
          yield* jobs
            .setV2Fields(jobId, { enabled: true, nextRunAt: now })
            .pipe(Effect.mapError(toErr("enable")))

          // Link the execution; moves the action proposed→...→in_progress.
          yield* sa.recordExecution(row.id, { kind: "job", id: jobId })
        })

      // ── Completion observer ────────────────────────────────────────────────
      // Poll the durable run ledger for each in-progress suggestion and fold the
      // terminal run status back onto the action. Best-effort: any error is
      // swallowed so the loop survives.
      const pollOnce: Effect.Effect<void> = Effect.gen(function* () {
        const inProgress = yield* sa
          .listInProgress()
          .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<SuggestedActionRow>)))
        for (const row of inProgress) {
          if (!row.executionId) continue
          const runs = yield* jobs
            .listRuns(row.executionId, 1)
            .pipe(Effect.catchAll(() => Effect.succeed([])))
          const latest = runs[0]
          if (!latest || latest.finishedAt === null) continue
          if (latest.status === "success") {
            yield* sa.recordTerminal(row.id, "completed").pipe(Effect.ignore)
          } else if (latest.status === "failed" || latest.status === "cancelled") {
            yield* sa
              .recordTerminal(row.id, "failed", latest.error)
              .pipe(Effect.ignore)
          }
        }
      })

      yield* pollOnce.pipe(
        Effect.catchAllCause(() => Effect.void),
        Effect.repeat(Schedule.fixed(pollInterval)),
        Effect.forkScoped,
      )

      return { accept } satisfies AcceptHandlerApi
    }),
  )
}
