/**
 * Shared low-level state-file IO for the deploy engine's crash-safe
 * key=value text files (transaction journal, guardian status heartbeat,
 * guardian health-debounce journal). atomicWriteFileSync mirrors the
 * write-tmp-then-rename idiom scripts/luna-update-server and
 * scripts/luna-guardian already use (write_transaction, write_guardian_status,
 * health_journal_write): `( umask 077; printf ... > "$file.tmp.$$" ); mv "$tmp" "$file"`.
 * Mode 0o600 on the temp file mirrors that `umask 077`; rename() on the same
 * filesystem is atomic on both sides, so a reader never observes a partial
 * write - the crash-safety property scripts/luna-guardian-remote-check and
 * every recovery path depend on.
 *
 * Provisioning the containing state directory is a SEPARATE step
 * (ensureStateDir below), not something atomicWriteFileSync does implicitly.
 * It is not the same bash function on both sides for all three writers - see
 * ensureStateDir's own doc, and docs/deploy-binary.md's state-file section,
 * for exactly which bash function owns that mkdir+chmod for each.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"

/**
 * Create `dir` (mkdir -p) and unconditionally chmod it to 0o700. Each of the
 * three state-file writers below calls this explicitly before its own
 * atomicWriteFileSync, rather than atomicWriteFileSync provisioning
 * `dirname(path)` implicitly for whatever path it is handed - that keeps the
 * directory-tightening visible at the call sites bash pairs it with, instead
 * of being a hidden side effect of the generic write primitive for any path
 * a future caller might pass it.
 *
 * Provenance differs per writer (see docs/deploy-binary.md's state-file
 * section for the full table):
 * - write_guardian_status (scripts/luna-guardian:287-288) and
 *   health_journal_write (scripts/luna-guardian:397-398) each do this exact
 *   `mkdir -p "$STATE_DIR" || return 1; chmod 700 "$STATE_DIR" 2>/dev/null ||
 *   true` pair themselves, immediately before their own printf - status-file.ts
 *   and health-journal.ts calling ensureStateDir is a direct port of that.
 * - write_transaction (scripts/luna-update-server:1010-1021) does NOT mkdir
 *   or chmod at all; $UPDATE_STATE_DIR is provisioned once, earlier in the
 *   real flow, by acquire_update_lock (scripts/luna-update-server:981-982).
 *   journal.ts's writeTransactionSync calling ensureStateDir on every write
 *   is a pragmatic stand-in - not a byte-format claim - until S22b/S22c port
 *   acquire_update_lock's own state machine.
 *
 * Best-effort on the chmod, matching bash's `... 2>/dev/null || true`: a
 * directory that already exists at looser permissions gets tightened, but a
 * chmod failure (e.g. not the owner) must never fail the write.
 */
export const ensureStateDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Best-effort, mirrors `chmod 700 "$STATE_DIR" 2>/dev/null || true`.
  }
}

/**
 * Atomically write `contents` to `path`: tmp file at mode 0600, then rename
 * over the destination. Assumes `dirname(path)` already exists - callers
 * provision it explicitly via ensureStateDir() first (see its doc for which
 * bash function actually owns that provisioning for each of the three
 * writers).
 */
export const atomicWriteFileSync = (path: string, contents: string): void => {
  const tmp = `${path}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, contents, { mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    // Mirrors write_guardian_status / health_journal_write: `rm -f "$tmp"
    // 2>/dev/null || true` on either the write or the `mv` failing, so a
    // partial write never lingers. Best-effort, same as bash: cleanup failing
    // must never replace the real error above with e.g. an unrelated EPERM.
    try {
      removeFileIfPresent(tmp)
    } catch {
      // best-effort, same as bash's `|| true`
    }
    throw err
  }
}

/**
 * Read `path` as utf8, or undefined if it does not exist (ENOENT). Any OTHER
 * read failure (EACCES, EISDIR, EIO, ...) is rethrown rather than swallowed:
 * a path that EXISTS but cannot be read is a different fact than "there is
 * no file here", and bash's own `[[ -r "$file" ]] || return 1` collapses
 * both into one boolean - but its callers do NOT all treat that boolean the
 * same way. journal.ts's loadTransactionSync needs exactly that same
 * absent-vs-unreadable split (its bash counterpart's caller branches on
 * file-existence SEPARATELY from load_transaction's own success -
 * `[[ -f "$UPDATE_JOURNAL" ]]` gates whether load_transaction runs at all,
 * scripts/luna-update-server:1923-1927) but implements it itself via its own
 * openSync/fstatSync rather than calling this function, because it also has
 * to reject a non-regular file at that path (a FIFO opened for reading would
 * otherwise block loadTransactionSync forever) without reopening the path
 * after the check - see journal.ts's module header. Callers that DO want
 * bash's collapsed single-state behavior (readKeyValue below, matching
 * status_value) catch and discard this rethrow themselves.
 */
export const readFileIfReadable = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }
}

/** Remove `path` if present; a no-op if already absent (mirrors `rm -f`). */
export const removeFileIfPresent = (path: string): void => {
  rmSync(path, { force: true })
}

/**
 * Byte-exact port of `status_value()` (scripts/luna-guardian:271-275): the
 * first `key=` line's value in `path`, or undefined if the file is absent OR
 * unreadable. Bash has exactly one such reader, shared by the status file
 * and the health journal - status-file-parity.test.ts and
 * health-journal-parity.test.ts both call this directly rather than each
 * module defining its own copy.
 *
 * Unlike loadTransactionSync, status_value's own `[[ -r "$file" ]] || return
 * 1` never distinguishes "absent" from "present but unreadable" - every
 * caller treats the failure identically (e.g. `status_value "$file" repo_sha
 * 2>/dev/null || true`, scripts/luna-guardian:292-294), so this reader keeps
 * that single-state contract and swallows readFileIfReadable's rethrow for
 * anything other than ENOENT.
 */
export const readKeyValue = (path: string, key: string): string | undefined => {
  let contents: string | undefined
  try {
    contents = readFileIfReadable(path)
  } catch {
    return undefined
  }
  if (contents === undefined) return undefined
  const prefix = `${key}=`
  for (const line of contents.split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length)
  }
  return undefined
}

/**
 * Every `key=value` pair in a text file, last occurrence winning - mirrors
 * `while IFS='=' read -r key value; do case "$key" in ...; done < "$file"`
 * (load_transaction, scripts/luna-update-server:1028-1044). Only the FIRST
 * `=` on a line separates key from value (bash `read`'s multi-field
 * assignment folds everything past it into the last named variable), which
 * matches this slice for every value this codebase's writers actually
 * produce (closed TX_PHASES strings, hex shas, digit timestamps).
 *
 * MEASURED DIVERGENCE (bash 3.2.57, /bin/bash on this repo's dev machine): a
 * value ending in EXACTLY ONE trailing `=` does NOT round-trip. `IFS='='
 * read -r k v` on the line `z=b=` yields `v=b` (bash's `read` drops that one
 * trailing delimiter) while this slice yields `b=` (`line.slice(i + 1)` keeps
 * everything after the first `=`, trailing char included). Two or more
 * trailing `=` DO agree: `x=y==` yields `y==` on both sides. This divergence
 * is unreachable from every writer in this module (no writer ever emits a
 * value ending in a single `=`) and its direction is safe: on the one
 * reachable-in-theory input where it would matter, this parser is STRICTER
 * than bash, classifying as corrupt (loadTransactionSync throwing
 * CorruptJournalError on a resulting sha/phase mismatch) something bash
 * would silently accept. See journal-parity.test.ts's divergence-boundary
 * pins for both probe lines.
 *
 * A final line with no trailing newline is dropped entirely, mirroring bash:
 * `read` returns non-zero at EOF without a newline, so the loop body never
 * runs for that partial line.
 */
export const allKeyValuesLastWins = (contents: string): Map<string, string> => {
  const fields = new Map<string, string>()
  const lines = contents.split("\n")
  if (!contents.endsWith("\n")) lines.pop()
  for (const line of lines) {
    if (line === "") continue
    const i = line.indexOf("=")
    const key = i === -1 ? line : line.slice(0, i)
    const value = i === -1 ? "" : line.slice(i + 1)
    fields.set(key, value)
  }
  return fields
}
