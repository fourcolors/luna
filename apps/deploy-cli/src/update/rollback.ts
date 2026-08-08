/**
 * `fail_forward` and `do_rollback` (scripts/luna-update-server:1793-1870): the
 * decision of what to do when a deploy fails, and the only path that can leave
 * a host running something other than what was asked for.
 *
 * ORCHESTRATION IS WHAT THIS PORTS. The collaborators it drives - apply_ref,
 * restart_service, readiness_ok, the journal writes - arrive as injected
 * seams, the same way restart.ts injects `runSystemctl`. What lives here is
 * the control flow between them: which failures roll back, which exit code
 * each outcome carries, and which of the three warning lines an operator sees.
 * That control flow IS the slice; apply_ref's own git/bun work is S24's.
 *
 * THREE OPERATOR-FACING STRINGS ARE BYTE-EXACT AND CARRY AN EM DASH ON
 * PURPOSE - the rollback marker (scripts/luna-update-server:1839), the
 * CRITICAL line (1841-1843) and the guard-defer line (1830). Every em dash in
 * this file sits inside one of those three ports; none is prose of mine.
 *
 * The marker is the load-bearing one:
 * packages/server-registry/src/driver/luna-chat-server.ts:164 classifies the
 * outcome by testing `result.stderr.includes("ROLLED BACK to")`. This repo
 * otherwise writes a plain dash; here fidelity to strings another program
 * parses - and that an operator diffs against a bash host's output during an
 * incident - outranks the house style. Normalising them would be a silent
 * behaviour change dressed as a typographical one, which is why
 * rollback-parity.test.ts fails if the dash is swapped.
 *
 * THE GUARD EXEMPTION IS SCOPED, AND THE SCOPE IS THE WHOLE POINT
 * (scripts/luna-update-server:1798-1814). Two cases, and they are not
 * symmetric:
 *
 *   forwardRestartRan = true  - the forward restart ALREADY interrupted
 *     service, so the session guard has nothing left to protect and blocking
 *     the rollback would strand a broken build. The guard is disabled for the
 *     rollback restart, which therefore cannot return 3.
 *
 *   forwardRestartRan = false - an APPLY-phase failure. The OLD server never
 *     stopped and is still serving, and sessions may have been established
 *     since the pre-mutation guard check. The guard stays ACTIVE: a defer
 *     restores nothing further (the checkout is already back at PREV, matching
 *     the still-running build), keeps the journal at phase=rolling-back, and
 *     exits 3 so the next idle tick finishes the rollback restart.
 *
 * An unconditional exemption would be the easy port and would silently take
 * down live sessions on the apply-phase path.
 *
 * READINESS IS RECONFIGURED BY THIS FUNCTION, NOT BY ITS CALLER. bash sets
 * EXPECTED_BUILD_SHA=$PREV and ALLOW_MISSING_BUILD_SHA=true before probing
 * (1817-1818), because the rollback target may legitimately predate /readyz's
 * additive buildSha field. `runReadiness` therefore receives both values from
 * here rather than being handed a pre-configured probe - a caller that could
 * set them independently could probe for the wrong build entirely.
 *
 * OUT OF SCOPE: `do_rollback_releases` (the releases-layout branch at 1794-
 * 1796, which always exits) and `lockfile_hash`. Callers on the releases
 * layout must not reach this function; `RollbackOptions.layout` exists so that
 * is an explicit refusal rather than a silent wrong answer.
 */

/** Exit 1: readiness failed but the rollback succeeded (scripts/luna-update-server:173). */
export const EXIT_ROLLED_BACK = 1
/** Exit 2: readiness failed AND the rollback also failed; the server may be down (174). */
export const EXIT_CRITICAL = 2
/** Exit 3: deferred by the session guard; the journal is retained and resumes when idle (176). */
export const EXIT_DEFERRED = 3

/**
 * scripts/luna-update-server:1839, byte for byte. See this module's header for
 * why the em dash survives the port.
 */
export const rolledBackMarker = (ref: string, prev: string, serviceName: string): string =>
  `update to ${ref} failed — ROLLED BACK to ${prev} (${serviceName} healthy)`

export type Supervisor = "systemd" | "launchd"

export interface RemediationContext {
  readonly supervisor: Supervisor
  readonly systemdUser: boolean
  readonly uid: string
  readonly launchdLabel: string
  readonly serviceName: string
}

/**
 * The remediation hint (scripts/luna-update-server:1845-1853). Split by
 * supervisor deliberately: "pointing a macOS operator at `systemctl`/
 * `journalctl` during an outage sends them to dead-ends" is the bash's own
 * rationale, and it only matters when someone is reading it at 3am.
 */
export function remediationHint(ctx: RemediationContext): string {
  if (ctx.supervisor === "launchd") {
    return `launchctl print gui/${ctx.uid}/${ctx.launchdLabel}; log show --last 10m --predicate 'process == "bun"'`
  }
  if (ctx.systemdUser) {
    return `systemctl --user status ${ctx.serviceName}; journalctl --user -u ${ctx.serviceName}`
  }
  return `systemctl status ${ctx.serviceName}; journalctl -u ${ctx.serviceName}`
}

/** scripts/luna-update-server:1841-1843 - the CRITICAL line, byte-exact. */
export const criticalLine = (ref: string, prev: string, hint: string): string =>
  `CRITICAL: update to ${ref} failed AND rollback to ${prev} also failed — server may be DOWN. Manual intervention required (check: ${hint}).`

export interface RollbackReadinessRequest {
  /** Always PREV on this path (scripts/luna-update-server:1817). */
  readonly expectedBuildSha: string
  /** Always true on this path (1818); see the header. */
  readonly allowMissingBuildSha: boolean
}

export interface RollbackOptions extends RemediationContext {
  /** The forward target that failed. */
  readonly ref: string
  /** The sha being rolled back to. */
  readonly prev: string
  /** Refused unless "bare" - the releases layout has its own exit-always path. */
  readonly layout: "bare" | "releases"
  /** Whether the forward restart already interrupted service. See the header. */
  readonly forwardRestartRan: boolean

  /** `apply_ref "$PREV" ... --no-fetch`; true on success. */
  readonly applyRef: (prev: string) => boolean
  /** `restart_service`; returns its rc, where 3 is the session-guard defer. */
  readonly restartService: (guardSessions: boolean) => number
  /** `readiness_ok "$rollback_baseline"` with the two values this function pins. */
  readonly runReadiness: (request: RollbackReadinessRequest) => boolean
  readonly writeTransaction: (phase: string) => void
  readonly clearTransaction: () => void
  readonly warn: (line: string) => void
}

export interface RollbackOutcome {
  readonly exitCode: typeof EXIT_ROLLED_BACK | typeof EXIT_CRITICAL | typeof EXIT_DEFERRED
  /** Whether the session guard stayed active for the rollback restart. */
  readonly guardSessions: boolean
}

/**
 * `do_rollback` (scripts/luna-update-server:1793-1859).
 *
 * Every exit path writes or clears the journal before returning, because the
 * journal is what lets the next idle tick finish an interrupted rollback -
 * a path that exits without touching it strands the host mid-transaction.
 */
export function doRollbackSync(options: RollbackOptions): RollbackOutcome {
  if (options.layout === "releases") {
    throw new Error(
      "doRollbackSync is the bare-layout path; the releases layout rolls back through do_rollback_releases (scripts/luna-update-server:1736), which is not part of this port",
    )
  }
  const { ref, prev, forwardRestartRan, applyRef, restartService, runReadiness, writeTransaction, clearTransaction, warn } = options

  // The scoped exemption - see the header on why these two cases differ.
  const guardSessions = !forwardRestartRan
  warn(
    forwardRestartRan
      ? "rollback restart proceeds without the session guard: the forward restart already interrupted service, and blocking rollback would strand a broken build"
      : "rollback after an apply-phase failure: the old server was never stopped, so the session guard stays ACTIVE for the rollback restart",
  )

  warn(`ROLLING BACK to ${prev}`)
  writeTransaction("rolling-back")

  let ok = applyRef(prev)
  if (ok) {
    const rc = restartService(guardSessions)
    if (rc === EXIT_DEFERRED) {
      // Only reachable when the guard stayed active (apply-phase failure, old
      // server still serving). The checkout is already back at PREV - the
      // state the running server was built from - so nothing is stranded; the
      // journal (phase=rolling-back) resumes the restart on the next idle tick.
      warn(
        `rollback restart DEFERRED by session guard (old server still serving; checkout already restored to ${prev}); transaction journal retained (phase=rolling-back) — resumes when sessions end`,
      )
      return { exitCode: EXIT_DEFERRED, guardSessions }
    }
    if (rc !== 0) ok = false
  }

  if (ok && runReadiness({ expectedBuildSha: prev, allowMissingBuildSha: true })) {
    warn(rolledBackMarker(ref, prev, options.serviceName))
    clearTransaction()
    return { exitCode: EXIT_ROLLED_BACK, guardSessions }
  }

  writeTransaction("rollback-failed")
  return { exitCode: EXIT_CRITICAL, guardSessions }
}

export interface FailForwardOptions extends RollbackOptions {
  /** `--no-rollback`: die at the new ref instead of rolling back. */
  readonly rollbackEnabled: boolean
  /** `${NEW_HEAD:-$REF}` - the head actually checked out, when known. */
  readonly newHead: string | null
}

export type FailForwardOutcome =
  | { readonly kind: "died"; readonly exitCode: 1; readonly message: string }
  | { readonly kind: "rolled-back"; readonly outcome: RollbackOutcome }

/**
 * `fail_forward` (scripts/luna-update-server:1861-1870).
 *
 * With `--no-rollback` this records phase=forward-failed and dies at the new
 * ref: exit 1 through `luna_die` (scripts/lib/luna-deploy.sh:6), the same code
 * a preflight error uses. The journal write happens FIRST so a host left on an
 * unhealthy build is still recorded as mid-transaction.
 */
export function failForwardSync(reason: string, options: FailForwardOptions): FailForwardOutcome {
  const head = options.newHead ?? options.ref
  options.warn(`update to ${options.ref} failed: ${reason} (HEAD=${head})`)

  if (!options.rollbackEnabled) {
    options.writeTransaction("forward-failed")
    return {
      kind: "died",
      exitCode: 1,
      message: `${reason} and --no-rollback set; server left at ${head} (may be unhealthy)`,
    }
  }
  return { kind: "rolled-back", outcome: doRollbackSync(options) }
}
