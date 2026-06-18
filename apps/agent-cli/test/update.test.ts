import { describe, expect, it } from "vitest"
import {
  buildCurrentHeader,
  buildEngineArgs,
  classifyEngineExit,
  compareServerVersion,
  type GithubRelease,
  pickLatestServerRelease,
  renderUpdatePlan,
} from "../src/commands/update.js"

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const makeRelease = (overrides: Partial<GithubRelease> = {}): GithubRelease => ({
  tag_name: "server-v0.1.0",
  draft: false,
  assets: [
    {
      name: "server-latest.json",
      browser_download_url: "https://github.com/fourcolors/luna/releases/download/server-v0.1.0/server-latest.json",
    },
  ],
  ...overrides,
})

/* -------------------------------------------------------------------------- */
/* pickLatestServerRelease                                                    */
/* -------------------------------------------------------------------------- */

describe("pickLatestServerRelease (pure)", () => {
  it("returns null when the list is empty", () => {
    expect(pickLatestServerRelease([])).toBeNull()
  })

  it("returns null when no server-v* release exists (moon-only releases)", () => {
    const releases: GithubRelease[] = [
      makeRelease({ tag_name: "moon-v0.0.36" }),
      makeRelease({ tag_name: "moon-v0.0.35" }),
    ]
    expect(pickLatestServerRelease(releases)).toBeNull()
  })

  it("returns null when the only server-v* release is a draft", () => {
    const releases: GithubRelease[] = [makeRelease({ tag_name: "server-v0.1.0", draft: true })]
    expect(pickLatestServerRelease(releases)).toBeNull()
  })

  it("ignores draft server-v* releases and picks the next non-draft", () => {
    const releases: GithubRelease[] = [
      makeRelease({ tag_name: "server-v0.2.0", draft: true }),
      makeRelease({ tag_name: "server-v0.1.0", draft: false }),
    ]
    const result = pickLatestServerRelease(releases)
    expect(result).not.toBeNull()
    expect(result!.tag_name).toBe("server-v0.1.0")
  })

  it("picks the first (newest, per GitHub API contract) non-draft server-v* release", () => {
    const releases: GithubRelease[] = [
      makeRelease({ tag_name: "moon-v0.0.36" }),          // not server-v*: skip
      makeRelease({ tag_name: "server-v0.3.0" }),          // newest server-v*: pick
      makeRelease({ tag_name: "server-v0.2.0" }),
      makeRelease({ tag_name: "server-v0.1.0" }),
    ]
    const result = pickLatestServerRelease(releases)
    expect(result!.tag_name).toBe("server-v0.3.0")
  })

  it("ignores moon-v* tags even when they appear before server-v* tags", () => {
    const releases: GithubRelease[] = [
      makeRelease({ tag_name: "moon-v0.0.36" }),
      makeRelease({ tag_name: "moon-v0.0.35" }),
      makeRelease({ tag_name: "server-v0.1.0" }),
    ]
    const result = pickLatestServerRelease(releases)
    expect(result!.tag_name).toBe("server-v0.1.0")
  })

  it("treats a pre-release server-v* as a valid pick (only drafts are excluded)", () => {
    const releases: GithubRelease[] = [
      makeRelease({ tag_name: "server-v0.2.0-rc.1", draft: false }),
    ]
    expect(pickLatestServerRelease(releases)?.tag_name).toBe("server-v0.2.0-rc.1")
  })

  it("returns the picked release with its full assets array intact", () => {
    const release = makeRelease({ tag_name: "server-v0.1.0" })
    const result = pickLatestServerRelease([release])
    expect(result).toStrictEqual(release)
  })
})

/* -------------------------------------------------------------------------- */
/* compareServerVersion                                                        */
/* -------------------------------------------------------------------------- */

describe("compareServerVersion (pure)", () => {
  it("returns 'up-to-date' when runningSha is a prefix of targetSha", () => {
    // Server returns a short SHA (7 chars); release has a longer one
    expect(compareServerVersion({ runningSha: "ae44d29", targetSha: "ae44d29f73b" })).toBe(
      "up-to-date",
    )
  })

  it("returns 'up-to-date' when targetSha is a prefix of runningSha (bidirectional)", () => {
    // Release has a shorter targetSha; server has a longer buildSha
    expect(compareServerVersion({ runningSha: "ae44d29f73b1a2", targetSha: "ae44d29" })).toBe(
      "up-to-date",
    )
  })

  it("returns 'up-to-date' when both shas are identical", () => {
    expect(compareServerVersion({ runningSha: "ae44d29", targetSha: "ae44d29" })).toBe(
      "up-to-date",
    )
  })

  it("returns 'update-available' when the SHAs differ", () => {
    expect(compareServerVersion({ runningSha: "ae44d29", targetSha: "f73b1a2" })).toBe(
      "update-available",
    )
  })

  it("returns 'update-available' when SHAs share a common length but differ", () => {
    // Same length, different content — not a prefix in either direction
    expect(compareServerVersion({ runningSha: "ae44d29", targetSha: "ae44d30" })).toBe(
      "update-available",
    )
  })

  it("returns 'unknown' when runningSha is undefined", () => {
    expect(compareServerVersion({ runningSha: undefined, targetSha: "ae44d29" })).toBe("unknown")
  })

  it("returns 'unknown' when runningSha is an empty string", () => {
    expect(compareServerVersion({ runningSha: "", targetSha: "ae44d29" })).toBe("unknown")
  })

  it("returns 'unknown' when targetSha is empty (defensive; should not occur in practice)", () => {
    expect(compareServerVersion({ runningSha: "ae44d29", targetSha: "" })).toBe("unknown")
  })
})

/* -------------------------------------------------------------------------- */
/* renderUpdatePlan                                                            */
/* -------------------------------------------------------------------------- */

describe("renderUpdatePlan (pure)", () => {
  // --- --check branch ---

  it("check-no-release: prints informative message, exits 0", () => {
    const r = renderUpdatePlan({ kind: "check-no-release" })
    expect(r.exitCode).toBe(0)
    expect(r.lines.join("\n")).toContain("No server releases published yet")
  })

  it("check-up-to-date: shows sha + tag, exits 0", () => {
    const r = renderUpdatePlan({ kind: "check-up-to-date", tag: "server-v0.1.0", sha: "ae44d29" })
    expect(r.exitCode).toBe(0)
    const text = r.lines.join("\n")
    expect(text).toContain("up to date")
    expect(text).toContain("ae44d29")
    expect(text).toContain("server-v0.1.0")
  })

  it("check-available: shows tag + sha transition, exits 0", () => {
    const r = renderUpdatePlan({
      kind: "check-available",
      tag: "server-v0.2.0",
      runningSha: "ae44d29",
      targetSha: "f73b1a2",
    })
    expect(r.exitCode).toBe(0)
    const text = r.lines.join("\n")
    expect(text).toContain("update available")
    expect(text).toContain("server-v0.2.0")
    expect(text).toContain("ae44d29")
    expect(text).toContain("f73b1a2")
  })

  it("check-available with unknown runningSha: shows 'unknown' for the from-sha, exits 0", () => {
    const r = renderUpdatePlan({
      kind: "check-available",
      tag: "server-v0.2.0",
      runningSha: undefined,
      targetSha: "f73b1a2",
    })
    expect(r.exitCode).toBe(0)
    const text = r.lines.join("\n")
    expect(text).toContain("unknown")
    expect(text).toContain("f73b1a2")
  })

  it("check-unknown: warns about unresolvable SHA, exits 0 (not an error)", () => {
    const r = renderUpdatePlan({ kind: "check-unknown", tag: "server-v0.2.0", targetSha: "f73b1a2" })
    expect(r.exitCode).toBe(0)
    const text = r.lines.join("\n")
    expect(text).toContain("WARN")
    expect(text).toContain("server-v0.2.0")
    expect(text).toContain("f73b1a2")
  })

  it("check-github-error: warns and suggests --ref escape hatch, exits 0", () => {
    const r = renderUpdatePlan({ kind: "check-github-error", detail: "rate limit (403)" })
    expect(r.exitCode).toBe(0)
    const text = r.lines.join("\n")
    expect(text).toContain("WARN")
    expect(text).toContain("rate limit (403)")
    expect(text).toContain("--ref")
  })

  // --- non-check branch ---

  it("no-release: prints 'No server releases published yet', exits 0", () => {
    const r = renderUpdatePlan({ kind: "no-release" })
    expect(r.exitCode).toBe(0)
    expect(r.lines.join("\n")).toContain("No server releases published yet")
  })

  it("up-to-date: shows sha + tag, exits 0", () => {
    const r = renderUpdatePlan({ kind: "up-to-date", tag: "server-v0.1.0", sha: "ae44d29" })
    expect(r.exitCode).toBe(0)
    const text = r.lines.join("\n")
    expect(text).toContain("up to date")
    expect(text).toContain("ae44d29")
    expect(text).toContain("server-v0.1.0")
  })

  it("deferred: shows session count + --allow-active hint, exits 0 (defer = success)", () => {
    const r = renderUpdatePlan({ kind: "deferred", count: 3, tag: "server-v0.2.0" })
    // Deferred is success: operator chose not to interrupt a live session.
    expect(r.exitCode).toBe(0)
    const text = r.lines.join("\n")
    expect(text).toContain("3 active session(s)")
    expect(text).toContain("--allow-active")
  })

  it("deferred with 1 session: grammatically consistent message", () => {
    const r = renderUpdatePlan({ kind: "deferred", count: 1, tag: "server-v0.2.0" })
    expect(r.exitCode).toBe(0)
    expect(r.lines.join("\n")).toContain("1 active session(s)")
  })

  it("applied-ok: shows targetSha, exits 0", () => {
    const r = renderUpdatePlan({ kind: "applied-ok", targetSha: "f73b1a2" })
    expect(r.exitCode).toBe(0)
    const text = r.lines.join("\n")
    expect(text).toContain("Updated")
    expect(text).toContain("f73b1a2")
  })

  it("applied-rolled-back: clear rollback message, exits 1", () => {
    const r = renderUpdatePlan({ kind: "applied-rolled-back" })
    expect(r.exitCode).toBe(1)
    const text = r.lines.join("\n")
    expect(text).toContain("rolled back")
    expect(text).toContain("running healthy")
  })

  it("applied-critical: intervention message, exits 2", () => {
    const r = renderUpdatePlan({ kind: "applied-critical" })
    expect(r.exitCode).toBe(2)
    const text = r.lines.join("\n")
    expect(text).toContain("CRITICAL")
    expect(text).toContain("manual intervention")
  })

  // --- exit code contract ---

  it("exit code 0 for every non-error path", () => {
    const exitZeroCases = [
      renderUpdatePlan({ kind: "check-no-release" }),
      renderUpdatePlan({ kind: "check-up-to-date", tag: "server-v0.1.0", sha: "abc" }),
      renderUpdatePlan({ kind: "check-available", tag: "server-v0.2.0", runningSha: "abc", targetSha: "def" }),
      renderUpdatePlan({ kind: "check-unknown", tag: "server-v0.2.0", targetSha: "def" }),
      renderUpdatePlan({ kind: "check-github-error", detail: "network error" }),
      renderUpdatePlan({ kind: "no-release" }),
      renderUpdatePlan({ kind: "up-to-date", tag: "server-v0.1.0", sha: "abc" }),
      renderUpdatePlan({ kind: "deferred", count: 2, tag: "server-v0.2.0" }),
      renderUpdatePlan({ kind: "applied-ok", targetSha: "def" }),
    ]
    for (const r of exitZeroCases) {
      expect(r.exitCode).toBe(0)
    }
  })

  it("applied-rolled-back exits 1 (not 0, not 2)", () => {
    expect(renderUpdatePlan({ kind: "applied-rolled-back" }).exitCode).toBe(1)
  })

  it("applied-critical exits 2 (max severity)", () => {
    expect(renderUpdatePlan({ kind: "applied-critical" }).exitCode).toBe(2)
  })

  // --- check-pinned (--check --ref) ---

  it("check-pinned: describes what would be applied, does NOT assert update available, exits 0", () => {
    const r = renderUpdatePlan({ kind: "check-pinned", ref: "server-v0.1.0" })
    expect(r.exitCode).toBe(0)
    const text = r.lines.join("\n")
    // Must name the ref
    expect(text).toContain("server-v0.1.0")
    // Must NOT claim an update is "available" — we cannot compare without an asset
    expect(text).not.toContain("update available")
    // Must communicate that comparison is not possible
    expect(text).toContain("cannot compare")
  })

  it("check-pinned exits 0 (never blocks scripting)", () => {
    expect(renderUpdatePlan({ kind: "check-pinned", ref: "server-v0.2.0-rc.1" }).exitCode).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* buildEngineArgs (pure)                                                      */
/* -------------------------------------------------------------------------- */

describe("buildEngineArgs (pure)", () => {
  it("produces the correct argv[0] (script path)", () => {
    const args = buildEngineArgs("/srv/luna", "server-v0.1.0", 4753, false)
    expect(args[0]).toBe("/srv/luna/scripts/luna-update-server")
  })

  it("includes --ref with the supplied ref", () => {
    const args = buildEngineArgs("/srv/luna", "server-v0.1.0", 4753, false)
    const refIdx = args.indexOf("--ref")
    expect(refIdx).toBeGreaterThan(-1)
    expect(args[refIdx + 1]).toBe("server-v0.1.0")
  })

  it("includes --repo-dir with the supplied repoDir", () => {
    const args = buildEngineArgs("/srv/luna", "server-v0.1.0", 4753, false)
    const idx = args.indexOf("--repo-dir")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe("/srv/luna")
  })

  it("includes --readiness-port as a string-encoded integer", () => {
    const args = buildEngineArgs("/srv/luna", "server-v0.1.0", 4753, false)
    const idx = args.indexOf("--readiness-port")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe("4753")
  })

  it("omits --dry-run when dryRun is false", () => {
    const args = buildEngineArgs("/srv/luna", "server-v0.1.0", 4753, false)
    expect(args).not.toContain("--dry-run")
  })

  it("appends --dry-run when dryRun is true", () => {
    const args = buildEngineArgs("/srv/luna", "server-v0.1.0", 4753, true)
    expect(args).toContain("--dry-run")
  })

  it("uses the custom port value in --readiness-port", () => {
    const args = buildEngineArgs("/srv/luna", "server-v0.1.0", 9000, false)
    const idx = args.indexOf("--readiness-port")
    expect(args[idx + 1]).toBe("9000")
  })

  it("uses a non-default ref (e.g. a short sha or branch)", () => {
    const args = buildEngineArgs("/opt/luna", "abc1234", 4753, false)
    const refIdx = args.indexOf("--ref")
    expect(args[refIdx + 1]).toBe("abc1234")
    expect(args[1]).toBe("--ref") // ref is the first flag after the script path
  })

  it("does not include --profile or --service-name (Phase-1 scope)", () => {
    // Phase-1 always drives the engine's default stable profile.
    // If these flags appeared the test would catch an unintended scope expansion.
    const args = buildEngineArgs("/srv/luna", "server-v0.1.0", 4753, false)
    expect(args).not.toContain("--profile")
    expect(args).not.toContain("--service-name")
  })

  it("--dry-run is forwarded to engine regardless of session state (defer-bypass contract)", () => {
    // The connect-aware defer is skipped when dryRun=true — a dry-run touches
    // nothing (luna_run print-only mode) so it is always safe mid-session.
    // This test asserts the mechanism: buildEngineArgs forwards --dry-run so the
    // engine receives the flag and routes through its print-only path.
    const dryArgs = buildEngineArgs("/srv/luna", "server-v0.1.0", 4753, true)
    expect(dryArgs).toContain("--dry-run")
    // Confirm that the non-dry-run invocation does NOT inject it (sanity-check
    // the dryRun=false branch so a future refactor can't silently always-add it).
    const normalArgs = buildEngineArgs("/srv/luna", "server-v0.1.0", 4753, false)
    expect(normalArgs).not.toContain("--dry-run")
  })
})

/* -------------------------------------------------------------------------- */
/* buildCurrentHeader (pure)                                                  */
/* -------------------------------------------------------------------------- */

describe("buildCurrentHeader (pure)", () => {
  it("returns undefined in --check mode (no header printed during check)", () => {
    expect(buildCurrentHeader("ae44d29", undefined, 4753, true)).toBeUndefined()
    expect(buildCurrentHeader(undefined, undefined, 4753, true)).toBeUndefined()
  })

  it("returns the 'current: <sha>' line when sha is known and not in check mode", () => {
    const header = buildCurrentHeader("ae44d29", undefined, 4753, false)
    expect(header).toBeDefined()
    expect(header).toContain("current: ae44d29")
  })

  it("appends the serverVersion in parentheses when present", () => {
    const header = buildCurrentHeader("ae44d29", "0.1.0", 4753, false)
    expect(header).toBeDefined()
    expect(header).toContain("current: ae44d29 (0.1.0)")
  })

  it("omits the version suffix when serverVersion is undefined", () => {
    const header = buildCurrentHeader("ae44d29", undefined, 4753, false)
    expect(header).toBeDefined()
    expect(header).toContain("current: ae44d29")
    expect(header).not.toContain("(")
  })

  it("returns the [WARN] unreachable line with the actual port when sha is undefined", () => {
    // This is the exact regression test for the line-488 ${port} bug:
    // previously the string was double-quoted, so ${port} was printed literally.
    const header = buildCurrentHeader(undefined, undefined, 4753, false)
    expect(header).toBeDefined()
    expect(header).toContain("4753")
    expect(header).toContain("[WARN]")
    expect(header).toContain("unreachable")
    expect(header).not.toContain("${port}")
  })

  it("interpolates a non-default port correctly in the WARN line", () => {
    const header = buildCurrentHeader(undefined, undefined, 9000, false)
    expect(header).toContain("9000")
    expect(header).not.toContain("${port}")
  })

  it("the WARN line ends with a newline (ready for process.stdout.write)", () => {
    const header = buildCurrentHeader(undefined, undefined, 4753, false)
    expect(header?.endsWith("\n")).toBe(true)
  })

  it("the current: line ends with a newline (ready for process.stdout.write)", () => {
    const header = buildCurrentHeader("ae44d29", "0.1.0", 4753, false)
    expect(header?.endsWith("\n")).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* classifyEngineExit (pure)                                                   */
/* -------------------------------------------------------------------------- */

describe("classifyEngineExit (pure)", () => {
  // This helper was extracted so the engine exit-code → UpdatePlanInput mapping
  // is independently testable. The mapping is the seam most likely to harbour a
  // future regression (mismatched exit-code constant, off-by-one on the ≥2
  // critical path), so testing it here is the same rationale that motivated
  // extracting buildEngineArgs and buildCurrentHeader.

  it("exit 0 → applied-ok with the supplied targetSha", () => {
    const result = classifyEngineExit(0, "f73b1a2")
    expect(result.kind).toBe("applied-ok")
    // Narrowing: TypeScript knows result is { kind:"applied-ok", targetSha:string }
    expect((result as { kind: "applied-ok"; targetSha: string }).targetSha).toBe("f73b1a2")
  })

  it("exit 1 → applied-rolled-back (server ran rollback and recovered)", () => {
    const result = classifyEngineExit(1, "f73b1a2")
    expect(result.kind).toBe("applied-rolled-back")
  })

  it("exit 2 → applied-critical (update AND rollback both failed)", () => {
    const result = classifyEngineExit(2, "f73b1a2")
    expect(result.kind).toBe("applied-critical")
  })

  it("any code > 2 → applied-critical (spawnSync null→2 + any engine extension)", () => {
    // applyUpdate maps spawnSync status=null → 2, but a defence-in-depth path:
    // any unexpected exit code ≥ 2 is treated as critical rather than silently
    // misclassified as rolled-back (which would emit an incorrect "healthy" msg).
    expect(classifyEngineExit(3, "f73b1a2").kind).toBe("applied-critical")
    expect(classifyEngineExit(127, "f73b1a2").kind).toBe("applied-critical")
  })

  it("applied-ok carries the exact targetSha passed (not truncated or modified)", () => {
    const sha = "ae44d29f73b1a2c9"
    const result = classifyEngineExit(0, sha)
    expect((result as { kind: "applied-ok"; targetSha: string }).targetSha).toBe(sha)
  })

  it("applied-ok result round-trips through renderUpdatePlan with exit code 0", () => {
    // classifyEngineExit + renderUpdatePlan compose correctly end-to-end
    const plan = classifyEngineExit(0, "f73b1a2")
    const report = renderUpdatePlan(plan)
    expect(report.exitCode).toBe(0)
    expect(report.lines.join("\n")).toContain("f73b1a2")
  })

  it("applied-rolled-back result round-trips through renderUpdatePlan with exit code 1", () => {
    const plan = classifyEngineExit(1, "f73b1a2")
    const report = renderUpdatePlan(plan)
    expect(report.exitCode).toBe(1)
  })

  it("applied-critical result round-trips through renderUpdatePlan with exit code 2", () => {
    const plan = classifyEngineExit(2, "f73b1a2")
    const report = renderUpdatePlan(plan)
    expect(report.exitCode).toBe(2)
  })
})
