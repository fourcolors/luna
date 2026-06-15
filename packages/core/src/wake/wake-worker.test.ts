/**
 * wake-worker.test.ts — Tier-1 unit tests for the V2 `wake` worker
 * (scheduler-v2 dream/wake migration, scenario M2).
 *
 * The WakeWorker is the V2-JobTicker equivalent of registerWakeCron: a
 * Worker<never> that, on dispatch, runs ONE `runWake(now, opts)` cycle against
 * the wake service environment (WakeReasoner + WakeLogStore + AgentNotesService)
 * captured at layer-build time. It exists because the generic prompt/workflow
 * workers are typed Worker<never> and reach only SDKClient + AgentNotesService —
 * they cannot carry wake's WakeReasoner + WakeLogStore deps.
 *
 * Unlike dream (which reads its window from a watermark and ignores the payload),
 * wake is PER-WORKSPACE: each wake job row carries {workspaceSlug, workspacePath}
 * in its payload, and the worker parses those defensively before running the
 * cycle. So the dispatch tests pass a payload, and a bad-payload test asserts the
 * worker fails cleanly with a WorkerError rather than crashing the ticker.
 *
 * Mirrors dream-worker.test.ts (provideMerge to keep the WorkerRegistry visible)
 * + wake.test.ts (FakeWakeReasoner + WakeLogStore.Memory).
 *
 * bun:sqlite gating (mirrors artifact-store.test.ts): the Memory-backed cases
 * (registration, kind override, defensive payload parse) run everywhere under
 * vitest/node; the full-cycle cases that need a real workspace.db to read inputs
 * from are bun-gated (`describe.skip` under node) and import bun:sqlite
 * dynamically so the file still transforms under vite.
 *
 * OUT OF SCOPE for the implementation (must NOT be touched):
 *   - packages/core/src/wake/wake.ts            (runWake reused as-is)
 *   - packages/core/src/wake/wake-log-store.ts
 *   - packages/core/src/wake/reasoner.ts
 *   - packages/core/src/jobs/worker-registry.ts
 *   - packages/core/src/wake/types.ts
 * The only new file is packages/core/src/wake/wake-worker.ts (+ an index export).
 */
import { afterEach, describe, expect, it } from "vitest"
import { Cause, Effect, Layer } from "effect"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Clock } from "../clock.js"
import {
  WorkerRegistry,
  makeWorkerRegistry,
  WorkerError,
  type WorkerContext,
} from "../jobs/worker-registry.js"
import { AgentNotesService } from "../agent-notes/agent-notes.js"
import { FakeWakeReasoner } from "./reasoner.js"
import { WakeLogStore } from "./wake-log-store.js"
import type { WakeDigest } from "./types.js"
import { WakeWorkerLayer, WAKE_WORKER_KIND } from "./wake-worker.js"

const ctx: WorkerContext = {
  jobId: "wake-job",
  runId: 11,
  attempt: 1,
  deadline: 0,
}

const pickDigest: WakeDigest = {
  workspaceSlug: "luna",
  observations: ["one action is open"],
  pickedActionId: 1,
  pickedReason: "highest priority + actionable",
  proposedActions: [],
}

/**
 * Build a layer that registers the WakeWorker AND exposes the underlying
 * service instances (WorkerRegistry, WakeLogStore, AgentNotesService) to the
 * test program — via provideMerge, exactly like dream-worker.test.ts.
 */
const exposed = (digest: WakeDigest) => {
  const baseDeps = Layer.mergeAll(
    FakeWakeReasoner.of(digest),
    WakeLogStore.Memory,
    AgentNotesService.Memory,
    makeWorkerRegistry({}),
  ).pipe(Layer.provideMerge(Clock.Default))
  return WakeWorkerLayer().pipe(Layer.provideMerge(baseDeps))
}

// ── Memory-backed cases (run everywhere: vitest/node + bun) ──────────────────

describe("WakeWorkerLayer", () => {
  it("(a) registers a worker under the 'wake' kind", async () => {
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const kinds = yield* reg.listKinds
      expect([...kinds]).toContain(WAKE_WORKER_KIND)
      expect(WAKE_WORKER_KIND).toBe("wake")
    })
    await Effect.runPromise(prog.pipe(Effect.provide(exposed(pickDigest))))
  })

  it("(d) a custom kind override registers under that kind instead of 'wake'", async () => {
    const baseDeps = Layer.mergeAll(
      FakeWakeReasoner.of(pickDigest),
      WakeLogStore.Memory,
      AgentNotesService.Memory,
      makeWorkerRegistry({}),
    ).pipe(Layer.provideMerge(Clock.Default))
    const stack = WakeWorkerLayer({ kind: "wake_inspect" }).pipe(
      Layer.provideMerge(baseDeps),
    )
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const kinds = yield* reg.listKinds
      expect([...kinds]).toEqual(["wake_inspect"])
    })
    await Effect.runPromise(prog.pipe(Effect.provide(stack)))
  })

  // ── Defensive payload parsing (GOAL.md M2) ────────────────────────────────
  // Wake is per-workspace: each job row's payload MUST carry workspaceSlug +
  // workspacePath. A malformed payload is a typed WorkerError (clean job_runs
  // row) — NOT a defect, and NOT a silent no-op that would hide a misconfigured
  // row. No real workspace.db is touched, so this runs under node too.
  it("(e) a payload missing workspaceSlug/workspacePath fails with a WorkerError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const reg = yield* WorkerRegistry
        return yield* reg.dispatch(WAKE_WORKER_KIND, { not: "valid" }, ctx)
      }).pipe(Effect.provide(exposed(pickDigest))),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = Cause.failureOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(WorkerError)
        expect((failure.value as WorkerError).kind).toBe(WAKE_WORKER_KIND)
      }
    }
  })

  // ── End-to-end dispatch (runs everywhere — no bun:sqlite) ─────────────────
  // Proves the worker actually DISPATCHES runWake end-to-end under the same
  // node/vitest runner CI uses (the bun-gated success cases below only run under
  // bun). Pointing at a non-existent workspace path drives runWake's read-inputs
  // ERROR route, which still writes a wake_log row + an agent_notes mirror — so
  // dispatch -> runWake -> WakeLogStore + AgentNotesService is verified, and the
  // worker returns a WorkerResult (runWake never throws).
  it("(g) dispatching 'wake' runs runWake end-to-end (missing workspace -> error wake_log row + notes mirror)", async () => {
    const missingPath = join(
      tmpdir(),
      `wake-worker-missing-${process.pid}-${Date.now()}`,
    )
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const store = yield* WakeLogStore
      const notes = yield* AgentNotesService

      const out = yield* reg.dispatch(
        WAKE_WORKER_KIND,
        { workspaceSlug: "luna", workspacePath: missingPath },
        ctx,
      )
      expect(out.outputText).not.toBeNull()
      expect(typeof out.outputText).toBe("string")

      // runWake's read-inputs failure route wrote an 'error' wake_log row.
      const rows = yield* store.recent(10)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.outcome).toBe("error")

      // And mirrored the error into agent_notes (kind='wake_digest').
      const mirrored = yield* notes.getRecent("wake-cron", 10)
      expect(mirrored).toHaveLength(1)
      expect(mirrored[0]?.kind).toBe("wake_digest")
      expect(mirrored[0]?.summary).toContain("[error]")
    })
    await Effect.runPromise(prog.pipe(Effect.provide(exposed(pickDigest))))
  })
})

// ── Full-cycle cases (bun-gated: need a real workspace.db to read inputs) ─────
//
// Mirrors artifact-store.test.ts: `isBun ? describe : describe.skip` + a
// dynamic bun:sqlite import so the file still transforms under vite/node.

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const d = isBun ? describe : describe.skip

/** Build a temp workspace dir with .workspace/{workspace.md,workspace.db}. */
async function makeTempWorkspace(opts: {
  withGoals?: boolean
  withActions?: boolean
}): Promise<{ path: string; cleanup: () => void }> {
  const bunSqlite = (await import(
    /* @vite-ignore */ "bun:sqlite"
  )) as { Database: new (p: string) => {
    run: (sql: string) => void
    close: () => void
  } }
  const root = join(
    tmpdir(),
    `wake-worker-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  const wsDir = join(root, ".workspace")
  mkdirSync(wsDir, { recursive: true })
  writeFileSync(
    join(wsDir, "workspace.md"),
    "# luna\nTest workspace for wake worker unit test.",
  )
  const db = new bunSqlite.Database(join(wsDir, "workspace.db"))
  db.run(`CREATE TABLE goals (
    slug TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', priority INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
  db.run(`CREATE TABLE next_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, goal_slug TEXT NOT NULL,
    action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
    priority INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, completed_at INTEGER, notes TEXT)`)
  db.run(`CREATE TABLE wake_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, woke_at INTEGER NOT NULL,
    goal_slug TEXT, summary TEXT NOT NULL, outcome TEXT NOT NULL,
    artifacts TEXT)`)
  if (opts.withGoals) {
    db.run(
      "INSERT INTO goals VALUES ('g1','First goal','desc','active',3,100,100)",
    )
  }
  if (opts.withActions) {
    db.run(
      "INSERT INTO next_actions (goal_slug, action, status, priority, created_at, updated_at) " +
        "VALUES ('g1','do the thing','todo',3,200,200)",
    )
  }
  db.close()
  return {
    path: root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

d("WakeWorkerLayer (full cycle, bun-gated)", () => {
  let cleanups: Array<() => void> = []
  afterEach(() => {
    for (const c of cleanups) c()
    cleanups = []
  })

  it("(b) dispatching 'wake' runs a full runWake cycle (a wake_log row is written)", async () => {
    const { path, cleanup } = await makeTempWorkspace({
      withGoals: true,
      withActions: true,
    })
    cleanups.push(cleanup)
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const store = yield* WakeLogStore

      const out = yield* reg.dispatch(
        WAKE_WORKER_KIND,
        { workspaceSlug: "luna", workspacePath: path },
        ctx,
      )

      // A WorkerResult with non-null outputText (lands in job_runs.output_text).
      expect(out.outputText).not.toBeNull()
      expect(typeof out.outputText).toBe("string")

      // runWake wrote a wake_log row, proving the cycle executed inside the worker.
      const rows = yield* store.recent(10)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.outcome).toBe("success")
      expect(rows[0]?.summary).toContain("picked action #1")
    })
    await Effect.runPromise(prog.pipe(Effect.provide(exposed(pickDigest))))
  })

  it("(c) dispatching 'wake' applies the reasoner's digest (artifacts recorded + agent_notes mirror)", async () => {
    const { path, cleanup } = await makeTempWorkspace({
      withGoals: true,
      withActions: true,
    })
    cleanups.push(cleanup)
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const store = yield* WakeLogStore
      const notes = yield* AgentNotesService

      yield* reg.dispatch(
        WAKE_WORKER_KIND,
        { workspaceSlug: "luna", workspacePath: path },
        ctx,
      )

      const rows = yield* store.recent(10)
      expect(rows).toHaveLength(1)
      const parsed = JSON.parse(rows[0]?.artifacts ?? "{}") as WakeDigest
      expect(parsed.pickedActionId).toBe(1)

      // wake mirrors its digest into agent_notes (kind='wake_digest').
      const mirrored = yield* notes.getRecent("wake-cron", 10)
      expect(mirrored).toHaveLength(1)
      expect(mirrored[0]?.kind).toBe("wake_digest")
      expect(mirrored[0]?.summary).toContain("[success]")
    })
    await Effect.runPromise(prog.pipe(Effect.provide(exposed(pickDigest))))
  })
})
