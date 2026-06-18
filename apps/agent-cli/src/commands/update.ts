import { spawnSync } from "node:child_process"
import { defineCommand } from "citty"

/**
 * `luna update` — check for and apply server-v* releases on the host.
 *
 * Phase-1 scope: SYSTEM-UNIT case only (scripts/luna-update-server already
 * refuses anything but /etc/systemd/system units). Supervisor auto-detection
 * (--user / launchd) is Phase 2 and OUT OF SCOPE here.
 *
 * Design mirrors `luna doctor` (doctor.ts): impure IO / network probes are
 * quarantined at the bottom; PURE functions — pickLatestServerRelease,
 * compareServerVersion, renderUpdatePlan — drive all comparison and rendering
 * logic and are independently unit-testable with no live server.
 *
 * Discovery invariants (from PRD §3.1):
 *   - Filter releases for tag_name startsWith "server-v" AND NOT draft.
 *   - NEVER use releases/latest — that endpoint is reserved for the Moon
 *     client updater (Tauri/minisign). Disturbing it would silently break Moon.
 *   - The targeted asset is named "server-latest.json" on each release.
 *
 * Server identity probe (Phase-1 scope decision — deviates slightly from PRD §3.2):
 *   PRD §3.2 step 1 specifies reading the running server identity from /readyz,
 *   "using the WS connection's hello frame as a fallback when the HTTP probe is
 *   not reachable." Phase-1 implements HTTP /readyz only. The WS-hello fallback
 *   is intentionally deferred to Phase 2 for one structural reason: `luna update`
 *   runs on the SERVER HOST as an operator command and does not carry a UI WS
 *   token (unlike `luna doctor`, which runs on the client machine and resolves a
 *   token from ~/.luna/.env). Without a token the /ui WebSocket upgrade returns
 *   401, making the fallback impossible without first solving token distribution
 *   on the host. Phase-1 graceful degradation: when /readyz is unreachable,
 *   runningSha stays undefined → compareServerVersion returns "unknown" →
 *   the engine is invoked anyway (it has its own readiness gate + auto-rollback),
 *   which is safe and matches the "cannot prove up-to-date → let engine decide"
 *   rationale documented at lines 663-664.
 *
 * Active-session deferral (from PRD §3.3, §3.4):
 *   - Calls luna_active_ws_count() from scripts/lib/luna-deploy.sh — one
 *     shared implementation (not reimplemented here) so the CLI, autodeploy,
 *     and installer all call the same function.
 *   - If active sessions > 0 and neither --allow-active nor --force: defer
 *     with exit 0 (deferred = success; let the operator decide).
 *   - If the count cannot be determined (exec/parse failure): WARN and proceed.
 *     Rationale: the engine (luna-update-server) has its own readiness gate and
 *     safety net; blocking on a tooling failure is worse than proceeding with
 *     a warning. Documented here so reviewers can audit the decision.
 */

/* -------------------------------------------------------------------------- */
/* GitHub release types                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Minimal shape of a GitHub Releases API item that we care about.
 * The full API response has many more fields we deliberately ignore.
 */
export interface GithubRelease {
  readonly tag_name: string
  readonly draft: boolean
  readonly assets: ReadonlyArray<{
    readonly name: string
    readonly browser_download_url: string
  }>
}

/**
 * One entry from the git/matching-refs API.
 * GET /repos/:owner/:repo/git/matching-refs/tags/server-v returns an array of
 * these — one per tag whose name starts with "server-v". No pagination: the API
 * returns the complete list in a single response, so >100 moon-v* releases never
 * push server-v* tags off the page.
 */
export interface GithubMatchingRef {
  readonly ref: string  // e.g. "refs/tags/server-v0.1.0"
  readonly object: {
    readonly sha: string
    readonly type: string
  }
}

/**
 * Parsed server-latest.json asset (published with each server-v* release).
 *
 * Note: the asset also carries a `version` field (e.g. "0.1.0") but we do not
 * include it here — `tag` already encodes the version ("server-v0.1.0") and
 * carrying a second copy would create a surface for the two to diverge.
 */
export interface ServerLatestJson {
  readonly tag: string
  readonly targetSha: string
}

/* -------------------------------------------------------------------------- */
/* Pure: semver helpers for server-v* tag selection                           */
/* -------------------------------------------------------------------------- */

/**
 * Matches a well-formed server release tag: "server-v" + numeric major.minor.patch,
 * with an OPTIONAL SemVer pre-release suffix (e.g. "server-v0.2.0-rc.1").
 *
 * WHY this guard exists: git/matching-refs/tags/server-v returns EVERY ref whose
 * name starts with "server-v" — including non-version refs an operator might push
 * by accident or convention ("server-vnext", "server-v", "server-v-test"). Those
 * yield NaN when parsed as major.minor.patch, and compareServerSemver(real, NaN)
 * returns NaN. Because `NaN > 0` is false, a malformed tag that SEEDS the reduce in
 * pickLatestServerTag would never be displaced by a real version → garbage pick,
 * order-dependent on ref ordering. We defend at TWO layers: parseMatchingRefsBody
 * drops malformed tags at ingestion (primary), and pickLatestServerTag/
 * sortServerTagsDesc skip them too (defense-in-depth, so the comparators stay
 * total and order-independent even if a malformed tag ever reaches them).
 */
export const SERVER_VERSION_TAG = /^server-v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/**
 * Pure: compare two server-v* tag names by numeric semver.
 *
 * WHY numeric: string-sorting "server-v0.10.0" < "server-v0.9.0" because "1"
 * < "9" lexicographically. This is the classic versioning pitfall. We strip the
 * "server-v" prefix, split on ".", and compare each component as an integer.
 *
 * Pre-release suffixes (e.g. "server-v0.2.0-rc.1") are stripped at the first "-"
 * for numeric comparison only — the returned order is by numeric version, not by
 * pre-release precedence. A full SemVer pre-release ordering (rc < release) is
 * intentionally out of scope: on a single release channel, multiple pre-releases
 * for the same numeric version are unlikely, and the added complexity is not
 * justified.
 *
 * Returns positive when a > b, negative when a < b, 0 when equal.
 */
export const compareServerSemver = (a: string, b: string): number => {
  const stripPrefix = (tag: string): string => {
    // Remove "server-v" prefix, then strip any pre-release suffix after "-"
    const withoutPrefix = tag.startsWith("server-v") ? tag.slice("server-v".length) : tag
    const dashIdx = withoutPrefix.indexOf("-")
    return dashIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, dashIdx)
  }

  const parseComponents = (version: string): readonly [number, number, number] => {
    const parts = version.split(".")
    return [
      Number.parseInt(parts[0] ?? "0", 10),
      Number.parseInt(parts[1] ?? "0", 10),
      Number.parseInt(parts[2] ?? "0", 10),
    ]
  }

  const [aMaj, aMin, aPatch] = parseComponents(stripPrefix(a))
  const [bMaj, bMin, bPatch] = parseComponents(stripPrefix(b))

  if (aMaj !== bMaj) return aMaj - bMaj
  if (aMin !== bMin) return aMin - bMin
  return aPatch - bPatch
}

/**
 * Pure: given an array of server-v* tag names, return the one with the highest
 * semver version. Returns null when none are well-formed (incl. empty input).
 *
 * Malformed tags (see SERVER_VERSION_TAG) are filtered out FIRST so the reduce
 * never compares against a NaN-producing tag — that is what makes the result
 * total and independent of input order (FINDING 1). After filtering we reduce in
 * a single linear pass, returning the running maximum.
 *
 * WHY not Array.sort for the max: Array.prototype.sort mutates the input array
 * and its string-sort default is wrong for versions (see compareServerSemver);
 * reduce sidesteps both.
 */
export const pickLatestServerTag = (tags: ReadonlyArray<string>): string | null => {
  const wellFormed = tags.filter((t) => SERVER_VERSION_TAG.test(t))
  if (wellFormed.length === 0) return null
  return wellFormed.reduce((best, tag) => (compareServerSemver(tag, best) > 0 ? tag : best))
}

/**
 * Pure: return the well-formed tags sorted newest → oldest by semver. Malformed
 * tags are dropped (see SERVER_VERSION_TAG) so the sort comparator never returns
 * NaN — keeping the order deterministic (FINDING 1).
 *
 * WHY this exists separately from pickLatestServerTag: the newest TAG is not
 * guaranteed to have a published RELEASE. server-latest.json lives on the
 * Release, not the tag — and a tag can exist with no Release (release CI still
 * running, or it failed after the tag was pushed). If we picked only the single
 * newest tag and its Release 404'd, discovery would abort and never consider the
 * latest *released* server-v*. So run() iterates this descending list, trying each
 * tag's Release in turn and stopping at the first 200. The engine's own
 * SHA-equality no-op prevents a downgrade if an older release is selected.
 *
 * Copies the input before sorting (Array.prototype.sort mutates in place) so the
 * function stays pure and the caller's array is untouched.
 */
export const sortServerTagsDesc = (tags: ReadonlyArray<string>): ReadonlyArray<string> =>
  tags.filter((t) => SERVER_VERSION_TAG.test(t)).sort((a, b) => compareServerSemver(b, a))

/**
 * Pure: parse and validate the matching-refs API response body.
 *
 * Extracted for testability — the impure fetchServerRefTags calls this. The API
 * can return a JSON object instead of an array when rate-limited even on a 200
 * (CDN edge cases); validating here keeps the type cast honest and ensures every
 * failure degrades through the same user-friendly error path.
 *
 * Returns an array of tag names with the "refs/tags/" prefix stripped, KEEPING
 * ONLY well-formed server-v<major.minor.patch> tags (see SERVER_VERSION_TAG).
 * Entries whose ref does not start with "refs/tags/", or whose stripped name is
 * not a well-formed version tag, are silently dropped. This is the single
 * choke-point that protects the (numeric, NaN-fragile) semver comparison from
 * malformed input.
 */
export const parseMatchingRefsBody = (body: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(body)) {
    throw new Error("GitHub returned an unexpected (non-array) matching-refs body")
  }
  const tags: string[] = []
  for (const entry of body) {
    if (typeof entry?.ref !== "string" || !entry.ref.startsWith("refs/tags/")) continue
    const tag = entry.ref.slice("refs/tags/".length)
    // Drop non-version refs (server-vnext, server-v, server-v-test, …) so the
    // numeric semver compare never sees a NaN-producing tag. See SERVER_VERSION_TAG.
    if (SERVER_VERSION_TAG.test(tag)) tags.push(tag)
  }
  return tags
}

/* -------------------------------------------------------------------------- */
/* Pure: SHA comparison                                                        */
/* -------------------------------------------------------------------------- */

export type CompareResult = "up-to-date" | "update-available" | "unknown"

/**
 * Pure: determine whether the running server is up to date relative to the
 * release targetSha.
 *
 * SHA matching is bidirectional prefix-match: either SHA may be a prefix of
 * the other. This handles the common situation where the server's /readyz
 * buildSha is a short git rev-parse (e.g. "ae44d29") while the release
 * targetSha may also be short or full. Prefix-in-either-direction avoids
 * false "update-available" when both shas refer to the same commit.
 *
 * Returns "unknown" when either sha is absent/empty — we cannot compare what
 * we cannot see, so we do not claim up-to-date (which could suppress a real
 * update) nor update-available (which could force an unnecessary restart).
 */
export const compareServerVersion = ({
  runningSha,
  targetSha,
}: {
  readonly runningSha: string | undefined
  readonly targetSha: string
}): CompareResult => {
  if (!runningSha || runningSha.length === 0) return "unknown"
  if (targetSha.length === 0) return "unknown"
  // Bidirectional prefix: either "ae44d29".startsWith("ae44d") or vice-versa
  if (targetSha.startsWith(runningSha) || runningSha.startsWith(targetSha)) {
    return "up-to-date"
  }
  return "update-available"
}

/* -------------------------------------------------------------------------- */
/* Pure: rendering                                                             */
/* -------------------------------------------------------------------------- */

export interface UpdateReport {
  readonly lines: ReadonlyArray<string>
  readonly exitCode: number
}

export type UpdatePlanInput =
  /** --check mode: no release published yet */
  | { readonly kind: "check-no-release" }
  /** --check mode: up to date */
  | { readonly kind: "check-up-to-date"; readonly tag: string; readonly sha: string }
  /** --check mode: update available (GitHub-discovered, SHA comparison possible) */
  | { readonly kind: "check-available"; readonly tag: string; readonly runningSha: string | undefined; readonly targetSha: string }
  /**
   * --check --ref mode: pinned ref reported without asserting "update available".
   * We have no release asset to compare against, so we cannot determine whether
   * the server is already at `ref`. We describe what *would* be applied rather
   * than falsely claiming an update is available.
   */
  | { readonly kind: "check-pinned"; readonly ref: string }
  /** --check mode: running sha unknown */
  | { readonly kind: "check-unknown"; readonly tag: string; readonly targetSha: string }
  /** --check mode: GitHub error while discovering */
  | { readonly kind: "check-github-error"; readonly detail: string }
  /** No server-v* release published yet (non-check path) */
  | { readonly kind: "no-release" }
  /** Running server is already at the target sha */
  | { readonly kind: "up-to-date"; readonly tag: string; readonly sha: string }
  /** Active sessions present; deferred */
  | { readonly kind: "deferred"; readonly count: number; readonly tag: string }
  /** Engine exit 0: updated and healthy */
  | { readonly kind: "applied-ok"; readonly targetSha: string }
  /** Engine exit 1: update failed, rolled back */
  | { readonly kind: "applied-rolled-back" }
  /** Engine exit 2: critical — update and rollback both failed */
  | { readonly kind: "applied-critical" }

/**
 * Pure: given a classified UpdatePlanInput, produce lines and an exit code.
 *
 * Exit codes:
 *   0 = success (up to date, check-only, deferred, no release yet)
 *   1 = update failed but server rolled back and is healthy
 *   2 = CRITICAL: update and rollback both failed; manual intervention needed
 *
 * No IO happens here — all output is returned as strings so tests can assert
 * on them without capturing stdout.
 */
export const renderUpdatePlan = (input: UpdatePlanInput): UpdateReport => {
  switch (input.kind) {
    case "check-no-release":
      return {
        lines: ["No server releases published yet (no server-v* tag)."],
        exitCode: 0,
      }

    case "check-up-to-date":
      return {
        lines: [`up to date at ${input.sha} (${input.tag})`],
        exitCode: 0,
      }

    case "check-available":
      return {
        lines: [
          `update available: ${input.tag} (${input.runningSha ?? "unknown"} -> ${input.targetSha})`,
        ],
        exitCode: 0,
      }

    case "check-pinned":
      return {
        lines: [
          `would apply pinned ref: ${input.ref} (cannot compare — no release metadata for this ref)`,
        ],
        exitCode: 0,
      }

    case "check-unknown":
      return {
        lines: [
          `[WARN] running server SHA unknown — cannot determine if update is needed`,
          `       latest release: ${input.tag} (${input.targetSha})`,
          `       run 'luna update' to apply or 'luna update --ref ${input.tag}' to pin`,
        ],
        exitCode: 0,
      }

    case "check-github-error":
      return {
        lines: [
          `[WARN] could not reach GitHub to check for updates: ${input.detail}`,
          `       run 'luna update --ref <tag>' to apply a pinned release without the API`,
        ],
        exitCode: 0,
      }

    case "no-release":
      return {
        lines: ["No server releases published yet (no server-v* tag)."],
        exitCode: 0,
      }

    case "up-to-date":
      return {
        lines: [`Server is up to date at ${input.sha} (${input.tag}).`],
        exitCode: 0,
      }

    case "deferred":
      return {
        lines: [
          `${input.count} active session(s) — not restarting mid-conversation. Re-run with --allow-active to update now.`,
        ],
        exitCode: 0,
      }

    case "applied-ok":
      return {
        lines: [`Updated. Server healthy at ${input.targetSha}.`],
        exitCode: 0,
      }

    case "applied-rolled-back":
      return {
        lines: ["Update failed — rolled back. Server running healthy."],
        exitCode: 1,
      }

    case "applied-critical":
      return {
        lines: ["CRITICAL: update failed AND rollback failed — manual intervention needed."],
        exitCode: 2,
      }
  }
}

/* -------------------------------------------------------------------------- */
/* Impure: probes and IO — quarantined here                                   */
/* -------------------------------------------------------------------------- */

const READYZ_TIMEOUT_MS = 3_000
const GITHUB_TIMEOUT_MS = 10_000
/**
 * Server-side prefix filter using the git refs API.
 *
 * WHY not /releases?per_page=100: that endpoint returns ALL tags (moon-v* and
 * server-v* interleaved) newest-first. Once the total tag count exceeds 100, a
 * server-v* release will fall off page 1 and `luna update` silently reports
 * "No server releases published yet" — a false negative. The moon release cadence
 * (multiple per week) means we hit that cliff within months.
 *
 * The git/matching-refs endpoint returns ONLY tags whose name starts with the
 * given prefix — no pagination, no interleaving, no cliff. It is the correct
 * primitive for "find all server-v* tags".
 */
const GITHUB_MATCHING_REFS_URL =
  "https://api.github.com/repos/fourcolors/luna/git/matching-refs/tags/server-v"

/**
 * Fetch a SPECIFIC release by tag name — no pagination risk.
 * We use this instead of /releases/latest because that endpoint is reserved for
 * the Moon client updater (Tauri/minisign). Disturbing it would silently break Moon.
 */
const GITHUB_RELEASE_BY_TAG_URL = (tag: string): string =>
  `https://api.github.com/repos/fourcolors/luna/releases/tags/${encodeURIComponent(tag)}`

/**
 * Parsed /readyz response fields we care about.
 *
 * Note: /readyz also carries `mode` ("normal"|"setup") but the CLI does not act
 * on it — the engine (luna-update-server) probes /readyz directly and enforces
 * the mode=normal gate before declaring readiness. Carrying `mode` here would
 * duplicate logic the engine already owns.
 */
interface ReadyzResult {
  readonly buildSha: string | undefined
  readonly serverVersion: string | undefined
}

/**
 * Probe the running server's /readyz endpoint.
 * Returns undefined when the server is unreachable (treated as "sha unknown").
 * A non-200 response also returns undefined — we don't crash on a stale server.
 *
 * Phase-1 scope: HTTP probe only (see module docblock for the WS-hello fallback
 * deferral rationale). When undefined is returned, the caller proceeds with
 * runningSha=undefined, comparison returns "unknown", and the engine is invoked
 * anyway — its own readiness gate and auto-rollback cover the failure path.
 */
const probeReadyz = async (port: number): Promise<ReadyzResult | undefined> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), READYZ_TIMEOUT_MS)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: controller.signal,
      redirect: "manual",
    })
    if (res.status !== 200) return undefined
    const body = (await res.json()) as {
      buildSha?: string
      serverVersion?: string
    }
    return {
      buildSha: typeof body.buildSha === "string" ? body.buildSha : undefined,
      serverVersion: typeof body.serverVersion === "string" ? body.serverVersion : undefined,
    }
  } catch {
    // Server unreachable, timed out, or parse error: not fatal, sha = unknown.
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Build the standard GitHub API request headers.
 * Extracted to avoid duplication between fetchServerRefTags and fetchReleaseByTag.
 */
const githubHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    "User-Agent": "luna-update",
    Accept: "application/vnd.github+json",
  }
  const token = process.env["GITHUB_TOKEN"]
  if (token !== undefined && token.length > 0) {
    headers["Authorization"] = `Bearer ${token}`
  }
  return headers
}

/**
 * Fetch all git refs whose name starts with "server-v" using the matching-refs API.
 * Returns an array of tag names (e.g. ["server-v0.1.0", "server-v0.10.0"]).
 *
 * This replaces the old fetchReleases + per_page=100 approach. The matching-refs
 * endpoint is prefix-filtered server-side, so the result contains ONLY server-v*
 * tags regardless of how many moon-v* tags exist. No pagination: the API returns
 * the complete list in one call.
 */
const fetchServerRefTags = async (): Promise<ReadonlyArray<string>> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(GITHUB_MATCHING_REFS_URL, {
      signal: controller.signal,
      headers: githubHeaders(),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`network error reaching GitHub: ${msg}`)
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 403) {
    throw new Error("GitHub rate limit (403) — set GITHUB_TOKEN or wait and retry")
  }
  if (res.status !== 200) {
    throw new Error(`GitHub API returned ${res.status}`)
  }

  const body: unknown = await res.json()
  return parseMatchingRefsBody(body)
}

/**
 * A 404 from the /releases/tags/:tag endpoint: the tag exists (matching-refs
 * returned it) but no Release has been published for it yet. This is NOT a
 * failure — it's the "release CI mid-run, or it failed after the tag push"
 * case — so run() catches THIS distinct type to skip to the next-newest tag,
 * while letting transient errors (403 rate limit, network, 5xx) propagate to the
 * graceful check-github-error / exit-1 path. A bare status check would conflate
 * "no release for this tag" with "GitHub is unreachable", which need opposite
 * handling: try-the-next-tag vs. degrade-gracefully.
 */
export class ReleaseNotFoundError extends Error {
  constructor(public readonly tag: string) {
    super(`no published release for tag ${tag}`)
    this.name = "ReleaseNotFoundError"
  }
}

/**
 * Fetch the release object for a specific tag.
 * Throws ReleaseNotFoundError on 404 (tag has no published Release — caller
 * should try the next tag); throws a user-friendly Error on network / rate-limit
 * / other non-200 (transient — caller should degrade gracefully).
 *
 * WHY a tag-specific fetch: once a server-v* tag has been selected by semver, we
 * need the full release object to find the server-latest.json asset URL. The
 * /releases/tags/:tag endpoint returns exactly that one release — no interleaving,
 * no pagination, no cliff.
 */
const fetchReleaseByTag = async (tag: string): Promise<GithubRelease> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(GITHUB_RELEASE_BY_TAG_URL(tag), {
      signal: controller.signal,
      headers: githubHeaders(),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`network error reaching GitHub: ${msg}`)
  } finally {
    clearTimeout(timer)
  }

  // 404 = tag exists but no Release yet — a recoverable "try the next tag" signal,
  // NOT a transient API failure. Distinguish it before the generic non-200 throw.
  if (res.status === 404) {
    throw new ReleaseNotFoundError(tag)
  }
  if (res.status === 403) {
    throw new Error("GitHub rate limit (403) — set GITHUB_TOKEN or wait and retry")
  }
  if (res.status !== 200) {
    throw new Error(`GitHub API returned ${res.status}`)
  }

  return (await res.json()) as GithubRelease
}

/**
 * Resolve the newest server-v* tag that actually has a published Release.
 *
 * Iterates `sortedTagsDesc` (newest → oldest), fetching each tag's Release via
 * the injected `fetchRelease`. The FIRST tag that resolves (200) wins and is
 * returned with its release object. A ReleaseNotFoundError (404) for a tag means
 * "release pending/missing for THIS tag" → skip to the next candidate. ANY OTHER
 * error (403 rate limit, network, 5xx) is transient and unrelated to release
 * presence, so it propagates immediately for the caller's graceful-degrade path
 * (we must NOT mask a rate limit as "no releases"). When every candidate 404s,
 * returns null → the caller renders the existing "No server releases published
 * yet" exit-0 path.
 *
 * `fetchRelease` is injected (rather than calling fetchReleaseByTag directly) so
 * this resolution loop is unit-testable with a mock — no real network in tests.
 *
 * WHY iterate instead of pick-one: the newest TAG may have no Release (CI mid-run
 * or failed post-tag). Picking only the top tag and aborting on its 404 would hide
 * the latest *released* version. The engine's SHA-equality no-op prevents any
 * downgrade if an older-but-released tag is selected.
 */
export const resolveLatestReleasedTag = async (
  sortedTagsDesc: ReadonlyArray<string>,
  fetchRelease: (tag: string) => Promise<GithubRelease>,
): Promise<{ readonly tag: string; readonly release: GithubRelease } | null> => {
  for (const tag of sortedTagsDesc) {
    try {
      const release = await fetchRelease(tag)
      return { tag, release }
    } catch (e) {
      if (e instanceof ReleaseNotFoundError) continue // no Release for this tag yet — try older
      throw e // transient (403/network/5xx) — let the caller degrade gracefully
    }
  }
  return null // every candidate tag lacked a published Release
}

/**
 * Fetch and parse the server-latest.json asset from a release.
 * Throws with a user-friendly message if the asset is missing or malformed.
 */
const fetchServerLatestJson = async (release: GithubRelease): Promise<ServerLatestJson> => {
  const asset = release.assets.find((a) => a.name === "server-latest.json")
  if (asset === undefined) {
    throw new Error(
      `release ${release.tag_name} has no server-latest.json asset — malformed release`,
    )
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(asset.browser_download_url, { signal: controller.signal })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`could not download server-latest.json: ${msg}`)
  } finally {
    clearTimeout(timer)
  }
  if (res.status !== 200) {
    throw new Error(`server-latest.json download returned ${res.status}`)
  }
  // Cast to a wider type so we can validate each field we care about.
  // `version` is present in the asset but not carried forward — see ServerLatestJson.
  const body = (await res.json()) as { version?: unknown; tag?: unknown; targetSha?: unknown }
  if (
    typeof body.version !== "string" ||
    typeof body.tag !== "string" ||
    typeof body.targetSha !== "string"
  ) {
    throw new Error("server-latest.json is missing required fields (version, tag, targetSha)")
  }
  // We validate `version` above (guards against a malformed asset) but do not
  // store it — `tag` already encodes the version string unambiguously.
  return { tag: body.tag, targetSha: body.targetSha }
}

/**
 * Query the count of active WebSocket sessions by sourcing the shared
 * luna_active_ws_count shell function from scripts/lib/luna-deploy.sh.
 *
 * We shell out rather than reimplement ss(8) counting in TypeScript:
 *   - One implementation to audit (PRD §3.4, §G5).
 *   - The shell function already handles the Incus/container case, the
 *     LUNA_TEST_WS_COUNT test seam, and platform-specific ss invocations.
 *
 * Returns undefined when the subprocess errors or the output cannot be parsed
 * as an integer. The caller treats undefined as "unknown" and proceeds with a
 * warning — see the WARN-and-proceed rationale in the module docblock.
 */
const queryActiveSessionCount = (repoDir: string, port: number): number | undefined => {
  // Pass repoDir and port via positional argv ($1, $2) rather than interpolating them
  // into the -c string. String interpolation inside double-quoted bash -c content would
  // allow a repoDir containing quotes to break out of the quoting context. This is not
  // a meaningful security boundary (an operator supplying --repo-dir controls the host),
  // but it is a correctness issue for legitimate paths with unusual characters, and the
  // argv form is unambiguously safer and equally readable.
  const result = spawnSync(
    "bash",
    [
      "-c",
      'source "$1/scripts/lib/luna-deploy.sh" && luna_active_ws_count "$2"',
      "bash",       // $0 (bash sets $0 from this, unused)
      repoDir,      // $1
      String(port), // $2
    ],
    { encoding: "utf8", timeout: 5_000 },
  )
  if (result.status !== 0 || result.error !== undefined) return undefined
  const n = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Pure: build the argv array for scripts/luna-update-server.
 *
 * Extracted from the impure applyUpdate() so the flag→engine mapping can be
 * unit-tested without spawning a subprocess. The first element is the script
 * path (argv[0]); the rest are flags. Callers pass args[0] to spawnSync as
 * the executable and args.slice(1) as the flag list.
 *
 * Flags emitted:
 *   --ref <ref>              the git ref / tag to apply
 *   --repo-dir <repoDir>     absolute path to the repo clone
 *   --readiness-port <port>  port the engine probes on /healthz + /readyz
 *   --dry-run                (conditional) passed only when dryRun is true
 */
export const buildEngineArgs = (
  repoDir: string,
  ref: string,
  port: number,
  dryRun: boolean,
): readonly string[] => {
  const args: string[] = [
    `${repoDir}/scripts/luna-update-server`,
    "--ref", ref,
    "--repo-dir", repoDir,
    "--readiness-port", String(port),
  ]
  if (dryRun) args.push("--dry-run")
  return args
}

/**
 * Pure: build the "current: <sha>" or "[WARN] unreachable" header line that is
 * written to stdout after probing /readyz. Returns undefined when --check mode
 * is active (no header is printed in check mode).
 *
 * Extracted from run() so the exact stdout strings can be unit-tested without
 * capturing process.stdout — the coverage gap that let the ${port} interpolation
 * bug (double-quoted string, not template literal) go undetected.
 */
export const buildCurrentHeader = (
  runningSha: string | undefined,
  serverVersion: string | undefined,
  port: number,
  isCheck: boolean,
): string | undefined => {
  if (isCheck) return undefined
  if (runningSha !== undefined) {
    const versionSuffix = serverVersion !== undefined ? ` (${serverVersion})` : ""
    return `  current: ${runningSha}${versionSuffix}\n`
  }
  return `  [WARN] server unreachable on port ${port} — SHA unknown\n`
}

/**
 * Pure: map the engine exit code to an UpdatePlanInput that renderUpdatePlan
 * can render. Extracted from run() so the mapping can be unit-tested without
 * spawning a subprocess — the same rationale that motivated extracting
 * buildEngineArgs and buildCurrentHeader.
 *
 * The `targetSha` parameter is the release's targetSha (used for the applied-ok
 * message). It is the ref itself when --ref was provided (pinned path), or the
 * JSON asset's targetSha on the GitHub-discovery path.
 *
 * Engine exit-code contract (from scripts/luna-update-server):
 *   0 = update applied, server healthy
 *   1 = update failed, rolled back, server running healthy
 *   2 = CRITICAL: update AND rollback both failed; manual intervention needed
 *   null / unexpected = spawnSync could not start the process (ENOENT etc.);
 *     applyUpdate maps null → 2 before calling us, so we treat ≥2 as critical.
 */
export const classifyEngineExit = (
  exitCode: number,
  targetSha: string,
): UpdatePlanInput => {
  if (exitCode === 0) return { kind: "applied-ok", targetSha }
  if (exitCode === 1) return { kind: "applied-rolled-back" }
  return { kind: "applied-critical" }
}

/**
 * Invoke scripts/luna-update-server with inherited stdio so the operator sees
 * the stop/settle/start/readiness progress live. Returns the engine exit code.
 */
const applyUpdate = (
  repoDir: string,
  ref: string,
  port: number,
  dryRun: boolean,
): number => {
  const args = buildEngineArgs(repoDir, ref, port, dryRun)

  const result = spawnSync(args[0]!, args.slice(1), {
    stdio: "inherit",
    encoding: "utf8",
    // No timeout: the engine manages its own settle + readiness window (can run
    // 30-60s). Imposing a TS-side timeout would race against a valid slow start.
  })
  // spawnSync returns status=null when the process could not be started (ENOENT
  // etc.). Map null to exit-2 (critical) so the caller emits the intervention msg.
  return result.status ?? 2
}

/** Write all lines then flush stdout before process.exit() (mirrors doctor.ts). */
const writeAndExit = async (report: UpdateReport): Promise<never> => {
  const output = report.lines.map((l) => `${l}\n`).join("")
  await new Promise<void>((resolve) => {
    process.stdout.write(output, () => resolve())
  })
  process.exit(report.exitCode)
}

/* -------------------------------------------------------------------------- */
/* citty command                                                               */
/* -------------------------------------------------------------------------- */

export const updateCommand = defineCommand({
  meta: {
    name: "update",
    description:
      "Check for and apply server-v* releases. Runs on the server host (cwd = repo root). Phase-1: system-unit installs only (targets the default 'stable' system unit luna-chat-server.service). Non-default profiles and macOS launchd are Phase 2.",
  },
  args: {
    check: {
      type: "boolean",
      description: "Print update status and exit 0 without applying anything",
    },
    "allow-active": {
      type: "boolean",
      description: "Apply even when active WebSocket sessions are present",
    },
    force: {
      type: "boolean",
      description: "Alias for --allow-active (proceed despite active sessions)",
    },
    "dry-run": {
      type: "boolean",
      description: "Pass --dry-run to the update engine: plan without applying",
    },
    ref: {
      type: "string",
      description:
        "Pin an exact git ref / tag to apply (skips GitHub API; air-gapped escape hatch)",
    },
    port: {
      type: "string",
      description: "Server readiness port (default 4753)",
    },
    "repo-dir": {
      type: "string",
      description: "Path to the cloned repo (default: process.cwd())",
    },
  },

  async run({ args }) {
    const port = args.port !== undefined ? Number.parseInt(args.port, 10) : 4_753
    // Guard against `--port abc` or `--port 0` or `--port 99999` before the value
    // propagates to http://127.0.0.1:NaN/readyz or the engine --readiness-port flag.
    // queryActiveSessionCount already guards its own parseInt with Number.isFinite
    // (line ~410); this is the operator-facing entry point for the same value.
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      process.stderr.write(`Error: --port must be a valid port number (1-65535), got: ${args.port}\n`)
      process.exit(1)
    }
    const repoDir = args["repo-dir"] ?? process.cwd()
    const isCheck = args.check === true
    const allowActive = args["allow-active"] === true || args.force === true
    const dryRun = args["dry-run"] === true
    const pinnedRef = args.ref

    // -------------------------------------------------------------------------
    // Step 1: probe the running server (/readyz, ~3s timeout, tolerates failure)
    // -------------------------------------------------------------------------
    if (!isCheck) {
      process.stdout.write("Checking for updates…\n")
    }

    const readyz = await probeReadyz(port)
    const runningSha = readyz?.buildSha

    const currentHeader = buildCurrentHeader(runningSha, readyz?.serverVersion, port, isCheck)
    if (currentHeader !== undefined) {
      process.stdout.write(currentHeader)
    }

    // -------------------------------------------------------------------------
    // Step 2: discover latest release
    //   If --ref given: use it directly (no GitHub API call).
    //   Else: fetch releases, filter server-v*, pick newest, fetch its JSON.
    // -------------------------------------------------------------------------

    if (pinnedRef !== undefined) {
      // Air-gapped / pinned path: skip GitHub, skip SHA no-op check (we have no
      // targetSha from the asset), and go straight to apply or check-report.
      if (isCheck) {
        // --check + --ref: report what would be applied, but do NOT assert
        // "update available" — we have no release asset to compare SHAs against.
        return writeAndExit(renderUpdatePlan({ kind: "check-pinned", ref: pinnedRef }))
      }
      // Defer check (skipped when --dry-run: a dry-run touches nothing, so it is
      // always safe to let the engine print its plan even during an active session)
      if (!allowActive && !dryRun) {
        const count = queryActiveSessionCount(repoDir, port)
        if (count === undefined) {
          process.stderr.write(
            "[WARN] could not determine active session count — proceeding anyway\n",
          )
        } else if (count > 0) {
          return writeAndExit(renderUpdatePlan({ kind: "deferred", count, tag: pinnedRef }))
        }
      }
      // Apply
      const engineExit = applyUpdate(repoDir, pinnedRef, port, dryRun)
      return writeAndExit(renderUpdatePlan(classifyEngineExit(engineExit, pinnedRef)))
    }

    // GitHub discovery path — three-step: refs → semver-pick → release-by-tag

    // Step 1: fetch all server-v* tag names from the matching-refs API.
    // This endpoint is prefix-filtered server-side: moon-v* tags never appear,
    // so there is no page-size cliff regardless of total tag count.
    let serverTags: ReadonlyArray<string>
    try {
      serverTags = await fetchServerRefTags()
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      if (isCheck) {
        // --check on GitHub error: warn but exit 0 (do not block scripting)
        return writeAndExit(renderUpdatePlan({ kind: "check-github-error", detail }))
      }
      // Apply path: GitHub failure is a real error since we can't know the ref
      process.stderr.write(`Error: ${detail}\n`)
      process.exit(1)
    }

    // Step 2: sort newest → oldest by semver (numeric — avoids "0.9.0" > "0.10.0" trap).
    // We sort the WHOLE list (not just pick the max) because the newest tag may not
    // have a published Release yet; step 3 walks candidates until one resolves.
    const sortedTags = sortServerTagsDesc(serverTags)
    if (sortedTags.length === 0) {
      return writeAndExit(
        renderUpdatePlan({ kind: isCheck ? "check-no-release" : "no-release" }),
      )
    }

    // Step 3: resolve the newest tag that actually has a published Release. A 404
    // for the newest tag (release CI mid-run, or failed post-tag) skips to the next
    // candidate; a transient error (403/network) propagates to the graceful path.
    let resolved: { readonly tag: string; readonly release: GithubRelease } | null
    try {
      resolved = await resolveLatestReleasedTag(sortedTags, fetchReleaseByTag)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      if (isCheck) {
        return writeAndExit(renderUpdatePlan({ kind: "check-github-error", detail }))
      }
      process.stderr.write(`Error: ${detail}\n`)
      process.exit(1)
    }

    // Every candidate tag lacked a published Release — the newest *released*
    // server-v does not exist yet. Same UX as "no server-v* tag at all".
    if (resolved === null) {
      return writeAndExit(
        renderUpdatePlan({ kind: isCheck ? "check-no-release" : "no-release" }),
      )
    }
    const latestRelease = resolved.release

    // Step 4: fetch the server-latest.json asset to get the canonical targetSha
    let latestJson: ServerLatestJson
    try {
      latestJson = await fetchServerLatestJson(latestRelease)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      if (isCheck) {
        return writeAndExit(renderUpdatePlan({ kind: "check-github-error", detail }))
      }
      process.stderr.write(`Error: ${detail}\n`)
      process.exit(1)
    }

    const { tag, targetSha } = latestJson

    // -------------------------------------------------------------------------
    // Step 3: compare
    // -------------------------------------------------------------------------
    const comparison = compareServerVersion({ runningSha, targetSha })

    if (isCheck) {
      // --check: report and exit 0; never apply
      if (comparison === "up-to-date") {
        return writeAndExit(renderUpdatePlan({ kind: "check-up-to-date", tag, sha: runningSha! }))
      } else if (comparison === "unknown") {
        return writeAndExit(renderUpdatePlan({ kind: "check-unknown", tag, targetSha }))
      } else {
        return writeAndExit(
          renderUpdatePlan({ kind: "check-available", tag, runningSha, targetSha }),
        )
      }
    }

    // -------------------------------------------------------------------------
    // Step 4: non-check path — act on comparison result
    // -------------------------------------------------------------------------

    if (comparison === "up-to-date") {
      return writeAndExit(
        renderUpdatePlan({ kind: "up-to-date", tag, sha: runningSha! }),
      )
    }

    // comparison === "update-available" OR "unknown" (proceed to apply; unknown
    // means we cannot prove up-to-date, so we let the engine decide)
    if (!isCheck) {
      process.stdout.write(`${tag} available (${runningSha ?? "unknown"} -> ${targetSha})\n`)
    }

    // -------------------------------------------------------------------------
    // Step 5: connect-aware defer
    //
    // Skipped when --dry-run: the engine's --dry-run routes all actions through
    // luna_run in print-only mode — no service is stopped or restarted — so a
    // dry-run is always safe to execute during an active session. Blocking it
    // prevents the operator from previewing the update plan mid-conversation,
    // which is the one operation that is most useful in that window.
    // -------------------------------------------------------------------------
    if (!allowActive && !dryRun) {
      const count = queryActiveSessionCount(repoDir, port)
      if (count === undefined) {
        // Cannot determine session count. WARN and proceed rather than blocking.
        // The engine has its own readiness gate and auto-rollback safety net;
        // failing here on a tooling problem (missing ss, wrong repoDir) would
        // prevent legitimate updates without adding safety.
        process.stderr.write(
          "[WARN] could not determine active session count — proceeding anyway\n",
        )
      } else if (count > 0) {
        return writeAndExit(renderUpdatePlan({ kind: "deferred", count, tag }))
      }
    }

    // -------------------------------------------------------------------------
    // Step 6: apply
    // -------------------------------------------------------------------------
    const engineExit = applyUpdate(repoDir, tag, port, dryRun)
    return writeAndExit(renderUpdatePlan(classifyEngineExit(engineExit, targetSha)))
  },
})
