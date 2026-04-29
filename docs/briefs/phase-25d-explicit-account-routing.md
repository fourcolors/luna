# Subagent Phase Brief — Phase 25d: Explicit Per-Ref 1Password Account Routing

> Replaces 25c's "try every OP token until one works" with explicit
> per-ref account selection via a new `luna-op://<label>/<vault>/<item>/<field>`
> grammar. `op://` stays valid only when exactly ONE OP account is
> registered. Closes the cross-account fall-through hole.
>
> **Advisor verdict on this design**: ⚠️ MODIFY (three tightenings
> already incorporated below — advisor's letter on file in session
> transcript).

---

## Context (advisor-verified, do not redo)

Prior phases (DO NOT modify):
- 25a (eced50b) — `AccountBrokerLayer.fromSql({ dbPath })`
- 25b (83644f4 + e3bc497) — luna-account CLI + dev-server-chat OP+Env wiring
- 25c (64f7b15 + a1e5ac3) — macOS keychain bootstrap + N OnePasswordSecretProvider layers in firstOf chain

Sterling's reasoning for this phase: 25c's "iterate every account until one resolves" is a permission-probing oracle. Multiple tokens are tried against every ref. He wants explicit routing where each `secret_ref` names which OP account to use, hard-fail on mismatch.

1Password official ref grammar (verified against developer.1password.com docs):
```
op://<vault-name>/<item-name>/[section-name/]<field-name>
```
Account selection in `op` CLI is out-of-band (`--account` flag / `OP_ACCOUNT` env / token). 1P does NOT have an account-prefix grammar of their own.

Currently registered keychain entries (verified by Sol):
- `luna.op.antmachine` / `antmachine` — populated, `op vault list` returns "Mr Bot"
- `luna.op.mrbot` / `mrbot` — Sterling will add later
- `luna.op.flow` / `flow` — Sterling will add later

Pre-existing bug to fix while we're here: `add.ts` validator allows `env://VAR` (with slashes), but `EnvSecretProvider` only accepts `env:VAR` (one colon, no slashes). Any row added with `env://` will never resolve. Fix in this phase by making the CLI validator require `env:` (one colon).

---

## 1. Required reading (BEFORE writing any code)

DESIGN.md sections:
- §0.2 — per-query rotation; OAuth tokens; SecretProvider contract
- §2.2.11 — token resolution chain (you will be AMENDING this)
- §3.4 — hard rules for executors (ALWAYS read)
- §6 — error taxonomy (use existing `ConfigError`, do NOT invent tags)
- §7.5 — AccountBroker surface (frozen)

Existing code — READ as references:
- `/Users/USER/Projects/luna/packages/core/src/secret-provider/onepassword-backend.ts`
  — `OnePasswordOptions` shape; `make({ token })`. You'll drop `vault`
  (dead — only `void opts.vault` today) and add required `accountLabel`.
- `/Users/USER/Projects/luna/packages/core/src/secret-provider/secret-provider.ts`
  — `secretProviderFirstOf` semantics. Leave alone.
- `/Users/USER/Projects/luna/packages/core/src/secret-provider/env-backend.ts`
  — line 12: shows the canonical `env:` form (one colon, no slashes)
- `/Users/USER/Projects/luna/packages/core/src/secret-provider/keychain-helper.ts`
  — already shipped in 25c, no changes
- `/Users/USER/Projects/luna/apps/ui-web/scripts/dev-server-chat.ts`
  — current OP composition you'll restructure
- `/Users/USER/Projects/luna/apps/agent-cli/src/commands/add.ts`
  — line 15 region: validator regex you'll extend
- `/Users/USER/Projects/luna/apps/agent-cli/test/cli.test.ts`
  — existing validator test patterns

---

## 2. Scope (exactly what this phase ships)

### A. DESIGN.md amendment (do FIRST, commit FIRST)

Update §2.2.11 to lock the new grammar contract. Add a sub-section
documenting:

```
Token resolution chain (Phase 25d):

secret_ref grammar:
  op://<vault>/<item>/[section/]<field>
    canonical 1Password syntax. Valid ONLY when exactly one OP
    account is registered. With ≥2 OP accounts, op:// is rejected
    with a ConfigError directing the user to use luna-op://<label>/...

  luna-op://<account-label>/<vault>/<item>/[section/]<field>
    Luna-specific explicit-routing form. <account-label> matches a
    registered OP service-account by keychain label. Resolution is
    bound to that single account — no fall-through. Unknown label →
    ConfigError naming the unknown label and listing the registered
    set.

  env:<VARNAME>
    Reads from process env. Single colon, no slashes (RFC-style
    URI scheme without authority).

  file:<absolute-path>
    Reads from local file. Single colon (or two slashes for the
    absolute-path form `file:///path`). Same semantics as today.

Account-label format (mandatory for luna-op://):
  ^[a-z][a-z0-9-]{0,30}$
  Reserved labels (rejected): env, file, op
  No URL-decoding is performed on any path segment.

Routing dispatcher (RoutedOpSecretProvider):
  Wraps N single-account OnePasswordSecretProvider layers, each
  registered by accountLabel. On luna-op://, dispatches to the
  matching layer ONLY. On op://, allowed iff exactly one OP layer
  is registered (otherwise the dispatcher returns a guidance
  ConfigError). The dispatcher rewrites luna-op://<label>/<rest>
  to op://<rest> before handing it to the inner backend, which
  remains a pure 1Password reader.

Error wrapping:
  Failures from a luna-op://<label>/... resolution are wrapped to
  include "(account=<label>)" in the message via Effect.mapError.
  Token strings never appear in any error message.
```

Phase 25c's "try-each" §-anchor (if any was added) supersedes-by-25d
note in HANDOFF.md drift section. Do not silently delete prior
language; mark it superseded with a date and pointer to §2.2.11.

### B. Core: RoutedOpSecretProvider

Create `packages/core/src/secret-provider/routed-op-provider.ts`:

```ts
export interface RoutedOpAccount {
  readonly label: string                          // matches account-label regex
  readonly layer: Layer.Layer<SecretProvider, ConfigError>
}
export interface RoutedOpOptions {
  readonly accounts: ReadonlyArray<RoutedOpAccount>
}
export const RoutedOpSecretProvider: {
  readonly make: (opts: RoutedOpOptions) => Layer.Layer<SecretProvider, ConfigError>
}
```

Behavior:

1. **Validation at construction time** — every label in `accounts`
   must match `^[a-z][a-z0-9-]{0,30}$` and not be in `{env, file, op}`.
   Violation → Layer fails with ConfigError naming the bad label.
2. **Duplicate label** check — Layer fails with ConfigError if two
   accounts share a label.
3. **Empty accounts array** is allowed (the dispatcher just rejects
   every op:// and luna-op://).
4. On `get(ref)`:
   - Ref doesn't start with `op://` or `luna-op://` → ConfigError
     (unsupported scheme — pass-through to next provider in firstOf).
     Actually: this should be a ConfigError that firstOf treats as
     "miss". Match the pattern OnePasswordBackend uses today.
   - `op://...`:
     - If `accounts.length === 1`: rewrite is a no-op; delegate to
       that single account's layer.
     - If `accounts.length === 0` or `>= 2`: ConfigError with
       message `"bare op:// requires exactly 1 registered OP account
       (have N); use luna-op://<label>/... — registered: [a, b, c]"`.
   - `luna-op://<rest>`:
     - Parse: split `<rest>` on the FIRST literal `/`. Left side =
       label, right side = remainder.
     - Empty label or empty remainder → ConfigError "malformed
       luna-op:// ref: missing <label> or <rest>".
     - Label fails regex / is reserved → ConfigError naming the
       offending label (do NOT echo the rest of the ref to the
       message — privacy).
     - No URL-decoding of any segment. The split is on literal `/`.
     - Look up `label` in `accounts`. Not found → ConfigError
       `"luna-op account '<label>' not registered; available: [a,
       b, c]"`.
     - Found → rewrite `luna-op://<label>/<rest>` to `op://<rest>`,
       delegate to that account's layer, on error wrap via
       `Effect.mapError` to prepend `"(account=<label>) "`.

5. **Boot-time dangling-ref warning** — exposed as a separate helper
   `validateAccountsTableLabels` that takes the accounts table rows
   (or just the secret_ref strings) and the registered set, and
   returns the list of refs that point at unknown labels. The
   wrapper itself does NOT read the DB (separation of concerns).
   The composition site (dev-server-chat) calls this after broker
   hydration and logs a WARN line. Do not hard-fail boot on dangling
   refs — operators may intentionally add accounts later.

Tests at `routed-op-provider.test.ts`:
- Construction-time invariants (bad regex, reserved label, duplicate
  label).
- Single-account chain: `op://VAULT/ITEM/FIELD resolves; `luna-op://VAULT/ITEM/FIELD
  resolves when X matches; ConfigError when X doesn't.
- Multi-account chain: `op://VAULT/ITEM/FIELD ConfigErrors with the guidance
  message and lists registered labels; `luna-op://VAULT/ITEM/FIELD routes
  only to X.
- Edge cases (every advisor-flagged gap):
  - `luna-op://VAULT/ITEM/FIELD `luna-op://flow` (no rest) → ConfigError.
  - `luna-op:///v/i/f` (empty label) → ConfigError.
  - `luna-op://VAULT/ITEM/FIELD (reserved) → ConfigError.
  - `luna-op://Mr Bot/v/i/f` (space) → ConfigError.
  - `luna-op://VAULT/ITEM/FIELD → ConfigError (no decoding).
- Error wrapping: when the wrapped backend fails for a
  `luna-op://VAULT/ITEM/FIELD ref, the outer error message contains
  `"(account=flow)"` — and contains NO token-shaped substring (assert
  no `ops_`, no `sk-ant`, no 30+-char alphanumeric blob).
- Mock the inner OP backend with a stub that returns
  `Redacted("ok")` or `ConfigError("simulated failure")` — do not
  shell out.

### C. Core: OnePasswordSecretProvider tweak

Modify `packages/core/src/secret-provider/onepassword-backend.ts`:
- `OnePasswordOptions` — DROP the `vault` field (dead). ADD required
  `accountLabel: string`. Validate against the same regex as the
  routed wrapper does (defense in depth — a future caller might
  bypass the wrapper).
- The backend STAYS `op://`-only. The `ref.startsWith("op://")`
  check is now a hard contract: backend never sees `luna-op://`.
  Add a comment locking that.
- Pass-through error mapping unchanged otherwise — `accountLabel`
  is used for diagnostic context only at the wrapper layer (the
  backend doesn't need to thread it through messages; the wrapper
  does).
- Update existing onepassword-backend tests to pass `accountLabel`.

### D. Re-exports

Update `packages/core/src/secret-provider/index.ts` to re-export
`RoutedOpSecretProvider`, `RoutedOpAccount`, `RoutedOpOptions`, and
`validateAccountsTableLabels`.

### E. CLI validator + side-fix

Modify `apps/agent-cli/src/commands/add.ts`:
1. Extend `SECRET_REF_PREFIXES` (or rewrite as a real parser) to
   accept:
   - `op://...` (any non-empty rest)
   - `luna-op://<label>/<rest>` where `<label>` matches
     `^[a-z][a-z0-9-]{0,30}$` and is not in `{env, file, op}`,
     and `<rest>` is non-empty
   - `env:<VAR>` (one colon, no slashes — see fix below)
   - `file:<path>` or `file://<host>/<path>` (current behavior;
     don't change unless it's broken — verify first)
2. **Fix env: validator** — replace the `env://` allowance with
   `env:<VAR>` only. Existing rows: there are 0 or 1 today; check
   with `bun run --filter '@luna/agent-cli' luna-account list`
   in your sub-environment via spawn (just inspect the output) —
   if any rows use `env://`, STOP and report. Otherwise the change
   is safe.
3. Tests at `apps/agent-cli/test/cli.test.ts` — add the routing-
   grammar cases listed in §B tests above (CLI-side variants),
   plus an `env://FOO` rejection test and an `env:FOO` acceptance
   test.

### F. dev-server-chat composition restructure

Modify `apps/ui-web/scripts/dev-server-chat.ts`:
- Replace the current `secretProviderFirstOf([...opLayers, env])`
  with a single `RoutedOpSecretProvider` constructed from the
  discovered tokens, then composed with EnvSecretProvider in
  firstOf.
- Account list passed in: derive from the existing
  `discoverOpTokens` result, but use a slightly different shape —
  each entry needs `{ label, layer }` where the layer is built
  inline via `OnePasswordSecretProvider.make({ token, accountLabel:
  label })`. The env-var token uses label `env` IF you keep it in
  the routed pool — actually NO, `env` is a reserved label. Decide:
  - Option (i): drop the env-var fallback entirely — Sterling's
    Sol-agent shell shouldn't be relied on; keychain is the source
    of truth. Cleaner.
  - Option (ii): give the env-var-sourced token an internal label
    like `envtok` (not reserved). Sterling's Sol-agent shell
    continues to work as a hidden default account.
  Lean **(i) drop** — but make this an explicit decision in your
  return summary so Sterling can override. Discuss tradeoff in the
  summary.
- Boot log: keep the existing format
  `[op] N providers active: <label1>, <label2>, ...`.
- Add a SECOND boot log line: `[op] dangling refs: <count>` where
  count is from `validateAccountsTableLabels`. When >0, also log
  the ref ids and the labels they reference. When 0, omit the line
  (don't add noise on the happy path).
- Update the header comment block to document the new grammar
  (point at DESIGN §2.2.11 for full spec; document the example
  refs and the keychain entries).

### G. live-smoke test update

Modify `apps/agent-cli/test/live-smoke.test.ts`:
- Switch the canonical ref to
  `luna-op://VAULT/ITEM/FIELD
- Add a SECOND smoke (also live-gated) using a bare `op://...` ref
  to confirm the single-account fall-through still works when only
  one account is registered.

---

**Out of scope (explicit):**
- Any change to `packages/core/src/account-broker/` — frozen this
  phase
- Any change to §5.1 schema — refs are strings; the grammar lives
  inside the string
- Any change to AccountBroker surface
- Any change to `packages/core/src/errors.ts` (frozen)
- Any change to `packages/adapter-sdk/`
- Any keychain WRITE operation
- Any new error tags
- Hot-reload of accounts on schema change

---

## 3. File layout

Create:
```
packages/core/src/secret-provider/routed-op-provider.ts
packages/core/src/secret-provider/routed-op-provider.test.ts
```

Modify:
```
DESIGN.md                                            # §2.2.11 amendment
HANDOFF.md                                           # drift note for 25d
packages/core/src/secret-provider/onepassword-backend.ts  # accountLabel option
packages/core/src/secret-provider/onepassword-backend.test.ts  # update calls
packages/core/src/secret-provider/index.ts           # re-exports
apps/ui-web/scripts/dev-server-chat.ts               # use RoutedOpSecretProvider
apps/agent-cli/src/commands/add.ts                   # luna-op:// + env: fix
apps/agent-cli/test/cli.test.ts                      # new validator cases
apps/agent-cli/test/live-smoke.test.ts               # luna-op:// + bare op://
```

Do NOT touch anything else.

---

## 4. Invariants you must honor

- **§0.2** — Tokens never logged. Wrapper error messages never
  include token-shaped substrings (assert in tests). No
  `process.env` mutation in this phase.
- **§2.2.11** — DESIGN amendment lands BEFORE any code that depends
  on the grammar. Commit order matters.
- **§3.4** — No new resources, no new finalizers needed.
- **§6** — All errors via `ConfigError`. No new tags.
- **§7.5** — AccountBroker surface unchanged. The change is purely
  in the SecretProvider chain.

---

## 5. Tests required

See §B (RoutedOpSecretProvider — full coverage matrix), §C
(OnePasswordSecretProvider — update existing), §E (CLI validator —
luna-op:// + env: fix), §G (live-smoke — both ref forms gated).

**Run `bun run test` and paste the literal final
`Test Files … | Tests …` summary line.**

**Run `bun run typecheck` and confirm zero errors.**

---

## 6. Constraints

- Do NOT modify files outside the listed paths. STOP if you think
  you need to.
- Do NOT add dependencies.
- Do NOT mutate `process.env` for tokens.
- Do NOT log tokens. Do NOT include token-shaped substrings in any
  error message.
- Do NOT change `secret_ref` for stored rows — Sterling will
  manually rewrite his ~1 row. Don't write a migration.
- Do NOT touch §5.1 `accounts` schema.
- Do NOT touch `errors.ts` (frozen).
- Do NOT URL-decode any path segment in routed-op-provider.
- typecheck must pass with zero errors.

---

## 7. Return summary shape (mandatory)

1. **Files created** — list with one-line purpose each.
2. **Files modified** — list with reason.
3. **Public API exported** — the new types/factories.
4. **Vitest output tail** — literal final summary line.
5. **Typecheck output** — pass/fail with error tail if fail.
6. **Invariants honored** — one sentence per §-anchor in §4.

Plus four extras:
- **DESIGN.md diff** — short summary of what changed in §2.2.11.
- **env: vs env:// fix** — confirm validator now requires `env:`
  (one colon) and reports any pre-existing `env://...` rows in
  Sterling's DB. If any rows exist, STOP before making code
  changes.
- **env-var-token decision** — which option (i drop / ii envtok)
  you implemented and why. Justify in 2 sentences.
- **No-token-leak proof** — confirm both routed-op-provider tests
  AND the existing 25c keychain-helper tests still assert no token
  leakage in stderr/error messages.

**Commits along the way** — Sterling explicitly wants per-checkpoint
commits. Use selective `git add <specific paths>` — NEVER
`git add -A` or `.`. Recommended split:

- `25d/1: docs(design): §2.2.11 — luna-op://<label>/... explicit account routing grammar`
  — DESIGN.md + HANDOFF.md only.
- `25d/2: feat(secret-provider): RoutedOpSecretProvider for explicit account dispatch`
  — routed-op-provider.{ts,test.ts} + onepassword-backend.{ts,test.ts} + index.ts.
- `25d/3: feat(agent-cli): luna-op:// validator + env: side-fix + tests`
  — agent-cli/src/commands/add.ts + agent-cli/test/cli.test.ts.
- `25d/4: feat(ui-web): dev-server-chat uses RoutedOpSecretProvider; live-smoke uses luna-op://`
  — apps/ui-web/scripts/dev-server-chat.ts + apps/agent-cli/test/live-smoke.test.ts.

Use HEREDOC for messages. Don't `--no-verify`. Don't amend. Don't
push. Run `git status --short` before each commit and verify only
on-topic files staged.

---

## 8. Red flags (stop and report, don't guess)

- Sterling's `~/.luna/luna.db` has any row with `env://...` in
  `secret_ref` — STOP before changing the env: validator. Report
  the row(s).
- DESIGN.md §2.2.11 doesn't exist or contradicts the proposed
  grammar in a way you can't resolve — STOP. Report the conflict.
- The OnePasswordBackend's `ref.startsWith("op://")` check turns
  out NOT to be the only place handling op-prefixed refs — STOP.
- You catch yourself wanting to URL-decode any path segment —
  STOP.
- You catch yourself wanting to add a new error tag — STOP. Use
  ConfigError.
- The single-account `op://` fall-through check turns out to need
  more state than expected (e.g. you need to count layers
  globally) — STOP and ask. The wrapper holds the account list,
  so this should be local; if you find yourself reaching outside
  it, surface that.
- A vitest case fails because `firstOf` doesn't fall through on
  the wrapper's "unsupported scheme" ConfigError — STOP. The
  semantics of `firstOf` need to be confirmed before adding
  workarounds.
- `bun run test` shows fewer tests than 25c's tail
  (`457 passed | 68 skipped`) — that means a regression. STOP
  before committing.
