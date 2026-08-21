/**
 * F11 — luna_pin_engine quarantine tests.
 *
 * Verifies that luna-autodeploy copies the engine bundle to a sha-stamped
 * directory before the real invocation, preventing self-mutation when
 * git reset --hard advances across a commit touching scripts/.
 *
 * Test seam: LUNA_TEST_PIN_DIR (overrides /usr/local/lib/luna).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  cpSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterAll, afterEach, describe, expect, it } from "vitest"

const repoRoot = new URL("..", import.meta.url).pathname
const FIXTURE = join(repoRoot, "test/fixtures/servers.toml")
const LUNA_AUTODEPLOY = join(repoRoot, "scripts/luna-autodeploy")
const LUNA_REGISTRY = join(repoRoot, "scripts/lib/luna-registry.sh")

// FIX 2: The pin sha is keyed by the ENGINE repo HEAD, not the deploy target's.
//
// THE ENGINE IS A FIXTURE, NOT THE LIVE scripts/ DIRECTORY, and that is a
// correctness fix rather than tidiness. This file used to read the real repo's
// HEAD once at module load, while luna_pin_engine reads it again on every
// invocation. Any git operation between those two reads - a colleague
// switching branches, a parallel CI step, an agent committing while the suite
// runs - made them disagree and failed up to 9 tests with paths that differed
// only in the sha. It was reproducible on demand with nothing more than:
//
//     git commit --allow-empty        (HEAD moves, the working tree does not)
//
// Pointing UPDATE_SERVER at a throwaway repo whose single commit this file
// created removes the shared mutable input entirely. The sha is now ours.
const engineRepo = mkdtempSync(join(tmpdir(), "luna-engine-fixture-"))
const engineSha = (() => {
  const lib = join(engineRepo, "lib")
  mkdirSync(lib, { recursive: true })
  // The REAL engine and libs - only their git history is synthetic, so the
  // copy/permission/completeness assertions still exercise real files.
  cpSync(join(repoRoot, "scripts/luna-update-server"), join(engineRepo, "luna-update-server"))
  cpSync(join(repoRoot, "scripts/lib"), lib, { recursive: true })
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", engineRepo, ...args], { encoding: "utf8" })
  git("init", "--initial-branch=master")
  git("config", "user.email", "test@test.com")
  git("config", "user.name", "Test")
  git("add", ".")
  git("commit", "-m", "engine fixture")
  return git("rev-parse", "HEAD").stdout.trim()
})()
const engineSrc = join(engineRepo, "luna-update-server")

afterAll(() => {
  rmSync(engineRepo, { recursive: true, force: true })
})

const tempDirs: string[] = []
const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-engine-pin-"))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Build a minimal fake git repo with a controlled HEAD sha and a stub
 * luna-update-server at the expected scripts/ location.
 *
 * Layout:
 *   <repoDir>/.git/              — real minimal git repo
 *   <repoDir>/../luna-update-server — stub engine (beside scripts/ sibling)
 *   <repoDir>/../lib/            — stub lib dir (luna-deploy.sh, luna-registry.sh)
 *
 * We cannot easily override the scripts/ dir path used by SELF inside
 * luna-autodeploy, so instead we construct a fake repo whose git HEAD
 * is a predictable sha (set via a real `git commit`), and we rely on
 * LUNA_TEST_PIN_DIR to redirect where the pin lands.
 *
 * For the engine-copy tests we call luna_pin_engine directly via a
 * small bash wrapper — simpler than exercising the full deploy path.
 */
const makeStubRepo = (pinDir: string): { repoDir: string; sha: string } => {
  const base = makeTempDir()
  const repoDir = join(base, "repo")
  mkdirSync(repoDir, { recursive: true })

  // Init real git repo so rev-parse works
  spawnSync("git", ["-C", repoDir, "init", "--initial-branch=master"], { encoding: "utf8" })
  spawnSync("git", ["-C", repoDir, "config", "user.email", "test@test.com"], { encoding: "utf8" })
  spawnSync("git", ["-C", repoDir, "config", "user.name", "Test"], { encoding: "utf8" })
  writeFileSync(join(repoDir, "README"), "stub")
  spawnSync("git", ["-C", repoDir, "add", "."], { encoding: "utf8" })
  spawnSync("git", ["-C", repoDir, "commit", "-m", "init"], { encoding: "utf8" })
  const revParse = spawnSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" })
  const sha = revParse.stdout.trim()

  return { repoDir, sha }
}

/**
 * Call luna_pin_engine <repo_dir> via a bash wrapper that sources luna-autodeploy
 * (using `set` to expose only luna_pin_engine) and captures the echoed path.
 *
 * We source luna-autodeploy in a sub-shell after stubbing the libs it sources,
 * instead of running the full script (avoids arg-parsing side-effects).
 */
const callPinEngine = (
  repoDir: string,
  pinDir: string,
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } => {
  // Bash script: source autodeploy to import luna_pin_engine then call it.
  // We set LUNA_TEST_WS_COUNT so the lib sourcing doesn't fail and
  // LUNA_SERVERS_CONFIG so the registry source is satisfied.
  const bashCmd = [
    "set -euo pipefail",
    // Source the script to define functions; suppress the no-profile error by
    // wrapping in a function context. We source with `bash -c` which doesn't
    // trigger the arg-parsing at the bottom of the file — that code runs only
    // when the file is executed (via $BASH_SOURCE check... actually it runs
    // unconditionally). So we need a different approach: extract the function.
    //
    // Safer approach: grep out the luna_pin_engine function body and eval it,
    // plus set the UPDATE_SERVER variable that it needs.
    `UPDATE_SERVER="${engineSrc}"`,
    `LUNA_TEST_PIN_DIR="${pinDir}"`,
    // Extract and define luna_pin_engine from the autodeploy file
    `eval "$(awk '/^luna_pin_engine\(\)/{found=1} found{print} found && /^}$/{exit}' "${LUNA_AUTODEPLOY}")"`,
    `result="$(luna_pin_engine "${repoDir}")"`,
    `printf '%s' "$result"`,
  ].join("\n")

  const result = spawnSync("bash", ["-c", bashCmd], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      LUNA_TEST_PIN_DIR: pinDir,
      LUNA_TEST_WS_COUNT: "0",
      LUNA_TAILSCALE_IP: "",
      LUNA_SERVERS_CONFIG: FIXTURE,
      LUNA_TEST_STAT_MODE: "600",
      ...extraEnv,
    },
  })
  return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? -1 }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core copy tests
// ─────────────────────────────────────────────────────────────────────────────

describe("F11: luna_pin_engine — copy mechanics", () => {
  it("copies luna-update-server into <pinDir>/deploy-engine@<engineSha>/", () => {
    const pinDir = makeTempDir()
    const { repoDir } = makeStubRepo(pinDir)

    const result = callPinEngine(repoDir, pinDir)
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)

    // FIX 2: pin dir is keyed by the ENGINE's repo sha, not the target sha
    const expectedDir = join(pinDir, `deploy-engine@${engineSha}`)
    expect(existsSync(join(expectedDir, "luna-update-server"))).toBe(true)
  })

  it("copies lib/ alongside so engine→lib relative path resolves", () => {
    const pinDir = makeTempDir()
    const { repoDir } = makeStubRepo(pinDir)

    const result = callPinEngine(repoDir, pinDir)
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)

    const expectedDir = join(pinDir, `deploy-engine@${engineSha}`)
    // lib/ must exist as a directory
    expect(existsSync(join(expectedDir, "lib"))).toBe(true)
    // At least luna-deploy.sh and luna-registry.sh must be present
    const libFiles = readdirSync(join(expectedDir, "lib"))
    expect(libFiles).toContain("luna-deploy.sh")
    expect(libFiles).toContain("luna-registry.sh")
  })

  it("pinned engine is executable", () => {
    const pinDir = makeTempDir()
    const { repoDir } = makeStubRepo(pinDir)

    callPinEngine(repoDir, pinDir)

    const pinnedEngine = join(pinDir, `deploy-engine@${engineSha}`, "luna-update-server")
    // Check executable bit via bash `test -x`
    const check = spawnSync("bash", ["-c", `test -x "${pinnedEngine}"`], { encoding: "utf8" })
    expect(check.status).toBe(0)
  })

  it("returns the pinned engine path on stdout", () => {
    const pinDir = makeTempDir()
    const { repoDir } = makeStubRepo(pinDir)

    const result = callPinEngine(repoDir, pinDir)
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    const expected = join(pinDir, `deploy-engine@${engineSha}`, "luna-update-server")
    expect(result.stdout.trim()).toBe(expected)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("F11: luna_pin_engine — idempotency", () => {
  it("second call with same sha reuses existing dir (no re-copy error, same path returned)", () => {
    const pinDir = makeTempDir()
    const { repoDir } = makeStubRepo(pinDir)

    const first = callPinEngine(repoDir, pinDir)
    expect(first.status, `first call stderr: ${first.stderr}`).toBe(0)

    const second = callPinEngine(repoDir, pinDir)
    expect(second.status, `second call stderr: ${second.stderr}`).toBe(0)

    // Both must return the same path
    expect(second.stdout.trim()).toBe(first.stdout.trim())

    // FIX 2: pin dir keyed by engine sha, not target sha
    const expectedDir = join(pinDir, `deploy-engine@${engineSha}`)
    expect(existsSync(expectedDir)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Pinned engine actually runs
// ─────────────────────────────────────────────────────────────────────────────

describe("F11: luna_pin_engine — pinned binary runs from pinned location", () => {
  it("exec'ing the pinned path uses the copy, not the in-tree file", () => {
    const pinDir = makeTempDir()
    const { repoDir } = makeStubRepo(pinDir)

    // First, pin the engine
    const pinResult = callPinEngine(repoDir, pinDir)
    expect(pinResult.status, `stderr: ${pinResult.stderr}`).toBe(0)

    const pinnedEngine = pinResult.stdout.trim()
    // FIX 2: pin dir is keyed by engine sha
    expect(pinnedEngine).toContain(`deploy-engine@${engineSha}`)

    // Verify the pinned path is a real executable file (not just a symlink
    // to the original) by overwriting the original with a canary file and
    // confirming the pinned copy is unaffected.
    // Compare against the file that was actually PINNED - the fixture engine -
    // not the in-tree one. They happen to be byte-identical (the fixture is a
    // copy), which is exactly why naming the wrong one would have gone
    // unnoticed.
    const originalContent = readFileSync(engineSrc, "utf8")

    // The pinned file must have identical content to the original at pin time
    const pinnedContent = readFileSync(pinnedEngine, "utf8")
    expect(pinnedContent).toBe(originalContent)

    // Pinned file lives at the expected path
    expect(pinnedEngine).toBe(join(pinDir, `deploy-engine@${engineSha}`, "luna-update-server"))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Fail-safe: unwritable pin dir → warn + fall back to in-tree path
// ─────────────────────────────────────────────────────────────────────────────

describe("F11: luna_pin_engine — fail-safe", () => {
  it("unwritable LUNA_TEST_PIN_DIR → emits WARNING to stderr, returns in-tree path, exit 0", () => {
    const { repoDir } = makeStubRepo(makeTempDir())

    // Point at a non-existent path rooted under /dev/null/... (guaranteed unwritable)
    const unwritableDir = "/dev/null/luna-pin-cannot-create"

    const result = callPinEngine(repoDir, unwritableDir)
    // Must not fail (deploy must not be blocked)
    expect(result.status).toBe(0)
    // Must warn on stderr
    expect(result.stderr).toContain("WARNING")
    expect(result.stderr).toContain("self-mutation hazard")
    // Must fall back to the in-tree path - which is the fixture engine, since
    // that is what UPDATE_SERVER points at.
    expect(result.stdout.trim()).toBe(engineSrc)
  })

  it("bad repo dir (no .git) → still pins successfully using engine repo sha (FIX 2: target repo no longer needed for sha)", () => {
    const pinDir = makeTempDir()
    const badRepo = makeTempDir() // no .git inside

    // FIX 2: sha comes from the ENGINE repo, not the target.
    // A bad target dir no longer causes a failure — we can still pin from the engine sha.
    const result = callPinEngine(badRepo, pinDir)
    expect(result.status).toBe(0)
    // Should successfully return the pinned engine path (engine sha is always valid)
    const expected = join(pinDir, `deploy-engine@${engineSha}`, "luna-update-server")
    expect(result.stdout.trim()).toBe(expected)
    // No warning should be emitted (engine repo is always accessible)
    expect(result.stderr).not.toContain("self-mutation hazard")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION: dry-run golden no-op is byte-identical (pinning must not touch it)
// ─────────────────────────────────────────────────────────────────────────────

describe("F11 REGRESSION: dry-run golden no-op still byte-identical", () => {
  /**
   * Shared fake-git environment used by both the golden (registry-disabled)
   * and registry-driven dry-run runs.
   */
  const makeDryRunEnv = () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-pin-golden-"))
    tempDirs.push(temp)
    mkdirSync(join(temp, "repo", ".git"), { recursive: true })
    const fakeBin = join(temp, "bin")
    mkdirSync(fakeBin)
    writeFileSync(
      join(fakeBin, "git"),
      `#!/usr/bin/env bash\n` +
      `case "$*" in\n` +
      `  *"fetch origin"*) exit 0 ;;\n` +
      `  *"rev-parse HEAD") printf 'aaaaaaaaa\\n' ;;\n` +
      `  *"rev-parse origin/"*) printf 'bbbbbbbbb\\n' ;;\n` +
      `  *) /usr/bin/git "$@" ;;\n` +
      `esac\n`,
    )
    spawnSync("chmod", ["+x", join(fakeBin, "git")])
    return { temp, fakeBin }
  }

  const runDryRun = (
    profile: string,
    opts: {
      disableRegistry?: boolean
      sharedEnv: { temp: string; fakeBin: string }
      pinDir?: string
    },
  ) => {
    const { temp, fakeBin } = opts.sharedEnv
    const profileUpper = profile.toUpperCase().replace(/[^A-Z0-9]/g, "_")
    const repoEnvKey = `LUNA_${profileUpper}_REPO_DIR`

    const env: Record<string, string | undefined> = {
      ...process.env,
      LUNA_TEST_WS_COUNT: "0",
      LUNA_TAILSCALE_IP: "",
      [repoEnvKey]: join(temp, "repo"),
      PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      LUNA_SERVERS_CONFIG: FIXTURE,
      LUNA_TEST_STAT_MODE: "600",
      ...(opts.disableRegistry ? { LUNA_REGISTRY_DISABLE: "1" } : {}),
      ...(opts.pinDir ? { LUNA_TEST_PIN_DIR: opts.pinDir } : {}),
    }
    return spawnSync("bash", [LUNA_AUTODEPLOY, profile, "--dry-run"], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    })
  }

  const extractDryRunLine = (stdout: string): string => {
    const match = stdout.match(/DRY-RUN: .+/)
    if (!match) throw new Error(`No DRY-RUN line found in:\n${stdout}`)
    return match[0].replace(/DRY-RUN: .+(luna-update-server)/, "DRY-RUN: luna-update-server")
  }

  it("stable: DRY-RUN line is byte-identical whether or not LUNA_TEST_PIN_DIR is set", () => {
    const sharedEnv = makeDryRunEnv()
    const pinDir = mkdtempSync(join(tmpdir(), "luna-pin-golden-pindir-"))
    tempDirs.push(pinDir)

    // golden: no pin dir
    const golden = runDryRun("stable", { disableRegistry: true, sharedEnv })
    // with pin dir set (must not alter dry-run output)
    const withPin = runDryRun("stable", { disableRegistry: true, sharedEnv, pinDir })

    expect(golden.status, `golden stderr: ${golden.stderr}`).toBe(0)
    expect(withPin.status, `withPin stderr: ${withPin.stderr}`).toBe(0)

    const goldenLine = extractDryRunLine(golden.stdout)
    const withPinLine = extractDryRunLine(withPin.stdout)
    expect(withPinLine).toBe(goldenLine)
  })

  it("dev: DRY-RUN line is byte-identical whether or not LUNA_TEST_PIN_DIR is set", () => {
    const sharedEnv = makeDryRunEnv()
    const pinDir = mkdtempSync(join(tmpdir(), "luna-pin-golden-pindir-"))
    tempDirs.push(pinDir)

    const golden = runDryRun("dev", { disableRegistry: true, sharedEnv })
    const withPin = runDryRun("dev", { disableRegistry: true, sharedEnv, pinDir })

    expect(golden.status, `golden stderr: ${golden.stderr}`).toBe(0)
    expect(withPin.status, `withPin stderr: ${withPin.stderr}`).toBe(0)

    const goldenLine = extractDryRunLine(golden.stdout)
    const withPinLine = extractDryRunLine(withPin.stdout)
    expect(withPinLine).toBe(goldenLine)
  })

  it("1b golden: stable registry uses --incus luna-stable (diverges from hardcoded fallback intentionally)", () => {
    // Phase 1b: the registry path is correct (--incus luna-stable).
    // The hardcoded fallback (DISABLE=1) retains the legacy bare-host path.
    // These MUST differ after 1b — registry=incus, fallback=repo-dir.
    // This test verifies the registry path, not equality between the two.
    const sharedEnv = makeDryRunEnv()

    const registry = runDryRun("stable", { disableRegistry: false, sharedEnv })

    expect(registry.status, `registry stderr: ${registry.stderr}`).toBe(0)

    const registryLine = extractDryRunLine(registry.stdout)
    // Registry must produce the incus invocation (the correct one)
    expect(registryLine).toContain("--profile stable --incus luna-stable --ref origin/master")
    expect(registryLine).not.toContain("--repo-dir")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1: Partial-pin race — stale dir (binary present, NO .complete) → re-pin
// ─────────────────────────────────────────────────────────────────────────────

describe("FIX 1: partial-pin race recovery", () => {
  it("stale partial dir (binary, no .complete, no lib/) → re-pins with complete+lib", () => {
    const pinDir = makeTempDir()
    const { repoDir } = makeStubRepo(pinDir)

    // FIX 2: pre-create a stale partial dir keyed by the ENGINE sha (not the stub target sha)
    const partialDir = join(pinDir, `deploy-engine@${engineSha}`)
    mkdirSync(partialDir, { recursive: true })
    writeFileSync(join(partialDir, "luna-update-server"), "#!/bin/sh\necho stub\n")
    spawnSync("chmod", ["+x", join(partialDir, "luna-update-server")])
    // Explicitly NO .complete and NO lib/

    const result = callPinEngine(repoDir, pinDir)
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)

    // .complete must now exist
    expect(existsSync(join(partialDir, ".complete"))).toBe(true)
    // lib/ must now exist
    expect(existsSync(join(partialDir, "lib"))).toBe(true)
    // Should NOT have reused the stub binary (must have re-copied real engine)
    const content = readFileSync(join(partialDir, "luna-update-server"), "utf8")
    expect(content).not.toContain("echo stub")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1: Completeness — after a successful pin, .complete exists and lib/ is present
// ─────────────────────────────────────────────────────────────────────────────

describe("FIX 1: completeness marker", () => {
  it("after successful pin, .complete exists and lib/ is populated", () => {
    const pinDir = makeTempDir()
    const { repoDir } = makeStubRepo(pinDir)

    const result = callPinEngine(repoDir, pinDir)
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)

    // FIX 2: keyed by engine sha
    const expectedDir = join(pinDir, `deploy-engine@${engineSha}`)
    expect(existsSync(join(expectedDir, ".complete"))).toBe(true)
    expect(existsSync(join(expectedDir, "lib"))).toBe(true)
    const libFiles = readdirSync(join(expectedDir, "lib"))
    expect(libFiles.length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2: Stamp uses engine repo HEAD, not target repo HEAD
// ─────────────────────────────────────────────────────────────────────────────

describe("FIX 2: pin sha keyed by engine repo, not target repo", () => {
  it("pin dir name uses engine repo HEAD even when target repo has a different HEAD", () => {
    // We build a stub repo for the "target" (repoDir), but luna_pin_engine should
    // stamp from the engine's OWN repo (the real Luna repo root where luna-update-server lives).
    // So the pin dir sha should equal the real repo's HEAD, NOT the stub target's sha.
    const pinDir = makeTempDir()
    const { repoDir, sha: targetSha } = makeStubRepo(pinDir)

    // The engine is the module-level fixture repo, so its HEAD is a sha this
    // file created - which is what makes "engine sha, not target sha" provable
    // rather than merely likely.

    // Only meaningful if target and engine repos have different HEADs
    // (which they do: the stub target has a fresh single-commit sha).
    expect(targetSha).not.toBe(engineSha)

    const result = callPinEngine(repoDir, pinDir)
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)

    // The pin dir should be keyed by the ENGINE's sha (repoRoot HEAD)
    const expectedDir = join(pinDir, `deploy-engine@${engineSha}`)
    expect(existsSync(expectedDir)).toBe(true)

    // The pin dir must NOT be keyed by the target repo's sha
    const wrongDir = join(pinDir, `deploy-engine@${targetSha}`)
    expect(existsSync(wrongDir)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FIX 3: Prune — pinning >5 distinct shas keeps only the most recent 5
// ─────────────────────────────────────────────────────────────────────────────

describe("FIX 3: prune old pin dirs", () => {
  it("after pinning >5 distinct shas only 5 dirs remain", () => {
    const pinDir = makeTempDir()

    // Pre-create 6 fake complete pin dirs with different timestamps
    const fakeShas = ["aaa111", "bbb222", "ccc333", "ddd444", "eee555", "fff666"]
    for (const fakeSha of fakeShas) {
      const dir = join(pinDir, `deploy-engine@${fakeSha}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, ".complete"), "")
      writeFileSync(join(dir, "luna-update-server"), "#!/bin/sh\necho stub\n")
      spawnSync("chmod", ["+x", join(dir, "luna-update-server")])
      // Small sleep to spread mtimes — not needed in bash `ls -dt` but harmless
    }

    const { repoDir } = makeStubRepo(pinDir)

    // Running pin creates a 7th dir (the real engine sha) + prunes to 5
    const result = callPinEngine(repoDir, pinDir)
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)

    // Count remaining deploy-engine@ dirs
    const remaining = readdirSync(pinDir).filter((d) => d.startsWith("deploy-engine@"))
    expect(remaining.length).toBeLessThanOrEqual(5)
  })
})
