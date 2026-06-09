# Feature: Calibration logging (Slice A — MEASURE-ONLY)

Record the EXISTING verbalized Dream confidence (placeholder) + a trivial
detectability heuristic into an append-only `calibration_log`, and compute an
Expected Calibration Error (ECE) over verdict-joined records.

**HARD invariant:** this is pure, write-only instrumentation. Nothing here may
ever be read back into scoring / injection / activation / cadence / belief
strength. ECE is measure-only; it NEVER gates or changes behavior.

Sampling-based confidence does NOT exist yet (deferred Slice B): the recorded
`confidence` is the verbalized 0..1 float the Dream reasoner already emits, and
`detectability` is a trivial heuristic over `DreamOpKind`. Do NOT fake sampling.

---

## S1 — record is append-only and idempotent

- **Given** a `CalibrationStore` (Memory layer)
- **When** I `record()` the SAME `(dreamId, targetId)` twice (id derives from
  those two fields only — `cal-<dreamId>-<targetId>`)
- **Then** `list()` returns exactly ONE row (second write is `INSERT OR IGNORE`d)
- **And** the FIRST write's fields (beliefId, proposalAt, confidence,
  detectability, sampleCount) are the ones persisted (first-write-wins).

## S2 — temporal join, not equijoin

Rule: for each survey verdict (`via='survey'`) on a belief, the verdict is
claimed by the LATEST calibration row whose `proposal_at < verdict.at` for that
`beliefId`. A re-proposal AFTER the verdict (`proposal_at > verdict.at`) is never
a candidate and must NOT steal the verdict.

- **Given** for one belief: proposal A @100, proposal B @150, and a survey
  verdict V @200
- **When** I `joinVerdicts([A, B], [V])`
- **Then** V joins B (the latest proposal before 200); A is unmatched.
- **And given** a re-proposal C @300 (after V) is added
- **Then** C is unmatched and does NOT steal V.
- **And** a verdict with `via='outreach'` is ignored (survey verdicts only).

## S3 — ECE never gates (>=30 joined records)

- **Given** >= 30 joined `{confidence, outcome}` records
- **When** I `calculateEce(records)`
- **Then** it returns a `number` in `[0, 1]` (it never throws, never gates).

## S4 — insufficient data sentinel (<30 joined records)

- **Given** fewer than 30 joined records (e.g. 29)
- **When** I `calculateEce(records)`
- **Then** it returns `null` (the not-enough-data sentinel) and does NOT throw.

## Pure ECE math (hand-computed fixture)

- **Given** 20 records at confidence 0.25 of which 10 have outcome 1
  (bin accuracy 0.50 → gap |0.25 − 0.50| = 0.25), AND 20 records at confidence
  0.75 of which 10 have outcome 1 (gap |0.75 − 0.50| = 0.25)
- **When** I `calculateEce(records)` (40 records ≥ 30)
- **Then** ECE = 0.5·0.25 + 0.5·0.25 = **0.25** (invariant to bin count M ≥ 2,
  since the two confidence groups never share a bin).
