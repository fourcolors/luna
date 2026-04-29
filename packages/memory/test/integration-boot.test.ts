/**
 * Phase 27a regression test — Vectorlite bootstrap race.
 *
 * Reproduces the dev-server-chat boot order: AccountBroker.fromSql + an
 * sqlite-backed SessionStore both open `bun:sqlite` Databases BEFORE the
 * SqliteVectorBackend Layer runs `initVectorlite()`. Because
 * `Database.setCustomSQLite()` is process-global one-shot — it MUST run
 * before the first `new Database()` — Vectorlite silently falls back to
 * naive in-process cosine ranking and the Phase 27 HNSW path is dead.
 *
 * Asserts:
 *   1. After boot, `SqliteVectorBackend.hnswEnabled === true`.
 *   2. No "Vectorlite HNSW unavailable" warning was emitted to console.warn.
 *
 * Lands RED at 27a/1 (no fix yet). Goes GREEN at 27a/3 once the core stores
 * + sqlite-vector all yield* `LunaSqliteBootstrap` before opening any
 * Database.
 *
 * Skipped under stock node+vitest (`bun:sqlite` unavailable).
 */
import { describe, expect, it, vi } from "vitest"
import { Effect, Layer } from "effect"
import {
  AccountBroker,
  AccountBrokerLayer,
  Clock,
  EnvSecretProvider,
  SessionStore,
  StubEmbedderLayer,
} from "@luna/core"
import { SqliteVectorBackend } from "../src/backends/sqlite-vector.js"
import { LunaSqliteBootstrapLive } from "../src/backends/vectorlite-bootstrap.js"
import { _resetVectorliteInitForTests } from "../src/backends/vectorlite-init.js"

const hasBunSqlite =
  typeof (process.versions as { bun?: string }).bun === "string"

describe.skipIf(!hasBunSqlite)(
  "Phase 27a — vectorlite bootstrap race (regression)",
  () => {
    it(
      "SqliteVectorBackend.hnswEnabled is true when AccountBroker + SessionStore " +
        "are co-built (no 'Vectorlite HNSW unavailable' warning)",
      async () => {
        // Process-global cache must be cleared so this test re-attempts the
        // bootstrap on its own. Without this, an earlier test in the run may
        // have already cached a result that doesn't reflect the race.
        _resetVectorliteInitForTests()

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

        try {
          // Mirror the dev-server-chat composition: AccountBroker.fromSql +
          // sqlite SessionStore + SqliteVectorBackend, all on :memory:. The
          // bug is that AccountBroker / SessionStore open `bun:sqlite`
          // Databases inside their own Layer.scoped before the
          // SqliteVectorBackend Layer gets a chance to call
          // setCustomSQLite() — so Vectorlite init fails.
          const brokerL = AccountBrokerLayer.fromSql({
            dbPath: ":memory:",
          }).pipe(
            Layer.provide(EnvSecretProvider.Default),
            Layer.provide(Clock.Default),
          )
          const sessionL = SessionStore.fromPath(":memory:")
          const vectorL = SqliteVectorBackend.fromPath(":memory:").pipe(
            Layer.provide(StubEmbedderLayer),
          )

          // Force the dev-server-chat boot order: build broker + session
          // FIRST (each opens bun:sqlite via `new Database(...)`), then
          // build the vector backend. We achieve this via a 2-phase
          // provide: the inner Effect requires SqliteVectorBackend (so
          // vectorL builds), but the broker + session layers are
          // *Effect-provided* on the outside via `Layer.merge` →
          // `Effect.provide` chain. The broker/session layers' Database
          // opens before vectorL's initVectorlite() runs, exercising the
          // race the bootstrap fix is meant to eliminate.
          const baseEff = Effect.gen(function* () {
            // Yield broker + session FIRST so their Layer.scoped gens
            // fully evaluate (each opens a bun:sqlite Database) before
            // we ask for SqliteVectorBackend, which will then attempt
            // setCustomSQLite() too late.
            yield* AccountBroker
            yield* SessionStore
            const v = yield* SqliteVectorBackend
            return v.hnswEnabled
          })

          const hnswEnabled = await Effect.runPromise(
            Effect.scoped(
              baseEff.pipe(
                Effect.provide(vectorL),
                Effect.provide(sessionL),
                Effect.provide(brokerL),
                // Phase 27a: provide the bootstrap Layer last so it
                // builds first. The store layers' yield* of
                // LunaSqliteBootstrap forces the swap to run before
                // any `new Database()` — which is the whole fix.
                Effect.provide(LunaSqliteBootstrapLive),
              ),
            ),
          )

          expect(hnswEnabled).toBe(true)

          const warnings = warnSpy.mock.calls
            .map((c) => String(c[0] ?? ""))
            .filter((m) => m.includes("Vectorlite HNSW unavailable"))
          expect(warnings).toEqual([])
        } finally {
          warnSpy.mockRestore()
        }
      },
    )
  },
)
