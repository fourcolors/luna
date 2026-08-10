/**
 * The exit-code and journal-disposition contract of the update transaction, as
 * DATA rather than as eight scattered branches.
 *
 * WHY THIS FILE EXISTS. `scripts/luna-update-server:1871-2086` decides the
 * process exit code at eleven separate `exit` statements and decides the fate
 * of the transaction journal at six more places, and the two decisions are
 * coupled: an exit 3 (session-guard defer) or an exit 2 (CRITICAL) that also
 * cleared the journal would silently drop a pending transaction that the next
 * tick is supposed to resume. Modelling every terminal outcome as one closed
 * union with two TOTAL lookup tables over it turns "exit 3 is never conflated
 * with exit 4" and "the journal is never cleared on a deferred or CRITICAL
 * path" into properties a pure test asserts in milliseconds, instead of a code
 * review of the whole tail.
 *
 * THE CODES ARE A CONTRACT with `packages/server-registry/src/driver/luna-chat-server.ts`,
 * `scripts/luna-autodeploy`'s rc `case` (:539-560 deploy, :619-623 repair) and
 * an operator's shell. Conflating 3 (session-guard defer) with 4 (lock
 * contention under --restart-only) is the specific failure the bash comment at
 * :1872-1878 exists to prevent: it makes a responder diagnose "live sessions"
 * when the real cause is a concurrent update holding the profile lock.
 *
 * IMPORTS. Only `./lock.js`, for two symbols: the `AcquireFailureReason` TYPE
 * that the `lock-unacquirable` arm carries (lock.ts:301-309), and the
 * `lockContentionExitCode` VALUE that decides 4-versus-0 (lock.ts:81-82).
 * That helper is NOT re-implemented here and NOT retired there: lock.ts's own
 * module doc cites it as the single copy of bash's :1872-1881 mapping, so this
 * module delegates to it rather than choosing those two numbers a second time.
 * Nothing else is imported - no node builtins, no IO, no clock.
 *
 * THE DISPOSITION TABLE IS DESCRIPTIVE, NOT EXECUTIVE. `update-flow.ts`
 * performs the actual `clear_transaction` at bash's own call sites (:2076, and
 * rollback.ts's own `clearTransaction` mirroring :1840). This table records
 * what those sites do so a test can assert the invariant across every arm at
 * once. Making it executive would move the clear away from where bash does it,
 * which is exactly how recovery gets broken.
 */
import { type AcquireFailureReason, lockContentionExitCode } from "./lock.js"

/**
 * Every way the update transaction can end, one arm per `exit` in
 * `scripts/luna-update-server:1871-2086` plus the two refusals that happen
 * before the tail is reached (config parse and the fresh-run preflight).
 *
 * CLOSED ON PURPOSE: `exitCodeFor` and `journalDispositionFor` both end in a
 * `never` check, so adding an arm here without deciding both its exit code and
 * its journal fate is a compile error rather than a runtime surprise.
 */
export type Terminal =
  /**
   * `acquire_update_lock` lost the race for the profile lock (:982-984), and
   * the caller block chose 4 or 0 (:1879-1880). Somebody else is deploying.
   */
  | { readonly kind: "lock-contention"; readonly restartOnly: boolean }
  /**
   * `acquire_update_lock` failed for one of its three NON-contended reasons
   * (:988, :992, :1000-1006). All four of bash's paths are `return 1`, so the
   * caller block cannot tell them apart and the exit code is identical; the
   * `reason` is carried so an operator log and a test can distinguish
   * "somebody else is deploying" from "this host cannot record its own
   * ownership", which are completely different incidents.
   */
  | { readonly kind: "lock-unacquirable"; readonly restartOnly: boolean; readonly reason: AcquireFailureReason }
  /**
   * A fresh run could not establish its own preconditions while holding the
   * lock: HEAD unreadable (:1965), `fetch` failed (:1974), or the target ref
   * did not resolve (:1994). Every one is a `luna_die`, which exits 1.
   */
  | { readonly kind: "preflight-refused" }
  /**
   * `parseUpdateConfig` refused the argv or its validation block did
   * (config.ts:305-307). Reached before the lock and before any journal read.
   */
  | { readonly kind: "config-refused" }
  /** `load_transaction` failed on an existing journal (:1924-1926). */
  | { readonly kind: "corrupt-journal" }
  /**
   * `restart_session_guard` said defer. The `site` names WHICH of bash's five
   * deferral points ran, because the journal fate differs between them and
   * because the operator-facing line differs at every one.
   */
  | {
      readonly kind: "deferred"
      readonly site: "fresh-run" | "recovery-resume" | "mid-transaction" | "rollback-restart" | "restart-only"
    }
  /** `--restart-only` restarted and the unit came back healthy (:1907-1908). */
  | { readonly kind: "restart-only-ok" }
  /** `--restart-only` and `restart_service` returned non-zero, non-3 (:1896). */
  | { readonly kind: "restart-only-restart-failed" }
  /** `--restart-only` restarted but readiness never passed (:1910-1911). */
  | { readonly kind: "restart-only-readiness-failed" }
  /** The forward path completed and readiness passed (:2073-2083). */
  | { readonly kind: "updated" }
  /** The forward path failed and the rollback restored a healthy server (:1838-1841). */
  | { readonly kind: "rolled-back" }
  /** The forward path failed AND the rollback failed; the server may be DOWN (:1854-1857). */
  | { readonly kind: "rollback-failed" }
  /** `fail_forward` under `--no-rollback`: left at the new ref, unhealthy (:1864-1866). */
  | { readonly kind: "forward-failed-no-rollback" }

/**
 * What the run leaves behind at `$UPDATE_JOURNAL`.
 *
 * `"cleared"`   - `clear_transaction` ran; there is no pending transaction.
 * `"retained"`  - a journal exists at exit and this path deliberately keeps it,
 *                 whether it wrote a new phase (:1856, :1865) or simply left
 *                 the one it found (:1926, :1949, :2058, :1830). The next tick
 *                 resumes from it.
 * `"untouched"` - this path never wrote or removed the journal, because it
 *                 exited before the first `write_transaction` (:2002) or ran on
 *                 an arm that provably has no journal at all.
 *
 * The `"retained"` / `"untouched"` split is not cosmetic: `"retained"` asserts
 * that a resumable transaction survives, `"untouched"` asserts that no state
 * was left behind for a later run to trip over.
 */
export type JournalDisposition = "cleared" | "retained" | "untouched"

/**
 * The process exit code for a terminal, and the only place the mapping lives
 * outside lock.ts's contention pair, which this function calls rather than
 * duplicates.
 *
 * 0 healthy / benign defer, 1 rolled back or refused, 2 corrupt or CRITICAL,
 * 3 session-guard defer, 4 lock contention under --restart-only.
 */
export const exitCodeFor = (t: Terminal): 0 | 1 | 2 | 3 | 4 => {
  switch (t.kind) {
    // :1879-1880, via lock.ts:81-82. Both lock arms share this mapping because
    // bash cannot tell them apart: all four acquire failures are `return 1`.
    case "lock-contention":
    case "lock-unacquirable":
      return lockContentionExitCode(t.restartOnly)
    // Every `luna_die`, which is exit 1 (scripts/lib/luna-deploy.sh:6).
    case "preflight-refused": // :1965, :1974, :1994
    case "config-refused": // config.ts:68
    case "restart-only-restart-failed": // :1896
    case "restart-only-readiness-failed": // :1911
    case "rolled-back": // :1841
    case "forward-failed-no-rollback": // :1866
      return 1
    case "corrupt-journal": // :1926
    case "rollback-failed": // :1857
      return 2
    // All five guard deferrals, including restart-only's bare `exit 3` at
    // :1895, which must NEVER collapse into the lock's 4.
    case "deferred": // :2000, :1950, :2059, :1831, :1895
      return 3
    case "restart-only-ok": // :1908
    case "updated": // :2083
      return 0
    default: {
      // Exhaustiveness: a new Terminal arm fails to compile until it is mapped.
      const never: never = t
      return never
    }
  }
}

/**
 * What each terminal leaves at `$UPDATE_JOURNAL`.
 *
 * THE TWO INVARIANTS this table exists to make testable:
 *   1. exactly `updated` and `rolled-back` are `"cleared"`;
 *   2. nothing whose exit code is 2 or 3 is `"cleared"` - a CRITICAL or a
 *      defer that destroyed the journal would strand a pending transaction
 *      that the next tick, autodeploy, or `--restart-only`'s recovery
 *      precedence is supposed to finish.
 */
export const journalDispositionFor = (t: Terminal): JournalDisposition => {
  switch (t.kind) {
    // `clear_transaction` at :2076 and :1840 respectively, and nowhere else.
    case "updated":
    case "rolled-back":
      return "cleared"
    // A journal exists at exit and is deliberately kept for the next tick.
    case "corrupt-journal": // :1925-1926 refuses to mutate and says so
    case "rollback-failed": // :1856 writes phase=rollback-failed
    case "forward-failed-no-rollback": // :1865 writes phase=forward-failed
      return "retained"
    case "deferred":
      // fresh-run defers BEFORE the first write (:1998-2000, "nothing
      // mutated"), and restart-only only runs its light path when the journal
      // does not exist at all (:1890 takes the else arm), so neither leaves a
      // journal behind. The other three defer with one already on disk.
      return t.site === "fresh-run" || t.site === "restart-only" ? "untouched" : "retained"
    // Everything below exits before `write_transaction "prepared"` (:2002), or
    // on the restart-only arm that :1890 proved has no journal.
    case "lock-contention": // :1879-1880, before the journal is ever read
    case "lock-unacquirable":
    case "preflight-refused": // :1965, :1974, :1994 - all pre-:2002
    case "config-refused": // before the lock, let alone the journal
    case "restart-only-ok": // :1908
    case "restart-only-restart-failed": // :1896
    case "restart-only-readiness-failed": // :1911
      return "untouched"
    default: {
      // Exhaustiveness: a new Terminal arm fails to compile until it is mapped.
      const never: never = t
      return never
    }
  }
}
