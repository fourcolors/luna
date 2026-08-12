/**
 * GATE 1, RUN AGAINST THE ARTIFACT THAT ACTUALLY SHIPS.
 *
 * Every other dual-drive row in this directory puts `bun main.ts` in the
 * Drive B position, for speed. What `scripts/luna-guardian` publishes into a
 * pin is not that: `publish_engine` runs
 * `"$bun_bin" build --compile --outfile="$tmp/deploy-cli" "$root/apps/deploy-cli/src/main.ts"`
 * (scripts/luna-guardian:1216-1219) and then proves the freshly built binary
 * PRINTS a version (:1227). An operator's host therefore executes a single-file
 * compiled binary, and until this file existed nothing in the repo asserted
 * that the compiled artifact and the interpreted entry point behave the same.
 * A fully green GATE 1 without this suite proves the wrong artifact works.
 *
 * WHAT THIS FILE ADDS THAT gate1-parity.test.ts CANNOT. It is the same harness,
 * the same fixtures, the same strict artifact diff, with one substitution:
 * `runBinaryUpdate`'s `exe` option (bash-fixtures.ts:1161-1174) puts the
 * compiled binary in the engine position instead of `bun <abs main.ts>`. So a
 * failure here that is green in gate1-parity.test.ts is, by construction, a
 * defect introduced by COMPILATION rather than by the port.
 *
 * WHICH DIFFERENCES ARE EXPECTED, AND WHY THE ANSWER IS "NONE".
 * This suite adds NO masking rule and NO normalisation rule; it asserts full
 * byte parity against the bash oracle exactly as gate1-parity.test.ts does. The
 * three ways a compiled Bun binary can legitimately differ from its interpreted
 * source are each accounted for, and none of them reaches a diffed byte:
 *
 *  1. `process.argv[0]` and `[1]`. Measured, same bun, same script:
 *     interpreted argv is `["<abs path to bun>", "<abs path to main.ts>",
 *     ...userArgs]`, compiled argv is `["bun", "/$bunfs/root/main",
 *     ...userArgs]` - the first two entries differ in both value and meaning,
 *     and the compiled one names a path inside Bun's virtual filesystem that
 *     does not exist on disk. It cannot reach an assertion because NOTHING
 *     under `apps/deploy-cli/src/` reads either entry: the only argv access in
 *     the whole tree is `process.argv.slice(2)` (main.ts:66,
 *     update-command.ts:196), whose result is byte-identical under both
 *     spellings. That equality is what row 1 below re-proves end to end by
 *     diffing the compiled drive against the interpreted drive directly.
 *
 *  2. Module-relative path resolution. A compiled binary's modules live under
 *     `/$bunfs/`, so any `import.meta.url`, `__dirname` or `process.execPath`
 *     read would resolve somewhere that does not exist on the host. `grep -rn
 *     "import\.meta|__dirname|execPath" apps/deploy-cli/src/` returns nothing
 *     outside comments, and every path this flow uses arrives through argv, the
 *     config record or `LUNA_DEPLOY_BASH_ENGINE`, so there is no such read to
 *     go wrong. If one is ever added, this suite is the thing that catches it.
 *
 *  3. Startup latency. The compiled binary starts faster than `bun main.ts`
 *     because it does no module resolution. The only timing-derived byte in any
 *     diffed artifact is the journal's `updated_at=<digits>`, which
 *     `maskArtifacts` rule 2 already replaces on both drives.
 *
 * NOT GATED BEHIND AN ENV FLAG, DELIBERATELY. The spec allows for the build
 * being slow enough to need one (spec:1221 budgets `{ timeout: 300_000 }` for
 * this file for exactly that reason). It is not: `bun build --compile` of this
 * entry point is a 35-module bundle and completes in well under a second, so
 * the whole cost of this file is the fixture builds and the bash drives it
 * shares with every other parity suite. A flag would have bought nothing and
 * cost the one property that matters - that the published artifact is covered
 * on every run rather than on the runs somebody remembered to opt into.
 *
 * IT THROWS, IT NEVER SKIPS. `resolveHostTool("bun")` throws a message naming
 * the fix when bun is absent (spec:1312), and a failed build or a binary that
 * cannot print its own version throws here rather than skipping, for the reason
 * the harness states everywhere else: a skipped parity gate is indistinguishable
 * from a passing one.
 *
 * PORTABILITY. Nothing here assumes macOS or one developer machine: `bash`,
 * `git` and `bun` are all resolved off the AMBIENT PATH by `resolveHostTool`,
 * the binary is invoked by the absolute path this file chose, and every path is
 * built with `node:path`.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  type Artifacts,
  type Fixture,
  type FixtureOptions,
  type RunResult,
  captureArtifacts,
  cleanupTempDirs,
  makeFixturePair,
  maskArtifacts,
  resolveHostTool,
  runBashDrive,
  runBinaryUpdate,
} from "./bash-fixtures.js"
import { makeTempDir, repoRoot } from "./temp-dirs.js"

afterAll(cleanupTempDirs)

/**
 * The readiness pair every GATE 1 row pins, restated here rather than imported
 * because gate1-parity.test.ts is a test file and importing it would run its
 * suite a second time. It yields EXACTLY ONE poll iteration per readiness call
 * on both drives; the proof is in gate1-parity.test.ts:85-104 and in the spec's
 * READINESS DETERMINISM section.
 */
const PINNED_READINESS = { timeout: "2", interval: "3" } as const

/** spec:1221 - this file's budget includes `bun build --compile`, which runs once in beforeAll. */
const ROW_TIMEOUT = 300_000

/** Where the compiled binary is built, and the binary itself. Assigned in beforeAll. */
let compiledBinary = ""

beforeAll(() => {
  const bun = resolveHostTool("bun")
  const outDir = makeTempDir("deploy-cli-compiled-artifact-")
  compiledBinary = join(outDir, "deploy-cli")
  // The exact command scripts/luna-guardian:1216-1217 runs, with the entry
  // point spelled absolutely so the build does not depend on the cwd vitest
  // happened to start in.
  const build = spawnSync(
    bun,
    ["build", "--compile", `--outfile=${compiledBinary}`, join(repoRoot, "apps/deploy-cli/src/main.ts")],
    { cwd: repoRoot, encoding: "utf8", timeout: ROW_TIMEOUT },
  )
  if (build.status !== 0) {
    throw new Error(
      `compiled-artifact.test.ts: \`bun build --compile\` failed (status ${String(build.status)}).\n` +
        `  bun: ${bun}\n  stdout: ${build.stdout ?? ""}\n  stderr: ${build.stderr ?? ""}\n` +
        "  This is the exact command scripts/luna-guardian:1216-1217 runs at publish time, so a failure here " +
        "means publish_engine would abort on this checkout.",
    )
  }
  // guardian's own postcondition (scripts/luna-guardian:1227): prove the binary
  // PRINTS a version rather than merely exiting 0. Asserted here too, because a
  // zero-byte or non-executing artifact would otherwise surface as a
  // mystifying byte-diff in the first scenario instead of as what it is.
  const version = spawnSync(compiledBinary, ["--version"], { encoding: "utf8", timeout: 60_000 })
  if (version.status !== 0 || (version.stdout ?? "").trim() === "") {
    throw new Error(
      "compiled-artifact.test.ts: the freshly compiled deploy-cli produced no --version output " +
        `(status ${String(version.status)}, stderr: ${version.stderr ?? ""}). ` +
        "scripts/luna-guardian:1224-1231 aborts the publish on exactly this condition.",
    )
  }
}, ROW_TIMEOUT)

interface Scenario {
  readonly fixture: FixtureOptions
  /** Appended to `fixture.args`, never inserted, so the base vector stays a strict prefix. */
  readonly extraArgs?: ReadonlyArray<string>
  /** Runs against EACH drive's own fixture after it is built and before that drive runs. */
  readonly prepare?: (fixture: Fixture) => void
}

interface DrivenPair {
  readonly bash: Artifacts
  readonly compiled: Artifacts
  readonly bashFixture: Fixture
  readonly compiledFixture: Fixture
}

/** `{...fixture, args}` - Fixture is a plain readonly record, so appending argv is a copy rather than a fixture rebuild. */
const withExtraArgs = (fixture: Fixture, extra: ReadonlyArray<string> | undefined): Fixture =>
  extra === undefined || extra.length === 0 ? fixture : { ...fixture, args: [...fixture.args, ...extra] }

const capture = (fixture: Fixture, raw: RunResult): Artifacts => maskArtifacts(captureArtifacts(fixture, raw), fixture)

/** Build the pair, stage both roots identically, run bash and the COMPILED binary, capture and mask. */
const driveBoth = (scenario: Scenario): DrivenPair => {
  const pair = makeFixturePair({ readiness: PINNED_READINESS, ...scenario.fixture })
  const bashFixture = withExtraArgs(pair.bash, scenario.extraArgs)
  const compiledFixture = withExtraArgs(pair.binary, scenario.extraArgs)
  scenario.prepare?.(bashFixture)
  scenario.prepare?.(compiledFixture)
  const bashRaw = runBashDrive(bashFixture)
  const compiledRaw = runBinaryUpdate(compiledFixture, { exe: compiledBinary })
  return {
    bash: capture(bashFixture, bashRaw),
    compiled: capture(compiledFixture, compiledRaw),
    bashFixture,
    compiledFixture,
  }
}

/**
 * Every artifact, most-localising first, with NO normalisation and no masking
 * beyond `maskArtifacts`'s closed list of three. Same order and same strictness
 * as gate1-parity.test.ts's `expectParity`; the labels say COMPILED so a
 * failure report cannot be mistaken for an interpreted-drive one.
 */
const expectParity = (actual: Artifacts, oracle: Artifacts, label: string): void => {
  expect(actual.exitCode, `${label}: exit code`).toBe(oracle.exitCode)
  expect(actual.stdout, `${label}: stdout`).toBe(oracle.stdout)
  expect(actual.stderr, `${label}: stderr`).toBe(oracle.stderr)
  expect(actual.trace, `${label}: trace.log (the shared ordered trace)`).toBe(oracle.trace)
  expect(actual.systemctl, `${label}: systemctl.log`).toBe(oracle.systemctl)
  expect(actual.curl, `${label}: curl.log`).toBe(oracle.curl)
  expect(actual.bun, `${label}: bun.log`).toBe(oracle.bun)
  expect(actual.incus, `${label}: incus.log`).toBe(oracle.incus)
  expect(actual.claude, `${label}: claude.log`).toBe(oracle.claude)
  expect(actual.ss, `${label}: ss.log`).toBe(oracle.ss)
  expect(actual.git, `${label}: git.log`).toBe(oracle.git)
  expect(actual.journal, `${label}: the transaction journal`).toBe(oracle.journal)
  expect(actual.lockDirPresent, `${label}: lock dir presence`).toBe(oracle.lockDirPresent)
  expect(actual.envFile, `${label}: $ENV_FILE bytes`).toBe(oracle.envFile)
  expect(actual.envFileMode, `${label}: $ENV_FILE mode`).toBe(oracle.envFileMode)
  expect(actual.head, `${label}: final git rev-parse HEAD`).toBe(oracle.head)
  expect(actual.tree, `${label}: the sorted path+mode listing`).toEqual(oracle.tree)
  // Absolute, not merely a parity fact: two drives that both leaked the lock
  // would diff clean.
  expect(oracle.lockDirPresent, `${label}: the bash drive leaked the update lock`).toBe(false)
  expect(actual.lockDirPresent, `${label}: the compiled drive leaked the update lock`).toBe(false)
}

/** `claude: { stub: "present" }` on every row, so artifact 8 compares written bytes rather than "absent equals absent". */
const CLAUDE_PRESENT = { stub: "present" } as const

/** Seed a transaction journal in the shape `write_transaction` writes (:1013), for the corrupt-journal row. */
const seedJournal = (
  fixture: Fixture,
  fields: { readonly phase: string; readonly prev: string; readonly target: string },
): void => {
  mkdirSync(fixture.updateState, { recursive: true })
  writeFileSync(
    fixture.journalPath,
    `phase=${fields.phase}\nprev=${fields.prev}\ntarget=${fields.target}\nprev_lock_hash=\nupdated_at=1767225600\n`,
    { mode: 0o600 },
  )
}

describe("the COMPILED single-file binary, the artifact scripts/luna-guardian publishes", () => {
  it(
    "happy path: compiled == bash, and compiled == interpreted on the very same inputs",
    () => {
      const scenario: Scenario = {
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT },
      }
      const pair = driveBoth(scenario)
      expectParity(pair.compiled, pair.bash, "compiled vs bash")
      expect(pair.compiled.exitCode).toBe(0)
      expect(pair.compiled.head).toBe(pair.compiledFixture.targetSha)
      expect(pair.compiled.journal, "the journal is CLEARED on success (:2076)").toBeNull()

      // THE THREE-WAY. A third, independently rooted fixture built from the
      // SAME options runs the INTERPRETED entry point, so a failure can be
      // attributed: compiled-vs-bash red with compiled-vs-interpreted green is
      // a port defect that gate1-parity.test.ts sees too, while
      // compiled-vs-interpreted red is a defect that ONLY the published
      // artifact has. makeFixturePair pins both commit dates to the same fixed
      // constant, so a second call produces the same shas as the first; that is
      // asserted rather than assumed, because a byte diff across two pairs whose
      // repos hashed differently would be meaningless.
      const second = makeFixturePair({ readiness: PINNED_READINESS, ...scenario.fixture })
      expect(second.binary.targetSha, "the two pairs must hash identically").toBe(pair.bashFixture.targetSha)
      expect(second.binary.prevSha, "the two pairs must hash identically").toBe(pair.bashFixture.prevSha)
      const interpreted = capture(second.binary, runBinaryUpdate(second.binary))
      expectParity(pair.compiled, interpreted, "compiled vs interpreted")
    },
    ROW_TIMEOUT,
  )

  it(
    "happy path with a lockfile delta: the install and seed path, compiled",
    () => {
      // The row that puts `bun install` and the dream/wake seed on the diffed
      // path, i.e. the two places the flow spawns a subprocess whose argv is
      // built from config rather than from argv. A compiled binary that
      // resolved a repo-relative path through its own module root would diverge
      // here and nowhere else.
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, lockChanges: true, claude: CLAUDE_PRESENT },
      })
      expectParity(pair.compiled, pair.bash, "compiled vs bash")
      expect(pair.compiled.exitCode).toBe(0)
      expect(pair.compiled.bun ?? "", "bun.log must carry the install").toContain("install")
    },
    ROW_TIMEOUT,
  )

  it(
    "readiness fails and the rollback recovers: exit 1 and `ROLLED BACK to`, compiled",
    () => {
      // Exit code 1 of the five-code contract, and the one operator string a
      // downstream program parses on the failure path.
      const pair = driveBoth({
        fixture: { readyAtTarget: false, readyAtPrev: true, claude: CLAUDE_PRESENT },
      })
      expectParity(pair.compiled, pair.bash, "compiled vs bash")
      expect(pair.compiled.exitCode).toBe(1)
      expect(pair.compiled.stderr).toContain(`ROLLED BACK to ${pair.compiledFixture.prevSha}`)
      expect(pair.compiled.head).toBe(pair.compiledFixture.prevSha)
    },
    ROW_TIMEOUT,
  )

  it(
    "fresh-run session-guard defer: exit 3 and NOTHING written, compiled",
    () => {
      // Exit code 3. It is in this slice rather than left to the interpreted
      // gate because 3-versus-4 is the distinction the whole exit-code contract
      // is built around, and the artifact that reports it to the guardian is
      // this one.
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT, ss: { sessions: 1 } },
      })
      expectParity(pair.compiled, pair.bash, "compiled vs bash")
      expect(pair.compiled.exitCode).toBe(3)
      expect(pair.compiled.journal, "a deferred fresh run leaves nothing behind (:1997-2001)").toBeNull()
      expect(pair.compiled.head).toBe(pair.compiledFixture.prevSha)
    },
    ROW_TIMEOUT,
  )

  it(
    "corrupt journal: exit 2 and the checkout UNTOUCHED, compiled",
    () => {
      // Exit code 2, and the one refusal that must never mutate anything.
      const pair = driveBoth({
        fixture: { readyAtTarget: true, readyAtPrev: true, claude: CLAUDE_PRESENT },
        prepare: (fixture) => {
          seedJournal(fixture, { phase: "bogus", prev: fixture.prevSha, target: fixture.targetSha })
        },
      })
      expectParity(pair.compiled, pair.bash, "compiled vs bash")
      expect(pair.compiled.exitCode).toBe(2)
      expect(pair.compiled.stderr).toContain("CRITICAL: corrupt update transaction journal")
      expect(pair.compiled.head).toBe(pair.compiledFixture.prevSha)
      expect(pair.compiled.journal, "refusing to mutate includes refusing to remove the evidence").toContain(
        "phase=bogus",
      )
    },
    ROW_TIMEOUT,
  )
})
