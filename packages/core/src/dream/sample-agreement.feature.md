# Feature: Sampling-based confidence (SelfCheckGPT-style agreement) — Slice B

> **MEASURE-ONLY.** This slice computes a *second*, sampling-derived confidence
> for each proposed belief and LOGS it alongside the existing verbalized
> confidence — for later ECE comparison. It changes **NO behavior**. Belief
> strength (`confidence × recency × validation`, used by `beliefs/scoring.ts` +
> `beliefs/inject.ts` for ranking/injection) is driven by the verbalized
> `BeliefContent.confidence`, which stays **byte-identical** to pre-Slice-B.

## Why

Slice A logs the model's **verbalized** confidence (the `0..1` it reports in a
`belief_candidate` op) to `calibration_log` with `sampleCount=1`. Verbalized
confidence is a poor calibration signal. A cheap, well-studied alternative is
**sampling agreement** (SelfCheckGPT): run the same reasoning turn N times at the
API's default temperature (the calls are UNSEEDED, so they vary — no SDK sampling
knob exists or is needed) and measure how often the same belief recurs across the
N independent passes. High recurrence ⇒ the model is "sure"; low recurrence ⇒ a
one-off hallucination. We log that agreement number to compare its ECE against
verbalized confidence's ECE — *without* letting it touch behavior yet.

## ⚠️ The trap (DO NOT fall in)

Substituting the sampled confidence INTO `BeliefContent.confidence` **changes
behavior** (it would re-rank/re-gate injection). That is NOT measure-only. The
sampled value goes **only** into `calibration_log` as a NEW nullable column
`sampled_confidence`. The materialized belief, its confidence, and *which*
beliefs are proposed must be byte-identical to today: **only PASS 1's ops
materialize.**

---

## Rule: PASS 1 is privileged — only it materializes (behavior byte-identical)

The N passes are NOT symmetric. **Pass 1 is "today's path": issued FIRST and
SEQUENTIALLY, and it ALONE materializes — EXACTLY as in Slice A.** Passes 2..N
are best-effort measurement extras whose ONLY product is the agreement count;
they run AFTER pass 1 and MAY be concurrent (`Effect` concurrency) with each
other. Concurrency MUST NOT be applied to pass 1 — agreement is order-independent
(a count over all passes), but *which* result is pass 1 must be deterministic so
the materialized belief stays byte-identical.

### Scenario: a single sampling run proposes one belief

- **Given** a Dream reasoner with sampling enabled (`N = 5`)
- And a (fake) SDK whose **first** call proposes belief `X` at verbalized
  confidence `0.85`
- And whose calls 2..5 propose `X` (in 3 of the 4 extra passes) plus assorted
  noise, with VARYING verbalized confidences and whitespace/case variants of
  `X`'s statement
- **When** the reasoner runs
- **Then** exactly the **pass-1** ops materialize — the materialized belief is
  `X` and its `BeliefContent.confidence` is `0.85` (the pass-1 verbalized value,
  NOT the sampled value)
- And the N-loop does NOT multiply materialized beliefs (one `X`, not five)
- And each pass-1 `belief_candidate` op carries `sampledConfidence` and
  `sampleCount` metadata for logging.

### Scenario: behavior-identical to single-pass

- **Given** the same pass-1 result fed through (a) sampling OFF / single pass and
  (b) sampling ON
- **Then** the materialized belief and its `confidence` are identical between the
  two — sampling only ADDS the logged number; it never substitutes.

---

## Rule: agreement = fraction of passes whose candidate set contains the belief

`sampledConfidence(b) = (# passes whose candidate set contains a candidate with
the SAME deriveBeliefId as b) / N`, where `N = passes.length`. `sampleCount = N`.

Clustering is by `deriveBeliefId(domain, statement)` (the deterministic
domain + normalized-statement FNV hash, `beliefs/types.ts:51-54`) — so a
whitespace/case variant of the same statement counts as the SAME belief.

### Scenario: 4 of 5 passes agree

- **Given** 5 passes, of which 4 contain belief `X` and 1 does not
- **Then** `sampledConfidence(X) = 4 / 5 = 0.8` and `sampleCount = 5`.

### Scenario: 1 of 5 passes (a one-off)

- **Given** 5 passes, of which only 1 contains belief `Y`
- **Then** `sampledConfidence(Y) = 1 / 5 = 0.2` and `sampleCount = 5`.

### Scenario: a belief appearing twice in ONE pass counts once for that pass

- **Given** pass 1 = `[A, A]` and pass 2 = `[B]`
- **Then** `sampledConfidence(A) = 1 / 2 = 0.5` (A's two occurrences in pass 1
  collapse to one **pass** that contains A), and `sampledConfidence(B) = 0.5`,
  `sampleCount = 2`.
- This discriminates the correct "passes containing" semantics from a naive
  occurrence counter (which would wrongly give `A = 1.0`).

### Scenario: no passes

- **Given** `passes = []` (effective sample count 0)
- **Then** `computeAgreement([])` returns an EMPTY map — never a divide-by-zero.

---

## Rule: resilience — extra-pass failures degrade, pass-1 failures are unchanged

- A **pass-1** failure (timeout / parse / SDK error) behaves EXACTLY as today's
  single-pass Slice-A failure — no new failure modes, the whole `reason` fails
  with the same `DreamError`.
- An **extra-pass (2..N)** failure is SKIPPED: it lowers the *effective* sample
  count (`sampleCount` = number of passes that actually produced candidates),
  and never fails the turn.

---

## Rule: `sampled_confidence` is write-only (HARD measure-only invariant)

- `sampled_confidence` is a NEW nullable column in `calibration_log`
  (migration `calibration` → v3; old rows tolerate NULL). The existing
  `confidence` column STAYS the verbalized value, for side-by-side comparison.
- It is **NEVER** read back into scoring / injection / cadence / activation /
  belief strength / `MATERIALIZE_OPS`. It exists solely to compute an ECE delta
  offline.

---

## Out of scope

- Substituting sampled confidence into belief strength (the trap).
- Reading `sampled_confidence` into any behavioral path.
- SDK temperature/seed knobs (none exist; default-temperature unseeded variation
  is the sampling source).
