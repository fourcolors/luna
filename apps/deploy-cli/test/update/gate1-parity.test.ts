/**
 * GATE 1: the hermetic full-flow parity suite.
 *
 * Both engines - `scripts/luna-update-server` (Drive A, the oracle) and this
 * repo's `deploy-cli update` (Drive B) - drive the ENTIRE state machine over
 * identical fixture inputs, non-dry and mutating, on two independent fixture
 * roots built by `makeFixturePair`. Every observable artifact is then compared
 * byte for byte, after the three masking rules and (for exactly one scenario)
 * the one normalisation rule.
 *
 * WHY THIS FILE IS THE PROOF AND THE OTHERS ARE NOT. Every other suite in this
 * directory drives ONE module through injected seams: they localise a failure
 * and they are fast, but each one asserts against a transcription of the bash
 * a human made. This file asserts against the bash itself, running, in the
 * same environment, over the same fixture, and compares what an operator and
 * every downstream program can actually see. A string this suite does not
 * cover is a string nothing covers.
 *
 * THE DETERMINISM CONTRACT, which is the thing that makes a byte diff of a
 * retry loop legitimate at all:
 *
 *  - Every scenario except the two named retry rows runs with
 *    `--readiness-timeout 2 --readiness-interval 3`, the pair proven under the
 *    spec's READINESS DETERMINISM section to give EXACTLY ONE poll iteration
 *    per readiness call on BOTH drives, whatever the machine. Each scenario
 *    states its own expected count in a comment beside it, because a rule
 *    nobody restates per row is a rule nobody notices breaking.
 *  - Artifacts that are deterministic by construction get a STRICT byte diff,
 *    on every scenario without exception. `git.log` is strict EVERYWHERE, and
 *    that is only true because the replacement `curl` stub resolves git by
 *    absolute path and bypasses the fixture's `git` shim, so no readiness poll
 *    can contribute a git entry. `stub-fidelity.test.ts` pins that property.
 *  - stdout and stderr are strict everywhere too, including on the exhaustion
 *    row: `readiness_ok` prints nothing inside its loop in either engine
 *    (bash :1074-1122, readiness.ts's loop), and the give-up line is emitted
 *    once, after the loop.
 *  - The ONE retry-to-exhaustion row is explicitly unpinnable - its iteration
 *    count is `ceil(window / (interval + per-iteration cost))` and the cost is
 *    the machine's - so it is the ONLY consumer of `normalisePollBlocks`, and
 *    it applies to exactly four logs. THE RETRY BEHAVIOUR THAT COLLAPSE HIDES
 *    IS ASSERTED ELSEWHERE, and naming where is what separates normalisation
 *    from masking. The three supports, all of which exist and are named at the
 *    line they live on:
 *      1. the retry-to-SUCCESS row in "GATE 1: readiness determinism" below,
 *         which drives `readyAfterCalls: 3` DUAL-DRIVE under a STRICT diff and
 *         asserts exactly three `/healthz` entries in each drive's own
 *         `curl.log`. That row is deterministic without any normalisation
 *         because the fixture's `curl` counts its own INVOCATIONS rather than
 *         watching a clock, so the loop is proven to iterate, in both engines,
 *         with nothing collapsed;
 *      2. the exhaustion row itself, which asserts per drive and OUTSIDE the
 *         diff that its own PRE-collapse `/healthz` count is at least two, so a
 *         port that polled once and gave up cannot ride the collapse;
 *      3. `readiness.ts`'s PR1 unit suite, which pins the loop against an
 *         injected clock.
 *    Delete any of those three and this normalisation becomes masking and must
 *    be deleted with it. (Support 1 is what the spec's `readiness-retry.test.ts`
 *    was specified to provide - "each engine driven with `readyAfterCalls: 3`,
 *    three `/healthz` entries per drive". It is discharged HERE instead, which
 *    is strictly stronger: the same assertion plus a byte diff between the two
 *    drives. There is no `readiness-retry.test.ts` in this directory and this
 *    header does not claim one.)
 *
 * MASKING IS A CLOSED LIST OF EXACTLY THREE RULES, all of them inside
 * `maskArtifacts` (fixture root, `updated_at=`, lock-owner `pid=`). This file
 * adds none. A fourth would be a disqualifying weakening of the gate.
 *
 * PORTABILITY. Nothing here assumes macOS or this developer's machine: both
 * drives are spawned through `resolveHostTool`, which resolves `bash`, `git`
 * and `bun` off the AMBIENT PATH and refuses anything inside a fixture root,
 * and every path is built with `node:path`. The fixture's own stubs are bash
 * 3.2 compatible for the same reason. The one row that needs a LIVE process to
 * own a lock uses this test runner's own pid and fingerprints it through the
 * ORACLE's `process_fingerprint` (both of its arms), never through the port's.
 *
 * WHAT THIS SUITE DOES NOT PROVE, and the PR body must say so in these words:
 * that the container-path plumbing is right against REAL container paths,
 * because the fixture's `incus` stub rewrites the hardcoded `/root/luna` and
 * `/root/.luna/.env` prefixes onto host directories in order to run at all.
 * That is what GATE 2 exists for. What the incus topology below DOES prove is
 * the repo-dir AXIS: that the container-side argv carries `CONTAINER_REPO_DIR`
 * while every git call carries `HOST_REPO_DIR`, which is invisible on a bare
 * host because config.ts collapses the two to the same value there.
 *
 * TWO SPEC ROWS ARE ABSENT AND THIS IS THE HONEST LIST, because a header that
 * overstates coverage is worse than no header:
 *  - `--restart-only` with a start-limit latch that then starts (the `:1375`
 *    warn on a SUCCESSFUL rung-1 restart). The fixture's `systemctl` always
 *    exits 0, so a `start` that fails once and an `is-failed` that succeeds
 *    cannot be expressed through any `FixtureOptions` knob, and re-writing the
 *    whole stub from a scenario would fork the one thing both drives share.
 *    It is covered bash-only in `restart-mainpid-parity.test.ts`.
 *  - the corrupt-journal shape "a DIRECTORY at the journal path". Bash reaches
 *    it through an UNGUARDED `write_transaction` whose `mv` failure prints
 *    `mv:`'s own diagnostic, whose text is the local mv implementation's and
 *    which the port (a `rename` syscall) cannot reproduce. It is a KNOWN
 *    DIVERGENCE, not a gap the diff can close, and belongs in the spec's
 *    divergence list rather than here.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  type Artifacts,
  type Fixture,
  type FixtureOptions,
  type RunResult,
  MASK_ROOT,
  captureArtifacts,
  cleanupTempDirs,
  makeFixturePair,
  maskArtifacts,
  normalisePollBlocks,
  resolveHostTool,
  runBashDrive,
  runBinaryUpdate,
} from "./bash-fixtures.js"

afterAll(cleanupTempDirs)

/**
 * The pinned readiness pair. EVERY scenario uses it except the two retry rows,
 * which say why in their own comments.
 *
 * The proof it yields exactly one iteration, restated here so a reader of this
 * file never has to fetch the spec: bash reads `SECONDS` as an integer S at
 * :1071 and sets `deadline=S+2`; the first `while (( SECONDS < deadline ))` at
 * :1074 runs two assignments later, so it is still under S+1 and the first
 * iteration ALWAYS runs. `sleep 3` at :1122 then guarantees `SECONDS >= S+3`,
 * so the second evaluation ALWAYS ends the loop. The port computes the same
 * deadline from a whole-second monotonic clock (readiness.ts:145,
 * probes.ts:244-246) and sleeps the same 3 seconds. Both margins are a full
 * second wide and neither involves per-iteration cost, so there is no
 * flakiness window.
 *
 * A poll that SUCCEEDS returns from inside the iteration, before the sleep, so
 * a passing readiness call costs one iteration and no sleep; a failing one
 * costs one iteration plus one three-second sleep. That is where this suite's
 * wall-clock cost comes from and why every row carries an explicit timeout.
 */
const PINNED_READINESS = { timeout: "2", interval: "3" } as const

/** Generous, and deliberately uniform: a row that fails readiness twice pays six seconds of `sleep` on each drive, on top of two fixture builds. */
const ROW_TIMEOUT = 180_000

/**
 * One dual-drive scenario.
 *
 * `prepare` runs against EACH drive's own fixture after it is built and before
 * that drive runs, which is the only way to stage pre-run state (a seeded
 * journal, a missing node_modules, a held lock) symmetrically. It must be
 * deterministic and must not read the other drive's root.
 */
interface Scenario {
  readonly fixture: FixtureOptions
  /**
   * Appended to `fixture.args`, never inserted, so the base vector stays a
   * strict prefix. A FUNCTION when the argv depends on the built fixture - the
   * `--ref <abbrev>` rows need the target sha, which does not exist until
   * `makeFixturePair` has committed it. Both halves of a pair are asserted to
   * hash identically (bash-fixtures.ts's makeFixturePair), so the function
   * returns the same vector for both drives.
   */
  readonly extraArgs?: ReadonlyArray<string> | ((fixture: Fixture) => ReadonlyArray<string>)
  /** `LUNA_RESTART_SETTLE_SECS`, per scenario (spec blocker R1). Defaults to "0" inside driveEnv. */
  readonly settleSecs?: string
  readonly prepare?: (fixture: Fixture) => void
}

interface DrivenPair {
  readonly bash: Artifacts
  readonly binary: Artifacts
  readonly bashFixture: Fixture
  readonly binaryFixture: Fixture
  readonly bashRaw: RunResult
  readonly binaryRaw: RunResult
}

/** `{...fixture, args}` - Fixture is a plain readonly record, so appending argv is a copy rather than a fixture rebuild. */
const withExtraArgs = (fixture: Fixture, extra: Scenario["extraArgs"]): Fixture => {
  const resolved = typeof extra === "function" ? extra(fixture) : extra
  return resolved === undefined || resolved.length === 0 ? fixture : { ...fixture, args: [...fixture.args, ...resolved] }
}

/** Build the pair, stage both roots identically, run both engines, capture and mask. */
const driveBoth = (scenario: Scenario): DrivenPair => {
  const pair = makeFixturePair({ readiness: PINNED_READINESS, ...scenario.fixture })
  const bashFixture = withExtraArgs(pair.bash, scenario.extraArgs)
  const binaryFixture = withExtraArgs(pair.binary, scenario.extraArgs)
  scenario.prepare?.(bashFixture)
  scenario.prepare?.(binaryFixture)
  const settle = scenario.settleSecs === undefined ? {} : { settleSecs: scenario.settleSecs }
  const bashRaw = runBashDrive(bashFixture, settle)
  const binaryRaw = runBinaryUpdate(binaryFixture, settle)
  return {
    bash: maskArtifacts(captureArtifacts(bashFixture, bashRaw), bashFixture),
    binary: maskArtifacts(captureArtifacts(binaryFixture, binaryRaw), binaryFixture),
    bashFixture,
    binaryFixture,
    bashRaw,
    binaryRaw,
  }
}

/**
 * The four poll-fed logs, and the ONLY four `normalisePollBlocks` may touch.
 * Named once so the retry row cannot quietly widen the set.
 */
const POLL_FED = ["trace", "systemctl", "curl", "incus"] as const

/**
 * Compare every artifact, most-localising first.
 *
 * The order is deliberate: exit code, then stdout, then stderr, then the
 * ordered trace, then the per-stub logs, then the persistent state. A run that
 * diverges usually diverges in all of them at once, and the first assertion to
 * fire is the one a reader wants to see.
 *
 * `normalise` is `true` for exactly one scenario in this file. It rewrites the
 * four poll-fed logs on BOTH sides before comparing; everything else stays
 * strict, including stdout, stderr and git.log.
 *
 * `foreignLock` inverts the final absolute, and ONLY that. The lock-contention
 * rows stage a lock dir owned by a LIVE process before either drive starts, so
 * "absent afterwards" would be the failure: an engine that removed it stole a
 * lock whose owner is still running, which is the interleaving the lock exists
 * to prevent. The parity comparison of `lockDirPresent` above is unchanged.
 */
const expectParity = (
  pair: DrivenPair,
  opts: { readonly normalise?: boolean; readonly foreignLock?: boolean } = {},
): void => {
  const collapse = (a: Artifacts): Artifacts => {
    if (opts.normalise !== true) return a
    const out: Record<string, unknown> = { ...a }
    for (const key of POLL_FED) {
      const value = a[key]
      out[key] = value === null ? null : normalisePollBlocks(value)
    }
    return out as unknown as Artifacts
  }
  const b = collapse(pair.bash)
  const n = collapse(pair.binary)

  expect(n.exitCode, "exit code").toBe(b.exitCode)
  expect(n.stdout, "stdout").toBe(b.stdout)
  expect(n.stderr, "stderr").toBe(b.stderr)
  expect(n.trace, "trace.log (the shared ordered trace)").toBe(b.trace)
  expect(n.systemctl, "systemctl.log").toBe(b.systemctl)
  expect(n.curl, "curl.log").toBe(b.curl)
  expect(n.bun, "bun.log").toBe(b.bun)
  expect(n.incus, "incus.log").toBe(b.incus)
  expect(n.claude, "claude.log").toBe(b.claude)
  expect(n.ss, "ss.log").toBe(b.ss)
  expect(n.git, "git.log").toBe(b.git)
  expect(n.journal, "the transaction journal").toBe(b.journal)
  expect(n.lockDirPresent, "lock dir presence").toBe(b.lockDirPresent)
  expect(n.envFile, "$ENV_FILE bytes").toBe(b.envFile)
  expect(n.envFileMode, "$ENV_FILE mode").toBe(b.envFileMode)
  expect(n.head, "final git rev-parse HEAD").toBe(b.head)
  expect(n.tree, "the sorted path+mode listing").toEqual(b.tree)
  if (opts.foreignLock === true) {
    // The staged lock's owner is alive, so honouring it means leaving it alone.
    expect(b.lockDirPresent, "bash drive STOLE a lock whose owner process is alive").toBe(true)
    expect(n.lockDirPresent, "binary drive STOLE a lock whose owner process is alive").toBe(true)
    return
  }
  // The lock is released on EVERY terminal path, on both drives. Asserted as
  // an absolute rather than only as a parity fact: two drives that both leaked
  // it would diff clean.
  expect(b.lockDirPresent, "bash drive leaked the update lock").toBe(false)
  expect(n.lockDirPresent, "binary drive leaked the update lock").toBe(false)
}

/** Count occurrences of a substring, for the "exactly once" line assertions. */
const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1

/** The index of a line containing `needle`, or -1. Used for ORDER assertions inside one artifact. */
const lineIndexOf = (text: string, needle: string): number =>
  text.split("\n").findIndex((line) => line.includes(needle))

/** `claude: { stub: "present" }` on every row that is not about the degrade path, so artifact 8 compares written bytes rather than "absent equals absent". */
const CLAUDE_PRESENT = { stub: "present" } as const

/** The container name every incus row uses. Not a real container: the fixture's `incus` is a logging passthrough. */
const CONTAINER = "luna-test"

/** Generous, and used by the rows that drive TWO dual-drive scenarios in one `it` because the contract they assert is a RELATION between the two. */
const PAIR_ROW_TIMEOUT = 300_000

/**
 * `process_fingerprint` (:951-960), evaluated by the ORACLE rather than by the
 * port.
 *
 * The lock-contention rows need an owner record both engines classify as LIVE.
 * Manufacturing one means writing the fingerprint bash itself would compute,
 * so this runs bash's two arms verbatim - `/proc/<pid>/stat` field 20 after the
 * greedy `) ` strip on Linux, `ps -p <pid> -o lstart=` piped through `tr -d`
 * elsewhere - under the same interpreter both drives run. Deriving it from
 * `lock.ts`'s port instead would assume the very equivalence the row exists to
 * observe: if the port fingerprints differently, the binary drive classifies
 * the lock STALE and takes it over while bash honours it, and this suite must
 * report that as a red byte diff rather than paper over it.
 *
 * Only trailing NEWLINES are stripped, matching `$(...)`. The `ps` arm's
 * padding is significant and is compared byte for byte by both engines.
 *
 * IT RUNS UNDER THE DRIVES' OWN `TZ`/`LANG`/`LC_ALL`, and that is not
 * decoration. `ps -o lstart=` renders a LOCAL, LOCALE-FORMATTED timestamp, so
 * the same live process fingerprints as `Sun Aug  9 23:41:17 2026` here and as
 * something else entirely inside `driveEnv`'s `TZ=UTC LANG=C LC_ALL=C` - and a
 * fingerprint that disagrees is exactly how a lock whose owner is alive gets
 * classified STALE and stolen. Measured, not reasoned about: staged under the
 * ambient environment, BOTH engines took the stale-takeover branch.
 */
const oracleProcessFingerprint = (pid: number): string => {
  const script = [
    'pid="$1"',
    'if [[ -r "/proc/$pid/stat" ]]; then',
    `  sed 's/^.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $20}'`,
    "else",
    `  ps -p "$pid" -o lstart= 2>/dev/null | tr -d '\\n'`,
    "fi",
  ].join("\n")
  const r = spawnSync(resolveHostTool("bash"), ["-c", script, "fingerprint", String(pid)], {
    encoding: "utf8",
    // The three keys driveEnv pins (bash-fixtures.ts's driveEnv). PATH is the
    // AMBIENT one on purpose: `ps`, `sed` and `awk` are host tools and the
    // fixture bin dir must never shadow them.
    env: { PATH: process.env.PATH ?? "", TZ: "UTC", LANG: "C", LC_ALL: "C" },
  })
  const out = (r.stdout ?? "").replace(/\n+$/, "")
  if (out === "") {
    throw new Error(
      `oracleProcessFingerprint(${pid}) produced nothing, so no lock owner record can be staged. ` +
        "Both bash arms failed: /proc/<pid>/stat is unreadable AND `ps -p <pid> -o lstart=` printed nothing.",
    )
  }
  return out
}

/** Computed once: this process's own fingerprint is constant for the life of the run, and every contention row wants the same live owner. */
let liveOwnerFingerprintCache: string | null = null
const liveOwnerFingerprint = (): string => {
  if (liveOwnerFingerprintCache === null) liveOwnerFingerprintCache = oracleProcessFingerprint(process.pid)
  return liveOwnerFingerprintCache
}

/**
 * Stage a held update lock whose owner is THIS process (`acquire_update_lock`,
 * :995-997), so both engines take the contention branch at :1872-1881.
 *
 * The test runner is the only process guaranteed to still be alive when each
 * drive runs, and using it needs no spawn, no sleep and no cleanup race. The
 * record is byte-identical to the one bash writes, including the trailing
 * newline and the 0600 mode, because bash's own `lock_owner_alive` is one of
 * the two readers that must accept it.
 */
const holdLockForALiveOwner = (fixture: Fixture): void => {
  mkdirSync(fixture.lockDir, { recursive: true })
  writeFileSync(join(fixture.lockDir, "owner"), `pid=${process.pid}\nfingerprint=${liveOwnerFingerprint()}\n`, {
    mode: 0o600,
  })
}

/**
 * Replace the fixture's `ss` with one that answers ZERO sessions on its first
 * invocation and ONE on every invocation after it.
 *
 * WHY A SCENARIO WRITES A STUB AT ALL, which is a thing this file otherwise
 * never does. Two of bash's five distinct exit-3 sites - the mid-transaction
 * defer (:2059) and the rollback-restart defer (:1830) - are reachable ONLY
 * when the guard PERMITS at the pre-mutation check and then DEFERS at a later
 * one inside the same run. Every static `ss` answer gives the same verdict at
 * both, so those two sites are unreachable through `FixtureOptions` as it
 * stands, and :1830 is the site the whole "an apply-phase failure keeps the
 * guard ACTIVE" branch exists for. Counting invocations is the smallest change
 * that separates the two checks.
 *
 * It is safe for the diff for the reason every other stub is: BOTH drives get
 * the same script over their own roots, so the counter is per-drive. It is not
 * a masking device either - if the port evaluates the guard a different NUMBER
 * of times than bash does, the two drives take different branches and `ss.log`,
 * stderr and the exit code all diverge, which is exactly the report a reader
 * wants. The line shapes are copied from `writeSsStub` so `ss.log` keeps its
 * meaning.
 */
const writeDeferOnLaterChecksSsStub = (fixture: Fixture): void => {
  const calls = join(fixture.temp, "ss.guard-calls")
  const ssBin = join(fixture.bin, "ss")
  writeFileSync(
    ssBin,
    `#!/usr/bin/env bash
printf 'ss %s\\n' "$*" >> "${fixture.traceLog}"
printf 'ss %s\\n' "$*" >> "${fixture.ssLog}"
n=1
if [[ -f "${calls}" ]]; then n=$(( $(cat "${calls}") + 1 )); fi
printf '%s' "$n" > "${calls}"
if [[ "$n" -ge 2 ]]; then printf 'ESTAB 0 0 127.0.0.1:${fixture.readinessPort} 127.0.0.1:12345\\n'; fi
exit 0
`,
  )
  chmodSync(ssBin, 0o755)
}

/** Seed a transaction journal in the shape `write_transaction` writes (:1013), for the resume and corrupt rows. */
const seedJournal = (
  fixture: Fixture,
  fields: { phase: string; prev: string; target: string; prevLockHash?: string; updatedAt?: string },
): void => {
  mkdirSync(fixture.updateState, { recursive: true })
  writeFileSync(
    fixture.journalPath,
    `phase=${fields.phase}\nprev=${fields.prev}\ntarget=${fields.target}\n` +
      `prev_lock_hash=${fields.prevLockHash ?? ""}\nupdated_at=${fields.updatedAt ?? "1767225600"}\n`,
    { mode: 0o600 },
  )
}

describe("GATE 1: full-flow parity, bare-host topology", () => {
  it(
    "happy path, lockfile unchanged: one readiness call of one poll iteration",
    () => {
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(0)
      expect(pair.bash.stdout).toContain("bun.lock unchanged -> skipping bun install")
      expect(pair.bash.stdout).toContain("post-deploy: seeding V2 dream/wake job rows (idempotent)")
      // The journal is CLEARED on success (:2076), not left behind.
      expect(pair.bash.journal).toBeNull()
      expect(pair.bash.head).toBe(pair.bashFixture.targetSha)
    },
    ROW_TIMEOUT,
  )

  it(
    "happy path, lockfile changed: install THEN restart THEN readiness THEN seed",
    () => {
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, lockChanges: true, claude: CLAUDE_PRESENT },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(0)
      const trace = pair.bash.trace ?? ""
      const install = lineIndexOf(trace, "bun install")
      const restart = lineIndexOf(trace, "systemctl stop")
      const readiness = lineIndexOf(trace, "/healthz")
      const seed = lineIndexOf(trace, "dream-wake-install.ts")
      expect(install, "bun install missing from trace.log").toBeGreaterThan(-1)
      expect(restart, "systemctl stop missing from trace.log").toBeGreaterThan(install)
      expect(readiness, "readiness probe must follow the restart").toBeGreaterThan(restart)
      expect(seed, "the dream/wake seed must follow readiness").toBeGreaterThan(readiness)
    },
    ROW_TIMEOUT,
  )

  it(
    "readiness fails, rollback recovers: exit 1, and the give-up line EXACTLY ONCE",
    () => {
      // TWO readiness calls, one poll iteration each. The forward call ends in
      // the give-up line at :1124; the rollback call RETURNS 0 from inside the
      // iteration at :1105 (readyAtPrev), so it never reaches :1124. That is
      // why the line appears once here and twice only on the row below.
      const pair = driveBoth({
        fixture: { readyAtTarget: false, readyAtPrev: true, claude: CLAUDE_PRESENT },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(1)
      expect(pair.bash.stderr).toContain(`ROLLED BACK to ${pair.bashFixture.prevSha}`)
      expect(countOf(pair.bash.stderr, "readiness gave up after")).toBe(1)
      // Rolled back means back at PREV, and the journal cleared on the way out (:1840).
      expect(pair.bash.head).toBe(pair.bashFixture.prevSha)
      expect(pair.bash.journal).toBeNull()
      // The seed fires only on the healthy path, so ZERO times here (:2075).
      expect(countOf(pair.bash.trace ?? "", "dream-wake-install.ts")).toBe(0)
    },
    ROW_TIMEOUT,
  )

  it(
    "rollback also fails: exit 2, the CRITICAL hint, and the give-up line TWICE",
    () => {
      // Both readiness calls exhaust, one iteration each, so the give-up line
      // is emitted twice - the only scenario where that is true.
      const pair = driveBoth({
        fixture: { readyAtTarget: false, readyAtPrev: false, claude: CLAUDE_PRESENT },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(2)
      expect(countOf(pair.bash.stderr, "readiness gave up after")).toBe(2)
      // The hint is SUPERVISOR-conditional (:1848-1855); this fixture is systemd, non-user.
      expect(pair.bash.stderr).toContain(`systemctl status ${pair.bashFixture.serviceName}`)
      expect(pair.bash.stderr).toContain("server may be DOWN")
      // The CRITICAL line is emitted BEFORE the rollback-failed phase write
      // (:1856-1857). This suite can only see that both drives agree on the
      // bytes and on the journal; the strict BEFORE ordering is asserted where
      // it can be observed without a crash seam, in rollback-parity.test.ts.
      expect(pair.bash.journal).toContain("phase=rollback-failed")
    },
    ROW_TIMEOUT,
  )

  it(
    "--no-rollback: exit 1, journal at phase=forward-failed, BOTH fail_forward lines",
    () => {
      // One readiness call, one iteration, ending in give-up; no rollback, so
      // no second call.
      const pair = driveBoth({
        fixture: { readyAtTarget: false, readyAtPrev: true, claude: CLAUDE_PRESENT },
        extraArgs: ["--no-rollback"],
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(1)
      // :1863 on every call, then :1866's --no-rollback arm. Both were dropped
      // by the revision that inlined fail_forward instead of calling it.
      expect(pair.bash.stderr).toContain("failed: failed readiness (HEAD=")
      expect(pair.bash.stderr).toContain("--no-rollback set; server left at")
      expect(pair.bash.journal).toContain("phase=forward-failed")
      // Left at the NEW ref, deliberately: --no-rollback means do not restore.
      expect(pair.bash.head).toBe(pair.bashFixture.targetSha)
    },
    ROW_TIMEOUT,
  )

  it(
    "apply-phase failure: the guard stays ACTIVE for the rollback restart, checkout back at PREV",
    () => {
      // The apply fails at the node_modules postcondition (:1210-1215): the
      // lockfile changed so `bun install` runs, the stub exits 0 without
      // creating anything, and the directory the fixture normally carries has
      // been removed. That is the ONE apply failure this fixture can stage
      // without a stub that fails on demand.
      //
      // The forward restart never happened, so FORWARD_RESTART_RAN is false and
      // do_rollback keeps the guard ACTIVE (:1810-1813) - the branch that
      // distinguishes an apply-phase failure from a post-restart one.
      //
      // ZERO readiness calls: the rollback's own apply hits the SAME missing
      // node_modules (its `git reset --hard` to PREV restores lock-v1, which
      // differs from the lock-v2 hash computed fresh at :1821, so `bun install`
      // runs again and its postcondition fails again), so the run converges on
      // the single exit-2 CRITICAL terminal without ever probing readiness.
      // That is the honest shape of this fixture: the only apply failure it can
      // stage is one that recurs on the way back, so it cannot also exercise a
      // SUCCESSFUL rollback from an apply-phase failure.
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, lockChanges: true, claude: CLAUDE_PRESENT },
        prepare: (fixture) => {
          rmSync(join(fixture.work, "node_modules"), { recursive: true, force: true })
        },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(2)
      expect(pair.bash.stderr).toContain(
        "rollback after an apply-phase failure: the old server was never stopped, so the session guard stays ACTIVE for the rollback restart",
      )
      expect(pair.bash.stderr).toContain("failed: apply to")
      // The rollback's reset landed before its install postcondition failed, so
      // the checkout is back at PREV even though the transaction is CRITICAL.
      expect(pair.bash.head).toBe(pair.bashFixture.prevSha)
      expect(pair.bash.journal).toContain("phase=rollback-failed")
      // ZERO readiness calls means the readiness probe never ran at all.
      expect(countOf(pair.bash.trace ?? "", "/healthz")).toBe(0)
    },
    ROW_TIMEOUT,
  )
})

describe("GATE 1: the session guard, both drives probing the same `ss` stub", () => {
  it(
    "fresh-run defer, one established session: exit 3 and NOTHING written",
    () => {
      // ZERO readiness calls: the guard defers before the first journal write.
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT, ss: { sessions: 1 } },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(3)
      expect(pair.bash.journal, "a deferred fresh run leaves nothing behind (:1997-2001)").toBeNull()
      expect(pair.bash.head).toBe(pair.bashFixture.prevSha)
    },
    ROW_TIMEOUT,
  )

  it(
    "fresh-run defer, two sessions: the guard's own line THEN the caller's",
    () => {
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT, ss: { sessions: 2 } },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(3)
      const guardLine = lineIndexOf(
        pair.bash.stderr,
        `session guard: 2 active session(s) on :${pair.bashFixture.readinessPort}`,
      )
      const callerLine = lineIndexOf(pair.bash.stderr, "DEFERRED by session guard; nothing mutated")
      expect(guardLine, "the :1477 guard verdict line is missing").toBeGreaterThan(-1)
      expect(callerLine, "the :1999 caller line must FOLLOW the guard's own").toBeGreaterThan(guardLine)
    },
    ROW_TIMEOUT,
  )

  it(
    "ws count UNKNOWN with the unit answering 'inactive': the dead-server exception, on a SUCCESSFUL run",
    () => {
      // `ss` exits 1, so both engines fall to `systemctl is-active`, which
      // answers 'inactive' until the first `start` lands. This is the only
      // guard line that appears on a run that then succeeds (:1491).
      // ONE readiness call of one iteration: by then a `start` has happened, so
      // is-active answers 'active'.
      const pair = driveBoth({
        fixture: {
          readyAtTarget: true,
          readyAtPrev: true,
          claude: CLAUDE_PRESENT,
          ss: { rc: 1 },
          isActive: "inactive",
        },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(0)
      expect(pair.bash.stderr).toContain(
        "session guard: ws count unknown but unit answered 'inactive' — no server process; restart permitted",
      )
    },
    ROW_TIMEOUT,
  )

  it(
    "ws count UNKNOWN with the unit answering 'activating': fail closed, exit 3",
    () => {
      const pair = driveBoth({
        fixture: {
          readyAtTarget: true,
          readyAtPrev: true,
          claude: CLAUDE_PRESENT,
          ss: { rc: 1 },
          isActive: "activating",
        },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(3)
      expect(pair.bash.stderr).toContain(
        "session guard: ws count unknown while unit answers 'activating' — may be serving; deferring (fail closed)",
      )
      expect(pair.bash.journal).toBeNull()
    },
    ROW_TIMEOUT,
  )
})

describe("GATE 1: the journal fork", () => {
  it(
    "corrupt journal, unparsable phase: exit 2 and the checkout UNTOUCHED",
    () => {
      // ZERO readiness calls, ZERO git calls past the corrupt-journal refusal.
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT },
        prepare: (fixture) => {
          seedJournal(fixture, { phase: "bogus", prev: fixture.prevSha, target: fixture.targetSha })
        },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(2)
      // A RAW printf with no `warning: ` prefix (:1924-1925).
      expect(pair.bash.stderr).toContain("CRITICAL: corrupt update transaction journal")
      expect(pair.bash.head).toBe(pair.bashFixture.prevSha)
      // Refusing to mutate includes refusing to remove the evidence.
      expect(pair.bash.journal).toContain("phase=bogus")
    },
    ROW_TIMEOUT,
  )

  it(
    "corrupt journal, a prev that is not a sha: exit 2",
    () => {
      // load_transaction validates four fields (:1041-1044); a bad phase and a
      // bad prev are different arms and a port could easily implement one.
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT },
        prepare: (fixture) => {
          seedJournal(fixture, { phase: "prepared", prev: "not-a-sha", target: fixture.targetSha })
        },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(2)
    },
    ROW_TIMEOUT,
  )

  it(
    "corrupt journal, a prev_lock_hash that is neither empty nor hex: exit 2",
    () => {
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT },
        prepare: (fixture) => {
          seedJournal(fixture, {
            phase: "prepared",
            prev: fixture.prevSha,
            target: fixture.targetSha,
            prevLockHash: "zzz",
          })
        },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(2)
    },
    ROW_TIMEOUT,
  )
})

describe("GATE 1: the post-stop settle, which every production deploy runs at 6s", () => {
  // The default in driveEnv is "0", which SKIPS settle_after_stop at :1274
  // before it can print anything. Production runs 6 (config.ts's default), so a
  // gate that only ever ran at "0" could never have seen the :1279 line, the
  // :1276 refusal or the :1283 sleep failure - spec blocker R1. Each row below
  // is a HAPPY path whose readiness succeeds on its first poll, so the settle is
  // the only thing that varies.

  it(
    "LUNA_RESTART_SETTLE_SECS=1: the :1279 settling line, and the restart still succeeds",
    () => {
      // ONE readiness call of one poll iteration.
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT },
        settleSecs: "1",
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(0)
      expect(pair.bash.stdout).toContain("settling 1s after stop so DuckDB/SQLite release WAL/SHM before start")
      expect(pair.bash.head).toBe(pair.bashFixture.targetSha)
    },
    ROW_TIMEOUT,
  )

  it(
    "LUNA_RESTART_SETTLE_SECS=abc: the :1276 invalid-value warn, no settling line, and the restart STILL succeeds",
    () => {
      // settle_after_stop validates BEFORE sleeping and returns 0 anyway, so an
      // invalid value must never trip set -e or route into rollback.
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT },
        settleSecs: "abc",
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(0)
      expect(pair.bash.stderr).toContain(
        "RESTART_SETTLE_SECS='abc' is not a non-negative number of seconds; SKIPPING the post-stop settle",
      )
      expect(pair.bash.stdout).not.toContain("settling")
    },
    ROW_TIMEOUT,
  )

  it(
    "a settle whose `sleep` FAILS: the :1283 warn, after the :1279 line, between the stop and the start",
    () => {
      // `failingSleep` intercepts every `sleep` on PATH, which is safe here for
      // one reason only: this row's readiness succeeds on its FIRST poll, so
      // the settle is the only caller of `sleep` and a failing stub cannot spin
      // the readiness loop (bash-fixtures.ts's writeFailingSleepStub says the
      // same thing at the stub).
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT, failingSleep: true },
        settleSecs: "1",
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(0)
      expect(pair.bash.stdout).toContain("settling 1s after stop")
      expect(pair.bash.stderr).toContain("post-stop settle sleep failed (RESTART_SETTLE_SECS='1')")
      // The two lines live on DIFFERENT streams (luna_info -> stdout, luna_warn
      // -> stderr), so "the :1279 line precedes the :1283 one" is asserted where
      // it is actually observable: the ordered trace, which shows the settle
      // sitting inside the restart window it exists to occupy.
      const trace = pair.bash.trace ?? ""
      const stop = lineIndexOf(trace, "systemctl stop")
      const slept = lineIndexOf(trace, "sleep 1")
      const start = lineIndexOf(trace, "systemctl start")
      expect(stop, "systemctl stop missing from trace.log").toBeGreaterThan(-1)
      expect(slept, "the settle sleep must follow the stop").toBeGreaterThan(stop)
      expect(start, "the start must follow the settle").toBeGreaterThan(slept)
    },
    ROW_TIMEOUT,
  )
})

describe("GATE 1: the two ref spellings where REF and NEW_HEAD separate", () => {
  // On every other row REF is `origin/master` and NEW_HEAD is the sha it
  // resolves to. These two are the spellings where REF is ITSELF hex and the
  // :1985-1990 arm short-circuits the rev-parse, so REF and NEW_HEAD differ in
  // LENGTH (abbrev) or in CASE (uppercase) while naming the same commit. Both
  // travel into the journal, the `Target ref:` banner, the success line and
  // readiness's buildSha compare.
  const refRow = (label: string, spell: (fixture: Fixture) => string): void => {
    it(
      label,
      () => {
        // ONE readiness call of one poll iteration.
        const pair = driveBoth({
          fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT },
          extraArgs: (fixture) => ["--ref", spell(fixture)],
        })
        expectParity(pair)
        expect(pair.bash.exitCode).toBe(0)
        expect(pair.bash.stdout).toContain(`Target ref: ${spell(pair.bashFixture)}`)
        // git answers lowercase and full-length whatever the request was.
        expect(pair.bash.head).toBe(pair.bashFixture.targetSha)
        expect(pair.bash.journal).toBeNull()
      },
      ROW_TIMEOUT,
    )
  }

  refRow("--ref <7-char abbrev>: the reset postcondition's prefix compare", (f) => f.targetSha.slice(0, 7))
  refRow("--ref <UPPERCASE 40-hex>: the reset postcondition's case fold", (f) => f.targetSha.toUpperCase())
})

describe("GATE 1: readiness determinism", () => {
  it(
    "retry to SUCCESS: three poll iterations on each drive, strict, nothing normalised",
    () => {
      // The ONE row that does not use PINNED_READINESS, and it does not need to
      // be normalised: `readyAfterCalls` counts the stub's own INVOCATIONS, not
      // the clock, so "ready on the third call" is machine-independent. The
      // window (10s) only has to be wide enough to hold three iterations at a
      // 1s interval on any machine, which is what makes this the STRICT proof
      // that both engines re-poll rather than deciding once.
      const pair = driveBoth({
        fixture: {
          readyAtTarget: true,
          readyAtPrev: true,
          claude: CLAUDE_PRESENT,
          readyAfterCalls: 3,
          readiness: { timeout: "10", interval: "1" },
        },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(0)
      // Per drive, never cross-drive: this is the assertion the normalisation
      // rule in bash-fixtures.ts leans on, so it must hold on each engine on
      // its own evidence.
      expect(countOf(pair.bash.curl ?? "", "/healthz"), "bash drive: /healthz calls").toBe(3)
      expect(countOf(pair.binary.curl ?? "", "/healthz"), "binary drive: /healthz calls").toBe(3)
    },
    ROW_TIMEOUT,
  )

  it(
    "retry to EXHAUSTION: the ONLY normalised row, and its pre-collapse poll count is asserted per drive",
    () => {
      // ONE readiness call (--no-rollback, so there is no second one) that runs
      // to the end of its window. The iteration count here is genuinely
      // unpinnable - `ceil(window / (interval + per-iteration cost))` with a
      // machine-dependent cost - which is the whole justification for the
      // collapse. Everything outside the four poll-fed logs stays strict,
      // including stdout, stderr and git.log.
      const pair = driveBoth({
        fixture: {
          readyAtTarget: false,
          readyAtPrev: true,
          claude: CLAUDE_PRESENT,
          readiness: { timeout: "5", interval: "1" },
        },
        extraArgs: ["--no-rollback"],
      })
      expectParity(pair, { normalise: true })
      expect(pair.bash.exitCode).toBe(1)
      expect(pair.bash.stderr).toContain("readiness gave up after 5s:")
      expect(pair.bash.journal).toContain("phase=forward-failed")
      // OUTSIDE the diff and on the RAW (uncollapsed) artifacts: a port that
      // polled once and gave up would produce a single block, which collapses
      // to itself and would diff clean against bash's many.
      expect(countOf(pair.bash.curl ?? "", "/healthz"), "bash drive polled fewer than twice").toBeGreaterThan(1)
      expect(countOf(pair.binary.curl ?? "", "/healthz"), "binary drive polled fewer than twice").toBeGreaterThan(1)
    },
    ROW_TIMEOUT,
  )
})

describe("GATE 1: EXIT 3 IS THE SESSION GUARD, EXIT 4 IS LOCK CONTENTION", () => {
  // The single failure mode the bash caller block (:1872-1881), lock.ts's
  // header and terminals.ts all argue about, because conflating the two made
  // the guardian page "DEFERRED by session guard - live or unknown sessions"
  // while the real cause was a concurrent update holding the profile lock, and
  // that sends an incident responder to a false diagnosis at the one moment
  // they cannot afford one. Both codes are driven dual-drive here, on the SAME
  // argv, differing only in which condition is staged.

  it(
    "--restart-only: live sessions are 3, a live lock owner is 4, and the two are never the same code",
    () => {
      const deferred = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT, ss: { sessions: 1 } },
        extraArgs: ["--restart-only"],
      })
      expectParity(deferred)
      const contended = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT },
        extraArgs: ["--restart-only"],
        prepare: holdLockForALiveOwner,
      })
      expectParity(contended, { foreignLock: true })

      expect(deferred.bash.exitCode, "bash: --restart-only with a live session").toBe(3)
      expect(deferred.binary.exitCode, "binary: --restart-only with a live session").toBe(3)
      expect(contended.bash.exitCode, "bash: --restart-only against a live lock owner").toBe(4)
      expect(contended.binary.exitCode, "binary: --restart-only against a live lock owner").toBe(4)
      // Stated as a RELATION and not only as two absolutes: a build that
      // collapsed both onto one code would satisfy neither of the pairs above
      // only by luck, and this is the assertion whose failure names the defect.
      expect(
        deferred.binary.exitCode,
        "the binary reported lock contention and a session-guard defer with the SAME exit code",
      ).not.toBe(contended.binary.exitCode)

      // And the two are distinguishable in the OPERATOR text as well, which is
      // what a responder actually reads.
      expect(deferred.bash.stderr).toContain(
        `session guard: 1 active session(s) on :${deferred.bashFixture.readinessPort}`,
      )
      expect(deferred.bash.stderr).not.toContain("is already running")
      expect(contended.bash.stderr).toContain(
        `DEFERRED: another update for profile '${contended.bashFixture.profile}' is already running`,
      )
      expect(contended.bash.stderr).not.toContain("session guard")
      // Contention mutates NOTHING: no journal, and the checkout untouched.
      expect(contended.bash.journal).toBeNull()
      expect(contended.bash.head).toBe(contended.bashFixture.prevSha)
    },
    PAIR_ROW_TIMEOUT,
  )

  it(
    "without --restart-only, the SAME contention is exit 0: a safe defer the timer retries",
    () => {
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT },
        prepare: holdLockForALiveOwner,
      })
      expectParity(pair, { foreignLock: true })
      expect(pair.bash.exitCode, "a normal run defers on contention with 0, not 1 and not 4").toBe(0)
      expect(pair.binary.exitCode).toBe(0)
      // Exit 0 without having deployed anything: the checkout must be untouched
      // and no readiness probe may have run, or "0" would mean something else.
      expect(pair.bash.head).toBe(pair.bashFixture.prevSha)
      expect(pair.bash.journal).toBeNull()
      expect(countOf(pair.bash.trace ?? "", "/healthz")).toBe(0)
    },
    ROW_TIMEOUT,
  )
})

describe("GATE 1: --restart-only, the repair ladder's first rung", () => {
  it(
    "the healthy rung: exit 0, no journal write, no git mutation, no install",
    () => {
      // ONE readiness call of one poll iteration, at PREV: --restart-only never
      // moves the checkout, so readyAtPrev is what gates it.
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT },
        extraArgs: ["--restart-only"],
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(0)
      expect(pair.bash.stdout).toContain(
        `restart-only: ${pair.bashFixture.serviceName} healthy at ${pair.bashFixture.prevSha.slice(0, 12)}`,
      )
      expect(pair.bash.journal, "the light path writes no journal at all").toBeNull()
      expect(pair.bash.head).toBe(pair.bashFixture.prevSha)
      // No fetch and no reset: rung 1 is a guarded restart, nothing more.
      expect(countOf(pair.bash.git ?? "", " fetch ")).toBe(0)
      expect(countOf(pair.bash.git ?? "", " reset ")).toBe(0)
      expect(countOf(pair.bash.bun ?? "", "install")).toBe(0)
    },
    ROW_TIMEOUT,
  )

  it(
    "readiness fails after the plain restart: exit 1, checkout untouched, NO rollback",
    () => {
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: false, claude: CLAUDE_PRESENT },
        extraArgs: ["--restart-only"],
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(1)
      expect(pair.bash.stderr).toContain("restart-only: readiness failed after plain restart (checkout untouched; no rollback)")
      expect(pair.bash.stderr).not.toContain("ROLLED BACK to")
      expect(pair.bash.head).toBe(pair.bashFixture.prevSha)
      expect(pair.bash.journal).toBeNull()
    },
    ROW_TIMEOUT,
  )

  it(
    "MainPID unchanged across the restart: the :1563 POSTCONDITION warn THEN the :1896 restart-errored warn, exit 1",
    () => {
      // The queue's last answer repeats, so one entry answers both the pre- and
      // the post-restart query with the same nonzero pid - the POSITIVE proof
      // that the stop silently failed. ZERO readiness calls: rung 1 gives up
      // before probing.
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT, mainPid: ["4242"] },
        extraArgs: ["--restart-only"],
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(1)
      const postcondition = lineIndexOf(
        pair.bash.stderr,
        "POSTCONDITION: restart did not replace the server process (MainPID before=4242 after=4242)",
      )
      const errored = lineIndexOf(pair.bash.stderr, "restart-only: restart errored (checkout untouched; no rollback)")
      expect(postcondition, "the :1563 warn is missing - restart.ts must print it for --restart-only too").toBeGreaterThan(-1)
      expect(errored, "the :1896 caller line must FOLLOW the primitive's own").toBeGreaterThan(postcondition)
      expect(countOf(pair.bash.trace ?? "", "/healthz")).toBe(0)
    },
    ROW_TIMEOUT,
  )

  // THE TWO NON-NEGOTIABLE ROWS (spec:1291). A pending journal takes precedence
  // over the light path: :1885-1887 warns and FALLS THROUGH into normal
  // recovery rather than restarting a checkout that is mid-transaction. That
  // fallthrough is what update-flow.ts calls the most important structural fact
  // in the file, and these are the only end-to-end proof it is intact. If they
  // cannot be made to pass, the restart-only factoring is what to change.

  it(
    "NON-NEGOTIABLE: --restart-only with a pending phase=verifying journal completes the UPDATE and clears it",
    () => {
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT },
        extraArgs: ["--restart-only"],
        prepare: (fixture) => {
          seedJournal(fixture, { phase: "verifying", prev: fixture.prevSha, target: fixture.targetSha })
        },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(0)
      expect(pair.bash.stderr).toContain(
        "restart-only requested but an update transaction is pending; running normal recovery instead",
      )
      expect(pair.bash.stderr).toContain("RECOVERING interrupted update phase=verifying")
      // It ran the UPDATE, not the light path: HEAD moved to the target and the
      // journal was cleared on success.
      expect(pair.bash.head).toBe(pair.bashFixture.targetSha)
      expect(pair.bash.journal).toBeNull()
      expect(pair.bash.stdout).not.toContain("restart-only: ")
    },
    ROW_TIMEOUT,
  )

  it(
    "NON-NEGOTIABLE: the same pending journal with readiness failing rolls back and exits 1",
    () => {
      const pair = driveBoth({
        fixture: { readyAtTarget: false, readyAtPrev: true, claude: CLAUDE_PRESENT },
        extraArgs: ["--restart-only"],
        prepare: (fixture) => {
          seedJournal(fixture, { phase: "verifying", prev: fixture.prevSha, target: fixture.targetSha })
        },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(1)
      expect(pair.bash.stderr).toContain(
        "restart-only requested but an update transaction is pending; running normal recovery instead",
      )
      expect(pair.bash.stderr).toContain(`ROLLED BACK to ${pair.bashFixture.prevSha}`)
      expect(pair.bash.head).toBe(pair.bashFixture.prevSha)
      expect(pair.bash.journal).toBeNull()
    },
    ROW_TIMEOUT,
  )
})

describe("GATE 1: the two exit-3 sites a STATIC session-guard answer cannot reach", () => {
  it(
    "apply-phase failure, then the ROLLBACK restart is deferred: exit 3, journal RETAINED at phase=rolling-back",
    () => {
      // bash :1826-1831, the branch the ACTIVE-guard warn at :1810-1813 exists
      // to set up, and the one exit-3 site with no other oracle row anywhere.
      //
      // The staging, which is the only shape this fixture admits:
      //  - a resume from phase=checkout whose journal carries a prev_lock_hash
      //    that matches NOTHING, so the FORWARD apply takes the install arm;
      //  - node_modules removed, so that install's postcondition (:1210-1215)
      //    fails and apply_ref returns 1 with the old server never stopped
      //    (FORWARD_RESTART_RAN=false, so do_rollback keeps the guard ACTIVE);
      //  - the ROLLBACK's apply computes its prev_lock_hash FRESH at :1821, and
      //    prev and target carry the same bun.lock here, so its install is
      //    SKIPPED and the rollback apply SUCCEEDS - which is what lets the run
      //    reach the rollback restart at all, and is exactly what the delivered
      //    apply-failure row above cannot do;
      //  - an `ss` that answers 0 on the first guard check and 1 afterwards, so
      //    the pre-mutation check PERMITS and the rollback restart DEFERS.
      const bogusLockHash = ["0123456789abcdef0123", "456789abcdef01234567"].join("")
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT },
        prepare: (fixture) => {
          seedJournal(fixture, {
            phase: "checkout",
            prev: fixture.prevSha,
            target: fixture.targetSha,
            prevLockHash: bogusLockHash,
          })
          rmSync(join(fixture.work, "node_modules"), { recursive: true, force: true })
          writeDeferOnLaterChecksSsStub(fixture)
        },
      })
      expectParity(pair)
      expect(pair.bash.exitCode, "a deferred rollback restart is 3, never 1 and never 2").toBe(3)
      expect(pair.bash.stderr).toContain(
        "rollback after an apply-phase failure: the old server was never stopped, so the session guard stays ACTIVE for the rollback restart",
      )
      expect(pair.bash.stderr).toContain(
        `rollback restart DEFERRED by session guard (old server still serving; checkout already restored to ${pair.bashFixture.prevSha}); transaction journal retained (phase=rolling-back)`,
      )
      // The checkout is already back at PREV - the state the still-running
      // server was built from - so nothing is stranded, and the journal is what
      // finishes the restart on the next idle tick.
      expect(pair.bash.head).toBe(pair.bashFixture.prevSha)
      expect(pair.bash.journal).toContain("phase=rolling-back")
      // ZERO readiness calls: the rollback never got as far as probing.
      expect(countOf(pair.bash.trace ?? "", "/healthz")).toBe(0)
    },
    ROW_TIMEOUT,
  )

  it(
    "a resume deferred by the guard: exit 3 with the journal retained at the phase it was found in",
    () => {
      // The :1946-1951 site. A deferred resume must keep the journal intact -
      // the whole point is that the next tick finishes the same transaction -
      // which is the opposite postcondition to the fresh-run defer above, where
      // nothing may be left behind.
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT, ss: { sessions: 1 } },
        prepare: (fixture) => {
          seedJournal(fixture, { phase: "restarting", prev: fixture.prevSha, target: fixture.targetSha })
        },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(3)
      expect(pair.bash.stderr).toContain(
        "DEFERRED by session guard; transaction journal retained (phase=restarting)",
      )
      expect(pair.bash.journal, "a deferred resume must NOT clear the journal").toContain("phase=restarting")
      // Deferred BEFORE any mutation: the checkout never moved.
      expect(pair.bash.head).toBe(pair.bashFixture.prevSha)
    },
    ROW_TIMEOUT,
  )
})

describe("GATE 1: resume from every phase the journal regex admits", () => {
  // All eight phases `:1041` accepts, which closes concern 6. The two rollback
  // phases route through do_rollback (:1932-1939); the other six are forward
  // resumes. Every one of them asserts that a resume performs ZERO `git fetch`:
  // the journal's target is an immutable sha resolved by the run that was
  // interrupted, and re-fetching would let origin's movement change what a
  // recovery completes.

  const FORWARD_PHASES = ["prepared", "checkout", "applied", "restarting", "verifying", "forward-failed"] as const

  for (const phase of FORWARD_PHASES) {
    it(
      `forward resume from phase=${phase}: exit 0, journal cleared, HEAD at the journal's target, ZERO fetch`,
      () => {
        // ONE readiness call of one poll iteration.
        const pair = driveBoth({
          fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT },
          prepare: (fixture) => {
            seedJournal(fixture, { phase, prev: fixture.prevSha, target: fixture.targetSha })
          },
        })
        expectParity(pair)
        expect(pair.bash.exitCode).toBe(0)
        expect(pair.bash.stderr).toContain(`RECOVERING interrupted update phase=${phase}`)
        expect(pair.bash.head).toBe(pair.bashFixture.targetSha)
        expect(pair.bash.journal).toBeNull()
        expect(countOf(pair.bash.git ?? "", " fetch "), "a resume must not re-fetch").toBe(0)
      },
      ROW_TIMEOUT,
    )
  }

  for (const phase of ["rolling-back", "rollback-failed"] as const) {
    it(
      `rollback resume from phase=${phase}: guard-exempt, back at PREV, exit 1, ZERO fetch`,
      () => {
        // A mid-rollback journal means a prior run already began the rollback,
        // so the service interruption already happened and the guard is exempt
        // (:1932-1939 sets FORWARD_RESTART_RAN=true before calling do_rollback).
        // ONE readiness call of one poll iteration, at PREV.
        const pair = driveBoth({
          fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT },
          prepare: (fixture) => {
            seedJournal(fixture, { phase, prev: fixture.prevSha, target: fixture.targetSha })
          },
        })
        expectParity(pair)
        expect(pair.bash.exitCode).toBe(1)
        expect(pair.bash.stderr).toContain(
          "rollback restart proceeds without the session guard: the forward restart already interrupted service",
        )
        expect(pair.bash.stderr).toContain(`ROLLED BACK to ${pair.bashFixture.prevSha}`)
        expect(pair.bash.head).toBe(pair.bashFixture.prevSha)
        expect(pair.bash.journal).toBeNull()
        expect(countOf(pair.bash.git ?? "", " fetch "), "a resume must not re-fetch").toBe(0)
      },
      ROW_TIMEOUT,
    )
  }
})

describe("GATE 1: the incus container topology", () => {
  // The transport nothing else in this file exercises: run_target /
  // run_target_capture (:352-369) wrap EVERY in-container step as
  // `incus exec <container> -- <argv>`, so the systemctl probes, the readiness
  // curls, the bun install, the node_modules postcondition and the claude
  // re-pin payload all change shape at once. `incus.log` records the RAW
  // in-container argv and is diffed strictly like every other artifact.
  //
  // It also observes the repo-dir AXIS directly, which a bare-host row
  // structurally cannot: config.ts collapses hostRepoDir and containerRepoDir
  // to the same value on the inplace bare-host layout, so a port that used the
  // wrong one of the two is invisible there and obvious here.

  it(
    "incus, happy path with the lock unchanged: container argv wrapped, git still HOST-side",
    () => {
      // ONE readiness call of one poll iteration, issued INSIDE the container.
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT, incus: CONTAINER },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(0)
      expect(pair.bash.head).toBe(pair.bashFixture.targetSha)
      expect(pair.bash.journal).toBeNull()
      const incus = pair.bash.incus ?? ""
      expect(incus, "no incus.log at all means the wrapper never ran").not.toBe("")
      expect(incus).toContain(`exec ${CONTAINER} --`)
      // The readiness probe runs inside the container, against the container's
      // own loopback, not the host's proxied port.
      expect(incus).toContain(`/healthz`)
      // THE AXIS: the claude re-pin payload carries CONTAINER paths...
      expect(incus, "the in-container payload must carry CONTAINER_REPO_DIR").toContain("/root/luna")
      // ...while every git call is host-side, against the fixture's own root.
      expect(pair.bash.git ?? "", "git runs on the HOST repo, never the container path").not.toContain("/root/luna")
      expect(pair.bash.git ?? "").toContain(MASK_ROOT)
    },
    ROW_TIMEOUT,
  )

  it(
    "incus, happy path with the lock CHANGED: install and its postcondition both run in-container",
    () => {
      const pair = driveBoth({
        fixture: {
          readyAtTarget: true,
          readyAtPrev: true,
          lockChanges: true,
          claude: CLAUDE_PRESENT,
          incus: CONTAINER,
        },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(0)
      const incus = pair.bash.incus ?? ""
      // `bun --cwd` is the IN-CONTAINER repo, and so is the node_modules test
      // that gates the install (:1207-1213). Both are the exact places a port
      // that reached for hostRepoDir would still pass on a bare host.
      expect(incus).toContain("install --cwd /root/luna --frozen-lockfile")
      expect(incus).toContain("test -d /root/luna/node_modules")
      expect(pair.bash.git ?? "").not.toContain("/root/luna")
      // Ordering survives the wrapper: install THEN restart THEN readiness.
      const trace = pair.bash.trace ?? ""
      const install = lineIndexOf(trace, "install --cwd")
      const restart = lineIndexOf(trace, "systemctl stop")
      const readiness = lineIndexOf(trace, "/healthz")
      expect(install, "bun install missing from trace.log").toBeGreaterThan(-1)
      expect(restart, "the restart must follow the install").toBeGreaterThan(install)
      expect(readiness, "readiness must follow the restart").toBeGreaterThan(restart)
    },
    ROW_TIMEOUT,
  )

  it(
    "incus, readiness fails and the rollback recovers: exit 1, back at PREV, the give-up line EXACTLY ONCE",
    () => {
      // TWO readiness calls of one poll iteration each, both through the
      // wrapper; the rollback probe returns from inside its iteration, so the
      // give-up line is emitted once - the same accounting as the bare-host row.
      const pair = driveBoth({
        fixture: { readyAtTarget: false, readyAtPrev: true, claude: CLAUDE_PRESENT, incus: CONTAINER },
      })
      expectParity(pair)
      expect(pair.bash.exitCode).toBe(1)
      expect(pair.bash.stderr).toContain(`ROLLED BACK to ${pair.bashFixture.prevSha}`)
      expect(countOf(pair.bash.stderr, "readiness gave up after")).toBe(1)
      expect(pair.bash.head).toBe(pair.bashFixture.prevSha)
      expect(pair.bash.journal).toBeNull()
    },
    ROW_TIMEOUT,
  )
})
