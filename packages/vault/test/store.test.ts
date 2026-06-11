/**
 * VaultStore tests — Memory + SQLite (:memory:) backends.
 *
 * The SQLite block is bun-only (bun:sqlite dies under stock vitest/node);
 * the block is skipped on non-bun runners via `describe.skip`.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Scope } from "effect"
import { Clock, LunaSqliteBootstrap } from "@luna/core"
import { VaultStore } from "../src/store.js"
import type { VaultItem, VaultSyncConfig } from "../src/types.js"

// ---------------------------------------------------------------------------
// Runtime guard and helpers
// ---------------------------------------------------------------------------

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const dSqlite = isBun ? describe : describe.skip

const bootstrapStubL = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "vault test — bootstrap stub",
} as const)

const makeFullLayer = (dbPath: string) =>
  VaultStore.makeLayer(dbPath).pipe(
    Layer.provide(Clock.Default),
    Layer.provide(bootstrapStubL),
  )

const runSqlite = <A, E>(
  prog: Effect.Effect<A, E, VaultStore | Scope.Scope>,
  dbPath = ":memory:",
) =>
  Effect.runPromise(
    Effect.scoped(prog).pipe(Effect.provide(makeFullLayer(dbPath))) as Effect.Effect<
      A,
      E,
      never
    >,
  )

const runMemory = <A, E>(prog: Effect.Effect<A, E, VaultStore>) =>
  Effect.runPromise(
    prog.pipe(Effect.provide(VaultStore.Memory)) as Effect.Effect<A, E, never>,
  )

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseItem = (overrides: Partial<VaultItem> = {}): VaultItem => ({
  id: "aaaa0001",
  name: "Openai Api Key",
  kind: "env-secret",
  ref: "env:OPENAI_API_KEY",
  source: "manual",
  description: null,
  createdAt: 1_000_000,
  updatedAt: 1_000_000,
  opItemId: null,
  ...overrides,
})

// ---------------------------------------------------------------------------
// Shared contract tests — applied to both backends
// ---------------------------------------------------------------------------

const contract = (
  run: <A, E>(prog: Effect.Effect<A, E, VaultStore | Scope.Scope>) => Promise<A>,
) => {
  it("list() returns empty initially", async () => {
    const items = await run(
      Effect.gen(function* () {
        const store = yield* VaultStore
        return yield* store.list()
      }),
    )
    expect(items).toHaveLength(0)
  })

  it("upsertByName inserts a new item and list returns it", async () => {
    const items = await run(
      Effect.gen(function* () {
        const store = yield* VaultStore
        yield* store.upsertByName(baseItem())
        return yield* store.list()
      }),
    )
    expect(items).toHaveLength(1)
    expect(items[0]?.name).toBe("Openai Api Key")
    expect(items[0]?.ref).toBe("env:OPENAI_API_KEY")
  })

  it("upsertByName updates case-insensitively, preserving id + createdAt", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* VaultStore
        yield* store.upsertByName(baseItem({ id: "orig-id", createdAt: 111, updatedAt: 111 }))
        // Different id, different case — should land on the same row.
        yield* store.upsertByName(
          baseItem({
            id: "new-id",
            name: "OPENAI API KEY",
            description: "updated",
            updatedAt: 222,
          }),
        )
        return yield* store.list()
      }),
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe("orig-id")        // id preserved
    expect(result[0]?.createdAt).toBe(111)        // createdAt preserved
    expect(result[0]?.updatedAt).toBe(222)        // updatedAt replaced
    expect(result[0]?.description).toBe("updated")
  })

  it("getById returns the item or null for unknown id", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* VaultStore
        const missing = yield* store.getById("ghost")
        expect(missing).toBeNull()
        yield* store.upsertByName(baseItem({ id: "found-1" }))
        const found = yield* store.getById("found-1")
        expect(found?.name).toBe("Openai Api Key")
      }),
    )
  })

  it("remove returns true on success, false for unknown id", async () => {
    const out = await run(
      Effect.gen(function* () {
        const store = yield* VaultStore
        const miss = yield* store.remove("ghost")
        yield* store.upsertByName(baseItem({ id: "rm-1" }))
        const ok = yield* store.remove("rm-1")
        const count = (yield* store.list()).length
        return { miss, ok, count }
      }),
    )
    expect(out.miss).toBe(false)
    expect(out.ok).toBe(true)
    expect(out.count).toBe(0)
  })

  it("list sorts by createdAt ascending", async () => {
    const names = await run(
      Effect.gen(function* () {
        const store = yield* VaultStore
        yield* store.upsertByName(
          baseItem({ id: "b", name: "B Key", ref: "env:B_KEY", createdAt: 200, updatedAt: 200 }),
        )
        yield* store.upsertByName(
          baseItem({ id: "a", name: "A Key", ref: "env:A_KEY", createdAt: 100, updatedAt: 100 }),
        )
        yield* store.upsertByName(
          baseItem({ id: "c", name: "C Key", ref: "env:C_KEY", createdAt: 300, updatedAt: 300 }),
        )
        return (yield* store.list()).map((i) => i.name)
      }),
    )
    expect(names).toEqual(["A Key", "B Key", "C Key"])
  })

  it("getSyncConfig returns null initially", async () => {
    const cfg = await run(
      Effect.gen(function* () {
        const store = yield* VaultStore
        return yield* store.getSyncConfig()
      }),
    )
    expect(cfg).toBeNull()
  })

  it("setSyncConfig persists and getSyncConfig returns it", async () => {
    const cfg: VaultSyncConfig = {
      enabled: true,
      opLabel: "primary",
      opVault: "Personal",
      pollSeconds: 300,
      lastSyncedAt: null,
      lastError: null,
    }
    const stored = await run(
      Effect.gen(function* () {
        const store = yield* VaultStore
        yield* store.setSyncConfig(cfg)
        return yield* store.getSyncConfig()
      }),
    )
    expect(stored).toEqual(cfg)
  })

  it("setSyncConfig is idempotent (upsert)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* VaultStore
        const cfg: VaultSyncConfig = {
          enabled: true,
          opLabel: "primary",
          opVault: "Personal",
          pollSeconds: 300,
          lastSyncedAt: null,
          lastError: null,
        }
        yield* store.setSyncConfig(cfg)
        yield* store.setSyncConfig({ ...cfg, pollSeconds: 60, lastSyncedAt: 999_000, lastError: "timeout" })
        return yield* store.getSyncConfig()
      }),
    )
    expect(result?.pollSeconds).toBe(60)
    expect(result?.lastSyncedAt).toBe(999_000)
    expect(result?.lastError).toBe("timeout")
  })

  it("op-item with opItemId round-trips correctly", async () => {
    const item = await run(
      Effect.gen(function* () {
        const store = yield* VaultStore
        yield* store.upsertByName(
          baseItem({
            id: "op-1",
            name: "Github Token",
            kind: "op-item",
            ref: "luna-op://primary/Personal/item999/credential",
            source: "1password",
            opItemId: "item999",
          }),
        )
        return yield* store.getById("op-1")
      }),
    )
    expect(item?.kind).toBe("op-item")
    expect(item?.source).toBe("1password")
    expect(item?.opItemId).toBe("item999")
  })

  // Finding 5: non-ASCII name deduplication uses JS .toLowerCase(), not SQLite lower().
  it("upsertByName deduplicates non-ASCII names identically to ASCII (Unicode fold)", async () => {
    // "Ñoño Key" and "ñoño key" differ only in case (ñ → U+00F1, Ñ → U+00D1).
    // JS .toLowerCase() folds them; SQLite lower() does NOT (ASCII-only).
    // The store must treat them as the same slot (upsert, not insert).
    const result = await run(
      Effect.gen(function* () {
        const store = yield* VaultStore
        yield* store.upsertByName(
          baseItem({ id: "unicode-1", name: "Ñoño Key", ref: "env:NONO_KEY", createdAt: 100, updatedAt: 100 }),
        )
        // Same name in lowercase — should land on the SAME row (upsert).
        yield* store.upsertByName(
          baseItem({ id: "unicode-2", name: "ñoño key", ref: "env:NONO_KEY", createdAt: 100, updatedAt: 200 }),
        )
        return yield* store.list()
      }),
    )
    // Must be exactly one row (not two).
    expect(result).toHaveLength(1)
    // id preserved from first insert.
    expect(result[0]?.id).toBe("unicode-1")
    // updatedAt replaced.
    expect(result[0]?.updatedAt).toBe(200)
  })
}

// ---------------------------------------------------------------------------
// Apply contract to both variants
// ---------------------------------------------------------------------------

describe("VaultStore.Memory", () => {
  contract((prog) =>
    runMemory(prog as Effect.Effect<never, never, VaultStore>),
  )
})

dSqlite("VaultStore.makeLayer (SQLite :memory:)", () => {
  contract(runSqlite)
})
