/**
 * The no-journal prologue of an inplace update
 * (scripts/luna-update-server:1954-2003), ported: everything the forward path
 * does BEFORE it is allowed to touch anything.
 *
 * WHERE IT STOPS, AND WHY THAT BOUNDARY IS THE POINT. Bash's block ends with
 * three statements this module deliberately does NOT contain: the session
 * guard (:1997), the DEFERRED warn (:1999) and `write_transaction "prepared"`
 * (:2002). They stay in `update-flow.ts` so that the orchestrator shows the
 * guard-then-first-journal-write ordering as two adjacent, reviewable lines,
 * rather than burying the single most important safety property of the whole
 * transaction inside a helper. That ordering is the reason a deferred fresh
 * run leaves NOTHING behind: everything below is read-only with respect to
 * the checkout (the fetch moves remote refs only, and ref resolution reads),
 * so a guard that defers after this function returns has nothing to undo.
 * There is therefore no journal seam on `FreshRunOptions` at all, the same way
 * `restart-only.ts` has none: "the fresh prologue cannot write a transaction"
 * is unrepresentable here rather than merely reviewed.
 *
 * ORDER IS THE CONTRACT, and it is observable. The six steps below are bash's
 * order exactly, and three of them issue commands the dual-drive parity gate
 * diffs from a shared trace log: the HEAD read, the lockfile hash (which may
 * or may not invoke git, see `lockfileHashSync`) and the fetch, in that
 * sequence, with the `Current HEAD:` line landing between the hash and the
 * fetch. Swapping any pair keeps the return value identical and changes the
 * bytes both engines produce, which is exactly the class of divergence a byte
 * diff exists to catch.
 *
 * STATUS IS IGNORED ON BOTH CAPTURES, ON PURPOSE. Bash writes
 * `PREV="$(git_target_capture rev-parse HEAD)"` and then tests `[[ -n "$PREV" ]]`
 * (:1964-1965); it never consults `$?`, because command substitution's status
 * is discarded by the assignment. The same holds for the `^{commit}` peel at
 * :1992, whose failure surfaces as an empty string that the hex validation at
 * :1994 then rejects. Checking `status` here would refuse runs bash completes
 * (a git that warns on stderr and still prints a sha) and would report the
 * wrong one of the two `luna_die` messages when it did refuse. The ONLY
 * status this module reads is the fetch's, because bash reads that one
 * (`git_target fetch origin || luna_die`, :1974).
 *
 * NO IO. Every boundary is injected, including the lockfile hash, so the whole
 * prologue is drivable from a test with no git, no repo and no filesystem.
 */
import { gitFetchOriginArgs, gitRevParseCommitArgs, gitRevParseHeadArgs } from "./commands.js"
import { currentHeadLine, fetchFailedMessage, readHeadFailedMessage, refUnresolvedMessage } from "./flow-lines.js"
import { stripTrailingNewlines } from "./session-guard.js"
import type { CommandResult } from "./target.js"

/**
 * Re-exported rather than reimplemented, so "the apply gate and the rollback
 * path share ONE lockfile hash" holds by construction.
 *
 * The implementation lives in `apply-inplace.ts` because that is where its
 * only in-module consumer is (step 5's install gate), and it landed there
 * ahead of this file. A second spelling here - even a thin adapter with a
 * positional signature - would be a second thing to keep in step with
 * `lockfile_hash` (:538-544), which is the one function in this slice whose
 * two arms BOTH return the empty string and whose value is compared as a plain
 * string against the journal's persisted `prev_lock_hash`.
 */
export { lockfileHashSync } from "./apply-inplace.js"
export type { LockfileHashOptions } from "./apply-inplace.js"

/**
 * 7-64 hex, case-insensitive: bash's `[[ "$REQUESTED_REF" =~ ^[0-9a-fA-F]{7,64}$ ]]`
 * at :1989 and the identical post-resolution test at :1994, which are two
 * separate tests against the same pattern.
 *
 * The bound is git's own: 7 is the shortest abbreviation `--ref` accepts and
 * 64 leaves room for sha-256 object ids. UPPERCASE is admitted and NOT
 * normalised - see step 5 - so this is `[0-9a-fA-F]`, not `[0-9a-f]`.
 *
 * `$` here is JavaScript's end-of-INPUT anchor (no `m` flag), which is what
 * bash's ERE `$` means too; a value with a trailing newline is rejected by
 * both, and every string reaching this pattern has already been through
 * `stripTrailingNewlines` anyway.
 *
 * `journal.ts:72` holds a private copy of the same pattern for the DIFFERENT
 * bash line it enforces (`load_transaction`'s field validation at :1041).
 * Sharing one constant across the two would couple a change to bash's ref
 * grammar to a change in the journal's on-disk grammar, which are separately
 * versioned surfaces.
 */
const HEX_REF = /^[0-9a-fA-F]{7,64}$/

export interface FreshRunOptions {
  /** `$HOST_REPO_DIR` (:305-341). Interpolated into the read-HEAD failure message (:1965) and into nothing else here: the git seams already carry it. */
  readonly hostRepoDir: string
  /** `REQUESTED_REF="$REF"` (:1973), i.e. `--ref` as preflight resolved and defaulted it (preflight.ts:364-368, bash :510-521). */
  readonly requestedRef: string
  /** `git_target` (:1974): the mutating-arm runner, whose status IS consulted. */
  readonly gitTarget: (args: ReadonlyArray<string>) => CommandResult
  /** `git_target_capture` (:1964, :1992): the `$( )` arm. Its status is NOT consulted; see this module's header. */
  readonly gitTargetCapture: (args: ReadonlyArray<string>) => CommandResult
  /** `lockfile_hash` (:1966); bind to `lockfileHashSync`. Never throws, always a string. */
  readonly lockfileHash: () => string
  /** `luna_info` (:1967). Payload only; the caller owns the `-> ` prefix. */
  readonly info: (line: string) => void
}

export type FreshRunOutcome =
  /** `PREV`, `REF` and `PREV_LOCK_HASH` as bash leaves them at :1994, ready for the guard and the `prepared` write. */
  | { readonly ok: true; readonly prev: string; readonly ref: string; readonly prevLockHash: string }
  /** One of bash's three `luna_die` payloads (:1965, :1974, :1994). The caller emits `error: <message>` and returns 1. */
  | { readonly ok: false; readonly message: string }

/**
 * `git_target_capture rev-parse HEAD` with `$( )` semantics, the single
 * spelling of "what does the checkout say HEAD is?".
 *
 * Three call sites read it in bash - PREV at :1964, the reset postcondition at
 * :1189 and NEW_HEAD at :2040 - and they differ only in what they do with an
 * empty answer, so the read itself is one function and the emptiness policy
 * belongs to each caller. `$( )` strips ALL trailing newlines and nothing
 * else, which is why this uses `stripTrailingNewlines` and not `.trim()`:
 * `.trim()` would also eat leading whitespace and an interior-adjacent tab, so
 * a git that printed anything unexpected would be silently normalised into a
 * plausible-looking value instead of failing the hex check.
 */
export const readHeadSync = (gitTargetCapture: (args: ReadonlyArray<string>) => CommandResult): string =>
  stripTrailingNewlines(gitTargetCapture(gitRevParseHeadArgs).stdout)

/**
 * The prologue itself (:1954-1994), in bash's order.
 *
 * Every failure arm returns rather than throwing, because bash's three exits
 * here are `luna_die` calls (:1965, :1974, :1994) - one stderr line and exit
 * 1 - and a thrown error would reach `run-update.ts`'s `finally` as a stack
 * trace with the lock still to release and the wrong exit code.
 */
export const freshRunSync = (opts: FreshRunOptions): FreshRunOutcome => {
  // 1. PREV (:1964-1965). Emptiness is the only failure test bash applies.
  const prev = readHeadSync(opts.gitTargetCapture)
  if (prev === "") return { ok: false, message: readHeadFailedMessage(opts.hostRepoDir) }

  // 2. PREV_LOCK_HASH (:1966), captured BEFORE the fetch and before any
  //    mutation, because it describes the tree the server is running now and
  //    is what the journal persists for a later rollback to compare against.
  const prevLockHash = opts.lockfileHash()

  // 3. The `Current HEAD:` line (:1967), after the hash and before the fetch.
  //    Its position is part of the stdout byte diff, not a cosmetic choice.
  opts.info(currentHeadLine(prev))

  // 4. Fetch (:1974). The one status this module reads. Failing here is safe
  //    to report as "checkout unchanged" precisely because steps 1-3 mutated
  //    nothing.
  if (opts.gitTarget(gitFetchOriginArgs).status !== 0) return { ok: false, message: fetchFailedMessage }

  // 5. Resolve the requested ref to an immutable target (:1989-1992).
  //    A hex ref is used VERBATIM, with no lowercasing and no peel: bash's
  //    inplace arm at :1990 is a bare `REF="$REQUESTED_REF"`. That matters
  //    downstream - the journal records this exact spelling, `git reset --hard`
  //    receives it, and an abbreviated or uppercase ref therefore separates
  //    REF from NEW_HEAD, which changes both the success line and the
  //    readiness detail. The releases layout normalises instead (:1985-1988)
  //    and is out of scope for this port.
  //    A non-hex ref (a branch or an annotated tag) is peeled with `^{commit}`
  //    (:1992); a peel that fails prints nothing and lands as "".
  const ref = HEX_REF.test(opts.requestedRef)
    ? opts.requestedRef
    : stripTrailingNewlines(opts.gitTargetCapture(gitRevParseCommitArgs(opts.requestedRef)).stdout)

  // 6. Validate the RESULT (:1994). This is a second, separate test in bash,
  //    and it is what turns a failed peel into an operator-facing refusal. The
  //    message interpolates the ref AS REQUESTED, not the resolved one,
  //    because the resolved one is exactly what does not exist.
  if (!HEX_REF.test(ref)) return { ok: false, message: refUnresolvedMessage(opts.requestedRef) }

  return { ok: true, prev, ref, prevLockHash }
}
