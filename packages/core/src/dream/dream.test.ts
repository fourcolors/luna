import { describe, expect, it } from "vitest"
import { Effect, Layer, Ref, Stream } from "effect"
import { Clock } from "../clock.js"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { DreamStore } from "./dream-store.js"
import { applyOps, revert, deriveDreamId, runDream } from "./dream.js"
import type { DreamOp } from "./types.js"
import { SessionStore } from "../session/session-store.js"
import { FakeReasoner } from "./reasoner.js"
import { makeBeliefRecord } from "../beliefs/types.js"
import { SuggestedActions } from "../suggested-actions/suggested-actions.js"
import { SuggestedActionsStore } from "../suggested-actions/suggested-actions-store.js"

// Minimal Ref-backed memory router double (only the methods applyOps uses).
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
        // unused by applyOps — provide inert stubs
        query: () => Stream.empty,
        search: () => { throw new Error("unused") },
      } as never
    }),
  )

const rec = (id: string): MemoryRecord => ({
  id, namespace: "operator", kind: "note", content: { id },
  schemaVersion: 1, createdAt: 0, updatedAt: 0, tags: [],
})

const provide = <A, E>(eff: Effect.Effect<A, E, any>, mem = FakeMemory([rec("dup-1")])) =>
  eff.pipe(Effect.provide(DreamStore.Memory), Effect.provide(mem), Effect.provide(Clock.Default))

describe("applyOps", () => {
  it("auto-applies memory_dedup (deletes the duplicate) and logs it 'applied'", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const mem = yield* MemoryRouterTag
          const store = yield* DreamStore
          const ops: DreamOp[] = [
            { kind: "memory_dedup", targetId: "dup-1", before: rec("dup-1"), after: null, rationale: "exact dup of canon-1" },
          ]
          yield* applyOps("dream-0-100", ops)
          const stillThere = yield* mem.get("dup-1")
          const rows = yield* store.list({ dreamId: "dream-0-100" })
          return { stillThere, rows }
        }),
      ),
    )
    expect(out.stillThere).toBeNull() // deleted
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]?.status).toBe("applied")
    expect(out.rows[0]?.appliedAt).not.toBeNull()
  })

  it("does NOT apply non-dedup ops; logs them 'proposed' and leaves memory untouched", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const mem = yield* MemoryRouterTag
          const store = yield* DreamStore
          const ops: DreamOp[] = [
            { kind: "memory_staleness", targetId: "dup-1", before: rec("dup-1"), after: { ...rec("dup-1"), content: { updated: true } }, rationale: "stale" },
            { kind: "memory_contradiction", targetId: "other-1", before: null, after: { resolved: true }, rationale: "conflict" },
          ]
          yield* applyOps("dream-0-100", ops)
          const untouched = yield* mem.get("dup-1")
          const rows = yield* store.list({ dreamId: "dream-0-100" })
          return { untouched, rows }
        }),
      ),
    )
    expect(out.untouched).not.toBeNull() // staleness was NOT applied
    expect(out.rows).toHaveLength(2)
    expect(out.rows.every((r) => r.status === "proposed")).toBe(true)
    expect(out.rows.every((r) => r.appliedAt === null)).toBe(true)
  })

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
        FakeMemory([]),
      ),
    )
    expect(out.stored).not.toBeNull() // belief record written
    expect((out.stored!.content as { status: string }).status).toBe("proposed")
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]?.status).toBe("applied") // op applied (undoable)
  })

  it("holds skill_improvement as proposed and does NOT write memory", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const mem = yield* MemoryRouterTag
          const store = yield* DreamStore
          const ops: DreamOp[] = [
            {
              kind: "skill_improvement",
              targetId: "skill-imp-x",
              before: null,
              after: {
                mode: "create",
                skillId: null,
                title: "Deploy skill",
                detail: null,
                prompt: "Author a deploy skill",
              },
              rationale: "repeated deploy friction",
            },
          ]
          const result = yield* applyOps("dream-0-100", ops)
          const rogue = yield* mem.get("skill-imp-x")
          const rows = yield* store.list({ dreamId: "dream-0-100" })
          return { rogue, rows, result }
        }),
        FakeMemory([]),
      ),
    )
    expect(out.rogue).toBeNull()
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]?.status).toBe("proposed")
    expect(out.rows[0]?.op).toBe("skill_improvement")
    expect(out.result.skillChipsEmitted).toBe(0) // no SuggestedActions + no thread
  })

  it("emits a dream-sourced create_skill chip when SuggestedActions + thread are provided", async () => {
    const saLayer = Layer.provideMerge(SuggestedActions.layer, SuggestedActionsStore.Memory)
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DreamStore
        const sa = yield* SuggestedActions
        const ops: DreamOp[] = [
          {
            kind: "skill_improvement",
            targetId: "skill-imp-y",
            before: null,
            after: {
              mode: "create",
              skillId: null,
              title: "Incident skill",
              detail: "Capture incident playbook",
              prompt: "Author SKILL.md for incidents",
            },
            rationale: "two incidents without a playbook",
          },
        ]
        const result = yield* applyOps("dream-0-100", ops, {
          actionsThreadId: "thread-home",
          skillChipBudget: 3,
        })
        const rows = yield* store.list({ dreamId: "dream-0-100" })
        const chips = yield* sa.listByThread("thread-home")
        return { result, rows, chips }
      }).pipe(
        Effect.provide(DreamStore.Memory),
        Effect.provide(FakeMemory([])),
        Effect.provide(saLayer),
        Effect.provide(Clock.Default),
      ) as Effect.Effect<any, any, never>,
    )
    expect(out.result.skillChipsEmitted).toBe(1)
    expect(out.rows[0]?.status).toBe("proposed")
    expect(out.chips).toHaveLength(1)
    expect(out.chips[0]?.source).toBe("dream")
    expect(out.chips[0]?.actionType).toBe("create_skill")
    expect(out.chips[0]?.title).toBe("Incident skill")
  })

  it("caps skill chips at the remaining budget (audit still records all)", async () => {
    const saLayer = Layer.provideMerge(SuggestedActions.layer, SuggestedActionsStore.Memory)
    const makeOp = (n: number): DreamOp => ({
      kind: "skill_improvement",
      targetId: `skill-imp-${n}`,
      before: null,
      after: {
        mode: "create",
        skillId: null,
        title: `Skill ${n}`,
        detail: null,
        prompt: `Author skill ${n}`,
      },
      rationale: `why ${n}`,
    })
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DreamStore
        const sa = yield* SuggestedActions
        const result = yield* applyOps(
          "dream-0-100",
          [makeOp(1), makeOp(2), makeOp(3), makeOp(4)],
          { actionsThreadId: "t", skillChipBudget: 2 },
        )
        const rows = yield* store.list({ dreamId: "dream-0-100" })
        const chips = yield* sa.listByThread("t")
        return { result, rows, chips }
      }).pipe(
        Effect.provide(DreamStore.Memory),
        Effect.provide(FakeMemory([])),
        Effect.provide(saLayer),
        Effect.provide(Clock.Default),
      ) as Effect.Effect<any, any, never>,
    )
    expect(out.result.skillChipsEmitted).toBe(2)
    expect(out.rows).toHaveLength(4) // all audited
    expect(out.chips).toHaveLength(2)
  })

})

describe("revert", () => {
  it("restores the before snapshot and marks the row reverted", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const mem = yield* MemoryRouterTag
          const store = yield* DreamStore
          // Apply a dedup that deletes dup-1 (before = the record).
          yield* applyOps("dream-0-100", [
            { kind: "memory_dedup", targetId: "dup-1", before: rec("dup-1"), after: null, rationale: "dup" },
          ])
          const rows = yield* store.list({ dreamId: "dream-0-100" })
          const ok = yield* revert(rows[0]!.id)
          const restored = yield* mem.get("dup-1")
          const row = yield* store.get(rows[0]!.id)
          return { ok, restored, row }
        }),
      ),
    )
    expect(out.ok).toBe(true)
    expect(out.restored).not.toBeNull() // before snapshot put back
    expect(out.row?.status).toBe("reverted")
  })

  it("revert undoes a materialized belief_candidate (deletes the proposed record)", async () => {
    const candidate = makeBeliefRecord({ statement: "x", confidence: 0.6, domain: "comms", now: 0 })
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const mem = yield* MemoryRouterTag
          const store = yield* DreamStore
          yield* applyOps("dream-0-100", [
            { kind: "belief_candidate", targetId: candidate.id, before: null, after: candidate, rationale: "pattern" },
          ])
          const rowId = (yield* store.list({ dreamId: "dream-0-100" }))[0]!.id
          const reverted = yield* revert(rowId)
          const afterRevert = yield* mem.get(candidate.id)
          const row = yield* store.get(rowId)
          return { reverted, afterRevert, status: row?.status }
        }),
        FakeMemory([]),
      ),
    )
    expect(out.reverted).toBe(true)
    expect(out.afterRevert).toBeNull()        // proposed belief deleted
    expect(out.status).toBe("reverted")        // audit row flipped
  })

  it("refuses to revert a proposed (never-applied) row", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const store = yield* DreamStore
          yield* applyOps("dream-0-100", [
            { kind: "memory_staleness", targetId: "dup-1", before: rec("dup-1"), after: rec("dup-1"), rationale: "stale" },
          ])
          const rows = yield* store.list({ dreamId: "dream-0-100" })
          return yield* revert(rows[0]!.id)
        }),
      ),
    )
    expect(out).toBe(false)
  })
})

describe("deriveDreamId", () => {
  it("is a pure function of the window bounds", () => {
    expect(deriveDreamId(0, 100)).toBe("dream-0-100")
    expect(deriveDreamId(0, 100)).toBe(deriveDreamId(0, 100))
  })
})

// ── Idempotency invariant ─────────────────────────────────────────────────────
// dreamId is keyed on (watermark, cutoff) where cutoff = max(lastMessageAt) of
// sessions actually gathered — NOT on `now`. This means a crash retry on a
// later tick (different `now`) still produces the same dreamId and INSERT OR
// IGNORE collapses duplicate audit rows.
//
// When no sessions are in the window (empty SessionStore), cutoff === watermark
// === 0, so both runs produce dreamId "dream-0-0" regardless of `now`.
// ─────────────────────────────────────────────────────────────────────────────

describe("runDream (end-to-end, idempotent)", () => {
  it("crash retry with a DIFFERENT now is still a no-op (idempotent)", async () => {
    const ops = [
      { kind: "memory_dedup" as const, targetId: "dup-1", before: rec("dup-1"), after: null, rationale: "dup" },
    ]
    const layers = Layer.mergeAll(
      DreamStore.Memory,
      SessionStore.Default,
      FakeMemory([rec("dup-1")]),
      FakeReasoner.of(ops),
      Clock.Default,
    )
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DreamStore
        yield* runDream(1000)           // window (0, 0] over empty sessions → cutoff=0 → dreamId "dream-0-0"
        const after1 = yield* store.list({})
        // Simulate a crash BEFORE the watermark was durably advanced, then a
        // retry on a LATER tick with a different `now`.
        yield* store.setWatermark(0)
        yield* runDream(2000)           // different now, same empty window → same cutoff=0 → same dreamId "dream-0-0"
        const after2 = yield* store.list({})
        return { after1, after2 }
      }).pipe(Effect.provide(layers)) as Effect.Effect<any, any, never>,
    )
    expect(out.after1).toHaveLength(1)
    expect(out.after2).toHaveLength(1) // collapses despite different `now` — proves dreamId is NOT keyed on now
  })
})
