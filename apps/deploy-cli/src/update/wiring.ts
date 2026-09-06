/**
 * The composition root: the ONE file under src/update/ that is allowed to
 * touch real IO, and the only place a PR1 primitive's options record is built.
 *
 * WHY A SEPARATE FILE AT ALL. Every module this slice assembles was written to
 * be driven by injected seams, and each one of them independently documented
 * the same missing collaborator: "the caller decides whether this runs on the
 * host or inside a container" (readiness.ts:43-47), "production wiring is a
 * future slice's concern" (restart.ts:181-191), "a guard used standalone with
 * a container target falls back to a HOST is-active read" (session-guard.ts:
 * 137-148). This file IS that caller. Keeping it separate from update-flow.ts
 * is what lets update-flow.ts stay a literal transcript of the bash tail with
 * no `spawnSync` anywhere in its import graph, and what lets every parity
 * suite inject AROUND this module rather than through it.
 *
 * NO MODULE DEFAULT FOR ANY IO SEAM, EVER. Several PR1 options types carry
 * optional seams that DEFAULT to real IO - preflight's `dirExists`/
 * `fileExists`/`containerFileExists`/`gitCurrentBranch`, session-guard's
 * `queryActiveWsCount`/`readUnitState`, lock's `processAlive`/
 * `processFingerprint`/`pid`, target's `spawn`/`writeStdout`, restart's
 * `sleepSync`, delegate's `runEngine`/`isExecutableFile`. Every single one is
 * filled EXPLICITLY here from `UpdateIo`. An omitted field is not a smaller
 * record, it is a live `spawnSync("systemctl", ["stop", ...])` reachable from
 * an in-process unit test on a host that is itself a deployment target, which
 * is the exact shape `no-ambient-io.test.ts` exists to make impossible.
 *
 * NEWLINE OWNERSHIP IS DECIDED HERE, ONCE. `RealSeams.writeStdout` and
 * `RealSeams.writeStderr` are RAW: they write their argument verbatim and
 * append nothing. `info` and `warn` are the two adapters that add
 * `scripts/lib/luna-deploy.sh:4-5`'s prefixes AND the terminator. Three
 * consumers want three different shapes and mixing them up is a byte diff:
 *
 *   - preflight's `print` (preflight.ts:172-173) takes "one fully-formed
 *     stdout line, newline excluded" and applies `-> ` to the banner's FIRST
 *     line ITSELF (preflight.ts:120), so it must be the RAW writer plus a
 *     newline. Handing it `info` double-prefixes four stdout lines and fails
 *     the very first bytes of the parity diff.
 *   - delegate's `writeStderr` (delegate.ts:245-246) takes "a line, WITHOUT
 *     its newline", so it gets the line-terminating adapter. Handing it the
 *     raw writer leaves the `DELEGATED to bash engine: <flag>` marker
 *     unterminated and glued to whatever the bash engine prints next.
 *   - update-flow's `writeStderrRaw` and apply-inplace's `writeStdout`/
 *     `writeStderr` forward bytes another program already terminated, so they
 *     get the raw writer unchanged.
 *
 * THE THREE-WAY REPO-DIR MAPPING (scripts/luna-update-server:302-341).
 * `hostRepoDir` for every git call, `containerRepoDir` for bun/systemctl/the
 * node_modules test, and `repoDir` VERBATIM for the host claude re-pin
 * (:1245). The first two genuinely differ on an incus target and swapping
 * them silently deploys into the wrong filesystem. The third cannot differ on
 * the inplace layout at all (:318-320 sets all three to the same string on a
 * bare host, which is the only arm that reads `repoDir`), so it earns no gate
 * credit here; it is passed correctly anyway so that a future slice folding in
 * the releases layout inherits correct wiring rather than a coincidence. See
 * apply-inplace.ts's own header for the full derivation.
 *
 * BASH'S GLOBALS ARE MODELLED AS BASH'S GLOBALS. `PREV`, `REF` and
 * `PREV_LOCK_HASH` are shell globals that `write_transaction` interpolates at
 * four call sites and that `apply_ref_inplace`'s own checkout write reads
 * (:1195). update-flow.ts passes the pair it is currently working on into
 * `applyRef`/`rollback`/`failForward`, but the journal writes those seams
 * perform need all three, so this file keeps one mutable cell updated at
 * EXACTLY bash's own two assignment points - the journal load (:1928-1931) and
 * the fresh-run prologue (:1964-1966, :1993) - plus every `write_transaction`,
 * which re-asserts the same values. That is the same state bash has, held in
 * the same place bash holds it, rather than a cache with an independent
 * lifetime.
 */
import {
  type ConfigureClaudeRequest,
  type ConfigureClaudeResult,
  type EnvValueResult,
  type BashLib,
  type BashRunner,
} from "./bash-lib.js"
import { applyInplaceSync, lockfileHashSync } from "./apply-inplace.js"
import { bunRunArgv } from "./commands.js"
import type { UpdateConfig } from "./config.js"
import type { EngineRunResult } from "./delegate.js"
import { seedFailedLine, seedOkLine, seedStartLine } from "./flow-lines.js"
import { freshRunSync, readHeadSync } from "./fresh-run.js"
import {
  CorruptJournalError,
  clearTransactionSync,
  loadTransactionSync,
  writeTransactionSync,
  type Transaction,
  type TxPhase,
} from "./journal.js"
import type { ResolvedNumbers } from "./numbers.js"
import {
  makeReadinessProbes,
  makeRunSystemctl,
  restartOutcomeRc,
  supMainPidSync,
  supRestartCountSync,
} from "./probes.js"
import {
  readinessGaveUpLine,
  readinessOkSync,
  readinessRestartBaseline,
  type ReadinessResult,
} from "./readiness.js"
import { restartServiceSync, type RestartOutcome } from "./restart.js"
import {
  doRollbackSync,
  failForwardSync,
  type FailForwardOptions,
  type FailForwardOutcome,
  type RollbackOptions,
  type RollbackOutcome,
  type RollbackReadinessRequest,
} from "./rollback.js"
import {
  guardVerdictLine,
  restartSessionGuardSync,
  stripTrailingNewlines,
  type GuardVerdict,
} from "./session-guard.js"
import {
  gitTargetCaptureSync,
  gitTargetSync,
  runTargetCaptureSync,
  runTargetSync,
  type CommandResult,
  type SpawnTarget,
  type TargetContext,
} from "./target.js"
import type { UpdateFlowDeps } from "./update-flow.js"

/**
 * Every real-IO boundary a run can reach, in ONE record.
 *
 * The audit that produced this type found the general problem: not one PR1
 * spawn site honours an injected environment, because every one of them
 * resolves argv[0] and PATH from the process's own environment
 * (target.ts:278, probes.ts:310, session-guard.ts's ss/incus/systemctl
 * probes, lock.ts's `ps`, bash-lib.ts:151). An in-process `runUpdate` test
 * that reached any of them would run REAL host binaries, and on a self-hosted
 * runner that is itself a deployment host one of those binaries is
 * `systemctl stop <unit>`.
 *
 * So the boundaries are not defaulted, they are ENUMERATED, and the only
 * production implementation lives in src/update-command.ts - outside this
 * directory, because its whole contract is a `process.env` identity check and
 * this directory is the one that must contain no ambient-environment read at
 * all. The TYPE stays here, where every consumer of it already is; types read
 * nothing.
 */
export interface UpdateIo {
  /** target.ts's execution waist (target.ts:125): every non-git and every git subprocess. */
  readonly spawnTarget: SpawnTarget
  /** bash-lib.ts's runner (bash-lib.ts:121): the four delegated shell-library functions. */
  readonly runBash: BashRunner
  /** delegate.ts's engine spawn (delegate.ts:248). */
  readonly runEngine: (path: string, args: ReadonlyArray<string>) => EngineRunResult
  /** session-guard.ts's ss(8) probe (session-guard.ts:156). Port is the RAW string, never a number. */
  readonly queryActiveWsCount: (port: string, incusContainer?: string) => number
  /** `sleep "$READINESS_INTERVAL"` (:1122), as seconds. Overrides probes.ts's spawning default. */
  readonly sleepSecs: (secs: number) => void
  /** `sleep "$RESTART_SETTLE_SECS"` (:1282), as the RAW string restart.ts validates. */
  readonly settleSleep: (secs: string) => { readonly ok: boolean }
  /** lock.ts's liveness probe (lock.ts:246). */
  readonly processAlive: (pid: number) => boolean
  /** lock.ts's ownership fingerprint (lock.ts:248). */
  readonly processFingerprint: (pid: number) => string
  /** bash's `$$` (lock.ts:321). */
  readonly pid: () => number
  /**
   * bash's `$UID`, as a number. NOT in the original audit's list, and added
   * for one reason: `PreflightBannerContext.uid` (preflight.ts:100) and
   * `RemediationContext.uid` (rollback.ts:78) are both REQUIRED fields, both
   * fed by bash's `$UID`, and both only ever reachable on the launchd arms
   * this binary delegates whole. Reading it off `process` inside this
   * directory would be exactly the ambient read the rest of this type exists
   * to remove, and inventing a constant would put a wrong number in an
   * operator's remediation hint the day the launchd arm stops being
   * delegated. It is a process boundary, so it lives with the other process
   * boundaries.
   */
  readonly uid: () => number
  /** Monotonic seconds, standing in for bash's `SECONDS` (:1071). */
  readonly now: () => number
  /** `[[ -d <path> ]]`. */
  readonly dirExists: (path: string) => boolean
  /** `[[ -f <path> ]]`. */
  readonly fileExists: (path: string) => boolean
  /** `[[ -x <path> ]]`. */
  readonly isExecutable: (path: string) => boolean
  /** `[[ -r "$f" && -f "$f" ]]`, resolveBashLib's REQUIRED seam (bash-lib.ts:169-175). */
  readonly isReadableFile: (path: string) => boolean
  /** `incus exec <c> -- test -f <path>` (:485), a CONTAINER-filesystem question. */
  readonly containerFileExists: (container: string, path: string) => boolean
  /** `git -C <dir> rev-parse --abbrev-ref HEAD || true` (:513). */
  readonly gitCurrentBranch: (hostRepoDir: string) => string
  /**
   * `command -v <name>` (:281, :1250) as a PATH WALK, never a spawn: `command`
   * is a shell builtin and `spawnSync("command", ...)` fails with ENOENT on
   * every platform. `makeCommandExists` below is the one implementation;
   * production and tests both build the seam from it.
   */
  readonly commandExists: (name: string) => boolean
}

/**
 * The process boundary as a value: the environment, the two raw output
 * streams, and every IO seam. `realSeams()` in src/update-command.ts is the
 * only production constructor, and it is the only function in the tree that
 * reads `process.env` or writes to `process.stdout` directly.
 */
export interface RealSeams {
  readonly env: Readonly<Record<string, string | undefined>>
  /** RAW. Receives text VERBATIM, including any newline; nothing here appends one. */
  readonly writeStdout: (text: string) => void
  /** RAW. Same contract as writeStdout. */
  readonly writeStderr: (text: string) => void
  /** REQUIRED, never optional: see this module's header on module defaults. */
  readonly io: UpdateIo
}

/**
 * `command -v <name>` as a PATH walk over an INJECTED environment.
 *
 * Split out and exported because two callers need the identical behaviour and
 * one of them lives outside this directory: `realUpdateIo` builds
 * `UpdateIo.commandExists` from it against `process.env`, and everything in
 * this slice then reads that one seam. Duplicating the walk would give the
 * launchctl probe (:281) and the claude probe (:1250) two different notions of
 * "on PATH".
 *
 * THE ONE BEHAVIOUR IT CANNOT REPRODUCE is bash's `command -v` also matching a
 * shell function or alias. Neither can exist in the non-interactive engine
 * context this runs in, so the gap is stated rather than papered over.
 *
 * The delimiter is `pathDelimiter` rather than a hardcoded `:` so the walk is
 * correct on every platform the test suite runs on; the caller passes
 * `path.delimiter`.
 */
export const makeCommandExists = (
  env: Readonly<Record<string, string | undefined>>,
  isExecutable: (path: string) => boolean,
  pathDelimiter: string,
  pathSeparator: string,
): ((name: string) => boolean) =>
  (name) => {
    // An absolute or explicitly relative name is not looked up on PATH at all,
    // which is what `command -v ./x` does.
    if (name.includes("/") || name.includes("\\")) return isExecutable(name)
    const raw = env["PATH"]
    if (raw === undefined || raw === "") return false
    for (const dir of raw.split(pathDelimiter)) {
      // An EMPTY PATH element means the current directory in POSIX; bash
      // honours that, so reproducing it costs one branch and removes a
      // difference nobody would look for.
      const base = dir === "" ? "." : dir
      if (isExecutable(`${base}${pathSeparator}${name}`)) return true
    }
    return false
  }

/**
 * `TargetContext` from parsed configuration (target.ts:127-149).
 *
 * `spawn` and `writeStdout` are filled EXPLICITLY: both default to real IO
 * (target.ts:286-288), and the writeStdout default writes to the process's own
 * stdout, which would bypass the seam every parity drive captures through.
 */
export const buildTargetContext = (config: UpdateConfig, seams: RealSeams): TargetContext => ({
  incusContainer: config.incusContainer,
  dryRun: config.dryRun,
  layout: config.layout,
  hostRepoDir: config.hostRepoDir,
  mirrorGit: config.mirrorGit,
  spawn: seams.io.spawnTarget,
  writeStdout: seams.writeStdout,
})

export interface BuildFlowDepsArgs {
  readonly config: UpdateConfig
  readonly numbers: ResolvedNumbers
  readonly bashLib: BashLib
  /** `BUN_BIN` as preflight resolved it (preflight.ts:367-368); never recomputed. */
  readonly bunBin: string
  /** Preflight's RESOLVED `--ref` (preflight.ts:364-368), never the transaction target. */
  readonly requestedRef: string
  readonly seams: RealSeams
}

/**
 * Build everything `runUpdateFlowSync` needs.
 *
 * Nothing here performs IO at construction time: every field is a closure, so
 * building the record is inert and a throw during wiring still unwinds through
 * run-update.ts's `finally` with the lock released.
 */
export const buildFlowDeps = (args: BuildFlowDepsArgs): UpdateFlowDeps => {
  const { config, numbers, bashLib, bunBin, requestedRef, seams } = args
  const io = seams.io

  // --- writers (scripts/lib/luna-deploy.sh:4-5) ------------------------------
  const info = (line: string): void => {
    seams.writeStdout(`-> ${line}\n`)
  }
  const warn = (line: string): void => {
    seams.writeStderr(`warning: ${line}\n`)
  }

  // --- the execution waist (target.ts) ---------------------------------------
  const target = buildTargetContext(config, seams)
  const gitTarget = (gitArgs: ReadonlyArray<string>): CommandResult => gitTargetSync(target, gitArgs)
  const gitTargetCapture = (gitArgs: ReadonlyArray<string>): CommandResult =>
    gitTargetCaptureSync(target, gitArgs)
  const runTarget = (argv: ReadonlyArray<string>): CommandResult => runTargetSync(target, argv)
  const runTargetCapture = (argv: ReadonlyArray<string>): CommandResult =>
    runTargetCaptureSync(target, argv)

  /**
   * ONE systemd transport for the restart, the probes and the guard's
   * fallback. `makeRunSystemctl` routes through the same `run_target_capture`
   * waist as everything else, which is the transport half of restart.ts's
   * NON-DECOUPLING contract: the systemd instance the restart acts on is
   * provably the one readiness then interrogates.
   */
  const runSystemctl = makeRunSystemctl({ systemdUser: config.systemdUser, runTargetCapture })

  const systemdProbeOptions = {
    serviceName: config.serviceName,
    systemdUser: config.systemdUser,
    runTargetCapture,
  }

  // --- lockfile_hash (:538-544) ----------------------------------------------
  // Deliberately NOT routed through target.ts's layout-aware git arms: bash's
  // lockfile_hash is a plain host-side `git -C`, and `gitHashObjectArgv`
  // already carries the whole argv including the binary name.
  const lockfileHash = (): string =>
    lockfileHashSync({
      hostRepoDir: config.hostRepoDir,
      fileExists: io.fileExists,
      spawn: (argv) => io.spawnTarget(argv, { capture: true }),
    })

  // --- bash's PREV / REF / PREV_LOCK_HASH globals ----------------------------
  // See this module's header. Updated at bash's own assignment points, and
  // read only by the two journal writes whose seams do not carry all three.
  const tx = { prev: "", target: "", prevLockHash: "" }

  // --- journal (:1013-1044, :2002-2076) --------------------------------------
  const journalPath = config.updateJournal
  const journalExists = (): boolean => io.fileExists(journalPath)

  /**
   * `load_transaction` (:1024-1044) as the flow's TWO-state seam.
   *
   * journal.ts keeps a three-state contract (`undefined` on ENOENT,
   * `CorruptJournalError` otherwise) and is not weakened for its other
   * callers. The flow only ever reaches this behind `journalExists()`, and
   * bash's own `load_transaction` opens with `[[ -r "$UPDATE_JOURNAL" ]] ||
   * return 1` (:1029) - so a journal that vanishes between the `-f` test at
   * :1923 and the load makes BASH print CRITICAL and exit 2 as well. Both
   * shapes therefore map to "corrupt", which is exactly what bash's caller can
   * observe. Anything that is NOT a CorruptJournalError is a programmer error
   * and is rethrown.
   */
  const loadTransaction = (): Transaction | "corrupt" => {
    let loaded: Transaction | undefined
    try {
      loaded = loadTransactionSync(journalPath)
    } catch (err) {
      if (err instanceof CorruptJournalError) return "corrupt"
      throw err
    }
    if (loaded === undefined) return "corrupt"
    // :1928-1931 - the transaction becomes the source of truth for the rest of
    // the run, exactly as bash's four global assignments do.
    tx.prev = loaded.prev
    tx.target = loaded.target
    tx.prevLockHash = loaded.prevLockHash
    return loaded
  }

  const writeTransaction = (
    phase: TxPhase,
    fields: { prev: string; target: string; prevLockHash: string },
  ): void => {
    tx.prev = fields.prev
    tx.target = fields.target
    tx.prevLockHash = fields.prevLockHash
    writeTransactionSync(journalPath, { phase, ...fields })
  }

  const clearTransaction = (): void => {
    clearTransactionSync(journalPath)
  }

  /**
   * `write_transaction <phase>` for the two seams whose callers cannot supply
   * the fields: rollback.ts's one-parameter `writeTransaction` (rollback.ts:
   * 126) and apply-inplace's `onCheckout` (:1195). Both interpolate the same
   * three bash globals, which is what `tx` above holds.
   */
  const writeTransactionPhaseOnly = (phase: TxPhase): void => {
    writeTransactionSync(journalPath, { phase, ...tx })
  }

  // --- the session guard -----------------------------------------------------
  /**
   * `restart_session_guard` at its two STANDALONE call sites (:1948, :1998).
   *
   * BOTH `incusContainer` AND `readUnitState` are filled, which is the fix for
   * the gap session-guard.ts:137-148 documents from its own side: its default
   * is-active fallback is host-scoped even for a container target, while
   * bash's own fallback routes through `run_target_capture` (:365-371) and
   * therefore execs INSIDE the container. Pointing `readUnitState` at the same
   * target-routed runner `makeRunSystemctl` builds makes the guard and the
   * restart read the same systemd in both topologies.
   *
   * `stripTrailingNewlines`, never `.trim()`: bash's `$( )` strips trailing
   * newlines and nothing else, and a `.trim()` here would launder a polluted
   * is-active answer into an exact match and permit a restart bash's own
   * `case` would have deferred.
   */
  const guard = (): GuardVerdict => {
    const verdict = restartSessionGuardSync({
      dryRun: config.dryRun,
      // `GUARD_SESSIONS` is true at both standalone sites; only do_rollback
      // ever lowers it, and it does so around restart_service, not here.
      guardSessions: true,
      supervisor: "systemd",
      operatorOverrideReason: config.operatorOverrideReason,
      serviceName: config.serviceName,
      profile: config.profile,
      maxSessionDefer: config.maxSessionDefer,
      updateStateDir: config.updateStateDir,
      readinessPort: config.readinessPort,
      incusContainer: config.incusContainer,
      queryActiveWsCount: io.queryActiveWsCount,
      readUnitState: (name) => stripTrailingNewlines(runSystemctl(["is-active", name]).stdout ?? ""),
    })
    // The five luna_warn lines bash emits from INSIDE restart_session_guard
    // (:1468, :1477, :1491, :1494, :1497). Emitted here for the two standalone
    // sites; restart.ts emits them for the three that sit inside
    // restart_service. A verdict whose line is null stays silent, matching
    // bash's four bare `return`s.
    const line = guardVerdictLine(verdict, config.readinessPort)
    if (line !== null) warn(line)
    return verdict
  }

  // --- restart / readiness ---------------------------------------------------
  const restart = (guardSessions: boolean): RestartOutcome =>
    restartServiceSync({
      serviceName: config.serviceName,
      dryRun: config.dryRun,
      // The RAW string config.ts holds (config.ts:362), which the three settle
      // lines interpolate exactly as bash interpolates $RESTART_SETTLE_SECS.
      settleSecs: config.restartSettleSecs,
      sleepSync: io.settleSleep,
      guard: {
        guardSessions,
        operatorOverrideReason: config.operatorOverrideReason,
        profile: config.profile,
        maxSessionDefer: config.maxSessionDefer,
        updateStateDir: config.updateStateDir,
        readinessPort: config.readinessPort,
        incusContainer: config.incusContainer,
        queryActiveWsCount: io.queryActiveWsCount,
      },
      runSystemctl,
      mainPid: () => supMainPidSync(systemdProbeOptions),
      info,
      warn,
    })

  const readinessBaseline = (): number =>
    readinessRestartBaseline(() => supRestartCountSync(systemdProbeOptions))

  /**
   * `readiness_ok` (:1069-1130), with BOTH clock seams OVERRIDDEN.
   *
   * `makeReadinessProbes` hardcodes `now: makeMonotonicSeconds()` and `sleep:
   * sleepSecondsSync` (probes.ts:331-332), and the latter spawns a real
   * `sleep` binary (probes.ts:309-311); neither is a seam on that factory. The
   * spread order below is load-bearing - the two overrides must come AFTER the
   * spread - and `no-ambient-io.test.ts` is what proves the override took,
   * because a missed one reaches a real spawn instead of a tagged throw.
   */
  const readiness = (req: {
    expectedBuildSha: string
    allowMissingBuildSha: boolean
    baseline: number
  }): ReadinessResult =>
    readinessOkSync({
      serviceName: config.serviceName,
      readinessPort: config.readinessPort,
      timeoutSecs: numbers.readinessTimeoutSecs,
      intervalSecs: numbers.readinessIntervalSecs,
      expectedBuildSha: req.expectedBuildSha,
      allowMissingBuildSha: req.allowMissingBuildSha,
      baseline: req.baseline,
      ...makeReadinessProbes({
        ...systemdProbeOptions,
        readinessPort: config.readinessPort,
        curlMaxTime: config.readinessCurlMaxTime,
      }),
      now: io.now,
      sleep: io.sleepSecs,
    })

  // --- apply_ref_inplace (:1169-1254) ----------------------------------------
  const applyInplace = (targetRef: string, prevLockHash: string, trackApply: boolean): boolean =>
    applyInplaceSync({
      target: targetRef,
      prevLockHash,
      // Both real call sites pass --no-fetch (:1821, :2020): the flow has
      // already fetched once, before resolving the ref.
      noFetch: true,
      trackApply,
      incusContainer: config.incusContainer,
      bunBin,
      containerRepoDir: config.containerRepoDir,
      envFile: config.envFile,
      // $REPO_DIR verbatim (:1245) - see this module's header.
      repoDir: config.repoDir,
      dryRun: config.dryRun,
      gitTarget,
      gitTargetCapture,
      runTarget,
      lockfileHash,
      /**
       * `write_transaction "checkout" || return 1` (:1195-1196).
       * journal.ts's writer returns void and THROWS on a failed atomic write,
       * so the false arm is that throw caught HERE and nowhere else: every
       * other journal write in this flow is one bash performs unguarded, and
       * swallowing one of those would strand a host mid-transaction.
       */
      onCheckout: () => {
        try {
          writeTransactionPhaseOnly("checkout")
          return true
        } catch {
          return false
        }
      },
      dirExists: io.dirExists,
      configureClaudeExecutable: (req: ConfigureClaudeRequest): ConfigureClaudeResult =>
        bashLib.configureClaudeExecutable(req),
      repinClaudeExecutable: (req: ConfigureClaudeRequest): ConfigureClaudeResult =>
        bashLib.configureClaudeExecutable(req),
      envValue: (envFile: string, key: string): EnvValueResult => bashLib.envValue(envFile, key),
      commandExists: io.commandExists,
      isExecutable: io.isExecutable,
      info,
      warn,
      writeStdout: seams.writeStdout,
      writeStderr: seams.writeStderr,
    }).ok

  // --- post-deploy seed (:413-419, :1710-1725) -------------------------------
  /**
   * `dream_wake_install_script` (:413-419), BOTH halves.
   *
   * The existence probe is HOST-side (`[[ -f "$HOST_REPO_DIR/..." ]]`, no
   * run_target, because the host mount is always reachable - it is the
   * bind-mount source on incus too), while the path it PRINTS is
   * CONTAINER_REPO_DIR-relative, matching every other in-container
   * invocation. Getting the probe side container-relative breaks every incus
   * deploy; getting the printed side host-relative runs the seed against a
   * path that does not exist inside the container.
   */
  const dreamWakeInstallScript = (): string =>
    io.fileExists(`${config.hostRepoDir}/apps/server/scripts/dream-wake-install.ts`)
      ? `${config.containerRepoDir}/apps/server/scripts/dream-wake-install.ts`
      : `${config.containerRepoDir}/apps/ui-web/scripts/dream-wake-install.ts`

  /**
   * `seed_dream_wake_jobs` (:1710-1725), which ALWAYS returns 0 and whose
   * caller additionally guards with `|| true` (:2075). A seed failure warns
   * and nothing more: the deploy has already succeeded and the server is
   * already healthy, so failing here would trip a rollback of a good build.
   *
   * Nothing is caught, and nothing needs to be: target.ts's runner converts a
   * spawn that never started into status 127 (target.ts:282) rather than
   * throwing, so the non-zero arm below is the only failure shape reachable.
   */
  const seedDreamWakeJobs = (): void => {
    const script = dreamWakeInstallScript()
    info(seedStartLine)
    const result = runTarget(bunRunArgv(bunBin, script))
    if (result.status === 0) info(seedOkLine)
    else warn(seedFailedLine(bunBin, script))
  }

  // --- rollback (:1793-1870) -------------------------------------------------
  /**
   * `readiness_ok "$rollback_baseline"` as reached from do_rollback (:1837-
   * 1838), and the fix for the give-up line going missing on that path.
   *
   * Three things, in this order:
   *
   *   1. The baseline is captured AT INVOCATION, because bash captures
   *      `rollback_baseline` at :1837, AFTER the rollback restart. A baseline
   *      baked in when this closure was built would be the pre-restart count
   *      and would read a healthy rollback as a crash loop.
   *   2. The two pinned fields come from rollback.ts, which sets
   *      EXPECTED_BUILD_SHA=$PREV and ALLOW_MISSING_BUILD_SHA=true itself
   *      (:1817-1818) - a rollback target may legitimately predate /readyz's
   *      buildSha field.
   *   3. On a false verdict the give-up warn is emitted HERE, because in bash
   *      it lives INSIDE readiness_ok (:1124) and therefore fires at all three
   *      call sites, while rollback.ts's seam is a bare boolean and its false
   *      branch prints nothing (rollback.ts:179-186). Without this, the exit-2
   *      CRITICAL scenario is a guaranteed stderr diff failure.
   */
  const runRollbackReadiness = (request: RollbackReadinessRequest): boolean => {
    const baseline = readinessBaseline()
    const result = readiness({
      expectedBuildSha: request.expectedBuildSha,
      allowMissingBuildSha: request.allowMissingBuildSha,
      baseline,
    })
    if (!result.ready) warn(readinessGaveUpLine(numbers.readinessTimeoutRaw, result.detail))
    return result.ready
  }

  /**
   * Everything `do_rollback` needs that the flow cannot see.
   *
   * update-flow.ts must NOT construct this record and does not try:
   * `RollbackOptions` wants a `layout` in rollback.ts's OWN vocabulary
   * ("bare" | "releases", rollback.ts:116), a `RemediationContext` (uid,
   * launchdLabel, supervisor scope), and a one-parameter `writeTransaction`
   * the flow's two-parameter journal seam is not assignable to.
   *
   * THE LAYOUT TRANSLATION IS EXPLICIT AND IS ONE LINE. target.ts:76-81 exists
   * specifically to warn that bash's LAYOUT ("inplace" | "releases") and
   * rollback.ts's discriminant ("bare" | "releases") are two different
   * vocabularies for two different questions. This binary only ever reaches
   * this code with `config.layout === "inplace"` (config.ts:271-277 delegates
   * the releases layout whole, before the lock), and an inplace rollback IS a
   * bare-host rollback in rollback.ts's vocabulary - so "bare" is the answer,
   * not a coincidence.
   */
  const rollbackOptions = (a: {
    ref: string
    prev: string
    forwardRestartRan: boolean
  }): RollbackOptions => ({
    supervisor: config.supervisor,
    systemdUser: config.systemdUser,
    uid: String(io.uid()),
    launchdLabel: config.launchdLabel,
    serviceName: config.serviceName,
    ref: a.ref,
    prev: a.prev,
    layout: "bare",
    forwardRestartRan: a.forwardRestartRan,
    // :1820-1821. The lockfile hash is computed FRESH at call time, never the
    // PREV_LOCK_HASH captured before the forward attempt: the forward apply
    // may have installed a different dependency tree, and reusing the stale
    // hash makes the rollback skip a `bun install` it needed. trackApply is
    // false so the rollback's own checkout never overwrites phase=rolling-back.
    applyRef: (prev) => applyInplace(prev, lockfileHash(), false),
    restartService: (guardSessions) => restartOutcomeRc(restart(guardSessions)),
    runReadiness: runRollbackReadiness,
    // rollback.ts types the phase as a bare string; the journal's own union is
    // narrower, and every value rollback.ts passes ("rolling-back",
    // "rollback-failed") is a member of it.
    //
    // THE SWALLOW IS BASH'S `|| true`, NOT A SHORTCUT. All three journal
    // writes reachable through this seam are guarded in bash:
    // `write_transaction "rolling-back" || true` (:1816),
    // `write_transaction "rollback-failed" || true` (:1856) and
    // `write_transaction "forward-failed" || true` (:1865). journal.ts's
    // writer returns void and THROWS on a failed atomic write, so binding it
    // bare here makes a full or read-only state dir escape out of
    // runUpdateFlowSync, past run-update.ts's finally, and die with a stack
    // trace and exit 1 - on the exact path where bash prints
    // `ROLLED BACK to` / the CRITICAL line and exits 1 or 2. Losing the 2
    // there is losing the whole exit-code contract at the worst possible
    // moment: `packages/server-registry/src/driver/luna-chat-server.ts:164`
    // and scripts/luna-autodeploy's rc `case` read that code to decide
    // whether a human is paged for a server that may be DOWN.
    //
    // THE GUARD IS PER-SITE AND THIS SEAM REACHES ONLY GUARDED SITES.
    // `write_transaction "checkout"` is `|| return 1` (:1165, :1196) and is
    // wired separately as `onCheckout` above, which is why that one turns a
    // throw into a FAILED apply rather than swallowing it. The four writes
    // bash performs UNGUARDED - "prepared" (:2002), "applied" (:2043),
    // "restarting" (:2045) and "verifying" (:2071) - go through the
    // two-parameter `writeTransaction` seam above, which deliberately does
    // NOT catch: under `set -euo pipefail` an unguarded failure aborts the
    // bash run, so a throw is the faithful port there.
    writeTransaction: (phase) => {
      try {
        writeTransactionPhaseOnly(phase as TxPhase)
      } catch {
        // `|| true`: bash prints nothing and carries on, so neither does this.
        // Anything written here would be a stdout/stderr byte GATE 1 diffs.
      }
    },
    clearTransaction,
    warn,
    // The CRITICAL line is a bare printf in bash (:1854-1855), not a
    // luna_warn, and it is emitted BEFORE the phase write - so it carries no
    // prefix and rollback.ts owns its ordering.
    writeStderrRaw: seams.writeStderr,
  })

  const failForward = (a: {
    reason: string
    ref: string
    prev: string
    newHead: string | null
    forwardRestartRan: boolean
  }): FailForwardOutcome => {
    const options: FailForwardOptions = {
      ...rollbackOptions({ ref: a.ref, prev: a.prev, forwardRestartRan: a.forwardRestartRan }),
      rollbackEnabled: config.rollback,
      newHead: a.newHead,
    }
    return failForwardSync(a.reason, options)
  }

  const rollback = (a: {
    ref: string
    prev: string
    forwardRestartRan: boolean
  }): RollbackOutcome => doRollbackSync(rollbackOptions(a))

  return {
    restartOnly: config.restartOnly,
    serviceName: config.serviceName,
    requestedRef,
    readinessTimeoutRaw: numbers.readinessTimeoutRaw,

    info,
    warn,
    writeStderrRaw: seams.writeStderr,

    journalExists,
    loadTransaction,
    writeTransaction,
    clearTransaction,
    journalPath,

    guard,
    restart,
    readinessBaseline,
    readiness,

    applyRef: applyInplace,
    readHead: () => readHeadSync(gitTargetCapture),
    freshRun: () => {
      const outcome = freshRunSync({
        hostRepoDir: config.hostRepoDir,
        requestedRef,
        gitTarget,
        gitTargetCapture,
        lockfileHash,
        info,
      })
      if (outcome.ok) {
        // :1964-1966 and :1993 - bash's three assignments, mirrored here so the
        // journal writes below interpolate the same values bash's globals hold.
        tx.prev = outcome.prev
        tx.target = outcome.ref
        tx.prevLockHash = outcome.prevLockHash
      }
      return outcome
    },
    seedDreamWakeJobs,

    failForward,
    rollback,
  }
}
