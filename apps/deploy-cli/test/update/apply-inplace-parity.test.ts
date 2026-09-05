/**
 * Golden parity for `apply_ref_inplace` and `lockfile_hash`
 * (scripts/luna-update-server:1170-1254 and :538-544).
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM THE FLOW-LEVEL GATE. apply-inplace.ts
 * is the one module in the slice that mutates a checkout, and the slice spec
 * grants it an explicit abandon condition: if its HEAD postcondition or its
 * lockfile gate diverges from the bash, the port is deleted and the whole
 * inplace invocation is delegated instead. That decision needs evidence at the
 * FUNCTION level, not filtered through an end-to-end run, because several of
 * the branches below are unreachable from any real call site (the fetch arm,
 * which both callers skip with `--no-fetch`) or need a deliberately broken
 * collaborator (a `git` that reports a successful reset without moving HEAD).
 *
 * THE ORACLE IS THE REAL BASH FUNCTION, awk'd out of the engine at test time
 * and eval'd - the same technique rollback-parity.test.ts uses - with its real
 * collaborators (`run_target`, `git_target`, `git_target_capture`,
 * `lockfile_hash`, and the whole of scripts/lib/luna-deploy.sh) rather than
 * stubs, so what is compared is two engines doing the same work against the
 * same fixture rather than two transcriptions of a comment.
 *
 * WHAT IS COMPARED, per scenario: the return code, stdout, stderr, and the
 * fixture's `git.log`, `bun.log`, `trace.log` and `incus.log`. The logs are
 * what make claims like "the unchanged arm runs NOTHING" and "the bare-host
 * node_modules check creates no process" falsifiable; an exit-code-only
 * comparison passes happily on a port that shells out where bash does not.
 * The two drives own separate fixture roots by construction (makeFixturePair),
 * so every captured byte is masked back to `<ROOT>` before comparison.
 *
 * PORTABILITY, which is the direct lesson of the previous slice. Every runtime
 * is resolved EXPLICITLY - `bash` and `git` through `resolveHostTool` off the
 * ambient PATH, everything else out of the fixture's own bin dir by absolute
 * path - so nothing here depends on how Node resolves argv[0] against a child
 * env, on a login shell's profile, or on `test`/`command` being external
 * binaries. Nothing creates a symlink, nothing depends on a file mode denying
 * access (a suite running as root would silently lose that assertion), and the
 * one filesystem refusal used to force a failure is ENOTDIR, which every POSIX
 * platform answers identically.
 */
import { spawnSync } from "node:child_process"
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { applyInplaceSync, lockfileHashSync } from "../../src/update/apply-inplace.js"
import { BASH_ENGINE_ENV, defaultIsReadableFile, makeSpawnBashRunner, resolveBashLib } from "../../src/update/bash-lib.js"
import { claudeDegradedLine, headPostconditionLine, lockChangedLine, lockUnchangedLine, nodeModulesPostconditionLine } from "../../src/update/flow-lines.js"
import {
  gitTargetCaptureSync,
  gitTargetSync,
  runTargetSync,
  type SpawnTarget,
  type TargetContext,
} from "../../src/update/target.js"
import {
  INCUS_CONTAINER_REPO_DIR,
  cleanupTempDirs,
  driveEnv,
  makeFixturePair,
  resolveHostTool,
  type Fixture,
  type FixtureOptions,
} from "./bash-fixtures.js"
import { repoRoot } from "./temp-dirs.js"

const UPDATE_SERVER = join(repoRoot, "scripts/luna-update-server")
const REPO_LIB = join(repoRoot, "scripts/lib/luna-deploy.sh")

/** The lockfile bytes makeDeployRepo commits at PREV (test/helpers/update-server-fixtures.ts:46). */
const PREV_LOCK = "lock-v1\n"

afterAll(() => {
  cleanupTempDirs()
})

// ---------------------------------------------------------------------------
// shell quoting and the oracle
// ---------------------------------------------------------------------------

/** POSIX single-quoting: the only form that is literal for EVERY byte a temp path can contain. */
const sq = (value: string): string => `'${value.split("'").join("'\\''")}'`

/**
 * Pin the LOGIN shell's PATH to the fixture's, and nothing else.
 *
 * THE INCUS CLAUDE RE-PIN RUNS `bash -lc` (scripts/luna-update-server:1236), and
 * a LOGIN shell sources /etc/profile before it does anything else. On
 * Debian-family Linux that file REPLACES `PATH` outright with
 * `/usr/local/bin:/usr/bin:/bin:...`, and on macOS it runs `path_helper`, which
 * re-orders `PATH` so `/usr/local/bin` precedes anything inherited. Either one
 * decides the payload's `command -v claude` from the HOST's real installation
 * instead of the fixture's bin dir - so the `exit 9` sentinel would fire on a
 * runner with no claude installed and not on a developer machine that has one,
 * and this suite would pass or fail on where the reader happens to work.
 *
 * bash reads `~/.bash_profile` AFTER `/etc/profile` on both platforms, and
 * `driveEnv` already points `HOME` at a per-fixture directory, so this file is
 * the last word on PATH for exactly the one shell that needs it and is invisible
 * to every other call. It is written for BOTH drives, so the two engines'
 * payloads see the same PATH by construction rather than by luck.
 */
const pinLoginPath = (fx: Fixture): void => {
  const home = join(fx.temp, "home")
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, ".bash_profile"),
    `# see pinLoginPath in apply-inplace-parity.test.ts\nexport PATH=${sq(`${fx.bin}:/usr/bin:/bin`)}\n`,
  )
}

/**
 * One top-level bash function, verbatim, ready to `eval`.
 *
 * `/^<fn>\(\)/` anchors on the definition and `f && /^}$/` on the first closing
 * brace in column 0, which is the engine's own formatting for every function it
 * defines; nothing inside these five bodies closes a brace unindented. The
 * pattern deliberately does NOT try to match the ` {` that follows, because
 * `\{` is an escape some awks warn about and the anchor is already unique.
 */
const extract = (fn: string): string =>
  `eval "$(awk '/^${fn}\\(\\)/{f=1} f{print} f && /^}$/{exit}' ${sq(UPDATE_SERVER)})"`

interface ApplyArgs {
  readonly target: string
  readonly prevLockHash: string
  /** bash's third positional; true passes the literal `--no-fetch` (:1172). */
  readonly noFetch: boolean
  /** `TRANSACTION_TRACK_APPLY` (:1195). */
  readonly trackApply: boolean
  /** What the `write_transaction "checkout"` seam answers (:1196). */
  readonly checkoutOk: boolean
  /** Overrides `$ENV_FILE`; only the forced host-arm failure needs it. */
  readonly envFile?: string
}

interface Streams {
  readonly rc: number
  readonly stdout: string
  readonly stderr: string
}

/** The container-side repo path on an incus target (:313), the host checkout otherwise (:318-320). */
const containerRepoDirOf = (fx: Fixture): string =>
  fx.incusContainer === undefined ? fx.work : INCUS_CONTAINER_REPO_DIR

/**
 * DRIVE A: the real bash function.
 *
 * `set -uo pipefail` and not `-e`, for the reason rollback-parity.test.ts and
 * bash-lib-parity.test.ts both state: the engine runs under `-e`, but with `-e`
 * a function returning 1 legitimately would kill the shell before its rc could
 * be read, and the rc is exactly what is compared.
 *
 * `write_transaction` is the ONE stub. It is the `onCheckout` seam on the port
 * side, and the real one needs a whole journal rig that has nothing to do with
 * what this suite is proving. It is silent so the stdout diff stays about
 * apply_ref_inplace's own lines.
 */
const runBashApply = (fx: Fixture, args: ApplyArgs): Streams => {
  const script = [
    "set -uo pipefail",
    `source ${sq(REPO_LIB)}`,
    "DRY_RUN=false",
    "LAYOUT=inplace",
    'MIRROR_GIT=""',
    `INCUS_CONTAINER=${sq(fx.incusContainer ?? "")}`,
    `HOST_REPO_DIR=${sq(fx.work)}`,
    `CONTAINER_REPO_DIR=${sq(containerRepoDirOf(fx))}`,
    `REPO_DIR=${sq(fx.work)}`,
    `ENV_FILE=${sq(args.envFile ?? fx.envFile)}`,
    `BUN_BIN=${sq(join(fx.bin, "bun"))}`,
    `TRANSACTION_TRACK_APPLY=${args.trackApply ? "true" : "false"}`,
    `write_transaction() { return ${args.checkoutOk ? 0 : 1}; }`,
    extract("run_target"),
    extract("git_target"),
    extract("git_target_capture"),
    extract("lockfile_hash"),
    extract("apply_ref_inplace"),
    `apply_ref_inplace ${sq(args.target)} ${sq(args.prevLockHash)}${args.noFetch ? " --no-fetch" : ""}`,
    'exit "$?"',
  ].join("\n")
  const r = spawnSync(resolveHostTool("bash"), ["-c", script], {
    cwd: repoRoot,
    env: driveEnv(fx),
    encoding: "utf8",
  })
  return { rc: r.status ?? 127, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

/**
 * DRIVE B's subprocess seam: target.ts's `SpawnTarget`, wired to the FIXTURE's
 * environment and its own bin dir.
 *
 * argv[0] is resolved EXPLICITLY rather than left to the child env's PATH.
 * Node's spawnSync does resolve argv[0] from `options.env`'s PATH, but relying
 * on that is a portability landmine the harness contract already refuses to
 * depend on for its interpreter; an absolute path costs one branch and answers
 * the same on every platform.
 *
 * The two `capture` dispositions mirror bash's two call shapes. A capture call
 * is one sitting inside `$( )`, and the only one this function makes is
 * `rev-parse HEAD 2>/dev/null` - so dropping the child's stderr there IS that
 * redirect, and is also why `CommandResult` has no stderr field. A non-capture
 * call is one whose child writes straight to the engine's own streams, so both
 * are appended to the recorded streams in place, which preserves ordering
 * against the port's own `info`/`warn` lines exactly as the pipe does on the
 * bash drive.
 */
const makeRecordingSpawn = (
  fx: Fixture,
  env: Record<string, string>,
  sink: { stdout: string; stderr: string },
): SpawnTarget =>
  (argv, opts) => {
    const cmd = argv[0]
    // `luna_run` with no arguments expands `"$@"` to nothing and returns 0.
    if (cmd === undefined) return { status: 0, stdout: "" }
    const exe = isAbsolute(cmd)
      ? cmd
      : existsSync(join(fx.bin, cmd))
        ? join(fx.bin, cmd)
        : resolveHostTool(cmd)
    const r = spawnSync(exe, argv.slice(1), { cwd: repoRoot, env, encoding: "utf8" })
    if (r.error !== undefined) return { status: 127, stdout: "" }
    if (opts.capture) return { status: r.status, stdout: r.stdout ?? "" }
    sink.stdout += r.stdout ?? ""
    sink.stderr += r.stderr ?? ""
    return { status: r.status, stdout: "" }
  }

/** `[[ -d <path> ]]`, the bare-host arm of the node_modules postcondition. */
const dirExists = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** `[[ -f <path> ]]`, lockfile_hash's own test (:539). */
const fileExists = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** `[[ -x <path> ]]` (:1249). */
const isExecutable = (path: string): boolean => {
  if (path === "") return false
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * `command -v <name>` as a PATH walk, never a spawn: `command` is a shell
 * BUILTIN, so `spawnSync("command", ["-v", name])` fails with ENOENT on every
 * platform. This is the adapter the composition root must supply, written here
 * against the fixture's own PATH so the two drives ask the same question of the
 * same directories.
 */
const makeCommandExists = (env: Record<string, string>) =>
  (name: string): boolean => {
    for (const dir of (env.PATH ?? "").split(delimiter)) {
      if (dir === "") continue
      const candidate = join(dir, name)
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, fsConstants.X_OK)
        return true
      } catch {
        continue
      }
    }
    return false
  }

interface TsRun extends Streams {
  readonly step: string | null
  readonly checkoutCalls: number
}

/**
 * DRIVE B: the port, over the same fixture shape.
 *
 * `configureClaudeExecutable` and `envValue` are the REAL bash-lib delegates,
 * resolved against the repo's own lib - the same bytes the bash drive sources -
 * because the stale-pin scenario's entire assertion is that the helper's own
 * stderr reaches the operator unaltered. A stubbed helper would assert the
 * forwarding of bytes the test itself invented.
 */
const runTsApply = (fx: Fixture, args: ApplyArgs): TsRun => {
  const env = driveEnv(fx)
  const sink = { stdout: "", stderr: "" }
  const spawn = makeRecordingSpawn(fx, env, sink)
  const ctx: TargetContext = {
    incusContainer: fx.incusContainer ?? "",
    dryRun: false,
    layout: "inplace",
    hostRepoDir: fx.work,
    spawn,
  }
  const resolved = resolveBashLib({
    env: (name) => (name === BASH_ENGINE_ENV ? UPDATE_SERVER : env[name]),
    isReadableFile: defaultIsReadableFile,
    runBash: makeSpawnBashRunner(env, resolveHostTool("bash")),
  })
  if (!resolved.ok) throw new Error(`resolveBashLib refused unexpectedly: ${resolved.errorLine}`)
  const lib = resolved.lib
  const envFile = args.envFile ?? fx.envFile
  let checkoutCalls = 0

  const outcome = applyInplaceSync({
    target: args.target,
    prevLockHash: args.prevLockHash,
    noFetch: args.noFetch,
    trackApply: args.trackApply,
    incusContainer: fx.incusContainer ?? "",
    bunBin: join(fx.bin, "bun"),
    containerRepoDir: containerRepoDirOf(fx),
    envFile,
    repoDir: fx.work,
    dryRun: false,
    gitTarget: (a) => gitTargetSync(ctx, a),
    gitTargetCapture: (a) => gitTargetCaptureSync(ctx, a),
    runTarget: (a) => runTargetSync(ctx, a),
    lockfileHash: () =>
      lockfileHashSync({
        hostRepoDir: fx.work,
        fileExists,
        // capture: true, so git's own stderr is dropped exactly as bash's
        // `2>/dev/null || printf ''` drops it (:540).
        spawn: (a) => spawn(a, { capture: true }),
      }),
    onCheckout: () => {
      checkoutCalls += 1
      return args.checkoutOk
    },
    dirExists,
    configureClaudeExecutable: (req) => lib.configureClaudeExecutable(req),
    envValue: (f, k) => lib.envValue(f, k),
    commandExists: makeCommandExists(env),
    isExecutable,
    // luna_info / luna_warn (scripts/lib/luna-deploy.sh:4-5), including their
    // prefixes and their stream choice; the port's builders return payloads.
    info: (line) => { sink.stdout += `-> ${line}\n` },
    warn: (line) => { sink.stderr += `warning: ${line}\n` },
    writeStdout: (text) => { sink.stdout += text },
    writeStderr: (text) => { sink.stderr += text },
  })

  return {
    rc: outcome.ok ? 0 : 1,
    stdout: sink.stdout,
    stderr: sink.stderr,
    step: outcome.ok ? null : outcome.step,
    checkoutCalls,
  }
}

// ---------------------------------------------------------------------------
// capture and masking
// ---------------------------------------------------------------------------

const readLog = (path: string | undefined): string | null =>
  path === undefined || !existsSync(path) ? null : readFileSync(path, "utf8")

/**
 * Each drive owns its own fixture root by construction, so every absolute path
 * differs between them and nothing else does. Both the mkdtemp path and its
 * realpath are masked because macOS hands out `/var/folders/...` while a
 * resolved path reads `/private/var/folders/...`, and a subprocess may report
 * either.
 */
const mask = (text: string, fx: Fixture): string => {
  let out = text.split(fx.temp).join("<ROOT>")
  const real = realpathSync(fx.temp)
  if (real !== fx.temp) out = out.split(real).join("<ROOT>")
  // The ONE genuinely random byte sequence either drive can emit.
  // `luna_upsert_env` writes through `mktemp "$env_file.XXXXXXXX"`
  // (scripts/lib/luna-deploy.sh:53-54), so the forced-failure row's stderr
  // carries mktemp's own eight-character suffix, which differs per invocation
  // BY DESIGN and has nothing to do with the port. Masking it is the narrowest
  // possible rule: it is anchored on the env file's own name, so a difference
  // anywhere else in that message still fails the diff.
  return out.replace(/(\.env)\.[A-Za-z0-9]{8}\b/g, "$1.<MKTEMP>")
}

interface Artifacts {
  readonly rc: number
  readonly stdout: string
  readonly stderr: string
  readonly git: string | null
  readonly bun: string | null
  readonly trace: string | null
  readonly incus: string | null
}

/** `null` means the file was ABSENT, which is itself a diffed fact: a log present on one drive and not the other is a divergence, not a missing capture. */
const maskedLog = (path: string | undefined, fx: Fixture): string | null => {
  const raw = readLog(path)
  return raw === null ? null : mask(raw, fx)
}

const capture = (fx: Fixture, streams: Streams): Artifacts => ({
  rc: streams.rc,
  stdout: mask(streams.stdout, fx),
  stderr: mask(streams.stderr, fx),
  git: maskedLog(fx.gitLog, fx),
  bun: maskedLog(fx.bunLog, fx),
  trace: maskedLog(fx.traceLog, fx),
  incus: maskedLog(fx.incusLog, fx),
})

/** How the fixture's host checkout reads AFTER masking; `work` is always `<temp>/repo` (update-server-fixtures.ts:37). */
const MASKED_WORK = "<ROOT>/repo"

/** Non-empty lines of a log, so an assertion counts entries rather than bytes. */
const lines = (log: string | null): ReadonlyArray<string> =>
  log === null ? [] : log.split("\n").filter((l) => l !== "")

interface Pair {
  readonly fixtures: { readonly bash: Fixture; readonly binary: Fixture }
  readonly bash: Artifacts
  readonly ts: Artifacts
  readonly step: string | null
  readonly checkoutCalls: number
}

/**
 * Build the pair, let the scenario mutate BOTH halves identically, run one
 * drive into each, and capture.
 *
 * `prepare` runs against each fixture separately rather than once, because the
 * whole point of the pair is that the two roots are independent; a mutation
 * applied to one only would show up as a byte diff that has nothing to do with
 * the port.
 */
const drivePair = (
  opts: FixtureOptions,
  args: (fx: Fixture) => ApplyArgs,
  prepare: (fx: Fixture) => void = () => {},
): Pair => {
  const pair = makeFixturePair(opts)
  pinLoginPath(pair.bash)
  pinLoginPath(pair.binary)
  prepare(pair.bash)
  prepare(pair.binary)
  const bash = capture(pair.bash, runBashApply(pair.bash, args(pair.bash)))
  const tsRun = runTsApply(pair.binary, args(pair.binary))
  const ts = capture(pair.binary, tsRun)
  return { fixtures: { bash: pair.bash, binary: pair.binary }, bash, ts, step: tsRun.step, checkoutCalls: tsRun.checkoutCalls }
}

/** Every diffed artifact, one assertion each so a failure names which one drifted. */
const expectParity = (p: Pair): void => {
  expect(p.ts.stdout).toBe(p.bash.stdout)
  expect(p.ts.stderr).toBe(p.bash.stderr)
  expect(p.ts.rc).toBe(p.bash.rc)
  expect(p.ts.git).toBe(p.bash.git)
  expect(p.ts.bun).toBe(p.bash.bun)
  expect(p.ts.trace).toBe(p.bash.trace)
  expect(p.ts.incus).toBe(p.bash.incus)
}

/** The blob id `git hash-object` gives some bytes, computed OUTSIDE any fixture so it adds no log entry to either drive. */
const blobHashOf = (content: string): string => {
  const r = spawnSync(resolveHostTool("git"), ["hash-object", "--stdin"], { input: content, encoding: "utf8" })
  const value = (r.stdout ?? "").replace(/\n+$/, "")
  if (r.status !== 0 || value === "") throw new Error(`git hash-object --stdin failed: ${r.stderr ?? ""}`)
  return value
}

/**
 * Replace the fixture's `git` shim with one that lies about ONE subcommand and
 * behaves normally for every other, keeping the shim's own log format byte for
 * byte (bash-fixtures.ts's writeGitShim).
 *
 * `#!/bin/sh` and a `case` on `" $* "` rather than anything bash-specific: this
 * shim is exec'd by both drives and by the fixture's other stubs, and dash and
 * bash agree completely on the three constructs used.
 */
type GitLie = "lying-reset" | "unreadable-head" | "failing-fetch" | "failing-hash-object"

const LIE_VERB: Record<GitLie, string> = {
  "lying-reset": "reset",
  "unreadable-head": "rev-parse",
  "failing-fetch": "fetch",
  "failing-hash-object": "hash-object",
}

const installLyingGit = (fx: Fixture, lie: GitLie): void => {
  const realGit = resolveHostTool("git")
  // A lying reset must still report SUCCESS - that is the defect the HEAD
  // postcondition exists to catch. The other three report failure, which is
  // what their own arms consume.
  const rc = lie === "lying-reset" ? 0 : 1
  writeFileSync(
    join(fx.bin, "git"),
    `#!/bin/sh
printf 'git %s\\n' "$*" >> "${fx.traceLog}"
printf '%s\\n' "$*" >> "${fx.gitLog}"
case " $* " in
  *" ${LIE_VERB[lie]} "*) exit ${rc} ;;
esac
exec "${realGit}" "$@"
`,
  )
  chmodSync(join(fx.bin, "git"), 0o755)
}

// ===========================================================================
// step 3: the HEAD postcondition (:1188-1194)
// ===========================================================================

describe("apply_ref_inplace: the HEAD postcondition", () => {
  /**
   * The three spellings `--ref` admits that all reset to the same commit.
   * A strict `head == target` check passes the first and FALSE-FAILS the other
   * two, rolling back a deploy that in fact succeeded - which is why the bash
   * comment at :1181-1187 spells the bidirectional, case-normalised rule out
   * and why each spelling gets its own row here.
   */
  const spellings: ReadonlyArray<{ readonly name: string; readonly of: (fx: Fixture) => string }> = [
    { name: "a full 40-hex sha", of: (fx) => fx.targetSha },
    { name: "a 7-char abbreviation", of: (fx) => fx.targetSha.slice(0, 7) },
    { name: "an UPPERCASE 40-hex sha", of: (fx) => fx.targetSha.toUpperCase() },
  ]

  for (const spelling of spellings) {
    it(`accepts ${spelling.name} and completes`, { timeout: 60_000 }, () => {
      const p = drivePair({ readyAtTarget: true, readyAtPrev: true, claude: { stub: "present", envPin: "detected" } }, (fx) => ({
        target: spelling.of(fx),
        prevLockHash: blobHashOf(PREV_LOCK),
        noFetch: true,
        trackApply: true,
        checkoutOk: true,
      }))
      expectParity(p)
      expect(p.bash.rc).toBe(0)
      expect(p.step).toBeNull()
      expect(p.bash.stderr).not.toContain("POSTCONDITION")
    })
  }

  it("refuses a reset that reported success without moving HEAD", { timeout: 60_000 }, () => {
    const p = drivePair(
      { readyAtTarget: true, readyAtPrev: true, claude: { stub: "present", envPin: "detected" } },
      (fx) => ({
        target: fx.targetSha,
        prevLockHash: blobHashOf(PREV_LOCK),
        noFetch: true,
        trackApply: true,
        checkoutOk: true,
      }),
      (fx) => { installLyingGit(fx, "lying-reset") },
    )
    expectParity(p)
    expect(p.bash.rc).toBe(1)
    expect(p.step).toBe("head-postcondition")
    // Byte-exact, and with the PREV sha in it: the reset did not move, so what
    // the operator is told HEAD is must be where it actually still is.
    expect(p.bash.stderr).toBe(
      `warning: ${headPostconditionLine(p.fixtures.bash.prevSha, p.fixtures.bash.targetSha)}\n`,
    )
    // It refuses BEFORE the journal write and BEFORE the lockfile gate, so a
    // resumable phase is never recorded for a checkout that did not happen.
    expect(p.checkoutCalls).toBe(0)
    expect(p.bash.stdout).toBe("")
    expect(lines(p.bash.bun)).toHaveLength(0)
  })

  it("prints 'unreadable' when the post-reset read produces nothing", { timeout: 60_000 }, () => {
    const p = drivePair(
      { readyAtTarget: true, readyAtPrev: true, claude: { stub: "present", envPin: "detected" } },
      (fx) => ({
        target: fx.targetSha,
        prevLockHash: blobHashOf(PREV_LOCK),
        noFetch: true,
        trackApply: true,
        checkoutOk: true,
      }),
      (fx) => { installLyingGit(fx, "unreadable-head") },
    )
    expectParity(p)
    expect(p.bash.rc).toBe(1)
    expect(p.step).toBe("head-postcondition")
    // bash's `${head_now:-unreadable}`: an empty capture and an unset variable
    // print the same word, and the port collapses them the same way.
    expect(p.bash.stderr).toBe(`warning: ${headPostconditionLine("", p.fixtures.bash.targetSha)}\n`)
    expect(p.bash.stderr).toContain("HEAD is 'unreadable'")
  })
})

// ===========================================================================
// step 4: the checkout journal write (:1195-1196)
// ===========================================================================

describe("apply_ref_inplace: the checkout journal write", () => {
  it("fails the apply when the journal write fails", { timeout: 60_000 }, () => {
    const p = drivePair({ readyAtTarget: true, readyAtPrev: true, claude: { stub: "present", envPin: "detected" } }, (fx) => ({
      target: fx.targetSha,
      prevLockHash: blobHashOf(PREV_LOCK),
      noFetch: true,
      trackApply: true,
      checkoutOk: false,
    }))
    expectParity(p)
    expect(p.bash.rc).toBe(1)
    expect(p.step).toBe("checkout-journal")
    expect(p.checkoutCalls).toBe(1)
    // It sits between the postcondition and the lockfile gate, so neither
    // bun.lock decision line is reached.
    expect(p.bash.stdout).not.toContain("bun.lock")
    expect(lines(p.bash.bun)).toHaveLength(0)
  })

  it("does not touch the journal at all when tracking is off", { timeout: 60_000 }, () => {
    // `checkoutOk: false` with `trackApply: false` proves the seam is not
    // consulted rather than merely that its answer was ignored.
    const p = drivePair({ readyAtTarget: true, readyAtPrev: true, claude: { stub: "present", envPin: "detected" } }, (fx) => ({
      target: fx.targetSha,
      prevLockHash: blobHashOf(PREV_LOCK),
      noFetch: true,
      trackApply: false,
      checkoutOk: false,
    }))
    expectParity(p)
    expect(p.bash.rc).toBe(0)
    expect(p.checkoutCalls).toBe(0)
  })
})

// ===========================================================================
// step 5: the lockfile gate (:1199-1216)
// ===========================================================================

describe("apply_ref_inplace: the lockfile gate", () => {
  it("skips the install when the hash is unchanged, and runs NOTHING", { timeout: 60_000 }, () => {
    const p = drivePair({ readyAtTarget: true, readyAtPrev: true, claude: { stub: "present", envPin: "detected" } }, (fx) => ({
      target: fx.targetSha,
      prevLockHash: blobHashOf(PREV_LOCK),
      noFetch: true,
      trackApply: true,
      checkoutOk: true,
    }))
    expectParity(p)
    expect(p.bash.rc).toBe(0)
    expect(p.bash.stdout).toContain(`-> ${lockUnchangedLine}\n`)
    expect(p.bash.stdout).not.toContain(lockChangedLine)
    // "runs NOTHING" is the claim, and bun.log is what falsifies it.
    expect(lines(p.bash.bun)).toHaveLength(0)
    expect(lines(p.ts.bun)).toHaveLength(0)
  })

  it("installs exactly once when the hash changed", { timeout: 60_000 }, () => {
    const p = drivePair({ readyAtTarget: true, readyAtPrev: true, lockChanges: true, claude: { stub: "present", envPin: "detected" } }, (fx) => ({
      target: fx.targetSha,
      prevLockHash: blobHashOf(PREV_LOCK),
      noFetch: true,
      trackApply: true,
      checkoutOk: true,
    }))
    expectParity(p)
    expect(p.bash.rc).toBe(0)
    expect(p.bash.stdout).toContain(`-> ${lockChangedLine}\n`)
    expect(p.bash.stdout).not.toContain(lockUnchangedLine)
    expect(lines(p.bash.bun)).toHaveLength(1)
    expect(lines(p.ts.bun)).toHaveLength(1)
    expect(lines(p.ts.bun)[0]).toBe(`install --cwd ${MASKED_WORK} --frozen-lockfile`)
  })

  it("fails the apply when the install itself fails", { timeout: 60_000 }, () => {
    const p = drivePair(
      { readyAtTarget: true, readyAtPrev: true, lockChanges: true, claude: { stub: "present", envPin: "detected" } },
      (fx) => ({
        target: fx.targetSha,
        prevLockHash: blobHashOf(PREV_LOCK),
        noFetch: true,
        trackApply: true,
        checkoutOk: true,
      }),
      (fx) => {
        // A `bun` that logs like the fixture's own and then FAILS, so the
        // install arm's `|| return 1` is exercised without the node_modules
        // postcondition ever being reached.
        writeFileSync(
          join(fx.bin, "bun"),
          `#!/usr/bin/env bash\nprintf 'bun %s\\n' "$*" >> "${fx.traceLog}"\nprintf '%s\\n' "$*" >> "${fx.bunLog}"\nexit 1\n`,
        )
        chmodSync(join(fx.bin, "bun"), 0o755)
      },
    )
    expectParity(p)
    expect(p.bash.rc).toBe(1)
    expect(p.step).toBe("bun-install")
    expect(p.bash.stderr).not.toContain("node_modules is missing")
  })
})

// ===========================================================================
// step 5's node_modules postcondition, ARM BY ARM (:1207-1213)
// ===========================================================================

describe("apply_ref_inplace: the node_modules postcondition", () => {
  /** The install exits 0 and produces nothing, which is the defect the postcondition exists for. */
  const removeNodeModules = (fx: Fixture): void => {
    rmSync(join(fx.work, "node_modules"), { recursive: true, force: true })
  }

  it("on a BARE HOST answers with a stat and creates no process", { timeout: 60_000 }, () => {
    const p = drivePair(
      { readyAtTarget: true, readyAtPrev: true, lockChanges: true, claude: { stub: "present", envPin: "detected" } },
      (fx) => ({
        target: fx.targetSha,
        prevLockHash: blobHashOf(PREV_LOCK),
        noFetch: true,
        trackApply: true,
        checkoutOk: true,
      }),
      removeNodeModules,
    )
    expectParity(p)
    expect(p.bash.rc).toBe(1)
    expect(p.step).toBe("node-modules")
    expect(p.bash.stderr).toBe(`warning: ${nodeModulesPostconditionLine(MASKED_WORK)}\n`)
    // THE CLAIM: bash's `run_target test -d ...` degenerates to the shell
    // BUILTIN `test` on a bare host, so no process is created and the port
    // stats instead. trace.log records every process the fixture can see, and
    // here it holds exactly the three git calls and the one bun call - a port
    // that spawned `/usr/bin/test` would still pass the exit-code assertion
    // above and fail this one.
    const traced = lines(p.bash.trace)
    expect(traced).toHaveLength(4)
    expect(traced.filter((l) => l.startsWith("git "))).toHaveLength(3)
    expect(traced.filter((l) => l.startsWith("bun "))).toHaveLength(1)
    expect(p.bash.incus).toBeNull()
  })

  it("on an INCUS target issues exactly one `test -d` through the container", { timeout: 60_000 }, () => {
    const p = drivePair(
      { readyAtTarget: true, readyAtPrev: true, lockChanges: true, incus: "luna-parity", claude: { stub: "present", envPin: "detected" } },
      (fx) => ({
        target: fx.targetSha,
        prevLockHash: blobHashOf(PREV_LOCK),
        noFetch: true,
        trackApply: true,
        checkoutOk: true,
      }),
      removeNodeModules,
    )
    expectParity(p)
    expect(p.bash.rc).toBe(1)
    expect(p.step).toBe("node-modules")
    // The path is the CONTAINER's, not the host's: the operator is told about
    // the path the target sees.
    expect(p.bash.stderr).toBe(`warning: ${nodeModulesPostconditionLine(INCUS_CONTAINER_REPO_DIR)}\n`)
    const probes = lines(p.bash.incus).filter((l) => l.includes(" -- test -d "))
    expect(probes).toEqual([`exec luna-parity -- test -d ${INCUS_CONTAINER_REPO_DIR}/node_modules`])
    expect(lines(p.ts.incus).filter((l) => l.includes(" -- test -d "))).toEqual(probes)
  })
})

// ===========================================================================
// step 6: the claude re-pin, arm for arm (:1221-1252)
// ===========================================================================

describe("apply_ref_inplace: the claude re-pin on an INCUS target", () => {
  const incusOpts = (extra: FixtureOptions): FixtureOptions => ({ ...extra, incus: "luna-parity" })
  const args = (fx: Fixture): ApplyArgs => ({
    target: fx.targetSha,
    prevLockHash: blobHashOf(PREV_LOCK),
    noFetch: true,
    trackApply: true,
    checkoutOk: true,
  })

  it("succeeds silently when the container has a usable claude", { timeout: 60_000 }, () => {
    const p = drivePair(incusOpts({ readyAtTarget: true, readyAtPrev: true, claude: { stub: "present" } }), args)
    expectParity(p)
    expect(p.bash.rc).toBe(0)
    expect(p.bash.stderr).not.toContain("POSTCONDITION degraded")
  })

  it("degrades to a WARNING on the payload's exit 9 and continues", { timeout: 60_000 }, () => {
    // No claude stub and no pin, which is exactly what makes the payload's
    // final `|| exit 9` fire (:1237).
    const p = drivePair(incusOpts({ readyAtTarget: true, readyAtPrev: true }), args)
    expectParity(p)
    // WARN-ONLY: rollback cannot conjure an absent binary, so the apply still
    // succeeds. A port that treated 9 as a failure would deadlock every update
    // on a container missing claude.
    expect(p.bash.rc).toBe(0)
    expect(p.step).toBeNull()
    expect(p.bash.stderr).toContain(`warning: ${claudeDegradedLine}\n`)
  })

  it("FAILS the apply on any other non-zero from the re-pin", { timeout: 60_000 }, () => {
    const p = drivePair(
      incusOpts({ readyAtTarget: true, readyAtPrev: true }),
      args,
      (fx) => {
        // The payload's first statement sources the container's copy of the
        // lib; removing it makes the whole `&&` chain fail with 1, which is a
        // TRANSPORT-shaped failure rather than the exit-9 sentinel. The file is
        // untracked in the fixture repo (bash-fixtures.ts writes it into the
        // checkout after the clone), so `git reset --hard` does not restore it.
        rmSync(join(fx.work, "scripts", "lib", "luna-deploy.sh"), { force: true })
      },
    )
    expectParity(p)
    expect(p.bash.rc).toBe(1)
    expect(p.step).toBe("claude-repin")
    expect(p.bash.stderr).not.toContain("POSTCONDITION degraded")
  })
})

describe("apply_ref_inplace: the claude re-pin on a BARE HOST", () => {
  const args = (fx: Fixture): ApplyArgs => ({
    target: fx.targetSha,
    prevLockHash: blobHashOf(PREV_LOCK),
    noFetch: true,
    trackApply: true,
    checkoutOk: true,
  })

  it("is silent when the pin already names an executable", { timeout: 60_000 }, () => {
    const p = drivePair({ readyAtTarget: true, readyAtPrev: true, claude: { stub: "present", envPin: "detected" } }, args)
    expectParity(p)
    expect(p.bash.rc).toBe(0)
    expect(p.bash.stderr).toBe("")
  })

  it("forwards the helper's own stale-pin stderr, then degrades", { timeout: 60_000 }, () => {
    // envPin "stale" without a claude stub drives BOTH halves of the arm: the
    // helper removes the dead pin and says so, then finds nothing to re-pin, so
    // the separate degrade check fires too.
    const p = drivePair({ readyAtTarget: true, readyAtPrev: true, claude: { envPin: "stale" } }, args)
    expectParity(p)
    expect(p.bash.rc).toBe(0)
    // THE REGRESSION THIS ROW EXISTS FOR: the stale-pin line is emitted from
    // INSIDE scripts/lib/luna-deploy.sh:139. On the bash drive it lands on the
    // engine's stderr for free; on the port it only appears if the caller
    // forwards ConfigureClaudeResult.stderr verbatim. Byte-exact, including the
    // helper's own `warning: ` prefix, which the port must NOT re-apply.
    expect(p.bash.stderr).toBe(
      "warning: no usable claude binary found after bun install; clearing stale pin: <ROOT>/stale-claude\n" +
        "warning: POSTCONDITION degraded: no usable claude executable detected — server will boot but cannot spawn claude\n",
    )
  })

  it("degrades when there is no pin and no claude on PATH", { timeout: 60_000 }, () => {
    const p = drivePair({ readyAtTarget: true, readyAtPrev: true }, args)
    expectParity(p)
    expect(p.bash.rc).toBe(0)
    expect(p.bash.stderr).toBe("warning: POSTCONDITION degraded: no usable claude executable detected — server will boot but cannot spawn claude\n")
  })

  it("FAILS the apply when the re-pin helper itself fails", { timeout: 60_000 }, () => {
    const p = drivePair(
      { readyAtTarget: true, readyAtPrev: true, claude: { stub: "present" } },
      (fx) => ({ ...args(fx), envFile: join(fx.temp, "blocked", ".env") }),
      (fx) => {
        // A REGULAR FILE where the .env's parent directory must be, so
        // luna_upsert_env's `mkdir -p` fails with ENOTDIR - the one filesystem
        // refusal that answers identically on every POSIX platform AND for
        // root, unlike a mode-based denial which a root CI runner ignores.
        writeFileSync(join(fx.temp, "blocked"), "not a directory\n")
      },
    )
    expectParity(p)
    expect(p.bash.rc).toBe(1)
    expect(p.step).toBe("claude-repin")
    // The degrade check sits AFTER the `|| return 1`, so it never runs.
    expect(p.bash.stderr).not.toContain("POSTCONDITION degraded")
  })
})

// ===========================================================================
// step 1: the fetch arm, which no real call site reaches (:1172-1174)
// ===========================================================================

describe("apply_ref_inplace: the fetch arm", () => {
  const args = (fx: Fixture): ApplyArgs => ({
    target: fx.targetSha,
    prevLockHash: blobHashOf(PREV_LOCK),
    noFetch: false,
    trackApply: true,
    checkoutOk: true,
  })

  it("fetches first when the third argument is not --no-fetch", { timeout: 60_000 }, () => {
    // BOTH production call sites pass `--no-fetch` (:1821, :2020) because the
    // flow has already fetched before resolving the ref, so this arm gets zero
    // coverage from any end-to-end diff and has to be driven directly.
    const p = drivePair({ readyAtTarget: true, readyAtPrev: true, claude: { stub: "present", envPin: "detected" } }, args)
    expectParity(p)
    expect(p.bash.rc).toBe(0)
    expect(lines(p.bash.git)[0]).toBe(`-C ${MASKED_WORK} fetch origin`)
  })

  it("fails before touching the checkout when the fetch fails", { timeout: 60_000 }, () => {
    const p = drivePair(
      { readyAtTarget: true, readyAtPrev: true, claude: { stub: "present", envPin: "detected" } },
      args,
      (fx) => { installLyingGit(fx, "failing-fetch") },
    )
    expectParity(p)
    expect(p.bash.rc).toBe(1)
    expect(p.step).toBe("fetch")
    // One git call, and it is the fetch: no reset was attempted.
    expect(lines(p.bash.git)).toHaveLength(1)
    expect(lines(p.bash.git)[0]).toContain("fetch origin")
  })

  it("performs ZERO fetches when the third argument IS --no-fetch", { timeout: 60_000 }, () => {
    const p = drivePair({ readyAtTarget: true, readyAtPrev: true, claude: { stub: "present", envPin: "detected" } }, (fx) => ({
      ...args(fx),
      noFetch: true,
    }))
    expectParity(p)
    expect(lines(p.bash.git).filter((l) => l.includes("fetch"))).toHaveLength(0)
  })
})

// ===========================================================================
// lockfile_hash (:538-544), driven directly
// ===========================================================================

describe("lockfile_hash", () => {
  /**
   * The oracle for the hash alone. It shares runBashApply's env and extraction
   * so the two functions are proven against the same fixture PATH, but it calls
   * `lockfile_hash` rather than the apply, because two of the three arms cannot
   * be reached through the apply at all: `git reset --hard` restores bun.lock
   * before the gate ever reads it, so a missing lockfile is unrepresentable
   * there.
   */
  const runBashHash = (fx: Fixture, hostRepoDir: string): Streams => {
    const script = [
      "set -uo pipefail",
      `source ${sq(REPO_LIB)}`,
      `HOST_REPO_DIR=${sq(hostRepoDir)}`,
      extract("lockfile_hash"),
      // `$( )`, exactly as the ONE production call site spells it
      // (`new_lock_hash="$(lockfile_hash)"`, :1200-1201): command substitution
      // strips the trailing newline git writes, and the value is compared as a
      // plain string afterwards. Calling the function bare would leave that
      // newline in and make the oracle disagree with its own caller.
      `printf '%s' "$(lockfile_hash)"`,
    ].join("\n")
    const r = spawnSync(resolveHostTool("bash"), ["-c", script], {
      cwd: repoRoot,
      env: driveEnv(fx),
      encoding: "utf8",
    })
    return { rc: r.status ?? 127, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
  }

  const runTsHash = (fx: Fixture, hostRepoDir: string): string => {
    const env = driveEnv(fx)
    const sink = { stdout: "", stderr: "" }
    const spawn = makeRecordingSpawn(fx, env, sink)
    return lockfileHashSync({ hostRepoDir, fileExists, spawn: (a) => spawn(a, { capture: true }) })
  }

  it("returns the blob id and invokes git exactly once", { timeout: 60_000 }, () => {
    const pair = makeFixturePair({ readyAtTarget: true, readyAtPrev: true })
    const bash = runBashHash(pair.bash, pair.bash.work)
    const ts = runTsHash(pair.binary, pair.binary.work)
    // `$( )` strips the trailing newline git writes; the port must match, or
    // the value never compares equal to the journal's persisted copy.
    expect(ts).toBe(bash.stdout)
    expect(ts).toBe(blobHashOf(PREV_LOCK))
    expect(lines(readLog(pair.bash.gitLog))).toEqual([`-C ${pair.bash.work} hash-object ${pair.bash.work}/bun.lock`])
    expect(lines(readLog(pair.binary.gitLog))).toEqual([
      `-C ${pair.binary.work} hash-object ${pair.binary.work}/bun.lock`,
    ])
  })

  it("returns the EMPTY STRING for a missing bun.lock without invoking git at all", { timeout: 60_000 }, () => {
    const pair = makeFixturePair({ readyAtTarget: true, readyAtPrev: true })
    // A directory that exists and holds no bun.lock. Pointing HOST_REPO_DIR at
    // it rather than deleting the fixture's own file keeps the repo intact for
    // the log assertion below.
    const empty = (fx: Fixture): string => {
      const dir = join(fx.temp, "no-lockfile")
      mkdirSync(dir, { recursive: true })
      return dir
    }
    const bash = runBashHash(pair.bash, empty(pair.bash))
    const ts = runTsHash(pair.binary, empty(pair.binary))
    expect(ts).toBe("")
    expect(bash.stdout).toBe("")
    // THE CLAIM: the missing-file arm short-circuits before git. An
    // implementation that always spawned git and leaned on the failure arm
    // would return the same string and leave a log entry, so this is the only
    // assertion that can tell the two apart.
    expect(readLog(pair.bash.gitLog)).toBeNull()
    expect(readLog(pair.binary.gitLog)).toBeNull()
  })

  it("returns the EMPTY STRING when git itself fails", { timeout: 60_000 }, () => {
    const pair = makeFixturePair({ readyAtTarget: true, readyAtPrev: true })
    installLyingGit(pair.bash, "failing-hash-object")
    installLyingGit(pair.binary, "failing-hash-object")
    const bash = runBashHash(pair.bash, pair.bash.work)
    const ts = runTsHash(pair.binary, pair.binary.work)
    // bash's `|| printf ''`. Never a throw and never an error sentinel: the
    // value feeds a plain string comparison, so a sentinel would compare
    // unequal to the journal's copy and reinstall dependencies every run.
    expect(ts).toBe("")
    expect(bash.stdout).toBe("")
    expect(lines(readLog(pair.bash.gitLog))).toHaveLength(1)
    expect(lines(readLog(pair.binary.gitLog))).toHaveLength(1)
  })
})
