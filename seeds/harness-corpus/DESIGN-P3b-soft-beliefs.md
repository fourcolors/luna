# P3b — Two-class soft-belief memory (design, not yet built)

**Status: design / decision-pending. No code written. Advisor-reviewed 2026-06-14.**

P3b was scoped as "hard facts become probes/checks; soft beliefs become
confidence-scored records that DECAY over time and DOWNGRADE on contradiction."
An advisor pass against the live codebase changed the picture materially, so this
is captured as a design doc rather than a build. **Do not build a belief store in
the corpus** — see Risk 1.

## Finding: P3b is ~70% already built in Luna

The soft-belief half is **not greenfield**. It lives in `packages/core/src/beliefs/`
and `packages/core/src/alignment/`:

- **Belief store** — beliefs are `kind:"belief"` MemoryRecords in the `operator`
  namespace, with `BeliefContent.{confidence, status, validationHistory}`
  (`beliefs/types.ts`). The Dream reasoner only *proposes* them
  (`belief_candidate` ops); the lifecycle lives in `beliefs/`.
- **"Phase 3 activation" is partially shipped, not a future unknown.**
  `alignment/survey.ts` (`applyActivationPolicy`) already runs the trust ladder:
  a `confirmed` survey verdict calls `belief-writer.activateBelief`
  (proposed→active, ≤20-cap, weakest-first eviction); `rejected`→retire;
  `corrected`→stays proposed.
- **Decay already exists — as recency-weighting, not confidence-mutation.**
  `beliefs/scoring.ts`: `beliefStrength = confidence × recencyFactor ×
  validationFactor`, recency decaying linearly over a ~90-day horizon (floor 0.1),
  and `validationFactor` already **downgrades** strength on `corrected`/`rejected`.
  Strength drives ranking + eviction.
- **`memory_contradiction` is deliberately inert** (`DREAM_OP_TRAITS…materialize:false`),
  sequenced by spec §7 step 3 to begin auto-applying "under the alignment governor"
  *after* the survey/read-path exists. A known, ordered gap — not an oversight.

## The binding constraint: a HARD measure-only firewall

`alignment/calibration.feature.md`, `tier-classifier.feature.md`, and
`dream/sample-agreement.feature.md` all repeat one invariant: computed confidence
signals (calibration, sampled confidence, tier) are **write-only** and may **never**
be read back into scoring / injection / activation / belief strength. The whole
calibration program is collecting ECE data *before* any computed signal is allowed
to change behavior. A time-decay that rewrites `BeliefContent.confidence` is exactly
the class of change this firewall defers.

## Risks (why the naive build is wrong)

1. **Duplicating belief state** — a separate decaying-belief layer in the corpus
   would be a second source of truth for "what Luna believes about Operator." The
   corpus (git + shell) has no access to `BeliefWriter`, so it *necessarily*
   duplicates the store. Highest blast radius. **Avoid.**
2. **Breaching the measure-only firewall** — letting decay/contradiction rewrite
   `confidence` and feed injection re-gates behavior from an uncalibrated signal
   and corrupts the ECE comparison the program exists to produce.
3. **Double-counting decay** — adding confidence-decay on top of the existing
   `recencyFactor` penalizes old beliefs twice and shifts the eviction horizon.

## Recommended path (advisor verdict: MODIFY → defer-then-extend)

1. **Reframe the two classes around what exists.** Soft beliefs = the existing
   `kind:"belief"` records. Hard facts = corpus probes. The only genuinely
   greenfield, corpus-appropriate piece is **routing at proposal time**: when a
   Dream `belief_candidate` is a hard, checkable fact, emit a *probe* to the
   corpus instead of (or alongside) a belief.
2. **Do NOT add confidence-mutating decay.** Either tune the existing
   `STALE_HORIZON_DAYS` / `RECENCY_FLOOR` in `scoring.ts` (decays *strength*, not
   `confidence`), or — if decay-of-confidence is truly wanted — compute it
   write-only into `calibration_log` and validate ECE before promoting to behavior,
   behind the same gate as every other computed signal.
3. **For contradiction-downgrade, activate the path already designed** (spec §7
   step 3): when a contradiction is confirmed via survey, route it through
   `BeliefWriter` by recording a `corrected`/`rejected` `BeliefValidation`, which
   already downgrades strength via `validationFactor`. Reuse, don't reinvent.

## Two questions for the operator before any P3b code

1. **Does P3b's decay/downgrade get to touch `BeliefContent.confidence` / prompt
   injection, or does it stay measure-only behind `calibration_log`?** This is the
   same decision the calibration program deferred — P3b is where it comes due. A
   genuine human call.
2. **What is the corpus↔belief routing contract** for "hard vs soft" at proposal
   time, given the corpus has no access to `BeliefWriter`?

## Recommendation to the epic

Keep P3a (mutation-gating, shipped). Treat P3b as its **own** effort, comparable in
size to the Phase-3 live-wiring plan already in `docs/superpowers/plans/`, gated on
answering the two questions above. The one-day P3 estimate covered P3a; P3b is not
a one-day build, and the corpus is the wrong home for it.

### Reading list (before writing any P3b code)
- `packages/core/src/beliefs/scoring.ts` — the decay/downgrade that already exists
- `packages/core/src/beliefs/belief-writer.ts` — activation + validation lifecycle
- `packages/core/src/alignment/survey.ts` — the live activation ladder
- `packages/core/src/alignment/calibration.feature.md` + `dream/sample-agreement.feature.md` — the firewall
- spec §7 step 3, `docs/superpowers/specs/2026-05-28-luna-alignment-loop-design.md` — contradiction-activation sequencing
