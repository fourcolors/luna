/**
 * SessionStore SQLite restart-fidelity tests.
 *
 * Phase 2 invariant: a chat-server restart replays the FULL conversation
 * transcript in the UI — frame count in == frame count out.
 *
 * These tests simulate a restart by:
 *   1. Building a SQLite SessionStore, creating a session, appending N frames.
 *   2. Closing the layer (DB connection closed by Effect finalizer).
 *   3. Re-opening the SAME luna.db file with a FRESH SQLite SessionStore layer.
 *   4. Calling readMessages() and asserting frame count matches (N in → N out)
 *      and content is faithful.
 *
 * Uses bun:sqlite natively (Bun test runner only).
 * DO NOT run under vitest/node — bun:sqlite is not resolvable there.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { makeSessionStoreSqlite } from "./session-store-sqlite.js"
import { SessionStore, type SessionStoreApi } from "./session-store.js"

// ── Bootstrap stub ───────────────────────────────────────────────────────────
// The SQLite layer requires LunaSqliteBootstrap (the vectorlite marker).
// In tests we provide a no-op stub — no Vectorlite loaded here.
const BootstrapStub = Layer.succeed(LunaSqliteBootstrap, {
  ok: false as const,
  reason: "test stub — no Vectorlite",
})

const makeTestLayer = (dbPath: string) =>
  makeSessionStoreSqlite(dbPath).pipe(Layer.provide(BootstrapStub))

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeTmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-session-restart-"))
  return join(dir, "luna.db")
}

/** Append N frames to a session and return the written messages. */
const appendFrames = (
  store: SessionStoreApi,
  sessionId: string,
  n: number,
) =>
  Effect.gen(function* () {
    const written = []
    for (let i = 0; i < n; i++) {
      const kind = i % 2 === 0 ? ("user" as const) : ("assistant" as const)
      const msg = yield* store.appendMessage({
        sessionId,
        messageId: `msg_${i}`,
        ts: 1000 + i,
        parentId: null,
        kind,
        payload: {
          type: kind,
          message: { role: kind, content: `Turn ${i} content` },
        },
      })
      written.push(msg)
    }
    return written
  })

describe("SessionStore SQLite restart-fidelity", () => {
  test("frame count in == frame count out after simulated restart", async () => {
    const dbPath = makeTmp()
    const N = 8 // 4 user + 4 assistant turns

    // ── Session 1: write N frames ─────────────────────────────────────────
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* store.create({
            id: "restart_session_1",
            options: { model: "claude-sonnet", title: "Restart test" },
            createdAt: 1000,
          })
          yield* appendFrames(store, "restart_session_1", N)
        }).pipe(Effect.provide(makeTestLayer(dbPath))),
      ),
    )

    // ── Simulated restart: FRESH layer on the same DB ─────────────────────
    const { frameCount, firstId, lastId } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          const msgs = yield* Stream.runCollect(
            store.readMessages("restart_session_1"),
          )
          const arr = Array.from(msgs)
          return {
            frameCount: arr.length,
            firstId: arr[0]?.id ?? null,
            lastId: arr[arr.length - 1]?.id ?? null,
          }
        }).pipe(Effect.provide(makeTestLayer(dbPath))),
      ),
    )

    expect(frameCount).toBe(N) // frame count in == frame count out
    expect(firstId).toBe("msg_0")
    expect(lastId).toBe(`msg_${N - 1}`)
  })

  test("messages replay in seq order (monotonic, gap-free)", async () => {
    const dbPath = makeTmp()
    const N = 6

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* store.create({
            id: "restart_seq",
            options: { model: "claude-opus" },
            createdAt: 1000,
          })
          yield* appendFrames(store, "restart_seq", N)
        }).pipe(Effect.provide(makeTestLayer(dbPath))),
      ),
    )

    const seqs = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          const msgs = yield* Stream.runCollect(
            store.readMessages("restart_seq"),
          )
          return Array.from(msgs).map((m) => m.seq)
        }).pipe(Effect.provide(makeTestLayer(dbPath))),
      ),
    )

    expect(seqs).toEqual([0, 1, 2, 3, 4, 5])
  })

  test("payload content is faithful after restart (no corruption)", async () => {
    const dbPath = makeTmp()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* store.create({
            id: "restart_payload",
            options: { model: "claude-haiku" },
            createdAt: 1000,
          })
          yield* store.appendMessage({
            sessionId: "restart_payload",
            messageId: "payload_msg",
            ts: 2000,
            parentId: null,
            kind: "user",
            payload: {
              type: "user",
              message: { content: "Hello, world! 🌍 emoji + unicode: 日本語" },
            },
          })
        }).pipe(Effect.provide(makeTestLayer(dbPath))),
      ),
    )

    const payload = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          const msgs = yield* Stream.runCollect(
            store.readMessages("restart_payload"),
          )
          return Array.from(msgs)[0]?.payload
        }).pipe(Effect.provide(makeTestLayer(dbPath))),
      ),
    )

    expect(payload).toEqual({
      type: "user",
      message: { content: "Hello, world! 🌍 emoji + unicode: 日本語" },
    })
  })

  test("session metadata (status, options) survives restart", async () => {
    const dbPath = makeTmp()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* store.create({
            id: "restart_meta",
            options: { model: "claude-sonnet", title: "Meta test", tags: ["tag-a", "tag-b"] },
            createdAt: 5000,
          })
          yield* store.setStatus("restart_meta", "idle")
          yield* store.setOptions("restart_meta", { title: "Updated title" })
        }).pipe(Effect.provide(makeTestLayer(dbPath))),
      ),
    )

    const summary = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          return yield* store.get("restart_meta")
        }).pipe(Effect.provide(makeTestLayer(dbPath))),
      ),
    )

    expect(summary?.status).toBe("idle")
    expect(summary?.title).toBe("Meta test") // title is a SessionRow field, not options
    expect(summary?.tags).toEqual(["tag-a", "tag-b"])
    expect(summary?.createdAt).toBe(5000)
  })

  test("lastMessagePreview + lastMessageAt survive restart and reflect real text", async () => {
    const dbPath = makeTmp()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* store.create({
            id: "restart_preview",
            options: { model: "claude-sonnet" },
            createdAt: 1000,
          })
          yield* store.appendMessage({
            sessionId: "restart_preview",
            messageId: "preview_msg",
            ts: 9999,
            parentId: null,
            kind: "user",
            payload: {
              type: "user",
              message: { role: "user", content: "What is the meaning of life?" },
            },
          })
        }).pipe(Effect.provide(makeTestLayer(dbPath))),
      ),
    )

    const summary = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          return yield* store.get("restart_preview")
        }).pipe(Effect.provide(makeTestLayer(dbPath))),
      ),
    )

    expect(summary?.lastMessageAt).toBe(9999)
    expect(summary?.lastMessagePreview).toBeTruthy()
    expect(typeof summary?.lastMessagePreview).toBe("string")
  })

  test("migration is idempotent across restarts (no double-apply)", async () => {
    const dbPath = makeTmp()

    // Open 3 times — should never throw on the second or third migration pass
    for (let pass = 0; pass < 3; pass++) {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SessionStore
            if (pass === 0) {
              yield* store.create({
                id: "idem_session",
                options: { model: "m" },
                createdAt: pass,
              })
            }
            const got = yield* store.get("idem_session")
            if (pass > 0) expect(got?.id).toBe("idem_session")
          }).pipe(Effect.provide(makeTestLayer(dbPath))),
        ),
      )
    }
  })

  // ── Defect-vs-typed-failure invariant ────────────────────────────────────────
  // Audit finding #2: appendMessage SELECTs (sessionExists.get, messageNextSeq.get,
  // sessionGetMeta.get) were outside the try/catch, so SQLITE_BUSY / SQLITE_IOERR
  // from any of those reads would propagate as a raw JS throw through
  // Effect.suspend — which becomes a defect (die), not a typed failure.  A defect
  // escapes Effect.catch in adapter.ts's onMirrorError handler and can kill the
  // live streaming fiber.  After the fix the outer try/catch covers all reads.
  //
  // We exercise two concrete SQLite-level error paths:
  //   A. "session not found" — exists-check SELECT returns undefined → typed Fail.
  //   B. Duplicate messageId INSERT — UNIQUE constraint throw → typed Fail (not Die).
  //   C. Raw throw escaping Effect.suspend in appendMessage is caught as typed Fail
  //      by verifying Effect.Cause._tag === "Fail" (not "Die") in all cases.
  test("appendMessage DB errors surface as typed IntegrityError, not defects", async () => {
    // ── A. Session not found (exists-check SELECT returns undefined) ──────────
    const dbPath = makeTmp()
    const exitA = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          // No store.create() — session does not exist.
          return yield* Effect.exit(
            store.appendMessage({
              sessionId: "ghost_session_never_created",
              messageId: "x",
              ts: 1,
              parentId: null,
              kind: "user",
              payload: {},
            }),
          )
        }).pipe(Effect.provide(makeTestLayer(dbPath))),
      ),
    )

    // Must be Failure with cause._tag === "Fail" (typed), NOT "Die" (defect).
    expect(exitA._tag).toBe("Failure")
    if (exitA._tag === "Failure") {
      expect(exitA.cause._tag).toBe("Fail")
    }

    // ── B. Duplicate messageId INSERT → UNIQUE constraint violation ───────────
    // This exercises the inner catch (INSERT path) and confirms ROLLBACK
    // happens and the error is also a typed Fail, not a defect.
    const dbPath2 = makeTmp()
    const exitB = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* store.create({
            id: "dupe_session",
            options: { model: "m" },
            createdAt: 1,
          })
          // First append — succeeds.
          yield* store.appendMessage({
            sessionId: "dupe_session",
            messageId: "dup_msg",
            ts: 1,
            parentId: null,
            kind: "user",
            payload: {},
          })
          // Second append with SAME messageId — SQLite UNIQUE constraint on
          // messages.id throws inside the transaction.  Must be typed Fail.
          return yield* Effect.exit(
            store.appendMessage({
              sessionId: "dupe_session",
              messageId: "dup_msg",
              ts: 2,
              parentId: null,
              kind: "user",
              payload: {},
            }),
          )
        }).pipe(Effect.provide(makeTestLayer(dbPath2))),
      ),
    )

    expect(exitB._tag).toBe("Failure")
    if (exitB._tag === "Failure") {
      expect(exitB.cause._tag).toBe("Fail")
    }

    // ── C. After a ROLLBACK the session store is still usable ────────────────
    // A defect would have killed the fiber; a typed failure lets the caller
    // recover and retry.  Confirm the store accepts a new (non-duplicate)
    // message on the same session after the failed append.
    const recoverOk = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          // Re-open same DB from dbPath2 (simulates turn recovery).
          const msg = yield* store.appendMessage({
            sessionId: "dupe_session",
            messageId: "recovery_msg",
            ts: 3,
            parentId: null,
            kind: "assistant",
            payload: { type: "assistant", message: { role: "assistant", content: "recovered" } },
          })
          return msg.id
        }).pipe(Effect.provide(makeTestLayer(dbPath2))),
      ),
    )

    expect(recoverOk).toBe("recovery_msg")
  })

  // ── seq-under-lock invariant ──────────────────────────────────────────────────
  // Fix for Copilot review comment: messageNextSeq.get() was called BEFORE
  // BEGIN IMMEDIATE, so two concurrent fibers could both read the same MAX(seq)
  // before either held the write lock → duplicate seq numbers.
  //
  // After the fix: seq is computed INSIDE BEGIN IMMEDIATE … COMMIT, so the
  // read + INSERT are atomic and seq is always monotonic and gap-free regardless
  // of concurrency.
  //
  // This test fires N appends concurrently (Promise.all) and asserts that the
  // resulting seqs are exactly [0 … N-1] with no duplicates and no gaps.
  test("seq is monotonic and gap-free under concurrent appends (seq computed inside lock)", async () => {
    const dbPath = makeTmp()
    const N = 12

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* store.create({
            id: "concurrent_seq",
            options: { model: "claude-sonnet" },
            createdAt: 1000,
          })
        }).pipe(Effect.provide(makeTestLayer(dbPath))),
      ),
    )

    // Launch N concurrent appends to the same session using the same DB
    // layer instance (one connection → SQLite serializes via the write lock;
    // the race is between the seq read and the INSERT, not between threads).
    const seqs = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          // Fire all appends concurrently and collect results.
          const results = yield* Effect.all(
            Array.from({ length: N }, (_, i) =>
              store.appendMessage({
                sessionId: "concurrent_seq",
                messageId: `concurrent_msg_${i}`,
                ts: 1000 + i,
                parentId: null,
                kind: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
                payload: { index: i },
              }),
            ),
            { concurrency: "unbounded" },
          )
          return results.map((m) => m.seq).sort((a, b) => a - b)
        }).pipe(Effect.provide(makeTestLayer(dbPath))),
      ),
    )

    // Must be exactly [0, 1, 2, ..., N-1]: no duplicates, no gaps.
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i))
  })
})
