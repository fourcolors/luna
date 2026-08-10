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
 *    from masking: `readiness-retry.test.ts` drives each engine independently
 *    with `readyAfterCalls: 3` and asserts three `/healthz` entries per drive;
 *    the exhaustion row below additionally asserts, per drive and OUTSIDE the
 *    diff, that its own pre-collapse poll count is at least two; and
 *    `readiness.ts`'s PR1 unit suite pins the loop against an injected clock.
 *    Delete any of those three and this normalisation becomes masking and must
 *    be deleted with it.
 *
 * MASKING IS A CLOSED LIST OF EXACTLY THREE RULES, all of them inside
 * `maskArtifacts` (fixture root, `updated_at=`, lock-owner `pid=`). This file
 * adds none. A fourth would be a disqualifying weakening of the gate.
 *
 * PORTABILITY. Nothing here assumes macOS or this developer's machine: both
 * drives are spawned through `resolveHostTool`, which resolves `bash`, `git`
 * and `bun` off the AMBIENT PATH and refuses anything inside a fixture root,
 * and every path is built with `node:path`. The fixture's own stubs are bash
 * 3.2 compatible for the same reason.
 *
 * WHAT THIS SUITE DOES NOT PROVE, and the PR body must say so in these words:
 * that the container-path plumbing is right against REAL container paths,
 * because the fixture's `incus` stub rewrites the hardcoded `/root/luna` and
 * `/root/.luna/.env` prefixes onto host directories in order to run at all.
 * That is what GATE 2 exists for.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  type Artifacts,
  type Fixture,
  type FixtureOptions,
  type RunResult,
  captureArtifacts,
  cleanupTempDirs,
  makeFixturePair,
  maskArtifacts,
  normalisePollBlocks,
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
  /** Appended to `fixture.args`, never inserted, so the base vector stays a strict prefix. */
  readonly extraArgs?: ReadonlyArray<string>
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
const withExtraArgs = (fixture: Fixture, extra: ReadonlyArray<string> | undefined): Fixture =>
  extra === undefined || extra.length === 0 ? fixture : { ...fixture, args: [...fixture.args, ...extra] }

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
 */
const expectParity = (pair: DrivenPair, opts: { readonly normalise?: boolean } = {}): void => {
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
