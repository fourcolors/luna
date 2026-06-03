/**
 * Unit tests for setup-login.ts — the decision logic that runs after
 * `claude setup-token` exits in setup-mode.
 *
 * All seams are injected so no real `claude` is spawned and no real
 * process.exit is called.
 *
 * bun:sqlite is not available when vitest runs under node, so we inject a
 * fake MinimalDb implementation backed by a plain JS Map. The `_openDb`
 * seam is used throughout — this matches the production injectable pattern
 * that setup-login.ts exposes.
 *
 * Three cases:
 *   1. Not logged in  → no exit, pty-output note sent
 *   2. Logged in, account already seeded → exit(0) called, no duplicate insert
 *   3. Logged in, no accounts yet        → one insert, then exit(0)
 */
import { describe, expect, it, vi } from "vitest"
import { onLoginAttemptComplete, seedLoginAccount } from "../setup-login.js"
import type { PtyOutputFrame } from "@luna/ui-ws"

// ── fake MinimalDb ─────────────────────────────────────────────────────────
//
// Stores accounts rows as plain objects in a JS Map. Implements just the
// subset of MinimalDb that setup-login.ts and seedLoginAccount use:
//   db.run(DDL)         — ignored (DDL is idempotent; fake always ready)
//   db.query(SELECT).get(…)  — key lookup
//   db.query(INSERT).run(…)  — row insertion
//   db.close()               — no-op

interface AccountRow {
  id: string
  label: string
  kind: string
  secret_ref: string
  health: string
  cooldown_ms: null
  usage_json: string
}

type FakeDb = ReturnType<typeof makeFakeDb>

const makeFakeDb = () => {
  const rows = new Map<string, AccountRow>()
  const db = {
    rows,
    run: (_sql: string) => { /* DDL no-op */ },
    query: (sql: string) => ({
      get: (...p: unknown[]): unknown => {
        // SELECT 1 AS x FROM accounts WHERE secret_ref = ? LIMIT 1
        if (sql.includes("WHERE secret_ref =")) {
          const ref = p[0] as string
          for (const row of rows.values()) {
            if (row.secret_ref === ref) return { x: 1 }
          }
          return undefined
        }
        // SELECT COUNT(*) AS n FROM accounts
        if (sql.includes("COUNT(*)")) {
          return { n: rows.size }
        }
        // SELECT kind, secret_ref FROM accounts WHERE id = 'default'
        if (sql.includes("WHERE id = 'default'")) {
          return rows.get("default")
        }
        return undefined
      },
      all: (..._p: unknown[]): unknown[] => {
        return Array.from(rows.values())
      },
      run: (...p: unknown[]): { changes: number } => {
        // INSERT INTO accounts (id, label, kind, secret_ref, health, cooldown_ms, usage_json)
        // VALUES (?, ?, ?, ?, ?, NULL, ?)
        if (sql.includes("INSERT INTO accounts")) {
          const [id, label, kind, secret_ref, health, usage_json] = p as string[]
          if (id !== undefined) {
            rows.set(id, { id, label, kind, secret_ref, health, cooldown_ms: null, usage_json })
            return { changes: 1 }
          }
        }
        return { changes: 0 }
      },
    }),
    close: () => { /* no-op */ },
  }
  return db
}

/** Create a factory that always returns the same FakeDb instance. */
const makeDbFactory = (db: FakeDb) => (_path: string) => db as unknown as Parameters<typeof seedLoginAccount>[1] extends ((p: string) => infer R) ? R : never

// ── captured send frames helper ───────────────────────────────────────────────

const captureFrames = () => {
  const frames: PtyOutputFrame[] = []
  const send = (f: PtyOutputFrame) => frames.push(f)
  const texts = () => frames.map((f) => Buffer.from(f.data, "base64").toString())
  return { send, frames, texts }
}

/** Resolve after the 150ms timeout so the deferred exit fires. */
const flushTick = () => new Promise<void>((resolve) => setTimeout(resolve, 200))

// ── test cases ────────────────────────────────────────────────────────────────

describe("onLoginAttemptComplete", () => {
  it("not logged in → no exit, sends a pty-output note", () => {
    const db = makeFakeDb()
    const exitSpy = vi.fn()
    const { send, texts } = captureFrames()

    onLoginAttemptComplete({
      send,
      checkLoggedIn: () => false,
      dbPath: "/fake/luna.db",
      exit: exitSpy,
      _openDb: makeDbFactory(db) as Parameters<typeof onLoginAttemptComplete>[0]["_openDb"],
    })

    expect(exitSpy).not.toHaveBeenCalled()
    expect(texts().join("")).toContain("login not detected")
  })

  it("logged in, account already seeded → exit(0) called, no duplicate insert", async () => {
    const db = makeFakeDb()
    // Pre-seed the account row (simulates lapsed-login re-login flow).
    // Insert directly into the fake db.
    db.rows.set("default", {
      id: "default",
      label: "Default",
      kind: "anthropic",
      secret_ref: "claude-code:login",
      health: "healthy",
      cooldown_ms: null,
      usage_json: "{}",
    })

    const exitSpy = vi.fn()
    const { send, texts } = captureFrames()

    onLoginAttemptComplete({
      send,
      checkLoggedIn: () => true,
      dbPath: "/fake/luna.db",
      exit: exitSpy,
      _openDb: makeDbFactory(db) as Parameters<typeof onLoginAttemptComplete>[0]["_openDb"],
    })

    // Success note is sent synchronously; exit is deferred via setImmediate so
    // the ws frame flushes first.
    expect(texts().join("")).toContain("Login successful")
    expect(exitSpy).not.toHaveBeenCalled() // deferred one tick
    await flushTick()
    expect(exitSpy).toHaveBeenCalledWith(0)
    // Must be exactly 1 row — idempotent, no duplicate.
    expect(db.rows.size).toBe(1)
  })

  it("logged in, zero accounts → one insert, then exit(0)", async () => {
    const db = makeFakeDb()
    const exitSpy = vi.fn()
    const { send } = captureFrames()

    onLoginAttemptComplete({
      send,
      checkLoggedIn: () => true,
      dbPath: "/fake/luna.db",
      exit: exitSpy,
      _openDb: makeDbFactory(db) as Parameters<typeof onLoginAttemptComplete>[0]["_openDb"],
    })

    // Insert is synchronous (runs before the deferred exit).
    expect(db.rows.size).toBe(1)
    const row = db.rows.get("default")
    expect(row?.kind).toBe("anthropic")
    expect(row?.secret_ref).toBe("claude-code:login")

    await flushTick()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})

describe("seedLoginAccount (idempotency)", () => {
  it("calling twice inserts only one row", () => {
    const db = makeFakeDb()
    const openFn = makeDbFactory(db) as Parameters<typeof seedLoginAccount>[1]
    seedLoginAccount("/fake/luna.db", openFn)
    seedLoginAccount("/fake/luna.db", openFn) // second call — must be a no-op
    expect(db.rows.size).toBe(1)
  })

  it("inserted row has correct kind and secret_ref", () => {
    const db = makeFakeDb()
    const openFn = makeDbFactory(db) as Parameters<typeof seedLoginAccount>[1]
    seedLoginAccount("/fake/luna.db", openFn)
    const row = db.rows.get("default")
    expect(row).toBeDefined()
    expect(row?.kind).toBe("anthropic")
    expect(row?.secret_ref).toBe("claude-code:login")
  })
})
