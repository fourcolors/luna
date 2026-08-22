/**
 * Golden parity for the `update` config block (S22d): every scenario runs the
 * REAL top-level preamble of scripts/luna-update-server and the TypeScript
 * port over the same argv AND the same environment, then asserts they agree on
 * the exit code, on the byte-exact `error: ` line, and on all 41 derived
 * variables.
 *
 * HOW THE BASH SIDE IS DRIVEN, AND WHY IT IS NOT awk-EXTRACTED LIKE
 * rollback-parity / readiness-parity. Those suites extract a FUNCTION; this
 * block is not one. The parser, the validation ladder and every derivation are
 * top-level statements running under `set -euo pipefail` between line 43 and
 * line 343, and `luna_die` inside them exits the shell rather than returning.
 * So the extraction here is a TRUNCATION rather than a function lift: the
 * script's own bytes from the top through `SERVICE_FILE=...`, plus the
 * UPDATE_STATE_DIR trio (:934-936) and the BUN_BIN fork (:526-530), then a
 * dump. Every anchor is located by exact line CONTENT, never by line number,
 * so a future edit that moves the block relocates the probe instead of
 * silently truncating somewhere else - and every anchor is asserted found
 * before a single scenario runs.
 *
 * The truncation stops before the banner (:423-440) on purpose: the banner and
 * everything after it is preflight.ts's territory, and a probe that printed it
 * would make this suite fail whenever that module's oracle moved.
 *
 * THE ENVIRONMENT IS PART OF THE INPUT, NOT AMBIENT. Fifteen of these
 * variables default from `LUNA_*` env and two derivations interpolate $HOME
 * (:237 and :295), so every scenario passes an EXPLICIT env to both drives -
 * including `PATH`, which is what makes `command -v launchctl` (:281) and
 * `luna_find_bun` (scripts/lib/luna-deploy.sh:441-455) answer the same on a
 * macOS laptop and a Linux CI runner. The PATH is a temp dir holding a symlink
 * to `dirname` and, per scenario, a `launchctl` and/or `bun` stub; on macOS
 * /bin/launchctl would otherwise be found unconditionally and the
 * launchctl-missing refusal could never be exercised at all.
 *
 * THE SEAMS ARE DRIVEN THROUGH REAL BASH. `validateProfile` and `hasLaunchctl`
 * (and `findBun`, for resolveBunBin) are injected, so a test could satisfy
 * them with a TypeScript guess at what the shell does. Instead each one shells
 * out to the SAME function in the SAME library under the SAME env the bash
 * drive used. That is what makes the profile-regex and PATH-probe rows of this
 * table evidence rather than assertion.
 *
 * THE ORDERING INVARIANT REPLACES THE PURITY CLAIM. config.ts is not pure and
 * the spec says so; the guarantee that actually protects a host is that no
 * lock is acquired before validation returns. It is asserted at the bottom of
 * this file against the REAL, UNTRUNCATED script: every refusal leaves
 * $LUNA_UPDATE_STATE_DIR absent entirely, so there is no lock dir, no journal
 * and no state dir to clean up after a bad flag.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterAll, describe, expect, it } from "vitest"
import {
  CONFIG_ERRORS,
  type ConfigSeams,
  type Env,
  type UpdateConfig,
  lunaServiceName,
  parseUpdateConfig,
  resolveBunBin,
} from "../../src/update/config.js"
import { runUpdate } from "./bash-fixtures.js"
import { repoRoot } from "./temp-dirs.js"

const UPDATE_SERVER = join(repoRoot, "scripts/luna-update-server")
const LIB_DIR = join(repoRoot, "scripts/lib")

/**
 * bash by ABSOLUTE path. Every spawn below hands the child a hermetic PATH
 * (see the header), and spawnSync resolves the executable against the CHILD's
 * PATH - so a bare "bash" would be unfindable in the tools dir and every
 * scenario would fail with status -1 and an empty stderr, which reads exactly
 * like a refusal that never happened.
 */
const BASH = ["/bin/bash", "/usr/bin/bash"].find((p) => existsSync(p)) ?? "bash"

const tempRoots: string[] = []
const makeTemp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(d)
  return d
}
afterAll(() => {
  for (const d of tempRoots.splice(0)) rmSync(d, { recursive: true, force: true })
})

// --- the bash probe: the script's own config bytes, truncated + dumped -------

/**
 * The variables both drives report, in one fixed order. The bash column is the
 * expansion the script itself would write; the TS column names the
 * `UpdateConfig` field. Adding a field to `UpdateConfig` without adding a row
 * here is caught by the `every field is diffed` test below.
 */
const DUMPED: ReadonlyArray<readonly [keyof UpdateConfig | "bunBin", string]> = [
  ["home", '$HOME'],
  ["profile", '$PROFILE'],
  ["repoDir", '$REPO_DIR'],
  ["repoDirExplicit", '$REPO_DIR_EXPLICIT'],
  ["lunaHome", '$LUNA_HOME'],
  ["serviceDir", '$SERVICE_DIR'],
  ["serviceName", '$SERVICE_NAME'],
  ["ref", '$REF'],
  ["incusContainer", '$INCUS_CONTAINER'],
  ["dryRun", '$DRY_RUN'],
  ["rollback", '$ROLLBACK'],
  ["operatorOverrideReason", '$OPERATOR_OVERRIDE_REASON'],
  ["maxSessionDefer", '$MAX_SESSION_DEFER'],
  ["restartOnly", '$RESTART_ONLY'],
  ["readinessPort", '$READINESS_PORT'],
  ["readinessTimeout", '$READINESS_TIMEOUT'],
  ["readinessInterval", '$READINESS_INTERVAL'],
  ["readinessCurlMaxTime", '$READINESS_CURL_MAX_TIME'],
  ["restartSettleSecs", '$RESTART_SETTLE_SECS'],
  ["supervisor", '$SUPERVISOR'],
  ["systemdUser", '$SYSTEMD_USER'],
  ["layout", '$LAYOUT'],
  ["deployRoot", '$DEPLOY_ROOT'],
  ["releasesKeep", '$RELEASES_KEEP'],
  ["materializeOnly", '$MATERIALIZE_ONLY'],
  ["containerDeployRoot", '$CONTAINER_DEPLOY_ROOT'],
  ["containerEnvFile", '$CONTAINER_ENV_FILE'],
  ["launchdLabel", '$LAUNCHD_LABEL'],
  ["launchdPlist", '$LAUNCHD_PLIST'],
  ["mirrorGit", '$MIRROR_GIT'],
  ["releasesDir", '$RELEASES_DIR'],
  ["currentLink", '$CURRENT_LINK'],
  ["previousLink", '$PREVIOUS_LINK'],
  ["hostRepoDir", '$HOST_REPO_DIR'],
  ["containerRepoDir", '$CONTAINER_REPO_DIR'],
  // BUN_BIN_INCUS is only assigned on the incus arm (:317); `set -u` would
  // abort the dump on a bare host without the `:-` guard, exactly as the bash
  // leaves it unset there and config.ts leaves it "".
  ["bunBinIncus", '${BUN_BIN_INCUS:-}'],
  ["userUnitFile", '$USER_UNIT_FILE'],
  ["envFile", '$ENV_FILE'],
  ["serviceFile", '$SERVICE_FILE'],
  ["updateStateDir", '$UPDATE_STATE_DIR'],
  ["updateLockDir", '$UPDATE_LOCK_DIR'],
  ["updateJournal", '$UPDATE_JOURNAL'],
  // Not a config field: BUN_BIN is `resolveBunBin(config, findBun)` on the TS
  // side, which is why it is appended rather than declared in UpdateConfig.
  ["bunBin", '$BUN_BIN'],
]

/** Locate a block by exact line CONTENT so the probe follows the code instead of a line number. */
const sliceAt = (lines: ReadonlyArray<string>, anchor: string, before: number, count: number): ReadonlyArray<string> => {
  const at = lines.indexOf(anchor)
  if (at < 0) {
    throw new Error(
      `config-parity: anchor not found in scripts/luna-update-server: ${JSON.stringify(anchor)}. ` +
        "The config block moved or was reworded; re-anchor this probe rather than deleting the assertion.",
    )
  }
  return lines.slice(at - before, at - before + count)
}

/**
 * Build the probe ONCE: the real script's lines 1..`SERVICE_FILE=...`, then
 * the three UPDATE_STATE_DIR lines, then the five-line BUN_BIN fork, then a
 * NUL-separated dump. NUL rather than newline because an operator-supplied
 * value (an --operator-override reason, say) may legitimately contain
 * anything a shell word can hold.
 */
const buildProbe = (): string => {
  const lines = readFileSync(UPDATE_SERVER, "utf8").split("\n")

  const headEnd = lines.indexOf('SERVICE_FILE="$SERVICE_DIR/$SERVICE_NAME"')
  if (headEnd < 0) throw new Error("config-parity: could not find the end of the config block (SERVICE_FILE=)")
  const head = lines.slice(0, headEnd + 1)

  const stateAnchor = 'UPDATE_STATE_DIR="${LUNA_UPDATE_STATE_DIR:-$LUNA_HOME/update}"'
  const state = sliceAt(lines, stateAnchor, 0, 3)

  // The fork's `if`/`else`/`fi` frame sits one line above and three below the
  // distinctive assignment, which is the only line in the file with this text.
  const bun = sliceAt(lines, '  BUN_BIN="$BUN_BIN_INCUS"', 1, 5)

  const dump = `printf '%s\\0' ${DUMPED.map(([k, expr]) => `"${k}=${expr}"`).join(" ")}`

  const dir = makeTemp("deploy-cli-config-probe-")
  // SCRIPT_DIR is `dirname $BASH_SOURCE` (:39), and the very next line sources
  // $SCRIPT_DIR/lib/luna-deploy.sh - so the probe needs a `lib` beside it. A
  // symlink to the REAL lib keeps the sourced bytes the audited ones.
  symlinkSync(LIB_DIR, join(dir, "lib"))
  const probe = join(dir, "luna-update-server-config-probe")
  writeFileSync(probe, `${[...head, ...state, ...bun, dump].join("\n")}\n`)
  return probe
}

const PROBE = buildProbe()

interface Drive {
  readonly status: number
  readonly stderr: string
  readonly vars: ReadonlyMap<string, string>
}

const parseDump = (stdout: string): ReadonlyMap<string, string> => {
  const out = new Map<string, string>()
  for (const field of stdout.split("\0")) {
    if (field === "") continue
    const eq = field.indexOf("=")
    out.set(field.slice(0, eq), field.slice(eq + 1))
  }
  return out
}

const runBash = (argv: ReadonlyArray<string>, env: Env): Drive => {
  const r = spawnSync(BASH, [PROBE, ...argv], { env: env as NodeJS.ProcessEnv, encoding: "utf8" })
  return { status: r.status ?? -1, stderr: r.stderr ?? "", vars: parseDump(r.stdout ?? "") }
}

// --- the seams, driven through the same shell the bash drive used -----------

/** `export HOME="${HOME:-/root}"` (:43): the seam subshells must see the same defaulted HOME the script exports. */
const seamEnv = (env: Env): NodeJS.ProcessEnv => ({ ...env, HOME: env.HOME === undefined || env.HOME === "" ? "/root" : env.HOME })

const sourced = (env: Env, body: string, ...args: ReadonlyArray<string>): { status: number; stdout: string } => {
  const r = spawnSync(BASH, ["-c", `source ${JSON.stringify(join(LIB_DIR, "luna-deploy.sh"))}\n${body}`, "_", ...args], {
    env: seamEnv(env),
    encoding: "utf8",
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? "" }
}

const makeSeams = (env: Env): ConfigSeams => ({
  // luna_validate_profile dies (exit 1) on a bad profile and returns 0 otherwise.
  validateProfile: (profile) => sourced(env, 'luna_validate_profile "$1"', profile).status === 0,
  // The literal probe from :281, under the scenario's own PATH.
  hasLaunchctl: () => spawnSync(BASH, ["-c", "command -v launchctl >/dev/null 2>&1"], { env: seamEnv(env) }).status === 0,
})

const findBunSeam = (env: Env) => (): string => sourced(env, "luna_find_bun").stdout.replace(/\n$/, "")

const runTs = (argv: ReadonlyArray<string>, env: Env): Drive => {
  const outcome = parseUpdateConfig(argv, env, makeSeams(env))
  if (outcome.kind === "help") return { status: 0, stderr: "", vars: new Map() }
  if (outcome.kind === "error") {
    return { status: outcome.exitCode, stderr: `error: ${outcome.message}\n`, vars: new Map() }
  }
  if (outcome.kind === "missing-value") {
    // bash emits its OWN runtime diagnostic here, not an `error: ` line; see
    // the ParseOutcome doc comment. Parity on this path is the exit code.
    return { status: outcome.exitCode, stderr: "", vars: new Map() }
  }
  const vars = new Map<string, string>()
  for (const [key] of DUMPED) {
    if (key === "bunBin") {
      vars.set("bunBin", resolveBunBin(outcome.config, findBunSeam(env)))
      continue
    }
    const v = outcome.config[key]
    vars.set(key, typeof v === "boolean" ? String(v) : v)
  }
  return { status: 0, stderr: "", vars }
}

// --- PATH control ------------------------------------------------------------

interface ToolsOptions {
  readonly launchctl?: boolean
  readonly bun?: boolean
}

/**
 * A hermetic PATH. `dirname` is the only external the truncated block runs
 * (:39). `launchctl` and `bun` are stubs so the two PATH probes in this block
 * answer identically on macOS and Linux - without this, /bin/launchctl makes
 * the launchctl-missing refusal untestable on a developer machine.
 */
const makeTools = (opts: ToolsOptions = {}): string => {
  const dir = makeTemp("deploy-cli-config-tools-")
  const dirnameBin = ["/usr/bin/dirname", "/bin/dirname"].find((p) => existsSync(p))
  if (dirnameBin === undefined) throw new Error("config-parity: no dirname on this host")
  symlinkSync(dirnameBin, join(dir, "dirname"))
  for (const [name, wanted] of [["launchctl", opts.launchctl], ["bun", opts.bun]] as const) {
    if (wanted !== true) continue
    const p = join(dir, name)
    writeFileSync(p, "#!/usr/bin/env bash\nexit 0\n")
    spawnSync("chmod", ["+x", p])
  }
  return dir
}

const TOOLS = makeTools()
const TOOLS_WITH_LAUNCHCTL = makeTools({ launchctl: true })

/** The env every scenario starts from: nothing ambient, everything named. */
const baseEnv = (tools: string = TOOLS): Env => ({ PATH: tools, HOME: "/home/operator" })

// --- the table ---------------------------------------------------------------

interface Scenario {
  readonly argv: ReadonlyArray<string>
  readonly env?: Env
}

const bothDrives = (s: Scenario): { readonly bash: Drive; readonly ts: Drive } => {
  const env = s.env ?? baseEnv()
  return { bash: runBash(s.argv, env), ts: runTs(s.argv, env) }
}

/** An accepted config: identical exit code, empty stderr on both, and all 42 dumped values byte-equal. */
const accepts = (name: string, s: Scenario): void => {
  it(name, () => {
    const { bash, ts } = bothDrives(s)
    expect(bash.status, `bash refused (stderr: ${bash.stderr})`).toBe(0)
    expect(ts.status, `port refused (stderr: ${ts.stderr})`).toBe(0)
    expect(bash.stderr).toBe("")
    expect(ts.stderr).toBe("")
    // Compared as one object so a diff names every field that drifted, not
    // just the first.
    expect(Object.fromEntries(ts.vars)).toEqual(Object.fromEntries(bash.vars))
    expect(bash.vars.size).toBe(DUMPED.length)
  })
}

/** A refusal: exit 1 on both drives and the SAME byte-exact `error: ` line. */
const refuses = (name: string, s: Scenario, expected: string): void => {
  it(name, () => {
    const { bash, ts } = bothDrives(s)
    expect(bash.status, `bash accepted (stdout vars: ${[...bash.vars.keys()].length})`).toBe(1)
    expect(bash.stderr).toBe(`error: ${expected}\n`)
    expect(ts.status).toBe(1)
    expect(ts.stderr).toBe(bash.stderr)
  })
}

describe("update config: golden parity with scripts/luna-update-server", () => {
  describe("accepts and derives", () => {
    accepts("no flags at all: every default, bare host", { argv: [] })

    accepts("a fully explicit bare-host invocation", {
      argv: [
        "--profile", "dev",
        "--repo-dir", "/srv/luna/repo",
        "--luna-home", "/srv/state",
        "--ref", "origin/next",
        "--service-dir", "/srv/units",
        "--service-name", "custom.service",
        "--readiness-timeout", "120",
        "--readiness-interval", "0.3",
        "--readiness-port", "5753",
        "--restart-settle", "0",
        "--no-rollback",
        "--restart-only",
      ],
    })

    // The incus arm DERIVES the host mount from the profile when the operator
    // stayed silent (:305-309) - the one place REPO_DIR_EXPLICIT is read.
    accepts("--incus without --repo-dir derives /root/luna/<profile>/repo", {
      argv: ["--profile", "dev", "--incus", "luna-dev"],
    })

    accepts("--incus WITH --repo-dir keeps the operator's host path", {
      argv: ["--profile", "dev", "--incus", "luna-dev", "--repo-dir", "/mnt/dev-repo"],
    })

    // LUNA_REPO_DIR sets REPO_DIR_EXPLICIT too (:58-59), so the env is as
    // "explicit" as the flag for the incus derivation.
    accepts("LUNA_REPO_DIR counts as explicit for the incus derivation", {
      argv: ["--profile", "dev", "--incus", "luna-dev"],
      env: { ...baseEnv(), LUNA_REPO_DIR: "/mnt/from-env" },
    })

    // `[[ -n "${LUNA_REPO_DIR:-}" ]]` (:58-59) is false for an EXPORTED but
    // empty value, not just an unset one - envSet must agree, or a stray
    // `LUNA_REPO_DIR=` on the command line silently freezes the host mount
    // path instead of falling back to the profile-derived one.
    accepts("LUNA_REPO_DIR set to the empty string is NOT explicit", {
      argv: ["--profile", "dev", "--incus", "luna-dev"],
      env: { ...baseEnv(), LUNA_REPO_DIR: "" },
    })

    accepts("--incus resolves the in-container bun through the LUNA_TEST_BUN_PATH seam", {
      argv: ["--incus", "luna-stable"],
      env: { ...baseEnv(), LUNA_TEST_BUN_PATH: "/opt/hermetic/bun" },
    })

    accepts("a bare host resolves bun through luna_find_bun", {
      argv: [],
      env: baseEnv(makeTools({ bun: true })),
    })

    // THE --user REWRITE, and its two edges. The guard tests the ENV var, not
    // the flag, so an operator who typed the system default explicitly still
    // gets it rewritten - a quirk a port would "fix" by accident.
    accepts("--user rewrites SERVICE_DIR to the XDG user unit dir", { argv: ["--user"] })

    accepts("--user leaves SERVICE_DIR alone when LUNA_SERVICE_DIR is set", {
      argv: ["--user"],
      env: { ...baseEnv(), LUNA_SERVICE_DIR: "/etc/systemd/system" },
    })

    // The other call site of the same `-n`-shaped guard: an exported but
    // EMPTY LUNA_SERVICE_DIR must still count as unset, so --user still
    // rewrites to the XDG dir instead of freezing at the (empty-sourced)
    // system default.
    accepts("--user rewrites SERVICE_DIR when LUNA_SERVICE_DIR is set to the empty string", {
      argv: ["--user"],
      env: { ...baseEnv(), LUNA_SERVICE_DIR: "" },
    })

    accepts("--user rewrites even an EXPLICIT --service-dir /etc/systemd/system", {
      argv: ["--user", "--service-dir", "/etc/systemd/system"],
    })

    accepts("--user with a non-default --service-dir is not rewritten", {
      argv: ["--user", "--service-dir", "/home/operator/units"],
    })

    // The releases override replaces the repo-dir conventions and, on bare
    // host only, REASSIGNS CONTAINER_DEPLOY_ROOT (:339).
    accepts("--layout releases on a bare host", {
      argv: ["--layout", "releases", "--deploy-root", "/srv/luna-deploy", "--ref", "origin/master"],
    })

    accepts("--layout releases with --incus keeps the container deploy root", {
      argv: ["--layout", "releases", "--deploy-root", "/srv/luna-deploy", "--incus", "luna-dev", "--ref", "origin/master"],
    })

    accepts("--layout releases honours LUNA_CONTAINER_DEPLOY_ROOT under --incus", {
      argv: ["--layout", "releases", "--deploy-root", "/srv/luna-deploy", "--incus", "luna-dev", "--ref", "origin/master"],
      env: { ...baseEnv(), LUNA_CONTAINER_DEPLOY_ROOT: "/root/luna-deploy" },
    })

    accepts("--layout releases --materialize --releases-keep at the boundary value 2", {
      argv: ["--layout", "releases", "--deploy-root", "/srv/luna-deploy", "--releases-keep", "2", "--materialize", "--ref", "origin/master"],
    })

    accepts("--supervisor launchd with launchctl on PATH", {
      argv: ["--supervisor", "launchd"],
      env: baseEnv(TOOLS_WITH_LAUNCHCTL),
    })

    // :237 derives the plist from the label INSIDE the loop, so the two
    // spellings are order-sensitive against each other.
    accepts("--launchd-label AFTER --launchd-plist discards the explicit plist", {
      argv: ["--supervisor", "launchd", "--launchd-plist", "/tmp/explicit.plist", "--launchd-label", "com.example.luna"],
      env: baseEnv(TOOLS_WITH_LAUNCHCTL),
    })

    accepts("--launchd-plist AFTER --launchd-label wins", {
      argv: ["--supervisor", "launchd", "--launchd-label", "com.example.luna", "--launchd-plist", "/tmp/explicit.plist"],
      env: baseEnv(TOOLS_WITH_LAUNCHCTL),
    })

    accepts("LUNA_LAUNCHD_LABEL flows into the default plist path", {
      argv: ["--supervisor", "launchd"],
      env: { ...baseEnv(TOOLS_WITH_LAUNCHCTL), LUNA_LAUNCHD_LABEL: "com.env.luna" },
    })

    accepts("LUNA_LAUNCHD_PLIST beats the label-derived default", {
      argv: ["--supervisor", "launchd"],
      env: { ...baseEnv(TOOLS_WITH_LAUNCHCTL), LUNA_LAUNCHD_LABEL: "com.env.luna", LUNA_LAUNCHD_PLIST: "/etc/plists/luna.plist" },
    })

    // `export HOME="${HOME:-/root}"` (:43) is load-bearing for two paths.
    accepts("an unset HOME defaults to /root and both HOME-derived paths follow", {
      argv: ["--user", "--supervisor", "systemd"],
      env: { PATH: TOOLS },
    })

    accepts("every LUNA_* default is honoured", {
      argv: [],
      env: {
        ...baseEnv(),
        LUNA_PROFILE: "canary",
        LUNA_REPO_DIR: "/env/repo",
        LUNA_HOME: "/env/state",
        LUNA_SERVICE_DIR: "/env/units",
        LUNA_READINESS_PORT: "9999",
        LUNA_READINESS_TIMEOUT: "11",
        LUNA_READINESS_INTERVAL: "7",
        LUNA_READINESS_CURL_MAX_TIME: "13",
        LUNA_RESTART_SETTLE_SECS: "0",
        LUNA_SUPERVISOR: "systemd",
        LUNA_CONTAINER_DEPLOY_ROOT: "/root/luna-deploy",
        LUNA_CONTAINER_ENV_FILE: "/root/.luna/other.env",
        LUNA_UPDATE_STATE_DIR: "/env/update-state",
        LUNA_TEST_BUN_PATH: "/env/bun",
      },
    })

    // `${VAR:-default}` falls back on EMPTY as well as on unset; `?? ` would not.
    accepts("an EMPTY LUNA_PROFILE falls back to stable, exactly like an unset one", {
      argv: [],
      env: { ...baseEnv(), LUNA_PROFILE: "", LUNA_HOME: "", LUNA_READINESS_TIMEOUT: "" },
    })

    // Same `${VAR:-default}` fallback, but for the ONE env var (:934-936) that
    // is never left simply unset in the scenario above - it is always either
    // absent or asserted at a real value ("every LUNA_* default is honoured").
    // A `LUNA_UPDATE_STATE_DIR=""` line (a common EnvironmentFile shape) is
    // UNSET-equivalent to `envOr`, but not to a bare `env[key] ?? dflt`, which
    // would leave `updateStateDir` as "" and derive the lock dir and journal
    // at filesystem root. This scenario is the only one in the suite that
    // exercises the empty-string arm of THIS particular envOr call.
    accepts("an EMPTY LUNA_UPDATE_STATE_DIR falls back to $LUNA_HOME/update, not the filesystem root", {
      argv: [],
      env: { ...baseEnv(), LUNA_HOME: "/srv/state", LUNA_UPDATE_STATE_DIR: "" },
    })

    // SAME-CLASS SWEEP: every OTHER envOr-defaulted LUNA_* key this suite does
    // not already drive empty somewhere above, all set to "" in one scenario.
    // Each is `${VAR:-default}`-shaped in bash (:44-100), so an EXPORTED but
    // empty line - the shape a systemd EnvironmentFile produces for an unset
    // interpolation - must fall back exactly like an absent one. `--incus` is
    // included so LUNA_TEST_BUN_PATH's fallback (bunBinIncus) is exercised
    // too, since that branch only assigns it under --incus.
    accepts("every remaining LUNA_* env default falls back on the empty string too", {
      argv: ["--incus", "luna-dev"],
      env: {
        ...baseEnv(),
        LUNA_READINESS_PORT: "",
        LUNA_READINESS_INTERVAL: "",
        LUNA_READINESS_CURL_MAX_TIME: "",
        LUNA_RESTART_SETTLE_SECS: "",
        LUNA_SUPERVISOR: "",
        LUNA_CONTAINER_DEPLOY_ROOT: "",
        LUNA_CONTAINER_ENV_FILE: "",
        LUNA_LAUNCHD_LABEL: "",
        LUNA_LAUNCHD_PLIST: "",
        LUNA_TEST_BUN_PATH: "",
      },
    })

    accepts("a profile with dots, dashes and underscores keeps its own unit name", {
      argv: ["--profile", "dev_2.eu-west"],
    })

    // `${X// }` strips SPACES only, so a tab-only reason is accepted.
    accepts("--operator-override with a TAB-only reason passes the space-only strip", {
      argv: ["--operator-override", "\t"],
    })

    accepts("--operator-override with a real reason", {
      argv: ["--operator-override", "incident 42: draining before the window closes"],
    })

    accepts("--dry-run", { argv: ["--dry-run"] })

    accepts("repeated flags: the LAST occurrence wins", {
      argv: ["--profile", "one", "--profile", "two", "--ref", "a", "--ref", "b"],
    })
  })

  describe("refuses, in bash's order", () => {
    refuses(
      "--operator-override with a whitespace-only reason",
      { argv: ["--operator-override", "   "] },
      CONFIG_ERRORS.operatorOverrideEmpty,
    )

    refuses(
      "a profile with a path separator",
      { argv: ["--profile", "bad/profile"] },
      CONFIG_ERRORS.invalidProfile,
    )

    refuses(
      "an unknown --layout",
      { argv: ["--layout", "bogus"] },
      CONFIG_ERRORS.invalidLayout("bogus"),
    )

    refuses(
      "--layout releases without --deploy-root",
      { argv: ["--layout", "releases"] },
      CONFIG_ERRORS.releasesNeedsDeployRoot,
    )

    refuses(
      "a relative --deploy-root",
      { argv: ["--layout", "releases", "--deploy-root", "relative/path"] },
      CONFIG_ERRORS.deployRootRelative("relative/path"),
    )

    refuses(
      "--releases-keep below the floor",
      { argv: ["--layout", "releases", "--deploy-root", "/srv/d", "--releases-keep", "1"] },
      CONFIG_ERRORS.releasesKeepTooSmall("1"),
    )

    refuses(
      "a non-integer --releases-keep",
      { argv: ["--layout", "releases", "--deploy-root", "/srv/d", "--releases-keep", "3.5"] },
      CONFIG_ERRORS.releasesKeepTooSmall("3.5"),
    )

    refuses(
      "--materialize off the releases layout",
      { argv: ["--materialize"] },
      CONFIG_ERRORS.materializeNeedsReleases,
    )

    refuses(
      "an unknown --supervisor",
      { argv: ["--supervisor", "sytemd"] },
      CONFIG_ERRORS.invalidSupervisor("sytemd"),
    )

    refuses(
      "--supervisor launchd with --incus",
      { argv: ["--supervisor", "launchd", "--incus", "luna-dev"], env: baseEnv(TOOLS_WITH_LAUNCHCTL) },
      CONFIG_ERRORS.launchdWithIncus,
    )

    refuses(
      "--supervisor launchd with --user",
      { argv: ["--supervisor", "launchd", "--user"], env: baseEnv(TOOLS_WITH_LAUNCHCTL) },
      CONFIG_ERRORS.launchdWithUser,
    )

    // Only reachable because the PATH is hermetic: on a developer Mac
    // /bin/launchctl would always answer.
    refuses(
      "--supervisor launchd with no launchctl on PATH",
      { argv: ["--supervisor", "launchd"] },
      CONFIG_ERRORS.launchdNeedsLaunchctl,
    )

    refuses(
      "--user with --incus",
      { argv: ["--user", "--incus", "luna-dev"] },
      CONFIG_ERRORS.userWithIncus,
    )

    refuses("an unknown flag", { argv: ["--turbo"] }, CONFIG_ERRORS.unknownOption("--turbo"))

    refuses("a bare positional argument", { argv: ["stable"] }, CONFIG_ERRORS.unknownOption("stable"))

    // THE ORDER ROWS. Each of these is valid-looking except for two problems
    // at once; the message names which check runs first, and a port that
    // validated in a "tidier" order would fail exactly here.
    refuses(
      "layout is checked before supervisor",
      { argv: ["--layout", "bogus", "--supervisor", "sytemd"] },
      CONFIG_ERRORS.invalidLayout("bogus"),
    )

    refuses(
      "the releases arm's systemd restriction beats the general supervisor check",
      { argv: ["--layout", "releases", "--deploy-root", "/srv/d", "--supervisor", "sytemd"] },
      CONFIG_ERRORS.releasesNeedsSystemd,
    )

    refuses(
      "--layout releases --supervisor launchd is a releases problem, not a launchd one",
      { argv: ["--layout", "releases", "--deploy-root", "/srv/d", "--supervisor", "launchd"], env: baseEnv(TOOLS_WITH_LAUNCHCTL) },
      CONFIG_ERRORS.releasesNeedsSystemd,
    )

    refuses(
      "the profile check beats the layout check",
      { argv: ["--profile", "bad/profile", "--layout", "bogus"] },
      CONFIG_ERRORS.invalidProfile,
    )

    refuses(
      "the operator-override check beats the profile check",
      { argv: ["--operator-override", " ", "--profile", "bad/profile"] },
      CONFIG_ERRORS.operatorOverrideEmpty,
    )

    refuses(
      "the deploy-root presence check beats its absoluteness check",
      { argv: ["--layout", "releases", "--releases-keep", "0"] },
      CONFIG_ERRORS.releasesNeedsDeployRoot,
    )

    // The absoluteness check (:258) beats the releases-keep integer check
    // (:259-260) - both problems present at once must report the path, not
    // the count.
    refuses(
      "the deploy-root absoluteness check beats the releases-keep check",
      { argv: ["--layout", "releases", "--deploy-root", "relative/path", "--releases-keep", "1"] },
      CONFIG_ERRORS.deployRootRelative("relative/path"),
    )

    // The launchd arm's own two incompatibility checks are order-sensitive
    // against EACH OTHER too: --incus (:275) is tested before --user (:277).
    refuses(
      "--supervisor launchd with both --incus and --user reports the incus incompatibility first",
      { argv: ["--supervisor", "launchd", "--incus", "luna-dev", "--user"], env: baseEnv(TOOLS_WITH_LAUNCHCTL) },
      CONFIG_ERRORS.launchdWithIncus,
    )

    refuses(
      "--supervisor launchd rejects --incus before probing for launchctl",
      { argv: ["--supervisor", "launchd", "--incus", "luna-dev"] },
      CONFIG_ERRORS.launchdWithIncus,
    )
  })

  /**
   * `${2:?missing --flag value}` (:214-236). bash writes its OWN diagnostic
   * here rather than an `error: ` line, so the contract this port keeps is the
   * exit code and the fact that NOTHING is accepted; the message shape is a
   * stated divergence, not a hidden one (see ParseOutcome in config.ts).
   */
  describe("missing and empty flag values", () => {
    const missing = (name: string, argv: ReadonlyArray<string>): void => {
      it(name, () => {
        const env = baseEnv()
        const bash = runBash(argv, env)
        expect(bash.status).toBe(1)
        expect(bash.vars.size, "bash must not have reached the dump").toBe(0)
        const outcome = parseUpdateConfig(argv, env, makeSeams(env))
        expect(outcome.kind).toBe("missing-value")
        if (outcome.kind !== "missing-value") return
        expect(outcome.exitCode).toBe(1)
        expect(outcome.flag).toBe(argv[argv.length - (argv[argv.length - 1] === "" ? 2 : 1)])
        // bash's diagnostic is its own; ours is the `word` from the `${2:?word}`.
        expect(bash.stderr).toContain(outcome.message)
        // The line above is a `toContain`, which a BLANKED `outcome.message`
        // ("") would pass vacuously - every string contains the empty string.
        // Pin the real word too: bash's own diagnostic for `${2:?word}` is
        // always `<script>: line N: 2: <word>`, so the text after the last
        // "2: " on that real, spawned line IS `word` byte-for-byte, and
        // `outcome.message` must equal it exactly (and be non-empty).
        const bashWord = bash.stderr.trimEnd().replace(/^.*: 2: /, "")
        expect(outcome.message.length).toBeGreaterThan(0)
        expect(outcome.message).toBe(bashWord)
      })
    }

    missing("--profile as the last argument", ["--profile"])
    missing("--profile with an EMPTY value (`:?` fires on null too)", ["--profile", ""])
    missing("--ref as the last argument", ["--ref"])
    missing("--incus with an empty value", ["--incus", ""])
    missing("--operator-override as the last argument", ["--operator-override"])
    missing("--launchd-label with an empty value", ["--launchd-label", ""])
    missing("--releases-keep as the last argument", ["--releases-keep"])

    it("every value-taking flag refuses a missing value, and every valueless flag does not", () => {
      const valued = [
        "--profile", "--repo-dir", "--luna-home", "--ref", "--service-dir", "--service-name",
        "--incus", "--readiness-timeout", "--readiness-interval", "--readiness-port",
        "--restart-settle", "--operator-override", "--layout", "--deploy-root",
        "--releases-keep", "--supervisor", "--launchd-label", "--launchd-plist",
      ]
      const valueless = ["--no-rollback", "--restart-only", "--materialize", "--dry-run", "--user"]
      // 23 flags exactly, as the spec counts them (help is not one of them).
      expect(valued.length + valueless.length).toBe(23)

      const env = baseEnv()
      for (const flag of valued) {
        const bash = runBash([flag], env)
        expect(bash.status, `bash accepted a bare ${flag}`).toBe(1)
        expect(parseUpdateConfig([flag], env, makeSeams(env)).kind, flag).toBe("missing-value")
      }
      for (const flag of valueless) {
        // A valueless flag must PARSE (whether the whole config then validates
        // is a separate question - --materialize is refused by the layout arm).
        const outcome = parseUpdateConfig([flag], env, makeSeams(env))
        expect(outcome.kind, flag).not.toBe("missing-value")
      }
    })
  })

  describe("help", () => {
    for (const flag of ["-h", "--help"]) {
      it(`${flag} is recognised and exits 0 without a config`, () => {
        const env = baseEnv()
        // The bash probe is truncated BEFORE `usage` is defined, so it cannot
        // run the help arm; the port's job here is simply to recognise the
        // flag rather than treat it as an unknown option, and main.ts owns the
        // text (spec: the raw-argv preamble, not citty).
        expect(parseUpdateConfig([flag], env, makeSeams(env)).kind).toBe("help")
        expect(parseUpdateConfig(["--profile", "dev", flag], env, makeSeams(env)).kind).toBe("help")
      })
    }
  })

  describe("lunaServiceName matches scripts/lib/luna-deploy.sh", () => {
    for (const profile of ["stable", "dev", "canary", "dev_2.eu-west", "x"]) {
      it(profile, () => {
        const r = spawnSync(
          "bash",
          ["-c", `source ${JSON.stringify(join(LIB_DIR, "luna-deploy.sh"))}\nluna_service_name "$1"`, "_", profile],
          { encoding: "utf8" },
        )
        expect(lunaServiceName(profile)).toBe((r.stdout ?? "").replace(/\n$/, ""))
      })
    }
  })

  /**
   * The delegation decision. It is NOT a bash behaviour - bash has no such
   * concept - so there is nothing to diff; what is asserted is the contract
   * S23's accept gate depends on: exactly one topology runs in the binary,
   * every other one names the flag that sent it to bash, and the marker line
   * is one fixed spelling.
   */
  describe("delegation", () => {
    const env = baseEnv(TOOLS_WITH_LAUNCHCTL)
    const delegationOf = (argv: ReadonlyArray<string>): string | null => {
      const outcome = parseUpdateConfig(argv, env, makeSeams(env))
      if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`)
      return outcome.delegation?.flag ?? null
    }

    it("the one owned topology does not delegate, on bare host and under --incus", () => {
      expect(delegationOf([])).toBeNull()
      expect(delegationOf(["--incus", "luna-dev", "--profile", "dev"])).toBeNull()
      expect(delegationOf(["--restart-only", "--no-rollback", "--ref", "origin/master"])).toBeNull()
    })

    it("every other topology delegates and names its flag", () => {
      expect(delegationOf(["--layout", "releases", "--deploy-root", "/srv/d", "--ref", "origin/master"])).toBe("--layout releases")
      expect(delegationOf(["--supervisor", "launchd"])).toBe("--supervisor launchd")
      expect(delegationOf(["--user"])).toBe("--user")
      expect(delegationOf(["--dry-run"])).toBe("--dry-run")
      // --materialize can only exist on the releases layout (validation
      // :264-265), so the layout is what the marker reports - the flag is
      // declared and parsed all the same.
      expect(delegationOf(["--layout", "releases", "--deploy-root", "/srv/d", "--materialize", "--ref", "origin/master"])).toBe("--layout releases")
    })

    // PRECEDENCE, not just presence: with --user and --dry-run BOTH set, the
    // fixed listing order (spec: layout, supervisor, --user, --dry-run,
    // --materialize) means --user's marker wins. A port that checked dry-run
    // first would report the wrong flag for an identical argv.
    it("--user precedes --dry-run when both are set", () => {
      expect(delegationOf(["--user", "--dry-run"])).toBe("--user")
    })

    // Same precedence claim, one rung higher: --layout releases + --user is a
    // VALID combination (nothing in the validation block forbids it, unlike
    // --supervisor launchd + --user), so this is the one argv that can
    // actually reach delegationFor with BOTH the layout branch and the
    // --user branch true at once. The fixed listing order puts layout first;
    // a port that hoisted the `config.systemdUser` check above the layout
    // check would report "--user" here instead.
    it("--layout releases precedes --user when both are set", () => {
      expect(
        delegationOf(["--layout", "releases", "--deploy-root", "/srv/d", "--user", "--ref", "origin/master"]),
      ).toBe("--layout releases")
    })

    it("the marker line is the one spelling the accept gate greps for", async () => {
      const { delegatedLine } = await import("../../src/update/config.js")
      expect(delegatedLine("--dry-run")).toBe("DELEGATED to bash engine: --dry-run")
    })
  })

  /**
   * THE ORDERING INVARIANT, asserted against the REAL untruncated script.
   *
   * This is what replaces the abandoned purity claim: whatever IO the config
   * block does, it does none of it under a lock, and a refusal therefore never
   * leaves a lock dir (or a state dir, or a journal) behind for the next run's
   * stale-takeover path to reason about.
   */
  describe("no lock is acquired before validation returns", () => {
    const refusals: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
      ["whitespace-only override reason", ["--operator-override", "   "]],
      ["invalid profile", ["--profile", "bad/profile"]],
      ["invalid layout", ["--layout", "bogus"]],
      ["releases without deploy-root", ["--layout", "releases"]],
      ["relative deploy-root", ["--layout", "releases", "--deploy-root", "rel"]],
      ["releases-keep below the floor", ["--layout", "releases", "--deploy-root", "/srv/d", "--releases-keep", "1"]],
      ["materialize off releases", ["--materialize"]],
      ["invalid supervisor", ["--supervisor", "sytemd"]],
      ["user with incus", ["--user", "--incus", "luna-dev"]],
      ["unknown option", ["--turbo"]],
      ["missing flag value", ["--profile"]],
    ]

    for (const [name, argv] of refusals) {
      it(name, () => {
        const state = join(makeTemp("deploy-cli-config-lock-"), "update-state")
        const r = runUpdate([...argv], { LUNA_UPDATE_STATE_DIR: state, LUNA_PROFILE: "stable" })
        expect(r.status, `expected a refusal (stderr: ${r.stderr})`).toBe(1)
        expect(existsSync(state), "the config block created the update state dir").toBe(false)
        expect(existsSync(join(state, "lock-stable")), "a lock was taken before validation returned").toBe(false)

        // And the port refuses the same argv without touching the filesystem
        // at all - it owns no writes, which is what makes the invariant
        // structural rather than incidental.
        const env: Env = { PATH: TOOLS, HOME: "/home/operator", LUNA_UPDATE_STATE_DIR: state }
        const outcome = parseUpdateConfig(argv, env, makeSeams(env))
        expect(outcome.kind === "error" || outcome.kind === "missing-value", `port accepted ${name}`).toBe(true)
        expect(existsSync(state)).toBe(false)
      })
    }

    // The invariant is "no filesystem writes", not "no writes ON A REFUSAL":
    // config.ts derives updateLockDir as a STRING for something else to
    // acquire later (see the header), and must not create it itself even when
    // the whole argv is accepted. The refusal-only rows above cannot catch a
    // write planted on the accept path, so this checks the one case they skip.
    it("parsing an ACCEPTED config creates nothing on disk either", () => {
      const state = join(makeTemp("deploy-cli-config-accept-"), "update-state")
      const env: Env = { PATH: TOOLS, HOME: "/home/operator", LUNA_UPDATE_STATE_DIR: state }
      const outcome = parseUpdateConfig([], env, makeSeams(env))
      expect(outcome.kind).toBe("ok")
      expect(existsSync(state), "config.ts must derive updateStateDir/updateLockDir without creating them").toBe(false)
    })
  })

  it("every UpdateConfig field is diffed against bash", () => {
    const env = baseEnv()
    const outcome = parseUpdateConfig([], env, makeSeams(env))
    if (outcome.kind !== "ok") throw new Error("baseline config did not parse")
    const dumped = new Set(DUMPED.map(([k]) => k))
    const missing = Object.keys(outcome.config).filter((k) => !dumped.has(k as keyof UpdateConfig))
    // A new field with no row in DUMPED would be a value the bash oracle never
    // sees - the exact shape a silent divergence takes.
    expect(missing, "add these to DUMPED with their bash expansion").toEqual([])
  })
})
