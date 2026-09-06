/**
 * `restart.ts`'s ELEVEN EMISSIONS: the bytes, and the POSITION.
 *
 * WHAT THIS FILE OWNS. Bash prints eleven operator lines from inside the two
 * functions `restart.ts` ports plus the guard and `sup_start` it composes:
 * the five `restart_session_guard` verdict lines (:1468, :1477, :1491, :1494,
 * :1497) at `restart_service`'s first statement (:1509), `settle_after_stop`'s
 * triple (:1276, :1279, :1283) between stop and start, `sup_start`'s
 * start-limit warn (:1375) between its is-failed probe and reset-failed, and
 * the two MainPID warns (:1559, :1563) between start and the return. This is
 * the one suite that asserts all eleven, so no other file has to keep a second
 * copy of the strings (`restart-guard-parity.test.ts` deliberately discards
 * both sinks, `restart-only.test.ts` asserts only what is rung-1-specific).
 *
 * THE EXPECTATIONS ARE READ OUT OF THE BASH, NOT TYPED (see
 * `bash-source-oracle.ts`). Three of these lines fire on paths no pre-existing
 * scenario reached, so "I transcribed it correctly" is exactly the claim that
 * cannot be taken on trust. Every assertion below is `bashLogLine(...)` against
 * the payload at the cited line of `scripts/luna-update-server`, with bash's
 * own variable expansions applied; the citations themselves are verified, so a
 * drifted line number fails with the new number rather than silently matching a
 * neighbour.
 *
 * WHY POSITION IS ASSERTED AND NOT JUST PRESENCE. The whole reason these
 * printers live inside `restart.ts` rather than in its callers (see that
 * module's header) is ORDER: bash interleaves the lines with the restart's own
 * systemctl calls. So the rows below record emissions and systemctl calls into
 * ONE ordered sink and assert the interleaving, which is the property a
 * caller-side printer would break while still passing a presence check.
 *
 * WHY THERE IS NO PER-CALL-SITE COPY OF THESE ROWS. `restart_service` has
 * three in-scope callers (:1894 restart-only, :2056 the forward restart, :1824
 * the rollback restart) and the port gives them ONE printer, so "every call
 * site emits" is structural rather than something three near-identical
 * scenarios could prove. The last describe block below asserts that structure
 * directly: `restart.ts` is the only module under `src/` that imports these six
 * builders, so a future caller-side second copy fails here.
 *
 * DRIVE A IS REAL. Four rows run the REAL `scripts/luna-update-server` over
 * the hermetic fixture and assert the prefixed line in its actual stdout/stderr,
 * which is what proves the payload/prefix split (`-> ` on stdout, `warning: `
 * on stderr) rather than assuming it. Drive B (the assembled binary) is not
 * available to this file yet; when it is, `update-flow-parity.test.ts`'s byte
 * diff subsumes these four rows.
 *
 * PORTABILITY. The function-level rows spawn nothing at all. The four drive-A
 * rows go through `bash-fixtures.ts`, which resolves its interpreter from the
 * ambient PATH and stubs every binary it needs.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  mainPidInconclusiveLine,
  mainPidUnchangedLine,
  settleInvalidLine,
  settleSleepFailedLine,
  settlingLine,
  startLimitLatchedLine,
} from "../../src/update/flow-lines.js"
import { type RestartOutcome, type RestartServiceOptions, restartServiceSync } from "../../src/update/restart.js"
import { type GuardVerdict, guardVerdictLine } from "../../src/update/session-guard.js"
import { INFO_PREFIX, WARN_PREFIX, bashLogLine } from "./bash-source-oracle.js"
import { READINESS_PORT, cleanupTempDirs, makeFixture, runUpdate } from "./bash-fixtures.js"
import { repoRoot, makeTempDir } from "./temp-dirs.js"

const SERVICE = "luna-chat-server.service"

/** Minimal guard fields newly required for deploy.maxSessionDefer parity. */
const guardDefaults = {
  profile: "stable" as const,
  maxSessionDefer: "4h",
  updateStateDir: () => makeTempDir("deploy-cli-mainpid-defer-"),
}

const idleGuard = () => ({
  guardSessions: true as const,
  ...{ profile: guardDefaults.profile, maxSessionDefer: guardDefaults.maxSessionDefer, updateStateDir: guardDefaults.updateStateDir() },
  readinessPort: READINESS_PORT,
  queryActiveWsCount: () => 0,
})

afterEach(() => {
  cleanupTempDirs()
})

// --------------------------------------------------------------------------
// The oracle: every payload, read out of scripts/luna-update-server
// --------------------------------------------------------------------------

const settleInvalidOracle = (secs: string): string =>
  bashLogLine({
    line: 1287,
    fn: "luna_warn",
    anchor: "is not a non-negative number of seconds",
    vars: { RESTART_SETTLE_SECS: secs },
  })

const settlingOracle = (secs: string): string =>
  bashLogLine({
    line: 1290,
    fn: "luna_info",
    anchor: "after stop so DuckDB/SQLite release",
    vars: { RESTART_SETTLE_SECS: secs },
  })

const settleSleepFailedOracle = (secs: string): string =>
  bashLogLine({
    line: 1294,
    fn: "luna_warn",
    anchor: "post-stop settle sleep failed",
    vars: { RESTART_SETTLE_SECS: secs },
  })

const startLimitOracle = (serviceName: string): string =>
  bashLogLine({
    line: 1386,
    fn: "luna_warn",
    anchor: "is start-limit latched failed",
    vars: { SERVICE_NAME: serviceName },
  })

const mainPidInconclusiveOracle = (): string =>
  bashLogLine({ line: 1580, fn: "luna_warn", anchor: "restart postcondition INCONCLUSIVE" })

const mainPidUnchangedOracle = (prePid: string, postPid: string): string =>
  bashLogLine({
    line: 1584,
    fn: "luna_warn",
    anchor: "restart did not replace the server process",
    vars: { pre_pid: prePid, post_pid: postPid },
  })

// --------------------------------------------------------------------------
// The function-level rig: ONE ordered sink for emissions AND systemctl calls
// --------------------------------------------------------------------------

/**
 * Every observable event in creation order. `warn:`/`info:` entries carry the
 * payload; `systemctl:` entries carry the verb. Two separate arrays would lose
 * the interleaving, which is the property most of these rows exist to pin.
 */
type Event = string

interface Rig {
  readonly events: Array<Event>
  readonly warns: Array<string>
  readonly infos: Array<string>
}

const makeRig = (): Rig => ({ events: [], warns: [], infos: [] })

interface RunOptions {
  readonly settleSecs?: string
  readonly dryRun?: boolean
  readonly sleepOk?: boolean
  /** Answer queue for the injected MainPID reader; omitted means NO seam at all. */
  readonly mainPids?: ReadonlyArray<string>
  /** The first `start` fails and `is-failed` agrees the unit is latched. */
  readonly startLimitLatched?: boolean
  /** After a latch, the retry start fails too. */
  readonly retryAlsoFails?: boolean
  readonly guard?: Partial<RestartServiceOptions["guard"]>
  /** `is-active` stdout for the guard's count-unknown fallback. */
  readonly unitState?: string
}

const runRestart = (rig: Rig, opts: RunOptions = {}): RestartOutcome => {
  const pids = [...(opts.mainPids ?? [])]
  let startAttempts = 0
  return restartServiceSync({
    serviceName: SERVICE,
    dryRun: opts.dryRun ?? false,
    settleSecs: opts.settleSecs ?? "0",
    // Injected: a real `sleep` would make the settle rows cost wall-clock time
    // and would drag the platform's `sleep` binary into a pure test.
    sleepSync: (secs) => {
      rig.events.push(`sleep:${secs}`)
      return { ok: opts.sleepOk ?? true }
    },
    guard: {
      guardSessions: true,
      profile: "stable",
      maxSessionDefer: "4h",
      updateStateDir: makeTempDir("deploy-cli-mainpid-defer-"),
      readinessPort: READINESS_PORT,
      queryActiveWsCount: () => 0,
      ...opts.guard,
    },
    runSystemctl: (args) => {
      const verb = args[0] ?? ""
      rig.events.push(`systemctl:${verb}`)
      if (verb === "is-active") return { status: 0, stdout: opts.unitState ?? "active\n" }
      if (verb === "start") {
        startAttempts += 1
        if (opts.startLimitLatched && startAttempts === 1) return { status: 1 }
        if (opts.retryAlsoFails && startAttempts === 2) return { status: 1 }
      }
      if (verb === "is-failed") return { status: opts.startLimitLatched ? 0 : 1 }
      return { status: 0 }
    },
    ...(opts.mainPids
      ? { mainPid: () => (pids.length > 1 ? (pids.shift() as string) : (pids[0] ?? "")) }
      : {}),
    info: (line) => {
      rig.events.push(`info:${line}`)
      rig.infos.push(line)
    },
    warn: (line) => {
      rig.events.push(`warn:${line}`)
      rig.warns.push(line)
    },
  })
}

// --------------------------------------------------------------------------
// settle_after_stop's three lines (:1276, :1279, :1283)
// --------------------------------------------------------------------------

describe("the settle triple, at the function level", () => {
  it("a normal settle emits ONLY the :1279 info, and emits it between stop and start", () => {
    const rig = makeRig()
    const outcome = runRestart(rig, { settleSecs: "6" })

    expect(outcome.code).toBe(0)
    expect(rig.infos).toEqual([settlingOracle("6")])
    expect(rig.warns).toEqual([])
    // POSITION, which is the whole reason this printer is inside the primitive:
    // bash calls settle_after_stop at :1528, between sup_stop and sup_start,
    // and the line lands in that window on both engines.
    //
    // AND ITS POSITION *WITHIN* THAT WINDOW, which is the assertion that used
    // to record a divergence and now pins the fix. bash prints :1279 BEFORE it
    // sleeps at :1282; an earlier revision of this port mapped the line from
    // the SettleOutcome instead, and that outcome does not exist until the
    // sleep is over, so the line announcing a six-second pause arrived six
    // seconds after the pause began. No byte diff could see it (nothing else
    // writes inside the window on either engine) and both audiences for the
    // line could: an operator tailing a live deploy, and anyone reading the
    // tail of a run killed DURING the settle, where bash's last line is the
    // settling line. restart.ts's `onSettling` seam puts it back in front of
    // the sleep; the sleep token below sitting AFTER the info token is what
    // proves it.
    expect(rig.events).toEqual([
      "systemctl:daemon-reload",
      `systemctl:stop`,
      `info:${settlingOracle("6")}`,
      "sleep:6",
      "systemctl:start",
    ])
    // ... and the builder the module actually calls agrees with the oracle.
    expect(settlingLine("6")).toBe(settlingOracle("6"))
  })

  it("the production default is 6, not 0, so the :1279 line fires on EVERY real deploy (blocker R1's second half)", () => {
    const rig = makeRig()
    // settleSecs omitted entirely: restart.ts falls back to
    // RESTART_SETTLE_SECS_DEFAULT, exactly as bash's `${LUNA_RESTART_SETTLE_SECS:-6}`
    // does. A gate that only ever pinned the settle to "0" could never see this.
    const outcome = restartServiceSync({
      serviceName: SERVICE,
      dryRun: false,
      sleepSync: () => ({ ok: true }),
      guard: idleGuard(),
      runSystemctl: () => ({ status: 0 }),
      info: (line) => rig.infos.push(line),
      warn: (line) => rig.warns.push(line),
    })

    expect(outcome.code).toBe(0)
    expect(rig.infos).toEqual([settlingOracle("6")])
  })

  it("an invalid value emits ONLY the :1276 warn, skips the sleep, and the restart still succeeds", () => {
    const rig = makeRig()
    const outcome = runRestart(rig, { settleSecs: "not-a-number" })

    // settle_after_stop ALWAYS returns 0 (:1265-1286's own contract): a bad
    // knob must warn, not trip the rollback path.
    expect(outcome.code).toBe(0)
    expect(rig.warns).toEqual([settleInvalidOracle("not-a-number")])
    expect(rig.infos).toEqual([])
    expect(rig.events.some((e) => e.startsWith("sleep:"))).toBe(false)
    expect(rig.events).toEqual([
      "systemctl:daemon-reload",
      "systemctl:stop",
      `warn:${settleInvalidOracle("not-a-number")}`,
      "systemctl:start",
    ])
    expect(settleInvalidLine("not-a-number")).toBe(settleInvalidOracle("not-a-number"))
  })

  it("a FAILED sleep emits TWO lines, :1279 then :1283, because bash prints the settling line before it sleeps", () => {
    const rig = makeRig()
    const outcome = runRestart(rig, { settleSecs: "6", sleepOk: false })

    expect(outcome.code).toBe(0)
    // TWO lines and not one, in this relative order, which is the assertion
    // that matters for the byte diff: bash reaches :1283 only after having
    // already printed :1279, so a port that emitted just the failure line
    // would be one stdout line short of the oracle on this row.
    // The sleep sits BETWEEN them here, exactly as it does in bash, because
    // the :1279 line is the announcement of the sleep that is about to be
    // attempted and the :1283 line is the report of its failure.
    expect(rig.events).toEqual([
      "systemctl:daemon-reload",
      "systemctl:stop",
      `info:${settlingOracle("6")}`,
      "sleep:6",
      `warn:${settleSleepFailedOracle("6")}`,
      "systemctl:start",
    ])
    expect(rig.infos).toEqual([settlingOracle("6")])
    expect(rig.warns).toEqual([settleSleepFailedOracle("6")])
    expect(settleSleepFailedLine("6")).toBe(settleSleepFailedOracle("6"))
  })

  it("settleSecs '0' and dry-run BOTH emit nothing (:1267-1268 return before any warn)", () => {
    const zero = makeRig()
    expect(runRestart(zero, { settleSecs: "0" }).code).toBe(0)
    expect([...zero.infos, ...zero.warns]).toEqual([])

    const dry = makeRig()
    expect(runRestart(dry, { settleSecs: "6", dryRun: true }).code).toBe(0)
    // Nothing at all: the guard's dry-run arm is silent too (:1462), and
    // luna_run never invokes.
    expect(dry.events).toEqual([])
  })
})

// --------------------------------------------------------------------------
// sup_start's start-limit warn (:1375)
// --------------------------------------------------------------------------

describe("sup_start's start-limit warn", () => {
  it("lands BETWEEN the is-failed probe (:1374) and the reset-failed that clears the latch (:1376)", () => {
    const rig = makeRig()
    const outcome = runRestart(rig, { startLimitLatched: true })

    expect(outcome).toEqual({ code: 0, settle: { kind: "skipped-zero" }, startLimitLatched: true })
    expect(rig.events).toEqual([
      "systemctl:daemon-reload",
      "systemctl:stop",
      "systemctl:start",
      "systemctl:is-failed",
      `warn:${startLimitOracle(SERVICE)}`,
      "systemctl:reset-failed",
      "systemctl:start",
    ])
    expect(startLimitLatchedLine(SERVICE)).toBe(startLimitOracle(SERVICE))
  })

  it("is emitted once and only once when the retry start ALSO fails, and the latch flag still travels", () => {
    const rig = makeRig()
    const outcome = runRestart(rig, { startLimitLatched: true, retryAlsoFails: true })

    expect(outcome).toEqual({ code: 1, step: "start", startLimitLatched: true })
    expect(rig.warns).toEqual([startLimitOracle(SERVICE)])
  })

  it("a start failure that is NOT a latch (is-failed disagrees) emits NOTHING - bash returns 1 at :1374 before the warn", () => {
    const rig = makeRig()
    // startLimitLatched false => `start` succeeds, so force the failure by hand.
    let attempts = 0
    const outcome = restartServiceSync({
      serviceName: SERVICE,
      dryRun: false,
      settleSecs: "0",
      guard: idleGuard(),
      runSystemctl: (args) => {
        const verb = args[0] ?? ""
        rig.events.push(`systemctl:${verb}`)
        if (verb === "start") {
          attempts += 1
          return { status: 1 }
        }
        if (verb === "is-failed") return { status: 1 }
        return { status: 0 }
      },
      info: (line) => rig.infos.push(line),
      warn: (line) => rig.warns.push(line),
    })

    expect(outcome).toEqual({ code: 1, step: "start" })
    expect(attempts).toBe(1)
    expect([...rig.infos, ...rig.warns]).toEqual([])
    expect(rig.events.includes("systemctl:reset-failed")).toBe(false)
  })
})

// --------------------------------------------------------------------------
// restart_service's MainPID postcondition (:1550-1568)
// --------------------------------------------------------------------------

describe("the MainPID postcondition, crossed over every pre/post shape", () => {
  it("changed: the postcondition is SILENT and the primitive passes (:1566-1567 falls through)", () => {
    const rig = makeRig()
    const outcome = runRestart(rig, { mainPids: ["4242", "4343"] })

    expect(outcome).toEqual({ code: 0, settle: { kind: "skipped-zero" } })
    expect([...rig.infos, ...rig.warns]).toEqual([])
  })

  it("unchanged: the :1563 POSTCONDITION warn, then code 1 step mainpid, with both pids on the outcome", () => {
    const rig = makeRig()
    const outcome = runRestart(rig, { mainPids: ["4242", "4242"] })

    expect(outcome).toEqual({ code: 1, step: "mainpid", prePid: "4242", postPid: "4242" })
    expect(rig.warns).toEqual([mainPidUnchangedOracle("4242", "4242")])
    // AFTER the start, never before: bash reads post_pid at :1552.
    expect(rig.events).toEqual([
      "systemctl:daemon-reload",
      "systemctl:stop",
      "systemctl:start",
      `warn:${mainPidUnchangedOracle("4242", "4242")}`,
    ])
    expect(mainPidUnchangedLine("4242", "4242")).toBe(mainPidUnchangedOracle("4242", "4242"))
  })

  it("post unreadable: the :1559 INCONCLUSIVE warn and the primitive PASSES (a read blip is not proof)", () => {
    const rig = makeRig()
    const outcome = runRestart(rig, { mainPids: ["4242", ""] })

    expect(outcome).toEqual({ code: 0, settle: { kind: "skipped-zero" }, mainPidInconclusive: true })
    expect(rig.warns).toEqual([mainPidInconclusiveOracle()])
    expect(mainPidInconclusiveLine).toBe(mainPidInconclusiveOracle())
  })

  it("post '0' PASSES silently: systemd answered 'no main process', which disproves 'the old one is still serving'", () => {
    const rig = makeRig()
    const outcome = runRestart(rig, { mainPids: ["4242", "0"] })

    expect(outcome).toEqual({ code: 0, settle: { kind: "skipped-zero" } })
    expect(rig.warns).toEqual([])
  })

  it("pre '0' and pre unreadable both SKIP the check entirely - no second read, no line", () => {
    for (const pre of ["0", "", "not-a-pid"]) {
      const rig = makeRig()
      const reads: string[] = []
      const outcome = restartServiceSync({
        serviceName: SERVICE,
        dryRun: false,
        settleSecs: "0",
        guard: idleGuard(),
        runSystemctl: () => ({ status: 0 }),
        mainPid: () => {
          reads.push(pre)
          return pre
        },
        info: (line) => rig.infos.push(line),
        warn: (line) => rig.warns.push(line),
      })

      expect([pre, outcome.code]).toEqual([pre, 0])
      expect([pre, reads.length]).toEqual([pre, 1])
      expect([pre, rig.warns]).toEqual([pre, []])
    }
  })

  it("no mainPid seam at all: the pre-read never happens and the check is skipped, exactly as an unknown pre-PID is (:1551)", () => {
    const rig = makeRig()
    const outcome = runRestart(rig, {})

    expect(outcome).toEqual({ code: 0, settle: { kind: "skipped-zero" } })
    expect(rig.warns).toEqual([])
  })

  it("dry-run never reads MainPID, mirroring bash's explicit :1520 guard around a run_target_capture that would otherwise execute", () => {
    const rig = makeRig()
    let reads = 0
    const outcome = restartServiceSync({
      serviceName: SERVICE,
      dryRun: true,
      settleSecs: "6",
      guard: idleGuard(),
      runSystemctl: () => ({ status: 0 }),
      mainPid: () => {
        reads += 1
        return "4242"
      },
      info: (line) => rig.infos.push(line),
      warn: (line) => rig.warns.push(line),
    })

    expect(outcome).toEqual({ code: 0, settle: { kind: "skipped-dry-run" } })
    expect(reads).toBe(0)
  })

  it("a rolling-back run restarts TWICE, and the second pre/post pair is what the second call compares", () => {
    // Bash's restart_service is called once for the forward restart (:2056) and
    // again for the rollback restart (:1824), and sup_main_pid is read twice per
    // call. One queue, four answers: the forward restart's stop silently fails
    // (unchanged), the rollback restart's succeeds (changed).
    const rig = makeRig()
    const pids = ["4242", "4242", "4242", "5555"]
    const mainPid = (): string => (pids.length > 1 ? (pids.shift() as string) : (pids[0] ?? ""))
    const call = (): RestartOutcome =>
      restartServiceSync({
        serviceName: SERVICE,
        dryRun: false,
        settleSecs: "0",
        guard: idleGuard(),
        runSystemctl: () => ({ status: 0 }),
        mainPid,
        info: (line) => rig.infos.push(line),
        warn: (line) => rig.warns.push(line),
      })

    expect(call()).toEqual({ code: 1, step: "mainpid", prePid: "4242", postPid: "4242" })
    expect(call()).toEqual({ code: 0, settle: { kind: "skipped-zero" } })
    // Exactly ONE warn across both calls, from the first: the second pair was
    // consumed and compared, not the first pair re-read.
    expect(rig.warns).toEqual([mainPidUnchangedOracle("4242", "4242")])
  })
})

// --------------------------------------------------------------------------
// restart_session_guard's five lines, emitted at :1509
// --------------------------------------------------------------------------

describe("the guard verdict line is emitted from inside the primitive, before anything the restart prints", () => {
  it("live-sessions: the :1477 line is the FIRST event and no systemctl verb follows", () => {
    const rig = makeRig()
    const outcome = runRestart(rig, { settleSecs: "6", guard: { queryActiveWsCount: () => 2 } })

    expect(outcome.code).toBe(3)
    const expected = bashLogLine({
      line: 1496,
      fn: "luna_warn",
      anchor: "deferring restart",
      vars: { n: "2", READINESS_PORT: READINESS_PORT },
    })
    expect(rig.events).toEqual([`warn:${expected}`])
  })

  it("dead-server-exception: the :1491 line is the one guard line that appears on a PERMITTED run, and it precedes daemon-reload", () => {
    const rig = makeRig()
    const outcome = runRestart(rig, {
      guard: {
        queryActiveWsCount: () => {
          throw new Error("ws count unknown (test stub)")
        },
      },
      unitState: "failed\n",
    })

    expect(outcome.code).toBe(0)
    const expected = bashLogLine({
      line: 1512,
      fn: "luna_warn",
      anchor: "no server process; restart permitted",
      vars: { state: "failed" },
    })
    // The guard's own is-active read comes first (it is what produced the
    // verdict), then the line, then the restart. Printing after the
    // `permitted` branch would silence this arm entirely.
    expect(rig.events).toEqual([
      "systemctl:is-active",
      `warn:${expected}`,
      "systemctl:daemon-reload",
      "systemctl:stop",
      "systemctl:start",
    ])
  })

  it("transport-unreachable (:1494) and unit-state-uncertain (:1497) both defer with their own line", () => {
    const unknown = (): number => {
      throw new Error("ws count unknown (test stub)")
    }

    const unreachable = makeRig()
    expect(runRestart(unreachable, { guard: { queryActiveWsCount: unknown }, unitState: "" }).code).toBe(3)
    expect(unreachable.warns).toEqual([
      bashLogLine({ line: 1515, fn: "luna_warn", anchor: "transport never reached systemd" }),
    ])

    const uncertain = makeRig()
    expect(runRestart(uncertain, { guard: { queryActiveWsCount: unknown }, unitState: "activating\n" }).code).toBe(3)
    expect(uncertain.warns).toEqual([
      bashLogLine({
        line: 1518,
        fn: "luna_warn",
        anchor: "may be serving; deferring",
        vars: { state: "activating" },
      }),
    ])
  })

  it("operator-override: the :1468 audit line is emitted through the SAME sink, from the verdict's own auditLine", () => {
    const rig = makeRig()
    const outcome = runRestart(rig, { guard: { operatorOverrideReason: "incident 42" } })

    expect(outcome.code).toBe(0)
    const expected = bashLogLine({
      line: 1482,
      fn: "luna_warn",
      anchor: "SESSION GUARD OVERRIDDEN by operator",
      vars: { OPERATOR_OVERRIDE_REASON: "incident 42" },
    })
    expect(rig.events[0]).toBe(`warn:${expected}`)
  })

  it("zero-sessions, guard-disabled and non-systemd-supervisor are silent, exactly as bash is at :1463/:1466/:1480", () => {
    const zero = makeRig()
    expect(runRestart(zero, {}).code).toBe(0)
    expect(zero.warns).toEqual([])

    const disabled = makeRig()
    expect(runRestart(disabled, { guard: { guardSessions: false } }).code).toBe(0)
    expect(disabled.warns).toEqual([])

    // The supervisor is not settable through this primitive by design (it
    // hardcodes "systemd"), so the arm is covered through the builder itself.
    expect(guardVerdictLine({ permitted: true, reason: "non-systemd-supervisor" }, READINESS_PORT)).toBeNull()
  })
})

// --------------------------------------------------------------------------
// Drive A: the same lines, out of the REAL bash engine
// --------------------------------------------------------------------------

describe("drive A: the real engine emits these lines with these prefixes", () => {
  it("a happy deploy with LUNA_RESTART_SETTLE_SECS=1 prints the :1279 settling line to STDOUT with the `-> ` prefix", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    const bash = runUpdate(fixture.args, { ...fixture.env, LUNA_RESTART_SETTLE_SECS: "1" })

    expect(bash.status, bash.stdout + bash.stderr).toBe(0)
    expect(bash.stdout.split("\n")).toContain(`${INFO_PREFIX}${settlingOracle("1")}`)
    // The port's builder produces the same payload the engine just printed.
    expect(bash.stdout).toContain(settlingLine("1"))
  })

  it("LUNA_RESTART_SETTLE_SECS=abc prints the :1276 warn to STDERR and the deploy still succeeds", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    const bash = runUpdate(fixture.args, { ...fixture.env, LUNA_RESTART_SETTLE_SECS: "abc" })

    expect(bash.status, bash.stdout + bash.stderr).toBe(0)
    expect(bash.stderr.split("\n")).toContain(`${WARN_PREFIX}${settleInvalidOracle("abc")}`)
    expect(bash.stderr).toContain(settleInvalidLine("abc"))
  })

  it("a MainPID that does not change prints the :1563 POSTCONDITION warn to STDERR", () => {
    // The stub answers `show --property=MainPID` from this queue, repeating the
    // last entry once exhausted, so every read in the run answers 4242: the
    // forward restart's postcondition sees an unchanged PID and fails.
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: true, mainPid: ["4242"] })
    const bash = runUpdate(fixture.args, fixture.env)

    expect(bash.stderr).toContain(`${WARN_PREFIX}${mainPidUnchangedOracle("4242", "4242")}`)
    expect(bash.stderr).toContain(mainPidUnchangedLine("4242", "4242"))
    // Not a success: bash's restart_service returned 1, so the forward deploy
    // failed and the transaction did not end healthy.
    expect(bash.status).not.toBe(0)
  })

  it("a MainPID read that answers nothing prints the :1559 INCONCLUSIVE warn and the deploy still SUCCEEDS", () => {
    // A non-numeric answer is passed through untouched by the stub, which is
    // how sup_main_pid's own `[[ =~ ^[0-9]+$ ]] || pid=""` normalisation and
    // restart_service's INCONCLUSIVE arm get exercised: first read numeric,
    // every read after it unreadable.
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false, mainPid: ["4242", "unknown"] })
    const bash = runUpdate(fixture.args, fixture.env)

    expect(bash.status, bash.stdout + bash.stderr).toBe(0)
    expect(bash.stderr).toContain(`${WARN_PREFIX}${mainPidInconclusiveOracle()}`)
    expect(bash.stderr).toContain(mainPidInconclusiveLine)
  })
})

// --------------------------------------------------------------------------
// ONE printer, three call sites
// --------------------------------------------------------------------------

/** Every `.ts` under a directory, recursively. Node-only, no shell, no glob dependency, no platform assumption. */
const listTsFiles = (dir: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTsFiles(full))
    else if (entry.name.endsWith(".ts")) out.push(full)
  }
  return out
}

describe("the six restart-owned builders have exactly ONE importer under src/", () => {
  it("restart.ts is the only module that imports them, so all three callers of restart_service get them", () => {
    // Bash prints these from inside restart_service/sup_start, which has three
    // in-scope callers (:1894, :2056, :1824). The port gives them one printer.
    // A caller-side second copy - the fix this design deliberately rejected -
    // would drift, and would print in the wrong ORDER relative to the restart's
    // own steps. This assertion is what makes that a test failure rather than a
    // code review.
    const builders = [
      "settleInvalidLine",
      "settlingLine",
      "settleSleepFailedLine",
      "startLimitLatchedLine",
      "mainPidInconclusiveLine",
      "mainPidUnchangedLine",
    ] as const
    const srcDir = join(repoRoot, "apps/deploy-cli/src")
    const files = listTsFiles(srcDir).filter(
      (f) => !f.endsWith(join("update", "flow-lines.ts")) && !f.endsWith(join("update", "restart.ts")),
    )
    const offenders: Array<string> = []
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      if (!text.includes("flow-lines.js")) continue
      for (const builder of builders) {
        if (new RegExp(`\\b${builder}\\b`).test(text)) offenders.push(`${file}: ${builder}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
