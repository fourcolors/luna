# Deploy layout migration: in-place checkout → releases layout (stable)

Operator-driven live cutover of the `stable` profile from the mutated-in-place
checkout (`/root/luna/stable/repo`, updated by `git fetch` + `git reset --hard`)
to the phase-4 releases layout:

```
/root/luna/stable/
  repo/                    frozen former checkout — never fetched or reset again;
                           kept intact as the rollback-to-inplace body
  mirror.git/              bare repo (~91M) — the ONLY thing any fetch touches
  releases/<full-sha>/     immutable checkouts: built once, .complete marker,
                           never mutated after publish, pruned by retention
  current  -> releases/<sha>   RELATIVE symlink, flipped atomically INSIDE the
                           guarded restart window (stop → flip → start)
  previous -> releases/<sha'>  RELATIVE; the rollback target (outgoing current
                           at every flip, forward AND rollback)
```

After the cutover, `git reset --hard` no longer exists on any automated path
for this profile. Deploy = fetch mirror → materialize release → build → verify
→ flip → restart. Rollback = flip back to `previous`. **This workflow was not
performed by the branch that shipped it — every step below is for the operator
to run at a chosen moment.**

---

## 1. Verified facts (measured on jax-box, 2026-07-30)

* **Incus devices (verified via `incus config device show luna-stable`):**
  * `luna-repo`: `source=/root/luna/stable/repo`, `path=/root/luna`,
    `shift=true` (dev uses the identical pattern with `/root/luna/dev/repo`).
  * `luna-home`: a **separate** disk device, `source=/root/.luna`,
    `path=/root/.luna`, `shift=true`. Consequence: `.env` / claude-pin edits
    are completely unaffected by any change to the repo device.
  * Proxy devices `ws4753` / `control4754` are port proxies — untouched by this
    migration.
* **Bind-mount semantics:** an established disk device pins the *source inode*
  at container start. Replacing the host-side source (or re-pointing a
  host-side symlink that IS the source) is invisible to a running container.
  Symlinks *inside* the mounted tree propagate instantly to both sides. This is
  why the `current` flip lives **inside** the mounted tree and why the bind
  source moves **up one level** (repo → profile dir) exactly once, at the one
  cutover restart.
* **Live unit paths (verified via `incus exec luna-stable -- systemctl cat
  luna-chat-server.service`):** `WorkingDirectory=/root/luna/apps/ui-web`,
  `ExecStart=/root/.bun/bin/bun run scripts/chat-server.ts` — the ExecStart
  script path is WorkingDirectory-relative, so only `WorkingDirectory` (and the
  alert unit's absolute `ExecStart=/root/luna/scripts/luna-pager`) change.
* **Hand-managed drop-ins the installer does NOT own** (verified present):
  `/etc/systemd/system/luna-chat-server.service.d/dream-samples.conf` and
  `.../memory.conf`. They are separate files and survive a unit re-render;
  verify both after step 5 anyway.
* **buildSha resolution order (chat-server):** `LUNA_BUILD_SHA` env would
  OVERRIDE the git fallback. Nothing writes it today — preflight (step 2)
  asserts the container `.env` does not set it, or the server would report a
  pinned stale sha forever and the guardian would classify every deploy
  NEGATIVE.
* **Disk (measured):** filesystem 1.8T, **1.5T free**; `repo/node_modules`
  3.6G; `repo/.git` 91M; ~4.0G of stray `repo/worktrees/` to reclaim. A
  release costs ~3.7G (node_modules dominates; the release `.git` is nearly
  free via `clone --local` hardlinks against the mirror). Default retention
  keep=3 ≈ 11.2G, under 1% of free space.

## 2. Preflight checks

**LOAD-BEARING PRECONDITION — phase 4 must be LIVE before the cutover.** Two
distinct artifacts must already contain the phase-4 code, and neither is this
working tree:

1. **The deployed checkout.** Merge phase 4 to the deployed branch and run one
   final ordinary INPLACE deploy, so the stable `DEPLOYED_SHA` itself contains
   the releases-aware scripts. Step 3c materializes the first release *at that
   sha* — if phase 4 is unmerged, the release contains pre-phase-4 scripts,
   step 5's installer has no `--layout` flag, and every in-release invocation
   below fails or (worse) half-works.
2. **The pinned guardian engine.** The guardian timer executes its PINNED
   engine copy under `/usr/local/lib/luna-guardian/engine@<sha>`, **not** the
   checkout. A pre-phase-4 pin (verified live 2026-07-30: the pin was
   `engine@512cd89e…`, whose bundled `lib/luna-registry.sh` has zero
   `deploy.layout` awareness) would read the flipped registry as inplace with
   `P_REPO=/root/luna/stable/repo` and, on the next origin advance, resume
   `git reset --hard` deploys against the "frozen" repo — `bun install` then
   fails in-container and the rollback restarts the LIVE server once per
   ~1min tick until a human notices. The final inplace deploy in (1) refreshes
   the pin (the guardian's engine refresh follows the checkout); assert it:

```bash
# The deployed checkout contains phase 4:
git -C /root/luna/stable/repo grep -q 'deploy\.layout' -- scripts/lib/luna-registry.sh \
  && echo checkout-ok || echo "STOP: phase 4 not in the deployed checkout"

# The PINNED guardian engine contains phase 4 (do not proceed on STOP):
ENGINE_PIN="$(readlink -f /usr/local/lib/luna-guardian/current-stable)"
echo "$ENGINE_PIN"    # engine@<sha> — <sha> must be a phase-4-containing sha
grep -q 'P_LAYOUT' "$ENGINE_PIN/lib/luna-registry.sh" \
  && echo engine-pin-ok || echo "STOP: pinned guardian engine is pre-phase-4 — run one inplace deploy (or the guardian engine refresh) first"
```

```bash
# ≥ 20G free on the deploy filesystem
df -h /root/luna

# NO pending transaction journal for stable (cross-layout journal replay is
# the one non-idempotent hazard — a journal written by the inplace engine must
# never be recovered by the releases engine, or vice versa):
ls -l /root/.luna/update/transaction-stable 2>/dev/null   # must NOT exist

# Guardian converged and quiet:
systemctl start luna-guardian-stable.service && journalctl -u luna-guardian-stable.service -n 5

# Pause automation for the window with DISABLE, not stop: the timer is
# enabled + Persistent=true (verified live), so a plain `systemctl stop`
# would not survive a host reboot mid-migration — the (possibly still
# pre-phase-4-pinned) guardian would silently revive against the
# half-migrated topology inside what you believe is a paused window.
systemctl disable --now luna-guardian-stable.timer   # and any luna-autodeploy-stable.timer
# Belt-and-braces (survives anything): also set deploy.autoUpdate = false for
# stable in /etc/luna/servers.toml for the duration of the window.

# Back up the registry:
cp -a /etc/luna/servers.toml /etc/luna/servers.toml.pre-releases

# No human work in flight under the deploy checkout (doctrine: there should be
# none, ever — see §10):
git -C /root/luna/stable/repo status --short         # expect clean/untracked only
ls /root/luna/stable/repo/worktrees 2>/dev/null      # note contents for reclaim

# Origin reachable from the host:
git -C /root/luna/stable/repo ls-remote origin HEAD

# The container .env must NOT set LUNA_BUILD_SHA (it would override the git
# fallback and pin buildSha forever):
grep -n '^LUNA_BUILD_SHA=' /root/.luna/.env && echo "REMOVE THIS FIRST" || echo OK
```

## 3. Stage beside the running server (zero interruption)

Everything in this step is additive; the live mount and the running process
are untouched.

```bash
# 3a. Create the mirror WITH the explicit refspec (LOAD-BEARING: clone --bare
# creates no fetch refspec; --mirror would map branches to refs/heads/* and
# break every caller's origin/<branch> spelling):
ORIGIN_URL="$(git -C /root/luna/stable/repo remote get-url origin)"
git clone --bare "$ORIGIN_URL" /root/luna/stable/mirror.git
git --git-dir /root/luna/stable/mirror.git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git --git-dir /root/luna/stable/mirror.git fetch origin
# Assert the refspec took:
git --git-dir /root/luna/stable/mirror.git config --get remote.origin.fetch
git --git-dir /root/luna/stable/mirror.git rev-parse origin/master

# 3b. TEMPORARY additive device so in-container build steps can reach the new
# tree (hot-plug additive — the established luna-repo mount is undisturbed):
incus config device add luna-stable luna-deploy disk source=/root/luna/stable path=/root/luna-deploy shift=true

# 3c. Materialize the first release AT THE CURRENTLY DEPLOYED SHA (inert:
# no restart, no unit interaction; builds happen inside the release dir).
# The engine is the DEPLOYED checkout's own copy — phase 4 is in DEPLOYED_SHA
# per the §2 precondition, so the release materialized here carries the
# releases-aware scripts that steps 5, 7 and 9 invoke from inside it:
DEPLOYED_SHA="$(git -C /root/luna/stable/repo rev-parse HEAD)"
LUNA_CONTAINER_DEPLOY_ROOT=/root/luna-deploy \
  /root/luna/stable/repo/scripts/luna-update-server \
    --profile stable --incus luna-stable \
    --layout releases --deploy-root /root/luna/stable \
    --materialize --ref "$DEPLOYED_SHA"

# 3d. Verify on the host:
ls /root/luna/stable/releases/"$DEPLOYED_SHA"/.complete
readlink /root/luna/stable/current          # → releases/<DEPLOYED_SHA>
```

## 4. Registry flip

Edit `/etc/luna/servers.toml`, stable stanza:

```toml
deploy.layout = "releases"
# deploy.root defaults to /root/luna/stable (parent of hostRepoDir); set it
# explicitly only if you want a different root.
# deploy.releasesKeep = 3   # optional; must be >= 2
```

Validation check (the loader now checks the releases shape; again the
deployed checkout's own copy):

```bash
/root/luna/stable/repo/scripts/luna-autodeploy stable --validate
```

Any junk `deploy.layout` value is a hard exit 2 — a typo cannot silently leave
automation running `reset --hard`.

## 5. Unit re-render (paths dangle until cutover — running process unaffected)

```bash
incus exec luna-stable -- /root/luna-deploy/current/scripts/luna-server-install \
  --profile stable --layout releases \
  --repo-dir /root/luna/current --luna-home /root/.luna \
  --units-only --no-enable --no-start
```

`--layout releases` skips the `.git` guard (in-container `/root/luna/current`
does not exist until the cutover) and requires `--repo-dir` to end in
`/current`. Rendered result: `WorkingDirectory=/root/luna/current/apps/ui-web`,
alert `ExecStart=/root/luna/current/scripts/luna-pager`.

```bash
# Confirm the render + surviving drop-ins:
incus exec luna-stable -- systemctl cat luna-chat-server.service | grep -E 'WorkingDirectory|dream-samples|memory'
```

Also point the claude pin through current NOW (the old pin references
`/root/luna/node_modules/...`, which vanishes at cutover). `/root/.luna` is the
same file on host and container (separate device), so edit host-side:

```bash
CLAUDE_BIN_REL="$(cd /root/luna/stable/current && find node_modules -path '*/@anthropic-ai/claude-agent-sdk-linux-x64/claude' -type f -perm -111 | sort | tail -1)"
sed -i "s#^LUNA_CLAUDE_CODE_EXECUTABLE=.*#LUNA_CLAUDE_CODE_EXECUTABLE=/root/luna/current/${CLAUDE_BIN_REL}#" /root/.luna/.env
grep '^LUNA_CLAUDE_CODE_EXECUTABLE=' /root/.luna/.env
```

**Keep the render→restart window tight.** From this point a spontaneous
crash-restart would chdir to a not-yet-visible path. Proceed to step 6
immediately.

## 6. THE ONE RESTART (operator-chosen moment)

Never attempt a hot device edit of the busy mount — stop, edit, start:

```bash
incus stop luna-stable
incus config device set luna-stable luna-repo source=/root/luna/stable
incus config device remove luna-stable luna-deploy
incus start luna-stable
```

The container now sees `/root/luna/{repo,mirror.git,releases,current,previous}`.

## 7. Verification

```bash
# Both sides of the mount land on the same release:
(cd -P /root/luna/stable/current && pwd)                       # host
incus exec luna-stable -- readlink -f /root/luna/current       # container
# → both end in /releases/<DEPLOYED_SHA>

incus exec luna-stable -- systemctl show luna-chat-server.service -p WorkingDirectory,MainPID

# /readyz: mode=normal, buildSha prefix-matches the release sha (resolved via
# the release's own .git — no LUNA_BUILD_SHA involved):
incus exec luna-stable -- curl -fsS http://127.0.0.1:4753/readyz

# Claude pin is the through-current spelling and executable:
grep '^LUNA_CLAUDE_CODE_EXECUTABLE=/root/luna/current/' /root/.luna/.env
incus exec luna-stable -- test -x "$(grep '^LUNA_CLAUDE_CODE_EXECUTABLE=' /root/.luna/.env | cut -d= -f2)" && echo pin-ok

# BEFORE re-enabling the timer: assert the PINNED guardian engine is
# phase-4-aware (the timer runs the pin, not the checkout — a pre-phase-4 pin
# would treat stable as inplace and resume reset --hard deploys per tick):
ENGINE_PIN="$(readlink -f /usr/local/lib/luna-guardian/current-stable)"
echo "$ENGINE_PIN"
grep -q 'P_LAYOUT' "$ENGINE_PIN/lib/luna-registry.sh" \
  && echo engine-pin-ok || echo "STOP: do NOT re-enable the timer — refresh the guardian engine pin first"

# One guardian tick converges silent; one no-op deploy run converges silent:
systemctl start luna-guardian-stable.service; journalctl -u luna-guardian-stable.service -n 3
/root/luna/stable/current/scripts/luna-autodeploy stable      # "up to date … no-op"

# Re-enable automation (mirrors §2's disable --now; restore deploy.autoUpdate
# in the registry if you set it false):
systemctl enable --now luna-guardian-stable.timer
```

## 8. Rollback-to-inplace (available indefinitely)

`repo/` was frozen untouched, so the pre-migration world can be restored at
any time. Ordering is load-bearing — three traps this sequence avoids:
`incus exec` fails against a stopped container (exec only after start); a
freshly started container would AUTOSTART the service against the
still-releases-shaped unit (`WorkingDirectory=/root/luna/current/...`, which
dangles once the device is restored) and crash-loop into its start limit
(disable the unit across the swap); and the through-current claude pin
dangles under the restored device (restore it BEFORE the service starts, or
the server boots but cannot spawn claude).

```bash
# 0) Automation must already be off (§2's disable --now; re-check):
systemctl is-enabled luna-guardian-stable.timer   # expect: disabled

# 1) Keep the unit from autostarting mid-swap with dangling paths:
incus exec luna-stable -- systemctl disable --now luna-chat-server.service

# 2) Device restore across a STOPPED container (never hot-edit the busy mount):
incus stop luna-stable
incus config device set luna-stable luna-repo source=/root/luna/stable/repo
incus start luna-stable
incus exec luna-stable -- true   # container is running again; execs work now

# 3) registry: deploy.layout = "inplace"
#    (or restore /etc/luna/servers.toml.pre-releases)

# 4) Re-render the units to the inplace shape (in-container /root/luna is the
#    frozen repo again, so the installer's .git guard passes):
incus exec luna-stable -- /root/luna/scripts/luna-server-install \
  --profile stable --repo-dir /root/luna --luna-home /root/.luna \
  --units-only --no-enable --no-start
incus exec luna-stable -- systemctl daemon-reload

# 5) Restore the claude pin BEFORE the service starts (host-side edit;
#    /root/.luna is the same file on both sides):
CLAUDE_BIN_REL="$(cd /root/luna/stable/repo && find node_modules -path '*/@anthropic-ai/claude-agent-sdk-linux-x64/claude' -type f -perm -111 | sort | tail -1)"
sed -i "s#^LUNA_CLAUDE_CODE_EXECUTABLE=.*#LUNA_CLAUDE_CODE_EXECUTABLE=/root/luna/${CLAUDE_BIN_REL}#" /root/.luna/.env
grep '^LUNA_CLAUDE_CODE_EXECUTABLE=' /root/.luna/.env

# 6) Clear any start-limit residue from the incident, re-enable, start:
incus exec luna-stable -- systemctl reset-failed luna-chat-server.service
incus exec luna-stable -- systemctl enable --now luna-chat-server.service

# 7) Verify /readyz buildSha == git -C /root/luna/stable/repo rev-parse HEAD:
incus exec luna-stable -- curl -fsS http://127.0.0.1:4753/readyz
```

**Kill-switch ordering:** `LUNA_REGISTRY_DISABLE=1` (the hardcoded fallback) is
only coherent AFTER this device/unit restore — the fallback is inplace-only by
design and knows nothing about the releases layout.

## 9. Manual rollback and 3am one-liners (releases mode)

* `previous` names the rollback target: `readlink /root/luna/stable/previous`.
* Clean rollback (seconds — reuse gate makes it a flip+restart, no rebuild):

  ```bash
  /root/luna/stable/current/scripts/luna-update-server \
    --profile stable --incus luna-stable \
    --layout releases --deploy-root /root/luna/stable \
    --ref "$(basename "$(readlink -f /root/luna/stable/previous)")"
  ```
* Emergency manual flip (server down, engine unusable):

  ```bash
  ln -sfT releases/<PREV_SHA> /root/luna/stable/current
  incus exec luna-stable -- systemctl restart luna-chat-server.service
  ```
* Transaction journal: `/root/.luna/update/transaction-stable` — `phase=` is one
  of `prepared|checkout|applied|restarting|verifying|rolling-back|rollback-failed|forward-failed`
  (same vocabulary as inplace; `prev=`/`target=` name the releases involved,
  and both are prune-protected while the journal exists).

## 10. Human workspace doctrine

* Dev work happens **only in independent clones** (the operator uses
  `/root/luna-work`). Nothing under `/root/luna/<profile>/` is a human
  worktree — `releases/` is machine-owned and **pruned**; `mirror.git` is
  machine-fetched; `repo/` is a frozen artifact.
* Evidence this doctrine exists: on 2026-07-30 an unattended
  `git reset --hard` destroyed a local commit made in the deploy checkout, and
  wiped linked-worktree metadata under `.git/worktrees`; the checkout had also
  accumulated ~4.0G of stray `worktrees/`. This migration removes
  `reset --hard` from every automated path (grep-provable: the string exists
  only in the inplace arm, pinned by a static test) and reclaims the stray
  worktrees:

  ```bash
  # after the cutover has soaked:
  rm -rf /root/luna/stable/repo/worktrees
  ```

## 11. dev / lea migration

Identical recipe with their own roots (`/root/luna/dev`, `/root/luna/lea`),
containers (`luna-dev`, `luna-lea`) and units
(`luna-dev-chat-server.service`, …). Until a profile's registry stanza sets
`deploy.layout = "releases"`, **nothing changes for it** — the inplace arm is
byte-identical to pre-phase-4 (pinned by the verbatim-signature test). Note:
lea's extra NIC/ACL devices are untouched by the `luna-repo` device edit.

## 12. Retention and disk budget

* Default `keep = 3` (~11.2G at ~3.7G/release, <1% of the 1.5T free);
  `deploy.releasesKeep` (integer ≥ 2) overrides per profile.
* Prune runs at the end of a healthy deploy AND at the end of a recovered
  rollback (readiness failed, flip-back succeeded, exit 1) — so a branch that
  keeps advancing while every deploy fails cannot accumulate
  complete-but-failed releases without bound. Protected always: the release
  `current` resolves to, the release `previous` resolves to, and any sha
  named in a live transaction journal. If `current` OR `previous` dangles,
  prune refuses to delete **anything**. The postcondition re-resolves both
  links and is fatal only when the run actually pruned.
* Partials (a release dir without `.complete`) never count toward `keep` and
  are removed regardless of age (unless protected): failed builds already
  clean up their own tree on the failure exit, and a rebuild of the DEPLOYED
  release happens in a staged sibling (`releases/.stage.<sha>`) swapped in
  only once complete — the tree `current` resolves to is never deleted by any
  automated path. Stale `.stage.*` leftovers (SIGKILL crashes) are swept by
  the next prune.
* Future work (explicitly rejected for v1): hardlink-seeding `node_modules`
  between releases — bun rewrites files in place, and a shared inode would
  corrupt the immutable previous release. Seeding uses full `cp -a` when the
  bun.lock blob is unchanged, and the frozen install still runs as a check.
