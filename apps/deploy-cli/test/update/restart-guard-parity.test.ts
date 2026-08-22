/**
 * Golden parity harness for the stop -> settle -> start restart primitive
 * and the fail-closed session guard: drives the REAL scripts/luna-update-server
 * (via bash-fixtures.ts's makeFixture/runUpdate, reusing the S22a harness)
 * for every scenario, and independently exercises restart.ts / session-guard.ts
 * against the SAME hermetic stub systemctl - proving the TS port's own call
 * shape and decisions agree with what the real bash run actually did, rather
 * than a hand-derived expectation of it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  operatorOverrideLogLine,
  queryActiveWsCountSync,
  restartSessionGuardSync,
  type SessionGuardOptions,
} from "../../src/update/session-guard.js"
import { RESTART_SETTLE_SECS_DEFAULT, restartServiceSync, settleAfterStopSync } from "../../src/update/restart.js"
import { READINESS_PORT, cleanupTempDirs, makeFixture, makeLightFixture, runUpdate } from "./bash-fixtures.js"
import { makeTempDir, repoRoot } from "./temp-dirs.js"

/** scripts/luna-update-server's own source text - read once and reused by every FIX3/FIX8 source-derived oracle below, rather than each helper re-reading the file. */
const updateServerSource = readFileSync(join(repoRoot, "scripts/luna-update-server"), "utf8")

/**
 * FIX8: derives each warn line's expected text from restart_session_guard's
 * OWN luna_warn call in scripts/luna-update-server at test runtime, instead
 * of a hand-typed JS copy of it (the previous version of these four helpers
 * claimed "not a hand-typed duplicate" while actually being exactly that,
 * except for the em dash). Each pattern anchors the FULL fixed skeleton
 * text around the call's interpolated bash variable(s) and captures only
 * the single separator character between them, so a wording edit to the
 * skeleton (added/changed/reordered text) breaks the match and throws here
 * - failing every test that reaches the affected helper - while the actual
 * em dash character is read out of the bash source rather than typed into
 * this file (this codebase bans the literal character in source). Only the
 * variable's runtime VALUE ($n / $state) is a genuine substitution point;
 * everything else must appear verbatim in scripts/luna-update-server or the
 * extraction fails loudly.
 */
const extractWarnSeparator = (pattern: RegExp, label: string): string => {
  const match = updateServerSource.match(pattern)
  if (!match || !match[1]) {
    throw new Error(
      `FIX8 oracle: could not locate restart_session_guard's ${label} luna_warn call in scripts/luna-update-server (pattern: ${pattern}) - has its wording changed?`,
    )
  }
  if (match[1].codePointAt(0) !== 0x2014) {
    throw new Error(`FIX8 oracle: ${label}'s separator is not the expected em dash (U+2014): got ${JSON.stringify(match[1])}`)
  }
  return match[1]
}

const liveSessionsWarnLine = (n: number, readinessPort: string): string => {
  const dash = extractWarnSeparator(
    /luna_warn "session guard: \$n active session\(s\) on :\$READINESS_PORT (.) deferring restart"/,
    "live-sessions",
  )
  return `session guard: ${n} active session(s) on :${readinessPort} ${dash} deferring restart`
}

const deadServerWarnLine = (state: string): string => {
  const dash = extractWarnSeparator(
    /luna_warn "session guard: ws count unknown but unit answered '\$state' (.) no server process; restart permitted"/,
    "dead-server-exception",
  )
  return `session guard: ws count unknown but unit answered '${state}' ${dash} no server process; restart permitted`
}

const transportUnreachableWarnLine = (): string => {
  const dash = extractWarnSeparator(
    /luna_warn "session guard: transport never reached systemd (.) deferring \(fail closed\); a restart through the same transport could not succeed anyway"/,
    "transport-unreachable",
  )
  return `session guard: transport never reached systemd ${dash} deferring (fail closed); a restart through the same transport could not succeed anyway`
}

const unitStateUncertainWarnLine = (state: string): string => {
  const dash = extractWarnSeparator(
    /luna_warn "session guard: ws count unknown while unit answers '\$state' (.) may be serving; deferring \(fail closed\)"/,
    "unit-state-uncertain",
  )
  return `session guard: ws count unknown while unit answers '${state}' ${dash} may be serving; deferring (fail closed)`
}

afterEach(() => {
  cleanupTempDirs()
  vi.unstubAllEnvs()
})

/**
 * First token of every non-empty stub-systemctl log line, filtered to the
 * FOUR events restart_service's happy path emits in order: daemon-reload/
 * stop/settle/start - drops the is-active/show calls the guard's dead-
 * server fallback and the (out-of-scope) readiness/MainPID reads also log
 * through the SAME stub. "settle" only ever appears when the fixture's bin
 * dir was additionally given installOrderedSleepStub's ordered "sleep"
 * wrapper (below) - every other scenario's log simply never contains that
 * token, so extending this filter set is a no-op for tests that never
 * install the wrapper.
 */
const restartVerbs = (log: string): ReadonlyArray<string> =>
  (existsSync(log) ? readFileSync(log, "utf8") : "")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ")[0] ?? "")
    .filter((verb) => verb === "daemon-reload" || verb === "stop" || verb === "start" || verb === "settle")

/**
 * restartServiceSync's `warn` and `info` seams are both REQUIRED (restart.ts
 * prints eleven operator lines through them, at bash's own positions inside
 * restart_session_guard, settle_after_stop, sup_start and restart_service).
 *
 * Every scenario in THIS file discards them, and that is deliberate rather
 * than an omission: these tests are about the primitive's CALL SHAPE and its
 * decisions (which systemctl verbs, in which order, with which outcome), and
 * they predate the printing. The byte-exactness and the POSITION of all eleven
 * lines is proven in restart-mainpid-parity.test.ts, against a bash-derived
 * oracle, so duplicating string assertions here would only add a second place
 * to update. No scenario here supplies a `mainPid` seam either, so the MainPID
 * postcondition is skipped exactly as bash skips it on an unknown pre-PID.
 */
const noWarn = (): void => {}
/** See noWarn. */
const noInfo = (): void => {}

const baseGuard = (serviceName: string, readinessPort: string): SessionGuardOptions => ({
  dryRun: false,
  guardSessions: true,
  supervisor: "systemd",
  serviceName,
  profile: "stable",
  maxSessionDefer: "4h",
  updateStateDir: makeTempDir("deploy-cli-guard-defer-"),
  readinessPort,
})

/**
 * Injectable ws-count stub that mirrors queryActiveWsCountSync's own "count
 * unknown" contract: throw, never return a sentinel value, so the guard's
 * fallback-to-systemd path is what gets exercised - the TS-side stand-in for
 * the real bash scenarios below that set LUNA_TEST_WS_COUNT=unknown (a seam
 * that is bash's own, not this port's - see session-guard.ts's header).
 */
const unknownWsCount = (): number => {
  throw new Error("ws count unknown (test stub)")
}

/**
 * Points the CURRENT process's PATH (not a spawned subprocess's env) at a
 * fixture's stub bin, so the TS port's own systemctl reads resolve the SAME
 * stub the matching bash run used. The `/usr/bin:/bin` suffix mirrors
 * bash-fixtures.ts's own PATH convention (`${bin}:/usr/bin:/bin`) - not for
 * spawnSync's own command resolution (a single-directory PATH resolves a
 * bare command name fine), but for the stub's OWN `#!/usr/bin/env bash`
 * shebang (test/helpers/update-server-fixtures.ts's makeStubBin): `env`
 * needs `bash` reachable on PATH to exec the script, and fails with `env:
 * bash: No such file or directory` (exit 127) when PATH is only the stub
 * dir (measured directly on this platform).
 */
const usingStubPath = (bin: string): void => {
  vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`)
}

/**
 * FIX2: installs a "sleep" wrapper ahead of the real binary on a fixture's
 * PATH that appends a "settle" marker to the SAME log the stub systemctl
 * writes to, before delegating to the REAL /bin/sleep - so daemon-reload/
 * stop/settle/start land in ONE ordered, file-backed log (restartVerbs,
 * above) instead of settle's having happened being provable only by timing.
 * A mutant that moves settle_after_stop's call (bash) or restartServiceSync's
 * settleAfterStopSync call (TS) to after start flips the recorded ORDER
 * here, not merely the wall-clock total - see the first test below, which
 * records having been run against that exact mutation.
 *
 * FIX N2: this wrapper intercepts EVERY `sleep` call bash makes while it is
 * on PATH, not just the settle - scripts/luna-update-server's own readiness
 * poll (:1122) and start-limit retry (:1353) also call `sleep`, and a future
 * change to either could route through this same fixture while the wrapper
 * is installed. `settleSecs` couples the wrapper to the ONE value the calling
 * test actually configured for the settle (its `LUNA_RESTART_SETTLE_SECS`),
 * so only an invocation matching that exact duration is logged as "settle" -
 * a readiness-poll or start-limit-retry sleep using a different duration
 * silently execs straight through to the real binary, unlogged, instead of
 * planting a phantom "settle" token that would corrupt restartVerbs's
 * ordered-log assertion.
 */
const installOrderedSleepStub = (bin: string, log: string, settleSecs: string): void => {
  writeFileSync(
    join(bin, "sleep"),
    `#!/usr/bin/env bash
if [[ "$*" == "${settleSecs}" ]]; then
  printf 'settle %s\\n' "$*" >> "${log}"
fi
exec /bin/sleep "$@"
`,
  )
  spawnSync("chmod", ["+x", join(bin, "sleep")])
}

describe("restart primitive: call order and settle timing match the real bash primitive", () => {
  it("reload -> stop -> settle -> start, in that EXACT order (FIX2: settle's position is now pinned, not just the three systemctl verbs), with a real (short) settle actually elapsing on BOTH sides (FIX4)", () => {
    const bashFixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    installOrderedSleepStub(bashFixture.bin, bashFixture.systemctlLog, "1")

    const bashResult = runUpdate(bashFixture.args, {
      ...bashFixture.env,
      LUNA_RESTART_SETTLE_SECS: "1",
      LUNA_TEST_WS_COUNT: "0",
    })
    expect(bashResult.status, bashResult.stdout + bashResult.stderr).toBe(0)
    // FIX N1: no bash-side wall-clock assertion here (a prior >=900ms check
    // was deleted). It was a no-op assertion in disguise: this scenario's
    // base run overhead is already ~1529ms even with settle=0, so the check
    // passed unconditionally regardless of whether the settle actually ran -
    // it could never discriminate "settled" from "never settled" over that
    // much incidental process/git/subprocess overhead. Settle's POSITION and
    // PRESENCE on the bash side are pinned instead by the ordered-log
    // assertion right below (daemon-reload/stop/settle/start) - confirmed
    // load-bearing directly against a settle_after_stop-removed bash mutant,
    // which this same ordered-log assertion kills (2 tests fail). The TS-side
    // elapsed-time assertion further down stays: it is independently
    // load-bearing (verified against the equivalent TS-side mutant) and does
    // not share this test's overhead-swamping problem.
    const bashEvents = restartVerbs(bashFixture.systemctlLog)
    expect(bashEvents).toEqual(["daemon-reload", "stop", "settle", "start"])

    // FIX10: this scenario never calls runUpdate on the TS side - only the
    // stub bin (for the REAL systemctl subprocess shape) is consumed - so it
    // uses the light fixture instead of paying for makeDeployRepo's git
    // checkout.
    const tsFixture = makeLightFixture({ readyAtTarget: true, readyAtPrev: false })
    const tsEvents: string[] = []
    const runSystemctl = (args: ReadonlyArray<string>): { readonly status: number | null } => {
      tsEvents.push(args[0] ?? "")
      const r = spawnSync("systemctl", args, { env: { ...process.env, PATH: `${tsFixture.bin}:/usr/bin:/bin` } })
      return { status: r.status }
    }
    const sleepSync = (seconds: string): { readonly ok: boolean } => {
      tsEvents.push("settle")
      const r = spawnSync("sleep", [seconds])
      return { ok: r.status === 0 }
    }

    const tsBefore = Date.now()
    const outcome = restartServiceSync({
      warn: noWarn,
      info: noInfo,
      serviceName: tsFixture.serviceName,
      dryRun: false,
      settleSecs: "1",
      sleepSync,
      guard: { ...baseGuard(tsFixture.serviceName, tsFixture.readinessPort), queryActiveWsCount: () => 0 },
      runSystemctl,
    })
    const tsElapsedMs = Date.now() - tsBefore

    expect(outcome.code).toBe(0)
    expect(tsElapsedMs).toBeGreaterThanOrEqual(900)
    expect(tsEvents).toEqual(["daemon-reload", "stop", "settle", "start"])
    expect(tsEvents).toEqual(bashEvents)
  })

  it("a guard defer issues ZERO systemctl calls, matching the real bash primitive (session guard is the FIRST line)", () => {
    const bashFixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    const bashResult = runUpdate(bashFixture.args, { ...bashFixture.env, LUNA_TEST_WS_COUNT: "2" })
    expect(bashResult.status, bashResult.stdout + bashResult.stderr).toBe(3)
    expect(restartVerbs(bashFixture.systemctlLog)).toEqual([])

    const tsFixture = makeLightFixture({ readyAtTarget: true, readyAtPrev: false })
    const calls: Array<ReadonlyArray<string>> = []
    const runSystemctl = (args: ReadonlyArray<string>): { readonly status: number | null } => {
      calls.push(args)
      return { status: 0 }
    }

    const outcome = restartServiceSync({
      warn: noWarn,
      info: noInfo,
      serviceName: tsFixture.serviceName,
      dryRun: false,
      settleSecs: "0",
      guard: { ...baseGuard(tsFixture.serviceName, tsFixture.readinessPort), queryActiveWsCount: () => 2 },
      runSystemctl,
    })

    expect(outcome.code).toBe(3)
    expect(outcome.code === 3 && outcome.verdict.reason).toBe("live-sessions")
    expect(calls).toEqual([])
  })
})

describe("restart primitive: dry-run gating, guard/execution non-decoupling, and the start-limit recovery", () => {
  it("dryRun issues ZERO real systemctl calls (mirrors luna_run's print-only, never-invoke semantics) and settle is skipped", () => {
    const calls: Array<ReadonlyArray<string>> = []
    const runSystemctl = (args: ReadonlyArray<string>): { readonly status: number | null } => {
      calls.push(args)
      return { status: 0 }
    }

    const outcome = restartServiceSync({
      warn: noWarn,
      info: noInfo,
      serviceName: "luna-chat-server.service",
      dryRun: true,
      settleSecs: "1",
      guard: baseGuard("luna-chat-server.service", READINESS_PORT),
      runSystemctl,
    })

    expect(outcome).toEqual({ code: 0, settle: { kind: "skipped-dry-run" } })
    expect(calls).toEqual([])
  })

  it("the primitive's own dryRun/serviceName/supervisor ALWAYS win over a guard object smuggling in disagreeing values - the guard cannot be decoupled from what actually executes", () => {
    const calls: Array<ReadonlyArray<string>> = []
    const runSystemctl = (args: ReadonlyArray<string>): { readonly status: number | null } => {
      calls.push(args)
      return { status: 0 }
    }
    // FIX9: no `as unknown as X` here. `disagreeingGuard` is a plain object
    // literal with NO type annotation, so TypeScript infers its own (wider)
    // type including the extra dryRun/serviceName/supervisor keys instead of
    // running excess-property checks against RestartServiceOptions["guard"]
    // - that check only fires for a FRESH literal assigned/passed directly
    // with that narrower type, not for an already-typed intermediate
    // variable. Passing the variable below therefore proves the SAME
    // runtime spread-order guarantee without defeating the type anywhere -
    // TypeScript still checks that every field it DOES know about
    // (guardSessions, readinessPort, queryActiveWsCount, ...) is legitimate.
    const disagreeingGuard = {
      ...baseGuard("luna-chat-server.service", READINESS_PORT),
      queryActiveWsCount: () => 2,
      dryRun: true,
      serviceName: "luna-old-decommissioned.service",
      supervisor: "launchd",
    }

    const outcome = restartServiceSync({
      warn: noWarn,
      info: noInfo,
      serviceName: "luna-chat-server.service",
      dryRun: false,
      settleSecs: "0",
      guard: disagreeingGuard,
      runSystemctl,
    })

    // Live sessions on the REAL primitive's own service/dryRun/supervisor:
    // the guard must defer, not permit on the strength of the smuggled-in
    // fields.
    expect(outcome.code).toBe(3)
    expect(outcome.code === 3 && outcome.verdict.reason).toBe("live-sessions")
    expect(calls).toEqual([])
  })

  it("omitting settleSecs reaches settleAfterStopSync as the verbatim default ('6'), not silently skipped", () => {
    const seen: string[] = []
    const outcome = restartServiceSync({
      warn: noWarn,
      info: noInfo,
      serviceName: "luna-chat-server.service",
      dryRun: false,
      guard: { ...baseGuard("luna-chat-server.service", READINESS_PORT), queryActiveWsCount: () => 0 },
      runSystemctl: () => ({ status: 0 }),
      sleepSync: (s) => (seen.push(s), { ok: true }),
    })
    expect(outcome).toEqual({ code: 0, settle: { kind: "settled", settleSecs: String(RESTART_SETTLE_SECS_DEFAULT) } })
    expect(seen).toEqual([String(RESTART_SETTLE_SECS_DEFAULT)])
  })

  it("a start-limit-latched unit recovers via is-failed -> reset-failed -> retry start, matching sup_start's own recovery (scripts/luna-update-server:1371-1381)", () => {
    let locked = true
    const calls: Array<ReadonlyArray<string>> = []
    const runSystemctl = (args: ReadonlyArray<string>): { readonly status: number | null } => {
      calls.push(args)
      const [verb] = args
      if (verb === "start") return { status: locked ? 1 : 0 }
      if (verb === "is-failed") return { status: locked ? 0 : 1 }
      if (verb === "reset-failed") {
        locked = false
        return { status: 0 }
      }
      return { status: 0 }
    }

    const outcome = restartServiceSync({
      warn: noWarn,
      info: noInfo,
      serviceName: "luna-chat-server.service",
      dryRun: false,
      settleSecs: "0",
      guard: { ...baseGuard("luna-chat-server.service", READINESS_PORT), queryActiveWsCount: () => 0 },
      runSystemctl,
    })

    expect(outcome.code).toBe(0)
    expect(calls).toEqual([
      ["daemon-reload"],
      ["stop", "luna-chat-server.service"],
      ["start", "luna-chat-server.service"],
      ["is-failed", "luna-chat-server.service"],
      ["reset-failed", "luna-chat-server.service"],
      ["start", "luna-chat-server.service"],
    ])
  })

  it("a start failure that is NOT a start-limit latch (is-failed disagrees) fails the primitive WITHOUT touching reset-failed", () => {
    const calls: Array<ReadonlyArray<string>> = []
    const runSystemctl = (args: ReadonlyArray<string>): { readonly status: number | null } => {
      calls.push(args)
      const [verb] = args
      if (verb === "start") return { status: 1 }
      if (verb === "is-failed") return { status: 1 } // unit is NOT latched failed
      return { status: 0 }
    }

    const outcome = restartServiceSync({
      warn: noWarn,
      info: noInfo,
      serviceName: "luna-chat-server.service",
      dryRun: false,
      settleSecs: "0",
      guard: { ...baseGuard("luna-chat-server.service", READINESS_PORT), queryActiveWsCount: () => 0 },
      runSystemctl,
    })

    expect(outcome).toEqual({ code: 1, step: "start" })
    expect(calls.some((c) => c[0] === "reset-failed")).toBe(false)
  })
})

describe("restart primitive: reload/stop failures short-circuit before start (FIX5 - previously uncovered)", () => {
  it("a failing daemon-reload returns {code:1, step:'reload'} and issues no further systemctl calls", () => {
    const calls: Array<ReadonlyArray<string>> = []
    const runSystemctl = (args: ReadonlyArray<string>): { readonly status: number | null } => {
      calls.push(args)
      if (args[0] === "daemon-reload") return { status: 1 }
      return { status: 0 }
    }

    const outcome = restartServiceSync({
      warn: noWarn,
      info: noInfo,
      serviceName: "luna-chat-server.service",
      dryRun: false,
      settleSecs: "0",
      guard: { ...baseGuard("luna-chat-server.service", READINESS_PORT), queryActiveWsCount: () => 0 },
      runSystemctl,
    })

    expect(outcome).toEqual({ code: 1, step: "reload" })
    expect(calls).toEqual([["daemon-reload"]])
  })

  it("a failing stop returns {code:1, step:'stop'} and CRITICALLY issues no start verb - two servers on one DB is the disaster case", () => {
    const calls: Array<ReadonlyArray<string>> = []
    const runSystemctl = (args: ReadonlyArray<string>): { readonly status: number | null } => {
      calls.push(args)
      if (args[0] === "stop") return { status: 1 }
      return { status: 0 }
    }

    const outcome = restartServiceSync({
      warn: noWarn,
      info: noInfo,
      serviceName: "luna-chat-server.service",
      dryRun: false,
      settleSecs: "0",
      guard: { ...baseGuard("luna-chat-server.service", READINESS_PORT), queryActiveWsCount: () => 0 },
      runSystemctl,
    })

    expect(outcome).toEqual({ code: 1, step: "stop" })
    expect(calls).toEqual([["daemon-reload"], ["stop", "luna-chat-server.service"]])
    expect(calls.some((c) => c[0] === "start")).toBe(false)
  })
})

describe("restart primitive: the guard's systemd fallback is routed through THIS primitive's own runSystemctl", () => {
  it("a thrown ws count falls back to an is-active read via the injected runSystemctl, not a second bare-host transport (dead-server-exception permits, then the sequence proceeds)", () => {
    const calls: Array<ReadonlyArray<string>> = []
    const runSystemctl = (args: ReadonlyArray<string>): { readonly status: number | null; readonly stdout?: string } => {
      calls.push(args)
      if (args[0] === "is-active") return { status: 3, stdout: "failed\n" }
      return { status: 0 }
    }

    const outcome = restartServiceSync({
      warn: noWarn,
      info: noInfo,
      serviceName: "luna-chat-server.service",
      dryRun: false,
      settleSecs: "0",
      guard: { ...baseGuard("luna-chat-server.service", READINESS_PORT), queryActiveWsCount: unknownWsCount },
      runSystemctl,
    })

    expect(outcome.code).toBe(0)
    expect(calls).toEqual([
      ["is-active", "luna-chat-server.service"],
      ["daemon-reload"],
      ["stop", "luna-chat-server.service"],
      ["start", "luna-chat-server.service"],
    ])
  })

  /**
   * FIX B2 (restart.ts's own call site, not session-guard.ts's default):
   * parametrized over the SAME polluted is-active answers the B2 describe
   * block below proves against queryUnitStateSync, so restartServiceSync's
   * OWN readUnitState closure (restart.ts:175, `stripTrailingNewlines`) is
   * pinned too - not just the session-guard.ts default it normally wraps. A
   * bare `.trim()` at that closure would launder 'inactive\r\n'/' inactive\n'
   * into an exact "inactive" match and 'failed \n' into an exact "failed"
   * match, wrongly flipping these three cases to permitted (dead-server-
   * exception, code 0) instead of the deferred (unit-state-uncertain, code 3)
   * outcome bash's own untrimmed `case` statement reaches - leaving the
   * clean 'active\n' case (which a `.trim()` cannot corrupt) as the only
   * previously-covered scenario here.
   */
  const activeFallbackDefersScenarios: ReadonlyArray<{ readonly label: string; readonly stdout: string }> = [
    { label: "'active\\n' (clean)", stdout: "active\n" },
    { label: "'inactive\\r\\n' (stray CR before the newline)", stdout: "inactive\r\n" },
    { label: "' inactive\\n' (leading space)", stdout: " inactive\n" },
    { label: "'failed \\n' (trailing space)", stdout: "failed \n" },
  ]

  for (const { label, stdout } of activeFallbackDefersScenarios) {
    it(`a thrown ws count with an is-active answer of ${label} defers (unit-state-uncertain) - the fallback is not hardcoded to always permit, and issues ZERO reload/stop/start calls`, () => {
      const calls: Array<ReadonlyArray<string>> = []
      const runSystemctl = (args: ReadonlyArray<string>): { readonly status: number | null; readonly stdout?: string } => {
        calls.push(args)
        if (args[0] === "is-active") return { status: 0, stdout }
        return { status: 0 }
      }

      const outcome = restartServiceSync({
        warn: noWarn,
        info: noInfo,
        serviceName: "luna-chat-server.service",
        dryRun: false,
        settleSecs: "0",
        guard: { ...baseGuard("luna-chat-server.service", READINESS_PORT), queryActiveWsCount: unknownWsCount },
        runSystemctl,
      })

      expect(outcome.code).toBe(3)
      expect(outcome.code === 3 && outcome.verdict.reason).toBe("unit-state-uncertain")
      expect(calls).toEqual([["is-active", "luna-chat-server.service"]])
    })
  }
})

describe("session guard: fail-closed decision matrix, parity with the real bash restart_session_guard", () => {
  it("live sessions defer (exit 3 in bash; permitted=false, reason=live-sessions in the TS port)", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    const bash = runUpdate(fixture.args, { ...fixture.env, LUNA_TEST_WS_COUNT: "2" })
    expect(bash.status, bash.stdout + bash.stderr).toBe(3)
    // Byte-match against restart_session_guard's OWN warn line (not the
    // higher-level "DEFERRED by session guard" line a caller further up the
    // script also emits on the same exit code).
    expect(bash.stderr).toContain(liveSessionsWarnLine(2, fixture.readinessPort))

    const verdict = restartSessionGuardSync({
      ...baseGuard(fixture.serviceName, fixture.readinessPort),
      queryActiveWsCount: () => 2,
    })
    expect(verdict).toEqual({ permitted: false, reason: "live-sessions", sessionCount: 2 })
  })

  it("zero sessions permit (exit 0 in bash; permitted=true, reason=zero-sessions in the TS port)", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    const bash = runUpdate(fixture.args, { ...fixture.env, LUNA_TEST_WS_COUNT: "0" })
    expect(bash.status, bash.stdout + bash.stderr).toBe(0)

    const verdict = restartSessionGuardSync({
      ...baseGuard(fixture.serviceName, fixture.readinessPort),
      queryActiveWsCount: () => 0,
    })
    expect(verdict).toEqual({ permitted: true, reason: "zero-sessions", sessionCount: 0 })
  })

  it("unknown count + unit 'active' defers (blip fail-closed): exit 3 in bash, permitted=false in the TS port", () => {
    const bashFixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    const bash = runUpdate(bashFixture.args, { ...bashFixture.env, LUNA_TEST_WS_COUNT: "unknown" })
    expect(bash.status, bash.stdout + bash.stderr).toBe(3)
    expect(bash.stderr).toContain(unitStateUncertainWarnLine("active"))

    const tsFixture = makeLightFixture({ readyAtTarget: true, readyAtPrev: false })
    usingStubPath(tsFixture.bin)
    const verdict = restartSessionGuardSync({
      ...baseGuard(tsFixture.serviceName, tsFixture.readinessPort),
      queryActiveWsCount: unknownWsCount,
    })
    expect(verdict).toEqual({ permitted: false, reason: "unit-state-uncertain", unitState: "active" })
  })

  it("unknown count + unit 'failed' is the dead-server exception: exit 0 in bash, permitted=true in the TS port", () => {
    const bashFixture = makeFixture({ readyAtTarget: true, readyAtPrev: false, isActive: "failed" })
    const bash = runUpdate(bashFixture.args, { ...bashFixture.env, LUNA_TEST_WS_COUNT: "unknown" })
    expect(bash.status, bash.stdout + bash.stderr).toBe(0)
    expect(bash.stderr).toContain(deadServerWarnLine("failed"))

    const tsFixture = makeLightFixture({ readyAtTarget: true, readyAtPrev: false, isActive: "failed" })
    usingStubPath(tsFixture.bin)
    const verdict = restartSessionGuardSync({
      ...baseGuard(tsFixture.serviceName, tsFixture.readinessPort),
      queryActiveWsCount: unknownWsCount,
    })
    expect(verdict).toEqual({ permitted: true, reason: "dead-server-exception", unitState: "failed" })
  })

  it("unknown count + unit 'activating' defers (pre-READY sockets): exit 3 in bash, permitted=false in the TS port", () => {
    const bashFixture = makeFixture({ readyAtTarget: true, readyAtPrev: false, isActive: "activating" })
    const bash = runUpdate(bashFixture.args, { ...bashFixture.env, LUNA_TEST_WS_COUNT: "unknown" })
    expect(bash.status, bash.stdout + bash.stderr).toBe(3)
    expect(bash.stderr).toContain(unitStateUncertainWarnLine("activating"))

    const tsFixture = makeLightFixture({ readyAtTarget: true, readyAtPrev: false, isActive: "activating" })
    usingStubPath(tsFixture.bin)
    const verdict = restartSessionGuardSync({
      ...baseGuard(tsFixture.serviceName, tsFixture.readinessPort),
      queryActiveWsCount: unknownWsCount,
    })
    expect(verdict).toEqual({ permitted: false, reason: "unit-state-uncertain", unitState: "activating" })
  })

  it("unknown count + empty is-active output defers (transport inconclusive): exit 3 in bash, permitted=false in the TS port", () => {
    const bashFixture = makeFixture({ readyAtTarget: true, readyAtPrev: false, isActive: "" })
    const bash = runUpdate(bashFixture.args, { ...bashFixture.env, LUNA_TEST_WS_COUNT: "unknown" })
    expect(bash.status, bash.stdout + bash.stderr).toBe(3)
    expect(bash.stderr).toContain(transportUnreachableWarnLine())

    const tsFixture = makeLightFixture({ readyAtTarget: true, readyAtPrev: false, isActive: "" })
    usingStubPath(tsFixture.bin)
    const verdict = restartSessionGuardSync({
      ...baseGuard(tsFixture.serviceName, tsFixture.readinessPort),
      queryActiveWsCount: unknownWsCount,
    })
    expect(verdict).toEqual({ permitted: false, reason: "transport-unreachable", unitState: "" })
  })

  it("a thrown/garbage session-count query REFUSES (fails closed) instead of proceeding, even with no systemd transport reachable at all - using the REAL production defaults, no injected stubs", () => {
    // No ss(8)/systemctl anywhere on PATH: queryActiveWsCountSync's real
    // ss(8) spawn fails (ENOENT) and throws - exactly the "ss(8) unavailable"
    // case scripts/lib/luna-deploy.sh:252 documents as UNKNOWN - and the
    // systemd fallback read then ALSO fails the same way and degrades to "",
    // landing on the same fail-closed "transport unreachable" branch the
    // empty-is-active bash scenario above takes. Proves the guard cannot be
    // coaxed into "permitted" by starving it of BOTH signals at once, using
    // the real production functions (no queryActiveWsCount/readUnitState
    // override), not stubs.
    vi.stubEnv("PATH", "/nonexistent-bin-only")
    const verdict = restartSessionGuardSync(baseGuard("luna-chat-server.service", READINESS_PORT))
    expect(verdict).toEqual({ permitted: false, reason: "transport-unreachable", unitState: "" })
  })

  it("queryActiveWsCountSync (the real ss(8) probe, the production default) throws when ss is not resolvable on PATH", () => {
    vi.stubEnv("PATH", "/nonexistent-bin-only")
    expect(() => queryActiveWsCountSync(READINESS_PORT)).toThrow()
  })

  it("--operator-override proceeds past live sessions and its log line is byte-exact against the real bash's own captured stderr", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    const bashOverride = runUpdate([...fixture.args, "--operator-override", "drill reason"], {
      ...fixture.env,
      LUNA_TEST_WS_COUNT: "2",
      LUNA_RESTART_SETTLE_SECS: "0",
    })
    expect(bashOverride.status, bashOverride.stdout + bashOverride.stderr).toBe(0)
    // The raw bash stderr must actually CONTAIN the TS port's own generated
    // line - not a hand-typed duplicate of it - so a future edit to either
    // side's wording trips this assertion instead of two copies drifting
    // apart silently.
    expect(bashOverride.stderr).toContain(operatorOverrideLogLine("drill reason"))

    const verdict = restartSessionGuardSync({
      ...baseGuard(fixture.serviceName, fixture.readinessPort),
      operatorOverrideReason: "drill reason",
    })
    // The verdict itself carries the audit line - a caller cannot grant the
    // bypass without also having the line in hand to log.
    expect(verdict).toEqual({
      permitted: true,
      reason: "operator-override",
      auditLine: operatorOverrideLogLine("drill reason"),
    })
  })

  it("standing sessions past maxSessionDefer permit as session-defer-stale (not operator-override)", () => {
    const stateDir = makeTempDir("deploy-cli-guard-stale-")
    writeFileSync(join(stateDir, "session-defer-stable"), "since=1000\n")
    const early = restartSessionGuardSync({
      ...baseGuard("luna-chat-server.service", READINESS_PORT),
      updateStateDir: stateDir,
      maxSessionDefer: "1h",
      nowEpoch: 1000 + 60,
      queryActiveWsCount: () => 2,
    })
    expect(early).toEqual({ permitted: false, reason: "live-sessions", sessionCount: 2 })

    const aged = restartSessionGuardSync({
      ...baseGuard("luna-chat-server.service", READINESS_PORT),
      updateStateDir: stateDir,
      maxSessionDefer: "1h",
      nowEpoch: 1000 + 3600,
      queryActiveWsCount: () => 2,
    })
    expect(aged.permitted).toBe(true)
    if (!aged.permitted) throw new Error("expected permit")
    expect(aged.reason).toBe("session-defer-stale")
    expect(aged.auditLine).toContain("staleness, not an operator override")
    expect(aged.auditLine).not.toContain("SESSION GUARD OVERRIDDEN")
  })

  it("unknown ws count never consults maxSessionDefer (still fail-closed)", () => {
    const stateDir = makeTempDir("deploy-cli-guard-unknown-")
    writeFileSync(join(stateDir, "session-defer-stable"), "since=1\n")
    const verdict = restartSessionGuardSync({
      ...baseGuard("luna-chat-server.service", READINESS_PORT),
      updateStateDir: stateDir,
      maxSessionDefer: "1s",
      nowEpoch: 1_000_000,
      queryActiveWsCount: unknownWsCount,
      readUnitState: () => "active",
    })
    expect(verdict).toEqual({
      permitted: false,
      reason: "unit-state-uncertain",
      unitState: "active",
    })
  })

  it("dry-run, guard-disabled, and non-systemd supervisor all permit unconditionally, matching bash's own unconditional passthroughs", () => {
    expect(restartSessionGuardSync({ ...baseGuard("x", READINESS_PORT), dryRun: true })).toEqual({
      permitted: true,
      reason: "dry-run",
    })
    expect(restartSessionGuardSync({ ...baseGuard("x", READINESS_PORT), guardSessions: false })).toEqual({
      permitted: true,
      reason: "guard-disabled",
    })
    expect(restartSessionGuardSync({ ...baseGuard("x", READINESS_PORT), supervisor: "launchd" })).toEqual({
      permitted: true,
      reason: "non-systemd-supervisor",
    })
  })
})

describe("session guard: the ws-count seam-boundary integer validation (FIX1) - closes the fail-open", () => {
  const invalidCounts: ReadonlyArray<{ readonly label: string; readonly value: unknown }> = [
    { label: "-1 (negative integer)", value: -1 },
    { label: "NaN", value: Number.NaN },
    { label: "'unknown' (bash's own sentinel string)", value: "unknown" },
    { label: "null", value: null },
    { label: "undefined", value: undefined },
  ]

  for (const { label, value } of invalidCounts) {
    it(`a queryActiveWsCount stand-in returning ${label} is treated EXACTLY like a thrown query - never a silently-accepted zero`, () => {
      // Deliberately defeats the return TYPE (not the surrounding object
      // shape - see the FIX9 test above for that distinction) to prove the
      // RUNTIME seam-boundary check (Number.isInteger(raw) && raw >= 0)
      // actually executes: TypeScript's own `=> number` annotation on
      // queryActiveWsCount cannot stop a real caller-supplied stand-in from
      // returning something else at runtime, which is exactly the scenario
      // this cast simulates.
      const badQuery = (() => value) as unknown as (port: string, incusContainer?: string) => number

      const permitVerdict = restartSessionGuardSync({
        ...baseGuard("luna-chat-server.service", READINESS_PORT),
        queryActiveWsCount: badQuery,
        readUnitState: () => "failed",
      })
      expect(permitVerdict).toEqual({ permitted: true, reason: "dead-server-exception", unitState: "failed" })

      const deferVerdict = restartSessionGuardSync({
        ...baseGuard("luna-chat-server.service", READINESS_PORT),
        queryActiveWsCount: badQuery,
        readUnitState: () => "active",
      })
      expect(deferVerdict).toEqual({ permitted: false, reason: "unit-state-uncertain", unitState: "active" })
    })
  }
})

describe("session guard: the incus-container ws-count arm (FIX1) - a faithful port, not a refusal", () => {
  const LIB = join(repoRoot, "scripts/lib/luna-deploy.sh")

  /**
   * incus-double passthrough (mirrors test/guardian.test.ts's private
   * writeIncusPassthroughStub and test/deploy-scripts.test.ts's incus
   * doubles): `incus exec <container> -- argv...` re-execs argv LOCALLY, so
   * a fake `ss` on the SAME PATH backs both the bash luna_active_ws_count
   * incus arm and the TS port's incus arm - proving both parse the
   * IDENTICAL sh -c output rather than merely asserting each in isolation.
   * This is as hermetic a proof as this arm gets without a real incus
   * daemon: it exercises the EXACT argv shape (`exec <c> -- sh -c "..."`)
   * and quoting both sides build, and the fake `ss` stands in for the same
   * seam LUNA_TEST_WS_COUNT stands in for on the host arm.
   */
  const writeIncusExecStub = (bin: string): void => {
    writeFileSync(
      join(bin, "incus"),
      `#!/usr/bin/env bash
[[ "\${1:-}" == exec ]] || exit 1
shift 2
if [[ "\${1:-}" == -- ]]; then shift; fi
export LUNA_TEST_VIA_INCUS_EXEC=1
exec "$@"
`,
    )
    spawnSync("chmod", ["+x", join(bin, "incus")])
  }

  /**
   * The witness half of the incus-arm proof above: without this guard, a
   * mutant that deletes queryActiveWsCountSync's whole `if (incusContainer)`
   * branch (routing straight to the bare-host `ss` call instead) is
   * INDISTINGUISHABLE from the real incus arm - both land on the SAME `ss`
   * binary on this fixture's PATH, so the count/idle assertions below would
   * pass either way and the mutant would survive. LUNA_TEST_VIA_INCUS_EXEC is
   * set by writeIncusExecStub's own `export`, immediately before its `exec
   * "$@"` - the ONLY place that ever sets it - so a bare-host `ss` invocation
   * (the deleted-arm mutant's shape) always sees it unset and refuses,
   * failing the two count-asserting tests below exactly as the incus-arm
   * deletion should. The pre-existing "installed-but-FAILING ss" test
   * already expects a throw regardless of which arm ran, so it survives the
   * same mutant unaffected - both arms throw. Scoped to THIS describe
   * block's local writeSsStub only: the bare-host ws-count/whitespace tests
   * elsewhere in this file write their own `ss` stubs directly and never
   * call this helper, so they carry no such witness and are unaffected.
   */
  const writeSsStub = (bin: string, ssBody: string): void => {
    writeFileSync(
      join(bin, "ss"),
      `#!/usr/bin/env bash
if [[ "\${LUNA_TEST_VIA_INCUS_EXEC:-}" != 1 ]]; then
  printf 'ss reached WITHOUT going through incus exec\\n' >&2
  exit 97
fi
${ssBody}
`,
    )
    spawnSync("chmod", ["+x", join(bin, "ss")])
  }

  const runBashIncusCount = (bin: string, container: string): { readonly status: number | null; readonly stdout: string } => {
    const r = spawnSync(
      "bash",
      ["-c", `set -uo pipefail; source "${LIB}"; luna_active_ws_count "${READINESS_PORT}" "${container}"`],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, LUNA_TEST_WS_COUNT: undefined, PATH: `${bin}:/usr/bin:/bin` } },
    )
    return { status: r.status, stdout: r.stdout }
  }

  it("two established rows through the incus double: bash's luna_active_ws_count and the TS port agree (count 2)", () => {
    const temp = makeTempDir("deploy-cli-incus-wscount-")
    const bin = join(temp, "bin")
    mkdirSync(bin, { recursive: true })
    writeIncusExecStub(bin)
    writeSsStub(
      bin,
      `printf 'ESTAB 0 0 127.0.0.1:${READINESS_PORT} 127.0.0.1:50001\\nESTAB 0 0 127.0.0.1:${READINESS_PORT} 127.0.0.1:50002\\n'`,
    )

    const bash = runBashIncusCount(bin, "luna-example-profile")
    expect(bash.status, bash.stdout).toBe(0)
    expect(bash.stdout.trim()).toBe("2")

    usingStubPath(bin)
    expect(queryActiveWsCountSync(READINESS_PORT, "luna-example-profile")).toBe(2)
  })

  it("an installed-but-FAILING ss inside the container is UNKNOWN (throws), never 0 - the same fail-closed contract as the host arm", () => {
    const temp = makeTempDir("deploy-cli-incus-wscount-")
    const bin = join(temp, "bin")
    mkdirSync(bin, { recursive: true })
    writeIncusExecStub(bin)
    writeSsStub(bin, `exit 1`)

    const bash = runBashIncusCount(bin, "luna-example-profile")
    expect(bash.status).not.toBe(0)

    usingStubPath(bin)
    expect(() => queryActiveWsCountSync(READINESS_PORT, "luna-example-profile")).toThrow()
  })

  it("a genuinely idle container (ss exits 0, empty output) counts 0 on both sides", () => {
    const temp = makeTempDir("deploy-cli-incus-wscount-")
    const bin = join(temp, "bin")
    mkdirSync(bin, { recursive: true })
    writeIncusExecStub(bin)
    writeSsStub(bin, `exit 0`)

    const bash = runBashIncusCount(bin, "luna-example-profile")
    expect(bash.status, bash.stdout).toBe(0)
    expect(bash.stdout.trim()).toBe("0")

    usingStubPath(bin)
    expect(queryActiveWsCountSync(READINESS_PORT, "luna-example-profile")).toBe(0)
  })
})

describe("session guard: stdout trimming matches bash's $() (FIX6 / FIX B2) - trailing-newline strip only, not a full trim, for BOTH the ws-count read and the is-active fallback read", () => {
  const LIB = join(repoRoot, "scripts/lib/luna-deploy.sh")

  it("a whitespace-only (but non-empty) ss line counts as 1, matching bash's wc -l of a blank-but-present row - NOT silently treated as 0", () => {
    const temp = makeTempDir("deploy-cli-wscount-trim-")
    const bin = join(temp, "bin")
    mkdirSync(bin, { recursive: true })
    // A single space followed by one newline: bash's $(...) strips ONLY the
    // trailing newline, leaving a non-empty (whitespace-only) $out - a real
    // counted row, per luna_active_ws_count's own `[[ -n "$out" ]]` check.
    writeFileSync(join(bin, "ss"), `#!/usr/bin/env bash\nprintf ' \\n'\n`)
    spawnSync("chmod", ["+x", join(bin, "ss")])

    const bash = spawnSync(
      "bash",
      ["-c", `set -uo pipefail; source "${LIB}"; luna_active_ws_count "${READINESS_PORT}"`],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, LUNA_TEST_WS_COUNT: undefined, PATH: `${bin}:/usr/bin:/bin` } },
    )
    expect(bash.status, bash.stdout).toBe(0)
    expect(bash.stdout.trim()).toBe("1")

    usingStubPath(bin)
    expect(queryActiveWsCountSync(READINESS_PORT)).toBe(1)
  })

  /**
   * FIX B2: the second fail-open. queryUnitStateSync (and restart.ts's own
   * runSystemctl-routed readUnitState) used to `.trim()` the is-active
   * fallback read instead of stripTrailingNewlines - bash's `$state="$(...)"`
   * strips ONLY trailing newlines, then `case "$state" in inactive|failed)`
   * matches EXACTLY, so a polluted-but-otherwise-"inactive"/"failed" answer
   * (a stray CR some systemd/journald builds emit, or incidental leading/
   * trailing spaces) fails that exact match and falls to the case statement's
   * `*)` default, which defers (fail closed). A bare `.trim()` erases that
   * exact pollution and matches the known-safe string, wrongly PERMITTING the
   * restart (dead-server-exception, code 0) in exactly the scenario the guard
   * exists to catch. Each case below drives the REAL bash script (via the
   * same makeFixture/isActive/runUpdate harness the decision-matrix tests
   * above use, since restart_session_guard lives in scripts/luna-update-server
   * itself, not the sourceable scripts/lib/luna-deploy.sh the ss-only test
   * above sources directly) and separately proves restartSessionGuardSync's
   * OWN default queryUnitStateSync (this module's production wiring, driven
   * through the identical stub systemctl via usingStubPath) now agrees.
   */
  const polluted: ReadonlyArray<{ readonly label: string; readonly isActive: string }> = [
    { label: "inactive\\r\\n' (stray CR before the newline)", isActive: "inactive\r" },
    { label: "' inactive\\n' (leading space)", isActive: " inactive" },
    { label: "'failed \\n' (trailing space)", isActive: "failed " },
  ]

  for (const { label, isActive } of polluted) {
    it(`a polluted is-active answer '${label}' defers on BOTH sides - a bare .trim() would match the clean word and wrongly PERMIT where bash's own case (matching on its untouched, non-trimmed $state) falls through to its default arm and defers`, () => {
      const bashFixture = makeFixture({ readyAtTarget: true, readyAtPrev: false, isActive })
      const bash = runUpdate(bashFixture.args, { ...bashFixture.env, LUNA_TEST_WS_COUNT: "unknown" })
      expect(bash.status, bash.stdout + bash.stderr).toBe(3)
      expect(bash.stderr).toContain(unitStateUncertainWarnLine(isActive))

      const tsFixture = makeLightFixture({ readyAtTarget: true, readyAtPrev: false, isActive })
      usingStubPath(tsFixture.bin)
      const verdict = restartSessionGuardSync({
        ...baseGuard(tsFixture.serviceName, tsFixture.readinessPort),
        queryActiveWsCount: unknownWsCount,
      })
      expect(verdict).toEqual({ permitted: false, reason: "unit-state-uncertain", unitState: isActive })
    })
  }
})

describe("settle_after_stop parity: the 6s default, injectability, and the invalid/zero/dry-run no-op branches", () => {
  it("RESTART_SETTLE_SECS_DEFAULT is the verbatim bash default (6) - never asserted by actually sleeping 6s", () => {
    expect(RESTART_SETTLE_SECS_DEFAULT).toBe(6)
  })

  it("RESTART_SETTLE_SECS_DEFAULT matches scripts/luna-update-server's OWN default literal (FIX3 oracle, S22a's oracle-independent-of-the-code pattern) - not just a hand-copied 6", () => {
    const match = updateServerSource.match(/LUNA_RESTART_SETTLE_SECS:-([0-9]+)/)
    expect(match, 'expected to find RESTART_SETTLE_SECS="${LUNA_RESTART_SETTLE_SECS:-N}" in scripts/luna-update-server').not.toBeNull()
    expect(RESTART_SETTLE_SECS_DEFAULT).toBe(Number(match?.[1]))
  })

  it("settleSecs='0' skips the settle with zero sleep calls (matches bash's `[[ \"$RESTART_SETTLE_SECS\" == \"0\" ]] && return 0`)", () => {
    let sleepCalls = 0
    const outcome = settleAfterStopSync({ dryRun: false, settleSecs: "0", sleepSync: () => (sleepCalls++, { ok: true }) })
    expect(outcome).toEqual({ kind: "skipped-zero" })
    expect(sleepCalls).toBe(0)
  })

  it("dryRun skips the settle with zero sleep calls", () => {
    let sleepCalls = 0
    const outcome = settleAfterStopSync({ dryRun: true, settleSecs: "6", sleepSync: () => (sleepCalls++, { ok: true }) })
    expect(outcome).toEqual({ kind: "skipped-dry-run" })
    expect(sleepCalls).toBe(0)
  })

  it("an invalid settleSecs (matches the bash regression test's 'not-a-number') skips the settle without sleeping, same as bash's loud-warn no-op", () => {
    const bashFixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    const bash = runUpdate(bashFixture.args, { ...bashFixture.env, LUNA_RESTART_SETTLE_SECS: "not-a-number" })
    expect(bash.status, bash.stdout + bash.stderr).toBe(0)
    expect(bash.stderr).toContain("not-a-number")
    expect(bash.stderr).toContain("SKIPPING the post-stop settle")

    let sleepCalls = 0
    const outcome = settleAfterStopSync({
      dryRun: false,
      settleSecs: "not-a-number",
      sleepSync: () => (sleepCalls++, { ok: true }),
    })
    expect(outcome).toEqual({ kind: "skipped-invalid", settleSecs: "not-a-number" })
    expect(sleepCalls).toBe(0)
  })

  it("a valid settleSecs invokes the injected sleep exactly once with that value, and reports settled", () => {
    const seen: string[] = []
    const outcome = settleAfterStopSync({
      dryRun: false,
      settleSecs: "2.5",
      sleepSync: (s) => (seen.push(s), { ok: true }),
    })
    expect(outcome).toEqual({ kind: "settled", settleSecs: "2.5" })
    expect(seen).toEqual(["2.5"])
  })

  it("a failed sleep still returns a normal outcome (never throws) - the primitive must proceed to start regardless", () => {
    const outcome = settleAfterStopSync({ dryRun: false, settleSecs: "1", sleepSync: () => ({ ok: false }) })
    expect(outcome).toEqual({ kind: "settled-sleep-failed", settleSecs: "1" })
  })
})
