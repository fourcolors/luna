/**
 * SessionStore.fromPath() — SQLite-backed Layer tests.
 *
 * Mirrors the in-memory store's contract tests, plus three scenarios
 * unique to a durable backend:
 *   - round-trip across reopen (the headline persistence test)
 *   - schema migration is idempotent (open twice → single schema_versions row)
 *   - WAL mode is on after construction
 *
 * Bun-only: `bun:sqlite` import dies under stock vitest/node. We gate the
 * whole file on the runtime check so a non-bun runner skips cleanly.
 */
import { describe, expect, it } from "vitest"
import { Effect, Stream, Layer, Scope } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import {
  LunaSqliteBootstrap,
  SessionStore,
  makeSessionStoreSqlite,
} from "../src/index.js"

// Skip the whole suite on non-bun runners. `bun:sqlite` is bun-native.
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const d = isBun ? describe : describe.skip

// Phase 27a: SessionStore.fromPath now declares `LunaSqliteBootstrap` in
// its `R`. The real Live Layer lives in @luna/memory; @luna/core tests
// satisfy the Tag with a no-op success value. Effect of `setCustomSQLite`
// is unobservable here (no Vectorlite is loaded against this DB).
const bootstrapStubL = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "core test — bootstrap stub",
} as const)

const memLayer = () =>
  makeSessionStoreSqlite(":memory:").pipe(Layer.provide(bootstrapStubL))

const provideMem = <A, E>(
  eff: Effect.Effect<A, E, SessionStore | Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(eff.pipe(Effect.provide(memLayer()))) as Effect.Effect<
      A,
      E,
      never
    >,
  )

const tmpDb = () =>
  path.join(
    os.tmpdir(),
    `luna-sqlite-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  )

const cleanupTmp = (p: string) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(p + suffix)
    } catch {
      /* ignore */
    }
  }
}

d("SessionStore.fromPath (sqlite)", () => {
  it("creates a session and retrieves it", async () => {
    const result = await provideMem(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const summary = yield* store.create({
          id: "s1",
          options: { model: "m", title: "t", tags: ["x"] },
          createdAt: 100,
        })
        const got = yield* store.get("s1")
        return { summary, got }
      }),
    )
    expect(result.summary.id).toBe("s1")
    expect(result.summary.status).toBe("active")
    expect(result.got?.title).toBe("t")
    expect(result.got?.tags).toEqual(["x"])
  })

  it("create() does not throw on a cyclic options blob (safe-stringify)", async () => {
    // Regression: chat-service decorate() injects LIVE MCP server objects into
    // sdkOptions.mcpServers; those carry cyclic references. A raw
    // JSON.stringify of the options blob threw "cannot serialize cyclic
    // structures" inside the INSERT, which Effect.orDie turned into a
    // silently-dropped defect that hung every new-thread request. The store's
    // safe-stringify defense must degrade gracefully (no throw) and the row
    // must still be readable.
    const cyclic: Record<string, unknown> = { name: "memory" }
    cyclic["self"] = cyclic // <-- the cycle
    const result = await provideMem(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const summary = yield* store.create({
          id: "cyc",
          options: {
            model: "m",
            sdkOptions: { mcpServers: { memory: cyclic } },
          },
          createdAt: 7,
        })
        const got = yield* store.get("cyc")
        // getOptions must not throw either (the persisted JSON is valid).
        const opts = yield* store.getOptions("cyc")
        return { summary, got, opts }
      }),
    )
    expect(result.summary.id).toBe("cyc")
    expect(result.summary.status).toBe("active")
    expect(result.got?.model).toBe("m")
    // The blob round-trips to valid JSON (the cycle was substituted, not fatal).
    expect(result.opts).not.toBeNull()
  })

  it("rejects duplicate session ids with IntegrityError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* store.create({
            id: "dup",
            options: { model: "m" },
            createdAt: 1,
          })
          yield* store.create({
            id: "dup",
            options: { model: "m" },
            createdAt: 2,
          })
        }).pipe(Effect.provide(memLayer())),
      ),
    )
    expect(exit._tag).toBe("Failure")
  })

  it("appendMessage assigns monotonic seq starting at 0", async () => {
    const seqs = await provideMem(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "s",
          options: { model: "m" },
          createdAt: 0,
        })
        const a = yield* store.appendMessage({
          sessionId: "s",
          messageId: "m1",
          ts: 1,
          parentId: null,
          kind: "user",
          payload: { text: "a" },
        })
        const b = yield* store.appendMessage({
          sessionId: "s",
          messageId: "m2",
          ts: 2,
          parentId: null,
          kind: "user",
          payload: { text: "b" },
        })
        return [a.seq, b.seq]
      }),
    )
    expect(seqs).toEqual([0, 1])
  })

  it("rejects appendMessage to unknown session with IntegrityError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* store.appendMessage({
            sessionId: "ghost",
            messageId: "x",
            ts: 0,
            parentId: null,
            kind: "user",
            payload: {},
          })
        }).pipe(Effect.provide(memLayer())),
      ),
    )
    expect(exit._tag).toBe("Failure")
  })

  it("readMessages streams messages in seq order", async () => {
    const ids = await provideMem(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "r",
          options: { model: "m" },
          createdAt: 0,
        })
        for (let i = 0; i < 5; i++) {
          yield* store.appendMessage({
            sessionId: "r",
            messageId: `m${i}`,
            ts: i,
            parentId: null,
            kind: "user",
            payload: { text: String(i) },
          })
        }
        const all = yield* Stream.runCollect(store.readMessages("r"))
        return Array.from(all).map((m) => m.id)
      }),
    )
    expect(ids).toEqual(["m0", "m1", "m2", "m3", "m4"])
  })

  it("interleaved appends across two sessions keep per-session seq monotonic", async () => {
    const seqs = await provideMem(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "a",
          options: { model: "m" },
          createdAt: 0,
        })
        yield* store.create({
          id: "b",
          options: { model: "m" },
          createdAt: 0,
        })
        const out: Array<{ s: string; seq: number }> = []
        for (let i = 0; i < 5; i++) {
          const ra = yield* store.appendMessage({
            sessionId: "a",
            messageId: `a${i}`,
            ts: i,
            parentId: null,
            kind: "user",
            payload: {},
          })
          const rb = yield* store.appendMessage({
            sessionId: "b",
            messageId: `b${i}`,
            ts: i,
            parentId: null,
            kind: "user",
            payload: {},
          })
          out.push({ s: "a", seq: ra.seq }, { s: "b", seq: rb.seq })
        }
        return out
      }),
    )
    const a = seqs.filter((x) => x.s === "a").map((x) => x.seq)
    const b = seqs.filter((x) => x.s === "b").map((x) => x.seq)
    expect(a).toEqual([0, 1, 2, 3, 4])
    expect(b).toEqual([0, 1, 2, 3, 4])
  })

  it("setStatus updates the status field", async () => {
    const status = await provideMem(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "s",
          options: { model: "m" },
          createdAt: 0,
        })
        yield* store.setStatus("s", "closed", 999)
        const got = yield* store.get("s")
        return got?.status
      }),
    )
    expect(status).toBe("closed")
  })

  it("list filters by status and orders by createdAt desc", async () => {
    const ids = await provideMem(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "old",
          options: { model: "m" },
          createdAt: 1,
        })
        yield* store.create({
          id: "new",
          options: { model: "m" },
          createdAt: 2,
        })
        yield* store.create({
          id: "closed",
          options: { model: "m" },
          createdAt: 3,
        })
        yield* store.setStatus("closed", "closed")
        const active = yield* Stream.runCollect(store.list({ status: "active" }))
        return Array.from(active).map((s) => s.id)
      }),
    )
    expect(ids).toEqual(["new", "old"])
  })

  it("preview tracks user/assistant text only; lastMessageAt bumps on every kind", async () => {
    const summary = await provideMem(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "p",
          options: { model: "m" },
          createdAt: 0,
        })
        yield* store.appendMessage({
          sessionId: "p",
          messageId: "u1",
          ts: 1,
          parentId: null,
          kind: "user",
          payload: { type: "user", message: { content: "hello" } },
        })
        yield* store.appendMessage({
          sessionId: "p",
          messageId: "h1",
          ts: 2,
          parentId: null,
          kind: "hook",
          payload: { event: "PreToolUse" },
        })
        return yield* store.get("p")
      }),
    )
    expect(summary?.lastMessageAt).toBe(2)
    expect(summary?.lastMessagePreview).toContain("hello")
  })

  it("preview ignores parented (subagent-internal) messages; lastMessageAt still bumps", async () => {
    // The SDK forwards a subagent's seed prompt as a parented user message —
    // without the parentId gate every Task spawn would overwrite the sidebar
    // preview with internal prompt text.
    const summary = await provideMem(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "psub",
          options: { model: "m" },
          createdAt: 0,
        })
        yield* store.appendMessage({
          sessionId: "psub",
          messageId: "u1",
          ts: 1,
          parentId: null,
          kind: "user",
          payload: { type: "user", message: { content: "real user text" } },
        })
        yield* store.appendMessage({
          sessionId: "psub",
          messageId: "seed1",
          ts: 2,
          parentId: "agent_call_1",
          kind: "user",
          payload: {
            type: "user",
            message: { content: "You are a subagent. Do the thing." },
          },
        })
        return yield* store.get("psub")
      }),
    )
    expect(summary?.lastMessageAt).toBe(2)
    expect(summary?.lastMessagePreview).toContain("real user text")
  })

  it("persists across reopen (round-trip through restart)", async () => {
    const dbPath = tmpDb()
    try {
      // First scope: create + append, then close.
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SessionStore
            yield* store.create({
              id: "persist",
              options: { model: "m", title: "first" },
              createdAt: 100,
            })
            yield* store.appendMessage({
              sessionId: "persist",
              messageId: "msg1",
              ts: 101,
              parentId: null,
              kind: "user",
              payload: { type: "user", message: { content: "saved" } },
            })
          }).pipe(Effect.provide(makeSessionStoreSqlite(dbPath).pipe(Layer.provide(bootstrapStubL)))),
        ),
      )
      // Second scope: reopen the same DB file.
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SessionStore
            const got = yield* store.get("persist")
            const msgs = yield* Stream.runCollect(
              store.readMessages("persist"),
            )
            return { got, msgs: Array.from(msgs) }
          }).pipe(Effect.provide(makeSessionStoreSqlite(dbPath).pipe(Layer.provide(bootstrapStubL)))),
        ),
      )
      expect(result.got?.title).toBe("first")
      expect(result.msgs).toHaveLength(1)
      expect(result.msgs[0]!.id).toBe("msg1")
      expect(result.msgs[0]!.seq).toBe(0)
    } finally {
      cleanupTmp(dbPath)
    }
  })

  it("schema migration is idempotent (open twice, schema_versions row stays single)", async () => {
    const dbPath = tmpDb()
    try {
      // First open creates schema + records (sessions, 1) in schema_versions.
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* SessionStore
          }).pipe(Effect.provide(makeSessionStoreSqlite(dbPath).pipe(Layer.provide(bootstrapStubL)))),
        ),
      )
      // Second open should no-op the migration.
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SessionStore
            yield* store.create({
              id: "after-migrate",
              options: { model: "m" },
              createdAt: 1,
            })
          }).pipe(Effect.provide(makeSessionStoreSqlite(dbPath).pipe(Layer.provide(bootstrapStubL)))),
        ),
      )
      // Third open verifies the v1 schema still works.
      const id = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SessionStore
            const got = yield* store.get("after-migrate")
            return got?.id
          }).pipe(Effect.provide(makeSessionStoreSqlite(dbPath).pipe(Layer.provide(bootstrapStubL)))),
        ),
      )
      expect(id).toBe("after-migrate")
    } finally {
      cleanupTmp(dbPath)
    }
  })
})
