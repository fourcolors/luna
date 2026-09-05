/**
 * The seam that shells out to the CO-PINNED `scripts/lib/luna-deploy.sh` for
 * the four functions the binary deliberately does not port:
 * `luna_validate_profile` (scripts/lib/luna-deploy.sh:182-185),
 * `luna_find_bun` (:441-455), `luna_env_value` (:88-101) and
 * `luna_repin_claude_executable` (:213-248).
 *
 * WHY DELEGATE RATHER THAN TRANSCRIBE. Three of the four write or read the
 * server's `.env`, and the write path (`luna_upsert_env`, :35-64 via
 * `luna_remove_env`, :66-86) is a mode-600 secrets writer that creates its temp
 * file BESIDE the target so the replacing `mv` is a same-filesystem atomic
 * rename - a property a re-implementation gets wrong quietly and only on the
 * host, never in a fixture. S22d's own abandon conditions say an unproven port
 * of that writer must not ship. Sourcing the same audited bytes both engines
 * already run makes the two engines' behaviour identical BY CONSTRUCTION rather
 * than by a parity suite that has to keep chasing the bash.
 *
 * WHY THE LIB PATH COMES FROM AN ENVIRONMENT VARIABLE. The bash engine finds
 * its lib with `SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"`
 * then `source "$SCRIPT_DIR/lib/luna-deploy.sh"` (scripts/luna-update-server:
 * 39-41). A compiled bun binary has no BASH_SOURCE and its own argv[0] points
 * at GUARDIAN's pin (/usr/local/lib/luna-guardian, scripts/luna-guardian:
 * 1216-1219) - which does carry a lib/, but not the one that matters. The lib
 * that matters is the one beside the bash engine autodeploy pinned for THIS
 * run (`luna_pin_engine`, scripts/luna-autodeploy), because that engine is also
 * the delegation target for every topology the binary hands back (releases,
 * launchd, --user, --dry-run, --materialize). If a delegated run and an
 * in-binary run sourced different copies of luna-deploy.sh, the escape hatch
 * would stop being an escape hatch. So autodeploy passes the answer down as the
 * command-prefix assignment `LUNA_DEPLOY_BASH_ENGINE="$pinned_engine"` on the
 * three exec sites, and this module derives
 * `dirname($LUNA_DEPLOY_BASH_ENGINE)/lib/luna-deploy.sh` from it. Deriving is
 * correct rather than lucky: `luna_pin_engine` copies `luna-update-server` AND
 * `lib/` into the same pin dir, which is exactly the layout
 * `SCRIPT_DIR/lib/luna-deploy.sh` assumes.
 *
 * IT FAILS LOUDLY, BEFORE THE LOCK. `resolveBashLib` touches nothing on disk
 * and spawns nothing; on a missing variable or an unreadable lib it returns a
 * refusal carrying a byte-exact `error: ` line in `luna_die`'s shape
 * (scripts/lib/luna-deploy.sh:6) for the caller to print and exit 1 with. That
 * ordering is the invariant config.ts and preflight.ts are built on: every
 * refusal happens before `acquire_update_lock` (scripts/luna-update-server:
 * 950-1008), so a refusing run can never leave a lock dir behind.
 *
 * COLLABORATORS ARE INJECTED, INCLUDING THE SUBPROCESS. `runBash` is a
 * parameter, not an import, so a test can drive every arm of a caller without a
 * real host - the same seam restart.ts draws around `runSystemctl` and
 * readiness.ts around its probes. `makeSpawnBashRunner` is the production
 * implementation and the ONLY place in this module that spawns.
 *
 * TWO FIDELITY DETAILS THAT LOOK LIKE STYLE AND ARE NOT:
 *
 *  1. ARGUMENTS ARE POSITIONAL PARAMETERS, NEVER INTERPOLATED SCRIPT TEXT. The
 *     spec's shorthand is `bash -c 'source <lib> && <fn>'`; spelled literally
 *     with a caller-supplied profile or path pasted in, that is a shell
 *     injection on the deploy path. The script below is a fixed string and every
 *     value arrives through `"$@"`, so `--profile '$(rm -rf /)'` reaches
 *     `luna_validate_profile` as one inert argument and is refused by its regex
 *     like any other bad profile.
 *
 *  2. `bash -c`, NOT `bash -lc`. The login shell in the claude re-pin's INCUS
 *     arm (scripts/luna-update-server:1236-1237) is load-bearing there - it
 *     re-sources the container's profile files, which is what makes
 *     `command -v claude` resolve against the container's PATH. The HOST arm
 *     (:1245) is an ordinary in-process call in a non-login shell, and this
 *     module ports the HOST arm. A `-l` here would silently change what
 *     `luna_find_claude_executable` (:103-122) resolves.
 *
 * STDOUT IS READ WITH COMMAND-SUBSTITUTION SEMANTICS. Every call site in the
 * bash captures these functions as `$(...)` (e.g. `BUN_BIN="$(luna_find_bun)"`
 * at scripts/luna-update-server:529, `claude_pin="$(luna_env_value ...)"` at
 * :1248), which strips ALL trailing newlines. `stripTrailingNewlines` below
 * reproduces that rather than `.trim()`, which would also eat leading
 * whitespace the bash keeps.
 *
 * OUT OF SCOPE: `luna_upsert_env` / `luna_remove_env` as standalone entry
 * points (nothing outside `luna_repin_claude_executable` needs them on the
 * inplace path), and the host-arm degrade check's `command -v claude`
 * (scripts/luna-update-server:1253), which belongs to apply-inplace.ts along
 * with the rest of that arm's outcome arity.
 */
import { spawnSync } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { dirname, join } from "node:path"

/** The command-prefix assignment autodeploy adds to all three exec sites; see the header. */
export const BASH_ENGINE_ENV = "LUNA_DEPLOY_BASH_ENGINE"

/** `$(dirname "$LUNA_DEPLOY_BASH_ENGINE")/lib/luna-deploy.sh` - the layout `luna_pin_engine` publishes. */
export const libFileFor = (bashEngine: string): string => join(dirname(bashEngine), "lib", "luna-deploy.sh")

/** `luna_die`'s line, byte-exact (scripts/lib/luna-deploy.sh:6), without its trailing newline. */
export const lunaDieLine = (message: string): string => `error: ${message}`

// No `lunaWarnLine` formatter here (deliberately, not an oversight): unlike
// `luna_die`, this module never RECONSTRUCTS a `luna_warn` line - the one
// warning callers see (the stale-pin line in `ConfigureClaudeResult.stderr`)
// is forwarded verbatim from the delegated subprocess's own stderr bytes, per
// the header's "so the caller can forward the bytes instead of reconstructing
// them". A formatter with no call site would be exactly the kind of dead
// export a mutation can rewrite for free with the suite staying green.

// --- the injected subprocess seam --------------------------------------------

export interface BashCall {
  /** Fixed script text. Never carries caller data; see fidelity detail 1 in the header. */
  readonly script: string
  /** Positional parameters: `$1` is the lib to source, the rest are the function's own arguments. */
  readonly args: ReadonlyArray<string>
  /** Overrides layered ON TOP of the base environment (only `DRY_RUN` today). */
  readonly env: Readonly<Record<string, string>>
}

export interface BashResult {
  /** 127 is reserved for "the source itself failed" - see `SOURCE_FAILED`. */
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

export type BashRunner = (call: BashCall) => BashResult

/**
 * The production runner: `bash -c <script> bash <args...>` with the base
 * environment passed through verbatim and the call's overrides layered on top.
 *
 * `baseEnv` is a parameter rather than a read of `process.env` inside the
 * runner so the parity suite can pin PATH/HOME per scenario without mutating
 * the test process. Production passes `process.env`, which is what the spec
 * means by "the parent's exact environment, DRY_RUN propagated".
 */
export const makeSpawnBashRunner = (
  baseEnv: NodeJS.ProcessEnv,
  bashPath = "bash",
): BashRunner =>
  (call) => {
    const r = spawnSync(bashPath, ["-c", call.script, "bash", ...call.args], {
      env: { ...baseEnv, ...call.env },
      encoding: "utf8",
    })
    return {
      // A spawn that never ran (ENOENT) reports null; surface it as 127, the
      // shell's own "command not found", rather than coercing it to 0.
      status: r.status ?? 127,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    }
  }

/** Convenience wrapper reading `process.env` AT CALL TIME (never at import time). */
export const spawnBashSync: BashRunner = (call) => makeSpawnBashRunner(process.env)(call)

/**
 * `source "$1" || exit 127; shift; <fn> "$@"`.
 *
 * The `|| exit 127` arm is belt-and-braces: `resolveBashLib` has already proved
 * the file readable, so reaching it means the lib vanished between preflight and
 * the call. Without it, a failed `source` would fall through and run `<fn>` as
 * an undefined command - also 127, but with a confusing message and, worse, a
 * shape indistinguishable from success for a function whose success is silent.
 */
const scriptFor = (fn: string): string => `source "$1" || exit 127\nshift\n${fn} "$@"\n`

/** `$(...)` strips ALL trailing newlines and nothing else; `.trim()` would also strip leading whitespace. */
const stripTrailingNewlines = (s: string): string => s.replace(/\n+$/, "")

// --- resolution ---------------------------------------------------------------

export interface ResolveBashLibOptions {
  /** Env reader, injected so a test never has to mutate `process.env`. */
  readonly env: (name: string) => string | undefined
  /** Readability predicate for the lib file; `defaultIsReadableFile` in production. */
  readonly isReadableFile: (path: string) => boolean
  readonly runBash: BashRunner
}

export type ResolveBashLibResult =
  | { readonly ok: true; readonly lib: BashLib }
  /** Print `errorLine` to stderr and exit `exitCode`; both match `luna_die`. */
  | { readonly ok: false; readonly errorLine: string; readonly exitCode: 1 }

/** `[[ -r "$f" && -f "$f" ]]`, the check the refusal below reports on. */
export const defaultIsReadableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** How the lib is spelled in both refusal lines; one constant so they cannot drift. */
const LIB_RELATIVE = "scripts/lib/luna-deploy.sh"

/**
 * Resolve the co-pinned lib, or refuse.
 *
 * Creates nothing, spawns nothing, and reads exactly one environment variable
 * and one file's metadata - so it is safe to call in preflight, before the lock
 * exists. Both refusals are exit 1 with a `luna_die`-shaped line, matching every
 * other preflight refusal in the engine.
 */
export function resolveBashLib(options: ResolveBashLibOptions): ResolveBashLibResult {
  const engine = options.env(BASH_ENGINE_ENV)
  if (engine === undefined || engine === "") {
    return {
      ok: false,
      exitCode: 1,
      errorLine: lunaDieLine(
        `${BASH_ENGINE_ENV} is not set, so the co-pinned ${LIB_RELATIVE} cannot be located; the binary engine is only ever exec'd by luna-autodeploy's engine gate, which sets it to the pinned bash engine`,
      ),
    }
  }
  const libFile = libFileFor(engine)
  if (!options.isReadableFile(libFile)) {
    return {
      ok: false,
      exitCode: 1,
      errorLine: lunaDieLine(
        `no readable ${LIB_RELATIVE} at ${libFile} (derived from ${BASH_ENGINE_ENV}=${engine}); the binary engine delegates luna_validate_profile, luna_find_bun, luna_env_value and luna_repin_claude_executable to it`,
      ),
    }
  }
  return { ok: true, lib: makeBashLib(engine, libFile, options.runBash) }
}

// --- the four delegated functions ---------------------------------------------

/** `luna_validate_profile` refuses through `luna_die`, so a failure is exit 1 plus one `error: ` line. */
export type ValidateProfileResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly exitCode: number; readonly stderr: string }

export type FindBunResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly exitCode: number; readonly stderr: string }

/**
 * `luna_env_value` returns 1 for BOTH "no such file" (:91) and "no such key"
 * (awk's `END { exit found ? 0 : 1 }`, :99), and a present-but-empty value is
 * rc 0 with an empty capture. `found` therefore distinguishes absent from
 * empty - a distinction the host arm's degrade check depends on
 * (`[[ -z "$claude_pin" || ! -x "$claude_pin" ]]`, scripts/luna-update-server:1252).
 */
export interface EnvValueResult {
  readonly found: boolean
  /** Command-substitution semantics: trailing newlines stripped. Empty when not found. */
  readonly value: string
  readonly exitCode: number
  readonly stderr: string
}

/**
 * The HOST arm of the claude re-pin (scripts/luna-update-server:1245), whose
 * outcome arity is TWO-way: `|| return 1`. The warn-only degrade check that
 * follows it (:1248-1255) is the caller's, not this function's.
 *
 * `stderr` carries the stale-pin warning verbatim
 * (`warning: removing stale LUNA_CLAUDE_CODE_EXECUTABLE (<path> is not
 * executable)`, scripts/lib/luna-deploy.sh:139) so the caller can forward the
 * bytes instead of reconstructing them.
 */
export interface ConfigureClaudeResult {
  readonly ok: boolean
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface ConfigureClaudeRequest {
  /** `$ENV_FILE`. */
  readonly envFile: string
  /** `$REPO_DIR` verbatim - NOT `$HOST_REPO_DIR` or `$CONTAINER_REPO_DIR` (scripts/luna-update-server:1245). */
  readonly repoDir: string
  /** Propagated because the helper returns 0 without writing when it is true (scripts/lib/luna-deploy.sh:130-132). */
  readonly dryRun: boolean
}

export interface BashLib {
  /** `$LUNA_DEPLOY_BASH_ENGINE` as resolved. */
  readonly bashEngine: string
  /** The lib actually sourced by every call below. */
  readonly libFile: string

  /** `luna_validate_profile "$PROFILE"` (scripts/luna-update-server:248). */
  readonly validateProfile: (profile: string) => ValidateProfileResult
  /** `BUN_BIN="$(luna_find_bun)"` (scripts/luna-update-server:529). */
  readonly findBun: () => FindBunResult
  /** `luna_env_value "$ENV_FILE" <KEY>` (scripts/luna-update-server:1248, :845). */
  readonly envValue: (envFile: string, key: string) => EnvValueResult
  /** `luna_repin_claude_executable "$ENV_FILE" "$REPO_DIR"` (scripts/luna-update-server:1262). */
  readonly configureClaudeExecutable: (request: ConfigureClaudeRequest) => ConfigureClaudeResult
}

const makeBashLib = (bashEngine: string, libFile: string, runBash: BashRunner): BashLib => {
  const call = (fn: string, args: ReadonlyArray<string>, env: Record<string, string> = {}): BashResult =>
    runBash({ script: scriptFor(fn), args: [libFile, ...args], env })

  return {
    bashEngine,
    libFile,

    validateProfile: (profile) => {
      const r = call("luna_validate_profile", [profile])
      return r.status === 0 ? { ok: true } : { ok: false, exitCode: r.status, stderr: r.stderr }
    },

    findBun: () => {
      const r = call("luna_find_bun", [])
      return r.status === 0
        ? { ok: true, path: stripTrailingNewlines(r.stdout) }
        : { ok: false, exitCode: r.status, stderr: r.stderr }
    },

    envValue: (envFile, key) => {
      const r = call("luna_env_value", [envFile, key])
      return {
        found: r.status === 0,
        value: r.status === 0 ? stripTrailingNewlines(r.stdout) : "",
        exitCode: r.status,
        stderr: r.stderr,
      }
    },

    configureClaudeExecutable: ({ envFile, repoDir, dryRun }) => {
      const r = call("luna_repin_claude_executable", [envFile, repoDir], {
        // The helper reads `${DRY_RUN:-false}`; pass the literal both ways so a
        // stale DRY_RUN in the inherited environment cannot leak in and turn a
        // real deploy's re-pin into a no-op.
        DRY_RUN: dryRun ? "true" : "false",
      })
      return { ok: r.status === 0, exitCode: r.status, stdout: r.stdout, stderr: r.stderr }
    },
  }
}
