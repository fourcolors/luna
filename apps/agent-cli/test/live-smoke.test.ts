/**
 * Phase 25b live smoke — exercises the full canary path that
 * dev-server-chat boots:
 *   CLI insert  →  AccountBrokerLayer.fromSql  →  acquireSession()
 *   →  OnePasswordSecretProvider  →  Redacted<sk-ant-oat-...>
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
  secretProviderFirstOf,
} from "@luna/core"

const LIVE = process.env["LUNA_LIVE_SMOKE"] === "1"
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
// `AccountBrokerLayer.fromSql` resolves `bun:sqlite` at boot. Under
// stock vitest+node the module is unavailable — skip cleanly so the
// suite stays green. The manual smoke (`bun run --filter '@luna/ui-web'
// dev:server:chat`) is the canonical end-to-end verification.
const d = LIVE && isBun ? describe : describe.skip

const CANONICAL_REF =
  "op://VAULT/ITEM/FIELD"
const CLI_ENTRY = path.resolve(__dirname, "..", "src", "index.ts")

d("Phase 25b live smoke — broker → 1Password → Redacted<sk-ant-oat>", () => {
  it("acquireSession returns a Redacted secret starting with sk-ant-oat", async () => {
    // 1. Seed a fresh DB via the CLI (subprocess) — same path users hit.
    const dbPath = path.join(
      os.tmpdir(),
      `luna-live-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    )
    try {
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
          CANONICAL_REF,
        ],
        { encoding: "utf8", env: { ...process.env, LUNA_DB_PATH: dbPath } },
      )
      expect(seed.status, seed.stderr).toBe(0)

      // 2. Build the broker Layer composition that dev-server-chat uses,
      //    minus the WS server.
      const opL = OnePasswordSecretProvider.make({ vault: "Mr Bot" }).pipe(
        Layer.provide(Clock.Default),
      )
      const secretL = secretProviderFirstOf([opL, EnvSecretProvider.Default])
      const brokerL = AccountBrokerLayer.fromSql({ dbPath }).pipe(
        Layer.provide(secretL),
        Layer.provide(Clock.Default),
      )

      // 3. acquireSession + assert Redacted shape.
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
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.unlinkSync(dbPath + suffix)
        } catch {
          /* ignore */
        }
      }
    }
  }, 30_000)
})
