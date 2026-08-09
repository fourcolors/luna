/**
 * `acquire_update_lock` / `release_update_lock` and the two readers they lean
 * on - `process_fingerprint` and `lock_owner_alive` (scripts/luna-update-server:
 * 950-1008). This is the mutual exclusion that stops a timer tick, a guardian
 * repair rung and an operator's manual run from interleaving a hard reset,
 * `bun install` and a unit restart on the same checkout.
 *
 * WHY A FINGERPRINT AND NOT JUST A PID (scripts/luna-update-server:951-960).
 * A lock whose liveness test is `kill -0 $pid` is wrong across a reboot or a
 * pid wrap: the pid in a stale owner file is eventually reused by an unrelated
 * process, and the lock then looks held forever - every subsequent deploy
 * defers and the host silently stops updating. So the owner record carries the
 * owner's START TIME as well, read from /proc/<pid>/stat field 20 (after
 * `sed 's/^.*) //'` drops the pid and the parenthesised comm, which may itself
 * contain spaces and parens) with `ps -p <pid> -o lstart=` as the non-Linux
 * fallback. A recycled pid has a different start time, so it classifies as
 * STALE and the lock is taken over rather than honoured.
 *
 * CONTENTION IS A SAFE DEFER, NOT A FAILURE, AND THE CODE IT DEFERS WITH IS
 * NOT 3. The caller block (scripts/luna-update-server:1872-1881) exits 0 on a
 * normal run - the timer simply retries - and exits 4 under `--restart-only`.
 * Four, not three, ON PURPOSE, and the bash carries the incident that bought
 * that distinction in a comment: 3 is the SESSION-GUARD defer, and conflating
 * the two made do_repair and the guardian page "DEFERRED by session guard -
 * live or unknown sessions" when the real cause was a concurrent update
 * holding the profile lock. That sends a responder to a false diagnosis at the
 * one moment they cannot afford one. `lockContentionExitCode` is the only place
 * this mapping lives, and lock-parity.test.ts drives the REAL bash caller block
 * to prove both arms - and that neither arm can ever produce 3.
 *
 * THE SELF-READBACK IS MANDATORY, NOT DEFENSIVE (scripts/luna-update-server:
 * 1000-1006). After writing the owner record the acquirer re-runs the SAME
 * `lock_owner_alive` a rival contender would run, from the same reader shape.
 * A lock whose owner record other contenders cannot witness - an unreadable
 * file, or the partial pid-without-fingerprint window - would be classified
 * stale and STOLEN mid-update, which is precisely the interleaving the lock
 * exists to prevent. Failing the readback removes the lock dir and defers.
 *
 * SEAMS. `processFingerprint` and `processAlive` arrive as injected function
 * parameters, the way restart.ts injects runSystemctl and readiness.ts injects
 * its probes, so a parity scenario can drive "pid recycled", "owner dead" and
 * "fingerprint changed between write and readback" deterministically instead of
 * trying to manufacture a genuinely dead pid. The FILESYSTEM is deliberately
 * NOT injected: the atomic-mkdir is the entire mechanism, so both drives of the
 * parity suite run it against a real directory in a real temp dir.
 *
 * THE TRAP DOES NOT PORT WHOLE, AND THE GAP IS STATED RATHER THAN PAPERED OVER.
 * Bash arms `trap release_update_lock EXIT INT TERM` (:1007), which fires
 * between commands. Node dispatches SIGINT/SIGTERM on the event loop, and the
 * synchronous update body spans a 6s settle (restart.ts) and a 60s readiness
 * poll (readiness.ts) that never yield to it, so an INT/TERM handler would not
 * run until after the work it was meant to interrupt. `installLockReleaseHooks`
 * therefore wires only the two that DO fire synchronously - 'exit' and
 * 'uncaughtException' - and the recovery for a killed binary is the next run's
 * stale takeover, which emits one extra `removing stale update lock` warn bash
 * never emits. That divergence is asserted in the parity suite, not hidden.
 */
import { spawnSync } from "node:child_process"
import { accessSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ensureStateDir } from "./atomic-file.js"

// --- exit codes ---------------------------------------------------------------

/** Contention on a normal run: a safe defer, the timer retries (scripts/luna-update-server:1880). */
export const EXIT_LOCK_CONTENTION = 0
/** Contention under `--restart-only`: exit 4 (scripts/luna-update-server:1879). */
export const EXIT_LOCK_CONTENTION_RESTART_ONLY = 4
/**
 * Exit 3 is the SESSION-GUARD defer (scripts/luna-update-server:176), NOT lock
 * contention. Exported from here only so the distinction is greppable at the
 * one place it is most often collapsed; nothing in this module returns it.
 */
export const EXIT_DEFERRED_BY_SESSION_GUARD = 3

/**
 * The caller block's mapping (scripts/luna-update-server:1872-1881), and the
 * only copy of it. See this module's header for why `--restart-only` reports 4
 * rather than reusing the session guard's 3.
 */
export const lockContentionExitCode = (restartOnly: boolean): typeof EXIT_LOCK_CONTENTION | typeof EXIT_LOCK_CONTENTION_RESTART_ONLY =>
  restartOnly ? EXIT_LOCK_CONTENTION_RESTART_ONLY : EXIT_LOCK_CONTENTION

// --- operator-facing strings (luna_warn payloads, byte-exact) -----------------

/** scripts/luna-update-server:983, byte for byte. */
export const lockContendedLine = (profile: string): string =>
  `DEFERRED: another update for profile '${profile}' is already running`

/**
 * scripts/luna-update-server:986, byte for byte. This is the line that appears
 * after a binary was killed mid-deploy, where bash's INT/TERM trap would have
 * released the lock and emitted nothing - see the trap note in this module's
 * header.
 */
export const removingStaleLockLine = (profile: string): string =>
  `removing stale update lock for profile '${profile}'`

/** scripts/luna-update-server:1003, byte for byte. */
export const OWNERSHIP_UNRECORDABLE_LINE = "cannot record update-lock ownership; deferring"

// --- paths and the owner record ----------------------------------------------

/** `UPDATE_LOCK_DIR="$UPDATE_STATE_DIR/lock-$PROFILE"` (scripts/luna-update-server:935). */
export const updateLockDirPath = (stateDir: string, profile: string): string => join(stateDir, `lock-${profile}`)

/** The single file inside the lock dir (scripts/luna-update-server:962, :997). */
export const OWNER_FILE_NAME = "owner"

/** `$UPDATE_LOCK_DIR/owner`. */
export const ownerFilePath = (lockDir: string): string => join(lockDir, OWNER_FILE_NAME)

/**
 * `printf 'pid=%s\nfingerprint=%s\n'` (scripts/luna-update-server:997), byte
 * for byte - including the trailing newline, because the interop requirement is
 * that bash's own `lock_owner_alive` reads a record this port wrote.
 */
export const ownerRecordContents = (pid: number, fingerprint: string): string =>
  `pid=${pid}\nfingerprint=${fingerprint}\n`

export interface OwnerRecord {
  readonly pid: string
  readonly fingerprint: string
}

/**
 * `sed -n 's/^pid=//p' ... | head -1` and its fingerprint twin
 * (scripts/luna-update-server:964-965). FIRST occurrence wins, which is why
 * this does not reuse atomic-file.ts's `allKeyValuesLastWins` - that reader
 * ports `while IFS='=' read`, whose LAST occurrence wins. Feeding a duplicated
 * key through the wrong one of the two silently picks the other record.
 *
 * A final line with no trailing newline still counts, matching sed (which
 * emits an incomplete last line) and unlike bash's `read`.
 */
export const parseOwnerRecord = (contents: string): OwnerRecord => {
  const lines = contents.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  let pid = ""
  let fingerprint = ""
  let sawPid = false
  let sawFingerprint = false
  for (const line of lines) {
    if (!sawPid && line.startsWith("pid=")) {
      pid = line.slice("pid=".length)
      sawPid = true
    }
    if (!sawFingerprint && line.startsWith("fingerprint=")) {
      fingerprint = line.slice("fingerprint=".length)
      sawFingerprint = true
    }
  }
  return { pid, fingerprint }
}

// --- the two real probes (production defaults for the seams) ------------------

export type FingerprintSource = "proc" | "ps"

export interface FingerprintReading {
  readonly fingerprint: string
  /**
   * Which of bash's two arms ran. Exported because the S22d acceptance requires
   * the suite to assert WHICH branch was exercised per platform (/proc on
   * Linux, the ps fallback on macOS) - without it, one arm could quietly stop
   * being covered on every runner at once.
   */
  readonly source: FingerprintSource
}

/**
 * `sed 's/^.*) //' | awk '{print $20}'` over /proc/<pid>/stat.
 *
 * The greedy `^.*\) ` is load-bearing: a process whose comm contains `) `
 * (perfectly legal - comm is arbitrary bytes up to 15 of them) would break a
 * lazy match, and field 20 of the REMAINDER is procfs' field 22, starttime.
 * A record with fewer than 20 remaining fields yields the empty string, exactly
 * as awk printing an unset `$20` does.
 *
 * Only the first line is considered; /proc/<pid>/stat is a single record.
 */
const starttimeFromProcStat = (raw: string): string => {
  const firstLine = raw.split("\n")[0] ?? ""
  const rest = firstLine.replace(/^.*\) /, "").trim()
  if (rest === "") return ""
  const fields = rest.split(/[ \t]+/)
  return fields[19] ?? ""
}

/**
 * `process_fingerprint` (scripts/luna-update-server:951-960). Never throws: both
 * bash arms swallow their own errors (`2>/dev/null`) and an empty answer is the
 * meaningful "cannot fingerprint" result its callers already branch on.
 */
export const readProcessFingerprintSync = (pid: number): FingerprintReading => {
  const statPath = `/proc/${pid}/stat`
  let statReadable = true
  try {
    accessSync(statPath, constants.R_OK)
  } catch {
    statReadable = false
  }
  if (statReadable) {
    let raw = ""
    try {
      raw = readFileSync(statPath, "utf8")
    } catch {
      // `sed ... 2>/dev/null` - a race where the process exits between the
      // readability test and the read yields the empty fingerprint, not a throw.
      raw = ""
    }
    return { fingerprint: starttimeFromProcStat(raw), source: "proc" }
  }
  // `ps -p "$pid" -o lstart= 2>/dev/null | tr -d '\n'`: newlines are DELETED,
  // not trimmed, and the surrounding whitespace ps pads with survives - so the
  // stored fingerprint is compared against a byte-identical later reading.
  const r = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" })
  if (r.error) return { fingerprint: "", source: "ps" }
  return { fingerprint: (r.stdout ?? "").replace(/\n/g, ""), source: "ps" }
}

/** The seam-shaped view of readProcessFingerprintSync: the string bash's `$(...)` would capture. */
export const processFingerprintSync = (pid: number): string => readProcessFingerprintSync(pid).fingerprint

/**
 * `kill -0 "$pid" 2>/dev/null` (scripts/luna-update-server:968).
 *
 * EPERM counts as NOT alive, which is what bash does too: `kill -0` on a
 * process owned by another user exits non-zero, so bash classifies that lock as
 * stale. Faithful rather than clever - the deploy engine runs as the owner of
 * every lock it can legitimately take over.
 */
export const processAliveSync = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// --- lock_owner_alive ---------------------------------------------------------

export interface OwnerProbes {
  /** Defaults to processAliveSync. */
  readonly processAlive?: (pid: number) => boolean
  /** Defaults to processFingerprintSync. */
  readonly processFingerprint?: (pid: number) => string
}

/**
 * `lock_owner_alive` (scripts/luna-update-server:961-971), in bash's order and
 * with bash's short-circuits: an unreadable owner file, a non-numeric pid, an
 * empty fingerprint, a dead pid and a CHANGED fingerprint all answer false, and
 * each of the first four answers false WITHOUT consulting the probe below it.
 * The order matters to the parity suite's fingerprint queue: a scenario whose
 * pid is dead never reaches `process_fingerprint` at all.
 */
export const lockOwnerAliveSync = (lockDir: string, probes: OwnerProbes = {}): boolean => {
  const owner = ownerFilePath(lockDir)
  try {
    accessSync(owner, constants.R_OK)
  } catch {
    return false
  }
  let contents: string
  try {
    contents = readFileSync(owner, "utf8")
  } catch {
    // `[[ -r ... ]]` passed but the read failed (a race, or a directory at that
    // path): bash's `sed` would emit nothing, so both fields come back empty
    // and the numeric test below rejects it.
    contents = ""
  }
  const { pid, fingerprint } = parseOwnerRecord(contents)
  if (!/^[0-9]+$/.test(pid) || fingerprint === "") return false
  const numericPid = Number(pid)
  if (!(probes.processAlive ?? processAliveSync)(numericPid)) return false
  const current = (probes.processFingerprint ?? processFingerprintSync)(numericPid)
  return current !== "" && current === fingerprint
}

// --- acquire / release --------------------------------------------------------

export interface UpdateLockHandle {
  readonly lockDir: string
  readonly ownerFile: string
  /** `UPDATE_LOCK_HELD` (scripts/luna-update-server:937) - release is a no-op once false. */
  readonly isHeld: () => boolean
  /** `release_update_lock` (scripts/luna-update-server:973-978); idempotent. */
  readonly release: () => void
}

/**
 * Which of bash's four `return 1` paths ran. Every one of them is `return 1` in
 * bash, so the exit code the caller derives is identical for all four - the
 * distinction exists so an operator log and a test can tell "somebody else is
 * deploying" from "this host cannot record its own ownership", which are
 * completely different incidents.
 */
export type AcquireFailureReason =
  /** Another live update holds the lock (scripts/luna-update-server:982-984). */
  | "contended"
  /** The stale lock was removed but the re-mkdir failed (:988). */
  | "stale-remkdir-failed"
  /** `process_fingerprint "$$"` came back empty (:992). Emits NO warning, matching bash. */
  | "fingerprint-unavailable"
  /** The mandatory self-readback failed (:1000-1006). */
  | "ownership-unrecordable"

export type AcquireLockOutcome =
  | { readonly acquired: true; readonly lock: UpdateLockHandle }
  | { readonly acquired: false; readonly reason: AcquireFailureReason }

export interface AcquireLockOptions extends OwnerProbes {
  /** `$UPDATE_STATE_DIR` (scripts/luna-update-server:934); provisioned here, `mkdir -p` + `chmod 700`. */
  readonly stateDir: string
  /** `$PROFILE`, which names the lock dir and appears in both warn lines. */
  readonly profile: string
  /** `$$`. Injected so the parity suite can write byte-identical owner records on both drives. */
  readonly pid?: number
  /** `luna_warn`'s payload (the `warning: ` prefix and the stderr routing are the caller's). */
  readonly warn: (line: string) => void
}

/** `mkdir "$dir" 2>/dev/null` - non-recursive, so an existing dir is a FAILURE, which is the whole atomicity mechanism. */
const tryMkdirExclusive = (dir: string): boolean => {
  try {
    mkdirSync(dir)
    return true
  } catch {
    return false
  }
}

/** `rm -rf "$dir" 2>/dev/null || true`. */
const removeLockDir = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Best-effort, matching bash's `|| true`.
  }
}

const makeHandle = (lockDir: string): UpdateLockHandle => {
  let held = true
  return {
    lockDir,
    ownerFile: ownerFilePath(lockDir),
    isHeld: () => held,
    release: () => {
      if (!held) return
      removeLockDir(lockDir)
      held = false
    },
  }
}

/**
 * `acquire_update_lock` (scripts/luna-update-server:980-1008), step for step.
 *
 * The ORDER of the two side effects on the readback-failure path is bash's:
 * `rm -rf` first, THEN the warn (:1001-1003). On the contended path the warn
 * comes first and nothing is removed (:983-984) - taking somebody else's lock
 * dir there would be the exact corruption this function prevents.
 *
 * Returns an outcome rather than throwing: all four failures are `return 1` in
 * bash, and the caller turns that into a deliberate exit 0 / exit 4.
 */
export const acquireUpdateLockSync = (opts: AcquireLockOptions): AcquireLockOutcome => {
  const { stateDir, profile, warn } = opts
  const pid = opts.pid ?? process.pid
  const lockDir = updateLockDirPath(stateDir, profile)
  const probes: OwnerProbes = {
    ...(opts.processAlive === undefined ? {} : { processAlive: opts.processAlive }),
    ...(opts.processFingerprint === undefined ? {} : { processFingerprint: opts.processFingerprint }),
  }

  // `mkdir -p "$UPDATE_STATE_DIR"; chmod 700 ... 2>/dev/null || true` (:981-982).
  // This is the ONE place $UPDATE_STATE_DIR is provisioned in the real flow -
  // see atomic-file.ts's ensureStateDir doc, which names this function.
  ensureStateDir(stateDir)

  if (!tryMkdirExclusive(lockDir)) {
    if (lockOwnerAliveSync(lockDir, probes)) {
      warn(lockContendedLine(profile))
      return { acquired: false, reason: "contended" }
    }
    warn(removingStaleLockLine(profile))
    removeLockDir(lockDir)
    if (!tryMkdirExclusive(lockDir)) return { acquired: false, reason: "stale-remkdir-failed" }
  }

  const fingerprint = (opts.processFingerprint ?? processFingerprintSync)(pid)
  if (fingerprint === "") {
    // `{ rm -rf "$UPDATE_LOCK_DIR"; return 1; }` (:992) - silent on purpose:
    // bash emits no warning here, and inventing one would be a divergence in
    // the direction that looks like an improvement.
    removeLockDir(lockDir)
    return { acquired: false, reason: "fingerprint-unavailable" }
  }

  // `( umask 077; printf ... > "$UPDATE_LOCK_DIR/owner" )` (:997). Mode 0600 is
  // what umask 077 produces from the 0666 a `>` redirection creates.
  writeFileSync(ownerFilePath(lockDir), ownerRecordContents(pid, fingerprint), { mode: 0o600 })

  if (!lockOwnerAliveSync(lockDir, probes)) {
    removeLockDir(lockDir)
    warn(OWNERSHIP_UNRECORDABLE_LINE)
    return { acquired: false, reason: "ownership-unrecordable" }
  }

  return { acquired: true, lock: makeHandle(lockDir) }
}

/** `release_update_lock` (scripts/luna-update-server:973-978). Idempotent, and a no-op on a lock that was never held. */
export const releaseUpdateLockSync = (lock: UpdateLockHandle): void => {
  lock.release()
}

/**
 * The half of `trap release_update_lock EXIT INT TERM` (scripts/luna-update-
 * server:1007) that Node can actually honour - see this module's header for why
 * INT/TERM are deliberately NOT wired and what recovers a killed binary.
 *
 * 'uncaughtException' RETHROWS after releasing: merely listening for it
 * suppresses Node's default fatal behaviour, and a lock module that silently
 * turned a crash into a continued run would be a far worse bug than the one it
 * is closing. Returns an uninstaller so a caller that releases normally does
 * not leak listeners across a long-lived process.
 */
export interface ExitHookTarget {
  on(event: string, listener: (...args: never[]) => void): unknown
  removeListener(event: string, listener: (...args: never[]) => void): unknown
}

export const installLockReleaseHooks = (
  lock: UpdateLockHandle,
  target: ExitHookTarget = process as unknown as ExitHookTarget,
): (() => void) => {
  const onExit = (): void => {
    lock.release()
  }
  const onUncaught = (...args: never[]): void => {
    lock.release()
    throw args[0]
  }
  target.on("exit", onExit)
  target.on("uncaughtException", onUncaught)
  return () => {
    target.removeListener("exit", onExit)
    target.removeListener("uncaughtException", onUncaught)
  }
}
