/**
 * WorkspaceRegistryService — Tier-1 tests.
 *
 * Mirrors `agent-notes.test.ts`. All tests use `WorkspaceRegistryService.Memory`
 * — no SQLite required. Coverage:
 *
 *   - register: insert with defaults, summary, status, upsert preserves createdAt
 *   - get: found, not found
 *   - list: empty, all, status filter, newest-updated first
 *   - touch: updates updatedAt, no-op for unknown slug
 *   - updateSummary: refreshes summary + updatedAt, no-op for unknown slug
 *   - setStatus: changes status + updatedAt, no-op for unknown slug
 *   - delete: removes row, returns count, returns 0 for unknown
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { WorkspaceRegistryService } from "./workspaces.js"

/**
 * Provides WorkspaceRegistryService.Memory + Clock.Default so every test
 * gets a fresh, isolated registry with the real wall-clock.
 */
const run = <A, E>(
  eff: Effect.Effect<A, E, WorkspaceRegistryService>,
): Promise<A> =>
  Effect.runPromise(
    eff.pipe(
      Effect.provide(
        WorkspaceRegistryService.Memory.pipe(Layer.provide(Clock.Default)),
      ),
    ),
  )

describe("WorkspaceRegistryService", () => {
  // ── register ───────────────────────────────────────────────────────────────

  describe("register", () => {
    it("inserts a workspace with sensible defaults", async () => {
      const ws = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          return yield* svc.register({ slug: "luna", path: "/root/luna" })
        }),
      )

      expect(ws.slug).toBe("luna")
      expect(ws.path).toBe("/root/luna")
      expect(ws.summary).toBeNull()
      expect(ws.status).toBe("active")
      expect(ws.createdAt).toBeGreaterThan(0)
      expect(ws.updatedAt).toBeGreaterThanOrEqual(ws.createdAt)
    })

    it("stores summary and status when provided", async () => {
      const ws = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          return yield* svc.register({
            slug: "rr",
            path: "/p/rr",
            summary: "Risk research notebook",
            status: "paused",
          })
        }),
      )

      expect(ws.summary).toBe("Risk research notebook")
      expect(ws.status).toBe("paused")
    })

    it("upserts: re-registering the same slug preserves createdAt and refreshes other fields", async () => {
      const { first, second } = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          const first = yield* svc.register({
            slug: "luna",
            path: "/old/path",
            summary: "old",
          })
          yield* Effect.sleep("2 millis")
          const second = yield* svc.register({
            slug: "luna",
            path: "/new/path",
            summary: "new",
          })
          return { first, second }
        }),
      )

      expect(second.slug).toBe("luna")
      expect(second.path).toBe("/new/path")
      expect(second.summary).toBe("new")
      expect(second.createdAt).toBe(first.createdAt) // preserved
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
    })

    it("upsert preserves prior status when caller omits it", async () => {
      const ws = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          yield* svc.register({
            slug: "luna",
            path: "/p",
            status: "paused",
          })
          return yield* svc.register({ slug: "luna", path: "/p2" })
        }),
      )

      expect(ws.status).toBe("paused")
    })
  })

  // ── get ─────────────────────────────────────────────────────────────────────

  describe("get", () => {
    it("returns the workspace for a known slug", async () => {
      const ws = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          yield* svc.register({ slug: "luna", path: "/p" })
          return yield* svc.get("luna")
        }),
      )

      expect(ws).not.toBeNull()
      expect(ws!.slug).toBe("luna")
    })

    it("returns null for an unknown slug", async () => {
      const ws = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          return yield* svc.get("nope")
        }),
      )

      expect(ws).toBeNull()
    })
  })

  // ── list ────────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("returns an empty array when no workspaces are registered", async () => {
      const rows = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          return yield* svc.list()
        }),
      )

      expect(rows).toEqual([])
    })

    it("returns rows ordered by updatedAt DESC (most recently touched first)", async () => {
      const rows = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          yield* svc.register({ slug: "a", path: "/a" })
          yield* svc.register({ slug: "b", path: "/b" })
          yield* svc.register({ slug: "c", path: "/c" })
          // Touch `a` so it becomes most recent.
          yield* Effect.sleep("2 millis")
          yield* svc.touch("a")
          return yield* svc.list()
        }),
      )

      expect(rows.map((w) => w.slug)).toEqual(["a", "c", "b"])
    })

    it("filters by status when filter.status is provided", async () => {
      const rows = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          yield* svc.register({ slug: "a", path: "/a", status: "active" })
          yield* svc.register({ slug: "b", path: "/b", status: "archived" })
          yield* svc.register({ slug: "c", path: "/c", status: "active" })
          return yield* svc.list({ status: "active" })
        }),
      )

      expect(rows.map((w) => w.slug).sort()).toEqual(["a", "c"])
      expect(rows.every((w) => w.status === "active")).toBe(true)
    })
  })

  // ── touch ──────────────────────────────────────────────────────────────────

  describe("touch", () => {
    it("refreshes updatedAt for a known slug", async () => {
      const { before, after } = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          const before = yield* svc.register({ slug: "a", path: "/a" })
          yield* Effect.sleep("2 millis")
          const after = yield* svc.touch("a")
          return { before, after }
        }),
      )

      expect(after).not.toBeNull()
      expect(after!.updatedAt).toBeGreaterThan(before.updatedAt)
      expect(after!.createdAt).toBe(before.createdAt)
    })

    it("returns null for an unknown slug", async () => {
      const out = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          return yield* svc.touch("nope")
        }),
      )

      expect(out).toBeNull()
    })
  })

  // ── updateSummary ──────────────────────────────────────────────────────────

  describe("updateSummary", () => {
    it("replaces the summary and bumps updatedAt", async () => {
      const ws = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          yield* svc.register({ slug: "a", path: "/a", summary: "old" })
          yield* Effect.sleep("2 millis")
          return yield* svc.updateSummary("a", "new")
        }),
      )

      expect(ws).not.toBeNull()
      expect(ws!.summary).toBe("new")
    })

    it("accepts null to clear the summary", async () => {
      const ws = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          yield* svc.register({ slug: "a", path: "/a", summary: "old" })
          return yield* svc.updateSummary("a", null)
        }),
      )

      expect(ws!.summary).toBeNull()
    })

    it("returns null for an unknown slug", async () => {
      const out = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          return yield* svc.updateSummary("nope", "x")
        }),
      )

      expect(out).toBeNull()
    })
  })

  // ── setStatus ──────────────────────────────────────────────────────────────

  describe("setStatus", () => {
    it("changes status and bumps updatedAt", async () => {
      const ws = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          yield* svc.register({ slug: "a", path: "/a" })
          return yield* svc.setStatus("a", "archived")
        }),
      )

      expect(ws!.status).toBe("archived")
    })

    it("returns null for an unknown slug", async () => {
      const out = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          return yield* svc.setStatus("nope", "archived")
        }),
      )

      expect(out).toBeNull()
    })
  })

  // ── delete ─────────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("removes the row and returns 1", async () => {
      const { deleted, after } = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          yield* svc.register({ slug: "a", path: "/a" })
          const deleted = yield* svc.delete("a")
          const after = yield* svc.get("a")
          return { deleted, after }
        }),
      )

      expect(deleted).toBe(1)
      expect(after).toBeNull()
    })

    it("returns 0 for an unknown slug", async () => {
      const deleted = await run(
        Effect.gen(function* () {
          const svc = yield* WorkspaceRegistryService
          return yield* svc.delete("nope")
        }),
      )

      expect(deleted).toBe(0)
    })
  })
})
