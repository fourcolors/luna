/**
 * feedback-job-bridge.ts — turns a triaged `ui_feedback` agent_notes row into
 * a durable, one-shot background job.
 *
 * Mirrors ../suggested-actions/accept-handler.ts's action → job bridge
 * (buildPromptJobSpec, the deterministic id, "one-shot ⇒ empty spec so the
 * V2 JobTicker fires it exactly once"), but Promise-based rather than
 * Effect-based: this bridge sits behind the curated MCP-app tool surface
 * (core-apps.ts buildCuratedAppTools), which is plain `unknown -> Promise
 * <unknown>` all the way down, so keeping this module Promise-native avoids
 * an Effect.runPromise seam at every call site. chat-server.ts adapts the
 * real (Effect-based) JobsStoreApi to FeedbackJobsDep with a thin
 * Effect.runPromise wrapper at the one place they meet.
 *
 * Flow (createJobFromFeedback):
 *   1. Look up the feedback row; fail closed (never touch the jobs store) for
 *      an unknown id or a note that isn't `kind: 'ui_feedback'` (B3) — the
 *      same WHERE-guard ui-feedback-status-store.ts's setStatus already
 *      applies, re-checked here because this bridge has its own lookup.
 *   2. Short-circuit with no write at all when the row is already linked to
 *      this exact job or has already reached a terminal status (B2) —
 *      resolved/dismissed/job-failed/wontfix feedback is never re-triggered.
 *   3. Compute the DETERMINISTIC job id (feedbackJobIdFor) and check whether
 *      it already exists. Creating a job twice for the same feedback id is
 *      idempotent (B4): a second call finds the row already recorded and
 *      skips straight to (4) without a second `jobs.record()` — this is also
 *      what makes a retry after a transient status-link failure safe (B11):
 *      the job row from the first attempt is never re-created, only the
 *      status link is retried. A record() failure is re-checked structurally
 *      (jobs.getById), never by string-matching the error (B3).
 *   4. Record the job, then link `resolvedRef` (status "queued") back onto
 *      the feedback note, preserving any existing triage notes, so the
 *      triage queue shows which job is working the report — record() must
 *      succeed before the note is touched.
 */
import type { JobRecordInputSpec } from "../jobs/jobs-store-types.js"
import { UI_FEEDBACK_SENTINEL_SESSION } from "./ui-feedback-status-store.js"
import type { FeedbackListRow } from "./ui-feedback-status-store.js"

/** Hard aggregate ceiling on the assembled `user_prompt`. `note`/`selector`
 *  are already bounded at the wire (packages/ui-ws/src/server.ts NOTE_MAX=
 *  8192 / SELECTOR_MAX=1024) but `page` is not — this is the bridge's own
 *  backstop so a pathological `page` string can never blow the prompt past a
 *  sane size regardless of what the wire layer bounds. */
export const PROMPT_MAX = 20_000

/** Default max_turns for feedback-triggered prompt jobs (mirrors
 *  DEFAULT_SUGGESTED_ACTION_MAX_TURNS in accept-handler.ts). */
const DEFAULT_MAX_TURNS = 15

/** Hard ceiling on a `sessionId` used as a deliver_to thread_id (B4) — a
 *  legacy/malformed row could in principle carry an absurdly long session
 *  id; deliver_to is omitted rather than stamping a job with a thread_id no
 *  UI will ever recognize. */
const MAX_DELIVER_TO_SESSION_LEN = 256

/** The one choke point's lookup shape: FeedbackListRow (the wire-safe
 *  feedback-list projection) plus the two fields the bridge needs that the
 *  wire projection deliberately omits — `kind` (the setStatus WHERE-guard
 *  field, so this bridge can apply the exact same "kind='ui_feedback'" check
 *  without a second query) and `sessionId` (the originating-thread field for
 *  deliver_to, B5). */
export interface FeedbackJobLookupRow extends FeedbackListRow {
  readonly kind: string
  readonly sessionId: string
}

/** A jobs-store `record()` input minus the caller-supplied id. Aliases the
 *  shared JobRecordInputSpec (jobs-store-types.ts) rather than hand-mirroring
 *  the shape a second time — accept-handler.ts's own JobRecordSpec aliases
 *  the same type. Kept under this module's existing name (not re-exported as
 *  JobRecordInputSpec) since callers/tests already import `JobRecordSpec`
 *  from here. */
export type JobRecordSpec = JobRecordInputSpec

/** The durable job id for a feedback report (deterministic — this is what
 *  makes createJobFromFeedback idempotent). Distinct prefix from
 *  executionIdFor's `saj-` (accept-handler.ts:63) so the two id spaces can
 *  never collide even though both land in the same `jobs` table. */
export const feedbackJobIdFor = (feedbackId: string): string => `fbj-${feedbackId}`

const truncate = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s)

/** Strip \r\n\t and every other C0/DEL control char before a string flows
 *  into `label` (B5) — labels surface in logs and job listings, where a
 *  raw newline/tab from end-user feedback text could otherwise fake a
 *  multi-line entry or break column-aligned output. */
const stripControlChars = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, "")

/**
 * Pure builder: a triaged feedback row → a one-shot `kind:'prompt'` job spec.
 * Exported for tests (mirrors buildPromptJobSpec's test seam in
 * accept-handler.ts). `spec` is empty → the ticker fires it exactly once.
 *
 * Every optional field (`page`/`selector`/`screenshotPath`) is only
 * interpolated when present — a null field is omitted entirely rather than
 * stringified, so a legacy/partial row can never leak a literal "null" or
 * "undefined" into the prompt (B9). Raw feedback `note` text is ALWAYS
 * embedded as inert prose, never parsed — unlike buildPromptJobSpec, which
 * trusts an agent-authored `payload.model`/`allowed_tools`, feedback text is
 * raw end-user input, so this builder never derives `model` or
 * `allowed_tools` from it (B8): those keys are simply never set here.
 */
export const buildFeedbackJobSpec = (row: FeedbackJobLookupRow): JobRecordSpec => {
  const lines: string[] = [
    "A user submitted UI feedback while using Luna. Investigate the report " +
      "and, if it describes a real bug or usability issue, fix it.",
    "",
    `Feedback: ${row.note}`,
  ]
  if (row.page) lines.push(`Page: ${row.page}`)
  if (row.selector) lines.push(`Element: ${row.selector}`)
  if (row.screenshotPath) lines.push(`Screenshot saved at: ${row.screenshotPath}`)
  const userPrompt = truncate(lines.join("\n"), PROMPT_MAX)

  const labelSource = row.note.length > 0 ? row.note : row.id
  const label = truncate(`Feedback: ${stripControlChars(labelSource)}`, 120)

  // deliver_to stamps the originating thread (#124 pattern) so the job's
  // result posts back into the conversation it came from. Omitted (B4) for:
  // an empty sessionId (nothing to deliver to), the 'ui-feedback' sentinel
  // (no real thread to post into), and an implausibly long sessionId (a
  // malformed/legacy row — a thread_id that long can never resolve to a
  // real thread, so it's safer to drop than to stamp).
  const canDeliverToSession =
    row.sessionId.length > 0 &&
    row.sessionId !== UI_FEEDBACK_SENTINEL_SESSION &&
    row.sessionId.length <= MAX_DELIVER_TO_SESSION_LEN

  return {
    kind: "prompt",
    spec: "",
    payload: {
      label,
      source: "feedback",
      user_prompt: userPrompt,
      max_turns: DEFAULT_MAX_TURNS,
      ...(canDeliverToSession
        ? { deliver_to: { kind: "chat_thread", thread_id: row.sessionId } }
        : {}),
    },
  }
}

/** The minimal jobs-store surface this bridge depends on. Promise-based (not
 *  Effect) — see the file-level comment for why. A real caller adapts the
 *  Effect-based JobsStoreApi (jobs-store-types.ts) with
 *  `Effect.runPromise`. */
export interface FeedbackJobsDep {
  readonly record: (input: JobRecordSpec & { readonly id: string }) => Promise<unknown>
  readonly getById: (id: string) => Promise<unknown>
}

/** The minimal ui_feedback_status `setStatus` surface (see
 *  UiFeedbackStatusStore.setStatus in ./ui-feedback-status-store.ts, made
 *  Promise-returning here for the same reason as FeedbackJobsDep). The
 *  resolved value is INSPECTED by createJobFromFeedback (B1) — a real
 *  adapter must resolve `{ok:false, message}` on a failed write rather than
 *  only throwing on a hard error, exactly like the underlying sync store's
 *  own return shape. */
export type FeedbackSetStatusDep = (
  args: {
    readonly id: string
    readonly status: string
    readonly resolvedRef?: string | null
    readonly notes?: string | null
    readonly expectedStatus?: string
    readonly appendNotes?: boolean
  },
  nowMs: number,
) => Promise<{ readonly ok: boolean; readonly message?: string }>

export interface CreateJobFromFeedbackDeps {
  readonly getFeedbackRow: (id: string) => Promise<FeedbackJobLookupRow | null>
  readonly jobs: FeedbackJobsDep
  readonly setStatus: FeedbackSetStatusDep
}

export interface CreateJobFromFeedbackResult {
  readonly ok: boolean
  readonly jobId?: string
  readonly message?: string
}

/** Terminal ui_feedback_status statuses (B2) — a note already in one of
 *  these states was resolved by a human, marked as wontfix, or reached a
 *  terminal job outcome; re-running create-job must never rewrite it. */
const TERMINAL_STATUSES = new Set(["resolved", "dismissed", "job-failed", "wontfix"])

/**
 * Flow: look up → fail closed on unknown/wrong-kind (B3) → short-circuit
 * when already linked/terminal (B2) → idempotently record the deterministic
 * job (B4, B11), re-checking structurally (not by string-matching the error)
 * on a record() failure (B3) → link resolvedRef back onto the note (B6)
 * using the INJECTED clock, never anything derived from the note itself
 * (B7), inspecting setStatus's resolved value so a partial failure is
 * reported rather than swallowed (B1). See the file-level comment for the
 * full step-by-step.
 */
export const createJobFromFeedback = async (
  args: { readonly id: string },
  deps: CreateJobFromFeedbackDeps,
  serverNowMs: number,
): Promise<CreateJobFromFeedbackResult> => {
  const row = await deps.getFeedbackRow(args.id)
  if (row === null || row.kind !== "ui_feedback") {
    return { ok: false, message: "unknown feedback id" }
  }

  const jobId = feedbackJobIdFor(args.id)

  // B2: already linked to this exact job, or the note has already reached a
  // terminal status — never rewrite either, not even to re-stamp the same
  // resolvedRef. No write of any kind happens on this path.
  if (row.resolvedRef === jobId) {
    return { ok: true, jobId, message: "already linked to this job" }
  }
  if (TERMINAL_STATUSES.has(row.status)) {
    return { ok: true, jobId, message: `already ${row.status}` }
  }

  const existing = await deps.jobs.getById(jobId)
  if (existing === null || existing === undefined) {
    const spec = buildFeedbackJobSpec(row)
    try {
      await deps.jobs.record({
        id: jobId,
        kind: spec.kind,
        spec: spec.spec,
        payload: spec.payload,
      })
    } catch (cause) {
      // B3: don't trust a string match on the error message to distinguish
      // "a concurrent creator won the record() race for this deterministic
      // id" (harmless — the row exists either way) from a real failure.
      // Re-check structurally: if the row exists now, fall through and link
      // status exactly like the idempotent re-call path; only a record
      // failure that leaves NO row behind is reported as ok:false.
      const recheck = await deps.jobs.getById(jobId)
      if (recheck === null || recheck === undefined) {
        return { ok: false, message: `job record failed: ${String(cause)}` }
      }
    }
  }

  try {
    const result = await deps.setStatus(
      {
        id: args.id,
        status: "queued",
        resolvedRef: jobId,
      },
      serverNowMs,
    )
    if (!result.ok) {
      return {
        ok: false,
        jobId,
        message: `job created but status link failed: ${result.message ?? "unknown error"} - retry to link`,
      }
    }
  } catch (cause) {
    // A throwing adapter (vs. one that resolves {ok:false}) is still a
    // partial failure — the job row exists, only the link failed — so the
    // caller gets the same jobId-carrying result either way.
    return { ok: false, jobId, message: `status link failed: ${String(cause)}` }
  }

  return { ok: true, jobId }
}

/** A single-row feedback lookup, keyed by id — the real (chat-server-side)
 *  counterpart to `getFeedbackRow` above, kept as its own small interface so
 *  `createFeedbackCreateJobDep` can be handed `null` when the underlying
 *  store failed to open at boot (B14) without dragging in the full
 *  UiFeedbackStatusStore surface. */
export interface FeedbackJobLookupStore {
  readonly getRow: (id: string) => FeedbackJobLookupRow | null
}

export interface CreateFeedbackCreateJobDepConfig {
  /** `null` when the ui_feedback_status store failed to open at boot —
   *  mirrors getFeedbackSetStatus/getFeedbackList's null-store handling in
   *  chat-server.ts (fails closed, never throws). */
  readonly store: FeedbackJobLookupStore | null
  readonly jobs: FeedbackJobsDep
  readonly setStatus: FeedbackSetStatusDep
  readonly nowMs: () => number
}

/**
 * Build the `feedback-create-job` curated-tool dep chat-server.ts injects
 * into buildCuratedAppTools (core-apps.ts). Fails closed with a friendly
 * message — never throws — when `store` is null (B14), the same posture
 * getFeedbackList/getFeedbackSetStatus already take for a store that failed
 * to open.
 */
export const createFeedbackCreateJobDep = (
  config: CreateFeedbackCreateJobDepConfig,
): FeedbackCreateJobDep => {
  return async (args) => {
    if (config.store === null) {
      return { ok: false, message: "feedback triage store unavailable" }
    }
    const store = config.store
    return createJobFromFeedback(
      args,
      {
        getFeedbackRow: async (id) => store.getRow(id),
        jobs: config.jobs,
        setStatus: config.setStatus,
      },
      config.nowMs(),
    )
  }
}

/** Alias for the function returned by `createFeedbackCreateJobDep` — the only
 *  surface the submit-time auto-enqueue helper needs to run. */
export type FeedbackCreateJobDep = (
  args: { readonly id: string },
) => Promise<CreateJobFromFeedbackResult>

/** Default-ON env gate for the submit-time feedback auto-job enqueue.
 *  Mirrors the `LUNA_WAKE_ENABLED` idiom used elsewhere: only a trimmed value
 *  of `"0"` disables the gate; unset, empty, or any other value leaves it ON.
 *
 *  @param env - environment dictionary (`process.env` in Node/Bun, or a test
 *               fixture). Defaults to `process.env` so runtime callers don't
 *               need to pass anything.
 *  @returns `true` when the auto-enqueue path should run.
 */
export const feedbackAutoJobEnabled = (
  env: { readonly [key: string]: string | undefined } = process.env,
): boolean => env["LUNA_FEEDBACK_AUTO_JOB"]?.trim() !== "0"

/** Run a feedback-create-job dep and swallow any failure into `log`.
 *  This is the submit-time auto-enqueue path: the feedback note is already
 *  durably recorded, so the caller must always proceed to ack `ok:true`.
 *  Rejections and `{ ok:false }` results are both turned into a single
 *  `log(message)` call and the returned promise always resolves.
 *
 *  @param createJob - the `createFeedbackCreateJobDep` function to run.
 *  @param id - the feedback note id.
 *  @param log - sink for the error line; called synchronously with the body
 *               of the message (the caller adds any prefix/newline).
 */
export const runFeedbackCreateJobNoThrow = async (
  createJob: FeedbackCreateJobDep,
  id: string,
  log: (message: string) => void,
): Promise<void> => {
  try {
    const result = await createJob({ id })
    if (!result.ok) {
      log(`auto-job create failed for ${id}: ${result.message ?? "unknown error"}`)
    }
  } catch (cause) {
    log(`auto-job create threw for ${id}: ${String(cause)}`)
  }
}
