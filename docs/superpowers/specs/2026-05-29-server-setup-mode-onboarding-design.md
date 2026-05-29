# Server Setup-Mode Onboarding (#1) — Design

**Date:** 2026-05-29
**Status:** Approved design (pending spec review)
**Relation:** Reshapes piece **#1** ("dead-simple Claude login") of the "make Luna easy for people" decomposition into a GUI onboarding. **Supersedes the #1 portion** of `2026-05-29-easy-onboarding-resilient-access-design.md` (which now covers **#3** — optional Tailscale/1Password + resilience — plus the CLI `luna login` as a power-user/headless alternative). Independent of Core A/B (the advanced `api-key`/`op://` modes). Builds on PR 0 (merged).

---

## 1. Problem

Onboarding is dev-centric and the model credential lapses *silently* (the production incident: an idle subscription token expired and every chat turn 401'd, surfaced only to the WS client, never loudly). We want a friendly **GUI** onboarding — see a live `claude` session, log in, done — that is also **incident-proof**: a lapsed credential should surface a "log back in" screen, not a silent failure.

## 2. Goals

- **Mode is a pure boot-time function of credential readiness.** On boot the server serves **setup-mode** (a token-gated install UI with an embedded live `claude` terminal) or **normal-mode** (chat). This is the *only* place mode is decided.
- **Restart is the sole transition.** Login completes → restart → gate re-decides → normal. Credential lapses → restart → gate re-decides → setup. No live in-memory mode-flipping.
- **Incident-proof + self-healing.** A lapse auto-surfaces the re-login UI; any restart (crash, deploy, manual, lapse) re-evaluates and lands in the correct mode — you can never get stuck in the wrong one.
- **`setup-token` as the login primitive, surfaced as a web terminal.** The operator opens the printed URL in their own browser, enters their claude.ai credentials, authorizes, and pastes the code back into the embedded terminal (headless-safe, no localhost callback; long-lived token).

## 3. Non-goals

- Operator username/password + sessions (#2 — separate spec). Setup UI stays gated by the static `UI_WS_TOKEN` (§5).
- Optional Tailscale/1Password + resilient access (#3 — the companion spec).
- Container secret system + plugins (#4).
- A **live hot transition** between modes — explicitly deferred; restart is the transition (§4.D). It's both simpler and more resilient.
- Changing the model-auth `secret_ref` model (Core A/B unchanged).

## 4. Architecture

### A. The readiness gate (the one decision point) — replaces the hard-exit boot guard
On boot, the server evaluates **credential readiness** and chooses its mode:
- For a `claude-code:login` account → run **`claude auth status`** (returns `{loggedIn, subscriptionType, …}` JSON, no paid model call; verified on the box). `loggedIn:true` = ready.
- For `env:`/`op://` accounts → resolve the secret through the existing chain (reuse the shared secret-chain module + the `luna doctor` probe from the installer spec §6). Resolves non-empty = ready.
- **No account, or not ready** → **setup-mode**. **Ready** → **normal-mode**.

This **replaces** today's `buildMain` "zero accounts → hard-exit" guard (the OCI-deadlock + silent-lapse source). The gate is a pure function of on-disk/credential state at boot.

### B. Setup-mode
The server stays up and serves a **token-gated** (`UI_WS_TOKEN`) install UI on the normal port; **chat is disabled** (capabilities advertise `setup` instead of `chat`). The install UI hosts a guided flow + the embedded terminal (§C). Security: the embedded terminal can run `claude`, so it MUST be token-gated — an open setup terminal on a network port is effectively remote code execution. Same Bearer/token gate as the chat WS.

### C. Embedded web terminal
The server runs **`claude setup-token`** in a real pty and streams it over WebSocket to an **xterm.js** terminal in the install UI.

**Pty mechanism — resolved by spike (2026-05-29):** `createLocalShellBridge` is **NOT reusable** (it's a request/response in-memory broker — `child_process.spawn`, bounded buffer, no pty, no streaming). And **`node-pty` fails under Bun on the Linux container** (native build errors — `gyp ERR! not ok`; no loadable `pty.node`). The viable mechanism is the **util-linux `script` command** (present, 2.39.3): `child_process.spawn("script", ["-qec", "<LUNA_CLAUDE_CODE_EXECUTABLE> setup-token", "/dev/null"])` — verified to allocate a real TTY (`/dev/pts/N`) and stream bidirectionally under Bun, **with no native dependency and no build toolchain**. So #1b builds a small `script`-pty↔WS bridge (stdout→`pty-output` frame; `pty-input`→the process stdin; `pty-resize`→env/`COLUMNS`/`LINES` or a `kill -WINCH`), plus an `@xterm/xterm` client (the only net-new dep, pure JS). A plan task confirms `script` is in the OCI image too (Debian/Ubuntu base → util-linux present; ensure it) and that stdin forwarding reaches claude.

**Flow:** the terminal shows the `setup-token` prompt + a URL; the operator opens the URL in *their* browser, enters claude.ai credentials, authorizes, and pastes the returned code into the terminal. On success (`claude auth status` → `loggedIn:true`): seed the `claude-code:login` account if absent (reuse `addAccount`), then **restart** (§D).

### D. Restart as the sole transition (simpler AND more resilient)
There is **no live mode-flip**. Both transitions are a restart, after which the gate (§A) re-decides:
- **setup → normal:** login succeeds + account seeded → server restarts → gate sees `loggedIn:true` → normal.
- **normal → setup:** lapse detected (§E) → server restarts → gate sees `loggedIn:false`/unresolvable → setup.

This leans on the **existing restart policies** (Podman `--restart unless-stopped`, systemd `Restart=always`) and PR 0's graceful-shutdown handler (clean HNSW-sidecar flush on the way down). On-disk state (luna.db, memory.db, the sidecar, `CLAUDE_CONFIG_DIR`) survives. **No restart loop:** setup-mode just *serves the UI and sits there* — it self-restarts only when a login completes; a permanently-bad credential rests safely in setup-mode.

### E. Lapse detection (triggers a restart, not a flip)
Two triggers, both ending in "restart → gate re-decides":
- **Proactive:** the cred-health check (hourly, the installer spec's `luna doctor`/`auth status`) finds `loggedIn:false`.
- **Reactive:** a chat turn fails auth (the 401 path). Let the current turn error out, then restart.
Either way the server restarts into setup-mode and the UI shows "your Claude login expired — log back in" with the embedded terminal. (The reactive trigger only fires from normal-mode, so it can't loop.)

## 5. Token interplay (the parked #2 dependency)

The setup UI + embedded terminal are gated by the static `UI_WS_TOKEN` (transport auth). The setup-mode concerns **model-credential readiness**, orthogonal to the transport token. **#2** (operator username/password) will later front the `UI_WS_TOKEN` with a real login; this spec must not entangle the two — the readiness gate keys only on model-credential readiness, never on the transport token.

## 6. Reuse

- `createLocalShellBridge` / the local-shell pty infra (`@luna/ui-ws`) for the embedded terminal.
- `addAccount` (`apps/agent-cli/src/commands/add.ts`) to seed `claude-code:login`.
- The shared secret-chain module + the `luna doctor` / `claude auth status` readiness probe (shared with the installer spec §6 — single source of truth for "is the credential usable").
- The existing `ui-web` surface for the install UI view (a setup view shown when the server reports setup-mode), or a minimal dedicated setup page if reusing ui-web is heavier than a small static page.
- The existing restart policies (Podman/systemd) — the transition mechanism.

## 7. Testing

- **Pure, node-runnable:** `decideMode(readiness) → 'setup'|'normal'` (the gate, given a readiness result) and the readiness evaluator with injected `auth status`/secret-resolve results. Transition triggers as pure logic: login-success → "restart" signal; lapse-detected-from-normal → "restart" signal (assert setup-mode never self-restarts).
- **Impure** terminal bridge tested with a **faked pty/`claude`** (assert: bytes stream both ways, token-gated, seeds the account + emits the restart signal on `loggedIn:true`).
- **MANDATORY real-box acceptance** (the mocks cover everything except the risky bits): on jax-box, exercise the full cycle against `luna-dev` — boot with no/invalid account → setup-mode UI → drive `setup-token` through the embedded terminal (real OAuth round-trip) → seed → restart → normal-mode chat works; then force a lapse (invalidate the cred) → confirm it restarts into setup-mode (not a silent 401, not a loop).
- **Gates:** `tsc --noEmit -p` for the touched packages; the **ManagedRuntime boot-smoke** must cover both setup-mode and normal-mode boots (the gate replaces the boot guard, and chat-server has no tsc gate — boot regressions ship green otherwise).

## 8. Key risks

- **pty mechanism — resolved (spike).** `createLocalShellBridge` is not reusable and `node-pty` fails to build/load under Bun on the container; the chosen mechanism is the util-linux **`script`** command (verified: real TTY + streams under Bun, no native dep). Residual: confirm `script` is in the OCI image and that stdin written to the spawned `script` process reaches claude's pty (a plan task).
- **OAuth round-trip in the embedded terminal** — `setup-token`'s paste-back must work through the xterm.js↔pty path; the real-box acceptance (§7) is the gate, not mocked tests.
- **Security** — the setup terminal is effectively RCE if unauthenticated; it MUST be `UI_WS_TOKEN`-gated (§4.B). A plan task asserts an unauthenticated setup-WS connection is rejected.
- **Gate replaces the boot guard** — touches `chat-server` boot (`buildMain`); re-verify the boot smokes for both modes; no tsc gate there.
- **Restart interrupts an in-flight turn** on lapse — acceptable (the credential is already dead), with the "let the turn error first" nicety.
- **#2 decoupling** — the gate must key only on model-credential readiness, never the transport token, so #2 can evolve the token independently.

## 9. Delivery sequence

1. **Readiness gate** — `decideMode` + the readiness evaluator (`auth status` for `claude-code:login`; secret-resolve for `env:`/`op://`), wired into `chat-server` boot to **replace the zero-accounts hard-exit**. Boot smokes for both modes.
2. **Setup-mode serving** — token-gated install-UI shell + `setup` capability; chat disabled in setup-mode.
3. **Embedded web terminal** — the pty↔WS bridge (reuse/confirm `createLocalShellBridge`) + xterm.js client + `claude setup-token`.
4. **Seed + restart-into-normal** — on `loggedIn:true`: `addAccount` (idempotent) → emit restart → gate lands normal.
5. **Lapse detection → restart** — proactive (cred-health/`auth status`) + reactive (turn 401), each triggering a restart from normal-mode only.

Each ships with §7 tests incl. the real-box acceptance. Depends on PR 0 (merged); shares the readiness probe with the installer spec's `luna doctor` (§6); independent of Core A/B and #3.
