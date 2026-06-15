# Alignment Loop — Phase 3 D3: TUI Survey Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the alignment loop FULLY TURN. The backend (`Survey.processVerdict`/`nextSurvey`, `AlignmentStore`, `BeliefWriter.recordValidation`, cadence) is merged; Dream forms PROPOSED beliefs nightly (real `DreamReasonerDefault` + `DreamCronLayer` wired into the live boot — already merged); active beliefs inject into the thread system prompt at boot (D5 — already merged). The ONE missing crank is the **human-facing survey**: the operator answers a short structured check-in, verdicts route to `Survey.processVerdict`, PROPOSED beliefs get activated/retired, the global EWMA moves on the task-quality signal, and the next survey is rescheduled. That is the loop turning. This plan builds the survey surface end-to-end over the **WS protocol**: a server-pushed `survey-request` frame → a TUI modal → a `survey-response` ClientFrame → `Survey.processVerdict` server-side. Phase 4 outreach emitter (D4) and the telemetry read-API (D6) remain OUT of scope.

**Architecture (CORRECTED — load-bearing):** The agent-cli TUI is a **thin WebSocket client** (`LunaWsClient` → `LunaHeadlessSession.handleFrame` → Solid `store`), NOT a process that holds `Survey`/`AlignmentStore` layers. VERIFIED: `apps/agent-cli/src/chat/ws-client.ts` (LunaWsClient sends `ClientFrame`, receives `ServerFrame`), `apps/agent-cli/src/chat/headless.ts:235-325` (`handleFrame` switch over `ServerFrame.type` emits events), `apps/agent-cli/src/tui/mount.ts:109-153` (events drive the store). **The prior live-wiring plan's Task 5 ("wire `Survey.Default` into the TUI's layer graph" + "TUI survey smoke") is WRONG and is superseded here** — there is no `Survey` layer in the TUI and no TUI `ManagedRuntime` to smoke. Instead:

- **Survey logic stays 100% in core `Survey`** (the chat-service precedent: `packages/chat-service/src/types.ts:1-10` — ui-ws is a "dumb adapter"). Two additive methods are added to the merged `Survey` service: `pendingSurvey(now)` (due-check + source items) and the lastSurveyAt read flows through `AlignmentStore.getLastSurveyAt` (also additive). The WS server calls `pendingSurvey` once on connect and `processVerdict` per answer — nothing more.
- **Two new wire frames** (mirroring the existing plain-TS discriminated-union pattern in `packages/ui-ws/src/protocol.ts`, NOT Effect Schema — see Decision D-LOCK-7): server→client `SurveyRequestFrame`, client→server `SurveyResponseFrame` (+ optional `SurveyDismissFrame`). The ui-ws server resolves a `Survey` handle (passed into `UIWebSocketServerConfig`, exactly like `chatService`/`accountBroker`) and routes the response frame to `processVerdict`.
- **chat-server boot** gains one `Survey` resolution + one config field (`survey: surveyHandle`) — the only boot-risk surface, verified by a `ManagedRuntime` real-exported-layer smoke (`buildSurveyLayer`), NOT tsc/eyeballing.
- **TUI** adds a `SurveyModal` Solid component + a `survey` signal in the store; `handleFrame` gains a `survey-request` case that populates it; submit/dismiss send the response/dismiss frames. Pure frame-roundtrip + component tests; no layer to smoke.

**Tech Stack:** Effect-TS v3, Bun, `bun:sqlite`, `@luna/core` (`Survey`, `AlignmentStore`, `BeliefWriter`, `SurveyVerdict`/`SurveyItem`, `Clock`), `@luna/ui-ws` (`ServerFrame`/`ClientFrame` plain-TS unions), `@luna/chat-service` (frame-shape precedent), OpenTUI/Solid (`apps/agent-cli/src/tui`). Tests: Vitest with Ref-backed `Memory` layers + `Clock.Test` (core), pure frame-roundtrip assertions (ui-ws + TUI), and — for the ONE boot-risk surface — a runnable `ManagedRuntime` layer-build smoke importing the REAL exported `buildSurveyLayer`, regression-guarded.

**Source-of-truth spec:** `docs/superpowers/specs/2026-05-28-luna-alignment-loop-design.md` (§2.1 cadence, §2.3 three signals + category boundary, §2.4 ladder + cold start, §3.3 "survey is a short structured check-in"). Builds on the merged Phase-3 backend (`packages/core/src/alignment/`) and the merged live wiring (`apps/ui-web/scripts/chat-server.ts` already has `DreamCronLayer`, belief injection). The live-wiring plan is `docs/superpowers/plans/2026-05-28-alignment-loop-phase3-live-wiring.md`; the backend plan is `docs/superpowers/plans/2026-05-28-alignment-loop-phase3-survey.md`.

> **Synthesis note (load-bearing — read before executing):** This drive referenced "design findings + BOTH critics' refutations/gaps." The critic artifacts were **not present in this author's context** (the same absence both prior Phase-3 plans flagged). This plan synthesizes from the spec plus **verified live source read this session** — every load-bearing claim cites file:line, never assumed. Where the prior live-wiring plan and the live code conflicted, the **live code wins** and the conflict is called out (most importantly: the TUI is a WS client, so D3 is server-push over the wire, NOT a TUI-side `Survey` layer — superseding live-wiring Task 5). One adversarial check was run via a stronger reviewer; its corrections are folded into the locked decisions below (most critically: the proof test's "ewma moved" MUST route through `task_quality`, never `belief_validation` — contradicting that would fail the merged `survey.test.ts:100` invariant).

---

## Spec deltas / decisions locked by this plan

Concrete, internally consistent defaults so they do not block. The genuine architecture choices are defaulted with rationale (the task mandated this). The load-bearing *constraints* (category boundary preserved; boot cannot break; idempotent replay) are enforced by tests.

1. **D-LOCK-1 — Trigger = server-push, connection-time due-check (RECOMMENDED, locked).** Options: (a) server pushes a `survey-request` after `hello` if a survey is due; (b) client polls; (c) a background server timer. **Locked: (a).** On each WS connection, after `hello` (fire-and-forget via `runFork`, exactly like the `account-list` send at `packages/ui-ws/src/server.ts:347-356`), the server calls `survey.pendingSurvey(now)`; if a survey is due it pushes one `survey-request` frame. Rationale: zero new infrastructure, matches the existing post-hello push precedent, and a check-in surfaces the next time the operator opens the TUI — which is exactly when they can answer. A background timer (c) is a deferred enhancement (openConcern) — connection-time is sufficient to close the loop because the operator must be present to answer anyway.

2. **D-LOCK-2 — `lastSurveyAt` is DERIVED, no migration (verify precondition holds).** `alignment_state` v1 is already shipped (`packages/core/src/alignment/alignment-store.ts` SCHEMA_V1), so an explicit `last_survey_at` column would need a v2 migration. We avoid it: **every survey carries exactly one mandatory `task_quality` item** (D-LOCK-4), and outreach stays dormant (D4 OUT), so `task_quality` rows in `alignment_log` ARE survey-completion markers. Therefore `getLastSurveyAt = MAX(at) WHERE signal_kind = 'task_quality'`. Cold start: no `task_quality` rows → `getLastSurveyAt` returns `null`/`0` → survey is due immediately (§2.4 cold start: daily until trust earned). This co-locates reschedule with the EWMA write (the task_quality append). **Precondition (asserted by Task 2's test): the survey ALWAYS includes a task_quality item.** If task_quality ever becomes optional, fall back to an explicit column via `applyMigration(db, "alignment", 2, …)`. The derivation is hidden behind `AlignmentStore.getLastSurveyAt` so the impl is swappable without touching callers.

3. **D-LOCK-3 — Beliefs-per-survey cap = 3 (RECOMMENDED, locked).** §3.3 says "short structured check-in." `pendingSurvey` sources at most **3** PROPOSED beliefs (`BeliefWriter.listByStatus("proposed")`, take first 3 by stable order). Overflow rolls to the next survey (they stay proposed; next due-check picks them up). Rationale: keeps the modal short; a 20-belief survey is not a check-in.

4. **D-LOCK-4 — task-quality scale = 1–5, mapped `(n-1)/4` (RECOMMENDED, locked).** The task_quality item is a static subjective prompt ("How aligned have I been with what you wanted?") answered 1–5. The TUI maps the choice to `score = (n-1)/4` → clean endpoints `1→0.0 … 5→1.0`, feeding `signalValueForVerdict`'s `score` path (`packages/core/src/alignment/cadence.ts` — `score` passes through clamped). Rationale: a discrete 1–5 Likert is the standard short-survey control and produces the exact `[0,1]` the EWMA wants. The prompt text is static (spec-delta #9 of the backend plan: the survey supplies task-quality DIRECTLY; D6 telemetry pre-biasing is enrichment, not a prerequisite).

5. **D-LOCK-5 — verdict `at` is stamped to the survey's `issuedAt`, NOT receipt-time (idempotency, load-bearing).** The `survey-request` frame carries `issuedAt` (the server's `now` at push). Every `SurveyVerdict` the TUI sends back, and the server forwards to `processVerdict`, stamps `at: issuedAt`. This is the merged service's idempotency anchor (`packages/core/src/alignment/survey.ts:111-140` + its DEVIATION header lines 41-48; `survey.test.ts:254` asserts "EWMA moved once not twice"). If the server stamped `now` at receipt, a re-delivered answer would double-move the EWMA on a real clock. **The wire MUST carry `issuedAt` and the server MUST use it.** All items in one survey share the same `issuedAt`, and each verdict's `ref` differs (per-belief id or `"task_quality"`), so the `(ref, signalKind, at)` idempotency key is unique per item yet stable across replay.

6. **D-LOCK-6 — Dismiss = no-op; Snooze = explicit suppress-one-interval (locked).** Two paths: **Dismiss** (operator closes the modal without answering) writes NOTHING — the next due-check re-surfaces it (correct: an unanswered survey is still due). **Snooze** sends a `survey-dismiss` ClientFrame; the server calls `survey.snooze(now)` which writes a single `task_quality` row at the *current* EWMA value (no EWMA change) so `getLastSurveyAt` advances and the survey is suppressed for one interval. Rationale: dismiss must not silently lose the check-in; snooze must not poison the alignment signal (it writes the *unchanged* EWMA, marking "asked, deferred"). Finer snooze controls (custom interval) are deferred.

7. **D-LOCK-7 — protocol is plain-TS discriminated unions, NOT Effect Schema.** ⚠️ The drive brief calls `protocol.ts` "Schema-based ServerFrame/ClientFrame unions." VERIFIED FALSE: `packages/ui-ws/src/protocol.ts:1-319` uses plain TypeScript `interface` + a hand-maintained `type ServerFrame = … | …` union; there is no `effect/Schema` import. The new frames MUST follow the actual pattern (plain interfaces added to the union types), NOT Effect Schema — introducing Schema would break the 1:1 `ChatFrame → ServerFrame` translation (`server.ts:456-466`) and the client's `parsed as ServerFrame` cast (`ws-client.ts:29`). State this mismatch; mirror reality.

8. **D-LOCK-8 — handleFrame/router switches have NO exhaustiveness guard.** VERIFIED: `headless.ts:237` and `server.ts:569` are plain `switch` over `frame.type` with no `default: assertNever`. Adding a frame to the union will NOT fail tsc if a case is missing. Therefore each new frame gets its case added MANUALLY plus a roundtrip test that proves the case fires (Task 4/6). Do not rely on tsc to catch a missing case.

9. **D-LOCK-9 — "injected" in the proof test is asserted at the DATA level (boot-snapshot reality).** Belief injection is a boot-time snapshot (merged D5: `chat-server.ts:267,304-307`), so a survey-activated belief appears in a thread prompt only after the next boot. The end-to-end proof test therefore asserts injection at the data layer: after `confirmed`, `BeliefWriter.listActive()` contains the belief AND `composeBeliefsSection(listActive, now)` renders its statement — NOT that a live thread's prompt mutated mid-session. (Per-thread live refresh remains the documented D5 openConcern, OUT of v1.)

---

## ⚠️ EXECUTION CORRECTIONS (mandatory — override the tasks/decisions below where they conflict; the operator + advisor, 2026-05-28)

1. **DROP snooze from v1 (supersedes D-DEC-5).** The plan's snooze wrote an "unchanged-EWMA `task_quality` marker" — but `task_quality` is EWMA-eligible, so that's either dishonest faked data (faked `ewma_after` + skipped `setEwma`) or a corpus-polluting neutral row. **Do neither.** v1 has **dismiss = no-op only**: an unanswered/dismissed survey simply re-surfaces on the next connection-time due-check (no timer-loop, so no nag-loop). With snooze gone, `lastSurveyAt = MAX(at) WHERE signal_kind='task_quality'` (D-DEC-2) is fully honest — only an *answered* survey (which always carries the mandatory `task_quality` item) advances the schedule. No migration, no faked rows. Snooze (advance-without-answering) is a documented follow-on. Remove any snooze frame/handler/marker from Tasks 1/2/4.

2. **ADD a live belief-injection refresh (the operator chose "truly fully turning").** D5 injection is currently boot-snapshot, so a survey-activated belief would not shape live threads until the next restart. Add a NEW task (call it **T3b**, sequenced right after T3): replace the boot-snapshot in `ThreadToolsProviderLayer` with a `Ref<string>` holding the rendered active-beliefs section, refreshed by a background fiber (poll `listActive` → `composeBeliefsSection` every N seconds, e.g. 30s; `decorate` reads the `Ref` synchronously). So a belief activated by a survey appears in the **next thread without a restart**. This touches the boot-risk injection seam → it gets its OWN runnable `ManagedRuntime` real-exported-layer smoke (build `ThreadToolsProviderLayer`, seed an active belief, advance the fiber/await one refresh, assert `decorate()` output contains it) + a **regression-guard** (removing the refresh wiring makes the smoke FAIL). Update T5's end-to-end proof to assert injection via the REFRESHED path (a belief activated mid-run appears after one refresh tick), not only the boot snapshot. Keep `decorate` SYNCHRONOUS (it reads the Ref; the fiber does the async query).

3. **T3 (and T3b) boot-gating: the sub-factory smoke is necessary but NOT sufficient — add a mandatory manual diff-read step.** A `buildSurveyLayer`/provider sub-factory smoke proves the deps compose, but does NOT prove `buildBaseLayer`'s `Layer.mergeAll` actually wired it with the real in-scope deps (the residual gap that bit D1-boot). So each boot-risk task MUST include an explicit step: **read the committed `buildBaseLayer` diff and confirm (a) the new layer is in the `mergeAll`, (b) every dep it's `.provide`d is a real in-scope binding, (c) no `const` use-before-definition** (defined after `memoryRouterL`/`clockL`/etc., before the `mergeAll`). This is the proven D1-boot/D5 mitigation, re-applied — the controller (me) performs this read before accepting the task.

---

## File structure

New (core — tsc + vitest covered):
- `packages/core/src/alignment/survey.ts` — **modified**: add `pendingSurvey(now)` + `snooze(now)` to `SurveyApi` + impl (additive; reuses the merged BeliefWriter+AlignmentStore+Clock+mem already closed over at `survey.ts:92-95`).
- `packages/core/src/alignment/survey.test.ts` — **modified**: add `pendingSurvey` (due/cold-start/cap/no-proposed) + `snooze` tests.
- `packages/core/src/alignment/alignment-store.ts` — **modified**: add `getLastSurveyAt` to `AlignmentStoreApi` + both layers (Memory + sqlite). Derives `MAX(at) WHERE signal_kind='task_quality'`.
- `packages/core/src/alignment/alignment-store.test.ts` — **modified**: add `getLastSurveyAt` derivation test (cold-start null/0; advances on task_quality append; ignores belief_validation rows).
- `packages/core/src/alignment/types.ts` — **modified**: add `PendingSurvey` shape (`issuedAt` + `items: ReadonlyArray<SurveyItem>`).

New (ui-ws — tsc + vitest covered):
- `packages/ui-ws/src/protocol.ts` — **modified**: add `SurveyRequestFrame` (server→client) to `ServerFrame`; add `SurveyResponseFrame` + `SurveyDismissFrame` (client→server) to `ClientFrame`. Plain interfaces (D-LOCK-7).
- `packages/ui-ws/src/server.ts` — **modified**: add `survey?: SurveyWsHandle` to `UIWebSocketServerConfig`; on connect (post-hello, fire-and-forget) push `survey-request` if due; route `survey-response` → `survey.processVerdict`, `survey-dismiss` → `survey.snooze`. `SurveyWsHandle` is a thin resolved-handle interface (like `accountBroker`) so the server env doesn't grow a `Survey` dependency.
- `packages/ui-ws/src/server.test.ts` (or the existing ui-ws test file) — **modified/new**: roundtrip test — a due survey pushes `survey-request`; an inbound `survey-response` calls the handle's `processVerdict` with `at == issuedAt`.

Modified (boot-risk — apps/ui-web, NO tsc gate):
- `apps/ui-web/scripts/chat-server.ts` — resolve `Survey` at boot (new `buildSurveyLayer` exported factory + a `Survey` resolution in `buildServerLayer`), pass `survey:` into `startUIWebSocketServer`. One new layer + one config field.

New (boot-risk verification — runnable smoke, NOT tsc):
- `apps/ui-web/scripts/smoke/survey-boot.smoke.ts` — `ManagedRuntime.make` over the REAL exported `buildSurveyLayer`, resolve `Survey`, assert no missing-service defect. Regression-guarded.

Modified (TUI — agent-cli; JSX baseline is known-red, gate is the roundtrip/component tests + the manual run):
- `apps/agent-cli/src/tui/store.ts` — add a `survey` signal (`PendingSurvey | null`) + setter.
- `apps/agent-cli/src/chat/headless.ts` — add the `survey-request` case to `handleFrame` + a `survey` event + helpers to send `survey-response`/`survey-dismiss`.
- `apps/agent-cli/src/tui/SurveyModal.tsx` — **new** Solid component: renders the task_quality Likert + per-belief confirm/correct/reject controls; collects verdicts; on submit/dismiss calls back.
- `apps/agent-cli/src/tui/App.tsx` — mount `<SurveyModal>` when `store.survey()` is non-null.
- `apps/agent-cli/src/tui/mount.ts` — wire the `survey` event → `store.setSurvey`; wire the modal's submit/dismiss → the headless send helpers.
- Test: `apps/agent-cli/src/chat/headless.test.ts` (or co-located) — frame-roundtrip: a `survey-request` frame emits the `survey` event; the modal's verdicts serialize to a `survey-response` frame with the right `issuedAt`/`kind`/`ref`.

---

# Build order: core (pure, shared) → ui-ws protocol+routing → chat-server boot (smoke-gated) → TUI modal → end-to-end proof

Each task is independently testable. Tasks 1–3 are tsc+vitest-covered core/ui-ws (no boot risk). Task 4 is the ONE boot-risk surface (smoke-gated). Task 5 is TUI (frame/component tests). Task 6 is the end-to-end proof. Merge order: Task 1 → 2 → 3 → 4 → 5 → 6; Tasks 1–3 may land independently as they merge cleanly; Task 4 requires 1–3; Tasks 5–6 require 4.

---

## Task 1: `AlignmentStore.getLastSurveyAt` + `Survey.pendingSurvey`/`snooze` (core backend, additive)

**Boot risk: NO** (core-only, tsc + vitest covered). Additive methods on the merged services. Closes the SurveyItem-producer gap and the lastSurveyAt-scheduling gap (D-LOCK-2).

**Files:**
- Modify: `packages/core/src/alignment/types.ts`
- Modify: `packages/core/src/alignment/alignment-store.ts`
- Modify: `packages/core/src/alignment/alignment-store.test.ts`
- Modify: `packages/core/src/alignment/survey.ts`
- Modify: `packages/core/src/alignment/survey.test.ts`

**Grounding (verified this session):**
- `AlignmentStoreApi` = `append | list | getEwma | setEwma | rebuildState` (`alignment-store.ts:61-69`); `list({ signalKind, since, limit })` already exists and filters by `signalKind` (`alignment-store.ts:92-103` Memory, `:215` sqlite).
- `SurveyApi` = `processVerdict | nextSurvey` (`survey.ts:83-86`); the Default layer closes over `store`/`writer`/`clock`/`mem` (`survey.ts:92-95`).
- `BeliefWriter.listByStatus(status)` returns proposed/active/retired beliefs (`belief-writer.ts:18,53-54`).
- `SurveyItem` shape exists but has NO producer anywhere (`types.ts:37-45`; grep: zero producers) — this task is its first producer.
- `nextSurveyAt(ewma, lastSurveyAt)` is pure (`cadence.ts`); `Survey.nextSurvey` already wraps it (`survey.ts:181-182`).
- The category boundary is merged + asserted: `survey.test.ts:100` `expect(out.ewma).toBe(0)` for `belief_validation`.

- [ ] **Step 1: Write the failing tests**

Add the `PendingSurvey` type to `packages/core/src/alignment/types.ts`:

```typescript
/** What pendingSurvey returns: the items to ask + the stable issue timestamp. */
export interface PendingSurvey {
  /** Server clock at issue. Stamped onto every returned verdict's `at`
   *  (idempotency anchor — spec-delta D-LOCK-5). All items share it. */
  readonly issuedAt: number
  /** The check-in items: ALWAYS one task_quality item, then ≤cap belief items. */
  readonly items: ReadonlyArray<SurveyItem>
}
```

Add to `packages/core/src/alignment/alignment-store.test.ts` (reuse its existing `provide`/`row` helpers):

```typescript
describe("getLastSurveyAt (derived, no migration — D-LOCK-2)", () => {
  it("cold start: returns 0 when no task_quality rows exist", async () => {
    const out = await Effect.runPromise(
      provide(Effect.gen(function* () {
        const s = yield* AlignmentStore
        return yield* s.getLastSurveyAt
      })),
    )
    expect(out).toBe(0)
  })

  it("returns MAX(at) of task_quality rows; ignores belief_validation rows", async () => {
    const out = await Effect.runPromise(
      provide(Effect.gen(function* () {
        const s = yield* AlignmentStore
        yield* s.append(row({ ref: "task:1", signalKind: "task_quality", at: 1000, ewmaAfter: 0.5 }))
        yield* s.append(row({ ref: "task:2", signalKind: "task_quality", at: 3000, ewmaAfter: 0.6 }))
        // a later belief_validation row must NOT count as a survey-completion marker
        yield* s.append(row({ ref: "b:1", signalKind: "belief_validation", at: 9000, ewmaAfter: null }))
        return yield* s.getLastSurveyAt
      })),
    )
    expect(out).toBe(3000)
  })
})
```

Add to `packages/core/src/alignment/survey.test.ts` (reuse its `FakeMemory`/`provide`/`makeBeliefRecord` helpers):

```typescript
describe("Survey.pendingSurvey (D-LOCK-2/3/4)", () => {
  const proposed = (statement: string) =>
    makeBeliefRecord({ statement, confidence: 0.7, domain: "comms", status: "proposed", now: 0 })

  it("cold start (no task_quality rows): survey is DUE and includes a task_quality item", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          return yield* survey.pendingSurvey(5000)
        }),
        FakeMemory([]),
      ),
    )
    expect(out).not.toBeNull()
    expect(out!.issuedAt).toBe(5000)
    expect(out!.items.some((i) => i.kind === "task_quality")).toBe(true)
  })

  it("ALWAYS carries exactly one task_quality item (the D-LOCK-2 precondition)", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          return yield* survey.pendingSurvey(5000)
        }),
        FakeMemory([proposed("a"), proposed("b")]),
      ),
    )
    expect(out!.items.filter((i) => i.kind === "task_quality")).toHaveLength(1)
  })

  it("caps proposed beliefs at 3 (D-LOCK-3); overflow rolls to next survey", async () => {
    const beliefs = ["a", "b", "c", "d", "e"].map(proposed)
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          return yield* survey.pendingSurvey(5000)
        }),
        FakeMemory(beliefs),
      ),
    )
    expect(out!.items.filter((i) => i.kind === "belief_validation")).toHaveLength(3)
  })

  it("no proposed beliefs: when due, still surfaces the task_quality item only", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          return yield* survey.pendingSurvey(5000)
        }),
        FakeMemory([]),
      ),
    )
    expect(out!.items).toHaveLength(1)
    expect(out!.items[0]?.kind).toBe("task_quality")
  })

  it("not due: returns null when now < lastSurveyAt + interval", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          // record a task_quality verdict at t=1000 → lastSurveyAt=1000, ewma climbs
          yield* survey.processVerdict({ itemId: "i", kind: "task_quality", ref: "task_quality", score: 1, via: "survey", at: 1000 })
          // ask again immediately at t=1001 — far inside the (≥1 day) interval
          return yield* survey.pendingSurvey(1001)
        }),
        FakeMemory([]),
      ),
    )
    expect(out).toBeNull()
  })
})

describe("Survey.snooze (D-LOCK-6)", () => {
  it("advances lastSurveyAt without moving the EWMA", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          const store = yield* AlignmentStore
          const before = yield* store.getEwma
          yield* survey.snooze(7000)
          const last = yield* store.getLastSurveyAt
          const after = yield* store.getEwma
          return { before, after, last }
        }),
        FakeMemory([]),
      ),
    )
    expect(out.last).toBe(7000) // survey suppressed for one interval
    expect(out.after).toBe(out.before) // EWMA unchanged (writes the SAME value)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run packages/core/src/alignment/alignment-store.test.ts packages/core/src/alignment/survey.test.ts`
Expected: FAIL — `getLastSurveyAt`, `pendingSurvey`, `snooze`, `PendingSurvey` do not exist.

- [ ] **Step 3: Implement `getLastSurveyAt` in `AlignmentStore`**

In `packages/core/src/alignment/alignment-store.ts`, add to `AlignmentStoreApi` (after `rebuildState`):

```typescript
  /**
   * The timestamp of the last completed survey, DERIVED as MAX(at) over
   * task_quality rows (D-LOCK-2 — every survey carries exactly one
   * task_quality item, so those rows ARE survey-completion markers; no
   * schema migration needed). Returns 0 cold (no rows → survey due now).
   */
  readonly getLastSurveyAt: Effect.Effect<number, AlignmentError>
```

Memory layer — add inside the `Effect.gen` (after `rebuildState`) and to the returned object:

```typescript
      const getLastSurveyAt: AlignmentStoreApi["getLastSurveyAt"] = Ref.get(rows).pipe(
        Effect.map((rs) =>
          rs
            .filter((r) => r.signalKind === "task_quality")
            .reduce((max, r) => Math.max(max, r.at), 0),
        ),
      )
      // ...
      return { append, list, getEwma, setEwma, rebuildState, getLastSurveyAt } satisfies AlignmentStoreApi
```

sqlite layer — add a prepared statement near the other stmts and the method:

```typescript
        const lastSurveyStmt = db.query(
          `SELECT MAX(at) AS m FROM alignment_log WHERE signal_kind = 'task_quality'`,
        )
        // ...
        const getLastSurveyAt: AlignmentStoreApi["getLastSurveyAt"] = wrap("getLastSurveyAt", () => {
          const r = lastSurveyStmt.get() as { m: number | null } | undefined
          return r?.m ?? 0
        })
        // ...
        return { append, list, getEwma, setEwma, rebuildState, getLastSurveyAt } satisfies AlignmentStoreApi
```

- [ ] **Step 4: Implement `pendingSurvey` + `snooze` in `Survey`**

In `packages/core/src/alignment/survey.ts`, import `BeliefWriter` is already present; add `PendingSurvey` + `SurveyItem` to the type import from `./types.js`, and `readBelief` is already imported. Add to `SurveyApi`:

```typescript
  /**
   * Decide whether a survey is due (now ≥ lastSurveyAt + cadence interval) and,
   * if so, source its items: ALWAYS one task_quality item (D-LOCK-2 precondition)
   * + up to 3 PROPOSED beliefs (D-LOCK-3). Returns null when not due.
   * The `issuedAt` is the idempotency anchor stamped onto every verdict (D-LOCK-5).
   */
  readonly pendingSurvey: (now: number) => Effect.Effect<PendingSurvey | null, AlignmentError | MemoryBackendError>
  /** Snooze: advance lastSurveyAt by one interval WITHOUT moving the EWMA
   *  (writes the current EWMA value as a task_quality marker). D-LOCK-6. */
  readonly snooze: (now: number) => Effect.Effect<void, AlignmentError>
```

Add the constant and implement inside the Default `Effect.gen` (after `nextSurvey`, before `return`):

```typescript
      const BELIEFS_PER_SURVEY = 3 // D-LOCK-3
      const TASK_QUALITY_PROMPT = "How aligned have I been with what you wanted lately?"

      const pendingSurvey = (now: number) =>
        Effect.gen(function* () {
          const lastSurveyAt = yield* store.getLastSurveyAt
          // COLD START (§2.4 "boots dormant → surveys daily" = first contact is
          // DUE, not epoch + 1 day). lastSurveyAt === 0 reliably means "never
          // surveyed" — any real survey/snooze writes a row with at > 0. Without
          // this guard, dueAt = nextSurveyAt(0, 0) = MIN_INTERVAL_DAYS*DAY =
          // 86_400_000, so the first survey would not fire until now ≥ 1 day
          // (epoch), which is wrong AND makes synthetic-clock tests (small `now`)
          // never due. Treat lastSurveyAt === 0 as immediately due.
          if (lastSurveyAt !== 0) {
            const dueAt = yield* nextSurvey(lastSurveyAt) // nextSurveyAt(ewma, lastSurveyAt)
            if (now < dueAt) return null
          }

          // ALWAYS one task_quality item (D-LOCK-2 precondition / D-LOCK-4 scale).
          // ref = "task_quality" (a stable, belief-less ref); the TUI maps a 1–5
          // Likert to score = (n-1)/4.
          const taskItem: SurveyItem = {
            id: `sq-${now}`,
            kind: "task_quality",
            prompt: TASK_QUALITY_PROMPT,
            ref: "task_quality",
          }

          // Up to 3 PROPOSED beliefs (D-LOCK-3). Overflow rolls to next survey.
          const proposed = yield* writer.listByStatus("proposed")
          const beliefItems: ReadonlyArray<SurveyItem> = proposed
            .slice(0, BELIEFS_PER_SURVEY)
            .map((rec) => ({
              id: `bv-${rec.id}-${now}`,
              kind: "belief_validation" as const,
              prompt: readBelief(rec).statement,
              ref: rec.id,
              beliefId: rec.id,
            }))

          return { issuedAt: now, items: [taskItem, ...beliefItems] } satisfies PendingSurvey
        })

      const snooze = (now: number) =>
        Effect.gen(function* () {
          // Write a task_quality marker at the CURRENT ewma (no signal change) so
          // getLastSurveyAt advances and the survey is suppressed for one interval.
          const ewma = yield* store.getEwma
          yield* store.append({
            at: now,
            signalKind: "task_quality",
            scoreDelta: ewma, // store the unchanged value; this is a "deferred" marker
            ewmaAfter: ewma,
            ref: `snooze:${now}`,
          })
        })
```

Add `pendingSurvey, snooze` to the returned `satisfies SurveyApi` object.

> **Note on `snooze` and the EWMA:** `snooze` calls `store.append` directly (NOT `processVerdict`), so it does NOT run `updateEwma` — it writes the existing `ewma` value verbatim into both `scoreDelta` and `ewmaAfter`. This advances `getLastSurveyAt` (the row is `task_quality`) while leaving the global EWMA exactly where it was. The test (Step 1) asserts `after === before`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run packages/core/src/alignment/`
Expected: PASS — all existing alignment tests (incl. the merged category-boundary `survey.test.ts:100`) plus the new `getLastSurveyAt`/`pendingSurvey`/`snooze` tests.

- [ ] **Step 6: Typecheck**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx tsc --noEmit -p tsconfig.json`
Expected: no NEW errors from `packages/core/src/alignment/`. (Known agent-cli JSX + DuckDB-test baseline unchanged — do NOT assert a clean exit; confirm no new diagnostics originate in `alignment/`.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/alignment/types.ts packages/core/src/alignment/alignment-store.ts packages/core/src/alignment/alignment-store.test.ts packages/core/src/alignment/survey.ts packages/core/src/alignment/survey.test.ts
git commit -m "feat(alignment): Survey.pendingSurvey/snooze + AlignmentStore.getLastSurveyAt (derived schedule, no migration)"
```

---

## Task 2: Survey wire frames + ui-ws server routing

**Boot risk: NO** (`packages/ui-ws` is tsc + vitest covered). Adds two server-pushed/two client frames + the server handler that calls a passed-in `Survey` handle.

**Files:**
- Modify: `packages/ui-ws/src/protocol.ts`
- Modify: `packages/ui-ws/src/server.ts`
- Modify (or create): `packages/ui-ws/src/server.test.ts`

**Grounding (verified this session):**
- `ServerFrame` is a hand-maintained union (`protocol.ts:197-217`); `ClientFrame` likewise (`protocol.ts:307-318`). Plain interfaces, no Schema (D-LOCK-7).
- `UIWebSocketServerConfig` already takes resolved handles: `chatService?: ChatService` (`server.ts:100`), `accountBroker?: {...}` (`server.ts:107-114`) — both are thin handle shapes, NOT Tags, so "the server's environment doesn't grow a dependency" (`server.ts:96-98`). `survey` follows this exact pattern.
- Post-hello fire-and-forget push precedent: `account-list` via `Effect.runFork` right after the `hello` send (`server.ts:347-356`).
- Inbound routing: `ws.on("message", …)` → `switch (frame.type)` inside a `handle()` effect run via `Runtime.runFork(runtime)` (`server.ts:551-712`). New cases go here; gate on `survey !== null` like `chat !== null`.
- `send(ws, frame)` is the typed wire sender (`server.ts:138-145`).

- [ ] **Step 1: Write the failing test**

Create/extend `packages/ui-ws/src/server.test.ts` with a routing-level test that does NOT spin a real socket — it exercises the frame translation + the handle call. (If a full WS integration harness already exists in the file, add the survey assertions there; otherwise a focused unit test on the handler is sufficient.) Minimum viable test asserts the contract:

```typescript
import { describe, expect, it } from "vitest"
import type { ServerFrame, ClientFrame, SurveyRequestFrame, SurveyResponseFrame } from "./protocol.js"

describe("survey wire frames (D-LOCK-7 — plain TS unions)", () => {
  it("SurveyRequestFrame is part of ServerFrame", () => {
    const f: ServerFrame = {
      type: "survey-request",
      issuedAt: 1000,
      items: [{ id: "sq-1000", kind: "task_quality", prompt: "How aligned?", ref: "task_quality" }],
    }
    expect(f.type).toBe("survey-request")
  })
  it("SurveyResponseFrame carries issuedAt as the verdict anchor (D-LOCK-5)", () => {
    const f: ClientFrame = {
      type: "survey-response",
      issuedAt: 1000,
      verdicts: [{ itemId: "sq-1000", kind: "task_quality", ref: "task_quality", score: 1, via: "survey", at: 1000 }],
    }
    expect(f.type).toBe("survey-response")
    if (f.type === "survey-response") {
      expect(f.verdicts.every((v) => v.at === f.issuedAt)).toBe(true) // anchor invariant
    }
  })
})
```

If the file has a live-server harness (it may — `server.ts` is integration-tested), add an integration assertion: start the server with a `survey` handle whose `pendingSurvey` returns one due survey, connect a client, and assert the client receives a `survey-request` frame after `hello`; then send a `survey-response` and assert the handle's `processVerdict` was called with `at == issuedAt`. Use a spy handle:

```typescript
const calls: Array<{ at?: number; kind: string }> = []
const surveyHandle = {
  pendingSurvey: (now: number) => Effect.succeed({ issuedAt: now, items: [{ id: "sq", kind: "task_quality" as const, prompt: "?", ref: "task_quality" }] }),
  processVerdict: (v: { at?: number; kind: string }) => Effect.sync(() => { calls.push(v) }),
  snooze: () => Effect.void,
}
// ... after sending survey-response with issuedAt=1000 ...
// expect(calls[0]?.at).toBe(1000)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run packages/ui-ws/src/server.test.ts`
Expected: FAIL — `survey-request`/`survey-response` frames not in the unions.

- [ ] **Step 3: Add the frames to `protocol.ts`**

Import `SurveyItem`/`SurveyVerdict` from `@luna/core` at the top (alongside the existing `import type { ObsEvent, ChatMessage, SessionSummary } from "@luna/core"`):

```typescript
import type { ObsEvent, ChatMessage, SessionSummary, SurveyItem, SurveyVerdict } from "@luna/core"
```

Add the server→client frame (near the other server frames, before the `ServerFrame` union):

```typescript
/* ── alignment survey (Phase 3 D3) ──────────────────────────────────── */

/**
 * Server-pushed check-in (§3.3). Sent after `hello` when a survey is due.
 * `issuedAt` is the stable idempotency anchor — the client echoes it on
 * every verdict's `at` (D-LOCK-5) so a re-delivered answer never double-moves
 * the EWMA.
 */
export interface SurveyRequestFrame {
  readonly type: "survey-request"
  readonly issuedAt: number
  readonly items: ReadonlyArray<SurveyItem>
}
```

Add it to the `ServerFrame` union:

```typescript
export type ServerFrame =
  | HelloFrame
  // ... existing ...
  | MemorySearchErrorFrame
  | SurveyRequestFrame
```

Add the client→server frames (near the other client frames, before the `ClientFrame` union):

```typescript
/**
 * The operator's answers to one survey. `issuedAt` MUST equal the
 * SurveyRequestFrame's issuedAt; the server stamps every verdict's `at`
 * to it (D-LOCK-5). `via` is always "survey" here.
 */
export interface SurveyResponseFrame {
  readonly type: "survey-response"
  readonly issuedAt: number
  readonly verdicts: ReadonlyArray<SurveyVerdict>
}

/** Snooze — suppress this survey for one cadence interval (D-LOCK-6). */
export interface SurveyDismissFrame {
  readonly type: "survey-dismiss"
  readonly issuedAt: number
}
```

Add both to the `ClientFrame` union:

```typescript
export type ClientFrame =
  | PongFrame
  // ... existing ...
  | MemorySearchRequestFrame
  | SurveyResponseFrame
  | SurveyDismissFrame
```

- [ ] **Step 4: Add the `survey` handle + routing to `server.ts`**

Define the handle interface near the config (mirroring the `accountBroker` shape — a resolved handle, NOT a Tag, so the server env stays narrow):

```typescript
/**
 * Optional Survey handle (Phase 3 D3). When provided, the server pushes a
 * `survey-request` after `hello` if a survey is due, and routes
 * `survey-response` → processVerdict, `survey-dismiss` → snooze. Pass the
 * RESOLVED handle (not the Tag) so the server's env doesn't grow a Survey dep.
 */
export interface SurveyWsHandle {
  readonly pendingSurvey: (now: number) => import("effect").Effect.Effect<
    { readonly issuedAt: number; readonly items: ReadonlyArray<import("@luna/core").SurveyItem> } | null,
    unknown
  >
  readonly processVerdict: (v: import("@luna/core").SurveyVerdict) => import("effect").Effect.Effect<void, unknown>
  readonly snooze: (now: number) => import("effect").Effect.Effect<void, unknown>
}
```

Add `survey?: SurveyWsHandle` to `UIWebSocketServerConfig`. In `startUIWebSocketServer`, resolve it: `const survey = config.survey ?? null`.

Push on connect — after the `account-list` block (`server.ts:356`), fire-and-forget the due-check (NEVER block connection setup; mirror the `account-list` `Effect.runFork`):

```typescript
// Phase 3 D3: push a survey check-in if one is due (fire-and-forget, like
// account-list). The error channel is swallowed — a survey failure must never
// take down the connection. `now` is captured once and becomes `issuedAt`.
if (survey !== null) {
  const s = survey
  Effect.runFork(
    Effect.flatMap(s.pendingSurvey(Date.now()), (pending) =>
      Effect.sync(() => {
        if (pending !== null) {
          send(ws, { type: "survey-request", issuedAt: pending.issuedAt, items: pending.items })
        }
      }),
    ).pipe(Effect.catchAllCause(() => Effect.void)),
  )
}
```

Add the inbound cases inside the `switch (frame.type)` (gate the message handler on `survey !== null` in the `if (chat !== null || localShellBridge !== null)` guard — extend it to `|| survey !== null`):

```typescript
                  case "survey-response": {
                    if (survey === null) return
                    // Stamp EVERY verdict's `at` to the survey's issuedAt
                    // (D-LOCK-5). Trust the client's verdict shape but PIN the
                    // anchor server-side — the client could omit/alter `at`.
                    for (const v of frame.verdicts) {
                      yield* survey.processVerdict({ ...v, at: frame.issuedAt }).pipe(
                        Effect.catchAllCause(() => Effect.void), // one bad verdict must not abort the rest
                      )
                    }
                    return
                  }
                  case "survey-dismiss": {
                    if (survey === null) return
                    yield* survey.snooze(Date.now()).pipe(Effect.catchAllCause(() => Effect.void))
                    return
                  }
```

> **Why pin `at` server-side:** D-LOCK-5 makes `issuedAt` the idempotency anchor. The client SHOULD send `at == issuedAt`, but the server overwrites it (`{ ...v, at: frame.issuedAt }`) so a buggy/replaying client cannot double-move the EWMA. The `survey-response`'s `issuedAt` is the single source of truth.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run packages/ui-ws/src/server.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx tsc --noEmit -p tsconfig.json`
Expected: no NEW errors from `packages/ui-ws/`. (`@luna/core` must export `SurveyItem`/`SurveyVerdict` — it does, via `export * from "./alignment/index.js"` at `core/src/index.ts:42`.)

- [ ] **Step 7: Commit**

```bash
git add packages/ui-ws/src/protocol.ts packages/ui-ws/src/server.ts packages/ui-ws/src/server.test.ts
git commit -m "feat(ui-ws): survey-request/response/dismiss frames + Survey handle routing (issuedAt anchor pinned server-side)"
```

---

## Task 3: Resolve `Survey` at boot + pass into the WS server (BOOT-RISK — smoke-gated)

**Boot risk: YES.** `apps/ui-web/scripts/chat-server.ts` has NO tsc gate (root `tsconfig.json` excludes `apps/ui-web/**`; the file is in `scripts/`, Bun-transpiled). A missing service in the layer graph crashes the WHOLE boot (its own comment, `chat-server.ts:549-551`). **Verification is a runnable `ManagedRuntime` real-exported-layer smoke, NOT tsc and NOT eyeballing.** Mirrors the merged `dream-cron-boot.smoke.ts` discipline exactly.

**Files:**
- Modify: `apps/ui-web/scripts/chat-server.ts`
- Create: `apps/ui-web/scripts/smoke/survey-boot.smoke.ts`

**Grounding (verified this session):**
- The merged boot already wires `dreamCronL` via the exported `buildDreamCronLayer` factory (`chat-server.ts:430-454,578-586`), and the smoke imports the REAL factory (`smoke/dream-cron-boot.smoke.ts:32`). Mirror this pattern for `Survey`.
- `Survey.Default` requires `AlignmentStore | BeliefWriter | Clock | MemoryRouter` (`survey.ts:91-95`). `BeliefWriter.Default` requires `MemoryRouter | Clock`. `AlignmentStore.makeLayer(dbPath)` requires `Clock | LunaSqliteBootstrap` (`alignment-store.ts:128`).
- In-scope at boot: `clockL = Clock.Default` (`chat-server.ts:469`), `memoryRouterL` (`chat-server.ts:556-560`), `paths.lunaDbPath` (`chat-server.ts:470` via `resolveRuntimePaths`). `LunaSqliteBootstrap` is satisfied at the bottom of `buildServerLayer` (`chat-server.ts:670`), same as every SQLite layer.
- `buildServerLayer` resolves `ChatService`/`AccountBroker` from the env then passes the handles to `startUIWebSocketServer` (`chat-server.ts:641-658`). `Survey` resolves the same way and passes a `survey:` handle.
- `Survey` is exported from `@luna/core` (`core/src/index.ts:42`).

- [ ] **Step 1: Add an exported `buildSurveyLayer` factory to `chat-server.ts`** (near `buildDreamCronLayer`, ~line 430 — exported so the smoke builds the REAL layer, never a mirror)

```typescript
// Phase 3 D3: Survey layer for the WS-mediated check-in. EXPORTED so the boot
// smoke builds THIS layer, not a hand-copied reconstruction (the no-tsc-gate
// failure mode is the boot). Mirrors buildDreamCronLayer's shape.
export interface BuildSurveyLayerOpts {
  readonly alignmentStoreL: Layer.Layer<AlignmentStore, ConfigError, Clock | LunaSqliteBootstrap>
  readonly memoryRouterL: Layer.Layer<MemoryRouter, ConfigError, LunaSqliteBootstrap>
  readonly clockL: Layer.Layer<Clock>
}

export const buildSurveyLayer = (opts: BuildSurveyLayerOpts) =>
  Survey.Default.pipe(
    Layer.provide(opts.alignmentStoreL),
    Layer.provide(BeliefWriter.Default.pipe(Layer.provide(opts.memoryRouterL), Layer.provide(opts.clockL))),
    Layer.provide(opts.memoryRouterL),
    Layer.provide(opts.clockL),
  )
```

Add `Survey`, `AlignmentStore`, `BeliefWriter` to the `@luna/core` import block (alongside the existing `DreamCronLayer`/`composeBeliefsSection` imports). Verify the exact `LunaSqliteBootstrap`/`ConfigError`/`MemoryRouter` type names already imported in the file (`MemoryRouterLayer`/`LunaSqliteBootstrapLive` are used at `:556,670`); import the type aliases if not present.

- [ ] **Step 2: Build the survey layer inside `buildBaseLayer` and merge it** (~line 586, near `dreamCronL`)

```typescript
// Phase 3 D3: Survey over the same luna.db AlignmentStore + the boot's
// memoryRouterL/clockL. LunaSqliteBootstrap satisfied at the bottom of
// buildServerLayer, same as every SQLite layer here.
const alignmentStoreL = AlignmentStore.makeLayer(paths.lunaDbPath).pipe(Layer.provide(clockL))
const surveyL = buildSurveyLayer({ alignmentStoreL, memoryRouterL, clockL })
```

Add `Survey` to the `buildBaseLayer` return union and the final `Layer.mergeAll`:

```typescript
  return Layer.mergeAll(
    uiL, obsL, clockL, storeL, brokerL, sdkAdapterL, chatL,
    telPlatformL, noopTracerL, agentNotesL,
    dreamCronL,
    surveyL, // Phase 3 D3: Survey available for buildServerLayer to resolve + pass to the WS server
  )
```

- [ ] **Step 3: Resolve `Survey` in `buildServerLayer` and pass the handle to the WS server** (`chat-server.ts:636-658`)

```typescript
      const chat = yield* ChatService
      const broker = yield* AccountBroker
      const survey = yield* Survey // Phase 3 D3
      // ...
      return yield* startUIWebSocketServer({
        port: 4753,
        // ... existing fields ...
        chatService: chat,
        accountBroker: broker,
        survey, // Phase 3 D3: resolved handle (SurveyApi has pendingSurvey/processVerdict/snooze)
        localShellBridge,
        onLocalShellRelease: reattachSandbox,
      })
```

> **Type fit:** `SurveyApi` (`survey.ts:83-86` + Task 1's additions) structurally satisfies `SurveyWsHandle` (Task 2) — both expose `pendingSurvey`/`processVerdict`/`snooze`. The `SurveyWsHandle` error channel is `unknown`, which the concrete `AlignmentError | MemoryBackendError` widens into cleanly. If TS complains about the `Effect` error-type variance at the boundary, widen by passing `survey` directly (the handle interface is structural) — confirm at execution.

- [ ] **Step 4: Write the runnable boot smoke** (`apps/ui-web/scripts/smoke/survey-boot.smoke.ts` — mirror `dream-cron-boot.smoke.ts` exactly)

```typescript
/**
 * survey-boot.smoke.ts — boot-risk verification for D3 (Survey resolution).
 *
 * chat-server.ts has NO tsc gate, so a missing service in the Survey layer
 * graph crashes the WHOLE boot. This smoke PROVES buildSurveyLayer builds in a
 * ManagedRuntime by importing the REAL exported factory — not a mirror. A typo
 * / missing-import / mis-named layer in the actual edited code makes THIS smoke
 * FAIL. Node-runnable doubles (AlignmentStore.Memory + Ref-backed FakeMemory +
 * Clock.Default) so it runs in the default test path (no bun:sqlite required).
 *
 * Regression guard: removing `Layer.provide(FakeMem)` from the opts (the
 * memoryRouterL analogue) MUST make this smoke FAIL with a missing-MemoryRouter
 * defect — Survey.Default + BeliefWriter.Default both yield* MemoryRouterTag.
 * Verify once (delete → FAIL → restore).
 *
 * Run: bun run apps/ui-web/scripts/smoke/survey-boot.smoke.ts
 * Exit 0 = PASS, non-zero = FAIL (missing service → fix the Layer.provide chain).
 */
import { AlignmentStore, BeliefWriter, Clock, Survey } from "@luna/core"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { Effect, Layer, ManagedRuntime, Ref, Stream } from "effect"
import { buildSurveyLayer } from "../chat-server.js"

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

// SAME factory the live boot uses; only leaf swaps: AlignmentStore.Memory
// (node-runnable, no SQLite) + FakeMem. Both satisfy the tags so the graph
// composes identically to boot.
const layer = buildSurveyLayer({
  alignmentStoreL: AlignmentStore.Memory as never, // Memory layer (Clock only) ↔ makeLayer (Clock+Bootstrap)
  memoryRouterL: FakeMem as never,
  clockL: Clock.Default,
})

const main = Effect.gen(function* () {
  const survey = yield* Survey // forces the layer to build
  // pendingSurvey on an empty store at cold start → DUE (a real method call,
  // proving the resolved handle is live, not just present).
  const pending = yield* survey.pendingSurvey(Date.now())
  console.log("[smoke] Survey resolved; cold-start pending =", pending !== null ? `${pending.items.length} item(s)` : "null")
  if (pending === null) {
    throw new Error("[smoke] FAIL — cold-start survey should be DUE (no task_quality rows yet)")
  }
})

const rt = ManagedRuntime.make(layer)
rt.runPromise(main)
  .then(() => rt.dispose())
  .then(() => { console.log("[smoke] PASS — Survey layer builds (AlignmentStore + BeliefWriter + MemoryRouter + Clock satisfied)"); process.exit(0) })
  .catch((err: unknown) => { console.error("[smoke] FAIL — Survey layer build defect:", err); process.exit(1) })
```

> **Note on `AlignmentStore.Memory as never`:** `buildSurveyLayer`'s `alignmentStoreL` param is typed for the SQLite `makeLayer` (R = `Clock | LunaSqliteBootstrap`). The smoke passes `AlignmentStore.Memory` (R = `Clock`) — a strict subtype of the requirement, but the `as never` cast (matching the dream-cron smoke's `as never` precedent at `smoke/dream-cron-boot.smoke.ts:49`) sidesteps the param-type narrowing while still building the REAL factory. The graph composes identically; the cast is only to satisfy the factory's input type with a node-runnable double.

- [ ] **Step 5: Run the boot smoke (THE verification — not tsc, not eyeballing)**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run apps/ui-web/scripts/smoke/survey-boot.smoke.ts`
Expected: stdout `[smoke] PASS — Survey layer builds …`, exit 0. A non-zero exit / `FAIL` means a missing service — fix the `Layer.provide` chain before proceeding.

- [ ] **Step 6: Regression-guard the smoke ONCE** (prove it guards the wiring)

Temporarily delete `Layer.provide(FakeMem)` from the smoke's `buildSurveyLayer` call (set `memoryRouterL` to a layer that does NOT provide `MemoryRouterTag`, or drop it). Re-run the smoke. Expected: FAIL with a missing-`MemoryRouter` defect (Survey.Default + BeliefWriter.Default both `yield* MemoryRouterTag`). Restore the line. Expected: PASS. A smoke that passes with the wiring removed guards nothing.

- [ ] **Step 7: Real-boot sanity (optional but recommended)**

Start the server per the repo run convention (`bun run apps/ui-web/scripts/chat-server.ts`) and confirm it boots WITHOUT a missing-service crash (the Survey layer is now in the graph). Stop it. Do NOT need a client yet.

- [ ] **Step 8: Commit**

```bash
git add apps/ui-web/scripts/chat-server.ts apps/ui-web/scripts/smoke/survey-boot.smoke.ts
git commit -m "feat(alignment): resolve Survey at boot + pass to WS server (verified by ManagedRuntime smoke)"
```

---

## Task 4: TUI survey modal + frame roundtrip

**Boot risk: NO** (the TUI is a thin WS client — no layer graph, no `ManagedRuntime` to smoke; see Architecture). The agent-cli JSX + DuckDB-test failures are the KNOWN baseline (never asserted clean); the gate here is the frame-roundtrip/component test + the manual run. The TUI renders a `survey-request`, collects answers, sends a `survey-response`/`survey-dismiss`.

**Files:**
- Modify: `apps/agent-cli/src/tui/store.ts`
- Modify: `apps/agent-cli/src/chat/headless.ts`
- Create: `apps/agent-cli/src/tui/SurveyModal.tsx`
- Modify: `apps/agent-cli/src/tui/App.tsx`
- Modify: `apps/agent-cli/src/tui/mount.ts`
- Create/modify: `apps/agent-cli/src/chat/headless.test.ts`

**Grounding (verified this session):**
- `LunaHeadlessSession.handleFrame` (`headless.ts:235-325`) is a `switch (frame.type)` with NO exhaustiveness guard (D-LOCK-8) — add a `survey-request` case manually. Events are typed in `LunaHeadlessEvents` (`headless.ts:19-36`).
- The session sends `ClientFrame`s via `this.client.send({...})` (`headless.ts:72,96,143-147` etc.). Add `sendSurveyResponse`/`sendSurveyDismiss` helpers there.
- The store is a Solid-signal bag (`store.ts:14-75`); `mount.ts:124-153` wires session events → store setters. The TUI App mounts components conditionally (`App.tsx:25-32`).
- Key handling: components own their keys via OpenTUI bindings (`Input.tsx:23-31,54-66`); global Ctrl-C is intercepted in `mount.ts:257-263`.
- `SurveyItem`/`SurveyVerdict`/`PendingSurvey` types come from `@luna/core` (re-exported via `@luna/ui-ws` frames carry them).

- [ ] **Step 1: Write the failing frame-roundtrip test** (`apps/agent-cli/src/chat/headless.test.ts`)

```typescript
import { describe, expect, it, vi } from "vitest"
import { LunaHeadlessSession } from "./headless.js"
import type { SurveyRequestFrame } from "@luna/ui-ws"

// A minimal fake LunaWsClient: records sends, lets us push frames.
const fakeClient = () => {
  const sent: unknown[] = []
  return {
    sent,
    send: (f: unknown) => { sent.push(f) },
    nextFrame: () => new Promise<never>(() => {}), // never resolves; we call handleFrame directly via the event path
    close: () => Promise.resolve(),
  }
}

describe("survey frame roundtrip (D3)", () => {
  it("a survey-request frame emits the 'survey' event with the PendingSurvey payload", () => {
    const client = fakeClient()
    const session = new LunaHeadlessSession({
      client: client as never, profileName: "test", model: "m",
      saveLastThread: () => {}, clearLastThread: () => {},
    })
    const got: Array<{ issuedAt: number; items: ReadonlyArray<{ kind: string }> }> = []
    session.on("survey", (p) => got.push(p))

    const frame: SurveyRequestFrame = {
      type: "survey-request",
      issuedAt: 1000,
      items: [
        { id: "sq-1000", kind: "task_quality", prompt: "How aligned?", ref: "task_quality" },
        { id: "bv-x-1000", kind: "belief_validation", prompt: "You prefer terse", ref: "x", beliefId: "x" },
      ],
    }
    // handleFrame is private; exercise it through the public rawFrame path used by run().
    ;(session as unknown as { handleFrame: (f: unknown) => void }).handleFrame(frame)

    expect(got).toHaveLength(1)
    expect(got[0]?.issuedAt).toBe(1000)
    expect(got[0]?.items).toHaveLength(2)
  })

  it("sendSurveyResponse stamps issuedAt onto every verdict's `at` (D-LOCK-5)", () => {
    const client = fakeClient()
    const session = new LunaHeadlessSession({
      client: client as never, profileName: "test", model: "m",
      saveLastThread: () => {}, clearLastThread: () => {},
    })
    session.sendSurveyResponse(1000, [
      { itemId: "sq-1000", kind: "task_quality", ref: "task_quality", score: 1, via: "survey" },
      { itemId: "bv-x-1000", kind: "belief_validation", ref: "x", beliefId: "x", verdict: "confirmed", via: "survey" },
    ])
    const frame = client.sent[0] as { type: string; issuedAt: number; verdicts: Array<{ at?: number }> }
    expect(frame.type).toBe("survey-response")
    expect(frame.issuedAt).toBe(1000)
    expect(frame.verdicts.every((v) => v.at === 1000)).toBe(true)
  })

  it("sendSurveyDismiss sends a survey-dismiss frame with the issuedAt", () => {
    const client = fakeClient()
    const session = new LunaHeadlessSession({
      client: client as never, profileName: "test", model: "m",
      saveLastThread: () => {}, clearLastThread: () => {},
    })
    session.sendSurveyDismiss(1000)
    expect(client.sent[0]).toEqual({ type: "survey-dismiss", issuedAt: 1000 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run apps/agent-cli/src/chat/headless.test.ts`
Expected: FAIL — `survey` event / `sendSurveyResponse` / `sendSurveyDismiss` do not exist; no `survey-request` case.

- [ ] **Step 3: Add the `survey` event, the handleFrame case, and the send helpers to `headless.ts`**

Add to `LunaHeadlessEvents` (`headless.ts:19-36`):

```typescript
  survey: (pending: import("@luna/core").PendingSurvey) => void
```

Add the case to `handleFrame`'s switch (`headless.ts:237`):

```typescript
      case "survey-request":
        this.emit("survey", { issuedAt: frame.issuedAt, items: frame.items })
        return
```

Add the send helpers (near `sendUser`, `headless.ts:89`):

```typescript
  /** Send the operator's survey answers. Stamps every verdict's `at` to
   *  `issuedAt` (D-LOCK-5 — the server re-pins it too, defence-in-depth). */
  sendSurveyResponse(
    issuedAt: number,
    verdicts: ReadonlyArray<import("@luna/core").SurveyVerdict>,
  ): void {
    this.client.send({
      type: "survey-response",
      issuedAt,
      verdicts: verdicts.map((v) => ({ ...v, at: issuedAt })),
    })
  }

  /** Snooze the survey for one interval (D-LOCK-6). */
  sendSurveyDismiss(issuedAt: number): void {
    this.client.send({ type: "survey-dismiss", issuedAt })
  }
```

> **Note:** `SurveyRequestFrame`/`SurveyResponseFrame`/`SurveyDismissFrame` are now in `ServerFrame`/`ClientFrame` (Task 2), so `this.client.send({ type: "survey-response", … })` and the `frame.type === "survey-request"` narrowing typecheck. `PendingSurvey`/`SurveyVerdict`/`SurveyItem` import from `@luna/core`.

- [ ] **Step 4: Add the `survey` signal to the store** (`store.ts`)

```typescript
import type { PendingSurvey } from "@luna/core"
// ... inside createTuiStore:
const [survey, setSurvey] = createSignal<PendingSurvey | null>(null)
// ... add to the returned object:
survey, setSurvey,
```

- [ ] **Step 5: Build `SurveyModal.tsx`** (new component)

A Solid component that renders when `store.survey()` is non-null. It shows the task_quality item as a 1–5 choice (mapping `n → (n-1)/4`, D-LOCK-4) and each belief_validation item with confirm/correct/reject controls (mapping to `verdict`). It collects answers into `SurveyVerdict[]` and, on submit, calls `props.onSubmit(issuedAt, verdicts)`; on dismiss, `props.onDismiss(issuedAt)`. Use OpenTUI key bindings for selection (mirror `Input.tsx`'s `keyBindings` pattern — e.g. number keys 1–5 for the Likert, `c`/`o`/`r` for confirm/correct/reject per belief, Enter to submit, Esc to dismiss). Keep ALL routing/scale logic here in the view; the headless session just forwards the frame.

```tsx
import { createSignal, For, Show } from "solid-js"
import type { PendingSurvey, SurveyVerdict, SurveyItem } from "@luna/core"

export type SurveyModalProps = {
  survey: PendingSurvey
  onSubmit: (issuedAt: number, verdicts: ReadonlyArray<SurveyVerdict>) => void
  onDismiss: (issuedAt: number) => void
}

type BeliefAnswer = "confirmed" | "corrected" | "rejected"

export const SurveyModal = (props: SurveyModalProps) => {
  // task_quality answer: 1–5 Likert → score (n-1)/4 (D-LOCK-4)
  const [likert, setLikert] = createSignal<number | null>(null)
  // belief answers keyed by item.beliefId
  const [beliefAnswers, setBeliefAnswers] = createSignal<Record<string, BeliefAnswer>>({})

  const taskItem = (): SurveyItem | undefined => props.survey.items.find((i) => i.kind === "task_quality")
  const beliefItems = (): ReadonlyArray<SurveyItem> => props.survey.items.filter((i) => i.kind === "belief_validation")

  const buildVerdicts = (): ReadonlyArray<SurveyVerdict> => {
    const out: SurveyVerdict[] = []
    const tq = taskItem()
    const n = likert()
    if (tq !== undefined && n !== null) {
      out.push({ itemId: tq.id, kind: "task_quality", ref: tq.ref, score: (n - 1) / 4, via: "survey" })
    }
    for (const b of beliefItems()) {
      const ans = b.beliefId !== undefined ? beliefAnswers()[b.beliefId] : undefined
      if (ans !== undefined && b.beliefId !== undefined) {
        out.push({ itemId: b.id, kind: "belief_validation", ref: b.ref, beliefId: b.beliefId, verdict: ans, via: "survey" })
      }
    }
    return out
  }

  // Key handling: 1–5 sets the Likert; submit on Enter (only when task answered,
  // the D-LOCK-2 mandatory item); Esc dismisses. Per-belief c/o/r cycles answers
  // for the focused belief. (Exact OpenTUI key wiring mirrors Input.tsx; the
  // executing agent grounds the available key API in apps/agent-cli/src/tui first.)
  const submit = (): void => {
    if (likert() === null) return // mandatory task_quality must be answered
    props.onSubmit(props.survey.issuedAt, buildVerdicts())
  }
  const dismiss = (): void => props.onDismiss(props.survey.issuedAt)

  return (
    <box style={{ borderStyle: "double", flexDirection: "column", padding: 1 }}>
      <text style={{ fg: "#00FF87" }}>Luna check-in — Enter to submit, Esc to snooze</text>
      <Show when={taskItem()}>
        {(tq) => (
          <box style={{ flexDirection: "column" }}>
            <text>{tq().prompt}</text>
            <text>{`  [1] poor  [2]  [3]  [4]  [5] great   (selected: ${likert() ?? "—"})`}</text>
          </box>
        )}
      </Show>
      <For each={beliefItems()}>
        {(b) => (
          <box style={{ flexDirection: "column" }}>
            <text>{`Belief: ${b.prompt}`}</text>
            <text>{`  [c]onfirm  [o] correct  [r]eject   (selected: ${b.beliefId !== undefined ? (beliefAnswers()[b.beliefId] ?? "—") : "—"})`}</text>
          </box>
        )}
      </For>
    </box>
  )
}
```

> **Component-rendering note:** OpenTUI/Solid keybinding wiring is framework-specific. The executing agent MUST ground the exact key-capture API in `apps/agent-cli/src/tui/Input.tsx` (it uses `keyBindings` on `<textarea>` + a global `keypress` listener in `mount.ts:274-276`) before finalizing the modal's interaction. The DATA contract (verdicts with the right `kind`/`ref`/`score`/`verdict`, stamped `issuedAt`) is what Task 4's test gates — the visual layout is secondary and may be refined. If the OpenTUI selection UX proves larger than a single component (focus management across N belief rows), surface it but ship the minimal version (Likert + sequential belief prompts) that satisfies the data contract.

- [ ] **Step 6: Mount the modal in `App.tsx` + wire events in `mount.ts`**

`App.tsx` — render the modal when a survey is pending:

```tsx
import { SurveyModal } from "./SurveyModal.js"
// ... inside the root box, conditionally:
<Show when={props.store.survey()}>
  {(s) => <SurveyModal survey={s()} onSubmit={props.onSurveySubmit} onDismiss={props.onSurveyDismiss} />}
</Show>
```

Extend `AppProps` with `onSurveySubmit`/`onSurveyDismiss`.

`mount.ts` — wire the `survey` event into the store, and pass submit/dismiss handlers that clear the survey and call the headless send helpers:

```typescript
session.on("survey", (pending) => { dbg(`evt survey items=${pending.items.length}`); store.setSurvey(pending) })
// ... where App is created (mount.ts:278) ...
const onSurveySubmit = (issuedAt: number, verdicts: ReadonlyArray<SurveyVerdict>): void => {
  session.sendSurveyResponse(issuedAt, verdicts)
  store.setSurvey(null) // close the modal
}
const onSurveyDismiss = (issuedAt: number): void => {
  session.sendSurveyDismiss(issuedAt)
  store.setSurvey(null)
}
return createComponent(App, { store, onSubmit: submit, onSurveySubmit, onSurveyDismiss })
```

(Import `SurveyVerdict` from `@luna/core` in `mount.ts`.)

- [ ] **Step 7: Run the roundtrip test to verify it passes**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run apps/agent-cli/src/chat/headless.test.ts`
Expected: PASS — all three roundtrip assertions green.

- [ ] **Step 8: Typecheck (note the baseline)**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx tsc --noEmit -p tsconfig.json`
Expected: agent-cli JSX is the KNOWN-baseline failure set — confirm NO NEW errors originate from the new/edited survey files specifically (`SurveyModal.tsx`, the `headless.ts`/`store.ts`/`App.tsx`/`mount.ts` edits). The roundtrip test (Step 7) is the behavioral gate.

- [ ] **Step 9: Commit**

```bash
git add apps/agent-cli/src/tui/SurveyModal.tsx apps/agent-cli/src/tui/store.ts apps/agent-cli/src/tui/App.tsx apps/agent-cli/src/tui/mount.ts apps/agent-cli/src/chat/headless.ts apps/agent-cli/src/chat/headless.test.ts
git commit -m "feat(tui): survey modal + survey-request/response/dismiss frame handling (issuedAt anchored)"
```

---

## Task 5: End-to-end proof — verdict → activation + EWMA + reschedule + injection (THE loop turning)

**Boot risk: NO** (this is a vitest integration test over the merged + new core services; no boot graph). This is THE proof the alignment loop fully turns: seed a PROPOSED belief, build a survey, submit a `confirmed` belief_validation verdict + a high task_quality verdict, and assert ALL four outcomes: (1) belief ACTIVE, (2) belief injected (data-level — D-LOCK-9), (3) EWMA moved (via task_quality — D-LOCK-5/the category boundary), (4) next survey rescheduled (lastSurveyAt advanced).

**Files:**
- Create: `packages/core/src/alignment/loop.e2e.test.ts`

**Grounding (verified this session):**
- The merged category boundary: `belief_validation` does NOT move the EWMA (`survey.test.ts:100` `expect(out.ewma).toBe(0)`). So the EWMA-moved assertion MUST come from the `task_quality` verdict — NOT the belief verdict. (This is the single point the advisor flagged as plan-breaking if wrong.)
- `composeBeliefsSection(records, now)` renders active beliefs (`packages/core/src/beliefs/inject.ts`); `BeliefWriter.listActive()` returns active beliefs (`belief-writer.ts:56`).
- `Survey.Default` + `AlignmentStore.Memory` + `BeliefWriter.Default` + `Clock.Test` + `FakeMemory` compose for a no-Bun integration test (the merged `survey.test.ts` `provide` helper does exactly this).
- `makeBeliefRecord`/`readBelief` from `beliefs/types.js`.

- [ ] **Step 1: Write the end-to-end proof test**

```typescript
// packages/core/src/alignment/loop.e2e.test.ts
/**
 * THE alignment-loop proof: a survey verdict closes the human-in-the-loop cycle.
 * Seed a PROPOSED belief → build the due survey → submit a `confirmed`
 * belief_validation verdict (activation) + a top task_quality verdict (cadence)
 * → assert the FOUR loop outcomes. The EWMA-moved assertion routes through
 * task_quality, NEVER belief_validation (the §2.3 category boundary — see
 * survey.test.ts:100). All verdicts share the survey's issuedAt (D-LOCK-5).
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Ref, Stream } from "effect"
import { Clock } from "../clock.js"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryQuery, MemoryRecord } from "@luna/memory"
import { BeliefWriter } from "../beliefs/belief-writer.js"
import { makeBeliefRecord, readBelief } from "../beliefs/types.js"
import { composeBeliefsSection } from "../beliefs/inject.js"
import { AlignmentStore } from "./alignment-store.js"
import { Survey } from "./survey.js"

// Reuse the survey.test.ts FakeMemory shape.
const FakeMemory = (initial: ReadonlyArray<MemoryRecord> = []) =>
  Layer.effect(
    MemoryRouterTag,
    Effect.gen(function* () {
      const store = yield* Ref.make<Map<string, MemoryRecord>>(new Map(initial.map((r) => [r.id, r])))
      return {
        put: (rec: MemoryRecord) => Ref.update(store, (m) => new Map(m).set(rec.id, rec)),
        get: (id: string) => Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
        delete: (id: string) => Ref.modify(store, (m) => { const had = m.has(id); const n = new Map(m); n.delete(id); return [had, n] }),
        query: (q: MemoryQuery) =>
          Stream.unwrap(Ref.get(store).pipe(Effect.map((m) =>
            Stream.fromIterable(Array.from(m.values()).filter((r) =>
              (q.namespace === undefined || r.namespace === q.namespace) &&
              (q.kind === undefined || r.kind === q.kind)))))),
        search: () => { throw new Error("unused") },
      } as never
    }),
  )

const provide = <A, E>(eff: Effect.Effect<A, E, any>, mem: Layer.Layer<any>) =>
  eff.pipe(
    Effect.provide(Survey.Default),
    Effect.provide(BeliefWriter.Default),
    Effect.provide(AlignmentStore.Memory),
    Effect.provide(mem),
    Effect.provide(Clock.Test(100)),
  )

describe("ALIGNMENT LOOP — end-to-end: survey verdict closes the cycle", () => {
  it("proposed belief + confirmed verdict + top task_quality → ACTIVE + injected + EWMA moved + rescheduled", async () => {
    const belief = makeBeliefRecord({ statement: "Operator prefers terse answers", confidence: 0.7, domain: "comms", status: "proposed", now: 0 })
    // Cold start (no prior task_quality rows → getLastSurveyAt === 0) ⇒ survey is
    // DUE for ANY `now` via the pendingSurvey cold-start guard. The value just
    // needs to be > 0 to be a valid stable idempotency anchor (D-LOCK-5).
    const ISSUED_AT = 5_000_000

    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          const writer = yield* BeliefWriter
          const store = yield* AlignmentStore

          // 1. The survey is due at cold start; it sources the proposed belief + the task_quality item.
          const pending = yield* survey.pendingSurvey(ISSUED_AT)
          if (pending === null) throw new Error("survey should be due at cold start")
          const lastBefore = yield* store.getLastSurveyAt

          // 2. Operator answers: confirm the belief + rate task_quality top (5 → score 1.0).
          //    ALL verdicts stamp at = issuedAt (D-LOCK-5).
          yield* survey.processVerdict({ itemId: "tq", kind: "task_quality", ref: "task_quality", score: 1, via: "survey", at: ISSUED_AT })
          yield* survey.processVerdict({ itemId: "bv", kind: "belief_validation", ref: belief.id, beliefId: belief.id, verdict: "confirmed", via: "survey", at: ISSUED_AT })

          // 3. Read the outcomes.
          const active = yield* writer.listActive()
          const ewma = yield* store.getEwma
          const lastAfter = yield* store.getLastSurveyAt
          const nextAt = yield* survey.nextSurvey(lastAfter)
          const section = composeBeliefsSection(active, ISSUED_AT)

          return { active, ewma, lastBefore, lastAfter, nextAt, section }
        }),
        FakeMemory([belief]),
      ),
    )

    // (1) ACTIVATION — proposed → active on confirmed.
    expect(out.active.map((r) => r.id)).toContain(belief.id)
    expect(out.active.map((r) => readBelief(r).status)).toContain("active")

    // (2) INJECTION (data-level, D-LOCK-9) — the activated belief renders in the section.
    expect(out.section).toContain("Operator prefers terse answers")

    // (3) EWMA MOVED — via task_quality (the category boundary: belief_validation alone leaves it at 0).
    expect(out.ewma).toBeGreaterThan(0)

    // (4) RESCHEDULED — lastSurveyAt advanced to the issuedAt; next survey is in the future.
    expect(out.lastAfter).toBe(ISSUED_AT)
    expect(out.lastAfter).toBeGreaterThan(out.lastBefore)
    expect(out.nextAt).toBeGreaterThan(ISSUED_AT)
  })

  it("CATEGORY BOUNDARY guard: with ONLY a belief_validation verdict, the EWMA stays at 0", async () => {
    // Proves outcome (3) above genuinely depends on task_quality, not the belief verdict.
    const belief = makeBeliefRecord({ statement: "s", confidence: 0.7, domain: "comms", status: "proposed", now: 0 })
    const ewma = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          const store = yield* AlignmentStore
          yield* survey.processVerdict({ itemId: "bv", kind: "belief_validation", ref: belief.id, beliefId: belief.id, verdict: "confirmed", via: "survey", at: 5_000_000 })
          return yield* store.getEwma
        }),
        FakeMemory([belief]),
      ),
    )
    expect(ewma).toBe(0) // unchanged — belief_validation NEVER feeds the EWMA (§2.3)
  })

  it("idempotent replay: re-submitting the SAME survey (same issuedAt) does not double-move the EWMA", async () => {
    const ISSUED_AT = 5_000_000
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const survey = yield* Survey
          const store = yield* AlignmentStore
          const v = { itemId: "tq", kind: "task_quality" as const, ref: "task_quality", score: 1, via: "survey" as const, at: ISSUED_AT }
          yield* survey.processVerdict(v)
          const once = yield* store.getEwma
          yield* survey.processVerdict(v) // replay (e.g. reconnect re-delivers)
          const twice = yield* store.getEwma
          return { once, twice }
        }),
        FakeMemory([]),
      ),
    )
    expect(out.twice).toBe(out.once) // moved exactly once (the merged survey.ts idempotency guard)
  })
})
```

- [ ] **Step 2: Run the proof test**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run packages/core/src/alignment/loop.e2e.test.ts`
Expected: PASS — all four loop outcomes plus the category-boundary guard plus idempotent replay green. **This passing is the proof the loop turns.**

- [ ] **Step 3: Run the full alignment + beliefs suite (no regressions)**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run packages/core/src/alignment/ packages/core/src/beliefs/`
Expected: PASS — all merged tests (incl. the category-boundary `survey.test.ts:100`) + Task 1's new tests + this proof, no regressions.

- [ ] **Step 4: Typecheck**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx tsc --noEmit -p tsconfig.json`
Expected: no NEW errors from `packages/core/src/alignment/`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/alignment/loop.e2e.test.ts
git commit -m "test(alignment): end-to-end proof — survey verdict → activate + inject + EWMA (task_quality) + reschedule"
```

---

## Task 6: Manual run + full-suite verification (the loop, live)

**Files:** none (verification only)

- [ ] **Step 1: Run the survey boot smoke (regression check)**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run apps/ui-web/scripts/smoke/survey-boot.smoke.ts`
Expected: `[smoke] PASS`, exit 0.

- [ ] **Step 2: Manual end-to-end (the live loop)**

1. Seed one PROPOSED belief into `luna.db` (a REPL/script: `makeBeliefRecord({ ..., status: "proposed" })` + `MemoryRouterTag.put`, or wait for the merged nightly Dream cron to propose one).
2. Start the chat-server (`bun run apps/ui-web/scripts/chat-server.ts`). Confirm clean boot (Survey layer present — Task 3).
3. Connect the TUI (`luna chat …`). On connect, confirm the `survey-request` surfaces the check-in modal (task_quality Likert + the proposed belief).
4. Answer: rate task_quality high; `confirm` the belief; submit.
5. Confirm server-side: a `task_quality` row + a `belief_validation` row in `alignment_log` (both `at == issuedAt`); the belief flipped to `active`; the EWMA advanced from 0.
6. Restart the server; confirm the activated belief now appears in a new thread's system prompt (`## What I believe about Operator` — boot-snapshot injection, D-LOCK-9).
7. Reconnect the TUI immediately; confirm NO survey re-surfaces (lastSurveyAt advanced → not due within the interval).
8. Reconnect after the interval elapses (or seed a stale lastSurveyAt); confirm the survey re-surfaces.

- [ ] **Step 3: Full core suite (no regressions)**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run packages/core/src/`
Expected: PASS — all dream + beliefs + alignment tests green.

- [ ] **Step 4: ui-ws suite**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run packages/ui-ws/`
Expected: PASS.

- [ ] **Step 5: Root typecheck — regression check against the known baseline (do NOT assert clean exit)**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx tsc --noEmit -p tsconfig.json`
Expected: the pre-existing agent-cli JSX + DuckDB-test failures are the known baseline (NOT introduced by this drive). Confirm NO NEW errors originate from `packages/core/src/alignment/`, `packages/ui-ws/`, or the survey-related agent-cli files. apps/ui-web is NOT covered by tsc — the boot smoke (Task 3) is its gate.

---

## Decisions for the human (defaulted; recommendation given for each)

> All genuine architecture choices below are DEFAULTED as locked decisions with rationale (spec-deltas D-LOCK-1…9). The human may retune; the load-bearing constraints (category boundary, idempotency anchor, boot-cannot-break) are test-enforced.

- **D-DEC-1 — Trigger mechanism.** Options: (a) server-push connection-time due-check; (b) client poll; (c) background server timer. **Recommendation: (a)** (D-LOCK-1) — zero new infra, matches the post-hello `account-list` precedent, surfaces exactly when the operator is present to answer. A background timer is a deferred enhancement (openConcern).
- **D-DEC-2 — `lastSurveyAt` persistence.** Options: (a) derive from `MAX(at) WHERE signal_kind='task_quality'` (no migration); (b) explicit `alignment_state.last_survey_at` column (v2 migration). **Recommendation: (a)** (D-LOCK-2) — avoids a migration on the already-shipped `alignment_state`, co-locates reschedule with the EWMA write, and is correct as long as every survey carries a mandatory task_quality item (Task 1's test asserts the precondition). Swappable behind `getLastSurveyAt`.
- **D-DEC-3 — Beliefs-per-survey cap.** Options: 1 / 3 / 5 / unbounded. **Recommendation: 3** (D-LOCK-3) — "short check-in" (§3.3); overflow rolls forward.
- **D-DEC-4 — task-quality scale.** Options: binary good/bad; 1–5 Likert; free 0–1. **Recommendation: 1–5 → (n-1)/4** (D-LOCK-4) — standard short-survey control, clean `[0,1]` endpoints for the EWMA.
- **D-DEC-5 — Dismiss vs snooze semantics.** **Recommendation: dismiss = no-op (re-surfaces next due); snooze = suppress one interval via an unchanged-EWMA marker** (D-LOCK-6). Finer snooze (custom duration) deferred.
- **D-DEC-6 — Survey surface scope.** **Recommendation: TUI-first** (the drive scope). The wire frames + the server-side `Survey` handle are surface-agnostic, so the web/Tauri UI reuses the exact `survey-request`/`survey-response` contract once it consumes the same `ChatService`-style stream — a follow-on, not v1.

---

## Self-review (run after writing, before execution)

**Spec coverage (§2.1 / §2.3 / §2.4 / §3.3):**
- ✅ Survey is a short structured check-in surfaced in the TUI — Task 4 (`SurveyModal`, ≤3 beliefs + 1 task_quality).
- ✅ Verdicts route to `Survey.processVerdict`; proposed beliefs activate/retire — Task 2 (server routing) + Task 5 (proof: confirmed → active).
- ✅ Global EWMA moves on the task_quality signal ONLY; belief_validation excluded — Task 5 (EWMA-moved via task_quality; category-boundary guard test asserts belief_validation alone leaves EWMA at 0). **This is the single plan-breaking point the advisor flagged — handled.**
- ✅ Next survey rescheduled — Task 1 (`getLastSurveyAt` advances on the task_quality append) + Task 5 (outcome 4).
- ✅ Cold start: survey due immediately (EWMA 0 → daily) — Task 1 (cold-start test) + Task 3 smoke (cold-start pending non-null).
- ✅ outreach_welcome modeled but emitter deferred (D4 OUT) — unchanged from merged backend.

**Build-order discipline (mandated):** protocol+types first (Task 1 core, Task 2 ui-ws protocol — pure/shared) → server wiring + trigger (Task 3, boot-risk, smoke-gated) → survey-item sourcing + verdict handler (Tasks 1+2) → TUI modal (Task 4) → end-to-end proof (Task 5). Each independently testable. ✅

**Boot-risk discipline (the KEY hazard):** The ONLY boot-risk surface is Task 3 (chat-server Survey resolution + WS config). It is verified by a runnable `ManagedRuntime` smoke that imports the REAL exported `buildSurveyLayer` (not a mirror), uses NODE-runnable doubles (AlignmentStore.Memory + Ref-backed FakeMem — runs in the default test path, no `bun:sqlite` skip), and is REGRESSION-GUARDED (delete the wiring → smoke FAILS → restore). The three live-wiring boot-gating fixes are carried forward. The TUI (Task 4) has NO layer graph — it is a thin WS client, so its gate is the frame-roundtrip test + the manual run, NOT a smoke (the prior live-wiring Task 5's "TUI survey smoke" is superseded). ✅

**Command discipline (corrected for THIS repo — NOT the first survey plan's style):**
- Tests: `cd /Users/fourcolors/Projects/1_active/luna && bun run vitest run <path>` ✅ (NOT `cd packages/core && bun run tsc`)
- Typecheck: `bunx tsc --noEmit -p tsconfig.json` from repo root ✅ (core/adapter-sdk/ui-ws covered; apps/ui-web NOT → smoke gates it; agent-cli JSX + DuckDB baseline never asserted clean)
- Boot smoke: `bun run apps/ui-web/scripts/smoke/survey-boot.smoke.ts` ✅

**Edge paths (each handled or explicitly deferred):**
- ✅ Cold start — survey due immediately (Task 1 test + Task 3 smoke).
- ✅ No proposed beliefs — survey still surfaces the task_quality item only (Task 1 test).
- ✅ Answer-twice (idempotent) — `at = issuedAt` anchor pinned server-side (Task 2) + the merged idempotency guard (Task 5 replay test).
- ✅ Dismiss — no-op, re-surfaces next due (D-LOCK-6).
- ✅ Snooze — `survey-dismiss` frame → `snooze` advances lastSurveyAt without moving EWMA (Task 1 snooze test).
- ◐ Background timer trigger (vs connection-time) — deferred (openConcern); connection-time is sufficient because the operator must be present to answer.
- ◐ Web client receives the push too — the `survey-request` push (Task 2) fires for EVERY WS connection (gated only on `survey !== null`), and the web UI shares this chat-server. VERIFIED the web client tolerates it: `apps/ui-web/src/App.tsx:147-149` filters frames with `if (frame.type === … || …)` predicates (no exhaustive switch, no throwing `default`), so an unknown `survey-request` is silently ignored — it will not break live web sessions. The web survey UI itself is a follow-on (D-DEC-6); flagged as an openConcern so the web rollout consumes the same frame contract rather than re-inventing it.

**Protocol hygiene:**
- ✅ Plain-TS discriminated unions, NOT Effect Schema (D-LOCK-7) — brief's "Schema-based" wording flagged false; mirrored reality.
- ✅ No exhaustiveness guard on the switches (D-LOCK-8) — new frame cases added manually + roundtrip-tested (Task 4 test asserts the `survey-request` case fires).

**Idempotency anchor (load-bearing, D-LOCK-5):** `issuedAt` carried on the wire; the server PINS every verdict's `at` to it (`{ ...v, at: frame.issuedAt }`), so a buggy/replaying client cannot double-move the EWMA. The client also stamps it (defence-in-depth). Asserted by Task 5's replay test + Task 2's wire test. ✅

**Synthesis honesty:** The critic artifacts were not in context (flagged, same as both prior plans); one adversarial review WAS run via a stronger reviewer and its corrections folded in (most critically the proof-test category boundary). Every load-bearing claim cites verified file:line. The TUI-is-a-WS-client correction (superseding live-wiring Task 5) is grounded in `ws-client.ts`/`headless.ts`/`mount.ts`. ✅

**Scope discipline:** D4 (outreach emitter) + D6 (telemetry read-API) NOT planned here — OUT per the drive. ✅

**Placeholder scan:** No TBD/TODO; every code step has complete code; every test step has assertions; every command has expected output. The one framework-specific area (OpenTUI key wiring in `SurveyModal`) is explicitly flagged for execution-time grounding with the DATA contract (what the test gates) separated from the visual layout (refinable). ✅
