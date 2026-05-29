# Portable Luna Server Installer — Design

**Date:** 2026-05-29
**Status:** Approved design (pending spec review)
**Scope:** The **server** installer. The client installer is a separate follow-on spec (a seed sketch is included in §10).

---

## 1. Problem

Luna's existing install tooling (`install.sh` client, `scripts/luna-server-install`, `scripts/luna-container-create`) provisions paths, the systemd unit, and the UI WebSocket token — but it **never provisions the model credential**. The account row is a manual `luna-account add` step, and the Claude subscription login is a manual, out-of-band `claude` login that **silently lapses when a container sits idle**. That gap caused a real production outage: `luna-stable`'s subscription token expired ~3 days unnoticed; every chat turn returned `401 Failed to authenticate`, surfaced only to the WS client, never to journald.

A second, related defect: the rendered systemd unit uses `ExecStart=… run --filter @luna/ui-web server:chat`. Under systemd this makes the `bun --filter` wrapper the unit's MainPID, so SIGTERM is delivered to the wrapper, not the chat-server child that owns the graceful-shutdown handler. The handler (which flushes the HNSW sidecar and re-secures files) never runs on `systemctl stop/restart`. This was proven empirically: under `--filter` the shutdown log never appeared and the sidecar was never written across four restarts; under a direct-exec unit the handler fired (sidecar written at `0600`, shutdown log present). The current direct-exec units on `luna-dev`/`luna-stable` are **manual `sed` edits** that a re-install would revert, because `render_service` still emits the buggy form.

## 2. Goals

- A **portable** server installer: any Linux host or container with systemd, no jax-box/incus/Tailscale/vault assumptions baked in.
- **Pluggable model auth**, asked at provision time and wired to the matching account `secret_ref`:
  - Claude **subscription** (`claude-code:login`)
  - **API key** (`env:VAR`, with real `sk-ant-…` support — see §5.2)
  - **1Password** (`op://…`, made to work on Linux — see §5.3)
- **No silent credential lapse**: a periodic credential health check that fails *loudly* (non-zero exit + journald) when a credential is missing/expired/unresolvable. Token type is never changed automatically.
- The installer is the **durable source of truth** for the unit and `.env`: idempotent, re-runnable, non-destructive — so an operator never *needs* to SSH in and hand-edit, but the manual escape hatch (systemd drop-ins, direct SSH) always remains.

## 3. Non-goals

- Native macOS *server* (Mac users run a Linux container + the client; see §10).
- Container/VM creation/orchestration (stays in `luna-container-create`).
- Real token-exchange/pairing protocol for the client (stays a static shared Bearer token).
- Auto-rotating or auto-refreshing credentials (health check *detects*, it does not *fix*).

## 4. Architecture — the bootstrap/provisioner seam

Two pieces, one documented handoff:

**4.1 `luna-bootstrap.sh` (bash, cold-start only).** The `curl | bash` entrypoint. Does only what must precede any bun code: verify Linux + systemd; install minimal apt deps (`git`, `curl`, `ca-certificates`, `unzip`, and — when op:// auth is selected — the `op` CLI, §5.3); install Bun if absent; clone/update the repo to `--repo-dir`; then `exec bun run --filter '@luna/agent-cli' luna -- provision server <flags>`. It holds no auth logic, no unit rendering, no `.env` writes.

**4.2 `luna provision server` (bun/TS, new subcommands in `@luna/agent-cli`).** The brains: idempotent, Effect-based, testable. Owns `.env` upserts, the systemd unit (direct-exec form), pluggable auth wiring, account seeding, and the cred-health timer. New sibling subcommands in `apps/agent-cli/src/luna.ts` (today `{chat, account, memory}`): `provision` (children `{server, client}`) and `doctor`. Mirrors the `commands/account/index.ts` citty pattern — thin `defineCommand` leaves that call pure `run*()` functions returning `CmdResult`, then `process.exit`.

Placing it in `@luna/agent-cli` reuses the existing `luna` entrypoint, the account-table code (`commands/add.ts` `runAdd`/`addAccount`, `db.ts` `openDb`/`defaultDbPath`), and the precedent that `luna memory` already imports `@luna/core` + `effect` at runtime (so importing the secret-provider in `doctor` is consistent — the "core-free" rule applies only to `db.ts`).

## 5. Pluggable model auth

The provisioner seeds **≥1 anthropic account** (the server fails boot on zero accounts — `chat-server.ts` `buildMain`; this is the enforced no-silent-lapse anchor) by **reusing** `addAccount` (= `runAdd`, `apps/agent-cli/src/commands/add.ts`), which already validates the `secret_ref` grammar and INSERTs `health='healthy', cooldown_ms=NULL, usage_json='{}'`.

**Idempotency (verified):** `add` is a plain INSERT and hard-fails (`exit 1`, "already exists") on a duplicate id; there is no upsert. `rm` takes a required `--id` flag and exits 1 when absent. So the converge flow is: `account list` → if `default` present with the *same* `secret_ref`, skip; else `account rm --id default || true` then `account add …`. Always run with `LUNA_DB_PATH=$LUNA_HOME/luna.db` exported (or `--db-path`) so the row lands where `chat-server` hydrates. **Restart is required after seeding** (the AccountBroker loads once at boot; no hot reload).

### 5.1 `subscription` → `secret_ref=claude-code:login`
Reuse the exported `CLAUDE_CODE_LOGIN_SECRET_REF` constant. Luna never touches the token: the broker resolves the sentinel to `Redacted.make("")` and the adapter skips the env overlay, so the bundled Claude Agent SDK reads `$CLAUDE_CONFIG_DIR` directly. Provisioner: the installer already `mkdir`s `$LUNA_HOME/claude` and sets `CLAUDE_CONFIG_DIR`; drive `claude setup-token` with `CLAUDE_CONFIG_DIR=$LUNA_HOME/claude` exported, using the repo-bundled `LUNA_CLAUDE_CODE_EXECUTABLE` so the on-disk format matches. The browser/device step is completed by the operator; the provisioner orchestrates and then verifies the credential file appeared. Works on Linux today.

### 5.2 `api-key` → `secret_ref=env:VAR` + **kind-aware overlay (Core change A)**
**Verified constraint:** today the adapter overlays the resolved secret *only* under `CLAUDE_CODE_OAUTH_TOKEN` (`adapter.ts`), and `chat-service.ts` builds the SDK env from a curated allowlist that does **not** include `ANTHROPIC_API_KEY`. So a raw `sk-ant-…` key in `env:VAR` would provision "successfully" but fail auth at first query.

**Core change A (decided: add real API-key support):** introduce a kind-aware credential overlay — a new account `kind` (e.g. `anthropic-apikey`) whose resolved secret is injected as `ANTHROPIC_API_KEY`, and add that variable to the SDK env allowlist in `chat-service.ts`. The `kind` must be added to the `validateKind` allowlist in `commands/add.ts`. Provisioner writes the key value into `$LUNA_HOME/.env` (0600, the only injection path — `EnvironmentFile`) and seeds `secret_ref=env:<VARNAME>`. `EnvSecretProvider` is platform-independent, so resolution works on Linux and macOS identically.

### 5.3 `op` (1Password) → `secret_ref=op://…` + **Linux op-token discovery (Core change B)**
**Verified state:** the `OnePasswordSecretProvider` backend is already platform-agnostic — it shells `op read --no-newline -- <ref>` and reads `OP_SERVICE_ACCOUNT_TOKEN` from `process.env` with no platform check. The only break is *token discovery*: `chat-server.ts` `discoverOpTokens` sources tokens **only** from the macOS keychain (`readKeychainToken`, which hard-fails on non-darwin). On Linux `routedAccounts=[]`, so `op://` fails at first `acquireSession` (`[op] 0 providers active`).

**Core change B (decided: build it):** in `discoverOpTokens`, on non-darwin (or unconditionally), if `process.env.OP_SERVICE_ACCOUNT_TOKEN` is set, push **one** labeled token under a non-reserved label (`primary` — note `{env, file, op}` are reserved, and the label regex is `^[a-z][a-z0-9-]{0,30}$`, no underscores). The backend's existing env-fallback then resolves refs; `buildBaseLayer` needs no change. This reverses Phase 25d's "keychain is the single source of truth" **on Linux only** — keychain stays the darwin path; the env path is a sibling discovery source, not a change to `keychain-helper` or the backend. Provisioner: ensure the `op` CLI is installed (bootstrap, §4.1), `upsertEnv OP_SERVICE_ACCOUNT_TOKEN`, seed `secret_ref=op://<vault>/<item>/<field>` (bare, single account). Restrict Linux op:// to **service-account tokens** (headless); reject interactive `op signin`. Rotating the token requires a server restart (token captured once at layer build).

**Redaction/§0.2:** `OP_SERVICE_ACCOUNT_TOKEN` is the *bootstrap* credential (a different layer than the account-pool secrets §0.2 governs); storing it in the 0600 `EnvironmentFile` is the standard headless service-account pattern. The boot log only ever prints provider labels/counts, never tokens.

## 6. Credential health check — `luna doctor` + timer

New read-only `luna doctor --check-creds` subcommand (no `doctor` exists today). Two paths, because the modes resolve differently:

- **`env:` / `op://`** → resolve through the **exact** chain the server uses. Factor the chain construction (`secretProviderFirstOf([routedOp, env])` + `discoverOpTokens`) out of `chat-server.ts` `buildBaseLayer` into a **shared module** imported by both `chat-server` and `doctor`, so they cannot drift. Resolve + non-empty = PASS; `ConfigError` = loud FAIL reporting module+key (never the secret). **No File provider** — the server chain has none, so a `file:` ref correctly FAILs (adding File would manufacture a false-healthy).
- **`claude-code:login`** → the sentinel traverses no provider. Doctor stats `$CLAUDE_CONFIG_DIR/.credentials.json` and checks `claudeAiOauth.expiresAt` (epoch-ms; refreshToken/scopes/subscriptionType also present — shape confirmed on the box). Missing/expired = loud FAIL.

**Honest limit (stated in output and docs):** resolution ≠ acceptance — a revoked-but-present key passes a free check. An opt-in `luna doctor --check-creds --live` (one `maxTurns:1` SDK turn) is the only fully-faithful probe; **off by default** (no paid calls).

**Output/exit:** print each account's `secret_ref` *pointer*, PASS/FAIL, and failure reason; exit 0 if all valid, non-zero if ≥1 lapsed. Do **not** trust the stored `health` column (the broker derives `healthy`/`rate_limited` from cooldown, ignoring it).

**Delivery:** `luna-<profile>-cred-health.{service,timer}` (profile naming via `luna_service_name`: stable → `luna-cred-health`, else `luna-<profile>-cred-health`). Service: `Type=oneshot`, `EnvironmentFile=${ENV_FILE}`, `ExecStart=${bun} ${REPO}/apps/agent-cli/src/luna.ts doctor --check-creds` (direct script path), no `[Install]`. Timer: `OnCalendar=hourly`, **`Persistent=true`** (fires after missed runs — the direct counter to silent lapse), `WantedBy=timers.target`. Separate from the chat unit so a failing probe never touches the server. Restart-on-Linux is always `systemctl` (the control plane's `restart` is `launchctl`/macOS-only).

## 7. Idempotent provisioning + the unit fix

### 7.1 PR 0 — unit-form fix (lands first, standalone)
`render_service` (`scripts/luna-server-install`): `WorkingDirectory=${REPO_DIR}/apps/ui-web` + `ExecStart=${bun_bin} run scripts/chat-server.ts`. Update the **three** assertions in `test/deploy-scripts.test.ts` that pin the old strings: **lines 326 (WorkingDirectory), 328 (ExecStart), 464 (ExecStart)**. Behavior-preserving — the only `process.cwd()` consumer is the per-query `sandbox-local-shell`, preserved by setting WorkingDirectory to `apps/ui-web`; `.env`, DNA.md, and `@luna/*` all resolve via `LUNA_HOME`/`import.meta.url`/symlinks, not cwd. This immediately fixes the live shutdown/HNSW bug and makes the installer the durable source of truth for the unit.

### 7.2 TS provisioner ownership
Port `luna_upsert_env` semantics to TS exactly (prefix-anchored `index($0, key "=") == 1` so `LUNA_DB` does not clobber `LUNA_DB_PATH`; skip empty values; replace-in-place else append; `chmod 0600` on create and after write). This becomes the single source of truth and de-dups the two existing bash copies (`luna-deploy.sh` and `install.sh`). Managed `.env` keys: the ~16 existing `LUNA_*`/`CLAUDE_CONFIG_DIR`/`UI_WS_TOKEN` keys, plus the auth-specific value (`ANTHROPIC_API_KEY` or `OP_SERVICE_ACCOUNT_TOKEN`). UI token preserved unless `--rotate-token`.

The unit is fully re-rendered and overwritten each run → a hand-`sed` edit is **clobbered by design** (the fix for today's drift). The supported customization escape hatch is a **systemd drop-in** (`/etc/systemd/system/<unit>.d/*.conf`), which re-render never touches — document this as *the* way to customize without losing it on re-provision.

Portable: all paths derive from `LUNA_HOME` (no `/root` assumption); `--repo-dir`/`--luna-home` args; **system** unit in `/etc/systemd/system` (never `--user` — a test forbids the user-scope string). Redaction uses an explicit secret-key allowlist (`UI_WS_TOKEN`, `OP_SERVICE_ACCOUNT_TOKEN`, `ANTHROPIC_API_KEY`, …) — a broad `*KEY*` pattern would over-redact. The TS command owns `daemon-reload`/`enable`/`restart` (root); `--dry-run` renders without applying.

**Flagged risk — profile-rename orphan:** re-running with a changed `--profile` renders a differently-named unit, leaving the old one enabled (two servers fighting over 4753/4754). Mitigation: detect and disable the prior profile's unit on a profile change, or disallow changing profile on re-run.

## 8. Testing

- **Pure, node-runnable** (no bun, no I/O): `resolveAuthWiring(mode, params) → {kind, secretRef}`, `renderUnit(cfg) → string`, `upsertEnv(text, key, val) → text` (byte-matched to the bash awk semantics, including the prefix anchor).
- **Impure** `provisionServer(cfg, deps?)` / `doctor(cfg, deps?)` with an injected-deps seam modeled on `keychain-helper`'s `{_execFile, _platform}` internals and `onepassword-backend.test`'s `vi.mock('node:child_process')` FIFO-queue pattern. The real account write delegates to `runAdd` against a temp `LUNA_DB_PATH` in a bun-gated layer.
- **Subprocess** tests mirror `apps/agent-cli/test/cli.test.ts` (spawn `bun src/luna.ts <sub>` with a temp DB) + a `citty-routing.test.ts` structural test (assert `meta.name` + `Object.keys(subCommands)`).
- **Net-new gates:** `bash -n` + `shellcheck` over `install.sh`/bootstrap/`luna-server-install` (with a `hasShellcheck` skip-gate like `hasBun`); an explicit `tsc --noEmit -p apps/agent-cli/tsconfig.json` step (vitest does not typecheck). Reuse the `LUNA_TEST_BUN_PATH` dry-run + PATH-fake-binary harness from `deploy-scripts.test.ts`.
- Keep the executable-bit and (platform-gated) 0600 assertions; extend them to the new bootstrap.

## 9. Decided defaults for the small knobs

- Cred-health timer: **hourly**, `Persistent=true`.
- Near-expiry: **soft-warn that still exits non-zero** (so the oneshot shows "failed" and journald carries it) — never a silent pass.
- No extra push channel in v1 (journald + non-zero exit). A push notification is a follow-on.
- Single `default` account in v1 (no multi-account at provision time).

## 10. Client installer (follow-on spec — seed)

`luna provision client` is trivially cross-platform: the UI token is a plain Bearer string with zero secret-provider/keychain entanglement. Thin bash bootstrap (git/bun/clone/install) → `luna provision client` writes server WS URL(s) + token + the `luna` wrapper via the shared `upsertEnv`. Writes **both** `stable`+`dev` profiles (or `--profile`) — never partial-write one silently, or `luna chat --dev` breaks. First-run connectivity check: after writing, attempt one WS connect with the token (or GET `/healthz` for reachability) and warn **loudly** on auth failure so a wrong token never writes a silently-dead `.env`. Mac self-host = run a Linux container (`luna-container-create` already prints the paste-ready URL+token) and point the client at the host-mapped port. SSH-recovery vars stay opt-in (and their stale `systemctl --user` default gets corrected to the system-scope unit). Real pairing/token-exchange is deferred.

## 11. Delivery sequence

1. **PR 0** — unit-form fix (`render_service` + `deploy-scripts.test.ts` 326/328/464). Independently valuable; fixes the live shutdown/HNSW bug and the revert-risk.
2. **Core A** — kind-aware credential overlay (real API keys) + `anthropic-apikey` kind + SDK env allowlist.
3. **Core B** — Linux op-token discovery in `discoverOpTokens`.
4. **`luna provision server`** — bash bootstrap + TS provisioner (pluggable auth wiring, idempotent `.env`/unit, account seeding) + the shared secret-chain module.
5. **`luna doctor` + cred-health timer.**

Each ships with the tests in §8. The **client installer** is its own spec after this lands.

## 12. Key risks

- **Profile-rename orphan** (§7.2) — two units fighting over ports.
- **`claude-code:login` expiry parsing** is coupled to the Claude Agent SDK's on-disk credential format (verified on the box, but not owned by this repo) — treat expiry detection as best-effort; file-presence is the guaranteed floor.
- **Resolution ≠ acceptance** (§6) — the free health check cannot detect a revoked-but-present credential; `--live` is the only certain probe.
- **Core changes A & B touch shared auth code** (`adapter.ts`/`chat-service.ts`/`chat-server.ts`) — must land behind the existing tests + the boot-smoke layer, and re-verify on the box (the chat-server has no tsc gate).
