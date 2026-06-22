import { describe, expect, it } from "vitest"
import { Effect, Either } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WakeLogStore } from "./wake-log-store.js"

describe("WakeLogStore.Memory", () => {
  it("appends rows and returns them newest-first via recent()", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WakeLogStore
        const a = yield* store.append({
          wokeAt: 1_000,
          goalSlug: null,
          summary: "early wake",
          outcome: "no-op",
          artifacts: "{}",
        })
        const b = yield* store.append({
          wokeAt: 2_000,
          goalSlug: "goal-x",
          summary: "later wake",
          outcome: "success",
          artifacts: '{"x":1}',
        })
        const c = yield* store.append({
          wokeAt: 1_500,
          goalSlug: null,
          summary: "middle wake",
          outcome: "error",
          artifacts: '{"err":"boom"}',
        })
        const rows = yield* store.recent(10)
        return { a, b, c, rows }
      }).pipe(Effect.provide(WakeLogStore.Memory)),
    )
    expect(out.a).toBe(1)
    expect(out.b).toBe(2)
    expect(out.c).toBe(3)
    expect(out.rows.map((r) => r.wokeAt)).toEqual([2_000, 1_500, 1_000])
    expect(out.rows[0]?.outcome).toBe("success")
    expect(out.rows[0]?.goalSlug).toBe("goal-x")
    expect(out.rows[2]?.artifacts).toBe("{}")
  })

  it("respects the limit on recent()", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WakeLogStore
        for (let i = 1; i <= 5; i++) {
          yield* store.append({
            wokeAt: i * 1_000,
            goalSlug: null,
            summary: `wake-${i}`,
            outcome: "no-op",
            artifacts: "{}",
          })
        }
        return yield* store.recent(2)
      }).pipe(Effect.provide(WakeLogStore.Memory)),
    )
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.wokeAt)).toEqual([5_000, 4_000])
  })

  it("isolated layer builds — each provide produces a fresh store", async () => {
    const a = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WakeLogStore
        yield* store.append({
          wokeAt: 1,
          goalSlug: null,
          summary: "a",
          outcome: "no-op",
          artifacts: "{}",
        })
        return yield* store.recent(10)
      }).pipe(Effect.provide(WakeLogStore.Memory)),
    )
    const b = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WakeLogStore
        return yield* store.recent(10)
      }).pipe(Effect.provide(WakeLogStore.Memory)),
    )
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(0)
  })
})

// bun:sqlite only exists under the Bun runtime; under `vitest run` (node) this
// suite is skipped — same reason the suites above use only WakeLogStore.Memory.
// It runs under `bun test` (npm `test:bun`).
const NOT_BUN = typeof (globalThis as { Bun?: unknown }).Bun === "undefined"

describe.skipIf(NOT_BUN)("WakeLogStore.makeLayer (disk, un-bootstrapped workspace)", () => {
  // Regression: a fresh local/dev boot points the wake store at a workspace.db
  // whose `.workspace/` parent dir may not exist AND which has no next_actions
  // table. Building the layer used to crash boot two ways — SQLITE_CANTOPEN
  // (missing dir) and `no such table: next_actions` (eager prepare). Both are
  // now deferred/handled, so the layer must BUILD and degrade gracefully.
  it("builds when the parent dir is missing and surfaces a WakeError (not a boot crash) on appendNextActions", async () => {
    const root = mkdtempSync(join(tmpdir(), "luna-wake-store-"))
    // `.workspace` deliberately does NOT exist — exercises the mkdir.
    const dbPath = join(root, ".workspace", "workspace.db")
    try {
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* WakeLogStore
          // wake_log is created by makeLayer → append works.
          const id = yield* store.append({
            wokeAt: 1,
            goalSlug: null,
            summary: "first wake on a fresh workspace",
            outcome: "no-op",
            artifacts: "{}",
          })
          // next_actions does NOT exist → must be a caught WakeError, not a throw.
          const filed = yield* Effect.either(
            store.appendNextActions(
              [{ goalSlug: null, action: "do the thing", priority: 3 }],
              1_000,
            ),
          )
          return { id, filed }
        }).pipe(Effect.provide(WakeLogStore.makeLayer(dbPath))),
      )
      // Reaching here at all proves the layer BUILT (the boot-crash bug is gone).
      expect(out.id).toBe(1)
      expect(Either.isLeft(out.filed)).toBe(true)
      if (Either.isLeft(out.filed)) {
        expect(out.filed.left._tag).toBe("WakeError")
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
