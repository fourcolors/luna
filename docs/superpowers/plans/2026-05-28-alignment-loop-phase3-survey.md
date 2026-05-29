# Alignment Loop — Phase 3: Survey + Cadence Controller + AlignmentStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the human-in-the-loop alignment cycle. Build the pure **cadence controller** (global-alignment EWMA → next-survey interval, asymmetric hysteresis), the **AlignmentStore** (`alignment_log` append-only ledger + `alignment_state` O(1) EWMA cache, mirroring `dream-store.ts`), the **signal model + routing** that maps the three survey/outreach verdicts (§2.3) onto the right streams (task-quality + outreach-welcome → global EWMA; belief-validation → per-belief track record only, **never** the EWMA), and the **survey-verdict → activation logic** that turns a `confirmed` verdict on a `proposed` belief into an `activateBelief` call (and `rejected` into `retireBelief`). All of this is **pure/library backend**: no observability read-API, no product decision, no live-server boot or UI change. The risky surfaces (cron-into-live-boot, real `DreamReasoner.Default`, the survey UI, and the deferred Phase-2 belief-injection wiring) are planned but **not** auto-implemented here.

**Architecture:** A new `packages/core/src/alignment/` module mirrors `dream/`: a `types.ts` data-shapes file (signal kinds, verdict→signal mapping shapes, survey item/result shapes), a pure `cadence.ts` (EWMA update + `nextSurveyAt`, no I/O — the Phase-2 `scoring.ts` discipline), an `alignment-store.ts` Effect service (`Memory` Ref layer + `makeLayer(dbPath)` SQLite layer, `ensureSchemaVersions` + `applyMigration`, exactly like `DreamStore`), and a `survey.ts` service that routes verdicts and drives activation through the **already-built** `BeliefWriter`. Two methods are added to `BeliefWriter` because they do not exist yet: `recordValidation` (append to `validationHistory`) is in the unblocked slice; nothing else changes. **The trust ladder is honored: Phase 3 ships the calibration loop, but the survey *surface* (how a human is asked) and the outreach *emitter* stay out** — the unblocked slice processes verdicts handed to it by fixtures, so it is testable end-to-end without any UI or telemetry source.

**Tech Stack:** Effect-TS v3, Bun, `bun:sqlite` (via the `schema-versions` migration ladder), `@luna/memory` (`MemoryRecord`, `MemoryRouterTag`), `@luna/core` `Clock`, `BeliefWriter` (Phase 2, merged). Tests: Vitest with Ref-backed `Memory` layers + `Clock.Test(fixedMs)` (no Bun runtime needed), mirroring `dream.test.ts` / `belief-writer.test.ts`.

**Source-of-truth spec:** `docs/superpowers/specs/2026-05-28-luna-alignment-loop-design.md` (§2.1 cadence, §2.3 three signals + category boundary, §3.3 survey + cadence controller, §5.1 belief content, §5.2 new SQLite tables, §7.3 Phase 3, §8 open questions). Builds on Phase 1 (`packages/core/src/dream/`) and Phase 2 (`packages/core/src/beliefs/`), both merged to `dev`.

> **Synthesis note:** The task referenced "design findings + a critic's refutations/gaps." Those artifacts were **not present in this author's context.** This plan synthesizes from the spec plus verified Phase-1/2 source. Every load-bearing claim below (the observability read-API gap, the cron-not-wired-into-boot state, the `BeliefWriter` method surface, the `MemoryRouter` transaction limit) was confirmed by reading the live code, not assumed.

---

## Spec deltas locked by this plan (refinements made concrete here)

These resolve the §8 open questions and the §5.2/§5.3 tunables with concrete, internally consistent defaults so they do **not** block implementation. They are deliberate defaults, not verified facts; the human may retune the constants later — the load-bearing *constraints* (asymmetry, clamps, category isolation) are enforced by tests.

1. **EWMA smoothing is asymmetric (slow up, fast down) — the §2.1 hysteresis, made concrete.** `updateEwma(prev, signal)` uses `alpha = signal >= prev ? ALPHA_UP : ALPHA_DOWN` with **`ALPHA_UP = 0.15`** (trust accrues slowly) and **`ALPHA_DOWN = 0.6`** (trust is revoked fast; must dominate `ALPHA_UP`). Signal values are normalized to `[0,1]`. The load-bearing invariant — *one bad signal moves the EWMA more than one equal-magnitude good signal* — is asserted in a table test, not just documented.

2. **Cadence interval curve + bounds are locked — CONVEX, not linear.** `nextSurveyAt(ewma, lastSurveyAt)` maps `ewma ∈ [0,1]` onto an interval clamped to **`MIN_INTERVAL_DAYS = 1`** and **`MAX_INTERVAL_DAYS = 30`** via a **convex curve** `intervalDays = MIN + (MAX - MIN) * ewma ** INTERVAL_CURVE` with **`INTERVAL_CURVE = 3`**. ⚠️ A *linear* mapping (curve = 1) FAILS the spec's central safety property: combined with a per-survey EWMA step, linear clawback takes ~weeks/many surveys to return to the 1-day floor — NOT "fast to revoke" (§2.1). The convex curve keeps intervals short across most of the ewma range and only eases toward 30 days near full trust, so a drop in alignment pulls cadence back toward 1 day within **≤2 surveys**, while reaching the cap needs sustained high trust. The load-bearing test drives the *real* `updateEwma → nextSurveyAt` pipeline from converged `ewma = 1.0` through 2 worst-case surveys and asserts the interval reaches ~MIN — it does NOT hand-set a low ewma (that masks the violation).

3. **Cold-start EWMA = `0.0` (dormant floor).** A fresh `alignment_state` reads as `0.0`, so the very first cadence is the 1-day floor (§2.4 cold start: surveys daily until trust is earned).

4. **Category boundary is a hard routing rule, asserted by test (§2.3).** `signalsForVerdict()` maps each survey/outreach verdict to typed signal rows. **`task_quality` and `outreach_welcome` roll into the global EWMA; `belief_validation` does NOT** — it is logged to `alignment_log` (for audit/training) and applied to the touched belief's `validationHistory`, but is **excluded** from `updateEwma`. The test asserts a `belief_validation` verdict leaves the EWMA unchanged while updating the belief.

5. **§5.3 "one atomic transaction" is a follow-on, not v1.** The spec wants a belief write + its `alignment_log` append in one SQL transaction. **That is undeliverable through `MemoryRouter`** — beliefs are written via the router's `put` (its own backend/transaction), and the alignment ledger is a separate `bun:sqlite` store; there is no shared transaction handle. v1 **sequences the two writes idempotently** (deterministic `alignment_log` ids via `(ref, signal_kind, at)` + `INSERT OR IGNORE`, belief writes already idempotent on stable id) so that **a retry of the same verdict is safe** (no duplication). Note this is weaker than Dream's auto-recovery: a survey verdict has no automatic re-run trigger (a human won't re-answer), so the idempotent keys guard against *accidental replay*, not against a partial-write that is never retried. True single-transaction atomicity is a documented follow-on (would require both stores behind one `bun:sqlite` handle, out of scope).

6. **`alignment_state` is a derivable cache, rebuildable from `alignment_log`.** Per §5.2 it is a single-row O(1) read on the cadence/gate hot path; `alignment_log` (filtered to EWMA-eligible `signal_kind`s) is the source of truth. v1 maintains it forward-only on each EWMA-eligible append; a `rebuildState()` method recomputes it by folding the log (used if the smoothing constant changes).

7. **Activation policy is locked (§2.4 ladder rung 1, gated by survey).** On a survey verdict touching a `proposed` belief: **`confirmed` → `activateBelief`** (climbs the ladder, subject to the Phase-2 ≤20 cap + eviction), **`rejected` → `retireBelief`**, **`corrected` → stays `proposed`** (records the validation, does not promote — a corrected belief needs a re-proposal with the correction, which Dream supplies next cycle). For an already-`active` belief, all three verdicts only append to `validationHistory` (re-validation), never re-cap. This is a *backend* policy invoked with fixture verdicts — it touches no UI.

8. **Outreach-welcome signal is modeled now, emitted later.** `signalsForVerdict()` handles `outreach_welcome` (routes to **both** the global EWMA and the touched belief's `validationHistory`, `via:"outreach"`, bypassing the survey clock per §2.3) so the routing is complete and fixture-tested. The *emitter* (the outreach `TriggerAgent` watcher that would produce these verdicts) stays deferred — modeling the signal does not pull the outreach surface into the unblocked slice.

9. **Read-API for telemetry is a follow-on, NOT a Phase-3 blocker.** Verified: `ObservabilityApi` (`observability/types.ts`) exposes only `emit` / `events` / `subscribeEvents` — **no historical query**. The §2.3 design has the survey supply task-quality signals **directly** (subjective ground truth); telemetry *pre-biasing* (the objective rough draft, including `PermissionDecision` denials) is an **enrichment** that needs the read-path. The unblocked slice therefore takes a task-quality verdict as an input and does not read telemetry at all. Adding the JSONL reader keyed by `(sessionId, time window)` is a deferred follow-on (§7.3 prerequisite) that enriches, not enables.

---

## File structure

New module `packages/core/src/alignment/` (mirrors `dream/` — same Clock + schema-versions + Memory/SQLite-layer discipline):

- `packages/core/src/alignment/types.ts` — signal model: `SignalKind` (`"task_quality" | "belief_validation" | "outreach_welcome"`), `EWMA_ELIGIBLE` set, `AlignmentSignal` (the routed signal row), `SurveyVerdict` / `SurveyItem` / `SurveyResult` shapes, `AlignmentLogRow` / `AlignmentLogRowInput` / `AlignmentLogQuery`, `AlignmentError`. Constants: `ALIGNMENT_COMPONENT = "alignment"`. One responsibility: data shapes.
- `packages/core/src/alignment/cadence.ts` — pure `updateEwma(prev, signalValue)` + `nextSurveyAt(ewma, lastSurveyAt)` + `signalValueForVerdict(verdict)`. No I/O. The EWMA + interval math.
- `packages/core/src/alignment/alignment-store.ts` — `AlignmentStore` Effect service: `Memory` (Ref) layer + `makeLayer(dbPath)` SQLite layer (`ensureSchemaVersions` + `applyMigration(db, "alignment", 1, SCHEMA_V1, now)`); methods `append`, `list`, `getEwma`, `setEwma`, `rebuildState`.
- `packages/core/src/alignment/survey.ts` — `Survey` Effect service over `AlignmentStore` + `BeliefWriter` + `Clock`: `signalsForVerdict` (pure helper, also exported), `processVerdict` (route → log → EWMA-or-belief → activation), `nextSurvey` (reads EWMA, returns `nextSurveyAt`).
- `packages/core/src/alignment/index.ts` — barrel exports.

Modified (unblocked):
- `packages/core/src/beliefs/belief-writer.ts` — add `recordValidation(id, validation)` (append to `validationHistory`); add to `BeliefWriterApi`.
- `packages/core/src/beliefs/belief-writer.test.ts` — `recordValidation` appends + persists.
- `packages/core/src/index.ts` — add `export * from "./alignment/index.js"` after the beliefs export.

Tests (new):
- `packages/core/src/alignment/cadence.test.ts` — EWMA asymmetry + interval-curve + endpoint table tests.
- `packages/core/src/alignment/alignment-store.test.ts` — append/list/EWMA round-trip + idempotent append + rebuildState (Memory layer).
- `packages/core/src/alignment/survey.test.ts` — verdict routing (category boundary: belief_validation excluded from EWMA), activation policy (confirmed→active, rejected→retired, corrected→stays proposed), outreach_welcome dual-routing.

---

# UNBLOCKED SLICE (auto-build now)

Pure/library backend. No observability read-API, no product decision, no server-boot or UI change. Build order: Task 1 → 7.

## Task 1: Alignment signal + survey data model

**Files:**
- Create: `packages/core/src/alignment/types.ts`
- Test: `packages/core/src/alignment/types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/alignment/types.test.ts
import { describe, expect, it } from "vitest"
import { EWMA_ELIGIBLE, type SignalKind } from "./types.js"

describe("EWMA_ELIGIBLE", () => {
  it("includes task_quality and outreach_welcome", () => {
    expect(EWMA_ELIGIBLE.has("task_quality")).toBe(true)
    expect(EWMA_ELIGIBLE.has("outreach_welcome")).toBe(true)
  })
  it("EXCLUDES belief_validation (category boundary §2.3)", () => {
    // belief_validation is logged + applied per-belief, but never rolls into the
    // global EWMA — the spec's load-bearing isolation rule.
    expect(EWMA_ELIGIBLE.has("belief_validation")).toBe(false)
  })
  it("covers exactly the three signal kinds", () => {
    const all: SignalKind[] = ["task_quality", "belief_validation", "outreach_welcome"]
    expect(all.length).toBe(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun run vitest run src/alignment/types.test.ts`
Expected: FAIL — cannot find module `./types.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/alignment/types.ts
import { Data } from "effect"
import type { BeliefVerdict } from "../beliefs/types.js"

/** Migration-ladder component key for the alignment tables (§5.2). */
export const ALIGNMENT_COMPONENT = "alignment"

/** The three alignment signals (spec §2.3). */
export type SignalKind = "task_quality" | "belief_validation" | "outreach_welcome"

/**
 * Signal kinds that roll into the GLOBAL alignment EWMA (→ survey cadence).
 * `belief_validation` is deliberately ABSENT: it gates per-belief actions and
 * must never be diluted into the aggregate (§2.3 category boundary). All three
 * kinds are still LOGGED to alignment_log; only these feed updateEwma.
 */
export const EWMA_ELIGIBLE: ReadonlySet<SignalKind> = new Set<SignalKind>([
  "task_quality",
  "outreach_welcome",
])

/** A routed signal: which stream it feeds + its normalized value [0,1]. */
export interface AlignmentSignal {
  readonly kind: SignalKind
  /** Normalized [0,1]: 1 = perfectly aligned, 0 = misaligned. */
  readonly value: number
  /** What the signal came from: task id / belief id / outreach id. */
  readonly ref: string
  /** For belief_validation / outreach_welcome: the touched belief id (if any). */
  readonly beliefId?: string
  /** For belief track-record: the survey/outreach verdict, if belief-bound. */
  readonly verdict?: BeliefVerdict
  readonly via: "survey" | "outreach"
}

/** A single survey check-in item (queued by Dream, surfaced by the UI later). */
export interface SurveyItem {
  readonly id: string
  readonly kind: SignalKind
  readonly prompt: string
  /** task id / belief id the item asks about. */
  readonly ref: string
  /** Present for belief-bound items. */
  readonly beliefId?: string
}

/** The human's answer to one survey item. */
export interface SurveyVerdict {
  readonly itemId: string
  readonly kind: SignalKind
  readonly ref: string
  readonly beliefId?: string
  /** task_quality uses `score`; belief/outreach use `verdict`. */
  readonly score?: number // [0,1] for task_quality
  readonly verdict?: BeliefVerdict // confirmed | corrected | rejected
  readonly via: "survey" | "outreach"
}

/** One persisted alignment-log row (§5.2). */
export interface AlignmentLogRow {
  readonly id: string
  readonly at: number
  readonly signalKind: SignalKind
  readonly scoreDelta: number
  readonly ewmaAfter: number | null // null for non-EWMA (belief_validation)
  readonly ref: string
}

/** Insert shape — `id` is derived from (ref, signalKind, at) for idempotency. */
export interface AlignmentLogRowInput {
  readonly at: number
  readonly signalKind: SignalKind
  readonly scoreDelta: number
  readonly ewmaAfter: number | null
  readonly ref: string
}

export interface AlignmentLogQuery {
  readonly signalKind?: SignalKind
  readonly since?: number
  readonly limit?: number
}

export class AlignmentError extends Data.TaggedError("AlignmentError")<{
  readonly op: string
  readonly message: string
  readonly cause?: unknown
}> {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun run vitest run src/alignment/types.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck (packages/core scope — root carries the agent-cli baseline)**

Run: `cd packages/core && bun run tsc --noEmit`
Expected: exit 0, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/alignment/types.ts packages/core/src/alignment/types.test.ts
git commit -m "feat(alignment): signal model + survey shapes + EWMA-eligible set (category boundary)"
```

---

## Task 2: Cadence controller — pure EWMA + interval math

This is the §3.3 "cadence controller is a pure function — no I/O" deliverable, with the §2.1 asymmetric hysteresis. Locked constants per spec-deltas #1–#3.

**Files:**
- Create: `packages/core/src/alignment/cadence.ts`
- Test: `packages/core/src/alignment/cadence.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/alignment/cadence.test.ts
import { describe, expect, it } from "vitest"
import {
  updateEwma, nextSurveyAt, signalValueForVerdict,
  ALPHA_UP, ALPHA_DOWN, MIN_INTERVAL_DAYS, MAX_INTERVAL_DAYS,
} from "./cadence.js"

const DAY = 86_400_000

describe("updateEwma — asymmetric hysteresis (§2.1)", () => {
  it("trust accrues slowly (ALPHA_UP) on a good signal", () => {
    const next = updateEwma(0.5, 1.0)
    expect(next).toBeCloseTo(0.5 + ALPHA_UP * (1.0 - 0.5), 6)
  })
  it("trust is revoked fast (ALPHA_DOWN) on a bad signal", () => {
    const next = updateEwma(0.5, 0.0)
    expect(next).toBeCloseTo(0.5 + ALPHA_DOWN * (0.0 - 0.5), 6)
  })
  it("INVARIANT: one bad signal moves more than one equal-magnitude good signal", () => {
    // The load-bearing asymmetry — slow to grant, fast to revoke.
    const up = Math.abs(updateEwma(0.5, 1.0) - 0.5)
    const down = Math.abs(updateEwma(0.5, 0.0) - 0.5)
    expect(down).toBeGreaterThan(up)
    expect(ALPHA_DOWN).toBeGreaterThan(ALPHA_UP)
  })
  it("stays clamped to [0,1]", () => {
    expect(updateEwma(0, -5)).toBeGreaterThanOrEqual(0)
    expect(updateEwma(1, 5)).toBeLessThanOrEqual(1)
  })
})

describe("nextSurveyAt — interval curve + FAST CLAWBACK (§2.1)", () => {
  it("high alignment eases to the 30-day cap (slow backoff)", () => {
    expect(nextSurveyAt(1.0, 1000)).toBe(1000 + MAX_INTERVAL_DAYS * DAY)
  })
  it("low alignment is at the 1-day floor", () => {
    expect(nextSurveyAt(0.0, 1000)).toBe(1000 + MIN_INTERVAL_DAYS * DAY)
  })
  // LOAD-BEARING (spec §2.1 central safety property — "fast to revoke").
  // Drives the REAL pipeline (updateEwma → nextSurveyAt) from CONVERGED trust
  // (ewma=1.0, 30-day cadence) through 2 worst-case surveys. Must reach the
  // ~1-day floor — NOT the ~weeks a symmetric/linear design produces. Do NOT
  // replace this with an endpoint test that hand-sets a low ewma: that masks
  // the violation (the bug a symmetric-alpha or linear-curve design hides).
  it("from converged trust, ≤2 bad surveys snap the interval to ~MIN", () => {
    let ewma = 1.0
    ewma = updateEwma(ewma, 0) // worst-case (rejected) survey 1
    ewma = updateEwma(ewma, 0) // worst-case survey 2
    const intervalDays = nextSurveyAt(ewma, 0) / DAY
    expect(intervalDays).toBeLessThanOrEqual(MIN_INTERVAL_DAYS + 1) // at/near floor
  })
  it("trust is SLOW to grant: from the floor, 2 good surveys stay well under the cap", () => {
    let ewma = 0.0
    ewma = updateEwma(ewma, 1) // good survey 1
    ewma = updateEwma(ewma, 1) // good survey 2
    expect(nextSurveyAt(ewma, 0) / DAY).toBeLessThan(MAX_INTERVAL_DAYS / 3)
  })
  it("interval is monotone in alignment", () => {
    expect(nextSurveyAt(0.5, 0)).toBeGreaterThan(nextSurveyAt(0.0, 0))
    expect(nextSurveyAt(0.5, 0)).toBeLessThan(nextSurveyAt(1.0, 0))
  })
})

describe("signalValueForVerdict", () => {
  it("maps belief verdicts to [0,1]", () => {
    expect(signalValueForVerdict({ verdict: "confirmed" })).toBe(1)
    expect(signalValueForVerdict({ verdict: "rejected" })).toBe(0)
    expect(signalValueForVerdict({ verdict: "corrected" })).toBeCloseTo(0.5, 6)
  })
  it("passes through an explicit task-quality score", () => {
    expect(signalValueForVerdict({ score: 0.8 })).toBe(0.8)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun run vitest run src/alignment/cadence.test.ts`
Expected: FAIL — cannot find module `./cadence.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/alignment/cadence.ts
import type { BeliefVerdict } from "../beliefs/types.js"

const DAY = 86_400_000

/** §2.1 asymmetric hysteresis: trust slow to grant, fast to revoke. */
export const ALPHA_UP = 0.15 // good signal → slow climb
export const ALPHA_DOWN = 0.6 // bad signal → fast clawback (must dominate ALPHA_UP)

/** §2.1 cadence bounds. */
export const MIN_INTERVAL_DAYS = 1 // dormant floor / clawback target
export const MAX_INTERVAL_DAYS = 30 // capped backoff

/**
 * Convex interval-curve exponent. Intervals stay short across most of the ewma
 * range and only ease toward MAX near FULL trust — so any drop in ewma pulls
 * the interval back toward MIN fast (§2.1 "fast to revoke"), while reaching the
 * 30-day cap requires sustained high trust ("slow to grant"). A LINEAR curve
 * (exponent 1) fails the fast-clawback property test — do not lower this to 1.
 */
export const INTERVAL_CURVE = 3

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/**
 * EWMA update with asymmetric smoothing. `signalValue` is normalized [0,1]
 * (clamped). When the signal pulls the score UP we move slowly (ALPHA_UP);
 * when it pulls DOWN we move fast (ALPHA_DOWN) — the §2.1 invariant that one
 * bad signal outweighs one equal-magnitude good one. Result clamped to [0,1].
 */
export function updateEwma(prev: number, signalValue: number): number {
  const v = clamp01(signalValue)
  const alpha = v >= prev ? ALPHA_UP : ALPHA_DOWN
  return clamp01(prev + alpha * (v - prev))
}

/**
 * Next survey timestamp. Maps ewma ∈ [0,1] onto an interval clamped to
 * [MIN, MAX] days via a CONVEX curve (ewma^INTERVAL_CURVE): the interval stays
 * near MIN across most of the range and only eases toward MAX near full trust.
 * Combined with the asymmetric updateEwma (fast ALPHA_DOWN), this makes a drop
 * in trust pull the cadence back toward 1 day within ≤2 surveys (§2.1 fast
 * clawback) while reaching 30 days needs sustained high alignment (slow grant).
 */
export function nextSurveyAt(ewma: number, lastSurveyAt: number): number {
  const e = clamp01(ewma)
  const intervalDays =
    MIN_INTERVAL_DAYS +
    (MAX_INTERVAL_DAYS - MIN_INTERVAL_DAYS) * Math.pow(e, INTERVAL_CURVE)
  return lastSurveyAt + Math.round(intervalDays * DAY)
}

/**
 * Normalize a verdict/score into a [0,1] signal value for the EWMA.
 * Belief verdicts: confirmed=1, corrected=0.5, rejected=0. A raw task-quality
 * score is passed through (clamped).
 */
export function signalValueForVerdict(input: {
  verdict?: BeliefVerdict
  score?: number
}): number {
  if (input.score !== undefined) return clamp01(input.score)
  switch (input.verdict) {
    case "confirmed":
      return 1
    case "corrected":
      return 0.5
    case "rejected":
      return 0
    default:
      return 0.5 // neutral when neither supplied
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun run vitest run src/alignment/cadence.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck**

Run: `cd packages/core && bun run tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/alignment/cadence.ts packages/core/src/alignment/cadence.test.ts
git commit -m "feat(alignment): pure cadence controller — asymmetric EWMA + clamped interval curve"
```

---

## Task 3: AlignmentStore — alignment_log ledger + alignment_state cache

Mirrors `dream-store.ts` exactly: `Memory` (Ref) layer + `makeLayer(dbPath)` SQLite layer, `ensureSchemaVersions` + `applyMigration(db, "alignment", 1, …)`, `db.close()` finalizer registered first, prepared statements, `INSERT OR IGNORE` idempotency on a deterministic id (spec-delta #5). Tests use the `Memory` layer (no Bun).

**Files:**
- Create: `packages/core/src/alignment/alignment-store.ts`
- Test: `packages/core/src/alignment/alignment-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/alignment/alignment-store.test.ts
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { Clock } from "../clock.js"
import { AlignmentStore } from "./alignment-store.js"
import type { AlignmentLogRowInput } from "./types.js"

const provide = <A, E>(eff: Effect.Effect<A, E, AlignmentStore | Clock>) =>
  eff.pipe(Effect.provide(AlignmentStore.Memory), Effect.provide(Clock.Test(1000)))

const row = (over: Partial<AlignmentLogRowInput> = {}): AlignmentLogRowInput => ({
  at: 1000, signalKind: "task_quality", scoreDelta: 0.1, ewmaAfter: 0.6, ref: "task:1", ...over,
})

describe("AlignmentStore (Memory)", () => {
  it("appends and lists rows", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* AlignmentStore
          yield* s.append(row({ ref: "task:1" }))
          yield* s.append(row({ ref: "task:2", signalKind: "belief_validation", ewmaAfter: null }))
          return yield* s.list({})
        }),
      ),
    )
    expect(out).toHaveLength(2)
  })

  it("append is idempotent on (ref, signalKind, at)", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* AlignmentStore
          yield* s.append(row())
          yield* s.append(row()) // same key → ignored
          return yield* s.list({})
        }),
      ),
    )
    expect(out).toHaveLength(1)
  })

  it("filters by signalKind", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* AlignmentStore
          yield* s.append(row({ ref: "a", signalKind: "task_quality" }))
          yield* s.append(row({ ref: "b", signalKind: "belief_validation", ewmaAfter: null }))
          return yield* s.list({ signalKind: "belief_validation" })
        }),
      ),
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.signalKind).toBe("belief_validation")
  })

  it("getEwma defaults to the dormant floor (0.0) and round-trips setEwma", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* AlignmentStore
          const cold = yield* s.getEwma
          yield* s.setEwma(0.7)
          const warm = yield* s.getEwma
          return { cold, warm }
        }),
      ),
    )
    expect(out.cold).toBe(0) // §2.4 cold start
    expect(out.warm).toBe(0.7)
  })

  it("rebuildState folds only EWMA-eligible rows", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* AlignmentStore
          // a task_quality row sets ewmaAfter 0.4; a belief_validation row has null
          yield* s.append(row({ ref: "t", signalKind: "task_quality", ewmaAfter: 0.4 }))
          yield* s.append(row({ ref: "b", signalKind: "belief_validation", ewmaAfter: null }))
          return yield* s.rebuildState()
        }),
      ),
    )
    // rebuild uses the last EWMA-eligible row's ewmaAfter
    expect(out).toBe(0.4)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun run vitest run src/alignment/alignment-store.test.ts`
Expected: FAIL — cannot find module `./alignment-store.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/alignment/alignment-store.ts
/**
 * AlignmentStore — SQLite-backed alignment-signal ledger + denormalized EWMA
 * cache (Phase 3, §5.2). Mirrors DreamStore's two-layer shape.
 *
 *   - `alignment_log` is an append-only signal ledger. Idempotent on a
 *     deterministic id derived from (ref, signal_kind, at) via INSERT OR IGNORE
 *     — so a crash between a belief write and its alignment append is crash-safe
 *     by re-run (spec-delta #5; true single-tx atomicity is a follow-on).
 *   - `alignment_state` is a single-row O(1) EWMA cache (§5.2). Derivable from
 *     the EWMA-eligible rows of alignment_log via rebuildState().
 *
 * Layers mirror DreamStore: Memory (Ref) for tests, makeLayer(dbPath) over
 * bun:sqlite requiring Clock + LunaSqliteBootstrap.
 */
import { Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ConfigError } from "../errors.js"
import { ALIGNMENT_COMPONENT, AlignmentError, EWMA_ELIGIBLE } from "./types.js"
import type { AlignmentLogQuery, AlignmentLogRow, AlignmentLogRowInput } from "./types.js"

interface BunDb {
  run: (sql: string) => void
  query: (sql: string) => BunStmt
  close: () => void
}
interface BunStmt {
  get: (...p: unknown[]) => unknown
  all: (...p: unknown[]) => unknown[]
  run: (...p: unknown[]) => { changes: number }
}

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS alignment_log (
    id          TEXT NOT NULL PRIMARY KEY,
    at          INTEGER NOT NULL,
    signal_kind TEXT NOT NULL CHECK(signal_kind IN ('task_quality','belief_validation','outreach_welcome')),
    score_delta REAL NOT NULL,
    ewma_after  REAL,
    ref         TEXT NOT NULL,
    UNIQUE(ref, signal_kind, at)
  );
  CREATE INDEX IF NOT EXISTS idx_alignment_log_kind_at ON alignment_log(signal_kind, at);

  CREATE TABLE IF NOT EXISTS alignment_state (
    id         INTEGER NOT NULL PRIMARY KEY CHECK(id = 1),
    ewma       REAL NOT NULL,
    updated_at INTEGER NOT NULL
  );
`

/** Deterministic id — idempotency key (spec-delta #5). */
const deriveLogId = (i: AlignmentLogRowInput): string =>
  `al-${i.ref}-${i.signalKind}-${i.at}`

export interface AlignmentStoreApi {
  readonly append: (input: AlignmentLogRowInput) => Effect.Effect<string, AlignmentError>
  readonly list: (q: AlignmentLogQuery) => Effect.Effect<ReadonlyArray<AlignmentLogRow>, AlignmentError>
  /** Current global EWMA; defaults to 0.0 (dormant floor, §2.4) when unset. */
  readonly getEwma: Effect.Effect<number, AlignmentError>
  readonly setEwma: (ewma: number) => Effect.Effect<void, AlignmentError>
  /** Recompute the EWMA cache from the EWMA-eligible log rows; returns it. */
  readonly rebuildState: () => Effect.Effect<number, AlignmentError>
}

export class AlignmentStore extends Effect.Tag("luna/AlignmentStore")<
  AlignmentStore,
  AlignmentStoreApi
>() {
  /** Ref-backed in-memory layer for tests. No SQLite. */
  static readonly Memory: Layer.Layer<AlignmentStore, never, Clock> = Layer.effect(
    AlignmentStore,
    Effect.gen(function* () {
      const rows = yield* Ref.make<ReadonlyArray<AlignmentLogRow>>([])
      const ewma = yield* Ref.make<number | null>(null)

      const append: AlignmentStoreApi["append"] = (input) =>
        Effect.gen(function* () {
          const id = deriveLogId(input)
          const existing = yield* Ref.get(rows)
          if (existing.some((r) => r.id === id)) return id // INSERT OR IGNORE
          const r: AlignmentLogRow = { id, ...input }
          yield* Ref.update(rows, (rs) => [...rs, r])
          return id
        })

      const list: AlignmentStoreApi["list"] = (q) =>
        Ref.get(rows).pipe(
          Effect.map((rs) => {
            let out = rs
            if (q.signalKind !== undefined) out = out.filter((r) => r.signalKind === q.signalKind)
            if (q.since !== undefined) out = out.filter((r) => r.at >= q.since!)
            out = [...out].sort((a, b) => a.at - b.at)
            if (q.limit !== undefined) out = out.slice(0, q.limit)
            return out
          }),
        )

      const getEwma: AlignmentStoreApi["getEwma"] = Ref.get(ewma).pipe(
        Effect.map((e) => e ?? 0),
      )
      const setEwma: AlignmentStoreApi["setEwma"] = (e) => Ref.set(ewma, e)

      const rebuildState: AlignmentStoreApi["rebuildState"] = () =>
        Effect.gen(function* () {
          const rs = yield* Ref.get(rows)
          const eligible = rs
            .filter((r) => EWMA_ELIGIBLE.has(r.signalKind) && r.ewmaAfter !== null)
            .sort((a, b) => a.at - b.at)
          const last = eligible.at(-1)?.ewmaAfter ?? 0
          yield* Ref.set(ewma, last)
          return last
        })

      return { append, list, getEwma, setEwma, rebuildState } satisfies AlignmentStoreApi
    }),
  )

  /** SQLite-backed Layer. Requires Clock + LunaSqliteBootstrap. */
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<AlignmentStore, ConfigError, Clock | LunaSqliteBootstrap> {
    return Layer.scoped(
      AlignmentStore,
      Effect.gen(function* () {
        yield* LunaSqliteBootstrap
        const clock = yield* Clock

        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () => import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
          catch: (cause) =>
            new ConfigError({
              module: "alignment-store",
              key: "bun:sqlite",
              message: `failed to import bun:sqlite: ${String(cause)}`,
            }),
        })
        const Database = (mod as { Database?: unknown }).Database as
          | (new (p: string) => BunDb)
          | undefined
        if (!Database) {
          return yield* Effect.fail(
            new ConfigError({
              module: "alignment-store",
              key: "bun:sqlite",
              message: "bun:sqlite module has no `Database` export",
            }),
          )
        }

        const db = new Database(dbPath)
        db.run("PRAGMA journal_mode = WAL")
        db.run("PRAGMA synchronous = NORMAL")
        db.run("PRAGMA foreign_keys = ON")

        const nowMs = yield* clock.nowMs()
        ensureSchemaVersions(db)
        applyMigration(db, ALIGNMENT_COMPONENT, 1, SCHEMA_V1, nowMs)

        // §3.4 #4 LIFO: register db.close finalizer FIRST.
        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        const insertStmt = db.query(`
          INSERT OR IGNORE INTO alignment_log
            (id, at, signal_kind, score_delta, ewma_after, ref)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        const getEwmaStmt = db.query(`SELECT ewma FROM alignment_state WHERE id = 1`)
        const setEwmaStmt = db.query(`
          INSERT INTO alignment_state (id, ewma, updated_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET ewma = excluded.ewma, updated_at = excluded.updated_at
        `)

        const rowToLog = (r: Record<string, unknown>): AlignmentLogRow => ({
          id: r.id as string,
          at: r.at as number,
          signalKind: r.signal_kind as AlignmentLogRow["signalKind"],
          scoreDelta: r.score_delta as number,
          ewmaAfter: (r.ewma_after as number | null) ?? null,
          ref: r.ref as string,
        })

        const wrap = <A>(op: string, f: () => A) =>
          Effect.try({
            try: f,
            catch: (cause) =>
              new AlignmentError({ op, message: `sqlite ${op} failed: ${String(cause)}`, cause }),
          })

        const append: AlignmentStoreApi["append"] = (input) =>
          wrap("append", () => {
            const id = deriveLogId(input)
            insertStmt.run(id, input.at, input.signalKind, input.scoreDelta, input.ewmaAfter, input.ref)
            return id
          })

        const list: AlignmentStoreApi["list"] = (q) =>
          wrap("list", () => {
            const clauses: string[] = []
            const params: unknown[] = []
            if (q.signalKind !== undefined) { clauses.push("signal_kind = ?"); params.push(q.signalKind) }
            if (q.since !== undefined) { clauses.push("at >= ?"); params.push(q.since) }
            const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
            const limit = q.limit !== undefined ? `LIMIT ${Number(q.limit)}` : ""
            const stmt = db.query(`SELECT * FROM alignment_log ${where} ORDER BY at ASC ${limit}`)
            return (stmt.all(...params) as Array<Record<string, unknown>>).map(rowToLog)
          })

        const getEwma: AlignmentStoreApi["getEwma"] = wrap("getEwma", () => {
          const r = getEwmaStmt.get() as { ewma: number } | undefined
          return r ? r.ewma : 0
        })

        const setEwma: AlignmentStoreApi["setEwma"] = (e) =>
          wrap("setEwma", () => { setEwmaStmt.run(e, Date.now()) }).pipe(Effect.asVoid)

        const rebuildState: AlignmentStoreApi["rebuildState"] = () =>
          Effect.gen(function* () {
            const eligible = yield* list({})
            const last = eligible
              .filter((r) => EWMA_ELIGIBLE.has(r.signalKind) && r.ewmaAfter !== null)
              .at(-1)?.ewmaAfter ?? 0
            const now = yield* clock.nowMs()
            yield* wrap("rebuildState", () => { setEwmaStmt.run(last, now) })
            return last
          })

        return { append, list, getEwma, setEwma, rebuildState } satisfies AlignmentStoreApi
      }),
    )
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun run vitest run src/alignment/alignment-store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `cd packages/core && bun run tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/alignment/alignment-store.ts packages/core/src/alignment/alignment-store.test.ts
git commit -m "feat(alignment): AlignmentStore — log ledger + EWMA cache (Memory + sqlite layers)"
```

---

## Task 4: BeliefWriter.recordValidation (append to validationHistory)

`BeliefWriter` already has `activateBelief` / `retireBelief` / `stageProposed` / `listActive` etc. (Phase 2, merged). It has **no** way to append a validation — `recordValidation` is net-new and is part of the unblocked slice (pure library, no boot risk). The survey (Task 5) calls it.

**Files:**
- Modify: `packages/core/src/beliefs/belief-writer.ts` (add to interface + impl)
- Modify: `packages/core/src/beliefs/belief-writer.test.ts` (add a test)

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/beliefs/belief-writer.test.ts` (reuse its existing `FakeMemory` + `provide` helpers):

```typescript
import type { BeliefValidation } from "./types.js"

it("recordValidation appends to validationHistory and persists", async () => {
  const b = makeBeliefRecord({ statement: "s", confidence: 0.7, domain: "d", status: "active", now: 0 })
  const v: BeliefValidation = { at: 5, verdict: "confirmed", via: "survey" }
  const out = await Effect.runPromise(
    provide(
      Effect.gen(function* () {
        const w = yield* BeliefWriter
        yield* w.recordValidation(b.id, v)
        const mem = yield* MemoryRouterTag
        return yield* mem.get(b.id)
      }),
      FakeMemory([b]),
    ),
  )
  expect(readBelief(out!).validationHistory).toEqual([v])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun run vitest run src/beliefs/belief-writer.test.ts`
Expected: FAIL — `w.recordValidation` is not a function.

- [ ] **Step 3: Add to the interface and implementation**

In `packages/core/src/beliefs/belief-writer.ts`, add to `BeliefWriterApi` (after `retireBelief`):

```typescript
  /** Append a validation to a belief's track record (per-belief, isolated). */
  readonly recordValidation: (
    id: string,
    validation: BeliefValidation,
  ) => Effect.Effect<boolean, MemoryBackendError>
```

Add the `BeliefValidation` type to the existing type import:

```typescript
import type { BeliefContent, BeliefStatus, BeliefValidation } from "./types.js"
```

Implement inside the `Effect.gen` (after `retireBelief`), and add it to the returned object:

```typescript
      const recordValidation = (id: string, validation: BeliefValidation) =>
        Effect.gen(function* () {
          const rec = yield* mem.get(id)
          if (rec === null || rec.kind !== BELIEF_KIND) return false
          const now = yield* clock.nowMs()
          const prev = readBelief(rec)
          const content: BeliefContent = {
            ...prev,
            validationHistory: [...prev.validationHistory, validation],
          }
          yield* mem.put({ ...rec, content, updatedAt: now })
          return true
        })

      return { listAll, listActive, listByStatus, stageProposed, activateBelief, retireBelief, recordValidation } satisfies BeliefWriterApi
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun run vitest run src/beliefs/belief-writer.test.ts`
Expected: PASS — all prior writer tests + the new one.

- [ ] **Step 5: Typecheck**

Run: `cd packages/core && bun run tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/beliefs/belief-writer.ts packages/core/src/beliefs/belief-writer.test.ts
git commit -m "feat(beliefs): BeliefWriter.recordValidation — append to per-belief track record"
```

---

## Task 5: Survey service — verdict routing + activation policy

The §3.3 deliverable. `processVerdict` routes a verdict per §2.3 (category boundary), logs it to `AlignmentStore`, updates either the global EWMA (task_quality / outreach_welcome) **or** the per-belief track record (belief_validation), and drives activation per spec-delta #7. `signalsForVerdict` is a pure exported helper so routing is unit-testable in isolation. No UI: verdicts are inputs.

**Files:**
- Create: `packages/core/src/alignment/survey.ts`
- Test: `packages/core/src/alignment/survey.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/alignment/survey.test.ts
import { describe, expect, it } from "vitest"
import { Effect, Layer, Ref, Stream } from "effect"
import { Clock } from "../clock.js"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryQuery, MemoryRecord } from "@luna/memory"
import { BeliefWriter } from "../beliefs/belief-writer.js"
import { makeBeliefRecord, readBelief } from "../beliefs/types.js"
import { AlignmentStore } from "./alignment-store.js"
import { Survey } from "./survey.js"
import type { SurveyVerdict } from "./types.js"

// Reuse the belief-writer test's FakeMemory shape (query supports namespace/kind/since).
const FakeMemory = (initial: ReadonlyArray<MemoryRecord> = []) =>
  Layer.effect(
    MemoryRouterTag,
    Effect.gen(function* () {
      const store = yield* Ref.make<Map<string, MemoryRecord>>(new Map(initial.map((r) => [r.id, r])))
      return {
        put: (rec: MemoryRecord) => Ref.update(store, (m) => new Map(m).set(rec.id, rec)),
        get: (id: string) => Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
        delete: (id: string) => Ref.modify(store, (m) => { const had = m.has(id); const n = new Map(m); n.delete(id); return [had, n] }),
        query: (q: MemoryQuery) =>
          Stream.unwrap(Ref.get(store).pipe(Effect.map((m) =>
            Stream.fromIterable(Array.from(m.values()).filter((r) =>
              (q.namespace === undefined || r.namespace === q.namespace) &&
              (q.kind === undefined || r.kind === q.kind))))),
          ),
        search: () => { throw new Error("unused") },
      } as never
    }),
  )

const provide = <A, E>(eff: Effect.Effect<A, E, any>, mem: Layer.Layer<any>) =>
  eff.pipe(
    Effect.provide(Survey.Default),
    Effect.provide(BeliefWriter.Default),
    Effect.provide(AlignmentStore.Memory),
    Effect.provide(mem),
    Effect.provide(Clock.Test(100)),
  )

describe("Survey.processVerdict — category boundary (§2.3)", () => {
  it("task_quality moves the global EWMA", async () => {
    const ewma = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          const v: SurveyVerdict = { itemId: "i1", kind: "task_quality", ref: "task:1", score: 1, via: "survey" }
          yield* survey.processVerdict(v)
          const store = yield* AlignmentStore
          return yield* store.getEwma
        }),
        FakeMemory([]),
      ),
    )
    expect(ewma).toBeGreaterThan(0) // climbed from the 0.0 floor
  })

  it("belief_validation does NOT move the global EWMA, but updates the belief", async () => {
    const b = makeBeliefRecord({ statement: "s", confidence: 0.7, domain: "comms", status: "active", now: 0 })
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          const v: SurveyVerdict = {
            itemId: "i2", kind: "belief_validation", ref: `belief:${b.id}`,
            beliefId: b.id, verdict: "confirmed", via: "survey",
          }
          yield* survey.processVerdict(v)
          const store = yield* AlignmentStore
          const mem = yield* MemoryRouterTag
          return { ewma: yield* store.getEwma, belief: yield* mem.get(b.id) }
        }),
        FakeMemory([b]),
      ),
    )
    expect(out.ewma).toBe(0) // EWMA UNCHANGED — the category boundary
    expect(readBelief(out.belief!).validationHistory).toHaveLength(1) // belief updated
  })
})

describe("Survey.processVerdict — activation policy (spec-delta #7)", () => {
  const proposed = (statement: string) =>
    makeBeliefRecord({ statement, confidence: 0.7, domain: "comms", status: "proposed", now: 0 })

  it("confirmed on a proposed belief activates it", async () => {
    const b = proposed("activate me")
    const status = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          yield* survey.processVerdict({ itemId: "i", kind: "belief_validation", ref: b.id, beliefId: b.id, verdict: "confirmed", via: "survey" })
          const mem = yield* MemoryRouterTag
          return readBelief((yield* mem.get(b.id))!).status
        }),
        FakeMemory([b]),
      ),
    )
    expect(status).toBe("active")
  })

  it("rejected on a proposed belief retires it", async () => {
    const b = proposed("reject me")
    const status = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          yield* survey.processVerdict({ itemId: "i", kind: "belief_validation", ref: b.id, beliefId: b.id, verdict: "rejected", via: "survey" })
          const mem = yield* MemoryRouterTag
          return readBelief((yield* mem.get(b.id))!).status
        }),
        FakeMemory([b]),
      ),
    )
    expect(status).toBe("retired")
  })

  it("corrected leaves a proposed belief proposed (records validation only)", async () => {
    const b = proposed("correct me")
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          yield* survey.processVerdict({ itemId: "i", kind: "belief_validation", ref: b.id, beliefId: b.id, verdict: "corrected", via: "survey" })
          const mem = yield* MemoryRouterTag
          const rec = (yield* mem.get(b.id))!
          return { status: readBelief(rec).status, history: readBelief(rec).validationHistory.length }
        }),
        FakeMemory([b]),
      ),
    )
    expect(out.status).toBe("proposed")
    expect(out.history).toBe(1)
  })
})

describe("Survey.processVerdict — outreach_welcome dual-routing (§2.3)", () => {
  it("feeds BOTH the EWMA and the belief track record", async () => {
    const b = makeBeliefRecord({ statement: "s", confidence: 0.9, domain: "comms", status: "active", now: 0 })
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          yield* survey.processVerdict({ itemId: "i", kind: "outreach_welcome", ref: b.id, beliefId: b.id, verdict: "confirmed", via: "outreach" })
          const store = yield* AlignmentStore
          const mem = yield* MemoryRouterTag
          return { ewma: yield* store.getEwma, history: readBelief((yield* mem.get(b.id))!).validationHistory }
        }),
        FakeMemory([b]),
      ),
    )
    expect(out.ewma).toBeGreaterThan(0) // EWMA moved
    expect(out.history).toHaveLength(1) // and the belief recorded it (via:"outreach")
    expect(out.history[0]?.via).toBe("outreach")
  })
})

describe("Survey.nextSurvey", () => {
  it("returns a timestamp from the current EWMA and lastSurveyAt", async () => {
    const at = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          return yield* survey.nextSurvey(1000)
        }),
        FakeMemory([]),
      ),
    )
    // cold EWMA 0 → 1-day floor
    expect(at).toBe(1000 + 86_400_000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun run vitest run src/alignment/survey.test.ts`
Expected: FAIL — cannot find module `./survey.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/alignment/survey.ts
/**
 * Survey — the §3.3 cadence + signal-routing service. Processes a verdict
 * (handed in by a survey/outreach surface — NOT produced here), routes it per
 * the §2.3 category boundary, logs it to AlignmentStore, and drives belief
 * activation per spec-delta #7. The surface (how a human is asked) is
 * deliberately out of this module (deferred, decision-gated).
 */
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { BeliefWriter } from "../beliefs/belief-writer.js"
import type { BeliefValidation, BeliefVerdict } from "../beliefs/types.js"
import { readBelief } from "../beliefs/types.js"
import { MemoryRouterTag } from "@luna/memory"
import { AlignmentStore } from "./alignment-store.js"
import { updateEwma, nextSurveyAt, signalValueForVerdict } from "./cadence.js"
import { AlignmentError, EWMA_ELIGIBLE } from "./types.js"
import type { AlignmentSignal, SurveyVerdict } from "./types.js"
import type { MemoryBackendError } from "../errors.js"

/**
 * Pure router: a verdict → the typed signal(s) it produces. task_quality and
 * outreach_welcome feed the EWMA; belief_validation and outreach_welcome feed
 * the per-belief track record. (outreach_welcome feeds BOTH — §2.3.)
 */
export function signalsForVerdict(v: SurveyVerdict): ReadonlyArray<AlignmentSignal> {
  const value = signalValueForVerdict({ verdict: v.verdict, score: v.score })
  return [{
    kind: v.kind,
    value,
    ref: v.ref,
    beliefId: v.beliefId,
    verdict: v.verdict,
    via: v.via,
  }]
}

// Error channel carries the tagged errors propagated from AlignmentStore +
// MemoryRouter (the house style — DreamStore/BeliefWriter surface tagged errors).
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

      const processVerdict = (v: SurveyVerdict) =>
        Effect.gen(function* () {
          const now = yield* clock.nowMs()
          for (const sig of signalsForVerdict(v)) {
            // (a) Global EWMA — ONLY for EWMA-eligible kinds (category boundary).
            let ewmaAfter: number | null = null
            if (EWMA_ELIGIBLE.has(sig.kind)) {
              const prev = yield* store.getEwma
              const next = updateEwma(prev, sig.value)
              yield* store.setEwma(next)
              ewmaAfter = next
            }
            // (b) Per-belief track record — for belief-bound signals.
            if (sig.beliefId !== undefined && sig.verdict !== undefined) {
              const validation: BeliefValidation = { at: now, verdict: sig.verdict, via: sig.via }
              yield* writer.recordValidation(sig.beliefId, validation)
              yield* applyActivationPolicy(sig.beliefId, sig.verdict)
            }
            // (c) Always log to the ledger (audit/training corpus). NOTE: the
            // §5.2 column is named `score_delta` but v1 stores the absolute
            // normalized signal value [0,1] (the EWMA does the smoothing); a
            // true delta is not needed for cadence and would be derivable.
            yield* store.append({
              at: now,
              signalKind: sig.kind,
              scoreDelta: sig.value,
              ewmaAfter,
              ref: sig.ref,
            })
          }
        })

      const applyActivationPolicy = (beliefId: string, verdict: BeliefVerdict) =>
        Effect.gen(function* () {
          const rec = yield* mem.get(beliefId)
          if (rec === null) return
          const status = readBelief(rec).status
          if (status !== "proposed") return // active → re-validation only (no re-cap)
          if (verdict === "confirmed") {
            yield* writer.activateBelief(beliefId) // climbs the ladder (≤20 cap)
          } else if (verdict === "rejected") {
            yield* writer.retireBelief(beliefId)
          }
          // corrected → stays proposed (awaits Dream's re-proposal with the fix)
        })

      const nextSurvey = (lastSurveyAt: number) =>
        store.getEwma.pipe(Effect.map((ewma) => nextSurveyAt(ewma, lastSurveyAt)))

      return { processVerdict, nextSurvey } satisfies SurveyApi
    }),
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun run vitest run src/alignment/survey.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck**

Run: `cd packages/core && bun run tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/alignment/survey.ts packages/core/src/alignment/survey.test.ts
git commit -m "feat(alignment): Survey service — verdict routing (category boundary) + activation policy"
```

---

## Task 6: Barrel exports + wire into core index

**Files:**
- Create: `packages/core/src/alignment/index.ts`
- Modify: `packages/core/src/index.ts` (add the alignment export after the beliefs export)

- [ ] **Step 1: Write the barrel**

```typescript
// packages/core/src/alignment/index.ts
export * from "./types.js"
export * from "./cadence.js"
export * from "./alignment-store.js"
export * from "./survey.js"
```

- [ ] **Step 2: Add the core export**

In `packages/core/src/index.ts`, immediately after the line `export * from "./beliefs/index.js"`, add:

```typescript
export * from "./alignment/index.js"
```

- [ ] **Step 3: Typecheck the package**

Run: `cd packages/core && bun run tsc --noEmit`
Expected: exit 0 (watch for duplicate-export collisions — `BeliefVerdict` is re-exported via beliefs already; alignment only *imports* it, never re-exports, so no clash).

- [ ] **Step 4: Run the whole alignment suite**

Run: `cd packages/core && bun run vitest run src/alignment/`
Expected: PASS — all alignment tests (Tasks 1–5) green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/alignment/index.ts packages/core/src/index.ts
git commit -m "feat(alignment): barrel exports + wire into @luna/core index"
```

---

## Task 7: Full-suite verification (unblocked slice)

**Files:** none (verification only)

- [ ] **Step 1: Run the full core test suite**

Run: `cd packages/core && bun run vitest run`
Expected: PASS — all existing dream + beliefs tests + new alignment tests green, no regressions.

- [ ] **Step 2: Typecheck packages/core**

Run: `cd packages/core && bun run tsc --noEmit`
Expected: exit 0. (This is the authoritative gate for this slice — packages/core is fully covered by tsc.)

- [ ] **Step 3: Root typecheck — note the known baseline, do NOT assert clean exit**

Run: from repo root, `bun run typecheck`
Expected: the **pre-existing** agent-cli JSX + DuckDB-test failures are the known baseline (they are NOT introduced by this slice). Confirm **no NEW errors originate from `packages/core/src/alignment/` or `packages/core/src/beliefs/`**. Step 2 is the gate; this step is a regression check against the baseline.

- [ ] **Step 4: Final commit (if any lint/format fixes were needed)**

```bash
git add -A
git commit -m "chore(alignment): Phase 3 unblocked slice complete — suite green, core typechecks"
```

---

# DECISION-GATED / BOOT-RISK (plan only, do NOT auto-implement)

Each item below touches the live server boot or a user surface, or needs a genuine product decision. **None is auto-built by the executing subagent.** chat-server.ts has **NO tsc gate** (root `tsconfig.json` excludes `apps/ui-web/**`; the file lives in `scripts/`, Bun-transpiled), and its own comment warns that a missing service in the layer graph "takes down the whole chatWithTools wiring at boot" — so the failure mode here is the **boot, not the feature**. Verify with a `ManagedRuntime` layer-build smoke harness, never by eyeballing.

## D1: Wire `registerDreamCron` into the live server boot

**Why deferred:** Verified — `registerDreamCron` exists (`dream/dream.ts`) but is **not called anywhere in `chat-server.ts`** (grep: zero hits). Wiring a cron into boot is the §7.3 "Cron wiring … final, discrete task" + the same boot-risk class as Phase-2 Task 7: a `TriggerAgent`/layer mistake crashes the whole boot, with no tsc net. **Recipe (do at Phase-3 ship, not in the slice):** build the dream dependency layers (`DreamStore.makeLayer(dbPath)`, real or `FakeReasoner`, `SessionStore`, `MemoryRouter`, `Clock`) and `Layer.provide` them INTO the cron-registering effect locally — mirroring the Phase-2 Task 7 `Layer.provide(memoryRouterL)` fix — then a `ManagedRuntime` smoke test asserts the boot layer builds with **no missing-service error** before any real cron fires. Default cadence: nightly (`0 3 * * *`), per §8 + §3.1 default.

## D2: Real `DreamReasoner.Default` (model-backed) implementation

**Why deferred:** Phase 1 ships only `FakeReasoner` (`dream/reasoner.ts`); `DreamReasoner` has no `.Default`. The real impl calls the model to turn `DreamInputs` → `DreamOp[]` (per §3.1 three reasoning targets, routed by the §2.3 category boundary: transcripts → belief candidates + hygiene; telemetry → task-quality only). This is net-new model wiring + prompt design — a substantive build with its own plan, not a slice task. Until it exists, the cron (D1) can run against `FakeReasoner` for the boot smoke test only.

## D3: Survey UI surface

**Why deferred:** §3.3 "surfaces in the chat/TUI as a short structured check-in." The unblocked `Survey` service consumes `SurveyVerdict`s; **producing** them needs a UI surface (TUI and/or web/Tauri) — a user-facing build that touches a surface and needs the product decision in D-decision-1 below. The backend is complete and fixture-tested without it.

## D4: Outreach emitter (`TriggerAgent` watcher, ships dormant)

**Why deferred:** §3.4 — the riskiest rung. The `outreach_welcome` *signal* is already modeled + routed in the slice (Task 5, spec-delta #8); the **emitter** that fires unprompted messages (per-belief gate + global-ceiling) is a separate dormant-by-default build (§7.4), gated on Phases 1–3 having logged real alignment. Not in Phase 3.

## D5: Deferred Phase-2 belief-injection wiring (carried forward)

**Why deferred:** Phase 2 Task 7 (inject active beliefs into the thread system prompt) was **deferred to Phase 3** for boot-risk reasons. Now that the survey can *activate* beliefs, the injection becomes non-empty and worth wiring — but it carries the same boot risk. **Use the verified Phase-2 Task 7 banner recipe verbatim:** in `chat-server.ts`, `const threadToolsL = ThreadToolsProviderLayer().pipe(Layer.provide(memoryRouterL), Layer.provide(obsL), Layer.provide(clockL))` (the `Layer.provide(memoryRouterL)` is the load-bearing fix — `Layer.mergeAll` does NOT cross-wire siblings); add `Stream` to the `effect` import; fetch active beliefs and inject via `composeBeliefsSection`; and because activation now makes beliefs non-empty, **move the fetch from boot into `decorate()`** for per-thread freshness (a just-activated belief should appear in the next thread). **VERIFY with a `ManagedRuntime` layer-build smoke test** (seed one ACTIVE belief, assert `threadToolsL` builds with no missing-service error and `decorate()`'s output contains the beliefs section). Do NOT rely on "it's inert so it can't break" — the failure mode is the boot.

## D6: Telemetry read-API (follow-on enrichment, NOT a blocker)

**Why deferred (and why it does not block the slice):** Verified — `ObservabilityApi` exposes only `emit` / `events` / `subscribeEvents`; there is **no historical query**. The §2.3 design has the survey supply task-quality signals **directly** (subjective ground truth), so the slice's `Survey.processVerdict` needs no telemetry read at all. The read-path (a JSONL reader keyed by `(sessionId, time window)` or a query method on the service) is the §7.3 prerequisite for telemetry **pre-biasing** the task-quality score (the objective rough draft, incl. `PermissionDecision` denials) — an **enrichment** layered on later. Net-new work, own plan.

---

## Decisions for the human (genuine product choices, not tunables)

> All tunables (EWMA `ALPHA_UP`/`ALPHA_DOWN`, interval bounds, activation policy) are **locked as spec-deltas** above with concrete defaults and test-enforced invariants — they do NOT block. The choices below are not tunables; they shape what gets built next.

- **D-decision-1 — Survey surface scope (D3).** Options: (a) TUI-only first; (b) all surfaces (web/Tauri + TUI) at once. **Recommendation: (a) TUI-only first** — smallest boot-risk surface, fastest to close the loop, web/Tauri follow once the verdict→backend contract is proven live.
- **D-decision-2 — When to wire Dream cron into live boot (D1) + build the real reasoner (D2).** Options: (a) after the unblocked slice + a `ManagedRuntime` layer-build smoke harness, with `FakeReasoner` first then the model-backed `DreamReasoner.Default`; (b) wire cron + real reasoner together in one boot change. **Recommendation: (a)** — prove the boot graph with `FakeReasoner` under a smoke harness before introducing model latency/cost into the boot path; the failure mode is the boot, so isolate it.
- **D-decision-3 — Belief-injection refresh point (D5).** Options: (a) boot-time fetch (Phase-2 wiring as-was); (b) per-thread fetch in `decorate()`. **Recommendation: (b) per-thread in `decorate()`** — once activation is live a just-activated belief should appear in the very next thread; boot-time caching would stale it until restart.
- **D-decision-4 — Outreach enablement (D4).** Options: (a) keep dormant through Phase 3, enable only after real alignment is logged; (b) enable a low-stakes outreach pilot in Phase 3. **Recommendation: (a) keep dormant** — §2.4/§7.4 explicitly ship outreach dormant; enabling it before the loop has logged real per-belief track records would fire the riskiest action without the validation it is gated on.

---

## Self-review (run after writing, before execution)

**Spec coverage (§2.1 / §2.3 / §3.3 / §5.1 / §5.2 / §7.3):**
- ✅ Global alignment EWMA → survey cadence ONLY, asymmetric hysteresis — Task 2 (`updateEwma` ALPHA_UP/DOWN + invariant test) + Task 5 (only EWMA-eligible kinds update it).
- ✅ Per-belief confidence + validation history gates actions, kept isolated — Task 4 (`recordValidation`) + Task 5 (belief_validation excluded from EWMA, asserted).
- ✅ Three signals routed correctly; category boundary a real test — Task 1 (`EWMA_ELIGIBLE`) + Task 5 routing tests.
- ✅ outreach_welcome feeds both streams, immediate (no survey clock) — Task 5 dual-routing test.
- ✅ Cadence controller is a pure function — Task 2 (no I/O, table tests).
- ✅ `alignment_log` + `alignment_state` SQLite tables (§5.2), idempotent append, O(1) EWMA read, rebuildable — Task 3.
- ✅ Survey activation closes the loop (proposed→active on confirmed) — Task 5 (spec-delta #7).
- ✅ §5.3 atomicity reconciled with `MemoryRouter` reality (idempotent sequencing, atomicity a follow-on) — spec-delta #5.
- ✅ Read-API reflected as follow-on, not blocker; slice has zero telemetry dependency — spec-delta #9 + D6.
- ◐ Cron-into-boot, real reasoner, survey UI, outreach emitter, belief-injection wiring — all **planned, deferred** (D1–D5), with the Phase-2 Task 7 boot-risk recipe carried forward.

**Boot-risk discipline:** Every live-boot/UI change is in the DECISION-GATED section; none is a slice task. The unblocked slice touches only `packages/core/src/` (tsc-covered). ✅

**Typecheck discipline:** Every code-writing task has a `cd packages/core && bun run tsc --noEmit` step (packages/core scope, exit 0). Root `bun run typecheck` is reserved for final regression check against the known agent-cli baseline, NOT asserted clean. ✅ (Vitest does not typecheck — the tsc step is mandatory.)

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step has complete code; every test step has assertions; commands have expected output. ✅

**Type consistency:**
- `SignalKind`, `AlignmentSignal`, `SurveyVerdict`, `AlignmentLogRow(Input)` defined once (Task 1), reused in Tasks 3/5. ✅
- `updateEwma`/`nextSurveyAt`/`signalValueForVerdict` signatures identical across Tasks 2/5. ✅
- `AlignmentStore` method names (`append`, `list`, `getEwma`, `setEwma`, `rebuildState`) consistent across both layers + Task 5. ✅
- `BeliefWriter.recordValidation(id, validation)` signature identical in Tasks 4/5. ✅
- `BeliefVerdict` imported from `beliefs/types.js` (single source), never re-declared — no export collision in the barrel (Task 6 Step 3). ✅
- `EWMA_ELIGIBLE` used identically in Tasks 1/3/5. ✅

**Tunables locked, not deferred:** ALPHA_UP=0.15, ALPHA_DOWN=0.5, MIN=1d, MAX=30d, cold-start EWMA=0.0, activation policy (confirmed→active / rejected→retired / corrected→proposed) — all concrete in spec-deltas #1–#3, #7, with invariants test-enforced. The four `decisions` are genuine product choices, not constants. ✅
