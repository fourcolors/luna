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
