/**
 * `flow-lines.ts` as DOCUMENTATION. This file proves nothing about fidelity to
 * bash and is not meant to.
 *
 * Say it plainly, because a reader will otherwise assume otherwise: asserting
 * a hand-transcribed constant against a second hand-transcribed constant
 * checks only that the same person typed the same thing twice. If a byte was
 * dropped while porting `scripts/luna-update-server`, it is dropped in both
 * places and every assertion below still passes. THE PROOF IS THE DUAL-DRIVE
 * BYTE DIFF in `update-flow-parity.test.ts`, where the bash and the TypeScript
 * run the same scenario over the same fixture and their stdout and stderr are
 * compared byte for byte.
 *
 * What this file IS worth: it makes each string readable in one place next to
 * its bash line number, and it pins the three structural properties that ARE
 * decisions rather than transcriptions, each of which a well-meaning edit
 * would otherwise break silently -
 *
 *   1. every builder returns a PAYLOAD, never a prefixed line, because
 *      `wiring.ts` owns the `-> ` / `warning: ` / `error: ` prefixes;
 *   2. the em dash appears in exactly the ported strings and nowhere else, so
 *      "fixing" one to match house style fails here rather than in an
 *      operator's log grep during an incident;
 *   3. the two sha abbreviations are DIFFERENT widths - 9 in the recovery line
 *      (:1932), 12 in the restart-only health line (:1907) - which reads like
 *      a typo and is not one.
 *
 * Pure: no filesystem, no spawn, no platform assumptions. Runs anywhere.
 */
import { describe, expect, it } from "vitest"
import * as lines from "../../src/update/flow-lines.js"

/**
 * The em dash the ports carry, written as an escape so that this file's own
 * source contains zero literal U+2014 and a house-style grep over new prose
 * stays clean. `flow-lines.ts` is the only file in the pair allowed a literal
 * one, and only inside a ported string.
 */
const EM_DASH = "\u2014"

/**
 * Render every export to a string so the structural tests can sweep the whole
 * module: constants pass through, builders are called with as many placeholder
 * arguments as they declare.
 */
const renderAll = (): ReadonlyArray<readonly [string, string]> =>
  Object.entries(lines).map(([name, value]) => {
    if (typeof value === "string") return [name, value] as const
    const args = Array.from({ length: value.length }, (_, i) => `<arg${i}>`)
    return [name, (value as (...a: ReadonlyArray<string>) => string)(...args)] as const
  })

describe("recovery of an interrupted transaction", () => {
  it("recoveringLine abbreviates both shas to 9 (:1932)", () => {
    expect(lines.recoveringLine("restarting", "0123456789abcdef", "fedcba9876543210")).toBe(
      `RECOVERING interrupted update phase=restarting prev=012345678 target=fedcba987`,
    )
  })

  it("corruptJournalLine carries no prefix and no trailing newline (:1925)", () => {
    expect(lines.corruptJournalLine("/var/lib/luna/update.journal")).toBe(
      `CRITICAL: corrupt update transaction journal /var/lib/luna/update.journal ${EM_DASH} refusing to mutate the checkout; inspect or remove it manually.`,
    )
    expect(lines.corruptJournalLine("/x").endsWith("\n")).toBe(false)
  })

  it("deferredRecoveryResumeLine names the retained phase (:1949)", () => {
    expect(lines.deferredRecoveryResumeLine("checkout")).toBe(
      `DEFERRED by session guard; transaction journal retained (phase=checkout) ${EM_DASH} resumes when sessions end`,
    )
  })
})

describe("the fresh-run path", () => {
  it("deferredFreshRunLine (:1999)", () => {
    expect(lines.deferredFreshRunLine).toBe("DEFERRED by session guard; nothing mutated (retry next tick)")
  })

  it("deferredMidTransactionLine hardcodes phase=restarting (:2058)", () => {
    expect(lines.deferredMidTransactionLine).toBe(
      `DEFERRED by session guard mid-transaction; journal retained (phase=restarting) ${EM_DASH} resumes next tick`,
    )
  })

  it("currentHeadLine (:1967) and checkedOutLine (:2041)", () => {
    expect(lines.currentHeadLine("abc1234")).toBe("Current HEAD: abc1234")
    expect(lines.checkedOutLine("def5678")).toBe("Checked out: def5678")
  })

  it("updatedLine (:2074)", () => {
    expect(lines.updatedLine("abc1234", "def5678", "luna-server")).toBe(
      "updated abc1234 -> def5678 (luna-server healthy)",
    )
  })

  it("the three luna_die messages (:1965, :1974, :1994)", () => {
    expect(lines.readHeadFailedMessage("/srv/luna")).toBe("could not read current HEAD in /srv/luna")
    expect(lines.fetchFailedMessage).toBe("fetch failed before update; checkout unchanged")
    expect(lines.refUnresolvedMessage("origin/nope")).toBe("could not resolve target ref origin/nope")
  })
})

describe("the restart-only path", () => {
  it("restartOnlyJournalPendingLine (:1891)", () => {
    expect(lines.restartOnlyJournalPendingLine).toBe(
      "restart-only requested but an update transaction is pending; running normal recovery instead",
    )
  })

  it("restartOnlyRestartErroredLine (:1896)", () => {
    expect(lines.restartOnlyRestartErroredLine).toBe(
      "restart-only: restart errored (checkout untouched; no rollback)",
    )
  })

  it("restartOnlyHealthyLine abbreviates the sha to 12, not 9 (:1907)", () => {
    expect(lines.restartOnlyHealthyLine("luna-server", "0123456789abcdef0123456789abcdef01234567")).toBe(
      "restart-only: luna-server healthy at 0123456789ab",
    )
  })

  it("restartOnlyReadinessFailedLine (:1910)", () => {
    expect(lines.restartOnlyReadinessFailedLine).toBe(
      "restart-only: readiness failed after plain restart (checkout untouched; no rollback)",
    )
  })
})

describe("apply_ref_inplace", () => {
  it("headPostconditionLine prints the head when it was readable (:1192)", () => {
    expect(lines.headPostconditionLine("aaaa111", "bbbb222")).toBe(
      `POSTCONDITION: git reset reported success but HEAD is 'aaaa111', expected bbbb222 ${EM_DASH} refusing to continue`,
    )
  })

  it("headPostconditionLine collapses null AND empty to 'unreadable', as bash's ${head_now:-unreadable} does", () => {
    const expected = `POSTCONDITION: git reset reported success but HEAD is 'unreadable', expected bbbb222 ${EM_DASH} refusing to continue`
    expect(lines.headPostconditionLine(null, "bbbb222")).toBe(expected)
    expect(lines.headPostconditionLine("", "bbbb222")).toBe(expected)
  })

  it("the lockfile gate, both ways, with an ASCII arrow (:1202, :1215)", () => {
    expect(lines.lockChangedLine).toBe("bun.lock changed -> bun install --frozen-lockfile")
    expect(lines.lockUnchangedLine).toBe("bun.lock unchanged -> skipping bun install")
    // Not an em dash: this one really is `->` in the bash.
    expect(lines.lockChangedLine).not.toContain(EM_DASH)
  })

  it("nodeModulesPostconditionLine takes the CONTAINER path (:1211)", () => {
    expect(lines.nodeModulesPostconditionLine("/root/luna")).toBe(
      "POSTCONDITION: bun install exited 0 but /root/luna/node_modules is missing",
    )
  })

  it("claudeDegradedLine, one constant for both arms (:1240, :1250)", () => {
    expect(lines.claudeDegradedLine).toBe(
      `POSTCONDITION degraded: no usable claude executable after re-pin ${EM_DASH} server will boot but cannot spawn claude`,
    )
  })
})

describe("the six restart.ts emits from inside its own ports", () => {
  it("settleInvalidLine quotes the offending value and names both flags (:1276)", () => {
    expect(lines.settleInvalidLine("not-a-number")).toBe(
      `RESTART_SETTLE_SECS='not-a-number' is not a non-negative number of seconds; SKIPPING the post-stop settle ${EM_DASH} the DuckDB/SQLite WAL/SHM race may recur. Set --restart-settle / LUNA_RESTART_SETTLE_SECS to a valid value (e.g. 6).`,
    )
  })

  it("settlingLine appends the unit to the number (:1279)", () => {
    expect(lines.settlingLine("6")).toBe(
      "settling 6s after stop so DuckDB/SQLite release WAL/SHM before start",
    )
  })

  it("settleSleepFailedLine (:1283)", () => {
    expect(lines.settleSleepFailedLine("6")).toBe(
      `post-stop settle sleep failed (RESTART_SETTLE_SECS='6'); proceeding to start WITHOUT a settle ${EM_DASH} the WAL/SHM race may recur.`,
    )
  })

  it("startLimitLatchedLine (:1375)", () => {
    expect(lines.startLimitLatchedLine("luna-server")).toBe(
      "sup_start: luna-server is start-limit latched failed; clearing with reset-failed and retrying once",
    )
  })

  it("mainPidInconclusiveLine (:1559)", () => {
    expect(lines.mainPidInconclusiveLine).toBe(
      `restart postcondition INCONCLUSIVE: post-restart MainPID unreadable (transport failure?); skipping the PID-change check ${EM_DASH} readiness still gates`,
    )
  })

  it("mainPidUnchangedLine (:1563)", () => {
    expect(lines.mainPidUnchangedLine("4242", "4242")).toBe(
      `POSTCONDITION: restart did not replace the server process (MainPID before=4242 after=4242) ${EM_DASH} the stop silently failed`,
    )
  })
})

describe("the post-deploy dream/wake seed", () => {
  it("seedStartLine (:1718) and seedOkLine (:1720)", () => {
    expect(lines.seedStartLine).toBe("post-deploy: seeding V2 dream/wake job rows (idempotent)")
    expect(lines.seedOkLine).toBe("post-deploy: dream/wake job rows ensured")
  })

  it("seedFailedLine hands the operator a runnable command (:1722)", () => {
    expect(lines.seedFailedLine("/usr/local/bin/bun", "scripts/seed.ts")).toBe(
      "post-deploy: dream/wake seed FAILED (non-fatal); if wake/dream go dark, run manually: /usr/local/bin/bun run scripts/seed.ts",
    )
  })
})

describe("structural properties, which are decisions rather than transcriptions", () => {
  it("no builder returns a prefixed line - wiring.ts owns the prefixes", () => {
    const prefixes = ["-> ", "warning: ", "error: "]
    for (const [name, rendered] of renderAll()) {
      const prefixed = prefixes.some((p) => rendered.startsWith(p))
      expect([name, prefixed]).toEqual([name, false])
    }
  })

  it("no builder returns a line with a trailing newline", () => {
    for (const [name, rendered] of renderAll()) {
      expect([name, rendered.endsWith("\n")]).toEqual([name, false])
    }
  })

  it("the em dash appears in exactly the ported strings that have one in bash", () => {
    const withEmDash = renderAll()
      .filter(([, rendered]) => rendered.includes(EM_DASH))
      .map(([name]) => name)
      .sort()
    // Each of these is a verbatim port of a bash string carrying U+2014.
    // Adding a name here without a bash line to point at is a house-style
    // violation; removing one is a silent change to what an operator greps.
    expect(withEmDash).toEqual([
      "claudeDegradedLine",
      "corruptJournalLine",
      "deferredMidTransactionLine",
      "deferredRecoveryResumeLine",
      "headPostconditionLine",
      "mainPidInconclusiveLine",
      "mainPidUnchangedLine",
      "settleInvalidLine",
      "settleSleepFailedLine",
    ])
  })

  it("every export is a string or a string builder, and none is empty", () => {
    for (const [name, rendered] of renderAll()) {
      expect([name, rendered.length > 0]).toEqual([name, true])
    }
  })
})
