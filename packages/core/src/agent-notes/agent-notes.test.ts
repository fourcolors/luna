/**
 * AgentNotesService — Tier-1 tests (TDD red phase).
 *
 * All tests use `AgentNotesService.Memory` — no SQLite required.
 * The Memory layer is an in-memory `Ref<Map<string, AgentNote>>` backed
 * implementation that satisfies the full AgentNotesApi contract.
 *
 * Coverage:
 *   - record: auto-id, parentId, payload, kind roundtrip
 *   - getRecent: ordering (ts DESC), default limit, custom limit, unknown session
 *   - getChain: ordering (ts ASC), session isolation
 *   - getByKind: cross-session filter, ts DESC ordering, limit
 *   - getById: found, not found
 *   - deleteForSession: removes notes, returns count, returns 0 for unknown
 *   - context reconstruction: goal_declared + 3 progress → getChain = 4 in order
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { AgentNotesService } from "./agent-notes.js"

// ── Test runner helper ───────────────────────────────────────────────────────

/**
 * Provides AgentNotesService.Memory + Clock.Default so every test gets a
 * fresh, isolated in-memory store with a real wall-clock.
 */
const run = <A, E>(
  eff: Effect.Effect<A, E, AgentNotesService>,
): Promise<A> =>
  Effect.runPromise(
    eff.pipe(
      Effect.provide(
        AgentNotesService.Memory.pipe(Layer.provide(Clock.Default)),
      ),
    ),
  )

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the current epoch-ms via Clock.Default (real wall-clock). */
const nowMs = (): number => Date.now()

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AgentNotesService", () => {
  // ── record ─────────────────────────────────────────────────────────────────

  describe("record", () => {
    it("inserts a note and returns it with an auto-generated non-empty id", async () => {
      const note = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          return yield* svc.record({
            sessionId: "sess-1",
            kind: "goal_declared",
            summary: "bootstrap the system",
          })
        }),
      )

      expect(typeof note.id).toBe("string")
      expect(note.id.length).toBeGreaterThan(0)
      expect(note.sessionId).toBe("sess-1")
      expect(note.kind).toBe("goal_declared")
      expect(note.summary).toBe("bootstrap the system")
      expect(note.parentId).toBeNull()
      expect(note.payload).toBeNull()
      expect(note.ts).toBeGreaterThan(0)
    })

    it("preserves parentId when provided", async () => {
      const { parent, child } = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          const parent = yield* svc.record({
            sessionId: "sess-p",
            kind: "goal_declared",
            summary: "first note",
          })
          const child = yield* svc.record({
            sessionId: "sess-p",
            kind: "progress",
            summary: "following up",
            parentId: parent.id,
          })
          return { parent, child }
        }),
      )

      expect(child.parentId).toBe(parent.id)
    })

    it("stores payload as JSON and returns it parsed", async () => {
      const payload = { step: 1, details: ["a", "b"], nested: { ok: true } }

      const note = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          return yield* svc.record({
            sessionId: "sess-payload",
            kind: "decision",
            summary: "chose approach A",
            payload,
          })
        }),
      )

      expect(note.payload).toEqual(payload)
    })

    it("roundtrips kind: goal_declared correctly", async () => {
      const note = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          return yield* svc.record({
            sessionId: "sess-kind",
            kind: "goal_declared",
            summary: "want to finish phase 30",
          })
        }),
      )

      expect(note.kind).toBe("goal_declared")
    })

    it("accepts open-string kinds beyond the named set", async () => {
      const note = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          return yield* svc.record({
            sessionId: "sess-open",
            kind: "custom_kind_xyz",
            summary: "a future kind",
          })
        }),
      )

      expect(note.kind).toBe("custom_kind_xyz")
    })
  })

  // ── getRecent ───────────────────────────────────────────────────────────────

  describe("getRecent", () => {
    it("returns notes for a session ordered ts DESC", async () => {
      const notes = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          // Insert with tiny delays so ts values differ.
          // We control ordering by inserting 3 notes and expecting DESC.
          const a = yield* svc.record({ sessionId: "s-ord", kind: "progress", summary: "first" })
          const b = yield* svc.record({ sessionId: "s-ord", kind: "progress", summary: "second" })
          const c = yield* svc.record({ sessionId: "s-ord", kind: "progress", summary: "third" })
          // Verify insertion order produced non-decreasing ts values
          // (clock may return same ms if fast, but order of ids must be preserved).
          // Then getRecent returns most-recent first.
          const recent = yield* svc.getRecent("s-ord")
          return { a, b, c, recent }
        }),
      )

      // The result must be ordered ts DESC: if all ts equal, implementation
      // must still be stable (same order reversed). We assert that the
      // summary of the LAST inserted note is the FIRST returned.
      const summaries = notes.recent.map((n) => n.summary)
      // Verify all 3 notes are present
      expect(summaries).toHaveLength(3)
      // The note inserted LAST should appear FIRST (DESC)
      expect(summaries[0]).toBe("third")
      expect(summaries[summaries.length - 1]).toBe("first")
    })

    it("returns at most 20 notes by default when more than 20 exist", async () => {
      const recent = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          for (let i = 0; i < 25; i++) {
            yield* svc.record({
              sessionId: "s-limit-default",
              kind: "progress",
              summary: `note ${i}`,
            })
          }
          return yield* svc.getRecent("s-limit-default")
        }),
      )

      expect(recent.length).toBe(20)
    })

    it("respects a custom limit", async () => {
      const recent = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          for (let i = 0; i < 10; i++) {
            yield* svc.record({
              sessionId: "s-limit-custom",
              kind: "progress",
              summary: `note ${i}`,
            })
          }
          return yield* svc.getRecent("s-limit-custom", 5)
        }),
      )

      expect(recent.length).toBe(5)
    })

    it("returns empty array for unknown sessionId", async () => {
      const recent = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          return yield* svc.getRecent("session-that-does-not-exist")
        }),
      )

      expect(recent).toEqual([])
    })
  })

  // ── getChain ────────────────────────────────────────────────────────────────

  describe("getChain", () => {
    it("returns all notes for a session in ts ASC order", async () => {
      const chain = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          yield* svc.record({ sessionId: "s-chain", kind: "goal_declared", summary: "start" })
          yield* svc.record({ sessionId: "s-chain", kind: "progress", summary: "middle" })
          yield* svc.record({ sessionId: "s-chain", kind: "reflection", summary: "end" })
          return yield* svc.getChain("s-chain")
        }),
      )

      expect(chain).toHaveLength(3)
      // ASC: oldest first
      expect(chain[0].summary).toBe("start")
      expect(chain[1].summary).toBe("middle")
      expect(chain[2].summary).toBe("end")
    })

    it("returns only notes for the specified session, not notes from other sessions", async () => {
      const chain = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          yield* svc.record({ sessionId: "s-mine", kind: "progress", summary: "mine 1" })
          yield* svc.record({ sessionId: "s-other", kind: "progress", summary: "other 1" })
          yield* svc.record({ sessionId: "s-mine", kind: "progress", summary: "mine 2" })
          yield* svc.record({ sessionId: "s-other", kind: "progress", summary: "other 2" })
          return yield* svc.getChain("s-mine")
        }),
      )

      expect(chain).toHaveLength(2)
      expect(chain.every((n) => n.sessionId === "s-mine")).toBe(true)
      expect(chain.map((n) => n.summary)).toEqual(["mine 1", "mine 2"])
    })
  })

  // ── getByKind ───────────────────────────────────────────────────────────────

  describe("getByKind", () => {
    it("returns notes across sessions filtered by kind", async () => {
      const results = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          yield* svc.record({ sessionId: "sx-1", kind: "reflection", summary: "reflect A" })
          yield* svc.record({ sessionId: "sx-1", kind: "progress", summary: "progress A" })
          yield* svc.record({ sessionId: "sx-2", kind: "reflection", summary: "reflect B" })
          yield* svc.record({ sessionId: "sx-2", kind: "decision", summary: "decision B" })
          return yield* svc.getByKind("reflection")
        }),
      )

      expect(results).toHaveLength(2)
      expect(results.every((n) => n.kind === "reflection")).toBe(true)
    })

    it("orders results ts DESC (most recent first)", async () => {
      const results = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          yield* svc.record({ sessionId: "sk-ord", kind: "reflection", summary: "older" })
          yield* svc.record({ sessionId: "sk-ord", kind: "reflection", summary: "newer" })
          return yield* svc.getByKind("reflection")
        }),
      )

      expect(results).toHaveLength(2)
      // DESC: "newer" was inserted last → should appear first
      expect(results[0].summary).toBe("newer")
      expect(results[1].summary).toBe("older")
    })

    it("respects the limit when provided", async () => {
      const results = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          for (let i = 0; i < 8; i++) {
            yield* svc.record({
              sessionId: "sk-lim",
              kind: "reflection",
              summary: `reflection ${i}`,
            })
          }
          return yield* svc.getByKind("reflection", 3)
        }),
      )

      expect(results).toHaveLength(3)
    })

    it("returns empty array when no notes exist for the kind", async () => {
      const results = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          yield* svc.record({ sessionId: "sk-empty", kind: "progress", summary: "not a reflection" })
          return yield* svc.getByKind("reflection")
        }),
      )

      expect(results).toEqual([])
    })
  })

  // ── getById ─────────────────────────────────────────────────────────────────

  describe("getById", () => {
    it("returns the note when it exists", async () => {
      const { recorded, found } = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          const recorded = yield* svc.record({
            sessionId: "s-byid",
            kind: "obstacle",
            summary: "hit a wall",
          })
          const found = yield* svc.getById(recorded.id)
          return { recorded, found }
        }),
      )

      expect(found).not.toBeNull()
      expect(found!.id).toBe(recorded.id)
      expect(found!.summary).toBe("hit a wall")
      expect(found!.kind).toBe("obstacle")
    })

    it("returns null when id is not found", async () => {
      const result = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          return yield* svc.getById("id-that-does-not-exist")
        }),
      )

      expect(result).toBeNull()
    })
  })

  // ── deleteForSession ────────────────────────────────────────────────────────

  describe("deleteForSession", () => {
    it("removes all notes for a session and returns the deleted count", async () => {
      const { countDeleted, remaining } = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          yield* svc.record({ sessionId: "s-del", kind: "progress", summary: "a" })
          yield* svc.record({ sessionId: "s-del", kind: "progress", summary: "b" })
          yield* svc.record({ sessionId: "s-del", kind: "progress", summary: "c" })
          // Notes from another session must not be removed
          yield* svc.record({ sessionId: "s-keep", kind: "progress", summary: "keep me" })

          const countDeleted = yield* svc.deleteForSession("s-del")
          const remaining = yield* svc.getChain("s-del")
          return { countDeleted, remaining }
        }),
      )

      expect(countDeleted).toBe(3)
      expect(remaining).toEqual([])
    })

    it("does not remove notes from other sessions", async () => {
      const keptNotes = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          yield* svc.record({ sessionId: "s-gone", kind: "progress", summary: "delete me" })
          yield* svc.record({ sessionId: "s-safe", kind: "progress", summary: "keep me" })
          yield* svc.deleteForSession("s-gone")
          return yield* svc.getChain("s-safe")
        }),
      )

      expect(keptNotes).toHaveLength(1)
      expect(keptNotes[0].summary).toBe("keep me")
    })

    it("returns 0 for an unknown sessionId", async () => {
      const count = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          return yield* svc.deleteForSession("session-never-existed")
        }),
      )

      expect(count).toBe(0)
    })
  })

  // ── Context reconstruction ──────────────────────────────────────────────────

  describe("context reconstruction", () => {
    it(
      "records goal_declared then 3 progress notes; getChain returns all 4 in ts ASC order",
      async () => {
        const result = await run(
          Effect.gen(function* () {
            const svc = yield* AgentNotesService

            const goal = yield* svc.record({
              sessionId: "sess-ctx",
              kind: "goal_declared",
              summary: "implement AgentNotesService",
            })

            const p1 = yield* svc.record({
              sessionId: "sess-ctx",
              kind: "progress",
              summary: "schema designed",
              parentId: goal.id,
            })

            const p2 = yield* svc.record({
              sessionId: "sess-ctx",
              kind: "progress",
              summary: "Memory layer implemented",
              parentId: p1.id,
            })

            const p3 = yield* svc.record({
              sessionId: "sess-ctx",
              kind: "progress",
              summary: "tests written",
              parentId: p2.id,
            })

            const chain = yield* svc.getChain("sess-ctx")
            return { goal, p1, p2, p3, chain }
          }),
        )

        const { goal, p1, p2, chain } = result

        // 4 notes total in ASC order
        expect(chain).toHaveLength(4)

        // ASC: goal is first
        expect(chain[0].kind).toBe("goal_declared")
        expect(chain[0].id).toBe(goal.id)

        // Remaining 3 are progress notes
        const progressNotes = chain.slice(1)
        expect(progressNotes.every((n) => n.kind === "progress")).toBe(true)

        // parentId chain is reconstructable
        expect(chain[1].parentId).toBe(goal.id)
        expect(chain[2].parentId).toBe(p1.id)
        expect(chain[3].parentId).toBe(p2.id)

        // Verify ts is non-decreasing (ASC)
        const timestamps = chain.map((n) => n.ts)
        for (let i = 1; i < timestamps.length; i++) {
          expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1])
        }
      },
    )
  })
})
