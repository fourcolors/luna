/**
 * The exit-code contract of `deploy-cli update`, as one readable suite.
 *
 * WHAT IS BEING DEFENDED. Five numbers are a contract with three separate
 * consumers - packages/server-registry/src/driver/luna-chat-server.ts,
 * scripts/luna-autodeploy's rc `case`, and an operator's shell - and two of
 * them are routinely confused with each other. 3 means "the session guard
 * deferred: there are live or unknown sessions". 4 means "another update holds
 * the profile lock". Conflating them makes an on-call responder hunt for
 * phantom live sessions while a concurrent deploy is the real cause, which is
 * the exact incident the bash comment at scripts/luna-update-server:1872-1878
 * exists to prevent. So this file keeps the FOUR session-guard defer sites
 * distinct from the TWO lock sites, by name, rather than asserting "3 happens
 * somewhere".
 *
 * IT DRIVES `runUpdate` IN PROCESS, with a fully injected `UpdateIo` and a
 * fixture-rooted state directory. That is the only level at which the
 * ORDERING invariants below are checkable at all, because they are statements
 * about what has and has not happened yet when a given code is returned:
 * delegation strictly before lock acquisition, no lock on any refusal path, no
 * lock left behind on ANY terminal including exit 2 and exit 3.
 *
 * PORTABILITY. No spawn, no host binary, no platform branch, no symlink. The
 * only real filesystem is the per-test temp state dir, which is where the lock
 * and journal deliberately live (wiring.ts's header states that exception).
 * `process.getuid` is never called: `UpdateIo.uid` is a stub like every other
 * boundary.
 *
 * ONE ROW IS ASSERTED AT THE TERMINAL LEVEL RATHER THAN END TO END, and it is
 * named here rather than quietly skipped: `acquireUpdateLockSync`'s
 * `stale-remkdir-failed` reason needs a `mkdir` inside the state dir to fail
 * while the preceding `rm -rf` succeeds, which portably requires an unwritable
 * parent - and mode bits do not stop root, which is who this engine runs as on
 * every real host, nor do they mean the same thing on Windows, where `tsc` and
 * a stray unit test can still run. terminals.test.ts already proves the
 * mapping over the whole `Terminal` union; what this file adds for the OTHER
 * two non-contended reasons is that `run-update.ts` actually CONSTRUCTS the
 * `lock-unacquirable` terminal rather than declaring it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { forwardedFlags } from "../../src/update/delegate.js"
import { ownerRecordContents } from "../../src/update/lock.js"
import { runUpdate } from "../../src/update/run-update.js"
import type { CommandResult, SpawnOptions } from "../../src/update/target.js"
import type { UpdateIo } from "../../src/update/wiring.js"
import { cleanupTempDirs, makeTempDir } from "./temp-dirs.js"
import { makeCapturedSeams, makeEnv, makeStubIo } from "./update-io-doubles.js"

afterAll(cleanupTempDirs)

// BUILT rather than written out: the secret-scan CI gate bans any 40-character
// hex run in a tracked file, because that is the shape of a leaked token. Two
// obviously-fake git shas are indistinguishable from one to a scanner.
const PREV = "a".repeat(40)
const TARGET = "b".repeat(40)
const PROFILE = "fixture"
const SERVICE = `luna-${PROFILE}-chat-server.service`

/** The pid `UpdateIo.pid` reports for this process, and the one a contended lock must NOT be. */
const SELF_PID = 4242
const OTHER_PID = 9999
const OTHER_FINGERPRINT = "another-deploy-is-running"

interface EngineOptions {
  /** Shas whose /healthz answers 500. Everything else answers 200. */
  readonly unhealthy?: ReadonlySet<string>
  /** `systemctl start`'s status, for the restart-failure rows. */
  readonly startStatus?: number
  /**
   * Shas whose `git reset --hard` fails, for the apply-failure rows. A set
   * rather than a flat status because the ROLLBACK issues a reset too: failing
   * both turns an apply-phase failure into a CRITICAL and the row under test
   * would never reach the rollback restart at all.
   */
  readonly resetFailsFor?: ReadonlySet<string>
}

interface Engine {
  readonly spawnTarget: (argv: ReadonlyArray<string>, opts: SpawnOptions) => CommandResult
  /** What the checkout currently says HEAD is; `reset --hard` moves it. */
  head: () => string
}

/**
 * The whole world outside the binary, as one argv dispatcher.
 *
 * Every subprocess this transaction can issue arrives at `UpdateIo.spawnTarget`
 * FULLY RESOLVED - already `incus exec`-wrapped, already carrying git's `-C`
 * prefix (target.ts:125) - so dispatching on the argv is dispatching on exactly
 * what would have run. Nothing here shells out; the "checkout" is one mutable
 * string.
 */
const makeEngine = (opts: EngineOptions = {}): Engine => {
  let head = PREV
  // Distinct MainPIDs per read, so the restart's postcondition sees the
  // process replaced (:1560-1564 fails only when they are equal and non-zero).
  let mainPid = 100
  const unhealthy = opts.unhealthy ?? new Set<string>()
  const ok = (stdout = ""): CommandResult => ({ status: 0, stdout })

  return {
    head: () => head,
    spawnTarget: (argv) => {
      const [cmd, ...rest] = argv
      if (cmd === "git") {
        // gitArgv puts `-C <hostRepoDir>` (or `--git-dir`) before the subcommand.
        const sub = rest.slice(2)
        if (sub[0] === "rev-parse" && sub[1] === "HEAD") return ok(`${head}\n`)
        if (sub[0] === "rev-parse") return ok(`${TARGET}\n`)
        if (sub[0] === "fetch") return ok()
        if (sub[0] === "reset") {
          const wanted = sub[2] ?? ""
          if (opts.resetFailsFor?.has(wanted) === true) return { status: 1, stdout: "" }
          head = wanted
          return ok()
        }
        // `lockfile_hash`'s `git -C <repo> hash-object <repo>/bun.lock`: one
        // stable blob id, so the lockfile gate reports "unchanged" and no
        // `bun install` runs on the happy path.
        if (sub[0] === "hash-object") return ok("c".repeat(40))
        return ok()
      }
      if (cmd === "systemctl") {
        const args = rest[0] === "--user" ? rest.slice(1) : rest
        if (args[0] === "is-active") return ok("active\n")
        if (args[0] === "show" && args.includes("--property=NRestarts")) return ok("0\n")
        if (args[0] === "show" && args.includes("--property=MainPID")) {
          mainPid += 1
          return ok(`${mainPid}\n`)
        }
        if (args[0] === "start") return { status: opts.startStatus ?? 0, stdout: "" }
        // `is-failed` returning non-zero is what makes a failed start terminal
        // rather than start-limit-latched.
        if (args[0] === "is-failed") return { status: 1, stdout: "" }
        return ok()
      }
      if (cmd === "curl") {
        const url = argv[argv.length - 1] ?? ""
        if (url.endsWith("/healthz")) return ok(unhealthy.has(head) ? "500" : "200")
        if (url.endsWith("/readyz")) return ok(`{"mode":"normal","buildSha":"${head}"}\n200`)
        return ok()
      }
      return ok()
    },
  }
}

/**
 * `luna_validate_profile`, `luna_find_bun`, `luna_env_value` and
 * `luna_configure_claude_executable`, dispatched on the script text bash-lib
 * builds. All four succeed; the rows that need a refusal override this seam.
 */
const stubRunBash: UpdateIo["runBash"] = (call) => {
  if (call.script.includes("luna_find_bun")) return { status: 0, stdout: "/fixture/bun\n", stderr: "" }
  return { status: 0, stdout: "", stderr: "" }
}

interface DriveOptions {
  readonly argv?: ReadonlyArray<string>
  readonly engine?: EngineOptions
  readonly io?: Partial<UpdateIo>
  /** Established websocket counts, consumed one per guard evaluation. The last value repeats. */
  readonly sessions?: ReadonlyArray<number>
  /** Written to the journal before the run. */
  readonly journal?: string
  /** Pre-create a lock dir owned by a live OTHER process. */
  readonly contendedLock?: boolean
}

interface DriveResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly lockExists: boolean
  readonly journalExists: boolean
  readonly journalPhase: string | null
  readonly head: string
}

const drive = (options: DriveOptions = {}): DriveResult => {
  const stateDir = makeTempDir("luna-exitcode-")
  const repoDir = makeTempDir("luna-exitcode-repo-")
  const lunaHome = makeTempDir("luna-exitcode-home-")
  const lockDir = join(stateDir, `lock-${PROFILE}`)
  const journalPath = join(stateDir, `transaction-${PROFILE}`)

  if (options.journal !== undefined) {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(journalPath, options.journal)
  }
  if (options.contendedLock === true) {
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, "owner"), ownerRecordContents(OTHER_PID, OTHER_FINGERPRINT))
  }

  const engine = makeEngine(options.engine)
  const sessions = options.sessions ?? [0]
  let guardCalls = 0
  const io = makeStubIo({
    spawnTarget: engine.spawnTarget,
    runBash: stubRunBash,
    queryActiveWsCount: () => {
      const value = sessions[Math.min(guardCalls, sessions.length - 1)] ?? 0
      guardCalls += 1
      return value
    },
    // `[[ -f ]]` is REAL for anything inside the state dir and a blanket yes
    // everywhere else. The journal's existence is what the flow's very first
    // fork branches on (:1890, :1923), so a blanket yes there would make every
    // single run report a corrupt journal - while a blanket no everywhere else
    // would fail preflight's unit check before the flow was reached at all.
    fileExists: (path) => (path.startsWith(stateDir) ? existsSync(path) : true),
    pid: () => SELF_PID,
    // Both the pre-planted OTHER holder and this run's own record must read
    // back as alive: `acquire_update_lock`'s mandatory self-readback
    // (:1000-1006) consults the SAME two probes the contention check does.
    processAlive: () => true,
    processFingerprint: (pid) => (pid === OTHER_PID ? OTHER_FINGERPRINT : "self-fingerprint"),
    ...options.io,
  })
  const captured = makeCapturedSeams(makeEnv(stateDir, { HOME: lunaHome }), io)

  const argv = options.argv ?? [
    "update",
    "--profile", PROFILE,
    "--repo-dir", repoDir,
    "--luna-home", lunaHome,
    // Two poll iterations at zero interval: the injected clock is a counter, so
    // the budget is a COUNT of attempts and costs no wall-clock time.
    "--readiness-timeout", "2",
    "--readiness-interval", "0",
    // The settle is exercised (the sleep seam is stubbed), not skipped, so the
    // happy path still emits the :1279 settling line the way production does.
    "--restart-settle", "6",
  ]

  const code = runUpdate(argv, captured.seams)
  const journalExists = existsSync(journalPath)
  return {
    code,
    stdout: captured.stdout.join(""),
    stderr: captured.stderr.join(""),
    lockExists: existsSync(lockDir),
    journalExists,
    journalPhase: journalExists
      ? (/^phase=(.*)$/m.exec(readFileSync(journalPath, "utf8"))?.[1] ?? null)
      : null,
    head: engine.head(),
  }
}

describe("THE ARGV CONTRACT", () => {
  it("consumes the `update` subcommand token instead of refusing it", () => {
    // The failure this row exists for: feeding rawArgv to parseUpdateConfig
    // makes EVERY invocation die with `unknown option: update` and exit 1,
    // including the acceptance gate's own.
    const r = drive()
    expect(r.stderr).not.toContain("unknown option: update")
    expect(r.code).toBe(0)
  })

  it("throws forwardedFlags' own message when the token is absent, rather than returning a code", () => {
    // A caller that reached this binary without the token is a wiring bug in
    // luna_select_engine, not an operator error, so it must be loud - a polite
    // exit code here would be read by a deploy driver as a real verdict.
    const stateDir = makeTempDir("luna-exitcode-noargv-")
    const captured = makeCapturedSeams(makeEnv(stateDir), makeStubIo())
    expect(() => runUpdate(["--profile", PROFILE], captured.seams)).toThrow(/forwardedFlags/)
    // And the message is the SAME one delegate.ts raises, not a paraphrase.
    expect(() => forwardedFlags(["--profile", PROFILE])).toThrow(/forwardedFlags/)
  })
})

describe("0 - healthy update", () => {
  it("updates, seeds and clears the journal", () => {
    const r = drive()
    expect(r.code).toBe(0)
    expect(r.head).toBe(TARGET)
    expect(r.stdout).toContain(`updated ${PREV} -> ${TARGET} (${SERVICE} healthy)`)
    expect(r.stdout).toContain("post-deploy: dream/wake job rows ensured")
    expect(r.journalExists, "clear_transaction (:2076) ran").toBe(false)
    expect(r.lockExists, "the finally released the lock").toBe(false)
  })

  it("--restart-only with a healthy unit exits 0 and writes NO journal", () => {
    const r = drive({ argv: restartOnlyArgv() })
    expect(r.code).toBe(0)
    expect(r.journalExists, "rung 1 has no journal seam at all, by the shape of its options type").toBe(false)
    expect(r.lockExists).toBe(false)
  })
})

describe("1 - rolled back, or refused", () => {
  it("readiness fails and the rollback restores PREV", () => {
    const r = drive({ engine: { unhealthy: new Set([TARGET]) } })
    expect(r.code).toBe(1)
    // The external contract packages/server-registry reads.
    expect(r.stderr).toContain("ROLLED BACK to")
    expect(r.head).toBe(PREV)
    expect(r.journalExists, "a successful rollback clears the journal (:1840)").toBe(false)
    expect(r.lockExists).toBe(false)
  })

  it("a config refusal exits 1 and takes NO lock", () => {
    const r = drive({ argv: ["update", "--profile", PROFILE, "--layout", "bogus"] })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("error: invalid --layout: 'bogus'")
    expect(r.lockExists, "config parsing happens before the lock").toBe(false)
  })

  it("a preflight refusal exits 1 and takes NO lock", () => {
    const r = drive({ io: { dirExists: () => false } })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("is not a git clone")
    expect(r.lockExists, "preflight happens before the lock").toBe(false)
  })

  it("a numeric-knob refusal exits 1 and takes NO lock", () => {
    const r = drive({ argv: ["update", "--profile", PROFILE, "--readiness-timeout", "0.3"] })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("error: --readiness-timeout must be an integer (got '0.3')")
    expect(r.lockExists).toBe(false)
  })

  it("an unresolvable bash lib exits 1 before anything else runs", () => {
    const r = drive({ io: { isReadableFile: () => false } })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("no readable scripts/lib/luna-deploy.sh")
    expect(r.lockExists).toBe(false)
  })

  it("--restart-only whose restart errors exits 1 with the checkout untouched", () => {
    const r = drive({ argv: restartOnlyArgv(), engine: { startStatus: 1 } })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("restart-only: restart errored (checkout untouched; no rollback)")
    expect(r.head, "rung 1 never mutates the checkout").toBe(PREV)
    expect(r.journalExists).toBe(false)
  })
})

describe("2 - corrupt journal, or a rollback that also failed", () => {
  it("a corrupt journal refuses to touch the checkout", () => {
    const r = drive({ journal: "phase=bogus\nprev=x\n" })
    expect(r.code).toBe(2)
    // A bare printf in bash (:1925): no `warning: ` prefix.
    expect(r.stderr).toContain("CRITICAL: corrupt update transaction journal")
    expect(r.stderr).not.toContain("warning: CRITICAL: corrupt")
    expect(r.head, "the checkout was never touched").toBe(PREV)
    expect(r.journalExists, "the journal is RETAINED for a human to inspect").toBe(true)
    expect(r.lockExists, "even the exit-2 path releases the lock").toBe(false)
  })

  it("a rollback that is itself unhealthy is CRITICAL and retains the journal", () => {
    const r = drive({ engine: { unhealthy: new Set([TARGET, PREV]) } })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("CRITICAL: update to")
    expect(r.stderr).toContain("server may be DOWN")
    expect(r.journalPhase).toBe("rollback-failed")
    expect(r.lockExists).toBe(false)
  })
})

describe("3 - deferred by the session guard, at each distinct site", () => {
  it("fresh run: nothing is mutated and no journal is written", () => {
    const r = drive({ sessions: [2] })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain("DEFERRED by session guard; nothing mutated (retry next tick)")
    // The guard's OWN line, which bash emits from inside restart_session_guard.
    expect(r.stderr).toContain("active session(s) on :4753")
    expect(r.journalExists, "the defer sits BEFORE the first write_transaction (:2002)").toBe(false)
    expect(r.head).toBe(PREV)
    expect(r.lockExists).toBe(false)
  })

  it("recovery resume: the journal is RETAINED at the phase it was found", () => {
    const r = drive({
      journal: journalAt("applied"),
      sessions: [2],
    })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain("transaction journal retained (phase=applied)")
    expect(r.journalPhase).toBe("applied")
    expect(r.lockExists).toBe(false)
  })

  it("mid-transaction: the journal is retained at phase=restarting", () => {
    // Permitted at the fresh-run guard, deferred at the restart's own guard.
    const r = drive({ sessions: [0, 2] })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain("DEFERRED by session guard mid-transaction")
    expect(r.journalPhase).toBe("restarting")
    expect(r.lockExists).toBe(false)
  })

  it("rollback restart: an apply-phase failure keeps the guard ACTIVE", () => {
    // reset --hard fails, so the forward restart never ran and the OLD server
    // is still serving: rollback.ts keeps the guard on, and a defer there is a
    // legitimate exit 3 with the journal at phase=rolling-back.
    const r = drive({ engine: { resetFailsFor: new Set([TARGET]) }, sessions: [0, 2] })
    expect(r.code).toBe(3)
    expect(r.journalPhase).toBe("rolling-back")
    expect(r.lockExists).toBe(false)
  })

  it("--restart-only: rung 1's own guard defer", () => {
    const r = drive({ argv: restartOnlyArgv(), sessions: [2] })
    expect(r.code).toBe(3)
    expect(r.journalExists).toBe(false)
    expect(r.lockExists).toBe(false)
  })
})

describe("4 - lock contention, and ONLY under --restart-only", () => {
  it("a contended lock is a benign defer in normal mode", () => {
    const r = drive({ contendedLock: true })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain(`DEFERRED: another update for profile '${PROFILE}' is already running`)
    // Somebody else's lock dir is never removed.
    expect(r.lockExists).toBe(true)
  })

  it("the SAME contention is 4 under --restart-only", () => {
    const r = drive({ argv: restartOnlyArgv(), contendedLock: true })
    expect(r.code).toBe(4)
    expect(r.lockExists).toBe(true)
  })

  it("3 and 4 are never the same answer for the same host state", () => {
    // The specific confusion scripts/luna-update-server:1872-1878 exists to
    // prevent: a responder told "3" hunts for live sessions.
    const contended = drive({ argv: restartOnlyArgv(), contendedLock: true })
    const guarded = drive({ argv: restartOnlyArgv(), sessions: [2] })
    expect(contended.code).toBe(4)
    expect(guarded.code).toBe(3)
  })

  describe("the non-contended acquire failures take the same codes", () => {
    it("fingerprint-unavailable: 0 normally, 4 under --restart-only", () => {
      const io = { processFingerprint: () => "" }
      expect(drive({ io }).code).toBe(0)
      expect(drive({ argv: restartOnlyArgv(), io }).code).toBe(4)
    })

    it("ownership-unrecordable: 0 normally, 4 under --restart-only", () => {
      // The mandatory self-readback (:1000-1006) fails when our own pid does
      // not read back as alive.
      const io = { processAlive: () => false }
      expect(drive({ io }).code).toBe(0)
      expect(drive({ argv: restartOnlyArgv(), io }).code).toBe(4)
    })
  })
})

describe("ordering invariants that no earlier suite could assert", () => {
  it("delegation happens strictly BEFORE the lock is acquired", () => {
    const stateDir = makeTempDir("luna-exitcode-delegate-")
    const lockDir = join(stateDir, `lock-${PROFILE}`)
    let lockExistedDuringDelegation: boolean | null = null
    const io = makeStubIo({
      runBash: stubRunBash,
      runEngine: () => {
        lockExistedDuringDelegation = existsSync(lockDir)
        return { status: 7, signal: null }
      },
    })
    const captured = makeCapturedSeams(makeEnv(stateDir), io)
    const code = runUpdate(["update", "--profile", PROFILE, "--dry-run"], captured.seams)
    // The delegated child's status is propagated VERBATIM, not normalised.
    expect(code).toBe(7)
    expect(lockExistedDuringDelegation, "the bash engine acquires the same lock; holding it here self-contends").toBe(false)
    expect(existsSync(lockDir)).toBe(false)
  })

  it("the lock directory is absent after EVERY terminal path", () => {
    const rows: ReadonlyArray<readonly [string, DriveResult]> = [
      ["updated", drive()],
      ["rolled-back", drive({ engine: { unhealthy: new Set([TARGET]) } })],
      ["rollback-failed", drive({ engine: { unhealthy: new Set([TARGET, PREV]) } })],
      ["corrupt-journal", drive({ journal: "phase=bogus\n" })],
      ["deferred fresh-run", drive({ sessions: [2] })],
      ["deferred mid-transaction", drive({ sessions: [0, 2] })],
      ["restart-only ok", drive({ argv: restartOnlyArgv() })],
      ["config-refused", drive({ argv: ["update", "--layout", "bogus"] })],
    ]
    for (const [name, r] of rows) {
      expect(r.lockExists, `${name} left a lock behind (exit ${r.code})`).toBe(false)
    }
  })
})

describe("the exit hooks are uninstalled, not merely installed", () => {
  // installLockReleaseHooks adds TWO process listeners per call and is not
  // idempotent (lock.ts:437-454). This suite drives dozens of runUpdate calls
  // in one process, so a missing uninstaller means Node prints
  // MaxListenersExceededWarning onto the very stderr a parity suite diffs.
  let before = 0
  beforeEach(() => {
    before = process.listenerCount("exit") + process.listenerCount("uncaughtException")
  })

  it("returns the listener count to where it started, over many runs", () => {
    for (let i = 0; i < 12; i += 1) drive()
    const after = process.listenerCount("exit") + process.listenerCount("uncaughtException")
    expect(after).toBe(before)
  })
})

/** `--restart-only` with the same fixture knobs the default argv carries. */
function restartOnlyArgv(): ReadonlyArray<string> {
  return [
    "update",
    "--profile", PROFILE,
    "--restart-only",
    "--readiness-timeout", "2",
    "--readiness-interval", "0",
    "--restart-settle", "6",
  ]
}

/** A journal record `load_transaction` accepts, at the given phase. */
function journalAt(phase: string): string {
  return `phase=${phase}\nprev=${PREV}\ntarget=${TARGET}\nprev_lock_hash=\nupdated_at=1\n`
}
