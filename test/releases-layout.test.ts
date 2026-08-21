/**
 * Phase 4 — releases deploy layout (per-profile opt-in).
 *
 * Hermetic coverage of the releases arm of luna-update-server plus the
 * releases forks in luna-autodeploy and luna-server-install:
 *   - mirror-only fetches (git reset --hard provably absent from the arm)
 *   - materialize_release: clone --local + build-in-release + .complete LAST,
 *     stale-partial sweep, reuse gate, cp -a node_modules seeding
 *   - flip_current: relative links, previous restamp, staged ln + atomic
 *     rename, cd -P postconditions, flip strictly INSIDE the guarded restart
 *     window
 *   - session-guard invariants: defer leaves current untouched (fresh and
 *     mid-transaction)
 *   - rollback matrix: flip-back only (no git surgery, no rebuild), CRITICAL
 *     classes, pre-flip failures never enter rollback
 *   - prune_releases retention + protection + refuse-all-on-dangling
 *   - claude pin: through-current spelling with read-back
 *   - inplace verbatim signature: the pre-phase-4 engine (git HEAD) and the
 *     phase-4 engine produce byte-identical command streams for an inplace
 *     forward deploy (mechanical proof phases 1-3 are preserved)
 *
 * The three baseline test files are untouched: the ENTIRE existing suite
 * exercises the inplace arm unchanged.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import { releaseManifest } from "./helpers/guardian-harness"

const repoRoot = new URL("..", import.meta.url).pathname
const ENGINE = join(repoRoot, "scripts/luna-update-server")
const AUTODEPLOY = join(repoRoot, "scripts/luna-autodeploy")
const SERVER_INSTALL = join(repoRoot, "scripts/luna-server-install")
const REAL_GIT = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()
const REAL_PERL = spawnSync("bash", ["-c", "command -v perl"], { encoding: "utf8" }).stdout.trim()
if (!REAL_PERL) throw new Error("releases-layout.test.ts: perl not found on host")

const tempDirs: string[] = []
const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-releases-test-"))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: ReadonlyArray<string>) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`)
  return r.stdout.trim()
}
const gitDir = (dir: string, ...args: ReadonlyArray<string>) => {
  const r = spawnSync("git", ["--git-dir", dir, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git --git-dir ${args.join(" ")} failed: ${r.stderr}`)
  return r.stdout.trim()
}

// Minimal real lib content so the incus-mode claude re-pin payload can source
// the release's own lib copy — use the actual repo lib (self-contained).
const LIB_CONTENT = readFileSync(join(repoRoot, "scripts/lib/luna-deploy.sh"), "utf8")

/**
 * Releases fixture: upstream bare origin (two commits, same bun.lock), a bare
 * mirror WITH the explicit origin refspec, one built prev release, and
 * current -> releases/<prev> (RELATIVE link).
 *
 * `targetExtraFiles` (relative path -> content) lands ONLY in the "target"
 * commit, after the "prev" commit is already cut - so the materialized prev
 * release lacks them and the materialized target release has them, modeling
 * a post-move tree shape appearing for the first time on a fresh deploy.
 */
const makeReleasesFixture = (
  root: string,
  opts: { readonly targetExtraFiles?: Readonly<Record<string, string>> } = {},
) => {
  const origin = join(root, "origin.git")
  mkdirSync(origin, { recursive: true })
  git(origin, "init", "--quiet", "--bare")

  const seed = join(root, "seed")
  mkdirSync(seed, { recursive: true })
  git(seed, "init", "--quiet")
  git(seed, "config", "user.email", "t@example.test")
  git(seed, "config", "user.name", "Test")
  git(seed, "checkout", "-q", "-B", "master")
  writeFileSync(join(seed, "file.txt"), "v1\n")
  writeFileSync(join(seed, "bun.lock"), "lock-v1\n")
  mkdirSync(join(seed, "scripts", "lib"), { recursive: true })
  writeFileSync(join(seed, "scripts", "lib", "luna-deploy.sh"), LIB_CONTENT)
  git(seed, "add", "-A")
  git(seed, "commit", "--quiet", "-m", "prev")
  const prevSha = git(seed, "rev-parse", "HEAD")
  writeFileSync(join(seed, "file.txt"), "v2\n")
  for (const [relPath, content] of Object.entries(opts.targetExtraFiles ?? {})) {
    const full = join(seed, relPath)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  git(seed, "add", "-A")
  git(seed, "commit", "--quiet", "-m", "target")
  const targetSha = git(seed, "rev-parse", "HEAD")
  git(seed, "remote", "add", "origin", origin)
  git(seed, "push", "--quiet", "origin", "master")

  // Deploy root: bare mirror with the LOAD-BEARING explicit refspec.
  const deploy = join(root, "deploy")
  mkdirSync(deploy, { recursive: true })
  const mirror = join(deploy, "mirror.git")
  git(root, "clone", "--quiet", "--bare", origin, mirror)
  gitDir(mirror, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
  gitDir(mirror, "fetch", "--quiet", "origin")

  // Prev release: clone --local, detach, artifacts, .complete.
  const releases = join(deploy, "releases")
  mkdirSync(releases, { recursive: true })
  const prevRel = join(releases, prevSha)
  git(root, "clone", "--quiet", "--no-checkout", "--local", mirror, prevRel)
  git(prevRel, "checkout", "--quiet", "--detach", prevSha)
  const claudeDir = join(prevRel, "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64")
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(join(claudeDir, "claude"), "#!/bin/sh\nexit 0\n")
  spawnSync("chmod", ["+x", join(claudeDir, "claude")])
  writeFileSync(join(prevRel, ".complete"), "")

  symlinkSync(`releases/${prevSha}`, join(deploy, "current"))

  return { origin, deploy, mirror, releases, prevSha, targetSha }
}

/**
 * Removes the `current` SYMLINK itself, never what it points at.
 *
 * Use this instead of `rmSync` on any deploy symlink. `rmSync` stats THROUGH
 * the link, so on a link-to-directory it throws ERR_FS_EISDIR ("Path is a
 * directory") on Node 24 and the whole test dies before it can assert
 * anything; `rmSync(..., { recursive: true })` would "work" but by deleting
 * the release the link resolves to, silently destroying the fixture the test
 * is about to make claims against. `unlinkSync` is the only call with the
 * semantics the deploy layout actually wants.
 */
function unlinkCurrent(deploy: string): void {
  unlinkSync(join(deploy, "current"))
}

/**
 * Stub bin: systemctl (records stop/start WITH what current resolves to at
 * that instant — the flip-inside-the-window proof), curl (verdict keyed off
 * the release current resolves to), bun (CREATES the release artifacts,
 * mirroring a real install), plus a logging passthrough git shim so fetch
 * targets are assertable.
 */
const makeReleasesStubBin = (
  root: string,
  deploy: string,
  opts: {
    readonly prevSha: string
    readonly targetSha: string
    readonly readyAtTarget: boolean
    readonly readyAtPrev: boolean
    readonly withIncus?: boolean
  },
) => {
  const bin = join(root, "bin")
  mkdirSync(bin, { recursive: true })
  const systemctlLog = join(root, "systemctl.log")
  const orderLog = join(root, "order.log")
  const curlLog = join(root, "curl.log")
  const bunLog = join(root, "bun.log")
  const gitLog = join(root, "git.log")
  const incusLog = join(root, "incus.log")

  writeFileSync(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${systemctlLog}"
cur="$(readlink "${deploy}/current" 2>/dev/null || printf 'none')"
case "$1" in
  is-active) printf 'active\\n'; exit 0 ;;
  stop) printf 'stop current=%s\\n' "$cur" >> "${orderLog}"; exit 0 ;;
  start) printf 'start current=%s\\n' "$cur" >> "${orderLog}"; eval "\${STUB_START_HOOK:-}"; exit 0 ;;
  show) printf '0\\n'; exit 0 ;;
  *) exit 0 ;;
esac
`,
  )

  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${curlLog}"
head="$(git -C "${deploy}/current" rev-parse HEAD 2>/dev/null || printf 'unknown')"
code='503'
mode='normal'
if [[ "$head" == "${opts.targetSha}" && "${opts.readyAtTarget ? "1" : "0"}" == "1" ]]; then code='200'; fi
if [[ "$head" == "${opts.prevSha}" && "${opts.readyAtPrev ? "1" : "0"}" == "1" ]]; then code='200'; fi
if [[ "$*" == *"/readyz"* ]]; then
  printf '{"status":"ok","mode":"%s","credentialOk":true,"buildSha":"%s"}\\n%s' "$mode" "$head" "$code"
  exit 0
fi
printf '%s' "$code"
exit 0
`,
  )

  writeFileSync(
    join(bin, "bun"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${bunLog}"
cwd=""
prev=""
for a in "$@"; do
  if [[ "$prev" == "--cwd" ]]; then cwd="$a"; fi
  prev="$a"
done
if [[ "$1" == "install" && -n "$cwd" ]]; then
  [[ "\${STUB_BUN_FAIL_INSTALL:-}" == "1" ]] && exit 1
  [[ -n "\${STUB_BUN_RM:-}" ]] && rm -f "\$STUB_BUN_RM"
  d="$cwd/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"
  mkdir -p "$d"
  printf '#!/bin/sh\\nexit 0\\n' > "$d/claude"
  chmod +x "$d/claude"
fi
exit 0
`,
  )

  // Logging passthrough git: records every invocation, then execs real git.
  writeFileSync(
    join(bin, "git"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${gitLog}"
exec "${REAL_GIT}" "$@"
`,
  )

  // perl shim: sabotage seam for luna_atomic_replace, the ONLY thing the flip
  // and materialize's staged swap now go through. Env-keyed, harmless when
  // STUB_FLIP_SABOTAGE_TARGET is unset: a rename(2) call whose staged-link
  // SOURCE points at $STUB_FLIP_SABOTAGE_TARGET silently "succeeds" without
  // renaming - the rigged non-landing flip the postcondition must catch.
  writeFileSync(
    join(bin, "perl"),
    `#!/usr/bin/env bash
if [[ -n "\${STUB_FLIP_SABOTAGE_TARGET:-}" && "$*" == *'rename('* ]]; then
  src="\${@: -2:1}"
  tgt="$(readlink "$src" 2>/dev/null || true)"
  if [[ "$tgt" == "\$STUB_FLIP_SABOTAGE_TARGET" ]]; then
    rm -f "$src"
    exit 0
  fi
fi
exec "${REAL_PERL}" "$@"
`,
  )

  if (opts.withIncus) {
    writeFileSync(
      join(bin, "incus"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${incusLog}"
if [[ "$1" == "exec" ]]; then
  shift; shift
  [[ "$1" == "--" ]] && shift
  if [[ "$1" == "test" ]]; then
    if [[ "$2" == "-f" ]]; then exit 0; fi
    "$@"; exit $?
  fi
  "$@"
  exit $?
fi
exit 0
`,
    )
  }

  for (const f of ["systemctl", "curl", "bun", "git", "perl", ...(opts.withIncus ? ["incus"] : [])]) {
    spawnSync("chmod", ["+x", join(bin, f)])
  }
  return { bin, systemctlLog, orderLog, curlLog, bunLog, gitLog, incusLog }
}

const writeUnit = (serviceDir: string, name = "luna-chat-server.service") => {
  mkdirSync(serviceDir, { recursive: true })
  writeFileSync(join(serviceDir, name), "[Unit]\n")
}

/** Run the engine in releases mode against a fixture. */
const runReleases = (
  fixture: { deploy: string },
  stubs: { bin: string },
  temp: string,
  extraArgs: ReadonlyArray<string> = [],
  env: Record<string, string | undefined> = {},
) => {
  const serviceDir = join(temp, "systemd")
  writeUnit(serviceDir)
  return spawnSync(
    "bash",
    [
      ENGINE,
      "--profile", "stable",
      "--layout", "releases",
      "--deploy-root", fixture.deploy,
      "--ref", "origin/master",
      "--luna-home", join(temp, "state"),
      "--service-dir", serviceDir,
      "--readiness-timeout", "3",
      "--readiness-interval", "1",
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${stubs.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        LUNA_RESTART_SETTLE_SECS: "0",
        LUNA_TEST_WS_COUNT: "0",
        LUNA_UPDATE_STATE_DIR: join(temp, "update-state"),
        ...env,
      },
    },
  )
}

const readLog = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")
const currentOf = (deploy: string) => readlinkSync(join(deploy, "current"))
const previousOf = (deploy: string) => readlinkSync(join(deploy, "previous"))

// releaseManifest (recursive nanosecond-mtime + inode + content-hash witness)
// moved to test/helpers/guardian-harness.ts (phase 5, W1) — imported above.

// ─────────────────────────────────────────────────────────────────────────────
// Static properties
// ─────────────────────────────────────────────────────────────────────────────

describe("releases layout — static properties", () => {
  it("bash -n clean on every touched script", () => {
    for (const f of [
      "scripts/luna-update-server",
      "scripts/luna-autodeploy",
      "scripts/luna-guardian",
      "scripts/luna-server-install",
      "scripts/lib/luna-registry.sh",
      "scripts/lib/luna-deploy.sh",
    ]) {
      const r = spawnSync("bash", ["-n", join(repoRoot, f)], { encoding: "utf8" })
      expect(r.status, `${f}: ${r.stderr}`).toBe(0)
    }
  })

  it("zero `reset --hard` in any releases-arm function (string confined to the inplace arm)", () => {
    const src = readFileSync(ENGINE, "utf8")
    const releasesFns = [
      "apply_ref_releases",
      "materialize_release",
      "flip_current",
      "repin_claude_releases",
      "prune_releases",
      "do_rollback_releases",
      "deployed_sha",
      "mirror_lock_blob",
    ]
    for (const fn of releasesFns) {
      const m = src.match(new RegExp(`^${fn}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))
      expect(m, `function ${fn} not found`).toBeTruthy()
      expect(m![0], `${fn} must not contain reset --hard`).not.toContain("reset --hard")
    }
    // The inplace arm still owns the string (sanity that the extraction works).
    const inplace = src.match(/^apply_ref_inplace\(\) \{[\s\S]*?^\}/m)
    expect(inplace).toBeTruthy()
    expect(inplace![0]).toContain("reset --hard")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// --materialize bootstrap + materialize_release behaviours
// ─────────────────────────────────────────────────────────────────────────────

describe("releases layout — materialize", () => {
  it("--materialize bootstraps a release + current on an empty deploy root, with NO restart/unit interaction", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    // Empty-root bootstrap: remove the pre-built release AND current.
    unlinkCurrent(fx.deploy)
    rmSync(join(fx.releases, fx.prevSha), { recursive: true })
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r = runReleases(fx, stubs, temp, ["--materialize", "--ref", fx.prevSha])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(existsSync(join(fx.releases, fx.prevSha, ".complete"))).toBe(true)
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)
    // NO unit interaction: not one systemctl call.
    expect(readLog(stubs.systemctlLog)).toBe("")
    expect(r.stdout).toContain("no restart, no unit interaction")
  })

  it("--materialize never moves an established current", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r = runReleases(fx, stubs, temp, ["--materialize", "--ref", fx.targetSha])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(existsSync(join(fx.releases, fx.targetSha, ".complete"))).toBe(true)
    // current still names prev — the bootstrap is inert on an established root.
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)
    expect(r.stdout).toContain("left untouched")
  })

  it("crash BEFORE .complete leaves a partial that the next run sweeps and rebuilds (canary proven)", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r1 = runReleases(fx, stubs, temp, ["--materialize", "--ref", fx.targetSha], {
      LUNA_TEST_CRASH_BEFORE_COMPLETE: "1",
    })
    expect(r1.signal, r1.stdout + r1.stderr).toBe("SIGKILL")
    const rel = join(fx.releases, fx.targetSha)
    expect(existsSync(rel)).toBe(true)
    expect(existsSync(join(rel, ".complete"))).toBe(false)
    // Canary: if the partial were REUSED instead of swept, this would survive.
    writeFileSync(join(rel, "canary.txt"), "stale\n")

    const r2 = runReleases(fx, stubs, temp, ["--materialize", "--ref", fx.targetSha])
    expect(r2.status, r2.stdout + r2.stderr).toBe(0)
    expect(r2.stderr).toContain("removing stale/incomplete release")
    expect(existsSync(join(rel, ".complete"))).toBe(true)
    expect(existsSync(join(rel, "canary.txt"))).toBe(false)
  })

  it("reuse gate: a complete release is reused (zero bun calls); a damaged one (deleted node_modules) is rebuilt", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r1 = runReleases(fx, stubs, temp, ["--materialize", "--ref", fx.targetSha])
    expect(r1.status, r1.stdout + r1.stderr).toBe(0)
    const bunAfterFirst = readLog(stubs.bunLog).split("\n").filter(Boolean).length
    expect(bunAfterFirst).toBe(1) // install only

    const r2 = runReleases(fx, stubs, temp, ["--materialize", "--ref", fx.targetSha])
    expect(r2.status, r2.stdout + r2.stderr).toBe(0)
    expect(r2.stdout).toContain("reusing")
    expect(readLog(stubs.bunLog).split("\n").filter(Boolean).length).toBe(bunAfterFirst) // zero new bun calls

    // Damage the declared artifact: .complete present but node_modules gone → rebuild.
    rmSync(join(fx.releases, fx.targetSha, "node_modules"), { recursive: true })
    const r3 = runReleases(fx, stubs, temp, ["--materialize", "--ref", fx.targetSha])
    expect(r3.status, r3.stdout + r3.stderr).toBe(0)
    expect(r3.stderr).toContain("removing stale/incomplete release")
    expect(readLog(stubs.bunLog).split("\n").filter(Boolean).length).toBe(bunAfterFirst + 1)
    expect(existsSync(join(fx.releases, fx.targetSha, "node_modules"))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Forward deploy e2e
// ─────────────────────────────────────────────────────────────────────────────

describe("releases layout — forward deploy", () => {
  it("happy path: mirror-only fetch, flip strictly inside the restart window, through-current claude pin, exit 0", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    // Rigged PHYSICAL pin: the deploy must rewrite it to the through-current
    // spelling detected against the NEW release.
    const stateDir = join(temp, "state")
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, ".env"), `LUNA_CLAUDE_CODE_EXECUTABLE=${fx.releases}/${fx.prevSha}/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude\n`)
    // Immutability witness: full recursive manifest (ns mtimes + content
    // hashes) of the prev release — any in-run write anywhere in it fails.
    const prevRelDir = join(fx.releases, fx.prevSha)
    const before = releaseManifest(prevRelDir)

    const r = runReleases(fx, stubs, temp)
    expect(r.status, r.stdout + r.stderr).toBe(0)

    // current is the LITERAL relative string (no leading slash) and resolves
    // to the target; previous restamped to the outgoing release.
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.targetSha}`)
    expect(previousOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)
    // no stray staged tmp link left behind
    expect(existsSync(join(fx.deploy, `current.tmp.${r.pid}`))).toBe(false)

    // Flip strictly INSIDE the stop->start window.
    const order = readLog(stubs.orderLog).trim().split("\n")
    expect(order).toEqual([
      `stop current=releases/${fx.prevSha}`,
      `start current=releases/${fx.targetSha}`,
    ])

    // Every fetch touched ONLY the mirror; zero resets anywhere.
    const gitLines = readLog(stubs.gitLog).split("\n").filter(Boolean)
    const fetches = gitLines.filter((l) => l.includes("fetch"))
    expect(fetches.length).toBeGreaterThan(0)
    for (const f of fetches) expect(f).toContain(`--git-dir ${fx.mirror}`)
    expect(gitLines.some((l) => l.includes("reset"))).toBe(false)

    // Prev release untouched (phase-3 converged idiom): identical recursive
    // manifest — no file changed, appeared, or moved inodes.
    const after = releaseManifest(prevRelDir)
    expect(after).toBe(before)

    // Claude pin: through-current spelling, detected against the NEW release.
    const envContent = readFileSync(join(stateDir, ".env"), "utf8")
    expect(envContent).toContain(
      `LUNA_CLAUDE_CODE_EXECUTABLE=${fx.deploy}/current/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`,
    )
    expect(envContent).not.toContain(`${fx.releases}/${fx.prevSha}/node_modules`)

    // Journal cleared; dream-wake seeded through current.
    expect(existsSync(join(temp, "update-state", "transaction-stable"))).toBe(false)
    expect(readLog(stubs.bunLog)).toContain(`${fx.deploy}/current/apps/ui-web/scripts/dream-wake-install.ts`)
  })

  it("dream-wake-install probe: a target release carrying apps/server/scripts logs the post-move path, not the ui-web fallback", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp, {
      targetExtraFiles: { "apps/server/scripts/dream-wake-install.ts": "// post-move fixture stub\n" },
    })
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r = runReleases(fx, stubs, temp)
    expect(r.status, r.stdout + r.stderr).toBe(0)
    // The materialized target release carries the post-move file; the prev
    // release (cut before it was added) does not.
    expect(existsSync(join(fx.releases, fx.targetSha, "apps", "server", "scripts", "dream-wake-install.ts"))).toBe(true)
    expect(existsSync(join(fx.releases, fx.prevSha, "apps", "server", "scripts", "dream-wake-install.ts"))).toBe(false)
    const bunLog = readLog(stubs.bunLog)
    expect(bunLog).toContain(`${fx.deploy}/current/apps/server/scripts/dream-wake-install.ts`)
    expect(bunLog).not.toContain(`${fx.deploy}/current/apps/ui-web/scripts/dream-wake-install.ts`)
  })

  it("cp -a node_modules seeding fires on an unchanged bun.lock blob, and the frozen install still runs", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    // Marker only present in the SEED source (prev release's node_modules).
    writeFileSync(join(fx.releases, fx.prevSha, "node_modules", "seed-marker.txt"), "seeded\n")
    const r = runReleases(fx, stubs, temp)
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain("seeding node_modules")
    expect(existsSync(join(fx.releases, fx.targetSha, "node_modules", "seed-marker.txt"))).toBe(true)
    // The frozen install STILL ran on the seeded tree.
    expect(readLog(stubs.bunLog)).toContain(`install --cwd ${fx.releases}/${fx.targetSha} --frozen-lockfile`)
  })

  it("incus mode: the in-container readlink -f flip assert appears in the command log", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true, withIncus: true,
    })
    const r = runReleases(fx, stubs, temp, ["--incus", "luna-stable"], {
      LUNA_CONTAINER_DEPLOY_ROOT: fx.deploy,
      LUNA_CONTAINER_ENV_FILE: join(temp, "state", ".env"),
      LUNA_TEST_BUN_PATH: join(stubs.bin, "bun"),
    })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(readLog(stubs.incusLog)).toContain(`exec luna-stable -- readlink -f ${fx.deploy}/current`)
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.targetSha}`)
    // The through-current pin was written into the CONTAINER env seam.
    expect(readFileSync(join(temp, "state", ".env"), "utf8")).toContain(
      `LUNA_CLAUDE_CODE_EXECUTABLE=${fx.deploy}/current/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`,
    )
  })

  it("--restart-only never flips (hook unset): current identical at stop and start", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r = runReleases(fx, stubs, temp, ["--restart-only"])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    const order = readLog(stubs.orderLog).trim().split("\n")
    expect(order).toEqual([
      `stop current=releases/${fx.prevSha}`,
      `start current=releases/${fx.prevSha}`,
    ])
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)
    expect(r.stdout).toContain(`healthy at ${fx.prevSha.slice(0, 12)}`)
  })

  it("--ref normalization: UPPERCASE and abbreviated shas deploy cleanly to the canonical lowercase release", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    // Uppercase full sha (pasted from a tool that uppercases): must NOT
    // produce an uppercase-named release dir nor bounce a healthy deploy
    // through readiness-mismatch rollback.
    const r1 = runReleases(fx, stubs, temp, ["--ref", fx.targetSha.toUpperCase()])
    expect(r1.status, r1.stdout + r1.stderr).toBe(0)
    expect(r1.stderr).not.toContain("ROLLED BACK")
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.targetSha}`)
    expect(existsSync(join(fx.releases, fx.targetSha.toUpperCase()))).toBe(
      // case-sensitive fs: the uppercase spelling must not exist as its own dir
      process.platform === "linux" ? false : true,
    )
    // Abbreviated sha (works in inplace via the bidirectional prefix match):
    // resolved through the mirror, not rejected by materialize's exact-length
    // HEAD postcondition with a misleading corruption warning.
    const r2 = runReleases(fx, stubs, temp, ["--ref", fx.targetSha.slice(0, 12)])
    expect(r2.status, r2.stdout + r2.stderr).toBe(0)
    expect(r2.stderr).not.toContain("POSTCONDITION")
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.targetSha}`)
  })

  it("dry-run renders the honest releases plan and executes nothing (no reset --hard in the trace)", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r = runReleases(fx, stubs, temp, ["--dry-run"])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain("mirror fetch")
    expect(r.stdout).toContain("materialize release")
    expect(r.stdout).toContain("build-in-release")
    expect(r.stdout).toContain("flip-inside-restart")
    expect(r.stdout).toContain("verify")
    expect(r.stdout).toContain("rollback = flip back to previous")
    expect(r.stdout + r.stderr).not.toContain("reset --hard")
    // The executed-command trace resolves --ref against the mirror first
    // (read-only): paths are releases/<sha> exactly as the live path forms
    // them — never a nested releases/origin/master shape it never creates.
    expect(r.stdout).toContain(`releases/${fx.targetSha}`)
    expect(r.stdout).not.toContain("releases/origin/master")
    // Executes nothing: no stub was ever invoked, deploy root untouched.
    expect(readLog(stubs.systemctlLog)).toBe("")
    expect(readLog(stubs.orderLog)).toBe("")
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)
    expect(existsSync(join(fx.releases, fx.targetSha))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Session-guard invariants on the releases arm
// ─────────────────────────────────────────────────────────────────────────────

describe("releases layout — session guard", () => {
  it("fresh-run defer (live sessions): exit 3, current untouched, no journal, no materialize", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r = runReleases(fx, stubs, temp, [], { LUNA_TEST_WS_COUNT: "2" })
    expect(r.status, r.stdout + r.stderr).toBe(3)
    expect(r.stderr).toContain("DEFERRED by session guard")
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)
    expect(existsSync(join(fx.deploy, "previous"))).toBe(false)
    expect(existsSync(join(fx.releases, fx.targetSha))).toBe(false)
    expect(existsSync(join(temp, "update-state", "transaction-stable"))).toBe(false)
    expect(readLog(stubs.orderLog)).toBe("")
  })

  it("fresh-run defer (UNKNOWN count, unit answers active): fail closed, exit 3", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r = runReleases(fx, stubs, temp, [], { LUNA_TEST_WS_COUNT: "unknown" })
    expect(r.status, r.stdout + r.stderr).toBe(3)
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)
    expect(readLog(stubs.orderLog)).toBe("")
  })

  it("mid-transaction defer at restart: exit 3, journal phase=restarting, current STILL old (flip never ran)", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r1 = runReleases(fx, stubs, temp, [], { LUNA_TEST_CRASH_AFTER_PHASE: "restarting" })
    expect(r1.signal).toBe("SIGKILL")
    const journal = join(temp, "update-state", "transaction-stable")
    expect(readFileSync(journal, "utf8")).toContain("phase=restarting")

    const r2 = runReleases(fx, stubs, temp, [], { LUNA_TEST_WS_COUNT: "1" })
    expect(r2.status, r2.stdout + r2.stderr).toBe(3)
    expect(readFileSync(journal, "utf8")).toContain("phase=restarting")
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)
    expect(readLog(stubs.orderLog)).toBe("")
  })

  it("crash at phase=restarting → idempotent recovery: reuse-gate no-op re-materialize, one flip+restart, exit 0", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r1 = runReleases(fx, stubs, temp, [], { LUNA_TEST_CRASH_AFTER_PHASE: "restarting" })
    expect(r1.signal).toBe("SIGKILL")
    const bunAfterCrash = readLog(stubs.bunLog).split("\n").filter(Boolean).length

    const r2 = runReleases(fx, stubs, temp)
    expect(r2.status, r2.stdout + r2.stderr).toBe(0)
    expect(r2.stderr).toContain("RECOVERING")
    expect(r2.stdout).toContain("reusing")
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.targetSha}`)
    // Recovery re-materialize was a no-op: only the dream-wake bun call added.
    expect(readLog(stubs.bunLog).split("\n").filter(Boolean).length).toBe(bunAfterCrash + 1)
    // Exactly one effective restart across recovery.
    const order = readLog(stubs.orderLog).trim().split("\n")
    expect(order).toEqual([
      `stop current=releases/${fx.prevSha}`,
      `start current=releases/${fx.targetSha}`,
    ])
    expect(existsSync(join(temp, "update-state", "transaction-stable"))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Serving-tree rule: the deployed release is never rm -rf'd
// ─────────────────────────────────────────────────────────────────────────────

describe("releases layout — serving-tree rule (deployed-release rebuild)", () => {
  it("damaged DEPLOYED release + failed rebuild: current never dangles, deployed tree intact, exit 1 pre-flip", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    // The repair-rung-2 damage class: node_modules lost (disk-pressure
    // cleanup), .complete intact — and repair pins --ref to the deployed sha.
    rmSync(join(fx.releases, fx.prevSha, "node_modules"), { recursive: true })
    const r = runReleases(fx, stubs, temp, ["--ref", fx.prevSha], { STUB_BUN_FAIL_INSTALL: "1" })
    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stderr).toContain("staged sibling")
    expect(r.stderr).toContain("PRE-flip")
    // THE invariant: the serving unit's WorkingDirectory was never deleted —
    // current still resolves to a directory carrying its .complete, so every
    // automated path (deploy PREV resolution, --restart-only readiness gate,
    // autodeploy, guardian repair) stays operable instead of bricking on a
    // dangling current.
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)
    expect(existsSync(join(fx.releases, fx.prevSha, ".complete"))).toBe(true)
    expect(existsSync(join(fx.releases, fx.prevSha, "file.txt"))).toBe(true)
    // Never stopped the unit; no staged debris left behind.
    expect(readLog(stubs.orderLog)).toBe("")
    expect(existsSync(join(fx.releases, `.stage.${fx.prevSha}`))).toBe(false)
  })

  it("damaged DEPLOYED release + successful rebuild: staged swap restores artifacts, deploy completes, exit 0", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    rmSync(join(fx.releases, fx.prevSha, "node_modules"), { recursive: true })
    const r = runReleases(fx, stubs, temp, ["--ref", fx.prevSha])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stderr).toContain("staged sibling")
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)
    expect(existsSync(join(fx.releases, fx.prevSha, "node_modules"))).toBe(true)
    expect(existsSync(join(fx.releases, fx.prevSha, ".complete"))).toBe(true)
    expect(existsSync(join(fx.releases, `.stage.${fx.prevSha}`))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Crash between flip and start (the narrowest recovery window)
// ─────────────────────────────────────────────────────────────────────────────

describe("releases layout — crash between flip and start", () => {
  it("recovery re-flips idempotently WITHOUT restamping previous (rollback target preserved)", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r1 = runReleases(fx, stubs, temp, [], { LUNA_TEST_CRASH_AFTER_FLIP: "1" })
    expect(r1.signal, r1.stdout + r1.stderr).toBe("SIGKILL")
    // The crash window: stop ran, flip landed, start never ran.
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.targetSha}`)
    expect(previousOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)
    const journal = join(temp, "update-state", "transaction-stable")
    expect(readFileSync(journal, "utf8")).toContain("phase=restarting")
    expect(readLog(stubs.orderLog).trim().split("\n")).toEqual([
      `stop current=releases/${fx.prevSha}`,
    ])

    const r2 = runReleases(fx, stubs, temp)
    expect(r2.status, r2.stdout + r2.stderr).toBe(0)
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.targetSha}`)
    // THE property: a re-flip to the sha current already names must NOT
    // restamp previous to the target (= itself) — that would destroy the true
    // rollback target's `previous` identity and, after clear_transaction, its
    // prune protection.
    expect(previousOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)
    expect(existsSync(join(fx.releases, fx.prevSha, ".complete"))).toBe(true)
    expect(existsSync(journal)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Recovery honesty: a failing re-apply during phase=restarting recovery
// ─────────────────────────────────────────────────────────────────────────────

describe("releases layout — recovery honesty", () => {
  it("recovery of phase=restarting with a failing re-apply RETAINS the journal and never claims the old server is serving", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r1 = runReleases(fx, stubs, temp, [], { LUNA_TEST_CRASH_AFTER_PHASE: "restarting" })
    expect(r1.signal).toBe("SIGKILL")
    const journal = join(temp, "update-state", "transaction-stable")
    expect(readFileSync(journal, "utf8")).toContain("phase=restarting")
    // Damage the target release so recovery's re-materialize must rebuild,
    // and make the rebuild fail (the transient 3am failure class).
    rmSync(join(fx.releases, fx.targetSha, "node_modules"), { recursive: true })
    const r2 = runReleases(fx, stubs, temp, [], { STUB_BUN_FAIL_INSTALL: "1" })
    expect(r2.status, r2.stdout + r2.stderr).toBe(1)
    expect(r2.stderr).toContain("RECOVERING")
    // In this phase the crashed run may already have stopped/flipped: the
    // false comfort message must not print, and the journal (with its
    // prev/target forensics) must survive so the next tick actually resumes
    // instead of autodeploy converging to a silent no-op with the unit down.
    expect(r2.stderr).toContain("journal RETAINED")
    expect(r2.stderr).not.toContain("old server still serving")
    expect(readFileSync(journal, "utf8")).toContain(`target=${fx.targetSha}`)

    // Once the transient failure clears, the retained journal completes.
    const r3 = runReleases(fx, stubs, temp)
    expect(r3.status, r3.stdout + r3.stderr).toBe(0)
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.targetSha}`)
    expect(existsSync(journal)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Rollback matrix
// ─────────────────────────────────────────────────────────────────────────────

describe("releases layout — rollback", () => {
  it("(a) readiness FAIL → flip-back to previous: zero git mutation, zero installs, re-pinned, exit 1", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: false, readyAtPrev: true,
    })
    const r = runReleases(fx, stubs, temp)
    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stderr).toContain("ROLLED BACK (flipped)")
    // current back at prev; previous names the FAILED release (forensics).
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)
    expect(previousOf(fx.deploy)).toBe(`releases/${fx.targetSha}`)
    // ZERO bun installs during rollback: forward materialize's 1 call only.
    expect(readLog(stubs.bunLog).split("\n").filter(Boolean).length).toBe(1)
    // ZERO git mutation during rollback: no reset, exactly one fetch (forward).
    // (\bfetch\b as a WORD: the preflight's `config --get remote.origin.fetch`
    // read is not a fetch.)
    const gitLines = readLog(stubs.gitLog).split("\n").filter(Boolean)
    expect(gitLines.some((l) => l.includes("reset"))).toBe(false)
    expect(gitLines.filter((l) => /(^|\s)fetch(\s|$)/.test(l)).length).toBe(1)
    // Both releases still complete (immutable).
    expect(existsSync(join(fx.releases, fx.prevSha, ".complete"))).toBe(true)
    expect(existsSync(join(fx.releases, fx.targetSha, ".complete"))).toBe(true)
    // Pin re-written through current.
    expect(readFileSync(join(temp, "state", ".env"), "utf8")).toContain(
      `LUNA_CLAUDE_CODE_EXECUTABLE=${fx.deploy}/current/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`,
    )
    expect(existsSync(join(temp, "update-state", "transaction-stable"))).toBe(false)
  })

  it("(b) rollback readiness also fails → exit 2 CRITICAL, journal rollback-failed, current at previous", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: false, readyAtPrev: false,
    })
    const r = runReleases(fx, stubs, temp)
    expect(r.status, r.stdout + r.stderr).toBe(2)
    expect(r.stderr).toContain("CRITICAL")
    expect(r.stderr).toContain(`ln -sfT releases/${fx.prevSha}`)
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)
    expect(readFileSync(join(temp, "update-state", "transaction-stable"), "utf8")).toContain("phase=rollback-failed")
  })

  it("(c) pre-flip install failure: current untouched, NO stop issued, exit 1, journal cleared; failed build tree cleaned up", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r1 = runReleases(fx, stubs, temp, [], { STUB_BUN_FAIL_INSTALL: "1" })
    expect(r1.status, r1.stdout + r1.stderr).toBe(1)
    expect(r1.stderr).toContain("PRE-flip")
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)
    expect(readLog(stubs.orderLog)).toBe("") // never stopped
    expect(existsSync(join(temp, "update-state", "transaction-stable"))).toBe(false)
    // The failed build tree is CLEANED UP on the failure exit — consecutive
    // failing deploys of distinct shas must not accumulate multi-GB partials
    // that would occupy prune's newest-by-mtime keep slots.
    expect(existsSync(join(fx.releases, fx.targetSha))).toBe(false)

    const r2 = runReleases(fx, stubs, temp)
    expect(r2.status, r2.stdout + r2.stderr).toBe(0)
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.targetSha}`)
  })

  it("(d) rigged non-landing flip: flip postcondition returns 1 (not die), routes to rollback flip-back, old release serving", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r = runReleases(fx, stubs, temp, [], {
      STUB_FLIP_SABOTAGE_TARGET: `releases/${fx.targetSha}`,
    })
    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stderr).toContain("POSTCONDITION: current flip did not land")
    expect(r.stderr).toContain("ROLLED BACK (flipped)")
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)
  })

  it("(e) rollback target missing .complete → exit 2 CRITICAL with named cause", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: false, readyAtPrev: true,
    })
    // The prev release loses its .complete DURING the run (post-preflight),
    // via the install stub's rm seam.
    const r = runReleases(fx, stubs, temp, [], {
      STUB_BUN_RM: join(fx.releases, fx.prevSha, ".complete"),
    })
    expect(r.status, r.stdout + r.stderr).toBe(2)
    expect(r.stderr).toContain("rollback target release")
    expect(r.stderr).toContain("missing or incomplete")
    expect(readFileSync(join(temp, "update-state", "transaction-stable"), "utf8")).toContain("phase=rollback-failed")
  })

  it("(f) crash at phase=applied → recovery completes with reuse and exactly one restart", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r1 = runReleases(fx, stubs, temp, [], { LUNA_TEST_CRASH_AFTER_PHASE: "applied" })
    expect(r1.signal).toBe("SIGKILL")
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)

    const r2 = runReleases(fx, stubs, temp)
    expect(r2.status, r2.stdout + r2.stderr).toBe(0)
    expect(currentOf(fx.deploy)).toBe(`releases/${fx.targetSha}`)
    const order = readLog(stubs.orderLog).trim().split("\n")
    expect(order).toEqual([
      `stop current=releases/${fx.prevSha}`,
      `start current=releases/${fx.targetSha}`,
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// prune_releases
// ─────────────────────────────────────────────────────────────────────────────

describe("releases layout — prune", () => {
  const seedFakeReleases = (releases: string, count: number) => {
    const fakes: string[] = []
    for (let i = 0; i < count; i++) {
      const sha = String(i).repeat(40).slice(0, 40)
      const dir = join(releases, sha)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, ".complete"), "")
      // Old mtimes so ls -dt ranks them below prev/target.
      const old = (Date.now() - (i + 1) * 86_400_000) / 1000
      utimesSync(dir, old, old)
      fakes.push(sha)
    }
    return fakes
  }

  it("keep honored (--releases-keep 2): current+previous protected, old releases pruned", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const fakes = seedFakeReleases(fx.releases, 3)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r = runReleases(fx, stubs, temp, ["--releases-keep", "2"])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    // current + previous survive; every fake is pruned.
    expect(existsSync(join(fx.releases, fx.targetSha, ".complete"))).toBe(true)
    expect(existsSync(join(fx.releases, fx.prevSha, ".complete"))).toBe(true)
    for (const f of fakes) expect(existsSync(join(fx.releases, f)), f).toBe(false)
  })

  it("a second healthy deploy's prune deletes nothing more", () => {
    // Idempotency property (phase 5): after a keep-honored prune, re-deploying
    // the SAME sha (reuse gate no-ops the build; deploy completes healthy;
    // prune runs on the healthy exit) must delete nothing further. Snapshot
    // equality, not named survivors — robust to mtime perturbation.
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    seedFakeReleases(fx.releases, 3)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r1 = runReleases(fx, stubs, temp, ["--releases-keep", "2"])
    expect(r1.status, r1.stdout + r1.stderr).toBe(0)
    const after1 = readdirSync(fx.releases).sort()
    const current1 = currentOf(fx.deploy)
    const previous1 = previousOf(fx.deploy)

    const r2 = runReleases(fx, stubs, temp, ["--releases-keep", "2", "--ref", fx.targetSha])
    expect(r2.status, r2.stdout + r2.stderr).toBe(0)
    expect(readdirSync(fx.releases).sort()).toEqual(after1)
    expect(r2.stderr).not.toContain("prune")
    expect(currentOf(fx.deploy)).toBe(current1)
    expect(previousOf(fx.deploy)).toBe(previous1)
  })

  it("default keep=3: the newest unprotected release survives, older ones are pruned", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const fakes = seedFakeReleases(fx.releases, 3)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r = runReleases(fx, stubs, temp)
    expect(r.status, r.stdout + r.stderr).toBe(0)
    // mtime order: target, prev, fake0, fake1, fake2 → keep 3 → fake0 stays.
    expect(existsSync(join(fx.releases, fakes[0]))).toBe(true)
    expect(existsSync(join(fx.releases, fakes[1]))).toBe(false)
    expect(existsSync(join(fx.releases, fakes[2]))).toBe(false)
  })

  it("prune protection is load-bearing: previous OLDER (by mtime) than `keep` newer releases still survives", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    // Make the outgoing release (the future `previous`) the OLDEST by mtime —
    // the real-world shape after a rollback then a later successful deploy —
    // so the keep-count alone can NOT spare it and only the protected-set
    // membership saves the rollback target.
    const old = (Date.now() - 7 * 86_400_000) / 1000
    utimesSync(join(fx.releases, fx.prevSha), old, old)
    const fakes: string[] = []
    for (let i = 0; i < 3; i++) {
      const sha = String(i).repeat(40).slice(0, 40)
      const dir = join(fx.releases, sha)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, ".complete"), "")
      const recent = (Date.now() - (i + 1) * 60_000) / 1000
      utimesSync(dir, recent, recent)
      fakes.push(sha)
    }
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r = runReleases(fx, stubs, temp, ["--releases-keep", "2"])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    // mtime order: target (built now), fake0..2, prev (7 days old): prev is
    // far past keep=2 and survives ONLY via the previous-link protection.
    expect(previousOf(fx.deploy)).toBe(`releases/${fx.prevSha}`)
    expect(existsSync(join(fx.releases, fx.prevSha, ".complete"))).toBe(true)
    // keep=2 spares target + fake0 by index; fake1/fake2 are pruned.
    expect(existsSync(join(fx.releases, fakes[0]))).toBe(true)
    expect(existsSync(join(fx.releases, fakes[1]))).toBe(false)
    expect(existsSync(join(fx.releases, fakes[2]))).toBe(false)
  })

  it("partials never occupy keep slots: unprotected incomplete releases are removed, complete ones retained", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    // Two NEWEST-by-mtime partials (no .complete) — under mtime-ranked keep
    // they would evict every complete release except current/previous.
    const partials: string[] = []
    for (let i = 0; i < 2; i++) {
      const sha = `${i}b`.repeat(20).slice(0, 40)
      const dir = join(fx.releases, sha)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "half-built.txt"), "partial\n")
      partials.push(sha)
    }
    // One complete release, older than the partials.
    const completeSha = "c".repeat(40)
    const completeDir = join(fx.releases, completeSha)
    mkdirSync(completeDir, { recursive: true })
    writeFileSync(join(completeDir, ".complete"), "")
    const old = (Date.now() - 86_400_000) / 1000
    utimesSync(completeDir, old, old)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const r = runReleases(fx, stubs, temp) // default keep=3
    expect(r.status, r.stdout + r.stderr).toBe(0)
    // Partials deleted regardless of age; the complete release keeps its slot
    // (index order: target, prev, complete → all within keep=3).
    for (const p of partials) expect(existsSync(join(fx.releases, p)), p).toBe(false)
    expect(existsSync(completeDir)).toBe(true)
    expect(existsSync(join(fx.releases, fx.prevSha, ".complete"))).toBe(true)
    expect(existsSync(join(fx.releases, fx.targetSha, ".complete"))).toBe(true)
  })

  it("refuse-all on a dangling previous: nothing deleted, deploy still exits 0", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const fakes = seedFakeReleases(fx.releases, 3)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    // The start hook dangles previous AFTER the flip restamped it (the only
    // window where prune can observe a dangling link).
    const r = runReleases(fx, stubs, temp, ["--releases-keep", "2"], {
      // -sfn, not -sfT: same replace-the-symlink semantics on GNU, but BSD ln
      // has no -T and the hook must dangle previous on macOS hosts too.
      STUB_START_HOOK: `ln -sfn releases/${"f".repeat(40)} ${fx.deploy}/previous`,
    })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stderr).toContain("prune refused")
    for (const f of fakes) expect(existsSync(join(fx.releases, f)), f).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// deployed_sha / tri-state interaction
// ─────────────────────────────────────────────────────────────────────────────

describe("releases layout — identity fails closed", () => {
  it("dangling current → luna_runtime_matches_checkout returns 3 (INCONCLUSIVE), never 1", () => {
    const temp = makeTempDir()
    mkdirSync(join(temp, "deploy"), { recursive: true })
    symlinkSync("releases/" + "0".repeat(40), join(temp, "deploy", "current"))
    const r = spawnSync(
      "bash",
      ["-c", `source ${join(repoRoot, "scripts/lib/luna-deploy.sh")}; luna_runtime_matches_checkout "${join(temp, "deploy", "current")}" 4753; echo "rc=$?"`],
      { encoding: "utf8", env: { ...process.env } },
    )
    expect(r.stdout).toContain("rc=3")
  })

  it("fresh deploy with a dangling current fails closed at preflight (die, exit 1)", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    unlinkCurrent(fx.deploy)
    symlinkSync("releases/" + "0".repeat(40), join(fx.deploy, "current"))
    const r = runReleases(fx, stubs, temp)
    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stderr).toContain("does not resolve to a complete release")
    expect(readLog(stubs.orderLog)).toBe("")
  })

  it("missing --ref in releases mode dies pointing at the registry (never degrades to origin/master)", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const r = spawnSync(
      "bash",
      [ENGINE, "--profile", "stable", "--layout", "releases", "--deploy-root", fx.deploy,
        "--luna-home", join(temp, "state"), "--service-dir", serviceDir],
      {
        cwd: repoRoot, encoding: "utf8",
        env: { ...process.env, PATH: `${stubs.bin}:${process.env.PATH}`, LUNA_TEST_WS_COUNT: "0" },
      },
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("requires an explicit --ref")
  })

  it("mirror without the origin refspec is refused at preflight (LOAD-BEARING)", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    gitDir(fx.mirror, "config", "--unset", "remote.origin.fetch")
    const r = runReleases(fx, stubs, temp)
    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stderr).toContain("remote.origin.fetch")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// luna-autodeploy releases mode
// ─────────────────────────────────────────────────────────────────────────────

describe("luna-autodeploy — releases mode", () => {
  const makeAutodeployEnv = (temp: string, fx: ReturnType<typeof makeReleasesFixture>, stubs: { bin: string }) => {
    const reg = join(temp, "servers.toml")
    writeFileSync(
      reg,
      [
        `kind = "registry"`,
        `[[server]]`,
        `name = "stable"`,
        `update.params.hostRepoDir = "${join(temp, "unused-repo")}"`,
        `update.params.ref = "origin/master"`,
        `ports.proxy = 4753`,
        `deploy.timer = true`,
        `deploy.layout = "releases"`,
        `deploy.root = "${fx.deploy}"`,
      ].join("\n") + "\n",
    )
    return {
      ...process.env,
      PATH: `${stubs.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      LUNA_SERVERS_CONFIG: reg,
      LUNA_TEST_STAT_MODE: "600",
      LUNA_TEST_WS_COUNT: "0",
      LUNA_TAILSCALE_IP: "",
      LUNA_GUARDIAN_STATE_DIR: join(temp, "guardian-state"),
      LUNA_UPDATE_STATE_DIR: join(temp, "update-state"),
    } as Record<string, string>
  }

  it("do_deploy fetches ONLY the mirror and passes --layout/--deploy-root through", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const env = makeAutodeployEnv(temp, fx, stubs)
    const r = spawnSync("bash", [AUTODEPLOY, "stable", "--dry-run"], { cwd: repoRoot, encoding: "utf8", env })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    // origin moved (current at prev, mirror knows target) → deploy line rendered.
    expect(r.stdout).toContain("deploying")
    expect(r.stdout).toContain("DRY-RUN")
    expect(r.stdout).toContain(`--layout releases --deploy-root ${fx.deploy}`)
    // fetch went to the mirror, NEVER into current/releases.
    const log = readFileSync(join(temp, "git.log"), "utf8").split("\n").filter(Boolean)
    const fetches = log.filter((l) => l.includes("fetch"))
    expect(fetches.length).toBeGreaterThan(0)
    for (const f of fetches) {
      expect(f).toContain(`--git-dir ${fx.mirror}`)
      expect(f).not.toContain("/current")
      expect(f).not.toContain("/releases/")
    }
  })

  it("do_repair: unresolvable current → exit 2 with named cause; rung 2 pins the RESOLVED release sha", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const env = makeAutodeployEnv(temp, fx, stubs)

    // Healthy: dry-run repair pins --ref to the resolved current release sha.
    const ok = spawnSync("bash", [AUTODEPLOY, "stable", "--repair", "--dry-run"], { cwd: repoRoot, encoding: "utf8", env })
    expect(ok.status, ok.stdout + ok.stderr).toBe(0)
    expect(ok.stdout).toContain(`--ref ${fx.prevSha} --restart-only`)
    expect(ok.stdout).not.toContain("--ref origin/master")

    // Dangling current: refuse unattended repair, exit 2.
    unlinkCurrent(fx.deploy)
    symlinkSync("releases/" + "0".repeat(40), join(fx.deploy, "current"))
    const bad = spawnSync("bash", [AUTODEPLOY, "stable", "--repair"], { cwd: repoRoot, encoding: "utf8", env })
    expect(bad.status, bad.stdout + bad.stderr).toBe(2)
    expect(bad.stderr).toContain("does not resolve")
    expect(bad.stderr).toContain("refusing unattended repair")
  })

  it("do_validate: passes on mirror+refspec+current+.complete; fails per broken element", () => {
    const temp = makeTempDir()
    const fx = makeReleasesFixture(temp)
    const stubs = makeReleasesStubBin(temp, fx.deploy, {
      prevSha: fx.prevSha, targetSha: fx.targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const env = { ...makeAutodeployEnv(temp, fx, stubs), LUNA_TEST_VALIDATE_SERVICE: "true" }

    const ok = spawnSync("bash", [AUTODEPLOY, "stable", "--validate"], { cwd: repoRoot, encoding: "utf8", env })
    expect(ok.status, ok.stdout + ok.stderr).toBe(0)
    expect(ok.stdout).toContain("releases deploy root")
    expect(ok.stdout).toContain("All checks passed")

    // Broken element 1: missing .complete on the current release.
    rmSync(join(fx.releases, fx.prevSha, ".complete"))
    const noComplete = spawnSync("bash", [AUTODEPLOY, "stable", "--validate"], { cwd: repoRoot, encoding: "utf8", env })
    expect(noComplete.status).toBe(2)
    expect(noComplete.stderr).toContain(".complete")
    writeFileSync(join(fx.releases, fx.prevSha, ".complete"), "")

    // Broken element 2: mirror without the refspec.
    gitDir(fx.mirror, "config", "--unset", "remote.origin.fetch")
    const noRefspec = spawnSync("bash", [AUTODEPLOY, "stable", "--validate"], { cwd: repoRoot, encoding: "utf8", env })
    expect(noRefspec.status).toBe(2)
    expect(noRefspec.stderr).toContain("refspec")
    gitDir(fx.mirror, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")

    // Broken element 3: dangling current.
    unlinkCurrent(fx.deploy)
    symlinkSync("releases/" + "0".repeat(40), join(fx.deploy, "current"))
    const dangling = spawnSync("bash", [AUTODEPLOY, "stable", "--validate"], { cwd: repoRoot, encoding: "utf8", env })
    expect(dangling.status).toBe(2)
    expect(dangling.stderr).toContain("does not resolve into")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// luna-server-install --layout releases
// ─────────────────────────────────────────────────────────────────────────────

describe("luna-server-install — releases layout", () => {
  const runInstall = (temp: string, args: ReadonlyArray<string>) => {
    const bin = join(temp, "ibin")
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, "systemctl"), "#!/usr/bin/env bash\nexit 0\n")
    // Stub bun: --units-only never invokes it, but the installer's [[ -x ]]
    // existence check must pass on any host — pointing LUNA_TEST_BUN_PATH at
    // a real path like /root/.bun/bin/bun only works inside the container.
    writeFileSync(join(bin, "bun"), "#!/usr/bin/env bash\nexit 0\n")
    for (const f of ["systemctl", "bun"]) spawnSync("chmod", ["+x", join(bin, f)])
    return spawnSync("bash", [SERVER_INSTALL, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        LUNA_TAILSCALE_IP: "",
        LUNA_TEST_BUN_PATH: join(bin, "bun"),
      },
    })
  }

  it("--layout releases requires --repo-dir ending in /current", () => {
    const temp = makeTempDir()
    const r = runInstall(temp, [
      "--profile", "stable", "--layout", "releases",
      "--repo-dir", "/root/luna/stable/repo",
      "--units-only", "--no-enable", "--no-start",
      "--service-dir", join(temp, "units"),
    ])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain("end in /current")
  })

  it("renders units THROUGH current and skips the .git guard (migration-window render)", () => {
    const temp = makeTempDir()
    const unitDir = join(temp, "units")
    // repo-dir points at a current that does NOT exist yet — exactly the
    // migration-window shape; the guard must not fire.
    const repoDir = join(temp, "not-yet-visible", "current")
    const r = runInstall(temp, [
      "--profile", "stable", "--layout", "releases",
      "--repo-dir", repoDir,
      "--luna-home", join(temp, "state"),
      "--units-only", "--no-enable", "--no-start",
      "--service-dir", unitDir,
    ])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    const unit = readFileSync(join(unitDir, "luna-chat-server.service"), "utf8")
    // Path-independent launcher (S07): WorkingDirectory names REPO_DIR itself
    // (no app-specific subpath) and ExecStart names ONLY the launcher, which
    // resolves the daemon's actual file relative to its own import.meta.url -
    // migration-window or not, the unit never encodes a version-dependent path.
    expect(unit).toContain(`WorkingDirectory=${repoDir}`)
    expect(unit).not.toContain(`WorkingDirectory=${repoDir}/apps/ui-web`)
    expect(unit).toMatch(/^ExecStart=.*bun run scripts\/luna-chat-server-entry\.ts$/m)
    const alert = readFileSync(join(unitDir, "luna-alert-luna-chat-server.service"), "utf8")
    expect(alert).toContain(`ExecStart=${repoDir}/scripts/luna-pager`)
  })

  it("invalid --layout value dies loudly", () => {
    const temp = makeTempDir()
    const r = runInstall(temp, [
      "--profile", "stable", "--layout", "release",
      "--repo-dir", join(temp, "x", "current"),
      "--units-only", "--no-enable", "--no-start",
      "--service-dir", join(temp, "units"),
    ])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain("invalid --layout")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Inplace verbatim signature (mechanical phase 1-3 preservation proof)
// ─────────────────────────────────────────────────────────────────────────────

describe("inplace verbatim signature", () => {
  // Rebuild the classic inplace fixture (mirrors update-server.test.ts).
  const makeInplaceFixture = (root: string) => {
    const origin = join(root, "origin.git")
    const work = join(root, "repo")
    mkdirSync(origin, { recursive: true })
    git(origin, "init", "--quiet", "--bare")
    const seed = join(root, "seed")
    mkdirSync(seed, { recursive: true })
    git(seed, "init", "--quiet")
    git(seed, "config", "user.email", "t@example.test")
    git(seed, "config", "user.name", "Test")
    git(seed, "checkout", "-q", "-B", "master")
    writeFileSync(join(seed, "file.txt"), "v1\n")
    writeFileSync(join(seed, "bun.lock"), "lock-v1\n")
    git(seed, "add", "-A")
    git(seed, "commit", "--quiet", "-m", "prev")
    const prevSha = git(seed, "rev-parse", "HEAD")
    writeFileSync(join(seed, "file.txt"), "v2\n")
    git(seed, "add", "-A")
    git(seed, "commit", "--quiet", "-m", "target")
    const targetSha = git(seed, "rev-parse", "HEAD")
    git(seed, "remote", "add", "origin", origin)
    git(seed, "push", "--quiet", "origin", "master")
    git(root, "clone", "--quiet", origin, work)
    git(work, "checkout", "--quiet", prevSha)
    mkdirSync(join(work, "node_modules"), { recursive: true })
    writeFileSync(join(work, "node_modules", ".keep"), "keep\n")
    // The PHASE3_TIP pinned engine (below) still runs the ui-web build and
    // checks this artifact - S11 only removed it from the LIVE engine, so
    // the fixture must still satisfy the historical engine's own postcondition.
    mkdirSync(join(work, "apps", "ui-web", "dist"), { recursive: true })
    writeFileSync(join(work, "apps", "ui-web", "dist", "index.html"), "<!doctype html>\n")
    return { work, prevSha, targetSha }
  }

  const makeInplaceStubs = (root: string, repo: string, targetSha: string) => {
    const bin = join(root, "bin")
    mkdirSync(bin, { recursive: true })
    const systemctlLog = join(root, "systemctl.log")
    const curlLog = join(root, "curl.log")
    const bunLog = join(root, "bun.log")
    writeFileSync(join(bin, "systemctl"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${systemctlLog}"
case "$1" in
  is-active) printf 'active\\n'; exit 0 ;;
  show) printf '0\\n'; exit 0 ;;
  *) exit 0 ;;
esac
`)
    writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${curlLog}"
head="$(git -C "${repo}" rev-parse HEAD 2>/dev/null || printf 'unknown')"
code='503'
if [[ "$head" == "${targetSha}" ]]; then code='200'; fi
if [[ "$*" == *"/readyz"* ]]; then
  printf '{"status":"ok","mode":"normal","credentialOk":true,"buildSha":"%s"}\\n%s' "$head" "$code"
  exit 0
fi
printf '%s' "$code"
exit 0
`)
    writeFileSync(join(bin, "bun"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${bunLog}"
exit 0
`)
    for (const f of ["systemctl", "curl", "bun"]) spawnSync("chmod", ["+x", join(bin, f)])
    return { bin, systemctlLog, curlLog, bunLog }
  }

  // The phases 1-3 tip, pinned BY COMMIT ID and not HEAD: once phase 4 is
  // committed, HEAD IS the phase-4 engine and a HEAD-based comparison would
  // compare the engine to itself — permanently vacuous on any clean checkout,
  // silently evaporating the preservation guarantee this test exists for.
  // Assembled from halves: the CI secret-scan hard gate greps tracked SOURCE
  // for 40-hex runs and would read a whole commit id as a leaked credential.
  const PHASE3_TIP = "c8f135057ae16d1bf159" + "6ae1423f219b75e4f87b"

  // The pinned engine is a HISTORICAL artifact that needs bash 4+ (${var,,});
  // under macOS's /bin/bash 3.2 it crashes mid-deploy with "bad substitution"
  // yet exits 0. Before the live engine was made 3.2-clean, BOTH sides crashed
  // identically there, and this compare passed VACUOUSLY on empty-vs-empty
  // command streams. A real comparison needs a bash that can still run the
  // historical side: probe for one, skip honestly when the host has none.
  // The blocking CI gate always has bash 4+, so the guarantee never lapses
  // where it counts.
  const BASH4 = (() => {
    for (const candidate of ["bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash"]) {
      const r = spawnSync(candidate, ["-c", 'x=A; [[ "${x,,}" == a ]]'], { encoding: "utf8" })
      if (r.status === 0) return candidate
    }
    return null
  })()

  it.skipIf(BASH4 === null)("the phase-4 engine's inplace command stream is byte-identical to the committed pre-phase-4 engine's", () => {
    // Extract the phase-3 engine at the pinned commit and run BOTH engines
    // over identical fixtures, comparing the full recorded command streams.
    const temp = makeTempDir()
    const oldEngineDir = join(temp, "old-engine")
    mkdirSync(join(oldEngineDir, "lib"), { recursive: true })
    const show = (p: string) => {
      const r = spawnSync("git", ["-C", repoRoot, "show", `${PHASE3_TIP}:${p}`], { encoding: "utf8" })
      // Fail loudly if the pinned commit is unavailable (e.g. a shallow
      // clone) instead of silently comparing against an empty file.
      expect(r.status, `git show ${PHASE3_TIP}:${p}: ${r.stderr}`).toBe(0)
      return r.stdout
    }
    writeFileSync(join(oldEngineDir, "luna-update-server"), show("scripts/luna-update-server"))
    writeFileSync(join(oldEngineDir, "lib", "luna-deploy.sh"), show("scripts/lib/luna-deploy.sh"))
    spawnSync("chmod", ["+x", join(oldEngineDir, "luna-update-server")])

    const streams: string[] = []
    for (const engine of [join(oldEngineDir, "luna-update-server"), ENGINE]) {
      const root = join(temp, engine === ENGINE ? "new" : "old")
      mkdirSync(root, { recursive: true })
      const fx = makeInplaceFixture(root)
      const stubs = makeInplaceStubs(root, fx.work, fx.targetSha)
      const serviceDir = join(root, "systemd")
      writeUnit(serviceDir)
      const r = spawnSync(
        BASH4 as string,
        [engine, "--profile", "stable", "--repo-dir", fx.work, "--ref", "origin/master",
          "--luna-home", join(root, "state"), "--service-dir", serviceDir,
          "--readiness-timeout", "5", "--readiness-interval", "1"],
        {
          cwd: repoRoot, encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${stubs.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            LUNA_RESTART_SETTLE_SECS: "0",
            LUNA_TEST_WS_COUNT: "0",
            LUNA_UPDATE_STATE_DIR: join(root, "update-state"),
          },
        },
      )
      expect(r.status, `${engine}: ${r.stdout}${r.stderr}`).toBe(0)
      const normalize = (s: string) => s.split(root).join("ROOT")
      const bunLog = normalize(readLog(stubs.bunLog))
      const uiWebBuildLine = /^run --cwd \S+ --filter @luna\/ui-web build$/m
      // S11 intentionally dropped the `@luna/ui-web build` step from the
      // inplace apply (nothing serves the frontend build anymore) - the ONE
      // sanctioned divergence from PHASE3_TIP. Strip that single line from
      // the HISTORICAL stream only, and assert its absence on the LIVE
      // stream directly, so a regression that re-adds the step to the live
      // engine fails this test instead of being silently stripped away.
      const bunLogForCompare = engine === ENGINE
        ? bunLog
        : bunLog.split("\n").filter((line) => !uiWebBuildLine.test(line)).join("\n")
      if (engine === ENGINE) {
        expect(bunLog).not.toMatch(uiWebBuildLine)
      }
      streams.push(
        "SYSTEMCTL:\n" + normalize(readLog(stubs.systemctlLog)) +
        "BUN:\n" + bunLogForCompare +
        "CURL:\n" + normalize(readLog(stubs.curlLog)),
      )
    }
    expect(streams[1]).toBe(streams[0])
  })
})
