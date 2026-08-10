/**
 * Stop -> settle -> start restart primitive: a behavioral port of
 * restart_service's core sequence (scripts/luna-update-server:1509 the
 * session guard, 1519-1522 the MainPID pre-read, 1526-1528 sup_reload/
 * sup_stop/settle_after_stop, 1549 sup_start, 1550-1568 the MainPID
 * postcondition) and settle_after_stop itself (scripts/luna-update-server:
 * 1256-1286).
 *
 * THIS MODULE PRINTS ELEVEN OPERATOR LINES, WHICH REVERSES PART OF ITS OWN
 * S22c HEADER. That header said the bash `luna_info`/`luna_warn` lines inside
 * restart_service and settle_after_stop were "not reproduced here by design
 * (this module returns typed outcomes instead)". The typed outcomes are still
 * returned, but the strings must ALSO be emitted, byte-exact, and from HERE.
 *
 * WHY FROM HERE AND NOT FROM THE CALLER. Bash emits all eleven from INSIDE the
 * two functions this module ports, and restart_service has three in-scope
 * callers (:1894 restart-only, :2056 the forward restart, :1824 the rollback
 * restart). A caller-side printer would be one copy per caller, would drift,
 * and two of the three could not print at all: restart-only never runs through
 * the orchestrator, and rollback.ts sees the primitive only through a
 * `restartService: (guardSessions: boolean) => number` seam. It is also the
 * wrong ORDER even where it works - the warns are interleaved with the
 * restart's own steps (between the is-failed probe and reset-failed, between
 * stop and start, between start and the return), not appended after the
 * primitive returns. So all eleven payloads go out through the injected
 * `info`/`warn` seams below (the caller owns the `-> ` / `warning: ` prefix,
 * exactly as rollback.ts/lock.ts/preflight.ts draw that line), at the four
 * positions bash prints them:
 *
 *   1. restart_session_guard's five verdict lines (:1468, :1477, :1491,
 *      :1494, :1497), emitted at restart_service's very FIRST statement
 *      (:1509) and therefore before anything the restart itself prints;
 *   2. settle_after_stop's invalid-value warn (:1276), settling info (:1279)
 *      and sleep-failed warn (:1283), between sup_stop and sup_start (:1528);
 *   3. sup_start's start-limit warn (:1375), between its is-failed probe
 *      (:1374) and the reset-failed that clears the latch (:1376);
 *   4. restart_service's two MainPID warns (:1559, :1563), between sup_start
 *      (:1549) and the function's return (:1569).
 *
 * The payloads themselves are NOT declared here. The six restart-owned ones
 * come from flow-lines.ts, so a reviewer diffing a changed bash string has one
 * file to open rather than two; the five guard ones come from session-guard.ts's
 * guardVerdictLine, which is the only place that can map GuardVerdict
 * exhaustively. A PR1 primitive importing a PR2 constants file is acceptable
 * because the dependency is on data, is acyclic, and flow-lines.ts imports
 * nothing itself.
 *
 * Bare-host / systemd-supervisor scope only, matching session-guard.ts:
 * sup_reload/sup_stop/sup_start's launchd branches, the --user systemd flag,
 * and the incus run_target routing are all out of scope for this port.
 *
 * STILL EXCLUDED: RESTART_PRESTART_HOOK (releases-only, and the releases
 * layout is delegated whole to the bash engine by config.ts's delegationFor).
 *
 * DRY-RUN mirrors bash's `luna_run` (scripts/lib/luna-deploy.sh:8-18): under
 * dry-run, `run_target`/`luna_run` PRINT the would-be command and return
 * success WITHOUT executing it, so `restartServiceSync` never invokes
 * `runSystemctl` at all when `dryRun` is true - the reload/stop/start steps
 * are treated as having succeeded, exactly as `sup_reload`/`sup_stop`/
 * `sup_start` always report success in that mode. `settleAfterStopSync`
 * already gates on the same flag on its own.
 *
 * THE SETTLE - WHY 6s (scripts/luna-update-server:90-98): `systemctl stop`
 * returns once the unit's cgroup is torn down, but the OUTGOING process's
 * DuckDB/SQLite WAL/SHM handles can take a moment longer to release (async
 * checkpoint, child reaping, and on an incus bind-mount, host fs cache
 * coherence). A fast restart can open the DBs from the new process while
 * those handles are still held, crashing the boot with "unable to open
 * database file" (SQLITE_CANTOPEN) and tripping a needless auto-rollback.
 * settleAfterStopSync closes that gap with a FIXED wait, not a port/handle
 * poll - the listening port is already gone the instant stop returns, yet
 * the fd release can lag process exit in ways the port never reflects, and
 * this primitive does not know the DB file paths to fuser/lsof against.
 * RESTART_SETTLE_SECS_DEFAULT carries the verbatim bash default (6); the
 * sleep itself is injectable (sleepSync) so tests can prove the knob is
 * wired without paying a real 6s of wall-clock time per test - production
 * callers omit it and get the real `sleep` binary at the default value.
 *
 * NON-DECOUPLING (the ONE full statement of this contract - session-
 * guard.ts's header and every other mention in this file are pointers back
 * here): restartServiceSync derives the guard's dryRun/serviceName/
 * supervisor from its OWN fields (RestartServiceOptions.guard's type omits
 * them) rather than accepting them as a second, independently-settable
 * object, so a caller cannot make the guard evaluate a different dry-run/
 * unit/supervisor than the one this primitive actually executes against -
 * mirroring why bash's restart_session_guard and its sup_reload/sup_stop/
 * sup_start callers read the SAME $DRY_RUN/$SERVICE_NAME/$SUPERVISOR
 * globals, never two copies. It extends that same non-decoupling to the
 * systemd TRANSPORT itself: SessionGuardOptions.readUnitState is filled
 * below from this primitive's OWN runSystemctl, so the guard's "count
 * unknown" fallback interrogates the exact systemd instance reload/stop/
 * start act on, never a second, independently-resolved transport.
 */
import { spawnSync } from "node:child_process"
import {
  mainPidInconclusiveLine,
  mainPidUnchangedLine,
  settleInvalidLine,
  settleSleepFailedLine,
  settlingLine,
  startLimitLatchedLine,
} from "./flow-lines.js"
import {
  type GuardVerdict,
  type SessionGuardOptions,
  guardVerdictLine,
  restartSessionGuardSync,
  stripTrailingNewlines,
} from "./session-guard.js"

/** Verbatim port of RESTART_SETTLE_SECS's default (scripts/luna-update-server:99, `LUNA_RESTART_SETTLE_SECS:-6`). See this module's header for the SQLITE_CANTOPEN rationale. */
export const RESTART_SETTLE_SECS_DEFAULT = 6

/** `^[0-9]+(\.[0-9]+)?$` - byte-exact port of settle_after_stop's own validation regex (scripts/luna-update-server:1275). */
const SETTLE_SECS_FORMAT = /^[0-9]+(\.[0-9]+)?$/

/** `[[ "$pre_pid" =~ ^[0-9]+$ ]]` / `[[ ! "$post_pid" =~ ^[0-9]+$ ]]` - the validation restart_service applies to its OWN two reads (scripts/luna-update-server:1551, :1553), separate bash statements from sup_main_pid's own normalisation, which probes.ts ports. */
const MAIN_PID_FORMAT = /^[0-9]+$/

export interface SettleAfterStopOptions {
  readonly dryRun: boolean
  /** Raw string form, mirroring RESTART_SETTLE_SECS/--restart-settle/LUNA_RESTART_SETTLE_SECS: a STRING, not a parsed number, so an invalid value (e.g. "not-a-number") is representable and validated exactly as settle_after_stop's own regex does. */
  readonly settleSecs: string
  /** Defaults to spawning the real `sleep` binary - mirrors bash's `sleep "$RESTART_SETTLE_SECS"` byte-for-byte. Tests inject a fast stand-in so the settle knob is provably wired without paying real wall-clock time. */
  readonly sleepSync?: (seconds: string) => { readonly ok: boolean }
}

export type SettleOutcome =
  | { readonly kind: "skipped-dry-run" }
  | { readonly kind: "skipped-zero" }
  | { readonly kind: "skipped-invalid"; readonly settleSecs: string }
  | { readonly kind: "settled"; readonly settleSecs: string }
  | { readonly kind: "settled-sleep-failed"; readonly settleSecs: string }

const defaultSleepSync = (seconds: string): { readonly ok: boolean } => {
  const r = spawnSync("sleep", [seconds])
  return { ok: r.status === 0 }
}

/**
 * Behavioral port of settle_after_stop (scripts/luna-update-server:
 * 1256-1286): same branch structure and the verbatim regex/timing.
 *
 * IT STILL DOES NOT PRINT, and that is not a contradiction of this module's
 * header. The three settle lines ARE emitted, but by restartServiceSync from
 * the SettleOutcome this function returns, which is byte-identically the same
 * position in the output because restart_service is settle_after_stop's only
 * caller in bash (:1528). Keeping the decision pure and the printing in one
 * place means this function stays callable from a test that wants the branch
 * without a writer, and there is exactly one emitter to read.
 *
 * ALWAYS returns a result, never throws: it sits unguarded between
 * restart_service's two `|| return 1` lines in bash, so a stray failure here
 * must never trip the rollback path - mirrored here by every branch
 * returning a normal SettleOutcome, including "the sleep itself failed".
 */
export const settleAfterStopSync = (opts: SettleAfterStopOptions): SettleOutcome => {
  if (opts.dryRun) return { kind: "skipped-dry-run" }
  if (opts.settleSecs === "0") return { kind: "skipped-zero" }
  if (!SETTLE_SECS_FORMAT.test(opts.settleSecs)) return { kind: "skipped-invalid", settleSecs: opts.settleSecs }
  const sleep = opts.sleepSync ?? defaultSleepSync
  const result = sleep(opts.settleSecs)
  if (!result.ok) return { kind: "settled-sleep-failed", settleSecs: opts.settleSecs }
  return { kind: "settled", settleSecs: opts.settleSecs }
}

export interface RestartServiceOptions {
  readonly serviceName: string
  readonly dryRun: boolean
  /** Defaults to String(RESTART_SETTLE_SECS_DEFAULT) ("6"). */
  readonly settleSecs?: string
  readonly sleepSync?: SettleAfterStopOptions["sleepSync"]
  /**
   * dryRun/serviceName/supervisor/readUnitState are NOT accepted here -
   * see this module's header (NON-DECOUPLING) for why: restartServiceSync
   * derives all four from its own fields below instead (supervisor is
   * hardcoded to "systemd", the only execution path this primitive
   * implements).
   */
  readonly guard: Omit<SessionGuardOptions, "dryRun" | "serviceName" | "supervisor" | "readUnitState">
  /**
   * Injected systemctl runner. Production wiring (calling the real
   * `systemctl` binary) is a future slice's concern - D3 keeps
   * ServerUpdateDriver's contract frozen this slice, and this primitive is
   * not called from anywhere yet - so this module stays a pure orchestration
   * of an injected effect; the parity harness points this at the exact
   * hermetic systemctl stub the hostenv suite already proves. `stdout` is
   * optional: only the guard's is-active fallback (below) reads it, so a
   * caller that only cares about exit status may omit it.
   */
  readonly runSystemctl: (args: ReadonlyArray<string>) => { readonly status: number | null; readonly stdout?: string }
  /**
   * `sup_main_pid` (scripts/luna-update-server:1423-1430), for the MainPID
   * postcondition. Production wiring passes probes.ts's supMainPidSync, which
   * routes the read through the SAME run_target_capture waist as the readiness
   * probes - so on an incus target the PID compared is the container's, which
   * is what bash's own `run_target_capture` read (:1426) yields.
   *
   * OPTIONAL, and omitting it SKIPS the postcondition entirely rather than
   * failing it. That is the same fail-only-on-positive-proof rule bash applies
   * to an unreadable pre-PID (:1516-1518): a caller with no MainPID transport
   * has no evidence the stop failed, and readiness_ok still gates. It is
   * expressed as an absent seam rather than a stubbed-out reader so that a
   * test asserting "no MainPID call was made" is possible at all.
   */
  readonly mainPid?: () => string
  /**
   * `luna_info` PAYLOAD, no `-> ` prefix - the caller owns the prefix, as in
   * rollback.ts/lock.ts/preflight.ts. REQUIRED for the same reason `warn` is:
   * the `:1279` settling line fires on EVERY production deploy (the default
   * RESTART_SETTLE_SECS is 6, not 0), so a wiring that forgets it is a visible
   * divergence from the bash engine on every single run, and that must be a
   * compile error rather than a quiet gap.
   */
  readonly info: (line: string) => void
  /**
   * `luna_warn` PAYLOAD, no `warning: ` prefix - the caller owns the prefix,
   * as in rollback.ts/lock.ts/preflight.ts. REQUIRED, not optional: the two
   * MainPID warns are the only diagnosis an operator gets for a silently
   * failed stop, and the guard verdict line is the only diagnosis for a
   * deferred deploy, so a wiring that forgets them must be a compile error
   * rather than a silent behaviour difference from the bash engine.
   */
  readonly warn: (line: string) => void
}

export type RestartOutcome =
  | { readonly code: 3; readonly verdict: Extract<GuardVerdict, { readonly permitted: false }> }
  /** `startLimitLatched` records that sup_start's is-failed probe agreed the unit was latched (:1374), so the reset-failed/retry cycle ran. Machine-readable only: the `:1375` warn is printed in place, not by the caller. */
  | { readonly code: 1; readonly step: "reload" | "stop" | "start"; readonly startLimitLatched?: boolean }
  /** The MainPID postcondition's ONE failing shape (:1560-1564): systemd answered, and the answer is the old, non-zero PID. Both PIDs travel so a caller can log them without re-reading. */
  | { readonly code: 1; readonly step: "mainpid"; readonly prePid: string; readonly postPid: string }
  /** `mainPidInconclusive` marks the :1553-1559 arm: the post-restart read was unanswerable, the check was SKIPPED, and the primitive passed. */
  | { readonly code: 0; readonly settle: SettleOutcome; readonly mainPidInconclusive?: boolean; readonly startLimitLatched?: boolean }

/**
 * Behavioral port of restart_service's core sequence (scripts/
 * luna-update-server:1509 the session guard, 1519-1522 the MainPID pre-read,
 * 1526-1528 sup_reload/sup_stop/settle_after_stop, 1549 sup_start, 1550-1568
 * the MainPID postcondition), minus the releases-layout RESTART_PRESTART_HOOK
 * sitting between them - see this module's header. Exit codes mirror the bash
 * primitive's own contract: 3 = guard deferred (restart_session_guard ||
 * return 3), 1 = a supervisor step failed (sup_reload/sup_stop/sup_start's
 * `|| return 1`) OR the MainPID postcondition proved the stop failed
 * (:1564's `return 1`), 0 = the full sequence completed (settle_after_stop
 * never fails the primitive - see its own doc). The start step includes
 * sup_start's own start-limit-latched
 * recovery (scripts/luna-update-server:1371-1381): a unit refused by
 * systemd's StartLimitIntervalSec/StartLimitBurst latch (scripts/
 * luna-server-install:280-281) gets exactly one is-failed -> reset-failed ->
 * retry-start cycle; reset-failed is never called ahead of a start that
 * would have succeeded on its own, since that would clear the counter
 * before OnFailure could fire.
 */
export const restartServiceSync = (opts: RestartServiceOptions): RestartOutcome => {
  const verdict = restartSessionGuardSync({
    ...opts.guard,
    dryRun: opts.dryRun,
    serviceName: opts.serviceName,
    // This primitive's execution steps below only implement the systemd
    // path (see this module's header); the guard must never be asked to
    // evaluate a supervisor this primitive would not actually act as.
    supervisor: "systemd",
    // Same non-decoupling as above (this module's header) - never a second,
    // independently-resolved transport. stripTrailingNewlines (not `.trim()`)
    // mirrors bash's `$(...)` command substitution exactly, the same fix
    // session-guard.ts's own queryUnitStateSync carries: a `.trim()` here
    // would launder a polluted is-active answer (a stray CR, or leading/
    // trailing spaces some systemd builds emit) into an exact match against
    // "inactive"/"failed", permitting a restart where bash's own `case`
    // statement - matching on the SAME untrimmed value - falls through to
    // its fail-closed default and defers.
    readUnitState: (name) => stripTrailingNewlines(opts.runSystemctl(["is-active", name]).stdout ?? ""),
  })
  // Emission point 1 (this module's header): bash warns from INSIDE
  // restart_session_guard, so the line lands before the `|| return 3` at
  // :1509 decides anything - which means it is printed on the PERMITTED arms
  // too (the dead-server exception at :1491 is the guard line an operator
  // sees on an otherwise successful deploy). Printing after the branch below
  // would silence exactly that one.
  const verdictLine = guardVerdictLine(verdict, opts.guard.readinessPort)
  if (verdictLine !== null) opts.warn(verdictLine)
  if (!verdict.permitted) return { code: 3, verdict }

  // :1519-1522 - the pre-read sits between the guard and sup_reload, never
  // under dry-run (bash's own condition; `run_target_capture` would execute
  // even there, which is why bash guards it explicitly), and systemd-only,
  // which is structural here since this primitive implements no other arm.
  // An absent seam reads as "" and takes exactly the same skip path bash's
  // unknown pre-PID takes at :1551 - see mainPid's own doc.
  const readMainPid = opts.mainPid
  const prePid = !opts.dryRun && readMainPid ? readMainPid() : ""

  // Mirrors luna_run: under dry-run, print-only, never invoke, always
  // "succeed" - see this module's header.
  const runStep = (args: ReadonlyArray<string>): number | null => (opts.dryRun ? 0 : opts.runSystemctl(args).status)

  if (runStep(["daemon-reload"]) !== 0) return { code: 1, step: "reload" }
  if (runStep(["stop", opts.serviceName]) !== 0) return { code: 1, step: "stop" }

  const settle = settleAfterStopSync({
    dryRun: opts.dryRun,
    settleSecs: opts.settleSecs ?? String(RESTART_SETTLE_SECS_DEFAULT),
    ...(opts.sleepSync ? { sleepSync: opts.sleepSync } : {}),
  })
  // Emission point 2 (this module's header): settle_after_stop's own three
  // lines, mapped from the outcome it just returned, still between sup_stop
  // and sup_start. `settled-sleep-failed` is TWO lines in bash and not one:
  // :1279 prints BEFORE the sleep is attempted at :1282, and :1283 only after
  // it fails. `skipped-dry-run` (:1267) and `skipped-zero` (:1268) return
  // before bash reaches any warn at all.
  switch (settle.kind) {
    case "skipped-invalid":
      opts.warn(settleInvalidLine(settle.settleSecs))
      break
    case "settled":
      opts.info(settlingLine(settle.settleSecs))
      break
    case "settled-sleep-failed":
      opts.info(settlingLine(settle.settleSecs))
      opts.warn(settleSleepFailedLine(settle.settleSecs))
      break
    case "skipped-dry-run":
    case "skipped-zero":
      break
  }

  const startArgs = ["start", opts.serviceName]
  let startLimitLatched = false
  if (runStep(startArgs) !== 0) {
    if (runStep(["is-failed", opts.serviceName]) !== 0) return { code: 1, step: "start" }
    // Emission point 3 (this module's header): sup_start prints :1375 between
    // the is-failed probe it just agreed with (:1374) and the reset-failed
    // below (:1376), so an operator reading systemctl.log beside stderr sees
    // the warn land between those two calls. The flag stays on the outcome as
    // a MACHINE-READABLE signal (a parity test asserts the latch without
    // string-matching stderr), not as a printing obligation on the caller.
    opts.warn(startLimitLatchedLine(opts.serviceName))
    startLimitLatched = true
    runStep(["reset-failed", opts.serviceName])
    if (runStep(startArgs) !== 0) return { code: 1, step: "start", startLimitLatched }
  }
  const latched = startLimitLatched ? { startLimitLatched: true } : {}

  // :1550-1568, THE RULE IS FAIL ONLY ON POSITIVE PROOF, and emission point 4
  // (this module's header) sits inside it. prePid is "" under
  // dry-run and whenever no mainPid seam was supplied, so both skip here on
  // the same condition bash uses for an unknown pre-PID, with no second test.
  if (readMainPid && MAIN_PID_FORMAT.test(prePid) && prePid !== "0") {
    const postPid = readMainPid()
    if (!MAIN_PID_FORMAT.test(postPid)) {
      // :1553-1559. A transport failure is not evidence the old process
      // survived; failing here would route a healthy deploy into rollback on a
      // read blip, and readiness_ok still gates the build that is serving.
      opts.warn(mainPidInconclusiveLine)
      return { code: 0, settle, mainPidInconclusive: true, ...latched }
    }
    if (postPid === prePid) {
      // :1560-1564. The one positive proof: systemd answered, and the answer is
      // the OLD pid, so the stop silently failed.
      opts.warn(mainPidUnchangedLine(prePid, postPid))
      return { code: 1, step: "mainpid", prePid, postPid }
    }
    // postPid === "0" PASSES (:1566-1567): systemd answered "no main process",
    // which disproves "the old process is still serving". A failed START is
    // readiness_ok's job, not this postcondition's.
  }

  return { code: 0, settle, ...latched }
}
