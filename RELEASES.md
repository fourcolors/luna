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
release was published most recently AND has the "Latest" flag set. Only
`moon-v*` releases include a `latest.json` asset; if any other release
holds the "Latest" flag, the URL returns HTML or 404 and the updater
fails with **"Could not fetch a valid release JSON from the remote"**.

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
- **How servers pick changes up:** the stable channel **auto-updates by
  default** — a host-side systemd timer (`luna-autodeploy`, every 15min) polls
  `origin/master` and applies moves while the channel is idle (it defers while
  WebSocket sessions are active). The manual one-command deploy
  (`luna-autodeploy stable`) still works, and the opt-out
  (`deploy.autoUpdate = false` or `uninstall-timer`) is documented in
  `docs/autodeploy.md`. `luna update` (Phase 1 Slice 4) drives the same apply
  engine on demand.
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
