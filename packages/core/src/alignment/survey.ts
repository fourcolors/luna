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
 *   proposed + corrected → stays proposed  (awaits Dream's re-proposal with the fix)
 *   active               → recordValidation only, no re-cap
 *
 * IDEMPOTENCY (spec-delta #5 / T4's flag):
 * The verdict's own `at` (if supplied) is used as the stable timestamp anchor
 * for the alignment_log row id, the log `at`, and the BeliefValidation `at`.
 * Retrying the same verdict with the same `at` hits:
 *   - AlignmentStore.append: INSERT OR IGNORE on deterministic id → no-op
 *   - BeliefWriter.recordValidation: dedup on (at, verdict, via) → no-op
 *   - EWMA update: guarded by the log idempotency check (skip if row already exists)
 * Falls back to clock.nowMs() only when no stable timestamp is provided.
 *
 * DEVIATION FROM PLAN (Task 5): The plan's processVerdict used a fresh
 * clock.nowMs() for `at`, which breaks idempotency — the EWMA would move twice
 * on replay with a real clock (ClockTest masks it; the real clock does not).
 * Fixed here by: (1) anchoring `at` to `v.at ?? clock.nowMs()` and (2) checking
 * for a pre-existing log row (same idempotency key) before executing EWMA + belief
 * updates. `SurveyVerdict` gains an optional `at` field (backward-compatible).
 */
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { BeliefWriter } from "../beliefs/belief-writer.js"
import type { BeliefValidation, BeliefVerdict } from "../beliefs/types.js"
import { readBelief } from "../beliefs/types.js"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryBackendError } from "../errors.js"
import { AlignmentStore } from "./alignment-store.js"
import { updateEwma, nextSurveyAt, signalValueForVerdict } from "./cadence.js"
import { AlignmentError, EWMA_ELIGIBLE } from "./types.js"
import type { AlignmentSignal, SurveyVerdict } from "./types.js"

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
}

export class Survey extends Effect.Tag("luna/Survey")<Survey, SurveyApi>() {
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
          } else if (verdict === "rejected") {
            yield* writer.retireBelief(beliefId)
          }
          // corrected → stays proposed (awaits Dream's re-proposal with the fix)
        })

      const processVerdict = (v: SurveyVerdict) =>
        Effect.gen(function* () {
          // Stable timestamp anchor for idempotency (spec-delta #5).
          // If the verdict carries its own `at`, use it (enables replay-safe retries).
          // Otherwise fall back to the current clock (new, unreplayed event).
          const at = v.at !== undefined ? v.at : (yield* clock.nowMs())

          for (const sig of signalsForVerdict(v)) {
            // IDEMPOTENCY GUARD: check if this exact (ref, signalKind, at) was already
            // logged. If so, all downstream ops (EWMA, recordValidation, append) would
            // also be no-ops (they key on `at`), so skip the entire block.
            // This prevents EWMA from moving twice on a retried verdict — the bug the
            // plan's fresh-clock approach would introduce with a real (non-Test) clock.
            const existing = yield* store.list({ signalKind: sig.kind, since: at })
            const alreadyProcessed = existing.some((r) => r.ref === sig.ref && r.at === at)
            if (alreadyProcessed) continue

            // (a) Global EWMA — ONLY for EWMA-eligible kinds (category boundary §2.3).
            // belief_validation is deliberately excluded here.
            let ewmaAfter: number | null = null
            if (EWMA_ELIGIBLE.has(sig.kind)) {
              const prev = yield* store.getEwma
              const next = updateEwma(prev, sig.value)
              yield* store.setEwma(next)
              ewmaAfter = next
            }

            // (b) Per-belief track record — for belief-bound signals.
            // belief_validation and outreach_welcome (when beliefId is present).
            if (sig.beliefId !== undefined && sig.verdict !== undefined) {
              const validation: BeliefValidation = { at, verdict: sig.verdict, via: sig.via }
              yield* writer.recordValidation(sig.beliefId, validation)
              yield* applyActivationPolicy(sig.beliefId, sig.verdict)
            }

            // (c) Always log to the ledger (audit/training corpus; idempotent via
            // INSERT OR IGNORE on deterministic id from (ref, signalKind, at)).
            // scoreDelta stores the normalized signal value [0,1]; the EWMA does
            // the smoothing, so a true delta is not needed here and would be derivable.
            yield* store.append({
              at,
              signalKind: sig.kind,
              scoreDelta: sig.value,
              ewmaAfter,
              ref: sig.ref,
            })
          }
        })

      const nextSurvey = (lastSurveyAt: number) =>
        store.getEwma.pipe(Effect.map((ewma) => nextSurveyAt(ewma, lastSurveyAt)))

      return { processVerdict, nextSurvey } satisfies SurveyApi
    }),
  )
}
