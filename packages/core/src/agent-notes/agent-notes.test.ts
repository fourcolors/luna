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
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import type { BunDb } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { AgentNotesService } from "./agent-notes.js"
import { isUnparsedPayload } from "./types.js"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const dSqlite = isBun ? describe : describe.skip

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

    // ── Part D: optional caller-supplied id (feedback-screenshot flow) ─────
    it("persists with the exact caller-supplied id when `id` is provided", async () => {
      const { note, found } = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          const note = yield* svc.record({
            id: "custom-fixed-id",
            sessionId: "sess-custom-id",
            kind: "ui_feedback",
            summary: "feedback note",
          })
          const found = yield* svc.getById("custom-fixed-id")
          return { note, found }
        }),
      )
      expect(note.id).toBe("custom-fixed-id")
      expect(found).not.toBeNull()
      expect(found!.id).toBe("custom-fixed-id")
    })

    it("still auto-generates a UUID when `id` is omitted (regression — 20+ existing callers)", async () => {
      const note = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          return yield* svc.record({
            sessionId: "sess-auto-id",
            kind: "progress",
            summary: "no explicit id",
          })
        }),
      )
      expect(typeof note.id).toBe("string")
      expect(note.id.length).toBeGreaterThan(0)
      expect(note.id).not.toBe("custom-fixed-id")
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

  // ── getRecentAcrossSessions ─────────────────────────────────────────────────

  describe("getRecentAcrossSessions", () => {
    it("returns notes from ALL sessions ordered ts DESC (the empty-filter recovery path)", async () => {
      const results = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          yield* svc.record({ sessionId: "ras-1", kind: "reflection", summary: "first" })
          yield* svc.record({ sessionId: "ras-2", kind: "progress",   summary: "second" })
          yield* svc.record({ sessionId: "ras-3", kind: "decision",   summary: "third" })
          return yield* svc.getRecentAcrossSessions()
        }),
      )

      expect(results).toHaveLength(3)
      // DESC by insertion order (ts ties resolve to insertion-DESC).
      expect(results[0].summary).toBe("third")
      expect(results[1].summary).toBe("second")
      expect(results[2].summary).toBe("first")
    })

    it("respects the limit when provided", async () => {
      const results = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          for (let i = 0; i < 30; i++) {
            yield* svc.record({
              sessionId: `ras-lim-${i % 4}`,
              kind: "progress",
              summary: `n-${i}`,
            })
          }
          return yield* svc.getRecentAcrossSessions(5)
        }),
      )

      expect(results).toHaveLength(5)
    })

    it("defaults to a limit of 20", async () => {
      const results = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          for (let i = 0; i < 50; i++) {
            yield* svc.record({
              sessionId: "ras-default",
              kind: "progress",
              summary: `n-${i}`,
            })
          }
          return yield* svc.getRecentAcrossSessions()
        }),
      )

      expect(results).toHaveLength(20)
    })

    it("returns an empty array when no notes exist", async () => {
      const results = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          return yield* svc.getRecentAcrossSessions()
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

// ── SQLite layer: same optional-id contract (Part D), skipped outside bun ────

const bootstrapStubL = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "agent-notes test — bootstrap stub",
} as const)

const SqliteTestLayer = AgentNotesService.makeLayer(":memory:").pipe(
  Layer.provide(Clock.Default),
  Layer.provide(bootstrapStubL),
)

const runSqlite = <A, E>(
  eff: Effect.Effect<A, E, AgentNotesService>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(SqliteTestLayer)))

dSqlite("AgentNotesService (SQLite layer) — record id", () => {
  it("persists with the exact caller-supplied id when `id` is provided", async () => {
    const { note, found } = await runSqlite(
      Effect.gen(function* () {
        const svc = yield* AgentNotesService
        const note = yield* svc.record({
          id: "sqlite-custom-id",
          sessionId: "sess-sqlite-custom",
          kind: "ui_feedback",
          summary: "feedback note",
        })
        const found = yield* svc.getById("sqlite-custom-id")
        return { note, found }
      }),
    )
    expect(note.id).toBe("sqlite-custom-id")
    expect(found).not.toBeNull()
    expect(found!.id).toBe("sqlite-custom-id")
  })

  it("still auto-generates a UUID when `id` is omitted (regression)", async () => {
    const note = await runSqlite(
      Effect.gen(function* () {
        const svc = yield* AgentNotesService
        return yield* svc.record({
          sessionId: "sess-sqlite-auto",
          kind: "progress",
          summary: "no explicit id",
        })
      }),
    )
    expect(typeof note.id).toBe("string")
    expect(note.id.length).toBeGreaterThan(0)
    expect(note.id).not.toBe("sqlite-custom-id")
  })
})

// ── Unparseable payload_json: one bad row must not poison every read ─────────
//
// Regression for the outage where a single row whose payload_json held raw
// markdown (written out-of-band, bypassing record()'s JSON.stringify) made
// EVERY read path fail with NoteError — blacking out obs_notes_recent()
// entirely even though 4000+ healthy notes were sitting right there.
//
// These must run on the SQLite layer: AgentNotesService.Memory stores the live
// object and never JSON round-trips, so it structurally cannot exercise this
// path — which is exactly why the bug class survived.

/** A REAL on-disk db: the corrupt row is written by a SECOND connection, so it
 *  cannot go through the service's own JSON.stringify path. ":memory:" would
 *  give the two connections separate databases. */
const corruptDbPath = join(
  tmpdir(),
  `agent-notes-corrupt-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
)

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(corruptDbPath + suffix)
    } catch {
      /* best-effort cleanup */
    }
  }
})

const CorruptDbLayer = AgentNotesService.makeLayer(corruptDbPath).pipe(
  Layer.provide(Clock.Default),
  Layer.provide(bootstrapStubL),
)

const runCorruptDb = <A, E>(
  eff: Effect.Effect<A, E, AgentNotesService>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(CorruptDbLayer)))

/** Shaped after the real rows found in luna.db: a markdown heading, which
 *  `JSON.parse` rejects with "Unrecognized token '#'". */
const CORRUPT_PAYLOAD_TEXT =
  "# Luna Maintainer Sweep — 2026-07-29\n\n## Reviewed\n- repo healthy"

/** Longer than the envelope's raw cap, so it must come back truncated. */
const HUGE_CORRUPT_PAYLOAD_TEXT = `# ${"sweep ".repeat(2000)}`

/** Write a row through a raw second connection, bypassing record(). DYNAMIC
 *  import (not a static one) so vitest can still LOAD this file — mirrors
 *  ui-feedback-status-store.test.ts. */
const insertRawRow = async (args: {
  id: string
  sessionId: string
  kind: string
  summary: string
  payloadJson: string | null
  ts: number
}): Promise<void> => {
  const mod = await import("bun:sqlite" as string)
  const Database = (mod as { Database?: new (p: string) => BunDb }).Database
  if (!Database) throw new Error("bun:sqlite has no `Database` export")
  const raw = new Database(corruptDbPath)
  try {
    raw
      .query(
        `INSERT INTO agent_notes
           (id, session_id, parent_id, kind, summary, payload_json, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.id,
        args.sessionId,
        null,
        args.kind,
        args.summary,
        args.payloadJson,
        args.ts,
      )
  } finally {
    raw.close()
  }
}

dSqlite("AgentNotesService (SQLite layer) — unparseable payload_json", () => {
  beforeAll(async () => {
    // A healthy note first: building the layer is what runs the migration, so
    // this must precede any raw INSERT (which would otherwise hit "no such
    // table"). It doubles as the "valid payload still round-trips" fixture.
    const healthy = await runCorruptDb(
      Effect.gen(function* () {
        const svc = yield* AgentNotesService
        yield* svc.record({
          id: "note-null-payload",
          sessionId: "sess-corrupt",
          kind: "reflection",
          summary: "no payload at all",
        })
        return yield* svc.record({
          id: "note-healthy",
          sessionId: "sess-corrupt",
          kind: "reflection",
          summary: "healthy note",
          payload: { ok: true, nested: { n: 1 } },
        })
      }),
    )

    // Corrupt siblings land directly on disk, same table, newer ts.
    await insertRawRow({
      id: "note-corrupt",
      sessionId: "sess-corrupt",
      kind: "reflection",
      summary: "maintainer sweep",
      payloadJson: CORRUPT_PAYLOAD_TEXT,
      ts: healthy.ts + 1,
    })
    await insertRawRow({
      id: "note-corrupt-huge",
      sessionId: "sess-huge",
      kind: "maintainer_sweep",
      summary: "oversized sweep",
      payloadJson: HUGE_CORRUPT_PAYLOAD_TEXT,
      ts: healthy.ts + 2,
    })
  })

  it("returns the row from every read path instead of failing with NoteError", async () => {
    const { across, recent, byKind, chain, byId } = await runCorruptDb(
      Effect.gen(function* () {
        const svc = yield* AgentNotesService
        return {
          across: yield* svc.getRecentAcrossSessions(),
          recent: yield* svc.getRecent("sess-corrupt"),
          byKind: yield* svc.getByKind("reflection"),
          chain: yield* svc.getChain("sess-corrupt"),
          byId: yield* svc.getById("note-corrupt"),
        }
      }),
    )

    // Every list read succeeds AND still contains the healthy notes.
    for (const rows of [across, recent, byKind, chain]) {
      const ids = rows.map((n) => n.id)
      expect(ids).toContain("note-corrupt")
      expect(ids).toContain("note-healthy")
    }

    // The corrupt row keeps every column that did parse; only `payload`
    // degrades — and it degrades to a self-describing, LOSSLESS envelope.
    expect(byId).not.toBeNull()
    expect(byId!.sessionId).toBe("sess-corrupt")
    expect(byId!.kind).toBe("reflection")
    expect(byId!.summary).toBe("maintainer sweep")
    expect(isUnparsedPayload(byId!.payload)).toBe(true)
    const envelope = byId!.payload as {
      __unparsed: true
      raw: string
      error: string
      truncated?: true
    }
    expect(envelope.__unparsed).toBe(true)
    expect(envelope.raw).toBe(CORRUPT_PAYLOAD_TEXT) // no data loss
    expect(envelope.error).toMatch(/JSON|Unexpected|Unrecognized/i)
    expect(envelope.truncated).toBeUndefined()
  })

  it("leaves a VALID payload untouched and a NULL payload null (no regression)", async () => {
    const { healthy, nullPayload } = await runCorruptDb(
      Effect.gen(function* () {
        const svc = yield* AgentNotesService
        return {
          healthy: yield* svc.getById("note-healthy"),
          nullPayload: yield* svc.getById("note-null-payload"),
        }
      }),
    )

    // A valid payload round-trips byte-for-byte — the fallback never fires.
    expect(healthy!.payload).toEqual({ ok: true, nested: { n: 1 } })
    expect(isUnparsedPayload(healthy!.payload)).toBe(false)

    // A genuinely NULL payload_json stays null, so it remains distinguishable
    // from a corrupt one (this is why `null` is the wrong fallback shape).
    expect(nullPayload!.payload).toBeNull()
  })

  it("caps the preserved raw text and flags it as truncated", async () => {
    const note = await runCorruptDb(
      Effect.gen(function* () {
        const svc = yield* AgentNotesService
        return yield* svc.getById("note-corrupt-huge")
      }),
    )

    expect(isUnparsedPayload(note!.payload)).toBe(true)
    const envelope = note!.payload as {
      raw: string
      truncated?: true
    }
    expect(envelope.truncated).toBe(true)
    expect(envelope.raw.length).toBe(4096)
    expect(HUGE_CORRUPT_PAYLOAD_TEXT.startsWith(envelope.raw)).toBe(true)
  })

  it("does not let one corrupt row hide healthy notes from other sessions", async () => {
    const results = await runCorruptDb(
      Effect.gen(function* () {
        const svc = yield* AgentNotesService
        yield* svc.record({
          sessionId: "sess-other",
          kind: "progress",
          summary: "unrelated healthy note",
        })
        return yield* svc.getRecentAcrossSessions()
      }),
    )

    const summaries = results.map((n) => n.summary)
    expect(summaries).toContain("unrelated healthy note")
    expect(summaries).toContain("maintainer sweep")
    expect(summaries).toContain("healthy note")
  })

  it("fails a non-serializable payload as a typed NoteError, not a defect", async () => {
    // JSON.stringify used to run outside record()'s try/catch, so a circular
    // payload escaped the declared NoteError channel as an unhandled defect.
    const result = await runCorruptDb(
      Effect.gen(function* () {
        const svc = yield* AgentNotesService
        const circular: Record<string, unknown> = { a: 1 }
        circular["self"] = circular
        return yield* Effect.result(
          svc.record({
            sessionId: "sess-circular",
            kind: "progress",
            summary: "circular payload",
            payload: circular,
          }),
        )
      }),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("NoteError")
      expect(result.failure.op).toBe("record")
    }
  })
})
