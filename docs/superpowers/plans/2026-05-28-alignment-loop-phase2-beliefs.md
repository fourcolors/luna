# Alignment Loop — Phase 2: Belief Set Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the bounded belief set — beliefs stored as `MemoryRecord`s (`kind:"belief"`, `namespace:"operator"`), a belief writer that activates/retires beliefs and enforces a 20-active cap by evicting the weakest, a pure ranked formatter that injects active beliefs into every thread's system prompt the way `DNA.md` does, and Dream wiring so the nightly reasoner *promotes* candidate beliefs into staged `proposed` records.

**Architecture:** Beliefs reuse the `@luna/memory` record + router (no record-level migration — `content` is already `unknown`). A new `packages/core/src/beliefs/` module mirrors `dream/`: a `types.ts` data-shapes file, a pure `scoring.ts` (belief-strength function, the eviction/ranking key), a pure `inject.ts` (formatter), and a `belief-writer.ts` Effect service over `MemoryRouterTag` + `Clock`. **The trust ladder is honored: Phase 2 ships the machinery but nothing auto-*activates* a belief.** Dream materializes candidates as `status:"proposed"` records (staged, undoable, *not* injected); the `proposed→active` transition is Phase 3's survey. Only `active` beliefs are injected, so an unvalidated belief never shapes a prompt without a human check.

**Tech Stack:** Effect-TS v3, Bun, `@luna/memory` (`MemoryRecord`, `makeRecord`, `MemoryRouterTag`, `query`/`put`/`get`/`delete`), `@luna/core` `Clock`. Tests: Vitest with Ref-backed `FakeMemory` + `Clock.Default` (no Bun), mirroring `dream.test.ts`.

**Source-of-truth spec:** `docs/superpowers/specs/2026-05-28-luna-alignment-loop-design.md` (§3.2 Belief set, §5.1 Belief model, §7 Phase 2). Builds on Phase 1 (`packages/core/src/dream/`, merged to `dev`).

---

## Spec deltas locked by this plan (refinements made concrete here)

1. **The 20 cap is on `active` beliefs only.** `proposed` beliefs are a staging area and do **not** count toward the cap; `retired` beliefs are excluded too. Eviction fires only on *activation* when the active set would exceed 20 (§3.2 "when a 21st wants in").
2. **Nothing auto-activates in Phase 2.** §7.2 "Dream begins promoting candidates" = Dream **creates `MemoryRecord`s with `content.status:"proposed"`**, not active ones. Belief *injection* into every prompt is the highest-leverage internal auto-apply in the system, so it stays gated on the Phase 3 survey (§7.3: deferred op classes auto-apply "under the alignment governor… once the survey exists"). The `proposed→active` trigger is Phase 3. `activateBelief`/`retireBelief` are *built and unit-tested* here so Phase 3 only has to *call* them.
3. **`belief_candidate` Dream ops change from *held* to *materialized*.** Phase 1 logged `belief_candidate` as a `proposed` audit row and did **not** write to memory. Phase 2 adds `belief_candidate` to the materialize set: it `put`s the proposed belief record AND logs the audit row `applied` (undoable via `revert` — `before:null` → delete). This is the safe shape of Phase 1's `memory_dedup` (idempotent state-set), because a `proposed` belief is inert (never injected) until Phase 3 activates it.
4. **Eviction/ranking score is a pure function with a neutral empty-validation term.** §3.2's "confidence × staleness × validation-track-record" is made concrete as `beliefStrength()`: `confidence × recencyFactor × validationFactor`, where an **empty `validationHistory` yields `1.0` (neutral), never `0`** — so a fresh, confident, unvalidated belief ranks *strong*, not weakest. Same function ranks injection order (DRY).
5. **Deterministic belief ids** (the Phase 1 "C1" idempotency lesson). `deriveBeliefId(domain, statement)` is a stable hash so a Dream re-run over the same window upserts the same record instead of duplicating it.
6. **Injection ranking = `beliefStrength` (confidence × recency × validation).** The §8 open question "confidence alone vs confidence × recency × domain-relevance-to-current-thread" is resolved to reuse `beliefStrength` (no thread context needed). Domain-relevance-to-current-thread is explicitly deferred (needs thread topic signals — Phase 3+).
7. **Injection wiring fetches active beliefs at boot.** `decorate()` in `chat-server.ts` is synchronous; the surrounding `ThreadToolsProviderLayer` `Effect.gen` is the only place with Effect context. Active beliefs are fetched there (like `dnaContent`) and formatted via the pure `composeBeliefsSection`. In Phase 2 there are zero `active` beliefs, so the section is empty and dropped by the existing `.filter` — the wiring is proven inert. True per-session refresh matters only once Phase 3 activation goes live; it is deferred with a code note (a `// PHASE 3:` comment).

---

## File structure

New module `packages/core/src/beliefs/` (mirrors `dream/` — same Clock + MemoryRouterTag discipline):

- `packages/core/src/beliefs/types.ts` — belief content model (`BeliefContent`, `BeliefStatus`, `BeliefVerdict`, `BeliefValidation`, `BeliefOutreachRights`), constants (`BELIEF_KIND`, `BELIEF_NAMESPACE`, `BELIEF_CAP`), `deriveBeliefId`, `makeBeliefRecord`, `readBelief`. One responsibility: data shapes + record construction.
- `packages/core/src/beliefs/scoring.ts` — pure `beliefStrength(content, updatedAt, now)` + `rankByStrength(records, now)`. No I/O. The eviction + injection ranking key.
- `packages/core/src/beliefs/inject.ts` — pure `composeBeliefsSection(records, now, opts?)` → markdown string (or `""`). The prompt formatter.
- `packages/core/src/beliefs/belief-writer.ts` — `BeliefWriter` Effect service over `MemoryRouterTag` + `Clock`: `listActive`, `listByStatus`, `activateBelief` (+ cap enforcement), `retireBelief`, `stageProposed`.
- `packages/core/src/beliefs/index.ts` — barrel exports.

Modified:
- `packages/core/src/dream/dream.ts` — extend the materialize set so `belief_candidate` stages a `proposed` belief record.
- `packages/core/src/dream/dream.test.ts` — update the "does NOT apply non-dedup ops" test (it currently asserts `belief_candidate` is held) + add a "stages belief_candidate" test.
- `packages/core/src/index.ts` — add `export * from "./beliefs/index.js"`.
- `apps/ui-web/scripts/chat-server.ts` — fetch active beliefs at boot, inject via `composeBeliefsSection`.

Tests (new):
- `packages/core/src/beliefs/types.test.ts` — `deriveBeliefId` determinism, `makeBeliefRecord` shape, `readBelief`.
- `packages/core/src/beliefs/scoring.test.ts` — `beliefStrength` table tests (empty-validation neutral, recency, confidence, verdict effects) + `rankByStrength` order.
- `packages/core/src/beliefs/inject.test.ts` — active-only filter, rank order, topN, empty → `""`.
- `packages/core/src/beliefs/belief-writer.test.ts` — activate/retire, 21st activation evicts weakest, retired persists, cap counts active only.

---

## Task 1: Belief content model, constants, id, record factory

**Files:**
- Create: `packages/core/src/beliefs/types.ts`
- Test: `packages/core/src/beliefs/types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/beliefs/types.test.ts
import { describe, expect, it } from "vitest"
import { deriveBeliefId, makeBeliefRecord, readBelief, BELIEF_KIND, BELIEF_NAMESPACE } from "./types.js"

describe("deriveBeliefId", () => {
  it("is deterministic for the same (domain, statement)", () => {
    const a = deriveBeliefId("comms", "Operator prefers terse answers")
    const b = deriveBeliefId("comms", "Operator prefers terse answers")
    expect(a).toBe(b)
  })
  it("differs across domain or statement", () => {
    expect(deriveBeliefId("comms", "x")).not.toBe(deriveBeliefId("finance", "x"))
    expect(deriveBeliefId("comms", "x")).not.toBe(deriveBeliefId("comms", "y"))
  })
  it("is whitespace/case insensitive on the statement", () => {
    expect(deriveBeliefId("comms", "Terse  Answers")).toBe(deriveBeliefId("comms", "terse answers"))
  })
})

describe("makeBeliefRecord", () => {
  it("builds an operator/belief record with proposed defaults", () => {
    const r = makeBeliefRecord({
      statement: "Operator prefers terse answers",
      confidence: 0.6,
      domain: "comms",
      evidence: ["session:abc#msg12"],
      now: 1000,
    })
    expect(r.kind).toBe(BELIEF_KIND)
    expect(r.namespace).toBe(BELIEF_NAMESPACE)
    expect(r.id).toBe(deriveBeliefId("comms", "Operator prefers terse answers"))
    expect(r.tags).toEqual(["comms"])
    expect(r.createdAt).toBe(1000)
    const c = readBelief(r)
    expect(c.status).toBe("proposed")
    expect(c.confidence).toBe(0.6)
    expect(c.validationHistory).toEqual([])
    expect(c.outreachRights).toEqual({ enabled: false, minConfidence: 0.8 })
  })
  it("honors an explicit status", () => {
    const r = makeBeliefRecord({ statement: "s", confidence: 0.9, domain: "d", status: "active", now: 0 })
    expect(readBelief(r).status).toBe("active")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun run vitest run src/beliefs/types.test.ts`
Expected: FAIL — cannot find module `./types.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/beliefs/types.ts
import type { MemoryRecord } from "@luna/memory"
import { makeRecord } from "@luna/memory"

/** Beliefs live in the operator namespace as kind:"belief" memory records. */
export const BELIEF_KIND = "belief"
export const BELIEF_NAMESPACE = "operator"
/** Max ACTIVE beliefs injected into the prompt; proposed/retired don't count. */
export const BELIEF_CAP = 20

export type BeliefStatus = "proposed" | "active" | "retired"
export type BeliefVerdict = "confirmed" | "corrected" | "rejected"

export interface BeliefValidation {
  readonly at: number
  readonly verdict: BeliefVerdict
  readonly via: "survey" | "outreach"
}

export interface BeliefOutreachRights {
  readonly enabled: boolean
  readonly minConfidence: number
}

/** Structured `content` of a belief MemoryRecord (spec §5.1). */
export interface BeliefContent {
  readonly statement: string
  readonly confidence: number // 0–1, set by Dream
  readonly status: BeliefStatus
  readonly domain: string
  readonly evidence: ReadonlyArray<string> // provenance: "session:abc#msg12"
  readonly validationHistory: ReadonlyArray<BeliefValidation> // per-belief track record
  readonly outreachRights: BeliefOutreachRights
}

/** FNV-1a 32-bit hash → stable hex id (no external dep). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/**
 * Deterministic belief id from (domain, normalized statement). Whitespace-
 * collapsed + lowercased so paraphrase-identical statements collide (upsert,
 * not duplicate) — the Phase 1 "C1" idempotency lesson applied to beliefs.
 */
export function deriveBeliefId(domain: string, statement: string): string {
  const norm = statement.trim().toLowerCase().replace(/\s+/g, " ")
  return `belief-${domain}-${fnv1a(`${domain} ${norm}`)}`
}

/** Construct a belief MemoryRecord. Defaults: status "proposed", no validation. */
export function makeBeliefRecord(input: {
  statement: string
  confidence: number
  domain: string
  evidence?: ReadonlyArray<string>
  status?: BeliefStatus
  outreachRights?: BeliefOutreachRights
  now?: number
}): MemoryRecord {
  const content: BeliefContent = {
    statement: input.statement,
    confidence: input.confidence,
    status: input.status ?? "proposed",
    domain: input.domain,
    evidence: input.evidence ?? [],
    validationHistory: [],
    outreachRights: input.outreachRights ?? { enabled: false, minConfidence: 0.8 },
  }
  return makeRecord({
    id: deriveBeliefId(input.domain, input.statement),
    namespace: BELIEF_NAMESPACE,
    kind: BELIEF_KIND,
    content,
    tags: [input.domain],
    now: input.now,
  })
}

/** Read a record's belief content (callers guarantee kind:"belief"). */
export function readBelief(rec: MemoryRecord): BeliefContent {
  return rec.content as BeliefContent
}

/** Is this record an active belief? */
export function isActiveBelief(rec: MemoryRecord): boolean {
  return rec.kind === BELIEF_KIND && readBelief(rec).status === "active"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun run vitest run src/beliefs/types.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/beliefs/types.ts packages/core/src/beliefs/types.test.ts
git commit -m "feat(beliefs): content model, deterministic id, record factory"
```

---

## Task 2: Belief strength scoring (eviction + ranking key)

**Files:**
- Create: `packages/core/src/beliefs/scoring.ts`
- Test: `packages/core/src/beliefs/scoring.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/beliefs/scoring.test.ts
import { describe, expect, it } from "vitest"
import { beliefStrength, rankByStrength } from "./scoring.js"
import { makeBeliefRecord } from "./types.js"
import type { BeliefContent } from "./types.js"

const DAY = 86_400_000
const base: BeliefContent = {
  statement: "s", confidence: 0.8, status: "active", domain: "d",
  evidence: [], validationHistory: [], outreachRights: { enabled: false, minConfidence: 0.8 },
}

describe("beliefStrength", () => {
  it("empty validation history is NEUTRAL (1.0), not zero", () => {
    // fresh, confident, unvalidated belief must NOT score 0 (the spec trap)
    const s = beliefStrength(base, /*updatedAt*/ 1000, /*now*/ 1000)
    expect(s).toBeCloseTo(0.8, 5) // confidence * 1 (recency) * 1 (validation)
  })
  it("decays with staleness", () => {
    const fresh = beliefStrength(base, 0, 0)
    const old = beliefStrength(base, 0, 45 * DAY)
    expect(old).toBeLessThan(fresh)
    expect(old).toBeGreaterThan(0) // never zeroed (floor)
  })
  it("never decays below the floor even when ancient", () => {
    const ancient = beliefStrength(base, 0, 10_000 * DAY)
    expect(ancient).toBeCloseTo(0.8 * 0.1, 5) // recency floor 0.1
  })
  it("confirmed history strengthens; rejected weakens", () => {
    const at = 0, now = 0
    const confirmed = beliefStrength(
      { ...base, validationHistory: [{ at, verdict: "confirmed", via: "survey" }] }, at, now)
    const rejected = beliefStrength(
      { ...base, validationHistory: [{ at, verdict: "rejected", via: "survey" }] }, at, now)
    expect(confirmed).toBeGreaterThan(0.8) // > neutral
    expect(rejected).toBeLessThan(0.8) // < neutral
  })
})

describe("rankByStrength", () => {
  it("orders strongest first", () => {
    const strong = makeBeliefRecord({ statement: "strong", confidence: 0.9, domain: "d", status: "active", now: 0 })
    const weak = makeBeliefRecord({ statement: "weak", confidence: 0.2, domain: "d", status: "active", now: 0 })
    const ranked = rankByStrength([weak, strong], 0)
    expect(ranked.map((r) => r.id)).toEqual([strong.id, weak.id])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun run vitest run src/beliefs/scoring.test.ts`
Expected: FAIL — cannot find module `./scoring.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/beliefs/scoring.ts
import type { MemoryRecord } from "@luna/memory"
import { readBelief } from "./types.js"
import type { BeliefContent } from "./types.js"

const DAY = 86_400_000
/** Beyond this age, recency hits the floor. */
const STALE_HORIZON_DAYS = 90
/** Recency never zeroes a belief — an old but confident belief still counts. */
const RECENCY_FLOOR = 0.1

/**
 * Belief strength — the eviction + ranking key. Higher = keep / inject first.
 * `confidence × recencyFactor × validationFactor`, all bounded so no single
 * term can zero the product (the spec's "× validation-track-record" trap:
 * validationHistory is empty until Phase 3, so it MUST be neutral, not 0).
 */
export function beliefStrength(
  content: BeliefContent,
  updatedAt: number,
  now: number,
): number {
  const ageDays = Math.max(0, (now - updatedAt) / DAY)
  const recencyFactor = Math.max(RECENCY_FLOOR, 1 - ageDays / STALE_HORIZON_DAYS)

  const h = content.validationHistory
  let validationFactor = 1.0 // NEUTRAL when no validation yet
  if (h.length > 0) {
    let net = 0
    for (const v of h) {
      if (v.verdict === "confirmed") net += 1
      else if (v.verdict === "corrected") net -= 1
      else net -= 2 // rejected hurts most
    }
    // map net/count into a bounded multiplier around 1.0
    validationFactor = Math.min(2, Math.max(0.25, 1 + net / h.length))
  }

  return content.confidence * recencyFactor * validationFactor
}

/** Rank belief records strongest-first (stable for equal strength via id). */
export function rankByStrength(
  records: ReadonlyArray<MemoryRecord>,
  now: number,
): ReadonlyArray<MemoryRecord> {
  return [...records].sort((a, b) => {
    const d = beliefStrength(readBelief(b), b.updatedAt, now) -
      beliefStrength(readBelief(a), a.updatedAt, now)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun run vitest run src/beliefs/scoring.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/beliefs/scoring.ts packages/core/src/beliefs/scoring.test.ts
git commit -m "feat(beliefs): pure beliefStrength scoring + rankByStrength (neutral empty-validation)"
```

---

## Task 3: Prompt injection formatter

**Files:**
- Create: `packages/core/src/beliefs/inject.ts`
- Test: `packages/core/src/beliefs/inject.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/beliefs/inject.test.ts
import { describe, expect, it } from "vitest"
import { composeBeliefsSection } from "./inject.js"
import { makeBeliefRecord } from "./types.js"

const active = (statement: string, confidence: number, domain = "comms") =>
  makeBeliefRecord({ statement, confidence, domain, status: "active", now: 0 })

describe("composeBeliefsSection", () => {
  it("returns '' when there are no active beliefs", () => {
    const proposed = makeBeliefRecord({ statement: "p", confidence: 0.9, domain: "d", status: "proposed", now: 0 })
    expect(composeBeliefsSection([proposed], 0)).toBe("")
    expect(composeBeliefsSection([], 0)).toBe("")
  })
  it("includes only active beliefs, ranked strongest-first", () => {
    const out = composeBeliefsSection([active("weak", 0.2), active("strong", 0.9)], 0)
    expect(out).toContain("strong")
    expect(out).toContain("weak")
    expect(out.indexOf("strong")).toBeLessThan(out.indexOf("weak"))
    expect(out).toMatch(/^## /m) // has a markdown header
  })
  it("respects topN", () => {
    const recs = [active("a", 0.9), active("b", 0.8), active("c", 0.7)]
    const out = composeBeliefsSection(recs, 0, { topN: 2 })
    expect(out).toContain("a")
    expect(out).toContain("b")
    expect(out).not.toContain("c")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun run vitest run src/beliefs/inject.test.ts`
Expected: FAIL — cannot find module `./inject.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/beliefs/inject.ts
import type { MemoryRecord } from "@luna/memory"
import { BELIEF_CAP, isActiveBelief, readBelief } from "./types.js"
import { rankByStrength } from "./scoring.js"

/**
 * Render the ranked active belief set as a system-prompt section — the
 * SQLite-backed analogue of DNA.md (spec §3.2). Returns "" when there are
 * no active beliefs so the caller's `.filter(Boolean)` drops it cleanly.
 */
export function composeBeliefsSection(
  records: ReadonlyArray<MemoryRecord>,
  now: number,
  opts?: { topN?: number },
): string {
  const topN = opts?.topN ?? BELIEF_CAP
  const active = records.filter(isActiveBelief)
  if (active.length === 0) return ""

  const lines = rankByStrength(active, now)
    .slice(0, topN)
    .map((r) => {
      const c = readBelief(r)
      return `- (${c.confidence.toFixed(2)}, ${c.domain}) ${c.statement}`
    })

  return [
    "## What I believe about Operator",
    "A validated, evolving model of Operator. Weight these but stay open to correction.",
    ...lines,
  ].join("\n")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun run vitest run src/beliefs/inject.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/beliefs/inject.ts packages/core/src/beliefs/inject.test.ts
git commit -m "feat(beliefs): composeBeliefsSection prompt formatter (active-only, ranked)"
```

---

## Task 4: Belief writer — activate (cap+evict), retire, stage, list

**Files:**
- Create: `packages/core/src/beliefs/belief-writer.ts`
- Test: `packages/core/src/beliefs/belief-writer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/beliefs/belief-writer.test.ts
import { describe, expect, it } from "vitest"
import { Effect, Layer, Ref, Stream } from "effect"
import { Clock } from "../clock.js"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryQuery, MemoryRecord } from "@luna/memory"
import { BeliefWriter } from "./belief-writer.js"
import { makeBeliefRecord, readBelief, BELIEF_CAP } from "./types.js"

// Ref-backed memory router double with a working query (namespace/kind/since).
const FakeMemory = (initial: ReadonlyArray<MemoryRecord> = []) =>
  Layer.effect(
    MemoryRouterTag,
    Effect.gen(function* () {
      const store = yield* Ref.make<Map<string, MemoryRecord>>(
        new Map(initial.map((r) => [r.id, r])),
      )
      return {
        put: (rec: MemoryRecord) => Ref.update(store, (m) => new Map(m).set(rec.id, rec)),
        get: (id: string) => Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
        delete: (id: string) =>
          Ref.modify(store, (m) => {
            const had = m.has(id)
            const next = new Map(m)
            next.delete(id)
            return [had, next]
          }),
        query: (q: MemoryQuery) =>
          Stream.unwrap(
            Ref.get(store).pipe(
              Effect.map((m) =>
                Stream.fromIterable(
                  Array.from(m.values()).filter(
                    (r) =>
                      (q.namespace === undefined || r.namespace === q.namespace) &&
                      (q.kind === undefined || r.kind === q.kind) &&
                      (q.since === undefined || r.updatedAt >= q.since),
                  ),
                ),
              ),
            ),
          ),
        search: () => { throw new Error("unused") },
      } as never
    }),
  )

const provide = <A, E>(eff: Effect.Effect<A, E, any>, mem: Layer.Layer<any>) =>
  eff.pipe(Effect.provide(BeliefWriter.Default), Effect.provide(mem), Effect.provide(Clock.Default))

describe("BeliefWriter", () => {
  it("activateBelief flips proposed → active", async () => {
    const b = makeBeliefRecord({ statement: "s", confidence: 0.7, domain: "d", status: "proposed", now: 0 })
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const w = yield* BeliefWriter
          yield* w.activateBelief(b.id)
          const mem = yield* MemoryRouterTag
          return yield* mem.get(b.id)
        }),
        FakeMemory([b]),
      ),
    )
    expect(readBelief(out!).status).toBe("active")
  })

  it("retireBelief flips active → retired (record persists)", async () => {
    const b = makeBeliefRecord({ statement: "s", confidence: 0.7, domain: "d", status: "active", now: 0 })
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const w = yield* BeliefWriter
          yield* w.retireBelief(b.id)
          const mem = yield* MemoryRouterTag
          return yield* mem.get(b.id)
        }),
        FakeMemory([b]),
      ),
    )
    expect(readBelief(out!).status).toBe("retired")
  })

  it("activating a 21st belief evicts the weakest (cap on active only)", async () => {
    // 20 active beliefs with descending confidence (b00 strongest ... b19 weakest)
    const actives = Array.from({ length: BELIEF_CAP }, (_, i) =>
      makeBeliefRecord({ statement: `b${i}`, confidence: 0.9 - i * 0.01, domain: "d", status: "active", now: 0 }),
    )
    // a proposed 21st, stronger than the current weakest
    const newcomer = makeBeliefRecord({ statement: "newcomer", confidence: 0.95, domain: "d", status: "proposed", now: 0 })
    const weakest = actives[actives.length - 1]!

    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const w = yield* BeliefWriter
          yield* w.activateBelief(newcomer.id)
          const active = yield* w.listActive()
          const mem = yield* MemoryRouterTag
          const retired = yield* mem.get(weakest.id)
          return { activeCount: active.length, activeIds: active.map((r) => r.id), weakestStatus: readBelief(retired!).status }
        }),
        FakeMemory([...actives, newcomer]),
      ),
    )
    expect(out.activeCount).toBe(BELIEF_CAP) // still 20
    expect(out.activeIds).toContain(newcomer.id) // newcomer is in
    expect(out.weakestStatus).toBe("retired") // weakest evicted
  })

  it("stageProposed writes a proposed belief record", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const w = yield* BeliefWriter
          const rec = makeBeliefRecord({ statement: "x", confidence: 0.5, domain: "d", now: 0 })
          yield* w.stageProposed(rec)
          const mem = yield* MemoryRouterTag
          return yield* mem.get(rec.id)
        }),
        FakeMemory([]),
      ),
    )
    expect(out).not.toBeNull()
    expect(readBelief(out!).status).toBe("proposed")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun run vitest run src/beliefs/belief-writer.test.ts`
Expected: FAIL — cannot find module `./belief-writer.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/beliefs/belief-writer.ts
import { Effect, Layer, Stream } from "effect"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { Clock } from "../clock.js"
import { BELIEF_CAP, BELIEF_KIND, BELIEF_NAMESPACE, readBelief } from "./types.js"
import type { BeliefContent, BeliefStatus } from "./types.js"
import { rankByStrength } from "./scoring.js"

export interface BeliefWriterApi {
  /** All belief records in the operator namespace. */
  readonly listAll: () => Effect.Effect<ReadonlyArray<MemoryRecord>>
  /** Active beliefs only (the injected set). */
  readonly listActive: () => Effect.Effect<ReadonlyArray<MemoryRecord>>
  readonly listByStatus: (status: BeliefStatus) => Effect.Effect<ReadonlyArray<MemoryRecord>>
  /** Stage a candidate as a `proposed` record (Dream's promotion target). */
  readonly stageProposed: (rec: MemoryRecord) => Effect.Effect<void>
  /** proposed → active. Enforces the ≤20 active cap (evicts the weakest). */
  readonly activateBelief: (id: string) => Effect.Effect<boolean>
  /** any → retired (record persists for audit/undo). */
  readonly retireBelief: (id: string) => Effect.Effect<boolean>
}

export class BeliefWriter extends Effect.Tag("luna/BeliefWriter")<
  BeliefWriter,
  BeliefWriterApi
>() {
  static readonly Default = Layer.effect(
    BeliefWriter,
    Effect.gen(function* () {
      const mem = yield* MemoryRouterTag
      const clock = yield* Clock

      const listAll = () =>
        mem
          .query({ namespace: BELIEF_NAMESPACE, kind: BELIEF_KIND })
          .pipe(Stream.runCollect, Effect.map((c) => Array.from(c)))

      const listByStatus = (status: BeliefStatus) =>
        listAll().pipe(Effect.map((rs) => rs.filter((r) => readBelief(r).status === status)))

      const listActive = () => listByStatus("active")

      const setStatus = (id: string, status: BeliefStatus) =>
        Effect.gen(function* () {
          const rec = yield* mem.get(id)
          if (rec === null || rec.kind !== BELIEF_KIND) return false
          const now = yield* clock.nowMs()
          const content: BeliefContent = { ...readBelief(rec), status }
          yield* mem.put({ ...rec, content, updatedAt: now })
          return true
        })

      const stageProposed = (rec: MemoryRecord) => mem.put(rec).pipe(Effect.asVoid)

      const retireBelief = (id: string) => setStatus(id, "retired")

      const activateBelief = (id: string) =>
        Effect.gen(function* () {
          const ok = yield* setStatus(id, "active")
          if (!ok) return false
          // Enforce the cap on the ACTIVE set only: keep the strongest
          // BELIEF_CAP active, retire the rest (weakest-first).
          const active = yield* listActive()
          if (active.length > BELIEF_CAP) {
            const now = yield* clock.nowMs()
            const ranked = rankByStrength(active, now)
            for (const loser of ranked.slice(BELIEF_CAP)) {
              yield* retireBelief(loser.id)
            }
          }
          return true
        })

      return { listAll, listActive, listByStatus, stageProposed, activateBelief, retireBelief }
    }),
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun run vitest run src/beliefs/belief-writer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/beliefs/belief-writer.ts packages/core/src/beliefs/belief-writer.test.ts
git commit -m "feat(beliefs): BeliefWriter — activate (cap+evict), retire, stage, list"
```

---

## Task 5: Barrel exports + wire into core index

**Files:**
- Create: `packages/core/src/beliefs/index.ts`
- Modify: `packages/core/src/index.ts` (add belief export after the dream export on line 40)

- [ ] **Step 1: Write the barrel**

```typescript
// packages/core/src/beliefs/index.ts
export * from "./types.js"
export * from "./scoring.js"
export * from "./inject.js"
export * from "./belief-writer.js"
```

- [ ] **Step 2: Add the core export**

In `packages/core/src/index.ts`, immediately after the line `export * from "./dream/index.js"`, add:

```typescript
export * from "./beliefs/index.js"
```

- [ ] **Step 3: Verify the package builds / typechecks**

Run: `cd packages/core && bun run tsc --noEmit`
Expected: no type errors (exit 0).

- [ ] **Step 4: Run the whole beliefs suite**

Run: `cd packages/core && bun run vitest run src/beliefs/`
Expected: PASS — all belief tests (Tasks 1–4) green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/beliefs/index.ts packages/core/src/index.ts
git commit -m "feat(beliefs): barrel exports + wire into @luna/core index"
```

---

## Task 6: Dream wiring — promote candidates into staged `proposed` beliefs

This is the §7.2 "Dream begins promoting candidates" deliverable. `belief_candidate` ops move from *held* (Phase 1) to *materialized* as `proposed` belief records (spec-delta #3). They are still **not** injected — only `active` beliefs are.

**Files:**
- Modify: `packages/core/src/dream/dream.ts:13` (the `AUTO_APPLY` set) and its comment
- Modify: `packages/core/src/dream/dream.test.ts` (update the held-ops test; add a staging test)

- [ ] **Step 1: Update the existing dream tests (red)**

In `packages/core/src/dream/dream.test.ts`, the test `"does NOT apply non-dedup ops; logs them 'proposed' and leaves memory untouched"` currently includes a `belief_candidate` op (line ~76). **Remove that one op line** so the held-set test only covers still-held kinds:

```typescript
// in the "does NOT apply non-dedup ops" test, the ops array becomes:
const ops: DreamOp[] = [
  { kind: "memory_staleness", targetId: "dup-1", before: rec("dup-1"), after: { ...rec("dup-1"), content: { updated: true } }, rationale: "stale" },
  { kind: "memory_contradiction", targetId: "other-1", before: null, after: { resolved: true }, rationale: "conflict" },
]
// ...and assert exactly these 2 rows are 'proposed' (adjust the length assertion to 2)
```

Then add a new test asserting `belief_candidate` IS materialized:

```typescript
it("materializes belief_candidate as a proposed belief record (audit 'applied')", async () => {
  const candidate = makeBeliefRecord({ statement: "Operator prefers terse answers", confidence: 0.6, domain: "comms", now: 0 })
  const out = await Effect.runPromise(
    provide(
      Effect.gen(function* () {
        const mem = yield* MemoryRouterTag
        const store = yield* DreamStore
        const ops: DreamOp[] = [
          { kind: "belief_candidate", targetId: candidate.id, before: null, after: candidate, rationale: "recurring pattern across 3 sessions" },
        ]
        yield* applyOps("dream-0-100", ops)
        const stored = yield* mem.get(candidate.id)
        const rows = yield* store.list({ dreamId: "dream-0-100" })
        return { stored, rows }
      }),
      // FakeMemory in dream.test.ts must support get for the candidate id; it
      // already maps initial records by id and put/get work — start empty.
      FakeMemory([]),
    ),
  )
  expect(out.stored).not.toBeNull() // belief record written
  expect((out.stored!.content as { status: string }).status).toBe("proposed")
  expect(out.rows).toHaveLength(1)
  expect(out.rows[0]?.status).toBe("applied") // op applied (undoable)
})
```

Add the import at the top of `dream.test.ts`:

```typescript
import { makeBeliefRecord } from "../beliefs/types.js"
```

- [ ] **Step 2: Run tests to verify the new test fails**

Run: `cd packages/core && bun run vitest run src/dream/dream.test.ts`
Expected: FAIL — the new `belief_candidate` materialization test fails (record is null; row status is `proposed`, not `applied`), because `belief_candidate` is not yet in the materialize set.

- [ ] **Step 3: Extend the materialize set in dream.ts**

In `packages/core/src/dream/dream.ts`, change line 12–13 from:

```typescript
/** Phase 1: the ONLY op kind safe to auto-apply without survey/undo coverage. */
const AUTO_APPLY: ReadonlySet<DreamOpKind> = new Set<DreamOpKind>(["memory_dedup"])
```

to:

```typescript
/**
 * Ops materialized to the store (vs. held as 'proposed' audit rows).
 *  - memory_dedup: idempotent delete of an exact duplicate (Phase 1).
 *  - belief_candidate: stage a PROPOSED belief record (Phase 2 §7.2). Safe to
 *    auto-write because a proposed belief is inert — only ACTIVE beliefs are
 *    injected, and activation stays gated on the Phase 3 survey. Undoable via
 *    revert (before:null → delete).
 * Still HELD as 'proposed' (no survey to catch a bad apply yet): memory_staleness,
 * memory_contradiction.
 */
const AUTO_APPLY: ReadonlySet<DreamOpKind> = new Set<DreamOpKind>([
  "memory_dedup",
  "belief_candidate",
])
```

No other change is needed: `applyOps` already `put`s `op.after` (the belief record) for materialized kinds and records the audit row `applied`; `revert` already deletes when `before === null`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && bun run vitest run src/dream/dream.test.ts`
Expected: PASS — held-ops test (now 2 ops) + new `belief_candidate` materialization test both green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/dream/dream.ts packages/core/src/dream/dream.test.ts
git commit -m "feat(dream): promote belief_candidate ops into staged proposed beliefs (Phase 2 §7.2)"
```

---

## Task 7: Inject active beliefs into the thread system prompt

> **⚠️ DEFERRED TO PHASE 3 (decision: the operator, 2026-05-28).** During Phase 2 execution
> this task was found to rest on a wrong assumption and to carry disproportionate risk:
>
> 1. **The plan's bare `yield* MemoryRouterTag` (Step 2 below) does NOT work as written.**
>    `ThreadToolsProviderLayer` is built self-sufficient via its own
>    `.pipe(Layer.provide(obsL), Layer.provide(clockL))` (chat-server.ts ~line 484), and it is
>    combined with `memoryRouterL` via `Layer.mergeAll` — which does **NOT** cross-wire
>    siblings. Adding `yield* MemoryRouterTag` inside the provider's `Effect.gen` therefore
>    leaves an **unsatisfied `MemoryRouter` requirement**.
> 2. **No typecheck gate exists on `chat-server.ts`** — root `tsconfig.json` *excludes*
>    `apps/ui-web/**`, and `apps/ui-web/tsconfig.json` only `include`s `src/**` (the file lives
>    in `scripts/`). It is Bun-executed (transpile-only). So the unmet requirement would NOT be
>    caught by any `tsc`.
> 3. **The failure mode is catastrophic, not cosmetic.** chat-server.ts's own comment
>    (~lines 467–469) warns that a missing `MemoryRouter` in this graph "takes down the whole
>    chatWithTools wiring (every MCP tool with it)" at boot.
> 4. **Zero Phase-2 upside.** Nothing activates beliefs until Phase 3 (the manual-activation
>    path was intentionally not built), so the injected section is *always empty* now.
>
> Phase 2 is complete and self-contained without this task (store, scoring, formatter,
> writer, and Dream promotion are all built + unit-tested). Task 7 is a leaf — nothing
> depends on it.
>
> **VERIFIED WIRING RECIPE FOR PHASE 3** (do this instead of the steps below):
> - In `chat-server.ts`, provide the router INTO the thread-tools layer so the requirement is
>   satisfied locally (mirrors how `obsL`/`clockL` are provided):
>   ```typescript
>   const threadToolsL = ThreadToolsProviderLayer().pipe(
>     Layer.provide(memoryRouterL),   // ← ADD: satisfies MemoryRouter inside the layer
>     Layer.provide(obsL),
>     Layer.provide(clockL),
>   )
>   ```
>   (`memoryRouterL` is already defined just above `threadToolsL`; this creates a second
>   read-only router instance over the same db file — harmless for reads.)
> - Add `Stream` to the `effect` import (chat-server.ts:136 currently imports only
>   `{ Effect, Layer, ManagedRuntime, Option }`).
> - Then the boot-fetch + `composeBeliefsSection` injection (Steps 1–3 below) works.
> - **Phase 3 note:** activation makes beliefs non-empty, so ALSO move the fetch from boot
>   into `decorate()` for per-thread freshness (a just-activated belief should appear in the
>   next thread).
> - **VERIFY (no tsc net):** a focused layer-build smoke test under `ManagedRuntime` with a
>   seeded `MemoryRouter` — assert `threadToolsL` builds with no missing-service error, and
>   that `decorate()`'s output contains the beliefs section when one ACTIVE belief is seeded.
>   Do NOT eyeball it; do NOT rely on "it's inert so it can't break" — the failure mode is the
>   boot, not the beliefs.

The original (pre-correction) steps are retained below as a starting point — but they are
**incomplete** without the `Layer.provide(memoryRouterL)` fix above.

**Files:**
- Modify: `apps/ui-web/scripts/chat-server.ts` (the `ThreadToolsProviderLayer` `Effect.gen`, ~lines 228–282; AND `threadToolsL` assembly ~line 484)

- [ ] **Step 1: Import the belief helpers**

At the top of `apps/ui-web/scripts/chat-server.ts`, add to the existing `@luna/core` import (or add a new import line):

```typescript
import { composeBeliefsSection, BELIEF_NAMESPACE, BELIEF_KIND } from "@luna/core"
import { MemoryRouterTag } from "@luna/memory"
```

(If `@luna/core` / `@luna/memory` are already imported, merge the named imports into the existing statements.)

- [ ] **Step 2: Fetch active beliefs at boot, inside the provider's `Effect.gen`**

In the `ThreadToolsProviderLayer` `Effect.gen` (after `const dnaContent = loadDna(__scriptDir)` near line 247), add:

```typescript
// Beliefs: SQLite-backed analogue of DNA.md (spec §3.2). Fetch the operator's
// belief records at boot and render the ACTIVE ones (composeBeliefsSection
// filters to active + ranks by strength). Phase 2 has no active beliefs yet,
// so this is empty until the Phase 3 survey activates beliefs.
// PHASE 3: move this fetch into decorate() (per-thread refresh) once activation
// is live, so a just-activated belief appears in the next thread immediately.
const mem = yield* MemoryRouterTag
const beliefRecords = yield* mem
  .query({ namespace: BELIEF_NAMESPACE, kind: BELIEF_KIND })
  .pipe(Stream.runCollect, Effect.map((c) => Array.from(c)))
const beliefsContent = composeBeliefsSection(beliefRecords, Date.now())
console.log(
  "[luna/boot] beliefs injected:",
  beliefRecords.filter((r) => (r.content as { status?: string }).status === "active").length,
  "active",
)
```

Ensure `Stream` is imported from `effect` at the top of the file (it is used elsewhere; if not, add `Stream` to the `effect` import).

- [ ] **Step 3: Add `beliefsContent` to the system-prompt array**

In `decorate()` (the `systemPrompt` array near line 272), insert `beliefsContent` right after `sessionMetadata`:

```typescript
const systemPrompt = [
  dnaContent,
  sessionMetadata,
  beliefsContent,
  opts.systemPrompt,
  memoryThreadTools.systemPromptAddendum,
  schedulerThreadTools.systemPromptAddendum,
  obsThreadTools.systemPromptAddendum,
  localShellThreadTools.systemPromptAddendum,
]
  .filter((s): s is string => typeof s === "string" && s.length > 0)
  .join("\n\n")
```

The existing `.filter((s) => ... s.length > 0)` already drops the empty section, so no active beliefs ⇒ no change to the prompt.

- [ ] **Step 4: Verify the app typechecks**

Run: `cd apps/ui-web && bun run tsc --noEmit` (or the repo's app typecheck script, e.g. `bun run typecheck` from the app dir)
Expected: no type errors (exit 0).

- [ ] **Step 5: Verify the boot log path with a seeded active belief (manual smoke)**

This is a wiring change with no unit harness around the app script. Smoke-test it by confirming the boot log line appears. With an empty belief store the expected log is `[luna/boot] beliefs injected: 0 active`. (Optional: seed one `active` belief via a REPL/script using `makeBeliefRecord({..., status:"active"})` + `MemoryRouterTag.put`, restart, and confirm the count increments and the `## What I believe about Operator` section appears in a new thread's prompt.)

- [ ] **Step 6: Commit**

```bash
git add apps/ui-web/scripts/chat-server.ts
git commit -m "feat(beliefs): inject ranked active beliefs into thread system prompt (DNA-style)"
```

---

## Task 8: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full core test suite**

Run: `cd packages/core && bun run vitest run`
Expected: PASS — all existing dream tests + new beliefs tests green, no regressions.

- [ ] **Step 2: Typecheck the whole workspace**

Run: from repo root, `bun run typecheck` (or the workspace's equivalent — check `package.json` scripts)
Expected: exit 0.

- [ ] **Step 3: Final review commit (if any lint/format fixes were needed)**

```bash
git add -A
git commit -m "chore(beliefs): Phase 2 belief set complete — lint/format + suite green"
```

---

## Self-review (run after writing, before execution)

**Spec coverage (§3.2 / §5.1 / §7.2):**
- ✅ Beliefs as `MemoryRecord` `kind:"belief"`, no migration — Task 1.
- ✅ `namespace:"operator"`, domain mirrored to `tags` — Task 1 (`tags:[domain]`).
- ✅ Structured `content` per §5.1 (statement, confidence, status, domain, evidence, validationHistory, outreachRights) — Task 1 `BeliefContent`.
- ✅ Capped at 20, weakest retired (status flip, not deleted) — Task 4 `activateBelief` cap enforcement.
- ✅ Cap enforced by the writer, not the store — Task 4.
- ◐ Ranked top-N injection — **formatter built + unit-tested (Task 3)**; chat-server *wiring* (Task 7) **DEFERRED to Phase 3** (boot-risk + no tsc gate + inert in P2; verified recipe captured in Task 7 banner).
- ✅ Dream begins promoting candidates — Task 6.
- ✅ Eviction key `confidence × staleness × validation` made concrete + neutral empty-validation — Task 2.

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step has complete code; every test step has assertions; commands have expected output. ✅

**Type consistency:**
- `BeliefContent`, `BeliefStatus`, `BeliefVerdict` defined once (Task 1), reused in Tasks 2/3/4. ✅
- `deriveBeliefId(domain, statement)` signature identical across Tasks 1/6. ✅
- `makeBeliefRecord` field names (`statement`, `confidence`, `domain`, `evidence`, `status`, `now`) consistent across Tasks 1/2/3/4/6. ✅
- `composeBeliefsSection(records, now, opts?)` signature identical in Tasks 3/7. ✅
- `BeliefWriter` method names (`listActive`, `activateBelief`, `retireBelief`, `stageProposed`, `listByStatus`, `listAll`) consistent (Task 4). ✅
- `BELIEF_KIND`/`BELIEF_NAMESPACE`/`BELIEF_CAP` constants used identically in Tasks 1/3/4/6/7. ✅

**Open questions deferred (non-blocking, noted in code):**
- Per-thread belief refresh (vs. boot-time) — `// PHASE 3:` note in Task 7.
- Domain-relevance-to-current-thread ranking — deferred (spec-delta #6); `beliefStrength` is the v1 ranking.
- Manual operator activation path (a CLI to hand-activate before Phase 3) — intentionally NOT built (honors "machinery now, activation in Phase 3").
