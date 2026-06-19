---
description: Cut a Luna Moon release — bump + tag (auto-fires the CI build), monitor it, then report download link, version & changelog and update the GitHub release notes.
argument-hint: "[x.y.z]  (optional — omit to auto-bump the patch)"
model: sonnet
allowed-tools: Read, Bash(git fetch:*), Bash(git pull:*), Bash(git tag:*), Bash(git log:*), Bash(git rev-parse:*), Bash(git status:*), Bash(git ls-remote:*), Bash(grep:*), Bash(gh run list:*), Bash(gh run view:*), Bash(gh run watch:*), Bash(gh release view:*), Bash(gh release list:*), Bash(curl:*)
---

# /cut-release — cut a Luna Moon release

Cut a Luna **Moon** desktop release (`moon-v*`) by bumping + tagging locally and pushing the tag
(which **auto-fires** the macOS build), then monitor it, report back inline, and write the GitHub
release notes. Requested version: **$ARGUMENTS** (may be empty).

Authoritative mechanics live in `RELEASES.md`, `scripts/bump-moon.ts`, and
`.github/workflows/release-moon.yml` — read them if anything below is unclear.

## Context (auto-loaded)

- Current version (must agree across all 4 files): !`grep -m1 '"version"' apps/ui-moon-tauri/package.json`
- Latest existing Moon tags: !`git fetch --tags --quiet origin 2>/dev/null; git tag --list 'moon-v*' --sort=-version:refname | head -3`
- Branch / tree state: !`git status -sb | head -1`
- Commits on master since the last Moon tag (what will ship): !`git log --oneline "$(git tag --list 'moon-v*' --sort=-version:refname | head -1)"..origin/master 2>/dev/null | head -40`

## Procedure

Work through these in order. Stop and surface the problem if any pre-flight check fails.

### 1. Decide the version
- If `$ARGUMENTS` is a valid `x.y.z`, that's the target.
- If empty, propose the next **patch** bump from the current version (e.g. `0.0.40` → `0.0.41`) and state it.
- Reject anything that isn't `x.y.z`. The tag will be `moon-v<x.y.z>`.

### 2. Pre-flight (all must pass before cutting)
The tag is cut from your **local `master` HEAD**, so:
- You are on `master`, the working tree is clean (`git status -sb`), and you're current: `git fetch origin master && git pull --ff-only`. The built artifact is exactly this commit (+ the bump) — master must be what you intend to ship.
- The tag is free: `git ls-remote --tags origin "refs/tags/moon-v<x.y.z>"` is empty (`bump-moon.ts --tag` also refuses a reused tag).
- Note the **previous** Moon tag (`git tag --list 'moon-v*' --sort=-version:refname | head -1`) for the changelog diff.

### 3. Show the plan, then cut (tag method)
Print: target version, tag, previous tag, and the one-line list of commits that will ship (from
the auto-loaded context). Then cut — **pushing a `moon-v*` tag auto-triggers `release-moon.yml`**
(`on: push: tags: "moon-v*"`), so the build starts the instant the tag lands:

```
bun run scripts/bump-moon.ts <x.y.z> --tag --push
git push origin master   # bump-moon --push pushes only the TAG; sync the bump commit to master too
```

`bump-moon.ts` rewrites all four version files in lockstep (`package.json` / `tauri.conf.json` /
`Cargo.toml` / `Cargo.lock`), commits `chore(ui-moon-tauri): bump to <x.y.z>`, creates the
annotated tag `moon-v<x.y.z>`, and pushes the tag → fires the build. This is the **irreversible,
user-facing publish** step — it will prompt for approval.

(Fallback if you'd rather CI do the git: the **Actions ▸ Release Moon ▸ Run workflow** button, or
`gh workflow run release-moon.yml -f version=<x.y.z>`.)

### 4. Find & monitor the run
- Give it a few seconds, then find the run the tag push triggered: `gh run list --workflow=release-moon.yml --limit 1 --json databaseId,status,url,createdAt,event`. Confirm `createdAt` is fresh; grab `databaseId`.
- Monitor it. The macOS build typically takes **~10–20 min** — run the watch in the **background** so you're re-invoked on completion instead of blocking the foreground:
  - `gh run watch <id> --exit-status --interval 30` via Bash `run_in_background: true`.
  - When notified, read the result. (If polling instead: `gh run view <id> --json status,conclusion,url` until `status == "completed"`.)

### 5a. On success — report + write release notes
1. Resolve assets: `gh release view moon-v<x.y.z> --json url,tagName,publishedAt,assets`.
   - **Download** = the release page `url`; also surface the macOS app asset (`*.app.tar.gz`) and note the updater manifest `latest.json`.
2. Verify the updater **"Latest" invariant** (`RELEASES.md`): only a `moon-v*` release may be GitHub-Latest, or the in-app updater breaks.
   ```
   curl -sL -o /tmp/luna-latest.json -w "HTTP %{http_code}\n" https://github.com/fourcolors/luna/releases/latest/download/latest.json
   ```
   Expect **HTTP 200** and `"version": "<x.y.z>"` matching. If not, flag it and suggest `gh release edit moon-v<x.y.z> --latest=true`.
3. Build the changelog from `git log moon-v<prev>..moon-v<x.y.z> --pretty='- %s'`. Group by Conventional-Commit type (Features / Fixes / Chore / Other), strip noise, keep it tight.
4. **Update the GitHub release notes** with that changelog (the "updated summary in GitHub"):
   ```
   gh release edit moon-v<x.y.z> --notes "<markdown changelog>"
   ```
5. Print the **inline report** in this shape:

   > ✅ **Luna Moon `<x.y.z>` released** — `moon-v<x.y.z>`, published `<time>` (build: `<run-url>`)
   > **Download:** `<release page url>`  ·  updater `latest.json` → HTTP 200 ✓ (Latest = this release)
   > **Changes since `moon-v<prev>`:**
   > - <grouped one-line summary of the shipped commits>
   >
   > Release notes updated on GitHub ✓

### 5b. On failure
- Report the failed run URL + failing step: `gh run view <id> --log-failed | tail -40`.
- ⚠️ The tag method pushes the tag (and you pushed master) **before** the build, so a build failure leaves `moon-v<x.y.z>` + the bump commit already on `origin/master`. Say so, then recommend either fixing forward (cut a new patch) or cleaning up: `gh release delete moon-v<x.y.z> --cleanup-tag` and revert the bump commit. Never leave a non-`moon-v*` release holding GitHub "Latest".

## Notes
- Only `moon-v*` releases may hold GitHub's **"Latest"** flag (the Moon auto-updater depends on it). Server (`server-v*`) and chat (`chat-v*`) releases are separate and must be `--latest=false`.
- This command is for **Moon**. For a server release use `scripts/bump-server.ts` + `release-server.yml` instead.
