# Portable Luna Server Installer — Design

**Date:** 2026-05-29
**Status:** Approved design, revised after adversarial spec review (pending final spec review)
**Scope:** The **server** installer. The client installer is a separate follow-on spec (a seed sketch is in §10).

---

## 1. Problem

Luna's existing install tooling (`install.sh` client, `scripts/luna-server-install`, `scripts/luna-container-create`) provisions paths, the systemd unit, and the UI WebSocket token — but it **never provisions the model credential**. The account row is a manual `luna-account add` step, and the Claude subscription login is a manual, out-of-band `claude` login that **silently lapses when a container sits idle**. That gap caused a real production outage: `luna-stable`'s subscription token expired ~3 days unnoticed; every chat turn returned `401 Failed to authenticate`, surfaced only to the WS client, never to journald.

A second, related defect: the rendered systemd unit uses `ExecStart=… run --filter @luna/ui-web server:chat`. Under systemd this makes the `bun --filter` wrapper the unit's MainPID, so SIGTERM is delivered to the wrapper, not the chat-server child that owns the graceful-shutdown handler. The handler (which flushes the HNSW sidecar and re-secures files) never runs on `systemctl stop/restart`. **Proven empirically this session:** under `--filter` the shutdown log never appeared and the sidecar was never written across four restarts; under a direct-exec unit the handler fired (sidecar written at `0600`, shutdown log present). The current direct-exec units on `luna-dev`/`luna-stable` are **manual `sed` edits** that a re-install would revert, because `render_service` still emits the buggy form.

## 2. Goals

- A **portable** server installer: any **Debian/Ubuntu (apt-based)** Linux host or container with systemd, no jax-box/incus/Tailscale/vault assumptions baked in. (Non-apt managers — dnf/apk/pacman — are a follow-on; see §4.1.)
- **Pluggable model auth** (anthropic only for v1), asked at provision time and wired to the matching account `secret_ref`:
  - Claude **subscription** (`claude-code:login`)
  - **API key** (`env:ANTHROPIC_API_KEY`, real `sk-ant-…` support — §5.2)
  - **1Password** (`op://…`, made to work on Linux — §5.3)
- **No silent credential lapse**: a periodic credential health check that fails *loudly* (non-zero exit + journald) when a credential is missing/expired/unresolvable. Token type is never changed automatically.
- The installer is the **durable source of truth** for the unit and `.env`: idempotent, re-runnable, non-destructive — so an operator never *needs* to SSH in and hand-edit, but the manual escape hatch (systemd drop-ins, direct SSH) always remains.

## 3. Non-goals

- Native macOS *server* (Mac users run a Linux container + the client; §10).
- Non-anthropic providers; multiple accounts at provision time (single `default` account in v1).
- Non-apt Linux package managers (v1 is apt-based).
- Container/VM creation/orchestration (stays in `luna-container-create`).
- Real token-exchange/pairing for the client (stays a static shared Bearer token).
- Auto-rotating or auto-refreshing credentials (health check *detects*, it does not *fix*).

## 4. Architecture — the bootstrap/provisioner seam

Two pieces, one documented handoff.

**4.1 `luna-bootstrap.sh` (bash, cold-start only).** The `curl | bash` entrypoint. Does only what must precede any bun code: verify Linux + systemd; install minimal deps via **apt-get** (`git`, `curl`, `ca-certificates`, `unzip`, and — when op:// auth is selected — the `op` CLI, §5.3); install Bun if absent; clone/update the repo to `--repo-dir`; then `exec bun run --filter '@luna/agent-cli' luna -- provision server <flags>`. It holds no auth logic, no unit rendering, no `.env` writes. **v1 requires apt-get** (mirrors today's `luna-server-install`); the dep step must fail with a clear "unsupported package manager" message on non-apt hosts rather than half-installing. `--repo-dir`/`--luna-home` are a **shared flag set** forwarded verbatim into `provision server` (same names on both sides).

**4.2 `luna provision server` (bun/TS, new subcommands in `@luna/agent-cli`).** The brains: idempotent, Effect-based, testable. Owns `.env` upserts, the systemd unit (direct-exec form), pluggable auth wiring, account seeding, and the cred-health timer. New sibling subcommands in `apps/agent-cli/src/luna.ts` (today `{chat, account, memory}`): `provision` (children `{server, client}`) and `doctor`. Mirrors the `commands/account/index.ts` citty pattern — thin `defineCommand` leaves that call pure `run*()` functions returning `CmdResult`, then `process.exit`.

Placing it in `@luna/agent-cli` reuses the existing `luna` entrypoint, the account-table code (`commands/add.ts` `runAdd`/`addAccount`, `db.ts` `openDb`/`defaultDbPath`), and the precedent that `luna memory` already imports `@luna/core` + `effect` at runtime (so importing the secret-provider in `doctor` is consistent — the "core-free" rule applies only to `db.ts`).

## 5. Pluggable model auth

The provisioner seeds **≥1 anthropic account** (the server fails boot on a zero-row accounts table — `chat-server.ts` `buildMain`) by **reusing** `addAccount` (= `runAdd`, `apps/agent-cli/src/commands/add.ts`), which validates the `secret_ref` grammar and INSERTs `(id, label, kind, secret_ref)` with `health='healthy'`, `usage_json='{}'`, and `cooldown_ms` at its column default. All v1 modes use `kind='anthropic'` (no new kind — §5.2), so the seeded account is always broker-acquirable.

**No-silent-lapse split:** the boot check only guarantees *an account row exists* — it does not validate the credential is live. Liveness is `luna doctor`'s job (§6). Both together close the lapse.

**Idempotent converge (verified):** `add` is a plain INSERT and hard-fails (`exit 1`, "already exists") on a duplicate id; there is no upsert. `rm` takes a required `--id` flag and exits 1 when absent. Converge flow keyed on **`secret_ref`** (kind is always `anthropic` in v1): `account list` → if `default` present with the same `secret_ref`, skip; else `account rm --id default || true` (tolerate exit 1) then `account add …`. A **value-only change** (same `secret_ref=env:ANTHROPIC_API_KEY` but a new value in `.env`) is a *correct skip* of the row — the value lives in `.env`, not the row — and the provisioner prints a `value changed; restart required` notice. Always run the CLI with `LUNA_DB_PATH=$LUNA_HOME/luna.db` (the installer already writes this key; both CLI `defaultDbPath()` and the server honor it). **Restart is required after any seed/change** (the AccountBroker loads once at boot; no hot reload).

### 5.1 `subscription` → `secret_ref=claude-code:login`
Reuse the exported `CLAUDE_CODE_LOGIN_SECRET_REF` constant. Luna never touches the token: the broker resolves the sentinel to `Redacted.make("")` and the adapter skips the overlay, so the bundled Claude Agent SDK reads `$CLAUDE_CONFIG_DIR` directly. **Interaction model:** `claude setup-token` is a **browser/device flow that requires a TTY — it is NOT available in a piped `curl | bash` run.** The provisioner runs it as an explicit interactive step (operator completes the browser/paste), with `CLAUDE_CONFIG_DIR=$LUNA_HOME/claude` exported and using the repo-bundled `LUNA_CLAUDE_CODE_EXECUTABLE` so the on-disk format matches, then verifies `$CLAUDE_CONFIG_DIR/.credentials.json` appeared. In a non-interactive run, this mode errors with a clear "run interactively" message. Works on Linux today.

### 5.2 `api-key` → `secret_ref=env:ANTHROPIC_API_KEY` + value-shape overlay (Core change A)
**Verified constraint:** today the broker-owned overlay (`packages/adapter-sdk/src/merge-env.ts`, injected at `adapter.ts:260-268`) places the resolved secret *only* under `CLAUDE_CODE_OAUTH_TOKEN`, and the per-thread SDK env object (`sdkEnv`, `packages/chat-service/src/chat-service.ts:283-288` — a fixed pass-through object, **not** a filter over `process.env`) hard-codes only `CLAUDE_CODE_DISABLE_AUTO_MEMORY` + optional `CLAUDE_CONFIG_DIR`. So a raw `sk-ant-…` key never reaches the SDK.

**Core change A (decided: value-shape branch, minimal — keep `kind='anthropic'`):**
- At the overlay site (`adapter.ts:260-268` / `merge-env.ts`), keep the existing `claude-code:login` skip; for a resolved secret, choose the injection variable by **value shape**: a value with the Anthropic API-key prefix `sk-ant-` is injected as **`ANTHROPIC_API_KEY`**; anything else as **`CLAUDE_CODE_OAUTH_TOKEN`** (preserves today's OAuth-token-in-env/op behavior exactly). The overlay already receives the resolved value, so this is a local branch.
- Add `ANTHROPIC_API_KEY` to the `sdkEnv` pass-through object in `packages/chat-service/src/chat-service.ts:283`.
- **No new account `kind`, no `validateKind` change, no broker change** — the account stays `kind='anthropic'` and is acquired normally. This works uniformly for the value arriving via `env:`, `op://`, or `file:`.

Provisioner: writes the key into `$LUNA_HOME/.env` (0600, the `EnvironmentFile` is the only injection path) under the **fixed** name `ANTHROPIC_API_KEY`, and seeds `secret_ref=env:ANTHROPIC_API_KEY` (no operator-chosen var name in v1). `EnvSecretProvider` is platform-independent.

### 5.3 `op` (1Password) → `secret_ref=op://…` + Linux op-token discovery (Core change B)
**Verified state:** the `OnePasswordSecretProvider` backend is already platform-agnostic — it shells `op read --no-newline -- <ref>` and reads `OP_SERVICE_ACCOUNT_TOKEN` from `process.env`. The only break is *token discovery*: `chat-server.ts` `discoverOpTokens` sources tokens **only** from the macOS keychain (`readKeychainToken`, hard-fails non-darwin). On Linux `routedAccounts=[]`, so `op://` fails at first `acquireSession` (`[op] 0 providers active`).

**Core change B (decided: build it):** in `discoverOpTokens`, **when `process.platform !== 'darwin'`** (non-darwin only — keychain stays the sole darwin source), if `process.env.OP_SERVICE_ACCOUNT_TOKEN` is set, push **one** labeled token under a non-reserved label `primary` (note `{env, file, op}` are reserved; label regex `^[a-z][a-z0-9-]{0,30}$`, no underscores). The backend's existing env-fallback resolves refs; `buildBaseLayer` is unchanged. This is a sibling discovery source, not a change to `keychain-helper` or the backend. Provisioner: ensure the `op` CLI is installed (bootstrap, §4.1), `upsertEnv OP_SERVICE_ACCOUNT_TOKEN`, seed a bare single-account `secret_ref=op://<vault>/<item>/<field>`. The provisioner does **not** add shape enforcement beyond the existing (loose) `validateSecretRef`; the three-part form is documentation guidance. Linux op:// is restricted to **service-account tokens** (reject interactive `op signin`). An op-stored value is still subject to the §5.2 value-shape branch (an `sk-ant-` value → `ANTHROPIC_API_KEY`). Rotating the token requires a server restart (token captured once at layer build).

**Redaction/§0.2:** `OP_SERVICE_ACCOUNT_TOKEN` is the *bootstrap* credential (a different layer than the account-pool secrets §0.2 governs); storing it in the 0600 `EnvironmentFile` is the standard headless service-account pattern. The boot log only prints provider labels/counts, never tokens.

## 6. Credential health check — `luna doctor` + timer

New read-only `luna doctor` subcommand (none exists today). **In v1 `--check-creds` is the default mode**, so bare `luna doctor` runs the credential check; the timer pins `--check-creds` explicitly for forward-compat. Two paths, because the modes resolve differently:

- **`env:` / `op://`** → resolve through the **exact** chain the server uses. Factor the chain construction (`secretProviderFirstOf([routedOp, env])` + `discoverOpTokens`) out of `chat-server.ts` `buildBaseLayer` into a **shared module** (§11 step 3.5) imported by both `chat-server` and `doctor`, so they cannot drift. Resolve + non-empty = PASS; `ConfigError` = loud FAIL reporting module+key (never the secret). **No File provider** — the server chain has none, so a `file:` ref correctly FAILs.
- **`claude-code:login`** → the sentinel traverses no provider. Doctor stats `$CLAUDE_CONFIG_DIR/.credentials.json` and checks `claudeAiOauth.expiresAt` (epoch-ms; shape confirmed on the box). Missing/expired = loud FAIL; **near-expiry = within 48h of `expiresAt`** = warn (still non-zero exit). Near-expiry applies **only** to `claude-code:login` (env:/op:// refs have no expiry concept).

**Honest limit (stated in output and docs):** resolution ≠ acceptance — a revoked-but-present key passes a free check. An opt-in `luna doctor --check-creds --live` (one `maxTurns:1` SDK turn) is the only fully-faithful probe; **off by default** (no paid calls).

**Exit codes** (following the `CmdResult` `0|1|2` precedent in `add.ts`): `0` = all creds pass; `1` = ≥1 credential lapsed **or** near-expiry (severity carried in the journald/stderr text, *not* the code); `2` = doctor itself failed to run (unresolvable config dir, missing accounts table). Print each account's `secret_ref` *pointer* + PASS/FAIL + reason; never the secret. Do **not** trust the stored `health` column (the broker derives `healthy`/`rate_limited` from cooldown, ignoring it).

**Delivery:** units named by a dedicated rule (a generalized `luna_unit_name <profile> <suffix>` helper — **not** `luna_service_name`, which is hard-wired to the chat-server suffix): stable → `luna-cred-health.{service,timer}`, else `luna-<profile>-cred-health.{service,timer}`. Service: `Type=oneshot`, `EnvironmentFile=${ENV_FILE}`, `ExecStart=${bun} ${REPO}/apps/agent-cli/src/luna.ts doctor --check-creds` (direct script path), no `[Install]`. Timer: `OnCalendar=hourly`, **`Persistent=true`** (fires after missed runs — the direct counter to silent lapse), `WantedBy=timers.target`. Separate from the chat unit so a failing probe never touches the server. Restart-on-Linux is always `systemctl` (the control plane's `restart` is `launchctl`/macOS-only).

## 7. Idempotent provisioning + the unit fix

### 7.1 PR 0 — unit-form fix (lands first, standalone)
`render_service` (`scripts/luna-server-install`): `WorkingDirectory=${REPO_DIR}/apps/ui-web` + `ExecStart=${bun_bin} run scripts/chat-server.ts`.
- **Test impact** in `test/deploy-scripts.test.ts` (repo root): lines **328 and 464** assert the literal `--filter @luna/ui-web server:chat` and **hard-fail** — they must change. Line **326** asserts `WorkingDirectory` via `toContain` (substring), so the new `…/repo/apps/ui-web` still matches and stays green; **tighten it** to pin the `/apps/ui-web` suffix so the cwd contract is test-locked.
- **Scope boundary:** PR 0 changes **only** `render_service` in `scripts/luna-server-install` (the systemd unit form). It does **not** touch the package.json `server:chat` script or the README/CLAUDE.md docs — `apps/ui-web/scripts/__tests__/rename-chat-server.test.ts` pins `bun run --filter '@luna/ui-web' server:chat` across those docs and **must stay green**. The npm `server:chat` script legitimately stays a `--filter` invocation for interactive/dev use; only the *unit* form is the bug (systemd makes the wrapper the MainPID).
- **Behavior-preserving — with a stated precondition.** Two `process.cwd()` consumers exist: `sandbox-local-shell.ts:67` (per-query tool sandbox, preserved by setting `WorkingDirectory=apps/ui-web`) and `chat-service.ts:294` (`cwd: opts.cwd ?? process.env["LUNA_REPO_ROOT"] ?? process.cwd()`). The latter is safe **provided `LUNA_REPO_ROOT` is always in the `EnvironmentFile`** (it is — `luna-server-install:169` — so the SDK-query cwd never falls back to `process.cwd()`). Make verifying `LUNA_REPO_ROOT` presence an explicit PR 0 acceptance check. `.env`, DNA.md, and `@luna/*` resolve via `LUNA_HOME`/`import.meta.url`/symlinks, not cwd.

This immediately fixes the live shutdown/HNSW bug and makes the installer the durable source of truth for the unit.

### 7.2 TS provisioner ownership
Port `luna_upsert_env` write semantics to TS exactly (prefix-anchored `index($0, key "=") == 1` so `LUNA_DB` does not clobber `LUNA_DB_PATH`; skip empty values; replace-in-place else append; `chmod 0600` on create and after write). This becomes the single source of truth and de-dups the two existing bash copies (`luna-deploy.sh`, `install.sh`). **Byte-matching applies to the upsert/awk WRITE semantics only — not to redaction.**

**Managed `.env` keys (exact set — the 16 `luna_upsert_env` calls at `scripts/luna-server-install:168-182`):** `CLAUDE_CONFIG_DIR`, `LUNA_REPO_ROOT`, `LUNA_UI_WS_HOST`, `LUNA_PROFILE`, `LUNA_CHAT_SERVER_NAME`, `LUNA_HOME`, `LUNA_DB_PATH`, `LUNA_MEMORY_DB`, `LUNA_ANALYTICS_DB_PATH`, `LUNA_EVENTS_JSONL_PATH`, `LUNA_EMBEDDER`, `LUNA_OLLAMA_BASE_URL`, `LUNA_OLLAMA_EMBED_MODEL`, `LUNA_OLLAMA_EMBED_DIMENSION`, `LUNA_OLLAMA_PROBE_TIMEOUT_MS`, plus `UI_WS_TOKEN` (preserved unless `--rotate-token`) — and `LUNA_CLAUDE_CODE_EXECUTABLE` (auto-detected/drift-checked). Per auth mode, also: `ANTHROPIC_API_KEY` (api-key) or `OP_SERVICE_ACCOUNT_TOKEN` (op://).

**Redaction:** the TS port uses an **explicit secret-key allowlist** (`UI_WS_TOKEN`, `OP_SERVICE_ACCOUNT_TOKEN`, `ANTHROPIC_API_KEY`, …), **not** the bash `*TOKEN*/*SECRET*` pattern — that pattern would leak `ANTHROPIC_API_KEY` (it is `*KEY*`, not `*TOKEN*`) on dry-run. Also add `ANTHROPIC_API_KEY` to the surviving bash redactors (`luna-deploy.sh`, `install.sh`) so a bash `--dry-run` doesn't leak it either.

The unit is fully re-rendered and overwritten each run → a hand-`sed` edit is **clobbered by design** (the fix for today's drift). The supported customization escape hatch is a **systemd drop-in** (`/etc/systemd/system/<unit>.d/*.conf`), which re-render never touches — document this as *the* way to customize without losing it on re-provision.

Portable: paths derive from `LUNA_HOME` (no `/root`); `--repo-dir`/`--luna-home` args; **system** unit in `/etc/systemd/system` (never `--user` for the chat unit). The TS command owns `daemon-reload`/`enable`/`restart` (root); `--dry-run` renders without applying.

**Profile-rename orphan — decided: detect-and-disable.** Re-running with a changed `--profile` renders a differently-named unit; the provisioner must detect and `disable --now` the prior profile's chat + cred-health units (else two servers fight over 4753/4754). Disallowing profile-change-on-rerun is rejected — it breaks the re-runnable philosophy (§2).

## 8. Testing

- **Pure, node-runnable** (no bun, no I/O): `resolveAuthWiring(mode, params) → {kind, secretRef}` (always `kind='anthropic'`; `subscription→claude-code:login`, `api-key→env:ANTHROPIC_API_KEY`, `op→op://…`), `renderUnit(cfg) → string`, `upsertEnv(text, key, val) → text` (byte-matched to the bash awk write semantics, including the prefix anchor), and the value-shape discriminator for Core A.
- **Impure** `provisionServer(cfg, deps?)` / `doctor(cfg, deps?)` with an injected-deps seam modeled on `keychain-helper`'s `{_execFile, _platform}` internals and `onepassword-backend.test`'s `vi.mock('node:child_process')` FIFO-queue pattern (register the mock *before* import; provide `Clock.Test` for Effect layers). The real account write delegates to `runAdd` against a temp `LUNA_DB_PATH` in a bun-gated layer.
- **Subprocess** tests mirror `apps/agent-cli/test/cli.test.ts` (spawn `bun src/luna.ts <sub>` with a temp DB; parameterize the subcommand) + a `citty-routing.test.ts` structural test.
- **Net-new gates:** `bash -n` + `shellcheck` over `install.sh`/bootstrap/`luna-server-install` (with a `hasShellcheck` skip-gate like `hasBun`); an explicit `tsc --noEmit -p apps/agent-cli/tsconfig.json` step (vitest does not typecheck; chat-server.ts has no tsc gate). Reuse the `LUNA_TEST_BUN_PATH` dry-run + PATH-fake-binary harness from `test/deploy-scripts.test.ts`.
- Keep the executable-bit and (platform-gated, `!== 'win32'`) 0600 assertions; extend to the new bootstrap.

## 9. Decided defaults

- Cred-health timer: **hourly**, `Persistent=true`.
- Near-expiry (claude-code:login only): **within 48h of `expiresAt`** → warn, still exit non-zero.
- Profile-rename: **detect-and-disable** the prior profile's units (§7.2).
- No extra push channel in v1 (journald + non-zero exit); push notification is a follow-on.
- Single `default` account, `kind='anthropic'`; api-key env var fixed to `ANTHROPIC_API_KEY`.

## 10. Client installer (follow-on spec — seed)

`luna provision client` is trivially cross-platform: the UI token is a plain Bearer string with zero secret-provider/keychain entanglement. Thin bash bootstrap (git/bun/clone/install) → `luna provision client` writes server WS URL(s) + token + the `luna` wrapper via the shared `upsertEnv`. Writes **both** `stable`+`dev` profiles (or `--profile`) — never partial-write one silently, or `luna chat --dev` breaks. First-run connectivity check: after writing, attempt one WS connect with the token (or GET `/healthz` for reachability) and warn **loudly** on auth failure so a wrong token never writes a silently-dead `.env`. Mac self-host = run a Linux container (`luna-container-create` already prints the paste-ready URL+token) and point the client at the host-mapped port. SSH-recovery vars stay opt-in; correct the chat-unit recovery default to the **system-scope** unit while leaving the legitimate SSH-recovery host-service-scope `systemctl --user` path (`docs/container-runtime.md`) intact — the test only forbids `--user` for the rendered chat unit in `docs/jax-box-deploy.md`. Real pairing/token-exchange is deferred.

## 11. Delivery sequence

The ordering A→B→shared-module→provisioner is a **hard correctness gate, not a preference**: the provisioner's api-key mode depends on Core A and its op:// mode on Core B, and `doctor` imports the shared module. Kept as **one implementation plan** (the parts share load-bearing context; only the client is split out).

1. **PR 0** — unit-form fix (`render_service` + `test/deploy-scripts.test.ts` 328/464, tighten 326). Independently shippable; fixes the live shutdown/HNSW bug and the revert-risk now.
2. **Core A** — value-shape overlay branch (`adapter.ts`/`merge-env.ts`) + `ANTHROPIC_API_KEY` in the `chat-service.ts` `sdkEnv`. No new kind/broker change.
3. **Core B** — Linux (non-darwin) op-token discovery in `discoverOpTokens`.
4. **Shared secret-chain module (step 3.5)** — extract `discoverOpTokens` + `secretProviderFirstOf([routedOp, env])` from `chat-server.ts` `buildBaseLayer` into a shared module imported by both `chat-server` and `doctor`. Lands **after** Core B, **before** the provisioner and doctor. Same risk class as A/B (boot-path auth code, no tsc gate) — re-verify on the box, behind the boot-smoke layer.
5. **`luna provision server`** — bash bootstrap + TS provisioner (pluggable auth wiring, idempotent `.env`/unit, account seeding). It must **not advertise/accept** the api-key or op:// CLI modes until Core A / Core B respectively are merged (or land subscription-only first and gate the other modes).
6. **`luna doctor` + cred-health timer.**

Each ships with the §8 tests. The **client installer** is its own spec after this lands.

## 12. Key risks

- **Shared-auth code blast radius** — Core A, Core B, and the shared secret-chain extraction (steps 2/3/3.5) all touch boot-path auth code (`adapter.ts`/`merge-env.ts`/`chat-server.ts`/`chat-service.ts`) that has no tsc gate. Each must land behind the existing tests + the boot-smoke layer and be re-verified on the box.
- **Value-shape discriminator** — Core A keys on the `sk-ant-` API-key prefix to choose the injection variable. Reliable today (API keys and OAuth tokens have distinct formats), but coupled to Anthropic's key format; document the assumption.
- **`claude-code:login` expiry parsing** is coupled to the Claude Agent SDK's on-disk credential format (verified on the box, not owned by this repo) — treat expiry/near-expiry as best-effort; file-presence is the guaranteed floor.
- **Resolution ≠ acceptance** (§6) — the free health check cannot detect a revoked-but-present credential; `--live` is the only certain probe.
- **Profile-rename orphan** (§7.2) — mitigated by detect-and-disable; residual risk if the prior unit name can't be derived (e.g. manual profile changes outside the provisioner).
