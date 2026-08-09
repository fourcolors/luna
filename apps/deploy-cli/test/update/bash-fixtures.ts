/**
 * Hermetic bash-side fixture for the golden parity harness: builds on the
 * shared git/makeDeployRepo/makeStubBin fixture (test/helpers/
 * update-server-fixtures.ts - a pure move of what used to be private to
 * test/update-server.test.ts, so this file no longer needs its own ~150-line
 * trimmed duplicate of them) plus the runUpdate pattern below.
 *
 * S22d PR1 EXTENSION - WHY EVERY NEW PIECE BELOW LIVES HERE AND NOT IN THE
 * SHARED FIXTURE. test/helpers/update-server-fixtures.ts is load-bearing for
 * the 273-test hostenv suite (test/deploy-scripts.test.ts 129 +
 * test/guardian.test.ts 90 + test/update-server.test.ts 54); the S22d spec
 * makes "cannot be built by layering replacement stubs in bash-fixtures.ts"
 * an ABANDON condition precisely so that suite is never perturbed to buy a
 * deploy-cli scenario. So every new stub here is written INTO the bin dir
 * makeStubBin already returned, replacing or adding to its files after the
 * fact, and every new behaviour is OPT-IN: with none of the new options set,
 * makeFixture/makeLightFixture produce byte-identical fixtures to before, so
 * journal-parity.test.ts and restart-guard-parity.test.ts keep passing
 * unedited.
 *
 * The four additions and the gap each one closes:
 *
 *  1. INCUS PASSTHROUGH (`incus`). target.ts's run_target waist
 *     (scripts/luna-update-server:352-358) wraps every in-container step in
 *     `incus exec <container> -- ...`, and the S22d acceptance runs the first
 *     three parity scenarios in BOTH bare-host and --incus topologies. With
 *     no `incus` on PATH those runs cannot start at all. The stub logs the
 *     RAW in-container argv (that is the diffable artifact) and then executes
 *     the payload on the host, rewriting the container-side path prefixes -
 *     CONTAINER_REPO_DIR is hardcoded to /root/luna at :313 and the claude
 *     re-pin arm hardcodes /root/.luna/.env at :1236-1247, neither of which
 *     is reachable through a flag - onto the fixture's own dirs. Without that
 *     rewrite `run_target test -d "$CONTAINER_REPO_DIR/node_modules"`
 *     (:1207-1213) fails on the host and every incus scenario dies in
 *     apply_ref_inplace's postcondition instead of exercising it.
 *
 *  2. SETTABLE MainPID (`mainPid`). The shared stub answers `show` with a
 *     hardcoded `printf '0\n'` (update-server-fixtures.ts:133), and
 *     restart_service skips the whole MainPID postcondition on a zero or
 *     unreadable pre-PID (:1519-1524, :1550) - so today EVERY MainPID
 *     scenario takes the skip branch and proves nothing. The replacement
 *     answers `--property=MainPID` from a caller-supplied QUEUE (one answer
 *     per query, the last repeating) and keeps `printf '0\n'` for
 *     NRestarts. A queue rather than a before/after pair because a run that
 *     rolls back restarts TWICE, and each restart needs its own pre/post
 *     pair; an answer of "" or a non-numeric string drives the
 *     unreadable/INCONCLUSIVE arms (:1552-1560).
 *
 *  3. CLAUDE STUB + .env (`claude`). The re-pin at :1218-1255 is ported
 *     arm-for-arm, and its three-way outcome (0 / rc 9 warn-only degrade /
 *     nonzero) is only observable if `command -v claude` and the pinned
 *     LUNA_CLAUDE_CODE_EXECUTABLE value can both be controlled: an
 *     executable pin returns at luna-deploy.sh:134-136, a stale pin takes
 *     the `removing stale ...` warn + remove path (:138-141), and neither a
 *     pin nor a claude on PATH is what makes the incus payload `exit 9`.
 *
 *  4. DATE-PINNED makeFixturePair. The dual-drive diff compares the two
 *     runs' final `git rev-parse HEAD` and their journals, which embed the
 *     target sha. makeDeployRepo does not pin GIT_AUTHOR_DATE /
 *     GIT_COMMITTER_DATE (update-server-fixtures.ts:41-60), so two fixtures
 *     built in the same run can land on different commit shas whenever the
 *     wall clock ticks a second between them, and the byte-diff would then
 *     pass or fail on timing luck. The pair pins both dates and ASSERTS the
 *     two repos hashed identically rather than trusting it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { makeDeployRepo, makeStubBin, type StubBinOptions } from "../../../../test/helpers/update-server-fixtures.js"
import { cleanupTempDirs as sharedCleanupTempDirs, makeTempDir as sharedMakeTempDir, repoRoot } from "./temp-dirs.js"

export const cleanupTempDirs = sharedCleanupTempDirs
// Shared by both the S22a journal-parity suite and the S22b restart/
// session-guard parity suite below - not journal-specific despite the file's
// own S22a origin, so a leaked temp dir points at the right suite.
const makeTempDir = (): string => sharedMakeTempDir("deploy-cli-update-parity-")

/** The SYSTEM unit file the script's user-unit guard requires (scripts/luna-update-server's user-unit-out-of-scope refusal). */
const writeUnit = (serviceDir: string, name = "luna-chat-server.service"): void => {
  mkdirSync(serviceDir, { recursive: true })
  writeFileSync(join(serviceDir, name), "[Unit]\n")
}

/** Single source of truth for the readiness/ws port every fixture pins, so `--readiness-port` (in args, below) and `readinessPort` (on Fixture, for a caller building a SessionGuardOptions) can never drift apart. */
export const READINESS_PORT = 4753

interface RunResult {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

export const runUpdate = (args: ReadonlyArray<string>, env: Record<string, string | undefined>): RunResult => {
  const r = spawnSync("bash", [join(repoRoot, "scripts/luna-update-server"), ...args], {
    cwd: repoRoot,
    env: { ...process.env, LUNA_RESTART_SETTLE_SECS: "0", LUNA_TEST_WS_COUNT: "0", ...env },
    encoding: "utf8",
  })
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

// --- replacement stubs, layered into makeStubBin's bin dir -------------------

/** `chmod +x` in the one shape makeStubBin uses (update-server-fixtures.ts:189), so every stub this file adds is executable the same way. */
const chmodExec = (...paths: ReadonlyArray<string>): void => {
  spawnSync("chmod", ["+x", ...paths])
}

/**
 * makeStubBin's private started-marker path (update-server-fixtures.ts:116),
 * recomputed rather than imported because it is not returned. The MainPID
 * systemctl replacement below must reproduce the shared stub's is-active
 * behaviour EXACTLY - including the `isActive`-until-first-start arm at
 * :122-125 - and that arm is keyed off this file.
 */
const startedMarkerPath = (root: string): string => join(root, "started.marker")

/** Where the container-side paths the bash script hardcodes get rewritten to, so an `incus exec` payload can run against the fixture's own dirs. See INCUS PASSTHROUGH in the header. */
export const INCUS_CONTAINER_REPO_DIR = "/root/luna"
export const INCUS_CONTAINER_LUNA_HOME = "/root/.luna"

/**
 * A hermetic `incus`: log the RAW argv, then run the payload on the host.
 *
 * `incus exec <container> -- <cmd> ...` is the only form the update script
 * emits (scripts/luna-update-server:352-358 and the run_target_capture twin
 * at :361-369), so anything else exits 1 loudly rather than silently
 * succeeding and letting a scenario "pass" on a command that never ran.
 *
 * `pathMap` entries are applied as plain substring replacements to EVERY
 * remaining argument, which is what makes the `bash -lc "<payload>"` claude
 * arm (:1236-1247) work too: its container paths sit inside a single quoted
 * argument. The log keeps the pre-rewrite text because the in-container
 * command is the thing a dual-drive diff is asserting.
 */
const writeIncusStub = (
  bin: string,
  incusLog: string,
  pathMap: ReadonlyArray<readonly [string, string]>,
): void => {
  // The from/to values are assigned to single-quoted shell variables and the
  // pattern is DOUBLE-QUOTED inside the expansion (`${a//"$_from0"/$_to0}`):
  // interpolating the paths into the expansion directly would break twice
  // over - bash ends the pattern at the first unescaped `/`, so `/root/luna`
  // silently degrades to an empty pattern, and an unquoted pattern is a GLOB,
  // so any `*?[` in a temp path would match structurally. Quoted-variable
  // form is literal and bash-3.2-safe (macOS ships 3.2, and these parity
  // suites run in the DEFAULT test gate on developer macOS).
  const assignments = pathMap
    .map(([from, to], i) => `_from${i}='${from}'\n_to${i}='${to}'`)
    .join("\n")
  const rewrites = pathMap.map((_pair, i) => `    a="\${a//"\$_from${i}"/\$_to${i}}"`).join("\n")
  writeFileSync(
    join(bin, "incus"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${incusLog}"
${assignments}
if [[ "$1" != "exec" ]]; then
  printf 'incus stub: unsupported subcommand: %s\\n' "$1" >&2
  exit 1
fi
# Drop 'exec' and the container name, then the '--' argv separator the script
# always passes. (The spec's shorthand 'shift 2' omits the separator; exec'ing
# a literal '--' would fail.)
shift 2
if [[ "$1" == "--" ]]; then shift; fi
if [[ $# -eq 0 ]]; then exit 0; fi
args=()
for a in "$@"; do
${rewrites}
  args+=("$a")
done
exec "\${args[@]}"
`,
  )
  chmodExec(join(bin, "incus"))
}

/**
 * systemctl with a SETTABLE MainPID, replacing the shared stub's hardcoded
 * `show -> printf '0\n'` (update-server-fixtures.ts:126-137). Everything else
 * - the log line's shape, is-active, the start marker, NRestarts answering 0,
 * the catch-all exit 0 - is reproduced verbatim, so a fixture that passes
 * `mainPid` differs from one that does not in exactly one answer.
 *
 * `--property=MainPID` is answered from `answers[callIndex]`, the last entry
 * repeating once the queue is exhausted; a run that rolls back queries twice
 * per restart and restarts twice, so the queue is the only shape that can
 * express "changed on the forward restart, changed again on the rollback
 * restart". A non-numeric or empty answer is passed through untouched, which
 * is how sup_main_pid's `[[ "$pid" =~ ^[0-9]+$ ]] || pid=""` normalisation
 * (:1424-1433) and restart_service's INCONCLUSIVE arm (:1552-1560) get
 * exercised. Bash 3.2 only - no mapfile - because this stub runs on the
 * developer macOS side of the default `bun run test` gate too.
 */
const writeMainPidSystemctl = (
  root: string,
  bin: string,
  systemctlLog: string,
  isActive: string | undefined,
  answers: ReadonlyArray<string>,
): { readonly mainPidAnswers: string; readonly mainPidCalls: string } => {
  const startedMarker = startedMarkerPath(root)
  const mainPidAnswers = join(root, "mainpid.answers")
  const mainPidCalls = join(root, "mainpid.calls")
  writeFileSync(mainPidAnswers, answers.length === 0 ? "" : `${answers.join("\n")}\n`)
  const isActiveLine =
    isActive === undefined
      ? `printf 'active\\n'`
      : `if [[ -f "${startedMarker}" ]]; then printf 'active\\n'; else printf '%s\\n' '${isActive}'; fi`
  writeFileSync(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${systemctlLog}"
case "$1" in
  is-active) ${isActiveLine}; exit 0 ;;
  start) : > "${startedMarker}"; exit 0 ;;
  show)
    if [[ "$*" == *MainPID* ]]; then
      n=1
      if [[ -f "${mainPidCalls}" ]]; then n=$(( $(cat "${mainPidCalls}") + 1 )); fi
      printf '%s' "$n" > "${mainPidCalls}"
      total=$(wc -l < "${mainPidAnswers}" | tr -d '[:space:]')
      if [[ "$total" -lt 1 ]]; then exit 0; fi
      if [[ "$n" -gt "$total" ]]; then n="$total"; fi
      sed -n "\${n}p" "${mainPidAnswers}"
      exit 0
    fi
    printf '0\\n'; exit 0 ;;
  *) exit 0 ;;
esac
`,
  )
  chmodExec(join(bin, "systemctl"))
  return { mainPidAnswers, mainPidCalls }
}

/**
 * How the claude re-pin (:1218-1255) is driven.
 *
 * `stub` decides what `command -v claude` answers - the FIRST branch of
 * luna_find_claude_executable (scripts/lib/luna-deploy.sh:113-116) and the
 * whole of the warn-only degrade check. `envPin` decides what
 * luna_configure_claude_executable reads out of ENV_FILE before it detects
 * anything (:128, :134-141):
 *   - "detected": the pin already names the claude stub, which is executable,
 *     so the helper returns at :134-136 having written nothing.
 *   - "stale": the pin names a path that does not exist, so the helper emits
 *     `removing stale LUNA_CLAUDE_CODE_EXECUTABLE (<path> is not executable)`
 *     on stderr, removes the key, and re-detects.
 * Omitting `envPin` writes no .env at all, which is what every pre-S22d
 * fixture did.
 *
 * The stub's own exit code is deliberately not configurable: nothing in the
 * re-pin path EXECUTES claude, it only resolves and stats it.
 */
export interface ClaudeFixtureOptions {
  readonly stub?: "present" | "absent"
  readonly envPin?: "detected" | "stale"
}

const writeClaudeStub = (bin: string): string => {
  const claudeBin = join(bin, "claude")
  writeFileSync(claudeBin, "#!/usr/bin/env bash\nexit 0\n")
  chmodExec(claudeBin)
  return claudeBin
}

/** A fully wired fixture: deploy repo + stub bin + unit + the args/env every runUpdate call in this suite shares. */
export interface Fixture {
  readonly temp: string
  readonly work: string
  readonly prevSha: string
  readonly targetSha: string
  readonly updateState: string
  readonly serviceName: string
  readonly readinessPort: number
  readonly bin: string
  readonly systemctlLog: string
  /** makeStubBin returns these (update-server-fixtures.ts:107-110) and the pre-S22d makeFixture dropped them; the dual-drive diff needs curl.log and bun.log as first-class artifacts (bun.log is what proves `bun install` fired only on a lockfile delta, and carries the seed invocation after it). */
  readonly curlLog: string
  readonly bunLog: string
  /** $LUNA_HOME/.env - written only when `claude.envPin` is set, but always named so a scenario can read it back after the re-pin. */
  readonly envFile: string
  // The optional fields below are spelled `?: T | undefined` rather than
  // `?: T` because this repo compiles with exactOptionalPropertyTypes
  // (tsconfig.json:12) and makeFixture assigns them unconditionally.
  /** The `claude` stub's path, when `claude.stub` is "present"; this is also the value a "detected" env pin carries. */
  readonly claudeBin?: string | undefined
  /** Raw `incus exec ...` argv log, when the `incus` option is set. */
  readonly incusLog?: string | undefined
  /** The MainPID answer queue and the query counter, when `mainPid` is set - a scenario may rewrite the answers file mid-run. */
  readonly mainPidAnswers?: string | undefined
  readonly mainPidCalls?: string | undefined
  /** The container name passed to `--incus`, when set. */
  readonly incusContainer?: string | undefined
  readonly args: ReadonlyArray<string>
  readonly env: Record<string, string | undefined>
}

/**
 * Every knob makeFixture forwards. The first three fields are the pre-S22d
 * signature unchanged; the rest are opt-in and default to exactly what the
 * pre-S22d fixture did, which is what keeps journal-parity.test.ts and
 * restart-guard-parity.test.ts passing unedited.
 */
export interface FixtureOptions
  extends Pick<
    StubBinOptions,
    | "readyAtTarget"
    | "readyAtPrev"
    | "isActive"
    | "setupAtTarget"
    | "omitBuildShaAtTarget"
    | "omitBuildShaAtPrev"
    | "mismatchBuildShaAtPrev"
  > {
  /** Forwarded to makeDeployRepo (update-server-fixtures.ts:51-56): target's bun.lock differs from prev's, so the lockfile-hash gate at :1199-1215 takes the INSTALL arm instead of the "unchanged" arm. */
  readonly lockChanges?: boolean | undefined
  /** Answer queue for `systemctl show --property=MainPID`; see writeMainPidSystemctl. Omitted keeps the shared stub's hardcoded 0 (and therefore the skip branch). */
  readonly mainPid?: ReadonlyArray<string> | undefined
  /** Drives the claude re-pin's three-way outcome; see ClaudeFixtureOptions. */
  readonly claude?: ClaudeFixtureOptions | undefined
  /** Container name for `--incus`; installs the passthrough stub and appends the flag. */
  readonly incus?: string | undefined
}

export const makeFixture = (opts: FixtureOptions): Fixture => {
  // Split the S22d knobs off the ones makeStubBin already understands, then
  // SPREAD the remainder: under exactOptionalPropertyTypes, re-listing each
  // optional field by hand would pass an explicit `undefined` into a
  // `readonly setupAtTarget?: boolean` slot and fail to compile. The rest
  // object preserves optionality exactly.
  const { lockChanges, mainPid, claude, incus, ...stubOpts } = opts
  const temp = makeTempDir()
  const { work, prevSha, targetSha } = makeDeployRepo(temp, lockChanges === undefined ? {} : { lockChanges })
  const serviceDir = join(temp, "systemd")
  const updateState = join(temp, "update-state")
  const lunaHome = join(temp, "state")
  const envFile = join(lunaHome, ".env")
  const serviceName = "luna-chat-server.service"
  writeUnit(serviceDir, serviceName)
  const { bin, systemctlLog, curlLog, bunLog } = makeStubBin(temp, { repo: work, prevSha, targetSha, ...stubOpts })

  // Layered replacements, each one a no-op unless its option was passed.
  const mainPidFiles =
    mainPid === undefined ? undefined : writeMainPidSystemctl(temp, bin, systemctlLog, opts.isActive, mainPid)

  const claudeBin = claude?.stub === "present" ? writeClaudeStub(bin) : undefined
  if (claude?.envPin !== undefined) {
    if (claude.envPin === "detected" && claudeBin === undefined) {
      throw new Error("makeFixture: claude.envPin 'detected' requires claude.stub 'present' (the pin must name an executable)")
    }
    const pinned = claude.envPin === "detected" ? claudeBin : join(temp, "stale-claude")
    mkdirSync(lunaHome, { recursive: true })
    // mode 600: the same posture luna_upsert_env enforces on the file it
    // rewrites (scripts/lib/luna-deploy.sh:52-62), so the fixture's starting
    // state is not looser than the state the deploy leaves behind.
    writeFileSync(envFile, `LUNA_CLAUDE_CODE_EXECUTABLE=${pinned}\n`, { mode: 0o600 })
  }

  const incusLog = incus === undefined ? undefined : join(temp, "incus.log")
  if (incus !== undefined && incusLog !== undefined) {
    // The claude re-pin's incus arm sources
    // "$CONTAINER_REPO_DIR/scripts/lib/luna-deploy.sh" (:1236-1247) - in
    // production that IS the repo's own lib, seen through the bind-mount.
    // makeDeployRepo's synthetic two-file repo has no scripts/, so drop the
    // REAL lib into the checkout rather than special-casing the path map:
    // the payload then resolves it through the ordinary /root/luna rewrite,
    // sources the same audited bytes bash-lib.ts will source, and - being
    // UNTRACKED - survives `git reset --hard` in both directions, the same
    // property the shared fixture already leans on for node_modules
    // (update-server-fixtures.ts:72-75).
    const libDir = join(work, "scripts", "lib")
    mkdirSync(libDir, { recursive: true })
    writeFileSync(join(libDir, "luna-deploy.sh"), readFileSync(join(repoRoot, "scripts/lib/luna-deploy.sh"), "utf8"))
    writeIncusStub(bin, incusLog, [
      // Longest prefix first: /root/.luna is not a prefix of /root/luna, but
      // ordering the map explicitly keeps it correct if either constant moves.
      [INCUS_CONTAINER_LUNA_HOME, lunaHome],
      [INCUS_CONTAINER_REPO_DIR, work],
    ])
  }

  return {
    temp,
    work,
    prevSha,
    targetSha,
    updateState,
    serviceName,
    readinessPort: READINESS_PORT,
    bin,
    systemctlLog,
    curlLog,
    bunLog,
    envFile,
    claudeBin,
    incusLog,
    mainPidAnswers: mainPidFiles?.mainPidAnswers,
    mainPidCalls: mainPidFiles?.mainPidCalls,
    incusContainer: incus,
    args: [
      // Pin every value the bash script would otherwise resolve from
      // ambient LUNA_* env (PROFILE/SUPERVISOR/READINESS_PORT) so a
      // developer's or CI runner's real env can never redirect this fixture
      // at the wrong journal path, unit name, or supervisor backend - the
      // fixture's own writeUnit()/journalPath assume profile "stable".
      "--profile", "stable",
      "--repo-dir", work,
      "--ref", "origin/master",
      "--luna-home", lunaHome,
      "--service-dir", serviceDir,
      "--readiness-timeout", "2",
      "--readiness-interval", "0.3",
      "--readiness-port", String(READINESS_PORT),
      "--supervisor", "systemd",
      // Appended, never inserted, so the pre-S22d arg vector is a strict
      // prefix of the incus one and a bare-host fixture's args are unchanged.
      ...(incus === undefined ? [] : ["--incus", incus]),
    ],
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_UPDATE_STATE_DIR: updateState,
    },
  }
}

/** The pieces of `Fixture` a TS-only scenario (no `runUpdate` call) ever consumes. */
export interface LightFixture {
  readonly temp: string
  readonly serviceName: string
  readonly readinessPort: number
  readonly bin: string
  readonly systemctlLog: string
  readonly mainPidAnswers?: string | undefined
  readonly mainPidCalls?: string | undefined
}

/**
 * A TS-only fixture path (FIX10): every scenario in restart-guard-parity.test.ts
 * that never calls `runUpdate` - it only drives `restartServiceSync`/
 * `restartSessionGuardSync`/`queryActiveWsCountSync` directly against the
 * stub `systemctl` binary - still paid for `makeFixture`'s full
 * `makeDeployRepo` (git init + a bare origin + a seed clone + two commits +
 * a push + a second clone + a checkout, ~15 subprocesses) despite consuming
 * only `.bin`/`.serviceName`/`.readinessPort`/`.systemctlLog` from the
 * result. `makeStubBin`'s own `curl` stub interpolates `repo`/`prevSha`/
 * `targetSha` into its script TEXT but never validates them at fixture-
 * build time - a TS-only scenario never executes that stub (it never spawns
 * `curl` at all), so placeholder strings are exactly as good as a real repo
 * here. `makeFixture` (above) stays the one used by every scenario that
 * actually calls `runUpdate` against the real bash script.
 */
export const makeLightFixture = (
  opts: {
    readonly readyAtTarget: boolean
    readonly readyAtPrev: boolean
    readonly isActive?: string
    /** Same MainPID answer queue makeFixture takes - restart.ts's new MainPID postcondition is driven TS-side, with no `runUpdate` call, so it needs it here too. */
    readonly mainPid?: ReadonlyArray<string> | undefined
  },
): LightFixture => {
  const { mainPid, ...stubOpts } = opts
  const temp = makeTempDir()
  const serviceName = "luna-chat-server.service"
  const { bin, systemctlLog } = makeStubBin(temp, {
    repo: join(temp, "unused-repo"),
    prevSha: "unused-prev-sha",
    targetSha: "unused-target-sha",
    ...stubOpts,
  })
  const mainPidFiles =
    mainPid === undefined ? undefined : writeMainPidSystemctl(temp, bin, systemctlLog, opts.isActive, mainPid)
  return {
    temp,
    serviceName,
    readinessPort: READINESS_PORT,
    bin,
    systemctlLog,
    mainPidAnswers: mainPidFiles?.mainPidAnswers,
    mainPidCalls: mainPidFiles?.mainPidCalls,
  }
}

// --- the dual-drive pair ------------------------------------------------------

/**
 * The fixed commit timestamp both drives' repos are built at. Any instant
 * works; what matters is that it is the SAME one for both, and that it is
 * pinned rather than read off the wall clock - see DATE-PINNED in the header.
 */
const PINNED_COMMIT_DATE = "2026-01-01T00:00:00+00:00"

/**
 * Run `build` with GIT_AUTHOR_DATE/GIT_COMMITTER_DATE pinned, restoring the
 * caller's values (including "was not set") on every exit path.
 *
 * process.env is the only lever available: makeDeployRepo's `git()` spawns
 * without an explicit `env` (update-server-fixtures.ts:19), so the child
 * inherits ours - and that shared helper is the one file this slice is
 * forbidden to edit, which is exactly why the pin lives out here.
 */
const withPinnedCommitDates = <T>(build: () => T): T => {
  const saved = { author: process.env.GIT_AUTHOR_DATE, committer: process.env.GIT_COMMITTER_DATE }
  process.env.GIT_AUTHOR_DATE = PINNED_COMMIT_DATE
  process.env.GIT_COMMITTER_DATE = PINNED_COMMIT_DATE
  try {
    return build()
  } finally {
    if (saved.author === undefined) delete process.env.GIT_AUTHOR_DATE
    else process.env.GIT_AUTHOR_DATE = saved.author
    if (saved.committer === undefined) delete process.env.GIT_COMMITTER_DATE
    else process.env.GIT_COMMITTER_DATE = saved.committer
  }
}

/** Two independently-rooted fixtures for the SAME scenario: one for the bash drive, one for the binary drive. */
export interface FixturePair {
  readonly bash: Fixture
  readonly binary: Fixture
}

/**
 * The dual-drive fixture. Both halves are built from identical options with
 * the commit dates pinned, so `prevSha`/`targetSha` - which the journal, the
 * success line, READINESS_DETAIL and the final `git rev-parse HEAD` all
 * embed - are equal by construction rather than by wall-clock luck.
 *
 * The equality is ASSERTED, not assumed: git's commit hash also folds in the
 * author/committer identity (makeDeployRepo pins those via `git config`) and
 * the tree, so a future change to the shared fixture that reintroduced any
 * per-run variation would otherwise show up as a mystifying byte-diff in
 * somebody else's parity suite instead of here.
 *
 * The two roots stay separate on purpose: each drive must be able to mutate
 * its own checkout, journal, lock dir and logs without the other observing
 * it, which is what makes the six diffed artifacts meaningful.
 */
export const makeFixturePair = (opts: FixtureOptions): FixturePair => {
  const { bash, binary } = withPinnedCommitDates(() => ({
    bash: makeFixture(opts),
    binary: makeFixture(opts),
  }))
  if (bash.prevSha !== binary.prevSha || bash.targetSha !== binary.targetSha) {
    throw new Error(
      "makeFixturePair: the two drives' repos did not hash identically despite pinned commit dates " +
        `(bash ${bash.prevSha}->${bash.targetSha}, binary ${binary.prevSha}->${binary.targetSha}); ` +
        "a byte-diff across the pair would be meaningless - has makeDeployRepo gained a per-run varying input?",
    )
  }
  return { bash, binary }
}
