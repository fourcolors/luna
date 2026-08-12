/**
 * `session-guard.ts`'s `guardVerdictLine` over EVERY member of the
 * `GuardVerdict` union.
 *
 * WHY THIS FUNCTION EXISTS AT ALL. `restart_session_guard` emits five
 * `luna_warn` lines from inside itself (scripts/luna-update-server:1468, :1477,
 * :1491, :1494, :1497) and passes through in silence on four other arms (:1462,
 * :1463, :1466, :1480). Before this builder the port returned a typed verdict
 * and said nothing, so a deferred deploy told an operator nothing at all where
 * bash named the reason. `restart.ts` emits the result at bash's own position,
 * `restart_service`'s first statement (:1509).
 *
 * WHY IT LIVES IN `session-guard.ts` AND NOT IN `flow-lines.ts`. Only the module
 * that declares `GuardVerdict` can map it EXHAUSTIVELY. The last test in this
 * file is the point: a new verdict arm must be a compile error, not a silent
 * `null` that makes the port quietly stop speaking on a path bash speaks on.
 *
 * THE EXPECTATIONS ARE READ OUT OF THE BASH (`bash-source-oracle.ts`), not
 * transcribed, so a wording change in `scripts/luna-update-server` fails here
 * rather than passing against a copy of the old wording. It also keeps U+2014
 * out of this file, which house style bans in new prose and three of these
 * lines carry.
 *
 * PURE: one `readFileSync` of a repo file, no spawn, no temp dir, no platform
 * assumption.
 */
import { describe, expect, it } from "vitest"
import { type GuardVerdict, guardVerdictLine, operatorOverrideLogLine } from "../../src/update/session-guard.js"
import { bashLogLine } from "./bash-source-oracle.js"

/** An operator's raw `--readiness-port` spelling; the guard interpolates it verbatim into the line, as bash interpolates `$READINESS_PORT`. */
const PORT = "04753"

describe("the four silent arms", () => {
  /**
   * Each of these is a bare `return 0`/`return` in bash with no luna_warn:
   * :1462 dry-run, :1463 guard-disabled, :1466 non-systemd-supervisor and
   * :1480 zero-sessions. `null` is how this builder spells "bash says nothing
   * here", and it must never become an empty string, which would print a bare
   * `warning: ` line the bash engine never emits.
   */
  const silent: ReadonlyArray<GuardVerdict> = [
    { permitted: true, reason: "dry-run" },
    { permitted: true, reason: "guard-disabled" },
    { permitted: true, reason: "non-systemd-supervisor" },
    { permitted: true, reason: "zero-sessions", sessionCount: 0 },
  ]

  for (const verdict of silent) {
    it(`${verdict.reason} returns null, not a line`, () => {
      expect(guardVerdictLine(verdict, PORT)).toBeNull()
    })
  }
})

describe("the five lines bash actually prints", () => {
  it("operator-override (:1468) reuses the auditLine already minted onto the verdict", () => {
    const reason = "incident 42: paging is down"
    const verdict: GuardVerdict = {
      permitted: true,
      reason: "operator-override",
      auditLine: operatorOverrideLogLine(reason),
    }
    expect(guardVerdictLine(verdict, PORT)).toBe(
      bashLogLine({
        line: 1468,
        fn: "luna_warn",
        anchor: "SESSION GUARD OVERRIDDEN by operator",
        vars: { OPERATOR_OVERRIDE_REASON: reason },
      }),
    )
  })

  it("live-sessions (:1477) carries the count and the RAW port spelling", () => {
    expect(guardVerdictLine({ permitted: false, reason: "live-sessions", sessionCount: 3 }, PORT)).toBe(
      bashLogLine({
        line: 1477,
        fn: "luna_warn",
        anchor: "active session(s) on",
        vars: { n: "3", READINESS_PORT: PORT },
      }),
    )
  })

  it("dead-server-exception (:1491) quotes the unit state, and is the only line on a PERMITTED arm", () => {
    const verdict: GuardVerdict = { permitted: true, reason: "dead-server-exception", unitState: "inactive" }
    expect(guardVerdictLine(verdict, PORT)).toBe(
      bashLogLine({
        line: 1491,
        fn: "luna_warn",
        anchor: "no server process; restart permitted",
        vars: { state: "inactive" },
      }),
    )
  })

  it("transport-unreachable (:1494) interpolates nothing at all", () => {
    expect(guardVerdictLine({ permitted: false, reason: "transport-unreachable", unitState: "" }, PORT)).toBe(
      bashLogLine({ line: 1494, fn: "luna_warn", anchor: "transport never reached systemd" }),
    )
  })

  it("unit-state-uncertain (:1497) quotes the state that made it fail closed", () => {
    expect(guardVerdictLine({ permitted: false, reason: "unit-state-uncertain", unitState: "activating" }, PORT)).toBe(
      bashLogLine({
        line: 1497,
        fn: "luna_warn",
        anchor: "may be serving; deferring",
        vars: { state: "activating" },
      }),
    )
  })
})

describe("structural properties", () => {
  it("no line carries a prefix - restart.ts's caller owns the `warning: `", () => {
    const all: ReadonlyArray<GuardVerdict> = [
      { permitted: true, reason: "operator-override", auditLine: operatorOverrideLogLine("r") },
      { permitted: false, reason: "live-sessions", sessionCount: 1 },
      { permitted: true, reason: "dead-server-exception", unitState: "failed" },
      { permitted: false, reason: "transport-unreachable", unitState: "" },
      { permitted: false, reason: "unit-state-uncertain", unitState: "activating" },
    ]
    for (const verdict of all) {
      const line = guardVerdictLine(verdict, PORT)
      expect([verdict.reason, line?.startsWith("warning: ")]).toEqual([verdict.reason, false])
      expect([verdict.reason, line?.endsWith("\n")]).toEqual([verdict.reason, false])
    }
  })

  it("an absent sessionCount/unitState renders as bash's EMPTY expansion, never the word 'undefined'", () => {
    // Both fields are optional on the union because most arms have no such
    // value, and the one constructor in session-guard.ts always sets them on
    // these arms. If one were ever missing, bash's own `$n`/`$state` expansion
    // of an unset variable is the empty string - and "undefined" is a token no
    // bash line can produce and no operator grep would match.
    const live = guardVerdictLine({ permitted: false, reason: "live-sessions" }, PORT)
    const uncertain = guardVerdictLine({ permitted: false, reason: "unit-state-uncertain" }, PORT)
    expect(live).not.toContain("undefined")
    expect(uncertain).not.toContain("undefined")
    expect(live).toBe(
      bashLogLine({
        line: 1477,
        fn: "luna_warn",
        anchor: "active session(s) on",
        vars: { n: "", READINESS_PORT: PORT },
      }),
    )
  })

  it("a NEW verdict arm is a COMPILE error here, not a silent null", () => {
    // This is the whole reason the builder lives beside the union. The `never`
    // assignment below is the same one guardVerdictLine's own default arm
    // makes: adding a member to GuardPermittedReason/GuardDeferredReason
    // without adding a case makes both fail to typecheck, and `tsc` over
    // apps/deploy-cli covers test files too.
    const exhaustive = (verdict: GuardVerdict): string => {
      switch (verdict.reason) {
        case "dry-run":
        case "guard-disabled":
        case "non-systemd-supervisor":
        case "zero-sessions":
        case "operator-override":
        case "live-sessions":
        case "dead-server-exception":
        case "transport-unreachable":
        case "unit-state-uncertain":
          return verdict.reason
        default: {
          const unhandled: never = verdict
          return unhandled
        }
      }
    }
    expect(exhaustive({ permitted: true, reason: "dry-run" })).toBe("dry-run")
  })
})
