/**
 * WHOLE-RUN DELEGATION to the co-pinned bash engine, for every topology the
 * binary does not own.
 *
 * The binary owns exactly one transaction shape: LAYOUT=inplace with the
 * systemd supervisor, bare-host or incus. Everything else - `--layout
 * releases` (scripts/luna-update-server:1736 do_rollback_releases and the
 * whole materialize/symlink-flip family), `--supervisor launchd`, `--user`,
 * `--dry-run` and `--materialize` - is handed to $LUNA_DEPLOY_BASH_ENGINE
 * whole, and this module is the hand-off.
 *
 * DELEGATION RATHER THAN REFUSAL, BECAUSE A REFUSAL IS A STOPPED DEPLOY. The
 * gate that selects this binary (luna_select_engine, scripts/luna-autodeploy)
 * is set by an operator or, after S23, by a default; a topology the port has
 * not reached yet must not turn that choice into an outage. The bash engine is
 * still installed, still pinned beside the binary in the same guardian
 * publish (scripts/luna-guardian:1216-1219), and still correct - so run it.
 *
 * WHY IT MUST HAPPEN BEFORE THE LOCK. The delegated child acquires the very
 * same profile lock this binary would (scripts/luna-update-server:950-1008,
 * an atomic mkdir under the shared state dir). Delegating from inside our own
 * lock would deadlock the child against its parent - it would take the stale-
 * takeover path or defer with exit 4 depending on timing, and either way the
 * deploy would be decided by a race rather than by the topology. This module
 * therefore imports NOTHING from lock.ts and is called from update-flow.ts
 * before acquisition; delegate-parity.test.ts asserts the import is absent,
 * because a future edit that quietly adds one would be invisible in behaviour
 * until a real host wedged.
 *
 * ARGV IS FORWARDED BYTE-IDENTICALLY, MINUS EXACTLY ONE TOKEN. This is the
 * single subtlety of the whole module, and it is a real trap:
 *
 *   luna_select_engine emits an argv PREFIX, not a path (scripts/luna-
 *   autodeploy). For bash the prefix is one field - luna-update-server has a
 *   FLAG-ONLY surface. For the binary it is two, `<cli>` then `update`,
 *   because deploy-cli replaces three scripts and citty dispatches on a
 *   subcommand. do_deploy then execs `"${engine_argv[@]}" "${P_UPDATE_ARGS[@]}"`,
 *   so the binary receives `update --profile dev --incus ...` while a bash-only
 *   selection would have produced `--profile dev --incus ...` with no
 *   subcommand at all.
 *
 *   Forwarding our own argv verbatim therefore hands `update` to
 *   luna-update-server's parser, which has no case for it and dies at
 *   `*) luna_die "unknown option: $1"` (scripts/luna-update-server:239) with
 *   exit 1 - a parse error standing in for the deploy the operator asked for,
 *   and one that looks exactly like a preflight refusal in the logs. The
 *   subcommand token is dropped and NOTHING else is: the forwarded argv must
 *   equal, field for field, what `LUNA_DEPLOY_ENGINE` unset would have
 *   produced, which is what delegate-parity.test.ts diffs against the REAL
 *   luna_select_engine.
 *
 *   The token's position is COMPUTED, never hardcoded to `argv[2]`: a compiled
 *   `bun build --compile` artifact and `bun run main.ts` do not agree on
 *   argv[1], so any fixed index is right in one and silently wrong in the
 *   other - and "silently wrong" here means forwarding the profile name as the
 *   subcommand and dropping a real flag.
 *
 * THE MARKER IS AN AUDIT ARTIFACT, NOT A LOG LINE. `DELEGATED to bash engine:
 * <flag>` is emitted exactly once, on stderr, before the child starts. S23's
 * accept gate greps for it to answer a question nothing else can: did the
 * BINARY deploy this host, or did bash deploy it while the binary watched? A
 * delegated run is a successful deploy and a worthless soak sample, and
 * counting one as proof of the other is how a fleet-wide flip ships on
 * evidence that was never collected. It goes to stderr, alongside luna_warn
 * (scripts/lib/luna-deploy.sh:5), so it can never be mistaken for part of the
 * engine's own stdout narrative, which the parity harness diffs byte-exact.
 *
 * Every collaborator is an INJECTED SEAM - the subprocess runner and the
 * executable probe both, the same way restart.ts injects runSystemctl - so the
 * parity suite can drive an exec without a real host while the production
 * default still spawns the real binary with the real stdio.
 */
import { accessSync, constants as fsConstants, statSync } from "node:fs"
import { constants as osConstants } from "node:os"
import { spawnSync } from "node:child_process"

/**
 * The env var carrying the co-pinned bash engine's absolute path. Set as a
 * COMMAND-PREFIX assignment on every engine exec in scripts/luna-autodeploy
 * (`LUNA_DEPLOY_BASH_ENGINE="$pinned_engine" "${engine_argv[@]}" ...`), which
 * is deliberate: a prefix assignment leaves argv byte-identical, and argv
 * being byte-identical is exactly what makes the forwarding above provable.
 *
 * It is also the only way the binary can learn this path. The bash engine is
 * quarantined into /usr/local/lib/luna/deploy-engine@<sha>/ by luna_pin_engine
 * and the binary lives in guardian's own pin - two different directories, so
 * there is nothing to derive it from.
 */
export const BASH_ENGINE_ENV = "LUNA_DEPLOY_BASH_ENGINE"

/** The subcommand token luna_select_engine appends for the binary, and the one token delegation drops. */
export const UPDATE_SUBCOMMAND = "update"

/**
 * The five topologies delegated whole, spelled as the operator-typed flag that
 * selected each one, because that is what an operator reading the marker needs
 * to see. A closed union rather than a string: the marker is grepped by S23's
 * accept gate, so a caller inventing a sixth spelling would produce a line the
 * gate does not recognise and a run that counts as binary-deployed when it was
 * not.
 */
export type DelegationFlag =
  | "--layout releases"
  | "--supervisor launchd"
  | "--user"
  | "--dry-run"
  | "--materialize"

/** Every DelegationFlag, so a caller (and the suite) can enumerate the delegated surface without restating it. */
export const DELEGATION_FLAGS: ReadonlyArray<DelegationFlag> = [
  "--layout releases",
  "--supervisor launchd",
  "--user",
  "--dry-run",
  "--materialize",
]

/** The prefix S23's accept gate greps for. Kept separate from the marker builder so the gate's own string is stated once. */
export const DELEGATED_MARKER_PREFIX = "DELEGATED to bash engine: "

/** The one stable stderr line a delegated run emits. See this module's header. */
export const delegatedMarker = (flag: DelegationFlag): string => `${DELEGATED_MARKER_PREFIX}${flag}`

/**
 * `error: ` refusals, in luna_die's shape (scripts/lib/luna-deploy.sh:6:
 * `printf 'error: %s\n' "$*" >&2; exit 1`). Delegation is unreachable without
 * a usable bash engine and both refusals happen before the lock, so they are
 * ordinary preflight errors and carry preflight's exit code (1).
 */
export const bashEngineUnsetError = (): string =>
  `error: ${BASH_ENGINE_ENV} is not set: this topology is delegated whole to the co-pinned bash engine, and there is no other way to locate it (scripts/luna-autodeploy sets it as a command-prefix assignment on every engine exec)`

export const bashEngineNotExecutableError = (path: string): string =>
  `error: ${BASH_ENGINE_ENV}=${path} is not an executable file; refusing to delegate rather than half-running a topology this binary does not own`

/** Exit 1 - preflight error, the same code luna_die uses (scripts/luna-update-server:172). */
export const EXIT_PREFLIGHT = 1

/** The result of a spawn, in the only two fields delegation reads. `error` is set when the spawn itself failed (ENOENT, EACCES). */
export interface EngineRunResult {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: Error | undefined
}

/**
 * The child inherits this process's stdio, unmodified: the bash engine's
 * stdout IS the deploy's narrative (luna_info, scripts/lib/luna-deploy.sh:4)
 * and its stderr carries `ROLLED BACK to`, which
 * packages/server-registry/src/driver/luna-chat-server.ts:164 classifies the
 * outcome on. Piping and re-emitting would reorder the two streams relative to
 * each other and interleave them differently from a bash-only run; inheriting
 * keeps a delegated run byte-indistinguishable from one where autodeploy had
 * exec'd bash directly, which is the whole promise of delegation.
 *
 * Exported so the suite can assert the option's EFFECT (spawnSync returns a
 * null stdout only when the fd was inherited) rather than merely asserting a
 * string in the source.
 */
export const ENGINE_STDIO = "inherit" as const

const defaultRunEngine = (path: string, args: ReadonlyArray<string>): EngineRunResult => {
  const r = spawnSync(path, [...args], { stdio: ENGINE_STDIO })
  return { status: r.status, signal: r.signal, error: r.error }
}

const defaultIsExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Bash reports a signal-killed child as 128 + signum (`$?` after a `wait`), and
 * that convention is what every caller of this engine already reads - the
 * autodeploy rc `case` (scripts/luna-autodeploy) and
 * LunaChatServerDriver's exit-code switch alike. Node hands back a signal NAME
 * instead, so the number is looked up rather than hardcoded: the values differ
 * across platforms (SIGUSR1 is 10 on Linux, 30 on Darwin) and a table baked in
 * here would be quietly wrong on one of the two platforms this suite runs on.
 *
 * An unmappable name falls back to 128, which is bash's own "killed by an
 * unknown signal" floor and is unambiguously nonzero.
 */
const exitCodeForSignal = (signal: NodeJS.Signals): number => {
  const number = (osConstants.signals as Record<string, number | undefined>)[signal]
  return number === undefined ? 128 : 128 + number
}

/**
 * Drop the subcommand token and forward everything after it, unmodified.
 *
 * `rawArgs` is what the process was invoked with after the executable
 * (`process.argv.slice(2)`, exactly as main.ts already computes it). The
 * subcommand's index is found as the first NON-FLAG token rather than assumed
 * to be 0 - see the header on why a fixed index is a real hazard - and the
 * token is then required to be `update`, since a delegation reached from any
 * other subcommand would be a wiring bug in the caller, not an operator error.
 *
 * Flag VALUES are never inspected: `--ref update` forwards untouched, because
 * the scan stops at the first non-flag token, which is the subcommand itself.
 */
export const forwardedFlags = (rawArgs: ReadonlyArray<string>): ReadonlyArray<string> => {
  const subcommandIndex = rawArgs.findIndex((arg) => !arg.startsWith("-"))
  if (subcommandIndex === -1 || rawArgs[subcommandIndex] !== UPDATE_SUBCOMMAND) {
    throw new Error(
      `forwardedFlags: expected the '${UPDATE_SUBCOMMAND}' subcommand token in argv, got ${JSON.stringify(rawArgs)}; ` +
        "delegation forwards the flags AFTER the subcommand and cannot be reached from any other surface",
    )
  }
  return rawArgs.slice(subcommandIndex + 1)
}

export type BashEngineResolution =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly errorLine: string }

/**
 * Resolve $LUNA_DEPLOY_BASH_ENGINE. An unset OR empty value is "unset" - an
 * exported-but-empty variable is what a shell profile assigning "" produces,
 * and bash's own `${VAR:-}` idiom treats the two the same throughout these
 * scripts.
 */
export const resolveBashEngine = (
  env: Readonly<Record<string, string | undefined>>,
  isExecutableFile: (path: string) => boolean = defaultIsExecutableFile,
): BashEngineResolution => {
  const path = env[BASH_ENGINE_ENV]
  if (path === undefined || path === "") return { ok: false, errorLine: bashEngineUnsetError() }
  if (!isExecutableFile(path)) return { ok: false, errorLine: bashEngineNotExecutableError(path) }
  return { ok: true, path }
}

export interface DelegateOptions {
  /** Which topology triggered the delegation; becomes the marker's suffix. */
  readonly flag: DelegationFlag
  /** `process.argv.slice(2)` - the subcommand token and everything after it. */
  readonly rawArgs: ReadonlyArray<string>
  /** The process environment, injected rather than read off `process.env` so a test drives it without mutating global state. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Where the marker and any refusal go. A line, WITHOUT its newline - the caller owns the terminator, matching rollback.ts's `warn` seam. */
  readonly writeStderr: (line: string) => void
  /** Defaults to a real `spawnSync` with inherited stdio. */
  readonly runEngine?: ((path: string, args: ReadonlyArray<string>) => EngineRunResult) | undefined
  /** Defaults to a real stat + X_OK probe. */
  readonly isExecutableFile?: ((path: string) => boolean) | undefined
}

export type DelegateOutcome =
  /** The bash engine could not be resolved; nothing was run and no marker was emitted. */
  | { readonly kind: "refused"; readonly exitCode: typeof EXIT_PREFLIGHT }
  /** The child ran to completion (or died on a signal); its status is this process's status. */
  | { readonly kind: "delegated"; readonly exitCode: number; readonly argv: ReadonlyArray<string> }

/**
 * Hand the whole run to the co-pinned bash engine.
 *
 * Order is load-bearing and is asserted by the suite: resolve, then MARK, then
 * exec. Marking before the exec means a child that never returns - killed with
 * the parent, or hanging in a readiness poll until an operator gives up - still
 * leaves the audit line behind. A marker written afterwards would be missing
 * from precisely the runs somebody needs to explain.
 *
 * The exit code is propagated VERBATIM. Nothing is normalised, remapped or
 * clamped: 0/1/2/3/4 all mean specific things to autodeploy's rc `case` and to
 * LunaChatServerDriver, and a delegated run is meant to be indistinguishable
 * from a bash-only one. A signal death becomes 128+signum, bash's own
 * convention, and a spawn that never started at all is a preflight failure.
 */
export const delegateToBashSync = (options: DelegateOptions): DelegateOutcome => {
  const resolution = resolveBashEngine(options.env, options.isExecutableFile ?? defaultIsExecutableFile)
  if (!resolution.ok) {
    options.writeStderr(resolution.errorLine)
    return { kind: "refused", exitCode: EXIT_PREFLIGHT }
  }

  // Computed BEFORE the marker: a malformed argv is a caller bug and must not
  // leave an audit line claiming a delegation that never happened.
  const argv: ReadonlyArray<string> = [resolution.path, ...forwardedFlags(options.rawArgs)]

  options.writeStderr(delegatedMarker(options.flag))

  const run = options.runEngine ?? defaultRunEngine
  const result = run(resolution.path, argv.slice(1))

  if (result.error !== undefined) {
    // The X_OK probe passed a moment ago, so this is a race (the pin pruned
    // mid-run) or an exec-format failure. Either way nothing deployed.
    options.writeStderr(
      `error: failed to exec the bash engine at ${resolution.path}: ${result.error.message}`,
    )
    return { kind: "delegated", exitCode: EXIT_PREFLIGHT, argv }
  }
  if (result.signal !== null) return { kind: "delegated", exitCode: exitCodeForSignal(result.signal), argv }
  // `status` is null only when a signal was delivered, which the branch above
  // already took; treat any remaining null as a failed run rather than a
  // success, since reporting 0 for a run whose outcome is unknown is the exact
  // silent-wrong-answer class this engine exists to remove.
  return { kind: "delegated", exitCode: result.status ?? EXIT_PREFLIGHT, argv }
}
