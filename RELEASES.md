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
release JSON from the remote"**. Worse: the already-published `studio-v*`
releases DO carry a `latest.json` (for retired Studio's own rolling feed) —
one of them holding "Latest" would feed Moon syntactically valid JSON for
the WRONG app, so the flag discipline outlives the deleted app.
(See the retired Studio section below.)

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

## Studio releases (`studio-v*`) — RETIRED

Studio was removed in PR #405 (2026-07-31 — see NEXT.md).
No new `studio-v*` release can be cut: `release-studio.yml`,
`scripts/bump-studio.ts`, and `apps/ui-studio-tauri` no longer exist.

Two facts about the ALREADY-PUBLISHED releases remain load-bearing:

- **Never delete the `studio-updater` rolling release** — installed Studio
  apps poll it forever, and it is their only updater feed.
- Existing `studio-v*` releases still carry a `latest.json` asset, so the
  "Latest"-flag discipline above still applies to them: none of them may
  ever hold the "Latest" flag, or Moon's updater reads the wrong app's feed.

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
