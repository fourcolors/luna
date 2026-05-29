# Easy Onboarding & Resilient Access (#1 + #3) — Design

**Date:** 2026-05-29
**Status:** Approved design (pending spec review)
**Relation:** Companion to `2026-05-29-portable-luna-server-installer-design.md`. This is piece **#1 (dead-simple Claude login)** + **#3 (optional Tailscale / optional 1Password)** of the "make Luna easy for people" decomposition. Pieces **#2 (operator username/password)** and **#4 (container secret system + plugins)** are separate follow-on specs. This spec **retires** the installer spec's §12 "subscription-login-in-a-container is awkward" risk and replaces its §5.1 clunky interactive step.

---

## 1. Problem

Setting Luna up is currently dev-centric and fiddly: the model credential requires a manual, out-of-band `claude` login (and silently lapses — the production incident), `op://` 1Password support is half-assumed, and the jax-box defaults bake in Tailscale. For "normal people," the happy path should be: install → one friendly command to log in to Claude → done, with no Tailscale and no 1Password required, and a reliable way back in if a network path (e.g. Tailscale) goes down.

## 2. Goals

- **`luna login`** — a reusable command that drops the operator into an interactive, detachable **tmux session with `claude` preloaded** inside the running instance; they type `/login` to complete the Claude subscription OAuth. Works for first-time setup **and** re-auth (the ~10-second fix for a lapsed token).
- **1Password optional** — default model auth is the subscription (`luna login`); `op://` stays opt-in/advanced. The installer doesn't install `op` or require `OP_SERVICE_ACCOUNT_TOKEN` unless `op://` is chosen.
- **Tailscale optional** — installer/client stop assuming Tailscale; sensible non-Tailscale defaults; Tailscale remains a supported URL, not a requirement.
- **Resilient access** — the client always has a **primary + ≥1 non-Tailscale fallback** so a single path going down can't lock you out. (The failover + SSH-recovery mechanism already exists — §6 — so this is defaults, not new code.)

## 3. Non-goals

- Operator username/password + sessions (#2 — separate spec). This spec keeps today's static `UI_WS_TOKEN` as the transport credential (§7).
- A container secret-injection system / plugins (#4 — separate spec).
- Replacing the model-provider auth model (Core A/B stay as the advanced `api-key`/`op://` modes).
- Building new failover/recovery logic (it exists; we configure it).

## 4. `luna login` (the new build)

New subcommand in `@luna/agent-cli` (`apps/agent-cli/src/luna.ts`, today `subCommands: {chat, account, memory}` → add `login`; mirror the `commands/account/index.ts` citty pattern: thin `defineCommand` → pure `runLogin()` → `process.exit`).

**Behavior:**
1. **Resolve the target instance + runtime.** Auto-detect / accept `--target <name>` + `--profile <stable|dev>`:
   - Local **Podman** container → `podman exec -it <ctr> …`
   - **incus** container → `incus exec <ctr> -- …` (locally, or over the operator's existing SSH target — reuse the chat config's `startSsh`/`startSshTargets`, `apps/agent-cli/src/chat/config.ts:292`)
   - **bare host** → run locally
2. **Open the login session.** Launch a detachable tmux session inside the target with `claude` preloaded and `CLAUDE_CONFIG_DIR` exported to the server's config dir (`$LUNA_HOME/claude`), using the repo-bundled binary (`LUNA_CLAUDE_CODE_EXECUTABLE`, auto-detected by `luna_configure_claude_executable`) so the on-disk credential format matches what the server reads. Roughly: `tmux new-session -A -s luna-login 'CLAUDE_CONFIG_DIR=$LUNA_HOME/claude <claude-bin>'`. The operator types `/login`, completes the browser/device OAuth (the code/URL prints to the TTY), and detaches/exits. tmux makes the session survive a dropped connection mid-flow (reattach with the same command).
3. **Verify + seed (first-time only).** Confirm `$LUNA_HOME/claude/.credentials.json` appeared. If the `default` account is absent, seed it by reusing `addAccount` (`apps/agent-cli/src/commands/add.ts`): `--id default --label Default --kind anthropic --secret-ref claude-code:login` against `LUNA_DB_PATH`. Then restart the server unit (incus: `systemctl restart …`; Podman: `podman restart …`) so the broker hydrates the new account.
4. **Re-auth path.** If the account already exists, **no seed and no restart** — the SDK re-reads `CLAUDE_CONFIG_DIR` per model call, so a fresh `/login` takes effect on the next turn. This is the durable fix for a lapsed subscription token.

**Requirements:** `tmux` must be present in the instance (cheap add to the OCI image / incus container). `claude setup-token` (long-lived) remains available as an alternative for headless/automation, documented but not the default.

**Installer handoff:** `luna provision server` ends by printing "run `luna login` to authenticate." First boot legitimately has zero accounts → the server's boot guard fails until `luna login` seeds one (acceptable: the operator is told exactly what to run).

## 5. Optional 1Password & Tailscale (defaults/optionality)

- **1Password:** the default path (`luna login` → `claude-code:login`) needs no `op`. The installer installs `op` and writes `OP_SERVICE_ACCOUNT_TOKEN` **only** when the operator explicitly selects `op://` auth. `op://` resolution stays as designed (Core B on Linux).
- **Tailscale:** the client URL set no longer defaults to the jax-box Tailscale name. New defaults: a **local** instance → primary `ws://localhost:<port>/ui`; a **remote/named** instance → primary `ws://<host>:<port>/ui`. Tailscale is just another URL you may list (primary or fallback). The installer/docs stop treating it as a prerequisite. `install.sh`'s `--stable-url`/`--stable-fallback-url`/`--dev-url`/`--dev-fallback-url` flags already make this fully configurable; this changes only the **defaults** (`install.sh:13-16`) and the docs.

## 6. Resilient access (reuse — do not rebuild)

Verified already implemented:
- `apps/agent-cli/src/chat/config.ts:221` builds an **ordered** `urls` list: `uniqueList([url, ...splitListSetting(fallbackUrlSetting?.value)])` (primary + fallback(s) from `LUNA_<PROFILE>_WS_URL` + `_FALLBACK_WS_URL(S)`).
- `apps/agent-cli/src/chat/app.ts:129` `connectWithRecovery(cfg, io)` loops `for (const url of cfg.urls)` and **fails over** on connection error (logs `connection failed for <url>` when >1 URL), then escalates to **SSH-recovery** (`cfg.startSshTargets` + `cfg.startCommand`, config.ts:292) — SSH in and restart the server if every URL fails.

So #3's resilience work is **configuration, not code**:
1. Ship the client (`luna provision client` / `install.sh`) with a **primary + ≥1 non-Tailscale fallback** by default, so a Tailscale outage can't lock the operator out. (e.g. primary = Tailscale name *if used*, fallback = LAN/`.local` or direct `host:port`; or for local: primary `localhost`, no Tailscale at all.)
2. Surface SSH-recovery in the friendly setup as the deeper backup (opt-in; it restarts a *down* server, vs failover which handles a *down path*).
3. Keep the first-run connectivity check (client-installer seed) so a bad/unreachable URL set warns loudly rather than writing a silently-dead `.env`.

## 7. Token interplay (the parked #2 dependency)

`luna login` is **model** auth (it populates `CLAUDE_CONFIG_DIR` / seeds the `claude-code:login` account). It is orthogonal to the **transport** token (`UI_WS_TOKEN`, the WS Bearer). This spec keeps the static `UI_WS_TOKEN` exactly as-is. #2 (operator username/password) will later evolve the transport token from "static, copied" → "minted on user/pass login," and that spec must not break `luna login`. Flagged here so the two stay decoupled.

## 8. Testing

- **Pure, node-runnable:** `resolveLoginTarget(env/flags) → {runtime, execPrefix, claudeConfigDir, dbPath}` (decides podman/incus/bare + the exec command), tested with injected env/flags (no real exec). The default-URL builder (primary + non-Tailscale fallback) as a pure function.
- **Impure** `runLogin(deps?)` with an injected-deps seam (modeled on `keychain-helper`'s `{_execFile,_platform}` and `onepassword-backend.test`'s `vi.mock`): fake the `exec`/`tmux`/`claude`/`systemctl`/`addAccount` so the flow (open session → verify creds file → seed-if-absent → restart-if-first-time → skip-restart on re-auth) is testable without a real container.
- **Subprocess/structural:** mirror `apps/agent-cli/test/cli.test.ts` + a `citty-routing` test asserting `login` is registered.
- **`install.sh` default change:** extend `test/deploy-scripts.test.ts` (or `install.sh`'s test) to assert the new non-Tailscale default URLs and that `op`/`OP_SERVICE_ACCOUNT_TOKEN` are written only when `op://` auth is selected.
- **Gates:** `bash -n`/`shellcheck` for any script changes; `tsc --noEmit -p apps/agent-cli/tsconfig.json` for the new command (vitest doesn't typecheck).

## 9. Decided defaults

- `luna login` opens a **tmux** session (detachable), `claude` interactive `/login` (subscription OAuth); `setup-token` documented as the headless alternative.
- First-time login seeds `claude-code:login` + restarts; re-auth does neither.
- 1Password + Tailscale **off by default**; both opt-in.
- Client default URL set = **primary + ≥1 non-Tailscale fallback** (localhost for local; `host:port` for remote).

## 10. Delivery sequence

1. **`luna login`** — the new subcommand (target resolution → tmux+claude session → verify/seed/restart, with re-auth fast path). The headline deliverable.
2. **Optionality flips** — installer: install `op` + write `OP_SERVICE_ACCOUNT_TOKEN` only for `op://`; change the default client URLs off Tailscale; update docs. Update the affected assertions.
3. **Resilience defaults** — ensure `luna provision client` / `install.sh` always write a non-Tailscale fallback; document SSH-recovery as the deeper backup. (No failover code — it exists.)
4. Add `tmux` to the OCI image (and confirm it's in the incus container).

Each ships with §8 tests. Depends on PR 0 (merged) for the unit form; independent of Core A/B (those are the advanced auth modes, untouched here).

## 11. Key risks

- **`/login` is interactive (browser/device).** `luna login` must give a real TTY (`exec -it`); the tmux detach/reattach handles a dropped link mid-OAuth. Document that `luna login` is not pipe-able (a non-interactive automation path uses `claude setup-token`).
- **Remote-target exec.** For an incus instance on a remote box, `luna login` must reach it (SSH + `incus exec`); reuse the chat config's SSH target rather than inventing a new one. If the SSH target is unset, `luna login` must fail with a clear "run me on the host, or set the SSH target."
- **First-boot zero-accounts.** The server's boot guard fails with no account; the install→`luna login` ordering must be crystal-clear in output so the operator isn't confused by a server that won't fully start until they log in.
- **`tmux`/`claude` presence in the instance** — a missing binary must produce a clear remediation, not a cryptic exec error.
- **Don't entangle with #2** — keep `luna login` (model auth) strictly separate from the transport token so #2 can evolve the token independently.
