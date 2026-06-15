/**
 * dream-wake-cutover.test.ts — M5 (scheduler-v2 dream/wake migration).
 *
 * Asserts the cutover invariant: the boot dream/wake cron factories register
 * EITHER the legacy fiber-per-cron trigger OR nothing-because-V2-drives-them,
 * NEVER both. Concretely, gating `buildDreamCronLayer` / `buildWakeCronLayer`
 * on `schedulerV2Enabled` must make them return an EMPTY layer (no
 * registerDreamCron / registerWakeCron call → no trigger) when V2 is on, and
 * the registering layer when V2 is off.
 *
 * These exercise the SAME exported factories the live boot uses (imported from
 * ../chat-server.js — the same module the worker-registry-wiring + boot smokes
 * import), so the test agrees with production wiring.
 *
 * Probe: a built cron layer exposes its marker service (DreamCron / WakeCron)
 * ONLY when it registered a trigger. So "resolves the marker" ⇔ legacy
 * registered; "fails with a missing-service defect" ⇔ gated to V2 (empty layer).
 *
 * The V2-ON (gated) cases are node-safe: the factory returns Layer.empty BEFORE
 * touching SDKClient / WakeLogStore (bun:sqlite), so no real services are
 * needed. The legacy-ON wake case builds WakeLogStore.makeLayer (bun:sqlite) and
 * is therefore bun-gated, mirroring jobs-store.test.ts's SQLite section.
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer, Ref, Stream } from "effect"
import {
  Clock,
  DreamCron,
  WakeCron,
  DreamStore,
  SessionStore,
  AccountBroker,
  AccountBrokerLayer,
  AgentNotesService,
  EnvSecretProvider,
  CLAUDE_CODE_LOGIN_SECRET_REF,
} from "@luna/core"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { SDKClient } from "@luna/adapter-sdk"
import type { Query } from "@luna/adapter-sdk"
import { buildDreamCronLayer, buildWakeCronLayer } from "../chat-server.js"
import { mkdtempSync, mkdirSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"

/**
 * Seed a workspace.db with the bootstrap-owned tables WakeLogStore.makeLayer
 * prepares against at LAYER BUILD (it prepares an INSERT into `next_actions`),
 * so the legacy wake layer composes. Mirrors wake-cron-boot.smoke.ts's seed.
 * Bun-only (uses bun:sqlite) — called solely from the bun-gated block.
 */
const seedWorkspaceDb = (wsRoot: string): void => {
  const wsDir = join(wsRoot, ".workspace")
  mkdirSync(wsDir, { recursive: true })
  // Dynamic require so node-vitest never evaluates the bun:sqlite import.
  const req = createRequire(import.meta.url)
  const { Database } = req("bun:sqlite") as {
    Database: new (p: string) => { run: (sql: string) => void; close: () => void }
  }
  const db = new Database(join(wsDir, "workspace.db"))
  db.run(
    `CREATE TABLE goals (slug TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', priority INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  )
  db.run(
    `CREATE TABLE next_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_slug TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo', priority INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER, notes TEXT)`,
  )
  db.run(
    `CREATE TABLE wake_log (id INTEGER PRIMARY KEY AUTOINCREMENT, woke_at INTEGER NOT NULL, goal_slug TEXT, summary TEXT NOT NULL, outcome TEXT NOT NULL, artifacts TEXT)`,
  )
  db.close()
}

// ── Node-runnable doubles (mirror dream-cron-boot.smoke.ts) ──────────────────

const FakeMem = Layer.effect(
  MemoryRouterTag,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<string, MemoryRecord>>(new Map())
    return {
      put: (r: MemoryRecord) => Ref.update(store, (m) => new Map(m).set(r.id, r)),
      get: (id: string) =>
        Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
      delete: () => Effect.succeed(false),
      query: () => Stream.empty,
      search: () => Stream.empty,
    } as never
  }),
)

const sdkFake: Layer.Layer<SDKClient> = SDKClient.fake(() => {
  async function* gen(): AsyncGenerator<never> {}
  return gen() as unknown as Query
})

const brokerFake: Layer.Layer<AccountBroker> = AccountBrokerLayer.fromAccounts([
  { id: "a1", kind: "anthropic", secretRef: CLAUDE_CODE_LOGIN_SECRET_REF },
]).pipe(Layer.provide(EnvSecretProvider.Default), Layer.provide(Clock.Default))

const buildDream = (schedulerV2Enabled: boolean | undefined) =>
  buildDreamCronLayer({
    expr: "0 3 * * *",
    sdkClientL: sdkFake,
    memoryRouterL: FakeMem,
    storeL: SessionStore.Default,
    clockL: Clock.Default,
    dreamStoreL: DreamStore.Memory,
    brokerL: brokerFake,
    schedulerV2Enabled,
  })

const buildWake = (schedulerV2Enabled: boolean | undefined, wsPath: string) =>
  buildWakeCronLayer({
    expr: "*/30 * * * *",
    workspaceSlug: "cutover-test",
    workspacePath: wsPath,
    sdkClientL: sdkFake,
    clockL: Clock.Default,
    agentNotesL: AgentNotesService.Memory.pipe(Layer.provide(Clock.Default)),
    brokerL: brokerFake,
    schedulerV2Enabled,
  })

/** Try to resolve a cron marker from a built layer; returns true if it
 * resolved (trigger registered), false if the layer was empty (gated). */
const markerResolves = <A, E>(
  tag: Effect.Effect<A, E, never>,
  layer: Layer.Layer<unknown, unknown, never>,
): Promise<boolean> =>
  Effect.runPromiseExit(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tag as any).pipe(Effect.provide(layer as any)),
  ).then((exit: Exit.Exit<A, E>) => Exit.isSuccess(exit))

describe("M5 cutover — dream cron factory gates on schedulerV2Enabled", () => {
  it("V2 ENABLED: registers NO legacy trigger (empty layer — DreamCron absent)", async () => {
    const resolved = await markerResolves(
      DreamCron,
      buildDream(true) as Layer.Layer<unknown, unknown, never>,
    )
    expect(resolved).toBe(false)
  })

  it("V2 DISABLED: registers the legacy trigger (DreamCron resolves)", async () => {
    const resolved = await markerResolves(
      DreamCron,
      buildDream(false) as Layer.Layer<unknown, unknown, never>,
    )
    expect(resolved).toBe(true)
  })

  it("flag UNSET behaves like DISABLED (legacy registers — safe default)", async () => {
    const resolved = await markerResolves(
      DreamCron,
      buildDream(undefined) as Layer.Layer<unknown, unknown, never>,
    )
    expect(resolved).toBe(true)
  })

  it("EITHER legacy OR V2, never both (dream)", async () => {
    const legacyOn = await markerResolves(
      DreamCron,
      buildDream(false) as Layer.Layer<unknown, unknown, never>,
    )
    const v2On = await markerResolves(
      DreamCron,
      buildDream(true) as Layer.Layer<unknown, unknown, never>,
    )
    // exactly one regime registers the legacy cron — XOR
    expect(legacyOn).not.toBe(v2On)
    expect(legacyOn).toBe(true)
    expect(v2On).toBe(false)
  })
})

describe("M5 cutover — wake cron factory gates on schedulerV2Enabled", () => {
  it("V2 ENABLED: registers NO legacy trigger (empty layer — WakeCron absent)", async () => {
    // node-safe: gated path returns Layer.empty before WakeLogStore (bun:sqlite)
    const resolved = await markerResolves(
      WakeCron,
      buildWake(true, "/nonexistent-path-never-opened") as Layer.Layer<
        unknown,
        unknown,
        never
      >,
    )
    expect(resolved).toBe(false)
  })

  // The legacy wake path builds WakeLogStore.makeLayer (bun:sqlite), so this
  // assertion only runs under bun (skips cleanly under node-vitest).
  const dWake = isBun ? describe : describe.skip
  dWake("legacy path (bun:sqlite)", () => {
    it("V2 DISABLED: registers the legacy trigger (WakeCron resolves)", async () => {
      const wsRoot = mkdtempSync(join(tmpdir(), "wake-cutover-"))
      seedWorkspaceDb(wsRoot)
      const resolved = await markerResolves(
        WakeCron,
        buildWake(false, wsRoot) as Layer.Layer<unknown, unknown, never>,
      )
      expect(resolved).toBe(true)
    })

    it("EITHER legacy OR V2, never both (wake)", async () => {
      const wsRoot = mkdtempSync(join(tmpdir(), "wake-cutover-"))
      seedWorkspaceDb(wsRoot)
      const legacyOn = await markerResolves(
        WakeCron,
        buildWake(false, wsRoot) as Layer.Layer<unknown, unknown, never>,
      )
      const v2On = await markerResolves(
        WakeCron,
        buildWake(true, wsRoot) as Layer.Layer<unknown, unknown, never>,
      )
      expect(legacyOn).not.toBe(v2On)
      expect(legacyOn).toBe(true)
      expect(v2On).toBe(false)
    })
  })
})
