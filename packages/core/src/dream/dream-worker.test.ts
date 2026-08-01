/**
 * dream-worker.test.ts — Tier-1 unit tests for the V2 `dream` worker
 * (scheduler-v2 dream/wake migration, scenario M1).
 *
 * The DreamWorker is the V2-JobTicker equivalent of registerDreamCron: a
 * Worker<never> that, on dispatch, runs ONE `runDream` cycle against the dream
 * service environment captured at layer-build time. It exists because the
 * generic `prompt`/`workflow` workers are typed Worker<never> and reach only
 * SDKClient + AgentNotesService — they cannot carry dream's deps
 * (DreamStore + DreamReasoner + SessionStore + MemoryRouter + Clock).
 *
 * Mirrors the conventions of prompt-worker.test.ts (Layer.provideMerge to keep
 * the WorkerRegistry visible above the worker layer) + dream-cron.test.ts
 * (FakeReasoner + DreamStore.Memory + FakeMemoryEmpty + a seeded session).
 * No SQLite, no model calls, no TestClock (the worker has no sleep — it runs
 * immediately on dispatch, so real Clock.Default is fine).
 *
 * OUT OF SCOPE for the implementation (pp-pong MUST NOT touch these):
 *   - packages/core/src/dream/dream.ts        (runDream/applyOps reused as-is)
 *   - packages/core/src/dream/dream-store.ts
 *   - packages/core/src/dream/reasoner.ts
 *   - packages/core/src/jobs/worker-registry.ts
 *   - packages/core/src/dream/types.ts
 * The only new file is packages/core/src/dream/dream-worker.ts (+ an index export).
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Ref, Stream } from "effect"
import { Clock } from "../clock.js"
import {
  WorkerRegistry,
  makeWorkerRegistry,
  type WorkerContext,
} from "../jobs/worker-registry.js"
import { DreamStore } from "./dream-store.js"
import { FakeReasoner } from "./reasoner.js"
import { SessionStore } from "../session/session-store.js"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import type { DreamOp } from "./types.js"
import {
  DreamWorkerLayer,
  DREAM_WORKER_KIND,
} from "./dream-worker.js"
import { DREAM_DEADLINE_SAFETY_MS } from "./dream.js"

// Minimal Ref-backed memory router double (mirrors dream-cron.test.ts).
const FakeMemoryEmpty = Layer.effect(
  MemoryRouterTag,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<string, MemoryRecord>>(new Map())
    return {
      put: (r: MemoryRecord) => Ref.update(store, (m) => new Map(m).set(r.id, r)),
      get: (id: string) => Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
      delete: (id: string) =>
        Ref.modify(store, (m) => {
          const had = m.has(id)
          const next = new Map(m)
          next.delete(id)
          return [had, next]
        }),
      query: () => Stream.empty,
      search: () => Stream.empty,
    } as never
  }),
)

const ctx: WorkerContext = {
  jobId: "dream-job",
  runId: 7,
  attempt: 1,
  deadline: 0,
}

const DEDUP_OP: DreamOp = {
  kind: "memory_dedup",
  targetId: "mem-dup-1",
  before: null,
  after: null, // null after ⇒ delete (materialized, idempotent)
  rationale: "exact duplicate",
}

/**
 * Build a layer that registers the DreamWorker AND exposes the underlying
 * service instances (WorkerRegistry, DreamStore, SessionStore) to the test
 * program — via provideMerge, exactly like prompt-worker.test.ts.
 */
const exposed = (ops: ReadonlyArray<DreamOp>) => {
  const baseDeps = Layer.mergeAll(
    DreamStore.Memory,
    FakeReasoner.of(ops),
    SessionStore.Default,
    FakeMemoryEmpty,
    makeWorkerRegistry({}),
  ).pipe(Layer.provideMerge(Clock.Default))
  return DreamWorkerLayer().pipe(Layer.provideMerge(baseDeps))
}

describe("DreamWorkerLayer", () => {
  it("(a) registers a worker under the 'dream' kind", async () => {
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const kinds = yield* reg.listKinds
      expect([...kinds]).toContain(DREAM_WORKER_KIND)
      expect(DREAM_WORKER_KIND).toBe("dream")
    })
    await Effect.runPromise(prog.pipe(Effect.provide(exposed([]))))
  })

  // job-ticker-oban-deadlines (Seam 2 boot wiring): a bare-function
  // registration here would silently regress every dream cycle back to the
  // pre-slice 5-min ticker ceiling — exactly the production bug (3/3 nightly
  // dream failures) this slice exists to fix.
  it("(a2) registers with a defaultTimeoutMs of 15 min by default, overridable via LUNA_DREAM_WORKER_TIMEOUT_MS", async () => {
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const entry = yield* reg.lookupEntry(DREAM_WORKER_KIND)
      expect(entry?.defaultTimeoutMs).toBe(15 * 60 * 1000)
    })
    await Effect.runPromise(prog.pipe(Effect.provide(exposed([]))))

    const prevEnv = process.env["LUNA_DREAM_WORKER_TIMEOUT_MS"]
    process.env["LUNA_DREAM_WORKER_TIMEOUT_MS"] = "600000"
    try {
      const prog2 = Effect.gen(function* () {
        const reg = yield* WorkerRegistry
        const entry = yield* reg.lookupEntry(DREAM_WORKER_KIND)
        expect(entry?.defaultTimeoutMs).toBe(600_000)
      })
      await Effect.runPromise(prog2.pipe(Effect.provide(exposed([]))))
    } finally {
      if (prevEnv === undefined) delete process.env["LUNA_DREAM_WORKER_TIMEOUT_MS"]
      else process.env["LUNA_DREAM_WORKER_TIMEOUT_MS"] = prevEnv
    }
  })

  it("(b) dispatching 'dream' runs a full runDream cycle (watermark advances to the gathered cutoff)", async () => {
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const sessions = yield* SessionStore
      const store = yield* DreamStore

      // Seed a session with a known lastMessageAt so the dream window is
      // non-empty and the watermark can advance to it (not to `now`).
      yield* sessions.create({ id: "s-1", options: { model: "test" }, createdAt: 0 })
      yield* sessions.appendMessage({
        sessionId: "s-1", messageId: "m-1", ts: 1800,
        parentId: null, kind: "user", payload: "hello",
      })

      const out = yield* reg.dispatch(DREAM_WORKER_KIND, {}, ctx)

      // A WorkerResult with non-null outputText (lands in job_runs.output_text).
      expect(out.outputText).not.toBeNull()
      expect(typeof out.outputText).toBe("string")

      // runDream advanced the watermark to the max gathered lastMessageAt (1800),
      // proving the dream cycle actually executed inside the worker.
      const wm = yield* store.getWatermark
      expect(wm).toBe(1800)
    })
    await Effect.runPromise(prog.pipe(Effect.provide(exposed([]))))
  })

  it("(c) dispatching 'dream' applies the reasoner's ops (audit row recorded)", async () => {
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const sessions = yield* SessionStore
      const store = yield* DreamStore

      yield* sessions.create({ id: "s-1", options: { model: "test" }, createdAt: 0 })
      yield* sessions.appendMessage({
        sessionId: "s-1", messageId: "m-1", ts: 1800,
        parentId: null, kind: "user", payload: "hello",
      })

      yield* reg.dispatch(DREAM_WORKER_KIND, {}, ctx)

      // memory_dedup materializes → an 'applied' audit row is recorded.
      const applied = yield* store.list({ status: "applied" })
      expect(applied).toHaveLength(1)
      expect(applied[0]?.op).toBe("memory_dedup")
      expect(applied[0]?.targetId).toBe("mem-dup-1")
    })
    await Effect.runPromise(prog.pipe(Effect.provide(exposed([DEDUP_OP]))))
  })

  it("(d) a custom kind override registers under that kind instead of 'dream'", async () => {
    const baseDeps = Layer.mergeAll(
      DreamStore.Memory,
      FakeReasoner.of([]),
      SessionStore.Default,
      FakeMemoryEmpty,
      makeWorkerRegistry({}),
    ).pipe(Layer.provideMerge(Clock.Default))
    const stack = DreamWorkerLayer({ kind: "dream_nightly" }).pipe(
      Layer.provideMerge(baseDeps),
    )
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const kinds = yield* reg.listKinds
      expect([...kinds]).toEqual(["dream_nightly"])
    })
    await Effect.runPromise(prog.pipe(Effect.provide(stack)))
  })

  // ── S8 — deadline seam (Loop C: chunked dream + deadline-aware stop) ─────
  // buildDreamWorker must forward `jobCtx.deadline` into runDream's new
  // `deadlineAt` option, and the worker's outputText must surface the
  // RunDreamSummary (chunks=/stoppedEarly=) so `job_runs.output_text` carries
  // enough signal to spot a deadline-truncated cycle without reading
  // dream_audit. Both the DREAM_DEADLINE_SAFETY_MS export and the
  // summary-aware outputText format are new (chunking.test.ts pins the full
  // runDream contract) — this is RED until the implementer wires runDream's
  // RunDreamSummary through buildDreamWorker's outputText.
  //
  // Determinism: replaces the base composition's `Clock.Default` (real wall
  // time) with a single static `Clock.Test(FIXED)` so the worker's `now` (via
  // `clock.nowMs()`) and runDream's internal deadline-gate read the SAME
  // deterministic instant. One seeded session ⇒ exactly one real chunk, so
  // no clock-ticking trick is needed here (unlike chunking.test.ts's S7a
  // multi-chunk scenario) — we only need "does the lone chunk run or not."
  it("(f) forwards jobCtx.deadline into runDream — a generous deadline completes normally, an already-exhausted one stops early", async () => {
    const FIXED = 5_000_000
    const clockLayer = Clock.Test(FIXED)

    const buildStack = (ops: ReadonlyArray<DreamOp>) => {
      const baseDeps = Layer.mergeAll(
        DreamStore.Memory,
        FakeReasoner.of(ops),
        SessionStore.Default,
        FakeMemoryEmpty,
        makeWorkerRegistry({}),
      ).pipe(Layer.provideMerge(clockLayer))
      return DreamWorkerLayer().pipe(Layer.provideMerge(baseDeps))
    }

    const seedAndDispatch = (dispatchCtx: WorkerContext) =>
      Effect.gen(function* () {
        const reg = yield* WorkerRegistry
        const sessions = yield* SessionStore
        yield* sessions.create({ id: "s-1", options: { model: "test" }, createdAt: 0 })
        yield* sessions.appendMessage({
          sessionId: "s-1", messageId: "m-1", ts: 1800,
          parentId: null, kind: "user", payload: "hello",
        })
        return yield* reg.dispatch(DREAM_WORKER_KIND, {}, dispatchCtx)
      })

    // Generous deadline: far beyond FIXED — the single chunk completes.
    const generousOut = await Effect.runPromise(
      seedAndDispatch({ ...ctx, deadline: FIXED + 10_000_000 }).pipe(
        Effect.provide(buildStack([])),
      ),
    )
    expect(generousOut.outputText).toContain("chunks=")
    expect(generousOut.outputText).toContain("stoppedEarly=false")

    // Already-exhausted deadline (past even accounting for the safety
    // margin): the gate trips before the only chunk runs.
    const pastOut = await Effect.runPromise(
      seedAndDispatch({ ...ctx, deadline: FIXED - DREAM_DEADLINE_SAFETY_MS - 1 }).pipe(
        Effect.provide(buildStack([])),
      ),
    )
    expect(pastOut.outputText).toContain("chunks=")
    expect(pastOut.outputText).toContain("stoppedEarly=true")
  })
})
