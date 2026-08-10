/**
 * The `update` subcommand's process boundary.
 *
 * NOTE THE PATH: this file sits beside main.ts, OUTSIDE src/update/, and that
 * is structural rather than stylistic. `src/update/` is the pure-and-injected
 * directory - two CI greps assert that nothing under it calls `process.exit(`
 * and that nothing under it reads `process.env` except the one pre-existing
 * `spawnBashSync` helper, which this slice does not call. `src/` is the
 * process boundary. So the citty command definition, `realSeams()`,
 * `realUpdateIo()` and the single `process.exit` all belong on this side of
 * the line, and nothing under `src/update/` imports this file.
 *
 * `realUpdateIo` is the clearest case. Its whole contract is the identity
 * comparison `env === process.env`, which IS a `process.env` read; declared
 * under `src/update/` it would fail the gate it is specified alongside. The
 * `UpdateIo` TYPE stays over there, where its consumers are, because a type
 * reads nothing.
 *
 * WHY THE IDENTITY CHECK EXISTS AT ALL. A real IO layer built against a
 * DIFFERENT env map is the silent-leak shape this slice's audit found: every
 * PR1 spawn site resolves argv[0] and PATH from the process's own environment
 * and none of them honours an injected `env`, so a caller that passed a
 * fixture env to `realUpdateIo` would get a record that LOOKS hermetic and
 * runs real host binaries - on a self-hosted runner that is itself a
 * deployment host, one of them is `systemctl stop <unit>`. Production passes
 * `process.env`; any test that wants a different environment must supply its
 * own `io`, which is exactly what makes that supply mandatory rather than
 * optional.
 *
 * `update --help` is NOT handled here, which is deliberate: main.ts's raw-argv
 * preamble runs BEFORE `runMain`, and putting the handling inside this
 * command's `run` is too late if citty intercepts first. citty's own
 * per-subcommand help prints through consola, which goes silent whenever
 * NODE_ENV or TEST is set - the exit-0-no-output shape the binary's publish
 * postcondition exists to catch.
 */
import { spawnSync } from "node:child_process"
import { accessSync, constants as fsConstants, statSync } from "node:fs"
import { delimiter as pathDelimiter, sep as pathSeparator } from "node:path"
import { defineCommand } from "citty"
import { makeSpawnBashRunner } from "./update/bash-lib.js"
import { ENGINE_STDIO, type EngineRunResult } from "./update/delegate.js"
import { processAliveSync, processFingerprintSync } from "./update/lock.js"
import { makeMonotonicSeconds, sleepSecondsSync } from "./update/probes.js"
import { UPDATE_USAGE, runUpdate } from "./update/run-update.js"
import { queryActiveWsCountSync, stripTrailingNewlines } from "./update/session-guard.js"
import { defaultSpawnTarget } from "./update/target.js"
import { makeCommandExists, type RealSeams, type UpdateIo } from "./update/wiring.js"

/** `[[ -d <path> ]]`. */
const realDirExists = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** `[[ -f <path> ]]`. */
const realFileExists = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** `[[ -x <path> ]]`, which for a directory is true in bash and useless to every caller here, so a regular-file check comes first. */
const realIsExecutable = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** `[[ -r "$f" && -f "$f" ]]` - resolveBashLib's readability seam (bash-lib.ts:169-175). */
const realIsReadableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

/** `incus exec "$c" -- test -f "$p"` (scripts/luna-update-server:485): a CONTAINER-filesystem question, never a host stat. */
const realContainerFileExists = (container: string, path: string): boolean =>
  spawnSync("incus", ["exec", container, "--", "test", "-f", path]).status === 0

/**
 * `$(git -C <dir> rev-parse --abbrev-ref HEAD 2>/dev/null || true)` (:513).
 * The `|| true` makes a failure and an empty answer the same answer, and both
 * fall through to origin/master.
 */
const realGitCurrentBranch = (hostRepoDir: string): string => {
  const r = spawnSync("git", ["-C", hostRepoDir, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  })
  if (r.status !== 0) return ""
  return stripTrailingNewlines(r.stdout ?? "")
}

/** `sleep "$RESTART_SETTLE_SECS"` (:1282), taking the RAW string restart.ts validated. */
const realSettleSleep = (secs: string): { readonly ok: boolean } => ({
  ok: spawnSync("sleep", [secs]).status === 0,
})

/** delegate.ts's engine spawn, with the inherited stdio that keeps a delegated run byte-indistinguishable from a bash-only one. */
const realRunEngine = (path: string, args: ReadonlyArray<string>): EngineRunResult => {
  const r = spawnSync(path, [...args], { stdio: ENGINE_STDIO })
  return { status: r.status, signal: r.signal, error: r.error }
}

/**
 * Every real-IO boundary, in one record.
 *
 * THROWS unless `env` is the very `process.env` object - see this module's
 * header for why that is a hard refusal rather than a warning.
 */
export const realUpdateIo = (env: Readonly<Record<string, string | undefined>>): UpdateIo => {
  if (env !== (process.env as Readonly<Record<string, string | undefined>>)) {
    throw new Error(
      "realUpdateIo: refusing to build the real IO layer against an environment that is not process.env; " +
        "every spawn below resolves argv[0] and PATH from the process's own environment, so a record built " +
        "against a different env map would look injected and run real host binaries. Supply your own UpdateIo instead.",
    )
  }
  return {
    spawnTarget: defaultSpawnTarget,
    runBash: makeSpawnBashRunner(process.env),
    runEngine: realRunEngine,
    queryActiveWsCount: queryActiveWsCountSync,
    sleepSecs: sleepSecondsSync,
    settleSleep: realSettleSleep,
    processAlive: processAliveSync,
    processFingerprint: processFingerprintSync,
    pid: () => process.pid,
    // bash's `$UID`. `getuid` is absent on Windows, which is not a deploy
    // target for this engine but IS a place `tsc` and a stray unit test can
    // run; 0 is the value every supported host reports for the root the
    // engine actually deploys as.
    uid: () => process.getuid?.() ?? 0,
    now: makeMonotonicSeconds(),
    dirExists: realDirExists,
    fileExists: realFileExists,
    isExecutable: realIsExecutable,
    isReadableFile: realIsReadableFile,
    containerFileExists: realContainerFileExists,
    gitCurrentBranch: realGitCurrentBranch,
    // The PATH walk, never a spawn of the `command` shell builtin.
    commandExists: makeCommandExists(process.env, realIsExecutable, pathDelimiter, pathSeparator),
  }
}

/**
 * The process boundary as a value, and the ONLY function in the tree that
 * reads `process.env` or writes to `process.stdout`/`process.stderr` directly.
 *
 * Both writers are RAW: they receive their bytes verbatim, including any
 * trailing newline, and add nothing. wiring.ts's `info`/`warn` are the two
 * adapters that add `scripts/lib/luna-deploy.sh:4-5`'s prefixes.
 */
export const realSeams = (): RealSeams => ({
  env: process.env,
  writeStdout: (text) => {
    process.stdout.write(text)
  },
  writeStderr: (text) => {
    process.stderr.write(text)
  },
  io: realUpdateIo(process.env),
})

/**
 * The citty command.
 *
 * `process.argv.slice(2)` and NOT citty's parsed args: the `update` subcommand
 * token has to survive to `delegateToBashSync`, which forwards the ORIGINAL
 * argv to the bash engine so that an operator's `--readiness-timeout 600`
 * reaches it as typed rather than as a reconstruction of what this binary
 * understood.
 */
export const updateCommand = defineCommand({
  meta: {
    name: "update",
    description: "Update an installed Luna server to a target ref (scripts/luna-update-server)",
  },
  run: () => {
    // The one process.exit in the update surface. Everything that had to
    // unwind - the update lock, its exit hooks - is already unwound by
    // runUpdate's own finally before this line is reached.
    process.exit(runUpdate(process.argv.slice(2), realSeams()))
  },
})

export { UPDATE_USAGE }
