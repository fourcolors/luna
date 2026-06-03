# How to Test & Verify — Tier-1 install/update toolkit (2026-06-03)

Everything below is grounded in commands actually run during the build, with their real
expected output. Caveats are called out honestly.

Shipped & live on `master` (`82600a3`), deployed to the jax server (`2aac5d2` running):
- `luna doctor` — connection preflight (down / bad-token / setup-mode / OAuth-lapse)
- `luna pair` — one-command remote connect + token-rotation recovery
- `luna-update-server` — server update with auto-rollback
- version-skew defenses (client protocol check + frame-set snapshot test + server unknown-frame log)
- Moon hardening (#9 connection robustness, #10 secure mode-600 token store, resume-thread fix)

Server WS tokens are NOT stored here — read them from each server's `~/.luna/.env`
(`grep ^UI_WS_TOKEN= ~/.luna/.env` on the box), or just use `luna pair` which wires
them for you. master = port 4753, dev = port 5753 on jax. (Never commit a real token;
the WS bearer token is the only auth layer.)

---

## 1. `luna doctor` — the fastest "is it working?" check

From the luna repo (`apps/agent-cli`):
```
bun run src/luna.ts doctor --url ws://jax-box:4753/ui --token <master-token>
```
Expected (healthy server):
```
luna doctor — profile=stable url=ws://jax-box:4753/ui
[ OK ] L1 REACH  server reachable (/healthz 200)
[ OK ] L2 TOKEN  token accepted (WS upgrade 101)
[ OK ] L3 MODE   chat ready (protocol v2)
[ OK ] L4 CHAT   active chat probe succeeded (assistant responded)
[ OK ] PASS — connection healthy; `luna chat` should work        (exit 0)
```
Failure modes it distinguishes (each tested live):
- **Bad/rotated token** → `[FAIL] L2 TOKEN  token REJECTED — rotated/invalid; re-pair`  (exit 1)
- **Server down / unreachable** → `[FAIL] L1 REACH  server DOWN or host unreachable — is Tailscale up?`  (exit 1, fast)
- **Claude login lapsed** → `[FAIL] L4 CHAT  server can't reach Claude — run claude setup-token on the server`
- **Slow first turn (cold start)** → `[WARN] L4 CHAT  no response within 60s — re-run`  (exit 0, soft — not a hard fail)

CAVEATS: L4 sends a tiny throwaway chat turn → **spends a sliver of Claude quota** and creates a
throwaway thread (does not touch your real conversation). L3 reads boot-time capabilities; only L4
catches a credential that lapsed *after* boot.

## 2. `luna pair` — point CLI + Moon at a server in one command
```
bun run src/luna.ts pair --url ws://jax-box:4753/ui --token <master-token>
# bare `luna pair` → prompts for url + token
```
Writes BOTH `~/.luna/.env` (LUNA_STABLE_WS_URL/_UI_WS_TOKEN, mode 600) and
`~/.luna/moon-connection.json` ({wsToken,wsUrl}, mode 600), then auto-runs doctor.
Expected: the 4 doctor lines + `✓ paired. luna chat and the Luna Moon widget will use this server.`
- Wrong token → writes files anyway + `✗ paired, but the server REJECTED this token … re-run luna pair` (exit 1)
- Bad url (e.g. https://) → `invalid --url …` (exit 2, **nothing written**)
This is also the **token-rotation fix**: when the server token rotates, re-run `luna pair` and both
the CLI and the Moon widget re-point. (Verify: re-pair with a new token, then `luna doctor` → green.)

## 3. Moon widget — end-to-end
```
cd apps/ui-moon-tauri && bun run tauri dev
```
- Crescent appears top-left; click → chat panel. After a `luna pair`, it auto-connects (mode-600 file).
- **Version-skew**: if the client/server protocol versions differ, you get an amber status dot + a
  persistent "Version mismatch …" banner BUT chat still works (it warns, never refuses).
- **Resume**: relaunching resumes your last conversation (the `subscribe` frame fix); the **+** button
  starts a fresh conversation. A killed/slow turn shows a visible error, not an endless spinner (#9).
CAVEAT: no hot reload — after editing index.html, Cmd+R the window; after a Rust change, relaunch `tauri dev`.

## 4. `luna-update-server` — server update + rollback (logic verified; not the live path yet)
```
# preview only, mutates nothing:
bash scripts/luna-update-server --dry-run --repo-dir <server-repo> --ref origin/master
```
CAVEAT: the live jax master runs a hand-edited `systemctl --user` unit, which `luna-update-server` v1
**deliberately refuses** (it targets a standard system unit). So master is currently updated manually
(see §6). The script's logic — pull → install-if-lockfile-changed → re-pin claude → restart →
readiness probe (is-active + NRestarts-not-climbing + /healthz 200) → rollback-to-PREV on failure →
CRITICAL/exit 2 if rollback also fails — is covered by **16 hermetic tests**:
```
bun run test test/update-server.test.ts        # 16 pass (incl. rollback, crash-loop, network-free-rollback)
```

## 5. Automated test suites (the green baseline)
```
# Tier-1 CLI + server, all green:
bun run test test/update-server.test.ts test/deploy-scripts.test.ts \
  apps/agent-cli/test/doctor.test.ts apps/agent-cli/test/pair.test.ts packages/ui-ws/
# → ~168 pass. ui-ws includes frame-set.protocol.test.ts (the version-skew snapshot test).

# Boot smokes (the deploy-risk gate — chat-server has no tsc gate; these prove the real layer graph builds):
LUNA_UI_WS_TOKEN=smoke-test-token-ok bun run apps/ui-web/scripts/smoke/setup-mode-boot.smoke.ts
# also: belief-injection-boot, dream-cron-boot, survey-boot  → each prints "PASS" / "OK"
```
Version-skew snapshot test — prove it catches a frame rename (the bug that started this):
temporarily rename a frame `type` literal in `packages/ui-ws/src/protocol.ts` (e.g. `"subscribe"` →
`"subscribe-thread"`) WITHOUT bumping `UI_WS_PROTOCOL_VERSION`, then
`bun run test packages/ui-ws/test/frame-set.protocol.test.ts` → it goes RED. Revert with
`git checkout packages/ui-ws/src/protocol.ts`.

## 6. Verifying a live master deploy (the dogfood pattern)
Master is updated manually for now (the `--user` unit, see §4). After any deploy:
1. `ssh root@jax-box` then `XDG_RUNTIME_DIR=/run/user/0 systemctl --user is-active luna-chat-server.service` → `active`, NRestarts not climbing.
2. **Authoritative check — drive a real turn, don't trust /healthz**: `luna doctor --url ws://jax-box:4753/ui --token <master-token>` → all 4 green, run it 2–3× (cold start can WARN on the first).
   This is what verified the dev→master promotion deploy — `/healthz` was 200 even though
   `bun install --frozen-lockfile` warned; only doctor's L4 real chat turn proved the server actually works.

## Known follow-ups (not blocking, tracked)
- **bun.lock** — ✅ RESOLVED (commit `59d8018`): the missing transitive deps were added by a clean
  non-frozen `bun install` (with a fresh writable cache dir to dodge the Mac sandbox cache-perm
  failure), so `bun install --frozen-lockfile` now exits 0 on a clean machine. CI enforces this as a
  hard gate (`.github/workflows/ci.yml`).
- **master `--user` → system unit**: normalize it so `luna-update-server` (with rollback) drives
  future master deploys instead of the manual path.
- **Design-spec branches** `feat/setup-mode-1b` + `feat/portable-server-installer` still hold unmerged
  CODE (their implementations are superseded by what shipped on master). Their DESIGN docs were
  cherry-picked onto master under `docs/superpowers/` (each carries a `Status:` note) — the branches
  remain only as a keep-or-prune decision for the code, not the specs.
