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
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { delimiter, join, relative, sep } from "node:path"
import { spawnSync } from "node:child_process"
import { makeDeployRepo, makeStubBin, type StubBinOptions } from "../../../../test/helpers/update-server-fixtures.js"
import { cleanupTempDirs as sharedCleanupTempDirs, makeTempDir as sharedMakeTempDir, repoRoot } from "./temp-dirs.js"

export const cleanupTempDirs = sharedCleanupTempDirs

/**
 * Every fixture root this module has ever handed out, in creation order.
 *
 * resolveHostTool (below) must be able to PROVE that the runtime it resolved
 * came off the ambient PATH and not out of a fixture's own bin dir - blocker
 * B17 in the S22d PR2 spec, where "look `bun` up on PATH" silently resolved
 * the stub that logs its argv and exits 0, so a test that believed it had run
 * the binary had run nothing at all. Scanning process.env.PATH is the primary
 * defence; this list is what turns the secondary assertion from a comment
 * into a check.
 */
const fixtureRoots: string[] = []

// Shared by both the S22a journal-parity suite and the S22b restart/
// session-guard parity suite below - not journal-specific despite the file's
// own S22a origin, so a leaked temp dir points at the right suite.
const makeTempDir = (): string => {
  const dir = sharedMakeTempDir("deploy-cli-update-parity-")
  fixtureRoots.push(dir)
  return dir
}

/** Path containment that does not depend on symlink resolution or on a trailing separator, so it answers the same on Linux and macOS. */
const isInside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child)
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`.${sep}.${sep}`)
}

const hostToolCache = new Map<string, string>()

/**
 * Resolve a host runtime (`bash`, `git`, `bun`) to an ABSOLUTE path, scanning
 * the AMBIENT process.env.PATH and nothing else.
 *
 * THE HARNESS CONTRACT, "One interpreter, resolved once". Three separate
 * things depend on this being ambient-only:
 *
 *  - Blocker B17. `vitest run` is a NODE process even under `bun run test`
 *    (process.versions.bun is undefined), so the old "use process.execPath
 *    when running under Bun, else look `bun` up on PATH" rule ALWAYS took the
 *    PATH branch - and the PATH a fixture-derived env carries has the fixture
 *    bin dir FIRST, whose `bun` is a stub that logs and exits 0. The natural
 *    reading of that rule therefore "ran the binary" by running a stub, and
 *    every assertion downstream of it was vacuous.
 *  - Blocker B19. Both drives must run the SAME bash. Node's spawnSync
 *    resolves argv[0] from the CHILD env's PATH when options.env is given
 *    (measured: a fake `bash` first on the child PATH is what ran), which is
 *    a portability landmine nobody should have to know about. Pinning the
 *    interpreter explicitly removes the dependency on that rule entirely.
 *  - THE REPLACEMENT `curl` MUST CALL GIT BY ABSOLUTE PATH. The curl stub's
 *    own `rev-parse HEAD` has to bypass the fixture's `git` shim, or git.log
 *    inherits the readiness poll count and the strict git.log diff starts
 *    flaking red on a CORRECT implementation.
 *
 * Absent tools THROW with the fix named, never skip: a silently-skipped
 * parity gate is indistinguishable from a passing one.
 *
 * Windows is deliberately unhandled (no PATHEXT walk): this repo's test gate
 * runs on Linux and macOS only, and a half-working Windows branch would be
 * worse than an honest absence.
 */
export const resolveHostTool = (name: string): string => {
  const cached = hostToolCache.get(name)
  if (cached !== undefined) return cached
  const raw = process.env.PATH ?? ""
  const dirs = raw.split(delimiter).filter((d) => d !== "")
  for (const dir of dirs) {
    const candidate = join(dir, name)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, fsConstants.X_OK)
    } catch {
      continue
    }
    for (const root of fixtureRoots) {
      if (isInside(root, candidate)) {
        throw new Error(
          `resolveHostTool(${JSON.stringify(name)}) resolved ${candidate}, which is INSIDE the fixture root ${root}. ` +
            "That is the stub, not the host tool (S22d PR2 blocker B17). The ambient PATH must not contain a fixture bin dir; " +
            "check for a leaked vi.stubEnv('PATH', ...) or a test that mutated process.env.PATH.",
        )
      }
    }
    hostToolCache.set(name, candidate)
    return candidate
  }
  throw new Error(
    `resolveHostTool(${JSON.stringify(name)}): no executable regular file named ${JSON.stringify(name)} on the ambient PATH.\n` +
      `  ambient PATH: ${raw}\n` +
      `  fix: install ${name} and put it on the PATH the test runner inherits. The dual-drive parity harness resolves every ` +
      "runtime explicitly from the AMBIENT PATH (never from a fixture env), so it cannot fall back to a stub, and it refuses " +
      "to skip - a skipped parity gate looks exactly like a passing one.",
  )
}

/** The SYSTEM unit file the script's user-unit guard requires (scripts/luna-update-server's user-unit-out-of-scope refusal). */
const writeUnit = (serviceDir: string, name = "luna-chat-server.service"): void => {
  mkdirSync(serviceDir, { recursive: true })
  writeFileSync(join(serviceDir, name), "[Unit]\n")
}

/** Single source of truth for the readiness/ws port every fixture pins, so `--readiness-port` (in args, below) and `readinessPort` (on Fixture, for a caller building a SessionGuardOptions) can never drift apart. A STRING, matching the raw spelling config.ts and every consumer of it now carry - the fixture must be able to express an operator's `04753` verbatim, not a renormalised form of it. */
export const READINESS_PORT = "4753"

export interface RunResult {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * THE SPAWN ERROR MUST NEVER BE SWALLOWED, and this helper exists because it
 * was, at all three drive sites, for the entire life of the harness.
 *
 * `spawnSync` reports a failure to START the process (EAGAIN under fork
 * pressure, ENOENT, ENOEXEC, a maxBuffer overflow) in `r.error`, leaving
 * `status` null and `stdout` empty. Every drive discarded that field, so such
 * a failure arrived at the comparison as a run that produced no output and no
 * exit code, and the parity diff then reported an arbitrary artifact
 * divergence with no cause attached.
 *
 * That is not hypothetical: an intermittent GATE 1 failure was investigated
 * twice, and both investigations dead-ended on exactly this - "cause not
 * identified, no assertion text captured". Whatever the next occurrence turns
 * out to be, it will now say so.
 *
 * IT THROWS RATHER THAN ANNOTATING, deliberately. The obvious alternative is
 * to append a note to stderr, but GATE 1 compares stderr BYTE-EXACTLY between
 * the two drives, so annotating would corrupt the very artifact the harness
 * exists to compare, and would turn a harness fault into a fake parity
 * failure. A process that never started has no behaviour to compare, so the
 * only honest outcome is a loud harness error naming the drive and the cause.
 */
const okOrThrow = (
  r: { error?: Error; status: number | null; signal: NodeJS.Signals | null; stdout?: string; stderr?: string },
  drive: string,
  cmd: string,
): RunResult => {
  if (r.error !== undefined) {
    throw new Error(
      `[harness] ${drive} FAILED TO SPAWN ${cmd}: ${r.error.message}\n` +
        `This is a harness fault, not a parity failure: the process never ran, so there is nothing to compare. ` +
        `Common causes are fork exhaustion under parallel load (EAGAIN), a missing interpreter (ENOENT), or a maxBuffer overflow.`,
    )
  }
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

export const runUpdate = (args: ReadonlyArray<string>, env: Record<string, string | undefined>): RunResult => {
  // resolveHostTool, NOT a bare "bash". A bare interpreter name resolves from
  // whatever PATH the caller happens to have, while runBashDrive (the other
  // oracle runner) resolves explicitly - so the two could run DIFFERENT bash
  // binaries and their byte diff would then compare two things that can differ
  // for reasons unrelated to the port. An audit raised exactly this, the fix
  // landed on the newer drive, and this legacy runner kept its bare call.
  const bash = resolveHostTool("bash")
  const r = spawnSync(bash, [join(repoRoot, "scripts/luna-update-server"), ...args], {
    cwd: repoRoot,
    env: { ...process.env, LUNA_RESTART_SETTLE_SECS: "0", LUNA_TEST_WS_COUNT: "0", ...env },
    encoding: "utf8",
  })
  return okOrThrow(r, "legacy runUpdate (bash oracle)", bash)
}

// --- replacement stubs, layered into makeStubBin's bin dir -------------------

/**
 * Make every stub this file writes executable.
 *
 * chmodSync rather than makeStubBin's `spawnSync("chmod", ["+x", ...])`
 * (update-server-fixtures.ts:189): the outcome is the same 0755 either way,
 * but a syscall cannot fail for the reasons a spawn can (no `chmod` on a
 * minimal PATH, a stubbed PATH left behind by a sibling test, an exec-format
 * refusal), and this harness deliberately never spawns anything it did not
 * resolve explicitly. Same reasoning as resolveHostTool, one layer down.
 */
const chmodExec = (...paths: ReadonlyArray<string>): void => {
  for (const p of paths) chmodSync(p, 0o755)
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
  traceLog: string,
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
printf 'incus %s\\n' "$*" >> "${traceLog}"
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
 * The ONE `systemctl` this file installs, written UNCONDITIONALLY over
 * makeStubBin's (update-server-fixtures.ts:126-137).
 *
 * WHY UNCONDITIONALLY, which is blocker R11. The shared stub lives in the one
 * file this slice is forbidden to edit, and it has no trace line - so
 * cross-stub ORDER is unobservable, and "the binary ran bun install AFTER the
 * restart" diffs clean on every per-stub log. Rather than edit the forbidden
 * file, bash-fixtures.ts re-implements the three trace-less stubs
 * (`systemctl`, `curl`, `bun`) in its own layer and overwrites them after
 * makeStubBin has written its own. The trace append is the FIRST statement,
 * before anything else the stub does, so trace.log is a true creation order.
 *
 * Everything else - the own-log line's shape, is-active, the start marker,
 * NRestarts answering 0, the catch-all exit 0 - is reproduced verbatim from
 * :126-137, so a fixture that passes `mainPid` differs from one that does not
 * in exactly one answer, and the three green PR1 suites that read
 * systemctl.log see byte-identical content.
 *
 * `--property=MainPID` is answered from `answers[callIndex]`, the last entry
 * repeating once the queue is exhausted; a run that rolls back queries twice
 * per restart and restarts twice, so the queue is the only shape that can
 * express "changed on the forward restart, changed again on the rollback
 * restart". A non-numeric or empty answer is passed through untouched, which
 * is how sup_main_pid's `[[ "$pid" =~ ^[0-9]+$ ]] || pid=""` normalisation
 * (:1424-1433) and restart_service's INCONCLUSIVE arm (:1552-1560) get
 * exercised. `answers === undefined` keeps the shared stub's hardcoded
 * `printf '0\n'`, which is what every pre-S22d fixture saw.
 * Bash 3.2 only - no mapfile - because this stub runs on the developer macOS
 * side of the default `bun run test` gate too.
 */
const writeSystemctlStub = (
  root: string,
  bin: string,
  systemctlLog: string,
  traceLog: string,
  isActive: string | undefined,
  answers: ReadonlyArray<string> | undefined,
): { readonly mainPidAnswers: string; readonly mainPidCalls: string } | undefined => {
  const startedMarker = startedMarkerPath(root)
  const mainPidAnswers = join(root, "mainpid.answers")
  const mainPidCalls = join(root, "mainpid.calls")
  if (answers !== undefined) {
    writeFileSync(mainPidAnswers, answers.length === 0 ? "" : `${answers.join("\n")}\n`)
  }
  const isActiveLine =
    isActive === undefined
      ? `printf 'active\\n'`
      : `if [[ -f "${startedMarker}" ]]; then printf 'active\\n'; else printf '%s\\n' '${isActive}'; fi`
  const showArm =
    answers === undefined
      ? `  show) printf '0\\n'; exit 0 ;;`
      : `  show)
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
    printf '0\\n'; exit 0 ;;`
  writeFileSync(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash
printf 'systemctl %s\\n' "$*" >> "${traceLog}"
printf '%s\\n' "$*" >> "${systemctlLog}"
case "$1" in
  is-active) ${isActiveLine}; exit 0 ;;
  start) : > "${startedMarker}"; exit 0 ;;
${showArm}
  *) exit 0 ;;
esac
`,
  )
  chmodExec(join(bin, "systemctl"))
  return answers === undefined ? undefined : { mainPidAnswers, mainPidCalls }
}

/**
 * The trace-emitting `curl`, a byte-faithful re-implementation of
 * update-server-fixtures.ts:142-176 with exactly three deliberate changes.
 *
 * A REVIEWER MUST DIFF THIS AGAINST :142-176. Six options
 * (readyAtTarget, readyAtPrev, setupAtTarget, omitBuildShaAtTarget,
 * omitBuildShaAtPrev, mismatchBuildShaAtPrev) drive the readiness verdict of
 * every scenario in the gate, so a silent drift here would make BOTH drives
 * agree on the wrong answer and every scenario would keep passing.
 * stub-fidelity.test.ts is the mechanical guard: it drives the original and
 * this replacement over the same option matrix at the same HEADs and asserts
 * byte-identical stdout.
 *
 * The three changes:
 *
 *  1. The trace line, first, before anything else.
 *
 *  2. THE `git` CALL IS ABSOLUTE, NOT A BARE `git`, and this is load-bearing
 *     for the whole gate rather than a detail. :143 runs `git -C <repo>
 *     rev-parse HEAD`; the fixture bin dir is FIRST on PATH and nothing in
 *     scripts/luna-update-server or scripts/lib/luna-deploy.sh re-orders it,
 *     so a bare `git` here resolves to this file's `git` SHIM. Every readiness
 *     poll would then append a `git` entry to trace.log and git.log, which
 *     breaks the gate twice over: git.log becomes exactly as poll-count-
 *     dependent as the logs the determinism section admits it cannot pin, so
 *     its STRICT diff flakes red on a CORRECT implementation; and the
 *     poll-block definition normalisePollBlocks implements stops matching
 *     anything real, so the collapse never fires and the one scenario that
 *     needs it is compared strictly against a varying log. Resolving git by
 *     absolute path buys the property the gate needs: git.log records ONLY the
 *     flow's own git calls, which are deterministic, so it stays STRICT on
 *     every scenario including retry-to-exhaustion.
 *     stub-fidelity.test.ts asserts this directly, by driving this stub once
 *     and asserting git.log did not change.
 *
 *  3. `readyAfterCalls`, an option the original does not have, used only by
 *     the retry scenarios under GATE 1: READINESS DETERMINISM. The stub counts
 *     its own invocations in a file beside the log and forces the not-ready
 *     code until the count is reached. The counting block is EMITTED ONLY when
 *     the option is set, so with it unset this stub is inert in exactly the
 *     way the fidelity assertion requires.
 */
export interface CurlStubOptions {
  readonly repo: string
  readonly prevSha: string
  readonly targetSha: string
  readonly readyAtTarget: boolean
  readonly readyAtPrev: boolean
  readonly setupAtTarget?: boolean | undefined
  readonly omitBuildShaAtTarget?: boolean | undefined
  readonly omitBuildShaAtPrev?: boolean | undefined
  readonly mismatchBuildShaAtPrev?: boolean | undefined
  /** Answer not-ready until this many invocations have happened; see change 3 above. */
  readonly readyAfterCalls?: number | undefined
}

export const writeCurlStub = (
  bin: string,
  curlLog: string,
  traceLog: string,
  callsFile: string,
  opts: CurlStubOptions,
): void => {
  const gitBin = resolveHostTool("git")
  const b = (v: boolean | undefined): string => (v === true ? "1" : "0")
  // Emitted only when readyAfterCalls is set, so the default stub stays a
  // byte-faithful re-implementation with nothing extra to drift.
  const retryGate =
    opts.readyAfterCalls === undefined
      ? ""
      : `n=1
if [[ -f "${callsFile}" ]]; then n=$(( $(cat "${callsFile}") + 1 )); fi
printf '%s' "$n" > "${callsFile}"
if [[ "$n" -lt ${opts.readyAfterCalls} ]]; then code='503'; mode='normal'; fi
`
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "${traceLog}"
printf '%s\\n' "$*" >> "${curlLog}"
head="$("${gitBin}" -C "${opts.repo}" rev-parse HEAD 2>/dev/null || printf 'unknown')"
code='503'
mode='normal'
if [[ "$head" == "${opts.targetSha}" && "${b(opts.readyAtTarget)}" == "1" ]]; then
  code='200'
fi
if [[ "$head" == "${opts.prevSha}" && "${b(opts.readyAtPrev)}" == "1" ]]; then
  code='200'
fi
# #28: a deploy that boots into setup-mode answers /healthz 200 but /readyz setup.
if [[ "$head" == "${opts.targetSha}" && "${b(opts.setupAtTarget)}" == "1" ]]; then
  code='200'; mode='setup'
fi
${retryGate}if [[ "$*" == *"/readyz"* ]]; then
  # Mirror curl -sS -w '\\n%{http_code}' on /readyz: JSON body, newline, code.
  okbool='true'; [[ "$mode" == 'setup' ]] && okbool='false'
  if [[ "$head" == "${opts.targetSha}" && "${b(opts.omitBuildShaAtTarget)}" == "1" ]] ||
     [[ "$head" == "${opts.prevSha}" && "${b(opts.omitBuildShaAtPrev)}" == "1" ]]; then
    printf '{"status":"ok","mode":"%s","credentialOk":%s}\\n%s' "$mode" "$okbool" "$code"
  elif [[ "$head" == "${opts.prevSha}" && "${b(opts.mismatchBuildShaAtPrev)}" == "1" ]]; then
    printf '{"status":"ok","mode":"%s","credentialOk":%s,"buildSha":"deadbeef"}\\n%s' "$mode" "$okbool" "$code"
  else
    printf '{"status":"ok","mode":"%s","credentialOk":%s,"buildSha":"%s"}\\n%s' "$mode" "$okbool" "$head" "$code"
  fi
  exit 0
fi
# /healthz: mirror -o /dev/null -w '%{http_code}' -> print just the code. Exit 0 so
# the script's own [[ "$http" == "200" ]] gate (not curl's rc) decides.
printf '%s' "$code"
exit 0
`,
  )
  chmodExec(join(bin, "curl"))
}

/** The trace-emitting `bun`, a byte-faithful re-implementation of update-server-fixtures.ts:181-187 plus the trace line. Same R11 reasoning as writeSystemctlStub. */
const writeBunStub = (bin: string, bunLog: string, traceLog: string): void => {
  writeFileSync(
    join(bin, "bun"),
    `#!/usr/bin/env bash
printf 'bun %s\\n' "$*" >> "${traceLog}"
printf '%s\\n' "$*" >> "${bunLog}"
exit 0
`,
  )
  chmodExec(join(bin, "bun"))
}

/** How the `ss` stub answers `luna_active_ws_count` / `queryActiveWsCountSync`. */
export interface SsFixtureOptions {
  /** One simulated ESTABLISHED connection per unit; 0 (the default) means zero live sessions. */
  readonly sessions?: number | undefined
  /** The stub's own exit code; 1 drives the UNKNOWN arm both engines must fail closed on. */
  readonly rc?: number | undefined
}

/**
 * `ss`, written UNCONDITIONALLY by makeFixture and makeLightFixture, which is
 * blockers B6 and B15.
 *
 * session-guard.ts:35-39 and :182-184 state that the port has no
 * LUNA_TEST_WS_COUNT seam and never will, because an ambient test variable
 * that can spoof a fail-closed decision is exactly what that module refuses to
 * have. So driveEnv cannot pin the BASH drive with that variable either, or
 * the two engines take structurally different probe paths: bash short-circuits
 * at scripts/lib/luna-deploy.sh:268-273 while the port runs spawnSync("ss")
 * at session-guard.ts:195 - which on macOS does not exist at all and on a
 * Linux runner counts the REAL host's established sockets on the readiness
 * port. A real `ss` on the fixture PATH makes the guard genuinely dual-driven
 * instead of short-circuited on one side.
 *
 * Unconditional, not opt-in, because that is precisely what lets driveEnv omit
 * LUNA_TEST_WS_COUNT safely. The legacy runUpdate helper therefore gains an
 * `ss` it did not have, which is harmless there: it sets LUNA_TEST_WS_COUNT=0,
 * which short-circuits before the probe is ever reached.
 *
 * Both luna_active_ws_count's bare-host arm (luna-deploy.sh:283-287) and
 * queryActiveWsCountSync's (session-guard.ts:195-199) pass the filter as ONE
 * quoted argv word and count lines, so one stub serves both. The incus arm
 * needs nothing extra: both engines exec `sh -c "command -v ss ...; ss ..."`
 * through the fixture's `incus` passthrough, the payload inherits the fixture
 * PATH, and `command -v ss` finds this same stub.
 */
const writeSsStub = (bin: string, ssLog: string, traceLog: string, port: string, opts: SsFixtureOptions): void => {
  const sessions = opts.sessions ?? 0
  const rc = opts.rc ?? 0
  writeFileSync(
    join(bin, "ss"),
    `#!/usr/bin/env bash
printf 'ss %s\\n' "$*" >> "${traceLog}"
printf 'ss %s\\n' "$*" >> "${ssLog}"
# One line per simulated established connection; zero lines = zero sessions.
n=${sessions}
i=0; while [[ $i -lt $n ]]; do printf 'ESTAB 0 0 127.0.0.1:${port} 127.0.0.1:12345\\n'; i=$((i+1)); done
exit ${rc}
`,
  )
  chmodExec(join(bin, "ss"))
}

/**
 * `git` is a SHIM, not a stub: it records the call and then execs the REAL git
 * by absolute path, so git stays real while its call sequence becomes
 * observable. Without it, "a resume performs ZERO `git fetch`" has no artifact
 * to assert against.
 *
 * A two-line `#!/bin/sh` shim rather than a symlink, because no test may
 * depend on symlink support: a checkout or a CI cache that does not preserve
 * symlinks would fail this suite for a reason unrelated to the port.
 * `/bin/sh` rather than `#!/usr/bin/env bash` because this shim must not
 * depend on the `bash` shim beside it, and because dash and bash agree
 * completely on the three constructs used here.
 */
const writeGitShim = (bin: string, gitLog: string, traceLog: string): void => {
  const gitBin = resolveHostTool("git")
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
printf 'git %s\\n' "$*" >> "${traceLog}"
printf '%s\\n' "$*" >> "${gitLog}"
exec "${gitBin}" "$@"
`,
  )
  chmodExec(join(bin, "git"))
}

/**
 * `bash`, so that BOTH drives run the SAME interpreter, which is blocker B19.
 *
 * Drive A passes this absolute path as spawnSync's argv[0], and every
 * `#!/usr/bin/env bash` shebang in the engine and in the stubs resolves
 * through the fixture PATH to this shim, which execs the same absolute path.
 * The pin matters concretely: bash 3.2 (macOS) and bash 5.x (Linux runner)
 * differ in `[[ ]]` regex handling, in `${var,,}` support - a bash-4 feature
 * whose absence makes bash 3.2 print "bad substitution" and then EXIT 0 - and
 * in arithmetic-error handling, all of which this engine and its stubs
 * exercise.
 *
 * It deliberately does NOT append to trace.log: `bash` is not one of the seven
 * traced stubs, and tracing an interpreter that every other stub runs under
 * would drown the ordering signal trace.log exists to carry.
 */
const writeBashShim = (bin: string): string => {
  const bashBin = resolveHostTool("bash")
  writeFileSync(join(bin, "bash"), `#!/bin/sh\nexec "${bashBin}" "$@"\n`)
  chmodExec(join(bin, "bash"))
  return bashBin
}

/**
 * A `sleep` that logs and FAILS, installed only for the settle row that needs
 * restart.ts's `:1283` sleep-failed warn.
 *
 * It is opt-in because it intercepts every `sleep` bash makes while on PATH -
 * the readiness poll (:1122) and the start-limit retry (:1353) included. The
 * one scenario that installs it is a HAPPY path whose readiness succeeds on
 * its first poll, so the settle is the only caller and a failing stub cannot
 * spin the readiness loop.
 *
 * It writes trace.log only, no own log: `sleep` is not one of the seven stubs
 * the artifact list names, and its position relative to the systemctl verbs is
 * the entire point, which is what trace.log records.
 */
const writeFailingSleepStub = (bin: string, traceLog: string): void => {
  writeFileSync(
    join(bin, "sleep"),
    `#!/usr/bin/env bash
printf 'sleep %s\\n' "$*" >> "${traceLog}"
exit 1
`,
  )
  chmodExec(join(bin, "sleep"))
}

/**
 * How the claude re-pin (:1218-1255) is driven.
 *
 * `stub` decides what `command -v claude` answers - the FIRST branch of
 * luna_find_claude_executable (scripts/lib/luna-deploy.sh:113-116) and the
 * whole of the warn-only degrade check. `envPin` decides what
 * luna_repin_claude_executable reads out of ENV_FILE before it detects
 * anything (:188-212):
 *   - "detected": the pin already names the claude stub, which is executable
 *     AND is the same path luna_find_claude_executable would detect, so the
 *     helper writes nothing and stays silent.
 *   - "stale": the pin names a path that does not exist, so the helper emits
 *     `no usable claude binary found after bun install; clearing stale pin: <path>`
 *     on stderr, removes the key, and re-detects.
 *   - "wrong-version": the pin names a DIFFERENT executable (not the stub in
 *     fx.bin), so the helper emits `replacing stale claude pin: <old> -> <new>`
 *     and upserts the freshly-detected binary. Requires `stub: "present"` so
 *     luna_find_claude_executable resolves the stub from PATH.
 * Omitting `envPin` writes no .env at all, which is what every pre-S22d
 * fixture did.
 *
 * The stub's own exit code is deliberately not configurable: nothing in the
 * re-pin path EXECUTES claude, it only resolves and stats it.
 */
export interface ClaudeFixtureOptions {
  readonly stub?: "present" | "absent"
  readonly envPin?: "detected" | "stale" | "wrong-version"
}

/**
 * `claude` traces like every other stub even though nothing in the re-pin path
 * EXECUTES it - the path only resolves and stats it - so claude.log is
 * normally an "absent equals absent" artifact. It logs anyway, because the
 * cheap way to discover that some future code path started executing claude is
 * for the artifact to stop being absent on both drives at once.
 */
const writeClaudeStub = (bin: string, claudeLog: string, traceLog: string): string => {
  const claudeBin = join(bin, "claude")
  writeFileSync(
    claudeBin,
    `#!/usr/bin/env bash
printf 'claude %s\\n' "$*" >> "${traceLog}"
printf '%s\\n' "$*" >> "${claudeLog}"
exit 0
`,
  )
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
  readonly readinessPort: string
  readonly bin: string
  readonly systemctlLog: string
  /** makeStubBin returns these (update-server-fixtures.ts:107-110) and the pre-S22d makeFixture dropped them; the dual-drive diff needs curl.log and bun.log as first-class artifacts (bun.log is what proves `bun install` fired only on a lockfile delta, and carries the seed invocation after it). */
  readonly curlLog: string
  readonly bunLog: string
  /** The SINGLE ordered trace every stub appends to before doing anything else - the only artifact that can prove sequencing ACROSS collaborating subprocesses (blocker B18). Per-stub logs cannot: a binary that ran `bun install` after the restart, or probed readiness before it, diffs clean on every one of them. */
  readonly traceLog: string
  readonly ssLog: string
  readonly gitLog: string
  readonly claudeLog: string
  /** The replacement curl's invocation counter, written only when `readyAfterCalls` is set. */
  readonly curlCalls: string
  /** The absolute host `bash` both drives run, resolved from the AMBIENT PATH and re-exported here so a caller never has to resolve it again. */
  readonly bashBin: string
  /** `--profile`, pinned in `args` below; the journal and lock paths are derived from it. */
  readonly profile: string
  /** `$UPDATE_STATE_DIR/transaction-$PROFILE` (:936). */
  readonly journalPath: string
  /** `$UPDATE_STATE_DIR/lock-$PROFILE` (:935). */
  readonly lockDir: string
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
  /** Answer queue for `systemctl show --property=MainPID`; see writeSystemctlStub. Omitted keeps the shared stub's hardcoded 0 (and therefore the skip branch). */
  readonly mainPid?: ReadonlyArray<string> | undefined
  /** Drives the claude re-pin's three-way outcome; see ClaudeFixtureOptions. */
  readonly claude?: ClaudeFixtureOptions | undefined
  /** Container name for `--incus`; installs the passthrough stub and appends the flag. */
  readonly incus?: string | undefined
  /**
   * Overrides the `--readiness-timeout` / `--readiness-interval` argv pair and
   * NOTHING else. The DEFAULT is byte-identical to what this fixture has always
   * emitted, so the three green PR1 suites see no change (same reasoning as
   * blocker R21: a green suite is not this PR's to perturb).
   *
   * GATE 1 passes `{ timeout: "2", interval: "3" }` on every scenario, which is
   * the pair proven under READINESS DETERMINISM to give EXACTLY ONE poll
   * iteration on both drives whatever the machine. The values travel as
   * STRINGS, matching the raw-spelling rule and matching how they reach both
   * engines' argv.
   */
  readonly readiness?: { readonly timeout: string; readonly interval: string } | undefined
  /** Session-guard determinism knob; see writeSsStub. Defaults to zero sessions, rc 0. */
  readonly ss?: SsFixtureOptions | undefined
  /** The replacement curl answers not-ready until this many invocations have happened; see writeCurlStub change 3. */
  readonly readyAfterCalls?: number | undefined
  /** Installs a `sleep` that logs and exits 1, for the settle row that needs restart.ts's `:1283` warn. See writeFailingSleepStub for why it is opt-in. */
  readonly failingSleep?: boolean | undefined
}

/** The readiness argv pair every pre-S22d fixture hardcoded (was bash-fixtures.ts:415-416). */
const DEFAULT_READINESS = { timeout: "2", interval: "0.3" } as const

/** `--profile`, pinned by every fixture; writeUnit()/journalPath both assume it. */
const FIXTURE_PROFILE = "stable"

export const makeFixture = (opts: FixtureOptions): Fixture => {
  // Split the S22d knobs off the ones makeStubBin already understands, then
  // SPREAD the remainder: under exactOptionalPropertyTypes, re-listing each
  // optional field by hand would pass an explicit `undefined` into a
  // `readonly setupAtTarget?: boolean` slot and fail to compile. The rest
  // object preserves optionality exactly.
  const { lockChanges, mainPid, claude, incus, readiness, ss, readyAfterCalls, failingSleep, ...stubOpts } = opts
  const temp = makeTempDir()
  const { work, prevSha, targetSha } = makeDeployRepo(temp, lockChanges === undefined ? {} : { lockChanges })
  const serviceDir = join(temp, "systemd")
  const updateState = join(temp, "update-state")
  const lunaHome = join(temp, "state")
  const envFile = join(lunaHome, ".env")
  const serviceName = "luna-chat-server.service"
  writeUnit(serviceDir, serviceName)
  const { bin, systemctlLog, curlLog, bunLog } = makeStubBin(temp, { repo: work, prevSha, targetSha, ...stubOpts })

  // --- layered entries -------------------------------------------------------
  // Three of these (systemctl, curl, bun) OVERWRITE what makeStubBin just
  // wrote, and they do so UNCONDITIONALLY: they live in the one file this
  // slice is forbidden to edit and they carry no trace line, which is blocker
  // R11. The rest (ss, git, bash) are new entries. See each writer for why.
  const traceLog = join(temp, "trace.log")
  const ssLog = join(temp, "ss.log")
  const gitLog = join(temp, "git.log")
  const claudeLog = join(temp, "claude.log")
  const curlCalls = join(temp, "curl.calls")

  const mainPidFiles = writeSystemctlStub(temp, bin, systemctlLog, traceLog, opts.isActive, mainPid)
  writeCurlStub(bin, curlLog, traceLog, curlCalls, {
    repo: work,
    prevSha,
    targetSha,
    readyAtTarget: opts.readyAtTarget,
    readyAtPrev: opts.readyAtPrev,
    setupAtTarget: opts.setupAtTarget,
    omitBuildShaAtTarget: opts.omitBuildShaAtTarget,
    omitBuildShaAtPrev: opts.omitBuildShaAtPrev,
    mismatchBuildShaAtPrev: opts.mismatchBuildShaAtPrev,
    readyAfterCalls,
  })
  writeBunStub(bin, bunLog, traceLog)
  writeSsStub(bin, ssLog, traceLog, READINESS_PORT, ss ?? {})
  writeGitShim(bin, gitLog, traceLog)
  const bashBin = writeBashShim(bin)
  if (failingSleep === true) writeFailingSleepStub(bin, traceLog)

  const claudeBin = claude?.stub === "present" ? writeClaudeStub(bin, claudeLog, traceLog) : undefined
  if (claude?.envPin !== undefined) {
    if (claude.envPin === "detected" && claudeBin === undefined) {
      throw new Error("makeFixture: claude.envPin 'detected' requires claude.stub 'present' (the pin must name an executable)")
    }
    if (claude.envPin === "wrong-version" && claudeBin === undefined) {
      throw new Error("makeFixture: claude.envPin 'wrong-version' requires claude.stub 'present' (needs a fresh binary to re-pin to)")
    }
    let pinned: string | undefined
    if (claude.envPin === "detected") {
      pinned = claudeBin
    } else if (claude.envPin === "wrong-version") {
      // A DIFFERENT executable: exists and is executable (so the keep-if-executable
      // guard in luna_configure_claude_executable would skip re-detection), but NOT
      // the binary luna_find_claude_executable would detect. luna_repin_claude_executable
      // bypasses that guard and replaces it with the freshly-detected binary.
      const wrongVersionBin = join(temp, "wrong-version-claude")
      writeFileSync(wrongVersionBin, "#!/bin/sh\nexit 0\n")
      chmodExec(wrongVersionBin)
      pinned = wrongVersionBin
    } else {
      pinned = join(temp, "stale-claude")
    }
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
    writeIncusStub(bin, incusLog, traceLog, [
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
    traceLog,
    ssLog,
    gitLog,
    claudeLog,
    curlCalls,
    bashBin,
    profile: FIXTURE_PROFILE,
    journalPath: join(updateState, `transaction-${FIXTURE_PROFILE}`),
    lockDir: join(updateState, `lock-${FIXTURE_PROFILE}`),
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
      "--profile", FIXTURE_PROFILE,
      "--repo-dir", work,
      "--ref", "origin/master",
      "--luna-home", lunaHome,
      "--service-dir", serviceDir,
      "--readiness-timeout", (readiness ?? DEFAULT_READINESS).timeout,
      "--readiness-interval", (readiness ?? DEFAULT_READINESS).interval,
      "--readiness-port", READINESS_PORT,
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
  readonly readinessPort: string
  readonly bin: string
  readonly systemctlLog: string
  readonly curlLog: string
  readonly bunLog: string
  readonly traceLog: string
  readonly ssLog: string
  readonly gitLog: string
  readonly bashBin: string
  /** Present only when the `incus` option named a container. */
  readonly incusLog?: string | undefined
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
    /** Session-guard determinism knob; see writeSsStub. */
    readonly ss?: SsFixtureOptions | undefined
    /** Installs the `incus` passthrough. The light fixture has no repo, so the path map is empty: the only caller that needs this drives the probe argv directly and cares about the WRAPPER-then-payload trace shape, not about container path rewriting. */
    readonly incus?: string | undefined
  },
): LightFixture => {
  const { mainPid, ss, incus, ...stubOpts } = opts
  const temp = makeTempDir()
  const serviceName = "luna-chat-server.service"
  const { bin, systemctlLog, curlLog, bunLog } = makeStubBin(temp, {
    repo: join(temp, "unused-repo"),
    prevSha: "unused-prev-sha",
    targetSha: "unused-target-sha",
    ...stubOpts,
  })
  // Same unconditional layering as makeFixture, for the same blocker-R11
  // reason: `ss` in particular is what lets driveEnv omit LUNA_TEST_WS_COUNT.
  const traceLog = join(temp, "trace.log")
  const ssLog = join(temp, "ss.log")
  const gitLog = join(temp, "git.log")
  const curlCalls = join(temp, "curl.calls")
  const mainPidFiles = writeSystemctlStub(temp, bin, systemctlLog, traceLog, opts.isActive, mainPid)
  writeCurlStub(bin, curlLog, traceLog, curlCalls, {
    repo: join(temp, "unused-repo"),
    prevSha: "unused-prev-sha",
    targetSha: "unused-target-sha",
    readyAtTarget: opts.readyAtTarget,
    readyAtPrev: opts.readyAtPrev,
  })
  writeBunStub(bin, bunLog, traceLog)
  writeSsStub(bin, ssLog, traceLog, READINESS_PORT, ss ?? {})
  writeGitShim(bin, gitLog, traceLog)
  const bashBin = writeBashShim(bin)
  const incusLog = incus === undefined ? undefined : join(temp, "incus.log")
  if (incusLog !== undefined) writeIncusStub(bin, incusLog, traceLog, [])
  return {
    temp,
    serviceName,
    readinessPort: READINESS_PORT,
    bin,
    systemctlLog,
    curlLog,
    bunLog,
    traceLog,
    ssLog,
    gitLog,
    bashBin,
    incusLog,
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

// --- the drive definitions ----------------------------------------------------

/**
 * `runUpdate` under the name test files that ALSO import `run-update.ts`'s
 * `runUpdate` must use, which is concern 19. The legacy helper keeps its old
 * name because three green PR1 suites drive it across 23 call sites and
 * renaming them would be a cosmetic edit to code this PR has no business
 * touching.
 *
 * NOTE that this is NOT Drive A. It spreads `process.env` and pins
 * `LUNA_TEST_WS_COUNT=0`, which is exactly the asymmetry `driveEnv` exists to
 * remove. Drive A is `runBashDrive`, below.
 */
export const runBashUpdate = runUpdate

/**
 * ONE environment map, both drives, and it does NOT spread `process.env`.
 *
 * That spread was the source of the asymmetry the audit found (concern 18,
 * blocker B19): the legacy helper above spreads the whole ambient environment
 * into the bash drive while the binary drive was specified as an explicit
 * override, and `scripts/luna-update-server:43` exports
 * `HOME="${HOME:-/root}"`, which `luna_find_bun`'s `$HOME/.bun/bin/bun`
 * fallback (scripts/lib/luna-deploy.sh:450-454) then reads. Two drives reading
 * a different HOME is not a parity harness.
 *
 * The keys are fixed; the VALUES are per-fixture because each drive owns its
 * own root, which is the whole point of the pair. Nothing is drive-specific:
 * `LUNA_DEPLOY_BASH_ENGINE` is set on both even though bash ignores it, so the
 * two maps are literally identical in shape and no future reader has to reason
 * about which key belongs to whom.
 *
 * It MKDIRS `<root>/home` before returning (concern 21): `luna_find_bun`'s
 * fallback and git's config lookup both read it, and a directory that exists
 * on one drive and not the other is exactly the asymmetry this map removes.
 *
 * `LUNA_TEST_WS_COUNT` is ABSENT, and absent from `driveEnv` ONLY (blocker
 * R21). The port has no such seam by design (session-guard.ts:35-39), so
 * pinning the bash side with it would make the two engines take structurally
 * different probe paths. The unconditional `ss` stub is what replaces it; the
 * legacy helper above still sets it, and must, or the three suites it drives
 * fall into `luna_active_ws_count`'s real probe.
 */
export const driveEnv = (
  fixture: Fixture,
  opts: { readonly settleSecs?: string | undefined } = {},
): Record<string, string> => {
  const home = join(fixture.temp, "home")
  mkdirSync(home, { recursive: true })
  return {
    PATH: `${fixture.bin}:/usr/bin:/bin`,
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    LUNA_RESTART_SETTLE_SECS: opts.settleSecs ?? "0",
    LUNA_TEST_BUN_PATH: join(fixture.bin, "bun"),
    LUNA_UPDATE_STATE_DIR: fixture.updateState,
    LUNA_DEPLOY_BASH_ENGINE: join(repoRoot, "scripts/luna-update-server"),
  }
}

/**
 * Drive A, the oracle: the real bash engine, run under the SAME interpreter
 * the fixture's shims exec (blocker B19), in the SAME env map as Drive B.
 */
export const runBashDrive = (
  fixture: Fixture,
  opts: { readonly settleSecs?: string | undefined } = {},
): RunResult => {
  const bash = resolveHostTool("bash")
  const r = spawnSync(bash, [join(repoRoot, "scripts/luna-update-server"), ...fixture.args], {
    cwd: repoRoot,
    env: driveEnv(fixture, opts),
    encoding: "utf8",
  })
  return okOrThrow(r, "Drive A (bash oracle)", bash)
}

/**
 * Drive B, the binary as its OWN OS process - never `runUpdate` in-process and
 * never `delegateToBashSync`, because spawning it is the only way `wiring.ts`,
 * `run-update.ts` and `update-command.ts` end up on the diffed path at all.
 *
 * `bun` is resolved from the AMBIENT PATH by `resolveHostTool`, which is
 * blocker B17: the fixture bin dir is first on the drive's own PATH and its
 * `bun` is a stub that logs its argv and exits 0, so resolving the runtime
 * from the fixture env would "run the binary" by running that stub.
 *
 * `exe` puts a DIFFERENT executable in the engine position, for
 * compiled-artifact.test.ts: `bun build --compile`'s output is what
 * scripts/luna-guardian publishes, while every other scenario runs
 * `bun main.ts` for speed. Both spellings are stated here rather than left to
 * the implementer.
 */
export const runBinaryUpdate = (
  fixture: Fixture,
  opts: { readonly settleSecs?: string | undefined; readonly exe?: string | undefined } = {},
): RunResult => {
  const argv =
    opts.exe === undefined
      ? { cmd: resolveHostTool("bun"), args: [join(repoRoot, "apps/deploy-cli/src/main.ts"), "update", ...fixture.args] }
      : { cmd: opts.exe, args: ["update", ...fixture.args] }
  const r = spawnSync(argv.cmd, argv.args, {
    cwd: repoRoot,
    env: driveEnv(fixture, opts),
    encoding: "utf8",
  })
  return okOrThrow(r, opts.exe === undefined ? "Drive B (binary, interpreted)" : "Drive B (COMPILED binary)", argv.cmd)
}

// --- the artifacts ------------------------------------------------------------

/**
 * The ten artifacts GATE 1 compares. `null` means "the file was absent", which
 * is itself a diffed fact: a journal present on one drive and absent on the
 * other is a DISQUALIFYING difference, not a missing capture.
 */
export interface Artifacts {
  /** 1. */
  readonly exitCode: number | null
  /** 2. Where the engine's entire narrative lives, since luna_info writes to stdout. */
  readonly stdout: string
  /** 3. */
  readonly stderr: string
  /** 4. The single shared ordered trace - the ONLY artifact that can prove sequencing ACROSS collaborating subprocesses. */
  readonly trace: string | null
  /** 5. The per-stub logs. */
  readonly systemctl: string | null
  readonly curl: string | null
  readonly bun: string | null
  readonly incus: string | null
  readonly claude: string | null
  readonly ss: string | null
  /** Strict on EVERY scenario, because no readiness poll touches git - true ONLY BECAUSE the replacement curl resolves git by absolute path. */
  readonly git: string | null
  /** 6. The final journal bytes, or the fact of its absence. */
  readonly journal: string | null
  /** 7. Must be ABSENT after every terminal, on both drives. */
  readonly lockDirPresent: boolean
  /** 8. $ENV_FILE bytes AND mode, the latter as `mode & 0o777` rendered octal. */
  readonly envFile: string | null
  readonly envFileMode: string | null
  /** 9. The deploy checkout's final HEAD, which proves the reset postcondition against REAL git rather than a mock. */
  readonly head: string
  /** 10. Every path under the fixture root with its mode, sorted, relative to the root. */
  readonly tree: ReadonlyArray<string>
}

const readIfPresent = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

const modeOf = (path: string): string | null => {
  try {
    return (lstatSync(path).mode & 0o777).toString(8).padStart(3, "0")
  } catch {
    return null
  }
}

/**
 * Every path under `root`, sorted, as `<d|f> <posix-relative-path> <octal
 * mode>`.
 *
 * lstat, never stat, so a symlink is reported as a symlink rather than as
 * whatever it points at; the separator is normalised to `/` so the listing
 * reads the same on any platform this suite runs on. The sort is on the final
 * rendered line, so the ordering cannot depend on readdir order, which is
 * filesystem-dependent and differs between ext4, APFS and tmpfs.
 */
const listTree = (root: string): ReadonlyArray<string> => {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: ReadonlyArray<string>
    try {
      entries = readdirSync(dir).slice().sort()
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      const rel = relative(root, full).split(sep).join("/")
      const mode = (st.mode & 0o777).toString(8).padStart(3, "0")
      out.push(`${st.isDirectory() ? "d" : "f"} ${rel} ${mode}`)
      if (st.isDirectory()) walk(full)
    }
  }
  walk(root)
  return out.slice().sort()
}

/**
 * Read every artifact off one drive AFTER its run has terminated.
 *
 * The final HEAD is read with the ABSOLUTE git, never a PATH-resolved one:
 * the fixture's `git` shim would otherwise append the capture's own read to
 * git.log, i.e. the act of measuring would mutate the artifact being measured.
 */
export const captureArtifacts = (fixture: Fixture, result: RunResult): Artifacts => {
  const gitBin = resolveHostTool("git")
  // Through okOrThrow for the same reason the drives are: a failed spawn here
  // yields an empty HEAD, which reads downstream as a legitimately different
  // checkout and produces a parity failure blaming the port for a fork that
  // never happened. This capture runs once per drive per scenario, so under
  // the same fork pressure that can break a drive it can break here too.
  const head = okOrThrow(
    spawnSync(gitBin, ["-C", fixture.work, "rev-parse", "HEAD"], { encoding: "utf8" }),
    "captureArtifacts HEAD read",
    gitBin,
  )
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    trace: readIfPresent(fixture.traceLog),
    systemctl: readIfPresent(fixture.systemctlLog),
    curl: readIfPresent(fixture.curlLog),
    bun: readIfPresent(fixture.bunLog),
    incus: fixture.incusLog === undefined ? null : readIfPresent(fixture.incusLog),
    claude: readIfPresent(fixture.claudeLog),
    ss: readIfPresent(fixture.ssLog),
    git: readIfPresent(fixture.gitLog),
    journal: readIfPresent(fixture.journalPath),
    lockDirPresent: existsSync(fixture.lockDir),
    envFile: readIfPresent(fixture.envFile),
    envFileMode: modeOf(fixture.envFile),
    head: (head.stdout ?? "").trim(),
    tree: listTree(fixture.temp),
  }
}

/** The fixed tokens the three masking rules substitute in. */
export const MASK_ROOT = "<FIXTURE-ROOT>"
export const MASK_UPDATED_AT = "updated_at=<TS>"
export const MASK_PID = "pid=<PID>"

/**
 * The masking rules, a CLOSED LIST OF EXACTLY THREE.
 *
 *  1. the drive's own fixture root path, wherever it appears;
 *  2. the journal's `updated_at=<digits>` value (write_transaction, :1013);
 *  3. the numeric pid inside a lock owner record (acquire_update_lock, :995).
 *
 * Any FOURTH rule is a DISQUALIFYING weakening of the gate and must be argued
 * in the PR body, not added quietly to make a scenario pass. The poll-collapse
 * in `normalisePollBlocks` is counted separately on purpose, as a
 * NORMALISATION rule with its own justification, so that "we added a rule" is
 * always a question with a yes-or-no answer.
 *
 * Rule 1 masks BOTH spellings of the root. macOS's os.tmpdir() answers
 * `/var/folders/...` while `/var` is a symlink to `/private/var`, so a path
 * that reached the artifact through a realpath-resolving code path (bash's
 * `cd`+`pwd -P`, git's own resolution) is spelled `/private/var/folders/...`
 * and would survive a single-spelling replace. Longest first, so the longer
 * spelling cannot be half-consumed by the shorter one.
 */
export const maskArtifacts = (artifacts: Artifacts, fixture: Fixture): Artifacts => {
  const spellings = new Set<string>([fixture.temp])
  try {
    spellings.add(realpathSync(fixture.temp))
  } catch {
    // The root is gone (a cleanup raced the capture); the one spelling we have is all there is.
  }
  const roots = [...spellings].sort((a, b) => b.length - a.length)
  const mask = (text: string): string => {
    let out = text
    for (const root of roots) out = out.split(root).join(MASK_ROOT)
    out = out.replace(/updated_at=[0-9]+/g, MASK_UPDATED_AT)
    out = out.replace(/pid=[0-9]+/g, MASK_PID)
    return out
  }
  const maskOrNull = (text: string | null): string | null => (text === null ? null : mask(text))
  return {
    exitCode: artifacts.exitCode,
    stdout: mask(artifacts.stdout),
    stderr: mask(artifacts.stderr),
    trace: maskOrNull(artifacts.trace),
    systemctl: maskOrNull(artifacts.systemctl),
    curl: maskOrNull(artifacts.curl),
    bun: maskOrNull(artifacts.bun),
    incus: maskOrNull(artifacts.incus),
    claude: maskOrNull(artifacts.claude),
    ss: maskOrNull(artifacts.ss),
    git: maskOrNull(artifacts.git),
    journal: maskOrNull(artifacts.journal),
    lockDirPresent: artifacts.lockDirPresent,
    envFile: maskOrNull(artifacts.envFile),
    envFileMode: artifacts.envFileMode,
    head: artifacts.head,
    tree: artifacts.tree.map(mask),
  }
}

// --- the readiness-poll normalisation -----------------------------------------

/** The token a collapsed run of identical poll blocks is replaced by. Its own line, so a reader of a normalised log sees the collapse rather than hunting for it. */
export const POLL_REPEATED = "<POLL-REPEATED>"

/**
 * The four probe commands a readiness iteration issues, IN ORDER
 * (readiness_ok, :1074-1122): `sup_is_active` (:1389), `sup_restart_count`
 * (:1408), the /healthz curl (:1082) and the /readyz curl (:1087). Any SUFFIX
 * of the last three may be absent, because the iteration returns or falls
 * through as soon as one answer disqualifies the deploy.
 */
type ProbeKind = "is-active" | "nrestarts" | "healthz" | "readyz"
const PROBE_ORDER: ReadonlyArray<ProbeKind> = ["is-active", "nrestarts", "healthz", "readyz"]

/**
 * Classify ONE payload argv.
 *
 * Matching is on the PAYLOAD, with the tool name optional, so that ONE
 * definition serves four differently-shaped logs rather than four definitions
 * drifting apart: trace.log lines are `<name> <argv>`, while each per-stub log
 * records only its own `"$*"`, i.e. systemctl.log says `is-active <unit>` with
 * no `systemctl` in front of it and curl.log says `-fsS -o /dev/null ...`.
 *
 * The `--user` tolerance is `_systemctl_user_flag` (:1389, :1408), which the
 * engine interpolates unquoted precisely so it can be absent.
 */
const classifyPayload = (tokens: ReadonlyArray<string>): ProbeKind | null => {
  let t = tokens
  if (t[0] === "systemctl" || t[0] === "curl") t = t.slice(1)
  if (t[0] === "--user") t = t.slice(1)
  if (t.length === 0) return null
  if (t[0] === "is-active" && t.length === 2) return "is-active"
  if (t[0] === "show" && t.includes("--property=NRestarts") && t.includes("--value")) return "nrestarts"
  // A curl probe is recognised by its URL, but only when the line also LOOKS
  // like curl (its first token is an option), so a hypothetical future stub
  // that merely mentions a /healthz path in an argument cannot be mistaken for
  // a poll entry and silently collapsed.
  if (t[0] !== undefined && t[0].startsWith("-")) {
    if (t.some((x) => x.includes("/healthz"))) return "healthz"
    if (t.some((x) => x.includes("/readyz"))) return "readyz"
  }
  return null
}

interface Entry {
  readonly line: string
  readonly kind: ProbeKind | null
  /** True when this line is the `incus exec <container> -- <payload>` WRAPPER rather than the payload itself. */
  readonly wrapper: boolean
}

/**
 * Split one log line into {is it a probe, is it the incus wrapper of one}.
 *
 * THE INCUS TOPOLOGY IS WHY THIS IS NOT A NAIVE FOUR-LINE MATCH.
 * `scripts/luna-update-server:1387-1389` routes `sup_is_active` through
 * `run_target_capture`, which (:361-369) wraps every probe as
 * `incus exec <container> -- <argv>`; the fixture's `incus` stub logs the raw
 * argv and then re-execs the payload, which logs itself. So on that topology
 * each probe yields an `incus exec ... -- <cmd>` entry IMMEDIATELY followed by
 * the `<cmd>` entry. Matching on the payload argv is what lets one definition
 * cover both topologies.
 */
const parseEntry = (line: string): Entry => {
  const tokens = line.split(/\s+/).filter((x) => x !== "")
  const t = tokens[0] === "incus" ? tokens.slice(1) : tokens
  if (t[0] === "exec") {
    const sep2 = t.indexOf("--")
    if (sep2 >= 0) {
      const kind = classifyPayload(t.slice(sep2 + 1))
      if (kind !== null) return { line, kind, wrapper: true }
    }
    return { line, kind: null, wrapper: false }
  }
  return { line, kind: classifyPayload(t), wrapper: false }
}

/**
 * Consume ONE poll block starting at `start`, or return null.
 *
 * A block is a maximal contiguous run of probe entries whose kinds STRICTLY
 * ASCEND through PROBE_ORDER, where on the incus topology each entry may be
 * immediately preceded by its own `incus exec` wrapper of the same kind.
 * Nothing else is collapsible: a run containing any command outside that set
 * is left alone entirely, which falls out of this parse stopping the moment it
 * meets an unclassifiable entry.
 *
 * STRICTLY ASCENDING rather than "a prefix of PROBE_ORDER starting at
 * is-active", and the difference is load-bearing rather than pedantic. The
 * rule applies to FOUR logs and only two of them contain the systemctl probes
 * at all: `curl.log` records the flow's curl argv and NOTHING else, so its
 * poll run is `healthz, readyz` repeated, with the `is-active, nrestarts`
 * prefix simply not present in the file. A prefix-anchored definition would
 * never collapse curl.log - which is one of the four logs the rule names -
 * and the exhaustion scenario would be compared strictly against a log whose
 * length is a function of subprocess latency. Ascending-subsequence is the
 * generalisation that makes ONE definition cover trace.log (all four kinds,
 * interleaved), systemctl.log (the first two), curl.log (the last two) and
 * incus.log (all four, each wrapped), which is what the spec asks for when it
 * says matching is on the payload argv so one definition serves both
 * topologies. The "any suffix of the last three may be absent" clause falls
 * out of the same rule, since an iteration that returns early simply stops
 * ascending.
 */
const takeBlock = (entries: ReadonlyArray<Entry>, start: number): { readonly end: number } | null => {
  let i = start
  let lastRank = -1
  while (i < entries.length) {
    const e = entries[i]
    if (e === undefined || e.kind === null) break
    const rank = PROBE_ORDER.indexOf(e.kind)
    if (rank <= lastRank) break
    if (e.wrapper) {
      const payload = entries[i + 1]
      // A wrapper whose payload entry is missing (incus.log, which records only
      // the wrappers, or a truncated trace) is still a legitimate probe entry:
      // consume it alone rather than refusing the whole block.
      i = payload !== undefined && !payload.wrapper && payload.kind === e.kind ? i + 2 : i + 1
    } else {
      i += 1
    }
    lastRank = rank
  }
  if (lastRank < 0) return null
  return { end: i }
}

/**
 * THE NORMALISATION RULE, and it is not masking.
 *
 * A maximal run of two or more consecutive repetitions of an IDENTICAL
 * readiness-poll block is replaced by ONE copy of the block followed by the
 * fixed token POLL_REPEATED. It applies to `trace.log`, `systemctl.log`,
 * `curl.log` and (on the incus topology) `incus.log`, and ONLY on the
 * retry-to-exhaustion scenario, whose iteration count genuinely cannot be
 * pinned: `readiness_ok` polls against a WALL CLOCK (:1071 deadline, :1074
 * loop, :1122 sleep), so the count is `ceil(window / (interval + per-iteration
 * cost))` with an integral-SECONDS window and a machine-dependent cost.
 * Measured, bash against bash, same fixture, four runs: curl.log 6/7/7/7 lines
 * and systemctl.log 20/22/22/22. Byte-diffing that is invalid by construction.
 *
 * The repeat COUNT is deliberately NOT compared, because the count is
 * precisely the non-deterministic dimension.
 *
 * The difference between this and masking, stated once so nobody has to
 * relitigate it: normalisation collapses a dimension whose behaviour is
 * asserted somewhere else, whereas masking hides a difference that nothing
 * else checks. The retry behaviour is asserted in three places, none of which
 * relies on the collapse - gate1-parity.test.ts's retry-to-SUCCESS row, which
 * drives `readyAfterCalls: 3` and asserts exactly three `/healthz` entries in
 * EACH drive's own curl.log under a STRICT diff (that row needs no
 * normalisation, because the fixture's curl counts its own invocations rather
 * than a clock); the exhaustion scenario's own per-drive pre-collapse "at least
 * two blocks" assertion; and readiness.ts's PR1 unit suite against an injected
 * clock. IF ANY OF THOSE THREE IS DELETED, THIS RULE BECOMES MASKING AND MUST
 * BE DELETED WITH IT.
 */
export const normalisePollBlocks = (log: string): string => {
  if (log === "") return log
  const trailingNewline = log.endsWith("\n")
  const lines = (trailingNewline ? log.slice(0, -1) : log).split("\n")
  const entries = lines.map(parseEntry)
  const out: string[] = []
  let i = 0
  while (i < entries.length) {
    const first = takeBlock(entries, i)
    if (first === null) {
      const e = entries[i]
      if (e !== undefined) out.push(e.line)
      i += 1
      continue
    }
    const blockLines = lines.slice(i, first.end)
    const blockText = blockLines.join("\n")
    let cursor = first.end
    let repeats = 1
    for (;;) {
      const next = takeBlock(entries, cursor)
      if (next === null) break
      if (lines.slice(cursor, next.end).join("\n") !== blockText) break
      repeats += 1
      cursor = next.end
    }
    out.push(...blockLines)
    if (repeats >= 2) out.push(POLL_REPEATED)
    i = cursor
  }
  return trailingNewline ? `${out.join("\n")}\n` : out.join("\n")
}
