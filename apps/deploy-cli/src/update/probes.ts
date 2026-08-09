/**
 * The concrete probes readiness.ts and restart.ts declare as seams but
 * deliberately refuse to implement: `sup_is_active` (scripts/luna-update-server:
 * 1387-1397), `sup_restart_count` (:1405-1413), the two readiness curls inside
 * `readiness_ok` (:1084-1091), bash's `SECONDS`/`sleep "$READINESS_INTERVAL"`
 * (:1071, :1124), and the systemctl transport `restart_service` drives through
 * `sup_reload`/`sup_stop`/`sup_start` (:1308-1381).
 *
 * WHY THESE LIVE IN ONE FILE RATHER THAN IN THE MODULES THAT CONSUME THEM.
 * readiness.ts:43-47 and restart.ts:12-19 each carry a paragraph saying the
 * incus routing is out of their scope; session-guard.ts scopes itself to the
 * bare host the same way. Those are three separate statements of ONE gap, and
 * this module is where it closes: every probe below takes an injected
 * `RunTargetCapture` and never decides for itself whether a command runs on the
 * host or inside a container. The topology decision is target.ts's - the
 * `run_target_capture` waist at scripts/luna-update-server:361-369 - and it
 * arrives here as a function parameter, so probes.ts is topology-blind and a
 * test can drive every scenario without a container, a systemd, or a network.
 * That is also why this file has no import edge into target.ts: the seam is
 * structural, so the module compiles and is fully testable on its own, and the
 * wiring layer supplies target.ts's runner.
 *
 * THE FALLBACK IS PART OF THE VALUE, NOT AN ERROR PATH - the single most
 * mis-portable thing in this file. Bash writes
 * `x="$(cmd 2>/dev/null || printf 'unknown')"`, and a command substitution
 * captures the stdout of the WHOLE `||` list. When `cmd` prints something AND
 * exits nonzero, the captured value is the command's output CONCATENATED with
 * the fallback, not the fallback alone. `systemctl is-active` on a stopped unit
 * is exactly that case - it prints `inactive` and exits 3 - so the value
 * `readiness_ok` compares against `"active"` is the two-line string
 * `inactive\nunknown`, and READINESS_DETAIL renders it verbatim as
 * `state=inactive\nunknown`. A port that returned a bare "unknown" would agree
 * with bash on the verdict and disagree on the only diagnosis an operator ever
 * reads. captureOrFallback below reproduces the concatenation, and
 * probes-parity.test.ts pins it against the real bash.
 *
 * TRAILING-NEWLINE STRIPPING BELONGS TO THE CALL SITE, and the two probes
 * differ on where it happens. `sup_is_active` does not capture anything - it
 * PRINTS, and the stripping is done by its caller's `active="$(sup_is_active)"`
 * (:1075). `sup_restart_count` captures internally (:1408) and then re-prints
 * with `printf '%s'`. Both are modelled here as the value the CALLER observes,
 * which is what readiness.ts's `isActive`/`restartCount` seams are typed as, so
 * `stripTrailingNewlines` (session-guard.ts, reused rather than re-derived -
 * never `.trim()`, see its own doc) is applied once at the end of each.
 *
 * THE TWO CURL INVOCATIONS ARE NOT INTERCHANGEABLE and their differences are
 * all load-bearing (:1084-1091):
 *   - /healthz uses `-f` and `-o /dev/null` with `-w '%{http_code}'`: the gate
 *     wants only the status line, so the body is discarded at the source.
 *   - /readyz drops `-f` and uses `-w '\n%{http_code}'`, because the BODY is
 *     the payload the gate parses for `"mode":"normal"` and buildSha, and `-f`
 *     would suppress it on any non-2xx. The `\n` is inside SINGLE quotes in the
 *     bash, so bash passes the two characters backslash-n through and CURL
 *     expands them - the argv element is literally `\n%{http_code}`, and a port
 *     that "helpfully" sent a real newline would change the argv bytes any
 *     operator diffing a strace would see.
 *   - Their fallbacks differ for the same reason: `000` for healthz,
 *     newline + `000` for readyz, because readiness.ts splits the readyz
 *     capture at its LAST newline to recover the code.
 *   - The URL is always the loopback `127.0.0.1`, never the host proxy: under
 *     incus the runner puts this inside the container, where the port is the
 *     container's own (:363-365).
 *
 * `--user` GOES BETWEEN `systemctl` AND THE SUBCOMMAND, mirroring
 * `_systemctl_user_flag` (:1435-1437) at all ten of its call sites. In bash the
 * flag is an UNQUOTED command substitution, so when SYSTEMD_USER is false word
 * splitting removes it entirely and no empty argument is passed; systemctlArgv
 * reproduces that by omitting the element rather than emitting "".
 *
 * `now` AND `sleep`. Bash's `SECONDS` is a whole number of seconds since the
 * shell started, and `readiness_ok`'s deadline arithmetic (:1071, :1074) is
 * integer arithmetic over it - so makeMonotonicSeconds truncates rather than
 * returning a float, and the number of probe attempts a given
 * timeout/interval pair yields is the same one bash gets. The sleep is an
 * external `sleep` binary on the HOST (it is not routed through run_target -
 * bash calls it bare at :1124), spawned the same way restart.ts's
 * defaultSleepSync spawns it, so the two never drift.
 *
 * OUT OF SCOPE, DELIBERATELY: the launchd arms of `sup_is_active` (:1390-1395)
 * and `sup_restart_count` (:1409). S22d's binary owns LAYOUT=inplace +
 * SUPERVISOR=systemd only and DELEGATES `--supervisor launchd` whole to the
 * bash engine before the lock is acquired, so porting a launchd arm here would
 * ship an untested path that nothing can reach. Also out of scope:
 * `sup_main_pid` (:1416-1433) - restart.ts reads MainPID through the same
 * injected runSystemctl this module builds, so it needs no second probe.
 */
import { spawnSync } from "node:child_process"
import type { ReadinessProbeOptions, ReadinessResult, ReadyzCapture } from "./readiness.js"
import type { RestartOutcome } from "./restart.js"
import { stripTrailingNewlines } from "./session-guard.js"

/**
 * What a captured command hands back. Structurally the shape target.ts's
 * `run_target_capture` port returns; declared here so this module has no import
 * edge into it (see the header). `stdout` must NOT have stderr folded into it -
 * bash sends stderr to /dev/null at every call site below (:1084, :1088, :1389,
 * :1408), and a curl progress or error line landing in the captured body would
 * be parsed as the /readyz payload.
 */
export interface CaptureResult {
  readonly status: number | null
  readonly stdout: string
}

/**
 * `run_target_capture "$@"` (scripts/luna-update-server:361-369): direct on a
 * bare host, `incus exec <container> --` prefixed when INCUS_CONTAINER is set.
 *
 * Structurally satisfied by target.ts's own runner with no adapter - the
 * wiring layer passes `(argv) => runTargetCaptureSync(ctx, argv)`, whose
 * CommandResult is the same `{ status, stdout }` pair - so declaring the seam
 * here buys the missing import edge back at zero cost to the caller.
 */
export type RunTargetCapture = (argv: ReadonlyArray<string>) => CaptureResult

/** `[[ "$n" =~ ^[0-9]+$ ]]` - sup_restart_count's own validation (scripts/luna-update-server:1412). Re-derived here rather than imported from readiness.ts because the two guards are separate bash statements that happen to share a regex; readiness.ts re-checks the value this returns, exactly as `readiness_ok` re-checks it at :1079. */
const RESTART_COUNT_FORMAT = /^[0-9]+$/

/**
 * `$( cmd 2>/dev/null || printf '<fallback>' )`.
 *
 * See THE FALLBACK IS PART OF THE VALUE in the header: on a non-zero exit the
 * captured value is the command's own stdout FOLLOWED BY the fallback, not the
 * fallback alone. A null status (killed by a signal) counts as failure, exactly
 * as bash's `||` treats a 128+n exit.
 */
const captureOrFallback = (
  run: RunTargetCapture,
  argv: ReadonlyArray<string>,
  fallback: string,
): string => {
  const r = run(argv)
  return stripTrailingNewlines(r.status === 0 ? r.stdout : `${r.stdout}${fallback}`)
}

/**
 * `systemctl $(_systemctl_user_flag) <args...>` (scripts/luna-update-server:
 * 1435-1437). Exported because it is the one place the `--user` position is
 * decided, and probes-parity.test.ts diffs it against the real bash argv.
 */
export const systemctlArgv = (
  systemdUser: boolean,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> => ["systemctl", ...(systemdUser ? ["--user"] : []), ...args]

/** What every systemd-scoped probe below needs: which unit, which systemd scope, and how to reach the target. */
export interface SystemdProbeOptions {
  readonly serviceName: string
  /** `SYSTEMD_USER` (`--user`); false for the system scope every unattended deploy uses. */
  readonly systemdUser: boolean
  readonly runTargetCapture: RunTargetCapture
}

/**
 * `active="$(sup_is_active)"` (scripts/luna-update-server:1075 capturing
 * :1387-1397): the systemd arm's value as its CALLER observes it. Returns
 * "active" when the unit is running; on any non-zero systemctl exit the state
 * systemctl printed is concatenated with the literal `unknown` - see the
 * header, this is the normal shape for a stopped unit, not an edge case.
 */
export const supIsActiveSync = (options: SystemdProbeOptions): string =>
  captureOrFallback(
    options.runTargetCapture,
    systemctlArgv(options.systemdUser, ["is-active", options.serviceName]),
    "unknown",
  )

/**
 * `sup_restart_count` (scripts/luna-update-server:1405-1413), systemd arm:
 * NRestarts via `systemctl show --property=NRestarts --value`, normalised to
 * "0" for anything that is not a bare run of digits. The normalisation is what
 * makes the `||`-concatenated failure value ("3\n0" when systemctl printed a
 * count AND failed) safe: it is not a bare integer, so it collapses to "0",
 * which disables the crash-loop climb check rather than mis-reporting it.
 */
export const supRestartCountSync = (options: SystemdProbeOptions): string => {
  const n = captureOrFallback(
    options.runTargetCapture,
    systemctlArgv(options.systemdUser, ["show", options.serviceName, "--property=NRestarts", "--value"]),
    "0",
  )
  return RESTART_COUNT_FORMAT.test(n) ? n : "0"
}

/** Which loopback endpoint and with what `--max-time` the two readiness curls are aimed at. */
export interface CurlProbeOptions {
  /** `READINESS_PORT` (scripts/luna-update-server:86). */
  readonly readinessPort: number
  /**
   * `READINESS_CURL_MAX_TIME` (:89) as a STRING, the same choice restart.ts
   * makes for settleSecs: the value reaches curl as an argv element, so
   * carrying it as a number would silently renormalise an operator's `5.0` or
   * `05` into `5` and break the byte-exactness of the argv this module exists
   * to preserve.
   */
  readonly curlMaxTime: string
  readonly runTargetCapture: RunTargetCapture
}

/** The /healthz argv, byte-exact (scripts/luna-update-server:1084-1086). */
export const healthzArgv = (readinessPort: number, curlMaxTime: string): ReadonlyArray<string> => [
  "curl", "-fsS", "-o", "/dev/null", "-w", "%{http_code}",
  "--max-time", curlMaxTime,
  `http://127.0.0.1:${readinessPort}/healthz`,
]

/** The /readyz argv, byte-exact (scripts/luna-update-server:1088-1090). The `-w` value carries a LITERAL backslash-n that curl expands - see the header. */
export const readyzArgv = (readinessPort: number, curlMaxTime: string): ReadonlyArray<string> => [
  "curl", "-sS", "-w", "\\n%{http_code}",
  "--max-time", curlMaxTime,
  `http://127.0.0.1:${readinessPort}/readyz`,
]

/** `http="$(run_target_capture curl ... /healthz ... || printf '000')"` (scripts/luna-update-server:1084-1086): the bare `%{http_code}`, or "000" when the transport failed. */
export const probeHealthzSync = (options: CurlProbeOptions): string =>
  captureOrFallback(
    options.runTargetCapture,
    healthzArgv(options.readinessPort, options.curlMaxTime),
    "000",
  )

/**
 * `readyz="$(run_target_capture curl ... /readyz ... || printf '\n000')"`
 * (scripts/luna-update-server:1088-1090): body + newline + code in one string,
 * which readiness.ts splits at the LAST newline. The fallback carries a REAL
 * newline (bash's `printf` expands it) so a transport failure still parses as
 * code "000" with an empty body - the distinction readiness.ts's header calls
 * out as the difference between retrying and promoting a corpse.
 */
export const probeReadyzSync = (options: CurlProbeOptions): ReadyzCapture =>
  captureOrFallback(
    options.runTargetCapture,
    readyzArgv(options.readinessPort, options.curlMaxTime),
    "\n000",
  )

/**
 * Bash's `SECONDS` (scripts/luna-update-server:1071, :1074): whole seconds
 * since the shell started. Anchored at construction, monotonic (hrtime, not
 * Date.now, so a clock step cannot move a deadline), and TRUNCATED to an
 * integer so `readiness_ok`'s deadline arithmetic yields the same attempt count
 * bash's integer arithmetic does.
 */
export const makeMonotonicSeconds = (): (() => number) => {
  const start = process.hrtime.bigint()
  return () => Number((process.hrtime.bigint() - start) / 1_000_000_000n)
}

/**
 * `sleep "$READINESS_INTERVAL"` (scripts/luna-update-server:1124). Spawns the
 * real `sleep` binary, the same way restart.ts's defaultSleepSync does, because
 * it is the same host-side wait and two different implementations of "wait n
 * seconds" in one deploy engine is one too many. Not routed through
 * RunTargetCapture: bash calls `sleep` bare, never through run_target, so under
 * incus the poll interval is spent on the HOST and not inside the container.
 */
export const sleepSecondsSync = (seconds: number): void => {
  spawnSync("sleep", [String(seconds)])
}

/**
 * Everything readiness.ts declares as an injected function
 * (readiness.ts:93-104), wired to one target and one unit. The return type is
 * pinned to a Pick of ReadinessProbeOptions rather than a hand-written
 * interface so that adding a seam to readiness.ts is a COMPILE error here
 * instead of a runtime gap in the gate that decides whether a deploy is
 * promoted or rolled back.
 */
export const makeReadinessProbes = (
  options: SystemdProbeOptions & CurlProbeOptions,
): Pick<
  ReadinessProbeOptions,
  "isActive" | "restartCount" | "probeHealthz" | "probeReadyz" | "now" | "sleep"
> => ({
  isActive: () => supIsActiveSync(options),
  restartCount: () => supRestartCountSync(options),
  probeHealthz: () => probeHealthzSync(options),
  probeReadyz: () => probeReadyzSync(options),
  now: makeMonotonicSeconds(),
  sleep: sleepSecondsSync,
})

/**
 * restart.ts's `runSystemctl` seam (restart.ts:132), routed through the same
 * target waist as the probes above so that the systemd instance the restart
 * acts on is provably the one the readiness gate then interrogates - the
 * transport half of the NON-DECOUPLING contract restart.ts's header states.
 *
 * One runner serves both of bash's arms: `sup_reload`/`sup_stop`/`sup_start`
 * use `run_target` and `sup_start`'s latch probe uses `run_target_capture`
 * (:1373-1377), but the two are the same command when DRY_RUN is false, and
 * restart.ts never calls this at all under dry-run (restart.ts:181). Under
 * dry-run the whole inplace transaction is delegated to the bash engine, so
 * the printing arm of `luna_run` (scripts/lib/luna-deploy.sh:8-18) is never
 * this module's to reproduce.
 */
export const makeRunSystemctl = (
  options: Pick<SystemdProbeOptions, "systemdUser" | "runTargetCapture">,
): ((args: ReadonlyArray<string>) => { readonly status: number | null; readonly stdout: string }) =>
  (args) => {
    const r = options.runTargetCapture(systemctlArgv(options.systemdUser, args))
    return { status: r.status, stdout: r.stdout }
  }

// --- the two wiring-layer adapters -------------------------------------------
// rollback.ts asks for `restartService: (guardSessions) => number` and
// `runReadiness: (request) => boolean` (rollback.ts:122-125), because the bash
// it ports reads an rc and a truth value. restart.ts and readiness.ts return
// richer typed verdicts. NEITHER PRIMITIVE IS WEAKENED TO FIT: the narrowing
// happens here, at the seam, in two named functions an operator-facing warning
// path can be traced through - rather than by re-typing RestartOutcome as a
// number and losing the failed step, or ReadinessResult as a boolean and losing
// READINESS_DETAIL, which is the only diagnosis a rolled-back deploy leaves.

/** `restart_service; rc=$?` - RestartOutcome's code, widened to the plain number rollback.ts's seam takes. The rest of the outcome (which step failed, how the settle went) stays with the caller, which is what prints it. */
export const restartOutcomeRc = (outcome: RestartOutcome): number => outcome.code

/** `readiness_ok "$baseline"` - ReadinessResult's verdict, without its detail. The caller keeps the ReadinessResult so it can still emit readinessGaveUpLine (readiness.ts:204) on a false. */
export const readinessResultOk = (result: ReadinessResult): boolean => result.ready
