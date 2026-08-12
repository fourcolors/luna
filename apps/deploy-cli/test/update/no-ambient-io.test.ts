/**
 * The structural guarantee that no in-process test can reach a real
 * `systemctl`, `ss`, `ps`, `sleep`, `incus`, `git`, `curl` or `bash`.
 *
 * WHY THIS FILE IS NOT PARANOIA. Not one PR1 spawn site honours an injected
 * environment: `target.ts:278` calls `spawnSync` with no `env`,
 * `probes.ts:310` spawns `sleep`, `session-guard.ts` spawns `incus`, `ss` and
 * `systemctl`, `lock.ts` spawns `ps`, and `bash-lib.ts:151` reads
 * `process.env` at call time. Several of the options records those functions
 * take DEFAULT their seams to exactly those spawns, so a wiring that simply
 * omits a field still compiles, still passes every behavioural test, and
 * silently runs host binaries. The self-hosted CI runner is documented as
 * itself a live deployment host, and one of those binaries is
 * `systemctl stop <unit>`.
 *
 * THE INSTRUMENT is `makeThrowingIo`: an `UpdateIo` whose every seam throws a
 * TAGGED error. A run driven with it can only end two ways. Either it reached
 * a DECLARED boundary and the escaping error carries the tag - or it reached
 * an UNDECLARED one, and the error is an untagged `ENOENT` / `EPERM` /
 * `spawnSync` failure, which is precisely the leak. The tag is what turns "it
 * threw" into "it threw for the right reason".
 *
 * THE PER-SEAM ROWS ARE THE STRONGER HALF. Arming ONE seam while every other
 * stays stubbed asserts that the transaction reaches that boundary THROUGH the
 * injected record: if `wiring.ts` had left the module default in place, the
 * armed seam would never be consulted and the run would either complete
 * normally or die with an untagged error from a real spawn. Both are failures
 * here. That is what makes the two overrides that are easiest to forget -
 * `readiness.ts`'s `now`/`sleep`, which `probes.ts:331-332` hardcodes on the
 * factory rather than exposing as seams - impossible to lose silently.
 *
 * PORTABLE by construction: this file's whole thesis is that nothing outside
 * the process is touched.
 */
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { runUpdate } from "../../src/update/run-update.js"
import type { CommandResult } from "../../src/update/target.js"
import type { UpdateIo } from "../../src/update/wiring.js"
import { cleanupTempDirs, makeTempDir } from "./temp-dirs.js"
import {
  AMBIENT_IO_TAG,
  AmbientIoError,
  makeCapturedSeams,
  makeEnv,
  makeStubIo,
  makeThrowingIo,
} from "./update-io-doubles.js"

afterAll(cleanupTempDirs)

const PREV = "a".repeat(40)
const TARGET = "b".repeat(40)
const PROFILE = "fixture"

/**
 * The same argv-dispatching world the exit-code matrix uses, reduced to what
 * these rows need: a checkout that moves, a unit that answers, and a /healthz
 * that can be made to fail so the readiness poll actually loops.
 */
const makeSpawnTarget = (healthy: boolean): UpdateIo["spawnTarget"] => {
  let head = PREV
  let mainPid = 100
  const ok = (stdout = ""): CommandResult => ({ status: 0, stdout })
  return (argv) => {
    const [cmd, ...rest] = argv
    if (cmd === "git") {
      const sub = rest.slice(2)
      if (sub[0] === "rev-parse" && sub[1] === "HEAD") return ok(`${head}\n`)
      if (sub[0] === "rev-parse") return ok(`${TARGET}\n`)
      if (sub[0] === "reset") {
        head = sub[2] ?? head
        return ok()
      }
      if (sub[0] === "hash-object") return ok("c".repeat(40))
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
      const url = argv[argv.length - 1] ?? ""
      if (url.endsWith("/healthz")) return ok(healthy ? "200" : "500")
      if (url.endsWith("/readyz")) return ok(`{"mode":"normal","buildSha":"${head}"}\n200`)
      return ok()
    }
    return ok()
  }
}

const stubRunBash: UpdateIo["runBash"] = (call) =>
  call.script.includes("luna_find_bun")
    ? { status: 0, stdout: "/fixture/bun\n", stderr: "" }
    : { status: 0, stdout: "", stderr: "" }

interface RunOptions {
  readonly argv?: ReadonlyArray<string>
  readonly io: Partial<UpdateIo>
  /** True for the rows that need the readiness poll to loop (and therefore to sleep). */
  readonly unhealthy?: boolean
}

/** A run whose defaults reach as far as the happy path, with `io` layered on top. */
const run = (options: RunOptions): number => {
  const stateDir = makeTempDir("luna-noambient-")
  const repoDir = makeTempDir("luna-noambient-repo-")
  const io = makeStubIo({
    spawnTarget: makeSpawnTarget(options.unhealthy !== true),
    runBash: stubRunBash,
    fileExists: (path) => !path.startsWith(join(stateDir, "transaction-")),
    ...options.io,
  })
  const captured = makeCapturedSeams(makeEnv(stateDir), io)
  const argv = options.argv ?? [
    "update",
    "--profile", PROFILE,
    "--repo-dir", repoDir,
    "--readiness-timeout", "2",
    "--readiness-interval", "0",
    "--restart-settle", "6",
  ]
  return runUpdate(argv, captured.seams)
}

/** The seam armed, and the argv that makes the transaction reach it. */
const SEAMS: ReadonlyArray<readonly [keyof UpdateIo, ReadonlyArray<string> | undefined]> = [
  ["isReadableFile", undefined],
  ["runBash", undefined],
  ["commandExists", ["update", "--profile", PROFILE, "--supervisor", "launchd"]],
  ["uid", undefined],
  ["dirExists", undefined],
  ["gitCurrentBranch", undefined],
  ["fileExists", undefined],
  ["pid", undefined],
  ["processFingerprint", undefined],
  ["processAlive", undefined],
  ["spawnTarget", undefined],
  ["settleSleep", undefined],
  ["now", undefined],
  ["runEngine", ["update", "--profile", PROFILE, "--dry-run"]],
  ["isExecutable", ["update", "--profile", PROFILE, "--dry-run"]],
  [
    "containerFileExists",
    ["update", "--profile", PROFILE, "--incus", "fixture-container", "--readiness-timeout", "2", "--readiness-interval", "0"],
  ],
]

describe("every declared boundary is reached THROUGH the injected record", () => {
  for (const [seam, argv] of SEAMS) {
    it(`${seam} is consulted, not bypassed by a module default`, () => {
      const thrown = captureThrow(() =>
        run({
          io: {
            [seam]: (() => {
              throw new AmbientIoError(seam)
            }) as never,
          },
          ...(argv === undefined ? {} : { argv }),
        }),
      )
      expect(thrown, `${seam} was never consulted: a module default answered instead`).not.toBeNull()
      expect(thrown).toBeInstanceOf(AmbientIoError)
      expect((thrown as AmbientIoError).seam).toBe(seam)
    })
  }

  it("queryActiveWsCount is consulted, asserted by RECORDING rather than by throwing", () => {
    // The one seam whose armed throw is not observable, and deliberately so:
    // `restartSessionGuardSync` (session-guard.ts:337-349) CATCHES a throwing
    // count and falls through to the fail-closed unit-state read, because a
    // guard that crashed the deploy on a probe failure would be worse than one
    // that defers. So this row proves the seam is reached by watching it be
    // called, with the config's own port and container.
    const calls: Array<{ port: string; container: string | undefined }> = []
    run({
      io: {
        queryActiveWsCount: (port, container) => {
          calls.push({ port, container })
          return 0
        },
      },
    })
    expect(calls.length, "the guard never asked how many sessions were live").toBeGreaterThan(0)
    expect(calls[0]?.port, "the RAW port string, never a renormalised number").toBe("4753")
  })

  it("sleepSecs is consulted when the readiness poll actually loops", () => {
    // Split out because it needs a FAILING /healthz: on the happy path the
    // first probe succeeds and `readiness_ok` returns before it ever sleeps,
    // so a run that never slept would prove nothing about the override.
    const thrown = captureThrow(() =>
      run({
        unhealthy: true,
        io: {
          sleepSecs: () => {
            throw new AmbientIoError("sleepSecs")
          },
        },
      }),
    )
    expect(thrown).toBeInstanceOf(AmbientIoError)
    expect((thrown as AmbientIoError).seam).toBe("sleepSecs")
  })
})

describe("a fully armed UpdateIo cannot reach anything untagged", () => {
  const SCENARIOS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["a normal update", ["update", "--profile", PROFILE]],
    ["--restart-only", ["update", "--profile", PROFILE, "--restart-only"]],
    ["a delegated topology", ["update", "--profile", PROFILE, "--dry-run"]],
    ["an incus target", ["update", "--profile", PROFILE, "--incus", "fixture-container"]],
    ["a config refusal", ["update", "--profile", PROFILE, "--layout", "bogus"]],
  ]

  for (const [name, argv] of SCENARIOS) {
    it(`${name} either returns a code or throws a TAGGED error`, () => {
      const stateDir = makeTempDir("luna-noambient-armed-")
      const captured = makeCapturedSeams(makeEnv(stateDir), makeThrowingIo())
      const thrown = captureThrow(() => runUpdate(argv, captured.seams))
      if (thrown === null) return
      // The whole assertion: an untagged ENOENT/EPERM/spawnSync error here
      // would mean a REAL host binary was reached.
      expect(
        thrown instanceof Error ? thrown.message : String(thrown),
        "an untagged error means a real IO boundary was reached",
      ).toContain(AMBIENT_IO_TAG)
    })
  }
})

/** Run `fn` and hand back whatever it threw, or null. */
function captureThrow(fn: () => unknown): unknown {
  try {
    fn()
    return null
  } catch (err) {
    return err
  }
}
