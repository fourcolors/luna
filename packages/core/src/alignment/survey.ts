// packages/core/src/alignment/survey.ts
/**
 * Survey — the §3.3 cadence + signal-routing service.
 *
 * Processes a verdict (handed in by a survey/outreach surface — NOT produced
 * here), routes it per the §2.3 category boundary:
 *
 *   task_quality | outreach_welcome  →  global EWMA + alignment_log
 *   belief_validation                →  alignment_log + per-belief validationHistory
 *   outreach_welcome (belief-bound)  →  BOTH (global EWMA + per-belief track record)
 *
 * Drives belief activation per spec-delta #7:
 *   proposed + confirmed → activateBelief  (climbs the trust ladder, ≤20 cap)
 *   proposed + rejected  → retireBelief
 *   proposed + corrected → retireBelief     (see applyActivationPolicy)
 *   active               → recordValidation only, no re-cap
 *
 * SELECTION (what the operator is actually asked): only PROPOSED beliefs whose
 * `domain` is about the operator himself, that have never been asked before,
 * strongest-first. See `SURVEYABLE_DOMAINS` and `pendingSurvey` for the why —
 * the short version is that asking someone to validate claims about the agent's
 * own internals produces agreement, not signal.
 *
 * IDEMPOTENCY (spec-delta #5 / T4's flag):
 * The verdict's own `at` (if supplied) is used as the stable timestamp anchor
 * for the alignment_log row id, the log `at`, and the BeliefValidation `at`.
 * Falls back to clock.nowMs() only when no stable timestamp is provided.
 *
 * Two distinct guarantees, of different strength:
 *
 *   (1) COMPLETED-VERDICT REPLAY (the common case — a UI/cron re-delivers a
 *       verdict that fully processed last time): the pre-existing-log-row guard
 *       short-circuits the whole block, so the EWMA, validationHistory, and log
 *       are each touched exactly once. (append's INSERT OR IGNORE and
 *       recordValidation's (at,verdict,via) dedup also self-guard as a backstop.)
 *
 *   (2) PARTIAL-WRITE THEN RETRY (a crash mid-block): writes are LOG-FIRST —
 *       the log row (the declared source of truth, foldable by rebuildState) is
 *       appended with `ewmaAfter` BEFORE the setEwma cache update. So a crash
 *       after the log-append but before setEwma is a *recoverable under-count*:
 *       rebuildState() restores the EWMA from the log. This is at-most-once on
 *       the EWMA cache, recoverable via rebuildState — NOT "moved exactly once
 *       under all faults". A crash BEFORE the log-append leaves no sentinel; a
 *       retry then re-runs cleanly (correct). True single-tx atomicity across
 *       the two stores remains a documented follow-on (spec-delta #5).
 *
 * DEVIATION FROM PLAN (Task 5): The plan's processVerdict used a fresh
 * clock.nowMs() for `at`, which breaks idempotency — the EWMA would move twice
 * on replay with a real clock (ClockTest masks it; the real clock does not).
 * Fixed here by: (1) anchoring `at` to `v.at ?? clock.nowMs()`, (2) a
 * pre-existing-log-row guard before any write, and (3) LOG-FIRST write ordering
 * so a partial write degrades to a recoverable under-count rather than an
 * unrecoverable double-count. `SurveyVerdict` gains an optional `at` field
 * (backward-compatible).
 */
import { Context, Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { BeliefWriter } from "../beliefs/belief-writer.js"
import type { BeliefValidation, BeliefVerdict } from "../beliefs/types.js"
import { readBelief } from "../beliefs/types.js"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryBackendError } from "../errors.js"
import { AlignmentStore } from "./alignment-store.js"
import { updateEwma, nextSurveyAt, signalValueForVerdict } from "./cadence.js"
import { rankByStrength } from "../beliefs/scoring.js"
import { AlignmentError, EWMA_ELIGIBLE } from "./types.js"
import type { AlignmentSignal, PendingSurvey, SurveyItem, SurveyVerdict } from "./types.js"

/**
 * Pure router: a verdict → the typed signal(s) it produces. task_quality and
 * outreach_welcome feed the EWMA; belief_validation and outreach_welcome feed
 * the per-belief track record. (outreach_welcome feeds BOTH — §2.3.)
 */
export function signalsForVerdict(v: SurveyVerdict): ReadonlyArray<AlignmentSignal> {
  const value = signalValueForVerdict({
    ...(v.verdict !== undefined ? { verdict: v.verdict } : {}),
    ...(v.score !== undefined ? { score: v.score } : {}),
  })
  const sig: AlignmentSignal = {
    kind: v.kind,
    value,
    ref: v.ref,
    via: v.via,
    ...(v.beliefId !== undefined ? { beliefId: v.beliefId } : {}),
    ...(v.verdict !== undefined ? { verdict: v.verdict } : {}),
  }
  return [sig]
}

export interface SurveyApi {
  readonly processVerdict: (v: SurveyVerdict) => Effect.Effect<void, AlignmentError | MemoryBackendError>
  readonly nextSurvey: (lastSurveyAt: number) => Effect.Effect<number, AlignmentError>
  /**
   * Decide whether a survey is due (now ≥ lastSurveyAt + cadence interval) and,
   * if so, source its items: ALWAYS one task_quality item (D-LOCK-2 precondition)
   * + up to 3 PROPOSED beliefs (D-LOCK-3). Returns null when not due.
   * The `issuedAt` is the idempotency anchor stamped onto every verdict (D-LOCK-5).
   */
  readonly pendingSurvey: (now: number) => Effect.Effect<PendingSurvey | null, AlignmentError | MemoryBackendError>
}

export class Survey extends Context.Service<Survey, SurveyApi>()("luna/Survey") {
  static readonly Default = Layer.effect(
    Survey,
    Effect.gen(function* () {
      const store = yield* AlignmentStore
      const writer = yield* BeliefWriter
      const clock = yield* Clock
      const mem = yield* MemoryRouterTag

      const applyActivationPolicy = (beliefId: string, verdict: BeliefVerdict) =>
        Effect.gen(function* () {
          const rec = yield* mem.get(beliefId)
          if (rec === null) return
          const status = readBelief(rec).status
          if (status !== "proposed") return // active/retired → recordValidation only, no ladder action
          if (verdict === "confirmed") {
            yield* writer.activateBelief(beliefId) // climbs the ladder (≤20 cap + eviction)
          } else if (verdict === "rejected" || verdict === "corrected") {
            // `corrected` retires too. It USED to leave the belief `proposed`,
            // "awaiting Dream's re-proposal with the fix" — but no such path
            // exists: the dream is never shown belief text, so it cannot know a
            // belief was corrected, let alone re-propose it amended. The belief
            // therefore stayed proposed and was re-selected, UNCHANGED, at the
            // next survey. Live data shows the result: a belief marked
            // `corrected`, re-asked, and then `confirmed` on the second pass —
            // the operator wearing down rather than the system learning.
            //
            // Retiring is honest and lossless: the record and its full
            // validationHistory persist for audit, nothing re-surfaces
            // unchanged, and if the underlying fact is still true the dream
            // re-derives it from new sessions on its own evidence.
            yield* writer.retireBelief(beliefId)
          }
        })

      const processVerdict = (v: SurveyVerdict) =>
        Effect.gen(function* () {
          // Stable timestamp anchor for idempotency (spec-delta #5).
          // If the verdict carries its own `at`, use it (enables replay-safe retries).
          // Otherwise fall back to the current clock (new, unreplayed event).
          const at = v.at !== undefined ? v.at : (yield* clock.nowMs())

          for (const sig of signalsForVerdict(v)) {
            // belief_validation MUST be belief-bound (it gates a per-belief action).
            // A belief_validation verdict with no beliefId is a malformed input — fail
            // loudly rather than silently logging a signal that touches no belief.
            // (task_quality is legitimately belief-less; outreach_welcome with no
            //  beliefId is a global-only signal and falls through to the EWMA path.)
            if (sig.kind === "belief_validation" && sig.beliefId === undefined) {
              return yield* Effect.fail(
                new AlignmentError({
                  op: "processVerdict",
                  message: "belief_validation verdict has no beliefId (cannot route to a belief track record)",
                }),
              )
            }

            // IDEMPOTENCY GUARD: check if this exact (ref, signalKind, at) was already
            // logged. The log row is the sentinel (written FIRST below), so its presence
            // means this verdict already fully processed — skip the entire block.
            // This prevents EWMA from moving twice on a retried verdict — the bug the
            // plan's fresh-clock approach would introduce with a real (non-Test) clock.
            const existing = yield* store.list({ signalKind: sig.kind, since: at })
            const alreadyProcessed = existing.some((r) => r.ref === sig.ref && r.at === at)
            if (alreadyProcessed) continue

            // Compute the new EWMA value WITHOUT committing the cache yet — ONLY for
            // EWMA-eligible kinds (category boundary §2.3; belief_validation excluded).
            let ewmaAfter: number | null = null
            if (EWMA_ELIGIBLE.has(sig.kind)) {
              const prev = yield* store.getEwma
              ewmaAfter = updateEwma(prev, sig.value)
            }

            // (a) LOG-FIRST: append the ledger row (the declared source of truth,
            // foldable by rebuildState) BEFORE the EWMA cache update. A crash after
            // this append but before setEwma is a recoverable under-count
            // (rebuildState restores the cache from the log); a crash before it leaves
            // no sentinel so a retry re-runs cleanly. Idempotent via INSERT OR IGNORE
            // on deterministic id (ref, signalKind, at). scoreDelta stores the
            // normalized signal value [0,1]; the EWMA does the smoothing.
            yield* store.append({
              at,
              signalKind: sig.kind,
              scoreDelta: sig.value,
              ewmaAfter,
              ref: sig.ref,
            })

            // (b) Commit the EWMA cache (forward-only fast path; the log above is the
            // recovery source if this never lands).
            if (ewmaAfter !== null) {
              yield* store.setEwma(ewmaAfter)
            }

            // (c) Per-belief track record — for belief-bound signals
            // (belief_validation always; outreach_welcome when beliefId is present).
            if (sig.beliefId !== undefined && sig.verdict !== undefined) {
              const validation: BeliefValidation = { at, verdict: sig.verdict, via: sig.via }
              yield* writer.recordValidation(sig.beliefId, validation)
              yield* applyActivationPolicy(sig.beliefId, sig.verdict)
            }
          }
        })

      const nextSurvey = (lastSurveyAt: number) =>
        store.getEwma.pipe(Effect.map((ewma) => nextSurveyAt(ewma, lastSurveyAt)))

      const BELIEFS_PER_SURVEY = 3 // D-LOCK-3

      /**
       * The domains whose subject is the OPERATOR, and which he is therefore the
       * only correct authority on. Everything else the dream writes is about the
       * agent's own machinery, where the operator has no vantage point and the
       * right validator is evidence, not a modal.
       *
       * Allow-list, not deny-list, on purpose: `domain` is a free-form string
       * the dream model invents per op (no enum in the schema, validated only as
       * a non-empty string), so a deny-list would leak every label the model
       * decides to coin next. Anything unrecognised is simply not surveyed.
       *
       * Live distribution over the 60 most recent beliefs:
       *   user 20, infrastructure 29, process 6, system 4, engineering 1.
       */
      const SURVEYABLE_DOMAINS: ReadonlySet<string> = new Set(["user", "process"])
      const TASK_QUALITY_PROMPT = "How aligned have I been with what you wanted lately?"

      const pendingSurvey = (now: number) =>
        Effect.gen(function* () {
          const lastSurveyAt = yield* store.getLastSurveyAt
          // COLD START (§2.4 "boots dormant → surveys daily" = first contact is
          // DUE, not epoch + 1 day). lastSurveyAt === 0 reliably means "never
          // surveyed" — any real survey writes a task_quality row with at > 0.
          // Without this guard, dueAt = nextSurveyAt(0, 0) = MIN_INTERVAL_DAYS*DAY =
          // 86_400_000, so the first survey would not fire until now ≥ 1 day
          // (epoch), which is wrong AND makes synthetic-clock tests (small `now`)
          // never due. Treat lastSurveyAt === 0 as immediately due.
          if (lastSurveyAt !== 0) {
            const dueAt = yield* nextSurvey(lastSurveyAt)
            if (now < dueAt) return null
          }

          // ALWAYS one task_quality item (D-LOCK-2 precondition / D-LOCK-4 scale).
          // ref = "task_quality" (a stable, belief-less ref); the TUI maps a 1–5
          // Likert to score = (n-1)/4.
          const taskItem: SurveyItem = {
            id: `sq-${now}`,
            kind: "task_quality",
            prompt: TASK_QUALITY_PROMPT,
            ref: "task_quality",
          }

          // Up to 3 PROPOSED beliefs (D-LOCK-3). Overflow rolls to next survey.
          //
          // WHAT CHANGED AND WHY. This used to be `proposed.slice(0, 3)` in raw
          // store order: unsorted, unfiltered, every domain. The operator's
          // report was that he could not tell what most items even were, so he
          // agreed with all of them. That is the worst possible outcome — a
          // validation loop that rubber-stamps does not merely fail to produce
          // signal, it manufactures false confidence and then feeds it into
          // every system prompt via the trust ladder.
          //
          // Measured cause, over the 60 most recent beliefs: only 20 were about
          // the operator. The other 40 were the agent's own findings
          // (infrastructure 29, process 6, system 4, engineering 1) — bun:sqlite
          // behaviour, PR pipelines, cron internals. Nobody can validate a claim
          // about a subsystem's internals from three seconds and a modal, and it
          // was never reasonable to ask.
          //
          // Three filters, in order:
          const beliefItems: ReadonlyArray<SurveyItem> = rankByStrength(
            (yield* writer.listByStatus("proposed"))
              // 1. SUBJECT. Only ask about claims whose subject is the operator:
              //    his preferences, his circumstances, his rules. `domain` is
              //    model-assigned free text, so this is a deliberate allow-list
              //    (unknown/new domain values are NOT surveyed) rather than a
              //    deny-list that a newly-invented label could slip through.
              .filter((rec) => SURVEYABLE_DOMAINS.has(readBelief(rec).domain))
              // 2. ASKED-ONCE. Never re-ask a belief that already carries a
              //    verdict. Combined with the corrected→retire change above,
              //    this closes the re-ask loop completely: one question, one
              //    answer, one outcome.
              //    `readBelief` is a cast, so an older record may carry no
              //    history array at all; treat that as "never asked".
              .filter((rec) => (readBelief(rec).validationHistory ?? []).length === 0),
            now,
          )
            // 3. STRONGEST FIRST. Ask the highest-strength candidates rather
            //    than whatever the store happened to return first, so a limited
            //    number of questions buys the most signal.
            .slice(0, BELIEFS_PER_SURVEY)
            .map((rec) => ({
              id: `bv-${rec.id}-${now}`,
              kind: "belief_validation" as const,
              // Prefer the plain-English rewrite; fall back to the full
              // statement. The fallback is the honest failure mode: a long,
              // precise question is worse to read but never misrepresents the
              // belief, which a truncation would.
              prompt: readBelief(rec).question ?? readBelief(rec).statement,
              ref: rec.id,
              beliefId: rec.id,
            }))

          return { issuedAt: now, items: [taskItem, ...beliefItems] } satisfies PendingSurvey
        })

      return { processVerdict, nextSurvey, pendingSurvey } satisfies SurveyApi
    }),
  )
}
