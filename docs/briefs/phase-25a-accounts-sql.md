# Subagent Phase Brief — Phase 25a: Accounts SQL Hydration

> Closes the §0.2/§5.1 deferral for AccountBroker. Adds SQL-backed
> account storage (load-once-at-boot). NO CLI, NO dev-server changes
> in this phase — those land in 25b.

---

## Context (advisor-verified, do not redo)

The advisor pre-flighted this scope and returned ⚠️ MODIFY with
findings already folded into this brief. Do not re-litigate:

- §9.3 does not exist in DESIGN.md — phantom forward-ref. Anchor only
  to §0.2, §5.1, §5.2, §7.5.
- §5.2 says "@effect/sql migration runner gated by schema_versions
  table" — that is **drift from reality**. All shipped SQLite modules
  in this repo (cost-store, session-store, telemetry-store) use
  `PRAGMA user_version` per-component ladder + dynamic `bun:sqlite`
  import. Mirror that pattern. There is no `schema_versions` table
  anywhere in the codebase. Note this drift in your return summary
  for HANDOFF.md.
- §0.2 says `~/.luna/accounts.db`. **Operator decision**: use
  `~/.luna/luna.db` (single shared DB, mirroring all shipped modules)
  and flag the §0.2 wording as drift in HANDOFF for amendment. Do
  NOT fork a separate accounts.db file.
- `report()` SQL write-back is OUT OF SCOPE this phase. In-memory
  cooldown state continues exactly as Phase 9 ships. Durability
  across restarts is deferred. The §7.5 surface (`acquireSession`,
  `acquireTool`, `report`) stays unchanged — only the seed source
  becomes durable.

---

## 1. Required reading (BEFORE writing any code)

DESIGN.md sections (read in full):
- §0.2 — per-query rotation contract; OAuth tokens; SQLite pool
- §3.4 — hard rules for executors (ALWAYS read)
- §5.1 — `accounts` table schema (verbatim spec — copy column-for-column)
- §5.2 — migration policy (note drift: in-repo uses PRAGMA, not table)
- §6 — error taxonomy (use existing `ConfigError`, `IntegrityError` —
  do NOT invent new error tags)
- §7.5 — AccountBroker three-method surface (frozen)

Existing code — READ as templates, do NOT modify:
- `/path/to/luna/packages/core/src/account-broker/account-broker.ts`
  — lines 18–20 (deferral note you are closing), 56–60 (`AccountSeed`
  interface), 94–184 (`fromAccounts` Layer factory you are mirroring
  for `fromSql`)
- `/path/to/luna/packages/core/src/cost-accounting/cost-store-sqlite.ts`
  — **canonical template**: PRAGMA user_version pattern, dynamic
  `bun:sqlite` import, Layer.scoped + LIFO finalizer, `ConfigError`
  on missing module
- `/path/to/luna/packages/core/src/session/session-store-sqlite.ts`
  — second precedent for the same pattern; cross-reference if
  cost-store details are unclear
- `/path/to/luna/packages/core/src/secret-provider/secret-provider.ts`
  — `SecretRef` shape; `fromSql` rows store the ref string, broker
  resolves it lazily on `acquireSession()` exactly as today

---

## 2. Scope (exactly what this phase ships)

- A new SQL backend for AccountBroker — `account-broker-sql.ts` (or
  similarly named file) inside the existing
  `packages/core/src/account-broker/` directory.
- New Layer factory: `AccountBrokerLayer.fromSql({ dbPath?: string })`.
  Default `dbPath` resolves to `~/.luna/luna.db`. Loads all rows from
  the `accounts` table at Layer construction, hydrates the existing
  in-memory `Ref<ReadonlyArray<AccountRecord>>` exactly the same
  shape Phase 9 produces. Returns the same `AccountBrokerApi` —
  callers cannot tell which factory was used.
- Schema migration code — `accounts` table created via PRAGMA
  user_version ladder. Idempotent on second boot (PRAGMA stays at
  current version, no-op).
- Tests (Tier-1 minimum — see §5).

**Public API additions** (other phases will consume):
- `AccountBrokerLayer.fromSql(opts)` — new factory, sibling of
  `fromAccounts`
- Re-export from `packages/core/src/index.ts` if `fromAccounts` is
  already exported there; otherwise leave at sub-path

**Out of scope (explicit — do NOT ship):**
- Seed CLI (Phase 25b)
- Any change to `dev-server-chat.ts` or any `apps/*` (Phase 25b)
- Writing back to SQL on `report()` — broker writes stay in-memory
- Hot-reload of new accounts post-boot — `fromSql` is load-once
- Any UI surface, gateway endpoint, or admin tooling
- Multi-vault config or namespacing
- Touching `packages/core/src/errors.ts` (frozen)

---

## 3. File layout (exact paths to create / modify)

Create:
```
packages/core/src/account-broker/account-broker-sql.ts
packages/core/src/account-broker/account-broker-sql.test.ts
```

Modify (minimal):
```
packages/core/src/account-broker/index.ts   # add fromSql to AccountBrokerLayer barrel
```

Do NOT touch anywhere else.

---

## 4. Invariants you must honor (cite §-anchor)

- **§0.2** — OAuth token never on disk in plaintext. Confirm by
  inspection: `accounts.secret_ref` is a pointer string; resolution
  goes through SecretProvider; tokens enter memory only as
  `Redacted<string>`. The migration must NOT add any column that
  could leak the token.
- **§5.1** — `accounts` table columns verbatim:
  `id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL,
  secret_ref TEXT NOT NULL, health TEXT NOT NULL, cooldown_ms INTEGER,
  usage_json TEXT NOT NULL`. Do NOT add columns. Do NOT alter types.
  If you need to denormalize, STOP and report.
- **§5.2** — Migrations are forward-only, gated. Mirror cost-store's
  `PRAGMA user_version` pattern (note repo-wide drift from §5.2's
  `schema_versions` table wording).
- **§6** — Errors only via existing tagged errors. Missing
  `bun:sqlite` → `ConfigError`. Malformed row at hydrate (e.g.,
  `kind` is empty, `secret_ref` is blank) → `ConfigError` with the
  offending `id` in the message. Do NOT invent new error tags.
- **§7.5** — AccountBroker public surface unchanged. `fromSql` returns
  the SAME `AccountBrokerApi` `fromAccounts` returns.

**Hydrate rule for fields the in-memory record doesn't carry**
(advisor flagged): §5.1 has `health`, `cooldown_ms`, `usage_json`
which Phase-9 `AccountRecord` doesn't model. At hydrate:
- `health`: ignore (default to "healthy" semantically — not stored in
  Ref)
- `cooldown_ms`: if non-zero, set `cooldownUntilMs = now + cooldown_ms`
  on the AccountRecord; else leave undefined
- `usage_json`: ignore for now (write-back is next phase)

Document this hydrate rule in a comment block at the top of
`account-broker-sql.ts`.

---

## 5. Tests required

Use the cost-store test file as a template for SQLite test setup
(temp DB path, cleanup via Effect Scope).

**Schema migration:**
- Fresh DB → `accounts` table exists with all §5.1 columns
- Re-run migration on existing DB → idempotent, no error, same
  `user_version`
- ConfigError when `bun:sqlite` import fails (use mock or skip-if
  pattern from cost-store)

**Hydration (the new Layer):**
- Empty table → broker has zero accounts; `acquireSession` returns
  `AllAccountsExhaustedError` (existing behavior)
- 3 valid rows → broker pool has exactly 3 records, all fields map
  correctly (id, kind, secretRef)
- Row with non-zero `cooldown_ms` → AccountRecord has
  `cooldownUntilMs` set to `now + cooldown_ms` (use injected Clock,
  not real time)
- Malformed row (empty `kind` or empty `secret_ref`) → `ConfigError`
  with offending id in message; broker fails to construct (Layer
  fails, not silent)

**Invariant enforcement:**
- After hydrate, calling `acquireSession({model:"sonnet-4-5"})` with a
  stub SecretProvider returns a Credential with the resolved secret
  (verify SecretProvider is called with the row's `secret_ref`).

**Out of test scope** (don't write these — they're 25b):
- 1Password integration tests (mock the SecretProvider)
- dev-server-chat boot tests
- CLI tests

**Run `bun run test` and paste the final
`Test Files … | Tests …` summary line into your return summary.**

---

## 6. Constraints

- Do NOT modify files outside
  `packages/core/src/account-broker/` (and the single barrel
  `index.ts` in that directory). If you think you need to, STOP and
  ask why.
- Do NOT modify `packages/core/src/errors.ts` (frozen).
- Do NOT modify `account-broker.ts` (the Phase-9 in-memory factory).
  `fromSql` is a sibling, not a refactor.
- Do NOT add dependencies. `bun:sqlite` is dynamic-imported per
  cost-store; no new package.json entries.
- Do NOT reformat existing code.
- `bun run typecheck` must pass with zero errors.

---

## 7. Return summary shape (mandatory — your response MUST include all six)

1. **Files created** — list with one-line purpose each.
2. **Files modified** — list with reason; should be only the local
   `account-broker/index.ts` barrel.
3. **Public API exported** — the new factory signature.
4. **Vitest output tail** — the literal final summary line, not
   paraphrased.
5. **Typecheck output** — pass/fail with error tail if fail.
6. **Invariants honored** — one sentence per §-anchor in §4 explaining
   the mechanism.

Plus one extra: **Drift note for HANDOFF** — confirm whether you
followed the PRAGMA pattern (mirroring cost-store) and that you used
`~/.luna/luna.db` (not a separate file). One sentence each.

---

## 8. Red flags (stop and report, don't guess)

- DESIGN.md §5.1 columns conflict with Phase-9 `AccountRecord` shape
  in any way you cannot resolve via the hydrate rule in §4 — STOP.
- `bun:sqlite` dynamic import pattern in cost-store doesn't compile in
  this context — STOP.
- You catch yourself wanting to modify `account-broker.ts` (Phase 9)
  to share code with `fromSql` — STOP. Duplication is acceptable here;
  mergers are a future refactor with its own brief.
- You catch yourself wanting to add a `schema_versions` table — STOP.
  Mirror cost-store PRAGMA only.
- You catch yourself wanting to seed accounts directly in this phase
  for a smoke test — STOP. CLI is 25b. Use a raw SQL INSERT in test
  setup only.
- The advisor guidance in this brief conflicts with code you read —
  STOP and report which file disagrees.
