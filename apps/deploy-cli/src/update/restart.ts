/**
 * Stop -> settle -> start restart primitive: a behavioral port of
 * restart_service's core sequence (scripts/luna-update-server:1509 the
 * session guard, 1526-1528 sup_reload/sup_stop/settle_after_stop, 1549
 * sup_start) and settle_after_stop itself (scripts/luna-update-server:
 * 1256-1286). "Behavioral", not byte-exact: the bash `luna_info`/`luna_warn`
 * lines inside restart_service and settle_after_stop are not reproduced here
 * by design (this module returns typed outcomes instead) -
 * operatorOverrideLogLine in session-guard.ts is the one genuinely
 * byte-exact artifact this slice ships.
 *
 * Bare-host / systemd-supervisor scope only, matching session-guard.ts:
 * sup_reload/sup_stop/sup_start's launchd branches, the --user systemd flag,
 * and the incus run_target routing are all out of scope for this port.
 *
 * DELIBERATELY EXCLUDED from this port: the MainPID pre/post postcondition
 * and RESTART_PRESTART_HOOK, both layered on top of the same
 * reload/stop/settle/start core this module owns - see docs/deploy-binary.md
 * (the S22b section) for the S22c scoping rationale.
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
import { type GuardVerdict, type SessionGuardOptions, restartSessionGuardSync, stripTrailingNewlines } from "./session-guard.js"

/** Verbatim port of RESTART_SETTLE_SECS's default (scripts/luna-update-server:99, `LUNA_RESTART_SETTLE_SECS:-6`). See this module's header for the SQLITE_CANTOPEN rationale. */
export const RESTART_SETTLE_SECS_DEFAULT = 6

/** `^[0-9]+(\.[0-9]+)?$` - byte-exact port of settle_after_stop's own validation regex (scripts/luna-update-server:1275). */
const SETTLE_SECS_FORMAT = /^[0-9]+(\.[0-9]+)?$/

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
 * 1256-1286): same branch structure and the verbatim regex/timing, but the
 * bash `luna_info`/`luna_warn` lines are not reproduced - see this module's
 * header. ALWAYS returns a result, never throws: it sits unguarded between
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
}

export type RestartOutcome =
  | { readonly code: 3; readonly verdict: Extract<GuardVerdict, { readonly permitted: false }> }
  | { readonly code: 1; readonly step: "reload" | "stop" | "start" }
  | { readonly code: 0; readonly settle: SettleOutcome }

/**
 * Behavioral port of restart_service's core sequence (scripts/
 * luna-update-server:1509 the session guard, 1526-1528 sup_reload/sup_stop/
 * settle_after_stop, 1549 sup_start), minus the MainPID postcondition and
 * the releases-layout RESTART_PRESTART_HOOK sitting between them - see this
 * module's header. Exit codes mirror the bash primitive's own contract:
 * 3 = guard deferred (restart_session_guard || return 3), 1 = a supervisor
 * step failed (sup_reload/sup_stop/sup_start's `|| return 1`), 0 = the full
 * sequence completed (settle_after_stop never fails the primitive - see its
 * own doc). The start step includes sup_start's own start-limit-latched
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
  if (!verdict.permitted) return { code: 3, verdict }

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

  const startArgs = ["start", opts.serviceName]
  if (runStep(startArgs) !== 0) {
    if (runStep(["is-failed", opts.serviceName]) !== 0) return { code: 1, step: "start" }
    runStep(["reset-failed", opts.serviceName])
    if (runStep(startArgs) !== 0) return { code: 1, step: "start" }
  }

  return { code: 0, settle }
}
