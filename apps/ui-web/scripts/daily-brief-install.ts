/**
 * daily-brief-install — install (or update) the daily-brief V2 prompt job.
 *
 * One-shot script that writes a `kind=prompt` row into the `jobs` table so
 * the Phase-12b JobTicker fires it on schedule, runs an autonomous Claude
 * query with the full MCP suite enabled, and delivers a structured digest
 * to `agent_notes` via `obs_note kind=daily_brief`. The operator sees the
 * brief by querying `obs_notes_recent` (or via the Moon UI when a panel
 * surfaces it).
 *
 * REQUIRES the V2 scheduler stack (chat-v0.12b or later). The server must
 * be running with `LUNA_SCHEDULER_V2_ENABLED=1` for the row to be picked
 * up by the ticker.
 *
 * Usage:
 *   bun run apps/ui-web/scripts/daily-brief-install.ts
 *   bun run apps/ui-web/scripts/daily-brief-install.ts --force   # replace existing
 *   bun run apps/ui-web/scripts/daily-brief-install.ts --uninstall
 *
 * Env vars honoured:
 *   LUNA_DB_PATH / LUNA_HOME     — same resolution as chat-server.ts
 *   LUNA_DAILY_BRIEF_CRON        — cron expr in SERVER UTC. Default "0 16 * * *"
 *                                  (= 09:00 America/Los_Angeles PDT,
 *                                     08:00 PST). The install script forces
 *                                  UTC interpretation regardless of the
 *                                  host's TZ, so the row is portable.
 *   LUNA_DAILY_BRIEF_ID          — stable job id. Default "daily-brief-luna".
 *   LUNA_DAILY_BRIEF_MAX_TURNS   — max_turns. Default 30.
 *
 * Idempotent: re-running without --force when the row already exists is
 * a no-op (prints the current row's state and exits 0).
 */
import { Cron, Effect, Layer, ManagedRuntime } from "effect"
import { Clock, JobsStoreService } from "@luna/core"
import { LunaSqliteBootstrapLive } from "@luna/memory"
import { resolveRuntimePaths } from "./runtime-paths.js"

const paths = resolveRuntimePaths()
console.log("[daily-brief-install] db paths:", {
  lunaDbPath: paths.lunaDbPath,
})

const args = new Set(process.argv.slice(2))
const FORCE = args.has("--force")
const UNINSTALL = args.has("--uninstall")

const JOB_ID = process.env.LUNA_DAILY_BRIEF_ID ?? "daily-brief-luna"
const CRON_EXPR = process.env.LUNA_DAILY_BRIEF_CRON ?? "0 16 * * *"
const MAX_TURNS = (() => {
  const raw = process.env.LUNA_DAILY_BRIEF_MAX_TURNS
  const n = raw ? Number(raw) : 30
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 30
})()

// ── Prompt body ─────────────────────────────────────────────────────────────
//
// The daily brief is a structured survey of Luna's own state, written for
// the operator's morning catch-up. Instructions are explicit + verifiable so
// the model's output is consistent across runs.

const USER_PROMPT = `# Daily Brief

You are Luna preparing your daily morning brief for the operator. Survey
your own state and produce a concise digest using the tools you have.

## Sources to consult (in order)

1. \`mcp__observability__obs_notes_recent\` (limit 30) — your behavioural
   ledger across the last day or two. Look for kinds: \`goal_declared\`,
   \`decision\`, \`progress\`, \`reflection\`, \`obstacle\`.
2. \`mcp__observability__obs_session_anomalies\` — any session with high
   error rate or unusual duration since yesterday's brief.
3. Workspace state — query \`luna.db\` via \`mcp__local_shell__local_shell_run\`:
   \`\`\`
   sqlite3 ~/.luna/luna.db "SELECT slug, path, status, summary FROM workspaces WHERE status='active'"
   \`\`\`
   Then for each active workspace, read its \`workspace.db\` and pull:
   - active goals (\`SELECT slug, summary, status, priority FROM goals WHERE status='active'\`)
   - top 5 prioritised next_actions
   - last 5 decisions
4. \`mcp__memory__memory_search\` — any prospective intentions worth raising.

## Output shape — one \`obs_note\` only

After surveying, write **one** \`mcp__observability__obs_note\` with:

- \`kind\`: \`"daily_brief"\`
- \`summary\`: a markdown digest with these 4 sections (in this order):
  1. **🌙 Yesterday** — 2-4 bullets on what got done since the last brief
     (anchor to specific PRs / commits / decisions when possible).
  2. **🎯 Active goals** — for each active goal: slug + one-line status.
  3. **🚀 Top 3 for today** — prioritised, with the reasoning in 1 line each.
  4. **⚠️ Anomalies / blockers** — empty section if none; explicit list if any.

Be honest and direct. If nothing happened since the last brief, say so.
If a goal is stuck, name the blocker. The operator reads these to decide
where to spend the day — vagueness is harmful.

End the obs_note. Do NOT send a chat reply.`

const SYSTEM_PROMPT = `You are Luna's daily-brief autonomous worker.
You survey Luna's own state (agent_notes, workspaces, memory, sessions)
and produce a single structured digest as an obs_note. You operate
independently — no operator turn will be taken. Use tools freely, then
write exactly one obs_note and stop.`

// ── Payload + program ───────────────────────────────────────────────────────

const ALLOWED_TOOLS = [
  // memory
  "mcp__memory__memory_search",
  // observability
  "mcp__observability__obs_notes_recent",
  "mcp__observability__obs_session_anomalies",
  "mcp__observability__obs_sessions_search",
  "mcp__observability__obs_runtime",
  "mcp__observability__obs_note",
  // local shell (for sqlite3 against luna.db + workspace.db)
  "mcp__local_shell__local_shell_run",
  "mcp__local_shell__local_shell_list_roots",
] as const

const buildPayload = () => ({
  label: "daily-brief",
  source: "daily-brief-install",
  user_prompt: USER_PROMPT,
  system_prompt: SYSTEM_PROMPT,
  max_turns: MAX_TURNS,
  allowed_tools: [...ALLOWED_TOOLS],
  deliver_to: {
    kind: "obs_note" as const,
    kind_tag: "daily_brief",
  },
})

/**
 * Compute next fire time AS IF the host were UTC.
 *
 * Effect's `Cron.next` interprets cron expressions using the host's
 * local timezone. The chat-server runs in UTC; this install script may
 * run on a developer's Mac in a different TZ. We force UTC interpretation
 * here by temporarily flipping `process.env.TZ` around the Cron call,
 * then restoring it. The result is the same epoch-ms the server would
 * compute on its next tick — the row is then portable across hosts.
 */
const computeNextRunAtUtc = (now: number): number | null => {
  const prevTz = process.env.TZ
  process.env.TZ = "UTC"
  try {
    const parsed = Cron.parse(CRON_EXPR)
    if (parsed._tag === "Left") return null
    return Cron.next(parsed.right, new Date(now)).getTime()
  } finally {
    if (prevTz === undefined) delete process.env.TZ
    else process.env.TZ = prevTz
  }
}

const jobsStoreL = JobsStoreService.makeLayer(paths.lunaDbPath).pipe(
  Layer.provide(Clock.Default),
  Layer.provide(LunaSqliteBootstrapLive),
)

const program = Effect.gen(function* () {
  const store = yield* JobsStoreService

  const existing = yield* store.getById(JOB_ID)

  if (UNINSTALL) {
    if (!existing) {
      console.log(`[daily-brief-install] no row '${JOB_ID}' — nothing to uninstall`)
      return
    }
    const removed = yield* store.remove(JOB_ID)
    console.log(`[daily-brief-install] uninstalled '${JOB_ID}' (removed=${removed})`)
    return
  }

  if (existing && !FORCE) {
    console.log(`[daily-brief-install] '${JOB_ID}' already installed:`)
    console.log({
      kind: existing.kind,
      spec: existing.spec,
      schedule: existing.schedule,
      enabled: existing.enabled,
      nextRunAt: existing.nextRunAt
        ? new Date(existing.nextRunAt).toISOString()
        : null,
      lastRun: existing.lastRun
        ? new Date(existing.lastRun).toISOString()
        : null,
    })
    console.log("[daily-brief-install] re-run with --force to overwrite")
    return
  }

  if (existing && FORCE) {
    yield* store.remove(JOB_ID)
    console.log(`[daily-brief-install] removed existing '${JOB_ID}' (forced)`)
  }

  const now = Date.now()
  const nextRunAt = computeNextRunAtUtc(now)
  if (nextRunAt === null) {
    throw new Error(
      `[daily-brief-install] failed to parse cron expression "${CRON_EXPR}"`,
    )
  }

  yield* store.record({
    id: JOB_ID,
    kind: "prompt",
    spec: CRON_EXPR,
    payload: buildPayload(),
  })
  yield* store.setV2Fields(JOB_ID, {
    schedule: CRON_EXPR,
    enabled: true,
    nextRunAt,
  })

  const row = yield* store.getById(JOB_ID)
  console.log(`[daily-brief-install] installed '${JOB_ID}':`, {
    schedule: CRON_EXPR,
    nextRunAt: new Date(nextRunAt).toISOString(),
    enabled: row?.enabled,
    maxTurns: MAX_TURNS,
    allowedTools: ALLOWED_TOOLS.length,
  })
  console.log(
    `[daily-brief-install] first fire at ${new Date(nextRunAt).toISOString()} (server time)`,
  )
})

const rt = ManagedRuntime.make(jobsStoreL)
rt.runPromiseExit(program)
  .then(async (exit) => {
    await rt.dispose()
    if (exit._tag === "Failure") {
      console.error("[daily-brief-install] FAILED:", exit.cause)
      process.exit(1)
    }
    console.log("[daily-brief-install] done.")
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error("[daily-brief-install] FATAL:", err)
    process.exit(1)
  })
