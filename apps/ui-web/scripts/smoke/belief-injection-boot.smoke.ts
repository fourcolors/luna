/**
 * belief-injection-boot.smoke.ts — boot-risk verification for D5.
 *
 * chat-server.ts has NO tsc gate (root tsconfig excludes apps/ui-web/**;
 * the file is in scripts/, Bun-transpiled), so a missing service in the
 * layer graph crashes the WHOLE boot. This smoke PROVES the thread-tools
 * layer builds correctly by importing the REAL exported
 * `ThreadToolsProviderLayer` factory — not a hand-copied mirror. A typo
 * or missing import in the actual edited code makes THIS smoke FAIL.
 *
 * Two assertions (per the BOOT-GATING CORRECTION):
 *   (a) decorate() does NOT throw at runSync — the load-bearing check.
 *       A missing MemoryRouterTag in the layer causes the layer build
 *       (or decorate) to blow up. Removing Layer.provide(seededMem)
 *       MUST make this smoke FAIL with a missing-MemoryRouter defect.
 *   (b) The returned systemPrompt contains "## What I believe about Operator"
 *       when one ACTIVE belief is seeded in the Ref-backed FakeMemory.
 *
 * Regression-guard discipline: verified ONCE that removing
 * Layer.provide(seededMem) makes the smoke FAIL → restored.
 *
 * Run: bun run apps/ui-web/scripts/smoke/belief-injection-boot.smoke.ts
 * Exit 0 = PASS, non-zero = FAIL
 */
import { Clock, makeBeliefRecord, ObservabilityService } from "@luna/core"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { LunaSqliteBootstrapLive } from "@luna/memory"
import { ThreadToolsProviderTag } from "@luna/chat-service"
import { Effect, Layer, ManagedRuntime, Ref, Stream } from "effect"
import { ThreadToolsProviderLayer } from "../chat-server.js"

// ---------------------------------------------------------------------------
// One seeded ACTIVE belief
// ---------------------------------------------------------------------------

const seeded = makeBeliefRecord({
  statement: "Operator prefers terse answers",
  confidence: 0.9,
  domain: "comms",
  status: "active",
  now: 0,
})

// ---------------------------------------------------------------------------
// Ref-backed FakeMemory that returns the seeded belief on query()
// ---------------------------------------------------------------------------

const seededMem = Layer.effect(
  MemoryRouterTag,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<string, MemoryRecord>>(
      new Map([[seeded.id, seeded]]),
    )
    return {
      put: (r: MemoryRecord) =>
        Ref.update(store, (m) => new Map(m).set(r.id, r)),
      get: (id: string) =>
        Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
      delete: () => Effect.succeed(false),
      query: () =>
        Stream.unwrap(
          Ref.get(store).pipe(
            Effect.map((m) => Stream.fromIterable(Array.from(m.values()))),
          ),
        ),
      search: () => Stream.empty,
      // MemoryRouter interface also requires backendFor + exportAll in the
      // full router, but ThreadToolsProviderLayer only calls query() for the
      // belief snapshot and put()/get() never — cast to satisfy the tag.
    } as never
  }),
)

// ---------------------------------------------------------------------------
// Minimal obs layer (needed by MemoryToolsLayer() inside ThreadToolsProviderLayer)
// ---------------------------------------------------------------------------

const clockL = Clock.Default
const obsL = ObservabilityService.makeLayer({
  logToConsole: false,
  jsonlPath: "/tmp/luna-smoke-belief-obs.jsonl",
}).pipe(Layer.provide(clockL))

// ---------------------------------------------------------------------------
// Build the REAL provider layer — same provide-chain shape as the live boot.
// Removing Layer.provide(seededMem) MUST make this smoke FAIL.
// ---------------------------------------------------------------------------

const threadToolsL = ThreadToolsProviderLayer().pipe(
  Layer.provide(seededMem), // ← regression guard: remove this → MUST FAIL (Service not found: luna/MemoryRouter)
  Layer.provide(obsL),
  Layer.provide(clockL),
  Layer.provide(LunaSqliteBootstrapLive), // needed by MemoryToolsLayer + ObsToolsLayer internally
)

// ---------------------------------------------------------------------------
// Main assertion
// ---------------------------------------------------------------------------

const main = Effect.gen(function* () {
  // (a) resolve the provider — forces the layer build (MemoryRouterTag must
  //     be satisfied or this throws with a missing-service defect)
  const provider = yield* ThreadToolsProviderTag

  // (b) call decorate() synchronously — it must not throw
  const binding = provider.decorate({} as never)

  // (c) assert the beliefs section is present
  const sp = binding.systemPrompt ?? ""
  if (!sp.includes("## What I believe about Operator")) {
    throw new Error(
      `[smoke] beliefs section missing from decorate() output.\n` +
        `systemPrompt (first 500 chars): ${sp.slice(0, 500)}`,
    )
  }
  console.log("[smoke] decorate() systemPrompt contains '## What I believe about Operator' ✓")
})

const rt = ManagedRuntime.make(threadToolsL)
rt.runPromise(main)
  .then(() => rt.dispose())
  .then(() => {
    console.log(
      "[smoke] PASS — real ThreadToolsProviderLayer builds (MemoryRouterTag satisfied) + active belief injected into systemPrompt",
    )
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error("[smoke] FAIL:", err)
    process.exit(1)
  })
