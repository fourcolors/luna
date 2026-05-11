/**
 * Phase 25d live smoke — exercises the full canary path that
 * chat-server boots:
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
  readKeychainToken,
  secretProviderFirstOf,
} from "@luna/core"

const LIVE = process.env["LUNA_LIVE_SMOKE"] === "1"
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
// `AccountBrokerLayer.fromSql` resolves `bun:sqlite` at boot. Under
// stock vitest+node the module is unavailable — skip cleanly so the
// suite stays green. The manual smoke (`bun run --filter '@luna/ui-web'
// server:chat`) is the canonical end-to-end verification.
const d = LIVE && isBun ? describe : describe.skip

const CANONICAL_LUNA_OP_REF =
  "luna-op://antmachine/<vault-id>/<item-id>/credential"
const CANONICAL_BARE_OP_REF =
  "op://<vault-id>/<item-id>/credential"
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
  it("luna-op://antmachine/... → acquireSession returns Redacted starting with sk-ant-oat", async () => {
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

  // Phase 25e/5: full chain proof, folded in from the now-deleted
  // apps/ui-web/scripts/broker-smoke.ts. Exercises:
  //   keychain × 3  →  OnePasswordSecretProvider × 3  →  RoutedOpSecretProvider
  //   →  AccountBrokerLayer.fromSql  →  acquireSession
  //   →  Redacted<sk-ant-oat-...>
  // Requires all three luna.op.<label> keychain entries present
  // (Sterling's machine has them; CI does not — that's why this is gated).
  it("3 keychain × OP layers × RoutedOp → broker → Redacted<sk-ant-oat>", async () => {
    const OP_ACCOUNTS = [
      {
        label: "antmachine",
        keychainService: "luna.op.antmachine",
        keychainAccount: "antmachine",
      },
      {
        label: "mrbot",
        keychainService: "luna.op.mrbot",
        keychainAccount: "mrbot",
      },
      {
        label: "flow",
        keychainService: "luna.op.flow",
        keychainAccount: "flow",
      },
    ] as const

    const buildOpLayers = Effect.gen(function* () {
      const accounts: {
        label: string
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        layer: Layer.Layer<any, any, any>
      }[] = []
      for (const acct of OP_ACCOUNTS) {
        const token = yield* readKeychainToken({
          service: acct.keychainService,
          account: acct.keychainAccount,
        })
        const opLayer = OnePasswordSecretProvider.make({
          accountLabel: acct.label,
          token,
        }).pipe(Layer.provide(Clock.Default))
        accounts.push({ label: acct.label, layer: opLayer })
      }
      return accounts
    })

    // Sterling's keychain layout: the `mrbot` SA token has read access to
    // the antmachine vault where the canonical credential lives. The other
    // two tokens 403 against this ref. Routing via `luna-op://mrbot/...`
    // proves the dispatcher picks the right inner layer (this is the whole
    // point of RoutedOp: don't rely on a single SA having every vault).
    const ROUTED_REF =
      "luna-op://mrbot/<vault-id>/<item-id>/credential"
    const dbPath = seedDb(ROUTED_REF)
    try {
      const program = Effect.gen(function* () {
        const accounts = yield* buildOpLayers
        expect(accounts).toHaveLength(3)
        expect(accounts.map((a) => a.label)).toEqual([
          "antmachine",
          "mrbot",
          "flow",
        ])
        const routedOp = RoutedOpSecretProvider.make({ accounts })
        const secretL = secretProviderFirstOf([
          routedOp,
          EnvSecretProvider.Default,
        ])
        const brokerL = AccountBrokerLayer.fromSql({ dbPath }).pipe(
          Layer.provide(secretL),
          Layer.provide(Clock.Default),
        )
        const acquire = Effect.gen(function* () {
          const broker = yield* AccountBroker
          return yield* broker.acquireSession({ model: "claude-sonnet-4-5" })
        })
        return yield* acquire.pipe(Effect.scoped, Effect.provide(brokerL))
      })
      const credential = await Effect.runPromise(
        program as Effect.Effect<{
          accountId: string
          kind: string
          resolvedSecret: Redacted.Redacted<string>
        }>,
      )
      expect(credential.kind).toBe("anthropic")
      const resolved = Redacted.value(credential.resolvedSecret)
      expect(resolved.startsWith("sk-ant-oat")).toBe(true)
    } finally {
      cleanupDb(dbPath)
    }
  }, 60_000)

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
