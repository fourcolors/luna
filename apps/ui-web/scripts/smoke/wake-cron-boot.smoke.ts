/**
 * wake-cron-boot.smoke.ts — boot-risk verification for the wake cron layer.
 *
 * chat-server.ts has NO tsc gate (root tsconfig excludes apps/ui-web/**),
 * so a missing service in the layer graph crashes the WHOLE boot. This
 * smoke PROVES the wake cron sub-layer builds with a ManagedRuntime by
 * importing the REAL exported `buildWakeCronLayer` factory — not a
 * hand-copied mirror.
 *
 * Doubles:
 *   - Real `WakeReasonerDefault` (keeps SDKClient requirement intact — proves
 *     the wiring shape the live boot uses)
 *   - `SDKClient.fake` so ZERO model calls are made (cron never fires during
 *     a layer build, so reason() is never invoked anyway)
 *   - workspacePath = process.cwd() — WakeLogStore.makeLayer opens
 *     <cwd>/.workspace/workspace.db at layer build. If the file doesn't
 *     exist, bun:sqlite creates it; the table-missing failure surfaces only
 *     on the first append(), not at boot.
 *
 * Regression guard: removing `Layer.provide(sdkClientL)` from
 * buildWakeCronLayer MUST make this smoke FAIL with a missing-service defect.
 *
 * Run: bun run apps/ui-web/scripts/smoke/wake-cron-boot.smoke.ts
 * Exit 0 = PASS, non-zero = FAIL (missing service in graph → fix Layer.provide)
 */
import {
  Clock,
  WakeCron,
  AccountBroker,
  AccountBrokerLayer,
  EnvSecretProvider,
  CLAUDE_CODE_LOGIN_SECRET_REF,
  AgentNotesService,
} from "@luna/core"
import { SDKClient } from "@luna/adapter-sdk"
import type { Query } from "@luna/adapter-sdk"
import { Effect, ManagedRuntime, Layer } from "effect"
import { Database } from "bun:sqlite"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildWakeCronLayer } from "../chat-server.js"

// ---------------------------------------------------------------------------
// Set up a temp workspace dir so WakeLogStore.makeLayer can open the db
// ---------------------------------------------------------------------------

const wsRoot = mkdtempSync(join(tmpdir(), "wake-smoke-"))
const wsDir = join(wsRoot, ".workspace")
mkdirSync(wsDir, { recursive: true })
writeFileSync(join(wsDir, "workspace.md"), "# smoke workspace\n")
// Seed the bootstrap-owned `goals` + `next_actions` tables (and `wake_log`).
// WakeLogStore.makeLayer prepares an INSERT into `next_actions` at LAYER BUILD
// (wake-log-store.ts:140), so an un-bootstrapped workspace.db defects the build
// with "no such table: next_actions". The live boot relies on
// scripts/bootstrap-workspace.ts having created these; we mirror its schema
// here (same DDL as packages/core/src/wake/wake.test.ts) so the smoke composes.
const seedDb = new Database(join(wsDir, "workspace.db"))
seedDb.run(`CREATE TABLE goals (
  slug TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', priority INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
seedDb.run(`CREATE TABLE next_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, goal_slug TEXT NOT NULL,
  action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
  priority INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, completed_at INTEGER, notes TEXT)`)
seedDb.run(`CREATE TABLE wake_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, woke_at INTEGER NOT NULL,
  goal_slug TEXT, summary TEXT NOT NULL, outcome TEXT NOT NULL,
  artifacts TEXT)`)
seedDb.close()

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/**
 * Canned, model-free Query. The cron does NOT fire during a layer build,
 * so reason() is never invoked — but WakeReasonerDefault.SDKClient must
 * be satisfiable, which is exactly what this smoke proves.
 */
const sdkFake: Layer.Layer<SDKClient> = SDKClient.fake(() => {
  async function* gen(): AsyncGenerator<never> {
    // never yields — reason() is never called during a layer build
  }
  return gen() as unknown as Query
})

/**
 * Seeded fake AccountBroker (A8): WakeReasonerDefault now requires AccountBroker.
 * One anthropic login-ref account is enough to compose the graph — the cron never
 * fires during a layer build, so acquireSession is never actually called. Built
 * from `fromAccounts` (in-memory; NO bun:sqlite) + EnvSecretProvider + Clock.
 */
const brokerFake: Layer.Layer<AccountBroker> = AccountBrokerLayer.fromAccounts([
  { id: "a1", kind: "anthropic", secretRef: CLAUDE_CODE_LOGIN_SECRET_REF },
]).pipe(Layer.provide(EnvSecretProvider.Default), Layer.provide(Clock.Default))

// ---------------------------------------------------------------------------
// Build the layer under test — SAME factory the live boot uses
// ---------------------------------------------------------------------------

const layer = buildWakeCronLayer({
  expr: "*/30 * * * *",
  workspaceSlug: "smoke",
  workspacePath: wsRoot,
  sdkClientL: sdkFake,
  clockL: Clock.Default,
  brokerL: brokerFake,
  // AgentNotesService.Memory (node-runnable, no SQLite). REQUIRED by
  // buildWakeCronLayer's Layer.provide(agentNotesL); without it the layer
  // graph has an undefined provide and the build defects. (This was missing
  // on HEAD — the smoke never actually composed before; now it does.)
  agentNotesL: AgentNotesService.Memory.pipe(Layer.provide(Clock.Default)),
})

// ---------------------------------------------------------------------------
// The assertion: resolve WakeCron marker (forces the layer to build)
// ---------------------------------------------------------------------------

const main = Effect.gen(function* () {
  const marker = yield* WakeCron
  console.log(
    "[smoke] WakeCron marker resolved; expr =",
    marker.expr,
    "slug =",
    marker.workspaceSlug,
    "triggerId =",
    marker.triggerId,
  )
  if (marker.expr !== "*/30 * * * *") {
    throw new Error(
      `[smoke] FAIL — expected expr "*/30 * * * *", got "${marker.expr}"`,
    )
  }
  if (marker.workspaceSlug !== "smoke") {
    throw new Error(
      `[smoke] FAIL — expected slug "smoke", got "${marker.workspaceSlug}"`,
    )
  }
  if (!marker.triggerId) {
    throw new Error("[smoke] FAIL — triggerId is falsy")
  }
})

const rt = ManagedRuntime.make(layer)
rt.runPromise(main)
  .then(() => rt.dispose())
  .then(() => {
    console.log(
      "[smoke] PASS — wake cron layer builds with the real WakeReasonerDefault graph (SDKClient + WakeLogStore satisfied)",
    )
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error("[smoke] FAIL — layer build defect:", err)
    process.exit(1)
  })
