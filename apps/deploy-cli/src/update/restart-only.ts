/**
 * Repair-ladder rung 1: `--restart-only` (scripts/luna-update-server:1883-1913).
 *
 * A plain guarded stop -> settle -> start plus a readiness probe. No journal
 * write, no git mutation, no `bun install`, no rollback. It is the rung
 * unattended automation drives most often (`scripts/luna-autodeploy:619-623`
 * is its only consumer that distinguishes exit 3 from exit 4), so it is also
 * the rung whose failure modes an operator sees most often.
 *
 * WHY IT IS ITS OWN MODULE, AND WHAT THAT BUYS. `RestartOnlyOptions` below
 * carries NO journal seam of any kind: not `writeTransaction`, not
 * `clearTransaction`, not `journalExists`. "Rung 1 never writes a transaction"
 * is therefore unrepresentable rather than merely reviewed - there is no
 * function in scope that could write one. The price is that bash's
 * journal-pending FALLTHROUGH at :1889-1892 is not expressed here: bash tests
 * `-f "$UPDATE_JOURNAL"` inline and, when a transaction IS pending, warns and
 * falls through into the normal recovery flow with `RESTART_ONLY` still true
 * and never re-read (so such a run can reach `do_rollback`, can print
 * `ROLLED BACK to`, and can exit 2). That precedence lives in the caller,
 * which invokes this module ONLY when the journal is absent. The two
 * journal-precedence rows of the parity gate exist to prove the caller kept
 * it; if they cannot be made to pass, this factoring is what changes.
 *
 * THIS MODULE PRINTS FOUR-AND-A-HALF LINES AND NOT ONE MORE. The restart
 * primitive emits ELEVEN operator-facing lines of its own - the five session
 * guard lines (:1468, :1477, :1491, :1494, :1497, all fired from
 * `restart_service`'s first statement at :1509), the three settle lines
 * (:1276, :1279, :1283), `sup_start`'s start-limit warn (:1375) and the two
 * MainPID warns (:1559, :1563) - and bash emits every one of them from INSIDE
 * `restart_service`/`sup_start`, which has three in-scope callers (:1894 here,
 * :2056 the forward restart, :1824 the rollback restart). So `restart.ts`
 * owns them for all three callers and this module deliberately re-emits NONE
 * of them. A copy here would be one of three copies, would drift, and could
 * not reproduce bash's ORDER: those lines are interleaved with the restart
 * steps, not appended after the primitive returns. The consequence to hold on
 * to is that they still appear on THIS rung - `--restart-only` against a unit
 * whose stop silently failed prints the :1563 POSTCONDITION warn and then the
 * :1896 restart-errored warn, in that order - and `restart-only.test.ts`
 * pins exactly that by composing the real `restartServiceSync` into the
 * `restart` seam rather than by asserting on a stub.
 *
 * THE READINESS SEAM MUST NOT PRINT ITS OWN GIVE-UP LINE. Bash emits
 * `readiness gave up after ${READINESS_TIMEOUT}s: ${READINESS_DETAIL}` from
 * inside `readiness_ok` (:1124), so it fires at every call site; in the port
 * that line is emitted HERE, from the failure branch below, because
 * `readinessOkSync` returns a typed result and writes nothing. A caller that
 * binds `readiness` to a closure which ALSO emits the give-up line would
 * print it twice. The rollback path's closure in `wiring.ts` does emit it,
 * because nothing downstream of `rollback.ts:125`'s bare-boolean seam can;
 * the closure bound here must not.
 *
 * IMPORTS: types and strings only. No node builtins, no IO, no clock, no
 * `process.exit`. Every effect arrives through `RestartOnlyOptions`.
 */
import {
  restartOnlyHealthyLine,
  restartOnlyReadinessFailedLine,
  restartOnlyRestartErroredLine,
} from "./flow-lines.js"
import { type ReadinessResult, readinessGaveUpLine } from "./readiness.js"
import type { RestartOutcome } from "./restart.js"
import type { Terminal } from "./terminals.js"

export interface RestartOnlyOptions {
  readonly serviceName: string
  /**
   * `restart_service` (:1894). Bind this to `restartServiceSync` with its own
   * `warn`/`info` seams pointed at the same sinks as the two below, so the
   * eleven lines that primitive owns land in the operator's stream on this
   * rung too - see this module's header.
   */
  readonly restart: () => RestartOutcome
  /**
   * `readiness_restart_baseline` (:1897, ported by
   * `readinessRestartBaseline`). Sampled AFTER the restart was issued, which
   * is what makes rung 2 of the readiness ladder meaningful: the number to
   * beat is the restart count this restart itself produced, not zero.
   */
  readonly readinessBaseline: () => number
  /**
   * `readiness_ok "$RESTART_BASELINE"` (:1906). Must NOT emit the give-up
   * line itself - see this module's header.
   */
  readonly readiness: (req: {
    readonly expectedBuildSha: string
    readonly allowMissingBuildSha: boolean
    readonly baseline: number
  }) => ReadinessResult
  /** `git_target_capture rev-parse HEAD` (:1904), the inplace arm only. */
  readonly readHead: () => string
  /**
   * `READINESS_TIMEOUT` AS THE OPERATOR WROTE IT, for the give-up line's
   * interpolation - `--readiness-timeout 007` must print `007` while still
   * counting seven seconds, so this is threaded as a string beside the parsed
   * number rather than re-derived from it (which cannot be done).
   */
  readonly readinessTimeoutRaw: string
  /** `luna_info` PAYLOAD, no `-> ` prefix; the caller owns the prefix. */
  readonly info: (line: string) => void
  /** `luna_warn` PAYLOAD, no `warning: ` prefix; the caller owns the prefix. */
  readonly warn: (line: string) => void
}

/**
 * A one-arm union on purpose. Every path through rung 1 ends the process, so
 * there is nothing else this can return today; keeping it a union means the
 * day a path stops being terminal (the journal fallthrough being folded in
 * here, say) the caller gets a compile error instead of a silently ignored
 * new shape.
 */
export type RestartOnlyOutcome = { readonly kind: "terminal"; readonly terminal: Terminal }

const terminal = (t: Terminal): RestartOnlyOutcome => ({ kind: "terminal", terminal: t })

/**
 * Behavioral port of the `--restart-only` block at :1893-1912, in bash's own
 * order. The three orderings below are contracts, not incidental:
 *
 *  - the restart happens FIRST, and a guard deferral (code 3) leaves through
 *    a BARE exit 3 (:1895) with no line from here at all: the guard's own
 *    `luna_warn` already fired from inside `restart_service`, and a second
 *    line here would be a line bash does not print. Exit 3 must never
 *    collapse into the lock's exit 4 - `terminals.ts`'s header records the
 *    incident that rule exists to prevent.
 *
 *  - the baseline is sampled BEFORE the SHA is read (:1897 then :1904).
 *    `readiness_restart_baseline` goes through `sup_restart_count`, which is a
 *    `systemctl` call, so swapping the two lines changes the order of entries
 *    in `systemctl.log` and in the shared trace, both of which the parity gate
 *    diffs. (It is NOT that the SHA read is an extra subprocess on a container
 *    drive: `git_target_capture` is a bare `git -C "$HOST_REPO_DIR"` with no
 *    `run_target` and no `incus exec` (:373-383, :392-398), so git runs on the
 *    host in BOTH topologies.)
 *
 *  - on readiness failure the give-up line precedes the rung's own warn
 *    (:1124 fires from inside `readiness_ok`, :1910 after it returns).
 *
 * `allowMissingBuildSha` is pinned FALSE, matching the comment at :1885-1887:
 * a build that cannot identify itself must fail rung 1 so the ladder escalates
 * to rung 2 (full redeploy) rather than declaring a stranger healthy. Only the
 * rollback path, where PREV may legitimately predate /readyz's additive
 * buildSha field, sets it true.
 *
 * The releases-layout arm at :1899-1902 (`deployed_sha` and its `luna_die`) is
 * NOT ported: `config.ts`'s `delegationFor` hands the whole releases layout to
 * the bash engine, so this module only ever runs on the inplace arm at :1904.
 */
export const restartOnlySync = (opts: RestartOnlyOptions): RestartOnlyOutcome => {
  // :1893-1894 - `RRC=0; restart_service || RRC=$?`.
  const restart = opts.restart()
  // :1895 - `if (( RRC == 3 )); then exit 3; fi`. Silent by design; see above.
  if (restart.code === 3) return terminal({ kind: "deferred", site: "restart-only" })
  // :1896 - any other non-zero code, including the MainPID postcondition's.
  if (restart.code !== 0) {
    opts.warn(restartOnlyRestartErroredLine)
    return terminal({ kind: "restart-only-restart-failed" })
  }

  // :1897 then :1904, in that order - see above on why the order is a contract.
  const baseline = opts.readinessBaseline()
  const expectedBuildSha = opts.readHead()

  // :1906. PASSING `baseline` IS MANDATORY: it is `readiness_ok`'s first
  // positional argument in bash and `ReadinessProbeOptions.baseline` in the
  // port, and it is the sole input to the crash-loop rung. Drop it and a unit
  // restarting into a 200 served by the OUTGOING process reads as healthy on
  // the way in, while a unit with any restart history at all reads as
  // crash-looping on the way out. `restart-only.test.ts` carries a row in each
  // direction.
  const result = opts.readiness({ expectedBuildSha, allowMissingBuildSha: false, baseline })
  if (result.ready) {
    // :1907-1908.
    opts.info(restartOnlyHealthyLine(opts.serviceName, expectedBuildSha))
    return terminal({ kind: "restart-only-ok" })
  }
  // :1124 from inside `readiness_ok`, then :1910.
  opts.warn(readinessGaveUpLine(opts.readinessTimeoutRaw, result.detail))
  opts.warn(restartOnlyReadinessFailedLine)
  return terminal({ kind: "restart-only-readiness-failed" })
}
