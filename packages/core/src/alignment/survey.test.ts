// packages/core/src/alignment/survey.test.ts
import { describe, expect, it } from "vitest"
import { Effect, Layer, Ref, Stream } from "effect"
import { Clock } from "../clock.js"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryQuery, MemoryRecord } from "@luna/memory"
import { BeliefWriter } from "../beliefs/belief-writer.js"
import { makeBeliefRecord, readBelief } from "../beliefs/types.js"
import { AlignmentStore } from "./alignment-store.js"
import { updateEwma } from "./cadence.js"
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
        delete: (id: string) =>
          Ref.modify(store, (m) => {
            const had = m.has(id)
            const n = new Map(m)
            n.delete(id)
            return [had, n]
          }),
        query: (q: MemoryQuery) =>
          Stream.unwrap(
            Ref.get(store).pipe(
              Effect.map((m) =>
                Stream.fromIterable(
                  Array.from(m.values()).filter(
                    (r) =>
                      (q.namespace === undefined || r.namespace === q.namespace) &&
                      (q.kind === undefined || r.kind === q.kind),
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
  eff.pipe(
    Effect.provide(Survey.Default),
    Effect.provide(BeliefWriter.Default),
    Effect.provide(AlignmentStore.Memory),
    Effect.provide(mem),
    Effect.provide(Clock.Test(100)),
  )

// ──────────────────────────────────────────────────────────────────────────────
// INVARIANT 1 — Category boundary §2.3 / spec-delta #4
// ──────────────────────────────────────────────────────────────────────────────
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

  it("belief_validation does NOT move the global EWMA, but updates the belief (THE category boundary)", async () => {
    const b = makeBeliefRecord({ statement: "s", confidence: 0.7, domain: "comms", status: "active", now: 0 })
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          const v: SurveyVerdict = {
            itemId: "i2",
            kind: "belief_validation",
            ref: `belief:${b.id}`,
            beliefId: b.id,
            verdict: "confirmed",
            via: "survey",
          }
          yield* survey.processVerdict(v)
          const store = yield* AlignmentStore
          const mem = yield* MemoryRouterTag
          return { ewma: yield* store.getEwma, belief: yield* mem.get(b.id) }
        }),
        FakeMemory([b]),
      ),
    )
    expect(out.ewma).toBe(0) // EWMA UNCHANGED — the category boundary (spec-delta #4)
    expect(readBelief(out.belief!).validationHistory).toHaveLength(1) // belief updated
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// INVARIANT 2 — Activation policy spec-delta #7 (each branch)
// ──────────────────────────────────────────────────────────────────────────────
describe("Survey.processVerdict — activation policy (spec-delta #7)", () => {
  const proposed = (statement: string) =>
    makeBeliefRecord({ statement, confidence: 0.7, domain: "comms", status: "proposed", now: 0 })

  it("confirmed on a proposed belief activates it", async () => {
    const b = proposed("activate me")
    const status = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          yield* survey.processVerdict({
            itemId: "i", kind: "belief_validation", ref: b.id, beliefId: b.id, verdict: "confirmed", via: "survey",
          })
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
          yield* survey.processVerdict({
            itemId: "i", kind: "belief_validation", ref: b.id, beliefId: b.id, verdict: "rejected", via: "survey",
          })
          const mem = yield* MemoryRouterTag
          return readBelief((yield* mem.get(b.id))!).status
        }),
        FakeMemory([b]),
      ),
    )
    expect(status).toBe("retired")
  })

  it("corrected leaves a proposed belief proposed (records validation only, no promotion)", async () => {
    const b = proposed("correct me")
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          yield* survey.processVerdict({
            itemId: "i", kind: "belief_validation", ref: b.id, beliefId: b.id, verdict: "corrected", via: "survey",
          })
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

  it("already-active belief + confirmed: stays active, only recordValidation (no re-cap)", async () => {
    // Pins verdict-independence of the status guard: applyActivationPolicy early-returns
    // for any non-proposed status BEFORE the verdict switch, so confirmed on an active
    // belief is re-validation, not a re-activation/re-cap.
    const b = makeBeliefRecord({ statement: "already active confirmed", confidence: 0.9, domain: "comms", status: "active", now: 0 })
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          yield* survey.processVerdict({
            itemId: "i", kind: "belief_validation", ref: b.id, beliefId: b.id, verdict: "confirmed", via: "survey",
          })
          const mem = yield* MemoryRouterTag
          const rec = (yield* mem.get(b.id))!
          return { status: readBelief(rec).status, historyLen: readBelief(rec).validationHistory.length }
        }),
        FakeMemory([b]),
      ),
    )
    expect(out.status).toBe("active")
    expect(out.historyLen).toBe(1)
  })

  it("already-active belief: all verdicts only recordValidation (no re-cap/retire)", async () => {
    // This is the surprising-but-correct branch — applyActivationPolicy returns early for non-proposed.
    // A survey `rejected` must NOT retire an active belief (only the full retirement
    // workflow does that, not a belief_validation verdict on an already-active belief).
    const b = makeBeliefRecord({ statement: "already active", confidence: 0.9, domain: "comms", status: "active", now: 0 })
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          yield* survey.processVerdict({
            itemId: "i", kind: "belief_validation", ref: b.id, beliefId: b.id, verdict: "rejected", via: "survey",
          })
          const mem = yield* MemoryRouterTag
          const rec = (yield* mem.get(b.id))!
          return { status: readBelief(rec).status, historyLen: readBelief(rec).validationHistory.length }
        }),
        FakeMemory([b]),
      ),
    )
    // Active belief stays active — only recordValidation (re-validation), no retire.
    expect(out.status).toBe("active")
    expect(out.historyLen).toBe(1)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// INVARIANT 3 — Idempotency spec-delta #5 + T4's flag
// Processing the SAME verdict twice → one log row, one validation entry,
// EWMA moved only once.
// ──────────────────────────────────────────────────────────────────────────────
describe("Survey.processVerdict — idempotency (spec-delta #5)", () => {
  it("processing the same verdict twice yields one log row, one validation entry, and EWMA moved exactly once", async () => {
    // outreach_welcome on an active belief exercises all three at once:
    //  - EWMA eligible → tests EWMA moves once (not twice)
    //  - belief-bound → tests validationHistory dedups
    //  - append → tests log has one row
    //
    // CRITICAL: v.at = 50, Clock.Test(100). If processVerdict uses clock.nowMs()
    // for 'at' it would use 100 on both calls (same result with Test clock — that
    // would hide the bug). We set v.at=50 and assert validation.at===50 to
    // prove the verdict's own timestamp is used, not the clock.
    const b = makeBeliefRecord({ statement: "idempotent", confidence: 0.9, domain: "comms", status: "active", now: 0 })
    const v: SurveyVerdict = {
      itemId: "idem", kind: "outreach_welcome", ref: b.id, beliefId: b.id, verdict: "confirmed", via: "outreach", at: 50,
    }
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          yield* survey.processVerdict(v)
          yield* survey.processVerdict(v) // exact same verdict — must be a no-op
          const store = yield* AlignmentStore
          const mem = yield* MemoryRouterTag
          return {
            logRows: (yield* store.list({})).length,
            ewma: yield* store.getEwma,
            validationHistory: readBelief((yield* mem.get(b.id))!).validationHistory,
          }
        }),
        FakeMemory([b]),
      ),
    )
    expect(out.logRows).toBe(1) // one log row (not two)
    expect(out.ewma).toBeCloseTo(updateEwma(0, 1), 10) // EWMA moved once (not twice)
    expect(out.validationHistory).toHaveLength(1) // one validation entry (not two)
    expect(out.validationHistory[0]?.at).toBe(50) // verdict's own timestamp used, not clock's
  })

  it("with at undefined, the fixed clock supplies a stable `at` → still one log row on replay", async () => {
    // Documents the constraint: idempotency relies on a STABLE `at`. When the verdict
    // omits `at`, processVerdict falls back to clock.nowMs(); under Clock.Test(100) that
    // fallback is deterministic, so a replay derives the same idempotency key → one row.
    // (In production a real clock would NOT be stable across retries — hence callers that
    //  need replay-safety must supply v.at; this test pins the fallback path's behavior.)
    const v: SurveyVerdict = { itemId: "noat", kind: "task_quality", ref: "task:noat", score: 1, via: "survey" }
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          yield* survey.processVerdict(v)
          yield* survey.processVerdict(v) // same verdict, no explicit at — fixed clock makes at stable
          const store = yield* AlignmentStore
          return { logRows: (yield* store.list({})).length, ewma: yield* store.getEwma }
        }),
        FakeMemory([]),
      ),
    )
    expect(out.logRows).toBe(1) // stable `at` (fixed clock) → idempotent
    expect(out.ewma).toBeCloseTo(updateEwma(0, 1), 10) // EWMA moved once
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// outreach_welcome dual-routing §2.3
// ──────────────────────────────────────────────────────────────────────────────
describe("Survey.processVerdict — outreach_welcome dual-routing (§2.3)", () => {
  it("feeds BOTH the EWMA and the belief track record", async () => {
    const b = makeBeliefRecord({ statement: "s", confidence: 0.9, domain: "comms", status: "active", now: 0 })
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          yield* survey.processVerdict({
            itemId: "i", kind: "outreach_welcome", ref: b.id, beliefId: b.id, verdict: "confirmed", via: "outreach",
          })
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

// ──────────────────────────────────────────────────────────────────────────────
// nextSurvey
// ──────────────────────────────────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────────────────────────
// Survey.pendingSurvey (D-LOCK-2/3/4)
// ──────────────────────────────────────────────────────────────────────────────
describe("Survey.pendingSurvey (D-LOCK-2/3/4)", () => {
  const proposed = (statement: string) =>
    makeBeliefRecord({ statement, confidence: 0.7, domain: "comms", status: "proposed", now: 0 })

  it("cold start (no task_quality rows): survey is DUE and includes a task_quality item", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          return yield* survey.pendingSurvey(5000)
        }),
        FakeMemory([]),
      ),
    )
    expect(out).not.toBeNull()
    expect(out!.issuedAt).toBe(5000)
    expect(out!.items.some((i) => i.kind === "task_quality")).toBe(true)
  })

  it("ALWAYS carries exactly one task_quality item (the D-LOCK-2 precondition)", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          return yield* survey.pendingSurvey(5000)
        }),
        FakeMemory([proposed("a"), proposed("b")]),
      ),
    )
    expect(out!.items.filter((i) => i.kind === "task_quality")).toHaveLength(1)
  })

  it("caps proposed beliefs at 3 (D-LOCK-3); overflow rolls to next survey (all stay proposed — read-only)", async () => {
    const beliefs = ["a", "b", "c", "d", "e"].map(proposed)
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          const pending = yield* survey.pendingSurvey(5000)
          // pendingSurvey is READ-ONLY: it sources items but never mutates the
          // beliefs. The 2 overflow beliefs (and the 3 surfaced) all stay proposed.
          const writer = yield* BeliefWriter
          const stillProposed = (yield* writer.listByStatus("proposed")).length
          return { pending, stillProposed }
        }),
        FakeMemory(beliefs),
      ),
    )
    expect(out.pending!.items.filter((i) => i.kind === "belief_validation")).toHaveLength(3)
    expect(out.stillProposed).toBe(5) // none promoted/retired — pendingSurvey did not mutate
  })

  it("no proposed beliefs: when due, still surfaces the task_quality item only", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          return yield* survey.pendingSurvey(5000)
        }),
        FakeMemory([]),
      ),
    )
    expect(out!.items).toHaveLength(1)
    expect(out!.items[0]?.kind).toBe("task_quality")
  })

  it("not due: returns null when now < lastSurveyAt + interval", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          // record a task_quality verdict at t=1000 → lastSurveyAt=1000, ewma climbs
          yield* survey.processVerdict({ itemId: "i", kind: "task_quality", ref: "task_quality", score: 1, via: "survey", at: 1000 })
          // ask again immediately at t=1001 — far inside the (≥1 day) interval
          return yield* survey.pendingSurvey(1001)
        }),
        FakeMemory([]),
      ),
    )
    expect(out).toBeNull()
  })
})
