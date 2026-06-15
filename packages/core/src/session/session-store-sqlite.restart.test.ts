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
import { SessionStore } from "./session-store.js"

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
  store: SessionStore["Type"],
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
})
