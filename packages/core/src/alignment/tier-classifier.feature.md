# Feature: Tier classifier (Slice 3 — MEASURE-ONLY)

A PURE, TOTAL function that classifies a proposed change into an autonomy **tier**
from `(effective-reversibility, stakes, calibrated-confidence)`, where
`effective-reversibility = detectability × revertability`.

Tier meaning (lower = safer):

| Tier | Meaning                              |
|------|--------------------------------------|
| 0    | auto-apply-eligible (safest)         |
| 1    | provisional / async                  |
| 2    | blocking confirm                     |

**HARD invariant (mirror `calibration.feature.md` §HARD):** this is pure,
WRITE-ONLY instrumentation. The classifier output (the recorded `tier`) is
**measure-only**. It may **NEVER gate** a dream turn and may **NEVER be read
back** into `scoring.ts` / `inject.ts` / `cadence.ts` / activation /
`MATERIALIZE_OPS` / belief strength. We record it to learn whether the tier
boundaries are sane BEFORE any code is ever allowed to branch on them. Anything
that reads `tier` back into behavior is a HARD violation, not a feature.

---

## Signal honesty (the inputs are placeholders — do NOT pretend otherwise)

`classifyTier` takes four `0..1` numbers (one nullable) and is agnostic to how
they were produced. Today, none of these inputs is a "real" calibrated signal:

- **confidence** — TODAY this is the **verbalized placeholder** the Dream
  reasoner emits (Slice A). Slice B will make it sampling-based. The classifier
  takes a `0..1` number and does NOT care how it was produced.
- **detectability** — from `dream.ts` `detectabilityFor()` heuristic
  (`belief_candidate → 1`, else `0`). **PLACEHOLDER.**
- **revertability** — NO score exists in the codebase today. We add a
  **DOCUMENTED placeholder heuristic** `revertabilityFor(opKind, materialized)`.
  **DECISION NEEDING CONFIRMATION** (see below).
- **stakes** — NO signal exists anywhere in the codebase. The classifier input
  is `stakes: number | null`; `null` = unknown. At the dream.ts hook we pass
  `stakes = null` because there is nothing to measure yet. **FLAG.**

---

## Decisions needing confirmation (FLAGGED — these are guesses, not gospel)

1. **Boundary constants** (named in `tier-classifier.ts`):
   - Tier 0 iff `confidence >= 0.8` AND `effRev >= 0.8` AND
     (`stakes === null` OR `stakes < 0.3`)
   - Tier 1 iff (NOT Tier 0) AND `confidence >= 0.5` AND `effRev >= 0.5` AND
     (`stakes === null` OR `stakes < 0.7`)
   - Tier 2 otherwise
   These thresholds (`0.8 / 0.5 / 0.3 / 0.7`) are first-guess defaults. They
   need calibration against recorded measure-only data before any of them is
   trusted.
2. **`revertabilityFor` heuristic** (placeholder):
   - a **materialized + revertable** op (`belief_candidate` / `memory_dedup`) → `0.9`
   - a **held `proposed`** op → `0.3`
   These two magic numbers are a guess; confirm against real revert-cost data.
3. **`stakes` is always `null` at the dream.ts hook** — there is no stakes signal
   anywhere, so we pass `null` (unknown). Treat any future non-null stakes as a
   new signal that must be designed, not invented here.
4. **Recording mechanism** = a nullable `tier` column on `calibration_log`
   (calibration migration bumped to **v2**: `ALTER TABLE … ADD COLUMN tier
   INTEGER`). Old rows tolerate `NULL`. Alternative (sibling write) was rejected
   as more surface for no benefit. Whatever the mechanism, NOTHING reads `tier`
   back.

---

## S1 — Tier 0 (auto-apply-eligible): safe + confident + low stakes

- **Given** `{ confidence: 0.9, detectability: 1, revertability: 0.9, stakes: 0.2 }`
  (effRev = 1 × 0.9 = 0.9 ≥ 0.8; confidence 0.9 ≥ 0.8; stakes 0.2 < 0.3)
- **When** I `classifyTier(i)`
- **Then** it returns **`0`**.

## S2 — Tier 1 (provisional): confident-enough + reversible-enough, stakes unknown

- **Given** `{ confidence: 0.6, detectability: 1, revertability: 0.7, stakes: null }`
  (effRev = 0.7; confidence 0.6 is `< 0.8` ⇒ not Tier 0 but `>= 0.5`; stakes null)
- **When** I `classifyTier(i)`
- **Then** it returns **`1`**.

## S3 — Tier 2 (low confidence drops it to blocking confirm)

- **Given** `{ confidence: 0.4, detectability: 1, revertability: 0.9, stakes: null }`
  (confidence 0.4 `< 0.5` ⇒ fails Tier 0 AND Tier 1, despite effRev 0.9)
- **When** I `classifyTier(i)`
- **Then** it returns **`2`**.

## S3b — Tier 2 (high stakes overrides high confidence + perfect reversibility)

- **Given** `{ confidence: 0.95, detectability: 1, revertability: 1, stakes: 0.8 }`
  (stakes 0.8 ≥ 0.7 ⇒ fails Tier 1's stakes gate, and ≥ 0.3 ⇒ fails Tier 0's)
- **When** I `classifyTier(i)`
- **Then** it returns **`2`** — a high-stakes change is never auto/provisional
  no matter how confident or reversible.

## S3c — Tier 2 (silent ⇒ effRev 0 ⇒ cannot be Tier 0/1)

- **Given** `{ confidence: 0.95, detectability: 0, revertability: 1, stakes: null }`
  (detectability 0 ⇒ effRev = 0 × 1 = 0 ⇒ fails both `effRev >= 0.8` and
  `effRev >= 0.5`)
- **When** I `classifyTier(i)`
- **Then** it returns **`2`**. This is the **"preferences gate because silent"**
  principle: an undetectable change can never be auto-applied or provisionally
  applied, regardless of confidence/revertability.

## S4 — purity / totality (never throws; clamps defensively)

- **Given** out-of-range / `NaN` inputs, e.g.
  `{ confidence: 2, detectability: -1, revertability: NaN, stakes: 5 }`
- **When** I `classifyTier(i)`
- **Then** it does NOT throw, and returns one of `0 | 1 | 2`. confidence/
  detectability/revertability/stakes are each clamped into `[0, 1]` and `NaN`
  is treated defensively (as the safe extreme). Here detectability `-1` clamps
  to `0` ⇒ effRev `0` ⇒ result is **`2`**.

---

## MEASURE-ONLY integration (the dream.ts hook records a tier, write-only)

- **Given** the SAME additive `dream.ts` `applyOps` hook where Slice A logs the
  calibration row (the `belief_candidate` branch), with a `CalibrationStore`
  (Memory layer) provided
- **When** a `belief_candidate` op is applied (confidence 0.6, detectability 1
  from the existing heuristic, `revertabilityFor(op.kind, true) = 0.9`,
  `stakes = null`)
- **Then** the recorded calibration row carries `tier === 1`
  (`classifyTier({confidence: 0.6, detectability: 1, revertability: 0.9,
  stakes: null})` → effRev 0.9, confidence 0.6 ⇒ Tier 1).
- **And** the write is additive + `Effect.ignore`d (a tier failure can NEVER
  alter a dream turn) and **nothing reads `tier` back** into behavior.
