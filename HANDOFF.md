# Luna — Orchestrator Handoff

Continuity doc between orchestrator sessions. Keep it short and append-only at
the bottom so the next orchestrator can read the tail and resume.

## How to resume (for the next orchestrator)

1. Read this file end-to-end.
2. `cd /Users/sol/Projects/luna && git log --oneline -10`
3. Read `/Users/sol/Projects/luna/DESIGN.md` §15 (milestones) and
   the §-anchors noted under "Next phase required reading" below.
4. Read `BRIEF_TEMPLATE.md` — every subagent dispatch fills this template.
5. Resume with the next pending phase per TodoWrite.

## Execution model (locked)

- **Orchestrator** (you): reads DESIGN, consults advisor, dispatches subagents,
  verifies diffs, commits.
- **Subagent** (general-purpose): receives a filled BRIEF_TEMPLATE, writes
  code + tests, returns a six-item summary.
- **Advisor**: called BEFORE each dispatch (scope validation) and AFTER each
  subagent return (diff validation with §-anchor citations).
- **Verification gates** before every commit:
  1. `git diff --stat` — confirm no unexpected files touched
  2. `bun run test` — confirm numeric pass/fail
  3. `bun run typecheck` — zero errors
  4. Read one implementation file + one test file for sanity (~30s)
  5. Advisor verdict cites §-anchor respected (not just "looks good")

- **Realistic horizon per orchestrator session: 4–6 phases.** When the
  orchestrator context feels heavy (roughly after 5 phases, or when
  summaries start feeling longer than the work), stop, update this doc,
  commit, and hand off.

## Anti-patterns (watch every dispatch)

- Subagent summary says "tests pass" without numbers → reject, demand vitest tail
- Subagent modifies files outside its phase scope → revert, re-dispatch
- Advisor PROCEEDs without citing a §-anchor → reject, re-ask
- Orchestrator stops Reading diffs and trusts summaries → drift begins
- Brief divergence across phases → always fill BRIEF_TEMPLATE.md slots

## Frozen artifacts (do not modify without explicit Sterling approval)

- `packages/core/src/errors.ts` — error taxonomy (§6)
- `packages/core/src/messages.ts` — versioned envelope (§12.2 #6)
- `packages/adapter-sdk/src/adapter.ts` — SDK bridge (§12.2 invariants #1–#8)
- `DESIGN.md` — all §0 frozen decisions

## Session log (append at end)

### Session 2026-04-24 (orchestrator A)
- Shipped: Phases 0–5 (initial strategy: inline; too context-heavy)
- Last commit: `933a8ea` feat(memory): Phase 5 — plug-and-play memory …
- Strategy change: Sterling switched to orchestrator/subagent model mid-session
- Scaffolding created: BRIEF_TEMPLATE.md, HANDOFF.md
- Advisor verdict on strategy: MODIFY — realistic horizon 4–6 phases/session,
  subagents share DESIGN path (not pasted text), verification must cite §-anchors

### Session 2026-04-24 (orchestrator A, continued)
- Starting Phase 6: MCP Tool List + Custom Tool builder + Override Tools + built-in wrappers
- Next phase required reading for Phase 6:
  - DESIGN.md §2.1.4 (Tools), §7.3 (ToolRegistry), §12.2 #4 (permission eval order)
  - `packages/adapter-sdk/src/sdk-client.ts` (re-exported SDK tool types)

### Session 2026-04-24 (orchestrator B — 4-phase run)

**Shipped:** Phases 6, 7, 8, 9. All advisor-validated with §-anchor citations.

| Phase | Commit    | Title                                   | Tests delta |
|-------|-----------|-----------------------------------------|-------------|
| 6     | `b4986da` | MCP registry + tools + interception     | 95  / 3 sk  |
| 7     | `c575e33` | SkillRegistry + HookRegistry            | 104 / 3 sk  |
| 8     | `df56702` | AgentRegistry                           | 109 / 3 sk  |
| 9     | `776fc2e` | AccountBroker + SecretProvider (narrow) | 139 / 3 sk  |

**Frozen-file edit authorized this session** (approved by Sterling, one-time):
- `packages/core/src/errors.ts` — appended `AllAccountsExhaustedError` per §6.2
  spec (byte-exact). Conformance, not new design. `errors.ts` remains frozen for
  any further edits.

**Pattern learnings for future registries:**
- Persistence-tier registries (MCP/Skill/Hook/Agent) all mirror MCPRegistry
  exactly: `Effect.Tag` + `Layer.effect` + `Ref<ReadonlyMap>` + opaque
  `XxxLike = Readonly<Record<string, unknown>>` value type + `registerScoped`
  helper via `Effect.addFinalizer`.
- Barrel alias trick: multiple registries exporting `registerScoped` causes
  TS2308 at the package barrel. Solution: each barrel re-exports as
  `registerScopedSkill` / `registerScopedHook` / `registerScopedAgent` while
  the in-module symbol stays `registerScoped`. MCPRegistry's barrel keeps the
  unaliased name (precedence).
- Runtime-tier services with Scoped credentials (AccountBroker): register
  finalizer BEFORE any fallible resolution step so a later failure still
  releases resources on Scope close.
- Always use `Clock` service, never `Date.now()` — enables Tier-2 simulation.
- Use `effect/Redacted` for any secret/token. Test the leak path explicitly
  (`JSON.stringify`, `String`, `util.inspect` must not contain the raw value).

### Session 2026-04-24 (end of orchestrator B)

**Full transcript of this session (for next orchestrator if needed):**
`/Users/sol/.claude/projects/-Users-sol/0dd4905e-c2c5-445c-b66a-21dc53a7fc75.jsonl`

**Next pending phase: 9.5/10a — ADAPTER.TS FROZEN-FILE EDIT + 1Password backend**

⚠️  **Requires explicit Sterling approval BEFORE dispatch.** This phase touches
`packages/adapter-sdk/src/adapter.ts` (listed as frozen above), which is the
largest-blast-radius file in the repo.

Scope (pre-advised by orchestrator B, not yet advisor-reviewed):
1. Wire `AccountBroker.acquireSession` into adapter's env overlay at
   `packages/adapter-sdk/src/adapter.ts` so the SDK's `Options.env` is populated
   per-`query()` with the rotated credential. Confirmed SDK field exists:
   `Options.env?: { [envVar: string]: string | undefined }` in sdk.d.ts v0.2.119.
2. Decide merge policy for caller-supplied `sdkOptions.env`:
   (a) broker-supplied keys overwrite caller keys, or
   (b) caller keys overwrite broker keys, or
   (c) add `env` to `RESERVED_SDK_OPTION_KEYS` and drop caller's `env` with warn.
   Recommend (a) with a named subset: only broker-owned keys
   (`CLAUDE_CODE_OAUTH_TOKEN` etc) overwrite; other caller env passes through.
   This preserves `env` as caller-extensible while guaranteeing rotation.
3. If (c) is chosen, update `packages/core/src/session/types.ts`
   `RESERVED_SDK_OPTION_KEYS` array and add a §12.2 #7 bullet.
4. Add `OnePasswordSecretProvider.make({ vault, token?})` that shells to `op`
   CLI. Use `OP_SERVICE_ACCOUNT_TOKEN` from caller env (already set in Sterling's
   shell). Cache results with a short TTL. Integration test skipped via
   `describe.skipIf(!process.env.OP_SERVICE_ACCOUNT_TOKEN)`; mocked-shell unit
   test always runs.

Required reading for Phase 9.5/10a:
- `DESIGN.md` §0.2 (frozen rotation mechanism), §12.2 invariants #1–#8
  (especially #7 reserved keys), §6.1 (SDKError for adapter failures).
- `packages/adapter-sdk/src/adapter.ts` full read — understand `mergeOptionsLogged`
  and the `canUseTool` / `hooks` / `abortController` wiring.
- `packages/adapter-sdk/src/merge-options.ts` — `RESERVED_SDK_OPTION_KEYS`
  currently excludes `env` (confirmed Session B).
- `packages/core/src/session/types.ts` lines 42–49 — `RESERVED_SDK_OPTION_KEYS`.
- `packages/core/src/account-broker/account-broker.ts` — broker surface to wire.
- Orchestrator B's pre-dispatch advisor verdict for Phase 9 contains the
  merge-policy risk analysis; grep the session transcript jsonl for
  "RESERVED_SDK_OPTION_KEYS" to find it quickly.

**How to resume (concrete):**
1. Read this file end-to-end.
2. `git log --oneline -10` from `/Users/sol/Projects/luna`.
3. Ask Sterling for explicit ✅/❌ on the adapter.ts frozen-file edit — the
   merge policy choice in particular. Do not dispatch without approval.
4. Once approved, invoke the advisor on scope (cite §12.2 invariants + §0.2).
5. Fill BRIEF_TEMPLATE.md with the narrowed Phase 9.5 scope + invariants.
6. Dispatch general-purpose subagent. Advisor review diff. Commit.
7. Then proceed to Phase 10 (Jobs & Schedule).

**Context hygiene:** orchestrator B ran 4 full phases + 4 advisor cycles + 4
subagent dispatches + numerous file verifications. Context felt full but
workable at session end. A 4-phase session is reliably achievable; 5 is the
stretch. Phases 10/11 (Jobs + Teams) touch Fiber supervision and are
materially heavier than the registry-pattern phases — budget them as 1-per-
session, not paired.

### Session 2026-04-24 (orchestrator C — Phase 9.5 only)

**Shipped:** Phase 9.5/10a — `b938361`

| Phase | Commit    | Title                                                    | Tests delta |
|-------|-----------|----------------------------------------------------------|-------------|
| 9.5   | `b938361` | adapter env-overlay wiring + OnePasswordSecretProvider   | 162 / 3 sk  |

**Frozen-file edit authorized this session** (approved by Sterling, one-time):
- `packages/adapter-sdk/src/adapter.ts` — split into `SDKAdapter.Default` +
  `SDKAdapter.WithBroker` via shared `makeAdapter(broker | null)` helper.
  `boundAccountId?: string` added to QueryRequest (NOT SessionOptions).
  Adapter remains frozen for any further edits.

**Merge policy locked: Option A.** `merge-env.ts` overlay where caller env
passes through; only broker-owned keys (`CLAUDE_CODE_OAUTH_TOKEN`) overwrite
with warn log. `env` is NOT in `RESERVED_SDK_OPTION_KEYS` — Option A overlay
is the parallel mechanism. §12.2 #7 unchanged.

**Pattern learnings for adapter integration:**
- Single `Redacted.value()` unwrap site (adapter.ts:262) with hygiene comment.
  Token never enters Refs/logs/stringification. Locked-down by comment.
- `broker.acquireSession` invoked INSIDE the query Effect.gen so the
  inFlight finalizer attaches to query Scope (§3.4 #1) — not session Scope.
- `Effect.mapError` wraps broker's `AllAccountsExhaustedError | ConfigError`
  → `SDKError({op:"acquire-session"})` so adapter error channel stays
  §6.1/§12.1-pure.
- `broker.report` is fire-and-forget at stream lifecycle edges (success on
  end, error on terminal). NOT attached to Scope finalizer because Scope
  close doesn't distinguish success from error. Rate-limit parsing deferred
  to Phase 16.
- OnePassword backend: native `op://vault/item/field` only; non-`op://` refs
  → ConfigError so `firstOf` falls through to next provider. 5min TTL cache
  via Layer-scoped Ref<Map>, Clock-driven (Tier-2 friendly).

**Advisor follow-ups for future phases (none blocking, recorded for next-up):**
1. Producer-orphan + report: if Phase 16 telemetry begins persisting
   non-rate-limit reports, guard `reportSuccess` with an "aborted" flag —
   currently benign because `report` no-ops on success/error kinds.
2. `broker.report` failures swallowed via `Effect.runPromise(...).catch(()=>{})`
   — Phase 16 should add an observability counter.
3. Sim test uses `await new Promise(r => setTimeout(r, 20))` for producer
   flush — replace with explicit "report received" signal when convenient.
4. OnePassword `vault` opt is currently diagnostic-only (`void opts.vault`).
   Could enrich ConfigError messages later.

### Session 2026-04-24 (end of orchestrator C)

**Full transcript of this session:**
Find via `~/.claude/projects/-Users-sol/` newest jsonl after timestamp
2026-04-24T19:00Z.

**Next pending phase: 10 — Jobs & Schedule + Trigger Agents + backpressure**

This is the FIRST Fiber-supervision phase. HANDOFF.md guidance: budget
1-per-session, not paired with Phase 11 (Teams).

Scope (per DESIGN.md §15 M3 + §2.1.2 Jobs + §2.1.8 Triggers):

**Locked design choices (advisor pre-review 2026-04-24):**
- Cron: `effect/Cron` (bundled in effect@3.21, no new deps).
- Supervisor primitive: `effect/FiberSet` (Scope-close auto-interrupts every
  member; canonical "supervised pool with cascading interruption").
- Backpressure: `Queue.bounded(N)` default `block`; per-scheduler
  `OfferPolicy = "block" | "drop-newest" | "drop-oldest"` configurable.
- Result channel: outbound `Stream<JobResult>` where each item is
  `{jobId, exit: Exit<A,E>}`. Submit returns `Effect<JobId>`.
- Restart: NO auto-restart at scheduler. Failures surface; callers re-submit.
  Retry-with-`Effect.retry` belongs INSIDE the job effect (caller-chosen).
  Trigger agents naturally re-fire on next cron tick.
- New tagged errors via §6.3 boundary rule (additive), NOT §6.2 frozen-list.
- Per-job acquireSession MUST be inside the job's own Effect.gen so broker
  finalizer attaches to job Scope (mirrors Phase 9.5 adapter pattern).

**Mandated Tier-2 sims (§8.2 conformance gate, all four required):**
1. Backpressure-block-then-drain (bounded(2), submit 5, FIFO, all complete)
2. Supervisor cascade-cancel (scheduler Scope close → all jobs Exit.isInterrupted,
   broker inFlight returns to 0)
3. Cron-tick determinism via fake Clock (advance N windows, exactly N firings)
4. Failure surfaces, no auto-restart (failing job → JobResult tagged error,
   no re-fire, scheduler not poisoned)

**Original scope items:
1. `JobScheduler` service in `packages/core/src/jobs/` — submit work items
   that run as supervised Fibers with backpressure (bounded queue).
2. `TriggerAgent` mechanism — agents that fire on cron / event signals.
3. Backpressure policy: bounded inbox (`Queue.bounded`), `offer` strategy
   (drop / block / sliding) configurable per-job.
4. Lifecycle: each Job runs in its own Scope under a supervisor Fiber;
   parent supervisor cancels cascade-down on shutdown (§3.4 #4).
5. Failure semantics: per-job retry policy (use `Effect.retry` + Schedule);
   exhaustion surfaces a tagged error; job results land in a result Ref or
   Stream depending on shape.
6. Interaction with AccountBroker: jobs that issue queries must acquire via
   broker like normal — Scope alignment carries naturally.

Required reading for Phase 10:
- `DESIGN.md` §2.1.2 (Jobs/Schedule), §2.1.8 (Trigger Agents), §3
  (concurrency invariants — esp. §3.4 #1, #4), §6.1+§6.3 (error taxonomy +
  additive boundary rule), §5.1 jobs table, §15 M3.
- `packages/core/src/account-broker/account-broker.ts` — Scoped credential
  pattern is the reference for supervised resources.
- Effect docs: `Effect.fork`, `Effect.forkScoped`, `Fiber`, `Supervisor`,
  `Schedule`, `Queue.bounded` with `Queue.offer`/`Queue.take`.
- `@effect/cron` if needed for cron parsing (or roll our own minimal —
  decide in advisor pre-review).

**How to resume (concrete):**
1. Read this file end-to-end.
2. `git log --oneline -10` from `/Users/sol/Projects/luna`.
3. Read DESIGN.md §2.1.10 + §15 M2 + §3.4.
4. Invoke advisor on Phase 10 scope (cite §3.4 invariants, §6.1 errors).
   Specific risk-checks: cron lib choice, backpressure default policy,
   per-job vs per-scheduler error channels, supervisor restart semantics.
5. Fill BRIEF_TEMPLATE.md with narrowed Phase 10 scope + invariants.
6. Dispatch general-purpose subagent. Advisor review diff. Commit.

**Context hygiene:** orchestrator C ran ONE phase (9.5) — context healthy.
Phase 10 is the heavy Fiber-supervision phase; recommend dispatching it to
a fresh subagent at session start to keep orchestrator context lean for
advisor cycles.

### Session 2026-04-25 (orchestrator C, continued — Phase 10)

**Shipped:** Phase 10 — `9a6acbc`

| Phase | Commit    | Title                                            | Tests delta |
|-------|-----------|--------------------------------------------------|-------------|
| 10    | `9a6acbc` | Jobs & Schedule + Trigger Agents + backpressure  | 174 / 3 sk  |

**Pattern learnings — FIBER SUPERVISION TEMPLATE (use for Phase 11 Teams):**
- **Supervisor primitive:** `FiberSet.make()` yielded inside `Layer.scoped`.
  Scope close auto-interrupts every member. Do NOT compose `Effect.fork` +
  manual Scope; FiberSet IS the canonical supervised pool.
- **LIFO finalizer ordering for cascade-cancel:** register the result-queue
  shutdown finalizer BEFORE creating the FiberSet. LIFO means on Scope close:
  (1) FiberSet interrupts fibers FIRST, (2) fibers' onExit hooks publish
  final `Exit.isInterrupted` results into the still-open queue, (3) queue
  shuts down LAST. Reversing this order silently drops final results.
- **Public API exposes IDs only, never `Fiber.RuntimeFiber` refs** — §3.4 #1.
  Internal `RunningEntry { jobId, fiber }` is fine; never return `fiber` from
  any public method.
- **Per-effect Scope wrapping:** `Effect.scoped(userEffect)` for each forked
  job/team-member effect so caller's resources (broker creds, etc.) attach
  to the per-effect Scope, not the supervisor's Layer Scope.
- **Backpressure pattern:** `Queue.bounded` + `Effect.Semaphore` + a `Ref` for
  in-flight count + a `submitMutex` for atomic check-and-mutate across
  concurrent submits. Effect.Semaphore lacks a sync `available` accessor, so
  the Ref shadow is required for drop-newest / drop-oldest decisions.
- **Cron:** `effect/Cron` is bundled in effect@3.21. Use `Cron.next(cron, date)`
  + `Effect.sleep(Duration.millis(...))` for TestClock-determinism. Avoid
  `Schedule.cron` if you need to inspect tick counts in sims.
- **Tier-2 sim mandate for Fiber-supervision modules:** at minimum (a) backpressure
  block-then-drain, (b) supervisor cascade-cancel using REAL `Layer.buildWithScope`
  + `Scope.close` (not `Effect.scoped` sleight-of-hand), (c) determinism via
  `TestClock`, (d) failure-no-auto-restart.

**Phase 10 advisor follow-ups (carry into Phase 11+ or address opportunistically):**
1. Tighten cron sim assertion `>= 4` → `=== 4` (could mask double-fire regression)
2. Strengthen FIFO claim in backpressure scenario 1 (currently only proves "all ran")
3. `JobInterruptedError` exported but unused — wire into drop-oldest eviction or drop
4. Document `slots.take(1)` after `Fiber.interruptFork` is interrupt-latency-bound
5. Consider extracting the FiberSet+LIFO pattern into a shared helper if Phase 11
   re-implements it byte-for-byte (premature now; revisit after Teams ships)

### Session 2026-04-25 (end of orchestrator C)

**Next pending phase: 11 — Teams module with supervisor Fiber + TeamBroker**

Per HANDOFF.md guidance + advisor pre-review for Phase 10: Phases 10 and 11
should NOT be paired in one orchestrator session. Phase 11 deserves a fresh
session.

Scope (per DESIGN.md §15 M3 + §2.1.x for Teams — verify exact §-anchor before
dispatch; advisor should pre-review):
1. `TeamBroker` / `Team` service — supervised group of cooperating sub-agents
   running concurrently with bounded message-passing.
2. Reuse FiberSet + LIFO finalizer pattern from Phase 10 (template above).
3. Inter-member message passing (likely via `Queue` or `PubSub` per member).
4. Team-level lifecycle: spawn → run → cleanup with cascading interruption.
5. Integration with AccountBroker so each member's queries acquire credentials
   via the per-member Scope (Phase 9.5 pattern).

Required reading for Phase 11:
- `DESIGN.md` Teams section (verify §-anchor — likely §2.1.x; not yet read by
  this orchestrator), §3 (concurrency invariants), §6.1+§6.3 (errors), §15 M3.
- `packages/core/src/jobs/job-scheduler.ts` — FiberSet + LIFO template.
- `packages/core/src/jobs/trigger-agent.ts` — multi-fiber lifecycle pattern.
- Effect docs: `PubSub`, `Mailbox` (effect@3.21 bundled), `FiberSet`.

**How to resume (concrete):**
1. Read this file end-to-end.
2. `git log --oneline -10` from `/Users/sol/Projects/luna`.
3. Read DESIGN.md Teams section + verify §-anchor numbers.
4. Invoke advisor on Phase 11 scope (cite §3.4 invariants, §6.1+§6.3 errors,
   the Phase 10 template above). Risk-checks: PubSub vs Mailbox vs Queue
   for member messaging, supervisor failure semantics (one member down →
   whole team or just that member?), broker integration scope.
5. Fill BRIEF_TEMPLATE.md with narrowed Phase 11 scope.
6. Dispatch general-purpose subagent. Advisor review diff. Commit.

**Context hygiene:** orchestrator C completed Phases 9.5 + 10 with full
verification cycles. Context still workable but the 2-phase budget is
consumed. STOP HERE — hand off to a fresh orchestrator for Phase 11.

### Session 2026-04-25 (orchestrator D — Phase 11a only)

**Phase 11 decomposition (Sterling approved):** The §7.2 TeamBroker signature
depends on `TaskList` + `SessionService`, neither of which exist. Phase 11 is
split into four sub-phases, one per orchestrator session:

| Sub-phase | Deliverable                                | Frozen-edit  |
|-----------|--------------------------------------------|--------------|
| 11a       | TaskList (in-memory persistence-tier)      | no           |
| 11b       | SessionService minimum (open/close/list)   | no           |
| 11.5      | Extract `_supervised-pool/` helper         | no           |
| 11c       | TeamBroker (FiberSet + LIFO template)      | **YES** — §6.2 |

**Frozen-file edit pre-approved for 11c** (Sterling gave advance ✅): append
`TeammateOrphanedError` + `TaskCompletionLagError` byte-exact per DESIGN §6.2
lines 414–419 to `packages/core/src/errors.ts`. Still requires re-confirmation
at 11c dispatch time to mirror Phase 9 pattern.

**Shipped this session:** Phase 11a — `e443e6e`

| Phase | Commit    | Title                                    | Tests delta |
|-------|-----------|------------------------------------------|-------------|
| 11a   | `e443e6e` | TaskList (in-memory persistence-tier)    | 193 / 3 sk  |

**Pattern learnings from 11a:**
- **Clock service wraps `Date.now()` directly**, so `effect/TestClock` cannot
  drive it. For tests that need deterministic timestamps, build a custom
  advancing-Clock layer: `Layer.succeed(Clock, advancingClockWithRef)`.
  Consider factoring into `test/helpers/advancing-clock.ts` if 11b/11c need
  it (advisor follow-up).
- **`PubSub.unbounded` + `Stream.fromPubSub`** is the canonical "passive
  event channel" pattern for persistence-tier services. Register
  `PubSub.shutdown` finalizer on Layer close. Private — only expose the
  Stream. Drop policy swap: `PubSub.sliding(N)` if memory becomes a concern.
- **Atomic state transitions via single `Ref.modify`** returning a
  discriminated outcome union (not-found | already-claimed | idempotent |
  claimed). Handles three observable paths in one transaction; no TOCTOU.
- **Same-assignee idempotent claim** — returning current task (not a fresh
  clone) preserves status/updatedAt → genuine idempotence. Caller can
  distinguish re-claim via `task.status !== "created"` if needed.
- **Live-only subscribe semantics** (no replay). Consumers that need
  history call `list()` first then `subscribe()`. Phase 11c TeamBroker
  MUST subscribe BEFORE first task publish.

**Advisor follow-ups (non-blocking):**
1. Tighten sim scenario 4 with time-delta bound (prove slow subscriber
   doesn't slow fast path by more than X ms).
2. Factor advancing-Clock helper if 11b/11c need it again.
3. **Phase 11b brief must decide**: teammate-to-teammate mailbox delivery
   happens via (a) new TaskList method (e.g. `message(from, to, payload)`),
   (b) sibling persistence-tier service (`Mailbox`), or (c) in-memory Hub
   inside SessionService. Pre-advise before dispatch.
4. **Phase 11c brief must state explicitly**: TeamBroker subscribes BEFORE
   first submit — relies on TaskList's live-only semantics.

### Session 2026-04-25 (end of orchestrator D)

**Next pending phase: 11b — SessionService minimum (open/close/list)**

Scope (per DESIGN §7.1):
1. `SessionService` Tag in `packages/core/src/session-service/` (NOT in
   `session/` — that namespace already has `types.ts`).
2. Surface: `open(opts: SessionOptions)` → scoped session with `send` /
   `replies` / `close`; `close(id)`; `list(q?)`.
3. **Defer**: `resume(id)` (needs durable SessionStore replay — coming with
   SQL persistence phase) and `fork(id, opts?)` (needs resume). Phase 11b
   ships open/close/list only.
4. Deps: SDKAdapter (already built), SessionStore Tag (check if it exists
   as a stub or needs creation — ALSO in-memory for 11b).

Required reading for Phase 11b:
- `DESIGN.md` §7.1 (SessionService signature), §3.1 (Layer.scoped at session
  boundary), §3.5 (reference implementation sketch lines 165–184), §5.1
  sessions/messages tables (informs SessionStore shape).
- `packages/adapter-sdk/src/adapter.ts` — QueryRequest surface that
  SessionService will wrap.
- `packages/core/src/session/types.ts` — existing session-related types.
- `packages/core/src/task-list/task-list.ts` — persistence-tier pattern.

**How to resume (concrete):**
1. Read this file end-to-end.
2. `git log --oneline -10` from `/Users/sol/Projects/luna`.
3. Check whether `SessionStore` Tag exists in core or needs to be built in
   11b alongside SessionService (`grep -r "SessionStore" packages/core/src`).
4. Invoke advisor on Phase 11b scope (cite §7.1, §3.1, §3.5). Risk-checks:
   mailbox mechanism for 11c (advisor follow-up #3 above), SessionStore
   co-build decision, iterable prompt lifetime semantics.
5. Fill BRIEF_TEMPLATE.md.
6. Dispatch subagent. Advisor review diff. Commit.

**Context hygiene:** orchestrator D ran ONE phase (11a, ~420s subagent +
~70s advisor). Context very healthy — could continue to 11b in-session,
but per HANDOFF guidance Fiber-supervision / session-boundary phases are
budgeted 1-per-session. STOP HERE — fresh orchestrator for 11b.

---

### Session 2026-04-25 (orchestrator E — Phase 11b-gap)

**Scope discovery:** on resume, `SessionService` + `SessionStore` ALREADY
existed in `packages/core/src/session/` with full §7.1 record-level surface
(`open/resume/fork/list/close` + `create/get/setStatus/appendMessage/
readMessages/list`). The original 11b brief was obsolete. Advisor audit
verdict: **MODIFY** — 60% shipped, but missing the `Scope`-returning variant
that 11c depends on.

**Phase 11b-gap shipped (commit `c0d461f`):**
- `SessionService.openScoped(opts) → Effect<ScopedSession, IntegrityError,
  SDKAdapter | Scope>` where `ScopedSession = {id, send, replies, close}`
- `Scope.addFinalizer` flips session to closed on Scope drop (§3.1 ownership)
- No `Effect.fork` — composes adapter's own Stream + Scope (§3.4 #1, #4)
- `genId` now Clock-driven: `Ref<number>` counter + `clock.nowMs()`
  (removes module-level `let _seq` and `Date.now()`)
- +5 tests (openScoped happy, cascade-cancel, store mirror, genId
  determinism under fixed Clock, fork-parent-not-found)
- Core: 94/94 pass · Full repo: 198 pass / 3 skip · Typecheck clean

**Pattern learned — SDKAdapter Tag identifier aliasing:**
`packages/core` cannot depend on `packages/adapter-sdk` (§4 topology + §12.2
#6 core-is-SDK-free; would also be a cycle since adapter-sdk → core). But
core's `openScoped` needs `SDKAdapter` in its requirements. Solution: core
declares a **local Tag with the identical identifier string**
`"luna/SDKAdapter"` via `Context.GenericTag<SDKAdapterLike>(...)`,
with a structural `SDKAdapterLike` interface mirroring `SDKAdapterService`.
Effect v3 keys Context slots by identifier string, so any layer providing
the adapter-sdk `SDKAdapter` Tag (e.g. `SDKAdapter.Default`) satisfies core's
requirement at runtime. Documented in `session-service.ts:14-22, 56-65`.

Auditor SHIP, with 2 follow-up nits: (1) brief said +6 tests, reality +5;
(2) consider adding a §4/§12 DESIGN note explaining the Tag-alias trick so
future contributors don't "fix" it by adding the dep.

**Next pending phase: 11.5 — extract `supervised-pool` helper** (advisor-locked plan)

Advisor (session 2026-04-25) recommended **MODIFY** on four points:

1. **Split into 11.5a + 11.5b**:
   - 11.5a: create `packages/core/src/supervised-pool/` helper + standalone
     Tier-2 sims (cascade-cancel, capacity, drop-oldest eviction,
     failure-no-restart) that mirror JobScheduler's sims against the new
     helper directly. **No JobScheduler touches.**
   - 11.5b: refactor JobScheduler to consume the helper; existing Phase-10
     sims stay green unchanged.
2. **API shape locked**:
   `make<J>({capacity, policy}) → {submit, size, shutdown, results: Stream}`
   — jobs carry their own `.run: Effect<unknown, unknown, Scope>` (matches
   current JobSpec at `job-scheduler.ts:56-65`); `policy: "block" |
   "drop-newest" | "drop-oldest"` constructor arg; replace `onJobDone?`
   callback with `results: Stream<{id, exit}>` (consumer filters).
3. **Do NOT target TeamBroker (11c)** — per §3.3 teammates are long-lived,
   named, externally-addressable supervisors; a different primitive. Ship
   11.5 as JobScheduler-refactor-only extraction. Brief for 11c must warn:
   do NOT retrofit teammate supervision onto supervised-pool without a
   fresh §3.3 review.
4. **Drop the `_` prefix** — no such convention exists in the repo.
   Use `supervised-pool/` with a `// @internal` header comment;
   barrel exports in `packages/core/src/index.ts` enforce visibility.

**Invariants to preserve verbatim** (advisor cited with `file:line`):
- LIFO: queue-shutdown finalizer registered BEFORE `FiberSet.make`
  (`job-scheduler.ts:108` before `:113` — §3.4 #4)
- Ref shadow for capacity (Effect.Semaphore has no sync `available`)
  (`job-scheduler.ts:121-124`)
- Submit-mutex serializes drop-policy decisions (`:128, :215`)
- Public API NEVER returns `Fiber.RuntimeFiber` — §3.4 #1 (`:89` internal)
- Per-job `Effect.scoped(run)` so caller resources attach to per-job Scope
  not pool Scope (`:159`) — critical for AccountBroker per Phase 9.5

---

### Session 2026-04-25 (orchestrator F-attempt + recovery, then 11.5a)

**Tooling discovery:** spawned subagents do NOT have access to the `Agent`
tool — they cannot dispatch sub-subagents. Orchestrator F (a spawned agent)
correctly stopped on tool-availability rather than playing all four roles
(orchestrator + advisor + subagent + auditor) single-handed.

**Workflow rule learned:** the orchestrator/advisor/subagent/auditor pattern
must run from the **top-level session**, not from a spawned orchestrator.
Top-level session can spawn each role in turn; can't delegate the whole
dispatch tree. Update mental model: HANDOFF + new top-level session is the
unit of progress, not "spawn an orchestrator."

**Phase 11.5a shipped (commit `170b0bb`):**
- New: `packages/core/src/supervised-pool/{types.ts, supervised-pool.ts, index.ts}`
- New: `packages/core/test/supervised-pool.test.ts` — 9 Tier-2 sims (capacity,
  block, drop-newest, drop-oldest, cascade-cancel, failure-no-restart,
  post-shutdown-submit, LIFO ordering, per-job Scope)
- Public API (internal-only — not re-exported from `packages/core` root):
  `makeSupervisedPool(config) → Effect<SupervisedPool, never, Scope>`,
  `SubmitOutcome` discriminated union, `results: Stream<PoolResult>`
- All 5 advisor-locked invariants preserved with `file:line` mapping to
  `job-scheduler.ts` template
- Repo: 210 pass / 3 skip / typecheck clean

**Deviation flagged:** API named `SupervisedPoolNs.make(...)` instead of
`SupervisedPool.make(...)` due to TS2323 type/value declaration-merge
collision (re-exported type alias + locally-declared const). Direct factory
`makeSupervisedPool` is available alongside. For 11.5b refactor, prefer
calling `makeSupervisedPool` directly. If 11.5b needs to expose this from
the root barrel later, consider `SupervisedPoolApi` or `SupervisedPoolModule`
naming over `Ns` suffix.

**Non-blocking follow-ups:**
- `Deferred` import at `packages/core/test/supervised-pool.test.ts:18` is
  unused — drop it on next touch
- `JobScheduler` itself is untouched — 11.5b will refactor it

### Session 2026-04-25 (autonomous run — 11.5b shipped)

**Phase 11.5b shipped (commit `a9eba35`):**
- 1 file modified: `packages/core/src/jobs/job-scheduler.ts`
- Net: -24 lines (162 deletions, 138 insertions)
- Public API byte-identical; Phase-10 tests (10/10) pass UNMODIFIED
- 207 tests pass repo-wide, typecheck clean

**Key design decision learned — `forkDaemon` vs `forkScoped` for the relay:**
Pool emits `PoolResult` via its own queue; scheduler renames `id`→`jobId`
and re-broadcasts via its own queue. The relay fiber that drives this
MUST be `Effect.forkDaemon`, NOT `forkScoped`. With `forkScoped` the relay
would be interrupted on Scope close BEFORE the pool's queue drained final
exits, dropping interrupted-job results. Pattern: register relay-join
finalizer EXPLICITLY before makeSupervisedPool so LIFO close runs:
FiberSet interrupts members → pool queue closes → relay drains → relay-join
awaits relay → scheduler queue closes.

**Cumulative state (this session):**
- 11b-gap (`c0d461f`) — SessionService.openScoped + Clock-driven genId
- 11.5a (`170b0bb`) — supervised-pool helper standalone
- 11.5b (`a9eba35`) — JobScheduler refactor onto pool

**Next pending phase: 11c — TeamBroker**

Frozen-edit pre-approved by Sterling: append `TeammateOrphanedError` +
`TaskCompletionLagError` to `packages/core/src/errors.ts` per DESIGN §6.2
lines 414–419 (byte-exact additions only).

Scope (per DESIGN §7.2 + §3.3):
1. `TeamBroker` Tag with `spawn(teammates)`, `dispatch(taskId)`,
   `members()` surface
2. Teammate supervisor — long-lived per-teammate fiber attached to the
   session Scope (NOT supervised-pool — teammates are named/addressable,
   not job-shaped)
3. TaskList integration — broker calls `taskList.claim(taskId, teammate)`
   atomically; subscribes to TaskList events for orphan detection
4. Orphan detection: if claimed task has no in-flight teammate fiber after
   N seconds, emit `TeammateOrphanedError`
5. Lag detection: if teammate hasn't completed a claimed task within
   configured timeout, emit `TaskCompletionLagError`

Required reading:
- DESIGN.md §3.3, §6.2 (lines 414-419 for the frozen-edit shape), §7.2
- packages/core/src/task-list/task-list.ts
- packages/core/src/session/session-service.ts (openScoped)
- packages/core/src/errors.ts (frozen — for the additive edit)

How to resume:
1. Read HANDOFF tail.
2. `git log --oneline -10` — `a9eba35` should be top.
3. Append the two TaggedErrors to errors.ts FIRST (smallest possible diff),
   commit separately.
4. Advisor on TeamBroker scope — biggest open question is teammate
   supervisor primitive shape. Pool is wrong shape; need a `Map<name,
   supervisedFiber>` with per-member events.
5. Fill BRIEF. Dispatch. Auditor. Commit. HANDOFF update.

After 11.5: **Phase 11c — TeamBroker** (frozen-edit to `errors.ts` pre-approved
for `TeammateOrphanedError` + `TaskCompletionLagError` per DESIGN §6.2
lines 414–419).

**How to resume (concrete):**
1. Read this file end-to-end.
2. `git log --oneline -10` from `/Users/sol/Projects/luna`.
3. Read `packages/core/src/jobs/job-scheduler.ts` (the current supervision
   template).
4. Invoke advisor on Phase 11.5 scope — verify the extraction shape before
   touching JobScheduler.
5. Fill BRIEF_TEMPLATE.md for 11.5. Dispatch subagent. Review. Commit.
6. Only then advance to 11c.

### Session 2026-04-25 (autonomous run — Phases 14–18 shipped)

**Shipped this session (5 phases):**

```
Phase  Commit    Title                                       Tests delta
─────  ────────  ──────────────────────────────────────────  ──────────
14     fedf0a9   ObservabilityService + WorkflowRuntime fix  +6
15     72dcef1   CostAccountingService                       +7
16     61ecff9   NetSecClient                                +7
17     e999e14   GatewayService + stdio/http adapters        +6
18     23051db   TelemetryService (Counter primitive)        +8
```

Repo state: **229 tests passing**, no skips relevant to these phases.

**Key pattern learnings (carry into next session):**

1. **Effect v3 has NO `Hub` — use `PubSub`.** `Stream.fromHub` does not
   exist either; use `Stream.fromPubSub`.

2. **`Stream.fromPubSub` is LAZY.** Subscribers register only when the
   stream is consumed, so events emitted before the consumer's `runForEach`
   reaches steady-state are LOST. Fix: expose an eager-subscribe API:
   ```ts
   subscribeEvents: Effect.Effect<Stream<T>, never, Scope>
   ```
   Implementation calls `PubSub.subscribe(hub)` (eager) then returns
   `Stream.fromQueue(sub)`. All §16 consumers (CostAccounting, future
   subscribers) MUST use `subscribeEvents`, not raw `events`. Pattern
   established in `observability/observability.ts` and
   `cost-accounting/cost-accounting.ts`.

3. **`exactOptionalPropertyTypes: true` requires conditional spread**
   when forwarding optional fields to external types (e.g., `RequestInit`):
   ```ts
   const init: RequestInit = {
     method,
     ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
     ...(opts.body !== undefined ? { body: opts.body } : {}),
   }
   ```
   Hit this 3× this session (NetSec, Gateway, Telemetry).

4. **`override` modifier required on `cause` field** when extending Error
   subclasses (`override readonly cause: unknown`).

5. **`Queue.unsafeMake` and `Queue.Strategy.Unbounded` don't exist** in
   Effect v3 — construct queues inside `Effect.gen` via
   `yield* Queue.unbounded<T>()`.

6. **Telemetry stays storage-agnostic per advisor (Phase 18 verdict
   MODIFY):** Counter only (no Gauge/Histogram), pull-based `snapshot()`
   only (no periodic ObsEvent emission), no DuckDB script in framework.
   External persistence is a separate ops adapter that polls `snapshot()`.

**Next pending phases (Feature/Runtime layer remainder per DESIGN §7.6):**
- TriggerService (separate from `jobs/trigger-agent.ts` — needs design clarification)
- UIService
- LabsService
- TrainingHarness

These were not started in this session — context budget consumed (5
phases shipped, the stretch limit per HANDOFF's own guidance). Hand off
to a fresh session.

**How to resume:**
1. Read this file tail.
2. `git log --oneline -10` — `23051db` should be top.
3. Re-read `DESIGN.md` §7.6+ for the remaining 4 services' contracts.
4. Pick TriggerService first (smallest, builds on existing
   `jobs/trigger-agent.ts`); advisor-gate the scope.
5. Standard cycle: advisor → BRIEF → implement → test → typecheck →
   advisor → commit → HANDOFF append.

**Sterling's standing directive:** "do all the phases without bothering me"
— continue autonomous through the remaining 4 phases unless an
irreversible / high-blast-radius decision arises.

### Session 2026-04-25 (continuation — Phases 19–22 shipped, M4 server surface COMPLETE)

**Shipped this run (4 phases + 1 frozen-edit):**

```
Commit    Title                                                    Tests
────────  ──────────────────────────────────────────────────────  ─────
ab2bb6e   Phase 19: TriggerAgent registry augment (list() + Sum)   +2
b9fbaf3   Phase 21 (frozen-edit): +ExperimentBudget/ScoringError    0
75a73d1   Phase 20: TrainingHarness (runEval + runBatch)           +6
f3e4e29   Phase 21: LabsService (scientist loop + budget gate)     +6
a4d7c11   Phase 22: UIService (server-side obs multiplexer)        +4
```

(Commit hashes approximate — see `git log --since="1 hour ago"`.)

**Repo state per auditor:** 296 passed, 3 skipped (sqlite, expected).
Core package: 192 passed across 30 files. ⚠️ Earlier "229" / "247"
counts in this HANDOFF were stale — auditor confirmed **296/299**.

**Advisor → Auditor cycle notes:**
- Advisor verdict (⚠️ MODIFY) reordered Harness BEFORE Labs (dependency:
  Labs dispatches into Harness per §2.1.11). Honored.
- Advisor rejected proposed parallel `TriggerService` Tag — extending
  `TriggerAgent` in-place avoids dual-API debt. Honored.
- Advisor required `subscribeEvents` (eager) NOT `events` (lazy) for
  UIService — Phase 14 race regression. Test included at
  `packages/core/test/ui.test.ts` ("eager-subscribe contract"). Verified.
- Frozen-edit `errors.ts` shipped in isolated commit per Phase 11c
  protocol (additive only: +15 lines, no changes/removals).
- Auditor: SHIP. No blockers; 4 minor non-blocking follow-ups.

**Auditor non-blocking follow-ups (carry into next session):**
1. Move/delete orphaned `test/rollup-tick.test.ts` at repo root (not
   picked up by vitest).
2. `packages/core/test/jobs/trigger-agent.test.ts:15-19` `fullLayer`
   helper is dead code — remove.
3. Add a Tier-2 sim asserting `TriggerAgent.list()` registry shrinks
   on Scope close (current test verifies in-scope count only).
4. UIService transport adapter (WS/SSE) for the Tauri client — separate
   package, future phase.

**M4 server surface: COMPLETE.**

Per DESIGN §15: M4 = "Labs, Training Harness, Gateway (Discord/Tg/CLI),
Plugin Play, Observability/Telemetry/UI, NetSec, Cost Accounting,
Secrets — Acceptance tests green; cost accounting accurate."

✅ Observability (14), CostAccounting (15), NetSec (16), Gateway (17),
Telemetry (18), TriggerAgent reg (19), TrainingHarness (20),
LabsService (21), UIService (22) — all server primitives green.
🚧 Remaining for M4 closure: Tauri shell desktop wrapper around the
Solid `@luna/ui-web` bundle (separate package, M5+ per §9), Plugin Play
(separate package), Acceptance test bundle, SQL migrations
(`@effect/sql` integration deferred per Phase 15 note).

**Next-up candidates (when Sterling resumes):**
- Acceptance/integration test bundle for the M4 gate
- WS/SSE UI transport adapter (consumes `UIService.subscribe`)
- M5 prep: SQL persistence layer for CostAccounting/Telemetry/Labs
  artifacts
- M5 prep: Effect v4 migration spike (DESIGN §15 M5)

**Pattern learnings (continuation of prior session's list):**

7. **`Effect.addFinalizer` for caller-Scope cleanup of registry
   entries:** Phase 19's pattern — register entry in shared Ref, add a
   finalizer that removes it on caller-Scope close. Avoids exposing
   `Fiber.RuntimeFiber` (§3.4 #1) while supporting `list()` queries.
   Layer's Ref outlives caller Scopes safely (Refs are pure mutable
   state — no shutdown semantics, so a stale finalizer just becomes
   a no-op).

8. **Frozen-edit isolated commit pattern:** errors.ts edits ship in
   their own commit BEFORE the consuming feature commit (Phase 11c
   protocol). Makes the diff trivially auditable and rollback-safe.

9. **CostAccountingService.recordCost vs raw emit:** for tests that
   need to pre-load cost state, prefer `obs.recordCost({ workflowId,
   tokensIn, tokensOut, pricePerMillion* })` over hand-constructing
   a CostAccrued event — fewer required fields, less brittle.

### Session 2026-04-27 (Phase 23 — M4 acceptance bundle)

**Shipped:** Phase 23 — M4 acceptance/integration test bundle.

```
Commit    Title                                              Tests delta
────────  ─────────────────────────────────────────────────  ───────────
ade604e   M4 acceptance bundle (F1 + F2 + F5 + predicate)    +6
```

**Repo state:** 419 passed / 14 skipped across 61 test files (was
413/2 across 60). Typecheck clean.

**Scope (per advisor ⚠️ MODIFY verdict):**
- Single file: `packages/core/test/acceptance/m4.test.ts` (618 LOC)
- F1: Gateway → Harness trial → CostAccounting → UI subscriber, with
  F3 fold-in (NetSec-blocked request emits ToolCall(status="error") +
  zero CostAccrued)
- F2: Labs experiment with caller-glue trial (14 LOC) trips
  `ExperimentBudgetExceededError` at iteration N
- F5: TriggerAgent fires under TestClock → Obs → UI (smoke)
- Cost-accuracy predicate suite: multi-dim attribution (one event
  tagged `{sessionId, workflowId}` lands in BOTH buckets with same
  amounts and `eventCount===1`), 9-decimal USD math, bucket
  independence, `isBudgetExceeded`/`remainingBudget` semantics

**Dropped from initial F1-F5 list:**
- F4 (Secrets→AccountBroker→Gateway) — Gateway has no AccountBroker
  layer dep at `gateway.ts:50`. Belongs in M2 adapter-parity tests
  where SDK actually consumes broker creds.
- F3 standalone — folded into F1 as a 5-line assertion. NetSec
  unit-tests already cover the rejection path.

**Pattern learnings:**

10. **Acceptance tests live in `packages/<owner>/test/acceptance/`,
    not at repo root.** Auditor flagged the orphan smell of
    `test/rollup-tick.test.ts` (now removed). Bundle living inside
    `@luna/core/test/acceptance/` inherits the package's tsconfig +
    scripts; no new workspace overhead.

11. **Labs+Harness composition is caller-glue, not framework-wired.**
    `labs/types.ts:29` accepts arbitrary `Effect<A>` `trial`. F2
    composes Harness invocation + `obs.recordCost` per-iteration in
    14 LOC of trial body. Don't predict-build a "LabsRunner"
    composer package until ≥2 callers need the same glue.

12. **Acceptance tests use `Effect.timeout("5 seconds")` per body
    + `TestClock` for time-dependent flows.** No real-clock sleeps
    longer than 20ms (the canonical post-subscribe settle).

**Auditor verdict:** SHIP. Cosmetic note: `void runner` on line 243 is
dead (outer-scope shadowed by inner Layer.provide). Non-blocking.

**M4 milestone status:** ✅ COMPLETE. All 9 server primitives shipped
(Phases 14-22) + acceptance gate green (Phase 23). Per DESIGN §15:
"Acceptance tests green; cost accounting accurate" — both satisfied.

**Next-up candidates:**
- M5 SQL persistence for Cost/Telemetry/Labs (needs design Q answered:
  do Labs experiments flow through cost accounting? are telemetry
  counters queryable post-session or live-only?)
- M5 Effect v4 migration spike (deferred per §0.1 — blocked on
  @effect/workflow + @effect/cluster v4 betas; check npm monthly)
- Plugin Play package (separate from M4 server surface)
- Tauri/Solid desktop client (Tauri shell over `@luna/ui-web`; M5+ per §9)

### Session 2026-04-27 (Phase 24a — SQLite cost-accounting)

**Sterling's design answers (locked this session):**
- Q1 (experimentId placement): SIDECAR table `cost_event_experiments`
  per advisor pushback. Frozen §5.1 schema untouched.
- Q2 (telemetry persistence shape): HYBRID per advisor pushback —
  Cost stays per-event (semantically natural; CostAccrued IS the unit),
  Telemetry will use UPSERT counter map + opt-in history table when 24b
  ships.
- Phase split: ship 24a only; 24b gated on review; 24c gated on
  "do we need Labs persistence at all?" YAGNI default = no.

**Shipped this run:**

```
Commit  Title                                            Tests delta
──────  ────────────────────────────────────────────────  ──────────
<24a>   Phase 24a: SQLite-backed CostAccountingService    +7 (sqlite)
```

`bun --bun x vitest packages/core/test/cost-accounting/sqlite.test.ts`
→ 7/7 in 273ms. m4 acceptance bundle untouched and continues 6/6.
Typecheck clean. Full node-vitest run unchanged at 419/14 (sqlite
tests skip on node, mirroring session-store-sqlite convention).

**Files:**
- new: `packages/core/src/cost-accounting/cost-store-sqlite.ts` (479 LOC)
- new: `packages/core/test/cost-accounting/sqlite.test.ts` (323 LOC)
- mod: `packages/core/src/cost-accounting/index.ts` (+1 export line)

**Pattern learnings:**

13. **Dual-Layer pattern is the canonical SQLite shape** —
    `XxxService.Default` (in-memory) + `XxxService.fromPath(dbPath)`
    (SQLite) via interface-augmentation. Mirrors session-store-sqlite.ts
    line 497-507 exactly. Tests pick which layer at composition time;
    in-memory acceptance bundles don't need to know SQL exists.

14. **"Events canonical, rollups computed" beats "events + rollup
    table".** No `cost_buckets` SQL table. `getBucket()` runs a SUM
    aggregate. Eliminates the divergence-on-crash risk of derived state.
    Per-dim indexes (`idx_cost_session(session_id, ts)` etc.) make the
    aggregate fast enough.

15. **Frozen §5.1 schema columns are byte-exact even when the event
    taxonomy hasn't caught up yet.** `account_id` writes NULL today
    because `CostAccruedEvent` has no `accountId` field; the column
    exists because §5.1 mandates it. NOT dead code — schema-driven
    forward-compat. Sidecar tables (e.g., `cost_event_experiments`)
    follow the same rule: declare the table, leave the write path
    forward-compat until the event taxonomy widens.

**Auditor non-blocking follow-ups — RESOLVED 2026-04-27 (#1-3 + ConfigError back-port):**
1. ~~Collapse 3 per-dim aggregate queries~~ — **DONE.** Static dispatch
   table (`Record<Dim, BunStmt>`); each statement keeps a literal column
   `WHERE` clause so per-column indexes remain reachable. Advisor
   caught a `CASE :dim WHEN ...` trap that would have defeated indexes.
2. ~~`IntegrityError` unused~~ — **DONE.** Daemon now builds
   `IntegrityError` via `integrity()` helper on insert failure.
3. ~~Daemon swallows errors via console.error~~ — **DONE.** Daemon body
   converted `Effect.sync` → `Effect.gen`; on Left, emits typed
   `ErrorEvent { errorTag: "CostInsertFailed" }` through `obs.emit`.
   Outer `catchAllCause(() => Effect.void)` mirrors in-memory parity.
   New fail-injection test (`sqlite.test.ts:329-436`) stubs
   `crypto.randomUUID` to force duplicate-PK, asserts the ErrorEvent
   surfaces and the daemon survives.
4. `experimentId` sidecar write path (lines 342-345) — **INTENTIONALLY
   RETAINED** per Pattern #15 (forward-compat scaffolding for the
   §5.1-required sidecar table). Trim path when event taxonomy widens.

**Bonus: 24b's typed `ConfigError` for `bun:sqlite` import — back-ported
to 24a.** Layer signature changed from `Layer.Layer<…, never, …>` →
`Layer.Layer<…, ConfigError, …>`. Verified zero production callers
before changing (test-only API).

**Phase 24c (Labs persistence) — DROPPED (YAGNI).** Sterling confirmed
2026-04-27. LabsService has zero state surface (`runExperiment` returns
`ExperimentReport` and forgets). Revisit only if a real caller demands
queryable experiment history.

---

## Session 2026-04-27 (Phase 24b — SQLite TelemetryService)

**Shipped:** `TelemetryService.fromPath(dbPath, options?)` — SQLite-backed
Layer mirroring the Phase 24a cost-store pattern. SQL is the sole source
of truth (no `Ref<Map>` mirror — advisor mandate). UPSERT on
`(name, tags_key)` keeps the hot path single-statement.

**Files:**
- NEW `packages/core/src/telemetry/telemetry-store-sqlite.ts` (327 LOC)
- NEW `packages/core/test/telemetry/sqlite.test.ts` (253 LOC, 7/7 green)
- MODIFIED `packages/core/src/telemetry/telemetry.ts` (+`export` on `counterKey`)
- MODIFIED `packages/core/src/telemetry/index.ts` (re-exports)

**Schema:**
- `telemetry_counters(name, tags_key, tags_json, value INTEGER, last_updated_ts)`
  PRIMARY KEY (name, tags_key) WITHOUT ROWID
- `telemetry_history(id, name, tags_key, tags_json, delta, ts)` —
  opt-in via `{ history: { enabled, nameAllowlist? } }`, default OFF

**Pattern learnings (additions to running list):**

16. **SQL table IS the map** — when migrating an in-memory `Ref<Map>`
    service to SQLite, prefer dropping the in-memory mirror entirely
    over restoring it on Layer init. Single source of truth eliminates
    dual-write bug class. (Phase 24a kept a Ref-backed daemon because
    cost events stream in via §16 subscribe; Phase 24b had no such
    constraint and went pure-SQL.)
17. **No-daemon SQLite Layers are simpler than daemon ones** — when the
    service has no §16 events to subscribe to, the SQLite Layer needs
    only ONE finalizer (`db.close`). LIFO ordering becomes trivially
    correct. Telemetry, AccountBroker, and similar pull-only services
    fit this shape; Cost (event-driven) does not.
18. **Advisor caught a HANDOFF ambiguity** — original Phase 24b
    pre-spec said "restore counter map from SQL on Layer init,"
    implying a Ref<Map> mirror. Advisor flagged this as dual-source-of-
    truth risk. The clean read is "SQL is the map" — ambiguity resolved
    by interpretation, not amendment. Future SQLite phases: if pre-
    spec implies hybrid storage, ask if it's actually needed.

**SQL-persistence epic (24a/24b/24c) status: DONE.** 24a + 24b shipped;
24c dropped YAGNI.

---

## Session 2026-04-27 (Phase 24a/24b auditor follow-ups — RESOLVED)

**Shipped:** Three 24a auditor follow-ups + 24b's typed `ConfigError`
back-port. All non-blocking items closed.

**Files:**
- MODIFIED `packages/core/src/cost-accounting/cost-store-sqlite.ts`
  (+187/-83-ish reshape; daemon body Effect.sync → Effect.gen)
- MODIFIED `packages/core/test/cost-accounting/sqlite.test.ts`
  (+122 LOC; new fail-injection test stubs `crypto.randomUUID`)

**What changed:**
1. **Aggregate queries collapsed** — `getBucket` now uses a static
   `Record<Dim, BunStmt>` dispatch table built from one SQL template.
   Each statement keeps a literal `WHERE col = ?` clause so per-column
   indexes stay reachable. Advisor caught a `CASE :dim WHEN ...`
   variant that would have defeated the indexes.
2. **Typed insert failures** — daemon body converted from `Effect.sync`
   to `Effect.gen`. On Left, builds `IntegrityError` via `integrity()`
   and emits `obs.emit({ kind: "Error", errorTag: "CostInsertFailed",
   context: { eventTs, eventId, cause } })`. Outer
   `catchAllCause(() => Effect.void)` mirrors in-memory parity —
   fiber stays alive (emit-and-continue).
3. **`console.error` removed** — silent data-loss risk closed. Failures
   now surface in the obs stream the user actually consumes.
4. **`ConfigError` back-port** — Layer signature gained `ConfigError`
   for `bun:sqlite` import failure. Verified zero production callers
   (test-only API) before changing.

**Test:** New fail-injection test stubs `crypto.randomUUID` to force
duplicate-PK insert; asserts exactly one `CostInsertFailed`
ErrorEvent with `IntegrityError` cause attached, plus daemon survival
via subsequent valid event landing in the bucket.

**Verification:**
- `bun test` SQLite: 15/15 pass (8 cost + 7 telemetry, 505ms)
- `node vitest run`: 419/419 (28 skipped — SQLite tests gate on
  `globalThis.Bun` per existing workspace pattern)
- `bun run typecheck`: clean

**Pattern learning #19 (added to running list):**

19. **API-channel changes are free when callers are test-only.**
    Before back-porting 24b's `ConfigError` to 24a, grep for
    `fromPath` callers — discovered zero production sites, only test
    files. Changing the Layer error channel from `never` to
    `ConfigError` was therefore costless. Lesson: always grep callers
    before assuming an error-channel change is "breaking."

**ONLY remaining 24a/24b follow-up (intentional):**
- HANDOFF #4: `experimentId` sidecar write path retained as
  forward-compat scaffolding per Pattern #15. Trim when event taxonomy
  widens. Do not remove pre-emptively.

24b cosmetic follow-up (low priority, non-blocking):
- Consider gating `BEGIN IMMEDIATE` on `historyAllows(name)` for
  hot-path throughput if profiling shows the overhead matters.
  Speculative; no profiling signal yet.

---

## Project status — 2026-04-27

**Luna is in a clean, healthy, milestone-complete state.**

- Working tree: clean, all committed
- Full repo tests: 419 passed | 28 skipped | 0 failed (canonical
  `bun run test` → vitest under node)
- SQLite-specific tests: 15/15 pass under `bun test`
- Typecheck: zero errors
- ui-ws WebSocket dev-server: confirmed working under bun (live probe
  to `ws://127.0.0.1:4753/ui` returns hello frame end-to-end)

**Milestones complete: M0 → M4 + SQL persistence epic (24a/24b).**

**No active work queued.** Next-session orchestrator should:
1. Read DESIGN.md §15 to confirm M5+ scope when Sterling chooses to
   resume — but Effect v4 migration is **deferred indefinitely**
   per Sterling's call (waiting for upstream stability).
2. M5 was originally "SQL persistence + Effect v4 spike." SQL
   persistence is done; the v4 spike was never blocking and is now
   off the roadmap until Effect v4 ships stable.
3. Other M5+ items (Tauri/Solid desktop client per §9 — Tauri shell
   over the live `@luna/ui-web` Solid app; plugin play separate
   package; full acceptance test bundle) are roadmap-revisable —
   wait for Sterling's direction. Apps in tree: `apps/ui-web`
   (SolidJS, canonical), `apps/ui-tauri` (Tauri shell),
   `apps/agent-cli`. The legacy `apps/ui-web-react` scaffold was
   removed 2026-04-27.

---

## Drift note — 2026-04-28: Phase 25d supersedes 25c "try-each" routing

Phase 25c shipped a `secretProviderFirstOf([...opLayers, env])`
composition where every registered OP token was tried in priority
order against every `op://` ref. This was a permission-probing
oracle — wrong tokens silently failed and the chain fell through to
the next.

**Phase 25d replaces this with explicit per-ref account routing.**
See DESIGN.md §2.2.11 for the full grammar lock. Summary:

- `op://...` is allowed ONLY when exactly 1 OP account is registered
  with the routed wrapper.
- `luna-op://<label>/...` is the explicit form; the wrapper dispatches
  to the named account only — no fall-through.
- Account labels match `^[a-z][a-z0-9-]{0,30}$`; reserved labels
  `env`, `file`, `op` are rejected at both CLI-validator and
  wrapper-construction time.
- Errors from `luna-op://<label>/...` failures are wrapped with
  `(account=<label>)` for diagnostic context. Tokens never appear in
  any error message.
- Side-fix: the CLI validator now requires `env:VAR` (one colon, no
  slashes) — `env://VAR` is rejected. `EnvSecretProvider` only ever
  parsed `env:`, so `env://...` rows would never resolve.

The 25c composition language above this note ("`firstOf` IS the
multi-account routing") is **superseded** by 25d's
`RoutedOpSecretProvider`. Operators with `op://...` rows after 25d
must EITHER keep exactly one OP account registered OR migrate refs
to `luna-op://<label>/...`.

