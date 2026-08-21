/**
 * `runUpdateFlowSync` (src/update/update-flow.ts) driven through a fully
 * injected `UpdateFlowDeps`, one row per branch of
 * `scripts/luna-update-server:1871-2086`.
 *
 * WHAT THIS FILE IS, AND WHAT IT IS NOT. It is the ORDERING and ROUTING suite
 * for the orchestrator: which seam is called, in which order, with which
 * arguments, and which `Terminal` comes back. It is NOT the byte-parity proof
 * - the bytes are proved by `update-flow-parity.test.ts`, which runs the real
 * bash engine and this binary over one fixture and diffs their stdout, stderr
 * and side effects. Anything asserted here that also appears there is asserted
 * here because it is cheap and localises the failure, not because this file is
 * the evidence.
 *
 * WHY AN ORDERING SUITE EARNS ITS KEEP ANYWAY. Three of the flow's facts are
 * invisible to a byte diff and expensive to see in a dual-drive run:
 *   1. the :1889-1913 fallthrough, where `--restart-only` with a pending
 *      journal must abandon rung 1 and run full recovery - a port that models
 *      rung 1 as a sibling machine passes every naturally-written test and
 *      silently deletes this path;
 *   2. `forwardRestartRan`, which is never printed and yet decides whether the
 *      eventual rollback exempts or keeps the session guard;
 *   3. the journal write/clear sites, where "which phase was on disk when the
 *      process died" is the whole crash-safety story and a stderr diff sees
 *      none of it.
 *
 * PURE, NO FIXTURES, RUNS ANYWHERE. No filesystem, no subprocess, no clock, no
 * platform assumption: every seam is a recording stub. The default vitest
 * budget is orders of magnitude more than these need, so no row carries an
 * explicit timeout, unlike the dual-drive suites where one is mandatory.
 *
 * THE DISPOSITION CROSS-CHECK AT THE BOTTOM is the one property test here.
 * `terminals.ts`'s `journalDispositionFor` is DESCRIPTIVE of this file, so a
 * table that says "cleared" for a terminal this flow leaves a journal behind
 * on would be a lie nothing else catches. The check covers exactly the
 * terminals whose journal handling this flow performs itself; the four that
 * `rollback.ts` owns (`rolled-back`, `rollback-failed`,
 * `forward-failed-no-rollback` and the rollback-restart defer) are excluded by
 * name, because here those seams are stubs and `rollback-parity.test.ts`
 * already drives the real ones against the bash.
 */
import { describe, expect, it } from "vitest"
import type { Transaction, TxPhase } from "../../src/update/journal.js"
import type { ReadinessResult } from "../../src/update/readiness.js"
import type { RestartOutcome } from "../../src/update/restart.js"
import type { FailForwardOutcome, RollbackOutcome } from "../../src/update/rollback.js"
import type { GuardVerdict } from "../../src/update/session-guard.js"
import { journalDispositionFor, type Terminal } from "../../src/update/terminals.js"
import { runUpdateFlowSync, type UpdateFlowDeps } from "../../src/update/update-flow.js"

const SERVICE = "luna-server-dev"
const PREV = "1".repeat(40)
const REF = "2".repeat(40)
const NEW_HEAD = "2".repeat(40)
const PREV_LOCK = "3".repeat(40)
const JOURNAL = "/var/lib/luna/deploy/transaction-dev"
const TIMEOUT_RAW = "007"

const PERMITTED: GuardVerdict = { permitted: true, reason: "zero-sessions", sessionCount: 0 }
const DEFERRED: GuardVerdict = { permitted: false, reason: "live-sessions", sessionCount: 2 }
const RESTART_OK: RestartOutcome = { code: 0, settle: { kind: "skipped-zero" } }
const RESTART_DEFER: RestartOutcome = { code: 3, verdict: DEFERRED }
const READY: ReadinessResult = { ready: true, detail: "" }
const NOT_READY: ReadinessResult = { ready: false, detail: "/healthz did not return 200 on :4753" }

const txn = (phase: TxPhase): Transaction => ({ phase, prev: PREV, target: REF, prevLockHash: PREV_LOCK })

interface WriteRecord {
  readonly phase: TxPhase
  readonly fields: { prev: string; target: string; prevLockHash: string }
}

interface FailForwardCall {
  readonly reason: string
  readonly ref: string
  readonly prev: string
  readonly newHead: string | null
  readonly forwardRestartRan: boolean
}

interface RollbackCall {
  readonly ref: string
  readonly prev: string
  readonly forwardRestartRan: boolean
}

/** What a run did, in one record, so a row asserts behaviour rather than mocks. */
interface Probe {
  /** Every seam call that has an order worth defending, in call order. */
  readonly trace: string[]
  /** `luna_info` payloads, i.e. what the `-> ` writer would have received. */
  readonly info: string[]
  /** `luna_warn` payloads, i.e. what the `warning: ` writer would have received. */
  readonly warn: string[]
  /** RAW stderr, newline included, exactly as the writer received it. */
  readonly raw: string[]
  readonly writes: WriteRecord[]
  readonly failForwardCalls: FailForwardCall[]
  readonly rollbackCalls: RollbackCall[]
  readonly applyRefCalls: Array<{ target: string; prevLockHash: string; trackApply: boolean }>
  readonly restartCalls: boolean[]
  readonly readinessCalls: Array<{ expectedBuildSha: string; allowMissingBuildSha: boolean; baseline: number }>
  cleared: number
  seeded: number
  journalExistsCalls: number
}

interface Scenario {
  readonly restartOnly?: boolean
  /** `null` means `[[ -f ]]` is false at BOTH of bash's tests. */
  readonly journal?: Transaction | "corrupt" | null
  readonly freshRun?: () => ReturnType<UpdateFlowDeps["freshRun"]>
  /** Consumed one per `restart_session_guard` call at the two standalone sites. */
  readonly guards?: ReadonlyArray<GuardVerdict>
  readonly restarts?: ReadonlyArray<RestartOutcome>
  readonly applyRefOk?: boolean
  readonly readiness?: ReadinessResult
  readonly failForward?: FailForwardOutcome
  readonly rollback?: RollbackOutcome
  readonly readHead?: string
}

const makeDeps = (scenario: Scenario): { deps: UpdateFlowDeps; probe: Probe } => {
  const probe: Probe = {
    trace: [],
    info: [],
    warn: [],
    raw: [],
    writes: [],
    failForwardCalls: [],
    rollbackCalls: [],
    applyRefCalls: [],
    restartCalls: [],
    readinessCalls: [],
    cleared: 0,
    seeded: 0,
    journalExistsCalls: 0,
  }
  const journal = scenario.journal ?? null
  const guards = [...(scenario.guards ?? [PERMITTED, PERMITTED])]
  const restarts = [...(scenario.restarts ?? [RESTART_OK])]

  const deps: UpdateFlowDeps = {
    restartOnly: scenario.restartOnly ?? false,
    serviceName: SERVICE,
    requestedRef: "origin/master",
    readinessTimeoutRaw: TIMEOUT_RAW,
    info: (line) => {
      probe.info.push(line)
      probe.trace.push(`info:${line}`)
    },
    warn: (line) => {
      probe.warn.push(line)
      probe.trace.push(`warn:${line}`)
    },
    writeStderrRaw: (text) => {
      probe.raw.push(text)
      probe.trace.push("writeStderrRaw")
    },
    journalExists: () => {
      probe.journalExistsCalls += 1
      probe.trace.push("journalExists")
      return journal !== null
    },
    loadTransaction: () => {
      probe.trace.push("loadTransaction")
      if (journal === null) throw new Error("loadTransaction called with no journal on disk")
      return journal
    },
    writeTransaction: (phase, fields) => {
      probe.writes.push({ phase, fields })
      probe.trace.push(`write:${phase}`)
    },
    clearTransaction: () => {
      probe.cleared += 1
      probe.trace.push("clear")
    },
    journalPath: JOURNAL,
    guard: () => {
      probe.trace.push("guard")
      const verdict = guards.shift()
      if (verdict === undefined) throw new Error("guard called more times than the scenario supplies verdicts")
      return verdict
    },
    restart: (guardSessions) => {
      probe.restartCalls.push(guardSessions)
      probe.trace.push(`restart:${String(guardSessions)}`)
      const outcome = restarts.shift()
      if (outcome === undefined) throw new Error("restart called more times than the scenario supplies outcomes")
      return outcome
    },
    readinessBaseline: () => {
      probe.trace.push("readinessBaseline")
      return 4
    },
    readiness: (req) => {
      probe.readinessCalls.push({ ...req })
      probe.trace.push("readiness")
      return scenario.readiness ?? READY
    },
    applyRef: (target, prevLockHash, trackApply) => {
      probe.applyRefCalls.push({ target, prevLockHash, trackApply })
      probe.trace.push("applyRef")
      return scenario.applyRefOk ?? true
    },
    readHead: () => {
      probe.trace.push("readHead")
      return scenario.readHead ?? NEW_HEAD
    },
    freshRun: () => {
      probe.trace.push("freshRun")
      return scenario.freshRun?.() ?? { ok: true, prev: PREV, ref: REF, prevLockHash: PREV_LOCK }
    },
    seedDreamWakeJobs: () => {
      probe.seeded += 1
      probe.trace.push("seed")
    },
    failForward: (args) => {
      probe.failForwardCalls.push(args)
      probe.trace.push("failForward")
      return scenario.failForward ?? { kind: "rolled-back", outcome: { exitCode: 1, guardSessions: false } }
    },
    rollback: (args) => {
      probe.rollbackCalls.push(args)
      probe.trace.push("rollback")
      return scenario.rollback ?? { exitCode: 1, guardSessions: false }
    },
  }
  return { deps, probe }
}

const run = (scenario: Scenario): { terminal: Terminal; probe: Probe } => {
  const { deps, probe } = makeDeps(scenario)
  return { terminal: runUpdateFlowSync(deps), probe }
}

const phases = (probe: Probe): ReadonlyArray<TxPhase> => probe.writes.map((w) => w.phase)

describe("runUpdateFlowSync: the fresh-run forward path (:1963-2086)", () => {
  it("walks bash's order and clears the journal on a healthy update", () => {
    const { terminal, probe } = run({})

    expect(terminal).toEqual({ kind: "updated" })
    // The whole transcript, in one assertion, because ORDER is the contract:
    // the guard sits after ref resolution and before the first write (:1997-
    // :2002), both post-apply writes are sequential (:2043, :2045), the
    // baseline is sampled after the restart is issued (:2069) and the
    // `verifying` write precedes the probe (:2071-2073).
    expect(probe.trace).toEqual([
      "journalExists",
      "freshRun",
      "guard",
      "write:prepared",
      "applyRef",
      "readHead",
      `info:Checked out: ${NEW_HEAD}`,
      "write:applied",
      "write:restarting",
      "restart:true",
      "readinessBaseline",
      "write:verifying",
      "readiness",
      `info:updated ${PREV} -> ${NEW_HEAD} (${SERVICE} healthy)`,
      "seed",
      "clear",
    ])
    expect(probe.warn).toEqual([])
    expect(probe.raw).toEqual([])
    expect(probe.seeded).toBe(1)
    expect(probe.cleared).toBe(1)
  })

  it("passes trackApply true at the ONE forward call site, with the fresh-run target and lock hash", () => {
    const { probe } = run({})
    expect(probe.applyRefCalls).toEqual([{ target: REF, prevLockHash: PREV_LOCK, trackApply: true }])
  })

  it("probes readiness for NEW_HEAD, never REF, and never allows a missing build sha (:2070-2073)", () => {
    // An abbreviated `--ref` is the spelling where the two separate: bash
    // passes 7-64 hex through verbatim on the inplace layout while `rev-parse
    // HEAD` always answers full lowercase 40.
    const { probe } = run({
      freshRun: () => ({ ok: true, prev: PREV, ref: "2222222", prevLockHash: PREV_LOCK }),
      readHead: NEW_HEAD,
    })
    expect(probe.readinessCalls).toEqual([{ expectedBuildSha: NEW_HEAD, allowMissingBuildSha: false, baseline: 4 }])
    expect(probe.applyRefCalls[0]?.target).toBe("2222222")
    // The journal's target field stays REF throughout (:2043 re-writes the
    // same three globals), so a resume re-applies what was asked for.
    expect(probe.writes.map((w) => w.fields.target)).toEqual(["2222222", "2222222", "2222222", "2222222"])
  })

  it("defers before the first journal write when the guard refuses (:1997-2000)", () => {
    const { terminal, probe } = run({ guards: [DEFERRED] })

    expect(terminal).toEqual({ kind: "deferred", site: "fresh-run" })
    expect(probe.warn).toEqual(["DEFERRED by session guard; nothing mutated (retry next tick)"])
    // "nothing mutated" has to be literally true, which is the only thing that
    // makes a fresh-run defer safe to retry on the next tick.
    expect(probe.writes).toEqual([])
    expect(probe.cleared).toBe(0)
    expect(probe.applyRefCalls).toEqual([])
  })

  it("turns a fresh-run refusal into one luna_die line and exit-1's terminal (:1965, :1974, :1994)", () => {
    const { terminal, probe } = run({
      freshRun: () => ({ ok: false, message: "fetch failed before update; checkout unchanged" }),
    })

    expect(terminal).toEqual({ kind: "preflight-refused" })
    expect(probe.raw).toEqual(["error: fetch failed before update; checkout unchanged\n"])
    expect(probe.warn).toEqual([])
    expect(probe.writes).toEqual([])
    // The guard is never consulted: bash dies inside the prologue, before
    // :1997 is reached.
    expect(probe.trace).toEqual(["journalExists", "freshRun", "writeStderrRaw"])
  })
})

describe("runUpdateFlowSync: forward failure routing (:2031, :2058-2065, :2086)", () => {
  it("routes an apply failure to fail_forward with newHead null and the restart not yet run (:2031)", () => {
    const { terminal, probe } = run({ applyRefOk: false })

    expect(probe.failForwardCalls).toEqual([
      { reason: `apply to ${REF} errored`, ref: REF, prev: PREV, newHead: null, forwardRestartRan: false },
    ])
    // forwardRestartRan false is what keeps the session guard ACTIVE for the
    // rollback restart: the old server never stopped and is still serving.
    expect(terminal).toEqual({ kind: "rolled-back" })
    expect(phases(probe)).toEqual(["prepared"])
    expect(probe.restartCalls).toEqual([])
  })

  it("does NOT route a mid-transaction guard defer into fail_forward (:2056-2059)", () => {
    const { terminal, probe } = run({ restarts: [RESTART_DEFER] })

    expect(terminal).toEqual({ kind: "deferred", site: "mid-transaction" })
    expect(probe.warn).toEqual([
      "DEFERRED by session guard mid-transaction; journal retained (phase=restarting) — resumes next tick",
    ])
    // fail_forward would roll back, and its rollback performs the very restart
    // the guard just refused.
    expect(probe.failForwardCalls).toEqual([])
    expect(probe.rollbackCalls).toEqual([])
    // The journal is left exactly where the line promises it is.
    expect(phases(probe)).toEqual(["prepared", "applied", "restarting"])
    expect(probe.cleared).toBe(0)
  })

  it("routes every other non-zero restart code, MainPID included, with forwardRestartRan true (:2062-2065)", () => {
    const { probe } = run({
      restarts: [{ code: 1, step: "mainpid", prePid: "4242", postPid: "4242" }],
    })

    expect(probe.failForwardCalls).toEqual([
      { reason: "service restart errored", ref: REF, prev: PREV, newHead: NEW_HEAD, forwardRestartRan: true },
    ])
    // The flow prints none of restart_service's own eleven lines; they are
    // emitted from inside restart.ts at bash's positions.
    expect(probe.warn).toEqual([])
    // Readiness is never reached on a failed restart.
    expect(probe.readinessCalls).toEqual([])
  })

  it("emits the give-up line before fail_forward on a readiness failure, and seeds nothing (:1124, :2086)", () => {
    const { terminal, probe } = run({ readiness: NOT_READY })

    expect(terminal).toEqual({ kind: "rolled-back" })
    // The RAW timeout spelling, not the parsed number: `007` counts 7 seconds
    // and prints `007`.
    expect(probe.warn).toEqual([
      "readiness gave up after 007s: /healthz did not return 200 on :4753",
    ])
    expect(probe.trace.slice(-2)).toEqual(["warn:readiness gave up after 007s: /healthz did not return 200 on :4753", "failForward"])
    expect(probe.failForwardCalls).toEqual([
      { reason: "failed readiness", ref: REF, prev: PREV, newHead: NEW_HEAD, forwardRestartRan: true },
    ])
    // A failed deploy neither seeds nor clears; the journal is at
    // phase=verifying for whatever fail_forward decides to do with it.
    expect(probe.seeded).toBe(0)
    expect(probe.cleared).toBe(0)
    expect(phases(probe)).toEqual(["prepared", "applied", "restarting", "verifying"])
  })

  it("prints fail_forward's --no-rollback message as a luna_die line (:1866)", () => {
    const { terminal, probe } = run({
      readiness: NOT_READY,
      failForward: {
        kind: "died",
        exitCode: 1,
        message: `failed readiness and --no-rollback set; server left at ${NEW_HEAD} (may be unhealthy)`,
      },
    })

    expect(terminal).toEqual({ kind: "forward-failed-no-rollback" })
    expect(probe.raw).toEqual([
      `error: failed readiness and --no-rollback set; server left at ${NEW_HEAD} (may be unhealthy)\n`,
    ])
    // failForwardSync already wrote phase=forward-failed; this flow adds no
    // write of its own on that path.
    expect(phases(probe)).toEqual(["prepared", "applied", "restarting", "verifying"])
    expect(probe.cleared).toBe(0)
  })

  it.each([
    [1, { kind: "rolled-back" } as Terminal],
    [2, { kind: "rollback-failed" } as Terminal],
    [3, { kind: "deferred", site: "rollback-restart" } as Terminal],
  ])("maps do_rollback's exit %i onto its terminal (:1841, :1857, :1831)", (exitCode, expected) => {
    const outcome = { exitCode, guardSessions: false } as RollbackOutcome
    const { terminal } = run({ readiness: NOT_READY, failForward: { kind: "rolled-back", outcome } })
    expect(terminal).toEqual(expected)
  })
})

describe("runUpdateFlowSync: the journal fork (:1923-1953)", () => {
  it("refuses to mutate a checkout behind a corrupt journal, with a prefix-free CRITICAL line (:1925-1926)", () => {
    const { terminal, probe } = run({ journal: "corrupt" })

    expect(terminal).toEqual({ kind: "corrupt-journal" })
    expect(probe.raw).toEqual([
      `CRITICAL: corrupt update transaction journal ${JOURNAL} — refusing to mutate the checkout; inspect or remove it manually.\n`,
    ])
    expect(probe.warn).toEqual([])
    // Nothing is read, written, applied or cleared: the journal is left for a
    // human, exactly as the line says.
    expect(probe.writes).toEqual([])
    expect(probe.cleared).toBe(0)
    expect(probe.applyRefCalls).toEqual([])
    expect(probe.trace).toEqual(["journalExists", "loadTransaction", "writeStderrRaw"])
  })

  it("recovers a forward phase from the journal rather than from argv, and writes no `prepared` (:1928-1932)", () => {
    const { terminal, probe } = run({ journal: txn("applied") })

    expect(terminal).toEqual({ kind: "updated" })
    expect(probe.warn).toEqual([
      `RECOVERING interrupted update phase=applied prev=${PREV.slice(0, 9)} target=${REF.slice(0, 9)}`,
    ])
    // A resume re-applies the journal's target with the journal's lock hash,
    // and never calls freshRun - so it performs no `git fetch` either.
    expect(probe.applyRefCalls).toEqual([{ target: REF, prevLockHash: PREV_LOCK, trackApply: true }])
    expect(probe.trace).not.toContain("freshRun")
    expect(phases(probe)).toEqual(["applied", "restarting", "verifying"])
  })

  it("keeps the journal when the guard defers a resume (:1947-1951)", () => {
    const { terminal, probe } = run({ journal: txn("restarting"), guards: [DEFERRED] })

    expect(terminal).toEqual({ kind: "deferred", site: "recovery-resume" })
    expect(probe.warn.at(-1)).toBe(
      "DEFERRED by session guard; transaction journal retained (phase=restarting) — resumes when sessions end",
    )
    expect(probe.writes).toEqual([])
    expect(probe.cleared).toBe(0)
    expect(probe.applyRefCalls).toEqual([])
  })

  it.each<TxPhase>(["rolling-back", "rollback-failed"])(
    "sends a phase=%s journal straight to do_rollback, guard-exempt and without consulting the guard (:1933-1938)",
    (phase) => {
      const { terminal, probe } = run({ journal: txn(phase), rollback: { exitCode: 2, guardSessions: false } })

      expect(terminal).toEqual({ kind: "rollback-failed" })
      // forwardRestartRan true is the exemption: a prior run already began
      // interrupting service, so blocking recovery would strand a broken build.
      expect(probe.rollbackCalls).toEqual([{ ref: REF, prev: PREV, forwardRestartRan: true }])
      // do_rollback never returns to the forward flow.
      expect(probe.trace).not.toContain("guard")
      expect(probe.applyRefCalls).toEqual([])
      expect(probe.readinessCalls).toEqual([])
    },
  )

  it.each<TxPhase>(["prepared", "checkout", "applied", "restarting", "verifying", "forward-failed"])(
    "resumes the forward flow from phase=%s (:1946-1951)",
    (phase) => {
      const { terminal, probe } = run({ journal: txn(phase) })
      expect(terminal).toEqual({ kind: "updated" })
      expect(probe.rollbackCalls).toEqual([])
      expect(probe.applyRefCalls).toEqual([{ target: REF, prevLockHash: PREV_LOCK, trackApply: true }])
    },
  )

  it("re-tests the journal at both of bash's `[[ -f ]]` sites (:1890, :1923)", () => {
    // Not a cached boolean: bash stats twice, and the corrupt-journal scenario
    // "a journal removed between the exists test and the load" depends on the
    // second read being a real one.
    const { probe } = run({ restartOnly: true, journal: txn("verifying") })
    expect(probe.journalExistsCalls).toBe(2)
  })
})

describe("runUpdateFlowSync: restart-only, and the :1889-1913 fallthrough", () => {
  it("runs rung 1 and returns its terminal when no transaction is pending (:1892-1912)", () => {
    const { terminal, probe } = run({ restartOnly: true, journal: null })

    expect(terminal).toEqual({ kind: "restart-only-ok" })
    expect(probe.info).toEqual([`restart-only: ${SERVICE} healthy at ${NEW_HEAD.slice(0, 12)}`])
    // Rung 1 is journal-free by construction: its options type carries no
    // journal seam at all.
    expect(probe.writes).toEqual([])
    expect(probe.cleared).toBe(0)
    expect(probe.applyRefCalls).toEqual([])
    // The second `[[ -f ]]` at :1923 is never reached, because bash exits
    // inside the `else`.
    expect(probe.journalExistsCalls).toBe(1)
  })

  it("returns rung 1's failure terminals rather than escalating (:1896, :1910)", () => {
    const errored = run({ restartOnly: true, journal: null, restarts: [{ code: 1, step: "start" }] })
    expect(errored.terminal).toEqual({ kind: "restart-only-restart-failed" })
    expect(errored.probe.warn).toEqual(["restart-only: restart errored (checkout untouched; no rollback)"])

    const unready = run({ restartOnly: true, journal: null, readiness: NOT_READY })
    expect(unready.terminal).toEqual({ kind: "restart-only-readiness-failed" })
    expect(unready.probe.warn).toEqual([
      "readiness gave up after 007s: /healthz did not return 200 on :4753",
      "restart-only: readiness failed after plain restart (checkout untouched; no rollback)",
    ])

    const deferred = run({ restartOnly: true, journal: null, restarts: [RESTART_DEFER] })
    // Exit 3, and bash's `exit 3` at :1895 is BARE: rung 1 says nothing here,
    // because the guard already spoke from inside restart_service.
    expect(deferred.terminal).toEqual({ kind: "deferred", site: "restart-only" })
    expect(deferred.probe.warn).toEqual([])
  })

  it("abandons rung 1 for full recovery when a transaction is pending, and can exit 0 (:1889-1891)", () => {
    // NON-NEGOTIABLE ROW 1: a `--restart-only` invocation completing a pending
    // phase=verifying transaction normally. A port that models rung 1 as a
    // sibling state machine returns `restart-only-ok` here and clears nothing.
    const { terminal, probe } = run({ restartOnly: true, journal: txn("verifying") })

    expect(terminal).toEqual({ kind: "updated" })
    expect(probe.warn[0]).toBe(
      "restart-only requested but an update transaction is pending; running normal recovery instead",
    )
    expect(probe.applyRefCalls).toEqual([{ target: REF, prevLockHash: PREV_LOCK, trackApply: true }])
    expect(probe.cleared).toBe(1)
  })

  it("can reach do_rollback, and therefore exit 1 or 2, from a --restart-only invocation (:1889-1913)", () => {
    // NON-NEGOTIABLE ROW 2: the same fallthrough failing readiness. `RESTART_ONLY`
    // is never re-read after :1889, so rung 1's exit set is {0,1,2,3,4}.
    const rolledBack = run({ restartOnly: true, journal: txn("verifying"), readiness: NOT_READY })
    expect(rolledBack.terminal).toEqual({ kind: "rolled-back" })
    expect(rolledBack.probe.failForwardCalls[0]?.reason).toBe("failed readiness")

    const critical = run({
      restartOnly: true,
      journal: txn("rolling-back"),
      rollback: { exitCode: 2, guardSessions: false },
    })
    expect(critical.terminal).toEqual({ kind: "rollback-failed" })
  })
})

describe("runUpdateFlowSync: the journal disposition table is descriptive of this flow", () => {
  /**
   * Every terminal this flow settles the journal for ITSELF, with the scenario
   * that produces it and whether a journal was on disk when the run started.
   * The four `rollback.ts` owns are excluded by name in this file's header.
   */
  const rows: ReadonlyArray<{ name: string; scenario: Scenario; journalOnEntry: boolean }> = [
    { name: "updated", scenario: {}, journalOnEntry: false },
    { name: "deferred/fresh-run", scenario: { guards: [DEFERRED] }, journalOnEntry: false },
    {
      name: "preflight-refused",
      scenario: { freshRun: () => ({ ok: false, message: "fetch failed before update; checkout unchanged" }) },
      journalOnEntry: false,
    },
    { name: "corrupt-journal", scenario: { journal: "corrupt" }, journalOnEntry: true },
    {
      name: "deferred/recovery-resume",
      scenario: { journal: txn("restarting"), guards: [DEFERRED] },
      journalOnEntry: true,
    },
    { name: "deferred/mid-transaction", scenario: { restarts: [RESTART_DEFER] }, journalOnEntry: false },
    { name: "restart-only-ok", scenario: { restartOnly: true, journal: null }, journalOnEntry: false },
    {
      name: "restart-only-restart-failed",
      scenario: { restartOnly: true, journal: null, restarts: [{ code: 1, step: "stop" }] },
      journalOnEntry: false,
    },
    {
      name: "restart-only-readiness-failed",
      scenario: { restartOnly: true, journal: null, readiness: NOT_READY },
      journalOnEntry: false,
    },
    { name: "deferred/restart-only", scenario: { restartOnly: true, journal: null, restarts: [RESTART_DEFER] }, journalOnEntry: false },
  ]

  it.each(rows)("$name leaves the journal where terminals.ts says it does", ({ scenario, journalOnEntry }) => {
    const { terminal, probe } = run(scenario)
    const disposition = journalDispositionFor(terminal)

    if (disposition === "cleared") {
      expect(probe.cleared).toBe(1)
      return
    }
    // Neither of the other two dispositions may destroy a pending transaction:
    // that is the whole reason exit 2 and exit 3 are excluded from "cleared".
    expect(probe.cleared).toBe(0)
    if (disposition === "untouched") {
      // Nothing was written AND nothing was there to begin with, so no state
      // is left for a later run to trip over.
      expect(probe.writes).toEqual([])
      expect(journalOnEntry).toBe(false)
    } else {
      // "retained": a resumable transaction survives, whether this run wrote
      // the phase or merely left the one it found.
      expect(journalOnEntry || probe.writes.length > 0).toBe(true)
    }
  })
})
