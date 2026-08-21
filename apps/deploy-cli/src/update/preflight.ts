/**
 * The pre-mutation checks: a byte-exact port of the whole `--- preflight ---`
 * region of scripts/luna-update-server (:421-530), in bash's own order.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE. Everything here runs BEFORE the update
 * lock is taken and before a single byte of the checkout is touched, and the
 * bash's own comment at :471-477 states the stake plainly: without the
 * unit-existence check the engine "would update the code but have no way to
 * restart the service - a silent half-deploy". A binary that skipped these
 * would mutate a live checkout on a host with no unit to restart it with.
 *
 * ORDER IS THE CONTRACT, NOT AN IMPLEMENTATION DETAIL. An operator sees
 * exactly ONE refusal - the first one - so the sequence is load-bearing:
 *
 *   1. the banner block (:423-440), four mutually exclusive arms
 *   2. the inplace clone check `[[ -d "$HOST_REPO_DIR/.git" ]]` (:468)
 *   3. the unit-existence preflight (:478-497), itself four arms in a fixed
 *      precedence, and skipped entirely under --dry-run / --materialize (:478)
 *   4. default-REF resolution (:510-520) and `Target ref:` (:521)
 *   5. BUN_BIN resolution (:526-530)
 *
 * Swapping 2 and 3 would report "system unit not found" on a host whose real
 * problem is that $HOST_REPO_DIR is not a clone at all, which is why
 * preflight-parity.test.ts drives a fixture where BOTH are broken and asserts
 * which message comes out.
 *
 * IT REFUSES BY RETURNING, NEVER BY EXITING. `luna_die` is `printf 'error: %s\n'
 * >&2; exit 1` (scripts/lib/luna-deploy.sh:6). This port reproduces the string
 * byte for byte in `PreflightRefusal.errorLine` and leaves the exit to main.ts,
 * for the same reason update-flow.ts returns a code: an early process-level
 * exit skips `finally` in Node/Bun, and a preflight that exited would
 * eventually be moved inside a try/finally by somebody and silently stop
 * releasing the lock. (The literal call is spelled out nowhere in this
 * directory on purpose - the S22d spec greps for it as a hard gate.)
 * Nothing here acquires a lock or writes anything, which is the ordering
 * invariant the S22d spec asks preflight to carry - asserted in the parity
 * suite by snapshotting the host tree across every refusal path.
 *
 * COLLABORATORS ARE INJECTED SEAMS, the same shape restart.ts draws around
 * `runSystemctl`: the filesystem probes, the in-container `test -f`, the
 * `rev-parse --abbrev-ref HEAD` read, `luna_find_bun` and stdout itself all
 * arrive as functions. That is what lets the parity harness drive the port and
 * the real bash region over one shared temp tree with no systemd, no incus and
 * no bun. The three that have an obvious hermetic-safe implementation (the two
 * fs probes, plus git/incus via spawnSync) carry defaults; `findBun` does not,
 * because its production implementation is bash-lib.ts's `lunaFindBun`
 * shelling through the co-pinned lib, and a wrong silent default there would
 * hand the deploy a bun that does not exist.
 *
 * OUT OF SCOPE, DELIBERATELY: the releases-layout arm of the repo check
 * (:456-466 - the bare-mirror, refspec and current-release assertions) and the
 * releases "explicit --ref required" refusal (:507-508). `--layout releases` is
 * DELEGATED whole to the bash engine before the lock, so preflight is never
 * reached on that path; porting those refusals would be dead code claiming
 * coverage it does not have. The parity harness therefore drives the extracted
 * bash region with LAYOUT=inplace, and this module takes no layout field at
 * all so there is nothing for a caller to set wrong.
 */
import { spawnSync } from "node:child_process"
import { statSync } from "node:fs"
import { join } from "node:path"
import { stripTrailingNewlines } from "./session-guard.js"

/** `luna_die` exits 1 (scripts/lib/luna-deploy.sh:6); every refusal below carries this. */
export const EXIT_PREFLIGHT_REFUSED = 1

/** `luna_info` (scripts/lib/luna-deploy.sh:4) - `printf '%s\n' "-> $*"`, stdout. */
export const infoLine = (message: string): string => `-> ${message}`

/** `luna_die`'s stderr line (scripts/lib/luna-deploy.sh:6), newline excluded. */
export const errorLine = (message: string): string => `error: ${message}`

/** scripts/luna-update-server:521, byte for byte. */
export const targetRefLine = (ref: string): string => `Target ref: ${ref}`

/** `--supervisor systemd|launchd` (scripts/luna-update-server:229). */
export type Supervisor = "systemd" | "launchd"

/**
 * Everything the banner block reads (scripts/luna-update-server:423-440).
 *
 * `incusContainer` is the empty string when `--incus` was not passed, matching
 * bash's `INCUS_CONTAINER=""` initial state and its `[[ -n ... ]]` test, rather
 * than an optional field - the four arms are selected by exactly that emptiness
 * check and a `?: string` would let a caller express `undefined` vs `""` as if
 * they differed.
 */
export interface PreflightBannerContext {
  readonly profile: string
  readonly incusContainer: string
  readonly supervisor: Supervisor
  readonly systemdUser: boolean
  readonly hostRepoDir: string
  /** Equals hostRepoDir off the incus path (scripts/luna-update-server:320). */
  readonly containerRepoDir: string
  /** `$SERVICE_DIR/$SERVICE_NAME` (:343). */
  readonly serviceFile: string
  readonly launchdLabel: string
  readonly launchdPlist: string
  /** bash's `$UID`, kept a string because it is only ever interpolated. */
  readonly uid: string
}

/**
 * The banner (scripts/luna-update-server:423-440) as the exact lines bash
 * prints, in order. Pure, and the only part of preflight that is: everything
 * below it is IO by nature.
 *
 * THE ARMS ARE EXCLUSIVE AND ORDERED. incus wins over launchd wins over
 * --user wins over bare host, so an incus deploy on a launchd-supervised host
 * prints the incus banner - and then, per :479-482, takes the LAUNCHD arm of
 * the unit check. That asymmetry is bash's, not a port artifact, and it has
 * its own parity scenario.
 *
 * The three-space run in `Repo (in-container):   %s` (:426) is column
 * alignment against the line above it and is reproduced verbatim; an operator
 * diffing two hosts' output would see a whitespace change as a real change.
 */
export const preflightBannerLines = (ctx: PreflightBannerContext): ReadonlyArray<string> => {
  const head = infoLine(`Updating Luna server profile: ${ctx.profile}`)
  if (ctx.incusContainer !== "") {
    return [
      head,
      `Repo (host git mount): ${ctx.hostRepoDir}`,
      `Repo (in-container):   ${ctx.containerRepoDir}`,
      `Service: ${ctx.serviceFile} (in container)`,
      `Target: incus container ${ctx.incusContainer}`,
    ]
  }
  if (ctx.supervisor === "launchd") {
    return [
      head,
      `Repo: ${ctx.hostRepoDir}`,
      `Service: ${ctx.launchdLabel} (launchd plist: ${ctx.launchdPlist})`,
      `Target: macOS launchd (gui/${ctx.uid})`,
    ]
  }
  if (ctx.systemdUser) {
    return [
      head,
      `Repo: ${ctx.hostRepoDir}`,
      `Service: ${ctx.serviceFile} (systemd --user)`,
      "Target: bare host (user scope)",
    ]
  }
  return [head, `Repo: ${ctx.hostRepoDir}`, `Service: ${ctx.serviceFile}`, "Target: bare host"]
}

/** scripts/luna-update-server:468, byte for byte. */
export const notAGitCloneMessage = (hostRepoDir: string): string => `${hostRepoDir} is not a git clone`

/**
 * The four unit-existence refusals (scripts/luna-update-server:480-495), byte
 * for byte. Each bash message is written across a `\`-continued line whose
 * continuation is REMOVED inside the double quotes, so the ported strings are
 * single-line with exactly one space after the `;` - the parity suite compares
 * them against the real script's own expansion rather than against this
 * transcription.
 */
export const unitRefusalMessages = {
  launchd: (plist: string): string =>
    `launchd plist ${plist} not found; create it (e.g. via render_launchd_plist) before running luna-update-server`,
  incus: (serviceFile: string, container: string): string =>
    `system unit ${serviceFile} not found in container ${container}; run luna-server-install inside the container first`,
  systemdUser: (userUnitFile: string): string =>
    `systemd user unit ${userUnitFile} not found; copy or symlink your unit there (e.g. cp my.service ${userUnitFile}) then run systemctl --user daemon-reload`,
  system: (serviceFile: string): string =>
    `system unit ${serviceFile} not found; run luna-server-install to create it, or pass --supervisor launchd / --user for non-system-unit hosts`,
} as const

export interface PreflightSeams {
  /** One fully-formed stdout line, newline excluded - bash's `printf '...\n'`. */
  readonly print: (line: string) => void
  /** `[[ -d <path> ]]`. Defaults to a real `statSync` probe. */
  readonly dirExists?: (path: string) => boolean
  /** `[[ -f <path> ]]`. Defaults to a real `statSync` probe. */
  readonly fileExists?: (path: string) => boolean
  /**
   * `incus exec "$INCUS_CONTAINER" -- test -f "$SERVICE_FILE"` (:485). The unit
   * is a CONTAINER-FS artifact, so a host-side `fileExists` would answer about
   * the wrong filesystem; this is a separate seam for exactly that reason.
   * Defaults to the real `incus exec`.
   */
  readonly containerFileExists?: (container: string, path: string) => boolean
  /**
   * `git -C "$HOST_REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true`
   * (:513): the current branch, `"HEAD"` when detached, and `""` when git
   * itself failed - the `|| true` is what makes a failure indistinguishable
   * from an empty answer, and both fall through to origin/master. Defaults to
   * the real `git`.
   */
  readonly gitCurrentBranch?: (hostRepoDir: string) => string
  /**
   * `luna_find_bun` (scripts/lib/luna-deploy.sh:441-455), reached only off the
   * incus path (:529). NO DEFAULT on purpose: production resolves it through
   * bash-lib.ts against the co-pinned lib, and a plausible-looking default here
   * would hand a deploy a bun path that never existed on the host.
   */
  readonly findBun: () => string
}

export interface PreflightOptions extends PreflightBannerContext, PreflightSeams {
  /** `$SERVICE_DIR/$SERVICE_NAME` under --user (:297); distinct from serviceFile because --user rewrites SERVICE_DIR at :294-296. */
  readonly userUnitFile: string
  /** Both exemptions from the unit check (:478). */
  readonly dryRun: boolean
  readonly materializeOnly: boolean
  /** `--ref` as given; "" means "resolve the default" (:510). A non-empty value passes through VERBATIM, including an abbreviated or uppercase sha. */
  readonly ref: string
  /** `BUN_BIN_INCUS` (:317), the container's bun; used verbatim on the incus path (:527). */
  readonly bunBinIncus: string
}

export interface PreflightSuccess {
  readonly ok: true
  /** REF after default resolution; the value `Target ref:` printed. */
  readonly ref: string
  /** BUN_BIN as bash would have set it. */
  readonly bunBin: string
}

export interface PreflightRefusal {
  readonly ok: false
  readonly exitCode: typeof EXIT_PREFLIGHT_REFUSED
  /** `luna_die`'s argument, without the prefix. */
  readonly message: string
  /** The byte-exact stderr line, newline excluded. */
  readonly errorLine: string
  /** Which check refused, for callers that want to branch without string-matching. */
  readonly check: "git-clone" | "unit"
}

export type PreflightOutcome = PreflightSuccess | PreflightRefusal

const realDirExists = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const realFileExists = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const realContainerFileExists = (container: string, path: string): boolean => {
  const r = spawnSync("incus", ["exec", container, "--", "test", "-f", path])
  return r.status === 0
}

/**
 * `$(git -C <dir> rev-parse --abbrev-ref HEAD 2>/dev/null || true)`: command
 * substitution strips ALL trailing newlines, and the `|| true` collapses any
 * failure to the empty string, so a non-zero exit and an empty stdout are the
 * same answer here.
 */
const realGitCurrentBranch = (hostRepoDir: string): string => {
  const r = spawnSync("git", ["-C", hostRepoDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" })
  if (r.status !== 0) return ""
  return stripTrailingNewlines(r.stdout ?? "")
}

const refuse = (check: PreflightRefusal["check"], message: string): PreflightRefusal => ({
  ok: false,
  exitCode: EXIT_PREFLIGHT_REFUSED,
  message,
  errorLine: errorLine(message),
  check,
})

/**
 * The unit-existence preflight (scripts/luna-update-server:478-497): undefined
 * when it passes, the refusal otherwise.
 *
 * THE EXEMPTION IS TWO FLAGS, NOT ONE (:478). --dry-run prints a plan and
 * touches nothing, so a missing unit must not block an inspection of what
 * WOULD happen; --materialize is the inert releases bootstrap that issues no
 * restart at all and deliberately runs while units still name the old layout.
 * Either one skips the whole block, including the incus probe - which also
 * means a dry run never shells out to `incus`.
 */
export const unitPreflightSync = (
  opts: Pick<
    PreflightOptions,
    | "dryRun"
    | "materializeOnly"
    | "supervisor"
    | "incusContainer"
    | "systemdUser"
    | "launchdPlist"
    | "serviceFile"
    | "userUnitFile"
  > &
    Pick<PreflightSeams, "fileExists" | "containerFileExists">,
): PreflightRefusal | undefined => {
  if (opts.dryRun || opts.materializeOnly) return undefined
  const fileExists = opts.fileExists ?? realFileExists
  const containerFileExists = opts.containerFileExists ?? realContainerFileExists

  if (opts.supervisor === "launchd") {
    if (fileExists(opts.launchdPlist)) return undefined
    return refuse("unit", unitRefusalMessages.launchd(opts.launchdPlist))
  }
  if (opts.incusContainer !== "") {
    if (containerFileExists(opts.incusContainer, opts.serviceFile)) return undefined
    return refuse("unit", unitRefusalMessages.incus(opts.serviceFile, opts.incusContainer))
  }
  if (opts.systemdUser) {
    if (fileExists(opts.userUnitFile)) return undefined
    return refuse("unit", unitRefusalMessages.systemdUser(opts.userUnitFile))
  }
  if (fileExists(opts.serviceFile)) return undefined
  return refuse("unit", unitRefusalMessages.system(opts.serviceFile))
}

/**
 * Default-REF resolution (scripts/luna-update-server:510-520): the
 * remote-tracking branch of whatever is checked out, falling back to
 * origin/master when the checkout is detached (`rev-parse --abbrev-ref HEAD`
 * answers the literal string `HEAD`) or when git could not answer at all.
 *
 * git runs HOST-side in both topologies, because HOST_REPO_DIR is the
 * bind-mount source the host can always stat (:501-502) - so there is no incus
 * arm here, and the `-d "$HOST_REPO_DIR/.git"` re-test at :512 is kept even
 * though the clone check above already proved it: dropping it would change
 * which seam gets called on a caller that skipped the clone check.
 */
export const resolveDefaultRefSync = (
  opts: Pick<PreflightOptions, "ref" | "hostRepoDir"> & Pick<PreflightSeams, "dirExists" | "gitCurrentBranch">,
): string => {
  if (opts.ref !== "") return opts.ref
  const dirExists = opts.dirExists ?? realDirExists
  const gitCurrentBranch = opts.gitCurrentBranch ?? realGitCurrentBranch
  let currentBranch = ""
  if (dirExists(join(opts.hostRepoDir, ".git"))) currentBranch = gitCurrentBranch(opts.hostRepoDir)
  if (currentBranch !== "" && currentBranch !== "HEAD") return `origin/${currentBranch}`
  return "origin/master"
}

/**
 * The whole preflight region, in bash's order (scripts/luna-update-server:
 * 421-530). Prints through the `print` seam as it goes - the banner is emitted
 * BEFORE any refusal, exactly as bash does, so an operator who gets a refusal
 * still sees which host/service/target the engine was talking about.
 *
 * Performs no mutation and takes no lock; see this module's header.
 */
export const runPreflightSync = (opts: PreflightOptions): PreflightOutcome => {
  for (const line of preflightBannerLines(opts)) opts.print(line)

  const dirExists = opts.dirExists ?? realDirExists
  if (!dirExists(join(opts.hostRepoDir, ".git"))) {
    return refuse("git-clone", notAGitCloneMessage(opts.hostRepoDir))
  }

  const unitRefusal = unitPreflightSync(opts)
  if (unitRefusal !== undefined) return unitRefusal

  const ref = resolveDefaultRefSync(opts)
  opts.print(targetRefLine(ref))

  const bunBin = opts.incusContainer !== "" ? opts.bunBinIncus : opts.findBun()
  return { ok: true, ref, bunBin }
}
