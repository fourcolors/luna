// packages/core/src/wake/wake.ts
//
// Wake orchestration: read workspace state from workspace.db, call the
// reasoner, write a wake_log row. Mirrors dream/dream.ts's `runDream` +
// `registerDreamCron` pattern.
//
// runWake intentionally never fails — any error short-circuits to a
// wake_log row with outcome='error', so the cron loop is non-poisoning
// (one bad tick doesn't kill the trigger fiber).
import { Effect, Clock as EffectClock } from "effect"
import { readFileSync, existsSync } from "node:fs"
import type { TriggerAgentApi } from "../jobs/trigger-agent.js"
import { WakeReasoner } from "./reasoner.js"
import { WakeLogStore } from "./wake-log-store.js"
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
export const runWake = (
  now: number,
  opts: WakeCronOptions,
): Effect.Effect<void, never, WakeReasoner | WakeLogStore> =>
  Effect.gen(function* () {
    const reasoner = yield* WakeReasoner
    const store = yield* WakeLogStore

    // Step 1: read state. Failure logged + returned early.
    const inputsResult = yield* Effect.either(readWakeInputs(opts))
    if (inputsResult._tag === "Left") {
      yield* Effect.ignore(
        store.append({
          wokeAt: now,
          goalSlug: null,
          summary: `wake aborted: ${inputsResult.left.message}`,
          outcome: "error",
          artifacts: JSON.stringify({
            stage: "read-inputs",
            error: inputsResult.left.message,
          }),
        }),
      )
      return
    }
    const inputs = inputsResult.right

    // Step 2: reason. Reasoner failure logged + returned.
    const reasonResult = yield* Effect.either(reasoner.reason(inputs))
    if (reasonResult._tag === "Left") {
      yield* Effect.ignore(
        store.append({
          wokeAt: now,
          goalSlug: null,
          summary: `wake reasoner failed: ${reasonResult.left.message}`,
          outcome: "error",
          artifacts: JSON.stringify({
            stage: "reason",
            error: reasonResult.left.message,
          }),
        }),
      )
      return
    }
    const digest = reasonResult.right

    // Step 3: write the successful row.
    yield* Effect.ignore(
      store.append({
        wokeAt: now,
        goalSlug: null,
        summary: summarizeDigest(digest),
        outcome: outcomeFromDigest(digest),
        artifacts: JSON.stringify(digest),
      }),
    )
  })

/**
 * Register a wake cron on the given TriggerAgent. Captures the wake-service
 * environment (WakeReasoner + WakeLogStore) into the cron `build()` closure
 * via `Effect.context()` so each tick runs with the same services.
 *
 * Returns the TriggerId so the caller can cancel if needed.
 */
export const registerWakeCron = (
  trigger: TriggerAgentApi,
  expr: string,
  opts: WakeCronOptions,
) =>
  Effect.gen(function* () {
    // Capture wake-service env at registration time. Scope is NOT included —
    // the JobScheduler injects a per-job Scope on each tick.
    const ctx = yield* Effect.context<WakeReasoner | WakeLogStore>()
    return yield* trigger.register({
      kind: "cron",
      expr,
      build: () => ({
        run: EffectClock.currentTimeMillis.pipe(
          Effect.flatMap((now) => runWake(now, opts)),
          Effect.provide(ctx),
        ),
      }),
    })
  })
