# Luna — Install & Update Lifecycle Plan

> Status: PLAN (no code yet). Produced 2026-06-02 via grounded multi-agent audit of the
> actual install scripts across the `luna` + `luna-moon` repos. Goal: super-simple INSTALL
> and a maintainable UPDATE mechanism for BOTH halves — the **client** (Luna Moon Tauri app)
> and the **backend server/container** — across two models:
> - **Model A:** local all-in-one on a Mac (one download → it works).
> - **Model B (Mr. Cobb's actual workflow):** server on a separate Linux box + Mac client over Tailscale.

## Current state (honest)
Install today = a 4-option interactive `install-mac.command` + two Linux scripts (`luna-server-install`,
`luna-container-create`). "Update" = entirely manual: `git pull` + `bun install` + restart on the box,
and re-typing tokens in Moon's Settings (we did exactly this by hand all session). Model A needs a
Rust/cargo + cargo-tauri toolchain and launches via `cargo tauri dev` (multi-minute compile, transient
dev process, not an installed app). Model B has **no clean wiring** — `main.rs:152` hardcodes
`ws://127.0.0.1:4753/ui`, so the remote URL+token must be typed by hand. Zero version-skew safety, zero
CI, zero release tags. The hardened secure-token-store Moon (`save_connection`/`load_connection`) exists
**only on `feat/moon-harden`** (dev=0, master=0), while a fresh `install.sh` clones the **master** default —
so a brand-new install today gets unhardened, behind code.

## Gaps (deduped, tagged)
- **[both/install] Branch divergence** — hardened Moon only on `feat/moon-harden`; dev & master both lack it; `install.sh` clones master default. Precondition for everything.
- **[B/install] No Model-B auto-wire** — luna-config seed hardcodes localhost (main.rs:152); remote URL can never reach Moon automatically.
- **[A/install] Rust/cargo wall** — option 4 `die()`s if missing (install-mac.command:263-266); `cargo tauri dev` compiles on first run; no installed app.
- **[B/install] Server install** — doesn't generate a token, apt-only, root-only, writes a SYSTEM unit (re-running on jax master's hand-edited `--user` unit risks a competing :4753 listener).
- **[both] Token rotation = permanent SILENT hang** — stale token → bare 401 + socket.destroy (server.ts:374) the browser WS can't read → infinite silent backoff (index.html:1045); stored stale token then BLOCKS recovery via the `!State.wsToken` guard (index.html:1647). Only manual re-entry recovers.
- **[B/update] No repeatable server update** — manual pull+install+restart, no rollback; `/healthz` (server.ts:308) is bare liveness (green even in setup-mode / on idle-OAuth 401) so it can't gate rollback.
- **[A/update] No client self-update** — version frozen at 0.0.1, no tauri-plugin-updater, no release feed, no tags, **no CI in either repo**.
- **[both/update] Version skew fails SILENTLY** — wire carries `UI_WS_PROTOCOL_VERSION=2` (protocol.ts:23) in hello (server.ts:415) but client throws it away (index.html:1089 no-op); unknown frames logged server-side only, nothing sent back (server.ts:684-687). A same-version frame-name typo (this session's `subscribe-thread`) hangs 40 min. A version-equality check alone would NOT catch it.
- **[both] No `luna doctor`** — nothing distinguishes down-server vs unreachable-Tailscale vs bad-token vs lapsed-Claude-login. A bun client CAN read the 401 the browser can't.
- **[both] Idle Claude OAuth lapse** — subscription token auto-refreshes only ON USE; idle server eventually 401s. Keep-warm = follow-on.

## Recommendation — TIERED

### Tier 0 — GATE: branch convergence (~0.5–1 day) [both]
Precondition; nothing works until a fresh install ships the hardened Moon.
- Merge `feat/moon-harden` → dev (brings save_connection/load_connection + luna-config precedence guard). Verify dev `save_connection` count 0→3.
- Decide + execute dev → master promotion (a REAL merge, not ff: dev 31 ahead, master 4 ahead on its own line). Gate on ManagedRuntime real-layer boot smokes.
- Pin fresh-install clone: `install.sh --branch <release line>` OR cut tag `v0.1.0` (no tags exist today).
- Verify `load_connection` populates State.wsToken BEFORE the luna-config listener fires (race check).

### Tier 1 — Model-B install + update story (~2–3 days after Tier 0, pure bash/JS, ZERO Rust recompile) [B + both-model update plumbing]
Biggest bang for Mr. Cobb's actual workflow. The "zero Rust/signing" scope is what keeps it a one-week job.
- **`luna pair`** (bash): reuse option-2's URL+token prompts → write `~/.luna/moon-connection.json` `{"wsUrl","wsToken"}` (camelCase must match main.rs:47-50 / index.html:1350) chmod 600. load() reads file FIRST → Moon connects remote, localhost seed auto-skipped. Re-pair on rotation = re-run + relaunch.
- Wire install-mac.command option 2 to also call `luna pair`; server installer auto-generates a token when none passed.
- **`luna doctor`** (Mac-side bun preflight — biggest debugging win): L1 `curl /healthz` (down/unreachable), L2 bun WS upgrade reads status — 401=bad/rotated token→re-pair, 101=good (the discriminator the browser can't read), L3 Claude-OAuth/setup-mode.
- **`scripts/luna-update-server`** (wrapper over lib/luna-deploy.sh): PREV=HEAD → fetch+checkout ref → `bun install` only if lockfile hash changed → re-pin LUNA_CLAUDE_CODE_EXECUTABLE → restart unit → readiness probe → on failure `git reset --hard $PREV`+reinstall+restart. Handles BOTH bare-host AND incus; respects which unit owns :4753.
- Deepen readiness gate: extend `/healthz` to report mode=normal|setup + credential-OK; gate rollback on THAT (not bare liveness).
- Readable-failure UI in Moon: after N fast-fail closes with zero open, STOP infinite backoff, show "Can't connect — run luna doctor or re-pair".
- **Version-skew defenses (ship here):** (a) client reads frame.protocolVersion at hello (replace index.html:1089 no-op) → loud banner + stop reconnect on mismatch; (b) server sends an unknown-frame reply (not just logs); (c) snapshot test in packages/ui-ws that FAILS if frame `type` literals change without bumping UI_WS_PROTOCOL_VERSION. Test case = the `subscribe-thread` typo (only b+c catch a same-version typo).

### Tier 2 — Model-A prebuilt UNSIGNED .app + self-update (~3–5 days, $0) [A; de-hardcode benefits both]
- `cargo tauri build` already emits .app + .dmg (bundle.active=true). Build once on a Mac, ship the .dmg; user drags to /Applications, right-click→Open once (Gatekeeper, unsigned). Build is on the dev's machine, not the user's.
- De-hardcode main.rs:152 → read `MOON_WS_URL=` from ~/.luna/.env (default localhost). ONE seed path = local (no line) + remote (installer writes line). Collapses "two models" → "one model, two profiles".
- Rework option 4 to server-bootstrap-only (drop `cargo tauri dev`), add the port guard option 1 has, sequence claude-login BEFORE launching the widget.
- Versioning baseline: tag releases, sync tauri.conf.json + Cargo.toml off 0.0.1.
- Wire **tauri-plugin-updater**: dep + capability + bundle.createUpdaterArtifacts + pubkey + GitHub Releases latest.json endpoint. **Generate a minisign keypair (`tauri signer generate`) — REQUIRED even unsigned**, SEPARATE from Apple notarization. Losing the minisign PRIVATE key bricks auto-update for ALL clients forever → custody is a hard requirement.

### Tier 3 — Signed + notarized .dmg + CI (~3–6 days + $99/yr ongoing) [both]
- Apple Developer Program ($99/yr), Developer ID Application cert, bundle.macOS signing block + hardenedRuntime/entitlements.
- Sign the WIDGET-ONLY .app (server/node_modules never enter the bundle), notarize via `xcrun notarytool` + staple.
- Stand up the only CI either repo needs: GitHub Action on tag-push (macos-14 arm64) → import cert → tauri build → notarize+staple → sign update artifact with minisign → latest.json → publish Release.
- Optional: universal2 (Intel) target; keep-warm heartbeat for idle-OAuth-401.

## Update lifecycle (the mechanism, summarized)
- **Client:** tauri-plugin-updater (Tier 2) checks a GitHub Releases `latest.json` (version + URL + minisign sig); non-blocking "Update ready — relaunch". Minisign key required even on the unsigned build; key loss = permanent brick. Until then: re-download the .dmg / re-run installer.
- **Server:** `luna-update-server` — pull ref → install-if-lockfile-changed → re-pin claude exe → restart → readiness probe → roll back on failed boot. Both incus + bare-host shapes.
- **Version skew (load-bearing):** wire already has UI_WS_PROTOCOL_VERSION=2. Three defenses together (client hello check + server unknown-frame reply + a literal-set snapshot test that forces a version bump). A version-equality check ALONE is blind to a same-version frame-name typo (the bug we hit). Rule: additive frames gated by `capabilities{}` don't need a bump; renames/removals/re-semantics DO.

## Big decisions for Mr. Cobb
1. **Apple Developer Program ($99/yr)?** Only needed for Tier 3 (no-warning .dmg). Few trusted Macs → Tier 2 unsigned + Open-Anyway is enough and free. Auto-update (minisign) is free + separate.
2. **Promote dev → master** (real merge, not ff) vs keep shipping off dev + pin `install.sh --branch dev`/tag? Either way master must stop being the fresh-install source until it carries the hardened Moon.
3. **Remote pairing UX:** connection-string / direct file write NOW (Tier 1, bash) vs `luna://` deep-link or QR later (needs Rust URL handler + prebuilt app). Recommend file-write now. No Tailscale auto-discovery (over-engineering).
4. **GitHub Releases as the update channel** for both client (latest.json+minisign) and server (the ref to check out)? Path of least resistance (gh already used).
5. **Who builds releases:** local on Mr. Cobb's Mac (Tier 2, $0, human-in-loop) vs GitHub Actions CI (Tier 3, greenfield). Local for Tier 2, CI for Tier 3.
6. **Minisign key custody** (1Password / repo secret / offline) — decide BEFORE the first auto-updating build; loss bricks all clients.

## Open questions
- Does `load_connection` populate State.wsToken before the luna-config listener fires on the converged branch? (race; verify empirically post-Tier-0)
- Tier 1 assumes the Mac can already launch Moon (Rust present — true for Mr. Cobb, false for fresh users). Acceptable as "works for Mr. Cobb this week", Tier 2 = "works for anyone"?
- Server installer auto-generate a token when none passed, or keep explicit `--token` as a safety choice?
- Idle Claude-OAuth-401: keep-warm heartbeat vs surface-via-doctor + manual re-`claude setup-token`?
- ~~Transport: server binds 0.0.0.0 + plaintext ws:// + token auth (safe behind Tailscale, exposed off-tailnet). Add bind-to-tailnet/firewall, or rely on Tailscale + a doctor warning?~~ **RESOLVED (BLOCKER #25):** Tailscale is now a STATED requirement, not an assumption. The deploy scripts auto-resolve the bind to the host's **Tailscale IP** when a tailnet is present (so the primary remote deployment Just Works without exposing a public interface), else fall back to loopback with a warning; a public `0.0.0.0` bind requires a conscious `--i-understand-public` opt-in (loud transport-confidentiality warning). `luna doctor` additionally WARNs when the server host is neither loopback, `*.ts.net`, nor a Tailscale CGNAT (100.64.0.0/10) address.
- universal2 (Intel) build target needed, or arm64-only OK?
