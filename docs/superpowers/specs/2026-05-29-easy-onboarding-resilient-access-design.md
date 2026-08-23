> **Status: superseded** — historical design record, brought onto master for the design trail; not current truth. Its #1 portion was reshaped into `2026-05-29-server-setup-mode-onboarding-design.md` (which shipped); the #3 resilience/access content is retained as background.

# Easy Onboarding & Resilient Access (#1 + #3) — Design

**Date:** 2026-05-29
**Status:** Partially superseded — see note below.
**Relation:** Companion to `2026-05-29-portable-luna-server-installer-design.md`.

> **⚠️ #1 reshaped & superseded (2026-05-29).** The primary onboarding is now a **GUI server setup-mode**, designed in `2026-05-29-server-setup-mode-onboarding-design.md` (the operator logs in via an embedded `claude` web terminal; the readiness gate + restart-as-transition replace the CLI flow). The `luna login` **CLI** described below (§4) is retained only as the **power-user / headless** alternative. This spec's still-current content is **#3** (optional Tailscale/1Password + resilience defaults, §5–§6) plus the `setup-token`/`auth status` findings that the new #1 spec also relies on. Pieces **#2** and **#4** remain separate follow-on specs.

---

## 1. Problem

Setting Luna up is dev-centric and fiddly: the model credential requires a manual, out-of-band `claude` login (and silently lapses — the production incident), `op://` 1Password is half-assumed, and the luna-server defaults bake in Tailscale. For normal people the happy path should be: install → one friendly command to log in to Claude → done, with no Tailscale and no 1Password required, and a reliable way back in if a network path (e.g. Tailscale) goes down.

## 2. Goals

- **`luna login`** — a reusable command that opens an interactive, detachable **tmux session** in the running instance and runs **`claude setup-token`** (the headless, paste-back URL+code flow): the operator opens the printed URL in *their* browser, authorizes, pastes the code back. Produces a **long-lived** token (also mitigates idle-lapse). Works for first-time setup **and** re-auth (the ~10-second fix for a lapsed token).
- **1Password optional** — default model auth is the subscription (`luna login`); `op://` stays opt-in/advanced. The installer doesn't install `op` or require `OP_SERVICE_ACCOUNT_TOKEN` unless `op://` is chosen.
- **Tailscale optional** — installer/client stop assuming Tailscale; sensible non-Tailscale defaults; Tailscale remains a supported URL, not a requirement.
- **Resilient access** — the client always has a **primary + ≥1 non-Tailscale fallback** so a single path going down can't lock you out. (The failover + SSH-recovery mechanism already exists — §6 — so this is defaults, not new code.)

## 3. Non-goals

- Operator username/password + sessions (#2). This spec keeps today's static `UI_WS_TOKEN` as the transport credential (§7).
- A container secret-injection system / plugins (#4).
- Replacing the model-provider auth model (Core A/B stay as the advanced `api-key`/`op://` modes).
- Building new failover/recovery logic (it exists; we configure it).

## 4. `luna login` (the new build)

New subcommand in `@luna/agent-cli` (`apps/agent-cli/src/luna.ts`, today `subCommands: {chat, account, memory}` → add `login`; mirror the `commands/account/index.ts` citty pattern: thin `defineCommand` → pure `runLogin()` → `process.exit`).

### 4.1 Auth primitive — `claude setup-token` (NOT interactive `/login`)
**Verified on the box:** the bundled `claude` (Claude Code 2.1.119) exposes `setup-token` ("Set up a long-lived authentication token, requires Claude subscription") and `auth login` (whose `--email`/`--sso` flags reveal a browser/"login page" flow). `setup-token` is the **headless-safe** primitive: it prints a URL the operator opens in *their own* browser, authorizes, and pastes a code back over the TTY — **no localhost callback**, so it works inside a container or over SSH. `auth login`'s browser/localhost-callback flow does **not** work headless (the container's localhost ≠ the operator's browser, even for a local container). `setup-token` is also **long-lived**, which directly blunts the idle-expiry that caused the incident. So `luna login` runs `setup-token` inside a tmux TTY; `auth login` is documented only for the rare case the operator runs `claude` on a desktop with a browser.

### 4.2 Runtime-specific flow (the OCI chicken-and-egg)
The server's boot guard fails on zero accounts (`buildMain`). The login path therefore differs by runtime:

- **incus / bare host:** the system container stays up under systemd even when the chat *unit* fails (zero accounts) — so `luna login` **execs into the running instance**: `incus exec -t <ctr> -- env CLAUDE_CONFIG_DIR=$LUNA_HOME/claude tmux new-session -A -s luna-login '<claude-bin> setup-token'` (bare host: run locally, no exec).
- **OCI / Podman:** the chat-server is **PID 1** and exits on zero accounts → on first run the main container crash-loops and `podman exec` can't get in. So first-time login uses a **transient login container** that mounts the same state volume and runs the auth, independent of the main container:
  `podman run --rm -it -v <state-volume>:/root/.luna <image> luna-login-shell`
  where `luna-login-shell` is an image entrypoint mode that runs `setup-token` into `CLAUDE_CONFIG_DIR` + seeds the account, then exits. The main container is then started and finds the seeded account. **Re-auth** (account already present, main container up) uses `podman exec -it <ctr> …` normally.

### 4.3 Seed + restart (first-time only) / re-auth fast path
- **First-time:** confirm `$LUNA_HOME/claude/.credentials.json` appeared (and `claude auth status` → `loggedIn:true`). If the `default` account is absent, seed it by reusing `addAccount` (`apps/agent-cli/src/commands/add.ts`): `--id default --label Default --kind anthropic --secret-ref claude-code:login` against `LUNA_DB_PATH`. Then start/restart the server so the broker hydrates it (incus: `systemctl restart`; OCI: start the main container).
- **Re-auth:** if the account already exists, **no seed, no restart** — the SDK re-reads `CLAUDE_CONFIG_DIR` per model call. *(Verify-on-box acceptance, §8: confirm a fresh token is picked up without restart, since this is the headline "10-second fix.")*

### 4.4 Persistence, detection, requirements
- **`CLAUDE_CONFIG_DIR` must live on the persisted volume** (`$LUNA_HOME/claude`, under the `/root/.luna` volume) so a login survives container recreate / image update.
- **Runtime detection:** prefer explicit `--target <name>`/`--profile`; else detect (a Podman container by the configured name exists → OCI; an incus container exists → incus; neither → bare host). A **remote** incus instance is reached via the chat config's existing SSH target (`startSsh`/`startSshTargets`, `apps/agent-cli/src/chat/config.ts:292`); if no target is set and the instance isn't local, fail with "run `luna login` on the host, or set the SSH target."
- **Requirements:** `tmux` and the bundled `claude` (`LUNA_CLAUDE_CODE_EXECUTABLE`) present in the instance/image (cheap adds). A missing binary must produce a clear remediation, not a raw exec error.
- **Installer handoff:** `luna provision server` ends by printing "run `luna login` to authenticate." First boot has zero accounts by design; the output makes the install→`luna login` ordering explicit so a not-yet-fully-up server isn't confusing.

## 5. Optional 1Password & Tailscale (defaults/optionality)

- **1Password:** the default path (`luna login` → `claude-code:login`) needs no `op`. The installer installs `op` and writes `OP_SERVICE_ACCOUNT_TOKEN` **only** when the operator selects `op://` auth. `op://` resolution stays as designed (Core B on Linux).
- **Tailscale:** the client URL set no longer defaults to the luna-server Tailscale name. New defaults: **local** instance → primary `ws://localhost:<port>/ui`; **remote/named** → primary `ws://<host>:<port>/ui`. Tailscale is just another URL you may list (primary or fallback), not a prerequisite. `install.sh`'s `--stable-url`/`--stable-fallback-url`/`--dev-url`/`--dev-fallback-url` flags already make this configurable; this changes only the **defaults** (`install.sh:13-16`) and the docs.

## 6. Resilient access (reuse) + the `auth status` doctor upgrade

**Resilient access — already implemented; configure, don't rebuild:**
- `apps/agent-cli/src/chat/config.ts:221` builds an **ordered** `urls` list (`uniqueList([url, ...fallbacks])`).
- `apps/agent-cli/src/chat/app.ts:129` `connectWithRecovery` loops `for (const url of cfg.urls)` and **fails over** on connection error, then escalates to **SSH-recovery** (`startSshTargets` + `startCommand`, config.ts:292) — SSH in and restart a *down* server.

So #3's work is configuration: ship the client with a **primary + ≥1 non-Tailscale fallback** by default (Tailscale-down can't lock you out), surface SSH-recovery as the deeper backup, and keep the first-run connectivity check that warns on an unreachable URL set. **No new failover code.**

**Doctor upgrade (cross-spec, into the installer spec's §6):** the `luna doctor` credential probe for `claude-code:login` should run **`claude auth status`** (returns `{loggedIn, subscriptionType, …}` JSON, no paid model call, no `.credentials.json` format-parsing) — an authoritative liveness check, strictly better than the file-presence + best-effort-expiry approach. Recommend updating the installer spec's §6 Branch B to use `auth status` as the primary signal (file-presence stays the floor if the binary/flag is unavailable).

## 7. Token interplay (the parked #2 dependency)

`luna login` is **model** auth (it populates `CLAUDE_CONFIG_DIR` / seeds the `claude-code:login` account). It is orthogonal to the **transport** token (`UI_WS_TOKEN`, the WS Bearer). This spec keeps the static `UI_WS_TOKEN` exactly as-is. #2 (operator username/password) will later evolve the transport token from "static, copied" → "minted on user/pass login," and that spec must not break `luna login`. Flagged so the two stay decoupled.

## 8. Testing

- **Pure, node-runnable:** `resolveLoginTarget(env/flags) → {runtime, mode: 'exec'|'transient', execArgv, claudeConfigDir, dbPath}` (decides incus-exec vs OCI-transient-container vs bare-local, and whether it's first-time-seed vs re-auth), tested with injected env/flags. The default-URL builder (primary + non-Tailscale fallback) as a pure function.
- **Impure** `runLogin(deps?)` with an injected-deps seam (modeled on `keychain-helper`'s `{_execFile,_platform}` and `onepassword-backend.test`'s `vi.mock`): fake `exec`/`podman`/`incus`/`tmux`/`claude`/`addAccount`/`systemctl` so the flow (open session → verify creds → `auth status` → seed-if-absent → restart-if-first-time → skip on re-auth) is unit-testable without a real container.
- **REAL-BOX acceptance (mandatory — the mocks cover everything *except* the risky bit):** on luna-server, run the actual `luna login` against `luna-dev` end-to-end through the `setup-token` OAuth round-trip, confirm `claude auth status` → `loggedIn:true`, and confirm a **re-auth is picked up without restart** (§4.3). Green unit tests must not be mistaken for a working OAuth flow.
- **Subprocess/structural:** mirror `apps/agent-cli/test/cli.test.ts` + a `citty-routing` test asserting `login` is registered.
- **`install.sh` defaults:** extend the deploy-script tests to assert the new non-Tailscale default URLs and that `op`/`OP_SERVICE_ACCOUNT_TOKEN` are written only when `op://` is selected.
- **Gates:** `bash -n`/`shellcheck` for script changes; `tsc --noEmit -p apps/agent-cli/tsconfig.json` (vitest doesn't typecheck).

## 9. Decided defaults

- `luna login` runs **`claude setup-token`** (headless paste-back, long-lived) inside a detachable tmux session; `auth login` (browser) documented only for desktop use.
- First-time login seeds `claude-code:login` + starts/restarts the server; re-auth does neither.
- OCI first-run uses a **transient login container**; incus/bare exec into the running instance.
- 1Password + Tailscale **off by default**; both opt-in.
- Client default URL set = **primary + ≥1 non-Tailscale fallback** (localhost for local; `host:port` for remote).
- `luna doctor` uses `claude auth status` for the subscription liveness check.

## 10. Delivery sequence

1. **Image/instance prep:** add `tmux` to the OCI image; add the `luna-login-shell` entrypoint mode (runs `setup-token` into `CLAUDE_CONFIG_DIR` + seeds the account); confirm `tmux` in the incus container.
2. **`luna login`** — the new subcommand: target/runtime resolution (incus-exec | OCI-transient-container | bare-local), the tmux+`setup-token` session, verify (`auth status`) + seed + start/restart, and the re-auth fast path. Headline deliverable.
3. **Optionality flips** — installer installs `op` + writes `OP_SERVICE_ACCOUNT_TOKEN` only for `op://`; change default client URLs off Tailscale; update docs + affected assertions.
4. **Resilience defaults** — ensure `luna provision client`/`install.sh` always write a non-Tailscale fallback; document SSH-recovery. (No failover code.)
5. **Doctor upgrade** — switch the installer spec's §6 `claude-code:login` probe to `claude auth status`.

Each ships with §8 tests (incl. the real-box acceptance). Depends on PR 0 (merged) for the unit form; independent of Core A/B.

## 11. Key risks

- **(Resolved) `/login` headless feasibility** — addressed by using `setup-token` (paste-back, no localhost callback), verified present on the binary. The mandatory real-box acceptance (§8) confirms the actual round-trip during implementation; do not ship on mocked tests alone.
- **(Resolved) OCI chicken-and-egg** — the transient login container (§4.2) seeds the account into the shared volume without the main (PID-1, zero-account-exiting) container being up. The spec no longer treats the two runtimes uniformly for login.
- **Re-auth "no restart" is load-bearing** — confirm on the box (§8) that a fresh token is picked up without restart; it's the headline benefit.
- **`CLAUDE_CONFIG_DIR` on the volume** — if it isn't persisted, a login is lost on container recreate; §4.4 requires it.
- **Remote-target exec** — for a remote incus instance, `luna login` must reach it via the configured SSH target or fail with a clear message (§4.4).
- **Don't entangle with #2** — keep `luna login` (model auth) strictly separate from the transport token so #2 can evolve the token independently.
