/**
 * The single in-process entry point for `deploy-cli update`.
 *
 * IT RETURNS A NUMBER AND NEVER CALLS `process.exit`. That is the whole reason
 * this file exists as something other than a citty `run` body: an early
 * process-level exit skips `finally` in Node and in Bun, and this function's
 * `finally` is what releases the update lock. The one `process.exit` in the
 * update surface lives in src/update-command.ts, on the far side of the
 * process boundary, where there is nothing left to unwind.
 *
 * IT IS ALSO THE ORDER. Everything below happens in one fixed sequence and
 * every step of it is a contract somebody can break by moving one line:
 *
 *   1. split the argv into its two shapes (see THE ARGV CONTRACT)
 *   2. resolve the co-pinned bash lib, because config parsing needs it
 *   3. parse and validate the configuration
 *   4. DELEGATE, if this topology is not ours - always before the lock
 *   5. convert the two numeric knobs
 *   6. preflight - still before the lock, still mutating nothing
 *   7. acquire the lock
 *   8. run the transaction inside a try/finally that always releases
 *
 * NO LOCK IS TAKEN BEFORE STEP 7, and `exit-code-matrix.test.ts` asserts the
 * lock directory is absent after every refusal above it. That ordering is what
 * makes a typo in an argv cost nothing, and what stops a delegated run from
 * holding a lock the bash engine it just exec'd will immediately contend for.
 *
 * THE ARGV CONTRACT, which is the first thing to get right here. Two argv
 * shapes exist, they are different, and both are needed:
 *
 *   `rawArgv`  = `process.argv.slice(2)`: the `update` subcommand token AND
 *                everything after it. `delegate.ts:207-215` THROWS unless the
 *                first non-flag token is literally `update`, and
 *                scripts/luna-autodeploy:136 proves the token is always
 *                present on the live path, because `luna_select_engine` prints
 *                `<cli>` and `update` as a two-line argv prefix.
 *   `flagArgv` = the flags AFTER that token. `config.ts:546-547` returns
 *                `unknown option: update` for ANY non-flag token.
 *
 * Feeding one array to both consumers is fatal in one direction or the other,
 * and an earlier revision of this port did exactly that and died with
 * `error: unknown option: update` on every single invocation. `forwardedFlags`
 * is REUSED rather than re-implemented because main.ts's raw-argv preamble
 * performs the same first-non-flag-token scan, and two copies of that scan are
 * two things that can drift.
 *
 * THAT THROW IS NOT CAUGHT, deliberately. A caller that reached this binary
 * without the subcommand token is a wiring bug in `luna_select_engine`, not an
 * operator error, and it must be loud rather than becoming a polite exit code
 * that a deploy driver would read as a real verdict.
 *
 * NO PR1 OPTIONS RECORD BUILT HERE RELIES ON A MODULE DEFAULT for a seam that
 * performs IO - the same rule wiring.ts's header states, restated because all
 * three of this file's own PR1 call sites (`resolveBashLib`,
 * `delegateToBashSync`, `runPreflightSync`) sit outside wiring.ts and each one
 * of them has at least one IO-defaulting optional seam.
 */
import {
  DELEGATION_FLAGS,
  delegateToBashSync,
  forwardedFlags,
  type DelegationFlag,
} from "./delegate.js"
import { lunaDieLine, resolveBashLib } from "./bash-lib.js"
import { delegationFor, parseUpdateConfig, type ConfigSeams } from "./config.js"
import { acquireUpdateLockSync, installLockReleaseHooks } from "./lock.js"
import { runPreflightSync, type PreflightOutcome } from "./preflight.js"
import { resolveNumbers } from "./numbers.js"
import { exitCodeFor } from "./terminals.js"
import { runUpdateFlowSync } from "./update-flow.js"
import { buildFlowDeps, type RealSeams } from "./wiring.js"

/**
 * `scripts/luna-update-server`'s usage text.
 *
 * WHY IT LIVES HERE rather than in src/update-command.ts, which is where this
 * PR's spec otherwise puts everything operator-facing about the command: the
 * `kind: "help"` arm below needs it, and src/update-command.ts imports THIS
 * file. Putting the constant there would make the only remaining edge an
 * import cycle, and the spec's own rule is that nothing under src/update/
 * imports src/update-command.ts. One string, exported, imported by both the
 * command definition and main.ts's preamble.
 *
 * THE `Exit codes:` BLOCK IS VERBATIM, because an operator reads it literally
 * during an incident and because those five numbers are a contract with
 * packages/server-registry/src/driver/luna-chat-server.ts and with
 * scripts/luna-autodeploy's rc `case`. The option list is the same surface
 * config.ts parses; the bash's own `--incus` paragraph names specific hosts,
 * which this public repo does not restate.
 */
export const UPDATE_USAGE = `Usage: deploy-cli update [options]

Updates an installed Luna server to a target git ref. After restarting the
service it runs a bounded readiness probe; if the new version fails to come up
healthy it AUTOMATICALLY ROLLS BACK to the previous commit and restarts again.

Options:
  --profile <name>          Runtime profile -> unit name. Default: stable.
  --repo-dir <path>         Server git clone to update. Default: /root/luna
                            (bare-host). With --incus, the HOST git mount;
                            default derived from --profile.
  --luna-home <path>        Luna state path (holds .env). Default: /root/.luna.
  --ref <git-ref>           Target ref to update to.
                            Default: origin/<current-branch>, or origin/master
                            if the checkout is detached.
  --service-dir <path>      systemd unit directory. Default: /etc/systemd/system.
  --service-name <name>     Override generated unit name.
  --incus <container>       Update an Incus container instead of a bare host.
                            git ops hit the host repo mount; bun install,
                            daemon-reload, restart and the readiness probe run
                            INSIDE the container via \`incus exec\`.
  --readiness-timeout <s>   Overall readiness poll budget. Default: 60.
  --readiness-interval <s>  Seconds between readiness attempts. Default: 2.
  --readiness-port <port>   Port for the /healthz probe. Default: 4753.
  --restart-settle <s>      Seconds to wait between stop and start so the
                            outgoing process releases its DuckDB/SQLite
                            WAL/SHM handles. Default: 6.
  --no-rollback             Do not auto-roll-back on readiness failure.
  --operator-override <reason>
                            HUMAN-ONLY override of the in-primitive session
                            guard. Requires a non-empty reason, which is logged
                            as the audit trail. Automation must never construct
                            this flag.
  --restart-only            Repair rung 1: plain guarded stop -> settle -> start
                            + readiness probe. No checkout mutation, no bun
                            install/build, no rollback. A pending update
                            transaction runs normal recovery instead.
  --layout <inplace|releases>
                            Deploy layout. inplace (default) is owned by this
                            binary; releases is delegated to the bash engine.
  --deploy-root <path>      Releases layout root. Required with --layout releases.
  --releases-keep <n>       Releases retention count (>= 2). Default: 3.
  --materialize             Releases-layout bootstrap. Delegated.
  --dry-run                 Print the plan and change NOTHING. Delegated.
  --supervisor <systemd|launchd>   supervisor backend (default: systemd)
  --user                           use systemd --user scope (systemd only)
  --launchd-label <label>          launchd service label
  --launchd-plist <path>           full path to launchd plist
  -h, --help                Show this help.

Exit codes:
  0  updated and healthy.
  1  preflight error, OR readiness failed but rollback succeeded.
  2  CRITICAL: readiness failed AND rollback also failed (server may be down;
     manual intervention required).
  3  deferred by the session guard (live or unknown sessions); fresh run:
     nothing mutated; mid-transaction: journal retained and resumed when idle;
     apply-phase rollback: checkout already restored to PREV, old server still
     serving, journal retained (phase=rolling-back) and resumed when idle.
  4  --restart-only only: deferred because another update already holds the
     profile lock (repair-rung contention). Distinct from 3 on purpose: no
     session-guard defer happened, and reporting it as one would send the
     on-call responder hunting for phantom live sessions.
`

/**
 * `luna_find_bun` failed.
 *
 * `PreflightSeams.findBun` is a REQUIRED `() => string` with no failure arm
 * (preflight.ts:193-199), while the only production source is
 * `bashLib.findBun`, whose failure arm is `{ ok: false, exitCode, stderr }`
 * (bash-lib.ts:235-237) because bash's `luna_find_bun` dies. The two do not
 * compose, so the adapter throws this and `runUpdate` catches it around the
 * `runPreflightSync` call ONLY. A thrown error rather than a widened signature
 * because that signature is fixed by a shipped module and one caller is not a
 * reason to change it.
 */
class BunUnresolvedError extends Error {
  readonly stderrBytes: string
  readonly exitCode: number

  constructor(stderrBytes: string, exitCode: number) {
    super("luna_find_bun failed")
    this.name = "BunUnresolvedError"
    this.stderrBytes = stderrBytes
    this.exitCode = exitCode
  }
}

/**
 * Narrow `config.ts`'s bare `string` flag (config.ts:234-236) to `delegate.ts`'s
 * CLOSED `DelegationFlag` union (delegate.ts:102-108).
 *
 * The throw is unreachable on every valid input today: `delegationFor` can only
 * ever yield `--dry-run`, `--user`, `--layout releases` and
 * `--supervisor launchd`, and `Layout` is a two-member union. It is kept
 * because it is a TYPE-LEVEL requirement rather than a runtime hope - without
 * it the call below does not compile - and because the marker line it feeds is
 * grepped by an accept gate, so a sixth spelling reaching it would be a run
 * that counts as binary-deployed when it was not.
 */
const asDelegationFlag = (flag: string): DelegationFlag => {
  const found = DELEGATION_FLAGS.find((f) => f === flag)
  if (found === undefined) {
    throw new Error(
      `asDelegationFlag: ${JSON.stringify(flag)} is not one of ${JSON.stringify(DELEGATION_FLAGS)}; ` +
        "delegationFor and DelegationFlag have drifted apart",
    )
  }
  return found
}

/**
 * Run the whole `update` command and return its exit code.
 *
 * `rawArgv` is `process.argv.slice(2)` - the `update` token INCLUDED. See THE
 * ARGV CONTRACT in this module's header.
 */
export const runUpdate = (rawArgv: ReadonlyArray<string>, seams: RealSeams): number => {
  const io = seams.io
  /** delegate.ts:245-246 types its writer as a line WITHOUT its newline. */
  const writeStderrLine = (line: string): void => {
    seams.writeStderr(`${line}\n`)
  }

  // --- 1. the two argv shapes ------------------------------------------------
  const flagArgv = forwardedFlags(rawArgv)

  // --- 2. the co-pinned bash lib (bash-lib.ts) -------------------------------
  // FIRST, because `ConfigSeams.validateProfile` is an INPUT to
  // parseUpdateConfig rather than something it can lazily resolve: the binary
  // can never report a config error faster than it can prove the bash escape
  // hatch exists.
  const resolved = resolveBashLib({
    env: (name) => seams.env[name],
    isReadableFile: io.isReadableFile,
    runBash: io.runBash,
  })
  if (!resolved.ok) {
    writeStderrLine(resolved.errorLine)
    return resolved.exitCode
  }
  const bashLib = resolved.lib

  // --- 3. configuration (config.ts:335-339) ----------------------------------
  const configSeams: ConfigSeams = {
    // `luna_validate_profile` refuses through `luna_die`, so its own stderr
    // bytes already carry the `error: ` prefix and the newline; they are
    // forwarded VERBATIM before the boolean is reported, exactly as bash's
    // failing call would have written them.
    validateProfile: (profile) => {
      const result = bashLib.validateProfile(profile)
      if (!result.ok) seams.writeStderr(result.stderr)
      return result.ok
    },
    // `command -v launchctl` (:281) as the PATH walk, never a spawn of a shell
    // builtin.
    hasLaunchctl: () => io.commandExists("launchctl"),
  }
  const parsed = parseUpdateConfig(flagArgv, seams.env, configSeams)
  if (parsed.kind === "help") {
    // UNREACHABLE in production: main.ts's raw-argv preamble handles
    // `update --help` before citty ever dispatches, because citty's own
    // per-subcommand help goes silent under NODE_ENV=test - the exit-0-no-
    // output shape guardian's publish postcondition exists to catch. Retained
    // as a defensive return rather than deleted, so that a future caller that
    // reaches parseUpdateConfig by another route still prints something.
    seams.writeStdout(UPDATE_USAGE)
    return 0
  }
  if (parsed.kind === "missing-value" || parsed.kind === "error") {
    writeStderrLine(parsed.kind === "error" ? lunaDieLine(parsed.message) : parsed.message)
    // THROUGH `exitCodeFor`, NOT `parsed.exitCode`. terminals.ts declares a
    // `config-refused` arm for exactly this refusal (terminals.ts:70-74) and
    // maps it to 1 in the same table that maps the other twelve; returning
    // config.ts's own number instead left that arm constructed nowhere, so
    // the one test that asserts the whole exit-code contract at once could
    // not see this path and the arm read as dead code. `ParseOutcome` types
    // `exitCode` as the literal 1 for both variants, so this is the same
    // number by a route that keeps the contract in one table.
    return exitCodeFor({ kind: "config-refused" })
  }
  const config = parsed.config

  // --- 4. delegation (config.ts:271-277) -------------------------------------
  // BEFORE the lock, always: the bash engine this hands off to acquires the
  // same profile lock, and holding it here would make every delegated run
  // contend with itself.
  const delegation = delegationFor(config)
  if (delegation !== null) {
    return delegateToBashSync({
      flag: asDelegationFlag(delegation.flag),
      // The RAW form, token included - delegate.ts drops the token itself.
      rawArgs: rawArgv,
      env: seams.env,
      writeStderr: writeStderrLine,
      runEngine: io.runEngine,
      // Optional on DelegateOptions, and its default is a real stat + X_OK
      // probe; omitting it would leave a live filesystem boundary in the one
      // file every in-process test drives.
      isExecutableFile: io.isExecutable,
    }).exitCode
  }

  // --- 5. the two numeric knobs (numbers.ts) ---------------------------------
  const numbers = resolveNumbers(config)
  if (!numbers.ok) {
    writeStderrLine(lunaDieLine(numbers.message))
    return 1
  }

  // --- 6. preflight (:421-530) -----------------------------------------------
  // Every seam bound EXPLICITLY: `dirExists`, `fileExists`,
  // `containerFileExists` and `gitCurrentBranch` all default to real statSync /
  // real `incus exec` / real `git` (preflight.ts:174-192, :235-249).
  const findBun = (): string => {
    const r = bashLib.findBun()
    if (!r.ok) throw new BunUnresolvedError(r.stderr, r.exitCode)
    return r.path
  }
  let preflight: PreflightOutcome
  try {
    preflight = runPreflightSync({
      profile: config.profile,
      incusContainer: config.incusContainer,
      supervisor: config.supervisor,
      systemdUser: config.systemdUser,
      hostRepoDir: config.hostRepoDir,
      containerRepoDir: config.containerRepoDir,
      serviceFile: config.serviceFile,
      launchdLabel: config.launchdLabel,
      launchdPlist: config.launchdPlist,
      uid: String(io.uid()),
      userUnitFile: config.userUnitFile,
      dryRun: config.dryRun,
      materializeOnly: config.materializeOnly,
      ref: config.ref,
      bunBinIncus: config.bunBinIncus,
      // THE RAW WRITER PLUS A NEWLINE, NEVER `info`. preflight.ts:119-147
      // applies `-> ` to the FIRST banner line itself and leaves the other
      // three plus `Target ref:` bare, mirroring bash where :422 is luna_info
      // and :424-440/:521 are bare printfs. Passing an `info` wrapper here
      // double-prefixes four stdout lines and fails the first bytes of the
      // parity diff.
      print: (line) => {
        seams.writeStdout(`${line}\n`)
      },
      dirExists: io.dirExists,
      fileExists: io.fileExists,
      containerFileExists: io.containerFileExists,
      gitCurrentBranch: io.gitCurrentBranch,
      findBun,
    })
  } catch (err) {
    if (!(err instanceof BunUnresolvedError)) throw err
    // `luna_find_bun`'s own `luna_die` line, already carrying its `error: `
    // prefix and its newline: written VERBATIM, with nothing added.
    seams.writeStderr(err.stderrBytes)
    return err.exitCode
  }
  if (!preflight.ok) {
    writeStderrLine(preflight.errorLine)
    return preflight.exitCode
  }
  // 7a. BUN_BIN, carried forward from preflight's success outcome
  // (preflight.ts:367-368) and never recomputed. config.ts's `resolveBunBin`
  // implements the same arm and is deliberately NOT called: two resolvers for
  // one value is exactly the drift this port exists to remove.
  const bunBin = preflight.bunBin
  const requestedRef = preflight.ref

  // --- 7. the lock (:1871-1881) ----------------------------------------------
  const acquired = acquireUpdateLockSync({
    stateDir: config.updateStateDir,
    profile: config.profile,
    pid: io.pid(),
    processAlive: io.processAlive,
    processFingerprint: io.processFingerprint,
    warn: (line) => {
      seams.writeStderr(`warning: ${line}\n`)
    },
  })
  if (!acquired.acquired) {
    // All four acquire failures are `return 1` in bash and take the same exit
    // path; the reason is carried so the terminal - and therefore an operator
    // log - can still tell "somebody else is deploying" from "this host cannot
    // record its own ownership".
    return exitCodeFor(
      acquired.reason === "contended"
        ? { kind: "lock-contention", restartOnly: config.restartOnly }
        : { kind: "lock-unacquirable", restartOnly: config.restartOnly, reason: acquired.reason },
    )
  }

  // --- 8. the transaction ----------------------------------------------------
  // CALLING THE UNINSTALLER IS MANDATORY: installLockReleaseHooks adds two
  // listeners per call and is NOT idempotent (lock.ts:437-454), and
  // exit-code-matrix.test.ts drives many runUpdate calls in one process - so
  // without it Node emits MaxListenersExceededWarning onto the very stderr a
  // parity suite diffs.
  const uninstallHooks = installLockReleaseHooks(acquired.lock)
  try {
    // Built INSIDE the try, and deliberately: it constructs nothing observable,
    // but keeping every construction inside the finally's scope means a throw
    // during wiring still releases the lock.
    const deps = buildFlowDeps({ config, numbers: numbers.value, bashLib, bunBin, requestedRef, seams })
    return exitCodeFor(runUpdateFlowSync(deps))
  } finally {
    uninstallHooks()
    acquired.lock.release()
  }
}
