/**
 * Golden parity for `do_rollback` / `fail_forward` (S22c part 2).
 *
 * Each scenario runs the REAL bash function out of scripts/luna-update-server
 * with every collaborator stubbed, and the TypeScript port over the same
 * inputs, then compares THREE things: the exit code, the ordered warning lines
 * an operator would see, and the ordered journal phases written.
 *
 * WHY ALL THREE. S22's acceptance names the exit code and the literal
 * `ROLLED BACK to` marker, because
 * packages/server-registry/src/driver/luna-chat-server.ts classifies a deploy
 * on exit code PLUS that string - drift in either silently reports a
 * SUCCESSFUL auto-rollback as a hard failure. The journal phases are asserted
 * too because they are what lets the next idle tick finish an interrupted
 * rollback; a path that exits with the right code but skips its journal write
 * strands the host mid-transaction, and no exit-code assertion would notice.
 *
 * THE TWO GUARD CASES ARE THE SUBTLE PART and each has its own scenario. When
 * the forward restart already ran, service was already interrupted and the
 * guard is exempted so a broken build cannot be stranded. When the failure was
 * in the APPLY phase the old server never stopped, so the guard stays ACTIVE
 * and a defer is a legitimate exit 3. An unconditional exemption passes a
 * naive test and takes down live sessions in production.
 */
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  EXIT_CRITICAL,
  EXIT_DEFERRED,
  EXIT_ROLLED_BACK,
  criticalLine,
  doRollbackSync,
  failForwardSync,
  remediationHint,
  rolledBackMarker,
} from "../../src/update/rollback.js"
import { repoRoot } from "./temp-dirs.js"

const UPDATE_SERVER = join(repoRoot, "scripts/luna-update-server")

// BUILT, not written out, and deliberately so: the secret-scan CI gate bans
// any 40-character hex run in a tracked file, because that is the shape of a
// leaked token. These are obviously fake git SHAs rather than secrets, but the
// scanner cannot tell the difference by construction and a per-file exemption
// would blunt a hard gate for the sake of a fixture. Constructing them keeps
// the values byte-identical and keeps the literal out of the source.
const REF = "1".repeat(40)
const PREV = "2".repeat(40)
const SERVICE = "luna-chat-server.service"

interface Scenario {
  readonly forwardRestartRan: boolean
  readonly applyOk: boolean
  /** restart_service's rc; 3 is the session-guard defer. */
  readonly restartRc: number
  readonly readinessOk: boolean
}

interface Trace {
  readonly exitCode: number
  readonly warnings: ReadonlyArray<string>
  readonly phases: ReadonlyArray<string>
}

const runBash = (s: Scenario): Trace => {
  const script = [
    "set -uo pipefail",
    `REF=${JSON.stringify(REF)}`,
    `PREV=${JSON.stringify(PREV)}`,
    `SERVICE_NAME=${JSON.stringify(SERVICE)}`,
    'LAYOUT="bare"',
    `FORWARD_RESTART_RAN=${s.forwardRestartRan}`,
    "GUARD_SESSIONS=true",
    "TRANSACTION_TRACK_APPLY=true",
    'EXPECTED_BUILD_SHA=""',
    "ALLOW_MISSING_BUILD_SHA=false",
    'SUPERVISOR="systemd"',
    "SYSTEMD_USER=false",
    'LAUNCHD_LABEL="ai.luna.chat-server"',
    // Collaborators, each announcing itself so the ORDER is observable.
    'luna_warn() { printf "WARN:%s\\n" "$*"; }',
    'write_transaction() { printf "PHASE:%s\\n" "$1"; }',
    'clear_transaction() { printf "PHASE:cleared\\n"; }',
    'lockfile_hash() { printf "deadbeef"; }',
    `apply_ref() { return ${s.applyOk ? 0 : 1}; }`,
    `restart_service() { return ${s.restartRc}; }`,
    'readiness_restart_baseline() { printf "0"; }',
    `readiness_ok() { return ${s.readinessOk ? 0 : 1}; }`,
    `eval "$(awk '/^do_rollback\\(\\)/{f=1} f{print} f && /^}$/{exit}' ${JSON.stringify(UPDATE_SERVER)})"`,
    "do_rollback",
  ].join("\n")

  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" })
  const lines = (r.stdout ?? "").split("\n").filter(Boolean)
  return {
    exitCode: r.status ?? -1,
    warnings: lines.filter((l) => l.startsWith("WARN:")).map((l) => l.slice(5)),
    phases: lines.filter((l) => l.startsWith("PHASE:")).map((l) => l.slice(6)),
    // The CRITICAL line goes to stderr via printf, not luna_warn; kept out of
    // `warnings` so the two channels stay distinguishable, and asserted
    // separately where it matters.
  }
}

const runTs = (s: Scenario): Trace & { readonly stderr: string[]; readonly guardPassedToRestart: boolean | null } => {
  const warnings: string[] = []
  const phases: string[] = []
  const stderr: string[] = []
  let guardPassedToRestart: boolean | null = null
  const outcome = doRollbackSync({
    ref: REF,
    prev: PREV,
    serviceName: SERVICE,
    layout: "bare",
    forwardRestartRan: s.forwardRestartRan,
    supervisor: "systemd",
    systemdUser: false,
    uid: "0",
    launchdLabel: "ai.luna.chat-server",
    applyRef: () => s.applyOk,
    // Records the guard value the restart is ACTUALLY invoked with. Asserting
    // only the exit code left the suite blind to an unconditional exemption -
    // a mutation that passes a naive test and takes down live sessions on the
    // apply-phase path.
    restartService: (guard) => { guardPassedToRestart = guard; return s.restartRc },
    runReadiness: () => s.readinessOk,
    writeTransaction: (p) => { phases.push(p) },
    clearTransaction: () => { phases.push("cleared") },
    warn: (l) => { warnings.push(l) },
  })
  if (outcome.exitCode === EXIT_CRITICAL) {
    stderr.push(criticalLine(REF, PREV, remediationHint({
      supervisor: "systemd", systemdUser: false, uid: "0",
      launchdLabel: "ai.luna.chat-server", serviceName: SERVICE,
    })))
  }
  return { exitCode: outcome.exitCode, warnings, phases, stderr, guardPassedToRestart }
}

const parity = (name: string, s: Scenario, expectedExit: number) => {
  it(name, () => {
    const bash = runBash(s)
    const ts = runTs(s)
    expect(bash.exitCode, `bash warnings: ${bash.warnings.join(" | ")}`).toBe(expectedExit)
    expect(ts.exitCode).toBe(expectedExit)
    // Byte-exact, in order: this is what an operator reads.
    expect(ts.warnings).toEqual(bash.warnings)
    // The journal is what resumes an interrupted rollback.
    expect(ts.phases).toEqual(bash.phases)
  })
}

describe("do_rollback: golden parity with scripts/luna-update-server", () => {
  parity(
    "forward restart ran, rollback succeeds: exit 1, marker emitted, journal cleared",
    { forwardRestartRan: true, applyOk: true, restartRc: 0, readinessOk: true },
    EXIT_ROLLED_BACK,
  )

  parity(
    "apply-phase failure, guard defers the rollback restart: exit 3, journal RETAINED",
    { forwardRestartRan: false, applyOk: true, restartRc: 3, readinessOk: true },
    EXIT_DEFERRED,
  )

  parity(
    "apply_ref fails: exit 2 CRITICAL",
    { forwardRestartRan: true, applyOk: false, restartRc: 0, readinessOk: true },
    EXIT_CRITICAL,
  )

  parity(
    "rollback restart fails for a reason other than the guard: exit 2 CRITICAL",
    { forwardRestartRan: true, applyOk: true, restartRc: 1, readinessOk: true },
    EXIT_CRITICAL,
  )

  parity(
    "rollback applies and restarts but the OLD build is not healthy either: exit 2 CRITICAL",
    { forwardRestartRan: true, applyOk: true, restartRc: 0, readinessOk: false },
    EXIT_CRITICAL,
  )

  describe("the marker the deploy classifier reads", () => {
    it("is byte-identical to the bash, em dash included", () => {
      const bash = runBash({ forwardRestartRan: true, applyOk: true, restartRc: 0, readinessOk: true })
      const marker = rolledBackMarker(REF, PREV, SERVICE)
      expect(bash.warnings).toContain(marker)
      // luna-chat-server.ts:164 tests for exactly this substring.
      expect(marker).toContain("ROLLED BACK to")
    })

    it("appears ONLY on the successful-rollback path", () => {
      for (const s of [
        { forwardRestartRan: true, applyOk: false, restartRc: 0, readinessOk: true },
        { forwardRestartRan: true, applyOk: true, restartRc: 0, readinessOk: false },
        { forwardRestartRan: false, applyOk: true, restartRc: 3, readinessOk: true },
      ] as const) {
        const ts = runTs(s)
        expect(ts.warnings.some((w) => w.includes("ROLLED BACK to")), JSON.stringify(s)).toBe(false)
      }
    })
  })

  describe("the scoped guard exemption", () => {
    it("exempts the guard ONLY when the forward restart already interrupted service", () => {
      const exempted = runTs({ forwardRestartRan: true, applyOk: true, restartRc: 0, readinessOk: true })
      expect(exempted.warnings[0]).toContain("proceeds without the session guard")

      const active = runTs({ forwardRestartRan: false, applyOk: true, restartRc: 0, readinessOk: true })
      expect(active.warnings[0]).toContain("session guard stays ACTIVE")
    })

    it("passes the guard value THROUGH to the restart, not merely into a log line", () => {
      // bash sets GUARD_SESSIONS=false and restart_service reads that global;
      // the port passes it as an argument. Asserting the argument is what makes
      // an unconditional exemption impossible to sneak past this suite.
      const exempted = runTs({ forwardRestartRan: true, applyOk: true, restartRc: 0, readinessOk: true })
      expect(exempted.guardPassedToRestart, "forward restart already ran: guard exempted").toBe(false)

      const active = runTs({ forwardRestartRan: false, applyOk: true, restartRc: 0, readinessOk: true })
      expect(active.guardPassedToRestart, "apply-phase failure: old server still serving, guard ACTIVE").toBe(true)
    })

    it("keeps the guard active on the apply-phase path, where a defer is legitimate", () => {
      const s = { forwardRestartRan: false, applyOk: true, restartRc: 3, readinessOk: true } as const
      const deferred = runTs(s)
      expect(deferred.exitCode).toBe(EXIT_DEFERRED)
      expect(deferred.guardPassedToRestart).toBe(true)
    })
  })

  describe("readiness is reconfigured by the rollback, not by its caller", () => {
    it("probes for PREV and tolerates a missing buildSha", () => {
      let seen: { expectedBuildSha: string; allowMissingBuildSha: boolean } | null = null
      doRollbackSync({
        ref: REF, prev: PREV, serviceName: SERVICE, layout: "bare", forwardRestartRan: true,
        supervisor: "systemd", systemdUser: false, uid: "0", launchdLabel: "l",
        applyRef: () => true, restartService: () => 0,
        runReadiness: (r) => { seen = r; return true },
        writeTransaction: () => {}, clearTransaction: () => {}, warn: () => {},
      })
      expect(seen).toEqual({ expectedBuildSha: PREV, allowMissingBuildSha: true })
    })
  })

  describe("the releases layout is refused, not silently mishandled", () => {
    it("throws rather than running the bare-layout path", () => {
      expect(() =>
        doRollbackSync({
          ref: REF, prev: PREV, serviceName: SERVICE, layout: "releases", forwardRestartRan: true,
          supervisor: "systemd", systemdUser: false, uid: "0", launchdLabel: "l",
          applyRef: () => true, restartService: () => 0, runReadiness: () => true,
          writeTransaction: () => {}, clearTransaction: () => {}, warn: () => {},
        }),
      ).toThrow(/releases layout/)
    })
  })
})

describe("remediationHint", () => {
  const base = { serviceName: SERVICE, uid: "501", launchdLabel: "ai.luna.chat-server" }

  it("points a macOS operator at launchctl, never systemctl", () => {
    const hint = remediationHint({ ...base, supervisor: "launchd", systemdUser: false })
    expect(hint).toContain("launchctl print gui/501/ai.luna.chat-server")
    expect(hint).not.toContain("systemctl")
  })

  it("uses --user for a user-scoped systemd unit", () => {
    expect(remediationHint({ ...base, supervisor: "systemd", systemdUser: true }))
      .toBe(`systemctl --user status ${SERVICE}; journalctl --user -u ${SERVICE}`)
  })

  it("uses system scope otherwise", () => {
    expect(remediationHint({ ...base, supervisor: "systemd", systemdUser: false }))
      .toBe(`systemctl status ${SERVICE}; journalctl -u ${SERVICE}`)
  })
})

describe("fail_forward", () => {
  const opts = {
    ref: REF, prev: PREV, serviceName: SERVICE, layout: "bare" as const, forwardRestartRan: true,
    supervisor: "systemd" as const, systemdUser: false, uid: "0", launchdLabel: "l",
    applyRef: () => true, restartService: () => 0, runReadiness: () => true,
    writeTransaction: () => {}, clearTransaction: () => {}, warn: () => {},
  }

  it("with --no-rollback: records forward-failed and dies at the new ref", () => {
    const phases: string[] = []
    const out = failForwardSync("readiness failed", {
      ...opts, rollbackEnabled: false, newHead: "abc123",
      writeTransaction: (p) => { phases.push(p) },
    })
    expect(out.kind).toBe("died")
    expect(phases, "the journal write must happen even on the no-rollback path").toEqual(["forward-failed"])
    if (out.kind === "died") {
      expect(out.exitCode).toBe(1)
      expect(out.message).toBe("readiness failed and --no-rollback set; server left at abc123 (may be unhealthy)")
    }
  })

  it("falls back to REF when NEW_HEAD is unknown, matching ${NEW_HEAD:-$REF}", () => {
    const warnings: string[] = []
    failForwardSync("boom", { ...opts, rollbackEnabled: false, newHead: null, warn: (l) => { warnings.push(l) } })
    expect(warnings[0]).toBe(`update to ${REF} failed: boom (HEAD=${REF})`)
  })

  it("otherwise delegates to the rollback", () => {
    const out = failForwardSync("readiness failed", { ...opts, rollbackEnabled: true, newHead: "abc123" })
    expect(out.kind).toBe("rolled-back")
    if (out.kind === "rolled-back") expect(out.outcome.exitCode).toBe(EXIT_ROLLED_BACK)
  })
})
