# Alignment Loop — Phase 3 Live Wiring: Reasoner + Cron + Belief Injection + Survey UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the alignment loop actually *turn*. Phase 3's pure/library backend is merged (`packages/core/src/alignment/` — `Survey.processVerdict`/`nextSurvey`, `AlignmentStore`, `cadence`; `BeliefWriter.recordValidation`). What is missing is the *live* wiring that turns the crank: a model-backed **Dream reasoner** (D2) so the nightly job produces real ops instead of fixtures; the **Dream cron** wired into the live server boot (D1) so reflection actually fires; **active-belief injection** into the thread system prompt (D5, the deferred Phase-2 Task 7, now non-empty because the survey can activate beliefs); and a **TUI survey surface** (D3) so a human can produce the `SurveyVerdict`s the backend already consumes. Build order respects dependencies: **D2 (reasoner) → D1 (cron, wires the real reasoner) → D5 (injection) → D3 (survey UI)**. Phase 4 outreach emitter (D4) and the telemetry read-API (D6) remain OUT of scope.

**Architecture:** D2 adds a real model-backed `DreamReasoner` layer in **`packages/adapter-sdk/src/dream-reasoner.ts`** (NEW file) — NOT in `core`. ⚠️ **CYCLE CORRECTION (overrides any "core/dream/reasoner.ts" reference below):** `adapter-sdk` already depends on `@luna/core` (`workspace:*`) and core does NOT depend on adapter-sdk; adding a `SDKClient`-using `Default` to `core/dream/reasoner.ts` would create a forbidden `core → adapter-sdk → core` cycle. So the `DreamReasoner` **Tag + `FakeReasoner` stay in `core/dream/reasoner.ts` (port-only, unchanged)**, and the model-backed layer (e.g. `export const DreamReasonerDefault: Layer.Layer<DreamReasoner, never, SDKClient | MemoryRouter>`) lives in `adapter-sdk`, acquiring `SDKClient` + `MemoryRouterTag` at layer-build and closing over them so the returned `reason` effect has `R = never` (matches `DreamReasonerApi`, which has no R channel). This requires **adding `@luna/memory` to `adapter-sdk/package.json` dependencies** (`workspace:*`) for `MemoryRouterTag`/`MemoryRecord` (needed for the before-snapshot query). adapter-sdk HAS a tsc gate + vitest, so D2 is verified by `tsc` + its suite — no boot smoke. D1 adds a self-contained `DreamCronLayer` to `packages/core/src/dream/` — a `Layer.scoped` that, exactly like the merged `SchedulerToolsLayer` (`packages/scheduler-tools/src/layer.ts:100-129`), provides its own `JobSchedulerLayer.make` + `TriggerAgentLayer.Default` + dream deps, resolves `TriggerAgent`, captures `Effect.scope`, and calls `registerDreamCron(trigger, expr)` at layer-build time so the supervised cron fibers outlive the build; chat-server's boot change is then a one-line `Layer.mergeAll` addition. D5 keeps `ThreadToolsProvider.decorate`'s **synchronous** contract (`packages/chat-service/src/types.ts:227`) by holding a boot-populated `Ref`/array snapshot of active beliefs the sync `decorate` reads via `composeBeliefsSection`. D3 adds a TUI survey surface that reads the next-survey schedule and calls `Survey.processVerdict`.

**Tech Stack:** Effect-TS v3, Bun, `bun:sqlite`, `@luna/memory` (`MemoryRouterTag`, `MemoryRecord`), `@luna/core` (`Clock`, `DreamReasoner`, `registerDreamCron`, `DreamStore`, `SessionStore`, `TriggerAgent`, `JobScheduler`, `Survey`, `composeBeliefsSection`, `BELIEF_NAMESPACE`, `BELIEF_KIND`), `@luna/adapter-sdk` (`SDKClient`, `@anthropic-ai/claude-agent-sdk` `query`). Tests: Vitest with `TestClock`/`TestContext` (cron), Ref-backed fakes (reasoner/injection), and — for every boot-risk surface — a **runnable `ManagedRuntime` layer-build smoke harness**, NOT tsc and NOT eyeballing.

**Source-of-truth spec:** `docs/superpowers/specs/2026-05-28-luna-alignment-loop-design.md` (§2.3 category boundary, §2.4 graduated autonomy ladder, §3.1 Dream engine + cron, §3.2 belief injection, §3.3 survey surface, §7.3 Phase 3 + cron-as-final-discrete-task). Builds on Phase 1 (`packages/core/src/dream/`), Phase 2 (`packages/core/src/beliefs/`), and the Phase 3 backend slice (`packages/core/src/alignment/`), all merged to `dev`. The verified Phase-2 Task 7 belief-injection recipe lives in `docs/superpowers/plans/2026-05-28-alignment-loop-phase2-beliefs.md` (Task 7 banner, lines 842-892).

> **Synthesis note (load-bearing — read before executing):** This drive referenced "design findings + a critic's refutations/gaps." The **critic's artifact was not present in this author's context** (same situation the Phase-3 survey-plan author flagged). This plan therefore synthesizes from the spec plus **verified live source read this session** — every load-bearing claim below was confirmed by reading the actual code, with file paths + line numbers cited, not assumed. Where the spec/banner and the live code conflicted, the **live code wins** and the conflict is called out (most importantly: `decorate` is synchronous, so the Phase-2 banner's "move the fetch into `decorate()`" is NOT a one-liner — see Task 5 / openConcern).

---

## Spec deltas / decisions locked by this plan

Concrete, internally consistent defaults so they do not block. Tunables; the human may retune. The load-bearing *constraints* (boot cannot break; reasoner output validated; category boundary preserved) are enforced by tests.

1. **D2-first, but the real reasoner never enters a boot *smoke* test.** The build order is D2 (real `DreamReasoner.Default`) → D1 (cron wires the *real* reasoner into live boot). This is so the live cron is wired against the real reasoner exactly once. **But the D1 layer-build smoke harness injects `FakeReasoner.of([])`** — a boot smoke test must not make model calls (latency/cost/non-determinism). State this split per task: real `DreamReasoner.Default` in the live boot layer; `FakeReasoner` in the smoke harness and the cron unit test.

2. **The Dream cron lives in `packages/core`, not chat-server.** `DreamCronLayer` is authored in `packages/core/src/dream/dream-cron-layer.ts` (tsc-covered, vitest-covered) as a self-contained scoped layer that produces a marker tag (`DreamCron`) so `Layer.mergeAll` is forced to build it and the smoke test has a service to assert. chat-server's untested surface shrinks to **one line**: import `DreamCronLayer` and add it to the `buildBaseLayer` final `Layer.mergeAll` (`chat-server.ts:502-513`). This is precedented: a *second* `JobScheduler`/`TriggerAgent` instance is created (the first is encapsulated inside `SchedulerToolsLayer`); harmless, exactly like the second `memoryRouterL` instance already in the boot graph (`chat-server.ts:474`, comment lines 466-473).

3. **Default cron cadence = nightly `0 3 * * *`** (§8 default "nightly"; §3.1 "nightly / on idle"). 5-field cron, the format `registerDreamCron` already takes and `dream-cron.test.ts` exercises (`"0 * * * *"`).

4. **`decorate` is SYNCHRONOUS — belief injection uses a boot-populated snapshot, not a per-thread async fetch.** VERIFIED: `ThreadToolsProvider.decorate: (opts: CreateThreadOptions) => ThreadToolsBinding` (`packages/chat-service/src/types.ts:227`) returns a plain binding, and is invoked synchronously inside ChatService's `createThread` `Effect.gen` (`chat-service.ts:379-381`). An async `mem.query(...)` (Stream/Effect) **cannot** run inside that sync closure. So the Phase-2 banner's "move the fetch into `decorate()`" is reinterpreted: the provider's `Effect.gen` (which IS in an Effect context, at layer build) populates a `Ref<readonly MemoryRecord[]>` (or a `let` snapshot) with active beliefs at boot; `decorate` reads that snapshot **synchronously** and renders it via `composeBeliefsSection`. Per-thread freshness (a just-activated belief appearing in the *next* thread without a restart) requires an out-of-band refresh of the snapshot — deferred as an openConcern, NOT silently dropped. v1 D5 ships boot-snapshot injection (a just-activated belief appears after the next boot), which is strictly better than Phase-2's always-empty section and carries the same boot-risk profile.

5. **D2's reasoner output is schema-validated; a parse failure fails the `DreamError` channel, never crashes the cron.** The real reasoner prompts the model for a strict JSON `DreamOp[]`, collects the assistant text from the `SDKClient` `Query` stream, and parses+validates it. Malformed output → `Effect.fail(new DreamError(...))`; the cron job's `run` effect already isolates per-tick failures (the scheduler fiber pool catches them — see `dream-cron.test.ts` which tolerates `Exit.isFailure`). The reasoner must NOT emit op kinds outside `DreamOpKind`, and (per §2.3 category boundary) belief candidates may only derive from transcripts — enforced by the prompt + a post-parse filter test.

6. **Survey surface scope = TUI-first (D-decision-1).** D3 builds the TUI surface only; web/Tauri follow once the verdict→backend contract is proven live. This is the smallest boot-risk surface and matches Mr. Cobb's prior choice (survey UI = TUI-first).

7. **Mergeable incrementally.** D2 is core-only, zero boot risk → lands to `dev` independently. D1 requires D2 merged (it wires the *real* reasoner) and its own ManagedRuntime smoke green. D5 is independent of D1/D2 (it only needs Phase-2 `composeBeliefsSection` + the survey's ability to activate beliefs, already merged) and lands on its smoke green. D3 is independent and gated on D-decision-1 (TUI-first, locked above). None must land together; each lands when its verification passes.

---

## ⚠️ BOOT-GATING CORRECTION (mandatory — overrides the smoke-test approach in Tasks 3/4/5)

The adversarial critic returned **`bootRiskAdequatelyGated: FALSE`**. The smoke tests as originally drafted are *mirror-theater* — they build a hand-copied reconstruction of the boot layer, not the edited file, so they CANNOT catch the typo / missing-import / mis-named-layer class that actually crashes the no-tsc-gate `chat-server.ts` boot. On the boot-risk surface a mirror smoke is **worse than no smoke** (false green). Every boot-risk task (Tasks 3, 4, 5) MUST adopt these three fixes:

1. **Export the REAL composition function from `chat-server.ts` and smoke-test THAT — never a mirror.** `buildBaseLayer` (`chat-server.ts:374`) is a bare `const`; the new `DreamCronLayer`/`ThreadToolsProviderLayer` factories likewise. **Verified safe to export:** `buildBaseLayer(opTokens)` is pure layer-composition returning a `Layer.Layer<…>` value — it does NOT bind ports or start the server (that happens at `chat-server.ts:649–651` via `ManagedRuntime.make` + SIGINT handlers, *after* and *outside* `buildBaseLayer`). So `export const buildBaseLayer` / `export ThreadToolsProviderLayer` is additive and behavior-preserving (precedent: `loadDna` is already exported at :164). The smoke `import`s the real exported symbol and builds it — so a missing/mis-named layer in the actual edited code makes the smoke FAIL.
2. **Composition smoke uses NODE-RUNNABLE Memory doubles — no `isBun ? describe : describe.skip`.** A `bun:sqlite`/`LunaSqliteBootstrapLive` smoke silently SKIPS under node-vitest (the `sqlite.test.ts:8-9` pattern), giving zero protection in the default test path. Use `DreamStore.Memory` + a Ref-backed `FakeMemory` MemoryRouter + `SessionStore.Default` + `FakeReasoner` + `Clock.Default` (the exact node-runnable doubles `dream-cron.test.ts` already uses) so the missing-service assertion runs in the normal path. (A SQLite variant may ADDITIONALLY run under bun, but must not be the only gate.)
3. **Assert `decorate()` does not THROW at `runSync` (D5), not merely that the prompt contains the belief.** The failure mode is the sync `decorate` blowing up when its layer requirement is unsatisfied — assert it runs cleanly AND contains `## What I believe about Operator`.

**Regression-guard discipline:** for each boot smoke, verify ONCE that removing the load-bearing wiring line (the `Layer.provide(memoryRouterL)` on `threadToolsL` for D5; the `DreamCronLayer` mergeAll entry for D1) makes the smoke FAIL with a missing-service defect — then restore. A smoke that passes with the wiring removed is not guarding anything.

**Decision locked (forced, not optional): belief injection is BOOT-SNAPSHOT in v1, not per-thread.** `ThreadToolsProvider.decorate` is SYNCHRONOUS (`chat-service/src/types.ts:227`, called sync at `chat-service.ts:379–381`), so a per-thread async `mem.query` is impossible. v1 fetches active beliefs at boot into a snapshot and renders synchronously via `composeBeliefsSection`. **Consequence (disclose, don't fix in v1):** a survey-activated belief appears only after the next server restart; per-thread freshness is a ~15-line background Ref-refresh fiber, an explicit follow-on OUT of v1 scope.

**D3 (TUI survey) is GROUND-THEN-REASSESS, not auto-build.** Its app layout is ungrounded and it needs a *triggering* mechanism (something must poll `nextSurvey()` to know when to surface a survey) — that is more than a UI component. Task 5 Step 0 MUST Read the TUI entrypoint + layer-assembly seam first; if it needs a poll loop or a new screen/route, STOP and surface for its own plan rather than forcing it into this drive.

---

## File structure

New (core, tsc + vitest covered):
- `packages/core/src/dream/reasoner.ts` — **modified**: add `DreamReasoner.Default` (model-backed, over `SDKClient`) alongside the existing `FakeReasoner`.
- `packages/core/src/dream/reasoner.test.ts` — **modified**: add parse/validation + category-boundary tests for the real reasoner using a fake `SDKClient`.
- `packages/core/src/dream/dream-cron-layer.ts` — **new**: `DreamCronLayer(expr)` self-contained scoped layer + `DreamCron` marker tag; mirrors `SchedulerToolsLayer`.
- `packages/core/src/dream/dream-cron-layer.test.ts` — **new**: `ManagedRuntime`/`TestClock` layer-build + registration-fires smoke (mirrors `dream-cron.test.ts`).
- `packages/core/src/dream/index.ts` — **modified**: export `dream-cron-layer.js`.

New (TUI surface, D3):
- TUI survey component + a thin controller calling `Survey.nextSurvey` / `Survey.processVerdict` (exact path determined in Task 7 after grounding the TUI app layout).

Modified (boot-risk — apps/ui-web, NO tsc gate):
- `apps/ui-web/scripts/chat-server.ts` — D1: one-line add `DreamCronLayer(...)` to `buildBaseLayer`'s final `Layer.mergeAll` + its dream-dep providers. D5: belief-snapshot Ref in `ThreadToolsProviderLayer`'s `Effect.gen` + sync read in `decorate` + `Stream`/`composeBeliefsSection`/`MemoryRouterTag` imports.

New (boot-risk verification — runnable smoke scripts, NOT tsc):
- `apps/ui-web/scripts/smoke/dream-cron-boot.smoke.ts` — `ManagedRuntime.make(layer)` → build → dispose, asserts no missing-service defect with `FakeReasoner`.
- `apps/ui-web/scripts/smoke/belief-injection-boot.smoke.ts` — seeds one ACTIVE belief, asserts `threadToolsL` builds and `decorate()` output contains the beliefs section.

---

# Build order: D2 → D1 → D5 → D3

---

## Task 1 (D2): Real model-backed `DreamReasoner.Default`

**Boot risk: NO** (core-only, tsc + vitest covered). Net-new model wiring + prompt design + output validation. Lands to `dev` independently.

**Files:**
- Modify: `packages/core/src/dream/reasoner.ts`
- Modify: `packages/core/src/dream/reasoner.test.ts`

**Grounding (verified this session):**
- `DreamReasonerApi.reason(inputs: DreamInputs) => Effect.Effect<ReadonlyArray<DreamOp>, DreamError>` (`packages/core/src/dream/types.ts:72-76`).
- `DreamOp` = `{ kind: DreamOpKind; targetId; before: unknown; after: unknown; rationale: string }`; `DreamOpKind` ∈ `memory_dedup | memory_staleness | memory_contradiction | belief_candidate` (`types.ts:9-25`).
- The model client is the `SDKClient` port: `SDKClient.query(params) => Effect.Effect<Query, never>`, `Query` is an async-iterable of `SDKMessage` plus a control handle; real layer wraps `@anthropic-ai/claude-agent-sdk` `query` (`packages/adapter-sdk/src/sdk-client.ts:43-69`). `SDKClient.fake(build)` supplies a deterministic `Query` for tests (`sdk-client.ts:62-68`).
- `FakeReasoner.of(ops)` stays unchanged (`reasoner.ts:9-13`).

- [ ] **Step 1: Write the failing test** (add to `packages/core/src/dream/reasoner.test.ts`)

```typescript
import { describe, expect, it } from "vitest"
import { Effect, Layer, Stream } from "effect"
import { SDKClient } from "@luna/adapter-sdk"
import type { SDKMessage } from "@luna/adapter-sdk"
import { DreamReasoner } from "./reasoner.js"
import type { DreamInputs } from "./types.js"

const EMPTY_INPUTS: DreamInputs = { sessions: [], memories: [] }

// A fake SDKClient whose Query yields a single assistant message carrying `text`.
const fakeClient = (text: string): Layer.Layer<SDKClient> =>
  SDKClient.fake(() => {
    async function* gen(): AsyncGenerator<SDKMessage> {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text }] },
      } as unknown as SDKMessage
      yield { type: "result", subtype: "success" } as unknown as SDKMessage
    }
    const q = gen() as unknown as import("@luna/adapter-sdk").Query
    return q
  })

const run = <A, E>(eff: Effect.Effect<A, E, DreamReasoner>, sdkText: string) =>
  Effect.runPromise(
    eff.pipe(Effect.provide(DreamReasoner.Default), Effect.provide(fakeClient(sdkText))),
  )

describe("DreamReasoner.Default — model-backed", () => {
  it("parses a well-formed JSON op array from the model", async () => {
    const json = JSON.stringify([
      { kind: "belief_candidate", targetId: "belief:abc", before: null, after: { id: "belief:abc" }, rationale: "operator prefers terse" },
    ])
    const ops = await run(
      Effect.gen(function* () {
        const r = yield* DreamReasoner
        return yield* r.reason(EMPTY_INPUTS)
      }),
      json,
    )
    expect(ops).toHaveLength(1)
    expect(ops[0]?.kind).toBe("belief_candidate")
  })

  it("rejects ops with an unknown kind (DreamError, never a crash)", async () => {
    const json = JSON.stringify([{ kind: "delete_everything", targetId: "x", before: null, after: null, rationale: "no" }])
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const r = yield* DreamReasoner
        return yield* r.reason(EMPTY_INPUTS)
      }).pipe(Effect.provide(DreamReasoner.Default), Effect.provide(fakeClient(json))),
    )
    expect(exit._tag).toBe("Failure")
  })

  it("malformed (non-JSON) model output fails the DreamError channel", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const r = yield* DreamReasoner
        return yield* r.reason(EMPTY_INPUTS)
      }).pipe(Effect.provide(DreamReasoner.Default), Effect.provide(fakeClient("not json at all"))),
    )
    expect(exit._tag).toBe("Failure")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run packages/core/src/dream/reasoner.test.ts`
Expected: FAIL — `DreamReasoner.Default` does not exist.

- [ ] **Step 3: Write the implementation** (`packages/core/src/dream/reasoner.ts`)

```typescript
import { Effect, Layer, Stream } from "effect"
import { SDKClient } from "@luna/adapter-sdk"
import type { SDKMessage } from "@luna/adapter-sdk"
import { DreamError } from "./types.js"
import type { DreamInputs, DreamOp, DreamOpKind, DreamReasonerApi } from "./types.js"

export class DreamReasoner extends Effect.Tag("luna/DreamReasoner")<
  DreamReasoner,
  DreamReasonerApi
>() {
  /**
   * Model-backed reasoner. Builds a prompt from DreamInputs (transcripts →
   * belief candidates + memory hygiene; memories = current state to reconcile —
   * the §2.3 category boundary lives in the PROMPT and a post-parse filter),
   * calls the SDK, collects the assistant text, and parses a strict JSON
   * DreamOp[]. Any parse/validation failure → DreamError (never a crash; the
   * cron's per-tick failure is isolated by the scheduler pool).
   */
  static readonly Default: Layer.Layer<DreamReasoner, never, SDKClient> = Layer.effect(
    DreamReasoner,
    Effect.gen(function* () {
      const sdk = yield* SDKClient
      const reason: DreamReasonerApi["reason"] = (inputs) =>
        Effect.gen(function* () {
          const prompt = buildPrompt(inputs)
          const query = yield* sdk.query({ prompt })
          const text = yield* collectAssistantText(query)
          return yield* parseOps(text)
        })
      return { reason } satisfies DreamReasonerApi
    }),
  )
}

/** Test/wiring double — returns a fixed op list, ignoring inputs. */
export const FakeReasoner = {
  of: (ops: ReadonlyArray<DreamOp>): Layer.Layer<DreamReasoner> =>
    Layer.succeed(DreamReasoner, { reason: () => Effect.succeed(ops) }),
} as const

const VALID_KINDS: ReadonlySet<string> = new Set<DreamOpKind>([
  "memory_dedup",
  "memory_staleness",
  "memory_contradiction",
  "belief_candidate",
])

function buildPrompt(inputs: DreamInputs): string {
  // §3.1 three reasoning targets, §2.3 category boundary stated explicitly.
  const sessions = inputs.sessions
    .map((s) => `SESSION ${s.summary.id} (${s.messages.length} msgs)`)
    .join("\n")
  const mems = inputs.memories.map((m) => `MEMORY ${m.id} kind=${m.kind}`).join("\n")
  return [
    "You are Luna's nightly Dream reasoner. Reflect over the sessions and current",
    "memory/beliefs below and propose state changes as a STRICT JSON array of ops.",
    "",
    "Rules (load-bearing):",
    "- Each op: {kind, targetId, before, after, rationale}.",
    `- kind ∈ ${[...VALID_KINDS].join(" | ")}.`,
    "- CATEGORY BOUNDARY: belief_candidate ops may ONLY derive from TRANSCRIPTS,",
    "  never from telemetry. Memories are the current state to reconcile against.",
    "- `after` is the idempotent desired end-state (null = delete the target).",
    "- Output ONLY the JSON array, no prose.",
    "",
    "SESSIONS:",
    sessions || "(none)",
    "",
    "CURRENT STATE:",
    mems || "(none)",
  ].join("\n")
}

function collectAssistantText(query: import("@luna/adapter-sdk").Query) {
  return Stream.fromAsyncIterable(query, (cause) => new DreamError({
    op: "reason", message: `SDK stream failed: ${String(cause)}`, cause,
  })).pipe(
    Stream.runFold("", (acc: string, msg: SDKMessage) => {
      const m = msg as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } }
      if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        for (const block of m.message!.content!) {
          if (block.type === "text" && typeof block.text === "string") acc += block.text
        }
      }
      return acc
    }),
  )
}

function parseOps(text: string): Effect.Effect<ReadonlyArray<DreamOp>, DreamError> {
  return Effect.try({
    try: () => {
      const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()
      const raw = JSON.parse(trimmed) as unknown
      if (!Array.isArray(raw)) throw new Error("model output is not a JSON array")
      return raw.map((o, i) => {
        const op = o as Partial<DreamOp>
        if (typeof op.kind !== "string" || !VALID_KINDS.has(op.kind)) {
          throw new Error(`op[${i}] has invalid kind: ${String(op.kind)}`)
        }
        if (typeof op.targetId !== "string" || typeof op.rationale !== "string") {
          throw new Error(`op[${i}] missing targetId/rationale`)
        }
        return {
          kind: op.kind as DreamOpKind,
          targetId: op.targetId,
          before: op.before ?? null,
          after: op.after ?? null,
          rationale: op.rationale,
        } satisfies DreamOp
      })
    },
    catch: (cause) => new DreamError({ op: "reason", message: `parse failed: ${String(cause)}`, cause }),
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run packages/core/src/dream/reasoner.test.ts`
Expected: PASS (3 new tests + any existing). Confirm `FakeReasoner` tests (if present) still pass.

- [ ] **Step 5: Typecheck (root project — packages/core + adapter-sdk are covered)**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx tsc --noEmit -p tsconfig.json`
Expected: no NEW errors from `packages/core/src/dream/`. The pre-existing `apps/agent-cli` JSX + DuckDB-test failures are the known baseline — do NOT assert a clean exit; confirm no new diagnostics originate in `dream/`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/dream/reasoner.ts packages/core/src/dream/reasoner.test.ts
git commit -m "feat(dream): model-backed DreamReasoner.Default over SDKClient — strict JSON op parse + validation"
```

---

## Task 2 (D1): `DreamCronLayer` — self-contained cron layer in core

**Boot risk: indirectly (this layer is built into the live boot in Task 3), but THIS task is core-only, tsc + vitest covered.** Mirrors the merged `SchedulerToolsLayer` (`packages/scheduler-tools/src/layer.ts:100-129`) exactly. The reasoner injected here is parameterized so the live boot (Task 3) uses `DreamReasoner.Default` while the smoke harness uses `FakeReasoner` (spec-delta #1).

**Files:**
- Create: `packages/core/src/dream/dream-cron-layer.ts`
- Create: `packages/core/src/dream/dream-cron-layer.test.ts`
- Modify: `packages/core/src/dream/index.ts`

**Grounding (verified this session):**
- `registerDreamCron(trigger: TriggerAgentApi, expr: string)` requires `DreamStore | DreamReasoner | SessionStore | MemoryRouter | Clock` in R, captured via `Effect.context` and baked into the cron job's `run` (`packages/core/src/dream/dream.ts:200-217`).
- `SchedulerToolsLayer` precedent: `Layer.scoped` resolving `TriggerAgent`, capturing `Effect.scope`, with `.pipe(Layer.provide(TriggerAgentLayer.Default), Layer.provide(JobSchedulerLayer.make({...})), Layer.provide(Clock.Default))` (`scheduler-tools/src/layer.ts:103-129`).
- `TriggerAgentLayer.Default` (`packages/core/src/jobs/trigger-agent.ts:249`) needs `JobScheduler`; `JobSchedulerLayer.make({capacity, offerPolicy})` (`job-scheduler.ts:245-248`) needs `Clock`.
- `DreamStore.makeLayer(dbPath): Layer.Layer<DreamStore, ConfigError, Clock | LunaSqliteBootstrap>` (`dream-store.ts:184-186`); `SessionStore.Default`.
- Cron-test pattern (TestClock fires the tick, watermark advances): `dream-cron.test.ts:79-144`.

- [ ] **Step 1: Write the failing test** (`packages/core/src/dream/dream-cron-layer.test.ts`)

```typescript
/**
 * dream-cron-layer.test.ts — Tier-1 unit test for DreamCronLayer.
 * Mirrors dream-cron.test.ts: build the layer (which registers the cron at
 * build time), then assert the DreamCron marker resolves AND advancing TestClock
 * fires one dream cycle (watermark advances). Uses FakeReasoner — no model calls.
 */
import { describe, expect, it } from "vitest"
import { Duration, Effect, Layer, Ref, Stream, TestClock, TestContext } from "effect"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { DreamStore } from "./dream-store.js"
import { FakeReasoner } from "./reasoner.js"
import { SessionStore } from "../session/session-store.js"
import { DreamCron, DreamCronLayer } from "./dream-cron-layer.js"

const FakeMemoryEmpty = Layer.effect(
  MemoryRouterTag,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<string, MemoryRecord>>(new Map())
    return {
      put: (r: MemoryRecord) => Ref.update(store, (m) => new Map(m).set(r.id, r)),
      get: (id: string) => Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
      delete: (id: string) => Ref.modify(store, (m) => { const had = m.has(id); const n = new Map(m); n.delete(id); return [had, n] }),
      query: () => Stream.empty,
      search: () => Stream.empty,
    } as never
  }),
)

// Dream deps the cron layer needs (it provides its own JobScheduler+TriggerAgent+Clock).
const dreamDeps = Layer.mergeAll(DreamStore.Memory, FakeReasoner.of([]), SessionStore.Default, FakeMemoryEmpty)

describe("DreamCronLayer", () => {
  it("(a) builds and exposes the DreamCron marker", async () => {
    const ok = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const marker = yield* DreamCron
          return marker.expr
        }).pipe(
          Effect.provide(DreamCronLayer("0 3 * * *")),
          Effect.provide(dreamDeps),
          // DreamStore.Memory + SessionStore.Default need Clock; provide TestContext last.
          Effect.provide(TestContext.TestContext),
        ),
      ),
    )
    expect(ok).toBe("0 3 * * *")
  })

  it("(b) the registered cron fires on a TestClock tick and advances the watermark", async () => {
    // The scheduler fiber must RUN before we read the watermark. The reference
    // dream-cron.test.ts:117-132 proves this requires forking the results stream
    // and awaiting one job BEFORE TestClock.adjust — omitting it reads the
    // watermark before the cron fiber has executed. Replicate that pattern.
    // NOTE: DreamCronLayer encapsulates its JobScheduler, so we cannot fork its
    // `results` stream directly. Resolve the cron marker (forces registration),
    // adjust the clock, then YIELD enough for the forked fiber to run by awaiting
    // a short TestClock window after adjust — if the encapsulated scheduler makes
    // a deterministic await impossible, fall back per the note below.
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* SessionStore
          const store = yield* DreamStore
          yield* sessions.create({ id: "s-1", options: { model: "test" }, createdAt: 0 })
          yield* sessions.appendMessage({ sessionId: "s-1", messageId: "m-1", ts: 1800, parentId: null, kind: "user", payload: "hi" })
          yield* DreamCron // force the layer (registers the cron) before adjusting the clock
          yield* TestClock.adjust(Duration.hours(4)) // crosses 03:00 → tick fires
          yield* TestClock.adjust(Duration.seconds(1)) // give the forked job-runner fiber a window to execute
          return yield* store.getWatermark
        }).pipe(
          Effect.provide(DreamCronLayer("0 3 * * *")),
          Effect.provide(dreamDeps),
          Effect.provide(TestContext.TestContext),
        ),
      ),
    )
    expect(result).toBe(1800)
  })
})
```

> **Fallback for `(b)`:** `DreamCronLayer` encapsulates its `JobScheduler`, so — unlike the reference `dream-cron.test.ts:117-132` — we cannot `Effect.fork` its `results` stream to deterministically await a job. The double-`adjust` above gives the cron's job-runner fiber an execution window. If this proves flaky, downgrade `(b)` to assert registration only (the marker carries the `TriggerId`: `expect((yield* DreamCron).triggerId).toBeDefined()`) and rely on the EXISTING `dream-cron.test.ts` — which already forks results and proves `registerDreamCron` fires end-to-end — for the fire guarantee. The end-to-end fire path is identical (`DreamCronLayer` calls the same `registerDreamCron`), so this is not a coverage gap. Prefer `(b)` as written; fall back only if flaky.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run packages/core/src/dream/dream-cron-layer.test.ts`
Expected: FAIL — cannot find module `./dream-cron-layer.js`.

- [ ] **Step 3: Write the implementation** (`packages/core/src/dream/dream-cron-layer.ts`)

```typescript
/**
 * DreamCronLayer — wires the nightly Dream cron into a layer graph, mirroring
 * SchedulerToolsLayer (scheduler-tools/src/layer.ts): a Layer.scoped that
 * provides its OWN JobScheduler + TriggerAgent + Clock, resolves TriggerAgent,
 * captures the layer Scope (so the supervised cron fibers outlive the build),
 * and calls registerDreamCron(trigger, expr) at build time.
 *
 * The dream DEPS (DreamStore, DreamReasoner, SessionStore, MemoryRouter) flow
 * in from R — the caller supplies real-or-Fake reasoner + real-or-Memory store.
 * Live boot supplies DreamReasoner.Default; the boot smoke harness supplies
 * FakeReasoner (spec-delta #1 — no model calls in a boot smoke test).
 *
 * Produces a DreamCron marker tag so Layer.mergeAll is forced to build this
 * layer (and thereby register the cron) and tests have a service to resolve.
 */
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { JobSchedulerLayer } from "../jobs/job-scheduler.js"
import { TriggerAgent, TriggerAgentLayer } from "../jobs/trigger-agent.js"
import type { MemoryRouter } from "@luna/memory"
import { DreamStore } from "./dream-store.js"
import { DreamReasoner } from "./reasoner.js"
import { SessionStore } from "../session/session-store.js"
import { registerDreamCron } from "./dream.js"
import type { TriggerId } from "../jobs/trigger-agent.js"

export interface DreamCronApi {
  readonly expr: string
  readonly triggerId: TriggerId
}

export class DreamCron extends Effect.Tag("luna/DreamCron")<DreamCron, DreamCronApi>() {}

export interface DreamCronLayerOptions {
  readonly capacity?: number
}

/**
 * Build a layer that registers a Dream cron at `expr`. Requires the dream deps
 * in R (DreamStore | DreamReasoner | SessionStore | MemoryRouter | Clock);
 * provides its own JobScheduler + TriggerAgent internally (a second instance —
 * harmless, precedented by SchedulerToolsLayer's encapsulated instance).
 */
export const DreamCronLayer = (
  expr: string,
  opts?: DreamCronLayerOptions,
): Layer.Layer<DreamCron, never, DreamStore | DreamReasoner | SessionStore | MemoryRouter | Clock> =>
  Layer.scoped(
    DreamCron,
    Effect.gen(function* () {
      const trigger = yield* TriggerAgent
      const triggerId = yield* registerDreamCron(trigger, expr)
      return { expr, triggerId } satisfies DreamCronApi
    }),
  ).pipe(
    Layer.provide(TriggerAgentLayer.Default),
    Layer.provide(JobSchedulerLayer.make({ capacity: opts?.capacity ?? 16, offerPolicy: "drop-newest" })),
    // Clock flows from R (shared with the dream deps); do NOT re-provide Clock.Default here
    // or the scheduler clock will diverge from the dream-deps clock in TestClock tests.
  )
```

> **Clock note (verified):** `JobSchedulerLayer.make` requires `Clock` and `dream-cron.test.ts` provides a single `Clock.Default` (or `TestContext`) shared across scheduler + dream deps (test lines 73-76). Leaving `Clock` in `DreamCronLayer`'s `R` (not re-providing it inside) ensures the cron's scheduler and `runDream`'s clock are the SAME clock — essential for the TestClock fire test and for live-boot consistency with `clockL`. If a build error demands Clock be provided locally, provide the SAME `Clock.Default` the boot graph uses; never a second divergent instance.

- [ ] **Step 4: Export from the barrel** (`packages/core/src/dream/index.ts`)

Add: `export * from "./dream-cron-layer.js"`

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run packages/core/src/dream/dream-cron-layer.test.ts`
Expected: PASS (2 tests; or 1 if `(b)` fell back per the Step-1 note).

- [ ] **Step 6: Typecheck**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx tsc --noEmit -p tsconfig.json`
Expected: no NEW errors from `packages/core/src/dream/`. (Known agent-cli baseline unchanged.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/dream/dream-cron-layer.ts packages/core/src/dream/dream-cron-layer.test.ts packages/core/src/dream/index.ts
git commit -m "feat(dream): DreamCronLayer — self-contained scoped cron layer (mirrors SchedulerToolsLayer)"
```

---

## Task 3 (D1): Wire `DreamCronLayer` into the live server boot

**Boot risk: YES.** `apps/ui-web/scripts/chat-server.ts` has **NO tsc gate** (root `tsconfig.json` excludes `apps/ui-web/**`; `apps/ui-web/tsconfig.json` includes only `src/**`; the file is in `scripts/`, Bun-transpiled). A missing service in the layer graph "takes down the whole chatWithTools wiring at boot" (its own comment, `chat-server.ts:466-469`). **Verification is a runnable `ManagedRuntime` layer-build smoke test, NOT tsc and NOT eyeballing.**

**Files:**
- Modify: `apps/ui-web/scripts/chat-server.ts` (`buildBaseLayer`)
- Create: `apps/ui-web/scripts/smoke/dream-cron-boot.smoke.ts`

**Grounding (verified this session):**
- `buildBaseLayer` ends with `return Layer.mergeAll(uiL, obsL, clockL, storeL, brokerL, sdkAdapterL, chatL, telPlatformL, noopTracerL, agentNotesL)` (`chat-server.ts:502-513`).
- Available in scope: `clockL = Clock.Default` (387), `storeL = SessionStore.Default` (399), `memoryRouterL` (474-478). `LunaSqliteBootstrapLive` is provided at the bottom of `buildServerLayer` (`chat-server.ts:570`) — any `DreamStore.makeLayer(dbPath)` declaring `LunaSqliteBootstrap` in R is satisfied there, same as every other SQLite layer.
- DB path helper: `resolveDbPath()` / `paths.lunaDbPath` (`chat-server.ts:474`, `460`).
- `TriggerAgent`/`JobScheduler` are NOT currently in chat-server (verified: zero grep hits) — `DreamCronLayer` provides its own (spec-delta #2).

- [ ] **Step 1: Add the dream-cron layer to `buildBaseLayer`** (inside `chat-server.ts`, near the other layer definitions ~line 484, before the final `Layer.mergeAll`)

```typescript
// Phase 3 D1: nightly Dream cron. DreamCronLayer provides its OWN
// JobScheduler+TriggerAgent (a second instance — harmless, like memoryRouterL).
// Dream deps flow in: real DreamReasoner.Default (model-backed), DreamStore over
// luna.db, a read-only SessionStore + MemoryRouter. LunaSqliteBootstrap is
// satisfied at the bottom of buildServerLayer, same as every SQLite layer here.
const dreamStoreL = DreamStore.makeLayer(paths.lunaDbPath).pipe(Layer.provide(clockL))
const dreamCronL = DreamCronLayer("0 3 * * *").pipe(
  Layer.provide(dreamStoreL),
  Layer.provide(DreamReasoner.Default.pipe(Layer.provide(sdkClientL))), // sdkClientL: reuse the boot's SDKClient layer
  Layer.provide(storeL),
  Layer.provide(memoryRouterL),
  Layer.provide(clockL),
)
```

> **Grounding caveat (resolve at execution):** `DreamReasoner.Default` requires `SDKClient`. Confirm the exact name of the boot's SDKClient layer — `sdkAdapterL` is assembled from `sdkClientL`/`storeL`/`brokerL` (`chat-server.ts:432-434`); verify `sdkClientL` is in scope at the cron wiring point (it is defined above `sdkAdapterL`). If it is not directly reusable, provide `SDKClient.Default` here. This is the ONE place D2's real reasoner enters the boot (spec-delta #1).

Add `DreamCron` to the final `Layer.mergeAll` so it is forced to build (registers the cron):

```typescript
return Layer.mergeAll(
  uiL, obsL, clockL, storeL, brokerL, sdkAdapterL, chatL, telPlatformL, noopTracerL, agentNotesL,
  dreamCronL, // ← Phase 3 D1: forces the cron to register at boot
)
```

Add to the `@luna/core` import (`chat-server.ts:148-157`): `DreamCronLayer`, `DreamStore`, `DreamReasoner`. (`SDKClient` is from `@luna/adapter-sdk` if not already imported.)

- [ ] **Step 2: Write the runnable boot smoke test** (`apps/ui-web/scripts/smoke/dream-cron-boot.smoke.ts`)

```typescript
/**
 * dream-cron-boot.smoke.ts — boot-risk verification for D1. chat-server.ts has
 * NO tsc gate, so we PROVE the cron layer builds in a ManagedRuntime with the
 * SAME dependency graph the live boot uses — crucially the REAL
 * DreamReasoner.Default (which REQUIRES SDKClient), satisfied by SDKClient.fake
 * so there are ZERO model calls and NO real cron fires. Using FakeReasoner here
 * would DELETE the SDKClient requirement and thus mask the exact crash this
 * smoke exists to catch (a missing/mis-named SDKClient layer in boot — see the
 * Step-1 caveat). spec-delta #1: real reasoner graph, no model calls.
 * Run with Bun: `bun run apps/ui-web/scripts/smoke/dream-cron-boot.smoke.ts`
 * Exits 0 on a clean build; non-zero on any missing-service / build defect.
 */
import { Effect, Layer, ManagedRuntime, Ref, Stream } from "effect"
import { Clock, DreamCron, DreamCronLayer, DreamReasoner, DreamStore, SessionStore } from "@luna/core"
import { SDKClient } from "@luna/adapter-sdk"
import type { Query } from "@luna/adapter-sdk"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"

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

// Canned, model-free Query — never hits the network; the cron never fires
// during a layer build, so reason() is never invoked anyway. The POINT is that
// DreamReasoner.Default's SDKClient requirement is REAL and must be satisfied.
const sdkFake = SDKClient.fake(() => {
  async function* gen() { yield { type: "result", subtype: "success" } as never }
  return gen() as unknown as Query
})

// MIRROR the live boot's dreamCronL provide-chain order EXACTLY (Step 1). Only
// leaf swaps: DreamStore.Memory (no SQLite needed to prove wiring) + SDKClient.fake.
const layer = DreamCronLayer("0 3 * * *").pipe(
  Layer.provide(DreamStore.Memory),
  Layer.provide(DreamReasoner.Default.pipe(Layer.provide(sdkFake))), // ← REAL reasoner graph; SDKClient must resolve
  Layer.provide(SessionStore.Default),
  Layer.provide(FakeMem),
  Layer.provide(Clock.Default),
)

const main = Effect.gen(function* () {
  const marker = yield* DreamCron // forces the build → registers the cron
  console.log("[smoke] DreamCron built; expr =", marker.expr, "triggerId =", marker.triggerId)
})

const rt = ManagedRuntime.make(layer)
rt.runPromise(main)
  .then(() => rt.dispose())
  .then(() => { console.log("[smoke] PASS — dream cron layer builds with the real reasoner graph (SDKClient satisfied)"); process.exit(0) })
  .catch((err) => { console.error("[smoke] FAIL — layer build defect:", err); process.exit(1) })
```

> This smoke validates the *full live wiring SHAPE*: `DreamReasoner.Default` keeps its `SDKClient` requirement (so a missing/mis-named SDKClient layer in boot makes the smoke FAIL — the regression it guards), while `SDKClient.fake` + the never-firing build means zero model calls (spec-delta #1). Only `DreamStore.Memory` substitutes for `DreamStore.makeLayer` (proving wiring without SQLite). Replicate the live boot's `dreamCronL` `Layer.provide` order here so the graphs match. (Optionally add a second variant over `DreamStore.makeLayer(":memory:")` under `LunaSqliteBootstrapLive` to exercise the SQLite path — Bun-only, which this script is.)

- [ ] **Step 3: Run the boot smoke test (THE verification — not tsc, not eyeballing)**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run apps/ui-web/scripts/smoke/dream-cron-boot.smoke.ts`
Expected: stdout `[smoke] PASS — dream cron layer builds, no missing service`, exit 0. A non-zero exit / `FAIL` means a missing service in the graph — fix the `Layer.provide` chain before proceeding.

- [ ] **Step 4: Real-boot sanity (optional but recommended)**

Start the server (the project's chat-server launch — e.g. `bun run apps/ui-web/scripts/chat-server.ts` per the repo's run convention) and confirm it boots WITHOUT a missing-service crash and the dream cron is registered (no error in the boot log). Stop it. Do NOT wait for 03:00.

- [ ] **Step 5: Commit**

```bash
git add apps/ui-web/scripts/chat-server.ts apps/ui-web/scripts/smoke/dream-cron-boot.smoke.ts
git commit -m "feat(dream): wire nightly DreamCronLayer into live server boot (verified by ManagedRuntime smoke)"
```

---

## Task 4 (D5): Inject active beliefs into the thread system prompt (boot snapshot)

**Boot risk: YES** — same surface, same NO-tsc-gate hazard as Task 3. This is the deferred Phase-2 Task 7, now non-empty because the survey can activate beliefs. **Verification is a runnable `ManagedRuntime` layer-build smoke test, NOT tsc and NOT eyeballing.**

**Files:**
- Modify: `apps/ui-web/scripts/chat-server.ts` (`ThreadToolsProviderLayer` `Effect.gen` + `decorate` + imports + `threadToolsL` assembly)
- Create: `apps/ui-web/scripts/smoke/belief-injection-boot.smoke.ts`

**Grounding (verified this session):**
- Phase-2 Task 7 verified recipe (`docs/.../phase2-beliefs.md:867-889`): in `chat-server.ts`, `const threadToolsL = ThreadToolsProviderLayer().pipe(Layer.provide(memoryRouterL), Layer.provide(obsL), Layer.provide(clockL))` — the `Layer.provide(memoryRouterL)` is the load-bearing fix (`Layer.mergeAll` does NOT cross-wire siblings); add `Stream` to the `effect` import (`chat-server.ts:136` currently `{ Effect, Layer, ManagedRuntime, Option }`).
- **CONFLICT with the banner — `decorate` is SYNCHRONOUS** (`packages/chat-service/src/types.ts:227`, called sync at `chat-service.ts:379-381`). The banner says "move the fetch into `decorate()`" — that is NOT possible as a sync `mem.query`. Resolution (spec-delta #4): fetch at boot inside the provider's `Effect.gen` into a snapshot, render synchronously in `decorate`.
- `composeBeliefsSection(records, now, opts?)` returns `""` when no active beliefs (`packages/core/src/beliefs/inject.ts:10-33`) — caller's existing `.filter((s) => s.length > 0)` (`chat-server.ts:281`) drops the empty section cleanly.
- `BELIEF_NAMESPACE = "operator"`, `BELIEF_KIND = "belief"` (`packages/core/src/beliefs/types.ts:5-6`), both exported from `@luna/core` (barrel `index.ts:41`).
- Current `systemPrompt` array: `[dnaContent, sessionMetadata, opts.systemPrompt, ...addenda]` (`chat-server.ts:272-282`).

- [ ] **Step 1: Add imports** (`chat-server.ts:136` and the `@luna/core` import block 148-157)

```typescript
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect" // ← add Stream
// in the @luna/core import: add composeBeliefsSection, BELIEF_NAMESPACE, BELIEF_KIND
import { MemoryRouterTag } from "@luna/memory" // if not already imported
```

- [ ] **Step 2: Fetch active beliefs into a boot snapshot inside the provider's `Effect.gen`** (after `const dnaContent = loadDna(__scriptDir)`, ~line 247)

```typescript
// Phase 3 D5: beliefs are the SQLite-backed analogue of DNA.md (§3.2). Fetch at
// BOOT into a snapshot (decorate is SYNCHRONOUS — types.ts:227 — so it cannot
// run an async mem.query itself). composeBeliefsSection filters to ACTIVE +
// ranks; returns "" when none, so the existing .filter(length>0) drops it.
// FRESHNESS: a belief activated by the survey appears after the NEXT boot. A
// per-thread live refresh requires an out-of-band snapshot update (openConcern,
// not v1) — this is strictly better than Phase-2's always-empty section.
const mem = yield* MemoryRouterTag
const beliefRecords = yield* mem
  .query({ namespace: BELIEF_NAMESPACE, kind: BELIEF_KIND })
  .pipe(Stream.runCollect, Effect.map((c) => Array.from(c)))
const beliefsSnapshot: ReadonlyArray<import("@luna/memory").MemoryRecord> = beliefRecords
console.log(
  "[luna/boot] beliefs injected:",
  beliefsSnapshot.filter((r) => (r.content as { status?: string }).status === "active").length,
  "active",
)
```

- [ ] **Step 3: Render the snapshot synchronously in `decorate`** (the `systemPrompt` array, ~line 272)

```typescript
const beliefsContent = composeBeliefsSection(beliefsSnapshot, Date.now()) // sync read of the boot snapshot
const systemPrompt = [
  dnaContent,
  sessionMetadata,
  beliefsContent, // ← Phase 3 D5
  opts.systemPrompt,
  memoryThreadTools.systemPromptAddendum,
  schedulerThreadTools.systemPromptAddendum,
  obsThreadTools.systemPromptAddendum,
  localShellThreadTools.systemPromptAddendum,
]
  .filter((s): s is string => typeof s === "string" && s.length > 0)
  .join("\n\n")
```

- [ ] **Step 4: Add the load-bearing `Layer.provide(memoryRouterL)` to `threadToolsL`** (`chat-server.ts:484-487`)

```typescript
const threadToolsL = ThreadToolsProviderLayer().pipe(
  Layer.provide(memoryRouterL), // ← REQUIRED: satisfies MemoryRouter inside the layer (siblings don't cross-wire)
  Layer.provide(obsL),
  Layer.provide(clockL),
)
```

- [ ] **Step 4b: Extract `ThreadToolsProviderLayer` into an importable module so the smoke builds the REAL layer.** `ThreadToolsProviderLayer` is module-private at `chat-server.ts:225`. Move it (and its small deps — `loadDna`/`buildSessionMetadata`/`resolveSandboxLocalShell`/`localShellBridge` references stay; pass what it needs or co-locate) into a new sibling module, e.g. `apps/ui-web/scripts/thread-tools-provider.ts`, and import it back into `chat-server.ts`. This is **additive** (chat-server's behavior is unchanged; only the definition relocates) and is what lets the smoke build the *actual* layer the boot uses — NOT a reconstruction. If a clean extraction is too entangled, the minimum viable alternative is to export `ThreadToolsProviderLayer` from `chat-server.ts` itself (it already exports `loadDna` at line 164, so re-exporting is precedented) and import it in the smoke.

- [ ] **Step 5: Write the runnable boot smoke test — builds the REAL `threadToolsL`** (`apps/ui-web/scripts/smoke/belief-injection-boot.smoke.ts`)

```typescript
/**
 * belief-injection-boot.smoke.ts — boot-risk verification for D5. Builds the
 * REAL ThreadToolsProviderLayer (with Layer.provide(memoryRouterL) over a seeded
 * router) under ManagedRuntime, resolves ThreadToolsProviderTag, and calls
 * decorate({}) — asserting BOTH:
 *   (a) the layer builds with NO missing-service defect — load-bearing: if you
 *       DELETE the `Layer.provide(seededMem)` (the memoryRouterL analogue) this
 *       smoke MUST FAIL (the layer's internal `yield* MemoryRouterTag` goes
 *       unsatisfied — exactly the Phase-2-banner boot crash this guards), and
 *   (b) decorate() output contains "What I believe about Operator" when one
 *       ACTIVE belief is seeded.
 * A reconstruction of composeBeliefsSection would test neither (a) nor the sync
 * snapshot read — it must be the real layer. NO tsc net; the failure mode is boot.
 * Run: `bun run apps/ui-web/scripts/smoke/belief-injection-boot.smoke.ts`
 */
import { Effect, Layer, ManagedRuntime, Ref, Stream } from "effect"
import { Clock, makeBeliefRecord } from "@luna/core"
import { ObservabilityService } from "@luna/core" // obsL analogue — confirm the exact obs tag/layer the provider needs
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { ThreadToolsProviderTag } from "@luna/chat-service"
import { ThreadToolsProviderLayer } from "../thread-tools-provider.js" // from Step 4b (or "../chat-server.js" if re-exported)

const seeded = makeBeliefRecord({ statement: "Operator prefers terse answers", confidence: 0.9, domain: "comms", status: "active", now: 0 })

const seededMem = Layer.effect(
  MemoryRouterTag,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<string, MemoryRecord>>(new Map([[seeded.id, seeded]]))
    return {
      put: (r: MemoryRecord) => Ref.update(store, (m) => new Map(m).set(r.id, r)),
      get: (id: string) => Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
      delete: () => Effect.succeed(false),
      query: () => Stream.unwrap(Ref.get(store).pipe(Effect.map((m) => Stream.fromIterable(Array.from(m.values()))))),
      search: () => Stream.empty,
    } as never
  }),
)

// Build the REAL provider layer with the SAME provide-chain shape as boot
// (Step 4): memoryRouterL → seededMem, plus obs + clock the provider needs.
// Removing `Layer.provide(seededMem)` MUST make this smoke fail (regression guard).
const obsL = ObservabilityService.makeLayer({ jsonlPath: "/tmp/luna-smoke-obs.jsonl" }).pipe(Layer.provide(Clock.Default)) // confirm exact obs layer args at execution
const threadToolsL = ThreadToolsProviderLayer().pipe(
  Layer.provide(seededMem),
  Layer.provide(obsL),
  Layer.provide(Clock.Default),
)

const main = Effect.gen(function* () {
  const provider = yield* ThreadToolsProviderTag // forces the build (a) — no missing service
  const binding = provider.decorate({} as never) // sync decorate read (b)
  if (!binding.systemPrompt?.includes("What I believe about Operator")) {
    throw new Error("beliefs section missing from decorate() output despite a seeded ACTIVE belief")
  }
  console.log("[smoke] decorate() systemPrompt contains the beliefs section")
})

const rt = ManagedRuntime.make(threadToolsL)
rt.runPromise(main)
  .then(() => rt.dispose())
  .then(() => { console.log("[smoke] PASS — real ThreadToolsProvider layer builds (MemoryRouter satisfied) + active belief injected"); process.exit(0) })
  .catch((err) => { console.error("[smoke] FAIL:", err); process.exit(1) })
```

> **Regression-guard note (state in the plan):** dropping `Layer.provide(seededMem)` from `threadToolsL` MUST make this smoke FAIL with a missing-`MemoryRouter` defect — that is the proof it guards the Phase-2-banner boot crash (`Layer.mergeAll` does NOT cross-wire siblings). Verify this once by deleting the line, observing FAIL, restoring it. The smoke builds the REAL `ThreadToolsProviderLayer` (Step 4b extraction makes it importable) — not a `composeBeliefsSection` reconstruction, which would test neither the layer build nor the sync snapshot read. The `obsL` args / the exact set of provider dependencies must be confirmed at execution against the real `ThreadToolsProviderLayer.pipe(...)` providers (`chat-server.ts:319-324, 484-487`).

- [ ] **Step 6: Run the boot smoke test (THE verification)**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run apps/ui-web/scripts/smoke/belief-injection-boot.smoke.ts`
Expected: `[smoke] PASS — real ThreadToolsProvider layer builds (MemoryRouter satisfied) + active belief injected`, exit 0.

- [ ] **Step 7: Real-boot sanity (optional)**

Start the server; with an empty belief store the boot log shows `[luna/boot] beliefs injected: 0 active`. Seed one active belief (REPL/script via `makeBeliefRecord({..., status:"active"})` + `MemoryRouterTag.put`), restart, confirm the count increments and `## What I believe about Operator` appears in a new thread's prompt. Stop.

- [ ] **Step 8: Commit**

```bash
git add apps/ui-web/scripts/chat-server.ts apps/ui-web/scripts/smoke/belief-injection-boot.smoke.ts
git commit -m "feat(beliefs): inject ranked active beliefs into thread system prompt (boot snapshot; verified by ManagedRuntime smoke)"
```

---

## Task 5 (D3): TUI survey surface

**Boot risk: YES if it touches the TUI app's live layer graph** (treat any layer-graph change with the same ManagedRuntime-smoke discipline). The backend (`Survey.processVerdict`/`nextSurvey`, `AlignmentStore`, `BeliefWriter`) is merged and fixture-tested; D3 only produces `SurveyVerdict`s and reads the schedule. TUI-first per D-decision-1 (locked, spec-delta #6).

**Files (exact paths determined in Step 0 after grounding the TUI app):**
- New TUI survey component + a controller that wires `Survey.Default` (over `AlignmentStore.makeLayer(dbPath)` + `BeliefWriter` + `MemoryRouter` + `Clock`) into the TUI's layer graph.

**Grounding to do FIRST (Step 0) — not yet read this session, flagged as an openConcern:**
- Locate the TUI app (likely `apps/agent-cli` — note its JSX + DuckDB tests are the known-baseline failures; confirm the survey component compiles cleanly even though the baseline is red) and its layer-assembly seam. Identify how it builds its runtime (a `ManagedRuntime`? a layer `mergeAll`?), where a new surface mounts, and whether `Survey` deps can be provided there.
- Confirm `Survey.Default` requires `AlignmentStore | BeliefWriter | Clock | MemoryRouter` (from `packages/core/src/alignment/survey.ts` — merged). Provide `AlignmentStore.makeLayer(paths.lunaDbPath)` (same db file) so verdicts persist to the live `alignment_log`.

- [ ] **Step 0: Ground the TUI app layout** (Read the TUI entrypoint + layer assembly; record exact file paths and the mount seam before writing). If the survey surface turns out larger than a single component (e.g. needs a scheduler poll loop to know WHEN to surface a survey, or a new screen/route), STOP and surface it — this may warrant its own plan (openConcern).

- [ ] **Step 1: Write the failing test** — a controller-level test (no terminal rendering): given a fixed EWMA, `nextSurvey` returns the right schedule; given a built survey verdict, `processVerdict` routes it (reuse the merged `survey.test.ts` fakes — `FakeMemory`, `AlignmentStore.Memory`, `Clock.Test`). The TUI component itself is verified by the framework's component test if one exists; otherwise a thin render-to-string assertion.

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run <new test path>`
Expected: FAIL — controller not implemented.

- [ ] **Step 2: Implement the controller + component.** Controller: resolve `Survey`, call `nextSurvey(lastSurveyAt)` to decide whether a check-in is due, render the queued `SurveyItem`s, collect answers into `SurveyVerdict`s, call `processVerdict` for each. Keep ALL routing/activation logic in the merged `Survey` service — the TUI only collects input and displays results.

- [ ] **Step 3: Run the controller test to green.**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run <new test path>`
Expected: PASS.

- [ ] **Step 4: Boot-risk verification — ManagedRuntime layer-build smoke for the TUI's survey-bearing layer graph.** Build the TUI runtime layer that now includes `Survey.Default` + its deps under `ManagedRuntime`, resolve `Survey`, assert no missing-service defect. This is the verification for the layer change — NOT tsc (the TUI may also lack a reliable gate given the agent-cli baseline) and NOT eyeballing.

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run <tui survey smoke path>`
Expected: PASS — survey layer builds.

- [ ] **Step 5: Typecheck (note the baseline).**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx tsc --noEmit -p tsconfig.json`
Expected: the TUI app may be the known-baseline JSX failures — confirm NO NEW errors originate from the new survey files specifically. If the TUI is outside the root tsconfig (like ui-web), the ManagedRuntime smoke (Step 4) is the gate, not tsc.

- [ ] **Step 6: Real-surface sanity.** Launch the TUI, trigger the survey surface, answer one item, confirm the verdict persists (a row in `alignment_log`, a belief status/validationHistory change).

- [ ] **Step 7: Commit**

```bash
git add <tui survey files>
git commit -m "feat(alignment): TUI survey surface — collects verdicts, drives Survey.processVerdict (verified by smoke)"
```

---

## Decisions for the human (genuine choices / a reversal to flag)

- **D-decision-1 — Belief-injection refresh point (REVERSAL of a prior choice, flag to Mr. Cobb).** Mr. Cobb previously chose "injection refresh = per-thread in `decorate`." VERIFIED this session: `ThreadToolsProvider.decorate` is **synchronous** (`packages/chat-service/src/types.ts:227`, called sync at `chat-service.ts:379-381`), so it **cannot** run a per-thread async `mem.query`. **Chosen v1 path: boot-snapshot injection** — fetch active beliefs at boot into a snapshot, render synchronously in `decorate` (Task 4). His "per-thread freshness" intent is NOT abandoned: it stays reachable via an **out-of-band `Ref` refresh** (a background effect updating the snapshot when the survey activates a belief), deferred as an openConcern. A just-activated belief appears after the next boot in v1; live refresh is the documented follow-on. **He should know his choice changed and why.**
- **D-decision-2 — Survey surface scope (D3).** Locked to **TUI-first** (spec-delta #6, matches his prior choice). web/Tauri follow once the verdict→backend contract is proven live.
- **D-decision-3 — Dream cron cadence + reasoner-in-boot.** Locked: nightly `0 3 * * *` (spec-delta #3); the real `DreamReasoner.Default` enters boot once (Task 3), proven by a smoke that keeps the real reasoner's SDKClient dependency while making zero model calls (spec-delta #1). Retune the cron expr later if "on idle" is preferred (§8).

---

## Self-review (run after writing, before execution)

**Build-order dependency discipline (§7.3 cron-as-final-discrete-task):**
- ✅ D2 (reasoner) FIRST — Task 1; core-only, no boot risk; lands independently.
- ✅ D1 (cron) AFTER D2 — Tasks 2-3; Task 3 wires `DreamReasoner.Default` (Task 1's output) into the live boot. Cron layer authored in core (Task 2) so the boot change is one line + smoke.
- ✅ D5 (injection) — Task 4; independent of D1/D2 (needs only Phase-2 `composeBeliefsSection` + survey activation, both merged).
- ✅ D3 (survey UI) — Task 5; independent, TUI-first.

**Boot-risk discipline (the KEY hazard):** Every task touching `chat-server.ts` or a live layer graph (Tasks 3, 4, 5) is verified by a **runnable `ManagedRuntime` layer-build smoke test** — explicitly stated per task, NOT tsc (no gate on `apps/ui-web/scripts/`) and NOT eyeballing. The cron logic itself (Task 2) is in tsc+vitest-covered core; the boot surface shrinks to one line (spec-delta #2). ✅

**Command discipline (corrected for THIS repo — NOT the Phase-2/3 style):**
- Tests: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run <path>` ✅ (NOT `cd packages/core && bun run vitest`)
- Typecheck: `cd /Users/fourcolors/Projects/1_active/luna && bunx tsc --noEmit -p tsconfig.json` ✅ (NOT `cd packages/core && bun run tsc`); packages/core + adapter-sdk covered; apps/ui-web NOT (hence smoke); agent-cli JSX + DuckDB failures are the known baseline, never asserted clean.
- Boot-risk smoke: `cd /Users/fourcolors/Projects/1_active/luna && bun run <smoke script>` ✅

**Reasoner-in-boot split (spec-delta #1):** Real `DreamReasoner.Default` enters the live boot ONCE (Task 3 Step 1). `FakeReasoner` is used in the cron unit test (Task 2) and the boot smoke (Task 3 Step 2) — no model calls in any smoke/boot-graph test. ✅

**`decorate` sync contract (verified — the banner conflict):** D5 does NOT do a per-thread async fetch (impossible — `decorate` is sync, `types.ts:227`). It boot-fetches into a snapshot, renders synchronously. Per-thread freshness is an explicit openConcern, not silently dropped. ✅

**Scope discipline:** D4 (outreach emitter) and D6 (telemetry read-API) are NOT planned here — out of scope per the drive. ✅

**Synthesis honesty:** The critic's refutations/gaps were not in context; this plan grounds every load-bearing claim in verified source (paths + line numbers) and flags the conflict where the banner and live code disagreed. ✅

**Open items carried to `openConcerns`:** (a) the missing critic artifact; (b) D5 per-thread belief freshness needs an out-of-band snapshot refresh; (c) D3 TUI app layout not yet grounded — Task 5 Step 0 grounds it, and if the survey surface is larger than a component (scheduler poll / new screen) it may need its own plan; (d) the exact reusable SDKClient layer name in chat-server for D2's reasoner in boot (Task 3 caveat).
