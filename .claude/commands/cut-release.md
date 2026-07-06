---
description: Cut a Luna Moon release — bump the four version files, push master, then push the moon-v tag (which fires the macOS build), monitor it, and write the release notes.
argument-hint: "[x.y.z]  (optional — omit to auto-bump the patch)"
model: sonnet
allowed-tools: Read, Bash(git fetch:*), Bash(git pull:*), Bash(git push:*), Bash(git log:*), Bash(git status:*), Bash(git ls-remote:*), Bash(git tag:*), Bash(grep:*), Bash(bun run:*), Bash(gh run list:*), Bash(gh run watch:*), Bash(gh run view:*), Bash(gh release view:*), Bash(gh release edit:*), Bash(curl:*)
---

# /cut-release — cut a Luna Moon release

Cut a Luna **Moon** desktop release (`moon-v<x.y.z>`): bump the four version files, push the
bump to `master`, then push the `moon-v` tag that fires the macOS build. Monitor it, report
back inline, and write the GitHub release notes. Requested version: **$ARGUMENTS** (may be
empty → auto-bump the patch).

Mechanics live in `scripts/bump-moon.ts`, `.github/workflows/release-moon.yml`, and `RELEASES.md`.

## Context (auto-loaded)

- Version sync (all four files must agree): !`bun run scripts/bump-moon.ts --check 2>&1 | tail -5`
- Latest existing Moon tags: !`git fetch --tags --quiet origin 2>/dev/null; git tag --list 'moon-v*' --sort=-version:refname | head -3`
- Branch / tree state: !`git status -sb | head -1`

## Procedure

### 1. Decide the version
- If `$ARGUMENTS` is a valid `x.y.z`, that's the target.
- If empty, propose the next **patch** bump from the current version (e.g. `0.0.40` → `0.0.41`) and state it.
- Reject anything that isn't `x.y.z`. The tag will be `moon-v<x.y.z>`.

### 2. Pre-flight (all must pass before cutting)
- On `master`, clean tree, up to date: `git fetch origin master && git pull --ff-only`. The
  built artifact is exactly this commit (+ the bump), so `master` must be what you intend to ship.
- The tag is free: `git ls-remote --tags origin "refs/tags/moon-v<x.y.z>"` is empty.

### 3. Cut — commit, then **master**, then tag
**Order matters:** the bump commit must reach `master` *before* the tag fires CI, so the
released commit is always on `master`. Pushing the `moon-v*` tag is what triggers
`release-moon.yml` (`on: push: tags: "moon-v*"`).

```
bun run scripts/bump-moon.ts <x.y.z> --tag   # bump 4 files in lockstep, commit, create tag — does NOT push
git push origin master                        # bump commit lands on master FIRST
git push origin moon-v<x.y.z>                 # ← fires the macOS build; the irreversible publish step
```

`bump-moon.ts --tag` rewrites all four version files (`package.json` / `tauri.conf.json` /
`Cargo.toml` / `Cargo.lock`), commits `chore(ui-moon-tauri): bump to <x.y.z>`, and creates the
annotated tag — but does **not** push. You push `master` first, then the tag. The tag push is
the user-facing publish — it will prompt for approval.

### 4. Find & monitor the run
- Give it a few seconds, then find the triggered run: `gh run list --workflow=release-moon.yml --limit 1 --json databaseId,status,url,createdAt,event`. Confirm it's fresh **and** `event` is `push` (the tag push — not a stale `workflow_dispatch`); grab `databaseId`.
- The macOS build takes **~10–20 min** — watch it in the **background** so you're re-invoked on completion instead of blocking: `gh run watch <id> --exit-status --interval 30` via Bash `run_in_background: true`.

### 5. On success — report + write release notes
1. Resolve assets: `gh release view moon-v<x.y.z> --json url,publishedAt,assets`. Download = the release page `url`.
2. Verify the updater **"Latest" invariant** — only a `moon-v*` release may be GitHub-Latest, or the in-app updater breaks:
   ```
   curl -sL -o /tmp/luna-latest.json -w "%{http_code}\n" https://github.com/fourcolors/luna/releases/latest/download/latest.json
   grep '"version"' /tmp/luna-latest.json   # must equal <x.y.z>
   ```
   Expect **HTTP 200** and `"version": "<x.y.z>"` matching the release. If either is wrong, flag it: `gh release edit moon-v<x.y.z> --latest`.
3. Changelog: `git log moon-v<prev>..moon-v<x.y.z> --pretty='- %s'`, grouped Features / Fixes / Chore. Write it: `gh release edit moon-v<x.y.z> --notes "<changelog>"`.
4. Print the inline report:
   > ✅ **Luna Moon `<x.y.z>` released** — `moon-v<x.y.z>`, published `<time>` (build: `<run-url>`)
   > **Download:** `<release page url>`  ·  updater `latest.json` → 200 ✓
   > **Changes since `moon-v<prev>`:** `<grouped one-line summary>`

### 6. On failure
- Report the failed step: `gh run view <id> --log-failed | tail -40`.
- The tag + bump are already on `master`, so recommend either fixing forward (cut a new patch)
  or cleanup: `gh release delete moon-v<x.y.z> --cleanup-tag` and revert the bump commit. Never
  leave a non-`moon-v*` release holding GitHub "Latest".

## Notes
- Only `moon-v*` releases may hold GitHub's **"Latest"** flag (the auto-updater depends on it). Server (`server-v*`) and chat (`chat-v*`) releases are separate and must be `--latest=false`.
- For a **server** release use `scripts/bump-server.ts` + `release-server.yml` instead.
