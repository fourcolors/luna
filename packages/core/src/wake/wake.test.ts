import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { runWake } from "./wake.js"
import { FakeWakeReasoner } from "./reasoner.js"
import { WakeLogStore } from "./wake-log-store.js"
import { WakeReasoner } from "./reasoner.js"
import { WakeError } from "./types.js"
import { AgentNotesService } from "../agent-notes/agent-notes.js"
import { Clock } from "../clock.js"
import type { WakeDigest } from "./types.js"
import { tmpdir } from "node:os"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { installWakeSchema } from "./workspace-schema.js"

/** Build a temp workspace dir with .workspace/{workspace.md,workspace.db}.
 *  `withSchema` (default true) installs the canonical wake schema; pass false
 *  to simulate a workspace that was never wake-enabled (skip path). */
function makeTempWorkspace(opts: {
  withGoals?: boolean
  withActions?: boolean
  withWakes?: boolean
  withSchema?: boolean
}): { path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "wake-test-"))
  const wsDir = join(root, ".workspace")
  mkdirSync(wsDir, { recursive: true })
  writeFileSync(
    join(wsDir, "workspace.md"),
    "# luna\nTest workspace for wake unit test.",
  )
  const db = new Database(join(wsDir, "workspace.db"))
  if (opts.withSchema !== false) {
    installWakeSchema(db)
  }
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

// runWake mirrors every wake event into agent notes, so it requires
// AgentNotesService. Provide its in-memory layer to every run; without it the
// Effect dies with "Service not found: luna/AgentNotesService" — a failure only
// surfaced at runtime because *.test.ts is excluded from `tsc` (tsconfig.json).
const AgentNotesL = AgentNotesService.Memory.pipe(Layer.provide(Clock.Default))

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
      const layer = Layer.mergeAll(
        FakeWakeReasoner.of(digest),
        WakeLogStore.Memory,
        AgentNotesL,
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
      const layer = Layer.mergeAll(
        FakeWakeReasoner.of(digest),
        WakeLogStore.Memory,
        AgentNotesL,
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
      const layer = Layer.mergeAll(
        failingReasoner,
        WakeLogStore.Memory,
        AgentNotesL,
      )
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
    const layer = Layer.mergeAll(
      FakeWakeReasoner.of(digest),
      WakeLogStore.Memory,
      AgentNotesL,
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

  it("writes a 'skipped' row (only on transition) when the workspace has no wake schema", async () => {
    const { path, cleanup } = makeTempWorkspace({ withSchema: false })
    try {
      // The reasoner must NEVER run for a not-wake-enabled workspace.
      const reasonerMustNotRun = Layer.succeed(WakeReasoner, {
        reason: () =>
          Effect.die("reasoner must not be invoked on a skipped workspace"),
      })
      const layer = Layer.mergeAll(
        reasonerMustNotRun,
        WakeLogStore.Memory,
        AgentNotesL,
      )
      const rows = await Effect.runPromise(
        Effect.gen(function* () {
          // Two consecutive ticks against the same in-memory store.
          yield* runWake(1_000, { workspaceSlug: "luna", workspacePath: path })
          yield* runWake(2_000, { workspaceSlug: "luna", workspacePath: path })
          const store = yield* WakeLogStore
          return yield* store.recent(10)
        }).pipe(Effect.provide(layer)),
      )
      // Transition-only: the first tick records a skip; the second stays silent.
      expect(rows).toHaveLength(1)
      expect(rows[0]?.outcome).toBe("skipped")
      expect(rows[0]?.wokeAt).toBe(1_000)
      expect(rows[0]?.summary).toContain("not wake-enabled")
      const artifacts = JSON.parse(rows[0]?.artifacts ?? "{}") as {
        stage?: string
        skipped?: string
      }
      expect(artifacts.stage).toBe("read-inputs")
      expect(artifacts.skipped).toBeDefined()
    } finally {
      cleanup()
    }
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
      const layer = Layer.mergeAll(
        capturingReasoner,
        WakeLogStore.Memory,
        AgentNotesL,
      )
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
