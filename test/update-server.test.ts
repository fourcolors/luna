import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

const repoRoot = new URL("..", import.meta.url).pathname
const tempDirs: string[] = []

const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-update-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const git = (cwd: string, ...args: ReadonlyArray<string>) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`)
  }
  return r.stdout.trim()
}

// Build a deploy-style checkout: a local bare `origin` plus a working clone with
// TWO commits on master. This gives the script a REAL `git fetch origin` +
// `git reset --hard <ref>` to drive — no faking of git's internal state. Returns
// the working-clone path plus the two commit SHAs (prev = first, target = HEAD).
const makeDeployRepo = (root: string) => {
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
  // Same lockfile content as prev → "lockfile unchanged" path for the happy test.
  git(seed, "add", "-A")
  git(seed, "commit", "--quiet", "-m", "target")
  const targetSha = git(seed, "rev-parse", "HEAD")
  git(seed, "remote", "add", "origin", origin)
  git(seed, "push", "--quiet", "origin", "master")

  // The deploy checkout starts at PREV (so an update to origin/master moves it
  // forward to target).
  git(root, "clone", "--quiet", origin, work)
  git(work, "config", "user.email", "t@example.test")
  git(work, "config", "user.name", "Test")
  git(work, "checkout", "--quiet", prevSha)

  return { origin, work, prevSha, targetSha }
}

// Stub bin dir with deterministic systemctl/curl/bun. The readiness VERDICT is
// keyed off the repo's CURRENT HEAD (read live by the curl stub) compared to
// env-provided SHAs — so there is zero timing dependence:
//   READY_AT_TARGET=1 → curl 200 when HEAD==target (happy path)
//   READY_AT_PREV=1   → curl 200 when HEAD==prev   (rollback recovers)
// Each stub appends to its own log so the test can assert call counts/sequence.
const makeStubBin = (
  root: string,
  opts: {
    readonly repo: string
    readonly prevSha: string
    readonly targetSha: string
    readonly readyAtTarget: boolean
    readonly readyAtPrev: boolean
    // #28: simulate a deploy that boots (healthz 200) but lands in SETUP-mode at
    // the target SHA — /readyz reports mode=setup, so the deepened gate must FAIL.
    readonly setupAtTarget?: boolean
  },
) => {
  const bin = join(root, "bin")
  mkdirSync(bin, { recursive: true })
  const systemctlLog = join(root, "systemctl.log")
  const curlLog = join(root, "curl.log")
  const bunLog = join(root, "bun.log")

  // systemctl: is-active always "active"; NRestarts always "0"; restart/daemon-
  // reload just log. (Crash-loop detection is exercised indirectly; here the
  // verdict is driven purely by curl so the tests stay deterministic.)
  writeFileSync(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${systemctlLog}"
case "$1" in
  is-active) printf 'active\\n'; exit 0 ;;
  show) printf '0\\n'; exit 0 ;;
  *) exit 0 ;;
esac
`,
  )

  // curl: read the repo's live HEAD; emit 200 only at the SHA(s) marked ready.
  // Answers BOTH /healthz (bare code) and /readyz (JSON body + newline + code),
  // mirroring the two curl -w contracts the readiness gate uses.
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${curlLog}"
head="$(git -C "${opts.repo}" rev-parse HEAD 2>/dev/null || printf 'unknown')"
code='503'
mode='normal'
if [[ "$head" == "${opts.targetSha}" && "${opts.readyAtTarget ? "1" : "0"}" == "1" ]]; then
  code='200'
fi
if [[ "$head" == "${opts.prevSha}" && "${opts.readyAtPrev ? "1" : "0"}" == "1" ]]; then
  code='200'
fi
# #28: a deploy that boots into setup-mode answers /healthz 200 but /readyz setup.
if [[ "$head" == "${opts.targetSha}" && "${opts.setupAtTarget ? "1" : "0"}" == "1" ]]; then
  code='200'; mode='setup'
fi
if [[ "$*" == *"/readyz"* ]]; then
  # Mirror curl -sS -w '\\n%{http_code}' on /readyz: JSON body, newline, code.
  okbool='true'; [[ "$mode" == 'setup' ]] && okbool='false'
  printf '{"status":"ok","mode":"%s","credentialOk":%s}\\n%s' "$mode" "$okbool" "$code"
  exit 0
fi
# /healthz: mirror -o /dev/null -w '%{http_code}' → print just the code. Exit 0 so
# the script's own [[ "$http" == "200" ]] gate (not curl's rc) decides.
printf '%s' "$code"
exit 0
`,
  )

  // bun: log the invocation so we can assert install fired ONLY when bun.lock
  // changed. Exit 0 (a real frozen install would succeed on an unchanged lock).
  writeFileSync(
    join(bin, "bun"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${bunLog}"
exit 0
`,
  )

  spawnSync("chmod", ["+x", join(bin, "systemctl"), join(bin, "curl"), join(bin, "bun")])
  return { bin, systemctlLog, curlLog, bunLog }
}

const runUpdate = (
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined> = {},
) =>
  spawnSync("bash", [join(repoRoot, "scripts/luna-update-server"), ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  })

// Create the SYSTEM unit file the script's user-unit guard requires.
const writeUnit = (serviceDir: string, name = "luna-chat-server.service") => {
  mkdirSync(serviceDir, { recursive: true })
  writeFileSync(join(serviceDir, name), "[Unit]\n")
}

describe("luna-update-server", () => {
  it("script is syntactically valid (bash -n)", () => {
    const r = spawnSync("bash", ["-n", join(repoRoot, "scripts/luna-update-server")], {
      encoding: "utf8",
    })
    expect(r.status, r.stderr).toBe(0)
  })

  it("script entrypoint is executable", () => {
    const mode = statSync(join(repoRoot, "scripts/luna-update-server")).mode
    expect(mode & 0o111).not.toBe(0)
  })

  it("--help prints usage and exits 0", () => {
    const r = runUpdate(["--help"])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain("Usage: scripts/luna-update-server")
    expect(r.stdout).toContain("--ref")
    expect(r.stdout).toContain("auto-roll")
  })

  it("--dry-run prints the plan and changes NOTHING", () => {
    const temp = makeTempDir()
    const { work, targetSha } = makeDeployRepo(temp)
    const headBefore = git(work, "rev-parse", "HEAD")

    const r = runUpdate([
      "--dry-run",
      "--repo-dir",
      work,
      "--ref",
      "origin/master",
      "--luna-home",
      join(temp, "state"),
      "--service-dir",
      join(temp, "systemd"),
    ], { LUNA_TEST_BUN_PATH: "/root/.bun/bin/bun" })

    expect(r.status, r.stderr).toBe(0)
    // The plan mentions every stage the task requires.
    expect(r.stdout).toContain("fetch origin")
    expect(r.stdout).toContain("reset --hard")
    expect(r.stdout).toContain("origin/master")
    expect(r.stdout).toContain("bun install")
    expect(r.stdout).toContain("frozen-lockfile")
    expect(r.stdout).toContain("daemon-reload")
    expect(r.stdout).toContain("restart luna-chat-server.service")
    expect(r.stdout).toContain("readiness probe")
    expect(r.stdout).toContain("ROLLED BACK")
    expect(r.stdout).toContain("exit 2")
    // Nothing happened: HEAD unchanged, no state/systemd dir written.
    expect(git(work, "rev-parse", "HEAD")).toBe(headBefore)
    expect(headBefore).not.toBe(targetSha) // sanity: an update WOULD move it
    expect(existsSync(join(temp, "state"))).toBe(false)
    expect(existsSync(join(temp, "systemd", "luna-chat-server.service"))).toBe(false)
  })

  it("rejects a non-git repo-dir with a clean error and no side effects", () => {
    const temp = makeTempDir()
    const r = runUpdate([
      "--repo-dir",
      join(temp, "missing"),
      "--luna-home",
      join(temp, "state"),
      "--service-dir",
      join(temp, "systemd"),
    ], { PATH: "/usr/bin:/bin" })

    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain("is not a git clone")
    expect(existsSync(join(temp, "state"))).toBe(false)
  })

  it("rejects an invalid profile", () => {
    const temp = makeTempDir()
    const r = runUpdate(["--profile", "bad name!", "--repo-dir", join(temp, "x")])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain("profile must contain only")
  })

  it("refuses when the system unit is absent (user-unit host out of scope)", () => {
    const temp = makeTempDir()
    const { work } = makeDeployRepo(temp)
    // No unit file written under service-dir → the user-unit guard must fire
    // BEFORE any git fetch / restart.
    const { bin } = makeStubBin(temp, {
      repo: work,
      prevSha: "x",
      targetSha: "y",
      readyAtTarget: true,
      readyAtPrev: true,
    })
    const r = runUpdate([
      "--repo-dir",
      work,
      "--ref",
      "origin/master",
      "--luna-home",
      join(temp, "state"),
      "--service-dir",
      join(temp, "systemd"),
    ], {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    })

    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain("out of scope for v1")
  })

  it("happy path: readiness OK → update applied, exit 0, no rollback", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const { bin, systemctlLog, bunLog } = makeStubBin(temp, {
      repo: work,
      prevSha,
      targetSha,
      readyAtTarget: true,
      readyAtPrev: false,
    })

    const r = runUpdate([
      "--repo-dir",
      work,
      "--ref",
      "origin/master",
      "--luna-home",
      join(temp, "state"),
      "--service-dir",
      serviceDir,
      "--readiness-timeout",
      "2",
      "--readiness-interval",
      "0.3",
    ], {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    })

    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain(`updated ${prevSha} -> ${targetSha}`)
    // The checkout actually moved forward to the target.
    expect(git(work, "rev-parse", "HEAD")).toBe(targetSha)
    // Exactly one restart cycle (no rollback restart).
    const restarts = (readFileSync(systemctlLog, "utf8").match(/restart/g) ?? []).length
    expect(restarts).toBe(1)
    // bun.lock is identical between prev and target → install skipped.
    expect(existsSync(bunLog)).toBe(false)
    expect(r.stdout).toContain("skipping bun install")
  })

  it("runs bun install when bun.lock changed between revisions", () => {
    const temp = makeTempDir()
    // Custom repo where target has a DIFFERENT bun.lock from prev.
    const origin = join(temp, "origin.git")
    const seed = join(temp, "seed")
    const work = join(temp, "repo")
    mkdirSync(origin, { recursive: true })
    git(origin, "init", "--quiet", "--bare")
    mkdirSync(seed, { recursive: true })
    git(seed, "init", "--quiet")
    git(seed, "config", "user.email", "t@example.test")
    git(seed, "config", "user.name", "Test")
    git(seed, "checkout", "-q", "-B", "master")
    writeFileSync(join(seed, "bun.lock"), "lock-v1\n")
    git(seed, "add", "-A")
    git(seed, "commit", "--quiet", "-m", "prev")
    const prevSha = git(seed, "rev-parse", "HEAD")
    writeFileSync(join(seed, "bun.lock"), "lock-v2-CHANGED\n")
    git(seed, "add", "-A")
    git(seed, "commit", "--quiet", "-m", "target")
    const targetSha = git(seed, "rev-parse", "HEAD")
    git(seed, "remote", "add", "origin", origin)
    git(seed, "push", "--quiet", "origin", "master")
    git(temp, "clone", "--quiet", origin, work)
    git(work, "checkout", "--quiet", prevSha)

    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const { bin, bunLog } = makeStubBin(temp, {
      repo: work,
      prevSha,
      targetSha,
      readyAtTarget: true,
      readyAtPrev: false,
    })

    const r = runUpdate([
      "--repo-dir",
      work,
      "--ref",
      "origin/master",
      "--luna-home",
      join(temp, "state"),
      "--service-dir",
      serviceDir,
      "--readiness-timeout",
      "2",
      "--readiness-interval",
      "0.3",
    ], {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    })

    expect(r.status, r.stderr).toBe(0)
    // bun.lock differed → install fired with the frozen flag.
    expect(existsSync(bunLog)).toBe(true)
    expect(readFileSync(bunLog, "utf8")).toContain("install")
    expect(readFileSync(bunLog, "utf8")).toContain("--frozen-lockfile")
  })

  it("forward COMMAND failure (bun install errors) → rolls back, exit 1 (not a set -e abort)", () => {
    const temp = makeTempDir()
    // Lockfile differs prev↔target so `bun install` fires in BOTH directions:
    // forward (fails) and rollback (succeeds the 2nd time).
    const origin = join(temp, "origin.git")
    const seed = join(temp, "seed")
    const work = join(temp, "repo")
    mkdirSync(origin, { recursive: true })
    git(origin, "init", "--quiet", "--bare")
    mkdirSync(seed, { recursive: true })
    git(seed, "init", "--quiet")
    git(seed, "config", "user.email", "t@example.test")
    git(seed, "config", "user.name", "Test")
    git(seed, "checkout", "-q", "-B", "master")
    writeFileSync(join(seed, "bun.lock"), "lock-v1\n")
    git(seed, "add", "-A")
    git(seed, "commit", "--quiet", "-m", "prev")
    const prevSha = git(seed, "rev-parse", "HEAD")
    writeFileSync(join(seed, "bun.lock"), "lock-v2\n")
    git(seed, "add", "-A")
    git(seed, "commit", "--quiet", "-m", "target")
    const targetSha = git(seed, "rev-parse", "HEAD")
    git(seed, "remote", "add", "origin", origin)
    git(seed, "push", "--quiet", "origin", "master")
    git(temp, "clone", "--quiet", origin, work)
    git(work, "checkout", "--quiet", prevSha)

    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    // Custom bin: bun FAILS on its first invocation (forward install), succeeds
    // after — so the forward apply errors at the command level, must route to
    // rollback (not abort), and rollback's own install then succeeds. curl is
    // healthy at PREV so the rollback recovers → exit 1.
    const bin = join(temp, "bin")
    mkdirSync(bin, { recursive: true })
    const bunCount = join(temp, "bun-count")
    const systemctlLog = join(temp, "systemctl.log")
    writeFileSync(
      join(bin, "systemctl"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${systemctlLog}"
case "$1" in is-active) echo active;; show) echo 0;; esac
exit 0
`,
    )
    writeFileSync(
      join(bin, "curl"),
      `#!/usr/bin/env bash
head="$(git -C "${work}" rev-parse HEAD 2>/dev/null || echo unknown)"
code='503'; [[ "$head" == "${prevSha}" ]] && code='200'
if [[ "$*" == *"/readyz"* ]]; then
  printf '{"status":"ok","mode":"normal","credentialOk":true}\\n%s' "$code"; exit 0
fi
printf '%s' "$code"
exit 0
`,
    )
    writeFileSync(
      join(bin, "bun"),
      `#!/usr/bin/env bash
n=0; [[ -f "${bunCount}" ]] && n="$(cat "${bunCount}")"
n=$((n+1)); printf '%s' "$n" > "${bunCount}"
# First install (forward) fails; later installs (rollback) succeed.
[[ "$n" -eq 1 ]] && exit 1
exit 0
`,
    )
    spawnSync("chmod", ["+x", join(bin, "systemctl"), join(bin, "curl"), join(bin, "bun")])

    const r = runUpdate([
      "--repo-dir",
      work,
      "--ref",
      "origin/master",
      "--luna-home",
      join(temp, "state"),
      "--service-dir",
      serviceDir,
      "--readiness-timeout",
      "2",
      "--readiness-interval",
      "0.3",
    ], {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    })

    // The forward bun install errored — but the script did NOT abort; it rolled
    // back and recovered.
    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stderr).toContain("ROLLED BACK")
    // Ended back at PREV.
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
  })

  it("readiness FAIL → rollback to PREV, restart again, exit 1", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    // Healthy only at PREV: the new HEAD never passes, PREV does → rollback OK.
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work,
      prevSha,
      targetSha,
      readyAtTarget: false,
      readyAtPrev: true,
    })

    const r = runUpdate([
      "--repo-dir",
      work,
      "--ref",
      "origin/master",
      "--luna-home",
      join(temp, "state"),
      "--service-dir",
      serviceDir,
      "--readiness-timeout",
      "1",
      "--readiness-interval",
      "0.3",
    ], {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    })

    expect(r.status).toBe(1)
    expect(r.stderr).toContain("ROLLED BACK")
    expect(r.stderr).toContain(prevSha)
    // The checkout ended back at PREV (rollback git reset --hard worked).
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    // Two restart cycles: the failed update + the rollback.
    const restarts = (readFileSync(systemctlLog, "utf8").match(/restart/g) ?? []).length
    expect(restarts).toBe(2)
  })

  it("#28 deepened gate: deploy boots into SETUP-mode (healthz 200 but readyz setup) → rollback, exit 1", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    // The new HEAD is ALIVE (healthz 200) but lands in setup-mode (readyz reports
    // mode=setup) — a credential-lapsed boot the old liveness-only gate would have
    // falsely accepted. PREV is a healthy normal-mode build, so rollback recovers.
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work,
      prevSha,
      targetSha,
      readyAtTarget: false,
      readyAtPrev: true,
      setupAtTarget: true,
    })

    const r = runUpdate([
      "--repo-dir",
      work,
      "--ref",
      "origin/master",
      "--luna-home",
      join(temp, "state"),
      "--service-dir",
      serviceDir,
      "--readiness-timeout",
      "1",
      "--readiness-interval",
      "0.3",
    ], {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    })

    // The setup-mode boot is NOT accepted: gate fails → rollback to PREV (normal).
    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stderr).toContain("ROLLED BACK")
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
  })

  it("readiness FAIL with --no-rollback → exit 1, NO revert", () => {
    const temp = makeTempDir()
    const { work, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work,
      prevSha: "noprev",
      targetSha,
      readyAtTarget: false,
      readyAtPrev: false,
    })

    const r = runUpdate([
      "--repo-dir",
      work,
      "--ref",
      "origin/master",
      "--luna-home",
      join(temp, "state"),
      "--service-dir",
      serviceDir,
      "--no-rollback",
      "--readiness-timeout",
      "1",
      "--readiness-interval",
      "0.3",
    ], {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    })

    expect(r.status).toBe(1)
    expect(r.stderr).toContain("--no-rollback")
    // Stayed on the (unhealthy) target; never reverted.
    expect(git(work, "rev-parse", "HEAD")).toBe(targetSha)
    // Only ONE restart — no rollback restart.
    const restarts = (readFileSync(systemctlLog, "utf8").match(/restart/g) ?? []).length
    expect(restarts).toBe(1)
  })

  it("--incus exits non-zero at parse with not-supported message, nothing runs", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const { bin, systemctlLog, curlLog, bunLog } = makeStubBin(temp, {
      repo: work,
      prevSha,
      targetSha,
      readyAtTarget: true,
      readyAtPrev: true,
    })

    const r = runUpdate([
      "--repo-dir",
      work,
      "--ref",
      "origin/master",
      "--luna-home",
      join(temp, "state"),
      "--service-dir",
      serviceDir,
      "--incus",
      "somecontainer",
    ], {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    })

    // Must exit non-zero and print the not-supported message.
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain("not supported in v1")
    // No side effects: no state dir, git HEAD unchanged, no stub logs written.
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    expect(existsSync(join(temp, "state"))).toBe(false)
    expect(existsSync(systemctlLog)).toBe(false)
    expect(existsSync(curlLog)).toBe(false)
    expect(existsSync(bunLog)).toBe(false)
  })

  it("crash-loop (NRestarts climbing) treated as failure → rollback, exit 1", () => {
    // The service is 'active' and curl would return 200 at target, BUT NRestarts
    // is climbing (baseline=0, then 1 during the probe) → the crash-loop guard
    // must reject this as unhealthy and trigger rollback. Rollback goes to PREV
    // where NRestarts stays at 0 and curl returns 200 → recovers, exit 1.
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)

    const bin = join(temp, "bin")
    mkdirSync(bin, { recursive: true })
    const systemctlLog = join(temp, "systemctl.log")
    const curlLog = join(temp, "curl.log")
    // Counter file for NRestarts at target: first show call (baseline) reads 0
    // then writes 1; second show call (probe) reads 1 (> baseline 0) → crash-loop
    // detected. When HEAD==prev the counter resets on restart so rollback's
    // baseline=0 and probe=0 → recovers.
    const nrestartsCounter = join(temp, "nrestarts-counter")

    // systemctl: NRestarts climbs at target (read-before-increment), stays 0 at
    // prev. is-active always "active".
    writeFileSync(
      join(bin, "systemctl"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${systemctlLog}"
case "$1" in
  is-active) printf 'active\\n'; exit 0 ;;
  show)
    head="$(git -C "${work}" rev-parse HEAD 2>/dev/null || printf 'unknown')"
    if [[ "$head" == "${targetSha}" ]]; then
      # Read current value (returned as NRestarts), then increment for next call.
      # First call: returns 0 (baseline=0). Second call: returns 1 (>baseline) →
      # crash-loop detected.
      n=0
      [[ -f "${nrestartsCounter}" ]] && n="$(cat "${nrestartsCounter}")"
      printf '%s\\n' "$n"
      printf '%s' "$((n+1))" > "${nrestartsCounter}"
    else
      printf '0\\n'
    fi
    exit 0
    ;;
  restart|daemon-reload)
    # On restart at PREV, reset the counter so rollback probe sees 0.
    head="$(git -C "${work}" rev-parse HEAD 2>/dev/null || printf 'unknown')"
    if [[ "$head" == "${prevSha}" ]]; then
      rm -f "${nrestartsCounter}"
    fi
    exit 0
    ;;
  *) exit 0 ;;
esac
`,
    )

    // curl: returns 200 at target (so crash-loop is the ONLY failure gate) and
    // also at prev (so rollback recovers after the crash-loop guard fires).
    writeFileSync(
      join(bin, "curl"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${curlLog}"
if [[ "$*" == *"/readyz"* ]]; then
  printf '{"status":"ok","mode":"normal","credentialOk":true}\\n200'; exit 0
fi
printf '200'
exit 0
`,
    )

    writeFileSync(join(bin, "bun"), `#!/usr/bin/env bash\nexit 0\n`)
    spawnSync("chmod", ["+x", join(bin, "systemctl"), join(bin, "curl"), join(bin, "bun")])

    const r = runUpdate([
      "--repo-dir",
      work,
      "--ref",
      "origin/master",
      "--luna-home",
      join(temp, "state"),
      "--service-dir",
      serviceDir,
      "--readiness-timeout",
      "2",
      "--readiness-interval",
      "0.3",
    ], {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    })

    // NRestarts climbing at target → forward fails despite curl 200 → rollback.
    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stderr).toContain("ROLLED BACK")
    // Ended back at PREV.
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
  })

  it("network-free rollback: fetch failing does not break rollback recovery", () => {
    // Simulate a forward update that fails at readiness, then verify the rollback
    // succeeds WITHOUT needing `git fetch`. We achieve a fetch-free rollback by
    // deleting the origin bare repo after the script starts, so any `git fetch`
    // in the rollback path would fail — but the local reset to PREV must still
    // work because FIX 2 passes --no-fetch in do_rollback.
    const temp = makeTempDir()
    const { origin, work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)

    // Stub bin: unhealthy at target (triggers rollback), healthy at prev (recovers).
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work,
      prevSha,
      targetSha,
      readyAtTarget: false,
      readyAtPrev: true,
    })

    // Destroy the origin so that any `git fetch` during rollback would fail.
    rmSync(origin, { recursive: true, force: true })

    const r = runUpdate([
      "--repo-dir",
      work,
      "--ref",
      "origin/master",
      "--luna-home",
      join(temp, "state"),
      "--service-dir",
      serviceDir,
      "--readiness-timeout",
      "1",
      "--readiness-interval",
      "0.3",
    ], {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    })

    // Rollback must succeed despite origin being gone (no fetch in rollback path).
    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stderr).toContain("ROLLED BACK")
    // Server ended at PREV — rollback local reset worked.
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    // Only ONE restart cycle: the forward apply_ref fails at fetch (before
    // restart_service runs), so only the rollback's restart fires. This is the
    // key assertion: exit 1 (not exit 2) proves rollback succeeded without fetch.
    const restarts = (readFileSync(systemctlLog, "utf8").match(/restart/g) ?? []).length
    expect(restarts).toBe(1)
  })

  it("readiness FAIL AND rollback FAIL → CRITICAL, exit 2", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    // Never healthy at any SHA → update fails AND rollback fails.
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work,
      prevSha,
      targetSha,
      readyAtTarget: false,
      readyAtPrev: false,
    })

    const r = runUpdate([
      "--repo-dir",
      work,
      "--ref",
      "origin/master",
      "--luna-home",
      join(temp, "state"),
      "--service-dir",
      serviceDir,
      "--readiness-timeout",
      "1",
      "--readiness-interval",
      "0.3",
    ], {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    })

    expect(r.status).toBe(2)
    expect(r.stderr).toContain("CRITICAL")
    expect(r.stderr).toContain("Manual intervention required")
    // Rollback was still ATTEMPTED → it reset to PREV (just didn't come up).
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    // Two restart cycles attempted (update + rollback).
    const restarts = (readFileSync(systemctlLog, "utf8").match(/restart/g) ?? []).length
    expect(restarts).toBe(2)
  })
})
