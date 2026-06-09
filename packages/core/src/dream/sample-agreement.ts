// packages/core/src/dream/sample-agreement.ts
//
// Slice B — SAMPLING-BASED CONFIDENCE, MEASURE-ONLY.
//
// PURE + TOTAL agreement fraction over N reasoning passes. Given the belief
// candidates produced by each of N (unseeded → naturally varying) passes,
// cluster them by `beliefId` (= deriveBeliefId(domain, statement)) and report,
// per belief, the fraction of passes whose candidate set CONTAINS it.
//
// This is a SelfCheckGPT-style agreement signal. It is logged ALONGSIDE the
// verbalized Dream confidence for offline ECE comparison — it is NEVER
// substituted into the materialized belief's confidence (that would change
// belief strength = confidence × recency × validation, i.e. behavior). See the
// HARD MEASURE-ONLY invariants in dream.ts / the Slice B contract.
//
// No Effect / Clock / SDK imports — this is a synchronous, dependency-free pure
// function so its unit test's RED reason ("module missing") is unambiguous.

/** Per-belief sampling agreement. */
export interface AgreementResult {
  /** (# passes CONTAINING this beliefId) / passes.length, in [0,1]. */
  readonly sampledConfidence: number
  /** The effective sample size N = passes.length. Uniform across all beliefs. */
  readonly sampleCount: number
}

/**
 * Compute the per-belief sampling agreement over N passes.
 *
 * A "pass" is the list of belief candidates one reasoning sample produced; only
 * each candidate's `beliefId` matters here (clustering already happened by the
 * caller deriving the id). For each beliefId present in ANY pass:
 *   - `sampledConfidence` = (count of passes that CONTAIN it) / passes.length
 *   - `sampleCount`       = passes.length  (uniform — the effective N)
 *
 * Semantics (load-bearing, pinned by fixtures):
 *   - WITHIN-PASS DEDUP: a beliefId appearing twice in ONE pass counts as ONE
 *     pass containing it (a `Set` per pass), e.g. [[A,A],[B]] → A=0.5 (NOT 1.0).
 *   - EMPTY INPUT: passes.length === 0 → EMPTY map (never divides by zero).
 *   - An empty-but-present pass still counts toward the denominator (e.g.
 *     [[X],[],[]] → X = 1/3) but contributes no ids.
 *
 * PURE + TOTAL: no I/O, no throws, deterministic.
 */
export const computeAgreement = (
  passes: ReadonlyArray<ReadonlyArray<{ readonly beliefId: string }>>,
): Map<string, AgreementResult> => {
  const out = new Map<string, AgreementResult>()
  const n = passes.length
  if (n === 0) return out // never divide by zero

  // Count, per beliefId, how many passes CONTAIN it (deduped within a pass).
  const containCount = new Map<string, number>()
  for (const pass of passes) {
    const seen = new Set<string>()
    for (const cand of pass) seen.add(cand.beliefId) // within-pass dedup
    for (const id of seen) {
      containCount.set(id, (containCount.get(id) ?? 0) + 1)
    }
  }

  for (const [id, count] of containCount) {
    out.set(id, { sampledConfidence: count / n, sampleCount: n })
  }
  return out
}
