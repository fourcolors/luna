// packages/core/src/wake/wake.ts
//
// Wake orchestration: read workspace state from workspace.db, call the
// reasoner, write a wake_log row. Mirrors dream/dream.ts's `runDream`.
//
// runWake intentionally never fails — any error short-circuits to a
// wake_log row with outcome='error', so a bad tick is non-poisoning (the
// WakeWorker records the failure and the next scheduled tick proceeds).
import { Effect } from "effect"
import { readFileSync, existsSync } from "node:fs"
import { AgentNotesService } from "../agent-notes/agent-notes.js"
import { WakeReasoner } from "./reasoner.js"
import { WakeLogStore } from "./wake-log-store.js"
import { planNextActions } from "./plan-actions.js"
import { WakeError } from "./types.js"
import type { WakeDigest, WakeInputs, WakeOutcome } from "./types.js"

// ── bun:sqlite minimal shape (mirrors wake-log-store.ts) ────────────────────
interface BunDb {
  query: (sql: string) => BunStmt
  close: () => void
}
interface BunStmt {
  all: (...p: unknown[]) => unknown[]
}

/**
 * Workspace.md is loaded verbatim into the prompt. Cap to keep prompt size
 * bounded — the reasoner doesn't need the full markdown, just enough to
 * understand vocabulary and conventions.
 */
const MAX_WORKSPACE_MD_CHARS = 4_000

/** Where workspace.db files live for a given workspace path. */
export const workspaceDbPathFor = (workspacePath: string): string =>
  `${workspacePath}/.workspace/workspace.db`

export const workspaceMdPathFor = (workspacePath: string): string =>
  `${workspacePath}/.workspace/workspace.md`

export interface WakeCronOptions {
  readonly workspaceSlug: string
  readonly workspacePath: string
}

/**
 * Read inputs for one wake cycle from the workspace.db at the given path.
 * Read-only — opens the db in readonly mode and closes it on exit.
 *
 * Returns a WakeInputs value or a WakeError if the db can't be opened or
 * any required table is missing. Caller decides how to log the error.
 *
 * bun:sqlite is loaded via dynamic-import-string indirection so this module
 * typechecks under tsc without @types/bun (same pattern as jobs-store.ts).
 */
export const readWakeInputs = (
  opts: WakeCronOptions,
): Effect.Effect<WakeInputs, WakeError> =>
  Effect.gen(function* () {
    const bunSqliteSpec = "bun:sqlite"
    const mod = yield* Effect.tryPromise({
      try: () =>
        import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
      catch: (cause) =>
        new WakeError({
          op: "wake/read-inputs",
          message: `failed to import bun:sqlite: ${String(cause)}`,
          cause,
        }),
    })
    const Database = (mod as { Database?: unknown }).Database as
      | (new (p: string, opts?: { readonly?: boolean }) => BunDb)
      | undefined
    if (!Database) {
      return yield* Effect.fail(
        new WakeError({
          op: "wake/read-inputs",
          message: "bun:sqlite module has no `Database` export",
        }),
      )
    }
    return yield* Effect.try({
      try: (): WakeInputs => {
        const dbPath = workspaceDbPathFor(opts.workspacePath)
        const mdPath = workspaceMdPathFor(opts.workspacePath)
        const workspaceMd = existsSync(mdPath)
          ? readFileSync(mdPath, "utf8").slice(0, MAX_WORKSPACE_MD_CHARS)
          : ""
        const db = new Database(dbPath, { readonly: true })
        try {
          const openGoals = db
            .query(
              "SELECT slug, title, priority FROM goals " +
                "WHERE status='active' ORDER BY priority DESC, created_at ASC",
            )
            .all() as ReadonlyArray<{
            slug: string
            title: string
            priority: number
          }>
          const rawActions = db
            .query(
              "SELECT id, goal_slug, action, priority, status FROM next_actions " +
                "WHERE status IN ('todo','doing') " +
                "ORDER BY priority DESC, created_at ASC LIMIT 20",
            )
            .all() as ReadonlyArray<{
            id: number
            goal_slug: string
            action: string
            priority: number
            status: string
          }>
          const rawWakes = db
            .query(
              "SELECT woke_at, summary, outcome FROM wake_log " +
                "ORDER BY woke_at DESC LIMIT 5",
            )
            .all() as ReadonlyArray<{
            woke_at: number
            summary: string
            outcome: string
          }>
          return {
            workspaceSlug: opts.workspaceSlug,
            workspaceMd,
            openGoals,
            openNextActions: rawActions.map((a) => ({
              id: a.id,
              goalSlug: a.goal_slug,
              action: a.action,
              priority: a.priority,
              status: a.status,
            })),
            recentWakes: rawWakes.map((w) => ({
              wokeAt: w.woke_at,
              summary: w.summary,
              outcome: w.outcome,
            })),
          } satisfies WakeInputs
        } finally {
          db.close()
        }
      },
      catch: (cause) =>
        new WakeError({
          op: "wake/read-inputs",
          message: `failed to read workspace state: ${String(cause)}`,
          cause,
        }),
    })
  })

/**
 * Build a one-line human-readable summary from a digest for the wake_log
 * `summary` column. The full digest goes into `artifacts` as JSON.
 */
const summarizeDigest = (digest: WakeDigest): string => {
  if (digest.pickedActionId !== null) {
    return `picked action #${digest.pickedActionId}: ${digest.pickedReason}`
  }
  if (digest.proposedActions.length > 0) {
    return `proposed ${digest.proposedActions.length} new action(s) — ${digest.pickedReason}`
  }
  return digest.pickedReason || "no actionable work found"
}

/** Decide the outcome enum from a digest's content. */
const outcomeFromDigest = (digest: WakeDigest): WakeOutcome =>
  digest.pickedActionId !== null || digest.proposedActions.length > 0
    ? "success"
    : "no-op"

/**
 * Run one wake cycle. Reads inputs, calls the reasoner, writes wake_log.
 * Always emits a wake_log row (success, no-op, or error) — never throws.
 */
/**
 * Synthetic sessionId used when wake mirrors its digest into agent_notes.
 * Wake doesn't run inside a chat session — using a stable id groups every
 * wake fire together for `getRecent('wake-cron', ...)` queries while still
 * surfacing through the cross-session `getRecentAcrossSessions` path that
 * `obs_notes_recent` uses by default.
 */
const WAKE_SESSION_ID = "wake-cron"

export const runWake = (
  now: number,
  opts: WakeCronOptions,
): Effect.Effect<
  void,
  never,
  WakeReasoner | WakeLogStore | AgentNotesService
> =>
  Effect.gen(function* () {
    const reasoner = yield* WakeReasoner
    const store = yield* WakeLogStore
    const notes = yield* AgentNotesService

    // Helper: mirror a wake row into agent_notes. Always best-effort —
    // failure here MUST NOT abort the wake cycle, since wake_log is the
    // primary durable record (workspace-scoped) and agent_notes is the
    // operator-visibility mirror (luna.db cross-session).
    const mirrorToNotes = (input: {
      readonly summary: string
      readonly outcome: string
      readonly artifacts: string
    }) =>
      Effect.ignore(
        notes.record({
          sessionId: WAKE_SESSION_ID,
          kind: "wake_digest",
          summary: `[${input.outcome}] ${input.summary}`,
          payload: {
            wokeAt: now,
            workspaceSlug: opts.workspaceSlug,
            workspacePath: opts.workspacePath,
            outcome: input.outcome,
            artifacts: input.artifacts,
          },
        }),
      )

    // Step 1: read state. Failure logged + returned early.
    const inputsResult = yield* Effect.either(readWakeInputs(opts))
    if (inputsResult._tag === "Left") {
      const errSummary = `wake aborted: ${inputsResult.left.message}`
      const errArtifacts = JSON.stringify({
        stage: "read-inputs",
        error: inputsResult.left.message,
      })
      yield* Effect.ignore(
        store.append({
          wokeAt: now,
          goalSlug: null,
          summary: errSummary,
          outcome: "error",
          artifacts: errArtifacts,
        }),
      )
      yield* mirrorToNotes({
        summary: errSummary,
        outcome: "error",
        artifacts: errArtifacts,
      })
      return
    }
    const inputs = inputsResult.right

    // Step 2: reason. Reasoner failure logged + returned.
    const reasonResult = yield* Effect.either(reasoner.reason(inputs))
    if (reasonResult._tag === "Left") {
      const errSummary = `wake reasoner failed: ${reasonResult.left.message}`
      const errArtifacts = JSON.stringify({
        stage: "reason",
        error: reasonResult.left.message,
      })
      yield* Effect.ignore(
        store.append({
          wokeAt: now,
          goalSlug: null,
          summary: errSummary,
          outcome: "error",
          artifacts: errArtifacts,
        }),
      )
      yield* mirrorToNotes({
        summary: errSummary,
        outcome: "error",
        artifacts: errArtifacts,
      })
      return
    }
    const digest = reasonResult.right

    // Step 3: write the successful row.
    const successSummary = summarizeDigest(digest)
    const successOutcome = outcomeFromDigest(digest)
    const successArtifacts = JSON.stringify(digest)
    yield* Effect.ignore(
      store.append({
        wokeAt: now,
        goalSlug: null,
        summary: successSummary,
        outcome: successOutcome,
        artifacts: successArtifacts,
      }),
    )
    yield* mirrorToNotes({
      summary: successSummary,
      outcome: successOutcome,
      artifacts: successArtifacts,
    })

    // Step 4 (Path B): file the reasoner's proposed actions into next_actions so
    // observation becomes actionable instead of evaporating into wake_log. The
    // planner dedups against the open actions the reasoner already saw, nulls any
    // unknown goal_slug (FK-safe), and clamps priority. Best-effort: a filing
    // failure must NOT poison the cron tick (wake_log already recorded above).
    if (digest.proposedActions.length > 0) {
      const planned = planNextActions(
        digest.proposedActions,
        inputs.openNextActions,
        inputs.openGoals.map((g) => g.slug),
      )
      if (planned.length > 0) {
        yield* Effect.ignore(store.appendNextActions(planned, now))
      }
    }
  })

// The legacy `registerWakeCron` (TriggerAgent fiber-per-cron registration) was
// removed with the V1 scheduler. Wake now runs exclusively through the V2 path:
// per-workspace `kind:"wake"` job rows drained by the JobTicker into the
// WakeWorker (see wake-worker.ts), which calls `runWake(now, opts)` directly.
