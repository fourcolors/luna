/**
 * Phase 25e/1 — regression test for the multi-component migration collision.
 *
 * Bug: 5 components share `~/.luna/luna.db` and each gates its v1 migration
 * on `PRAGMA user_version`. Whichever component runs first bumps the pragma
 * to 1; subsequent components see `userVersion >= 1` and SKIP their CREATE
 * TABLE entirely, leaving their tables non-existent.
 *
 * Reproduction (in-memory, no fs):
 *   1. Open `:memory:` DB
 *   2. Simulate the sessions migration: bump `PRAGMA user_version = 1`
 *      WITHOUT creating the accounts table (this is what happens when a
 *      different component wins the race)
 *   3. Run the broker's hydration via `AccountBrokerLayer.fromSql`
 *   4. Assert the `accounts` table EXISTS afterwards
 *
 * Pre-25e/3: the broker sees user_version=1 and skips creating accounts →
 * test fails with "no such table: accounts" when it tries to SELECT.
 *
 * Post-25e/3: the broker uses `applyMigration("accounts", 1, ...)` keyed on
 * `schema_versions`, which is empty for the "accounts" component → CREATE
 * runs → test passes.
 *
 * NOTE: bun-only. Stock vitest+node can't import `bun:sqlite`.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { LunaSqliteBootstrap } from "./sqlite-bootstrap.js"
import {
  SecretProvider,
  type SecretProviderApi,
} from "../secret-provider/index.js"
import { AccountBroker, AccountBrokerLayer } from "../account-broker/index.js"

// Phase 27a: AccountBrokerLayer.fromSql now declares `LunaSqliteBootstrap`
// in its `R`. Provide a no-op stub here (no Vectorlite against this DB).
const bootstrapStubL = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "core test — bootstrap stub",
} as const)

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const d = isBun ? describe : describe.skip

// Minimal SecretProvider stub — broker hydrate doesn't resolve secrets, so
// any provider satisfying the interface is fine. (We don't acquireSession
// in this test; we only assert table existence after Layer build.)
const stubSecretProvider: SecretProviderApi = {
  get: (_ref) =>
    Effect.die("stub SecretProvider.get should not be called in this test"),
}
const SecretProviderStub = Layer.succeed(SecretProvider, stubSecretProvider)

interface MinimalDb {
  run: (sql: string) => void
  query: (sql: string) => {
    get: (...p: unknown[]) => unknown
    all: (...p: unknown[]) => unknown[]
  }
  close: () => void
}

const openMemoryDbAt = async (
  dbPath: string,
): Promise<MinimalDb> => {
  const bunSqliteSpec = "bun:sqlite"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(/* @vite-ignore */ bunSqliteSpec)
  return new mod.Database(dbPath) as MinimalDb
}

d("Phase 25e regression — migration collision across components", () => {
  it("broker hydrate creates `accounts` table even when user_version is already 1", async () => {
    // We need a single physical file so the Layer reopens what we seeded.
    // bun:sqlite `:memory:` can't be shared across handles, so use a
    // tempfile instead — still in-process, no /Users/sol/.luna touched.
    const os = await import("node:os")
    const path = await import("node:path")
    const fs = await import("node:fs")
    const dbPath = path.join(
      os.tmpdir(),
      `luna-25e-regression-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    )

    try {
      // STEP 1+2: simulate "another component already migrated to v1" by
      // bumping PRAGMA user_version=1 WITHOUT creating the accounts table.
      // This is exactly what happens on Sterling's dev DB after sessions
      // migration ran first.
      const seedDb = await openMemoryDbAt(dbPath)
      seedDb.run("PRAGMA journal_mode = WAL")
      seedDb.run("PRAGMA user_version = 1")
      // Sanity: confirm `accounts` does NOT exist yet.
      const before = seedDb
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'",
        )
        .get() as { name: string } | null | undefined
      expect(before == null).toBe(true)
      seedDb.close()

      // STEP 3: build the broker layer against this poisoned DB.
      const brokerL = AccountBrokerLayer.fromSql({ dbPath }).pipe(
        Layer.provide(SecretProviderStub),
        Layer.provide(Clock.Default),
        Layer.provide(bootstrapStubL),
      )
      const program = Effect.gen(function* () {
        // Just touching the broker forces Layer construction (and the
        // migration ladder to run). We don't need to call any methods.
        const _broker = yield* AccountBroker
        return _broker
      })
      await Effect.runPromise(
        Effect.scoped(program).pipe(Effect.provide(brokerL)),
      )

      // STEP 4: assert `accounts` table exists. Pre-25e/3 this fails:
      // the broker saw user_version=1 and skipped CREATE.
      const verifyDb = await openMemoryDbAt(dbPath)
      try {
        const after = verifyDb
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'",
          )
          .get() as { name: string } | null | undefined
        expect(after != null).toBe(true)
        expect(after?.name).toBe("accounts")
      } finally {
        verifyDb.close()
      }
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.unlinkSync(dbPath + suffix)
        } catch {
          /* ignore */
        }
      }
    }
  })
})
