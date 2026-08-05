/**
 * survey-boot.smoke.ts — boot-risk verification for D3 (Survey resolution).
 *
 * `chat-server.ts` (apps/server/src, S09) has a tsc gate, but tsc cannot see
 * whether a Layer.provide composition actually resolves at runtime - a missing
 * service in the Survey layer graph still crashes the WHOLE boot with no type
 * error. This smoke PROVES buildSurveyLayer builds in a ManagedRuntime by
 * importing the REAL exported factory - NOT a hand-copied mirror. A typo /
 * missing-import / mis-named layer in the actual edited code makes THIS smoke
 * FAIL.
 *
 * Node-runnable doubles:
 *   - AlignmentStore.Memory (no bun:sqlite / LunaSqliteBootstrap needed)
 *   - BeliefWriter.Default over a Ref-backed FakeMemory MemoryRouter
 *   - Clock.Default
 *
 * Regression guard: removing Layer.provide(FakeMem) from the opts (the
 * memoryRouterL analogue) MUST make this smoke FAIL with a missing-MemoryRouter
 * defect — Survey.Default + BeliefWriter.Default both yield* MemoryRouterTag.
 * Verify once (delete → FAIL → restore) before committing.
 *
 * Run: bun run apps/ui-web/scripts/smoke/survey-boot.smoke.ts
 * Exit 0 = PASS, non-zero = FAIL (missing service → fix the Layer.provide chain).
 */
import { AlignmentStore, BeliefWriter, Clock, Survey } from "@luna/core"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { Effect, Layer, ManagedRuntime, Ref, Stream } from "effect"
import { buildSurveyLayer } from "../../../server/src/chat-server.js"

// ---------------------------------------------------------------------------
// Node-runnable doubles
// ---------------------------------------------------------------------------

/** Ref-backed in-memory MemoryRouter — no bun:sqlite required. */
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

// ---------------------------------------------------------------------------
// Build the layer under test — SAME factory the live boot uses
// ---------------------------------------------------------------------------

// AlignmentStore.Memory (R = Clock) and BeliefWriter.Default over FakeMem swap
// in for the SQLite-backed layers (R = Clock + LunaSqliteBootstrap). Both
// satisfy their tags so the dep graph composes identically to live boot.
// `as never` sidesteps param-type narrowing — same pattern as dream-cron smoke.
const beliefWriterDouble = BeliefWriter.Default.pipe(
  Layer.provide(FakeMem),
  Layer.provide(Clock.Default),
) as never

const layer = buildSurveyLayer({
  alignmentStoreL: AlignmentStore.Memory as never,
  beliefWriterL: beliefWriterDouble,
  memoryRouterL: FakeMem as never,
  clockL: Clock.Default,
})

// ---------------------------------------------------------------------------
// The assertion: resolve Survey (forces the layer to build) + cold-start check
// ---------------------------------------------------------------------------

const main = Effect.gen(function* () {
  const survey = yield* Survey
  // Cold start: no task_quality rows → lastSurveyAt = 0 → due immediately.
  // Proves the resolved handle is live, not just present.
  const pending = yield* survey.pendingSurvey(Date.now())
  console.log(
    "[smoke] Survey resolved; cold-start pending =",
    pending !== null ? `${pending.items.length} item(s)` : "null",
  )
  if (pending === null) {
    throw new Error(
      "[smoke] FAIL — cold-start survey should be DUE (no task_quality rows yet)",
    )
  }
  if (!pending.items.some((i) => i.kind === "task_quality")) {
    throw new Error(
      "[smoke] FAIL — cold-start survey must include a task_quality item (D-LOCK-2 precondition)",
    )
  }
})

const rt = ManagedRuntime.make(layer)
rt.runPromise(main)
  .then(() => rt.dispose())
  .then(() => {
    console.log(
      "[smoke] PASS — Survey layer builds (AlignmentStore + BeliefWriter + MemoryRouter + Clock satisfied)",
    )
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error("[smoke] FAIL — Survey layer build defect:", err)
    process.exit(1)
  })
