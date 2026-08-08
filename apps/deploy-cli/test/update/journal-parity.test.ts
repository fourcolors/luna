/**
 * Golden parity harness for the transaction journal: drives the REAL
 * scripts/luna-update-server through every journal phase (crash-injected via
 * LUNA_TEST_CRASH_AFTER_PHASE where the phase is reachable mid-run, or to
 * natural completion where it is a terminal failure state) and diffs the
 * resulting bytes against apps/deploy-cli/src/update/journal.ts's own
 * writer/loader - proving the on-disk format this slice ports is
 * byte-identical to the bash it replaces, per phase, from real captured
 * output rather than a hand-derived expectation.
 *
 * "checkout" additionally proves bidirectional interop: a TS-authored
 * journal, dropped in place of the bash-authored one, is accepted by the
 * REAL bash script's own recovery path to a clean exit 0 - the coexistence
 * property docs/deploy-binary.md's state-file-format section describes.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { allKeyValuesLastWins } from "../../src/update/atomic-file.js"
import {
  CorruptJournalError,
  clearTransactionSync,
  loadTransactionSync,
  transactionJournalPath,
  writeTransactionSync,
  type Transaction,
  type TxPhase,
} from "../../src/update/journal.js"
import { cleanupTempDirs, makeFixture, runUpdate, type Fixture } from "./bash-fixtures.js"
import { makeTempDir } from "./temp-dirs.js"

afterEach(cleanupTempDirs)

const journalPath = (fixture: Pick<Fixture, "updateState">) => transactionJournalPath(fixture.updateState, "stable")

/**
 * Two syntactically valid (HEX_SHA-format) placeholder shas for the pure-TS
 * tests below, which exercise loadTransactionSync's own rejection rules and
 * never invoke the real bash script - unlike makeFixture(), no real git
 * checkout is needed to produce them.
 */
const PLACEHOLDER_PREV_SHA = "1111111aaaa1"
const PLACEHOLDER_TARGET_SHA = "2222222bbbb2"

/** A bare $UPDATE_STATE_DIR fixture for the pure-TS tests below: just a temp dir, not makeFixture()'s full git checkout + stub bins + real bash run. */
const makeStateFixture = (): Pick<Fixture, "updateState" | "prevSha" | "targetSha"> => ({
  updateState: join(makeTempDir("deploy-cli-journal-unit-"), "update-state"),
  prevSha: PLACEHOLDER_PREV_SHA,
  targetSha: PLACEHOLDER_TARGET_SHA,
})

/** Gates the mkfifo test below: not every platform running this suite ships the `mkfifo` binary. */
const mkfifoAvailable = spawnSync("which", ["mkfifo"]).status === 0

/** Extracts updated_at directly from raw bytes - load_transaction discards this field, so journal.ts's parser is the only reader; the raw regex here keeps this test's oracle independent of that parser. */
const rawUpdatedAt = (raw: Buffer): number => {
  const match = raw.toString("utf8").match(/^updated_at=(\d+)$/m)
  expect(match, raw.toString("utf8")).not.toBeNull()
  return Number(match![1])
}

/** Re-derives the bash-written bytes through journal.ts's own writer and asserts byte-for-byte equality, plus that the loader parses the same fields back. */
const assertByteParity = (raw: Buffer, fixture: Fixture, expectedPhase: TxPhase): Transaction => {
  const parsed = loadTransactionSync(journalPath(fixture))
  expect(parsed, raw.toString("utf8")).toBeDefined()
  expect(parsed!.phase).toBe(expectedPhase)
  expect(parsed!.prev).toBe(fixture.prevSha)
  expect(parsed!.target).toBe(fixture.targetSha)

  const tsPath = join(fixture.temp, `ts-journal-${expectedPhase}`)
  writeTransactionSync(tsPath, {
    phase: parsed!.phase,
    prev: parsed!.prev,
    target: parsed!.target,
    prevLockHash: parsed!.prevLockHash,
    updatedAt: rawUpdatedAt(raw),
  })
  const tsBytes = readFileSync(tsPath)
  expect(tsBytes.equals(raw)).toBe(true)
  return parsed!
}

describe("journal byte-parity: crash-injected phases", () => {
  it("prepared", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: true })
    const killed = runUpdate(fixture.args, { ...fixture.env, LUNA_TEST_CRASH_AFTER_PHASE: "prepared" })
    expect(killed.signal, killed.stdout + killed.stderr).toBe("SIGKILL")
    assertByteParity(readFileSync(journalPath(fixture)), fixture, "prepared")
  })

  it("applied", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: true })
    const killed = runUpdate(fixture.args, { ...fixture.env, LUNA_TEST_CRASH_AFTER_PHASE: "applied" })
    expect(killed.signal, killed.stdout + killed.stderr).toBe("SIGKILL")
    assertByteParity(readFileSync(journalPath(fixture)), fixture, "applied")
  })

  it("restarting", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: true })
    const killed = runUpdate(fixture.args, { ...fixture.env, LUNA_TEST_CRASH_AFTER_PHASE: "restarting" })
    expect(killed.signal, killed.stdout + killed.stderr).toBe("SIGKILL")
    assertByteParity(readFileSync(journalPath(fixture)), fixture, "restarting")
  })

  it("verifying", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: true })
    const killed = runUpdate(fixture.args, { ...fixture.env, LUNA_TEST_CRASH_AFTER_PHASE: "verifying" })
    expect(killed.signal, killed.stdout + killed.stderr).toBe("SIGKILL")
    assertByteParity(readFileSync(journalPath(fixture)), fixture, "verifying")
  })

  // Unlike its siblings above, this phase is only reached after the forward
  // readiness probe runs to exhaustion (readyAtTarget: false, the fixture's
  // --readiness-timeout 2) before the crash injection ever fires - the same
  // cost as rollback-failed/forward-failed below, so it gets their explicit
  // 30s budget rather than the global 10s testTimeout.
  it("rolling-back (reached via a failed forward readiness probe)", { timeout: 30_000 }, () => {
    const fixture = makeFixture({ readyAtTarget: false, readyAtPrev: true })
    const killed = runUpdate(fixture.args, { ...fixture.env, LUNA_TEST_CRASH_AFTER_PHASE: "rolling-back" })
    expect(killed.signal, killed.stdout + killed.stderr).toBe("SIGKILL")
    assertByteParity(readFileSync(journalPath(fixture)), fixture, "rolling-back")
  })

  it("checkout: byte-parity, loader validation, AND bidirectional recovery from a TS-authored journal", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: true })
    const killed = runUpdate(fixture.args, { ...fixture.env, LUNA_TEST_CRASH_AFTER_PHASE: "checkout" })
    expect(killed.signal, killed.stdout + killed.stderr).toBe("SIGKILL")
    const raw = readFileSync(journalPath(fixture))
    const parsed = assertByteParity(raw, fixture, "checkout")

    // Replace the bash-authored journal with one authored via journal.ts's
    // own writer (same fields, independently re-serialized - not a copy of
    // `raw`) and let the REAL bash script recover from it end to end. The
    // byte-parity claim for this exact field set is already proven above by
    // assertByteParity; this write's job is only to install the TS-authored
    // file at the real journal path for the recovery run below.
    writeTransactionSync(journalPath(fixture), {
      phase: parsed.phase,
      prev: parsed.prev,
      target: parsed.target,
      prevLockHash: parsed.prevLockHash,
      updatedAt: rawUpdatedAt(raw),
    })

    const recovered = runUpdate(fixture.args, fixture.env)
    expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0)
    expect(recovered.stderr).toContain("RECOVERING interrupted update")
    expect(existsSync(journalPath(fixture))).toBe(false)
  })
})

describe("journal byte-parity: terminal phases reached by natural completion (no crash injection)", () => {
  // Both cases run the forward readiness probe to exhaustion (and
  // rollback-failed runs a second probe on rollback), so on a loaded runner
  // they sit closer to the global 10s testTimeout than the crash-injected
  // cases above, which exit as soon as the crash point is hit. A generous
  // explicit timeout - not a shorter --readiness-timeout - keeps this from
  // trading a slow-test flake for a probe-too-short flake.
  it("rollback-failed (forward AND rollback both fail readiness)", { timeout: 30_000 }, () => {
    const fixture = makeFixture({ readyAtTarget: false, readyAtPrev: false })
    const r = runUpdate(fixture.args, fixture.env)
    expect(r.status, r.stdout + r.stderr).toBe(2)
    assertByteParity(readFileSync(journalPath(fixture)), fixture, "rollback-failed")
  })

  it("forward-failed (--no-rollback set, forward readiness fails)", { timeout: 30_000 }, () => {
    const fixture = makeFixture({ readyAtTarget: false, readyAtPrev: true })
    const r = runUpdate([...fixture.args, "--no-rollback"], fixture.env)
    expect(r.status, r.stdout + r.stderr).toBe(1)
    assertByteParity(readFileSync(journalPath(fixture)), fixture, "forward-failed")
  })
})

describe("loadTransactionSync: rejects the same malformed records load_transaction refuses", () => {
  // Only "the file does not exist at all" (ENOENT) returns undefined - see
  // journal.ts's module header for the three-state contract this mirrors.
  // Every other case below is present-but-untrustworthy, so it throws
  // CorruptJournalError instead of returning undefined.
  it("returns undefined for a missing file", () => {
    expect(loadTransactionSync("/nonexistent/path/transaction-stable")).toBeUndefined()
  })

  it("throws CorruptJournalError for an unrecognized phase", () => {
    const fixture = makeStateFixture()
    mkdirSync(fixture.updateState, { recursive: true })
    // Raw write, not writeTransactionSync + a cast: TxPhase is a closed
    // union, so writing an invalid phase through the typed writer needs an
    // `as unknown as TxPhase` double-cast that proves nothing about what
    // load_transaction actually sees on disk. A literal malformed record is
    // the same pattern the truncated-record case below already uses.
    writeFileSync(
      journalPath(fixture),
      `phase=not-a-real-phase\nprev=${fixture.prevSha}\ntarget=${fixture.targetSha}\nprev_lock_hash=\nupdated_at=1700000000\n`,
    )
    expect(() => loadTransactionSync(journalPath(fixture))).toThrow(CorruptJournalError)
  })

  it("throws CorruptJournalError for a malformed prev/target sha", () => {
    const fixture = makeStateFixture()
    writeTransactionSync(journalPath(fixture), {
      phase: "prepared",
      prev: "not-hex",
      target: fixture.targetSha,
      prevLockHash: "",
    })
    expect(() => loadTransactionSync(journalPath(fixture))).toThrow(CorruptJournalError)
  })

  it("accepts an empty prev_lock_hash", () => {
    const fixture = makeStateFixture()
    writeTransactionSync(journalPath(fixture), {
      phase: "prepared",
      prev: fixture.prevSha,
      target: fixture.targetSha,
      prevLockHash: "",
    })
    const parsed = loadTransactionSync(journalPath(fixture))
    expect(parsed?.prevLockHash).toBe("")
  })

  it("throws CorruptJournalError for a journal truncated mid-record (no trailing newline on the last line)", () => {
    // `while IFS='=' read -r key value; do ...; done < file` returns
    // non-zero for a final line with no trailing newline, so the loop body
    // never runs for it - load_transaction never sees a `target` value and
    // fails its regex. A short write (ENOSPC, or a kill mid-printf) that
    // still gets `mv`'d over the journal must be rejected the same way here.
    const fixture = makeStateFixture()
    mkdirSync(fixture.updateState, { recursive: true })
    writeFileSync(journalPath(fixture), `phase=applied\nprev=${fixture.prevSha}\ntarget=${fixture.targetSha}`)
    expect(() => loadTransactionSync(journalPath(fixture))).toThrow(CorruptJournalError)
  })

  // A FIFO is the fourth state journal.ts's module header documents: bash's
  // `[[ -f ]]` would be false here (same fresh-update path as no journal at
  // all), but opening one for reading blocks until a writer shows up - which
  // never happens in this test - so a naive readFileSync would hang
  // loadTransactionSync forever instead of rejecting it. The explicit
  // timeout keeps that regression a fast failure, not a hung test run.
  it.skipIf(!mkfifoAvailable)(
    "throws CorruptJournalError promptly for a non-regular file (mkfifo) at the journal path, instead of blocking forever",
    { timeout: 2_000 },
    () => {
      const fixture = makeStateFixture()
      mkdirSync(fixture.updateState, { recursive: true })
      const path = journalPath(fixture)
      const mkfifo = spawnSync("mkfifo", [path])
      expect(mkfifo.status, mkfifo.stderr?.toString()).toBe(0)
      expect(() => loadTransactionSync(path)).toThrow(CorruptJournalError)
    },
  )
})

describe("three-state contract: absent vs corrupt, against the real bash resume gate", () => {
  it("journal truncated mid-record before the run: bash resume refuses with CRITICAL exit 2, loadTransactionSync throws CorruptJournalError", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: true })
    mkdirSync(fixture.updateState, { recursive: true })
    // Same truncated shape as the pure-TS test above, but installed BEFORE
    // the real bash script ever runs, so it is bash's own resume path
    // (`[[ -f "$UPDATE_JOURNAL" ]]` + load_transaction,
    // scripts/luna-update-server:1923-1927) that is actually exercised here,
    // not a hand-derived expectation of it.
    writeFileSync(journalPath(fixture), `phase=applied\nprev=${fixture.prevSha}\ntarget=${fixture.targetSha}`)

    const r = runUpdate(fixture.args, fixture.env)
    expect(r.status, r.stdout + r.stderr).toBe(2)
    expect(r.stderr).toContain("CRITICAL")
    expect(r.stderr).toContain("corrupt update transaction journal")

    expect(() => loadTransactionSync(journalPath(fixture))).toThrow(CorruptJournalError)
  })

  // root ignores file mode bits entirely, so a chmod-000 probe cannot
  // reproduce "present but unreadable" when running as root - skip rather
  // than assert a false negative.
  it.skipIf(process.getuid?.() === 0)(
    "journal present but unreadable (chmod 000): bash resume refuses with CRITICAL exit 2, loadTransactionSync throws CorruptJournalError",
    () => {
      const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: true })
      mkdirSync(fixture.updateState, { recursive: true })
      writeTransactionSync(journalPath(fixture), {
        phase: "applied",
        prev: fixture.prevSha,
        target: fixture.targetSha,
        prevLockHash: "",
      })
      chmodSync(journalPath(fixture), 0o000)

      const r = runUpdate(fixture.args, fixture.env)
      expect(r.status, r.stdout + r.stderr).toBe(2)
      expect(r.stderr).toContain("CRITICAL")
      expect(r.stderr).toContain("corrupt update transaction journal")

      expect(() => loadTransactionSync(journalPath(fixture))).toThrow(CorruptJournalError)
    },
  )

  it("no journal present: bash takes the fresh-update path, loadTransactionSync returns undefined", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: true })
    expect(loadTransactionSync(journalPath(fixture))).toBeUndefined()

    const r = runUpdate(fixture.args, fixture.env)
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stderr).not.toContain("RECOVERING")
  })
})

/**
 * Runs the literal idiom this suite's divergence-boundary comment measures
 * against - `printf '<line>\n' > f; while IFS='=' read -r k v; do ...; done <
 * f` - on the REAL /bin/bash, not whatever `bash` a developer's or CI's
 * $PATH happens to resolve first (macOS ships an old bash 3.2 at that exact
 * path; a Homebrew bash 5.x earlier on $PATH would not reproduce the
 * measured divergence). A live oracle rather than a hand-derived expectation,
 * so a bash behavior change here fails this test instead of staling a
 * comment.
 */
const bashReadKeyValue = (line: string): string => {
  const dir = makeTempDir("deploy-cli-journal-kv-probe-")
  const file = join(dir, "kv-probe")
  writeFileSync(file, `${line}\n`)
  const script = `while IFS='=' read -r k v; do printf '%s' "$v"; done < "$1"`
  const r = spawnSync("/bin/bash", ["-c", script, "bash", file], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`bash read failed for line ${JSON.stringify(line)}: ${r.stderr}`)
  return r.stdout
}

describe("key=value parser: bash 3.2 trailing-delimiter divergence boundary (unreachable from writers, safe direction)", () => {
  // Measured on /bin/bash 3.2.57 via `printf '<line>\n' > f; while IFS='='
  // read -r k v; do ...; done < f`. Both probes are UNREACHABLE from every
  // writer in this codebase (TX_PHASES is a closed set, prev/target/
  // prev_lock_hash are hex-sha-validated, updated_at is digits-only) and the
  // one-character divergence is SAFE in its only direction: it can only make
  // loadTransactionSync classify as corrupt (a sha/phase that then fails its
  // own regex) a record bash's load_transaction would have accepted. See
  // atomic-file.ts's allKeyValuesLastWins doc for the full writeup. Each case
  // below pins BOTH halves: the TS parser via allKeyValuesLastWins, and the
  // real /bin/bash oracle via bashReadKeyValue, so a future bash behavior
  // change fails this test instead of a comment silently going stale.
  it("single trailing '=' (unreachable-and-safe): bash's read strips it, this parser keeps it", () => {
    const fields = allKeyValuesLastWins("z=b=\n")
    expect(fields.get("z")).toBe("b=")
    expect(bashReadKeyValue("z=b=")).toBe("b")
  })

  it("double trailing '=' (unreachable, and here bash and this parser already agree)", () => {
    const fields = allKeyValuesLastWins("x=y==\n")
    expect(fields.get("x")).toBe("y==")
    expect(bashReadKeyValue("x=y==")).toBe("y==")
  })
})

describe("transactionJournalPath / clearTransactionSync", () => {
  it("derives $UPDATE_STATE_DIR/transaction-$PROFILE (scripts/luna-update-server:936)", () => {
    expect(transactionJournalPath("/state/dir", "stable")).toBe("/state/dir/transaction-stable")
  })

  it("removes an existing journal (mirrors clear_transaction's rm -f)", () => {
    const fixture = makeStateFixture()
    writeTransactionSync(journalPath(fixture), {
      phase: "prepared",
      prev: fixture.prevSha,
      target: fixture.targetSha,
      prevLockHash: "",
    })
    expect(existsSync(journalPath(fixture))).toBe(true)
    clearTransactionSync(journalPath(fixture))
    expect(existsSync(journalPath(fixture))).toBe(false)
  })

  it("is a no-op when the journal does not exist", () => {
    expect(() => clearTransactionSync("/nonexistent/path/transaction-stable")).not.toThrow()
  })
})
