import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { runWake } from "./wake.js"
import { FakeWakeReasoner } from "./reasoner.js"
import { WakeLogStore } from "./wake-log-store.js"
import { WakeReasoner } from "./reasoner.js"
import { WakeError } from "./types.js"
import type { WakeDigest } from "./types.js"
import { tmpdir } from "node:os"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"

/** Build a temp workspace dir with .workspace/{workspace.md,workspace.db} */
function makeTempWorkspace(opts: {
  withGoals?: boolean
  withActions?: boolean
  withWakes?: boolean
}): { path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "wake-test-"))
  const wsDir = join(root, ".workspace")
  mkdirSync(wsDir, { recursive: true })
  writeFileSync(
    join(wsDir, "workspace.md"),
    "# luna\nTest workspace for wake unit test.",
  )
  const db = new Database(join(wsDir, "workspace.db"))
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
  if (opts.withWakes) {
    db.run(
      "INSERT INTO wake_log (woke_at, goal_slug, summary, outcome, artifacts) " +
        "VALUES (50, NULL, 'earlier wake', 'no-op', '{}')",
    )
  }
  db.close()
  return {
    path: root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

describe("runWake", () => {
  it("writes a success row when the reasoner picks an action", async () => {
    const { path, cleanup } = makeTempWorkspace({
      withGoals: true,
      withActions: true,
    })
    try {
      const digest: WakeDigest = {
        workspaceSlug: "luna",
        observations: ["one action is open"],
        pickedActionId: 1,
        pickedReason: "highest priority + actionable",
        proposedActions: [],
      }
      const layer = Layer.merge(
        FakeWakeReasoner.of(digest),
        WakeLogStore.Memory,
      )
      const rows = await Effect.runPromise(
        Effect.gen(function* () {
          yield* runWake(1_000, {
            workspaceSlug: "luna",
            workspacePath: path,
          })
          const store = yield* WakeLogStore
          return yield* store.recent(10)
        }).pipe(Effect.provide(layer)),
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.wokeAt).toBe(1_000)
      expect(rows[0]?.outcome).toBe("success")
      expect(rows[0]?.summary).toContain("picked action #1")
      const parsed = JSON.parse(rows[0]?.artifacts ?? "{}") as WakeDigest
      expect(parsed.pickedActionId).toBe(1)
    } finally {
      cleanup()
    }
  })

  it("writes a no-op row when the reasoner picks nothing", async () => {
    const { path, cleanup } = makeTempWorkspace({})
    try {
      const digest: WakeDigest = {
        workspaceSlug: "luna",
        observations: ["workspace is empty"],
        pickedActionId: null,
        pickedReason: "nothing actionable",
        proposedActions: [],
      }
      const layer = Layer.merge(
        FakeWakeReasoner.of(digest),
        WakeLogStore.Memory,
      )
      const rows = await Effect.runPromise(
        Effect.gen(function* () {
          yield* runWake(2_000, {
            workspaceSlug: "luna",
            workspacePath: path,
          })
          const store = yield* WakeLogStore
          return yield* store.recent(10)
        }).pipe(Effect.provide(layer)),
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.outcome).toBe("no-op")
      expect(rows[0]?.summary).toBe("nothing actionable")
    } finally {
      cleanup()
    }
  })

  it("writes an error row + does not throw when reasoner fails", async () => {
    const { path, cleanup } = makeTempWorkspace({})
    try {
      const failingReasoner = Layer.succeed(WakeReasoner, {
        reason: () =>
          Effect.fail(
            new WakeError({
              op: "wake/test",
              message: "synthetic failure",
            }),
          ),
      })
      const layer = Layer.merge(failingReasoner, WakeLogStore.Memory)
      const rows = await Effect.runPromise(
        Effect.gen(function* () {
          yield* runWake(3_000, {
            workspaceSlug: "luna",
            workspacePath: path,
          })
          const store = yield* WakeLogStore
          return yield* store.recent(10)
        }).pipe(Effect.provide(layer)),
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.outcome).toBe("error")
      expect(rows[0]?.summary).toContain("synthetic failure")
      const artifacts = JSON.parse(rows[0]?.artifacts ?? "{}") as {
        stage?: string
      }
      expect(artifacts.stage).toBe("reason")
    } finally {
      cleanup()
    }
  })

  it("writes an error row when workspace.db doesn't exist", async () => {
    const fakePath = join(tmpdir(), "does-not-exist-" + Math.random())
    const digest: WakeDigest = {
      workspaceSlug: "luna",
      observations: [],
      pickedActionId: null,
      pickedReason: "",
      proposedActions: [],
    }
    const layer = Layer.merge(
      FakeWakeReasoner.of(digest),
      WakeLogStore.Memory,
    )
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        yield* runWake(4_000, {
          workspaceSlug: "luna",
          workspacePath: fakePath,
        })
        const store = yield* WakeLogStore
        return yield* store.recent(10)
      }).pipe(Effect.provide(layer)),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe("error")
    const artifacts = JSON.parse(rows[0]?.artifacts ?? "{}") as {
      stage?: string
    }
    expect(artifacts.stage).toBe("read-inputs")
  })

  it("feeds workspace state into the reasoner", async () => {
    const { path, cleanup } = makeTempWorkspace({
      withGoals: true,
      withActions: true,
      withWakes: true,
    })
    try {
      // Reasoner that captures whatever inputs it sees so the test can assert.
      const captured: { inputs?: unknown } = {}
      const capturingReasoner = Layer.succeed(WakeReasoner, {
        reason: (inputs) =>
          Effect.sync(() => {
            captured.inputs = inputs
            return {
              workspaceSlug: inputs.workspaceSlug,
              observations: [],
              pickedActionId: null,
              pickedReason: "captured",
              proposedActions: [],
            }
          }),
      })
      const layer = Layer.merge(capturingReasoner, WakeLogStore.Memory)
      await Effect.runPromise(
        runWake(5_000, {
          workspaceSlug: "luna",
          workspacePath: path,
        }).pipe(Effect.provide(layer)),
      )
      const inputs = captured.inputs as {
        workspaceSlug: string
        workspaceMd: string
        openGoals: ReadonlyArray<{ slug: string }>
        openNextActions: ReadonlyArray<{ id: number; action: string }>
        recentWakes: ReadonlyArray<{ wokeAt: number; outcome: string }>
      }
      expect(inputs.workspaceSlug).toBe("luna")
      expect(inputs.workspaceMd).toContain("Test workspace")
      expect(inputs.openGoals).toHaveLength(1)
      expect(inputs.openGoals[0]?.slug).toBe("g1")
      expect(inputs.openNextActions).toHaveLength(1)
      expect(inputs.openNextActions[0]?.action).toBe("do the thing")
      expect(inputs.recentWakes).toHaveLength(1)
      expect(inputs.recentWakes[0]?.outcome).toBe("no-op")
    } finally {
      cleanup()
    }
  })
})
