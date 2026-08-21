# PRD — Generalized Luna Server Self-Update

**Status:** Proposed
**Owner:** Server / platform
**Audience:** Self-hosted Luna operators (non-developer where possible), maintainers, contributors

---

## 1. Problem & Context

Luna ships two updatable surfaces, but only one is a product.

**The Moon desktop client already auto-updates for everyone.** A Tauri v2 updater polls
`releases/latest/download/latest.json`, verifies a minisign-signed bundle, downloads it in the
background, and stages a held *"Restart to update"* that persists and restores the session
(`apps/ui-moon-tauri/src-tauri/tauri.conf.json` updater block; `bump-moon.ts:37-41` bumps the
version triple; `.github/workflows/release-moon.yml` builds + signs + publishes on a `moon-v*`
tag). This is a real, general capability.

**The server has none of this.** Updating the Luna chat server today is the *maintainer's private
ops*:

- `scripts/luna-update-server` is a genuinely reusable, product-grade **update engine** — fetch a
  ref → conditional `bun install` → **stop → settle → start** restart → `/healthz`+`/readyz`
  readiness gate → **auto-rollback** on failure, with exit codes `0` healthy / `1` rolled-back /
  `2` critical. This part is good and we keep it verbatim.
- `scripts/luna-autodeploy` is the **bespoke trigger** wrapped around that engine: a systemd timer
  that polls GitHub because the maintainer's box is on a private network and cannot be reached
  inbound, with hardcoded clone paths, container plumbing, and a private-host profile map. None of
  this generalizes.
- `install.sh` is **install-only** — it clones (or fast-forwards) a client checkout and writes a
  CLI wrapper. There is **no upgrade verb**.
- There is **no server release artifact, no server version, no `luna update` command, and no
  "update available" signal.** The only server-version notion that exists is the git short-SHA:
  `resolveBuildSha()` (`apps/server/src/chat-server.ts:358-378`) resolves `LUNA_BUILD_SHA` →
  `git rev-parse --short HEAD` → `"unknown"`, surfaced in the `hello` frame
  (`packages/ui-ws/src/protocol.ts:42-46`) and the `/readyz` JSON body
  (`packages/ui-ws/src/server.ts:960-998`). `PKG_VERSION` in
  `packages/control-server/src/router.ts:19` is a hardcoded `"0.0.1"` that is never bumped.
- The engine even **refuses** anything but a system unit under `/etc/systemd/system`
  (`scripts/luna-update-server:243-262`) and knows nothing about macOS launchd — so a rootless
  `systemctl --user` install or the Moon "This Mac" local server cannot be updated by it at all.

**The gap:** every self-hoster — on a bare Linux host, in a container, or running a local server
under the Moon app on macOS — needs a first-class way to discover, apply, and (optionally)
automate server updates, with the same safety guarantees the maintainer's box enjoys, and with
zero knowledge of the maintainer's private infrastructure.

---

## 2. Goals / Non-Goals

### Goals

- **G1.** A single, topology-agnostic operator command — `luna update` — that checks for a newer
  server release, applies it through the existing engine, and reports the outcome. Works on a bare
  Linux host, in a container, on rootless `--user` installs, and on a macOS local server.
- **G2.** A **server release channel** (`server-v*` tags + a tiny JSON version pointer) so "what's
  the latest server version" is a stable, unauthenticated lookup — mirroring the Moon release model
  *without* touching the Moon updater's `releases/latest` invariant.
- **G3.** Preserve **every** safety primitive: `/healthz`+`/readyz` readiness gate, auto-rollback,
  stop→settle→start restart (SQLite/DuckDB WAL settle), and connect-aware defer ("never drop a user
  mid-conversation").
- **G4.** Reuse `scripts/luna-update-server` as the *sole* apply/restart/rollback executor — no
  reimplementation of restart, probe, or rollback logic.
- **G5.** Make the engine **genuinely general in the same effort**: lift the `--user` refusal and
  auto-detect the supervisor (system unit / `--user` unit / launchd). Extract connect-aware defer
  into a shared library function so the CLI, the installer, and the maintainer's autodeploy share
  one implementation.
- **G6.** Surface a real **server version** in `/readyz` and the `hello` frame so update-available
  comparison is not SHA-only.
- **G7.** An **opt-in** richer UX layered on top: an operator-installed timer for hands-off updates,
  and an additive, capability-gated server-update notification that Moon's existing Updates panel
  can project.

### Non-Goals

- **NG1.** Replacing or duplicating the **Moon Tauri client updater.** It already works for
  everyone; we mirror its *flow* (background discover → quiet stage → user-pressed apply) but never
  its artifact format, and we never disturb its `releases/latest` "Latest" flag.
- **NG2.** Replacing the **maintainer's private autodeploy.** `scripts/luna-autodeploy` stays as a
  private convenience trigger. It is refactored only to *consume* the shared defer helper; its
  private-network/container/private-host assumptions are not generalized and never appear in the product.
- **NG3.** Turning Luna into a **hosted/managed SaaS** or a multi-tenant control plane. This is
  self-host server self-update only.
- **NG4.** Making the server **self-restart-aware by default.** Background polling and self-triggered
  restarts are strictly opt-in (Phase 3); the default product is an operator-run command.
- **NG5.** Automatic **DB-migration rollback.** Code rollback to the previous commit is in scope;
  schema-downgrade is explicitly out of scope (see Risks §8).

---

## 3. Recommended Design

The design ships **one distribution backbone**, **one trigger/UX layer**, and **one opt-in auto
path**, with every safety-critical step delegated to the unmodified engine.

```
                    ┌─────────────────────────────────────────────────┐
   server-v* tag ──▶│  release-server.yml  →  GitHub Release           │
   (off master)     │  + server-latest.json  (--latest=false)         │
                    └───────────────┬─────────────────────────────────┘
                                    │ HTTPS GET (no auth)
                                    ▼
  operator ── luna update ──▶ resolve latest server-v* tag
                              compare targetSha vs /readyz buildSha   ← no-op if equal
                              luna_active_ws_count()  (shared lib)    ← defer if active
                              detect supervisor (systemd / --user / launchd)
                                    │
                                    ▼
              scripts/luna-update-server  --ref <tag> [--user | --supervisor launchd]
              ─────────────────────────────────────────────────────────────────────
              apply (conditional bun install, re-pin claude exec)
              → stop → settle (6s) → start         ← WAL-safe restart
              → /healthz 200 + /readyz mode:normal ← readiness gate
              → auto-rollback to PREV sha on any failure
              exit 0 healthy / 1 rolled-back / 2 critical
```

### 3.1 Version source — `server-v*` tags + a JSON pointer

- A new `server-v*` annotated tag (e.g. `server-v0.1.0`) is cut from `master`. A new
  `scripts/bump-server.ts` mirrors `scripts/bump-moon.ts` (which bumps a fixed list of version
  files, `bump-moon.ts:37-41`); it bumps a single server version field — wiring real semver into
  `PKG_VERSION` (`packages/control-server/src/router.ts:19`, today the dead literal `"0.0.1"`) — and
  cuts the tag.
- A new `.github/workflows/release-server.yml` triggers on `server-v*` tags and publishes a GitHub
  Release carrying **one lightweight asset**, `server-latest.json`:

  ```json
  { "version": "0.1.0", "tag": "server-v0.1.0", "targetSha": "f73b1a2", "notes": "...", "date": "..." }
  ```

  No binaries are needed — the server ships as source and `bun install` runs on the host. The tag's
  **target commit SHA is the ground truth**; the JSON is convenience.
- **Critical invariant — the Moon updater is never disturbed.** Every server release is published
  `--latest=false`, exactly as `RELEASES.md:41-61` already mandates for non-Moon tags. Discovery
  uses the **GitHub Releases API filtered for `server-v*`** (`api.github.com/repos/.../releases`),
  **never** the `releases/latest` endpoint reserved for Moon. There is no "Latest"-flag race.

### 3.2 How an update is discovered

`luna update` (and, in Phase 3, an opt-in background poll):

1. Reads the running server's identity from `/readyz` — `buildSha` and the new `serverVersion`
   field (§6) — using the WS connection's `hello` frame as a fallback when the HTTP probe is not
   reachable (`protocol.ts:42-46`).
2. Fetches the newest `server-v*` release's `server-latest.json` via the filtered Releases API.
3. **No-op when unchanged:** if the release `targetSha` prefix-matches the running `buildSha`, it
   prints `up to date at <sha> (server-v0.1.0)` and exits `0` — the same idempotent guard
   `luna-autodeploy:86-92` uses (verified: it compares local vs remote SHA and returns early when
   equal).

### 3.3 How an update is delivered & applied

4. **Connect-aware defer** (never drop a user mid-conversation): the command calls a new shared
   helper `luna_active_ws_count(port)` extracted from `luna-autodeploy`'s `active_ws_count`
   (verified at `luna-autodeploy:63-74`: `ss -tnH state established '( sport = :PORT )' | wc -l`).
   If any sessions are active it **defers** (exit `0`, with a message) unless `--allow-active` /
   `--force` is passed — exactly the autodeploy behavior at `luna-autodeploy:94-100`, now reusable.
5. **Supervisor auto-detection** picks the restart backend before invoking the engine:
   - System unit present at `/etc/systemd/system/<svc>.service` → engine as-is.
   - System unit absent but `systemctl --user is-active <svc>` succeeds → pass `--user`.
   - `uname -s == Darwin` and the launchd label `com.user.luna-chat-server` is loaded → pass
     `--supervisor launchd`.
6. The command does **no apply logic itself.** It invokes
   `scripts/luna-update-server --ref <tag> [--repo-dir …] [--luna-home …] [--user | --supervisor launchd] [--dry-run]`.
   The engine performs the entire sequence (verified against the real script):
   - **apply**: `git fetch` → `git reset --hard <ref>`, conditional `bun install --frozen-lockfile`
     only when `bun.lock` changed, re-pin `LUNA_CLAUDE_CODE_EXECUTABLE`.
   - **restart**: `restart_service()` does `daemon-reload → stop → settle → start`, *not* a fast
     `systemctl restart` — the `settle_after_stop()` 6s wait lets DuckDB/SQLite release WAL/SHM
     before reopen (`luna-update-server:429-464`, confirmed).
   - **readiness gate**: `readiness_ok()` requires `is-active` + `NRestarts` not climbing +
     `/healthz == 200` + `/readyz` reporting `"mode":"normal"` (rejects a credential-lapsed
     setup-mode server), with a 404/000 fallback to liveness-only for older rollback targets
     (`luna-update-server:326-365`, confirmed).
   - **auto-rollback**: any forward failure resets to the previous SHA (`--no-fetch`, local),
     reinstalls if the lockfile reverted, restarts, re-probes; exits `1` recovered / `2` critical.
7. The command maps the engine exit code to its own (`0`/`1`/`2`) and prints
   `from <sha> → to <sha>`, the rolled-back SHA on failure, or the critical-intervention message.

### 3.4 Safety primitives — preserved, every one

| Primitive | Where it lives | How this design keeps it |
|---|---|---|
| Stop → settle → start (WAL-safe) | `luna-update-server:429-464` | Engine owns the restart; CLI never touches it. The `--user`/launchd paths reuse the *same* `settle_after_stop()` wall-clock wait around their stop/start. |
| Health + readiness gate | `luna-update-server:326-365` | Pure `curl` probes of `/healthz`+`/readyz`; supervisor-agnostic, unchanged. |
| Auto-rollback (0/1/2) | `luna-update-server:547-606` | Engine owns rollback; CLI surfaces the exit code verbatim with a clear "rolled back, still running" message. |
| Connect-aware defer | `luna-autodeploy:63-100` → `scripts/lib/luna-deploy.sh` | Extracted to one shared `luna_active_ws_count`; CLI, installer branch, and autodeploy all call it. |
| No-op when unchanged + conditional `bun install` + dry-run | `luna-autodeploy:86-92`, `luna-update-server` | SHA-equality pre-check before any restart; `--dry-run` passes through to the engine. |

---

## 4. Operator UX

### Happy path (manual, non-developer)

```bash
luna update
```

```
Checking for updates… current: ae44d29 (server-v0.1.0)
server-v0.2.0 available (ae44d29 → f73b1a2)
1 active session — not restarting mid-conversation. Re-run with --allow-active to update now.
```

When idle (or with `--allow-active`):

```
Updating server-v0.1.0 → server-v0.2.0 …
  stopping… settling 6s… starting…
  waiting for readiness… /healthz OK   /readyz OK (mode=normal)
Updated. Server healthy at f73b1a2.
```

On a failed update:

```
Update failed — rolled back to ae44d29. Server is running healthy.
```

### Read-only / scripting

```bash
luna update --check      # prints "update available: server-v0.2.0" or "up to date"; exits 0
luna update --dry-run    # prints the full engine plan, touches nothing
luna update --ref server-v0.2.0   # pin an exact tag (also the air-gapped / no-API escape hatch)
```

### Second entry point — re-run the installer (idiom operators already know)

The Moon "This Mac" wizard already shows **"Update & restart"** when it detects an existing install.
To match that idiom for non-CLI operators, re-running `scripts/luna-server-install` on an existing
clone routes through the **same** `luna update` path: detect `.git` present → compare SHA → call the
shared defer helper → invoke the engine. *Update = re-run the install command.* (Verified the
installer already distinguishes fresh-vs-existing via the env-token check and is idempotent.)

### Opt-in hands-off updates (Phase 3)

```bash
luna update install-timer --interval 6h   # writes a systemd timer (Linux) or launchd StartInterval (macOS)
luna update uninstall-timer
```

The timer runs `luna update`, which is a no-op until a new `server-v*` tag exists — so restarts
happen only on real movement, and only when no session is active. **Never auto-enabled.**

### macOS local server (Moon "This Mac")

Same `luna update` command and output; the supervisor is auto-detected as launchd and the engine's
launchd path issues a load/unload around the *same* settle window (it does **not** use the bare
`launchctl kickstart` from `control.restart` at `router.ts:41-50`, which has no settle and no
rollback). The Moon wizard's "Update & restart" button calls `luna update --allow-active`.

---

## 5. Coexistence

### With the Moon Tauri client updater

- **Orthogonal channels.** Moon tracks `moon-v*` via `releases/latest`; the server tracks `server-v*`
  via the filtered Releases API. They never collide because every server release is `--latest=false`
  (`RELEASES.md:41-61`), preserving the exact invariant the Tauri updater depends on.
- **Mirrored flow, not mirrored format.** We copy Moon's *discover-in-background → stage quietly →
  user-pressed apply* model and its phase vocabulary, but trust comes from **git-ref provenance**
  (signed/known tag SHA), not a minisign binary. We do not reuse the minisign pubkey machinery.
- **One panel, two sections (Phase 3).** Moon's `settings-updates.js` already projects a phase
  string. A "Server" section reuses that exact component shape, fed by an additive,
  capability-gated `server-update-available` WS frame — old clients simply ignore it.

### With the maintainer's private autodeploy

- `scripts/luna-autodeploy` is **unchanged in behavior** and stays private (private-network polling,
  container map, private paths). It is refactored only to call the new shared
  `luna_active_ws_count` — so there is exactly one defer implementation, not two.
- The product trigger (`luna update` + optional timer) is the **general** equivalent; it carries
  none of the polling-because-unreachable rationale, none of the private hostnames, paths, or
  container plumbing. The public design contains **zero personal infrastructure**.

---

## 6. Release / Versioning Changes

1. **Server version identity.** Add `serverVersion` (semver string) to the `/readyz` JSON body
   (additive, exactly like the existing optional `buildSha` field at
   `packages/ui-ws/src/server.ts:980-988`) and to the `hello` frame
   (`packages/ui-ws/src/protocol.ts:42-46`). Source it from a new `LUNA_BUILD_VERSION` env (set by
   release/install) → `git describe --tags --match 'server-v*'` → fallback, paralleling the existing
   `resolveBuildSha()` chain. Wire the same value into `PKG_VERSION`
   (`packages/control-server/src/router.ts:19`) so `control.status` finally returns a real version.
2. **Bump tool.** `scripts/bump-server.ts` mirrors `bump-moon.ts`: bump the version field, commit,
   cut a `server-v*` tag, optional `--push`. Add a `bump-server --check` CI gate mirroring the Moon
   check.
3. **Release pipeline.** `.github/workflows/release-server.yml` triggers on `server-v*`, creates a
   GitHub Release with a single `server-latest.json` asset, and enforces `--latest=false` (plus a
   re-anchor guard so a server release can never steal Moon's "Latest" flag — the same guard
   `release-moon.yml` already runs).
4. **Comparison contract.** "Update available" = release `targetSha` does not prefix-match the
   running `/readyz` `buildSha`. When a server was `git reset` to a custom SHA with no `server-v*`
   tag checked out, fall back to SHA comparison (never a false "up to date").
5. **Docs.** Add a "Server releases (`server-v*`)" section to `RELEASES.md` mirroring the Moon
   section; add an upgrade section to `docs/install.md`; scrub personal-infra defaults from
   `install.sh` (replace any maintainer-host default URL with a prompt/placeholder).

---

## 7. Phased Rollout (vertical slices, each independently shippable)

Every slice reuses the engine; the engine is modified only additively (new flags) and never in its
core apply/restart/rollback logic.

**Phase 1 — MVP: a working `luna update`.**

- *Slice 1 — Release channel.* `bump-server.ts` + `release-server.yml` publishing
  `server-latest.json` `--latest=false`; cut `server-v0.1.0`. *Ship gate:*
  `curl …/server-v0.1.0/server-latest.json` returns valid JSON; Moon's `releases/latest` still
  points at the newest `moon-v*`.
- *Slice 2 — Server version surface.* Add `serverVersion` to `/readyz` + `hello`; wire `PKG_VERSION`.
  *Ship gate:* `/readyz` returns `serverVersion` next to `buildSha`.
- *Slice 3 — Shared defer.* Extract `luna_active_ws_count` into `scripts/lib/luna-deploy.sh`;
  refactor `luna-autodeploy` to call it (behavior unchanged); unit-test it. *Ship gate:* autodeploy
  defers identically; helper callable standalone.
- *Slice 4 — `luna update` command.* New citty subcommand in `apps/agent-cli/src/commands/update.ts`,
  registered in `luna.ts`. Resolve latest `server-v*` → SHA no-op → defer → invoke engine. Flags:
  `--check`, `--allow-active`, `--force`, `--dry-run`, `--ref`. *Ship gate:* on a behind
  systemd-system box, `luna update` applies + health-gates + reports; on a current box it no-ops.
  **(End of Phase 1 = full MVP for the most common shape, zero installer change reaches everyone via
  the existing `luna` wrapper at `install.sh:244-249`.)**

**Phase 2 — Generality (works for *every* self-hoster).**

- *Slice 5 — `--user` engine support.* Remove the hard refusal at `luna-update-server:243-262`; add
  `--user` to scope all `systemctl` calls to `--user` and look under `~/.config/systemd/user`.
  Auto-detect in `luna update`. *Ship gate:* a rootless `--user` install updates with rollback intact
  (hermetic test with `LUNA_RESTART_SETTLE_SECS=0`).
- *Slice 6 — launchd engine support.* Add `--supervisor launchd`: load/unload around the *same*
  settle, `launchctl list` in the readiness gate, shared `/healthz`+`/readyz` probes. Auto-detect on
  Darwin. *Ship gate:* a macOS local server updates with settle + rollback (real-macOS verification).
- *Slice 7 — Installer upgrade branch.* Make re-running `scripts/luna-server-install` on an existing
  clone route to the `luna update` path. *Ship gate:* re-running on a current box exits `0`; on a
  behind box it updates.

**Phase 3 — Opt-in richer UX (never default-on).**

- *Slice 8 — Operator-installed timer.* `luna update install-timer` / `uninstall-timer` (systemd
  timer or launchd `StartInterval`). *Ship gate:* timer runs `luna update`, restarts only on real
  movement, defers on active sessions.
- *Slice 9 — Moon "Server" notification.* Additive, capability-gated `server-update-available` WS
  frame (gated like `skills`/`mcpApps` in the `hello` capabilities) emitted after an opt-in
  background check; a "Server" section in `settings-updates.js` projecting the phase, with
  **replay-on-open** (last phase held in memory) and a **single-flight gate** (reject a second
  trigger in flight — mirrors Moon's `UpdateManager`). **Screenshot proof required per CLAUDE.md.**
  *Ship gate:* a freshly opened panel syncs the current phase; gear badge lights on availability.

---

## 8. Risks & Open Questions

- **`--user` vs system unit scope (resolved direction, real test surface).** Lifting the engine's
  refusal is the single biggest generality unlock, but it adds a new execution branch. *Mitigation:*
  hermetic tests with `LUNA_RESTART_SETTLE_SECS=0` and a mocked supervisor; auto-detect rather than
  ask. *Open:* default service-name derivation for `--user` installs that didn't follow the standard
  installer.
- **macOS launchd settle equivalence.** `launchctl` load/unload semantics differ from
  `systemctl stop/start`; `bootout` can fail when the service isn't loaded. *Mitigation:* tolerate
  not-loaded, keep the explicit settle, real-macOS integration test before Slice 6 ships. *Open:* CI
  can't fully cover launchd without a macOS runner — gate on manual real-Tauri/launchd verification.
- **Signing / verification of the server artifact.** The product distributes a **git ref**, not a
  binary, so trust is git-ref provenance (known tag SHA), not minisign. *Open:* do we sign the
  `server-v*` tags and verify the tag signature as a preflight? Recommended as a lightweight
  enhancement — verify the resolved tag's commit signature/SHA against the release JSON before
  restart — explicitly **not** a second (binary) distribution format.
- **Hosts without a build toolchain.** The "download" is a `git fetch` + conditional
  `bun install`, which can take 30s+ after a lockfile bump and needs Bun present (the installer
  already installs it). *Mitigation:* communicate "Updating… (up to a minute)" rather than a
  byte-progress bar; conditional install skips when `bun.lock` is unchanged. *Open:* a future
  `bun build --compile` single-file artifact as an optimization (the pipeline supports it without
  redesign).
- **GitHub Releases API rate limit (Phase 3 polling).** 60 unauthenticated req/hr/IP. A ~6h poll is
  far under, but many servers behind one NAT could add up. *Mitigation:* conditional GET with
  ETag/`If-None-Match` and ±30m jitter. Phase-1 manual `luna update` is unaffected.
- **`/readyz` reachability for the comparison.** WS-only reverse proxies might not forward the HTTP
  health path. *Mitigation:* `buildSha`/`serverVersion` also ride the `hello` frame on the existing
  WS connection — fall back to that.
- **DB-migration rollback (explicit NG5).** Code rollback to the previous commit is automatic;
  schema downgrade is **not** in scope. A forward migration that can't be reverted by simply running
  old code is a real hazard. *Open:* document a forward-only migration policy, or add an
  operator-acknowledged "this update includes a non-reversible migration" gate. Until then, the
  readiness gate + rollback protect against *boot* failure, not *data-shape* incompatibility.
- **Multi-tenant vs single-user (NG3).** Scope is a single self-hosted server. A future multi-server
  fleet trigger is out of scope and intentionally left to the maintainer's private path.
- **Release discipline.** `luna update` only sees what's tagged. If a fix lands on `master` without a
  `server-v*` tag, operators correctly see "up to date." *Open:* whether/how often to auto-cut a
  `server-v*` tag from CI on `master` movement, vs. keeping releases deliberate.

---

## 9. Success Criteria

1. **One command, everyone.** A non-developer self-hoster on a bare Linux host runs `luna update`
   and gets a health-gated, auto-rolling-back update with a clear outcome — **without** any
   knowledge of systemd, git, Bun, GitHub, or any maintainer-specific setup. (No installer change is
   required to reach existing installs: the `luna` wrapper is already present, `install.sh:244-249`.)
2. **All shapes covered.** The same command works unchanged on: bare-host systemd **system** unit,
   rootless **`--user`** unit, and macOS **launchd** local server — supervisor auto-detected, not
   configured.
3. **Every safety primitive intact.** Stop→settle→start, `/healthz`+`/readyz` readiness gate,
   auto-rollback (`0`/`1`/`2`), and connect-aware defer are all delegated to the unmodified engine;
   a deliberately bad `server-v*` tag leaves an unattended server **running on the previous version,
   healthy**, never broken.
4. **Never drops a user mid-conversation.** With an active session, `luna update` defers by default
   and clearly says so; `--allow-active` is the only override.
5. **Moon updater untouched.** Across multiple `server-v*` releases, the Moon Tauri client continues
   to auto-update; `releases/latest` always resolves to the newest `moon-v*`.
6. **Version is observable.** `/readyz` and the `hello` frame report a real `serverVersion`; an
   operator (or a monitoring script) can read which release is live and whether an update is
   available, with no auth.
7. **Opt-in only.** A fresh install performs **no** background polling and **no** self-restart until
   the operator installs the timer or enables the Moon "Server" notification.
8. **No personal infrastructure anywhere.** The shipped code, docs, and release artifacts contain no
   private hostnames, network assumptions, container names, or fixed `/root` paths — every path is
   env/flag-overridable, every topology auto-detected.