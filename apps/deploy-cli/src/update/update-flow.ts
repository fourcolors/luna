/**
 * The update transaction itself (scripts/luna-update-server:1871-2086), ported
 * as a single top-to-bottom synchronous function.
 *
 * THIS FILE IS A TRANSCRIPT, NOT A DESIGN. The bash tail it ports is
 * simultaneously the specification, the parity oracle and the thing an
 * operator greps at 3am, so the only port whose correctness a reviewer can
 * actually check is one that reads in bash's own order, with a bash line
 * number on every branch. Read this file beside `sed -n '1871,2086p'
 * scripts/luna-update-server` and the two should track line for line. That is
 * why there is no state-machine driver loop here, no early `switch` over
 * phases, and no helper that "tidies up" the restart-only block: the
 * :1889-1913 fallthrough (below) is invisible in every structure that looks
 * tidier than this one.
 *
 * IT DECIDES, IT DOES NOT PERFORM. Every subprocess, clock, journal write and
 * output stream arrives as a seam on `UpdateFlowDeps`, and every non-trivial
 * decision is delegated to the module that already owns it: `restart-only.ts`
 * for rung 1, `fresh-run.ts` for the no-journal prologue, `apply-inplace.ts`
 * behind `applyRef`, `rollback.ts` behind `failForward`/`rollback`,
 * `terminals.ts` for what each ending means. What lives here is the control
 * flow between them, plus the journal writes at bash's own call sites.
 *
 * IT RETURNS A `Terminal`, NEVER AN EXIT CODE, and never calls `process.exit`.
 * `run-update.ts` is the only thing that consults `exitCodeFor`, so the "3 is
 * never conflated with 4" property is decided in one table rather than at the
 * eleven `exit` statements bash spreads it over.
 *
 * EVERY EXIT PATH WRITES OR CLEARS THE JOURNAL, or provably has none to touch.
 * The journal is what lets the next idle tick finish an interrupted run, so a
 * path that returns without settling it strands the host mid-transaction.
 * `journalDispositionFor` in terminals.ts records what each terminal here
 * leaves behind; that table is DESCRIPTIVE of this file, never executive over
 * it, because moving the clear away from bash's own call sites (:2076, and
 * rollback.ts's own clear mirroring :1840) is exactly how recovery breaks.
 *
 * THE ONLY STRING LITERALS. This file holds the four forward journal phases it
 * writes (:2002, :2043, :2045, :2071) and the three `fail_forward` reason
 * strings (:2031, :2065, :2086), and nothing else: every operator-facing line
 * comes from `flow-lines.ts`, the five
 * session-guard lines are emitted by `wiring.ts`'s guard closure and by
 * `restart.ts`, and the eleven restart lines are emitted from inside
 * `restart.ts` at bash's own positions. The three reasons live here rather
 * than in flow-lines.ts because they are not lines: they are fragments
 * `failForwardSync` interpolates into two lines it owns (rollback.ts:210,
 * :217), and splitting them out would put half of one sentence in each file.
 */
import { lunaDieLine } from "./bash-lib.js"
import {
  checkedOutLine,
  corruptJournalLine,
  deferredFreshRunLine,
  deferredMidTransactionLine,
  deferredRecoveryResumeLine,
  recoveringLine,
  restartOnlyJournalPendingLine,
  updatedLine,
} from "./flow-lines.js"
import type { FreshRunOutcome } from "./fresh-run.js"
import type { Transaction, TxPhase } from "./journal.js"
import { readinessGaveUpLine, type ReadinessResult } from "./readiness.js"
import { restartOnlySync } from "./restart-only.js"
import type { RestartOutcome } from "./restart.js"
import {
  EXIT_CRITICAL,
  EXIT_DEFERRED,
  EXIT_ROLLED_BACK,
  type FailForwardOutcome,
  type RollbackOutcome,
} from "./rollback.js"
import type { GuardVerdict } from "./session-guard.js"
import type { Terminal } from "./terminals.js"

/** `fail_forward "apply to $REF errored"` (:2031). */
const applyErroredReason = (ref: string): string => `apply to ${ref} errored`

/** `fail_forward "service restart errored"` (:2065). */
const RESTART_ERRORED_REASON = "service restart errored"

/** `fail_forward "failed readiness"` (:2086). */
const FAILED_READINESS_REASON = "failed readiness"

export interface UpdateFlowDeps {
  /** `$RESTART_ONLY` (:1889). Read ONCE, at the top; see the fallthrough note there. */
  readonly restartOnly: boolean
  readonly serviceName: string
  /**
   * `$REQUESTED_REF` as preflight resolved it (:1973 reads the already-
   * defaulted `$REF`). The flow itself never reads it - `freshRun` closes over
   * the same string and `run-update.ts` builds both from one source - but it
   * is exposed here so that the value the transaction was ASKED for is
   * inspectable beside the target it resolved to, which is the pair an
   * operator reconciles when a deploy lands on an unexpected sha.
   */
  readonly requestedRef: string
  /**
   * `$READINESS_TIMEOUT` AS THE OPERATOR SPELLED IT, for the give-up line at
   * :1124. Threaded as a string, never re-derived from the parsed seconds:
   * `--readiness-timeout 007` counts 7 seconds and prints `007`.
   */
  readonly readinessTimeoutRaw: string

  /** `luna_info` PAYLOAD, no `-> ` prefix; wiring.ts supplies the writer. */
  readonly info: (line: string) => void
  /** `luna_warn` PAYLOAD, no `warning: ` prefix; wiring.ts supplies the writer. */
  readonly warn: (line: string) => void
  /**
   * RAW stderr: receives its bytes verbatim, INCLUDING the trailing newline,
   * and adds nothing. Three lines go through it, all of them bash writes
   * without `luna_warn`: the corrupt-journal `printf` at :1925, and the two
   * `luna_die` refusals at :1965/:1974/:1994 (via `freshRun`) and :1866 (via
   * `failForward`), whose `error: ` prefix comes from the one shared spelling
   * in bash-lib.ts rather than from a literal here.
   */
  readonly writeStderrRaw: (text: string) => void

  /** `[[ -f "$UPDATE_JOURNAL" ]]` (:1890, :1923). Called at BOTH of bash's tests, never cached. */
  readonly journalExists: () => boolean
  /**
   * `load_transaction` (:1924), called ONLY behind `journalExists()`.
   *
   * TWO STATES, NOT THREE, and the missing arm is deliberate: journal.ts's
   * `loadTransactionSync` returns `undefined` only on ENOENT and throws
   * `CorruptJournalError` otherwise, while bash's `load_transaction` opens
   * with `[[ -r "$UPDATE_JOURNAL" ]] || return 1` (:1029) - so a journal that
   * vanishes between the `-f` test and the load makes BASH print CRITICAL and
   * exit 2 too. `wiring.ts` maps both the throw and the `undefined` onto
   * `"corrupt"`, which is what bash's caller can observe; journal.ts's own
   * three-state contract is not weakened for its other callers.
   */
  readonly loadTransaction: () => Transaction | "corrupt"
  /** `write_transaction <phase>` (:2002, :2043, :2045, :2071). The fields are bash's PREV/REF/PREV_LOCK_HASH globals. */
  readonly writeTransaction: (phase: TxPhase, fields: { prev: string; target: string; prevLockHash: string }) => void
  /** `clear_transaction` (:2076). */
  readonly clearTransaction: () => void
  /** `$UPDATE_JOURNAL`, for the corrupt-journal line only (:1925). */
  readonly journalPath: string

  /**
   * `restart_session_guard` at its two STANDALONE sites (:1948, :1998); the
   * three that sit inside `restart_service` are `restart.ts`'s. The verdict's
   * own `luna_warn` line (:1468/:1477/:1491/:1494/:1497) is emitted by this
   * closure in wiring.ts, at the position bash emits it from inside the guard,
   * so this flow prints only the CALLER's line.
   */
  readonly guard: () => GuardVerdict
  /** `restart_service` (:2056). Prints its own eleven lines; see restart.ts. */
  readonly restart: (guardSessions: boolean) => RestartOutcome
  /** `readiness_restart_baseline` (:1897, :2069). */
  readonly readinessBaseline: () => number
  /** `readiness_ok` (:1906, :2073). Emits nothing; the give-up line is the caller's. */
  readonly readiness: (req: {
    expectedBuildSha: string
    allowMissingBuildSha: boolean
    baseline: number
  }) => ReadinessResult

  /** `apply_ref "$REF" "$PREV_LOCK_HASH" --no-fetch` (:2020), with `TRANSACTION_TRACK_APPLY` (:2019) passed per call. */
  readonly applyRef: (target: string, prevLockHash: string, trackApply: boolean) => boolean
  /** `git_target_capture rev-parse HEAD` (:2040). */
  readonly readHead: () => string
  /** The whole no-journal prologue (:1963-1994), stopping before the guard. */
  readonly freshRun: () => FreshRunOutcome
  /** `seed_dream_wake_jobs || true` (:2075). Never throws: a seed failure must not fail a healthy deploy. */
  readonly seedDreamWakeJobs: () => void

  /**
   * `fail_forward` (:1861-1869), i.e. rollback.ts's `failForwardSync`. Not
   * re-implemented inline: it owns four operator-facing lines and the
   * `--no-rollback` journal write, and a second copy of that decision is a
   * second thing to keep in step with the bash.
   */
  readonly failForward: (args: {
    reason: string
    ref: string
    prev: string
    newHead: string | null
    forwardRestartRan: boolean
  }) => FailForwardOutcome
  /** `do_rollback` reached STRAIGHT from journal recovery (:1939), never through fail_forward. */
  readonly rollback: (args: { ref: string; prev: string; forwardRestartRan: boolean }) => RollbackOutcome
}

/**
 * `do_rollback`'s three endings (:1831, :1841, :1857) as terminals.
 *
 * The exit codes are rollback.ts's own constants rather than bare numbers so
 * that this mapping cannot drift from the module that produces them, and the
 * `never` default makes a widened `RollbackOutcome` a compile error here.
 */
const terminalForRollback = (outcome: RollbackOutcome): Terminal => {
  switch (outcome.exitCode) {
    // :1830-1831 - the guard stayed active for an apply-phase rollback and
    // refused the restart; the journal is at phase=rolling-back and resumes.
    case EXIT_DEFERRED:
      return { kind: "deferred", site: "rollback-restart" }
    // :1839-1841 - the old build is back and healthy. Exit 1, not 0: the
    // update the operator asked for did not happen.
    case EXIT_ROLLED_BACK:
      return { kind: "rolled-back" }
    // :1854-1857 - CRITICAL, journal at phase=rollback-failed.
    case EXIT_CRITICAL:
      return { kind: "rollback-failed" }
    default: {
      const never: never = outcome.exitCode
      return never
    }
  }
}

/**
 * `fail_forward`'s two endings (:1866 die, :1868 roll back).
 *
 * The `--no-rollback` arm is the one place this flow writes a `luna_die` line:
 * `failForwardSync` has already written phase=forward-failed and returned the
 * message, and bash's `luna_die` prints `error: <message>` to stderr and exits
 * 1 (scripts/lib/luna-deploy.sh:6).
 */
const finishFailForward = (deps: UpdateFlowDeps, outcome: FailForwardOutcome): Terminal => {
  if (outcome.kind === "died") {
    deps.writeStderrRaw(`${lunaDieLine(outcome.message)}\n`)
    return { kind: "forward-failed-no-rollback" }
  }
  return terminalForRollback(outcome.outcome)
}

/**
 * The live-update tail (:1883-2086), in bash's order.
 *
 * The lock (:1871-1881) is NOT here: `run-update.ts` acquires it before this
 * function is reached and releases it in a `finally` that covers the whole
 * body, exactly as bash's `trap release_update_lock EXIT` covers everything
 * below the acquire.
 */
export const runUpdateFlowSync = (deps: UpdateFlowDeps): Terminal => {
  // --- restart-only mode, repair ladder rung 1 (:1883-1913) -----------------
  //
  // THE FALLTHROUGH BELOW IS THE MOST IMPORTANT STRUCTURAL FACT IN THIS FILE.
  // A pending transaction takes precedence over the light path: bash warns
  // (:1891) and then simply does not enter the `else`, so execution continues
  // into the normal recovery flow with `RESTART_ONLY` never read again. A
  // `--restart-only` invocation with a pending journal can therefore reach
  // `do_rollback`, can print `ROLLED BACK to`, and can exit 2 - its exit set
  // is {0,1,2,3,4}, not {0,1,3,4}. Modelling rung 1 as a sibling state machine
  // deletes this path silently and every test anyone would naturally write
  // still passes, which is why the branch is written in bash's shape.
  if (deps.restartOnly) {
    if (deps.journalExists()) {
      deps.warn(restartOnlyJournalPendingLine) // :1891
      // ...and fall through into the journal fork below. No `return`.
    } else {
      // :1892-1912. rung 1 owns its own five steps and, by the shape of its
      // options type, cannot write a journal at all.
      return restartOnlySync({
        serviceName: deps.serviceName,
        readinessTimeoutRaw: deps.readinessTimeoutRaw,
        // Bash calls `restart_service` plainly here, i.e. with the guard in
        // whatever state the config left it - the same call the forward path
        // makes at :2056. Only the rollback path ever exempts it.
        restart: () => deps.restart(true),
        readinessBaseline: deps.readinessBaseline,
        readiness: deps.readiness,
        readHead: deps.readHead,
        info: deps.info,
        warn: deps.warn,
      }).terminal
    }
  }

  // `NEW_HEAD=""` (:1915). Null rather than "" because the only consumer is
  // `fail_forward`'s `${NEW_HEAD:-$REF}` (:1863), and null says "never read"
  // at the type level. The two are NOT distinguished at the use site: bash's
  // `:-` substitutes for unset OR empty, so rollback.ts's `headOrRef` maps
  // both to `$REF` - `""` is a HEAD of nothing, which is exactly what `:-`
  // exists to keep out of an operator line.
  let newHead: string | null = null
  // `FORWARD_RESTART_RAN` (:2063, :1938): whether service was already
  // interrupted, which is the single thing that decides whether a later
  // rollback exempts or keeps the session guard.
  let forwardRestartRan = false
  let prev: string
  let ref: string
  let prevLockHash: string

  // --- journal fork (:1923-1953) -------------------------------------------
  //
  // The second `[[ -f ]]` test is bash's own (:1923); it is deliberately not
  // the same call as :1890's, so a journal that appears or vanishes between
  // them takes bash's path, not a cached one.
  if (deps.journalExists()) {
    const loaded = deps.loadTransaction() // :1924
    if (loaded === "corrupt") {
      // :1925-1926. A bare `printf ... >&2`, with no `warning: ` prefix,
      // because at this point the engine is refusing to touch the checkout at
      // all and the message is addressed to a human, not to the deploy driver.
      deps.writeStderrRaw(`${corruptJournalLine(deps.journalPath)}\n`)
      return { kind: "corrupt-journal" }
    }
    // :1928-1931. The transaction, not the argv, is the source of truth from
    // here: recovery finishes the SAME transaction even if origin advanced.
    prev = loaded.prev
    ref = loaded.target
    prevLockHash = loaded.prevLockHash
    const recoveryPhase = loaded.phase
    deps.warn(recoveringLine(recoveryPhase, prev, ref)) // :1932

    if (recoveryPhase === "rolling-back" || recoveryPhase === "rollback-failed") {
      // :1933-1940. A prior run already began the rollback, so the service
      // interruption (if any) already happened and blocking recovery here
      // would strand a broken build: the rollback restart is guard-EXEMPT,
      // unconditionally. Bash's `do_rollback` exits, so this never returns to
      // the forward flow.
      forwardRestartRan = true // :1938
      return terminalForRollback(deps.rollback({ ref, prev, forwardRestartRan })) // :1939
    }

    // :1947-1951. Forward-resume phases only. Bash guards this with
    // `[[ -n "$TX_PHASE" ]]`, which is vacuous in the port because `TxPhase`
    // is a closed non-empty union and `loadTransaction` rejects anything else
    // (journal.ts:178) - a loaded transaction always has a phase. The guard
    // call itself is not vacuous: a resume re-applies and restarts, so it
    // faces the same pre-mutation check a fresh run does.
    const verdict = deps.guard()
    if (!verdict.permitted) {
      deps.warn(deferredRecoveryResumeLine(recoveryPhase)) // :1949
      return { kind: "deferred", site: "recovery-resume" } // :1950, journal RETAINED
    }
  } else {
    // :1963-1994, all of it inside fresh-run.ts: HEAD, lock hash, the
    // `Current HEAD:` line, the fetch, and the ref resolution.
    const outcome = deps.freshRun()
    if (!outcome.ok) {
      // Every failure in that prologue is a `luna_die` (:1965, :1974, :1994).
      deps.writeStderrRaw(`${lunaDieLine(outcome.message)}\n`)
      return { kind: "preflight-refused" }
    }
    prev = outcome.prev
    ref = outcome.ref
    prevLockHash = outcome.prevLockHash

    // :1995-2001. The pre-mutation check: defer BEFORE the first journal
    // write, so a deferred fresh run leaves NOTHING behind. The fetch and ref
    // resolution above touched remote refs only, never the checkout.
    const verdict = deps.guard()
    if (!verdict.permitted) {
      deps.warn(deferredFreshRunLine) // :1999
      return { kind: "deferred", site: "fresh-run" } // :2000
    }
    deps.writeTransaction("prepared", { prev, target: ref, prevLockHash }) // :2002 - the FIRST write
  }

  // Bash's write_transaction interpolates the same three globals every time;
  // naming them once here keeps the four call sites below identical to each
  // other, which is what makes a recovery read back what a forward run wrote.
  const journalFields = { prev, target: ref, prevLockHash }

  // --- forward apply (:2019-2033) -------------------------------------------
  //
  // `TRANSACTION_TRACK_APPLY=true` (:2019) is passed as an argument rather
  // than set as a module global: it is true HERE and nowhere else, and the
  // rollback path's own apply (:1820) must not be able to overwrite the
  // journal phase away from rolling-back.
  if (!deps.applyRef(ref, prevLockHash, true)) {
    // :2031. The releases-layout PRE-flip carve-outs at :2022-2030 are out of
    // scope for the inplace binary (config.ts:271-277 delegates that whole
    // layout), so an apply failure here ALWAYS routes to fail_forward.
    // `newHead` is still null, which fail_forward resolves to `$REF`.
    return finishFailForward(
      deps,
      deps.failForward({ reason: applyErroredReason(ref), ref, prev, newHead: null, forwardRestartRan }),
    )
  }

  // --- post-apply (:2034-2045) ---------------------------------------------
  //
  // NEW_HEAD is READ BACK, never assumed to be REF: with an abbreviated or
  // uppercase `--ref` the two differ, and it is NEW_HEAD - not REF - that
  // becomes EXPECTED_BUILD_SHA for readiness and the second half of the
  // `updated` line.
  newHead = deps.readHead() // :2040
  deps.info(checkedOutLine(newHead)) // :2041
  deps.writeTransaction("applied", journalFields) // :2043
  // Two sequential phase writes with nothing between them is what bash does on
  // the inplace layout (:2045 follows :2043 immediately; the releases arm's
  // flip hook sits between them). Recovery's phase branching depends on the
  // distinction, so neither write may be elided as redundant.
  deps.writeTransaction("restarting", journalFields) // :2045

  // --- restart (:2052-2066) -------------------------------------------------
  //
  // This flow prints NOTHING about the restart. The guard verdict line, the
  // settle lines, the start-limit warn and both MainPID warns are emitted from
  // inside restart.ts at bash's own positions, so all three callers of
  // `restart_service` (:1894, :2056, :1824) see them interleaved identically.
  const restartOutcome = deps.restart(true) // :2056
  if (restartOutcome.code === 3) {
    // :2057-2060. A guard defer must NOT route into fail_forward: fail_forward
    // would roll back, and its rollback performs the very restart the guard
    // just refused. Exit 3 keeps the journal at phase=restarting.
    deps.warn(deferredMidTransactionLine) // :2058
    return { kind: "deferred", site: "mid-transaction" } // :2059, journal RETAINED
  }
  // :2063. Past the guard the stop was at least attempted, so service is
  // interrupted. This assignment sits AFTER the code-3 check and BEFORE the
  // non-zero check on purpose: a deferred restart never ran, and a failed one
  // did.
  forwardRestartRan = true
  if (restartOutcome.code !== 0) {
    // :2064-2065. Every non-zero code lands here, `step: "mainpid"` included:
    // a stop that silently failed is a failed restart, not a warning.
    return finishFailForward(
      deps,
      deps.failForward({ reason: RESTART_ERRORED_REASON, ref, prev, newHead, forwardRestartRan }),
    )
  }

  // --- verify (:2067-2086) --------------------------------------------------
  //
  // The baseline is captured right AFTER issuing the restart (:2069) so that a
  // climbing NRestarts count during the probe window reads as crash-looping
  // rather than as the restart we just asked for.
  const baseline = deps.readinessBaseline() // :2069
  deps.writeTransaction("verifying", journalFields) // :2071 - the fourth and last forward write
  const readiness = deps.readiness({
    // EXPECTED_BUILD_SHA is NEW_HEAD (:2070), never REF.
    expectedBuildSha: newHead,
    // False on the forward path (:2072 leaves the global at its default): a
    // build that cannot identify itself must not be promoted. Only the
    // rollback path relaxes this, because PREV may predate /readyz's buildSha.
    allowMissingBuildSha: false,
    baseline,
  }) // :2073

  if (readiness.ready) {
    deps.info(updatedLine(prev, newHead, deps.serviceName)) // :2074
    deps.seedDreamWakeJobs() // :2075 - `|| true`; a seed failure never fails a healthy deploy
    deps.clearTransaction() // :2076
    // :2077-2082's prune_releases is releases-only and out of scope, so the
    // success tail ends here.
    return { kind: "updated" } // :2083
  }

  // The give-up warn lives INSIDE bash's readiness_ok (:1124), so it lands
  // before fail_forward's own line. The RAW timeout spelling is what bash
  // interpolates there.
  deps.warn(readinessGaveUpLine(deps.readinessTimeoutRaw, readiness.detail))
  return finishFailForward(
    deps,
    deps.failForward({ reason: FAILED_READINESS_REASON, ref, prev, newHead, forwardRestartRan }),
  ) // :2086
}
