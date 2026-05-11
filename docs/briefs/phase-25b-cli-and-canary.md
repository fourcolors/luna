# Subagent Phase Brief — Phase 25b: Account CLI + dev-server-chat Canary

> Depends on Phase 25a (`AccountBrokerLayer.fromSql` must be shipped
> and green). Adds the seed CLI and wires `dev-server-chat.ts` to use
> 1Password + SQL-backed broker end-to-end. This phase is the first
> production caller of AccountBroker.

---

## Context (advisor-verified)

- Phase 25a shipped `AccountBrokerLayer.fromSql({ dbPath })` reading
  the §5.1 `accounts` table from `~/.luna/luna.db`.
- `OnePasswordSecretProvider` already exists in
  `packages/core/src/secret-provider/onepassword-backend.ts`. It shells
  `op read --no-newline -- op://VAULT/ITEM/FIELD with a 5-min
  layer-scoped cache.
- `SDKAdapter` is already broker-aware (Phase 9.5) — wiring
  AccountBroker into the layer composition causes `acquireSession()`
  to overlay the env automatically.
- `apps/agent-cli/src/` is empty (workspace exists, no source).
- Canonical 1Password reference for Sterling's Claude OAuth token (use
  this in seed instructions and the smoke test):
  `op://<vault-id>/<item-id>/credential`

---

## 1. Required reading (BEFORE writing any code)

DESIGN.md sections:
- §0.2 — per-query rotation; OAuth tokens; SecretProvider contract
- §3.4 — hard rules for executors (ALWAYS read)
- §6 — error taxonomy
- §7.5 — AccountBroker surface (unchanged this phase, but must be
  honored)
- §12.2 — SDK adapter invariants (you are NOT modifying the adapter,
  but the canary path runs through it)

Existing code — READ as references:
- `/Users/USER/Projects/luna/packages/core/src/account-broker/account-broker-sql.ts`
  (shipped in 25a) — the `fromSql` you will instantiate
- `/Users/USER/Projects/luna/packages/core/src/secret-provider/onepassword-backend.ts`
  — Layer factory, options shape
- `/Users/USER/Projects/luna/packages/core/src/secret-provider/secret-provider.ts`
  — `secretProviderFirstOf` chain helper (1password → env fallback)
- `/Users/USER/Projects/luna/apps/ui-web/scripts/dev-server-chat.ts`
  — full file, especially lines 49–80 (env-var bail you are
  replacing) and the layer composition

---

## 2. Scope (exactly what this phase ships)

**A. Seed CLI** at `apps/agent-cli/src/`:
- Single binary `luna-account` with three subcommands:
  - `add --id <id> --label <label> --kind <kind> --secret-ref <ref>`
    — inserts a row into the `accounts` table; validates `kind`
    matches a small allowlist (`anthropic`, or `tool-<name>`,
    `mcp-<name>`); validates `secret-ref` starts with `op://` or
    `env://` or `file://`; rejects empty fields with a helpful error.
  - `list` — prints all accounts (id, label, kind, secret_ref). NEVER
    resolve or print the actual secret.
  - `rm --id <id>` — deletes one row by id.
- Uses the same `~/.luna/luna.db` path as the broker default.
- Connects via `bun:sqlite` directly (mirror cost-store's import
  pattern); does NOT depend on the broker package's internals beyond
  the schema constant if exposed.
- Argument parsing: simple manual parsing or a minimal helper. Do
  NOT add a CLI framework dependency.
- Exit codes: 0 success, 1 user error, 2 system error.

**B. dev-server-chat wiring** at
`apps/ui-web/scripts/dev-server-chat.ts`:
- Replace the `process.env["CLAUDE_CODE_OAUTH_TOKEN"]` bail (lines
  49–57) with broker-driven flow:
  1. Compose `OnePasswordSecretProvider` (canonical) with an
     `EnvSecretProvider` fallback via `secretProviderFirstOf`
  2. Compose `AccountBrokerLayer.fromSql({})` (default db path)
  3. Provide both upstream of `SDKAdapter.Default` in `baseLayer`
  4. After Layer construction, query the broker's `_inspect()` once
     to log `[accounts] N hydrated: <kind1>×N, <kind2>×M` (operator
     visibility — advisor explicitly required this)
- Failure modes — surface clearly, do NOT crash on panic:
  - 0 accounts in DB → log a `ConfigError`-style message with the
    seed CLI command to fix (e.g.,
    `"No accounts seeded. Run: bun run --filter '@luna/agent-cli' luna-account add --id sterling --label 'Sterling' --kind anthropic --secret-ref op://..."`)
    and exit cleanly. Do NOT proceed.
  - 1Password CLI not authenticated → `ConfigError` with hint to set
    `OP_SERVICE_ACCOUNT_TOKEN` env. Surface at first
    `acquireSession()`, not at boot (1Password backend resolves
    lazily — that's by design). Catch and log nicely.

**C. Documentation**:
- Add a `# Account Setup` section to
  `apps/ui-web/scripts/dev-server-chat.ts`'s top-of-file comment
  block explaining the seed CLI command and the `op://` ref format.

**Out of scope (explicit):**
- ANY change to `packages/core/` (broker, secret-provider) — those
  shipped in 25a / Phase 9 / Phase 9.5
- Health/cooldown writes back to SQL on `report()` — still in-memory
- Hot-reload (CLI insert requires server restart — DOCUMENT this in
  the dev-server-chat header comment)
- Multi-vault support
- Admin UI / gateway endpoints
- Updating CLAUDE.md (recently trimmed; should not summarize
  architecture — HANDOFF.md captures the phase)

---

## 3. File layout

Create:
```
apps/agent-cli/package.json                          # workspace package
apps/agent-cli/tsconfig.json                         # extends root
apps/agent-cli/src/index.ts                          # binary entry
apps/agent-cli/src/commands/add.ts
apps/agent-cli/src/commands/list.ts
apps/agent-cli/src/commands/rm.ts
apps/agent-cli/src/db.ts                             # bun:sqlite helper
apps/agent-cli/test/cli.test.ts                      # arg parsing + behavior
```

Modify:
```
apps/ui-web/scripts/dev-server-chat.ts               # the canary wire-up
package.json                                         # workspace already includes apps/* — verify, don't edit unless needed
```

Do NOT touch `packages/core/`. Do NOT touch
`apps/ui-web/src/`. Do NOT touch any other app.

---

## 4. Invariants you must honor

- **§0.2** — Token never logged, never printed, never persisted as
  plaintext. The `list` CLI command must show the `secret_ref`
  POINTER, NEVER resolve it. dev-server-chat boot log shows kind +
  count only, never the resolved token. Add a test that asserts
  `list` output does NOT contain anything matching `sk-ant-` or a
  resolved token shape.
- **§5.1** — CLI inserts must populate ALL NOT NULL columns
  (`id`, `label`, `kind`, `secret_ref`, `health`, `usage_json`).
  Defaults: `health="healthy"`, `usage_json="{}"`. `cooldown_ms` may
  be NULL.
- **§6** — Errors via existing tagged errors. CLI user-error → `exit 1`
  + helpful stderr. System error (db missing, sqlite import fail) →
  `exit 2` + `ConfigError`-tagged log. Do NOT invent new error tags.
- **§7.5** — Broker surface unchanged. dev-server-chat consumes
  `acquireSession` exclusively (no direct env-var manipulation
  remains).
- **§12.2** — SDK adapter is frozen. Verify by inspection that you
  did NOT modify any file under `packages/adapter-sdk/`. The broker
  just passes a `Credential`; the adapter does the env overlay.

---

## 5. Tests required

**CLI** (vitest at `apps/agent-cli/test/cli.test.ts`):
- `add` happy path: inserts a valid row; subsequent `list` shows it
- `add` rejects empty id, empty label, empty secret-ref, missing
  required arg → exit 1, stderr contains the field name
- `add` rejects `kind` outside the allowlist → exit 1
- `add` rejects `secret-ref` not starting with `op://`, `env://`, or
  `file://` → exit 1
- `list` on empty db → prints "no accounts" and exits 0
- `list` does NOT print resolved secrets — assert output contains the
  `op://...` pointer literal and contains NO match for `sk-ant-` or
  any 30+ char alphanumeric blob that could be a real token
- `rm --id <missing>` → exit 1, stderr "no such account: <id>"
- `rm --id <existing>` happy path
- DB path defaults to `~/.luna/luna.db` (use a temp dir override env
  var or arg in tests)

**dev-server-chat smoke test (manual; document in return summary):**

This phase ships infra; full e2e requires real 1Password auth which
test runners can't have. Instead, write a single
`describe.skipIf(!process.env.LUNA_LIVE_SMOKE)` test that:
1. Inserts one account row via the CLI module pointing to
   `op://<vault-id>/<item-id>/credential`
2. Boots the dev-server-chat layer composition (NOT the WS server —
   just the broker layer)
3. Calls `acquireSession({model:"claude-sonnet-4-5"})`
4. Asserts the returned `Credential.resolvedSecret` is a
   `Redacted<string>` and `Redacted.value(redacted)` starts with
   `sk-ant-oat`

**Then run the manual smoke separately**:
- `op signin` (verify auth)
- `bun run --filter '@luna/agent-cli' luna-account add --id sterling --label "Sterling" --kind anthropic --secret-ref op://<vault-id>/<item-id>/credential`
- `bun run --filter '@luna/agent-cli' luna-account list`
- `bun run --filter '@luna/ui-web' dev:server:chat`
- Confirm boot log: `[accounts] 1 hydrated: anthropic×1`
- Open `http://localhost:5174` in a browser
- Send a chat message, confirm response streams

Paste the boot log and a screenshot reference / confirmation into the
return summary.

**Run `bun run test` and paste the final `Test Files … | Tests …`
summary line.**

---

## 6. Constraints

- Do NOT touch `packages/core/`, `packages/adapter-sdk/`, or any
  frozen file.
- Do NOT add a CLI framework dep (commander, yargs, oclif). Hand-roll
  it; the surface is small.
- Do NOT add a 1Password SDK dep — the existing OnePasswordBackend
  shells the CLI; reuse it.
- Do NOT touch `apps/ui-web/src/`. The canary wires only the
  dev-server script.
- Do NOT modify CLAUDE.md.
- `bun run typecheck` must pass with zero errors.
- agent-cli package name: `@luna/agent-cli`. Binary name:
  `luna-account`.

---

## 7. Return summary shape (mandatory)

1. **Files created** — list with one-line purpose each.
2. **Files modified** — list with reason. Should be ONLY:
   - `apps/ui-web/scripts/dev-server-chat.ts`
   - root `package.json` ONLY if workspace glob doesn't already pick
     up `apps/agent-cli`
3. **Public API exported** — CLI commands + the agent-cli package
   exports (if any).
4. **Vitest output tail** — literal final summary line.
5. **Typecheck output** — pass/fail with error tail if fail.
6. **Invariants honored** — one sentence per §-anchor in §4.

Plus three extras:
- **Live smoke result** — boot log line + chat round-trip confirmation
- **Hot-reload note** — confirm the dev-server-chat header comment
  documents that CLI inserts require server restart
- **No-token-leak proof** — confirm the `list` test asserts the secret
  doesn't appear in stdout

---

## 8. Red flags (stop and report, don't guess)

- 25a's `fromSql` doesn't behave as documented — STOP. Report the
  discrepancy; this phase blocks on a green 25a.
- You catch yourself wanting to modify `packages/core/` — STOP. This
  phase is purely a consumer.
- The `op` CLI is not installed or `OP_SERVICE_ACCOUNT_TOKEN` isn't
  set in the dev environment — degrade gracefully (skip the live
  smoke, mark it skipped, note in summary). Do NOT install or
  configure 1Password yourself.
- You think you need a new error tag — STOP. Use existing
  `ConfigError`.
- Adapter wiring doesn't pick up the broker as expected — STOP.
  Phase 9.5 is supposed to handle this; if it doesn't, that's a Phase
  9.5 bug, not a 25b fix.
- Dev-server-chat startup hangs or panics — STOP. Capture the stack
  and report.
