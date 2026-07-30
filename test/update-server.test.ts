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
    // Legacy /readyz responses can omit the additive buildSha field. Forward
    // promotion must reject that ambiguity, while rollback may accept it.
    readonly omitBuildShaAtTarget?: boolean
    readonly omitBuildShaAtPrev?: boolean
    readonly mismatchBuildShaAtPrev?: boolean
    // Phase 2 session-guard matrix: when set, `systemctl is-active` answers
    // THIS string (may be empty) until the first `start` lands, then 'active'
    // — modelling a dead/activating unit that comes up after the restart.
    // Undefined keeps the legacy always-'active' behaviour.
    readonly isActive?: string
  },
) => {
  const bin = join(root, "bin")
  mkdirSync(bin, { recursive: true })
  const systemctlLog = join(root, "systemctl.log")
  const curlLog = join(root, "curl.log")
  const bunLog = join(root, "bun.log")
  const startedMarker = join(root, "started.marker")

  // systemctl: is-active "active" (or opts.isActive until a start happened);
  // NRestarts always "0"; stop/start/daemon-reload just log. (Crash-loop
  // detection is exercised indirectly; here the verdict is driven purely by
  // curl so the tests stay deterministic.)
  const isActiveLine =
    opts.isActive === undefined
      ? `printf 'active\\n'`
      : `if [[ -f "${startedMarker}" ]]; then printf 'active\\n'; else printf '%s\\n' '${opts.isActive}'; fi`
  writeFileSync(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${systemctlLog}"
case "$1" in
  is-active) ${isActiveLine}; exit 0 ;;
  start) : > "${startedMarker}"; exit 0 ;;
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
  if [[ "$head" == "${opts.targetSha}" && "${opts.omitBuildShaAtTarget ? "1" : "0"}" == "1" ]] ||
     [[ "$head" == "${opts.prevSha}" && "${opts.omitBuildShaAtPrev ? "1" : "0"}" == "1" ]]; then
    printf '{"status":"ok","mode":"%s","credentialOk":%s}\\n%s' "$mode" "$okbool" "$code"
  elif [[ "$head" == "${opts.prevSha}" && "${opts.mismatchBuildShaAtPrev ? "1" : "0"}" == "1" ]]; then
    printf '{"status":"ok","mode":"%s","credentialOk":%s,"buildSha":"deadbeef"}\\n%s' "$mode" "$okbool" "$code"
  else
    printf '{"status":"ok","mode":"%s","credentialOk":%s,"buildSha":"%s"}\\n%s' "$mode" "$okbool" "$head" "$code"
  fi
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

// Add an `incus` stub into an existing stub bin so the --incus LIVE path can be
// exercised hermetically (the repo's verify design expected a stub `incus`). The
// script invokes `incus exec <container> -- <cmd...>`; the stub strips everything
// up to and including `--` and runs <cmd...> LOCALLY, so the in-container
// systemctl/curl/bun calls hit the SAME PATH stubs as bare-host. git still runs
// for-real on the host work-repo (the script keeps git host-side), so the curl
// stub's HEAD-based readiness verdict works unchanged.
//
// The ONE special case: the claude re-pin is `incus exec <c> -- bash -lc
// 'source /root/luna/... && luna_configure_claude_executable ...'`. Running that
// payload on the test host would fail (no /root/luna), spuriously triggering
// rollback. So the stub treats an in-container re-pin as a hermetic no-op —
// mirroring that on a real container it just rewrites the container .env.
const addIncusStub = (bin: string, incusLog: string) => {
  writeFileSync(
    join(bin, "incus"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${incusLog}"
# Only 'incus exec <container> -- <cmd...>' is used; strip up to and incl. '--'.
if [[ "$1" == "exec" ]]; then
  shift            # drop 'exec'
  shift            # drop <container>
  [[ "$1" == "--" ]] && shift   # drop '--'
  # Hermetic no-op for the in-container claude re-pin (would need /root/luna).
  if [[ "$1" == "bash" && "$*" == *"luna_configure_claude_executable"* ]]; then
    exit 0
  fi
  "$@"             # run the in-container command against the PATH stubs
  exit $?
fi
exit 0
`,
  )
  spawnSync("chmod", ["+x", join(bin, "incus")])
}

const runUpdate = (
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined> = {},
) =>
  spawnSync("bash", [join(repoRoot, "scripts/luna-update-server"), ...args], {
    cwd: repoRoot,
    // Default the post-stop settle to 0 so the hermetic suite never sleeps the
    // 6s production default between stop and start; individual tests override it
    // (see the stop->settle->start regression test, which sets a real 1s).
    // Default LUNA_TEST_WS_COUNT to 0 so the engine's in-primitive session
    // guard never reads the LIVE host's :4753 socket table (production stable);
    // individual tests override it to exercise the guard.
    env: { ...process.env, LUNA_RESTART_SETTLE_SECS: "0", LUNA_TEST_WS_COUNT: "0", ...env },
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
    // Restart is now a clean stop -> settle -> start, not a fast `systemctl restart`.
    expect(r.stdout).toContain("stop luna-chat-server.service")
    expect(r.stdout).toContain("start luna-chat-server.service")
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
    expect(r.stderr).toContain("not found; run luna-server-install")
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
    // Exactly one restart cycle (no rollback restart). A cycle is now stop ->
    // settle -> start, so count `stop ` calls (one per cycle) rather than the
    // retired `restart` verb.
    const cycles = (readFileSync(systemctlLog, "utf8").match(/stop /g) ?? []).length
    expect(cycles).toBe(1)
    // bun.lock is identical between prev and target → install skipped.
    const bunLogContent = existsSync(bunLog) ? readFileSync(bunLog, "utf8") : ""
    const hasInstall = bunLogContent.split("\n").some(line => line.startsWith("install"))
    expect(hasInstall).toBe(false)
    expect(r.stdout).toContain("skipping bun install")
  })

  it("recovers an update killed after checkout from the durable journal", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    const updateState = join(temp, "update-state")
    writeUnit(serviceDir)
    const { bin } = makeStubBin(temp, {
      repo: work, prevSha, targetSha, readyAtTarget: true, readyAtPrev: true,
    })
    const args = [
      "--repo-dir", work, "--ref", "origin/master",
      "--luna-home", join(temp, "state"), "--service-dir", serviceDir,
      "--readiness-timeout", "2", "--readiness-interval", "0.3",
    ]
    const commonEnv = {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_UPDATE_STATE_DIR: updateState,
    }

    const killed = runUpdate(args, { ...commonEnv, LUNA_TEST_CRASH_AFTER_PHASE: "checkout" })
    expect(killed.signal).toBe("SIGKILL")
    expect(git(work, "rev-parse", "HEAD")).toBe(targetSha)
    expect(existsSync(join(updateState, "transaction-stable"))).toBe(true)
    expect(existsSync(join(updateState, "lock-stable"))).toBe(true)

    const recovered = runUpdate(args, commonEnv)
    expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0)
    expect(recovered.stderr).toContain("RECOVERING interrupted update")
    expect(git(work, "rev-parse", "HEAD")).toBe(targetSha)
    expect(existsSync(join(updateState, "transaction-stable"))).toBe(false)
    expect(existsSync(join(updateState, "lock-stable"))).toBe(false)
  })

  it("rejects a forward /readyz response that omits buildSha", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const { bin } = makeStubBin(temp, {
      repo: work,
      prevSha,
      targetSha,
      readyAtTarget: true,
      readyAtPrev: true,
      omitBuildShaAtTarget: true,
    })

    const r = runUpdate([
      "--repo-dir", work,
      "--ref", "origin/master",
      "--luna-home", join(temp, "state"),
      "--service-dir", serviceDir,
      "--readiness-timeout", "1",
      "--readiness-interval", "0.3",
    ], {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    })

    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stderr).toContain("ROLLED BACK")
    // The readiness timeout must name buildSha as the blocker so an operator is
    // not left staring at an opaque "failed readiness" rollback loop.
    expect(r.stderr).toContain("readiness gave up")
    expect(r.stderr).toContain("buildSha")
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
  })

  it("defers a concurrent update without touching the checkout", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    const updateState = join(temp, "update-state")
    const lockDir = join(updateState, "lock-stable")
    writeUnit(serviceDir)
    mkdirSync(lockDir, { recursive: true })
    const fingerprint = spawnSync("ps", ["-p", String(process.pid), "-o", "lstart="], {
      encoding: "utf8",
    }).stdout.replace(/\n/g, "")
    writeFileSync(join(lockDir, "owner"), `pid=${process.pid}\nfingerprint=${fingerprint}\n`)

    const r = runUpdate([
      "--repo-dir", work, "--ref", "origin/master",
      "--luna-home", join(temp, "state"), "--service-dir", serviceDir,
    ], { LUNA_UPDATE_STATE_DIR: updateState })

    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stderr).toContain("another update")
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    expect(prevSha).not.toBe(targetSha)
  })

  it("restart is a clean stop -> settle -> start (NOT a fast `systemctl restart`)", () => {
    // Regression for the 2026-06-08 stable-deploy incident: a fast `systemctl
    // restart` started the new chat-server before the outgoing one released its
    // DuckDB/SQLite WAL/SHM handles → SQLITE_CANTOPEN on boot → needless rollback.
    // The fix restarts as stop -> settle -> start. Here we use a real (tiny) 1s
    // settle to prove the knob is wired, and assert the ordered stop-before-start
    // sequence with NO fast restart.
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const { bin, systemctlLog } = makeStubBin(temp, {
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
      LUNA_RESTART_SETTLE_SECS: "1", // override the suite-default 0 → prove the wait runs
    })

    expect(r.status, r.stdout + r.stderr).toBe(0)
    const sys = readFileSync(systemctlLog, "utf8")
    // No fast restart — that overlapping stop+start was the bug.
    expect(sys).not.toContain("restart luna-chat-server.service")
    // Clean stop happens, and BEFORE the start.
    const stopIdx = sys.indexOf("stop luna-chat-server.service")
    const startIdx = sys.indexOf("start luna-chat-server.service")
    expect(stopIdx).toBeGreaterThanOrEqual(0)
    expect(startIdx).toBeGreaterThan(stopIdx)
    // The settle actually ran between them (the knob is wired into the cycle).
    expect(r.stdout).toContain("settling 1s")
  })

  it("invalid RESTART_SETTLE_SECS WARNS loudly and no-ops the settle (not a silent skip)", () => {
    // A bad settle value must not be swallowed silently (which would reintroduce
    // the WAL/SHM race with no signal). The settle is skipped, but a loud warning
    // is emitted; the deploy itself still proceeds and succeeds at the target.
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const { bin, systemctlLog } = makeStubBin(temp, {
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
      LUNA_RESTART_SETTLE_SECS: "not-a-number", // invalid → must warn, not silently skip
    })

    // Deploy still succeeds (the bad value degrades to no-settle, it does not abort).
    expect(r.status, r.stdout + r.stderr).toBe(0)
    // The operator gets a loud signal naming the bad value and the risk.
    expect(r.stderr).toContain("not-a-number")
    expect(r.stderr).toContain("SKIPPING the post-stop settle")
    // No bogus "settling" line — the settle was skipped, not attempted.
    expect(r.stdout).not.toContain("settling not-a-number")
    // Stop -> start still happened (one cycle); only the settle was skipped.
    const cycles = (readFileSync(systemctlLog, "utf8").match(/stop /g) ?? []).length
    expect(cycles).toBe(1)
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
  printf '{"status":"ok","mode":"normal","credentialOk":true,"buildSha":"%s"}\\n%s' "$head" "$code"; exit 0
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
    // Two restart cycles: the failed update + the rollback (count `stop ` calls,
    // one per stop -> settle -> start cycle).
    const cycles = (readFileSync(systemctlLog, "utf8").match(/stop /g) ?? []).length
    expect(cycles).toBe(2)
  })

  it("accepts a healthy rollback /readyz response that omits buildSha", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const { bin } = makeStubBin(temp, {
      repo: work,
      prevSha,
      targetSha,
      readyAtTarget: false,
      readyAtPrev: true,
      omitBuildShaAtPrev: true,
    })

    const r = runUpdate([
      "--repo-dir", work,
      "--ref", "origin/master",
      "--luna-home", join(temp, "state"),
      "--service-dir", serviceDir,
      "--readiness-timeout", "1",
      "--readiness-interval", "0.3",
    ], {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    })

    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stderr).toContain("ROLLED BACK")
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
  })

  it("rejects a rollback /readyz response whose present buildSha mismatches PREV", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const { bin } = makeStubBin(temp, {
      repo: work,
      prevSha,
      targetSha,
      readyAtTarget: false,
      readyAtPrev: true,
      mismatchBuildShaAtPrev: true,
    })

    const r = runUpdate([
      "--repo-dir", work,
      "--ref", "origin/master",
      "--luna-home", join(temp, "state"),
      "--service-dir", serviceDir,
      "--readiness-timeout", "1",
      "--readiness-interval", "0.3",
    ], {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    })

    expect(r.status, r.stdout + r.stderr).toBe(2)
    expect(r.stderr).toContain("CRITICAL")
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
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
    // Only ONE restart cycle — no rollback restart (count `stop `, one per cycle).
    const cycles = (readFileSync(systemctlLog, "utf8").match(/stop /g) ?? []).length
    expect(cycles).toBe(1)
  })

  it("--incus --dry-run plans git-on-host + bun/restart/probe in-container, changes NOTHING", () => {
    // The incus path routes correctly: git ops on the HOST repo mount, but bun
    // install / daemon-reload / restart / readiness curl INSIDE the container via
    // `incus exec`. --dry-run must PRINT that exact plan and execute nothing. We
    // pass --repo-dir explicitly so the host git ops drive the real test work-repo
    // (the auto-derived /root/luna/<profile>/repo would not exist here).
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const headBefore = git(work, "rev-parse", "HEAD")
    // No PATH stubs needed: dry-run prints commands via luna_run and never execs
    // incus/systemctl/curl. git runs for real on the host work-repo (read-only:
    // rev-parse/hash-object), which is exactly the routing we want to prove.
    const r = runUpdate([
      "--dry-run",
      "--profile",
      "dev",
      "--incus",
      "luna-dev",
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
    // Routing: git fetch/reset run on the HOST (luna_run prints them unwrapped,
    // NOT behind `incus exec`), against the host repo path.
    expect(r.stdout).toContain(`git -C ${work} fetch origin`)
    expect(r.stdout).toContain(`git -C ${work} reset --hard origin/master`)
    // bun install runs INSIDE the container, cwd = the in-container repo /root/luna.
    expect(r.stdout).toContain("incus exec luna-dev -- /root/.bun/bin/bun install --cwd /root/luna --frozen-lockfile")
    // daemon-reload + clean stop -> start of the dev unit run INSIDE the container
    // (the settle is a host-side wait, so it is not an `incus exec` line).
    expect(r.stdout).toContain("incus exec luna-dev -- systemctl daemon-reload")
    expect(r.stdout).toContain("incus exec luna-dev -- systemctl stop luna-dev-chat-server.service")
    expect(r.stdout).toContain("incus exec luna-dev -- systemctl start luna-dev-chat-server.service")
    // claude re-pin routed INTO the container (not a host-side path write). The
    // bash -lc payload is %q-escaped by luna_run, so match the function name +
    // in-container .env path on their own (spaces are backslash-escaped there).
    expect(r.stdout).toContain("incus exec luna-dev -- bash -lc")
    expect(r.stdout).toContain("luna_configure_claude_executable")
    expect(r.stdout).toContain("/root/.luna/.env")
    // Readiness probe targets the container-internal port 4753 (NOT a host proxy).
    expect(r.stdout).toContain("127.0.0.1:4753/healthz")
    expect(r.stdout).toContain("ROLLED BACK")
    expect(r.stdout).toContain("exit 2")
    // Nothing executed: HEAD unchanged, no state/systemd dir written.
    expect(git(work, "rev-parse", "HEAD")).toBe(headBefore)
    expect(headBefore).not.toBe(targetSha) // sanity: an update WOULD move it
    expect(existsSync(join(temp, "state"))).toBe(false)
    expect(existsSync(join(temp, "systemd", "luna-dev-chat-server.service"))).toBe(false)
  })

  it("--incus LIVE happy path: readiness OK in-container → exit 0, restart via incus exec", () => {
    // Exercise the incus path for REAL (not just the printed plan): an `incus`
    // stub strips up to `--` and runs the in-container command against the same
    // systemctl/curl/bun stubs. git runs host-side on the work-repo, the readiness
    // curl is healthy at target → update applied, exit 0, no rollback.
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    // Dev profile unit; the in-container unit-guard test -f runs locally via stub.
    writeUnit(serviceDir, "luna-dev-chat-server.service")
    const { bin, systemctlLog, bunLog } = makeStubBin(temp, {
      repo: work,
      prevSha,
      targetSha,
      readyAtTarget: true,
      readyAtPrev: false,
    })
    const incusLog = join(temp, "incus.log")
    addIncusStub(bin, incusLog)

    const r = runUpdate([
      "--profile",
      "dev",
      "--incus",
      "luna-dev",
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

    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain(`updated ${prevSha} -> ${targetSha}`)
    // The host checkout actually moved forward to the target (host git ran).
    expect(git(work, "rev-parse", "HEAD")).toBe(targetSha)
    // The restart (now stop -> start) was routed through `incus exec` (not a bare
    // host systemctl).
    const incus = readFileSync(incusLog, "utf8")
    expect(incus).toContain("exec luna-dev -- systemctl stop luna-dev-chat-server.service")
    expect(incus).toContain("exec luna-dev -- systemctl start luna-dev-chat-server.service")
    expect(incus).toContain("exec luna-dev -- systemctl daemon-reload")
    // bun.lock identical prev↔target → install skipped (incus bun never invoked).
    const bunLogContent = existsSync(bunLog) ? readFileSync(bunLog, "utf8") : ""
    const hasInstall = bunLogContent.split("\n").some(line => line.startsWith("install"))
    expect(hasInstall).toBe(false)
    expect(r.stdout).toContain("skipping bun install")
    // Exactly one restart cycle (no rollback) — counted from the in-container log
    // (one `stop ` per stop -> settle -> start cycle).
    const cycles = (readFileSync(systemctlLog, "utf8").match(/stop /g) ?? []).length
    expect(cycles).toBe(1)
  })

  it("--incus LIVE readiness FAIL → rollback to PREV in-container, restart again, exit 1", () => {
    // The incus path's whole point is auto-rollback. Healthy only at PREV: the new
    // HEAD never passes the in-container readiness probe → rollback resets the host
    // checkout to PREV and restarts the container unit again → exit 1.
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir, "luna-dev-chat-server.service")
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work,
      prevSha,
      targetSha,
      readyAtTarget: false,
      readyAtPrev: true,
    })
    const incusLog = join(temp, "incus.log")
    addIncusStub(bin, incusLog)

    const r = runUpdate([
      "--profile",
      "dev",
      "--incus",
      "luna-dev",
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

    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stderr).toContain("ROLLED BACK")
    expect(r.stderr).toContain(prevSha)
    // The host checkout ended back at PREV (rollback git reset --hard ran on host).
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    // Two restart cycles (failed update + rollback), both via incus exec (one
    // `stop ` per stop -> settle -> start cycle).
    const cycles = (readFileSync(systemctlLog, "utf8").match(/stop /g) ?? []).length
    expect(cycles).toBe(2)
    const incusOut = readFileSync(incusLog, "utf8")
    expect(incusOut).toContain("exec luna-dev -- systemctl stop luna-dev-chat-server.service")
    expect(incusOut).toContain("exec luna-dev -- systemctl start luna-dev-chat-server.service")
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
head="$(git -C "${work}" rev-parse HEAD 2>/dev/null || printf 'unknown')"
if [[ "$*" == *"/readyz"* ]]; then
  printf '{"status":"ok","mode":"normal","credentialOk":true,"buildSha":"%s"}\\n200' "$head"; exit 0
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

    // Let the transaction prefetch succeed, then destroy origin immediately.
    // Any later rollback fetch would fail, while the local PREV remains usable.
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim()
    writeFileSync(
      join(bin, "git"),
      `#!/usr/bin/env bash
if [[ "$*" == *" fetch origin"* ]]; then
  "${realGit}" "$@"
  rc=$?
  rm -rf "${origin}"
  exit $rc
fi
exec "${realGit}" "$@"
`,
    )
    spawnSync("chmod", ["+x", join(bin, "git")])

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
    // Two restart cycles: the transaction prefetch succeeds, then origin is
    // removed; the unhealthy forward start and the network-free rollback each
    // restart once. Exit 1 (not exit 2) proves rollback did not fetch.
    // (One `stop ` per stop -> settle -> start cycle.)
    const cycles = (readFileSync(systemctlLog, "utf8").match(/stop /g) ?? []).length
    expect(cycles).toBe(2)
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
    // Two restart cycles attempted (update + rollback); one `stop ` per cycle.
    const cycles = (readFileSync(systemctlLog, "utf8").match(/stop /g) ?? []).length
    expect(cycles).toBe(2)
  })

  // ── phase 2: in-primitive session guard ────────────────────────────────────

  const readLog = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "")

  const seedJournal = (
    updateState: string,
    fields: { phase: string; prev: string; target: string },
  ) => {
    mkdirSync(updateState, { recursive: true })
    writeFileSync(
      join(updateState, "transaction-stable"),
      `phase=${fields.phase}\nprev=${fields.prev}\ntarget=${fields.target}\nprev_lock_hash=\nupdated_at=${Math.floor(Date.now() / 1000)}\n`,
    )
  }

  const guardArgs = (temp: string, work: string, serviceDir: string, extra: string[] = []) => [
    "--repo-dir", work,
    "--ref", "origin/master",
    "--luna-home", join(temp, "state"),
    "--service-dir", serviceDir,
    "--readiness-timeout", "2",
    "--readiness-interval", "0.3",
    ...extra,
  ]

  it("session guard: live sessions defer a fresh update, nothing mutated (exit 3)", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    const updateState = join(temp, "update-state")
    writeUnit(serviceDir)
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work, prevSha, targetSha, readyAtTarget: true, readyAtPrev: false,
    })

    const r = runUpdate(guardArgs(temp, work, serviceDir), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_TEST_WS_COUNT: "2",
      LUNA_UPDATE_STATE_DIR: updateState,
    })

    expect(r.status, r.stdout + r.stderr).toBe(3)
    expect(r.stderr).toContain("DEFERRED by session guard")
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    expect(readLog(systemctlLog)).not.toContain("stop")
    // Guard fires BEFORE the first journal write: nothing to recover.
    expect(existsSync(join(updateState, "transaction-stable"))).toBe(false)
  })

  it("session guard: unknown count while the unit answers 'active' defers (blip fail-closed)", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    const updateState = join(temp, "update-state")
    writeUnit(serviceDir)
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work, prevSha, targetSha, readyAtTarget: true, readyAtPrev: false,
    })

    const r = runUpdate(guardArgs(temp, work, serviceDir), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_TEST_WS_COUNT: "unknown",
      LUNA_UPDATE_STATE_DIR: updateState,
    })

    expect(r.status, r.stdout + r.stderr).toBe(3)
    expect(r.stderr).toContain("may be serving")
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    expect(readLog(systemctlLog)).not.toContain("stop")
    expect(existsSync(join(updateState, "transaction-stable"))).toBe(false)
  })

  it("session guard: dead-server exception — unknown count + unit 'failed' proceeds (exit 0)", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work, prevSha, targetSha, readyAtTarget: true, readyAtPrev: false,
      isActive: "failed",
    })

    const r = runUpdate(guardArgs(temp, work, serviceDir), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_TEST_WS_COUNT: "unknown",
    })

    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stderr).toContain("no server process; restart permitted")
    expect(git(work, "rev-parse", "HEAD")).toBe(targetSha)
    const sys = readLog(systemctlLog)
    expect(sys).toContain("stop luna-chat-server.service")
    expect(sys).toContain("start luna-chat-server.service")
  })

  it("session guard: unknown count + unit 'activating' defers (pre-READY sockets)", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work, prevSha, targetSha, readyAtTarget: true, readyAtPrev: false,
      isActive: "activating",
    })

    const r = runUpdate(guardArgs(temp, work, serviceDir), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_TEST_WS_COUNT: "unknown",
    })

    expect(r.status, r.stdout + r.stderr).toBe(3)
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    expect(readLog(systemctlLog)).not.toContain("stop")
  })

  it("session guard: unknown count + empty is-active output defers (transport inconclusive)", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work, prevSha, targetSha, readyAtTarget: true, readyAtPrev: false,
      isActive: "",
    })

    const r = runUpdate(guardArgs(temp, work, serviceDir), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_TEST_WS_COUNT: "unknown",
    })

    expect(r.status, r.stdout + r.stderr).toBe(3)
    expect(r.stderr).toContain("transport never reached systemd")
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    expect(readLog(systemctlLog)).not.toContain("stop")
  })

  it("--operator-override proceeds past live sessions and logs the reason", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work, prevSha, targetSha, readyAtTarget: true, readyAtPrev: false,
    })

    const r = runUpdate(
      guardArgs(temp, work, serviceDir, ["--operator-override", "drill reason"]),
      {
        PATH: `${bin}:/usr/bin:/bin`,
        LUNA_TEST_BUN_PATH: join(bin, "bun"),
        LUNA_TEST_WS_COUNT: "2",
      },
    )

    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stderr).toContain("SESSION GUARD OVERRIDDEN by operator: drill reason")
    expect(git(work, "rev-parse", "HEAD")).toBe(targetSha)
    const sys = readLog(systemctlLog)
    expect(sys).toContain("stop luna-chat-server.service")
    expect(sys).toContain("start luna-chat-server.service")
  })

  it("--operator-override with a missing value dies before any mutation", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work, prevSha, targetSha, readyAtTarget: true, readyAtPrev: false,
    })

    const r = runUpdate(guardArgs(temp, work, serviceDir, ["--operator-override"]), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    })

    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain("missing --operator-override reason")
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    expect(prevSha).not.toBe(targetSha)
    expect(readLog(systemctlLog)).toBe("")
  })

  it("--restart-only: guarded plain restart — no checkout mutation, no install/build, no journal", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    const updateState = join(temp, "update-state")
    writeUnit(serviceDir)
    const { bin, systemctlLog, bunLog } = makeStubBin(temp, {
      repo: work, prevSha, targetSha, readyAtTarget: false, readyAtPrev: true,
    })

    const r = runUpdate(guardArgs(temp, work, serviceDir, ["--restart-only"]), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_UPDATE_STATE_DIR: updateState,
    })

    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain("restart-only")
    expect(r.stdout).toContain("healthy")
    // Checkout untouched — no fetch/reset effect on HEAD.
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    // No bun install/build in this mode.
    expect(readLog(bunLog)).toBe("")
    const sys = readLog(systemctlLog)
    expect(sys).toContain("daemon-reload")
    expect(sys).toContain("stop luna-chat-server.service")
    expect(sys).toContain("start luna-chat-server.service")
    // No transaction journal was created.
    expect(existsSync(join(updateState, "transaction-stable"))).toBe(false)
  })

  it("--restart-only: readiness failure exits 1 with NO rollback", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work, prevSha, targetSha, readyAtTarget: false, readyAtPrev: false,
    })

    const r = runUpdate(guardArgs(temp, work, serviceDir, ["--restart-only"]), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    })

    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stderr).toContain("no rollback")
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    // Exactly ONE stop -> start cycle: no rollback restart followed.
    const cycles = (readLog(systemctlLog).match(/stop /g) ?? []).length
    expect(cycles).toBe(1)
  })

  it("--restart-only: live sessions defer (exit 3, nothing stopped)", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work, prevSha, targetSha, readyAtTarget: false, readyAtPrev: true,
    })

    const r = runUpdate(guardArgs(temp, work, serviceDir, ["--restart-only"]), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_TEST_WS_COUNT: "2",
    })

    expect(r.status, r.stdout + r.stderr).toBe(3)
    expect(readLog(systemctlLog)).not.toContain("stop")
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    expect(prevSha).not.toBe(targetSha)
  })

  it("--restart-only with a pending forward journal runs normal recovery instead", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    const updateState = join(temp, "update-state")
    writeUnit(serviceDir)
    const { bin } = makeStubBin(temp, {
      repo: work, prevSha, targetSha, readyAtTarget: true, readyAtPrev: false,
    })
    seedJournal(updateState, { phase: "restarting", prev: prevSha, target: targetSha })

    const r = runUpdate(guardArgs(temp, work, serviceDir, ["--restart-only"]), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_UPDATE_STATE_DIR: updateState,
    })

    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stderr).toContain("running normal recovery instead")
    expect(r.stderr).toContain("RECOVERING interrupted update")
    // Recovery completed the transaction: forward to target, journal cleared.
    expect(git(work, "rev-parse", "HEAD")).toBe(targetSha)
    expect(existsSync(join(updateState, "transaction-stable"))).toBe(false)
  })

  it("rollback is exempt from the session guard (live sessions cannot strand a broken build)", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    const updateState = join(temp, "update-state")
    writeUnit(serviceDir)
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work, prevSha, targetSha, readyAtTarget: false, readyAtPrev: true,
    })
    seedJournal(updateState, { phase: "rolling-back", prev: prevSha, target: targetSha })

    const r = runUpdate(guardArgs(temp, work, serviceDir), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_TEST_WS_COUNT: "2",
      LUNA_UPDATE_STATE_DIR: updateState,
    })

    // Recovery completed the rollback despite 2 "live" sessions: the guard
    // never blocks do_rollback (the forward restart already interrupted service).
    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stderr).toContain("ROLLED BACK")
    expect(r.stderr).toContain("without the session guard")
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    const sys = readLog(systemctlLog)
    expect(sys).toContain("stop luna-chat-server.service")
    expect(sys).toContain("start luna-chat-server.service")
    expect(existsSync(join(updateState, "transaction-stable"))).toBe(false)
  })

  it("mid-transaction defer preserves the journal and a later idle run resumes it", () => {
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    const updateState = join(temp, "update-state")
    writeUnit(serviceDir)
    const { bin } = makeStubBin(temp, {
      repo: work, prevSha, targetSha, readyAtTarget: true, readyAtPrev: false,
    })
    seedJournal(updateState, { phase: "restarting", prev: prevSha, target: targetSha })

    const deferred = runUpdate(guardArgs(temp, work, serviceDir), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_TEST_WS_COUNT: "2",
      LUNA_UPDATE_STATE_DIR: updateState,
    })
    expect(deferred.status, deferred.stdout + deferred.stderr).toBe(3)
    expect(deferred.stderr).toContain("transaction journal retained")
    expect(existsSync(join(updateState, "transaction-stable"))).toBe(true)

    const resumed = runUpdate(guardArgs(temp, work, serviceDir), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_TEST_WS_COUNT: "0",
      LUNA_UPDATE_STATE_DIR: updateState,
    })
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0)
    expect(git(work, "rev-parse", "HEAD")).toBe(targetSha)
    expect(existsSync(join(updateState, "transaction-stable"))).toBe(false)
  })

  it("session guard: dead-server exception — unknown count + unit 'inactive' proceeds (exit 0)", () => {
    // Pins the OTHER arm of the inactive|failed dead-server predicate: a future
    // edit that splits the case and mishandles 'inactive' (e.g. routes it to
    // the fail-closed default) would deadlock repair of a cleanly-stopped unit.
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    writeUnit(serviceDir)
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work, prevSha, targetSha, readyAtTarget: true, readyAtPrev: false,
      isActive: "inactive",
    })

    const r = runUpdate(guardArgs(temp, work, serviceDir), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_TEST_WS_COUNT: "unknown",
    })

    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stderr).toContain("no server process; restart permitted")
    expect(git(work, "rev-parse", "HEAD")).toBe(targetSha)
    const sys = readLog(systemctlLog)
    expect(sys).toContain("stop luna-chat-server.service")
    expect(sys).toContain("start luna-chat-server.service")
  })

  it("session guard: an answered count n>0 defers even when the unit reports 'failed' (ws-count first)", () => {
    // Pins the documented ordering: an answered kernel socket count is
    // authoritative in both directions. A refactor that consulted systemd
    // FIRST would read 'failed' as the dead-server exception and drop the
    // orphaned/lingering session holders the ordering exists to protect.
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    const updateState = join(temp, "update-state")
    writeUnit(serviceDir)
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work, prevSha, targetSha, readyAtTarget: true, readyAtPrev: false,
      isActive: "failed",
    })

    const r = runUpdate(guardArgs(temp, work, serviceDir), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_TEST_WS_COUNT: "2",
      LUNA_UPDATE_STATE_DIR: updateState,
    })

    expect(r.status, r.stdout + r.stderr).toBe(3)
    expect(r.stderr).toContain("active session(s)")
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    expect(readLog(systemctlLog)).not.toContain("stop")
    expect(existsSync(join(updateState, "transaction-stable"))).toBe(false)
  })

  // Compute the lock-owner fingerprint EXACTLY the way the engine's
  // process_fingerprint does (procfs starttime on Linux, ps lstart elsewhere),
  // so the seeded lock owner is judged ALIVE — not stale — by lock_owner_alive.
  const engineFingerprint = (pid: number) => {
    const r = spawnSync(
      "bash",
      ["-c",
        `if [[ -r /proc/${pid}/stat ]]; then sed 's/^.*) //' /proc/${pid}/stat | awk '{print $20}'; else ps -p ${pid} -o lstart= | tr -d '\\n'; fi`],
      { encoding: "utf8" },
    )
    return r.stdout.trim()
  }

  it("--restart-only: update-lock contention exits 4, distinct from the session-guard defer (3)", () => {
    // A guardian repair rung colliding with a live manual deploy is LOCK
    // contention, not a session-guard defer: exit 3 here made do_repair and the
    // guardian page "live or unknown sessions" while the session count was
    // never evaluated, sending the responder after phantom sessions.
    const temp = makeTempDir()
    const { work, prevSha, targetSha } = makeDeployRepo(temp)
    const serviceDir = join(temp, "systemd")
    const updateState = join(temp, "update-state")
    const lockDir = join(updateState, "lock-stable")
    writeUnit(serviceDir)
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(
      join(lockDir, "owner"),
      `pid=${process.pid}\nfingerprint=${engineFingerprint(process.pid)}\n`,
    )
    const { bin, systemctlLog } = makeStubBin(temp, {
      repo: work, prevSha, targetSha, readyAtTarget: false, readyAtPrev: true,
    })

    const r = runUpdate(guardArgs(temp, work, serviceDir, ["--restart-only"]), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_UPDATE_STATE_DIR: updateState,
    })

    expect(r.status, r.stdout + r.stderr).toBe(4)
    expect(r.stderr).toContain("another update")
    expect(readLog(systemctlLog)).not.toContain("stop")
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
  })

  it("apply-phase failure with live sessions: rollback restart stays GUARDED (exit 3), idle tick completes it", () => {
    // The rollback guard exemption is scoped: an apply-phase failure (bun
    // install error) rolls back while the OLD server is still running and
    // serving, and sessions opened during the multi-minute install must not be
    // dropped to "recover" to the very build already serving them. The
    // exemption applies only after a forward restart actually interrupted
    // service (or when recovering a mid-rollback journal — the resume below).
    const temp = makeTempDir()
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
    const updateState = join(temp, "update-state")
    writeUnit(serviceDir)
    const bin = join(temp, "bin")
    mkdirSync(bin, { recursive: true })
    const systemctlLog = join(temp, "systemctl.log")
    const ssCount = join(temp, "ss-count")
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
  printf '{"status":"ok","mode":"normal","credentialOk":true,"buildSha":"%s"}\\n%s' "$head" "$code"; exit 0
fi
printf '%s' "$code"
exit 0
`,
    )
    // bun keyed off the LIVE checkout HEAD: fails at TARGET (forward install
    // errors before any restart), succeeds at PREV (rollback install works).
    writeFileSync(
      join(bin, "bun"),
      `#!/usr/bin/env bash
head="$(git -C "${work}" rev-parse HEAD 2>/dev/null || echo unknown)"
[[ "$head" == "${targetSha}" ]] && exit 1
exit 0
`,
    )
    // ss keyed off a call counter: the PRE-mutation guard sees an idle socket
    // table (0 sessions), then a session appears during the failing install,
    // so the ROLLBACK guard sees 2 established rows and must defer.
    writeFileSync(
      join(bin, "ss"),
      `#!/usr/bin/env bash
n=0; [[ -f "${ssCount}" ]] && n="$(cat "${ssCount}")"
n=$((n+1)); printf '%s' "$n" > "${ssCount}"
if [[ "$n" -ge 2 ]]; then
  printf 'ESTAB 0 0 127.0.0.1:4753 127.0.0.1:50001\\nESTAB 0 0 127.0.0.1:4753 127.0.0.1:50002\\n'
fi
exit 0
`,
    )
    spawnSync("chmod", ["+x", join(bin, "systemctl"), join(bin, "curl"), join(bin, "bun"), join(bin, "ss")])

    const guardedRollback = runUpdate(guardArgs(temp, work, serviceDir), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      // Unset the pinned seam so the guard consults the ss stub above.
      LUNA_TEST_WS_COUNT: undefined,
      LUNA_UPDATE_STATE_DIR: updateState,
    })

    expect(guardedRollback.status, guardedRollback.stdout + guardedRollback.stderr).toBe(3)
    expect(guardedRollback.stderr).toContain("session guard stays ACTIVE")
    expect(guardedRollback.stderr).toContain("rollback restart DEFERRED by session guard")
    // The old server was never stopped, and the checkout is already back at PREV.
    expect(readLog(systemctlLog)).not.toContain("stop")
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    const journal = join(updateState, "transaction-stable")
    expect(existsSync(journal)).toBe(true)
    expect(readFileSync(journal, "utf8")).toContain("phase=rolling-back")

    // An idle tick recovers the mid-rollback journal (exempt: the interruption
    // decision already happened) and completes the rollback restart, exit 1.
    const resumed = runUpdate(guardArgs(temp, work, serviceDir), {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_TEST_WS_COUNT: "0",
      LUNA_UPDATE_STATE_DIR: updateState,
    })
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(1)
    expect(resumed.stderr).toContain("ROLLED BACK")
    expect(git(work, "rev-parse", "HEAD")).toBe(prevSha)
    expect(existsSync(journal)).toBe(false)
    const sys = readLog(systemctlLog)
    expect(sys).toContain("stop luna-chat-server.service")
    expect(sys).toContain("start luna-chat-server.service")
  })
})
