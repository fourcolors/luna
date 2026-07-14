# Release conventions

This repo cuts two distinct kinds of releases. They share a tag namespace
on `fourcolors/luna` but **must** maintain a specific invariant or the
Luna Moon auto-updater silently stops working.

## The "Latest" invariant

> **At any given time, the GitHub "Latest" release on `fourcolors/luna`
> MUST be a `moon-v*` release.**

The Tauri v2 auto-updater inside Luna Moon fetches its release manifest
from:

```
https://github.com/fourcolors/luna/releases/latest/download/latest.json
```

GitHub resolves `releases/latest` to whichever non-draft, non-prerelease
release was published most recently AND has the "Latest" flag set. If a
release without a `latest.json` asset holds the flag, the URL returns
HTML or 404 and Moon's updater fails with **"Could not fetch a valid
release JSON from the remote"**. Worse: `studio-v*` releases DO carry a
`latest.json` (for Studio's own rolling feed) — a Studio release holding
"Latest" would feed Moon syntactically valid JSON for the WRONG app, so
the flag discipline matters even more with two Tauri apps in the repo.
(Studio's own updater never reads `releases/latest` — see the Studio
section below.)

This bit us once already (chat-v0.12b briefly held "Latest" on
2026-06-07 around 09:27 UTC — fixed via `gh release edit moon-v0.0.12 --latest`).

## Moon releases (`moon-v*`)

- **Trigger:** EITHER (1) run the **"Release Moon"** workflow from the
  Actions tab and enter a version (recommended), OR (2) push a `moon-v*`
  tag. Both funnel into the same `release-moon.yml` run.
- **Pipeline:** `.github/workflows/release-moon.yml` runs on macOS-14,
  builds + signs + publishes via `tauri-apps/tauri-action`.
- **"Latest" flag:** automatically set by tauri-action; a final
  `gh release edit --latest` step re-anchors it as a belt-and-suspenders
  guard against a non-Moon release that might have stolen it between
  tag push and pipeline completion.
- **Operator runbook (recommended — no local Mac, no git ritual):** open
  GitHub → **Actions → Release Moon → Run workflow**, enter `x.y.z`. The
  run bumps all four version files in lockstep, commits them to `master`,
  tags `moon-v<version>`, pushes both, then builds + signs + publishes.
- **Operator runbook (local):** `bun run scripts/bump-moon.ts <version> --tag --push`,
  then `git push origin master`. The bump moves **all four** version files —
  `package.json` / `tauri.conf.json` / `Cargo.toml` / **`Cargo.lock`** (the
  `luna-moon-ui` entry). `bump-moon.ts --check` is the CI gate that fails a
  PR on any version drift across the four.

## Studio releases (`studio-v*`)

- **Trigger:** EITHER (1) run the **"Release Studio"** workflow from the
  Actions tab and enter a version (recommended), OR (2) push a `studio-v*`
  tag. Both funnel into the same `release-studio.yml` run.
- **Pipeline:** `.github/workflows/release-studio.yml` runs on macOS-14,
  builds + signs + publishes `apps/ui-studio-tauri` via `tauri-apps/tauri-action`.
- **Updater feed (deliberately NOT `releases/latest`):** Studio's updater
  endpoint is the fixed rolling release `studio-updater`:

  ```
  https://github.com/fourcolors/luna/releases/download/studio-updater/latest.json
  ```

  The workflow uploads each release's `latest.json` to that rolling release
  (`--clobber`), so Studio's feed never depends on the repo-wide "Latest"
  flag and can never collide with Moon's.
  **Never delete the `studio-updater` release** — installed Studio apps
  poll it forever.
- **"Latest" flag:** Studio releases are published `--latest=false` and the
  workflow's final step re-anchors "Latest" to the newest `moon-v*` release,
  preserving the invariant above.
- **Signing:** minisign keypair in repo secrets
  `STUDIO_TAURI_SIGNING_PRIVATE_KEY` / `STUDIO_TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  (distinct from Moon's; recovery copies in the operator keychain under
  `luna.studio.updater-key`). macOS bundle is ad-hoc signed (committed conf).
- **Version lockstep:** `bump-studio.ts` moves all four Studio version files —
  `package.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` (the
  `luna-studio-ui` entry). `bump-studio.ts --check` is the CI gate.
- **Update UX (v1):** release builds check the feed on boot, silently stage
  `download_and_install`, and the new version takes effect on the next
  launch. Debug builds skip the check entirely.
- **Operator runbook:** open GitHub → **Actions → Release Studio → Run
  workflow**, enter `x.y.z` — or locally
  `bun run scripts/bump-studio.ts <version> --tag --push` then
  `git push origin master`.

## Chat-server / library releases (`chat-v*`, anything else)

- **No pipeline** — these are tag-only, manual.
- **"Latest" flag:** **MUST be set to false.** If you cut one of these
  releases manually, use:

  ```bash
  gh release create chat-v0.12c \
    --title "..." --notes "..." \
    --latest=false \
    --target <sha>
  ```

  Or after the fact:

  ```bash
  gh release edit chat-v0.12c --latest=false
  gh release edit moon-v0.0.<N> --latest=true   # re-anchor to newest Moon
  ```

- **Why a separate flag?** Because of the invariant above. The Moon
  updater is the only consumer of "Latest" and it cannot use anything
  else.

## Server releases (`server-v*`)

- **Trigger:** push a `server-v*` annotated tag cut by `bump-server.ts`.
- **Pipeline:** `.github/workflows/release-server.yml` runs on `ubuntu-latest`
  (no macOS runner, no binary build — the server ships as source). It publishes
  a GitHub Release with a single asset, `server-latest.json`, carrying `{version,
  tag, targetSha, notes, date}`.
- **"Latest" flag:** **MUST be set to false.** The workflow enforces
  `--latest=false` on `gh release create`. It also runs a re-anchor guard as a
  belt-and-suspenders measure (the same guard `release-moon.yml` runs) that
  re-points the Latest flag to the newest `moon-v*` release after every server
  publish. A server release stealing Latest would break the Moon updater.
- **Operator runbook:**

  ```zsh
  # 1. Bump the version and cut the tag locally (no publish yet):
  bun run scripts/bump-server.ts <x.y.z> --tag

  # 2. Review the diff and the tag, then push to trigger the release pipeline:
  bun run scripts/bump-server.ts <x.y.z> --tag --push
  # — or equivalently after step 1: git push origin server-v<x.y.z>
  ```

  `--push` is operator-gated: it publishes a GitHub Release visible to all
  self-hosters. Do not run it without reviewing intent and the tag contents.
- **What the workflow publishes:** only `server-latest.json`. No binaries, no
  signed bundles — the server is updated via `git fetch` + conditional
  `bun install` by `scripts/luna-update-server` (the apply engine).
- **How servers pick changes up:** the stable channel uses the host-side
  `luna-guardian-stable.timer` every minute. It performs deep health/recovery
  and invokes the same connect-aware apply engine, so branch movement waits
  while WebSocket sessions are active. Existing legacy autodeploy timers
  self-adopt the guardian only after the running SHA proves the checkout safe.
  `deploy.autoUpdate = false` disables branch movement without disabling health
  and repair. See `docs/autodeploy.md`.
- **Release completion gate:** publishing `server-v*` is not deployment
  completion. After stable reaches the release target, run the pinned guardian
  acceptance interface with the immutable master SHA:

  ```bash
  /usr/local/lib/luna-guardian/current-stable/luna-guardian accept stable \
    --expected-sha <full-master-sha> --min-cycles 2
  ```

  Completion requires two consecutive healthy cycles, exact runtime and engine
  SHAs, `Type=notify` plus watchdog, a clean update journal, `luna-doctor`, and
  verified retirement of the legacy timer. A connect-aware defer leaves the
  release pending; do not force connected sessions merely to turn the gate green.
- **Discovery contract:** `luna update` and any monitoring script resolve the
  latest server release via the GitHub Releases API **filtered for `server-v*`**
  — never via the `releases/latest` endpoint (reserved for Moon).

## Verification

After cutting any release, sanity-check the updater endpoint:

```bash
curl -sL -o /tmp/check.json -w "HTTP %{http_code}\n" \
  https://github.com/fourcolors/luna/releases/latest/download/latest.json
python3 -m json.tool /tmp/check.json | head -5
```

Expected: HTTP 200 + valid JSON starting with `"version": "0.0.X"`. If
that fails, the wrong release has the "Latest" flag — find which one
with `gh release list --limit 5` and reset:

```bash
gh release edit <wrong-tag> --latest=false
gh release edit moon-v<latest> --latest=true
```
