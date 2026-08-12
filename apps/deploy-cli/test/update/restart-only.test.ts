/**
 * `src/update/restart-only.ts` - repair-ladder rung 1 (`--restart-only`,
 * scripts/luna-update-server:1883-1913).
 *
 * PURE, NO FIXTURES, RUNS ANYWHERE. No filesystem, no subprocess, no clock, no
 * platform assumption: every seam the module declares is injected, and the two
 * real collaborators this file composes in (`readinessOkSync` and
 * `restartServiceSync`) are themselves driven entirely through their own
 * injected seams - `runSystemctl`, `mainPid`, `queryActiveWsCount`,
 * `isActive`, `restartCount`, `probeHealthz`, `probeReadyz`, `now`, `sleep`.
 * Nothing here spawns, so nothing here can depend on this developer's machine
 * (the specific failure mode PR1 shipped three times). No timeout override is
 * needed; the default 10s vitest budget is orders of magnitude more than these
 * take.
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT IS NOT FOR. The dual-drive byte diff in
 * `update-flow-parity.test.ts` is the proof that the bytes below match the
 * bash engine; this suite proves the things a byte diff CANNOT isolate,
 * because they are about which value reached which seam:
 *
 *  1. THE READINESS BASELINE IS ACTUALLY PASSED THROUGH (blockers B4 and B8).
 *     `readiness.ts:91` makes `baseline` a required field and
 *     `readiness.ts:154-155` is the crash-loop rung that compares against it,
 *     so an omission is a compile error - but a WRONG value is not, and a
 *     hardcoded `0` or a baseline sampled at the wrong moment compiles fine
 *     and is invisible on any run whose unit has never restarted. So the two
 *     rows under "the readiness baseline" drive the REAL `readinessOkSync`
 *     with a unit whose NRestarts is already non-zero: one where it holds
 *     steady (must PASS, which a hardcoded `0` fails) and one where it climbs
 *     (must FAIL, which is the parity row the audit asked for).
 *
 *  2. THE RESTART PRIMITIVE'S OWN LINES REACH THE OPERATOR ON THIS RUNG
 *     (blocker R3). Bash emits eleven operator-facing lines from inside
 *     `restart_service`/`sup_start`/`restart_session_guard`, and rung 1 is one
 *     of that function's three callers. `restart-only.ts` re-emits none of
 *     them on purpose, so the only way to know rung 1 is not silent where bash
 *     speaks is to compose the REAL `restartServiceSync` into the `restart`
 *     seam and read the shared sink - which the rows under "composed with the
 *     real restart primitive" do.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT OWN. The BYTES of those eleven lines
 * belong to `flow-lines.test.ts` and `session-guard.ts`'s own suite, and their
 * POSITION relative to `systemctl.log` belongs to
 * `restart-mainpid-parity.test.ts`; a second copy of either here would drift.
 * So where a row below needs one of them it names it through its builder, and
 * asserts only the rung-1 facts: that the line reaches the operator on THIS
 * path at all, and where it sits relative to rung 1's own four lines. The
 * settle triple is not touched here at all - every row pins `settleSecs` to
 * `"0"` so `settle_after_stop` takes its silent, sleepless arm.
 */
import { describe, expect, it } from "vitest"
import {
  mainPidUnchangedLine,
  restartOnlyHealthyLine,
  restartOnlyReadinessFailedLine,
  restartOnlyRestartErroredLine,
  startLimitLatchedLine,
} from "../../src/update/flow-lines.js"
import {
  type ReadinessResult,
  readinessGaveUpLine,
  readinessOkSync,
  readinessRestartBaseline,
} from "../../src/update/readiness.js"
import { type RestartOnlyOptions, restartOnlySync } from "../../src/update/restart-only.js"
import { type RestartOutcome, restartServiceSync } from "../../src/update/restart.js"
import { guardVerdictLine } from "../../src/update/session-guard.js"
import { exitCodeFor, journalDispositionFor } from "../../src/update/terminals.js"

const SERVICE = "luna-server.service"
/** RAW string, exactly as `config.ts` holds it - `007` must print `007`. */
const TIMEOUT_RAW = "007"
/** A full 40-hex HEAD, so the `:0:12` abbreviation in the healthy line is observable. */
const HEAD = ["abcdef0123456789abcd", "ef0123456789abcdef01"].join("")

/**
 * One ordered sink for BOTH `info` and `warn`, tagged by stream. Order across
 * the two streams is the thing several rows below assert (bash interleaves
 * them on one terminal), so two separate arrays would lose the property under
 * test.
 */
type Emitted = { readonly stream: "info" | "warn"; readonly line: string }

interface Harness {
  readonly emitted: Array<Emitted>
  readonly calls: Array<string>
  readonly readinessRequests: Array<{ expectedBuildSha: string; allowMissingBuildSha: boolean; baseline: number }>
}

const makeHarness = (): Harness => ({ emitted: [], calls: [], readinessRequests: [] })

const linesOf = (h: Harness): ReadonlyArray<string> => h.emitted.map((e) => e.line)

/**
 * Builds `RestartOnlyOptions` around a harness with every seam recorded.
 * Overrides are applied last so a row can swap in a real collaborator.
 */
const makeOpts = (
  h: Harness,
  overrides: Partial<RestartOnlyOptions> = {},
): RestartOnlyOptions => ({
  serviceName: SERVICE,
  readinessTimeoutRaw: TIMEOUT_RAW,
  restart: () => {
    h.calls.push("restart")
    return { code: 0, settle: { kind: "skipped-zero" } }
  },
  readinessBaseline: () => {
    h.calls.push("readinessBaseline")
    return 0
  },
  readHead: () => {
    h.calls.push("readHead")
    return HEAD
  },
  readiness: (req) => {
    h.calls.push("readiness")
    h.readinessRequests.push({ ...req })
    return { ready: true, detail: "" }
  },
  info: (line) => h.emitted.push({ stream: "info", line }),
  warn: (line) => h.emitted.push({ stream: "warn", line }),
  ...overrides,
})

describe("restartOnlySync - the four terminals", () => {
  it("healthy restart + healthy readiness is restart-only-ok, exit 0, journal untouched (:1907-1908)", () => {
    const h = makeHarness()
    const outcome = restartOnlySync(makeOpts(h))

    expect(outcome.terminal).toEqual({ kind: "restart-only-ok" })
    expect(exitCodeFor(outcome.terminal)).toBe(0)
    // The type-level guarantee this module's shape makes, restated as a runtime
    // one: rung 1 has no journal seam, so it can leave nothing behind.
    expect(journalDispositionFor(outcome.terminal)).toBe("untouched")
    expect(h.emitted).toEqual([
      { stream: "info", line: `restart-only: ${SERVICE} healthy at abcdef012345` },
    ])
    // ... and the literal above is the builder's output, so a change to either
    // one alone fails here.
    expect(linesOf(h)).toEqual([restartOnlyHealthyLine(SERVICE, HEAD)])
  })

  it("a guard deferral is exit 3 with NO line from this module (:1895's bare exit 3)", () => {
    const h = makeHarness()
    const outcome = restartOnlySync(
      makeOpts(h, {
        restart: () => {
          h.calls.push("restart")
          return { code: 3, verdict: { permitted: false, reason: "live-sessions", sessionCount: 1 } }
        },
      }),
    )

    expect(outcome.terminal).toEqual({ kind: "deferred", site: "restart-only" })
    // 3 and 4 must NEVER be conflated: 4 means a concurrent update holds the
    // profile lock and no session was ever evaluated, and the two send an
    // incident responder to different diagnoses (:1872-1878).
    expect(exitCodeFor(outcome.terminal)).toBe(3)
    expect(exitCodeFor(outcome.terminal)).not.toBe(4)
    expect(journalDispositionFor(outcome.terminal)).toBe("untouched")
    // Bash's `exit 3` here is BARE - the guard's own luna_warn already fired
    // from inside restart_service. A line from this module would be a line
    // bash does not print.
    expect(h.emitted).toEqual([])
    // Nothing downstream of the restart may run.
    expect(h.calls).toEqual(["restart"])
  })

  it("a failed restart emits only the restart-errored warn and stops, exit 1 (:1896)", () => {
    const h = makeHarness()
    const outcome = restartOnlySync(
      makeOpts(h, {
        restart: () => {
          h.calls.push("restart")
          return { code: 1, step: "start" }
        },
      }),
    )

    expect(outcome.terminal).toEqual({ kind: "restart-only-restart-failed" })
    expect(exitCodeFor(outcome.terminal)).toBe(1)
    expect(journalDispositionFor(outcome.terminal)).toBe("untouched")
    expect(h.emitted).toEqual([
      { stream: "warn", line: "restart-only: restart errored (checkout untouched; no rollback)" },
    ])
    expect(linesOf(h)).toEqual([restartOnlyRestartErroredLine])
    // No baseline, no HEAD read, no probe: bash exits before all three.
    expect(h.calls).toEqual(["restart"])
  })

  it("the MainPID postcondition failure is a restart failure like any other (:1564 -> :1896)", () => {
    // `restart_service` returns 1 from the postcondition exactly as it does
    // from a failed sup_start, so rung 1 must not special-case it.
    const h = makeHarness()
    const outcome = restartOnlySync(
      makeOpts(h, { restart: () => ({ code: 1, step: "mainpid", prePid: "4242", postPid: "4242" }) }),
    )

    expect(outcome.terminal).toEqual({ kind: "restart-only-restart-failed" })
    expect(linesOf(h)).toEqual([restartOnlyRestartErroredLine])
  })

  it("a readiness failure emits the give-up line THEN the rung's warn, exit 1 (:1124 then :1910)", () => {
    const h = makeHarness()
    const detail = `${SERVICE} is crash-looping (NRestarts 6 > baseline 5)`
    const outcome = restartOnlySync(
      makeOpts(h, { readiness: () => ({ ready: false, detail }) }),
    )

    expect(outcome.terminal).toEqual({ kind: "restart-only-readiness-failed" })
    expect(exitCodeFor(outcome.terminal)).toBe(1)
    expect(journalDispositionFor(outcome.terminal)).toBe("untouched")
    // ORDER IS THE CONTRACT: bash emits the give-up warn from INSIDE
    // readiness_ok (:1124) and the rung's own warn after it returns (:1910).
    expect(h.emitted).toEqual([
      { stream: "warn", line: `readiness gave up after 007s: ${detail}` },
      { stream: "warn", line: "restart-only: readiness failed after plain restart (checkout untouched; no rollback)" },
    ])
    expect(linesOf(h)).toEqual([readinessGaveUpLine(TIMEOUT_RAW, detail), restartOnlyReadinessFailedLine])
  })

  it("interpolates READINESS_TIMEOUT as the operator wrote it, not as parsed", () => {
    // `--readiness-timeout 007` counts seven seconds and prints `007`; a port
    // that re-derived the string from the number could only ever print `7`.
    const h = makeHarness()
    restartOnlySync(makeOpts(h, { readiness: () => ({ ready: false, detail: "d" }) }))
    expect(linesOf(h)[0]).toBe("readiness gave up after 007s: d")
    expect(linesOf(h)[0]).not.toContain("after 7s")
  })
})

describe("restartOnlySync - the call order and the readiness request", () => {
  it("restarts, THEN samples the baseline, THEN reads HEAD, THEN probes (:1894, :1897, :1904, :1906)", () => {
    const h = makeHarness()
    restartOnlySync(makeOpts(h))
    // The baseline-before-HEAD half is not cosmetic: readiness_restart_baseline
    // goes through sup_restart_count, which is a systemctl call, so swapping
    // the two lines reorders systemctl.log and the shared trace, both of which
    // GATE 1 diffs.
    expect(h.calls).toEqual(["restart", "readinessBaseline", "readHead", "readiness"])
  })

  it("hands the probe the sampled baseline verbatim, the real HEAD, and allowMissingBuildSha FALSE", () => {
    const h = makeHarness()
    restartOnlySync(makeOpts(h, { readinessBaseline: () => 5 }))

    expect(h.readinessRequests).toEqual([
      { expectedBuildSha: HEAD, allowMissingBuildSha: false, baseline: 5 },
    ])
  })

  it("keeps allowMissingBuildSha false so an unidentifiable build escalates to rung 2 (:1885-1887)", () => {
    // The flag is true only on the rollback path, where PREV may predate
    // /readyz's additive buildSha field. Here, a build that cannot say what it
    // is must FAIL rung 1 rather than be declared healthy.
    const h = makeHarness()
    restartOnlySync(makeOpts(h))
    expect(h.readinessRequests[0]?.allowMissingBuildSha).toBe(false)
  })

  it("abbreviates the healthy line's sha to twelve characters, not nine (:1907)", () => {
    const h = makeHarness()
    restartOnlySync(makeOpts(h))
    expect(linesOf(h)).toEqual([`restart-only: ${SERVICE} healthy at ${HEAD.slice(0, 12)}`])
    expect(HEAD.slice(0, 12)).toHaveLength(12)
  })
})

/**
 * Blockers B4 and B8. These drive the REAL `readinessRestartBaseline` and the
 * REAL `readinessOkSync`, so the baseline travels the entire path bash's
 * `RESTART_BASELINE="$(readiness_restart_baseline)"` /
 * `readiness_ok "$RESTART_BASELINE"` pair travels.
 */
describe("restartOnlySync - the readiness baseline actually reaches the crash-loop rung", () => {
  /**
   * `{ timeout: 2, interval: 3 }` is the exactly-one-iteration pair: the loop
   * tests `now() < deadline` BEFORE each attempt, so one attempt runs, the
   * interval sleep pushes the clock past the deadline, and the loop ends. That
   * keeps these rows deterministic without a real clock or a real sleep.
   */
  const TIMEOUT_SECS = 2
  const INTERVAL_SECS = 3

  const withRealReadiness = (h: Harness, restartCounts: ReadonlyArray<string>): RestartOnlyOptions => {
    const queue = [...restartCounts]
    // `sup_restart_count`: one answer per call, the last one repeating.
    const restartCount = (): string => (queue.length > 1 ? (queue.shift() as string) : (queue[0] as string))
    let clock = 0
    return makeOpts(h, {
      readinessBaseline: () => {
        h.calls.push("readinessBaseline")
        return readinessRestartBaseline(restartCount)
      },
      readiness: (req): ReadinessResult => {
        h.calls.push("readiness")
        h.readinessRequests.push({ ...req })
        return readinessOkSync({
          ...req,
          serviceName: SERVICE,
          readinessPort: "4753",
          timeoutSecs: TIMEOUT_SECS,
          intervalSecs: INTERVAL_SECS,
          isActive: () => "active",
          restartCount,
          probeHealthz: () => "200",
          probeReadyz: () => `{"mode":"normal","buildSha":"${HEAD}"}\n200`,
          now: () => clock,
          sleep: (secs) => {
            clock += secs
          },
        })
      },
    })
  }

  it("a unit with restart HISTORY that holds steady is healthy, exit 0", () => {
    // The regression this row guards: a baseline hardcoded to 0, or sampled
    // before the restart, makes NRestarts=5 read as a crash loop and rolls a
    // perfectly healthy repair into a rung-2 escalation.
    const h = makeHarness()
    const outcome = restartOnlySync(withRealReadiness(h, ["5"]))

    expect(h.readinessRequests[0]?.baseline).toBe(5)
    expect(outcome.terminal).toEqual({ kind: "restart-only-ok" })
    expect(exitCodeFor(outcome.terminal)).toBe(0)
    expect(linesOf(h)).toEqual([restartOnlyHealthyLine(SERVICE, HEAD)])
  })

  it("PARITY ROW: a CLIMBING NRestarts fails the rung with the byte-exact crash-loop detail, exit 1", () => {
    // Baseline sampled at 5 right after the restart; the probe then observes 6.
    // The unit is restarting into a 200 that the OUTGOING process is still
    // serving, which is exactly the case rung 2 of the readiness ladder exists
    // for and exactly the signal a dropped baseline deletes.
    const h = makeHarness()
    const outcome = restartOnlySync(withRealReadiness(h, ["5", "6"]))

    expect(h.readinessRequests[0]?.baseline).toBe(5)
    expect(outcome.terminal).toEqual({ kind: "restart-only-readiness-failed" })
    expect(exitCodeFor(outcome.terminal)).toBe(1)
    expect(journalDispositionFor(outcome.terminal)).toBe("untouched")
    expect(h.emitted).toEqual([
      {
        stream: "warn",
        line: `readiness gave up after 007s: ${SERVICE} is crash-looping (NRestarts 6 > baseline 5)`,
      },
      { stream: "warn", line: restartOnlyReadinessFailedLine },
    ])
  })

  it("a non-numeric NRestarts baselines to 0, exactly as bash's `|| n=0` does (:1064-1065)", () => {
    const h = makeHarness()
    const outcome = restartOnlySync(withRealReadiness(h, ["unknown", "0"]))

    expect(h.readinessRequests[0]?.baseline).toBe(0)
    // 0 <= 0, so the crash-loop rung passes and the run proceeds to /healthz.
    expect(outcome.terminal).toEqual({ kind: "restart-only-ok" })
  })

  it("an unidentifiable build fails rung 1 rather than being declared healthy", () => {
    // allowMissingBuildSha is pinned false here, so a /readyz with no usable
    // hex buildSha must NOT pass - the ladder escalates to rung 2.
    const h = makeHarness()
    let clock = 0
    const outcome = restartOnlySync(
      makeOpts(h, {
        readiness: (req) => {
          h.readinessRequests.push({ ...req })
          return readinessOkSync({
            ...req,
            serviceName: SERVICE,
            readinessPort: "4753",
            timeoutSecs: TIMEOUT_SECS,
            intervalSecs: INTERVAL_SECS,
            isActive: () => "active",
            restartCount: () => "0",
            probeHealthz: () => "200",
            probeReadyz: () => '{"mode":"normal","buildSha":""}\n200',
            now: () => clock,
            sleep: (secs) => {
              clock += secs
            },
          })
        },
      }),
    )

    expect(outcome.terminal).toEqual({ kind: "restart-only-readiness-failed" })
    expect(exitCodeFor(outcome.terminal)).toBe(1)
    expect(linesOf(h)[1]).toBe(restartOnlyReadinessFailedLine)
  })
})

/**
 * Blocker R3. `restart-only.ts` prints none of the eleven lines
 * `restart_service`/`sup_start`/`restart_session_guard` own, so these rows
 * compose the REAL `restartServiceSync` into the `restart` seam, point its
 * `warn` at the SAME sink, and assert those lines land on this rung and in
 * bash's order relative to the rung's own.
 *
 * The systemctl transport, the MainPID reader and the ws-count probe are all
 * injected, so nothing here spawns.
 */
describe("restartOnlySync - composed with the real restart primitive", () => {
  interface SystemctlLog {
    readonly calls: Array<ReadonlyArray<string>>
  }

  const makeRestart = (
    h: Harness,
    log: SystemctlLog,
    cfg: {
      readonly mainPids?: ReadonlyArray<string>
      readonly firstStartFails?: boolean
      readonly guardSessions?: boolean
      readonly wsCount?: number
    } = {},
  ): (() => RestartOutcome) => {
    const pids = [...(cfg.mainPids ?? [])]
    let startAttempts = 0
    return () => {
      h.calls.push("restart")
      return restartServiceSync({
        serviceName: SERVICE,
        dryRun: false,
        // "0" takes settle_after_stop's skipped-zero arm, which emits nothing
        // and calls no sleep - so these rows never wait and never spawn.
        settleSecs: "0",
        guard: {
          guardSessions: cfg.guardSessions ?? false,
          readinessPort: "4753",
          queryActiveWsCount: () => cfg.wsCount ?? 0,
        },
        runSystemctl: (args) => {
          log.calls.push(args)
          if (args[0] === "start") {
            startAttempts += 1
            if (cfg.firstStartFails && startAttempts === 1) return { status: 1 }
          }
          return { status: 0 }
        },
        ...(pids.length > 0
          ? { mainPid: () => (pids.length > 1 ? (pids.shift() as string) : (pids[0] as string)) }
          : {}),
        info: (line) => h.emitted.push({ stream: "info", line }),
        warn: (line) => h.emitted.push({ stream: "warn", line }),
      })
    }
  }

  it("MainPID unchanged: the :1563 POSTCONDITION warn precedes :1896's restart-errored warn, exit 1", () => {
    // The row the audit named. It proves restart.ts prints for restart-only
    // too: revision 2 put these warns in update-flow.ts, which rung 1 never
    // runs, so `--restart-only` against a unit whose stop silently failed
    // printed the POSTCONDITION warn on bash and nothing at all on the binary.
    const h = makeHarness()
    const log: SystemctlLog = { calls: [] }
    const outcome = restartOnlySync(makeOpts(h, { restart: makeRestart(h, log, { mainPids: ["4242", "4242"] }) }))

    expect(outcome.terminal).toEqual({ kind: "restart-only-restart-failed" })
    expect(exitCodeFor(outcome.terminal)).toBe(1)
    expect(h.emitted).toEqual([
      { stream: "warn", line: mainPidUnchangedLine("4242", "4242") },
      { stream: "warn", line: restartOnlyRestartErroredLine },
    ])
    // Byte-exactness of the first line, stated once and not via the builder.
    expect(linesOf(h)[0]).toBe(
      "POSTCONDITION: restart did not replace the server process (MainPID before=4242 after=4242) — the stop silently failed",
    )
    // Nothing past the restart ran.
    expect(h.calls).toEqual(["restart"])
  })

  it("MainPID changed: the postcondition is silent and the rung succeeds, exit 0", () => {
    const h = makeHarness()
    const log: SystemctlLog = { calls: [] }
    const outcome = restartOnlySync(makeOpts(h, { restart: makeRestart(h, log, { mainPids: ["4242", "4343"] }) }))

    expect(outcome.terminal).toEqual({ kind: "restart-only-ok" })
    expect(linesOf(h)).toEqual([restartOnlyHealthyLine(SERVICE, HEAD)])
    expect(log.calls).toEqual([["daemon-reload"], ["stop", SERVICE], ["start", SERVICE]])
  })

  it("a start-limit latch warns and still SUCCEEDS on rung 1, exit 0", () => {
    // Concern 14 on this rung: a unit systemd has latched gets exactly one
    // is-failed -> reset-failed -> retry-start cycle, the `:1375` warn lands on
    // an otherwise SUCCESSFUL rung-1 restart, and the rung finishes healthy
    // rather than escalating. The line is asserted through its builder, not as
    // a literal: `flow-lines.test.ts` owns its bytes and
    // `restart-mainpid-parity.test.ts` owns its position inside systemctl.log.
    // What is rung-1-specific, and asserted here, is that it reaches the
    // operator at all on this path and precedes the rung's own healthy line.
    const h = makeHarness()
    const log: SystemctlLog = { calls: [] }
    const outcome = restartOnlySync(makeOpts(h, { restart: makeRestart(h, log, { firstStartFails: true }) }))

    expect(outcome.terminal).toEqual({ kind: "restart-only-ok" })
    expect(exitCodeFor(outcome.terminal)).toBe(0)
    expect(h.emitted).toEqual([
      { stream: "warn", line: startLimitLatchedLine(SERVICE) },
      { stream: "info", line: restartOnlyHealthyLine(SERVICE, HEAD) },
    ])
    expect(log.calls).toEqual([
      ["daemon-reload"],
      ["stop", SERVICE],
      ["start", SERVICE],
      ["is-failed", SERVICE],
      ["reset-failed", SERVICE],
      ["start", SERVICE],
    ])
  })

  it("a live-session guard deferral exits 3 with NOTHING from this module in the stream", () => {
    const h = makeHarness()
    const log: SystemctlLog = { calls: [] }
    const outcome = restartOnlySync(
      makeOpts(h, { restart: makeRestart(h, log, { guardSessions: true, wsCount: 1 }) }),
    )

    expect(outcome.terminal).toEqual({ kind: "deferred", site: "restart-only" })
    expect(exitCodeFor(outcome.terminal)).toBe(3)
    // The guard defers BEFORE any supervisor step, exactly as :1509 is
    // restart_service's first statement.
    expect(log.calls).toEqual([])
    // Rung 1's `exit 3` is BARE, but the run is NOT silent: bash prints the
    // :1477 line from inside restart_session_guard, and so does the port. The
    // whole point of R2/R3 is that these two facts hold at once.
    const expectedGuardLine = guardVerdictLine({ permitted: false, reason: "live-sessions", sessionCount: 1 }, "4753")
    expect(expectedGuardLine).not.toBeNull()
    expect(h.emitted).toEqual([{ stream: "warn", line: expectedGuardLine }])
    const own = [
      restartOnlyRestartErroredLine,
      restartOnlyReadinessFailedLine,
      restartOnlyHealthyLine(SERVICE, HEAD),
    ]
    for (const line of linesOf(h)) expect(own).not.toContain(line)
  })
})
