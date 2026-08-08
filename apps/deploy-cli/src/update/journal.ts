/**
 * Transaction journal: crash-safe phase record for one deploy transaction,
 * ported byte-exact from scripts/luna-update-server's write_transaction /
 * load_transaction / clear_transaction (:1010-1044). The phase sequence
 * itself and next-tick resumption (:1915-2085 - acquire the profile lock,
 * inspect a pending journal, recover from whichever phase it names) stay
 * bash-only until the apply/restart/rollback state machine is ported
 * (S22b/S22c, docs/deploy-binary.md); this module only owns the on-disk
 * record those phases write and the resume path reads back.
 *
 * FORMAT IS A CONTRACT: scripts/luna-update-server's own load_transaction
 * reads this exact shape back on recovery, so every field, its order and the
 * trailing newline must byte-match what the bash writer produces - see
 * apps/deploy-cli/test/update/journal-parity.test.ts, which drives the real
 * bash script (including crash-injection between phases) and diffs bytes
 * against this module.
 *
 * THREE-STATE CONTRACT (absent vs corrupt) - WHY: bash's own resume call
 * site (scripts/luna-update-server:1923-1927) treats a missing journal and a
 * present-but-untrustworthy one OPPOSITELY. `[[ -f "$UPDATE_JOURNAL" ]]`
 * false means "no journal - take the fresh-update path", nothing has been
 * interrupted. `[[ -f ]]` true but `load_transaction` failing (unreadable,
 * OR readable but malformed) means "an update WAS interrupted and its
 * record cannot be trusted" - CRITICAL, refuse to mutate the checkout, exit
 * 2. Collapsing that second case into `undefined`, the same value returned
 * for "nothing to resume", would erase exactly the asymmetry bash's own
 * crash-safety hinges on. So loadTransactionSync below is three-state:
 * absent (ENOENT) -> undefined; present-but-unreadable OR
 * present-but-invalid -> throws CorruptJournalError; present and valid ->
 * Transaction.
 *
 * FOURTH CASE - A NON-REGULAR FILE AT THE JOURNAL PATH (a FIFO, socket,
 * device, or directory): bash's `[[ -f "$UPDATE_JOURNAL" ]]` is false for
 * any of these too, so bash takes the SAME fresh-update path it takes for
 * "no journal at all" - it never calls load_transaction. loadTransactionSync
 * deliberately does NOT mirror that lenience: it treats a non-regular file
 * as present-but-untrustworthy (CorruptJournalError), the same bucket as
 * unreadable-or-malformed, not as absent. This is a documented TS-stricter
 * divergence in the safe direction, identical in shape to the directory
 * case already folded into "present-but-unreadable" above. It also closes a
 * real hazard bash's `-f` test does not have to worry about: opening a FIFO
 * for reading blocks until a writer shows up, so a plain `readFileSync`
 * against one would hang loadTransactionSync forever instead of failing
 * fast. loadTransactionSync avoids that by opening O_NONBLOCK (which only
 * changes how a FIFO's OPEN behaves - it has no effect on reading a regular
 * file) and fstat-ing that SAME fd before ever reading from it, rather than
 * a statSync/existsSync pre-check on the path, which would reopen the very
 * TOCTOU window this shape avoids - the check and the eventual read share
 * one open, never two.
 */
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { allKeyValuesLastWins, atomicWriteFileSync, ensureStateDir, removeFileIfPresent } from "./atomic-file.js"

/** Every phase write_transaction accepts (the TX_PHASE regex at scripts/luna-update-server:1040). */
export const TX_PHASES = [
  "prepared",
  "checkout",
  "applied",
  "restarting",
  "verifying",
  "rolling-back",
  "rollback-failed",
  "forward-failed",
] as const

export type TxPhase = (typeof TX_PHASES)[number]

const isTxPhase = (value: string): value is TxPhase => (TX_PHASES as readonly string[]).includes(value)

/** 7-64 hex chars, case-insensitive - the same bound load_transaction enforces on prev/target (a git abbreviated-to-full sha). */
const HEX_SHA = /^[0-9a-fA-F]{7,64}$/

export interface Transaction {
  readonly phase: TxPhase
  readonly prev: string
  readonly target: string
  /** Empty string is valid (scripts/luna-update-server:1043 allows an empty prev_lock_hash). */
  readonly prevLockHash: string
}

/** `$UPDATE_STATE_DIR/transaction-$PROFILE` (scripts/luna-update-server:936). */
export const transactionJournalPath = (stateDir: string, profile: string): string =>
  join(stateDir, `transaction-${profile}`)

export interface TransactionFields {
  readonly phase: TxPhase
  readonly prev: string
  readonly target: string
  readonly prevLockHash: string
  /** Unix seconds, matching `date +%s`. Defaults to now; pass the bash side's captured value to prove byte parity against a specific run. */
  readonly updatedAt?: number
}

/** Byte-exact port of write_transaction's printf (scripts/luna-update-server:1013-1014). */
export const writeTransactionSync = (journalPath: string, fields: TransactionFields): void => {
  const updatedAt = fields.updatedAt ?? Math.floor(Date.now() / 1000)
  const contents =
    `phase=${fields.phase}\n` +
    `prev=${fields.prev}\n` +
    `target=${fields.target}\n` +
    `prev_lock_hash=${fields.prevLockHash}\n` +
    `updated_at=${updatedAt}\n`
  ensureStateDir(dirname(journalPath))
  atomicWriteFileSync(journalPath, contents)
}

/**
 * Thrown by loadTransactionSync when the journal at `journalPath` EXISTS but
 * cannot be trusted - either the read itself failed (EACCES, EIO, ...) or
 * the content failed one of load_transaction's own validations (unrecognized
 * phase, malformed prev/target/prev_lock_hash, or a record truncated
 * mid-line with no trailing newline). This is the bash-mandated other half
 * of the three-state contract described in this module's header: an
 * existing-but-untrustworthy journal is CRITICAL evidence that an update was
 * interrupted, not "nothing to resume" - see that header for the full WHY.
 */
export class CorruptJournalError extends Error {
  readonly journalPath: string
  readonly reason: string

  constructor(journalPath: string, reason: string) {
    super(`corrupt or unreadable transaction journal at ${journalPath}: ${reason}`)
    this.name = "CorruptJournalError"
    this.journalPath = journalPath
    this.reason = reason
  }
}

/**
 * Byte-exact port of load_transaction (scripts/luna-update-server:1028-1044),
 * paired with the outer caller's `[[ -f "$UPDATE_JOURNAL" ]]` check
 * (scripts/luna-update-server:1923-1927) that gives this file's absence and
 * its presence-but-unreadable-or-corrupt two OPPOSITE meanings on the bash
 * side - see this module's header for the full contract (including the
 * FOURTH CASE it documents for a non-regular file at `journalPath`).
 * undefined only on ENOENT (no journal at all); CorruptJournalError for a
 * present file whose read fails, whose content fails any of
 * load_transaction's own validations, OR that is not a regular file;
 * a Transaction otherwise.
 *
 * The open-then-fstat-then-read below (rather than readFileIfReadable's
 * plain path-based readFileSync) is deliberate: O_NONBLOCK makes the OPEN of
 * a FIFO return immediately instead of blocking for a writer that will never
 * arrive, and fstat-ing that already-open fd - never a fresh statSync/
 * existsSync on the path - means the type check and the eventual read share
 * one open, so there is no window between "checked" and "read" for the path
 * to start pointing somewhere else.
 */
export const loadTransactionSync = (journalPath: string): Transaction | undefined => {
  let fd: number
  try {
    fd = openSync(journalPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    const reason = err instanceof Error ? err.message : String(err)
    throw new CorruptJournalError(journalPath, `unreadable: ${reason}`)
  }
  let contents: string
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) {
      throw new CorruptJournalError(journalPath, `not a regular file: mode ${stat.mode.toString(8)}`)
    }
    contents = readFileSync(fd, "utf8")
  } catch (err) {
    if (err instanceof CorruptJournalError) throw err
    const reason = err instanceof Error ? err.message : String(err)
    throw new CorruptJournalError(journalPath, `unreadable: ${reason}`)
  } finally {
    closeSync(fd)
  }
  const fields = allKeyValuesLastWins(contents)
  const phase = fields.get("phase") ?? ""
  const prev = fields.get("prev") ?? ""
  const target = fields.get("target") ?? ""
  const prevLockHash = fields.get("prev_lock_hash") ?? ""
  if (!isTxPhase(phase)) throw new CorruptJournalError(journalPath, `unrecognized phase ${JSON.stringify(phase)}`)
  if (!HEX_SHA.test(prev)) throw new CorruptJournalError(journalPath, `malformed prev sha ${JSON.stringify(prev)}`)
  if (!HEX_SHA.test(target)) throw new CorruptJournalError(journalPath, `malformed target sha ${JSON.stringify(target)}`)
  if (prevLockHash !== "" && !HEX_SHA.test(prevLockHash)) {
    throw new CorruptJournalError(journalPath, `malformed prev_lock_hash ${JSON.stringify(prevLockHash)}`)
  }
  // updated_at is deliberately not read back here: load_transaction's own
  // `case` has no `updated_at)` arm (scripts/luna-update-server:1032-1039),
  // so production recovery logic never consumes it either.
  return { phase, prev, target, prevLockHash }
}

/** `rm -f "$UPDATE_JOURNAL"` (clear_transaction, scripts/luna-update-server:1023-1026). */
export const clearTransactionSync = (journalPath: string): void => removeFileIfPresent(journalPath)
