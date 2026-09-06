/**
 * Integration test: outcome-health predicates end-to-end (ADR 0001 Phase 2).
 *
 * Verifies:
 *   1. A job with a stale health predicate: run succeeds, outcome_state='stale',
 *      last_outcome_success_at=null, exactly ONE agent_note per fingerprint.
 *   2. A job with a fresh health predicate: outcome_state='fresh',
 *      last_outcome_success_at set, no agent_note.
 *   3. A job without a health predicate: outcome_state=null, no agent_note.
 *
 * Uses Memory JobsStore (V5 fields are in PersistedJob), stub AgentNotesService
 * that captures calls, JobTickerLayer({ autoStart: false }).
 */
import { describe, expect, it } from "vitest"
import { Context, Duration, Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { JobsStoreService } from "./jobs-store.js"
import { JobTicker, JobTickerLayer } from "./job-ticker.js"
import { makeWorkerRegistry, type Worker } from "./worker-registry.js"
import { AgentNotesService } from "../agent-notes/agent-notes.js"
import type { AgentNotesApi, GatedNoteResult } from "../agent-notes/types.js"
import { registerPredicate } from "./outcome-health-predicate.js"

// ── Deterministic predicates (registered once per process) ───────────────────

const ALWAYS_STALE = "test_integration_always_stale"
const ALWAYS_FRESH = "test_integration_always_fresh"

registerPredicate(ALWAYS_STALE, async () => ({
  state: "stale" as const,
  detail: "injected stale for integration test",
}))
registerPredicate(ALWAYS_FRESH, async () => ({
  state: "fresh" as const,
}))

// ── Stub AgentNotesService ───────────────────────────────────────────────────

function makeStubNotesLayer(): { layer: Layer.Layer<AgentNotesService>; calls: { summary: string; fingerprint?: string }[] } {
  const calls: { summary: string; fingerprint?: string }[] = []
  const seen = new Set<string>()

  const recordIfChanged: AgentNotesApi["recordIfChanged"] = (input, opts) => {
    const fp = opts?.fingerprint
    if (fp !== undefined && seen.has(fp)) {
      return Effect.succeed({ suppressed: true } as GatedNoteResult)
    }
    if (fp !== undefined) seen.add(fp)
    calls.push({ summary: input.summary, ...(fp !== undefined ? { fingerprint: fp } : {}) })
    return Effect.succeed({ suppressed: false, note: { id: `stub-${calls.length}`, kind: input.kind, summary: input.summary } as never } satisfies GatedNoteResult)
  }

  // Stub that satisfies AgentNotesApi — only recordIfChanged needs implementation
  const stub = {
    recordIfChanged,
    record: () => Effect.die("stub"),
    getRecent: () => Effect.succeed([]),
    listByKind: () => Effect.succeed([]),
    listAll: () => Effect.succeed([]),
    search: () => Effect.succeed([]),
    getById: () => Effect.succeed(null),
    deleteById: () => Effect.succeed(0),
  } as unknown as AgentNotesApi

  const layer = Layer.succeed(AgentNotesService, stub)
  return { layer, calls }
}

// ── buildStack helper ────────────────────────────────────────────────────────

const noop: Worker = () => Effect.succeed({ outputText: null })

function buildStack(
  workers: Record<string, Worker>,
  notesLayer?: Layer.Layer<AgentNotesService>,
) {
  const storeL = JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))
  const regL = makeWorkerRegistry(workers)
  const base = Layer.mergeAll(storeL, regL, Clock.Default)
  return JobTickerLayer({
    tickInterval: Duration.seconds(60),
    autoStart: false,
    shutdownDrainMs: 0,
  }).pipe(
    Layer.provideMerge(
      notesLayer ? Layer.mergeAll(base, notesLayer) : base,
    ),
  )
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("outcome-health integration", () => {
  it("stale predicate → outcome_state='stale', last_outcome_success_at=null, exactly one note", async () => {
    const { layer: notesL, calls } = makeStubNotesLayer()

    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker

      yield* store.record({
        id: "stale-job",
        kind: "wake",
        spec: "",
        payload: { label: "stale-job", health: { predicate: ALWAYS_STALE } },
      })
      yield* store.setV2Fields("stale-job", { nextRunAt: 0, enabled: true })

      // First drain
      yield* ticker.drain
      yield* ticker.awaitIdle

      const job1 = yield* store.getById("stale-job")
      expect(job1?.outcomeState).toBe("stale")
      expect(job1?.lastOutcomeSuccessAt).toBeNull()
      expect(job1?.lastStatus).toBe("fired")
      expect(calls).toHaveLength(1)
      expect(calls[0]?.summary).toContain("stale")

      // Second drain — next_run_at must be set for a second pick-up.
      // Memory store leaves it at 0 so a second drain picks it up again.
      yield* ticker.drain
      yield* ticker.awaitIdle

      // Same fingerprint → stub dedupes → still exactly 1 call
      expect(calls).toHaveLength(1)
    })

    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: noop }, notesL))),
    )
  })

  it("fresh predicate → outcome_state='fresh', last_outcome_success_at set, no note", async () => {
    const { layer: notesL, calls } = makeStubNotesLayer()

    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker

      yield* store.record({
        id: "fresh-job",
        kind: "wake",
        spec: "",
        payload: { label: "fresh-job", health: { predicate: ALWAYS_FRESH } },
      })
      yield* store.setV2Fields("fresh-job", { nextRunAt: 0, enabled: true })

      yield* ticker.drain
      yield* ticker.awaitIdle

      const job = yield* store.getById("fresh-job")
      expect(job?.outcomeState).toBe("fresh")
      expect(typeof job?.lastOutcomeSuccessAt).toBe("number")
      expect(calls).toHaveLength(0)
    })

    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: noop }, notesL))),
    )
  })

  it("no health predicate → outcomeState stays null, no note", async () => {
    const { layer: notesL, calls } = makeStubNotesLayer()

    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker

      yield* store.record({
        id: "no-health-job",
        kind: "wake",
        spec: "",
        payload: { label: "no-health-job" },
      })
      yield* store.setV2Fields("no-health-job", { nextRunAt: 0, enabled: true })

      yield* ticker.drain
      yield* ticker.awaitIdle

      const job = yield* store.getById("no-health-job")
      expect(job?.outcomeState).toBeNull()
      expect(job?.lastOutcomeSuccessAt).toBeNull()
      expect(calls).toHaveLength(0)
    })

    await Effect.runPromise(
      prog.pipe(Effect.provide(buildStack({ wake: noop }, notesL))),
    )
  })
})
