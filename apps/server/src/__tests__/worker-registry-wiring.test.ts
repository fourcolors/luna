/**
 * worker-registry-wiring.test.ts — integration test for M3 (scheduler-v2
 * dream/wake migration): the chat-server's V2 worker registry must register
 * the dream + wake worker kinds alongside the generic prompt + workflow
 * workers, so a JobTicker draining the `jobs` table can dispatch `kind='dream'`
 * and `kind='wake'` rows.
 *
 * This asserts the SAME factory the live boot uses (`buildWorkerRegistryLayer`,
 * exported from chat-server.ts) — built here with in-memory / fake leaf layers
 * (no SDKClient model calls, no SQLite, no real workspace.db) so the wiring is
 * proven composable + the kind set is correct without booting the server.
 *
 * Mirrors the standalone prompt-worker-boot.smoke.ts pattern, promoted into the
 * vitest suite (apps/ui-web/scripts/__tests__) so it runs in CI.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Ref, Stream } from "effect"
import {
  AgentNotesService,
  Clock,
  DreamStore,
  FakeReasoner,
  FakeWakeReasoner,
  SessionStore,
  WakeLogStore,
  WorkerRegistry,
  makeWorkerRegistry,
} from "@luna/core"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { SDKClient } from "@luna/adapter-sdk"
import type { Query } from "@luna/adapter-sdk"
import type { WakeDigest } from "@luna/core"
import { buildWorkerRegistryLayer } from "../chat-server.js"

// SDK fake: never invoked (no jobs drained here), but satisfies the prompt /
// workflow worker layers' SDKClient requirement.
const sdkFakeL: Layer.Layer<SDKClient> = SDKClient.fake(() => {
  async function* gen(): AsyncGenerator<never> {}
  return gen() as unknown as Query
})

// Minimal Ref-backed memory router double (mirrors dream-worker.test.ts).
const FakeMemoryEmpty = Layer.effect(
  MemoryRouterTag,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<string, MemoryRecord>>(new Map())
    return {
      put: (r: MemoryRecord) => Ref.update(store, (m) => new Map(m).set(r.id, r)),
      get: (id: string) => Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
      delete: (id: string) =>
        Ref.modify(store, (m) => {
          const had = m.has(id)
          const next = new Map(m)
          next.delete(id)
          return [had, next]
        }),
      query: () => Stream.empty,
      search: () => Stream.empty,
    } as never
  }),
)

const emptyDigest: WakeDigest = {
  workspaceSlug: "test",
  observations: [],
  pickedActionId: null,
  pickedReason: "noop",
  proposedActions: [],
}

const clockL = Clock.Default

const workerRegistryL = buildWorkerRegistryLayer({
  clockL,
  sdkClientL: sdkFakeL,
  agentNotesL: AgentNotesService.Memory.pipe(Layer.provide(clockL)),
  // dream leaf deps
  dreamStoreL: DreamStore.Memory,
  dreamReasonerL: FakeReasoner.of([]),
  sessionStoreL: SessionStore.Default,
  memoryRouterL: FakeMemoryEmpty,
  // wake leaf deps
  wakeReasonerL: FakeWakeReasoner.of(emptyDigest),
  wakeLogStoreL: WakeLogStore.Memory,
})

describe("buildWorkerRegistryLayer (M3 boot wiring)", () => {
  it("registers prompt + workflow + dream + wake worker kinds", async () => {
    const kinds = await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* WorkerRegistry
        return yield* reg.listKinds
      }).pipe(Effect.provide(workerRegistryL)),
    )
    expect([...kinds]).toEqual(
      expect.arrayContaining(["prompt", "workflow", "dream", "wake"]),
    )
  })

  it("includes BOTH dream and wake (the M3 cutover prerequisites)", async () => {
    const kinds = await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* WorkerRegistry
        return yield* reg.listKinds
      }).pipe(Effect.provide(workerRegistryL)),
    )
    expect([...kinds]).toContain("dream")
    expect([...kinds]).toContain("wake")
  })
})
