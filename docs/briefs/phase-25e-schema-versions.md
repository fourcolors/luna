# Phase 25e — Per-component migration ladder (`schema_versions` table)

> Fix the migration-collision bug where 5 components share `~/.luna/luna.db` but
> all gate on a single `PRAGMA user_version`. Whichever runs first wins, others
> silently skip. Replace with the per-component `schema_versions` table that
> DESIGN.md §5.2 already specifies.

## §0. Why now

Phase 25c+25d shipped the broker end-to-end, but the very first attempt to seed
an account on a real dev DB failed:

```
$ luna-account add --id sterling --kind anthropic --secret-ref 'luna-op://...'
@luna/agent-cli luna-account: error: insert failed:
  SQLiteError: no such table: accounts
```

Root cause: `~/.luna/luna.db` had `user_version=1` from sessions/messages
migration; account-broker-sql.ts and apps/agent-cli/src/db.ts both check
`if (userVersion < 1) { CREATE accounts ... PRAGMA user_version = 1 }` and
**skip entirely** because the version was already bumped by a different
component. Result: accounts table never exists.

Advisor verified the bug spans **5 modules** sharing the gate:

- `packages/core/src/account-broker/account-broker-sql.ts`
- `packages/core/src/cost-accounting/cost-store-sqlite.ts`
- `packages/core/src/session/session-store-sqlite.ts`
- `packages/core/src/telemetry/telemetry-store-sqlite.ts`
- `apps/agent-cli/src/db.ts`

DESIGN.md §5.2 (lines 442-453) already specifies the right answer:

```sql
CREATE TABLE schema_versions (
  component     TEXT NOT NULL,
  version       INTEGER NOT NULL,
  applied_at    INTEGER NOT NULL,
  PRIMARY KEY (component, version)
);
```

The shipped code drifted to `PRAGMA user_version`. Phase 25e closes the drift.

## §1. Invariants (do not violate)

- **§5.2 contract.** The new `schema_versions` table matches DESIGN.md byte-for-byte.
- **Frozen artifacts unchanged.** Do not edit `errors.ts`, `messages.ts`,
  `packages/adapter-sdk/src/adapter.ts`.
- **CLI decoupling preserved.** `apps/agent-cli/src/db.ts` is intentionally
  decoupled from `@luna/core` (header comment lines 11-13). Inline-duplicate
  the helper there; do NOT add a `@luna/core` dependency.
- **No process-env mutation, no token leakage** — same rules as 25c/25d.
- **Pure-function helper, not an Effect-TS runner.** Keep it small.
- **No backfill of existing rows.** All `SCHEMA_V1` strings already use
  `CREATE TABLE IF NOT EXISTS`, so re-running a v1 migration on an existing
  DB is a no-op CREATE; afterward the `schema_versions` row exists and the
  gate is real. (Advisor's simpler stance — no provenance fiction.)

## §2. Design (advisor-locked minimal shape)

### 2.1 New helper

`packages/core/src/db/schema-versions.ts`:

```ts
import type { BunDb } from "..." // shared type if it exists, else inline

const SCHEMA_VERSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_versions (
    component   TEXT NOT NULL,
    version     INTEGER NOT NULL,
    applied_at  INTEGER NOT NULL,
    PRIMARY KEY (component, version)
  );
`

/** Idempotent. Safe to call from every component on every open. */
export const ensureSchemaVersions = (db: BunDb): void => {
  db.run(SCHEMA_VERSIONS_DDL)
}

/**
 * Run `sql` exactly once for (component, version). Records success in
 * schema_versions in the same transaction. Idempotent across processes
 * via BEGIN IMMEDIATE.
 *
 * Throws on SQL error — caller wraps in ConfigError as appropriate.
 */
export const applyMigration = (
  db: BunDb,
  component: string,
  version: number,
  sql: string,
  nowMs: number,
): void => {
  const has = db.query(
    `SELECT 1 AS x FROM schema_versions WHERE component = ? AND version = ? LIMIT 1`,
  ).get(component, version) as { x: number } | undefined
  if (has !== undefined) return
  db.run("BEGIN IMMEDIATE")
  try {
    db.run(sql)
    db.query(
      `INSERT INTO schema_versions (component, version, applied_at) VALUES (?, ?, ?)`,
    ).run(component, version, nowMs)
    db.run("COMMIT")
  } catch (e) {
    try { db.run("ROLLBACK") } catch { /* best-effort */ }
    throw e
  }
}
```

If a shared `BunDb` type doesn't already exist in core, define it inline
in this file (matches the shape used in account-broker-sql.ts).

### 2.2 Component call-site pattern

Replace each component's existing ladder (lines that look like
`if (userVersion < 1) { ... PRAGMA user_version = 1 }`) with:

```ts
ensureSchemaVersions(db)
applyMigration(db, "<component>", 1, SCHEMA_V1, now)
```

**Component names** (canonical, do not change):

```
accounts     → account-broker-sql.ts
cost         → cost-store-sqlite.ts
sessions     → session-store-sqlite.ts
telemetry    → telemetry-store-sqlite.ts
accounts     → apps/agent-cli/src/db.ts (same component as broker)
```

The CLI uses the same `accounts` component name as the broker — they migrate
the same table, so versioning must agree.

`now`: each component already has access to a clock or `Date.now()`. Use what's
already in scope. Do NOT add a Clock dependency to the CLI.

### 2.3 PRAGMA user_version

**Stop bumping it.** Leave existing values alone (don't reset to 0 — could
break another reader). Just don't reference it in the new code. The
`schema_versions` table is now the source of truth.

### 2.4 CLI inline duplication

`apps/agent-cli/src/db.ts` keeps its no-`@luna/core` policy. Copy `applyMigration`
+ `ensureSchemaVersions` + the DDL constant inline. Add this comment at the top
of the duplicated block:

```ts
// Keep in sync with packages/core/src/db/schema-versions.ts.
// The CLI deliberately does not depend on @luna/core (see header) — drift
// reintroduces the migration-collision bug fixed in Phase 25e.
```

## §3. Commit plan (TDD order)

### 25e/1: regression test (red)

`packages/core/src/db/migration-collision.test.ts`

Reproduces the production bug:

1. Open in-memory DB
2. Run sessions migration (or simulate with a SCHEMA_V1 that bumps user_version=1)
3. Open accounts migration (current code)
4. Assert `accounts` table EXISTS (will fail under current code)

This commit lands the test in the **failing** state — the red bar that proves
the bug is real and that the fix actually fixes it. Other tests must remain green.

### 25e/2: feat(core/db) — schema-versions helper + unit tests

- New file `packages/core/src/db/schema-versions.ts` (helper)
- New file `packages/core/src/db/schema-versions.test.ts` (4 unit tests):
  - `applyMigration` runs SQL on first call
  - `applyMigration` skips on second call (idempotent)
  - `applyMigration` rolls back on SQL error and leaves no row
  - `ensureSchemaVersions` is idempotent
- Export from `packages/core/src/index.ts` (and `db/index.ts` if pattern requires it)
- Regression test from 25e/1 still RED (helper exists but no call sites use it)

### 25e/3: refactor(core stores) — adopt applyMigration

Migrate the 4 core stores to use `applyMigration`:

- `account-broker-sql.ts` — component "accounts"
- `cost-store-sqlite.ts` — component "cost"
- `session-store-sqlite.ts` — component "sessions"
- `telemetry-store-sqlite.ts` — component "telemetry"

After this commit:
- All existing tests for these stores still pass
- Regression test from 25e/1 GOES GREEN

### 25e/4: refactor(agent-cli) — inline the helper

- `apps/agent-cli/src/db.ts` — inline-duplicate helper, swap ladder, component "accounts"
- Add the "keep in sync" comment
- All existing CLI tests still pass

### 25e/5: test + cleanup — fold broker-smoke into live-smoke, prove dev DB fix

This commit closes the loop and removes the throwaway script.

- **Fold `apps/ui-web/scripts/broker-smoke.ts` into `apps/agent-cli/test/live-smoke.test.ts`**
  as a second test, gated by `LUNA_LIVE_SMOKE=1` AND `bun` runtime (existing pattern).
  The new test proves the full chain: keychain → 3 OP layers → routedOp → broker → Redacted<sk-ant-oat>.
- **Delete `apps/ui-web/scripts/broker-smoke.ts`**.
- Run: `bun run typecheck`; `bun run test`; `LUNA_LIVE_SMOKE=1 bun run test apps/agent-cli/test/live-smoke.test.ts`
- Manual verification (in commit body, NOT a script):
  - On a DB with stale `user_version=1` and no accounts table → reboot dev-server-chat → accounts table now created
  - Real broker-smoke equivalent passes against `~/.luna/luna.db`

## §4. Test discipline

- Unit tests use **in-memory bun:sqlite DBs** (`new Database(":memory:")`). No fs writes.
- Regression test must FAIL on the pre-25e/3 code and PASS on the post-25e/3 code.
- Vitest tail with numeric pass/fail in EVERY commit body.
- Do not add fake clocks, multi-process tests, or fuzz harnesses. Advisor said skip those.

## §5. Verification ladder (must run before declaring done)

1. `bun run typecheck` — clean
2. `bun run test` — all green, regression test included
3. Smoke against real DB:
   ```bash
   bun run --filter '@luna/ui-web' dev:server:chat &
   sleep 5
   pkill -f dev-server-chat
   ```
   Boot log must show:
   ```
   [op] 3 providers active: antmachine, mrbot, flow
   [accounts] 1 hydrated: anthropic×1
   ```
4. `LUNA_LIVE_SMOKE=1 bun run test apps/agent-cli/test/live-smoke.test.ts`
   — both tests pass (existing CLI smoke + new broker E2E smoke)

## §6. Out of scope (do NOT do these)

- Effect-TS migration runner (advisor: don't)
- Schema_versions seed/backfill heuristics (advisor: don't)
- Splitting luna.db into per-component .db files (breaks DESIGN.md §5)
- Touching DESIGN.md §5.2 wording (it's correct; code now matches it)
- Optional: a one-line note acknowledging substitution of `@effect/sql` runner
  for the bun:sqlite + helper approach. Add ONLY in the helper docstring,
  NOT in DESIGN.md.

## §7. Final report shape

When done, return:

1. Commit hashes for 25e/1 → 25e/5
2. `bun run typecheck` tail
3. `bun run test` tail (numeric)
4. Live-smoke output (both tests passing under `LUNA_LIVE_SMOKE=1`)
5. Confirmation: regression test was red at 25e/1, green at 25e/3
6. Any deviations + why
7. Confirmation broker-smoke.ts deleted
