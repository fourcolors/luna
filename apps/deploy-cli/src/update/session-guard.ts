/**
 * Fail-closed session guard: a port of restart_session_guard's decision
 * procedure (scripts/luna-update-server:1461-1500). THE invariant it
 * protects (scripts/luna-update-server:1440-1442): the operator is never
 * dropped mid-conversation by an unattended restart.
 *
 * NON-DECOUPLING FROM ITS CALLER: this module's dryRun/serviceName/
 * supervisor/readUnitState are never independently settable by a caller
 * that also controls the actual reload/stop/start - restart.ts's header
 * carries the one full statement of that contract; this module is only the
 * decision procedure, restart.ts is what enforces the wiring.
 *
 * FAIL-CLOSED IS NON-NEGOTIABLE (the abandon condition this slice was built
 * against) - but the guarantee is scoped, not absolute: four unconditional
 * bash-faithful passthroughs run BEFORE the count decision even starts -
 * dry-run, guard-disabled, non-systemd-supervisor, and an explicit operator
 * override - each a verbatim port of one of bash's own unconditional early
 * returns, so they permit ON PURPOSE, not as a gap. PAST those, the
 * decision is fail-closed: queryActiveWsCountSync (or an injected
 * SessionGuardOptions.queryActiveWsCount stand-in) is documented to throw
 * when the count cannot be established, mirroring luna_active_ws_count's
 * non-zero return (scripts/lib/luna-deploy.sh:243-289) - and a caller-side
 * validation at the restartSessionGuardSync call site treats a returned
 * value that is not a non-negative integer (NaN, negative, or a runtime
 * stand-in returning a non-number - bash's own "unknown" sentinel string
 * included) IDENTICALLY to a thrown query, never as a silently-accepted
 * zero. Either failure falls back to reading systemd is-active
 * (queryUnitStateSync, mirroring scripts/luna-update-server:1485-1497's
 * classification) and permits ONLY on the one proof that no supervised
 * process can exist (inactive/failed - the dead-server exception); every
 * other answer defers, including an unreachable transport (empty output).
 * queryActiveWsCountSync itself ports BOTH of luna_active_ws_count's arms
 * (bare-host ss(8) and the incus-exec arm) - see that function below.
 *
 * TEST SEAM: dependency injection only (SessionGuardOptions.
 * queryActiveWsCount / .readUnitState), never an ambient LUNA_TEST_* env
 * read from shipped code - the same pattern restart.ts uses for
 * runSystemctl/sleepSync, so a process that merely inherits a stray test
 * env var can never spoof the fail-closed decision.
 *
 * REVERSAL NOTE: apps/agent-cli/src/commands/update.ts's
 * queryActiveSessionCount shells out to bash's luna_active_ws_count instead
 * of reimplementing ss(8) ("one implementation to audit", PRD 3.4, G5).
 * This module reverses that call for deploy-cli specifically, since the
 * bash engine it folds into is being replaced, not called out to; the two
 * sites are unrelated and neither invokes the other.
 *
 * The operator-override log line is a byte-exact observable contract
 * (scripts/luna-update-server:1467-1469, the journalctl-of-the-invoking-
 * unit audit trail): operatorOverrideLogLine reproduces it byte-for-byte,
 * carried on the GuardVerdict as `auditLine` so a caller cannot grant the
 * bypass without the line in hand to log. The other bash warn lines inside
 * restart_session_guard are informational only; callers read
 * `reason`/`sessionCount`/`unitState` off the verdict instead.
 */
import { spawnSync } from "node:child_process"

export type GuardPermittedReason =
  | "dry-run"
  | "guard-disabled"
  | "non-systemd-supervisor"
  | "operator-override"
  | "zero-sessions"
  | "dead-server-exception"

export type GuardDeferredReason = "live-sessions" | "transport-unreachable" | "unit-state-uncertain"

/**
 * A discriminated union rather than a flat `permitted: boolean` plus a flat
 * reason union: pairing a deferring reason (e.g. "live-sessions") with
 * `permitted: true` is the exact class of bug this module exists to prevent,
 * so the type makes that pairing unrepresentable instead of merely untested.
 */
export type GuardVerdict =
  | {
      readonly permitted: true
      readonly reason: GuardPermittedReason
      /** Set only when a session count was actually established (zero-sessions). */
      readonly sessionCount?: number
      /** Set only when the ws count was unknown and a systemd is-active read was consulted (dead-server-exception). */
      readonly unitState?: string
      /**
       * Set only when reason is "operator-override": the byte-exact
       * operatorOverrideLogLine text for this override (scripts/luna-update-
       * server:1467-1469's luna_warn payload), carried on the verdict itself
       * so granting the bypass and logging its audit line cannot come apart
       * - a caller reads this off the verdict instead of reconstructing it
       * by hand.
       */
      readonly auditLine?: string
    }
  | {
      readonly permitted: false
      readonly reason: GuardDeferredReason
      /** Set only when a session count was actually established (live-sessions). */
      readonly sessionCount?: number
      /** Set only when the ws count was unknown and a systemd is-active read was consulted. */
      readonly unitState?: string
    }

export interface SessionGuardOptions {
  readonly dryRun: boolean
  readonly guardSessions: boolean
  readonly supervisor: "systemd" | "launchd"
  /** Non-empty means the operator explicitly overrode the guard (--operator-override). */
  readonly operatorOverrideReason?: string
  readonly serviceName: string
  /**
   * `READINESS_PORT` as the RAW STRING config.ts holds (config.ts:186/:358).
   * The value is interpolated into the ss(8) filter `( sport = :<port> )` and
   * nowhere else - no arithmetic - so parsing it to a number would only give an
   * operator's `--readiness-port 04753` a chance to reach ss(8) as a different
   * filter than the bash engine builds.
   */
  readonly readinessPort: string
  /**
   * Non-empty means the target is an incus container (mirrors the
   * `[incus_container]` argument to luna_active_ws_count, scripts/lib/
   * luna-deploy.sh:243-289). queryActiveWsCountSync routes the ss(8) probe
   * through `incus exec <container> -- sh -c ...` when this is set - see
   * that function below for the faithful port of BOTH of
   * luna_active_ws_count's arms.
   *
   * The is-active FALLBACK read (queryUnitStateSync, or a caller-injected
   * readUnitState) stays host-scoped, by contrast: bash's own fallback
   * routes through run_target_capture (scripts/luna-update-server:365-371,
   * which execs inside the container when INCUS_CONTAINER is set), but this
   * port's fallback does not - the same host-only boundary restart.ts's own
   * reload/stop/start already draw for incus targets (see that module's
   * header). A guard used standalone (not via restartServiceSync) with a
   * container target AND an unknown count therefore falls back to a HOST
   * is-active read; this is a documented scope gap, not a silent one -
   * closing it is future-slice work alongside actually wiring restart.ts's
   * own reload/stop/start through incus.
   */
  readonly incusContainer?: string
  /**
   * Injected active-ws-count reader. Defaults to queryActiveWsCountSync (the
   * real ss(8)/incus-exec probe) - see this module's header for why this is
   * dependency injection rather than an env-var seam. Called with this
   * options object's own readinessPort/incusContainer.
   */
  readonly queryActiveWsCount?: (port: string, incusContainer?: string) => number
  /**
   * Injected systemd is-active reader for the "count unknown" fallback.
   * Defaults to queryUnitStateSync (bare-host systemctl). restartServiceSync
   * (restart.ts) fills this from its OWN runSystemctl so the guard always
   * interrogates the SAME systemd transport/instance the primitive's
   * reload/stop/start calls act on.
   */
  readonly readUnitState?: (serviceName: string) => string
}

/** Byte-exact contract line (scripts/luna-update-server:1468's luna_warn payload). */
export const operatorOverrideLogLine = (reason: string): string => `SESSION GUARD OVERRIDDEN by operator: ${reason}`

/**
 * Strips ONLY trailing newlines, mirroring bash's `$(...)` command
 * substitution - never a full `.trim()`, so leading/embedded whitespace in a
 * subprocess's own stdout survives exactly as bash would see it (a
 * whitespace-only, non-empty line is a real counted row in bash, not
 * nothing). Exported so restart.ts's own is-active read (its `readUnitState`
 * passed to restartSessionGuardSync) can share this SAME stripping instead
 * of a second, independently-written `.trim()` that would silently launder
 * a CR or embedded space `queryUnitStateSync` below is careful to preserve -
 * see both call sites' comments for the fail-open a bare `.trim()` caused
 * there (a polluted 'inactive\r\n'/' inactive\n'/'failed \n' answer would
 * `.trim()`-match the known-safe state and PERMIT a restart where bash's own
 * `case` statement - matching on its own untouched, non-trimmed `$state` -
 * defers).
 */
export const stripTrailingNewlines = (s: string): string => s.replace(/\n+$/, "")

/** Mirrors `[[ -n "$out" ]] && printf '%s\n' "$out" | wc -l || n=0` (scripts/lib/luna-deploy.sh:279/284) against output already stripped of trailing newlines by stripTrailingNewlines. */
const countWsLines = (strippedOut: string): number => (strippedOut === "" ? 0 : strippedOut.split("\n").length)

/**
 * Real ss(8)/incus-exec probe: a faithful port of BOTH of
 * luna_active_ws_count's arms (scripts/lib/luna-deploy.sh:263-289) - the
 * bare-host arm (no incusContainer) and the incus-routed arm (incusContainer
 * set), which execs `sh -c "command -v ss ... ; ss -tnH state established
 * '( sport = :$port )' ..."` INSIDE the named instance byte-for-byte,
 * because dev terminates ws connections inside the container so checking
 * the host would always read 0 and defeat the deferral guard. Both arms
 * throw when the count cannot be established: a missing/failing ss(8) (or,
 * for the incus arm, an unreachable incus daemon/instance or a missing
 * in-container ss) - mirroring luna_active_ws_count's non-zero return. A
 * caller MUST treat a throw here as "unknown", never as zero. This is the
 * production default for SessionGuardOptions.queryActiveWsCount; it has no
 * test seam of its own (LUNA_TEST_WS_COUNT is bash's seam, not this port's)
 * - see this module's header.
 */
export const queryActiveWsCountSync = (port: string, incusContainer?: string): number => {
  if (incusContainer) {
    const innerScript = `command -v ss >/dev/null 2>&1 || exit 9; ss -tnH state established '( sport = :${port} )' 2>/dev/null`
    const r = spawnSync("incus", ["exec", incusContainer, "--", "sh", "-c", innerScript], { encoding: "utf8" })
    if (r.error || r.status !== 0) {
      throw new Error(`incus exec ss failed: ${r.error?.message ?? r.stderr ?? `exit ${r.status}`}`)
    }
    return countWsLines(stripTrailingNewlines(r.stdout ?? ""))
  }
  const r = spawnSync("ss", ["-tnH", "state", "established", `( sport = :${port} )`], { encoding: "utf8" })
  if (r.error || r.status !== 0) {
    throw new Error(`ss failed: ${r.error?.message ?? r.stderr ?? `exit ${r.status}`}`)
  }
  return countWsLines(stripTrailingNewlines(r.stdout ?? ""))
}

/**
 * `systemctl is-active <unit>` output, stripped of ONLY its trailing
 * newline(s) via stripTrailingNewlines (never a full `.trim()` - see that
 * function's doc for why a full trim is a fail-open here) - mirrors
 * `run_target_capture systemctl is-active "$SERVICE_NAME" 2>/dev/null ||
 * true` (scripts/luna-update-server:1485): stderr and a non-zero exit are
 * both swallowed, exactly like bash's `|| true`, because a missing unit
 * still prints "inactive" to stdout with rc=4 - non-empty output IS the
 * proof transport reached systemd; only empty output is inconclusive. Never
 * throws: any spawn failure (ENOENT, ...) degrades to the same empty string
 * bash's own transport-failure case observes. This is the production
 * default for SessionGuardOptions.readUnitState; restartServiceSync
 * (restart.ts) overrides it with its own runSystemctl-routed reader (using
 * this SAME stripTrailingNewlines) so the two never diverge - see this
 * module's header. Host-scoped only (no incusContainer routing) - see
 * SessionGuardOptions.incusContainer's doc.
 */
export const queryUnitStateSync = (serviceName: string): string => {
  const r = spawnSync("systemctl", ["is-active", serviceName], { encoding: "utf8" })
  return stripTrailingNewlines(r.stdout ?? "")
}

const unitStateVerdict = (state: string): GuardVerdict => {
  if (state === "inactive" || state === "failed") {
    return { permitted: true, reason: "dead-server-exception", unitState: state }
  }
  if (state === "") return { permitted: false, reason: "transport-unreachable", unitState: state }
  return { permitted: false, reason: "unit-state-uncertain", unitState: state }
}

export const restartSessionGuardSync = (opts: SessionGuardOptions): GuardVerdict => {
  if (opts.dryRun) return { permitted: true, reason: "dry-run" }
  if (!opts.guardSessions) return { permitted: true, reason: "guard-disabled" }
  if (opts.supervisor !== "systemd") return { permitted: true, reason: "non-systemd-supervisor" }
  if (opts.operatorOverrideReason) {
    return {
      permitted: true,
      reason: "operator-override",
      auditLine: operatorOverrideLogLine(opts.operatorOverrideReason),
    }
  }

  let n: number
  try {
    const raw = (opts.queryActiveWsCount ?? queryActiveWsCountSync)(opts.readinessPort, opts.incusContainer)
    // Seam-boundary validation: queryActiveWsCount is an injectable stand-in
    // that TypeScript's return type cannot enforce at runtime, so a bad
    // implementation (or bash's own "unknown" sentinel string passed
    // through unchanged by a naive caller) must be caught HERE, not trusted.
    // Anything that is not a non-negative integer is UNKNOWN - the same
    // fail-closed branch a thrown query takes below - never a silently
    // accepted zero (a negative count, treated as "not > 0", would otherwise
    // fall through to "permitted: zero-sessions").
    if (!Number.isInteger(raw) || raw < 0) {
      throw new Error(`active ws count is not a non-negative integer: ${String(raw)}`)
    }
    n = raw
  } catch {
    // Count unknown (including a thrown query or an invalid return value):
    // fall through to the systemd fallback read. That read is itself
    // wrapped - it never throws in practice (see queryUnitStateSync), but a
    // defensive catch here keeps this function's fail-closed guarantee
    // independent of that promise.
    let state = ""
    try {
      state = (opts.readUnitState ?? queryUnitStateSync)(opts.serviceName)
    } catch {
      state = ""
    }
    return unitStateVerdict(state)
  }
  if (n > 0) return { permitted: false, reason: "live-sessions", sessionCount: n }
  return { permitted: true, reason: "zero-sessions", sessionCount: n }
}
