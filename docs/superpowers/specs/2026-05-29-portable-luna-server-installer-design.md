> **Status: superseded** — historical design record, brought onto master for the design trail; not current truth. The PR 0 unit-form fix shipped; the broader dual-runtime installer was not landed wholesale, so master's installer code is the source of truth.

# Portable Luna Server Installer — Design

**Date:** 2026-05-29
**Status:** Approved design, revised for the dual-runtime decision (incus on Linux, Podman/OCI on Mac). Pending final spec review.
**Scope:** The **server** installer. The client installer is a separate follow-on spec (seed in §11).

---

## 1. Problem

Luna's existing install tooling (`install.sh` client, `scripts/luna-server-install`, `scripts/luna-container-create`) provisions paths, the systemd unit, and the UI WebSocket token — but it **never provisions the model credential**. The account row is a manual `luna-account add`, and the Claude subscription login is a manual, out-of-band step that **silently lapses when a container sits idle**. That gap caused a real production outage: `luna-stable`'s subscription token expired ~3 days unnoticed; every chat turn returned `401 Failed to authenticate`, surfaced only to the WS client, never to journald.

A second defect: the rendered systemd unit uses `ExecStart=… run --filter @luna/ui-web server:chat`. Under systemd that makes the `bun --filter` wrapper the unit's MainPID, so SIGTERM hits the wrapper, not the chat-server child that owns the graceful-shutdown handler (which flushes the HNSW sidecar). **Proven empirically:** under `--filter` the shutdown handler never ran across four restarts; under a direct-exec unit it fired (sidecar written at `0600`). The live containers carry a manual `sed` fix that a re-install would revert, because `render_service` still emits the buggy form.

Third: the server runs only on **Linux + systemd**, so a macOS user can't run it, and `luna-container-create` is **incus (Linux-host-only)** — so there is no portable / Mac story.

## 2. Goals

- **Portable**, with a clean per-platform runtime (decided after research — see §4):
  - **Linux → incus** system containers (kept as-is: lightest natively, full-OS feel, real GPU passthrough).
  - **macOS / portable → Podman** running a Luna **OCI image** (Docker-compatible, rootless, lighter than Docker Desktop, keeps the Mac-GPU door open via libkrun/krunkit; the image also runs under Docker).
- **Pluggable model auth** (anthropic only for v1), wired to the account `secret_ref`: subscription (`claude-code:login`), API key (`env:ANTHROPIC_API_KEY`), 1Password (`op://…`).
- **No silent credential lapse**: a credential health check that fails *loudly* (non-zero exit + journald / container `unhealthy`) when a credential is missing/expired/unresolvable. Token type is never auto-changed.
- The installer is the **durable source of truth** for config (unit / image config + `.env`): idempotent, re-runnable, non-destructive — the operator never *needs* to hand-edit, but the manual escape hatch (systemd drop-ins on Linux; `podman exec` on Mac; direct SSH) always remains.

## 3. Non-goals

- Native macOS *server* (Mac runs the OCI image under Podman — no systemd on the Mac host).
- Non-anthropic providers; multiple accounts at provision time (single `default`, `kind='anthropic'`).
- Non-apt Linux package managers for the bootstrap (v1 is apt-based; the OCI image base is its own choice).
- A *third* runtime (Docker as a first-class target is not required, though the OCI image runs under it; Colima+incus and OrbStack are documented alternatives, not built).
- Real token-exchange/pairing for the client (static shared Bearer token).
- Auto-rotating/refreshing credentials (health check *detects*, does not *fix*).

## 4. Architecture — one shared core, two runtime adapters

The valuable, hard logic is **runtime-agnostic** and lives once in `@luna/agent-cli` + the app packages; each runtime is a thin adapter on top.

```
                ┌─────────────────────── SHARED CORE (bun/TS) ───────────────────────┐
                │ • luna provision server  — auth wiring + account seed + .env upsert │
                │ • luna doctor --check-creds — per-mode credential health probe      │
                │ • shared secret-chain module (discoverOpTokens + firstOf chain)     │
                │ • Core A: value-shape overlay (sk-ant- → ANTHROPIC_API_KEY)         │
                │ • Core B: Linux op-token discovery (non-darwin OP_SERVICE_ACCT)     │
                │ • bun chat-server is PID 1 in BOTH runtimes (SIGTERM → clean stop)  │
                └─────────────────────────────────────────────────────────────────────┘
                          ▲                                              ▲
        ADAPTER A — Linux (incus)                        ADAPTER B — macOS/portable (Podman)
  • luna-bootstrap.sh (apt + bun + clone)          • Luna OCI image (multi-arch amd64/arm64)
  • luna provision server → systemd unit           • entrypoint: provision-then-`exec bun … PID 1`
    (direct-exec, PR 0)                            • podman run/compose: --restart + HEALTHCHECK
  • luna-container-create (incus system container) • volume for ~/.luna; -p 4753/4754; -e auth
  • cred-health = systemd timer                    • cred-health = HEALTHCHECK → luna doctor
```

**Why this split (research-backed):** incus is genuinely lightest on Linux (kernel-sharing, zero VM) and gives real GPU passthrough — keep it. On a Mac every runtime is a VM, so incus's lightness can't transfer; Podman is the best portable choice (OCI/Docker-compatible, rootless, ~35% lighter than Docker Desktop, and the only mainstream runtime that can pass an Apple-Silicon GPU into the guest via libkrun/krunkit). "Ship an image + restart-policy, no systemd inside" is the cross-platform norm (Open WebUI, LibreChat, Dify, n8n, Agent Zero all do exactly this).

**OCI image internals (decided): no systemd.** The entrypoint runs first-run provisioning (§7.3) then `exec`s the bun chat-server as **PID 1** — the same principle as the systemd direct-exec fix, so it receives SIGTERM directly and the graceful-shutdown handler runs. Supervision is Podman's `--restart` policy; health is a `HEALTHCHECK`. The image also runs under plain Docker.

## 5. Pluggable model auth

The provisioner seeds **≥1 anthropic account** (the server fails boot on a zero-row accounts table) by **reusing** `addAccount` (= `runAdd`, `apps/agent-cli/src/commands/add.ts`), which validates the `secret_ref` grammar and INSERTs `(id,label,kind,secret_ref)` with `health='healthy'`, `usage_json='{}'`, `cooldown_ms` defaulted. All v1 modes use `kind='anthropic'` (no new kind — §5.2), so the account is always broker-acquirable. The boot check only guarantees an account *exists*; liveness is `luna doctor`'s job (§6).

**Idempotent converge (verified):** `add` hard-fails on a duplicate id (no upsert); `rm` takes `--id` and exits 1 if absent. Flow keyed on `secret_ref`: `account list` → if `default` present with the same ref, skip; else `account rm --id default || true` then `add`. A value-only change (same ref, new value in `.env`/env) is a correct skip of the row + a `restart required` notice. Run the CLI with `LUNA_DB_PATH=$LUNA_HOME/luna.db`. **Restart required after any change** (broker loads once at boot).

**How each mode is supplied per runtime:**

| Mode | `secret_ref` | Linux/incus | Mac/Podman (OCI) |
|---|---|---|---|
| subscription | `claude-code:login` | `luna provision server` runs `claude setup-token` (interactive TTY) into `$LUNA_HOME/claude` | `podman exec -it luna claude setup-token` (one-time, into the mounted `CLAUDE_CONFIG_DIR` volume) |
| api-key | `env:ANTHROPIC_API_KEY` | provisioner upserts `ANTHROPIC_API_KEY` into `.env` (0600) | `podman run -e ANTHROPIC_API_KEY=…` (non-interactive, clean) |
| 1Password | `op://…` | upsert `OP_SERVICE_ACCOUNT_TOKEN` + install `op` (Core B) | `podman run -e OP_SERVICE_ACCOUNT_TOKEN=…`; `op` baked into the image |

### 5.1 subscription → `claude-code:login`
Reuse `CLAUDE_CODE_LOGIN_SECRET_REF`. Luna never touches the token (broker resolves the sentinel to `Redacted.make("")`; adapter skips the overlay; the SDK reads `$CLAUDE_CONFIG_DIR`). `claude setup-token` is a **browser/device flow that needs a TTY — not available in a piped `curl|bash` or a non-interactive `podman run`.** It is an explicit interactive step (Linux: provisioner; Mac: `podman exec -it`), after which the credential file is verified.

### 5.2 api-key → `env:ANTHROPIC_API_KEY` + value-shape overlay (Core A)
**Verified constraint:** the broker overlay (`packages/adapter-sdk/src/merge-env.ts`, applied at `adapter.ts:260-268`) injects the resolved secret only as `CLAUDE_CODE_OAUTH_TOKEN`, and the per-thread SDK env (`sdkEnv`, `packages/chat-service/src/chat-service.ts:283-288`, a fixed pass-through object — not a `process.env` filter) lacks `ANTHROPIC_API_KEY`. **Core A (minimal):** keep `kind='anthropic'`; at the overlay site branch on **value shape** — a value with prefix `sk-ant-` → inject `ANTHROPIC_API_KEY`, else `CLAUDE_CODE_OAUTH_TOKEN` (preserves today's OAuth-in-env/op behavior); add `ANTHROPIC_API_KEY` to the `sdkEnv` pass-through. **No new kind, no broker change** (a new kind would be invisible to `acquireSession`, which hardcodes kind `anthropic`). Works uniformly for env/op/file-sourced values.

### 5.3 op:// → Linux op-token discovery (Core B)
The `OnePasswordSecretProvider` backend is already platform-agnostic (`op read`, reads `OP_SERVICE_ACCOUNT_TOKEN`). Only discovery is darwin-locked: `chat-server.ts discoverOpTokens` sources tokens only from the macOS keychain. **Core B:** when `process.platform !== 'darwin'`, if `OP_SERVICE_ACCOUNT_TOKEN` is set, push one token under the non-reserved label `primary` (label regex `^[a-z][a-z0-9-]{0,30}$`; `{env,file,op}` reserved). Reverses Phase 25d **on Linux only**. Restrict to service-account tokens (reject interactive `op signin`). op-resolved values still pass the §5.2 value-shape branch. Rotation needs a restart.

## 6. Credential health check — `luna doctor`

New read-only `luna doctor` (none exists today). **`--check-creds` is the default mode** in v1. Two paths:
- **`env:` / `op://`** → resolve through the **exact** chain the server uses (the §4 shared secret-chain module — extracted from `chat-server.ts buildBaseLayer` so server and doctor can't drift). Resolve + non-empty = PASS; `ConfigError` = loud FAIL (module+key, never the secret). **No File provider** (the server chain has none; a `file:` ref correctly FAILs).
- **`claude-code:login`** → stat `$CLAUDE_CONFIG_DIR/.credentials.json`, check `claudeAiOauth.expiresAt` (epoch-ms). Missing/expired = loud FAIL; **near-expiry = within 48h** = warn (still non-zero). Near-expiry applies to this mode only.

**Honest limit:** resolution ≠ acceptance (a revoked-but-present key passes). `--check-creds --live` (one `maxTurns:1` turn) is the only fully-faithful probe; off by default (no paid calls). **Exit codes:** `0` all pass; `1` ≥1 lapsed or near-expiry (severity in the text); `2` doctor itself failed to run. Print the `secret_ref` pointer + PASS/FAIL + reason; never the stored `health` column.

**Delivery per runtime:**
- **Linux/incus:** systemd `luna-<profile>-cred-health.{service,timer}` (dedicated naming rule, not `luna_service_name` which is chat-suffix-bound). `Type=oneshot`, `ExecStart=${bun} …/agent-cli/src/luna.ts doctor --check-creds`. Timer `OnCalendar=hourly`, **`Persistent=true`** (fires after missed runs). Separate from the chat unit.
- **Mac/Podman (OCI):** a `HEALTHCHECK CMD luna doctor --check-creds` in the image → the container shows `unhealthy` + the failure is logged. (Unhealthy doesn't auto-restart — matches the "detect loudly, don't auto-fix" decision; Podman `--restart` still covers crashes.)

## 7. Provisioning & runtime adapters

### 7.1 PR 0 — systemd unit-form fix (lands first, standalone, Linux)
`render_service` (`scripts/luna-server-install`): `WorkingDirectory=${REPO_DIR}/apps/ui-web` + `ExecStart=${bun_bin} run scripts/chat-server.ts`.
- **Tests:** `test/deploy-scripts.test.ts` lines **328 & 464** assert the literal `--filter … server:chat` and **hard-fail** — update them. Line **326** is a `toContain` substring on `WorkingDirectory` so stays green; **tighten** it to pin `/apps/ui-web`.
- **Scope boundary:** only `render_service`; do **not** touch the package.json `server:chat` script or README/CLAUDE.md — `apps/ui-web/scripts/__tests__/rename-chat-server.test.ts` pins `--filter '@luna/ui-web' server:chat` there and must stay green.
- **Behavior-preserving, with precondition:** two `process.cwd()` consumers — `sandbox-local-shell.ts:67` (preserved by `WorkingDirectory=apps/ui-web`) and `chat-service.ts:294` (`… ?? LUNA_REPO_ROOT ?? process.cwd()`), safe **provided `LUNA_REPO_ROOT` is in the EnvironmentFile** (it is). Make that an acceptance check.

### 7.2 Shared idempotent provisioning (TS, both runtimes)
Port `luna_upsert_env` write semantics to TS exactly (prefix-anchored `index($0,key"=")==1` so `LUNA_DB` ≠ `LUNA_DB_PATH`; skip empty; replace-or-append; `chmod 0600`) — single source of truth, de-dups the two bash copies. **Byte-matching is for the write semantics only, not redaction.** Managed `.env` keys = the exact 16 at `luna-server-install:168-182` (`CLAUDE_CONFIG_DIR`, `LUNA_REPO_ROOT`, `LUNA_UI_WS_HOST`, `LUNA_PROFILE`, `LUNA_CHAT_SERVER_NAME`, `LUNA_HOME`, `LUNA_DB_PATH`, `LUNA_MEMORY_DB`, `LUNA_ANALYTICS_DB_PATH`, `LUNA_EVENTS_JSONL_PATH`, `LUNA_EMBEDDER`, `LUNA_OLLAMA_BASE_URL`, `LUNA_OLLAMA_EMBED_MODEL`, `LUNA_OLLAMA_EMBED_DIMENSION`, `LUNA_OLLAMA_PROBE_TIMEOUT_MS`, `UI_WS_TOKEN` preserved unless `--rotate-token`) + `LUNA_CLAUDE_CODE_EXECUTABLE` + per-mode `ANTHROPIC_API_KEY`/`OP_SERVICE_ACCOUNT_TOKEN`. **Redaction:** explicit secret-key allowlist (`UI_WS_TOKEN`, `OP_SERVICE_ACCOUNT_TOKEN`, `ANTHROPIC_API_KEY`, …), **not** the bash `*TOKEN*/*SECRET*` pattern (which leaks `*KEY*`); also patch the surviving bash redactors.

### 7.3 Linux adapter (incus)
`luna provision server` renders the (PR-0-fixed) systemd unit, idempotently. The unit is fully re-rendered each run → a hand-`sed` edit is **clobbered by design**; the supported customization hatch is a **systemd drop-in** (`/etc/systemd/system/<unit>.d/*.conf`). Paths derive from `LUNA_HOME` (no `/root`); **system** unit in `/etc/systemd/system`. **Profile-rename → detect-and-disable** the prior profile's chat + cred-health units. Container creation stays `luna-container-create` (incus, unchanged).

### 7.4 Mac/portable adapter (Podman OCI image)
- **`Dockerfile`** (multi-arch `amd64`+`arm64` via `buildx`): base Debian/Ubuntu (parity with the incus base); install `bun`, the repo + `bun install --frozen-lockfile`, the bundled `claude` binary (`LUNA_CLAUDE_CODE_EXECUTABLE`), vectorlite/duckdb deps, `git`/`curl`, and `op` (for op:// mode). Full-enough userland for the agent's `sandbox-local-shell`. **No systemd.**
- **Entrypoint** (`exec` form → bun is PID 1): on first run, ensure `.env` defaults + `CLAUDE_CONFIG_DIR`, seed the account from env-supplied auth (`ANTHROPIC_API_KEY` / `OP_SERVICE_ACCOUNT_TOKEN`) via the shared core, or fail with a clear "provide auth" message; then `exec bun run scripts/chat-server.ts` (cwd `apps/ui-web`).
- **Run surface:** `podman run -d --restart unless-stopped -p 4753:4753 -p 4754:4754 -v luna-state:/root/.luna -e ANTHROPIC_API_KEY=… <image>`, plus a `compose` file and a `curl|bash` Mac quickstart that wraps `podman machine init` + the run. `HEALTHCHECK` → `luna doctor --check-creds`.
- **Persistence:** a volume for `/root/.luna` (luna.db, memory.db, the HNSW sidecar, claude creds, .env) — survives image updates. Updates = `podman pull` a new image tag + recreate (state in the volume).

## 8. GPU & the embedder

Luna's only GPU workload is **embeddings via Ollama**, reached over HTTP through the installer-managed **`LUNA_OLLAMA_BASE_URL`** — so Luna's own process never needs in-container GPU. This **decouples GPU from the runtime choice**:
- **Linux/incus:** pass the host GPU into the container (`incus config device add … gpu`) for a local/sidecar Ollama (real CUDA/ROCm/Vulkan), or point at any Ollama.
- **Mac/Podman:** run **Ollama natively on the Mac** (full Metal) and set `LUNA_OLLAMA_BASE_URL=http://host.containers.internal:11434` — full GPU, zero passthrough. (Experimental in-container Mac GPU is possible via Podman's libkrun/krunkit Vulkan path, but unnecessary for the embedder.)
- **Docker Desktop** gives no in-container GPU — a non-issue here since the embedder is offloaded.

Caveat: this holds while GPU use stays "a separate Ollama over HTTP." In-process GPU (e.g. `node-llama-cpp` in Luna's process) would re-require native Linux passthrough or the experimental Mac Vulkan path.

## 9. Testing

- **Pure, node-runnable:** `resolveAuthWiring(mode,params)→{kind:'anthropic', secretRef}`, `renderUnit(cfg)→string`, `upsertEnv(text,key,val)→text` (byte-matched to the bash awk write semantics), the Core A value-shape discriminator, and an **`renderDockerfile`/`renderCompose`** string-builder (testable like `renderUnit`).
- **Impure** `provisionServer(cfg,deps?)`/`doctor(cfg,deps?)`/`ociEntrypoint(deps?)` with an injected-deps seam (modeled on `keychain-helper`'s `{_execFile,_platform}` + `onepassword-backend.test`'s `vi.mock` FIFO pattern; register mock before import; provide `Clock.Test`). Account writes delegate to `runAdd` against a temp `LUNA_DB_PATH` (bun-gated).
- **Subprocess** tests mirror `apps/agent-cli/test/cli.test.ts` + a `citty-routing` structural test.
- **Net-new gates:** `bash -n` + `shellcheck` (with a `hasShellcheck` skip-gate) over the scripts + bootstrap; `tsc --noEmit -p apps/agent-cli/tsconfig.json` (vitest doesn't typecheck; chat-server has no tsc gate); a **container build smoke** (build the image for the host arch, run it with a fake API key, assert `/healthz` 200 + `luna doctor` exit code) gated on `hasPodman||hasDocker`.

## 10. Decided defaults

- Cred-health: hourly, `Persistent=true` (Linux) / `HEALTHCHECK` (OCI).
- Near-expiry (claude-code:login only): within 48h → warn, exit non-zero.
- Profile-rename: detect-and-disable prior units.
- Single `default` account, `kind='anthropic'`; api-key var fixed to `ANTHROPIC_API_KEY`.
- OCI image base: Debian/Ubuntu, multi-arch; no systemd; `--restart unless-stopped`.
- No extra push channel in v1 (journald / `unhealthy` + non-zero exit).

## 11. Delivery sequence

Ordering is a **hard correctness gate** (the provisioner's api-key mode needs Core A, op:// needs Core B, and `doctor` needs the shared module). One implementation plan; the client is split out.

1. **PR 0** — systemd unit-form fix (Linux). Independently shippable; fixes the live shutdown/HNSW bug + revert-risk now.
2. **Core A** — value-shape overlay (`adapter.ts`/`merge-env.ts`) + `ANTHROPIC_API_KEY` in `sdkEnv`.
3. **Core B** — Linux op-token discovery in `discoverOpTokens`.
4. **Shared secret-chain module** — extract `discoverOpTokens` + `secretProviderFirstOf([routedOp,env])` from `chat-server.ts buildBaseLayer`; imported by `chat-server` and `doctor`. After Core B, before the provisioner/doctor. Same risk class as A/B (boot-path auth, no tsc gate) — re-verify on box.
5. **`luna provision server`** (shared core) + the **Linux/incus adapter** (systemd render via the PR-0 form; `luna-container-create` unchanged). Must not advertise api-key/op modes until Core A/B merge.
6. **`luna doctor`** + cred-health (systemd timer on Linux; `HEALTHCHECK` reused by the OCI image).
7. **Mac/Podman adapter** — the OCI `Dockerfile` + entrypoint + compose + `curl|bash` Mac quickstart, reusing the shared core (steps 2–6 are prerequisites; the entrypoint just orchestrates them + `exec`s the server).

**Client installer (follow-on spec — seed):** `luna provision client` is trivially cross-platform (UI token is a plain Bearer string; zero keychain entanglement). Thin bootstrap → writes server WS URL(s) + token + the `luna` wrapper via the shared `upsertEnv`; writes both `stable`+`dev` profiles (or `--profile`); first-run WS-connect/`/healthz` check that warns loudly on a bad token. Mac self-host = the Podman image above + the local client. SSH-recovery vars stay opt-in (fix the stale `systemctl --user` default for the chat unit while preserving the legitimate host-service-scope `--user` path in `container-runtime.md`).

## 12. Key risks

- **Two runtime surfaces** — incus/systemd + the OCI image must both stay green; the container build smoke + the existing deploy-scripts tests are the guards. The *shared core* keeps the divergence thin.
- **Shared-auth blast radius** — Core A, Core B, and the secret-chain extraction touch boot-path auth code (no tsc gate); land behind tests + the boot-smoke layer, re-verify on box.
- **Value-shape discriminator** (`sk-ant-`) — reliable today but coupled to Anthropic's key format; document the assumption.
- **Subscription login in a container** is interactive (`podman exec -it claude setup-token`) — not turnkey for the `curl|bash` Mac path; api-key/op modes are the non-interactive ones. Document clearly.
- **`claude-code:login` expiry parsing** — coupled to the SDK's on-disk format; file-presence is the guaranteed floor, expiry/near-expiry best-effort.
- **Resolution ≠ acceptance** — the free health check can't detect a revoked-but-present credential; `--live` is the only certain probe.
- **Krunkit Mac GPU** is experimental + Vulkan-only — not relied on (embedder offloads to Ollama).
- **Profile-rename orphan** — mitigated by detect-and-disable (Linux).
