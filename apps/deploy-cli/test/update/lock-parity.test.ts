/**
 * Golden parity for the update lock (S22d PR1): `acquire_update_lock`,
 * `release_update_lock`, `lock_owner_alive` and `process_fingerprint`
 * (scripts/luna-update-server:950-1008), plus the CALLER block that turns a
 * contended acquire into an exit code (:1872-1881).
 *
 * Every scenario extracts the REAL bash functions with awk, evals them into a
 * shell where only the two genuinely un-fakeable collaborators are stubbed -
 * `kill -0` and `process_fingerprint` - and runs the TypeScript port over the
 * same inputs against its own real temp dir. The filesystem is NOT stubbed on
 * either side: an atomic `mkdir` IS the mechanism, so a port proven against a
 * fake fs would prove nothing.
 *
 * WHAT IS COMPARED, AND WHY EACH ONE. Not just the return code:
 *   - the return code (bash rc vs `acquired`), because every caller branches on it;
 *   - the ordered `luna_warn` payloads, byte-exact, because "removing stale
 *     update lock" and "DEFERRED: another update ..." are what an operator
 *     greps for when a host stops deploying;
 *   - the owner file's BYTES (base64, so the trailing newline is in the diff)
 *     and its MODE, because the interop requirement is that bash's own
 *     `lock_owner_alive` reads a record this port wrote, and because `umask
 *     077` is the only thing keeping a pid/starttime fingerprint at 0600;
 *   - the lock dir's presence BEFORE the trap fires and AFTER, which is what
 *     distinguishes "released cleanly" from "leaked a lock that will make the
 *     next run emit a stale-takeover warning";
 *   - the NUMBER of `process_fingerprint` calls, which pins bash's
 *     short-circuit ORDER inside lock_owner_alive. A port that fingerprinted
 *     before testing `kill -0` agrees on every verdict and diverges here.
 *
 * THE 4-vs-3 DISTINCTION IS ITS OWN DESCRIBE BLOCK. `--restart-only` reports
 * lock contention as exit 4 while 3 is the session-guard defer, and the bash
 * comment at :1874-1878 records the incident that bought the distinction: the
 * guardian paged "DEFERRED by session guard" when the real cause was a
 * concurrent update, sending the responder to a false diagnosis. The suite
 * drives the real caller block for both arms and asserts it can never produce
 * a 3.
 *
 * THE STUBS. `kill` is overridden as a shell FUNCTION (functions win over
 * builtins), answering from an explicit alive-pid list, so "the lock owner is
 * dead" and "the owner is us" are both expressible without manufacturing a
 * genuinely dead pid - which is inherently racy, since pids are recycled.
 * `process_fingerprint` answers from a QUEUE (last entry repeating), because a
 * single acquire calls it twice - once to write the record, once for the
 * mandatory self-readback - and the interesting failures are exactly the ones
 * where those two answers differ. The REAL `process_fingerprint` gets its own
 * describe block at the bottom, run against this process's own pid on both
 * drives, which is also where the per-platform /proc-vs-ps branch is pinned.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  EXIT_DEFERRED_BY_SESSION_GUARD,
  EXIT_LOCK_CONTENTION,
  EXIT_LOCK_CONTENTION_RESTART_ONLY,
  OWNERSHIP_UNRECORDABLE_LINE,
  type AcquireFailureReason,
  acquireUpdateLockSync,
  installLockReleaseHooks,
  lockContendedLine,
  lockContentionExitCode,
  lockOwnerAliveSync,
  ownerFilePath,
  ownerRecordContents,
  parseOwnerRecord,
  processAliveSync,
  readProcessFingerprintSync,
  releaseUpdateLockSync,
  removingStaleLockLine,
  updateLockDirPath,
} from "../../src/update/lock.js"
import { cleanupTempDirs, makeTempDir, repoRoot } from "./temp-dirs.js"

/**
 * A single override slot for the ONE path `starttimeFromProcStat` (private to
 * lock.ts) ever reads: `/proc/<pid>/stat`. Every other call through
 * `accessSync`/`readFileSync` - including lock_owner_alive's real owner-file
 * reads elsewhere in this suite - falls through to the real filesystem
 * unchanged, because this darwin dev machine has no `/proc` to read: the
 * `source: "proc"` arm can only be forced open this way, not by writing a real
 * fixture file, which is why this lives beside the mock rather than in a temp
 * dir like every other fixture in this suite.
 *
 * `vi.hoisted` is required, not decorative: `vi.mock`'s factory is hoisted
 * above this file's imports and runs the moment something first imports
 * "node:fs" (lock.ts included), which is before a plain `const` here would
 * have executed.
 */
const procStatOverride = vi.hoisted(() => ({ path: null as string | null, contents: "" }))

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    accessSync: (path: unknown, mode?: unknown) => {
      if (procStatOverride.path !== null && path === procStatOverride.path) return undefined
      return (actual.accessSync as (...a: unknown[]) => unknown)(path, mode)
    },
    readFileSync: (path: unknown, options?: unknown) => {
      if (procStatOverride.path !== null && path === procStatOverride.path) return procStatOverride.contents
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, options)
    },
  }
})

const UPDATE_SERVER = join(repoRoot, "scripts/luna-update-server")

const PROFILE = "stable"
/** The acquiring process on BOTH drives, so the owner records are byte-comparable. */
const SELF_PID = 424242
/** A pid that is never in `alivePids`: the owner of a stale lock. */
const DEAD_PID = 999001

afterEach(cleanupTempDirs)

const tempRoot = (): string => makeTempDir("deploy-cli-lock-parity-")

/** `awk '/^fn()/{f=1} f{print} f && /^}$/{exit}'` - the technique rollback-parity and readiness-parity both use. */
const extractFn = (name: string): string =>
  `eval "$(awk '/^${name}\\(\\)/{f=1} f{print} f && /^}$/{exit}' ${JSON.stringify(UPDATE_SERVER)})"`

/**
 * THE ACQUIRING PID CANNOT BE MADE EQUAL ON BOTH DRIVES: bash's
 * acquire_update_lock writes `$$`, which is the pid of the `bash -c` child, and
 * nothing can pin that. So a scenario names the acquirer SYMBOLICALLY as
 * `@SELF@` - substituted with `$$` when the bash drive seeds its fixture and
 * with SELF_PID when the TS drive seeds its own - and the owner record is
 * compared after the same substitution runs in reverse. The pid VALUE is
 * therefore not what is being diffed (it cannot be), but its position, the
 * field order, the separator and the trailing newline all are.
 */
const SELF_TOKEN = "@SELF@"

interface Scenario {
  /** What sits at $UPDATE_LOCK_DIR before acquire runs; `owner` may contain @SELF@. */
  readonly preexisting: "none" | "empty-dir" | { readonly owner: string }
  /** `process_fingerprint`'s answer queue, last entry repeating. Empty means it always answers "". */
  readonly fingerprints: ReadonlyArray<string>
  /** Whether `kill -0` succeeds for the ACQUIRING process. DEAD_PID is never alive. */
  readonly selfAlive: boolean
}

interface Trace {
  readonly rc: number
  readonly held: boolean
  readonly warnings: ReadonlyArray<string>
  /** Lock dir presence BEFORE the trap / release ran. */
  readonly lockDirPresent: boolean
  readonly lockDirMode: string
  readonly stateDirMode: string
  /** The owner file's text with the acquiring pid folded back to @SELF@, or "absent". */
  readonly ownerText: string
  readonly ownerMode: string
  readonly fingerprintCalls: number
  /** Lock dir presence AFTER the trap / release ran. */
  readonly lockDirPresentAfterRelease: boolean
  /** The pid this drive acquired as. */
  readonly selfPid: number
}

const octalMode = (path: string): string => (statSync(path).mode & 0o7777).toString(8)

const foldSelfPid = (text: string, pid: number): string => text.replace(new RegExp(`^pid=${pid}$`, "m"), `pid=${SELF_TOKEN}`)

const runBash = (s: Scenario): Trace => {
  const root = tempRoot()
  const stateDir = join(root, "update-state")
  const lockDir = updateLockDirPath(stateDir, PROFILE)
  const fpAnswers = join(root, "fp.answers")
  const fpCalls = join(root, "fp.calls")
  writeFileSync(fpAnswers, s.fingerprints.length === 0 ? "" : `${s.fingerprints.join("\n")}\n`)

  const preOwner = s.preexisting === "none" || s.preexisting === "empty-dir" ? "" : s.preexisting.owner
  const script = [
    "set -uo pipefail",
    `PROFILE=${JSON.stringify(PROFILE)}`,
    `UPDATE_STATE_DIR=${JSON.stringify(stateDir)}`,
    `UPDATE_LOCK_DIR=${JSON.stringify(lockDir)}`,
    "UPDATE_LOCK_HELD=false",
    `FPANS=${JSON.stringify(fpAnswers)}`,
    `FPCALLS=${JSON.stringify(fpCalls)}`,
    // The alive list is built AFTER $$ is known, which is the whole reason the
    // fixture is seeded inside the shell rather than from TypeScript.
    `ALIVE=" ${s.selfAlive ? "$$" : ""} "`,
    `PRE=${JSON.stringify(s.preexisting === "none" ? "none" : s.preexisting === "empty-dir" ? "empty-dir" : "owner")}`,
    `PRE_OWNER=${JSON.stringify(preOwner)}`,
    // `%b`, not `%s`: PRE_OWNER arrives through JSON.stringify, so its newlines
    // are BACKSLASH-n escapes, and a double-quoted bash string never expands
    // them. Writing it with %s produced a one-line owner file whose pid field
    // was `12345\nfingerprint=...`, which failed the numeric test and sent
    // every "contended" scenario down the stale-takeover path instead - two
    // implementations of a case that cannot occur, exactly the trap
    // readiness-parity.test.ts's header records for its own /readyz body.
    `if [[ "$PRE" != "none" ]]; then
       mkdir -p "$UPDATE_LOCK_DIR"
       if [[ "$PRE" == "owner" ]]; then
         printf '%b' "\${PRE_OWNER//${SELF_TOKEN}/$$}" > "$UPDATE_LOCK_DIR/owner"
         chmod 600 "$UPDATE_LOCK_DIR/owner"
       fi
     fi`,
    'luna_warn() { printf "WARN:%s\\n" "$*"; }',
    // A shell FUNCTION shadows the `kill` builtin; bash calls it as
    // `kill -0 "$pid"`, so the pid is $2.
    'kill() { case "$ALIVE" in *" $2 "*) return 0 ;; *) return 1 ;; esac; }',
    // Queue-backed process_fingerprint; bash 3.2 safe (no mapfile), because
    // these suites run in the DEFAULT test gate on developer macOS too.
    `process_fingerprint() {
       local n=1 total
       if [[ -f "$FPCALLS" ]]; then n=$(( $(cat "$FPCALLS") + 1 )); fi
       printf '%s' "$n" > "$FPCALLS"
       total=$(wc -l < "$FPANS" | tr -d '[:space:]')
       if [[ "$total" -lt 1 ]]; then return 0; fi
       if [[ "$n" -gt "$total" ]]; then n="$total"; fi
       sed -n "\${n}p" "$FPANS"
     }`,
    'mode_of() { stat -c "%a" "$1" 2>/dev/null || stat -f "%Lp" "$1" 2>/dev/null; }',
    extractFn("lock_owner_alive"),
    extractFn("release_update_lock"),
    extractFn("acquire_update_lock"),
    "acquire_update_lock; rc=$?",
    // Everything below runs BEFORE the EXIT trap, so it observes the held lock.
    'printf "SELFPID:%s\\n" "$$"',
    'printf "RC:%s\\n" "$rc"',
    'printf "HELD:%s\\n" "$UPDATE_LOCK_HELD"',
    'if [[ -d "$UPDATE_LOCK_DIR" ]]; then printf "LOCKDIR:present\\n"; printf "LOCKMODE:%s\\n" "$(mode_of "$UPDATE_LOCK_DIR")"; else printf "LOCKDIR:absent\\nLOCKMODE:absent\\n"; fi',
    'printf "STATEMODE:%s\\n" "$(mode_of "$UPDATE_STATE_DIR")"',
    'if [[ -f "$UPDATE_LOCK_DIR/owner" ]]; then printf "OWNERB64:%s\\n" "$(base64 < "$UPDATE_LOCK_DIR/owner" | tr -d "\\n")"; printf "OWNERMODE:%s\\n" "$(mode_of "$UPDATE_LOCK_DIR/owner")"; else printf "OWNERB64:absent\\nOWNERMODE:absent\\n"; fi',
    'if [[ -f "$FPCALLS" ]]; then printf "FPCALLS:%s\\n" "$(cat "$FPCALLS")"; else printf "FPCALLS:0\\n"; fi',
  ].join("\n")

  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" })
  const out = (r.stdout ?? "").split("\n").filter((l) => l !== "")
  const field = (prefix: string): string => {
    const line = out.find((l) => l.startsWith(prefix))
    return line === undefined ? "" : line.slice(prefix.length)
  }
  const selfPid = Number(field("SELFPID:"))
  const ownerB64 = field("OWNERB64:")
  return {
    // The script's own exit status is the last printf's, never the acquire's -
    // reading `r.status` here would silently assert 0 for every scenario.
    rc: Number(field("RC:")),
    held: field("HELD:") === "true",
    warnings: out.filter((l) => l.startsWith("WARN:")).map((l) => l.slice("WARN:".length)),
    lockDirPresent: field("LOCKDIR:") === "present",
    lockDirMode: field("LOCKMODE:"),
    stateDirMode: field("STATEMODE:"),
    ownerText: ownerB64 === "absent" ? "absent" : foldSelfPid(Buffer.from(ownerB64, "base64").toString("utf8"), selfPid),
    ownerMode: field("OWNERMODE:"),
    fingerprintCalls: Number(field("FPCALLS:")),
    lockDirPresentAfterRelease: existsSync(lockDir),
    selfPid,
  }
}

const runTs = (s: Scenario): Trace & { readonly reason: AcquireFailureReason | null } => {
  const root = tempRoot()
  const stateDir = join(root, "update-state")
  const lockDir = updateLockDirPath(stateDir, PROFILE)
  if (s.preexisting !== "none") {
    mkdirSync(lockDir, { recursive: true })
    if (s.preexisting !== "empty-dir") {
      writeFileSync(ownerFilePath(lockDir), s.preexisting.owner.split(SELF_TOKEN).join(String(SELF_PID)), { mode: 0o600 })
    }
  }

  const warnings: string[] = []
  let calls = 0
  const fingerprint = (): string => {
    calls += 1
    if (s.fingerprints.length === 0) return ""
    const idx = Math.min(calls, s.fingerprints.length) - 1
    return s.fingerprints[idx] ?? ""
  }

  const outcome = acquireUpdateLockSync({
    stateDir,
    profile: PROFILE,
    pid: SELF_PID,
    processAlive: (pid) => s.selfAlive && pid === SELF_PID,
    processFingerprint: fingerprint,
    warn: (line) => {
      warnings.push(line)
    },
  })

  const ownerFile = ownerFilePath(lockDir)
  const hasOwner = existsSync(ownerFile)
  const trace = {
    rc: outcome.acquired ? 0 : 1,
    held: outcome.acquired ? outcome.lock.isHeld() : false,
    warnings,
    lockDirPresent: existsSync(lockDir),
    lockDirMode: existsSync(lockDir) ? octalMode(lockDir) : "absent",
    stateDirMode: octalMode(stateDir),
    ownerText: hasOwner ? foldSelfPid(readFileSync(ownerFile, "utf8"), SELF_PID) : "absent",
    ownerMode: hasOwner ? octalMode(ownerFile) : "absent",
    fingerprintCalls: calls,
    reason: outcome.acquired ? null : outcome.reason,
    selfPid: SELF_PID,
  }
  // The trap analog: bash's `trap release_update_lock EXIT` fires after the
  // observations above, so the port releases at exactly the same point.
  if (outcome.acquired) releaseUpdateLockSync(outcome.lock)
  return { ...trace, lockDirPresentAfterRelease: existsSync(lockDir) }
}

const ownerRecord = (pid: number | string, fingerprint: string): string => `pid=${pid}\nfingerprint=${fingerprint}\n`

const parity = (
  name: string,
  s: Scenario,
  expected: { readonly rc: number; readonly reason: AcquireFailureReason | null },
): void => {
  it(name, () => {
    const bash = runBash(s)
    const ts = runTs(s)

    expect(bash.rc, `bash warnings: ${bash.warnings.join(" | ")}`).toBe(expected.rc)
    expect(ts.rc).toBe(expected.rc)
    expect(ts.reason).toBe(expected.reason)

    // Byte-exact, in order: this is what an operator reads.
    expect(ts.warnings).toEqual(bash.warnings)
    expect(ts.held).toBe(bash.held)
    expect(ts.lockDirPresent).toBe(bash.lockDirPresent)
    expect(ts.lockDirMode).toBe(bash.lockDirMode)
    expect(ts.stateDirMode).toBe(bash.stateDirMode)
    // The owner record's text, trailing newline included, with only the
    // un-pinnable pid folded to @SELF@ - bash's own lock_owner_alive has to be
    // able to read what this port wrote.
    expect(ts.ownerText).toBe(bash.ownerText)
    expect(ts.ownerMode).toBe(bash.ownerMode)
    // Pins lock_owner_alive's short-circuit ORDER, not just its verdict.
    expect(ts.fingerprintCalls).toBe(bash.fingerprintCalls)
    // Released (or never taken) on both drives: a leaked lock makes the NEXT
    // run emit a stale-takeover warning bash would never have emitted.
    expect(ts.lockDirPresentAfterRelease).toBe(bash.lockDirPresentAfterRelease)
  })
}

describe("updateLockDirPath", () => {
  it("names the lock dir 'lock-<profile>', matching UPDATE_LOCK_DIR=\"$UPDATE_STATE_DIR/lock-$PROFILE\" (scripts/luna-update-server:935)", () => {
    // The golden-parity scenarios above never independently check this: both
    // drives are handed the SAME path computed by this function (see runBash's
    // header comment), so a wrong literal here would silently rename the lock
    // dir on both sides at once instead of breaking parity. This is the one
    // place the literal itself is pinned.
    expect(updateLockDirPath("/tmp/update-state", "stable")).toBe(join("/tmp/update-state", "lock-stable"))
    expect(updateLockDirPath("/tmp/update-state", "dev")).toBe(join("/tmp/update-state", "lock-dev"))
  })
})

describe("acquire_update_lock: golden parity with scripts/luna-update-server", () => {
  parity(
    "uncontended: takes the lock, writes a 0600 owner record, releases on exit",
    { preexisting: "none", fingerprints: ["FP-SELF"], selfAlive: true },
    { rc: 0, reason: null },
  )

  parity(
    "contended by a LIVE owner: warns DEFERRED, returns 1, leaves the other run's lock alone",
    {
      preexisting: { owner: ownerRecord(SELF_TOKEN, "FP-OWNER") },
      fingerprints: ["FP-OWNER"],
      selfAlive: true,
    },
    { rc: 1, reason: "contended" },
  )

  parity(
    "stale because the owner pid is dead: warns, takes over, succeeds",
    {
      preexisting: { owner: ownerRecord(DEAD_PID, "FP-DEAD") },
      fingerprints: ["FP-SELF"],
      selfAlive: true,
    },
    { rc: 0, reason: null },
  )

  parity(
    "stale because the pid was RECYCLED (alive, different starttime): takes over",
    {
      preexisting: { owner: ownerRecord(SELF_TOKEN, "FP-OLD") },
      fingerprints: ["FP-NEW"],
      selfAlive: true,
    },
    { rc: 0, reason: null },
  )

  parity(
    "stale because the lock dir has no owner file at all: takes over",
    { preexisting: "empty-dir", fingerprints: ["FP-SELF"], selfAlive: true },
    { rc: 0, reason: null },
  )

  parity(
    "stale because the owner pid is not numeric: takes over without fingerprinting",
    {
      preexisting: { owner: "pid=not-a-pid\nfingerprint=FP-OWNER\n" },
      fingerprints: ["FP-SELF"],
      selfAlive: true,
    },
    { rc: 0, reason: null },
  )

  parity(
    "stale because the record is a partial pid-without-fingerprint write: takes over",
    { preexisting: { owner: `pid=${SELF_TOKEN}\n` }, fingerprints: ["FP-SELF"], selfAlive: true },
    { rc: 0, reason: null },
  )

  parity(
    "own fingerprint unavailable: removes the lock and defers SILENTLY (bash emits no warning here)",
    { preexisting: "none", fingerprints: [], selfAlive: true },
    { rc: 1, reason: "fingerprint-unavailable" },
  )

  parity(
    "self-readback fails because the fingerprint moved under us: removes the lock, warns, defers",
    { preexisting: "none", fingerprints: ["FP-A", "FP-B"], selfAlive: true },
    { rc: 1, reason: "ownership-unrecordable" },
  )

  parity(
    "self-readback fails because kill -0 rejects our own pid: removes the lock, warns, defers",
    { preexisting: "none", fingerprints: ["FP-SELF"], selfAlive: false },
    { rc: 1, reason: "ownership-unrecordable" },
  )

  it("stale-remkdir-failed: a losing retry mkdir defers instead of silently continuing (bash :988 `mkdir \"$UPDATE_LOCK_DIR\" || return 1`)", () => {
    const root = tempRoot()
    const stateDir = join(root, "update-state")
    const lockDir = updateLockDirPath(stateDir, PROFILE)
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(ownerFilePath(lockDir), ownerRecord(DEAD_PID, "FP-DEAD"), { mode: 0o600 })
    // Deny write on the lock dir itself so the stale-takeover `rm -rf` cannot
    // unlink the owner file inside it (matching bash's `rm -rf ... || true`
    // swallowing a permission failure): the directory survives, so the retry
    // `mkdir` collides with the very dir it was supposed to have cleared.
    chmodSync(lockDir, 0o500)
    try {
      const outcome = acquireUpdateLockSync({
        stateDir,
        profile: PROFILE,
        pid: SELF_PID,
        processAlive: () => false, // DEAD_PID is never alive -> classified stale
        processFingerprint: () => "FP-SELF",
        warn: () => {},
      })
      expect(outcome).toEqual({ acquired: false, reason: "stale-remkdir-failed" })
      // The lock this run could not clear is still there for the next attempt,
      // not silently treated as ours.
      expect(existsSync(lockDir)).toBe(true)
      expect(existsSync(ownerFilePath(lockDir))).toBe(true)
    } finally {
      // Restore write permission so this suite's own temp-dir cleanup can remove it.
      chmodSync(lockDir, 0o700)
    }
  })

  it("readback failure: removes the lock dir BEFORE warning, not after (bash :1001-1003 removes first)", () => {
    const root = tempRoot()
    const stateDir = join(root, "update-state")
    const lockDir = updateLockDirPath(stateDir, PROFILE)
    let lockDirGoneWhenWarned: boolean | null = null
    let fingerprintCalls = 0
    const outcome = acquireUpdateLockSync({
      stateDir,
      profile: PROFILE,
      pid: SELF_PID,
      processAlive: () => true,
      // First answer (the write) differs from the second (the mandatory
      // self-readback), so `lock_owner_alive` rejects the record we just wrote.
      processFingerprint: () => {
        fingerprintCalls += 1
        return fingerprintCalls === 1 ? "FP-A" : "FP-B"
      },
      warn: (line) => {
        // Captured AT THE MOMENT warn fires - if the swap mutation ran, the
        // lock dir would still be present here because the removal would not
        // have happened yet.
        if (line === OWNERSHIP_UNRECORDABLE_LINE) lockDirGoneWhenWarned = !existsSync(lockDir)
      },
    })
    expect(outcome).toEqual({ acquired: false, reason: "ownership-unrecordable" })
    expect(lockDirGoneWhenWarned, "the lock dir must already be gone by the time the warn fires").toBe(true)
  })

  it("the three warn payloads are byte-exact against the bash that produced them", () => {
    const contended = runBash({
      preexisting: { owner: ownerRecord(SELF_TOKEN, "FP-OWNER") },
      fingerprints: ["FP-OWNER"],
      selfAlive: true,
    })
    expect(contended.warnings).toEqual([lockContendedLine(PROFILE)])

    const stale = runBash({
      preexisting: { owner: ownerRecord(DEAD_PID, "FP-DEAD") },
      fingerprints: ["FP-SELF"],
      selfAlive: true,
    })
    expect(stale.warnings).toEqual([removingStaleLockLine(PROFILE)])

    const unrecordable = runBash({ preexisting: "none", fingerprints: ["FP-A", "FP-B"], selfAlive: true })
    expect(unrecordable.warnings).toEqual([OWNERSHIP_UNRECORDABLE_LINE])
  })

  it("writes the owner record bash's printf would have written, byte for byte", () => {
    const bash = runBash({ preexisting: "none", fingerprints: ["FP-SELF"], selfAlive: true })
    // ownerRecordContents is the port's own formatter, driven with the pid the
    // bash child actually ran as - so this is a byte comparison of the real
    // `printf 'pid=%s\nfingerprint=%s\n'` output, trailing newline included.
    expect(bash.ownerText).toBe(foldSelfPid(ownerRecordContents(bash.selfPid, "FP-SELF"), bash.selfPid))
    expect(bash.ownerMode).toBe("600")
  })
})

describe("release_update_lock", () => {
  it("is idempotent and never removes a lock it does not hold", () => {
    const root = tempRoot()
    const stateDir = join(root, "update-state")
    const outcome = acquireUpdateLockSync({
      stateDir,
      profile: PROFILE,
      pid: SELF_PID,
      processAlive: () => true,
      processFingerprint: () => "FP",
      warn: () => {},
    })
    expect(outcome.acquired).toBe(true)
    if (!outcome.acquired) return
    const lockDir = outcome.lock.lockDir
    releaseUpdateLockSync(outcome.lock)
    expect(existsSync(lockDir)).toBe(false)
    expect(outcome.lock.isHeld()).toBe(false)

    // A second run takes the lock; the FIRST handle's release must not touch it.
    const second = acquireUpdateLockSync({
      stateDir,
      profile: PROFILE,
      pid: SELF_PID,
      processAlive: () => true,
      processFingerprint: () => "FP",
      warn: () => {},
    })
    expect(second.acquired).toBe(true)
    releaseUpdateLockSync(outcome.lock)
    expect(existsSync(lockDir), "the stale handle must not delete the new owner's lock").toBe(true)
  })

  it("wires only the hooks Node dispatches synchronously; INT/TERM are a documented divergence", () => {
    const registered: string[] = []
    const removed: string[] = []
    const listeners = new Map<string, (...args: never[]) => void>()
    const target = {
      on(event: string, listener: (...args: never[]) => void): void {
        registered.push(event)
        listeners.set(event, listener)
      },
      removeListener(event: string): void {
        removed.push(event)
      },
    }
    const root = tempRoot()
    const outcome = acquireUpdateLockSync({
      stateDir: join(root, "update-state"),
      profile: PROFILE,
      pid: SELF_PID,
      processAlive: () => true,
      processFingerprint: () => "FP",
      warn: () => {},
    })
    expect(outcome.acquired).toBe(true)
    if (!outcome.acquired) return

    const uninstall = installLockReleaseHooks(outcome.lock, target)
    expect(registered).toEqual(["exit", "uncaughtException"])
    // Bash traps INT and TERM too; a synchronous body spanning a 6s settle and
    // a 60s readiness poll never yields to them, so they are NOT wired and the
    // next run's stale takeover is the recovery. See lock.ts's header.
    expect(registered).not.toContain("SIGINT")
    expect(registered).not.toContain("SIGTERM")

    const onExit = listeners.get("exit")
    expect(onExit).toBeDefined()
    onExit?.()
    expect(existsSync(outcome.lock.lockDir)).toBe(false)

    uninstall()
    expect(removed).toEqual(["exit", "uncaughtException"])
  })

  it("uncaughtException releases the lock and RETHROWS - it must never swallow the crash", () => {
    const listeners = new Map<string, (...args: never[]) => void>()
    const target = {
      on(event: string, listener: (...args: never[]) => void): void {
        listeners.set(event, listener)
      },
      removeListener(): void {},
    }
    const root = tempRoot()
    const outcome = acquireUpdateLockSync({
      stateDir: join(root, "update-state"),
      profile: PROFILE,
      pid: SELF_PID,
      processAlive: () => true,
      processFingerprint: () => "FP",
      warn: () => {},
    })
    expect(outcome.acquired).toBe(true)
    if (!outcome.acquired) return

    installLockReleaseHooks(outcome.lock, target)
    const onUncaught = listeners.get("uncaughtException") as ((err: unknown) => void) | undefined
    expect(onUncaught).toBeDefined()

    const boom = new Error("boom")
    // Merely listening for 'uncaughtException' suppresses Node's default fatal
    // behaviour, so a handler that released the lock and then swallowed the
    // error would be a far worse bug than the one this module closes - see the
    // header's note on this. It must rethrow the SAME error object.
    expect(() => onUncaught?.(boom)).toThrow(boom)
    expect(existsSync(outcome.lock.lockDir), "the lock must still be released even though the handler rethrows").toBe(
      false,
    )
  })
})

describe("lock_owner_alive: the owner record reader", () => {
  const runBashOwnerAlive = (owner: string | null, alivePids: ReadonlyArray<number>, fingerprint: string): number => {
    const root = tempRoot()
    const lockDir = join(root, "lock-stable")
    mkdirSync(lockDir, { recursive: true })
    if (owner !== null) writeFileSync(ownerFilePath(lockDir), owner, { mode: 0o600 })
    const script = [
      "set -uo pipefail",
      `UPDATE_LOCK_DIR=${JSON.stringify(lockDir)}`,
      `ALIVE=${JSON.stringify(` ${alivePids.join(" ")} `)}`,
      'kill() { case "$ALIVE" in *" $2 "*) return 0 ;; *) return 1 ;; esac; }',
      `process_fingerprint() { printf '%s' ${JSON.stringify(fingerprint)}; }`,
      extractFn("lock_owner_alive"),
      "lock_owner_alive; rc=$?",
      'printf "RC:%s\\n" "$rc"',
      // The dir is handed back so the TS drive reads the SAME bytes.
      `printf "DIR:%s\\n" ${JSON.stringify(lockDir)}`,
    ].join("\n")
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8" })
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RC:"))
    // The TS drive runs against the identical directory, so any divergence is
    // in the reader, not in the fixture.
    const tsVerdict = lockOwnerAliveSync(lockDir, {
      processAlive: (pid) => alivePids.includes(pid),
      processFingerprint: () => fingerprint,
    })
    expect(tsVerdict, "TS verdict disagrees with bash lock_owner_alive").toBe(line === "RC:0")
    return line === "RC:0" ? 0 : 1
  }

  it("accepts a well-formed live record", () => {
    expect(runBashOwnerAlive(ownerRecord(SELF_PID, "FP"), [SELF_PID], "FP")).toBe(0)
  })

  it("rejects an absent owner file", () => {
    expect(runBashOwnerAlive(null, [SELF_PID], "FP")).toBe(1)
  })

  it("rejects a changed fingerprint (the recycled-pid case the whole design exists for)", () => {
    expect(runBashOwnerAlive(ownerRecord(SELF_PID, "FP-OLD"), [SELF_PID], "FP-NEW")).toBe(1)
  })

  it("rejects an empty CURRENT fingerprint even when the record's matches nothing", () => {
    expect(runBashOwnerAlive(ownerRecord(SELF_PID, ""), [SELF_PID], "")).toBe(1)
  })

  it("takes the FIRST pid line, matching `sed ... | head -1` and not a last-wins parser", () => {
    // A last-wins reader would resolve 999001 (dead) and answer 1 here.
    const owner = `pid=${SELF_PID}\npid=${DEAD_PID}\nfingerprint=FP\n`
    expect(runBashOwnerAlive(owner, [SELF_PID], "FP")).toBe(0)
  })

  it("reads a final line that has no trailing newline, matching sed and not `read`", () => {
    expect(runBashOwnerAlive(`pid=${SELF_PID}\nfingerprint=FP`, [SELF_PID], "FP")).toBe(0)
  })

  it("keeps everything after the FIRST '=' in a fingerprint value", () => {
    expect(runBashOwnerAlive(`pid=${SELF_PID}\nfingerprint=a=b\n`, [SELF_PID], "a=b")).toBe(0)
  })
})

describe("parseOwnerRecord", () => {
  it("is first-wins per key, unlike atomic-file.ts's last-wins load_transaction reader", () => {
    expect(parseOwnerRecord("pid=1\npid=2\nfingerprint=a\nfingerprint=b\n")).toEqual({ pid: "1", fingerprint: "a" })
  })

  it("returns empty strings for a record missing either field", () => {
    expect(parseOwnerRecord("pid=1\n")).toEqual({ pid: "1", fingerprint: "" })
    expect(parseOwnerRecord("")).toEqual({ pid: "", fingerprint: "" })
  })
})

describe("the contention exit code the CALLER derives (scripts/luna-update-server:1872-1881)", () => {
  const callerBlock = (): string => {
    const r = spawnSync(
      "bash",
      ["-c", `awk '/^if ! acquire_update_lock; then$/{f=1} f{print} f && /^fi$/{exit}' ${JSON.stringify(UPDATE_SERVER)}`],
      { encoding: "utf8" },
    )
    const block = r.stdout ?? ""
    expect(block, "the caller block could not be extracted; has luna-update-server moved it?").toContain(
      "acquire_update_lock",
    )
    return block
  }

  const runCaller = (restartOnly: boolean): number => {
    const script = [
      "set -uo pipefail",
      `RESTART_ONLY=${restartOnly}`,
      // Contention: the real function's `return 1`.
      "acquire_update_lock() { return 1; }",
      callerBlock(),
      // Only reached if the block did not exit, which would itself be a defect.
      "exit 99",
    ].join("\n")
    return spawnSync("bash", ["-c", script], { encoding: "utf8" }).status ?? -1
  }

  it("exits 0 on a normal run: contention is a safe defer and the timer retries", () => {
    expect(runCaller(false)).toBe(EXIT_LOCK_CONTENTION)
    expect(lockContentionExitCode(false)).toBe(EXIT_LOCK_CONTENTION)
  })

  it("exits 4 under --restart-only", () => {
    expect(runCaller(true)).toBe(EXIT_LOCK_CONTENTION_RESTART_ONLY)
    expect(lockContentionExitCode(true)).toBe(EXIT_LOCK_CONTENTION_RESTART_ONLY)
  })

  it("EXIT_DEFERRED_BY_SESSION_GUARD is the value the REAL session guard defer exits with", () => {
    // Extracts the actual `if ! restart_session_guard; then ... exit 3; fi`
    // block (scripts/luna-update-server:1948-1951) with the same
    // awk-to-matching-brace technique extractFn uses for whole functions, and
    // runs it for real with the guard stubbed to refuse - this pins the
    // CONSTANT to bash's own behavior, not to a second copy of the literal.
    const block = spawnSync(
      "bash",
      [
        "-c",
        `awk '/^    if ! restart_session_guard; then$/{f=1} f{print} f && /^    fi$/{exit}' ${JSON.stringify(UPDATE_SERVER)}`,
      ],
      { encoding: "utf8" },
    ).stdout ?? ""
    expect(block, "the session-guard defer block could not be extracted; has luna-update-server moved it?").toContain(
      "restart_session_guard",
    )
    const script = [
      "set -uo pipefail",
      'TX_PHASE="restarting"',
      "restart_session_guard() { return 1; }",
      'luna_warn() { :; }',
      block,
      "exit 99",
    ].join("\n")
    const rc = spawnSync("bash", ["-c", script], { encoding: "utf8" }).status
    expect(rc).toBe(EXIT_DEFERRED_BY_SESSION_GUARD)
  })

  it("never reports contention as 3, which is the SESSION-GUARD defer", () => {
    // Conflating the two made the guardian page "DEFERRED by session guard"
    // while the real cause was a concurrent update holding the profile lock -
    // a false diagnosis for whoever is responding. The bash comment at
    // :1874-1878 records exactly that incident.
    expect(EXIT_LOCK_CONTENTION_RESTART_ONLY).not.toBe(EXIT_DEFERRED_BY_SESSION_GUARD)
    expect(callerBlock()).not.toMatch(/\bexit 3\b/)
    expect(runCaller(true)).not.toBe(EXIT_DEFERRED_BY_SESSION_GUARD)
    expect(runCaller(false)).not.toBe(EXIT_DEFERRED_BY_SESSION_GUARD)
  })
})

describe("process_fingerprint: the REAL probe, against this process's own pid", () => {
  const bashFingerprint = (pid: number): string => {
    const script = [
      "set -uo pipefail",
      extractFn("process_fingerprint"),
      `printf '%s' "$(process_fingerprint ${pid})"`,
    ].join("\n")
    return spawnSync("bash", ["-c", script], { encoding: "utf8" }).stdout ?? ""
  }

  it("agrees with the bash function byte for byte", () => {
    const reading = readProcessFingerprintSync(process.pid)
    expect(reading.fingerprint).toBe(bashFingerprint(process.pid))
    expect(reading.fingerprint, "a live process must fingerprint to something").not.toBe("")
  })

  it("takes the branch this platform actually has, so neither arm silently stops being covered", () => {
    const reading = readProcessFingerprintSync(process.pid)
    const hasProc = existsSync(`/proc/${process.pid}/stat`)
    expect(reading.source).toBe(hasProc ? "proc" : "ps")
    if (process.platform === "linux") expect(reading.source).toBe("proc")
    if (process.platform === "darwin") expect(reading.source).toBe("ps")
  })

  it("answers the empty string for a pid it cannot see, on both drives", () => {
    // Not asserted as "dead" - pids are recycled - but as AGREEMENT: whatever
    // this pid is, both implementations must say the same thing about it.
    expect(readProcessFingerprintSync(DEAD_PID).fingerprint).toBe(bashFingerprint(DEAD_PID))
  })
})

describe("starttimeFromProcStat (private to lock.ts, exercised through readProcessFingerprintSync's /proc arm)", () => {
  afterEach(() => {
    procStatOverride.path = null
    procStatOverride.contents = ""
  })

  it("takes field 20 of the comm-stripped remainder via the GREEDY strip, not field 1 via a lazy one", () => {
    const pid = 555555
    const statPath = `/proc/${pid}/stat`
    // The comm field contains ") " on purpose: a LAZY `^.*?\) ` would stop at
    // the first ") " (right after the comm), leaving a leading "X)" token that
    // shifts every field index by one. The greedy `^.*\) ` bash actually uses
    // strips through the LAST ") " instead, matching a comm that legally
    // contains parens and spaces (comm is arbitrary bytes up to 15 of them).
    const remainder = "S 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 STARTTIME_MARK"
    procStatOverride.path = statPath
    procStatOverride.contents = `${pid} (COMM) X) ${remainder}\n`

    const reading = readProcessFingerprintSync(pid)
    expect(reading.source).toBe("proc")
    // fields[19] of the greedy-stripped remainder is STARTTIME_MARK. The
    // fields[0]-after-lazy-strip mutation instead yields "X)" - the leftover
    // token the lazy match failed to consume.
    expect(reading.fingerprint).toBe("STARTTIME_MARK")
  })

  it("yields the empty string, not a wrong field, when fewer than 20 fields remain (awk printing an unset $20)", () => {
    const pid = 555556
    const statPath = `/proc/${pid}/stat`
    procStatOverride.path = statPath
    procStatOverride.contents = `${pid} (COMM) S 1 1 1\n`
    expect(readProcessFingerprintSync(pid)).toEqual({ fingerprint: "", source: "proc" })
  })
})

describe("processAliveSync", () => {
  const bashKill0 = (pid: number): boolean =>
    (spawnSync("bash", ["-c", `kill -0 ${pid} 2>/dev/null`], { encoding: "utf8" }).status ?? 1) === 0

  it("agrees with `kill -0` about this process", () => {
    expect(processAliveSync(process.pid)).toBe(true)
    expect(processAliveSync(process.pid)).toBe(bashKill0(process.pid))
  })

  it("agrees with `kill -0` about a pid this test does not own", () => {
    expect(processAliveSync(DEAD_PID)).toBe(bashKill0(DEAD_PID))
  })
})
