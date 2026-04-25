# Experiment-Agent — Orchestrator Handoff

Continuity doc between orchestrator sessions. Keep it short and append-only at
the bottom so the next orchestrator can read the tail and resume.

## How to resume (for the next orchestrator)

1. Read this file end-to-end.
2. `cd /Users/sol/Projects/experiment-agent && git log --oneline -10`
3. Read `/Users/sol/Projects/experiment-agent/DESIGN.md` §15 (milestones) and
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
2. `git log --oneline -10` from `/Users/sol/Projects/experiment-agent`.
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
2. `git log --oneline -10` from `/Users/sol/Projects/experiment-agent`.
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
