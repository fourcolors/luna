/**
 * INTEROP: the two engines share ONE journal and ONE lock, on one host, across
 * a crash.
 *
 * WHY THIS IS NOT A SECOND COPY OF GATE 1. Every other parity suite runs the
 * two engines SIDE BY SIDE on two independent fixture roots and diffs the
 * result. That proves they behave the same; it proves nothing about whether one
 * can pick up where the other left off. But the whole rollout plan is an
 * ENGINE PIN that can be flipped either way at any moment: a host can run bash
 * at 03:00, be repinned to the binary, and find a journal and a lock the other
 * engine wrote. If either artifact is not mutually readable, the escape hatch
 * back to bash is fiction and the fold cannot proceed (spec:1879, spec:1989).
 * So this file drives the two engines IN SEQUENCE over the SAME fixture root.
 *
 * THE FOUR OBLIGATIONS, from spec:1314-1320:
 *
 *  1. Bash crashes at each phase via `LUNA_TEST_CRASH_AFTER_PHASE`
 *     (`scripts/luna-update-server:1017-1020`, a deliberate `kill -KILL "$$"`
 *     that traps cannot intercept, which is what makes it a power-loss
 *     simulation rather than a clean abort) and the BINARY completes the
 *     transaction.
 *  2. The reverse. The binary ships NO self-SIGKILL seam and never will, so the
 *     reverse direction is driven by having the binary WRITE a journal through
 *     an ordinary terminal path - `--no-rollback` leaves `phase=forward-failed`
 *     on disk (`:1865`) - and then invoking bash on it, so bash's
 *     `load_transaction` (`:1028-1044`) parses bytes the port produced.
 *  3. A bash lock holder defers the binary and vice versa, with the owner file
 *     read by the OTHER engine's `lock_owner_alive`.
 *  4. The binary-killed-mid-deploy case takes stale takeover, and its extra
 *     `removing stale update lock for profile '<p>'` line is asserted as a
 *     KNOWN divergence rather than masked (spec:780-781, spec:1650).
 *
 * Plus the platform obligation: assert WHICH fingerprint branch ran (`/proc` on
 * Linux, the `ps` fallback elsewhere) so neither arm can quietly stop being
 * covered on every runner at once.
 *
 * HOW THE ASSERTIONS STAY ORACLES RATHER THAN TRANSCRIPTIONS. Every operator
 * string this file pins is read OUT of `scripts/luna-update-server` at test
 * time by `bashLogLine`, which also verifies the cited line number. The bash
 * lock code is likewise not transcribed: `bashLockHolder` extracts
 * `process_fingerprint`, `lock_owner_alive`, `release_update_lock` and
 * `acquire_update_lock` VERBATIM from the script, sources the real
 * `scripts/lib/luna-deploy.sh` for `luna_warn`, and runs them. The owner record
 * the binary then has to read is therefore written by bash's own code, not by a
 * TypeScript approximation of it.
 *
 * WHY THE LIVE HOLDER IS `exec sleep`. A lock is only HELD while its owner pid
 * is alive with an unchanged start time. So the bash holder acquires the lock,
 * disarms its EXIT trap and `exec`s a long sleep: `exec` replaces the program
 * without changing the pid or the process start time, so `kill -0` succeeds and
 * both engines' fingerprint readings still match the record. That makes
 * "another update is running" a deterministic fact for the length of the test
 * instead of a race against a real deploy.
 *
 * PORTABILITY. `bash`, `git` and `bun` are resolved off the AMBIENT PATH by
 * `resolveHostTool`; nothing is spawned with "whatever launched the tests". The
 * one platform branch (the fingerprint source) is explicit and asserted in both
 * directions rather than assumed. No symlink is created. No path is spelled by
 * hand.
 */
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  type Fixture,
  type FixtureOptions,
  type RunResult,
  cleanupTempDirs,
  driveEnv,
  makeFixture,
  resolveHostTool,
  runBinaryUpdate,
  writeCurlStub,
} from "./bash-fixtures.js"
import { WARN_PREFIX, bashLogLine } from "./bash-source-oracle.js"
import { repoRoot } from "./temp-dirs.js"
import {
  acquireUpdateLockSync,
  lockOwnerAliveSync,
  ownerFilePath,
  readProcessFingerprintSync,
} from "../../src/update/lock.js"

afterAll(cleanupTempDirs)

/**
 * The readiness pair GATE 1 pins, for the same reason: exactly one poll
 * iteration per readiness call on both engines, whatever the machine.
 */
const PINNED_READINESS = { timeout: "2", interval: "3" } as const

/** Generous and uniform. Every row here runs at least two full engine invocations over one fixture. */
const ROW_TIMEOUT = 120_000

const PROFILE = "stable"

// --- the operator strings, read out of the bash at test time ------------------

/** `scripts/luna-update-server:985`. The line an engine prints when the OTHER engine's lock is genuinely held. */
const CONTENDED_LINE = bashLogLine({
  line: 1002,
  fn: "luna_warn",
  anchor: "is already running",
  vars: { PROFILE },
})

/** `scripts/luna-update-server:1005`. The line that makes obligation 4 visible instead of silent. */
const STALE_TAKEOVER_LINE = bashLogLine({
  line: 1005,
  fn: "luna_warn",
  anchor: "removing stale update lock",
  vars: { PROFILE },
})

/**
 * `scripts/luna-update-server:1959` carries `${PREV:0:9}` and `${REF:0:9}`,
 * substring expansions `bashLogLine` deliberately refuses to evaluate (it
 * throws on any surviving `$`), so this ONE expectation is composed here rather
 * than extracted. The wording is still guarded: the anchor below asserts the
 * fixed prefix exists exactly once in the source at the cited line.
 */
const recoveringLine = (phase: string, prev: string, target: string): string => {
  const prefix = 'luna_warn "RECOVERING interrupted update phase='
  const hits = engineSource
    .split("\n")
    .map((line, index) => ({ text: line.replace(/^\s+/, ""), line: index + 1 }))
    .filter((entry) => entry.text.startsWith(prefix))
  const only = hits[0]
  if (hits.length !== 1 || only === undefined || only.line !== 1959) {
    throw new Error(
      `interop-parity: expected exactly ONE ${JSON.stringify(prefix)} line at scripts/luna-update-server:1959, ` +
        `found ${hits.length} at ${JSON.stringify(hits.map((h) => h.line))} - update the citation and this expectation.`,
    )
  }
  return `RECOVERING interrupted update phase=${phase} prev=${prev.slice(0, 9)} target=${target.slice(0, 9)}`
}

// --- drives -------------------------------------------------------------------

/**
 * Drive A with an extra environment entry.
 *
 * `runBashDrive` takes only `settleSecs`, and this suite needs
 * `LUNA_TEST_CRASH_AFTER_PHASE`. Rather than widen the shared helper - which
 * three green PR1 suites and GATE 1 all depend on - the extra key is layered
 * over the SAME `driveEnv` map here, so the two drives still share one
 * environment shape.
 */
const runBash = (fixture: Fixture, extraEnv: Record<string, string> = {}): RunResult => {
  const r = spawnSync(resolveHostTool("bash"), [join(repoRoot, "scripts/luna-update-server"), ...fixture.args], {
    cwd: repoRoot,
    env: { ...driveEnv(fixture), ...extraEnv },
    encoding: "utf8",
  })
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

/** `{...fixture, args}` - Fixture is a plain readonly record, so appending argv is a copy rather than a fixture rebuild. */
const withExtraArgs = (fixture: Fixture, extra: ReadonlyArray<string>): Fixture =>
  extra.length === 0 ? fixture : { ...fixture, args: [...fixture.args, ...extra] }

/** The deploy checkout's HEAD, read with the ABSOLUTE git so the fixture's `git` shim does not log the measurement. */
const headOf = (fixture: Fixture): string => {
  const r = spawnSync(resolveHostTool("git"), ["-C", fixture.work, "rev-parse", "HEAD"], { encoding: "utf8" })
  return (r.stdout ?? "").trim()
}

const journalOf = (fixture: Fixture): string | null => {
  try {
    return readFileSync(fixture.journalPath, "utf8")
  } catch {
    return null
  }
}

/** One fixture, not a pair: interop is sequential on ONE root by definition. */
const makeInteropFixture = (opts: FixtureOptions): Fixture =>
  makeFixture({ readiness: PINNED_READINESS, claude: { stub: "present" }, ...opts })

/**
 * A lock dir whose owner names a LIVE pid with a fingerprint that cannot match
 * any real reading - the recycled-pid shape, which is the only reason the
 * fingerprint field exists and the one stale case that can be staged
 * deterministically (a pid that has genuinely been reused cannot).
 */
const writeStaleOwner = (fixture: Fixture): void => {
  mkdirSync(fixture.lockDir, { recursive: true })
  writeFileSync(ownerFilePath(fixture.lockDir), `pid=${process.pid}\nfingerprint=not-a-real-fingerprint\n`, {
    mode: 0o600,
  })
}

// --- the bash lock holder -----------------------------------------------------

const engineSource = readFileSync(join(repoRoot, "scripts/luna-update-server"), "utf8")

/**
 * Extract one shell function VERBATIM from the engine, by name.
 *
 * The body runs from the `<name>() {` line to the first line that is exactly
 * `}`, which is this file's own layout for every function it defines. The
 * extraction refuses anything it cannot find, so a rename in the bash breaks
 * this suite loudly instead of silently testing a transcription.
 */
const bashFunction = (name: string): string => {
  const lines = engineSource.split("\n")
  const start = lines.findIndex((l) => l === `${name}() {`)
  if (start < 0) {
    throw new Error(`interop-parity: no \`${name}() {\` line in scripts/luna-update-server - has it been renamed?`)
  }
  const end = lines.indexOf("}", start)
  if (end < 0) throw new Error(`interop-parity: \`${name}\` has no closing brace in scripts/luna-update-server`)
  return lines.slice(start, end + 1).join("\n")
}

/** `process_fingerprint "$1"` as the REAL bash computes it, with `$(...)`'s trailing-newline stripping applied. */
const bashProcessFingerprint = (pid: number): string => {
  const script = `${bashFunction("process_fingerprint")}\nprintf '%s' "$(process_fingerprint "$1")"\n`
  const r = spawnSync(resolveHostTool("bash"), ["-c", script, "bash", String(pid)], { encoding: "utf8" })
  return r.stdout ?? ""
}

interface BashHolder {
  readonly pid: number
  readonly stop: () => void
}

/**
 * Acquire the fixture's update lock with bash's OWN `acquire_update_lock`, then
 * stay alive holding it.
 *
 * `scripts/lib/luna-deploy.sh` is sourced for `luna_warn` (it contains no
 * top-level statement, only function definitions, so sourcing it is inert), and
 * the four lock functions are eval'd verbatim. After a successful acquire the
 * EXIT/INT/TERM trap `acquire_update_lock` installs is DISARMED and the shell
 * `exec`s a long sleep: exec keeps the pid and the process start time, so the
 * owner record stays valid and the lock stays genuinely held until `stop()`.
 *
 * IT RUNS IN `driveEnv`, not in the ambient environment, and that is
 * load-bearing rather than tidy: on a `ps`-fallback host the fingerprint is
 * rendered in the caller's timezone (see `withDriveLocale`), so a holder that
 * fingerprinted itself in a different environment from the engine that reads
 * the record would be classified STALE and have its lock stolen. Every engine
 * this suite runs, and the in-process port acquire, share one environment.
 */
const bashLockHolder = (fixture: Fixture): BashHolder => {
  const script = [
    `source ${JSON.stringify(join(repoRoot, "scripts/lib/luna-deploy.sh"))}`,
    bashFunction("process_fingerprint"),
    bashFunction("lock_owner_alive"),
    bashFunction("release_update_lock"),
    bashFunction("acquire_update_lock"),
    `PROFILE=${JSON.stringify(PROFILE)}`,
    `UPDATE_STATE_DIR=${JSON.stringify(fixture.updateState)}`,
    `UPDATE_LOCK_DIR=${JSON.stringify(fixture.lockDir)}`,
    "UPDATE_LOCK_HELD=false",
    "acquire_update_lock || exit 1",
    "trap - EXIT INT TERM",
    'printf "%s\\n" "$$"',
    "exec sleep 300",
  ].join("\n")
  const child = spawn(resolveHostTool("bash"), ["-c", script], {
    cwd: repoRoot,
    env: driveEnv(fixture),
    stdio: ["ignore", "pipe", "pipe"],
  })
  const stop = (): void => {
    try {
      child.kill("SIGKILL")
    } catch {
      // Already gone.
    }
  }
  return { pid: child.pid ?? -1, stop }
}

/**
 * The locale keys `driveEnv` pins, applied to THIS process's environment for
 * the duration of `body` and restored on every exit path (including "was not
 * set"). Same shape, and the same reason, as bash-fixtures' own
 * `withPinnedCommitDates`.
 *
 * WHY IT IS NEEDED, AND WHAT IT REVEALS. On a host without `/proc` the
 * fingerprint is `ps -p <pid> -o lstart=`, whose output is rendered in the
 * CALLER'S timezone: measured on one live pid, `Sun Aug  9 23:41:32 2026`
 * locally and `Mon Aug 10 06:41:32 2026` under `TZ=UTC`. The port's
 * `acquireUpdateLockSync` runs `ps` in whatever environment its own process
 * carries, while the bash drive runs it in `driveEnv`'s pinned `LANG=C
 * LC_ALL=C TZ=UTC`. Without this wrapper the two engines disagree about a lock
 * neither of them is wrong about, and the row below would be testing the
 * harness rather than the port. The underlying sensitivity is NOT hidden by
 * this helper - it is asserted directly by the "TIMEZONE-sensitive" row.
 */
const withDriveLocale = <T,>(body: () => T): T => {
  const keys = ["LANG", "LC_ALL", "TZ"] as const
  const pinned: Record<string, string> = { LANG: "C", LC_ALL: "C", TZ: "UTC" }
  const saved = new Map<string, string | undefined>(keys.map((k) => [k, process.env[k]]))
  for (const k of keys) process.env[k] = pinned[k]
  try {
    return body()
  } finally {
    for (const k of keys) {
      const was = saved.get(k)
      if (was === undefined) delete process.env[k]
      else process.env[k] = was
    }
  }
}

/** Poll a predicate on the real clock, bounded, for the two places this suite must wait on another process. */
const waitFor = async (label: string, predicate: () => boolean, budgetMs = 30_000): Promise<void> => {
  const deadline = Date.now() + budgetMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`interop-parity: timed out after ${budgetMs}ms waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// --- obligation 1: bash crashes, the binary finishes --------------------------

/**
 * Every phase `write_transaction` is called with on the FORWARD path, which is
 * every phase a crashed forward deploy can leave behind: `:2002` prepared,
 * `:1165`/`:1196` checkout, `:2043` applied, `:2045` restarting, `:2071`
 * verifying. The three failure-path phases (`rolling-back`, `rollback-failed`,
 * `forward-failed`) are unreachable from a HAPPY fixture, and the last of them
 * is what obligation 2 uses in the other direction.
 */
const FORWARD_PHASES = ["prepared", "checkout", "applied", "restarting", "verifying"] as const

describe("interop 1: bash is SIGKILLed mid-transaction and the BINARY completes it", () => {
  for (const phase of FORWARD_PHASES) {
    it(
      `bash crashes after phase=${phase}; the binary recovers the same journal and finishes`,
      () => {
        const fixture = makeInteropFixture({ readyAtTarget: true, readyAtPrev: true })
        const crashed = runBash(fixture, { LUNA_TEST_CRASH_AFTER_PHASE: phase })

        // The seam is a real SIGKILL, not an exit: traps cannot run, which is
        // why the lock survives it and why this is a power-loss simulation.
        expect(crashed.signal, `bash should have been SIGKILLed after phase=${phase}`).toBe("SIGKILL")
        const crashedJournal = journalOf(fixture)
        expect(crashedJournal, "the crashed run must leave its journal behind").toContain(`phase=${phase}`)
        expect(existsSync(fixture.lockDir), "a SIGKILLed bash cannot release its lock").toBe(true)

        // Now the binary, on the SAME root, with the SAME argv. It must take
        // the dead holder's lock over, parse bash's journal, and finish.
        const resumed = runBinaryUpdate(fixture)
        expect(resumed.status, `binary stderr: ${resumed.stderr}`).toBe(0)
        expect(resumed.stderr, "the stale takeover of the dead bash lock").toContain(
          `${WARN_PREFIX}${STALE_TAKEOVER_LINE}`,
        )
        expect(resumed.stderr, "the binary must announce WHICH phase it recovered").toContain(
          recoveringLine(phase, fixture.prevSha, fixture.targetSha),
        )
        expect(journalOf(fixture), "a completed transaction clears its journal (:2076)").toBeNull()
        expect(existsSync(fixture.lockDir), "the binary must release the lock on the way out").toBe(false)
        expect(headOf(fixture), "the recovered transaction lands on the crashed run's target").toBe(fixture.targetSha)
      },
      ROW_TIMEOUT,
    )
  }
})

// --- obligation 2: the binary writes, bash finishes ---------------------------

describe("interop 2: the BINARY writes the journal and bash completes it", () => {
  it(
    "a binary-written phase=forward-failed journal is parsed and finished by bash",
    () => {
      // `--no-rollback` is the one ordinary terminal that leaves a journal on
      // disk written by the engine under test (:1865-1866), which is what makes
      // this direction drivable without a self-kill seam the port refuses to
      // have.
      const base = makeInteropFixture({ readyAtTarget: false, readyAtPrev: true })
      const fixture = withExtraArgs(base, ["--no-rollback"])
      const failed = runBinaryUpdate(fixture)
      expect(failed.status, `binary stderr: ${failed.stderr}`).toBe(1)

      const written = journalOf(fixture)
      expect(written, "the binary must have written a journal").not.toBeNull()
      expect(written).toContain("phase=forward-failed")
      // The five keys, in write_transaction's order (:1013). Bash's
      // load_transaction is a `while IFS='=' read` over these lines, so the
      // SHAPE is the interop contract, not just the phase value.
      expect((written ?? "").split("\n").slice(0, 4).map((l) => l.split("=")[0])).toEqual([
        "phase",
        "prev",
        "target",
        "prev_lock_hash",
      ])
      expect(written).toContain("updated_at=")

      // Flip the readiness verdict so the resumed transaction can succeed. The
      // curl stub is REWRITTEN with the shared writer rather than hand-edited,
      // so the second run's stub is the same audited bytes the first run's was,
      // differing only in `readyAtTarget`.
      writeCurlStub(fixture.bin, fixture.curlLog, fixture.traceLog, fixture.curlCalls, {
        repo: fixture.work,
        prevSha: fixture.prevSha,
        targetSha: fixture.targetSha,
        readyAtTarget: true,
        readyAtPrev: true,
      })

      const finished = runBash(fixture)
      expect(finished.status, `bash stderr: ${finished.stderr}`).toBe(0)
      expect(finished.stderr, "bash's load_transaction must accept the port's journal").toContain(
        recoveringLine("forward-failed", fixture.prevSha, fixture.targetSha),
      )
      expect(journalOf(fixture), "bash clears the journal it inherited").toBeNull()
      expect(headOf(fixture)).toBe(fixture.targetSha)
      // The binary released its lock on the way out, so bash acquired a FRESH
      // one and there was nothing stale to take over.
      expect(finished.stderr).not.toContain(STALE_TAKEOVER_LINE)
      expect(existsSync(fixture.lockDir)).toBe(false)
    },
    ROW_TIMEOUT,
  )
})

// --- obligation 3 and the platform branch: the lock, read across engines ------

describe("interop 3: the update lock's owner record, written by one engine and read by the other", () => {
  it("both engines compute the SAME fingerprint for the same pid, on this platform's branch", () => {
    // The fingerprint is the whole reason the lock survives a pid wrap, and it
    // is the one field whose VALUE the two implementations could disagree on
    // while both look correct. The pid is this test process's own: guaranteed
    // alive, so neither reading can race a dying process.
    // Both readings under ONE environment - `driveEnv`'s, the one every engine
    // in this suite runs in - because the `ps` arm renders a date and would
    // otherwise be comparing two timezones (see `withDriveLocale`).
    const reading = withDriveLocale(() => readProcessFingerprintSync(process.pid))
    const fromBash = withDriveLocale(() => bashProcessFingerprint(process.pid))
    expect(fromBash, "bash could not fingerprint a live process").not.toBe("")
    expect(reading.fingerprint, "the port and bash must agree byte for byte").toBe(fromBash)

    // WHICH BRANCH RAN, asserted per platform so neither arm can silently stop
    // being covered (spec:1319). `/proc/<pid>/stat` field 20 is an integer
    // jiffies count; `ps -p <pid> -o lstart=` is a padded date string.
    if (process.platform === "linux") {
      expect(reading.source, "Linux must take the /proc arm").toBe("proc")
      expect(reading.fingerprint, "a starttime is a bare integer").toMatch(/^[0-9]+$/)
    } else {
      expect(reading.source, "a host without /proc must take the ps fallback").toBe("ps")
      expect(reading.fingerprint, "an lstart string is not a bare integer").not.toMatch(/^[0-9]+$/)
    }
  })

  it(
    "the ps-fallback fingerprint is TIMEZONE-sensitive; the /proc one is not",
    () => {
      // Pinned deliberately, because it is the ONE property that decides
      // whether two engines invoked with different environments agree about a
      // live lock. `/proc/<pid>/stat` field 20 is a jiffies count and cannot
      // vary; `ps -o lstart=` is a rendered date and does. The consequence, on
      // any host without /proc, is a real cross-engine hazard rather than a
      // curiosity: an operator running the engine by hand in a local timezone
      // reads a DIFFERENT fingerprint for the same live pid than the timer does
      // under a pinned TZ, classifies the other's lock as stale, and steals it
      // mid-deploy. That is bash's own behaviour, faithfully ported, so this is
      // not a port defect and this suite does not fail on it - it pins it, so
      // that fixing it (by pinning the format inside `process_fingerprint`) is
      // a deliberate change with a test to update rather than a silent one.
      const branch = readProcessFingerprintSync(process.pid).source
      const utc = withDriveLocale(() => readProcessFingerprintSync(process.pid).fingerprint)
      const other = (() => {
        const saved = process.env.TZ
        process.env.TZ = "Asia/Tokyo"
        try {
          return readProcessFingerprintSync(process.pid).fingerprint
        } finally {
          if (saved === undefined) delete process.env.TZ
          else process.env.TZ = saved
        }
      })()
      expect(utc, "a fingerprint must never come back empty for a live pid").not.toBe("")
      if (branch === "proc") expect(other, "the /proc arm is environment-invariant").toBe(utc)
      else expect(other, "the ps arm renders a date, so it is NOT environment-invariant").not.toBe(utc)
    },
    ROW_TIMEOUT,
  )

  it(
    "a BASH-held lock defers the binary: exit 0 plain, exit 4 under --restart-only, nothing mutated",
    async () => {
      const fixture = makeInteropFixture({ readyAtTarget: true, readyAtPrev: true })
      const holder = bashLockHolder(fixture)
      try {
        // The holder acquires asynchronously, so WAIT for the record rather
        // than racing it. Both waits are on facts, not on a sleep: the file
        // exists, and the PORT's own reader judges it live.
        expect(holder.pid, "the bash holder did not start").toBeGreaterThan(0)
        await waitFor("bash to write its owner record", () => existsSync(ownerFilePath(fixture.lockDir)))
        await waitFor("the port to read bash's record as LIVE", () =>
          withDriveLocale(() => lockOwnerAliveSync(fixture.lockDir)),
        )

        const plain = runBinaryUpdate(fixture)
        expect(plain.status, `binary stderr: ${plain.stderr}`).toBe(0)
        expect(plain.stderr).toContain(`${WARN_PREFIX}${CONTENDED_LINE}`)
        expect(plain.stderr, "a held lock must never be taken over").not.toContain(STALE_TAKEOVER_LINE)
        expect(journalOf(fixture), "a deferred run mutates nothing").toBeNull()
        expect(headOf(fixture)).toBe(fixture.prevSha)
        expect(existsSync(fixture.lockDir), "the deferring engine must leave the holder's lock alone").toBe(true)

        // FOUR, NOT THREE. Contention under --restart-only is exit 4; 3 is the
        // session-guard defer and conflating them sends an incident responder
        // to a false diagnosis (lock.ts's header, :1872-1881).
        const restartOnly = runBinaryUpdate(withExtraArgs(fixture, ["--restart-only"]))
        expect(restartOnly.status, `binary stderr: ${restartOnly.stderr}`).toBe(4)
        expect(restartOnly.status).not.toBe(3)
        expect(restartOnly.stderr).toContain(`${WARN_PREFIX}${CONTENDED_LINE}`)
      } finally {
        holder.stop()
      }
    },
    ROW_TIMEOUT,
  )

  it(
    "a PORT-held lock defers bash: exit 0 plain, exit 4 under --restart-only, nothing mutated",
    () => {
      const fixture = makeInteropFixture({ readyAtTarget: true, readyAtPrev: true })
      const warned: string[] = []
      // The port's REAL acquire, writing a REAL owner record for a pid that is
      // alive for the whole test - this process's own. No seam is injected, so
      // the fingerprint in the record is the one production would write; only
      // the locale is pinned to `driveEnv`'s, for the reason `withDriveLocale`
      // states.
      const outcome = withDriveLocale(() =>
        acquireUpdateLockSync({
          stateDir: fixture.updateState,
          profile: PROFILE,
          warn: (line) => warned.push(line),
        }),
      )
      expect(outcome.acquired, `the port failed to acquire: ${JSON.stringify(warned)}`).toBe(true)
      if (!outcome.acquired) return
      try {
        const plain = runBash(fixture)
        expect(plain.status, `bash stderr: ${plain.stderr}`).toBe(0)
        expect(plain.stderr, "bash's lock_owner_alive must read the port's owner record as LIVE").toContain(
          `${WARN_PREFIX}${CONTENDED_LINE}`,
        )
        expect(plain.stderr).not.toContain(STALE_TAKEOVER_LINE)
        expect(journalOf(fixture)).toBeNull()
        expect(headOf(fixture)).toBe(fixture.prevSha)
        expect(existsSync(fixture.lockDir)).toBe(true)

        const restartOnly = runBash(withExtraArgs(fixture, ["--restart-only"]))
        expect(restartOnly.status, `bash stderr: ${restartOnly.stderr}`).toBe(4)
        expect(restartOnly.status).not.toBe(3)
      } finally {
        outcome.lock.release()
      }
    },
    ROW_TIMEOUT,
  )

  it(
    "a fingerprint that no longer matches (the recycled-pid case) is STALE to both engines",
    () => {
      // pid ALIVE, fingerprint wrong: `kill -0` succeeds and the comparison
      // fails, which is exactly what a reused pid looks like and the only
      // reason the fingerprint field exists. Constructed rather than raced,
      // because a genuinely recycled pid cannot be staged deterministically.
      const forBinary = makeInteropFixture({ readyAtTarget: true, readyAtPrev: true })
      const forBash = makeInteropFixture({ readyAtTarget: true, readyAtPrev: true })
      for (const fixture of [forBinary, forBash]) {
        writeStaleOwner(fixture)
        expect(lockOwnerAliveSync(fixture.lockDir), "the port must classify this record as STALE").toBe(false)
      }

      const binary = runBinaryUpdate(forBinary)
      expect(binary.status, `binary stderr: ${binary.stderr}`).toBe(0)
      expect(binary.stderr).toContain(`${WARN_PREFIX}${STALE_TAKEOVER_LINE}`)
      expect(headOf(forBinary)).toBe(forBinary.targetSha)

      const bash = runBash(forBash)
      expect(bash.status, `bash stderr: ${bash.stderr}`).toBe(0)
      expect(bash.stderr).toContain(`${WARN_PREFIX}${STALE_TAKEOVER_LINE}`)
      expect(headOf(forBash)).toBe(forBash.targetSha)
    },
    ROW_TIMEOUT,
  )
})

// --- obligation 4: the known divergence ---------------------------------------

describe("interop 4: a KILLED binary leaves the lock behind, and the next run says so", () => {
  it(
    "SIGTERM mid-deploy: the binary leaks the lock where bash's trap releases it, and the takeover line is the KNOWN divergence",
    async () => {
      // THE DIVERGENCE, stated plainly (spec:780-781). Bash arms
      // `trap release_update_lock EXIT INT TERM` (:1009). Node and Bun dispatch
      // signals on the event loop, and the synchronous update body never yields
      // to it, so lock.ts wires only 'exit' and 'uncaughtException' and says so
      // in its own header. Measured here rather than argued: a SIGTERMed binary
      // leaves the lock dir, a SIGTERMed bash does not, and the recovery for
      // the former is the next run's stale takeover - which emits one extra
      // stderr line bash would never have emitted. This suite asserts that
      // line; it does not mask it.
      const forBinary = await killMidInstall((f) => ({
        cmd: resolveHostTool("bun"),
        args: [join(repoRoot, "apps/deploy-cli/src/main.ts"), "update", ...f.args],
      }))
      expect(forBinary.lockPresentAfterKill, "a SIGTERMed binary CANNOT release its lock").toBe(true)
      expect(existsSync(ownerFilePath(forBinary.fixture.lockDir)), "the leaked lock still names its dead owner").toBe(
        true,
      )
      expect(forBinary.stderr, "the killed run itself acquired a FRESH lock, so no takeover happened in it").not.toContain(
        STALE_TAKEOVER_LINE,
      )

      const forBash = await killMidInstall((f) => ({
        cmd: resolveHostTool("bash"),
        args: [join(repoRoot, "scripts/luna-update-server"), ...f.args],
      }))
      expect(forBash.lockPresentAfterKill, "bash's EXIT/TERM trap DOES release the lock").toBe(false)

      // The recovery half: restore the fast `bun` stub and run the binary again
      // over its own leaked lock. It takes the lock over, announces it, and
      // finishes the interrupted transaction.
      restoreFastBunStub(forBinary.fixture)
      const recovered = runBinaryUpdate(forBinary.fixture)
      expect(recovered.status, `binary stderr: ${recovered.stderr}`).toBe(0)
      expect(recovered.stderr, "THE known divergence, asserted rather than masked").toContain(
        `${WARN_PREFIX}${STALE_TAKEOVER_LINE}`,
      )
      expect(existsSync(forBinary.fixture.lockDir)).toBe(false)
      expect(headOf(forBinary.fixture)).toBe(forBinary.fixture.targetSha)
    },
    ROW_TIMEOUT,
  )
})

/** Marker + slow `bun`, so the kill lands inside `bun install` rather than racing the whole deploy. */
const BLOCK_MARKER = "bun.blocking"

/**
 * Replace the fixture's `bun` with one that announces itself and then blocks.
 *
 * `bun install` runs on a lockfile delta (`:1204`), strictly AFTER the lock is
 * acquired and the first journal writes have landed, which is exactly the state
 * "killed mid-deploy" means. Polling for the marker makes the kill deterministic
 * instead of a sleep-and-hope. Three seconds is enough for a 25ms poll to see
 * the marker and signal, and short enough that the bash arm - whose TERM trap
 * cannot run until its foreground child returns - is not slow.
 */
const writeBlockingBunStub = (fixture: Fixture): void => {
  const marker = join(fixture.temp, BLOCK_MARKER)
  writeFileSync(
    join(fixture.bin, "bun"),
    `#!/usr/bin/env bash
printf 'bun %s\\n' "$*" >> "${fixture.traceLog}"
printf '%s\\n' "$*" >> "${fixture.bunLog}"
: > "${marker}"
sleep 3
exit 0
`,
  )
  chmodSync(join(fixture.bin, "bun"), 0o755)
}

/** The trace-emitting `bun` every other fixture carries (bash-fixtures.ts's writeBunStub), restored for the recovery run. */
const restoreFastBunStub = (fixture: Fixture): void => {
  writeFileSync(
    join(fixture.bin, "bun"),
    `#!/usr/bin/env bash
printf 'bun %s\\n' "$*" >> "${fixture.traceLog}"
printf '%s\\n' "$*" >> "${fixture.bunLog}"
exit 0
`,
  )
  chmodSync(join(fixture.bin, "bun"), 0o755)
}

interface KilledRun {
  readonly fixture: Fixture
  readonly lockPresentAfterKill: boolean
  readonly stderr: string
}

/** Start an engine, wait until it is inside `bun install`, SIGTERM it, and report what it left behind. */
const killMidInstall = async (
  argvOf: (fixture: Fixture) => { readonly cmd: string; readonly args: ReadonlyArray<string> },
): Promise<KilledRun> => {
  const fixture = makeInteropFixture({ readyAtTarget: true, readyAtPrev: true, lockChanges: true })
  writeBlockingBunStub(fixture)
  const { cmd, args } = argvOf(fixture)
  const child = spawn(cmd, [...args], {
    cwd: repoRoot,
    env: driveEnv(fixture),
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stderr = ""
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  child.stdout?.resume()
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()))
  await waitFor("the engine to reach `bun install`", () => existsSync(join(fixture.temp, BLOCK_MARKER)))
  child.kill("SIGTERM")
  await exited
  return { fixture, lockPresentAfterKill: existsSync(fixture.lockDir), stderr }
}
