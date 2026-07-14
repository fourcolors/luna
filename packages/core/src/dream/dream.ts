import { Effect, Option, Stream } from "effect"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord, MemoryRouter } from "@luna/memory"
import { Clock } from "../clock.js"
import { CalibrationStore } from "../alignment/calibration-store.js"
import { classifyTier, revertabilityFor } from "../alignment/tier-classifier.js"
import { readBelief } from "../beliefs/types.js"
import { SessionStore } from "../session/session-store.js"
import { SkillRegistry } from "../skill-registry/skill-registry.js"
import { SuggestedActions } from "../suggested-actions/suggested-actions.js"
import { DreamStore } from "./dream-store.js"
import { DreamReasoner } from "./reasoner.js"
import {
  distillSession,
  DEFAULT_DISTILL_OPTIONS,
  estimateTokens,
  DREAM_PROMPT_TOKEN_BUDGET,
} from "./distill.js"
import type { DistilledSession } from "./distill.js"
import {
  MAX_SKILL_IMPROVEMENT_CHIPS,
  skillImprovementToPropose,
} from "./skill-chip.js"
import type { DreamOp, DreamOpKind, DreamInputs, DreamSkillSummary } from "./types.js"
import { DREAM_OP_TRAITS } from "./types.js"

const OP_KINDS = Object.keys(DREAM_OP_TRAITS) as ReadonlyArray<DreamOpKind>

/**
 * Slice A detectability heuristic (PLACEHOLDER — a decision needing
 * confirmation). Derived from DREAM_OP_TRAITS — the single exhaustive
 * op-kind table in types.ts — so a new DreamOpKind can't silently default.
 */
const detectabilityFor = (kind: DreamOpKind): number =>
  DREAM_OP_TRAITS[kind].detectability

/**
 * Ops materialized to the store (vs. held as 'proposed' audit rows). Derived
 * from DREAM_OP_TRAITS.materialize:
 *  - memory_dedup: idempotent delete of an exact duplicate (Phase 1).
 *  - belief_candidate: stage a PROPOSED belief record (Phase 2 §7.2). Safe to
 *    auto-write because a proposed belief is inert — only ACTIVE beliefs are
 *    injected, and activation stays gated on the Phase 3 survey. Undoable via
 *    revert (before:null → delete).
 * Still HELD as 'proposed' (no survey to catch a bad apply yet): memory_staleness,
 * memory_contradiction, skill_improvement.
 *
 * skill_improvement additionally bridges to SuggestedActions chips when a
 * thread target is provided and SuggestedActions is wired (optional).
 */
const MATERIALIZE_OPS: ReadonlySet<DreamOpKind> = new Set<DreamOpKind>(
  OP_KINDS.filter((k) => DREAM_OP_TRAITS[k].materialize),
)

export interface ApplyOpsOptions {
  /**
   * Thread that receives dream-sourced skill chips. When null/undefined, skill
   * improvements are still audited as 'proposed' but no chip is emitted.
   */
  readonly actionsThreadId?: string | null
  /**
   * Remaining skill-chip budget for this dream cycle (not just this call).
   * Defaults to MAX_SKILL_IMPROVEMENT_CHIPS. applyOps returns how many were
   * emitted so the caller can ratchet the budget across chunks.
   */
  readonly skillChipBudget?: number
}

export interface ApplyOpsResult {
  /** How many skill_improvement chips were actually proposed this call. */
  readonly skillChipsEmitted: number
}

/**
 * Apply a reasoner's ops. Auto-applies exact-dedup (idempotent state-set);
 * holds everything else as a 'proposed' audit row. Caller advances the
 * watermark AFTER this resolves (see runDream) — re-running over the same
 * window is a no-op because dreamId is deterministic and record() is
 * INSERT OR IGNORE, and memory ops are idempotent.
 *
 * skill_improvement: always audit as proposed; optionally emit a
 * SuggestedActions chip (source:"dream") when actionsThreadId + budget allow.
 * A chip failure NEVER fails the dream turn (same measure-only discipline as
 * calibration).
 */
export const applyOps = (
  dreamId: string,
  ops: ReadonlyArray<DreamOp>,
  opts: ApplyOpsOptions = {},
) =>
  Effect.gen(function* () {
    const store = yield* DreamStore
    const mem = yield* MemoryRouterTag
    const clock = yield* Clock
    const now = yield* clock.nowMs()

    // Slice A calibration instrumentation (MEASURE-ONLY). OPTIONAL dependency:
    // serviceOption keeps applyOps' requirement channel unchanged, so existing
    // dream layers (DreamStore/MemoryRouter/Clock only) are untouched. The write
    // is Effect.ignore'd below — a calibration failure can NEVER alter a dream
    // turn, and nothing ever reads calibration_log back into behavior.
    const calOpt = yield* Effect.serviceOption(CalibrationStore)
    const saOpt = yield* Effect.serviceOption(SuggestedActions)

    let skillChipsEmitted = 0
    let skillChipBudget =
      opts.skillChipBudget ?? MAX_SKILL_IMPROVEMENT_CHIPS
    const actionsThreadId = opts.actionsThreadId ?? null

    for (const op of ops) {
      if (MATERIALIZE_OPS.has(op.kind)) {
        // Idempotent state-set: null after = delete; else upsert to desired state.
        if (op.after === null) {
          yield* mem.delete(op.targetId)
        } else {
          yield* mem.put(op.after as MemoryRecord)
        }
        yield* store.record({
          dreamId, at: now, op: op.kind, targetId: op.targetId,
          before: op.before, after: op.after, rationale: op.rationale,
          status: "applied", appliedAt: now,
        })
        // Additive, write-only: log a calibration row for confidence-bearing
        // belief proposals (the only ops carrying a beliefId + verbalized
        // confidence). Slice A records the EXISTING verbalized confidence as a
        // placeholder + the trivial detectability heuristic; sampleCount=1.
        if (op.kind === "belief_candidate" && op.after !== null) {
          if (Option.isNone(calOpt)) {
            // Diagnosability: without this line a missing CalibrationStore
            // silently no-ops the entire instrumentation (the deploy-shaped
            // failure: sampling cost paid upstream, zero rows written). Warn —
            // never fail — so an unwired sink is visible in the dream logs.
            yield* Effect.logWarning(
              "[luna/dream] CalibrationStore not provided — calibration row NOT recorded " +
                `(beliefId=${op.targetId}); wire CalibrationStore.makeLayer into the dream layer to collect ECE data`,
            )
          } else {
            const cal = calOpt.value
            // The ENTIRE calibration block — input prep (readBelief /
            // classifyTier can throw on a malformed `after`) AND the write —
            // lives inside this suspended effect, and the whole thing is
            // swallowed via catchAllCause (failures AND defects). HARD
            // invariant: a calibration/tier failure can NEVER alter a dream
            // turn. (Effect.ignore alone would miss defects, and prep that
            // throws OUTSIDE the effect would fail the turn.)
            yield* Effect.suspend(() => {
              const confidence = readBelief(op.after as MemoryRecord).confidence
              const detectability = detectabilityFor(op.kind)
              // Slice 3 MEASURE-ONLY: compute the autonomy tier write-only on
              // the SAME calibration row. stakes is ALWAYS null here (no stakes
              // signal exists anywhere in the codebase — FLAG); revertability
              // is the materialized placeholder heuristic. `tier` is NEVER
              // gated and NEVER read back into behavior.
              const tier = classifyTier({
                confidence,
                detectability,
                revertability: revertabilityFor(op.kind, true), // op is materialized here
                stakes: null,
              })
              return cal.record({
                dreamId,
                targetId: op.targetId,
                beliefId: op.targetId, // belief_candidate targetId IS the belief id
                proposalAt: now,
                confidence,
                detectability,
                // Slice B MEASURE-ONLY: log the sampling-agreement confidence
                // ALONGSIDE the verbalized `confidence` above (NOT in place of
                // it), and the effective sample size. ABSENT (single pass) ⇒
                // sampledConfidence null + sampleCount 1, preserving prior
                // behavior. Write-only; never read back into behavior.
                sampledConfidence: op.sampledConfidence ?? null,
                sampleCount: op.sampleCount ?? 1,
                tier,
              })
            }).pipe(Effect.catchAllCause(() => Effect.void))
          }
        }
      } else {
        yield* store.record({
          dreamId, at: now, op: op.kind, targetId: op.targetId,
          before: op.before, after: op.after, rationale: op.rationale,
          status: "proposed", appliedAt: null,
        })

        // skill_improvement → chip bridge (optional). Audit already written
        // above; emission is best-effort and budgeted across the dream cycle.
        if (op.kind === "skill_improvement") {
          if (skillChipBudget <= 0) {
            yield* Effect.logInfo(
              `[luna/dream] skill_improvement chip budget exhausted; audited only ` +
                `(targetId=${op.targetId})`,
            )
          } else if (!actionsThreadId) {
            yield* Effect.logWarning(
              `[luna/dream] skill_improvement has no actionsThreadId — chip NOT emitted ` +
                `(targetId=${op.targetId}); set LUNA_DREAM_ACTIONS_THREAD or process a session window`,
            )
          } else if (Option.isNone(saOpt)) {
            yield* Effect.logWarning(
              `[luna/dream] SuggestedActions not provided — skill chip NOT emitted ` +
                `(targetId=${op.targetId}); wire SuggestedActions into the dream layer`,
            )
          } else {
            const input = skillImprovementToPropose(op, actionsThreadId)
            if (input === null) {
              yield* Effect.logWarning(
                `[luna/dream] skill_improvement payload malformed; chip skipped ` +
                  `(targetId=${op.targetId})`,
              )
            } else {
              yield* saOpt.value.propose(input).pipe(
                Effect.tap(() => {
                  skillChipsEmitted += 1
                  skillChipBudget -= 1
                  return Effect.void
                }),
                Effect.catchAllCause((cause) =>
                  Effect.logWarning(
                    `[luna/dream] skill chip propose failed (non-fatal): ${String(cause)}`,
                  ),
                ),
              )
            }
          }
        }
      }
    }

    return { skillChipsEmitted } satisfies ApplyOpsResult
  })

/**
 * Undo an applied op: restore the `before` snapshot to memory and mark the
 * audit row reverted. Returns false if the row is missing or not 'applied'.
 */
export const revert = (auditId: string) =>
  Effect.gen(function* () {
    const store = yield* DreamStore
    const mem = yield* MemoryRouterTag
    const clock = yield* Clock
    const row = yield* store.get(auditId)
    if (row === null || row.status !== "applied") return false
    // Reverse the idempotent state-set.
    if (row.before === null) {
      // op created/kept nothing to restore by id; undo = delete the target.
      yield* mem.delete(row.targetId)
    } else {
      yield* mem.put(row.before as MemoryRecord)
    }
    const now = yield* clock.nowMs()
    return yield* store.markReverted(auditId, now)
  })

export const deriveDreamId = (windowStart: number, windowEnd: number): string =>
  `dream-${windowStart}-${windowEnd}`

/**
 * Collect the dream window (watermark, now]: sessions whose lastMessageAt falls
 * in range, their messages DISTILLED to a bounded excerpt, and operator-namespace
 * memories.
 *
 * Distillation (issue #255): each in-window session's raw StoredMessages are run
 * through distillSession(...) so the reasoner receives a short excerpt (message-
 * granularity windowing + per-scope char caps) instead of every raw payload —
 * the reasoner MUST NOT re-serialize whole message bags into the prompt.
 *
 * NOTE: SessionStore.list has no `since` param, so we list ordered by
 * lastMessageAt and filter the window in code.
 *
 * A readMessages failure yields an EMPTY-message distillation (the session is
 * still surfaced with excerpt="" and windowMessageCount=0), never a dropped
 * session — losing a session silently is worse than reasoning over an empty one.
 *
 * Adaptation from task spec: the error channel is `MemoryBackendError` (not
 * `never`) because MemoryRouter.query returns Stream<MemoryRecord, MemoryBackendError>.
 */
export const gatherInputs = (
  watermark: number,
  now: number,
) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore
    const mem = yield* MemoryRouterTag

    const summaries = yield* sessions
      .list({ orderBy: "lastMessageAt" })
      .pipe(
        Stream.filter(
          (s) => s.lastMessageAt !== null && s.lastMessageAt > watermark && s.lastMessageAt <= now,
        ),
        Stream.runCollect,
        Effect.map((c) => Array.from(c)),
      )

    const withMessages = yield* Effect.forEach(summaries, (summary) =>
      sessions
        .readMessages(summary.id)
        .pipe(
          Stream.runCollect,
          Effect.map((c) =>
            distillSession(summary, Array.from(c), { watermark, now }, DEFAULT_DISTILL_OPTIONS),
          ),
          // A failed readMessages still surfaces the session as an empty-message
          // distillation (not a dropped session — see header comment).
          Effect.catchAll(() =>
            Effect.succeed(distillSession(summary, [], { watermark, now }, DEFAULT_DISTILL_OPTIONS)),
          ),
        ),
    )

    const memories = yield* mem
      .query({ namespace: "operator" })
      .pipe(Stream.runCollect, Effect.map((c) => Array.from(c)))

    // Optional skill catalog for skill_improvement proposals. Bodies never
    // enter the dream prompt (cost + leak surface) — metadata only.
    const skillsOpt = yield* Effect.serviceOption(SkillRegistry)
    let skills: ReadonlyArray<DreamSkillSummary> = []
    if (Option.isSome(skillsOpt)) {
      const catalog = yield* skillsOpt.value.catalog()
      skills = catalog.map(
        (e): DreamSkillSummary => ({
          id: e.id,
          name: e.name,
          description: e.description,
          enabled: e.enabled,
          source: e.source,
        }),
      )
    }

    return { sessions: withMessages, memories, skills }
  })

/**
 * Thread that receives dream-sourced skill chips.
 * 1. LUNA_DREAM_ACTIONS_THREAD env (explicit operator pin)
 * 2. else newest session id in this cycle's ordered window (session id === thread id)
 * 3. else null (audit only, no chip)
 */
export const resolveDreamActionsThreadId = (
  orderedSessions: ReadonlyArray<DistilledSession>,
): string | null => {
  const env = process.env["LUNA_DREAM_ACTIONS_THREAD"]?.trim()
  if (env) return env
  if (orderedSessions.length === 0) return null
  // ordered ascending by lastMessageAt — last element is most recent.
  const newest = orderedSessions[orderedSessions.length - 1]
  return newest?.summary.id ?? null
}

/**
 * Fixed headroom reserved for everything that rides on the prompt besides the
 * session excerpts and memories block: the reasoner's own scaffolding
 * (instructions, schema, framing) PLUS the Claude Code CLI's system prompt and
 * tool schemas, which the SDK adds on top of our prompt and our estimate never
 * sees. Sized from sandbox verification against the live #255 backlog, where
 * the original 2k reserve left a chunk the pre-flight approved but the SDK
 * rejected as too long.
 */
export const DREAM_PROMPT_OVERHEAD_TOKENS = 20_000

/**
 * Per-dream token budget for the packed session excerpts alone: the whole
 * prompt budget MINUS the memories-block reservation (identical every chunk)
 * MINUS DREAM_PROMPT_OVERHEAD_TOKENS. Keeps each chunk's session payload
 * inside DREAM_PROMPT_TOKEN_BUDGET for every DIVISIBLE window; the one
 * deliberate exception is an indivisible packing item — a single oversized
 * session, or a tie group of equal-lastMessageAt sessions (see packSessions) —
 * which runs as its own chunk even over budget rather than being dropped or
 * split. The memories reservation divides by 3 to match estimateTokens.
 */
export const DREAM_SESSION_TOKEN_BUDGET =
  DREAM_PROMPT_TOKEN_BUDGET -
  Math.ceil(DEFAULT_DISTILL_OPTIONS.memoriesChars / 3) -
  DREAM_PROMPT_OVERHEAD_TOKENS

/**
 * Per-session packing floor: every session charges at least this many tokens,
 * regardless of excerpt size. A session whose in-window messages are all noise
 * kinds distills to an EMPTY excerpt (estimateTokens("") = 0) yet still costs
 * per-session prompt scaffolding (headers, ids, framing) the excerpt measure
 * never sees — without a floor, unboundedly many zero-cost sessions clump into
 * one chunk and their headers alone can blow the prompt budget (a residual
 * death spiral).
 */
export const SESSION_OVERHEAD_TOKENS = 32

/**
 * Wall-time safety margin subtracted from a chunk's hard deadline: if the live
 * clock is within this window of `deadlineAt`, stop BEFORE starting the next
 * chunk rather than risk overrunning (a chunk is a real reasoner/LLM call).
 */
export const DREAM_DEADLINE_SAFETY_MS = 60_000

export interface RunDreamOptions {
  /** Per-chunk token budget for packed session excerpts. Default DREAM_SESSION_TOKEN_BUDGET. */
  readonly sessionTokenBudget?: number
  /** Hard deadline (epoch-ms) for this cycle; null/undefined = no deadline. */
  readonly deadlineAt?: number | null
  /** Safety margin subtracted from deadlineAt at each gate. Default DREAM_DEADLINE_SAFETY_MS. */
  readonly deadlineSafetyMs?: number
}

export interface RunDreamSummary {
  /** Reasoner passes committed this cycle (the zero-window dummy pass counts as 1). */
  readonly chunksProcessed: number
  /** Distinct sessions reasoned over this cycle. */
  readonly sessionsProcessed: number
  /** True if the deadline gate stopped the cycle before all chunks ran. */
  readonly stoppedEarly: boolean
  /** The watermark after this cycle (the last committed cutoff). */
  readonly watermark: number
}

/**
 * Packing cost of one session: excerpt tokens floored at
 * SESSION_OVERHEAD_TOKENS (see that constant for why the floor exists).
 */
const sessionCost = (s: DistilledSession): number =>
  Math.max(estimateTokens(s.excerpt), SESSION_OVERHEAD_TOKENS)

/**
 * Greedy first-fit packing over TIE GROUPS (pure). The ASCENDING-sorted
 * sessions are first grouped by equal lastMessageAt; groups then pack
 * greedily — a group joins the current chunk while the chunk's summed
 * per-session cost (sessionCost, overhead-floored) stays within `budget`,
 * otherwise a new chunk starts. A group whose summed cost ALONE exceeds the
 * budget still becomes its own (possibly over-budget) chunk — never dropped,
 * and the "fresh chunk only when the current one is non-empty" rule guarantees
 * no infinite loop on an oversized item.
 *
 * Why groups are indivisible (auditor defect 1): the chunk loop commits
 * watermark = cutoff = MAX lastMessageAt per chunk, and gatherInputs' window
 * filter is STRICT (`lastMessageAt > watermark`). If two sessions sharing a
 * timestamp were split across chunks and the run stopped between them
 * (deadline trip or reasoner failure), the committed cutoff would EQUAL the
 * orphan's lastMessageAt — no future run could ever gather it again. Cohesion
 * beats the budget, exactly like the oversized-singleton rule.
 */
const packSessions = (
  sessions: ReadonlyArray<DistilledSession>,
  budget: number,
): ReadonlyArray<ReadonlyArray<DistilledSession>> => {
  // Group consecutive equal-lastMessageAt sessions (input is sorted ascending,
  // so equal timestamps are adjacent).
  const groups: Array<Array<DistilledSession>> = []
  for (const session of sessions) {
    const last = groups[groups.length - 1]
    if (
      last !== undefined &&
      (last[0]?.summary.lastMessageAt ?? 0) === (session.summary.lastMessageAt ?? 0)
    ) {
      last.push(session)
    } else {
      groups.push([session])
    }
  }

  const chunks: Array<Array<DistilledSession>> = []
  let current: Array<DistilledSession> = []
  let currentTokens = 0
  for (const group of groups) {
    const cost = group.reduce((sum, s) => sum + sessionCost(s), 0)
    if (current.length === 0) {
      current = [...group]
      currentTokens = cost
    } else if (currentTokens + cost <= budget) {
      current.push(...group)
      currentTokens += cost
    } else {
      chunks.push(current)
      current = [...group]
      currentTokens = cost
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * One dream cycle. `now` is injected (caller/cron supplies the clock reading)
 * so the function is deterministic in tests, and resolves with a
 * RunDreamSummary (additive — existing callers ignore the value).
 *
 * CHUNKED, per-chunk watermark advance (issue #255, the death-spiral fix). The
 * window is gathered once, sorted ASCENDING by lastMessageAt (SessionStore.list
 * yields DESCENDING), and greedy-packed into chunks each within
 * `sessionTokenBudget` — with two deliberate packing edges (see packSessions):
 * per-session costs are floored at SESSION_OVERHEAD_TOKENS so empty-excerpt
 * sessions can't clump unboundedly, and an indivisible item (oversized session
 * or equal-lastMessageAt tie group) runs as one over-budget chunk rather than
 * being split or dropped. Per chunk, in order: chunkStart = the watermark
 * BEFORE the chunk; cutoff = MAX lastMessageAt in the chunk; dreamId =
 * "dream-${chunkStart}-${cutoff}"; reason() -> applyOps() -> setWatermark(cutoff),
 * BEFORE the next chunk begins. `memories` is identical across every chunk.
 *
 * The per-chunk advance REPLACES the old advance-LAST rule. A monotone ratchet
 * means an oversized or failing night can no longer freeze ALREADY-COMMITTED
 * progress: chunks that committed stay committed, the watermark sits at the
 * last committed cutoff, and a re-run gathers only the unprocessed remainder
 * (the self-heal that ends the death spiral). A pathological single chunk — an
 * indivisible over-budget item whose reasoner call keeps failing — can still
 * stall at ITS boundary, but never rolls back or re-processes what came before
 * it. Per-chunk dreamId keyed on (chunkStart, cutoff) keeps crash-retry
 * idempotency PER CHUNK — a retry over the same sub-window regenerates the
 * same dreamId, so INSERT OR IGNORE collapses the re-run.
 *
 * Failure isolation falls out for free: a reasoner failure in chunk k
 * propagates as a typed error, but chunks 1..k-1 are already applied and the
 * watermark stays at chunk (k-1)'s cutoff — no special catch logic here.
 *
 * Deadline: before EVERY chunk (chunk 1 included), if `deadlineAt` is set and
 * the LIVE clock is within `deadlineSafetyMs` of it, stop cleanly (resolve with
 * stoppedEarly: true and the progress so far) instead of starting a chunk that
 * might overrun the ticker deadline.
 *
 * Zero-window: when no sessions are in the window there are no chunks, so a
 * single unconditional dummy pass runs — sessions:[], dreamId "dream-W-W",
 * watermark unmoved, chunksProcessed:1, sessionsProcessed:0. This path is NOT
 * subject to the deadline gate (memory-hygiene ops still get logged, and a
 * clean re-run collapses them).
 */
export const runDream = (now: number, opts: RunDreamOptions = {}) =>
  Effect.gen(function* () {
    const store = yield* DreamStore
    const reasoner = yield* DreamReasoner
    const clock = yield* Clock
    const sessionTokenBudget = opts.sessionTokenBudget ?? DREAM_SESSION_TOKEN_BUDGET
    const deadlineAt = opts.deadlineAt ?? null
    const deadlineSafetyMs = opts.deadlineSafetyMs ?? DREAM_DEADLINE_SAFETY_MS

    let watermark = (yield* store.getWatermark) ?? 0
    yield* Effect.logInfo(
      `[luna/dream] runDream(${now}) starting; watermark=${watermark}`,
    )

    const inputs = yield* gatherInputs(watermark, now)
    yield* Effect.logInfo(
      `[luna/dream] runDream: gathered ${inputs.sessions.length} session(s) and ${inputs.memories.length} memory record(s)`,
    )

    // SessionStore.list yields DESCENDING lastMessageAt; pack ASCENDING so the
    // watermark ratchets forward oldest-first — an interrupted night still
    // advances past every chunk it managed to process.
    const ordered = [...inputs.sessions].sort(
      (a, b) => (a.summary.lastMessageAt ?? 0) - (b.summary.lastMessageAt ?? 0),
    )
    const chunks = packSessions(ordered, sessionTokenBudget)
    // Chunk-plan observability: the packing decision is the load-bearing step
    // (issue #255 was invisible without it), so log every chunk's estimated
    // size up front — the live-verify rubric reads these lines.
    yield* Effect.logInfo(
      `[luna/dream] runDream: packed ${chunks.length} chunk(s) [budget=${sessionTokenBudget}]: ` +
        chunks
          .map(
            (c, i) =>
              `#${i + 1}{sessions=${c.length} estTokens=${c.reduce(
                (t, s) => t + Math.max(estimateTokens(s.excerpt), SESSION_OVERHEAD_TOKENS),
                0,
              )}}`,
          )
          .join(" "),
    )

    let chunksProcessed = 0
    let sessionsProcessed = 0
    let stoppedEarly = false
    // Cycle-wide skill chip budget (shared across chunks).
    let skillChipBudget = MAX_SKILL_IMPROVEMENT_CHIPS
    const actionsThreadId = resolveDreamActionsThreadId(ordered)
    if (actionsThreadId) {
      yield* Effect.logInfo(
        `[luna/dream] runDream: skill chips → thread ${actionsThreadId}`,
      )
    }

    if (chunks.length === 0) {
      // Zero-window dummy pass (today's exact behavior): ONE reasoner call over
      // an empty session set, dreamId "dream-W-W", watermark unmoved. Kept as an
      // unconditional path — NOT gated on the deadline (see header).
      const dreamId = deriveDreamId(watermark, watermark)
      const ops = yield* reasoner.reason({
        sessions: [],
        memories: inputs.memories,
        skills: inputs.skills,
      })
      const applied = yield* applyOps(dreamId, ops, {
        actionsThreadId,
        skillChipBudget,
      })
      skillChipBudget -= applied.skillChipsEmitted
      yield* store.setWatermark(watermark)
      chunksProcessed = 1
    } else {
      for (const chunk of chunks) {
        // Deadline gate before EVERY chunk (chunk 1 included): each chunk is a
        // real reasoner call, so re-read the LIVE clock and stop cleanly if
        // starting this chunk would risk overrunning the deadline.
        if (deadlineAt != null) {
          const nowMs = yield* clock.nowMs()
          if (nowMs >= deadlineAt - deadlineSafetyMs) {
            stoppedEarly = true
            break
          }
        }

        const chunkStart = watermark
        const cutoff = chunk.reduce(
          (max, s) => Math.max(max, s.summary.lastMessageAt ?? 0),
          chunkStart,
        )
        const dreamId = deriveDreamId(chunkStart, cutoff)
        yield* Effect.logInfo(
          `[luna/dream] runDream: chunk ${chunksProcessed + 1}/${chunks.length} starting; dreamId=${dreamId}; sessions=${chunk.length}`,
        )

        const ops = yield* reasoner.reason({
          sessions: chunk,
          memories: inputs.memories,
          skills: inputs.skills,
        })
        const applied = yield* applyOps(dreamId, ops, {
          actionsThreadId,
          skillChipBudget,
        })
        skillChipBudget -= applied.skillChipsEmitted

        // Advance the watermark PER CHUNK, BEFORE the next chunk — the monotone
        // ratchet that keeps a partial/failed night from freezing progress.
        yield* store.setWatermark(cutoff)
        watermark = cutoff
        chunksProcessed += 1
        sessionsProcessed += chunk.length
      }
    }

    yield* Effect.logInfo(
      `[luna/dream] runDream: completed; chunks=${chunksProcessed}; sessions=${sessionsProcessed}; stoppedEarly=${stoppedEarly}; watermark advanced to ${watermark}`,
    )

    return {
      chunksProcessed,
      sessionsProcessed,
      stoppedEarly,
      watermark,
    } satisfies RunDreamSummary
  }).pipe(
    Effect.tapErrorCause((cause) =>
      Effect.logError(`[luna/dream] runDream FAILED`, { cause }),
    ),
  )

// The legacy `registerDreamCron` (TriggerAgent fiber-per-cron registration)
// was removed with the V1 scheduler. The nightly dream now runs exclusively
// through the V2 path: a `kind:"dream"` job row drained by the JobTicker into
// the DreamWorker (see dream-worker.ts), which calls `runDream` directly.
