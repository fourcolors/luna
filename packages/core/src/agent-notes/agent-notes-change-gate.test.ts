/**
 * AgentNotesService.recordIfChanged — unit tests.
 *
 * All tests use `AgentNotesService.Memory` — no SQLite required.
 * Time is controlled via Clock.Test or a mutable clock so wall-clock drift
 * cannot interfere.
 *
 * Coverage:
 *   - identical content within the window is suppressed
 *   - changed content within the window records
 *   - identical content AFTER the heartbeat elapses records (anti-silence)
 *   - explicit fingerprint overrides content hashing (payload noise ignored)
 *   - fingerprint comparison works against a pre-existing note with NO _gate
 *   - heartbeatMs: 0 always records
 *   - non-serializable payload yields NoteError (SQLite layer)
 *   - first-ever note of a kind always records
 */
import { afterAll, describe, expect, it } from "vitest"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { AgentNotesService } from "./agent-notes.js"
import { DEFAULT_HEARTBEAT_MS } from "./types.js"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const dSqlite = isBun ? describe : describe.skip

// ── Fixed-clock test runner ──────────────────────────────────────────────────

/**
 * Build a runner with a fixed timestamp. All clock.nowMs() calls return
 * the same value. Use this when time advancement is not needed.
 */
const makeRunner = (fixedMs: number) => {
  const layer = AgentNotesService.Memory.pipe(
    Layer.provide(Clock.Test(fixedMs)),
  )
  return <A, E>(eff: Effect.Effect<A, E, AgentNotesService>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)))
}

/**
 * Build a test layer with a Ref-based clock that can be advanced between
 * steps within a SINGLE Effect chain. The layer is evaluated once and the
 * store + clock are shared for the lifetime of that chain.
 *
 * Usage:
 *   const { layer, setTime } = makeMutableClockLayer(BASE_TS)
 *   const run = <A, E>(eff) => Effect.runPromise(eff.pipe(Effect.provide(layer)))
 *   // All steps must be inside one run() call:
 *   await run(Effect.gen(function*() {
 *     const svc = yield* AgentNotesService
 *     yield* setTime(BASE_TS + 1000)
 *     ...
 *   }))
 */
const makeMutableClockLayer = (initialMs: number) => {
  const timeRef = Ref.makeUnsafe(initialMs)
  const setTime = (ms: number) => Ref.set(timeRef, ms)
  const layer = AgentNotesService.Memory.pipe(
    Layer.provide(
      Layer.succeed(
        Clock,
        Clock.of({
          nowMs: () => Ref.get(timeRef),
          nowIso: () => Ref.get(timeRef).pipe(
            Effect.map((ms) => new Date(ms).toISOString()),
          ),
        }),
      ),
    ),
  )
  return { layer, setTime }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AgentNotesService.recordIfChanged", () => {
  // ── First-ever note ─────────────────────────────────────────────────────────

  describe("first-ever note of a kind", () => {
    it("always records when no previous note exists for the kind", async () => {
      const run = makeRunner(1_000_000)
      const result = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          return yield* svc.recordIfChanged({
            sessionId: "sess-first",
            kind: "sentinel_kind_first",
            summary: "initial escalation",
          })
        }),
      )

      expect(result.suppressed).toBe(false)
      if (!result.suppressed) {
        expect(result.note.summary).toBe("initial escalation")
        expect(result.note.kind).toBe("sentinel_kind_first")
      }
    })
  })

  // ── Suppression within the window ───────────────────────────────────────────

  describe("identical content within the heartbeat window", () => {
    it("suppresses the second write and returns lastTs/lastId", async () => {
      const BASE_TS = 1_000_000
      const run = makeRunner(BASE_TS)

      const { firstResult, secondResult } = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          const firstResult = yield* svc.recordIfChanged({
            sessionId: "sess-sup",
            kind: "sentinel_kind_sup",
            summary: "Escalating to the Chairman.",
            payload: { status: "critical" },
          })
          const secondResult = yield* svc.recordIfChanged({
            sessionId: "sess-sup",
            kind: "sentinel_kind_sup",
            summary: "Escalating to the Chairman.",
            payload: { status: "critical" },
          })
          return { firstResult, secondResult }
        }),
      )

      expect(firstResult.suppressed).toBe(false)
      expect(secondResult.suppressed).toBe(true)

      if (secondResult.suppressed) {
        expect(secondResult.lastTs).toBe(BASE_TS)
        if (!firstResult.suppressed) {
          expect(secondResult.lastId).toBe(firstResult.note.id)
        }
      }
    })

    it("suppresses even with a different sessionId (kind is the scope, not session)", async () => {
      const run = makeRunner(2_000_000)

      const { first, second } = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          const first = yield* svc.recordIfChanged({
            sessionId: "sess-A",
            kind: "cross_session_kind",
            summary: "same text",
          })
          const second = yield* svc.recordIfChanged({
            sessionId: "sess-B",
            kind: "cross_session_kind",
            summary: "same text",
          })
          return { first, second }
        }),
      )

      expect(first.suppressed).toBe(false)
      expect(second.suppressed).toBe(true)
    })
  })

  // ── Changed content ─────────────────────────────────────────────────────────

  describe("changed content within the heartbeat window", () => {
    it("records when the summary changes", async () => {
      const run = makeRunner(3_000_000)

      const { first, second } = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          const first = yield* svc.recordIfChanged({
            sessionId: "sess-chg-sum",
            kind: "sentinel_kind_chg_sum",
            summary: "version A",
          })
          const second = yield* svc.recordIfChanged({
            sessionId: "sess-chg-sum",
            kind: "sentinel_kind_chg_sum",
            summary: "version B",
          })
          return { first, second }
        }),
      )

      expect(first.suppressed).toBe(false)
      expect(second.suppressed).toBe(false)
      if (!second.suppressed) {
        expect(second.note.summary).toBe("version B")
      }
    })

    it("records when the payload changes", async () => {
      const run = makeRunner(4_000_000)

      const { first, second } = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          const first = yield* svc.recordIfChanged({
            sessionId: "sess-chg-pay",
            kind: "sentinel_kind_chg_pay",
            summary: "same summary",
            payload: { count: 1 },
          })
          const second = yield* svc.recordIfChanged({
            sessionId: "sess-chg-pay",
            kind: "sentinel_kind_chg_pay",
            summary: "same summary",
            payload: { count: 2 },
          })
          return { first, second }
        }),
      )

      expect(first.suppressed).toBe(false)
      expect(second.suppressed).toBe(false)
    })
  })

  // ── Heartbeat: identical content AFTER the window elapses ───────────────────

  describe("heartbeat: identical content after the interval elapses", () => {
    it("records when the heartbeat has elapsed even with identical content (anti-silence)", async () => {
      const BASE_TS = 10_000_000
      const HEARTBEAT = 60_000 // 60 seconds for the test

      // All three steps happen inside ONE Effect chain so they share the same
      // store and clock Ref. setTime is an Effect, called with yield*.
      const { layer, setTime } = makeMutableClockLayer(BASE_TS)

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService

          // Step 1: initial write at BASE_TS
          const first = yield* svc.recordIfChanged(
            {
              sessionId: "sess-hb",
              kind: "sentinel_kind_hb",
              summary: "Standing condition active.",
            },
            { heartbeatMs: HEARTBEAT },
          )

          // Step 2: advance to just before the heartbeat boundary — must suppress
          yield* setTime(BASE_TS + HEARTBEAT - 1)
          const withinWindow = yield* svc.recordIfChanged(
            {
              sessionId: "sess-hb",
              kind: "sentinel_kind_hb",
              summary: "Standing condition active.",
            },
            { heartbeatMs: HEARTBEAT },
          )

          // Step 3: advance to exactly the heartbeat boundary — must record
          yield* setTime(BASE_TS + HEARTBEAT)
          const afterHeartbeat = yield* svc.recordIfChanged(
            {
              sessionId: "sess-hb",
              kind: "sentinel_kind_hb",
              summary: "Standing condition active.",
            },
            { heartbeatMs: HEARTBEAT },
          )

          return { first, withinWindow, afterHeartbeat }
        }).pipe(Effect.provide(layer)),
      )

      expect(result.first.suppressed).toBe(false)
      expect(result.withinWindow.suppressed).toBe(true)
      expect(result.afterHeartbeat.suppressed).toBe(false)
      if (!result.afterHeartbeat.suppressed) {
        expect(result.afterHeartbeat.note.summary).toBe("Standing condition active.")
      }
    })
  })

  // ── Explicit fingerprint ────────────────────────────────────────────────────

  describe("explicit fingerprint overrides content hashing", () => {
    it("suppresses when the explicit fingerprint is stable, even if payload contains a changing timestamp", async () => {
      const BASE_TS = 20_000_000
      const run = makeRunner(BASE_TS)

      const { first, second, third } = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          // First write: stable fingerprint key, noisy timestamp in payload
          const first = yield* svc.recordIfChanged(
            {
              sessionId: "sess-fp",
              kind: "sentinel_kind_fp",
              summary: "Escalating to the Chairman.",
              payload: { lastCheckedAt: 1000, status: "critical" },
            },
            { fingerprint: "escalation:chairman:critical" },
          )
          // Second write: same fingerprint key, different payload timestamp
          const second = yield* svc.recordIfChanged(
            {
              sessionId: "sess-fp",
              kind: "sentinel_kind_fp",
              summary: "Escalating to the Chairman.",
              payload: { lastCheckedAt: 2000, status: "critical" },
            },
            { fingerprint: "escalation:chairman:critical" },
          )
          // Third write: different fingerprint key -> records
          const third = yield* svc.recordIfChanged(
            {
              sessionId: "sess-fp",
              kind: "sentinel_kind_fp",
              summary: "Escalating to the Chairman.",
              payload: { lastCheckedAt: 3000, status: "critical" },
            },
            { fingerprint: "escalation:chairman:resolved" },
          )
          return { first, second, third }
        }),
      )

      expect(first.suppressed).toBe(false)
      expect(second.suppressed).toBe(true)
      expect(third.suppressed).toBe(false)
    })
  })

  // ── Pre-existing note without _gate ─────────────────────────────────────────

  describe("fingerprint comparison against a pre-existing note without _gate", () => {
    it("suppresses when the computed content hash matches a note written without _gate metadata", async () => {
      const BASE_TS = 30_000_000
      const run = makeRunner(BASE_TS)

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          // Write an ordinary note (no _gate key) via plain record()
          yield* svc.record({
            sessionId: "sess-no-gate",
            kind: "sentinel_kind_no_gate",
            summary: "pre-existing note",
            payload: { x: 1 },
          })
          // Now call recordIfChanged with the same content — it must suppress
          return yield* svc.recordIfChanged({
            sessionId: "sess-no-gate",
            kind: "sentinel_kind_no_gate",
            summary: "pre-existing note",
            payload: { x: 1 },
          })
        }),
      )

      expect(result.suppressed).toBe(true)
    })

    it("records when content differs from a note written without _gate metadata", async () => {
      const run = makeRunner(31_000_000)

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          // Write an ordinary note via plain record()
          yield* svc.record({
            sessionId: "sess-no-gate-2",
            kind: "sentinel_kind_no_gate_2",
            summary: "original content",
            payload: { v: 1 },
          })
          // Call recordIfChanged with DIFFERENT content — must record
          return yield* svc.recordIfChanged({
            sessionId: "sess-no-gate-2",
            kind: "sentinel_kind_no_gate_2",
            summary: "updated content",
            payload: { v: 1 },
          })
        }),
      )

      expect(result.suppressed).toBe(false)
    })
  })

  // ── heartbeatMs: 0 (always record) ─────────────────────────────────────────

  describe("heartbeatMs: 0 disables suppression", () => {
    it("records every call regardless of identical content", async () => {
      const run = makeRunner(40_000_000)

      const { first, second, third } = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          const first = yield* svc.recordIfChanged(
            {
              sessionId: "sess-hb0",
              kind: "sentinel_kind_hb0",
              summary: "same text",
            },
            { heartbeatMs: 0 },
          )
          const second = yield* svc.recordIfChanged(
            {
              sessionId: "sess-hb0",
              kind: "sentinel_kind_hb0",
              summary: "same text",
            },
            { heartbeatMs: 0 },
          )
          const third = yield* svc.recordIfChanged(
            {
              sessionId: "sess-hb0",
              kind: "sentinel_kind_hb0",
              summary: "same text",
            },
            { heartbeatMs: 0 },
          )
          return { first, second, third }
        }),
      )

      expect(first.suppressed).toBe(false)
      expect(second.suppressed).toBe(false)
      expect(third.suppressed).toBe(false)
    })
  })

  // ── Negative heartbeatMs ────────────────────────────────────────────────────

  describe("negative heartbeatMs", () => {
    it("returns NoteError for a negative heartbeatMs value", async () => {
      const run = makeRunner(50_000_000)

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          return yield* Effect.result(
            svc.recordIfChanged(
              {
                sessionId: "sess-neg",
                kind: "sentinel_kind_neg",
                summary: "should fail",
              },
              { heartbeatMs: -1 },
            ),
          )
        }),
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("NoteError")
        expect(result.failure.op).toBe("record")
      }
    })
  })

  // ── _gate metadata in written notes ────────────────────────────────────────

  describe("_gate metadata stored in written notes", () => {
    it("injects _gate.fp into the note payload", async () => {
      const run = makeRunner(60_000_000)

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          return yield* svc.recordIfChanged({
            sessionId: "sess-gate-meta",
            kind: "sentinel_kind_gate_meta",
            summary: "check gate metadata",
            payload: { data: "value" },
          })
        }),
      )

      expect(result.suppressed).toBe(false)
      if (!result.suppressed) {
        const payload = result.note.payload as Record<string, unknown>
        expect(typeof payload["_gate"]).toBe("object")
        const gate = payload["_gate"] as Record<string, unknown>
        expect(typeof gate["fp"]).toBe("string")
        expect((gate["fp"] as string).length).toBeGreaterThan(0)
      }
    })

    it("preserves caller-supplied payload fields alongside _gate", async () => {
      const run = makeRunner(61_000_000)

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          return yield* svc.recordIfChanged({
            sessionId: "sess-gate-preserve",
            kind: "sentinel_kind_gate_preserve",
            summary: "preserve fields",
            payload: { important: "data", count: 42 },
          })
        }),
      )

      expect(result.suppressed).toBe(false)
      if (!result.suppressed) {
        const payload = result.note.payload as Record<string, unknown>
        expect(payload["important"]).toBe("data")
        expect(payload["count"]).toBe(42)
        expect(payload["_gate"]).toBeDefined()
      }
    })

    it("creates { _gate } payload when input payload is undefined", async () => {
      const run = makeRunner(62_000_000)

      const result = await run(
        Effect.gen(function* () {
          const svc = yield* AgentNotesService
          return yield* svc.recordIfChanged({
            sessionId: "sess-gate-null",
            kind: "sentinel_kind_gate_null",
            summary: "no payload",
          })
        }),
      )

      expect(result.suppressed).toBe(false)
      if (!result.suppressed) {
        const payload = result.note.payload as Record<string, unknown>
        expect(payload["_gate"]).toBeDefined()
      }
    })
  })

  // ── DEFAULT_HEARTBEAT_MS export ─────────────────────────────────────────────

  describe("DEFAULT_HEARTBEAT_MS constant", () => {
    it("is 6 hours in milliseconds", () => {
      expect(DEFAULT_HEARTBEAT_MS).toBe(6 * 60 * 60 * 1000)
    })
  })
})

// ── SQLite layer: non-serializable payload still yields NoteError ─────────────
//
// The Memory layer never JSON round-trips (it stores live objects), so this
// test must run against the SQLite layer which goes through JSON.stringify.

const bootstrapStubL = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "agent-notes change-gate test — bootstrap stub",
} as const)

const gateTestDbPath = join(
  tmpdir(),
  `agent-notes-gate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
)

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(gateTestDbPath + suffix)
    } catch {
      /* best-effort cleanup */
    }
  }
})

const GateSqliteLayer = AgentNotesService.makeLayer(gateTestDbPath).pipe(
  Layer.provide(Clock.Default),
  Layer.provide(bootstrapStubL),
)

const runSqlite = <A, E>(
  eff: Effect.Effect<A, E, AgentNotesService>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(GateSqliteLayer)))

dSqlite("AgentNotesService.recordIfChanged (SQLite layer)", () => {
  it("non-serializable payload yields NoteError, not a defect", async () => {
    const result = await runSqlite(
      Effect.gen(function* () {
        const svc = yield* AgentNotesService
        const circular: Record<string, unknown> = { a: 1 }
        circular["self"] = circular
        return yield* Effect.result(
          svc.recordIfChanged({
            sessionId: "sess-circ",
            kind: "sentinel_kind_circ",
            summary: "circular payload",
            payload: circular,
          }),
        )
      }),
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("NoteError")
      expect(result.failure.op).toBe("record")
    }
  })

  it("writes and suppresses correctly through the SQLite round-trip", async () => {
    const first = await runSqlite(
      Effect.gen(function* () {
        const svc = yield* AgentNotesService
        return yield* svc.recordIfChanged({
          sessionId: "sess-sqlite-gate",
          kind: "sentinel_kind_sqlite_gate",
          summary: "sqlite gate test",
          payload: { val: 1 },
        })
      }),
    )
    expect(first.suppressed).toBe(false)

    const second = await runSqlite(
      Effect.gen(function* () {
        const svc = yield* AgentNotesService
        return yield* svc.recordIfChanged({
          sessionId: "sess-sqlite-gate",
          kind: "sentinel_kind_sqlite_gate",
          summary: "sqlite gate test",
          payload: { val: 1 },
        })
      }),
    )
    // Same SQLite layer shares state across runSqlite calls (same DB file).
    expect(second.suppressed).toBe(true)
  })
})
