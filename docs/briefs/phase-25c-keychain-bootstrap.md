# Subagent Phase Brief — Phase 25c: macOS Keychain Bootstrap + Multi-Account 1Password

> Depends on Phase 25b (commits 83644f4 + e3bc497). Adds a keychain
> token-reader helper in `packages/core/`, then composes N
> OnePasswordSecretProvider layers (one per service-account token) in
> `dev-server-chat.ts`'s `firstOf` chain. No grammar change, no schema
> change, no `process.env` mutation.
>
> **Advisor verdict on this design**: ⚠️ MODIFY (consolidated to a
> single phase, simplified — no new SecretProvider backend needed).

---

## Context (advisor-verified, do not redo)

- macOS keychain entries already exist for `luna.op.primary`
  (account `primary`). Operator will add `luna.op.ops` and
  `luna.op.flow` manually via `security add-generic-password -U` —
  **do not try to add them yourself**.
- Verified: `bun` reading `luna.op.primary` via
  `security find-generic-password -w` returns the token in <100ms
  with no GUI prompt (entries owned by current user, no `-T` ACL
  needed for same-user reads).
- Verified: `OP_SERVICE_ACCOUNT_TOKEN=<keychain-token> op vault list`
  returns `Example Vault` — the primary token is real and works.
- §0.2 says "never as plaintext env vars" — we honor this by passing
  tokens via the existing `OnePasswordBackendOptions.token` arg, NOT
  by mutating `process.env`.
- `OnePasswordSecretProvider.make({ token })` already accepts an
  explicit token (see `onepassword-backend.ts:28` and line 53–58
  where it's forwarded into the spawned `op` process env, which is
  unavoidable for the CLI shape).
- `firstOf` (`secret-provider.ts`) builds each layer once and tries
  them in order on miss — exactly the multi-account routing
  primitive we need. Each 1Password service-account token sees only
  its own account's vaults, so `firstOf` IS the routing.

---

## 1. Required reading (BEFORE writing any code)

DESIGN.md sections:
- §0.2 — per-query rotation; OAuth tokens; SecretProvider contract
- §3.4 — hard rules for executors (ALWAYS read)
- §6 — error taxonomy (use existing `ConfigError`, do NOT invent tags)
- §7.5 — AccountBroker surface (frozen — not modifying it, but the
  canary path runs through it)

Existing code — READ as references:
- `/path/to/luna/packages/core/src/secret-provider/onepassword-backend.ts`
  — especially the `OnePasswordBackendOptions` shape (line 21–32) and
  the `make({ token })` factory. The `token` option is already the
  right plumbing point.
- `/path/to/luna/packages/core/src/secret-provider/secret-provider.ts`
  — `secretProviderFirstOf` semantics. Confirm it falls through on
  ConfigError and stops on success.
- `/path/to/luna/packages/core/src/secret-provider/index.ts`
  — barrel; you'll re-export the new helper from here.
- `/path/to/luna/apps/ui-web/scripts/dev-server-chat.ts`
  — current Layer composition (the `firstOf([opProvider, envProvider])`
  pattern). You're extending this list to N OP layers + the env one.

---

## 2. Scope (exactly what this phase ships)

**A. Keychain helper** at
`packages/core/src/secret-provider/keychain-helper.ts`:

- Pure Effect-wrapped function that reads a keychain entry by
  service+account label and returns the token as a string (the
  caller wraps it in `Redacted` if needed).
- Signature:
  ```ts
  export interface KeychainQuery {
    readonly service: string  // e.g. "luna.op.primary"
    readonly account: string  // e.g. "primary"
  }
  export const readKeychainToken: (
    q: KeychainQuery
  ) => Effect.Effect<string, ConfigError>
  ```
- Behavior:
  - On non-darwin: `ConfigError` with message
    `"keychain unsupported on platform <process.platform>"` — return
    immediately, no shell-out.
  - Shells out via `execFile("security", ["find-generic-password",
    "-s", q.service, "-a", q.account, "-w"])`. Use `node:child_process`
    `execFile` (NOT `exec`) — no shell interpolation.
  - Use a **5s timeout** to avoid hanging if `security` ever does
    prompt unexpectedly. On timeout → `ConfigError("keychain read
    timed out for <service>")`.
  - Trims trailing newline.
  - Empty / missing entry → `ConfigError("keychain entry not found:
    <service>/<account>")`. (`security` exits non-zero on miss.)
  - Other spawn failures → `ConfigError("keychain read failed:
    <stderr trimmed>")`.
  - Do NOT log the token. Do NOT include the token in any error
    message.
- Re-export from `packages/core/src/secret-provider/index.ts` and
  from `packages/core/src/index.ts` if SecretProvider is already
  re-exported there (check first; don't duplicate barrels).

**B. dev-server-chat wiring** at
`apps/ui-web/scripts/dev-server-chat.ts`:

- Define a hardcoded list of op service accounts to try, IN
  PRIORITY ORDER:
  ```ts
  const OP_ACCOUNTS = [
    { keychainService: "luna.op.primary", keychainAccount: "primary" },
    { keychainService: "luna.op.ops",      keychainAccount: "ops" },
    { keychainService: "luna.op.flow",       keychainAccount: "flow" },
  ] as const
  ```
- For each entry, build an OP layer that:
  1. Reads the keychain token (Effect `readKeychainToken`)
  2. If the read fails with ConfigError, the LAYER fails to construct
     — but the firstOf chain should still work because we want
     missing keychain entries to be **non-fatal at boot**. To get
     non-fatal behavior, build the layer lazily and **catch
     ConfigError**, returning a no-op provider instead. The cleanest
     pattern is:
     - `readKeychainToken(q).pipe(Effect.option)` — yields
       `Option<string>`; `None` if keychain miss
     - `Option.match` → if `Some(token)` build a real
       `OnePasswordSecretProvider.make({ token })`; if `None`,
       contribute nothing to the chain (filter it out before
       composing).
- The final chain order (first-match-wins):
  1. **Env-var layer** — if `OP_SERVICE_ACCOUNT_TOKEN` is set in
     env, use it. (Preserves existing dev workflow for shells that
     already export the token.) Build an OP layer with that token.
  2. Each present keychain layer in `OP_ACCOUNTS` order
     (skip absent ones).
  3. `EnvSecretProvider` for `env:VARNAME` legacy refs.
- Boot log: `[op] N providers active: <env|primary|ops|flow>×N`.
  Print the LABELS that contributed, never the token. If zero OP
  providers and zero env providers — that's fine; broker will fail
  on first `acquireSession` with the standard error.
- Do NOT mutate `process.env.OP_SERVICE_ACCOUNT_TOKEN`. Tokens flow
  through the `token` option exclusively.

**C. Documentation**:

- Update the `# Account Setup` section of `dev-server-chat.ts` header
  to document:
  - The three keychain entries (`luna.op.<label>` / `<label>`)
  - The `security add-generic-password -U -s luna.op.<label> -a
    <label> -w` command for adding new ones
  - That the environment variable still works as a fallback
  - That entries are user-scoped — same-user reads do not prompt;
    cross-user / launchd-as-different-user would need additional
    ACL setup (`-T <binary>` or "Always Allow")

**Out of scope (explicit):**
- Any change to `packages/core/src/account-broker/`
- Any change to `accounts` table schema (§5.1 stays untouched —
  advisor explicitly nixed adding `op_account` column)
- Any new `secret_ref` grammar (no `op+ops://...`, no
  `op://ops@...` — refs stay `op://vault/item/field`)
- Any change to `packages/adapter-sdk/`
- Any other app
- Any CLI changes to luna-account
- Any change to the `~/.luna/luna.db` `accounts` table contents at
  runtime
- Any per-account routing config table or file
- Any keychain WRITE operation — read-only this phase

---

## 3. File layout

Create:
```
packages/core/src/secret-provider/keychain-helper.ts
packages/core/src/secret-provider/keychain-helper.test.ts
```

Modify:
```
packages/core/src/secret-provider/index.ts         # re-export readKeychainToken + KeychainQuery type
packages/core/src/index.ts                         # if SecretProvider exports flow through, add the new symbols
apps/ui-web/scripts/dev-server-chat.ts             # multi-account composition + boot log + header docs
```

Do NOT touch anything else. If you think you need to, STOP.

---

## 4. Invariants you must honor

- **§0.2** — Tokens never on disk in plaintext outside keychain;
  never logged; never in `process.env` mutation; never in error
  messages. The boot log shows account LABELS only.
- **§3.4 #4 (LIFO)** — the keychain helper is a pure Effect with no
  Scope finalizer needed (no resources held). Spawning `security` is
  one-shot.
- **§6** — Errors only via `ConfigError`. Cases:
  - Non-darwin platform
  - Keychain entry not found
  - Spawn timeout
  - Other spawn failures
  Do NOT invent new error tags.
- **§7.5** — AccountBroker surface untouched. The change is purely
  in the SecretProvider chain composition.

---

## 5. Tests required

**Unit tests** at `keychain-helper.test.ts` (vitest):

- **Happy path** — mock `execFile` (or use a `fake-security` script
  on PATH? Cleaner: dependency-inject the spawn function or accept
  an `_execFile` test override option). Returns `"sk-token\n"` →
  helper returns `"sk-token"` (trimmed).
- **Non-darwin** — set `_platform: "linux"` test override → returns
  `ConfigError` with platform-mention.
- **Entry not found** — `execFile` exits non-zero with stderr
  `"security: SecKeychainSearchCopyNext: The specified item could not
  be found in the keychain."` → `ConfigError` with the service+account
  in the message; **assert the error message does NOT contain any
  token-shaped substring**.
- **Timeout** — `execFile` simulated to never resolve within 5s →
  `ConfigError("keychain read timed out ...")`.
- **No-leak** — when execFile returns a token, confirm `console.log`
  / `console.error` were not called by the helper itself (use a
  spy).

**Integration test** (vitest, gated):

- A `describe.skipIf(process.platform !== "darwin")` block that
  actually shells out to `security` and reads `luna.op.primary`.
  Operator has this entry pre-populated. Asserts the token starts
  with `ops_` (1Password service-account JWTs always do). If the
  entry is missing on a CI box, the test skips cleanly via
  ConfigError catch + `expect.skip`.

**firstOf composition test** (vitest):

- Build three faked OnePassword-shaped providers where:
  - Provider 1 fails with ConfigError on a specific `op://` ref
  - Provider 2 fails with ConfigError on the same ref
  - Provider 3 returns `Redacted("expected-token")`
- Compose via `secretProviderFirstOf([1, 2, 3])`.
- Assert resolution succeeds with the third provider's token.
- This test verifies the routing claim (each provider's token sees
  only its own vault; mismatches fall through cleanly).

**dev-server-chat smoke** — manual; document in return summary:
- With current keychain (only `luna.op.primary` populated):
  boot log should read `[op] 1 providers active: primary` (env
  not set, ops & flow absent).
- With `OP_SERVICE_ACCOUNT_TOKEN` env set: log should
  read `[op] 2 providers active: env, primary` (env first).
- After Operator adds `luna.op.ops` + `luna.op.flow`: log should
  read `[op] 4 providers active: env, primary, ops, flow` (or
  the subset present).

**Run `bun run test` and paste the final `Test Files … | Tests …`
summary line.**

**Run `bun run typecheck` and confirm zero errors.**

---

## 6. Constraints

- Do NOT modify files outside the listed paths. If you need to,
  STOP and explain why.
- Do NOT add dependencies. `node:child_process` is built-in;
  Effect is already pinned.
- Do NOT mutate `process.env` for tokens.
- Do NOT log tokens. Do NOT include token-shaped substrings in
  error messages.
- Do NOT change the `secret_ref` grammar. Refs stay `op://...`.
- Do NOT touch §5.1 `accounts` schema.
- Do NOT touch `packages/core/src/errors.ts` (frozen).
- typecheck must pass with zero errors.

---

## 7. Return summary shape (mandatory)

1. **Files created** — list with one-line purpose each.
2. **Files modified** — list with reason. Should be ONLY:
   - `packages/core/src/secret-provider/index.ts` (barrel)
   - `packages/core/src/index.ts` (if it already re-exports
     SecretProvider symbols — check first)
   - `apps/ui-web/scripts/dev-server-chat.ts`
3. **Public API exported** — `readKeychainToken`, `KeychainQuery`.
4. **Vitest output tail** — literal final summary line.
5. **Typecheck output** — pass/fail with error tail if fail.
6. **Invariants honored** — one sentence per §-anchor in §4.

Plus three extras:
- **Boot-log result** — paste actual line from running
  `bun run --filter '@luna/ui-web' dev:server:chat` (briefly,
  Ctrl-C after the log appears). With current single-account
  keychain state.
- **No-token-leak proof** — confirm error-message tests assert
  the token doesn't appear in stdout/stderr.
- **Commits along the way** — Operator explicitly wants
  per-checkpoint commits. Use selective `git add <specific paths>`
  — NEVER `git add -A` or `.`. Suggested split:
  - `25c/1`: `feat(secret-provider): keychain-helper for macOS token reads`
    (helper + test + barrel re-export)
  - `25c/2`: `feat(ui-web): dev-server-chat reads OP tokens from keychain`
    (dev-server-chat composition + header docs)
  Run `git status --short` before each commit; verify only
  on-topic files staged. Use HEREDOC for messages.

---

## 8. Red flags (stop and report, don't guess)

- The `security` CLI is missing or behaves differently than expected
  (different exit codes, different stderr) — STOP. Report what you
  observed.
- `bun` triggers a GUI prompt when reading the keychain entry —
  STOP. This is a real operational issue and the design needs to
  account for it (likely `-T <bun-binary>` ACL when entries are
  added). Operator tested this in interactive mode and saw no
  prompt; if you see one, something is different.
- You catch yourself wanting to add a column to the `accounts`
  table or change the `secret_ref` grammar — STOP. Advisor
  explicitly rejected both.
- You catch yourself wanting to mutate `process.env` for tokens —
  STOP. Advisor explicitly rejected this.
- You think you need to add a vault → account routing table — STOP.
  The `firstOf` chain IS the routing; each OP token sees only its
  own account's vaults, so wrong-token attempts cleanly fall
  through.
- The `firstOf` composition test (third provider succeeds) doesn't
  pass — STOP. Either `firstOf` semantics are different than
  documented, or the OnePassword backend's error mapping is wider
  than expected. Either way, that's a discovery worth surfacing
  before continuing.
- `bun run typecheck` fails on changes to `dev-server-chat.ts` —
  remember the root tsconfig excludes `apps/ui-web/**`. If your
  changes typecheck only when invoked manually with an inline tsc,
  document that the exclusion is preexisting (Phase 25b found this
  too).
