/**
 * The composition root itself.
 *
 * WHY THIS FILE HAS TO EXIST. Every other suite in this slice injects AROUND
 * `wiring.ts` - the parity drives replace its seams, the exit-code matrix
 * replaces its IO - which makes it the one module a behavioural diff cannot
 * isolate. Its whole job is to connect A to B correctly, and connecting A to
 * the WRONG B is invisible in an output diff whenever both are plausible: a
 * container path where a host path belonged, `info` where the raw writer
 * belonged, a baseline captured at the wrong moment. So this suite asserts the
 * connections directly.
 *
 * PORTABLE: no spawn, no host binary, no platform branch. The only real
 * filesystem is a per-test temp state dir, which is where the journal
 * deliberately lives.
 */
import { afterAll, describe, expect, it } from "vitest"
import type { BashLib, ConfigureClaudeRequest } from "../../src/update/bash-lib.js"
import { parseUpdateConfig, type UpdateConfig } from "../../src/update/config.js"
import { readinessGaveUpLine } from "../../src/update/readiness.js"
import { runUpdate } from "../../src/update/run-update.js"
import type { CommandResult, SpawnOptions } from "../../src/update/target.js"
import { buildFlowDeps, type RealSeams, type UpdateIo } from "../../src/update/wiring.js"
import { cleanupTempDirs, makeTempDir } from "./temp-dirs.js"
import { makeCapturedSeams, makeEnv, makeStubIo } from "./update-io-doubles.js"

afterAll(cleanupTempDirs)

const PREV = "a".repeat(40)
const TARGET = "b".repeat(40)
const PROFILE = "fixture"

/** Parse a real config rather than hand-rolling forty fields, then override what a scenario needs. */
const configFor = (
  flags: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  overrides: Partial<UpdateConfig> = {},
): UpdateConfig => {
  const parsed = parseUpdateConfig(["--profile", PROFILE, ...flags], env, {
    validateProfile: () => true,
    hasLaunchctl: () => true,
  })
  if (parsed.kind !== "ok") throw new Error(`fixture config did not parse: ${JSON.stringify(parsed)}`)
  return { ...parsed.config, ...overrides }
}

const NUMBERS = { readinessTimeoutSecs: 2, readinessTimeoutRaw: "2", readinessIntervalSecs: 0 }

interface Rig {
  readonly deps: ReturnType<typeof buildFlowDeps>
  /** Every argv `spawnTarget` was handed, in order, fully resolved. */
  readonly spawns: ReadonlyArray<ReadonlyArray<string>>
  readonly stdout: () => string
  readonly stderr: () => string
  readonly claudeRequests: ReadonlyArray<ConfigureClaudeRequest>
}

interface RigOptions {
  readonly config: UpdateConfig
  readonly io?: Partial<UpdateIo>
  /** Answers keyed loosely on the argv; see makeRig. */
  readonly healthz?: string
  readonly lockHash?: string
  readonly bunBin?: string
}

const makeRig = (options: RigOptions): Rig => {
  const spawns: string[][] = []
  const claudeRequests: ConfigureClaudeRequest[] = []
  const ok = (stdout = ""): CommandResult => ({ status: 0, stdout })
  // The "checkout": one mutable string that `reset --hard` moves, so
  // apply-inplace's HEAD postcondition (:1188-1194) sees what it just asked
  // for. It starts at TARGET so a forward apply passes; the rollback rows move
  // it back to PREV.
  let head = TARGET
  // Distinct MainPIDs per read, so restart_service's postcondition (:1560-1564)
  // sees the process REPLACED. Equal non-zero pids are its one failing shape,
  // and a constant here would fail every restart in this file.
  let mainPid = 100

  const spawnTarget = (argv: ReadonlyArray<string>, _opts: SpawnOptions): CommandResult => {
    spawns.push([...argv])
    // Skip an `incus exec <c> --` prefix so one dispatcher serves both
    // topologies, exactly as the resolved argv differs only by that prefix.
    const inner = argv[0] === "incus" ? argv.slice(4) : argv
    const [cmd, ...rest] = inner
    if (cmd === "git") {
      const sub = rest.slice(2)
      if (sub[0] === "rev-parse" && sub[1] === "HEAD") return ok(`${head}\n`)
      if (sub[0] === "rev-parse") return ok(`${TARGET}\n`)
      if (sub[0] === "hash-object") return ok(`${options.lockHash ?? "c".repeat(40)}\n`)
      if (sub[0] === "reset") {
        head = sub[2] ?? head
        return ok()
      }
      return ok()
    }
    if (cmd === "systemctl") {
      const args = rest[0] === "--user" ? rest.slice(1) : rest
      if (args[0] === "is-active") return ok("active\n")
      if (args[0] === "show" && args.includes("--property=NRestarts")) return ok("0\n")
      if (args[0] === "show" && args.includes("--property=MainPID")) {
        mainPid += 1
        return ok(`${mainPid}\n`)
      }
      return ok()
    }
    if (cmd === "curl") {
      const url = inner[inner.length - 1] ?? ""
      if (url.endsWith("/healthz")) return ok(options.healthz ?? "200")
      if (url.endsWith("/readyz")) return ok(`{"mode":"normal","buildSha":"${head}"}\n200`)
      return ok()
    }
    return ok()
  }

  const io = makeStubIo({ spawnTarget, ...options.io })
  const captured = makeCapturedSeams(makeEnv(options.config.updateStateDir), io)
  const bashLib: BashLib = {
    bashEngine: "/fixture/engine",
    libFile: "/fixture/lib/luna-deploy.sh",
    validateProfile: () => ({ ok: true }),
    findBun: () => ({ ok: true, path: "/fixture/bun" }),
    envValue: () => ({ found: true, value: "", exitCode: 0, stderr: "" }),
    configureClaudeExecutable: (request) => {
      claudeRequests.push(request)
      return { ok: true, exitCode: 0, stdout: "", stderr: "" }
    },
    legacyConfigureClaudeExecutable: () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
  }
  const deps = buildFlowDeps({
    config: options.config,
    numbers: NUMBERS,
    bashLib,
    bunBin: options.bunBin ?? "/fixture/bun",
    requestedRef: TARGET,
    seams: captured.seams as RealSeams,
  })
  return {
    deps,
    spawns,
    stdout: () => captured.stdout.join(""),
    stderr: () => captured.stderr.join(""),
    claudeRequests,
  }
}

/** The first recorded argv whose (container-prefix-stripped) form satisfies `pred`. */
const findSpawn = (
  spawns: ReadonlyArray<ReadonlyArray<string>>,
  pred: (argv: ReadonlyArray<string>) => boolean,
): ReadonlyArray<string> | undefined => spawns.find((argv) => pred(argv))

describe("the three-way repo-dir mapping", () => {
  // A synthetic config in which all THREE values are deliberately distinct.
  // No runtime path can produce this on the inplace layout - :318-320 sets
  // HOST_REPO_DIR and CONTAINER_REPO_DIR to REPO_DIR on every bare-host run,
  // in production exactly as in a fixture - so the third assertion below
  // protects a future releases-layout fold rather than anything GATE 1 or a
  // live run could observe today. The first two ARE observable and are
  // additionally asserted end to end on the incus topology by the dual-drive
  // gate, from git.log against bun.log and incus.log.
  const stateDir = makeTempDir("luna-wiring-repodirs-")
  const config = configFor([], makeEnv(stateDir), {
    updateStateDir: stateDir,
    updateJournal: `${stateDir}/transaction-${PROFILE}`,
    repoDir: "/synthetic/repo-dir",
    hostRepoDir: "/synthetic/host-repo",
    containerRepoDir: "/synthetic/container-repo",
  })

  it("every git call carries hostRepoDir", () => {
    const rig = makeRig({ config })
    rig.deps.readHead()
    const git = findSpawn(rig.spawns, (a) => a[0] === "git")
    expect(git?.slice(0, 3)).toEqual(["git", "-C", "/synthetic/host-repo"])
  })

  it("bun install carries containerRepoDir", () => {
    // A lock hash that differs from the one passed in is what makes the
    // lockfile gate run `bun install` at all (:1199-1216).
    const rig = makeRig({ config, lockHash: "d".repeat(40) })
    rig.deps.applyRef(TARGET, "e".repeat(40), false)
    const install = findSpawn(rig.spawns, (a) => a[1] === "install")
    expect(install).toEqual(["/fixture/bun", "install", "--cwd", "/synthetic/container-repo", "--frozen-lockfile"])
  })

  it("the systemd unit is addressed through the container when one is set", () => {
    const incusConfig = configFor(["--incus", "fixture-container"], makeEnv(stateDir), {
      updateStateDir: stateDir,
      updateJournal: `${stateDir}/transaction-${PROFILE}`,
    })
    const rig = makeRig({ config: incusConfig })
    rig.deps.readinessBaseline()
    const show = findSpawn(rig.spawns, (a) => a.includes("--property=NRestarts"))
    expect(show?.slice(0, 4)).toEqual(["incus", "exec", "fixture-container", "--"])
  })

  it("the HOST claude re-pin carries repoDir VERBATIM", () => {
    const rig = makeRig({ config })
    rig.deps.applyRef(TARGET, "c".repeat(40), false)
    expect(rig.claudeRequests).toHaveLength(1)
    expect(rig.claudeRequests[0]?.repoDir).toBe("/synthetic/repo-dir")
    expect(rig.claudeRequests[0]?.envFile).toBe(config.envFile)
  })
})

describe("the standalone session guard", () => {
  const stateDir = makeTempDir("luna-wiring-guard-")
  const config = configFor(["--incus", "fixture-container"], makeEnv(stateDir), {
    updateStateDir: stateDir,
    updateJournal: `${stateDir}/transaction-${PROFILE}`,
  })

  it("carries the container AND a TARGET-ROUTED readUnitState", () => {
    // session-guard.ts:137-148 documents that its own is-active fallback is
    // HOST-scoped even for a container target, while bash's routes through
    // run_target_capture (:365-371) and execs INSIDE the container. Pointing
    // readUnitState at the same runner makeRunSystemctl builds is what closes
    // that gap - and an unknown ws count is the only way to observe it.
    const containers: Array<string | undefined> = []
    const rig = makeRig({
      config,
      io: {
        queryActiveWsCount: (_port, container) => {
          containers.push(container)
          // Not a non-negative integer: the guard treats it as UNKNOWN and
          // falls through to the unit-state read.
          return -1
        },
      },
    })
    const verdict = rig.deps.guard()
    expect(containers, "the count probe is told which container to look in").toEqual(["fixture-container"])
    const isActive = findSpawn(rig.spawns, (a) => a.includes("is-active"))
    expect(isActive?.slice(0, 4), "the fallback read must exec inside the container").toEqual([
      "incus", "exec", "fixture-container", "--",
    ])
    // The stub unit answers "active", which is fail-closed.
    expect(verdict.permitted).toBe(false)
  })

  it("emits the guard's OWN warn line, which bash prints from inside the guard", () => {
    const rig = makeRig({
      config,
      io: { queryActiveWsCount: () => 2 },
    })
    rig.deps.guard()
    expect(rig.stderr()).toBe(
      `warning: session guard: 2 active session(s) on :4753 — deferring restart\n`,
    )
  })

  it("stays SILENT on the arms bash passes through in silence", () => {
    const rig = makeRig({ config, io: { queryActiveWsCount: () => 0 } })
    const verdict = rig.deps.guard()
    expect(verdict.permitted).toBe(true)
    expect(rig.stderr()).toBe("")
  })
})

describe("dream_wake_install_script probes the HOST and prints the CONTAINER path", () => {
  const stateDir = makeTempDir("luna-wiring-seed-")
  const config = configFor(["--incus", "fixture-container"], makeEnv(stateDir), {
    updateStateDir: stateDir,
    updateJournal: `${stateDir}/transaction-${PROFILE}`,
    hostRepoDir: "/synthetic/host-repo",
    containerRepoDir: "/synthetic/container-repo",
  })

  it("uses apps/server when the HOST file is present", () => {
    const probed: string[] = []
    const rig = makeRig({
      config,
      io: {
        fileExists: (path) => {
          probed.push(path)
          return path.includes("apps/server")
        },
      },
    })
    rig.deps.seedDreamWakeJobs()
    expect(probed, "the probe is HOST-side; the host mount is always reachable").toContain(
      "/synthetic/host-repo/apps/server/scripts/dream-wake-install.ts",
    )
    const seed = findSpawn(rig.spawns, (a) => a.includes("run"))
    expect(seed?.slice(-1)).toEqual(["/synthetic/container-repo/apps/server/scripts/dream-wake-install.ts"])
  })

  it("falls back to apps/ui-web, still CONTAINER-relative", () => {
    const rig = makeRig({ config, io: { fileExists: () => false } })
    rig.deps.seedDreamWakeJobs()
    const seed = findSpawn(rig.spawns, (a) => a.includes("run"))
    expect(seed?.slice(-1)).toEqual(["/synthetic/container-repo/apps/ui-web/scripts/dream-wake-install.ts"])
  })

  it("returns normally and only WARNS when the seed itself fails", () => {
    // `|| true` at :2075 is load-bearing: the deploy has already succeeded and
    // the server is already healthy, so a seed failure must never trip a
    // rollback of a good build.
    const rig = makeRig({
      config,
      io: {
        fileExists: () => true,
        spawnTarget: (argv) => (argv.includes("run") ? { status: 1, stdout: "" } : { status: 0, stdout: "" }),
      },
    })
    expect(() => rig.deps.seedDreamWakeJobs()).not.toThrow()
    expect(rig.stderr()).toContain("post-deploy: dream/wake seed FAILED (non-fatal)")
  })
})

describe("the rollback readiness closure", () => {
  const stateDir = makeTempDir("luna-wiring-rollback-")
  const config = configFor([], makeEnv(stateDir), {
    updateStateDir: stateDir,
    updateJournal: `${stateDir}/transaction-${PROFILE}`,
  })

  it("emits the give-up line, which rollback.ts's bare-boolean seam cannot", () => {
    // In bash the warn lives INSIDE readiness_ok (:1124), so it fires at ALL
    // THREE call sites; rollback.ts:179-186 prints nothing on its false branch.
    // Without this closure the exit-2 CRITICAL scenario is a guaranteed stderr
    // diff failure.
    const rig = makeRig({ config, healthz: "500" })
    const outcome = rig.deps.rollback({ ref: TARGET, prev: PREV, forwardRestartRan: true })
    expect(outcome.exitCode).toBe(2)
    expect(rig.stderr()).toContain(
      `warning: ${readinessGaveUpLine(NUMBERS.readinessTimeoutRaw, "/healthz did not return 200 on :4753")}\n`,
    )
  })

  it("captures the baseline AFTER the rollback restart, not before", () => {
    // bash captures rollback_baseline at :1837, AFTER restart_service. A
    // baseline baked in when the closure was BUILT would be the pre-restart
    // count and would read a healthy rollback as a crash loop.
    const rig = makeRig({ config, healthz: "500" })
    rig.deps.rollback({ ref: TARGET, prev: PREV, forwardRestartRan: true })
    const started = rig.spawns.findIndex((a) => a.includes("start"))
    const baseline = rig.spawns.findIndex((a) => a.includes("--property=NRestarts"))
    expect(started, "the rollback restart ran").toBeGreaterThanOrEqual(0)
    expect(baseline, "NRestarts was sampled").toBeGreaterThan(started)
  })
})

describe("who owns the newline, and who owns the prefix", () => {
  it("preflight's banner goes through the RAW writer, so only its first line is `-> `-prefixed", () => {
    // The regression test for a double-prefixed banner: preflight.ts:120
    // applies `-> ` to the head line ITSELF (bash's :422 luna_info) and leaves
    // :424-440 and :521 as bare printfs. Passing wiring's `info` wrapper to
    // preflight's `print` prefixes all five and fails the very first bytes of
    // the parity diff.
    const stateDir = makeTempDir("luna-wiring-banner-")
    const repoDir = makeTempDir("luna-wiring-banner-repo-")
    const io = makeStubIo({
      // Refuse at the unit check, immediately after the banner, so the run
      // stops with the banner as the whole of stdout.
      fileExists: () => false,
    })
    const captured = makeCapturedSeams(makeEnv(stateDir), io)
    const code = runUpdate(
      ["update", "--profile", PROFILE, "--repo-dir", repoDir],
      captured.seams,
    )
    expect(code).toBe(1)
    expect(captured.stdout.join("")).toBe(
      [
        `-> Updating Luna server profile: ${PROFILE}`,
        `Repo: ${repoDir}`,
        `Service: /etc/systemd/system/luna-${PROFILE}-chat-server.service`,
        "Target: bare host",
        "",
      ].join("\n"),
    )
  })

  it("the delegation adapter terminates its marker exactly once", () => {
    // delegate.ts:245-246 types its writer as a line WITHOUT its newline, so
    // handing it the RAW writer leaves the marker glued to the next output.
    const stateDir = makeTempDir("luna-wiring-delegate-")
    const captured = makeCapturedSeams(makeEnv(stateDir), makeStubIo())
    runUpdate(["update", "--profile", PROFILE, "--dry-run"], captured.seams)
    expect(captured.stderr).toContain("DELEGATED to bash engine: --dry-run\n")
  })
})
