/**
 * chunking.test.ts — Loop C (Dream v2 Phase 1, the death-spiral fix): CHUNKED
 * dreaming with a PER-CHUNK watermark advance and a deadline-aware stop.
 *
 * Background: today's `runDream` (dream.ts) gathers the WHOLE window, makes
 * ONE reasoner call, and advances the watermark LAST — after that single
 * call. If one night's window is oversized (blows the prompt budget) or the
 * single reasoner call fails, the watermark NEVER moves and every subsequent
 * run re-gathers the same frozen window forever (the "death spiral").
 *
 * This file is the RED half of Loop C. It pins a NEW contract on dream.ts
 * that does not exist yet:
 *
 *   export const DREAM_SESSION_TOKEN_BUDGET: number
 *   export const DREAM_DEADLINE_SAFETY_MS = 60_000
 *   export interface RunDreamOptions { sessionTokenBudget?, deadlineAt?, deadlineSafetyMs? }
 *   export interface RunDreamSummary { chunksProcessed, sessionsProcessed, stoppedEarly, watermark }
 *   runDream(now, opts?): Effect<RunDreamSummary, ...>
 *
 * Because vitest does not typecheck, the missing exports resolve to
 * `undefined` at import time rather than a hard SyntaxError (Vite's dev
 * module graph does not statically enforce named-export existence) — so
 * every assertion below fails as a plain runtime assertion (`undefined !==
 * number`, call-count mismatches, etc.), which is valid RED. Nothing here
 * edits dream.ts — that is the implementer's job.
 *
 * Chunking semantics under test (packing + per-chunk commit):
 *   - Sessions sort ascending by lastMessageAt and pack GREEDILY: a session
 *     joins the current chunk while the chunk's summed estimateTokens(excerpt)
 *     stays <= sessionTokenBudget; otherwise a new chunk starts. A session
 *     whose excerpt alone exceeds the budget still gets its own singleton
 *     chunk (never dropped).
 *   - Per chunk: chunkStart = watermark BEFORE this chunk; cutoff = max
 *     lastMessageAt in the chunk; dreamId = `dream-${chunkStart}-${cutoff}`;
 *     reason() -> applyOps() -> setWatermark(cutoff), in that order, BEFORE
 *     the next chunk begins. `memories` is identical across every chunk call.
 *   - Zero window sessions: ONE reasoner pass, sessions: [], dreamId
 *     `dream-W-W`, watermark unmoved (today's exact behavior).
 *   - Deadline: before each chunk, if deadlineAt != null and clock.nowMs() >=
 *     deadlineAt - deadlineSafetyMs, STOP cleanly (resolve, not fail) with
 *     stoppedEarly: true and the progress made so far.
 *   - Failure isolation: if the reasoner fails on chunk k>1, runDream FAILS,
 *     but the watermark stays at chunk (k-1)'s cutoff and chunks 1..k-1's ops
 *     are already applied — a re-run only gathers the unprocessed remainder
 *     (the self-heal property that is the whole point of this fix).
 *
 * AUDITOR ROUND (Correct-axis FAIL, two additional contract pins — see the
 * "auditor defect" describe blocks at the bottom):
 *   - TIE-GROUP COHESION: packing must NEVER split a group of equal-
 *     lastMessageAt sessions across chunks — a tie group moves as a unit
 *     (cohesion beats the budget, like the oversized-singleton rule).
 *     Otherwise a committed chunk cutoff strands the same-ts sibling FOREVER:
 *     gatherInputs' window is STRICT (`lastMessageAt > watermark`), so a
 *     session with lastMessageAt == watermark is never re-gathered (D1).
 *   - PER-SESSION OVERHEAD FLOOR: each session charges
 *     max(estimateTokens(excerpt), SESSION_OVERHEAD_TOKENS) where
 *     SESSION_OVERHEAD_TOKENS = 32 is a new dream.ts export. Otherwise
 *     empty-excerpt sessions cost 0 and clump UNBOUNDED into one chunk whose
 *     per-session prompt headers alone can blow the 120k pre-flight — a
 *     residual death spiral (D2).
 *
 * DETERMINISTIC DEADLINE TESTING (a documented ambiguity resolution): this
 * codebase's only test Clock double (`Clock.Test(fixedMs)`, clock.ts) is a
 * single static reading for the whole run — it never advances. A real dream
 * cycle's deadline gate must re-read a LIVE clock before each chunk (each
 * chunk is a real, time-consuming reasoner/LLM call in production), so a
 * "chunk 1 passes the gate, chunk 2 does not" scenario needs the clock to
 * genuinely advance BETWEEN chunks. Rather than coupling the test to how many
 * times the implementation happens to call `clock.nowMs()` internally (an
 * implementation detail this navigator does not control), S7a builds its own
 * Ref-backed ticking Clock double and advances it as a side effect of the
 * RECORDING reasoner's `reason()` call — i.e. "this simulated reasoner call
 * took `stepMs` of wall time." This is deterministic, does not depend on any
 * internal call count, and mirrors production (a chunk's cost IS the reasoner
 * call). See S7a below for the exact arithmetic.
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer, Ref, Stream } from "effect"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { Clock } from "../clock.js"
import { SessionStore } from "../session/session-store.js"
import { DreamStore } from "./dream-store.js"
import { DreamReasoner } from "./reasoner.js"
import { DEFAULT_DISTILL_OPTIONS, DREAM_PROMPT_TOKEN_BUDGET } from "./distill.js"
import type { DreamInputs, DreamOp } from "./types.js"
import { DreamError } from "./types.js"
import {
  runDream,
  DREAM_SESSION_TOKEN_BUDGET,
  DREAM_DEADLINE_SAFETY_MS,
  SESSION_OVERHEAD_TOKENS,
} from "./dream.js"

// ── fixtures ─────────────────────────────────────────────────────────────────

// Ref-backed MemoryRouter double whose `query` actually replays seeded records
// (mirrors gather.test.ts — the recording-reasoner tests assert `memories` is
// identical across every chunk call, which is only meaningful if query isn't
// stubbed to Stream.empty).
const FakeMemory = (initial: ReadonlyArray<MemoryRecord> = []) =>
  Layer.effect(
    MemoryRouterTag,
    Effect.gen(function* () {
      const store = yield* Ref.make<ReadonlyArray<MemoryRecord>>(initial)
      return {
        put: (r: MemoryRecord) => Ref.update(store, (recs) => [...recs, r]),
        get: () => Effect.succeed(null),
        delete: () => Effect.succeed(false),
        query: () => Stream.unwrap(Ref.get(store).pipe(Effect.map(Stream.fromIterable))),
        search: () => {
          throw new Error("unused")
        },
      } as never
    }),
  )

const memRecord = (id: string): MemoryRecord => ({
  id, namespace: "operator", kind: "note", content: { id },
  schemaVersion: 1, createdAt: 0, updatedAt: 0, tags: [],
})

const textPayload = (role: "user" | "assistant", content: string) => ({
  message: { role, content },
})

/** [kind] + body header length ("[user] ") is 7 chars. 393 + 7 = 400 chars → estimateTokens = 100. */
const EXCERPT_CHARS = 393

const seedSession = (
  sessions: Effect.Effect.Success<typeof SessionStore>,
  id: string,
  ts: number,
  chars: number = EXCERPT_CHARS,
) =>
  Effect.gen(function* () {
    yield* sessions.create({ id, options: { model: "test" }, createdAt: 0 })
    yield* sessions.appendMessage({
      sessionId: id, messageId: `${id}-m1`, ts, parentId: null,
      kind: "user", payload: textPayload("user", "x".repeat(chars)),
    })
  })

const OLD_TS = 100
const NEW_TS = 200
const NOW = 1000

/** Two ~100-token sessions, ascending by lastMessageAt. */
const seedTwoSessions = (sessions: Effect.Effect.Success<typeof SessionStore>) =>
  Effect.gen(function* () {
    yield* seedSession(sessions, "s-old", OLD_TS)
    yield* seedSession(sessions, "s-new", NEW_TS)
  })

const dedupOp = (targetId: string): DreamOp => ({
  kind: "memory_dedup",
  targetId,
  before: memRecord(targetId),
  after: null,
  rationale: "test dedup",
})

// ── recording reasoner double ────────────────────────────────────────────────

interface RecordedCall {
  readonly sessionIds: ReadonlyArray<string>
  readonly memories: ReadonlyArray<MemoryRecord>
}
type RecordingResponse = { readonly ops: ReadonlyArray<DreamOp> } | { readonly fail: DreamError }

/**
 * A DreamReasoner double that records each call's session ids + memories (for
 * S5/S6 assertions), replays a scripted response per call index, and
 * optionally ticks a shared clock Ref by `stepMs` after each call — the
 * deterministic "this reasoner call took stepMs of wall time" hook S7a needs.
 */
const makeRecordingReasoner = (
  responses: ReadonlyArray<RecordingResponse>,
  tick?: { readonly ref: Ref.Ref<number>; readonly stepMs: number },
) => {
  const callsRef = Effect.runSync(Ref.make<ReadonlyArray<RecordedCall>>([]))
  const layer: Layer.Layer<DreamReasoner> = Layer.succeed(DreamReasoner, {
    reason: (inputs: DreamInputs) =>
      Effect.gen(function* () {
        const prior = yield* Ref.get(callsRef)
        const idx = prior.length
        yield* Ref.update(callsRef, (cs) => [
          ...cs,
          { sessionIds: inputs.sessions.map((s) => s.summary.id), memories: inputs.memories },
        ])
        if (tick) yield* Ref.update(tick.ref, (t) => t + tick.stepMs)
        const resp = responses[idx]
        if (resp && "fail" in resp) return yield* Effect.fail(resp.fail)
        return resp?.ops ?? []
      }),
  })
  return { layer, callsRef }
}

const getCalls = (callsRef: Ref.Ref<ReadonlyArray<RecordedCall>>) =>
  Effect.runSync(Ref.get(callsRef))

// ── constants ────────────────────────────────────────────────────────────────

describe("chunking constants", () => {
  it("DREAM_SESSION_TOKEN_BUDGET is derived from the prompt budget minus the memories reservation minus headroom", () => {
    expect(DREAM_SESSION_TOKEN_BUDGET).toBe(
      DREAM_PROMPT_TOKEN_BUDGET - Math.ceil(DEFAULT_DISTILL_OPTIONS.memoriesChars / 4) - 2_000,
    )
    expect(DREAM_SESSION_TOKEN_BUDGET).toBe(108_000)
  })

  it("DREAM_DEADLINE_SAFETY_MS is 60 seconds", () => {
    expect(DREAM_DEADLINE_SAFETY_MS).toBe(60_000)
  })
})

// ── S5 — packing ─────────────────────────────────────────────────────────────

describe("runDream chunking — packing (S5)", () => {
  it("S5a: two sessions fitting one budget → ONE reasoner call with both, watermark = later lastMessageAt", async () => {
    const layers = Layer.mergeAll(
      DreamStore.Memory,
      SessionStore.Default,
      FakeMemory([memRecord("mem-1")]),
      Clock.Default,
    )
    const { layer: reasonerL, callsRef } = makeRecordingReasoner([{ ops: [] }])

    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        yield* seedTwoSessions(sessions)
        return yield* runDream(NOW, { sessionTokenBudget: 300 })
      }).pipe(Effect.provide(reasonerL), Effect.provide(layers)) as Effect.Effect<any, any, never>,
    )

    const calls = getCalls(callsRef)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sessionIds).toEqual(["s-old", "s-new"])
    expect(out.chunksProcessed).toBe(1)
    expect(out.sessionsProcessed).toBe(2)
    expect(out.stoppedEarly).toBe(false)
    expect(out.watermark).toBe(NEW_TS)
  })

  it("S5b: a small budget forces TWO reasoner calls in ascending order, TWO distinct dreamIds, watermark = newest cutoff", async () => {
    const layers = Layer.mergeAll(
      DreamStore.Memory,
      SessionStore.Default,
      FakeMemory([memRecord("mem-1")]),
      Clock.Default,
    )
    // Re-spec adjudication (Loop C escalation): the ledger records one row PER
    // OP, so an empty chunk-2 op list can never surface chunk 2's dreamId.
    // Both chunks see the same memories, so a real reasoner would re-propose
    // the dedup in both windows — chunk 2 returns an op too.
    const { layer: reasonerL, callsRef } = makeRecordingReasoner([
      { ops: [dedupOp("mem-1")] },
      { ops: [dedupOp("mem-1")] },
    ])

    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DreamStore
        const sessions = yield* SessionStore
        yield* seedTwoSessions(sessions)
        const summary = yield* runDream(NOW, { sessionTokenBudget: 150 })
        const rows = yield* store.list({})
        return { summary, rows }
      }).pipe(Effect.provide(reasonerL), Effect.provide(layers)) as Effect.Effect<any, any, never>,
    )

    const calls = getCalls(callsRef)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.sessionIds).toEqual(["s-old"])
    expect(calls[1]?.sessionIds).toEqual(["s-new"])
    // memories identical across every chunk call
    expect(calls[0]?.memories).toEqual(calls[1]?.memories)

    expect(out.summary.chunksProcessed).toBe(2)
    expect(out.summary.sessionsProcessed).toBe(2)
    expect(out.summary.stoppedEarly).toBe(false)
    expect(out.summary.watermark).toBe(NEW_TS)

    const dreamIds = new Set(out.rows.map((r: { dreamId: string }) => r.dreamId))
    expect(dreamIds.has(`dream-0-${OLD_TS}`)).toBe(true)
    expect(dreamIds.has(`dream-${OLD_TS}-${NEW_TS}`)).toBe(true)
  })

  it("S5c: a single session whose excerpt alone exceeds the budget still gets its own singleton chunk (never dropped)", async () => {
    const layers = Layer.mergeAll(
      DreamStore.Memory,
      SessionStore.Default,
      FakeMemory([]),
      Clock.Default,
    )
    const { layer: reasonerL, callsRef } = makeRecordingReasoner([{ ops: [] }])

    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        yield* seedSession(sessions, "s-big", 500) // ~100 tokens, budget below is 10
        return yield* runDream(NOW, { sessionTokenBudget: 10 })
      }).pipe(Effect.provide(reasonerL), Effect.provide(layers)) as Effect.Effect<any, any, never>,
    )

    const calls = getCalls(callsRef)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sessionIds).toEqual(["s-big"])
    expect(out.chunksProcessed).toBe(1)
    expect(out.sessionsProcessed).toBe(1)
    expect(out.stoppedEarly).toBe(false)
    expect(out.watermark).toBe(500)
  })
})

// ── S6 — failure isolation / self-heal ───────────────────────────────────────

describe("runDream chunking — failure isolation and self-heal (S6)", () => {
  it("S6a+S6b: a chunk-2 reasoner failure freezes the watermark at chunk-1's cutoff; a follow-up run reprocesses only the remainder", async () => {
    const layers = Layer.mergeAll(
      DreamStore.Memory,
      SessionStore.Default,
      FakeMemory([memRecord("mem-1")]),
      Clock.Default,
    )
    const { layer: failingReasonerL, callsRef: failingCalls } = makeRecordingReasoner([
      { ops: [dedupOp("mem-1")] },
      { fail: new DreamError({ op: "reason", message: "boom" }) },
    ])
    const { layer: healReasonerL, callsRef: healCalls } = makeRecordingReasoner([{ ops: [] }])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        const store = yield* DreamStore
        yield* seedTwoSessions(sessions)

        // First run: chunk 1 succeeds, chunk 2 fails.
        const exit1 = yield* Effect.exit(
          runDream(NOW, { sessionTokenBudget: 150 }).pipe(Effect.provide(failingReasonerL)),
        )
        const watermarkAfterFailure = yield* store.getWatermark
        const rowsAfterFailure = yield* store.list({})

        // Second run: an always-succeeding reasoner should only see the
        // unprocessed remainder (self-heal — the point of this whole fix).
        const summary2 = yield* runDream(NOW + 1, { sessionTokenBudget: 150 }).pipe(
          Effect.provide(healReasonerL),
        )
        const finalWatermark = yield* store.getWatermark

        return { exit1, watermarkAfterFailure, rowsAfterFailure, summary2, finalWatermark }
      }).pipe(Effect.provide(layers)) as Effect.Effect<any, any, never>,
    )

    // S6a
    expect(Exit.isFailure(result.exit1)).toBe(true)
    expect(result.watermarkAfterFailure).toBe(OLD_TS)
    expect(
      result.rowsAfterFailure.some((r: { dreamId: string }) => r.dreamId === `dream-0-${OLD_TS}`),
    ).toBe(true)
    expect(getCalls(failingCalls)).toHaveLength(2) // chunk 1 attempted+succeeded, chunk 2 attempted+failed

    // S6b — self-heal
    const healed = getCalls(healCalls)
    expect(healed).toHaveLength(1)
    expect(healed[0]?.sessionIds).toEqual(["s-new"]) // s-old is now behind the watermark
    expect(result.summary2.chunksProcessed).toBe(1)
    expect(result.summary2.sessionsProcessed).toBe(1)
    expect(result.finalWatermark).toBe(NEW_TS)
  })
})

// ── S7 — deadline-aware stop ─────────────────────────────────────────────────

describe("runDream chunking — deadline-aware stop (S7)", () => {
  it("S7a: a deadline that goes effectively-exhausted between chunk 1 and chunk 2 stops cleanly after chunk 1", async () => {
    const T0 = 5_000_000
    const clockRef = Effect.runSync(Ref.make(T0))
    const clockLayer: Layer.Layer<Clock> = Layer.succeed(
      Clock,
      Clock.of({
        _tag: "luna/Clock",
        nowMs: () => Ref.get(clockRef),
        nowIso: () => Ref.get(clockRef).pipe(Effect.map((t) => new Date(t).toISOString())),
      }),
    )
    // The recording reasoner ticks the shared clock by STEP_MS as a side
    // effect of chunk 1's call — simulating "chunk 1's reasoning took 65s of
    // wall time." deadlineAt is picked so the gate READS AS NOT-YET-DUE at
    // T0 (chunk 1's check passes) but IS due at T0 + STEP_MS (chunk 2's
    // check trips). See the file header comment for why this, and not a
    // static Clock.Test, is required for a 2-chunk deadline scenario.
    const STEP_MS = 65_000
    const deadlineAt = T0 + DREAM_DEADLINE_SAFETY_MS + 1

    const layers = Layer.mergeAll(
      DreamStore.Memory,
      SessionStore.Default,
      FakeMemory([memRecord("mem-1")]),
      clockLayer,
    )
    const { layer: reasonerL, callsRef } = makeRecordingReasoner(
      [{ ops: [] }, { ops: [] }],
      { ref: clockRef, stepMs: STEP_MS },
    )

    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        yield* seedTwoSessions(sessions)
        return yield* runDream(NOW, { sessionTokenBudget: 150, deadlineAt })
      }).pipe(Effect.provide(reasonerL), Effect.provide(layers)) as Effect.Effect<any, any, never>,
    )

    const calls = getCalls(callsRef)
    expect(calls).toHaveLength(1) // chunk 2 (s-new) was NOT processed
    expect(calls[0]?.sessionIds).toEqual(["s-old"])
    expect(out.chunksProcessed).toBe(1)
    expect(out.sessionsProcessed).toBe(1)
    expect(out.stoppedEarly).toBe(true)
    expect(out.watermark).toBe(OLD_TS)
  })

  it("S7b: deadlineAt null (default) never stops early, regardless of the clock", async () => {
    const layers = Layer.mergeAll(
      DreamStore.Memory,
      SessionStore.Default,
      FakeMemory([memRecord("mem-1")]),
      Clock.Test(999_999_999), // arbitrarily "late" — irrelevant, deadlineAt is null
    )
    const { layer: reasonerL, callsRef } = makeRecordingReasoner([{ ops: [] }, { ops: [] }])

    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        yield* seedTwoSessions(sessions)
        return yield* runDream(NOW, { sessionTokenBudget: 150, deadlineAt: null })
      }).pipe(Effect.provide(reasonerL), Effect.provide(layers)) as Effect.Effect<any, any, never>,
    )

    expect(getCalls(callsRef)).toHaveLength(2)
    expect(out.chunksProcessed).toBe(2)
    expect(out.sessionsProcessed).toBe(2)
    expect(out.stoppedEarly).toBe(false)
    expect(out.watermark).toBe(NEW_TS)
  })

  it("S7c: zero window sessions — summary is exactly {chunksProcessed:1, sessionsProcessed:0, stoppedEarly:false, watermark:W} (dream-W-W dreamId already covered by dream.test.ts)", async () => {
    const layers = Layer.mergeAll(
      DreamStore.Memory,
      SessionStore.Default,
      FakeMemory([]),
      Clock.Default,
    )
    const { layer: reasonerL, callsRef } = makeRecordingReasoner([{ ops: [] }])

    const out = await Effect.runPromise(
      runDream(NOW, {}).pipe(Effect.provide(reasonerL), Effect.provide(layers)) as Effect.Effect<
        any,
        any,
        never
      >,
    )

    const calls = getCalls(callsRef)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sessionIds).toEqual([])
    expect(out).toEqual({
      chunksProcessed: 1,
      sessionsProcessed: 0,
      stoppedEarly: false,
      watermark: 0,
    })
  })
})

// ── Auditor defect 1 — tie-group cohesion (equal-lastMessageAt orphaning) ────
//
// gatherInputs' window is STRICT (`lastMessageAt > watermark`), and the loop
// commits watermark = chunk cutoff PER CHUNK. If a naive greedy pack splits two
// sessions sharing the SAME lastMessageAt across a chunk boundary and the run
// stops between them (deadline trip or chunk-2 failure), the committed cutoff
// EQUALS the orphan's lastMessageAt — so no future run ever gathers it again.
// Contract fix under test: a tie group of equal-lastMessageAt sessions always
// packs as ONE chunk, even when its summed tokens exceed the budget (cohesion
// beats the budget, exactly like the oversized-singleton rule) — so a committed
// cutoff can never strand a same-timestamp sibling.

describe("runDream chunking — tie-group cohesion (auditor defect 1)", () => {
  it("D1: equal-lastMessageAt sessions pack as ONE chunk (never split), so a mid-run stop can never orphan a same-ts sibling below the committed watermark", async () => {
    const TIE_TS = 100
    // Ticking clock (same pattern as S7a): run 1's reasoner call "takes 65s",
    // so if the implementation splits the tie into two chunks, the deadline
    // gate trips between them — reproducing the auditor's stop-mid-tie repro.
    const T0 = 5_000_000
    const clockRef = Effect.runSync(Ref.make(T0))
    const clockLayer: Layer.Layer<Clock> = Layer.succeed(
      Clock,
      Clock.of({
        _tag: "luna/Clock",
        nowMs: () => Ref.get(clockRef),
        nowIso: () => Ref.get(clockRef).pipe(Effect.map((t) => new Date(t).toISOString())),
      }),
    )
    const STEP_MS = 65_000
    const deadlineAt = T0 + DREAM_DEADLINE_SAFETY_MS + 1

    const layers = Layer.mergeAll(
      DreamStore.Memory,
      SessionStore.Default,
      FakeMemory([memRecord("mem-1")]),
      clockLayer,
    )
    // Each session's excerpt is ~100 tokens; budget 150 < 200 summed — a naive
    // greedy pack splits the tie, the fixed pack keeps it whole.
    const { layer: run1ReasonerL, callsRef: run1Calls } = makeRecordingReasoner(
      [{ ops: [] }, { ops: [] }],
      { ref: clockRef, stepMs: STEP_MS },
    )
    const { layer: run2ReasonerL, callsRef: run2Calls } = makeRecordingReasoner([
      { ops: [] },
      { ops: [] },
    ])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        const store = yield* DreamStore
        yield* seedSession(sessions, "s-tie-a", TIE_TS)
        yield* seedSession(sessions, "s-tie-b", TIE_TS)

        // Run 1: may stop early (that's the point) — a stop between tie
        // siblings is exactly the orphaning hazard.
        yield* runDream(NOW, { sessionTokenBudget: 150, deadlineAt }).pipe(
          Effect.provide(run1ReasonerL),
        )
        // Run 2: healthy, no deadline — the recovery pass an orphan would
        // need to be picked up by.
        yield* runDream(NOW + 1, { sessionTokenBudget: 150 }).pipe(
          Effect.provide(run2ReasonerL),
        )
        const finalWatermark = (yield* store.getWatermark) ?? 0
        return { finalWatermark }
      }).pipe(Effect.provide(layers)) as Effect.Effect<any, any, never>,
    )

    // Packing-level contract: the tie group moves as a UNIT — run 1's first
    // reasoner call receives BOTH same-ts sessions (order within the tie is
    // unspecified, hence the sort), in exactly one chunk.
    const calls1 = getCalls(run1Calls)
    expect([...(calls1[0]?.sessionIds ?? [])].sort()).toEqual(["s-tie-a", "s-tie-b"])
    expect(calls1).toHaveLength(1)

    // Run-level invariant: across both runs, every seeded session was either
    // reasoned over or is still re-gatherable (lastMessageAt STRICTLY beyond
    // the final committed watermark). A session that is BOTH unreasoned AND
    // at-or-below the watermark is stranded forever — the death spiral's
    // residue this loop exists to kill.
    const reasonedIds = new Set(
      [...calls1, ...getCalls(run2Calls)].flatMap((c) => c.sessionIds),
    )
    expect(reasonedIds.has("s-tie-b")).toBe(true) // eventually reasoned over
    const stranded = [
      { id: "s-tie-a", ts: TIE_TS },
      { id: "s-tie-b", ts: TIE_TS },
    ].filter((s) => !reasonedIds.has(s.id) && s.ts <= result.finalWatermark)
    expect(stranded).toEqual([])
  })
})

// ── Auditor defect 2 — per-session overhead floor (empty-excerpt clumping) ───
//
// estimateTokens("") is 0, so sessions whose in-window messages are all noise
// kinds (excerpt = "") cost nothing under a pure excerpt-token pack — an
// unbounded number of them clump into ONE chunk, and their per-session prompt
// headers (unbudgeted) can alone blow the 120k pre-flight: a residual death
// spiral. Contract fix under test: each session charges
// max(estimateTokens(excerpt), SESSION_OVERHEAD_TOKENS), with
// SESSION_OVERHEAD_TOKENS = 32 exported from dream.ts.

describe("runDream chunking — per-session overhead floor (auditor defect 2)", () => {
  // Noise-kind in-window message: bumps lastMessageAt (appendMessage is
  // unconditional) but distills to an EMPTY excerpt (stream_event is a noise
  // kind dropped by distillMessage).
  const seedNoiseSession = (
    sessions: Effect.Effect.Success<typeof SessionStore>,
    id: string,
    ts: number,
  ) =>
    Effect.gen(function* () {
      yield* sessions.create({ id, options: { model: "test" }, createdAt: 0 })
      yield* sessions.appendMessage({
        sessionId: id, messageId: `${id}-m1`, ts, parentId: null,
        kind: "stream_event", payload: { delta: "noise" },
      })
    })

  it("D2: empty-excerpt sessions each charge SESSION_OVERHEAD_TOKENS — 4 empty sessions with budget 64 pack into exactly 2 chunks of 2", async () => {
    const layers = Layer.mergeAll(
      DreamStore.Memory,
      SessionStore.Default,
      FakeMemory([]),
      Clock.Default,
    )
    const { layer: reasonerL, callsRef } = makeRecordingReasoner([{ ops: [] }, { ops: [] }])

    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        // DISTINCT lastMessageAt values (10/20/30/40) so tie-group cohesion
        // (defect 1) cannot interfere with the packing arithmetic here.
        yield* seedNoiseSession(sessions, "s-e1", 10)
        yield* seedNoiseSession(sessions, "s-e2", 20)
        yield* seedNoiseSession(sessions, "s-e3", 30)
        yield* seedNoiseSession(sessions, "s-e4", 40)
        return yield* runDream(NOW, { sessionTokenBudget: 64 })
      }).pipe(Effect.provide(reasonerL), Effect.provide(layers)) as Effect.Effect<any, any, never>,
    )

    // 32+32 = 64 fits the budget; a third session (96) would exceed it —
    // exactly two chunks of two, ascending. Today all four charge 0 tokens and
    // clump into ONE call.
    const calls = getCalls(callsRef)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.sessionIds).toEqual(["s-e1", "s-e2"])
    expect(calls[1]?.sessionIds).toEqual(["s-e3", "s-e4"])
    expect(out.chunksProcessed).toBe(2)
    expect(out.sessionsProcessed).toBe(4)
    expect(out.stoppedEarly).toBe(false)
    expect(out.watermark).toBe(40)
    // The floor is a named, exported constant — not an inlined magic number.
    expect(SESSION_OVERHEAD_TOKENS).toBe(32)
  })
})
