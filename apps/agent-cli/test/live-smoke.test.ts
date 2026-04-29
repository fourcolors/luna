/**
 * Phase 25d live smoke — exercises the full canary path that
 * dev-server-chat boots:
 *   CLI insert  →  AccountBrokerLayer.fromSql  →  acquireSession()
 *   →  RoutedOpSecretProvider  →  OnePasswordSecretProvider
 *   →  Redacted<sk-ant-oat-...>
 *
 * Skipped unless `LUNA_LIVE_SMOKE=1` is set, because it requires:
 *   - `op` CLI on PATH
 *   - `OP_SERVICE_ACCOUNT_TOKEN` set (preferred — service account, headless)
 *     OR an active `op signin` session (interactive fallback)
 *   - the canonical Sterling Claude OAuth ref to be reachable
 *
 * Run:
 *   LUNA_LIVE_SMOKE=1 bun run test apps/agent-cli/test/live-smoke.test.ts
 */
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { Effect, Layer, Redacted } from "effect"
import {
  AccountBroker,
  AccountBrokerLayer,
  Clock,
  EnvSecretProvider,
  OnePasswordSecretProvider,
  RoutedOpSecretProvider,
  secretProviderFirstOf,
} from "@luna/core"

const LIVE = process.env["LUNA_LIVE_SMOKE"] === "1"
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
// `AccountBrokerLayer.fromSql` resolves `bun:sqlite` at boot. Under
// stock vitest+node the module is unavailable — skip cleanly so the
// suite stays green. The manual smoke (`bun run --filter '@luna/ui-web'
// dev:server:chat`) is the canonical end-to-end verification.
const d = LIVE && isBun ? describe : describe.skip

const CANONICAL_LUNA_OP_REF =
  "luna-op://VAULT/ITEM/FIELD"
const CANONICAL_BARE_OP_REF =
  "op://VAULT/ITEM/FIELD"
const CLI_ENTRY = path.resolve(__dirname, "..", "src", "index.ts")

const seedDb = (ref: string): string => {
  const dbPath = path.join(
    os.tmpdir(),
    `luna-live-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  )
  const seed = spawnSync(
    "bun",
    [
      "run",
      CLI_ENTRY,
      "add",
      "--id",
      "sterling",
      "--label",
      "Sterling",
      "--kind",
      "anthropic",
      "--secret-ref",
      ref,
    ],
    { encoding: "utf8", env: { ...process.env, LUNA_DB_PATH: dbPath } },
  )
  if (seed.status !== 0) {
    throw new Error(`seed failed: ${seed.stderr}`)
  }
  return dbPath
}

const cleanupDb = (dbPath: string): void => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix)
    } catch {
      /* ignore */
    }
  }
}

const buildRoutedSecretL = () => {
  const innerOpL = OnePasswordSecretProvider.make({
    accountLabel: "antmachine",
  }).pipe(Layer.provide(Clock.Default))
  const routedL = RoutedOpSecretProvider.make({
    accounts: [{ label: "antmachine", layer: innerOpL }],
  })
  return secretProviderFirstOf([routedL, EnvSecretProvider.Default])
}

d("Phase 25d live smoke — broker → RoutedOpSecretProvider → Redacted<sk-ant-oat>", () => {
  it("luna-op://VAULT/ITEM/FIELD → acquireSession returns Redacted starting with sk-ant-oat", async () => {
    const dbPath = seedDb(CANONICAL_LUNA_OP_REF)
    try {
      const secretL = buildRoutedSecretL()
      const brokerL = AccountBrokerLayer.fromSql({ dbPath }).pipe(
        Layer.provide(secretL),
        Layer.provide(Clock.Default),
      )
      const program = Effect.gen(function* () {
        const broker = yield* AccountBroker
        return yield* broker.acquireSession({ model: "claude-sonnet-4-5" })
      })
      const credential = await Effect.runPromise(
        Effect.scoped(program).pipe(Effect.provide(brokerL)) as Effect.Effect<{
          resolvedSecret: Redacted.Redacted<string>
        }>,
      )
      const resolved = Redacted.value(credential.resolvedSecret)
      expect(resolved.startsWith("sk-ant-oat")).toBe(true)
    } finally {
      cleanupDb(dbPath)
    }
  }, 30_000)

  it("bare op://... still resolves when exactly 1 OP account is registered", async () => {
    const dbPath = seedDb(CANONICAL_BARE_OP_REF)
    try {
      const secretL = buildRoutedSecretL()
      const brokerL = AccountBrokerLayer.fromSql({ dbPath }).pipe(
        Layer.provide(secretL),
        Layer.provide(Clock.Default),
      )
      const program = Effect.gen(function* () {
        const broker = yield* AccountBroker
        return yield* broker.acquireSession({ model: "claude-sonnet-4-5" })
      })
      const credential = await Effect.runPromise(
        Effect.scoped(program).pipe(Effect.provide(brokerL)) as Effect.Effect<{
          resolvedSecret: Redacted.Redacted<string>
        }>,
      )
      const resolved = Redacted.value(credential.resolvedSecret)
      expect(resolved.startsWith("sk-ant-oat")).toBe(true)
    } finally {
      cleanupDb(dbPath)
    }
  }, 30_000)
})
