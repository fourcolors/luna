/**
 * The four topologies this binary does not own, and how it hands them over.
 *
 * THIS SUITE IS NOT A PARITY ORACLE, and saying so is the point of this
 * header. Driving `--dry-run` through here proves that the binary hands the
 * WHOLE run to the co-pinned bash engine and passes the child's status back
 * unchanged. It proves nothing whatsoever about what the bash engine then
 * does, and it must never be cited as evidence that the port agrees with the
 * bash - that is what the dual-drive gate is for, and it is exactly the
 * mistake an earlier revision of this slice's acceptance made when it tried to
 * prove parity through a `--dry-run` output diff.
 *
 * WHAT IT DOES DEFEND, in four properties an operator or a gate depends on:
 *
 *   1. `rawArgs` is the RAW argv, subcommand token included. `delegate.ts`
 *      drops the token itself and forwards everything after it VERBATIM, so an
 *      operator's `--readiness-timeout 600` reaches the bash engine as typed
 *      rather than as a reconstruction of what this binary understood. Feeding
 *      it the already-stripped flags makes `forwardedFlags` throw
 *      (delegate.ts:207-215) and kills every delegated run.
 *   2. The `DELEGATED to bash engine: <flag>` marker is the stable stderr line
 *      S23's accept gate greps for. It is written through the LINE writer, not
 *      the raw one, so it is terminated exactly once - an unterminated marker
 *      is glued to whatever the engine prints next and the gate stops matching.
 *   3. The child's exit code is propagated VERBATIM. 0/1/2/3/4 all mean
 *      specific things to autodeploy's rc `case`; normalising any of them
 *      turns a rolled-back deploy into a healthy one.
 *   4. NO LOCK is taken. The bash engine acquires the same profile lock, so a
 *      binary holding it here would make every delegated run contend with
 *      itself and defer forever.
 *
 * PORTABLE: no spawn, no host binary, no platform branch. `runEngine` is an
 * injected recorder and the "engine" is a label, not a path.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { DELEGATED_MARKER_PREFIX, type DelegationFlag } from "../../src/update/delegate.js"
import { runUpdate } from "../../src/update/run-update.js"
import { cleanupTempDirs, makeTempDir } from "./temp-dirs.js"
import { FIXTURE_BASH_ENGINE, makeCapturedSeams, makeEnv, makeStubIo } from "./update-io-doubles.js"

afterAll(cleanupTempDirs)

const PROFILE = "fixture"

interface Delegated {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  /** `(path, args)` as `delegateToBashSync` invoked it, or null if it never did. */
  readonly engineCall: { path: string; args: ReadonlyArray<string> } | null
  readonly lockExists: boolean
}

const delegate = (flags: ReadonlyArray<string>, childStatus = 0): Delegated => {
  const stateDir = makeTempDir("luna-delegate-")
  const lockDir = join(stateDir, `lock-${PROFILE}`)
  let engineCall: { path: string; args: ReadonlyArray<string> } | null = null
  const io = makeStubIo({
    runEngine: (path, args) => {
      engineCall = { path, args: [...args] }
      return { status: childStatus, signal: null }
    },
  })
  const captured = makeCapturedSeams(makeEnv(stateDir), io)
  const argv = ["update", "--profile", PROFILE, ...flags]
  const code = runUpdate(argv, captured.seams)
  return {
    code,
    stdout: captured.stdout.join(""),
    stderr: captured.stderr.join(""),
    engineCall,
    lockExists: existsSync(lockDir),
  }
}

/** Every flag `delegationFor` (config.ts:271-277) can actually yield, with an argv that reaches it. */
const ROWS: ReadonlyArray<readonly [DelegationFlag, ReadonlyArray<string>]> = [
  ["--dry-run", ["--dry-run"]],
  ["--layout releases", ["--layout", "releases", "--deploy-root", "/srv/luna"]],
  ["--supervisor launchd", ["--supervisor", "launchd"]],
  ["--user", ["--user"]],
]

describe("every delegated topology reaches the bash engine", () => {
  for (const [flag, flags] of ROWS) {
    describe(flag, () => {
      it("marks the run exactly once, on stderr, terminated", () => {
        const r = delegate(flags)
        const marker = `${DELEGATED_MARKER_PREFIX}${flag}`
        expect(r.stderr).toContain(`${marker}\n`)
        // Exactly once: the gate greps for the prefix and a second copy would
        // make a single run look like two.
        expect(r.stderr.split(DELEGATED_MARKER_PREFIX).length - 1).toBe(1)
        // And terminated exactly once - `delegate.ts:245-246` types its writer
        // as a line WITHOUT its newline, so handing it the RAW writer instead
        // of the line adapter leaves the marker glued to the next output.
        expect(r.stderr).not.toContain(`${marker}${DELEGATED_MARKER_PREFIX}`)
        expect(r.stderr.endsWith("\n")).toBe(true)
      })

      it("forwards the flags AFTER the subcommand token, verbatim", () => {
        const r = delegate(flags)
        expect(r.engineCall).not.toBeNull()
        expect(r.engineCall?.path).toBe(FIXTURE_BASH_ENGINE)
        // The token is consumed, everything after it survives in order.
        expect(r.engineCall?.args).toEqual(["--profile", PROFILE, ...flags])
      })

      it("returns the child's status VERBATIM", () => {
        for (const status of [0, 1, 2, 3, 4, 7]) {
          expect(delegate(flags, status).code, `child exited ${status}`).toBe(status)
        }
      })

      it("takes no lock", () => {
        expect(delegate(flags).lockExists).toBe(false)
      })
    })
  }
})

describe("precedence is fixed, so the marker is deterministic for one argv", () => {
  it("reports the layout, not the supervisor, when both would delegate", () => {
    // config.ts:271-277 checks layout first. A different order would give the
    // same argv two different markers on two different days.
    const r = delegate(["--layout", "releases", "--deploy-root", "/srv/luna", "--user"])
    expect(r.stderr).toContain(`${DELEGATED_MARKER_PREFIX}--layout releases`)
    expect(r.stderr).not.toContain(`${DELEGATED_MARKER_PREFIX}--user`)
  })
})

describe("an unusable bash engine refuses instead of half-running", () => {
  it("exits 1 without a marker when the engine is not executable", () => {
    const stateDir = makeTempDir("luna-delegate-refuse-")
    let engineRan = false
    const io = makeStubIo({
      isExecutable: () => false,
      runEngine: () => {
        engineRan = true
        return { status: 0, signal: null }
      },
    })
    const captured = makeCapturedSeams(makeEnv(stateDir), io)
    const code = runUpdate(["update", "--profile", PROFILE, "--dry-run"], captured.seams)
    expect(code).toBe(1)
    expect(engineRan, "nothing may run when the engine cannot be resolved").toBe(false)
    // No audit line may claim a delegation that never happened.
    expect(captured.stderr.join("")).not.toContain(DELEGATED_MARKER_PREFIX)
  })
})
