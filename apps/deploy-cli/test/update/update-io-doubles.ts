/**
 * `UpdateIo` doubles shared by the four in-process suites that drive
 * `runUpdate` end to end (exit-code-matrix, no-ambient-io,
 * delegation-boundary, wiring).
 *
 * WHY A SHARED FILE. `UpdateIo` (wiring.ts) enumerates EVERY real-IO boundary
 * the update transaction can reach, and its whole purpose is that a caller
 * cannot silently fall back to a module default. That purpose only holds if
 * every in-process suite fills every field - and four independent copies of a
 * seventeen-field record is four chances for one of them to quietly grow a
 * real `spawnSync`. One builder, one place to add a field when the type grows,
 * and a compile error in exactly one file when it does.
 *
 * NOTHING HERE TOUCHES THE HOST. No spawn, no stat, no clock, no platform
 * branch: every default is a constant or a counter. The one real filesystem
 * these suites use is the lock/journal state directory, which is fixture-
 * rooted per test and is the behaviour under test rather than an escape (see
 * wiring.ts's header on that deliberate exception).
 *
 * THE `bash` PATHS BELOW ARE NEVER EXECUTED. `LUNA_DEPLOY_BASH_ENGINE` has to
 * name something for `resolveBashLib` to accept, and `isReadableFile` is a
 * stub that says yes, so the string is a label rather than a path. It is
 * deliberately NOT a real path on this machine: a suite that accidentally
 * started spawning would then fail loudly instead of running the developer's
 * own checkout.
 */
import type { UpdateIo } from "../../src/update/wiring.js"

/** A single seam invocation, in call order, for suites that assert on WHAT was reached rather than on a result. */
export interface IoCall {
  readonly seam: keyof UpdateIo
  readonly args: ReadonlyArray<unknown>
}

/** A label, not a path: see this module's header. */
export const FIXTURE_BASH_ENGINE = "/nonexistent/luna-deploy-fixture/scripts/luna-update-server"

/**
 * The environment `runUpdate` is driven with. `LUNA_DEPLOY_BASH_ENGINE` is
 * required by `resolveBashLib` before anything else runs, and the state dir is
 * per-test so the lock and journal land in a temp tree rather than in
 * `$HOME/.luna/update`.
 */
export const makeEnv = (
  stateDir: string,
  extra: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> => ({
  LUNA_DEPLOY_BASH_ENGINE: FIXTURE_BASH_ENGINE,
  LUNA_UPDATE_STATE_DIR: stateDir,
  HOME: stateDir,
  ...extra,
})

/**
 * A fully hermetic `UpdateIo` whose every seam answers a benign constant.
 *
 * The defaults are chosen so that a run reaches as FAR as possible rather than
 * refusing early - preflight's probes all pass, the guard sees zero sessions,
 * the lock's fingerprint is recordable - because a suite that wants a refusal
 * overrides the one seam that produces it, and a suite that wants the happy
 * path should not have to override sixteen.
 *
 * `calls` is optional; pass an array to record every invocation in order.
 */
export const makeStubIo = (
  overrides: Partial<UpdateIo> = {},
  calls?: IoCall[],
): UpdateIo => {
  const record = (seam: keyof UpdateIo, ...args: ReadonlyArray<unknown>): void => {
    calls?.push({ seam, args })
  }
  // A counter rather than a clock: `readiness_ok`'s loop condition is
  // `now() < deadline`, so a monotonically climbing integer makes the poll
  // budget exhaust in a bounded number of steps with no wall-clock time paid.
  let ticks = 0
  const base: UpdateIo = {
    spawnTarget: (argv, opts) => {
      record("spawnTarget", argv, opts)
      return { status: 0, stdout: "" }
    },
    runBash: (call) => {
      record("runBash", call)
      return { status: 0, stdout: "", stderr: "" }
    },
    runEngine: (path, args) => {
      record("runEngine", path, args)
      return { status: 0, signal: null }
    },
    queryActiveWsCount: (port, incusContainer) => {
      record("queryActiveWsCount", port, incusContainer)
      return 0
    },
    sleepSecs: (secs) => {
      record("sleepSecs", secs)
    },
    settleSleep: (secs) => {
      record("settleSleep", secs)
      return { ok: true }
    },
    // TRUE, and this default is load-bearing: `acquire_update_lock`'s
    // mandatory self-readback (:1000-1006) writes an owner record and then
    // asks these same two probes whether it is alive. A `false` here makes
    // EVERY run fail to acquire with reason "ownership-unrecordable" and exit
    // 0 before the transaction is reached at all, which looks like a passing
    // happy path and tests nothing.
    processAlive: (pid) => {
      record("processAlive", pid)
      return true
    },
    processFingerprint: (pid) => {
      record("processFingerprint", pid)
      return "fixture-fingerprint"
    },
    pid: () => {
      record("pid")
      return 4242
    },
    uid: () => {
      record("uid")
      return 0
    },
    now: () => {
      record("now")
      ticks += 1
      return ticks
    },
    dirExists: (path) => {
      record("dirExists", path)
      return true
    },
    fileExists: (path) => {
      record("fileExists", path)
      return true
    },
    isExecutable: (path) => {
      record("isExecutable", path)
      return true
    },
    isReadableFile: (path) => {
      record("isReadableFile", path)
      return true
    },
    containerFileExists: (container, path) => {
      record("containerFileExists", container, path)
      return true
    },
    gitCurrentBranch: (hostRepoDir) => {
      record("gitCurrentBranch", hostRepoDir)
      return "master"
    },
    commandExists: (name) => {
      record("commandExists", name)
      return true
    },
  }
  return { ...base, ...overrides }
}

/** The tag every seam of `makeThrowingIo` carries. See that function. */
export const AMBIENT_IO_TAG = "AMBIENT-IO-BOUNDARY-REACHED"

export class AmbientIoError extends Error {
  readonly seam: string

  constructor(seam: string) {
    super(`${AMBIENT_IO_TAG}: ${seam}`)
    this.name = "AmbientIoError"
    this.seam = seam
  }
}

/**
 * An `UpdateIo` whose every seam THROWS a tagged error.
 *
 * This is the instrument `no-ambient-io.test.ts` uses, and the tag is the
 * whole point: a run driven with this record can only fail in one of two ways.
 * Either it reached a declared boundary, and the escaping error carries the
 * tag - or it reached an UNDECLARED one, in which case the error is an
 * untagged `ENOENT` / `EPERM` / `spawnSync` failure from a real host binary,
 * which is precisely the leak the record exists to detect.
 *
 * `overrides` exists so a suite can let ONE boundary answer normally while
 * every other stays armed.
 */
export const makeThrowingIo = (overrides: Partial<UpdateIo> = {}): UpdateIo => {
  const boom = (seam: string): never => {
    throw new AmbientIoError(seam)
  }
  const base: UpdateIo = {
    spawnTarget: () => boom("spawnTarget"),
    runBash: () => boom("runBash"),
    runEngine: () => boom("runEngine"),
    queryActiveWsCount: () => boom("queryActiveWsCount"),
    sleepSecs: () => boom("sleepSecs"),
    settleSleep: () => boom("settleSleep"),
    processAlive: () => boom("processAlive"),
    processFingerprint: () => boom("processFingerprint"),
    pid: () => boom("pid"),
    uid: () => boom("uid"),
    now: () => boom("now"),
    dirExists: () => boom("dirExists"),
    fileExists: () => boom("fileExists"),
    isExecutable: () => boom("isExecutable"),
    isReadableFile: () => boom("isReadableFile"),
    containerFileExists: () => boom("containerFileExists"),
    gitCurrentBranch: () => boom("gitCurrentBranch"),
    commandExists: () => boom("commandExists"),
  }
  return { ...base, ...overrides }
}

/** Collected stdout/stderr bytes plus the `RealSeams` that writes into them. */
export interface CapturedSeams {
  readonly stdout: string[]
  readonly stderr: string[]
  readonly seams: {
    readonly env: Readonly<Record<string, string | undefined>>
    readonly writeStdout: (text: string) => void
    readonly writeStderr: (text: string) => void
    readonly io: UpdateIo
  }
}

/**
 * `RealSeams` with both writers captured VERBATIM.
 *
 * Nothing is split on newlines and nothing is trimmed: the writers are raw by
 * contract, and a suite that wants lines joins and splits itself. Silently
 * normalising here would hide exactly the double-prefix and missing-terminator
 * defects these suites exist to catch.
 */
export const makeCapturedSeams = (
  env: Readonly<Record<string, string | undefined>>,
  io: UpdateIo,
): CapturedSeams => {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    seams: {
      env,
      writeStdout: (text) => {
        stdout.push(text)
      },
      writeStderr: (text) => {
        stderr.push(text)
      },
      io,
    },
  }
}
