/**
 * dream-cron-boot.smoke.ts — boot-risk verification for D1.
 *
 * chat-server.ts has NO tsc gate (root tsconfig excludes apps/ui-web/**;
 * the file is in scripts/, Bun-transpiled), so a missing service in the
 * layer graph crashes the WHOLE boot. This smoke PROVES the cron layer
 * builds correctly with a ManagedRuntime by importing the REAL exported
 * `buildDreamCronLayer` factory — not a hand-copied mirror. A typo or
 * missing import in the actual edited code makes THIS smoke FAIL.
 *
 * Spec-delta #1 split:
 *   - Real `DreamReasonerDefault` (keeps SDKClient + MemoryRouter requirements
 *     intact — proves the wiring shape the live boot uses)
 *   - `SDKClient.fake` so ZERO model calls are made (cron never fires during
 *     a layer build, so reason() is never invoked anyway)
 *   - Node-runnable doubles: DreamStore.Memory + Ref-backed FakeMemoryRouter +
 *     SessionStore.Default + Clock.Default (no bun:sqlite needed)
 *
 * Regression guard: removing `Layer.provide(sdkFake)` (or `Layer.provide(FakeMem)`)
 * from the opts MUST make this smoke FAIL with a missing-service defect —
 * that is the proof it guards the real SDKClient+MemoryRouter wiring shape.
 *
 * Run: bun run apps/ui-web/scripts/smoke/dream-cron-boot.smoke.ts
 * Exit 0 = PASS, non-zero = FAIL (missing service in graph → fix Layer.provide chain)
 */
import {
  CalibrationStore,
  Clock,
  DreamCron,
  DreamStore,
  SessionStore,
  AccountBroker,
  AccountBrokerLayer,
  EnvSecretProvider,
  CLAUDE_CODE_LOGIN_SECRET_REF,
} from "@luna/core"
import { DreamReasonerDefault, SDKClient } from "@luna/adapter-sdk"
import type { Query } from "@luna/adapter-sdk"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { Effect, Layer, ManagedRuntime, Ref, Stream } from "effect"
import { buildDreamCronLayer } from "../chat-server.js"

// ---------------------------------------------------------------------------
// Node-runnable doubles
// ---------------------------------------------------------------------------

/** Ref-backed in-memory MemoryRouter — no bun:sqlite required */
const FakeMem = Layer.effect(
  MemoryRouterTag,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<string, MemoryRecord>>(new Map())
    return {
      put: (r: MemoryRecord) => Ref.update(store, (m) => new Map(m).set(r.id, r)),
      get: (id: string) => Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
      delete: () => Effect.succeed(false),
      query: () => Stream.empty,
      search: () => Stream.empty,
    } as never
  }),
)

/**
 * Canned, model-free Query. The cron does NOT fire during a layer build,
 * so reason() is never invoked — but DreamReasonerDefault.SDKClient must
 * be satisfiable, which is exactly what this smoke proves.
 */
const sdkFake: Layer.Layer<SDKClient> = SDKClient.fake(() => {
  async function* gen(): AsyncGenerator<never> {
    // never yields — reason() is never called during a layer build
  }
  return gen() as unknown as Query
})

/**
 * Seeded fake AccountBroker (A8): DreamReasonerDefault now requires AccountBroker.
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

// dreamStoreL = DreamStore.Memory (node-runnable, no bun:sqlite / LunaSqliteBootstrap).
// The live boot passes DreamStore.makeLayer(paths.lunaDbPath) here; both satisfy
// the DreamStore tag so DreamCronLayer composes identically.
const layer = buildDreamCronLayer({
  expr: "0 3 * * *",
  sdkClientL: sdkFake,
  memoryRouterL: FakeMem,
  storeL: SessionStore.Default,
  clockL: Clock.Default,
  dreamStoreL: DreamStore.Memory,
  // MEASURE-ONLY calibration sink (PR #100): the live boot passes
  // CalibrationStore.makeLayer(lunaDbPath); the smoke uses the node-runnable
  // Memory layer to prove the Layer.provide(calibrationStoreL) branch builds.
  calibrationStoreL: CalibrationStore.Memory.pipe(Layer.provide(Clock.Default)),
  brokerL: brokerFake,
})

// ---------------------------------------------------------------------------
// The assertion: resolve DreamCron marker (forces the layer to build)
// ---------------------------------------------------------------------------

const main = Effect.gen(function* () {
  const marker = yield* DreamCron
  console.log(
    "[smoke] DreamCron marker resolved; expr =",
    marker.expr,
    "triggerId =",
    marker.triggerId,
  )
  if (marker.expr !== "0 3 * * *") {
    throw new Error(`[smoke] FAIL — expected expr "0 3 * * *", got "${marker.expr}"`)
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
      "[smoke] PASS — dream cron layer builds with the real DreamReasonerDefault graph (SDKClient + MemoryRouter satisfied)",
    )
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error("[smoke] FAIL — layer build defect:", err)
    process.exit(1)
  })
