// packages/core/src/alignment/loop.e2e.test.ts
/**
 * THE alignment-loop end-to-end proof.
 *
 * A single file read top-to-bottom that demonstrates:
 *   proposed → confirmed verdict → active → injected in composeBeliefsSection
 *   EWMA moves ONLY via task_quality (never via belief_validation — the §2.3
 *   category boundary)
 *   survey reschedules (lastSurveyAt advances, nextSurvey in the future)
 *   replay is idempotent (same at → one log row, EWMA unchanged)
 *   rejected → retired; corrected → stays proposed
 *
 * Uses the REAL Survey + AlignmentStore.Memory + BeliefWriter.Default +
 * Ref-backed FakeMemory MemoryRouter + Clock.Test — node-runnable, no bun:sqlite
 * gate. Mirrors the survey.test.ts FakeMemory/provide idiom exactly.
 *
 * TDD note: every assertion targets the REAL production path. If an assertion
 * fails it means a LOOP-CORRECTNESS BUG — do not weaken it to force a pass.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Ref, Stream } from "effect"
import { Clock } from "../clock.js"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryQuery, MemoryRecord } from "@luna/memory"
import { BeliefWriter } from "../beliefs/belief-writer.js"
import { makeBeliefRecord, readBelief } from "../beliefs/types.js"
import { composeBeliefsSection } from "../beliefs/inject.js"
import { AlignmentStore } from "./alignment-store.js"
import { Survey } from "./survey.js"

// ── Ref-backed FakeMemory (mirrors survey.test.ts exactly) ───────────────────

const FakeMemory = (initial: ReadonlyArray<MemoryRecord> = []) =>
  Layer.effect(
    MemoryRouterTag,
    Effect.gen(function* () {
      const store = yield* Ref.make<Map<string, MemoryRecord>>(
        new Map(initial.map((r) => [r.id, r])),
      )
      return {
        put: (rec: MemoryRecord) =>
          Ref.update(store, (m) => new Map(m).set(rec.id, rec)),
        get: (id: string) =>
          Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
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
        search: () => {
          throw new Error("unused")
        },
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

// ── helpers ───────────────────────────────────────────────────────────────────

const proposed = (statement: string) =>
  makeBeliefRecord({ statement, confidence: 0.7, domain: "comms", status: "proposed", now: 0 })

// ── THE PROOF ─────────────────────────────────────────────────────────────────

describe("ALIGNMENT LOOP — end-to-end proof: survey verdict closes the cycle", () => {
  /**
   * Assertion 1 — proposed belief is NOT in listActive() initially;
   *               composeBeliefsSection does not contain it.
   *
   * Assertion 2 — `confirmed` belief_validation verdict → belief becomes ACTIVE
   *               (listActive includes it; readBelief(status) === "active").
   *
   * Assertion 3 — EWMA: belief_validation alone does NOT move EWMA (captured
   *               before and after step 2 and asserted UNCHANGED); task_quality
   *               verdict DOES move it.
   *
   * Assertion 4 — composeBeliefsSection(listActive(), now) contains the
   *               activated belief's statement + "## What I believe about Operator"
   *               (data-level proof that survey-activated belief flows into the
   *               injected prompt — D-LOCK-9).
   *
   * Assertion 5 — survey rescheduled: after the task_quality verdict,
   *               nextSurvey(getLastSurveyAt()) > ISSUED_AT, AND
   *               pendingSurvey(ISSUED_AT + 1) returns null (not due).
   */
  it("proposed→confirmed→active; EWMA via task_quality only; injection; reschedule", async () => {
    const belief = proposed("Operator prefers terse answers")
    // Large enough to be a valid stable idempotency anchor; cold start means no
    // prior task_quality rows → survey is DUE for any `now` via cold-start guard.
    const ISSUED_AT = 5_000_000

    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          const writer = yield* BeliefWriter
          const store = yield* AlignmentStore

          // ── [A1] initial state: proposed belief NOT active ──────────────────
          const initialActive = yield* writer.listActive()
          const initialSection = composeBeliefsSection(initialActive, ISSUED_AT)

          // ── [A3 setup] capture EWMA before ANY verdict ──────────────────────
          const ewmaBefore = yield* store.getEwma // should be 0 (dormant floor)

          // ── [A2] submit `confirmed` belief_validation verdict ───────────────
          yield* survey.processVerdict({
            itemId: "bv-1",
            kind: "belief_validation",
            ref: belief.id,
            beliefId: belief.id,
            verdict: "confirmed",
            via: "survey",
            at: ISSUED_AT,
          })

          // ── [A3 mid] EWMA UNCHANGED after belief_validation ─────────────────
          const ewmaAfterBelief = yield* store.getEwma // must still be 0

          // ── read activation outcomes ────────────────────────────────────────
          const activeAfterConfirm = yield* writer.listActive()

          // ── [A3] submit task_quality verdict → EWMA MOVES ──────────────────
          yield* survey.processVerdict({
            itemId: "tq-1",
            kind: "task_quality",
            ref: "task_quality",
            score: 1,
            via: "survey",
            at: ISSUED_AT,
          })

          const ewmaAfterTask = yield* store.getEwma // must be > 0

          // ── [A4] injection ──────────────────────────────────────────────────
          const activeForInject = yield* writer.listActive()
          const section = composeBeliefsSection(activeForInject, ISSUED_AT)

          // ── [A5] reschedule ─────────────────────────────────────────────────
          const lastSurveyAt = yield* store.getLastSurveyAt
          const nextAt = yield* survey.nextSurvey(lastSurveyAt)
          const pendingAfter = yield* survey.pendingSurvey(ISSUED_AT + 1)

          return {
            initialActive,
            initialSection,
            ewmaBefore,
            ewmaAfterBelief,
            activeAfterConfirm,
            ewmaAfterTask,
            section,
            lastSurveyAt,
            nextAt,
            pendingAfter,
          }
        }),
        FakeMemory([belief]),
      ),
    )

    // ── [A1] proposed NOT in initial active list; section empty ──────────────
    expect(out.initialActive.map((r) => r.id)).not.toContain(belief.id)
    expect(out.initialSection).toBe("")

    // ── [A2] confirmed verdict → belief is ACTIVE ────────────────────────────
    expect(out.activeAfterConfirm.map((r) => r.id)).toContain(belief.id)
    expect(
      out.activeAfterConfirm
        .filter((r) => r.id === belief.id)
        .map((r) => readBelief(r).status),
    ).toContain("active")

    // ── [A3] EWMA boundary: belief_validation did NOT move; task_quality DID ─
    expect(out.ewmaBefore).toBe(0)
    expect(out.ewmaAfterBelief).toBe(0) // category boundary — UNCHANGED
    expect(out.ewmaAfterTask).toBeGreaterThan(0) // task_quality MOVED the EWMA

    // ── [A4] injection: activated belief in composeBeliefsSection ────────────
    expect(out.section).toContain("Operator prefers terse answers")
    expect(out.section).toContain("## What I believe about Operator")

    // ── [A5] reschedule: lastSurveyAt advanced; nextSurvey in the future ─────
    expect(out.lastSurveyAt).toBe(ISSUED_AT)
    expect(out.nextAt).toBeGreaterThan(ISSUED_AT)
    // pendingSurvey at just-after ISSUED_AT must return null (not due)
    expect(out.pendingAfter).toBeNull()
  })

  /**
   * Assertion 6 — Idempotent replay.
   * Submit the SAME task_quality verdict (same `at`) a SECOND time via
   * processVerdict. Assert:
   *   (a) EWMA is UNCHANGED from after the first submit.
   *   (b) alignment_log has only ONE row for it (the (ref, signalKind, at) guard).
   */
  it("[A6] idempotent replay: same verdict twice → EWMA unchanged; log has one row", async () => {
    const ISSUED_AT = 5_000_000
    const verdict = {
      itemId: "tq-idem",
      kind: "task_quality" as const,
      ref: "task_quality",
      score: 1,
      via: "survey" as const,
      at: ISSUED_AT,
    }

    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          const store = yield* AlignmentStore

          yield* survey.processVerdict(verdict)
          const ewmaOnce = yield* store.getEwma

          yield* survey.processVerdict(verdict) // exact replay
          const ewmaTwice = yield* store.getEwma

          const logRows = yield* store.list({ signalKind: "task_quality" })

          return { ewmaOnce, ewmaTwice, logRowCount: logRows.length }
        }),
        FakeMemory([]),
      ),
    )

    expect(out.ewmaTwice).toBe(out.ewmaOnce) // EWMA unchanged from first submit
    expect(out.logRowCount).toBe(1) // only ONE row for the (ref, signalKind, at) tuple
  })

  /**
   * Assertion 7 — rejected path and corrected path.
   *   (a) `rejected` verdict on a proposed belief → status becomes "retired"
   *       (not active, status === "retired").
   *   (b) `corrected` verdict on a proposed belief → stays "proposed" (records
   *       validation, no promotion).
   */
  it("[A7a] rejected verdict → belief becomes retired (not active)", async () => {
    const b = proposed("Operator wants long replies")

    const status = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          const mem = yield* MemoryRouterTag

          yield* survey.processVerdict({
            itemId: "bv-rej",
            kind: "belief_validation",
            ref: b.id,
            beliefId: b.id,
            verdict: "rejected",
            via: "survey",
            at: 5_000_000,
          })

          return readBelief((yield* mem.get(b.id))!).status
        }),
        FakeMemory([b]),
      ),
    )

    expect(status).toBe("retired")
  })

  it("[A7b] corrected verdict → belief stays proposed (records validation, no promotion)", async () => {
    const b = proposed("Operator likes emoji")

    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          const mem = yield* MemoryRouterTag

          yield* survey.processVerdict({
            itemId: "bv-corr",
            kind: "belief_validation",
            ref: b.id,
            beliefId: b.id,
            verdict: "corrected",
            via: "survey",
            at: 5_000_000,
          })

          const rec = (yield* mem.get(b.id))!
          return {
            status: readBelief(rec).status,
            historyLen: readBelief(rec).validationHistory.length,
          }
        }),
        FakeMemory([b]),
      ),
    )

    expect(out.status).toBe("proposed") // NOT promoted
    expect(out.historyLen).toBe(1) // validation was recorded
  })
})
