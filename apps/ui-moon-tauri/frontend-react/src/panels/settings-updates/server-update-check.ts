/**
 * server-update-check.ts - checks GitHub for a newer Luna server release.
 *
 * The control API (`control.checkServerUpdate`) is loopback-only by design,
 * so a remote Moon cannot call it. Instead Moon queries the public GitHub
 * releases API itself and compares the newest non-draft, non-prerelease
 * `server-v*` tag against the connected server's release version (captured
 * from the WS hello frame by server-version.ts).
 *
 * When an update is available the UI offers a copy-to-clipboard button for
 * the exact host-side command (`luna-update-server --ref server-vX.Y.Z`).
 * Triggering a server update remotely would kill the very connection Moon
 * uses to report success, so the human stays in the loop for the infra op.
 */

import { getServerVersion } from "./server-version"

const RELEASES_URL = "https://api.github.com/repos/fourcolors/luna/releases?per_page=30"

export interface ServerUpdateInfo {
  /** Bare semver of the connected server, e.g. "0.5.0". */
  readonly current: string
  /** Bare semver of the newest published server release, e.g. "0.6.0". */
  readonly latest: string
  /** Full release tag, e.g. "server-v0.6.0". */
  readonly tag: string
  /** Release notes body, may be null. */
  readonly notes: string | null
  /** Exact host-side command to run the update. */
  readonly updateCommand: string
}

interface GitHubRelease {
  readonly tag_name?: string
  readonly draft?: boolean
  readonly prerelease?: boolean
  readonly body?: string | null
}

function parseServerTag(tag: string): string | null {
  const m = /^server-v(\d+\.\d+\.\d+)$/.exec(tag.trim())
  return m ? m[1]! : null
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Returns ServerUpdateInfo when a newer server release exists, null when the
 * server is current (or its version is unknown / no server releases found).
 * Throws on network or API errors so the caller can show a soft error state.
 */
export async function checkServerUpdate(): Promise<ServerUpdateInfo | null> {
  const current = getServerVersion()
  if (!current) return null

  const res = await fetch(RELEASES_URL, {
    headers: { Accept: "application/vnd.github+json" },
  })
  if (!res.ok) {
    throw new Error(`GitHub releases API returned ${res.status}`)
  }
  const releases = (await res.json()) as GitHubRelease[]

  let best: { version: string; tag: string; notes: string | null } | null = null
  for (const r of releases) {
    if (r.draft || r.prerelease) continue
    if (typeof r.tag_name !== "string") continue
    const version = parseServerTag(r.tag_name)
    if (!version) continue
    if (!best || compareSemver(version, best.version) > 0) {
      best = {
        version,
        tag: r.tag_name.trim(),
        notes: typeof r.body === "string" && r.body.trim() ? r.body.trim() : null,
      }
    }
  }
  if (!best) return null
  if (compareSemver(best.version, current) <= 0) return null

  return {
    current,
    latest: best.version,
    tag: best.tag,
    notes: best.notes,
    updateCommand: `luna-update-server --ref ${best.tag}`,
  }
}
