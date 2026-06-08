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

- **Trigger:** push a `moon-v*` tag.
- **Pipeline:** `.github/workflows/release-moon.yml` runs on macOS-14,
  builds + signs + publishes via `tauri-apps/tauri-action`.
- **"Latest" flag:** automatically set by tauri-action; a final
  `gh release edit --latest` step re-anchors it as a belt-and-suspenders
  guard against a non-Moon release that might have stolen it between
  tag push and pipeline completion.
- **Operator runbook:** `bun run scripts/bump-moon.ts <version>` (if
  present) or hand-bump `package.json` / `tauri.conf.json` / `Cargo.toml`
  then push `moon-v<version>`.

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
