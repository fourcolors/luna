# Phase 30b — Test hardening punch list

> Operator asked "what needs to be tested?" after we found and fixed the
> systemPrompt dead-letter bug (chat-service top-level `systemPrompt` field was
> read by zero SDK-path consumers, silently dropped before reaching Claude).
> Same bug class likely exists at two other seams. This brief enumerates the
> tests that would prevent the next instance.
>
> Not a phase in the strict sense (no architectural change). Pure test-debt
> repayment. File ordered by risk × effort: do top of list first.

## §1. Context — why this list exists

The systemPrompt routing fix (commit pending — chat-service.ts:217-219 → slot
into sdkOptions) closed one of three known dead-letter paths for fields that
*should* reach the SDK but don't. The other two:

- `packages/core/src/session/session-service.ts:140-142` —
  `fork()` carries `overrides.systemPrompt` into the child `SessionOptions`,
  which then hits the same adapter that ignores top-level `systemPrompt`.
- `packages/ui-ws/src/server.ts:519-522` (and `ui-shared/wire.ts:215`) —
  the wire-frame `new-thread` accepts `systemPrompt?: string`, forwards into
  `chat.createThread`, which (until commit pending) dropped it on the floor.

Pattern: field is declared on the schema, layered by merge-policy, persisted
to the session row, and never reaches `SDK.query.options`. No contract test
asserts the round-trip, so the bug ships invisibly.

## §2. Tier 1 — high value, low effort (do first)

### 2.1 Contract test: every CreateThreadOptions field reaches SDK options

**File:** extend `packages/chat-service/test/chat-service.sim.test.ts`
**Pattern:** Use the existing `SDKClient.fake((p) => { capturedOptions = p.options })`
harness (already used by the settingSources / permissionMode tests).
**Shape:**

```ts
const FIELDS = [
  { name: "systemPrompt", value: "X-IDENTITY-X", expect: "systemPrompt" },
  { name: "cwd", value: "/tmp/luna-cwd-test", expect: "cwd" },
  { name: "settingSources", value: [], expect: "settingSources" },
  { name: "permissionMode", value: "bypassPermissions", expect: "permissionMode" },
  { name: "mcpServers", value: { foo: {} as never }, expect: "mcpServers" },
] as const

it.each(FIELDS)(
  "createThread: opts.$name lands in SDK options.$expect",
  async ({ name, value, expect: key }) => {
    /* one fake-SDK harness, drive createThread({...defaults, [name]: value}),
       assert capturedOptions[key] equals value */
  },
)
```

**Why:** catches the entire bug class — not just systemPrompt, but anything
new that gets added to `CreateThreadOptions` without the corresponding slot
in `buildSessionOptions`. ~30 lines, blocks regressions forever.

### 2.2 session-service.fork() carries systemPrompt to SDK

**File:** `packages/core/src/session/` test directory (find the existing
fork tests, extend).
**Assert:** Forking a parent session with `overrides.systemPrompt = "Y"`
results in a child whose SDK call sees `options.systemPrompt === "Y"`.
Currently this drops on the same adapter dead-letter as the chat-service bug;
unfixed at time of writing.

### 2.3 ui-ws new-thread frame: systemPrompt round-trip

**File:** `packages/ui-ws/test/server.chat.test.ts`
**Assert:** A wire `{type: "new-thread", systemPrompt: "Z"}` frame results in
the spawned thread's underlying SDK call seeing `options.systemPrompt === "Z"`.
Same dead-letter as 2.2, third path.

### 2.4 DNA.md missing → boot fails loudly

**File:** new — `apps/ui-web/scripts/__tests__/dev-server-chat.boot.test.ts`
(or extract DNA-load helper into a testable module first — recommended).
**Assert:** With DNA.md absent at the resolved path, `buildServerLayer`
throws at Layer build with a clear "DNA.md missing" message. Currently
relies on `readFileSync`'s default ENOENT — the failure surface is
intentional but untested, so a future "graceful fallback" PR could silently
break Luna identity again.

## §3. Tier 2 — medium value, medium effort

### 3.1 End-to-end identity assertion

**Goal:** Fresh thread with DNA.md loaded → fake SDK echoes `options.systemPrompt`
back → assert the system prompt sent to the model contains the literal string
"You are **Luna**" (or whatever the canonical identity sentence is in DNA.md).
**Why:** the symptom Operator actually cares about. Tier 1 tests prove
plumbing; this proves Luna identity reaches the model. Pin the canonical
sentence in DNA.md so the test fails loudly if someone rewrites DNA.md to
say "You are [another agent]" or similar.

### 3.2 HNSW path actually used at scale (not just enabled)

**File:** `packages/memory/test/` or move existing bench into a vitest
integration.
**Assert:** With N=1000 vectors planted, `search()` p95 latency < 5ms. Phase
27a tests assert the `hnswEnabled` flag is `true`, which is necessary but
not sufficient — a bug in the search path could fall back to naive cosine
with the flag still `true`.

### 3.3 Long-running thread (idleTimeoutDisabled) survives extended idle

**File:** `packages/chat-service/test/chat-service.sim.test.ts`
**Pattern:** Use vitest `vi.useFakeTimers()` to advance time by 30+ minutes
between user turns; assert thread Scope, fiber, and SDK handle remain alive
and responsive.
**Why:** `disableIdleTimeout: true` is forced for every chat thread. If the
SDK or our adapter has a hidden timeout deeper than the surface flag, hours-
long chat sessions die silently in production but no test catches it.

### 3.4 Multi-account routing security invariants

**File:** `packages/core/src/account-broker/test/`
**Assert:**
- `op://<rest>` resolves successfully when exactly 1 account registered.
- `op://<rest>` HARD FAILS (not falls through) with >1 account registered.
- `luna-op://<label>/<rest>` routes only to `<label>`, never falls through
  to other accounts.
- Error messages from `luna-op://<label>/...` failures are wrapped with
  `(account=<label>)` and contain ZERO secret material.

Phase 25d core security feature. Currently has unit-level coverage for
parsing but the no-fall-through invariant is a security boundary that
deserves explicit assertion.

## §4. Tier 3 — known unknowns, lower priority

### 4.1 `bun test` vs `vitest` discrepancy

**Symptom seen 2026-04-29:** `bun run --cwd packages/memory test` failed with
"Dimension mismatch" on a vector test that vitest passes 500/576. Two test
runners disagreeing means some module-level state (most likely the
`vectorlite-init.ts` singleton cache) bleeds across tests in one runner but
not the other.
**Action:** pick the canonical runner (vitest, per `package.json` scripts),
gate the other in CI to prevent silent confusion, OR isolate the leaking
state. Don't ship until we know which.

### 4.2 schema_versions migration ladder fwd/back

**File:** `packages/core/src/db/` (find existing migration runner tests)
**Assert:** for each migration in the ladder, `up()` then `down()` returns
the schema to the prior state (idempotent across both directions).
Phase 25e introduced per-component schema_versions; migration ladders have
a known habit of being written, never run.

### 4.3 Memory tools MCP roundtrip

**File:** new — `packages/memory-tools/test/mcp-roundtrip.test.ts`
**Assert:** A thread spawned with the memory MCP server registered can
invoke `memory.search({ query: "X" })` and receive a structurally valid
hit list. Currently the wiring is tested at the Layer level but no test
exercises a real MCP tool call from the SDK side.

## §5. Sequencing

Reasonable PR order, each ~1 commit:

1. §2.1 Contract test (catches the broadest class — write FIRST)
2. §2.2 + §2.3 fork & ui-ws systemPrompt (close the remaining dead-letters)
3. §2.4 DNA.md missing assertion
4. §3.1 End-to-end identity (top-of-stack symptom test)
5. §3.4 Multi-account security invariants (security gates next)
6. §3.2 HNSW @scale, §3.3 long-thread (perf/durability)
7. §4 known unknowns as standalone investigations

## §6. Out of scope (explicit non-goals)

- Architectural refactors (Option B from advisor: routing systemPrompt through
  `composeBasePrompt`). Tracked separately; this brief is pure test-debt.
- DESIGN.md anchor fix (`composeBasePrompt`'s header says §2.1.3, advisor
  verified actually §2.1.5). Tracked separately.
- Frozen artifact changes.

## §7. Definition of done

- Tier 1 tests landed and green in CI.
- Tier 2 tests landed and green; performance assertions documented in
  commit body with measured numbers.
- Tier 3 investigation outcomes documented as their own ADRs or briefs.
- `bun run test` passes from a clean checkout with no flake across 3
  consecutive runs.
