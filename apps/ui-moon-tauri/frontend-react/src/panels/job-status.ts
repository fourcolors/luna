/**
 * job-status.ts — THE single definition of what a job's `lastStatus` string
 * means, for every panel that renders one.
 *
 * WHY THIS FILE EXISTS: `jobs.last_status` is written by the backend in its own
 * vocabulary — "fired" for a run that succeeded and "errored" for one that
 * failed (packages/core/src/jobs/job-ticker-executor.ts and
 * job-ticker-producer.ts; also doctor-enqueue.ts and job-heal.ts). It reaches
 * the UI UNNORMALIZED: chat-server.ts forwards `lastStatus: j.lastStatus`
 * verbatim, and the wire type is a bare `string | null`.
 *
 * Two panels used to classify that same field with two independent copies of
 * the vocabulary, and they drifted. The Workflows gallery knew about
 * "fired"/"errored"; the Briefing digest did not, matching only
 * "failed"/"error"/"success". The consequence was not a cosmetic wrong colour:
 * Briefing's `groupWorkflows` puts a workflow in "Needs attention" or "Recent"
 * or NEITHER, so a real job — whose status is always "fired" or "errored" —
 * matched no branch and silently vanished from the digest entirely. The nightly
 * `dream-luna` job failed 90 consecutive times over 30 days without ever
 * appearing in the one surface designed to say "here is what needs you".
 *
 * So the fix is not to paste "errored" into the second copy. It is to delete the
 * second copy. One vocabulary, defined once, here.
 *
 * NOT IN SCOPE: `panels/flow-model.ts` keeps its own `statusClass`, and that is
 * correct — it classifies a single RUN's `status` (success/failed/running/…),
 * a different wire contract from a job's `lastStatus`. Two things that look
 * alike are not the same thing; merging them would blur two real vocabularies
 * back into one and re-create this bug from the other direction.
 */

/**
 * The canonical classes a job `lastStatus` can fall into.
 *
 * "never" means the job has no meaningful last run to report (no status at all,
 * or "scheduled" — queued but never fired). Consumers that have no such visual
 * state map it onto their own nearest neighbour; see `jobStatusDotClass`.
 */
export type JobStatusClass =
  | "success"
  | "failed"
  | "running"
  | "waiting"
  | "cancelled"
  | "never"
  | "queued"

/**
 * Classify a RAW `jobs.last_status` value.
 *
 * Accepts both the backend's own vocabulary ("fired"/"errored") and the
 * normalized run-status vocabulary ("success"/"failed"/…), as belt-and-braces
 * for any server that normalizes before sending. Unknown non-empty strings fall
 * through to "queued" rather than throwing — this renders an untrusted value
 * off the wire, so it must be total.
 */
export function jobStatusClass(rawStatus: unknown): JobStatusClass {
  const s = String(rawStatus || "").toLowerCase()
  if (s === "fired" || s === "success" || s === "ok" || s === "completed") return "success"
  if (s === "errored" || s === "failed" || s === "fail" || s === "error") return "failed"
  if (s === "running" || s === "started") return "running"
  if (s === "waiting") return "waiting"
  if (s === "cancelled" || s === "canceled") return "cancelled"
  if (!rawStatus || s === "scheduled") return "never"
  return "queued"
}

/** A job that is stuck or broken and wants a human — the "Needs attention" set. */
export const jobNeedsAttention = (rawStatus: unknown): boolean => {
  const c = jobStatusClass(rawStatus)
  return c === "waiting" || c === "failed"
}

/** A job that finished and needs nothing — the "Recent" set. */
export const jobIsSettled = (rawStatus: unknown): boolean => {
  const c = jobStatusClass(rawStatus)
  return c === "success" || c === "cancelled"
}
