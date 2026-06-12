/**
 * request_input — the job-side tool for summoning operator input mid-run
 * (widget-system.md Phase 5). Mirrors secret-tools' defineTool pattern, with
 * two deliberate differences:
 *
 *   - The answer COMES BACK to the model. It is operator input, not a
 *     secret — the whole point is to hand the reply to the job's turn. It is
 *     still never logged anywhere (bridge + server contract).
 *   - The binding is PER-RUN, not per-thread: jobs have no chat session, so
 *     `makeJobInputTools` closes over the claimed run's identity (runId /
 *     jobId / jobName) instead of a mutable session cell. The worker builds
 *     a fresh server per dispatch via the provider's `forRun`.
 *
 * Run-status choreography: the handler parks the `job_runs` row in
 * `waiting` BEFORE broadcasting (so the workflow gallery shows the run
 * needs input), and ALWAYS flips it back to `running` afterwards — answer,
 * cancel, timeout, or bridge failure alike (Effect.ensuring). A flip-back
 * that lands after the ticker already closed the run is a no-op: the
 * store's `updateRunStatus` refuses rows whose `finished_at` is set.
 *
 * DEADLINE INTERACTION (why the default wait is 5 minutes): the ticker's
 * `workerDeadline` (default 5 min) is ADVISORY ONLY — V1 never interrupts an
 * overrunning worker — so a long wait cannot be killed by it. The REAL
 * ceiling is the worker's own SDK wall-clock (`runBoundedQuery`, payload
 * `timeout_ms`, default 10 min): the wait happens INSIDE the model turn, so
 * a 5-minute wait fits the default budget with the same 2× margin the
 * secret tool gets, but a payload that lowers `timeout_ms` below the wait
 * will abort the subprocess mid-wait (the ticker then closes the run as
 * failed — the `waiting` status is overwritten by `recordRunEnd`).
 */
import { Effect } from "effect"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import type { JobInputBridge } from "@luna/ui-ws"
import type { JobRunIdentity } from "@luna/adapter-sdk"

/** How long the operator has to answer before the request resolves failed. */
export const JOB_INPUT_TIMEOUT_MS = 300_000

const JOB_INPUT_TOOL_DISCOVERY = {
  alwaysLoad: true,
  searchHint:
    "Pause this job and ask the operator a question through the Luna client " +
    "(a docked input prompt); resume with their typed answer.",
} as const

export interface JobInputToolsDeps {
  /** The ui-ws broadcast bridge — `request()` fans out and awaits the answer. */
  readonly bridge: JobInputBridge
  /**
   * Flip the run's `job_runs.status` between `running` and `waiting`.
   * Resolves `false` (never throws) when the run is already closed —
   * the caller treats that as a no-op.
   */
  readonly setRunStatus: (
    runId: number,
    status: "running" | "waiting",
  ) => Promise<boolean>
  /** Override the operator-answer timeout (tests). Default 5 minutes. */
  readonly timeoutMs?: number
}

export const makeJobInputTools = (
  deps: JobInputToolsDeps,
  run: JobRunIdentity,
) => {
  const timeoutMs = deps.timeoutMs ?? JOB_INPUT_TIMEOUT_MS
  /** Best-effort status flip — a store hiccup must never fail the tool. */
  const flip = (status: "running" | "waiting"): Effect.Effect<void> =>
    Effect.promise(() =>
      deps.setRunStatus(run.runId, status).catch(() => false),
    ).pipe(Effect.asVoid)

  const requestInput = defineTool({
    name: "request_input",
    description:
      "Pause this job and ask the operator one question. A prompt opens in " +
      "every connected Luna client; the first answer is returned to you as " +
      "`{ok:true, answer}`. While you wait, the run is marked 'waiting'. If " +
      "the operator cancels or does not answer within ~5 minutes you get " +
      "`{ok:false, message}` — continue sensibly without the input (pick a " +
      "safe default or finish with what you have). Ask at most one question " +
      "at a time, and only when the job genuinely cannot proceed without it.",
    inputSchema: {
      prompt: z
        .string()
        .min(1)
        .describe(
          "The question shown to the operator above the input field, e.g. " +
            "'Which of these three subject lines should I use?'. Include any " +
            "options inline — the operator answers with free text.",
        ),
    },
    ...JOB_INPUT_TOOL_DISCOVERY,
    handler: (args) =>
      Effect.gen(function* () {
        // Park the run in `waiting` BEFORE the broadcast so the gallery
        // reflects the state by the time a client renders the prompt.
        yield* flip("waiting")

        const outcome = yield* Effect.tryPromise({
          try: () =>
            deps.bridge.request({
              runId: run.runId,
              jobId: run.jobId,
              jobName: run.jobName,
              prompt: args.prompt,
              timeoutMs,
            }),
          catch: (cause) =>
            new ToolError({
              tool: "request_input",
              op: "job_input.request",
              cause,
            }),
        }).pipe(
          // ALWAYS resume `running` — answer, cancel, timeout, or a bridge
          // defect alike. (No-op if the ticker closed the run meanwhile.)
          Effect.ensuring(flip("running")),
        )

        // Two separate returns (not a ternary) so TS doesn't synthesize
        // `answer?: undefined` / `message?: undefined` union members, which
        // are not assignable to the JSONOutput index signature.
        if (outcome.ok) {
          return { ok: true, answer: outcome.answer } as const
        }
        return { ok: false, message: outcome.message } as const
      }),
  })

  return [requestInput] as const
}
