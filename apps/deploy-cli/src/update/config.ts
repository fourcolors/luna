/**
 * The `update` command's argument parser, its validation block, and every path
 * it derives - the top-level preamble of scripts/luna-update-server:44-343
 * (env defaults :44-100, flag defaults :169-211, the 23-flag `while`/`case`
 * :213-241, the validation block :243-283, the SERVICE_NAME/SERVICE_DIR
 * derivations :285-297, the git-on-host / rest-in-container path split
 * :302-330, the releases override :333-340, ENV_FILE/SERVICE_FILE :342-343),
 * plus UPDATE_STATE_DIR and its two children (:934-936) and BUN_BIN (:524-530).
 *
 * WHY THIS IS ONE MODULE AND NOT THREE. In bash these are not three phases;
 * they are one straight-line block whose ORDER is the contract. `--layout
 * releases --supervisor sytemd` dies with "supports only the systemd
 * supervisor" (:262-263) and NOT with "invalid --supervisor" (:271-272),
 * because the releases arm runs first. `--launchd-plist X --launchd-label Y`
 * ends up at $HOME/Library/LaunchAgents/Y.plist, discarding X, because the
 * label's plist derivation happens INSIDE the parse loop (:237) rather than
 * after it. Splitting the block into "parse" and "validate" and "derive"
 * modules would let a future edit reorder them without any test noticing, and
 * every one of those reorderings is a different set of operator-facing errors
 * for the same argv.
 *
 * THE PORT IS NOT PURE, AND THE DRAFT'S CLAIM THAT IT WAS IS THE ONE THING
 * CORRECTED HERE. Three impurities are real and none of them can be designed
 * away:
 *
 *   - `luna_validate_profile "$PROFILE"` (:248) is a shell-library function.
 *     The spec routes bash-lib calls through `bash -c 'source luna-deploy.sh
 *     && ...'`, so it arrives here as the injected `validateProfile` seam.
 *   - `command -v launchctl` (:281) probes PATH. Injected as `hasLaunchctl`.
 *   - `--launchd-label` reads $HOME at parse time (:237), and `export
 *     HOME="${HOME:-/root}"` (:43) means $HOME is itself a defaulted env read.
 *     The whole environment therefore arrives as `env`, never as `process.env`
 *     read from inside.
 *
 * WHAT REPLACES PURITY IS AN ORDERING INVARIANT: no lock acquisition happens
 * before this function returns. That is a property of the ASSEMBLY, not of
 * this file, and it is testable in a way purity never was - config-parity
 * asserts the real bash script leaves $UPDATE_STATE_DIR/lock-$PROFILE absent
 * on every refusal path, and this module contributes to it by owning no
 * filesystem writes at all. `updateLockDir` is DERIVED here and acquired
 * elsewhere precisely so the two cannot be confused.
 *
 * EVERY FLAG IS DECLARED, INCLUDING THE ONES THAT DELEGATE. `--deploy-root`
 * only means anything on the releases layout, which this binary hands whole to
 * bash - but if the binary did not declare it, `--deploy-root /srv/luna` would
 * fall through to `unknown option` on some paths and be silently dropped on
 * others. Worse, an operator typing `--readiness-timeout 600` on a delegated
 * topology must get 600 seconds, not the 60-second default, and the only way
 * to guarantee that is to parse the flag here and forward the ORIGINAL argv
 * (delegate.ts's job) rather than a reconstruction.
 *
 * NUMERIC FLAGS STAY STRINGS. bash never coerces READINESS_TIMEOUT,
 * READINESS_INTERVAL, READINESS_PORT or RESTART_SETTLE_SECS - `--readiness-
 * interval 0.3` is a perfectly good bash value and the hermetic fixtures pass
 * exactly that (bash-fixtures.ts). Parsing them to `number` here would
 * introduce a coercion bash does not have, and would have to invent a
 * behaviour for values bash simply passes through to `sleep`. The consumer
 * that needs a number converts at its own boundary.
 *
 * OUT OF SCOPE: the usage text (:101-186) and the `-h/--help` output, which
 * main.ts prints from its raw-argv preamble so it survives NODE_ENV=test;
 * GUARD_SESSIONS / FORWARD_RESTART_RAN (:76-78), which are flow state rather
 * than configuration; and RESTART_PRESTART_HOOK (:184), which only the
 * releases layout ever sets and which this binary therefore never reaches.
 */

/** `luna_die` exits 1 (scripts/lib/luna-deploy.sh:6); so does every refusal here. */
export const EXIT_CONFIG_ERROR = 1

export type Supervisor = "systemd" | "launchd"
export type Layout = "inplace" | "releases"

/** The process environment, read once and passed in. See the header on why nothing here reads `process.env`. */
export type Env = Readonly<Record<string, string | undefined>>

/**
 * `${VAR:-default}`: bash's `:-` falls back on UNSET *and* on empty, which is
 * why this cannot be `env[key] ?? dflt`. `LUNA_PROFILE=` on the command line
 * yields "stable", not "".
 */
const envOr = (env: Env, key: string, dflt: string): string => {
  const v = env[key]
  return v === undefined || v === "" ? dflt : v
}

/** `[[ -n "${LUNA_SERVICE_DIR:-}" ]]` - set AND non-empty. */
const envSet = (env: Env, key: string): boolean => {
  const v = env[key]
  return v !== undefined && v !== ""
}

/**
 * `luna_service_name` (scripts/lib/luna-deploy.sh:187-193), ported rather than
 * shelled: it is a total two-branch function over a string the validation
 * block has already constrained, it is not in the spec's bash-lib call list,
 * and a subprocess per invocation would buy nothing. config-parity diffs it
 * against the real lib function anyway.
 */
export const lunaServiceName = (profile: string): string =>
  profile === "stable" ? "luna-chat-server.service" : `luna-${profile}-chat-server.service`

/**
 * Collaborators this port cannot perform itself. Both are IO in bash and stay
 * IO here; see the header.
 */
export interface ConfigSeams {
  /**
   * `luna_validate_profile "$PROFILE"` (:248), which dies unless the profile
   * matches `^[A-Za-z0-9._-]+$` (scripts/lib/luna-deploy.sh:182-185). Returns
   * true when the profile is acceptable; the refusal message is emitted here
   * so `error: ` lines stay greppable in one file.
   */
  readonly validateProfile: (profile: string) => boolean
  /** `command -v launchctl >/dev/null 2>&1` (:281). */
  readonly hasLaunchctl: () => boolean
}

/** Byte-exact refusal messages, in the order the bash block can emit them. Each is the argument to `luna_die`, so the operator sees `error: <message>`. */
export const CONFIG_ERRORS = {
  /** :246-247 */
  operatorOverrideEmpty: "--operator-override requires a non-empty reason",
  /** scripts/lib/luna-deploy.sh:183-184, reached through :248 */
  invalidProfile: "profile must contain only letters, numbers, dot, underscore, or dash",
  /** :253-254 */
  invalidLayout: (layout: string): string =>
    `invalid --layout: '${layout}' (expected 'inplace' or 'releases')`,
  /** :256-257 */
  releasesNeedsDeployRoot:
    "--layout releases requires --deploy-root (the registry passes it; see docs/deploy-layout-migration.md)",
  /** :258 */
  deployRootRelative: (deployRoot: string): string =>
    `--deploy-root must be an absolute path (got '${deployRoot}')`,
  /** :259-260 */
  releasesKeepTooSmall: (keep: string): string =>
    `--releases-keep must be an integer >= 2 (got '${keep}')`,
  /** :261-262 */
  releasesNeedsSystemd: "--layout releases supports only the systemd supervisor",
  /** :265 */
  materializeNeedsReleases: "--materialize requires --layout releases",
  /** :271-272 */
  invalidSupervisor: (supervisor: string): string =>
    `invalid --supervisor: '${supervisor}' (expected 'systemd' or 'launchd')`,
  /** :275 */
  launchdWithIncus:
    "--supervisor launchd is incompatible with --incus (launchd is macOS-only; containers run Linux systemd)",
  /** :277 */
  launchdWithUser:
    "--supervisor launchd is incompatible with --user (launchd has no system/user unit split)",
  /** :279 */
  launchdNeedsLaunchctl: "--supervisor launchd requires launchctl (not found in PATH)",
  /** :282-283 */
  userWithIncus:
    "--user is incompatible with --incus (user units run on the bare host, not inside a container)",
  /** :239 */
  unknownOption: (arg: string): string => `unknown option: ${arg}`,
} as const

/**
 * The resolved configuration: one field per bash variable that survives the
 * preamble, named after it. Nothing is renamed for taste - an operator
 * comparing a binary run against a bash host reads the same nouns.
 */
export interface UpdateConfig {
  /** `export HOME="${HOME:-/root}"` (:43). Load-bearing: two derived paths read it. */
  readonly home: string

  readonly profile: string
  /** `REPO_DIR` (:57) - the operator-facing path, before the host/container split. */
  readonly repoDir: string
  /** `REPO_DIR_EXPLICIT` (:58-59): did the operator pass --repo-dir / LUNA_REPO_DIR? Only the incus arm reads it (:305-309). */
  readonly repoDirExplicit: boolean
  readonly lunaHome: string
  readonly serviceDir: string
  readonly serviceName: string
  /** Empty when the operator passed no --ref; preflight resolves the default (:508-520). */
  readonly ref: string
  /** Empty on a bare host. */
  readonly incusContainer: string
  readonly dryRun: boolean
  /** `ROLLBACK` (:65); false under --no-rollback. */
  readonly rollback: boolean
  readonly operatorOverrideReason: string
  readonly restartOnly: boolean

  /** Readiness knobs, kept as written - see the header on why these are not numbers. */
  readonly readinessPort: string
  readonly readinessTimeout: string
  readonly readinessInterval: string
  readonly readinessCurlMaxTime: string
  readonly restartSettleSecs: string

  readonly supervisor: Supervisor
  /** `SYSTEMD_USER` (:170) - the --user flag. */
  readonly systemdUser: boolean

  readonly layout: Layout
  readonly deployRoot: string
  /** `RELEASES_KEEP` (:182), as written; validated to be an integer >= 2 only on the releases layout. */
  readonly releasesKeep: string
  readonly materializeOnly: boolean
  /** `CONTAINER_DEPLOY_ROOT` (:186) - REASSIGNED to $DEPLOY_ROOT on releases+bare-host (:339). */
  readonly containerDeployRoot: string
  readonly containerEnvFile: string

  readonly launchdLabel: string
  readonly launchdPlist: string

  /** Releases-layout paths (:334-337); empty strings on the inplace layout, exactly as bash leaves them (:188-191). */
  readonly mirrorGit: string
  readonly releasesDir: string
  readonly currentLink: string
  readonly previousLink: string

  /** Where `git` runs - ALWAYS host-side (:303-311, :338). */
  readonly hostRepoDir: string
  /** Where `bun`/`systemctl` work - inside the container in incus mode (:312-313, :340-341). */
  readonly containerRepoDir: string
  /** The in-container bun, incl. the LUNA_TEST_BUN_PATH hermetic seam (:317). Empty on a bare host, where bash leaves BUN_BIN_INCUS unset. */
  readonly bunBinIncus: string

  readonly userUnitFile: string
  readonly envFile: string
  readonly serviceFile: string

  readonly updateStateDir: string
  readonly updateLockDir: string
  readonly updateJournal: string
}

/**
 * Why the run is being handed to bash, and the exact flag spelling the marker
 * line names. See `delegationFor`.
 */
export interface Delegation {
  readonly flag: string
}

/**
 * The stable stderr marker S23's accept gate greps for. One line, one
 * spelling: a run that emitted this did NOT prove the binary deployed
 * anything, and the gate must be able to say so without parsing prose.
 */
export const delegatedLine = (flag: string): string => `DELEGATED to bash engine: ${flag}`

/**
 * The delegation decision. The binary owns exactly one topology - LAYOUT=
 * inplace + SUPERVISOR=systemd, system scope, a real (non-dry) run - on both
 * bare-host and incus. Everything else is handed to $LUNA_DEPLOY_BASH_ENGINE
 * whole.
 *
 * DELEGATION, NOT REFUSAL, and the difference matters at 3am: a refusal is a
 * stopped deploy, while a delegation is the same deploy the host would have
 * got before this binary existed.
 *
 * PRECEDENCE IS FIXED so the marker is deterministic for the same argv. It
 * follows the spec's own listing order. `--materialize` is declared and
 * parsed (see the parse loop) but has NO branch of its own here: validation
 * (:264-265) already rejects it off the releases layout, so
 * `config.materializeOnly` is true only when `config.layout === "releases"`,
 * which the FIRST branch below already catches. A `--materialize` branch at
 * the end of this function would therefore be dead code reachable through no
 * call of `delegationFor` from `parseUpdateConfig` (its one caller) - so it
 * is omitted rather than kept as an arm nothing can ever take. If a future
 * change lets `--materialize` exist off the releases layout, add its branch
 * back here, ordered last per the spec's listing.
 *
 * Call this AFTER validation, never before: `--layout bogus` must exit 1 with
 * bash's message, not delegate a typo to a bash engine that will reject it
 * with the same message one process later.
 */
export const delegationFor = (config: UpdateConfig): Delegation | null => {
  if (config.layout !== "inplace") return { flag: `--layout ${config.layout}` }
  if (config.supervisor !== "systemd") return { flag: `--supervisor ${config.supervisor}` }
  if (config.systemdUser) return { flag: "--user" }
  if (config.dryRun) return { flag: "--dry-run" }
  return null
}

/**
 * `BUN_BIN` (:524-530). In incus mode the host's bun does not exist inside the
 * container, so the container's path (already resolved at :317, hermetic seam
 * included) wins; on a bare host it is `luna_find_bun`, which is a bash-lib
 * call and therefore a seam.
 *
 * This lives in config.ts rather than at its bash line number because it is
 * pure path resolution over already-parsed configuration, and because
 * BUN_BIN_INCUS - the half that carries LUNA_TEST_BUN_PATH - is resolved 200
 * lines earlier in the same preamble. Keeping the two arms apart is how a port
 * ends up with a bare-host bun inside a container.
 */
export const resolveBunBin = (config: UpdateConfig, findBun: () => string): string =>
  config.incusContainer !== "" ? config.bunBinIncus : findBun()

export type ParseOutcome =
  /** `-h|--help) usage; exit 0` (:238). main.ts owns the text. */
  | { readonly kind: "help" }
  /**
   * `${2:?missing --flag value}` (:214-236). bash's own runtime diagnostic
   * goes to stderr in bash's shape (`bash: 2: missing --profile value`), NOT
   * through luna_die - so the parity contract for this path is the EXIT CODE,
   * and `message` is what this binary prints instead. Kept as its own variant
   * rather than folded into "error" so that divergence stays visible in the
   * type instead of being asserted away in a test.
   */
  | { readonly kind: "missing-value"; readonly exitCode: 1; readonly flag: string; readonly message: string }
  /** Any `luna_die` in the parse loop or the validation block: `error: <message>` on stderr, exit 1. */
  | { readonly kind: "error"; readonly exitCode: 1; readonly message: string }
  | { readonly kind: "ok"; readonly config: UpdateConfig; readonly delegation: Delegation | null }

const missingValue = (flag: string, word: string): ParseOutcome => ({
  kind: "missing-value",
  exitCode: EXIT_CONFIG_ERROR,
  flag,
  message: word,
})

const configError = (message: string): ParseOutcome => ({
  kind: "error",
  exitCode: EXIT_CONFIG_ERROR,
  message,
})

/** `[[ "$RELEASES_KEEP" =~ ^[0-9]+$ ]]` (:259). */
const DIGITS = /^[0-9]+$/

/**
 * Parse `argv` (the flags AFTER the `update` subcommand token), validate it in
 * bash's order, and derive every path the rest of the run reads.
 *
 * ORDER IS THE CONTRACT. The refusals below are sequenced exactly as
 * scripts/luna-update-server:243-283 sequences them; reordering any two of
 * them changes which error an operator sees for the same argv, which is a
 * behaviour change wearing a refactor's clothes.
 */
export function parseUpdateConfig(
  argv: ReadonlyArray<string>,
  env: Env,
  seams: ConfigSeams,
): ParseOutcome {
  // :43 - HOME is defaulted and EXPORTED before anything reads it, so the two
  // derivations that interpolate it (--launchd-label's plist, --user's
  // SERVICE_DIR) see /root on a host with no HOME rather than an empty path.
  const home = envOr(env, "HOME", "/root")

  // --- env-sourced defaults (:44-100, :168-192) ------------------------------
  let profile = envOr(env, "LUNA_PROFILE", "stable")
  let repoDir = envOr(env, "LUNA_REPO_DIR", "/root/luna")
  let repoDirExplicit = envSet(env, "LUNA_REPO_DIR")
  let lunaHome = envOr(env, "LUNA_HOME", "/root/.luna")
  let serviceDir = envOr(env, "LUNA_SERVICE_DIR", "/etc/systemd/system")
  let serviceName = ""
  let ref = ""
  let incusContainer = ""
  let dryRun = false
  let rollback = true
  let operatorOverrideReason = ""
  let restartOnly = false
  let readinessPort = envOr(env, "LUNA_READINESS_PORT", "4753")
  let readinessTimeout = envOr(env, "LUNA_READINESS_TIMEOUT", "60")
  let readinessInterval = envOr(env, "LUNA_READINESS_INTERVAL", "2")
  const readinessCurlMaxTime = envOr(env, "LUNA_READINESS_CURL_MAX_TIME", "5")
  let restartSettleSecs = envOr(env, "LUNA_RESTART_SETTLE_SECS", "6")
  let supervisorRaw = envOr(env, "LUNA_SUPERVISOR", "systemd")
  let systemdUser = false
  let layoutRaw = "inplace"
  let deployRoot = ""
  let releasesKeep = "3"
  let materializeOnly = false
  let containerDeployRoot = envOr(env, "LUNA_CONTAINER_DEPLOY_ROOT", "/root/luna")
  const containerEnvFile = envOr(env, "LUNA_CONTAINER_ENV_FILE", "/root/.luna/.env")
  let launchdLabel = envOr(env, "LUNA_LAUNCHD_LABEL", "com.user.luna-chat-server")
  let launchdPlist = envOr(
    env,
    "LUNA_LAUNCHD_PLIST",
    `${home}/Library/LaunchAgents/${launchdLabel}.plist`,
  )

  // --- the 23-flag parse loop (:213-241) -------------------------------------
  // `${2:?...}` rejects a missing value AND an empty one (`:?` fires on null),
  // so `--profile ""` is a refusal, not a profile named "".
  const valueAt = (i: number): string | null => {
    const v = argv[i + 1]
    return v === undefined || v === "" ? null : v
  }

  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    if (arg === undefined) break
    switch (arg) {
      case "--profile": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --profile value")
        profile = v
        i += 2
        break
      }
      case "--repo-dir": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --repo-dir value")
        repoDir = v
        repoDirExplicit = true
        i += 2
        break
      }
      case "--luna-home": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --luna-home value")
        lunaHome = v
        i += 2
        break
      }
      case "--ref": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --ref value")
        ref = v
        i += 2
        break
      }
      case "--service-dir": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --service-dir value")
        serviceDir = v
        i += 2
        break
      }
      case "--service-name": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --service-name value")
        serviceName = v
        i += 2
        break
      }
      case "--incus": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --incus value")
        incusContainer = v
        i += 2
        break
      }
      case "--readiness-timeout": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --readiness-timeout value")
        readinessTimeout = v
        i += 2
        break
      }
      case "--readiness-interval": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --readiness-interval value")
        readinessInterval = v
        i += 2
        break
      }
      case "--readiness-port": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --readiness-port value")
        readinessPort = v
        i += 2
        break
      }
      case "--restart-settle": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --restart-settle value")
        restartSettleSecs = v
        i += 2
        break
      }
      case "--no-rollback":
        rollback = false
        i += 1
        break
      case "--operator-override": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --operator-override reason")
        operatorOverrideReason = v
        i += 2
        break
      }
      case "--restart-only":
        restartOnly = true
        i += 1
        break
      case "--layout": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --layout value")
        layoutRaw = v
        i += 2
        break
      }
      case "--deploy-root": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --deploy-root value")
        deployRoot = v
        i += 2
        break
      }
      case "--releases-keep": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --releases-keep value")
        releasesKeep = v
        i += 2
        break
      }
      case "--materialize":
        materializeOnly = true
        i += 1
        break
      case "--dry-run":
        dryRun = true
        i += 1
        break
      case "--supervisor": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --supervisor value")
        supervisorRaw = v
        i += 2
        break
      }
      case "--user":
        systemdUser = true
        i += 1
        break
      case "--launchd-label": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --launchd-label value")
        launchdLabel = v
        // :237, and the order-sensitivity is deliberate on bash's side: the
        // plist is RE-DERIVED here, so a --launchd-plist that came EARLIER on
        // the command line is discarded. A port that derived the plist after
        // the loop would silently keep it.
        launchdPlist = `${home}/Library/LaunchAgents/${launchdLabel}.plist`
        i += 2
        break
      }
      case "--launchd-plist": {
        const v = valueAt(i)
        if (v === null) return missingValue(arg, "missing --launchd-plist value")
        launchdPlist = v
        i += 2
        break
      }
      case "-h":
      case "--help":
        return { kind: "help" }
      default:
        return configError(CONFIG_ERRORS.unknownOption(arg))
    }
  }

  // --- validation block (:243-283), in bash's order --------------------------

  // :245-247. `${X// }` strips SPACES only (not tabs), so a tab-only reason
  // passes bash's check; reproduce that rather than the "obvious" trim.
  if (operatorOverrideReason !== "" && operatorOverrideReason.split(" ").join("") === "") {
    return configError(CONFIG_ERRORS.operatorOverrideEmpty)
  }

  // :248
  if (!seams.validateProfile(profile)) return configError(CONFIG_ERRORS.invalidProfile)

  // :252-254
  if (layoutRaw !== "inplace" && layoutRaw !== "releases") {
    return configError(CONFIG_ERRORS.invalidLayout(layoutRaw))
  }
  const layout: Layout = layoutRaw

  // :255-266. Note this arm runs BEFORE the general --supervisor value check,
  // so `--layout releases --supervisor sytemd` reports the releases
  // restriction, not the typo.
  if (layout === "releases") {
    if (deployRoot === "") return configError(CONFIG_ERRORS.releasesNeedsDeployRoot)
    if (!deployRoot.startsWith("/")) return configError(CONFIG_ERRORS.deployRootRelative(deployRoot))
    if (!DIGITS.test(releasesKeep) || Number(releasesKeep) < 2) {
      return configError(CONFIG_ERRORS.releasesKeepTooSmall(releasesKeep))
    }
    if (supervisorRaw !== "systemd") return configError(CONFIG_ERRORS.releasesNeedsSystemd)
  } else if (materializeOnly) {
    return configError(CONFIG_ERRORS.materializeNeedsReleases)
  }

  // :271-272
  if (supervisorRaw !== "systemd" && supervisorRaw !== "launchd") {
    return configError(CONFIG_ERRORS.invalidSupervisor(supervisorRaw))
  }
  const supervisor: Supervisor = supervisorRaw

  // :273-280
  if (supervisor === "launchd") {
    if (incusContainer !== "") return configError(CONFIG_ERRORS.launchdWithIncus)
    if (systemdUser) return configError(CONFIG_ERRORS.launchdWithUser)
    if (!seams.hasLaunchctl()) return configError(CONFIG_ERRORS.launchdNeedsLaunchctl)
  }

  // :281-283
  if (systemdUser && incusContainer !== "") return configError(CONFIG_ERRORS.userWithIncus)

  // --- derivations (:285-343, :934-936) --------------------------------------

  // :285-287
  if (serviceName === "") serviceName = lunaServiceName(profile)

  // :294-296. The LUNA_SERVICE_DIR test is on the ENV, not on the resolved
  // value: an operator who exported LUNA_SERVICE_DIR=/etc/systemd/system keeps
  // it under --user, while one who exported nothing gets the XDG user dir.
  if (systemdUser && !envSet(env, "LUNA_SERVICE_DIR") && serviceDir === "/etc/systemd/system") {
    serviceDir = `${home}/.config/systemd/user`
  }
  const userUnitFile = `${serviceDir}/${serviceName}`

  // :302-330 - the git-on-host / rest-in-container split.
  let hostRepoDir: string
  let containerRepoDir: string
  let bunBinIncus = ""
  if (incusContainer !== "") {
    hostRepoDir = repoDirExplicit ? repoDir : `/root/luna/${profile}/repo`
    containerRepoDir = "/root/luna"
    bunBinIncus = envOr(env, "LUNA_TEST_BUN_PATH", "/root/.bun/bin/bun")
  } else {
    hostRepoDir = repoDir
    containerRepoDir = repoDir
  }

  // :333-341 - the releases override, which REPLACES the repo-dir conventions
  // above (and, on bare-host, rewrites CONTAINER_DEPLOY_ROOT in place at :339).
  let mirrorGit = ""
  let releasesDir = ""
  let currentLink = ""
  let previousLink = ""
  if (layout === "releases") {
    mirrorGit = `${deployRoot}/mirror.git`
    releasesDir = `${deployRoot}/releases`
    currentLink = `${deployRoot}/current`
    previousLink = `${deployRoot}/previous`
    hostRepoDir = currentLink
    if (incusContainer !== "") {
      containerRepoDir = `${containerDeployRoot}/current`
    } else {
      containerRepoDir = currentLink
      containerDeployRoot = deployRoot
    }
  }

  const envFile = `${lunaHome}/.env`
  const serviceFile = `${serviceDir}/${serviceName}`

  // :934-936. Derived here, acquired elsewhere - see the header's ordering
  // invariant.
  const updateStateDir = envOr(env, "LUNA_UPDATE_STATE_DIR", `${lunaHome}/update`)

  const config: UpdateConfig = {
    home,
    profile,
    repoDir,
    repoDirExplicit,
    lunaHome,
    serviceDir,
    serviceName,
    ref,
    incusContainer,
    dryRun,
    rollback,
    operatorOverrideReason,
    restartOnly,
    readinessPort,
    readinessTimeout,
    readinessInterval,
    readinessCurlMaxTime,
    restartSettleSecs,
    supervisor,
    systemdUser,
    layout,
    deployRoot,
    releasesKeep,
    materializeOnly,
    containerDeployRoot,
    containerEnvFile,
    launchdLabel,
    launchdPlist,
    mirrorGit,
    releasesDir,
    currentLink,
    previousLink,
    hostRepoDir,
    containerRepoDir,
    bunBinIncus,
    userUnitFile,
    envFile,
    serviceFile,
    updateStateDir,
    updateLockDir: `${updateStateDir}/lock-${profile}`,
    updateJournal: `${updateStateDir}/transaction-${profile}`,
  }

  return { kind: "ok", config, delegation: delegationFor(config) }
}
