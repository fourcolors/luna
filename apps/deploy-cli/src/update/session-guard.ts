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
 * bypass without the line in hand to log.
 *
 * THE OTHER FOUR WARN LINES ARE NOW PORTED TOO, WHICH REVERSES THE REST OF
 * THAT PARAGRAPH. It used to end "the other bash warn lines inside
 * restart_session_guard are informational only; callers read `reason`/
 * `sessionCount`/`unitState` off the verdict instead". A typed verdict is
 * still what callers branch on, but "informational only" was never true of
 * the BYTES: bash emits five luna_warn lines from inside
 * restart_session_guard (:1468, :1477, :1491, :1494, :1497) and a port that
 * returns a verdict and says nothing is silent exactly where an operator
 * diagnosing a deferred deploy needs a line. guardVerdictLine below is the
 * one place that maps the verdict union to those five payloads; it lives
 * HERE rather than in flow-lines.ts precisely because only this module can
 * map GuardVerdict exhaustively, so a new arm is a compile error instead of
 * a silently-silent verdict. restart.ts emits it at bash's own position -
 * restart_service's very first statement (:1509).
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type GuardPermittedReason =
  | "dry-run"
  | "guard-disabled"
  | "non-systemd-supervisor"
  | "operator-override"
  | "zero-sessions"
  | "dead-server-exception"
  | "session-defer-stale"

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
       * Set when reason is "operator-override" or "session-defer-stale": the
       * byte-exact luna_warn payload for this permit, carried on the verdict
       * so granting the bypass and logging its audit line cannot come apart.
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
   * Profile name for the session-defer state file
   * (`$UPDATE_STATE_DIR/session-defer-$PROFILE`), matching bash's
   * `luna_session_defer_*` helpers. Required whenever maxSessionDefer can
   * fire (production wiring always passes config.profile).
   */
  readonly profile: string
  /**
   * `deploy.maxSessionDefer` / `--max-session-defer` / `LUNA_MAX_SESSION_DEFER`
   * as the raw systemd time span string (default "4h"). Parsed to seconds by
   * parseSystemdDuration — "0" / "infinity" disables the staleness escape.
   */
  readonly maxSessionDefer: string
  /**
   * `$UPDATE_STATE_DIR` (config.updateStateDir). Session-defer markers live
   * here beside the transaction journal so outer autodeploy and the engine
   * share one clock.
   */
  readonly updateStateDir: string
  /**
   * Optional pinned wall-clock seconds (mirrors bash `LUNA_TEST_NOW_EPOCH`).
   * Production omits this and uses `Date.now()/1000`.
   */
  readonly nowEpoch?: number
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
 * The `luna_warn` PAYLOAD restart_session_guard emits for this verdict, or
 * `null` for the four arms bash passes through in silence (:1462, :1463,
 * :1466, :1480). No `warning: ` prefix - the caller owns it, as with every
 * other line builder in this port.
 *
 * WHY A SWITCH WITH A `never` DEFAULT rather than a lookup table: a new
 * GuardVerdict arm must be a COMPILE error here, not a silent `null` that
 * makes the port quietly stop speaking where bash speaks. That is the whole
 * reason this function lives in this module instead of flow-lines.ts, which
 * cannot see the union.
 *
 * `readinessPort` is passed in rather than read off the verdict because the
 * verdict does not carry it and bash interpolates `$READINESS_PORT` from the
 * same global the count probe used; restart.ts passes its own guard options'
 * value, so the port printed is always the port counted.
 *
 * THE `?? ""` FALLBACKS ARE BASH-FAITHFUL, NOT DEFENSIVE PADDING.
 * `sessionCount` and `unitState` are optional on GuardVerdict because most
 * arms have no such value; on the three arms below the one constructor in
 * this file always sets them. If one were ever absent, bash's own `$n` /
 * `$state` expansion of an unset variable is the EMPTY STRING, so an empty
 * interpolation is what the oracle would print - never the JavaScript word
 * "undefined", which is a string no bash line can produce and which an
 * operator's grep would never match.
 */
export const guardVerdictLine = (verdict: GuardVerdict, readinessPort: string): string | null => {
  switch (verdict.reason) {
    // :1462 dry-run, :1463 guard-disabled, :1466 non-systemd-supervisor and
    // :1480 zero-sessions are bare `return 0`/`return`s in bash with no warn.
    case "dry-run":
    case "guard-disabled":
    case "non-systemd-supervisor":
    case "zero-sessions":
      return null
    // :1468. Reuses the auditLine already minted onto the verdict so the
    // logged bypass and the granted bypass cannot come apart (see above).
    case "operator-override":
      return verdict.auditLine ?? null
    /** :1477. */
    case "live-sessions":
      return `session guard: ${verdict.sessionCount ?? ""} active session(s) on :${readinessPort} — deferring restart`
    /** Staleness apply after deploy.maxSessionDefer (bash restart_session_guard). */
    case "session-defer-stale":
      return (
        verdict.auditLine ??
        `session guard: ${verdict.sessionCount ?? ""} active session(s) on :${readinessPort} — deploy.maxSessionDefer elapsed; applying despite standing sessions (staleness, not an operator override)`
      )
    /** :1491, the only guard line that appears on a PERMITTED run. */
    case "dead-server-exception":
      return `session guard: ws count unknown but unit answered '${verdict.unitState ?? ""}' — no server process; restart permitted`
    /** :1494. */
    case "transport-unreachable":
      return "session guard: transport never reached systemd — deferring (fail closed); a restart through the same transport could not succeed anyway"
    /** :1497. */
    case "unit-state-uncertain":
      return `session guard: ws count unknown while unit answers '${verdict.unitState ?? ""}' — may be serving; deferring (fail closed)`
    default: {
      const unhandled: never = verdict
      return unhandled
    }
  }
}

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

// countWsLines lived here and counted the probe's OUTPUT LINES. It is gone
// because the shared shell probe now does its own counting and prints a single
// decimal, so line-counting on this side would be a second, divergent notion of
// what a session is - which is the exact class of drift that shared probe text
// exists to prevent.

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
/**
 * BYTE-FOR-BYTE THE SAME SHELL PROBE `luna_active_ws_count` RUNS
 * (scripts/lib/luna-deploy.sh). Not a re-implementation of it - the same text.
 *
 * WHY THE SAME TEXT AND NOT A TYPESCRIPT PORT. This function previously WAS a
 * faithful port, and that is exactly how it inherited a live production bug:
 * the chat server holds a loopback connection to its own port, both ends owned
 * by the unit's own MainPID, and counting that self-pair as a user session made
 * the guard defer every deploy forever while exiting 0. One channel sat 154
 * commits behind, reporting success every three minutes.
 *
 * Fixing the bash did NOT fix this, because parity means the port reproduces
 * whatever bash does, including its defects - so a behavioural fix has to land
 * in two places, and the second one is easy to forget. It was forgotten: the
 * binary went on deferring on a host where the bash engine no longer did.
 *
 * Sharing the probe text removes the second place. The two engines cannot
 * disagree about what counts as a session, which is the one question where a
 * disagreement drops live users.
 */
const WS_COUNT_PROBE = `
port="$1"
command -v ss >/dev/null 2>&1 || exit 9
out="$(ss -tnH state established "( sport = :$port )" 2>/dev/null)" || exit 1
if [ -n "$out" ]; then total="$(printf "%s\\n" "$out" | wc -l)"; else total=0; fi
lp="$(ss -tlnHp "( sport = :$port )" 2>/dev/null | grep -o "pid=[0-9]*" | head -1)" || lp=""
self=0
if [ -n "$lp" ]; then
  selfout="$(ss -tnHp state established "( dport = :$port )" 2>/dev/null)" || selfout=""
  if [ -n "$selfout" ]; then self="$(printf "%s\\n" "$selfout" | grep -c "$lp," || true)"; fi
fi
[ -n "$self" ] || self=0
n=$((total - self))
[ "$n" -lt 0 ] && n=0
printf "%s" "$n"
`

export const queryActiveWsCountSync = (port: string, incusContainer?: string): number => {
  const r = incusContainer
    ? spawnSync("incus", ["exec", incusContainer, "--", "sh", "-c", WS_COUNT_PROBE, "_", port], { encoding: "utf8" })
    : spawnSync("sh", ["-c", WS_COUNT_PROBE, "_", port], { encoding: "utf8" })
  if (r.error || r.status !== 0) {
    const how = incusContainer ? "incus exec ss" : "ss"
    throw new Error(`${how} failed: ${r.error?.message ?? r.stderr ?? `exit ${r.status}`}`)
  }
  // The probe prints a single decimal. Anything else is a probe that did not
  // run correctly, and UNKNOWN must never degrade to "zero sessions".
  const text = stripTrailingNewlines(r.stdout ?? "")
  if (!/^[0-9]+$/.test(text)) throw new Error(`ss probe returned a non-numeric count: ${JSON.stringify(text)}`)
  return Number(text)
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

/**
 * Port of `luna_parse_systemd_duration` (scripts/lib/luna-deploy.sh).
 * Returns seconds, or null on garbage. "0" / "infinity" → 0 (disabled escape).
 */
export const parseSystemdDuration = (span: string): number | null => {
  const raw = span.trim().toLowerCase()
  if (raw === "") return null
  if (raw === "infinity") return 0
  let total = 0
  for (const tok of raw.split(/\s+/)) {
    const m = /^([0-9]+)([a-z]*)$/.exec(tok)
    if (!m) return null
    const num = Number(m[1])
    const unit = m[2] ?? ""
    switch (unit) {
      case "":
      case "s":
      case "sec":
      case "secs":
      case "second":
      case "seconds":
        total += num
        break
      case "m":
      case "min":
      case "mins":
      case "minute":
      case "minutes":
        total += num * 60
        break
      case "h":
      case "hr":
      case "hrs":
      case "hour":
      case "hours":
        total += num * 3600
        break
      case "d":
      case "day":
      case "days":
        total += num * 86400
        break
      case "w":
      case "week":
      case "weeks":
        total += num * 604800
        break
      default:
        return null
    }
  }
  return total
}

/** Port of `luna_session_defer_state_path`. */
export const sessionDeferStatePath = (updateStateDir: string, profile: string): string =>
  join(updateStateDir, `session-defer-${profile}`)

const readSince = (path: string): number | null => {
  try {
    const text = readFileSync(path, "utf8")
    const line = text.split("\n").find((l) => l.startsWith("since="))
    if (!line) return null
    const raw = line.slice("since=".length).trim()
    if (!/^[0-9]+$/.test(raw)) return null
    return Number(raw)
  } catch {
    return null
  }
}

/** Port of `luna_session_defer_mark` — idempotent first-seen stamp. */
export const sessionDeferMark = (updateStateDir: string, profile: string, nowEpoch: number): void => {
  const path = sessionDeferStatePath(updateStateDir, profile)
  if (readSince(path) !== null) return
  try {
    mkdirSync(updateStateDir, { recursive: true, mode: 0o700 })
  } catch {
    /* best-effort */
  }
  const tmp = `${path}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, `since=${nowEpoch}\n`, { mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

/** Port of `luna_session_defer_clear`. */
export const sessionDeferClear = (updateStateDir: string, profile: string): void => {
  try {
    unlinkSync(sessionDeferStatePath(updateStateDir, profile))
  } catch {
    /* ignore missing */
  }
}

/**
 * Port of `luna_session_defer_aged`. True when the defer window has aged past
 * maxSecs (caller may apply as staleness). False while within the window, or
 * when maxSecs is 0 (disabled). Marks the clock on every call.
 */
export const sessionDeferAged = (
  updateStateDir: string,
  profile: string,
  maxSecs: number,
  nowEpoch: number,
): boolean => {
  if (!Number.isInteger(maxSecs) || maxSecs <= 0) return false
  sessionDeferMark(updateStateDir, profile, nowEpoch)
  const since = readSince(sessionDeferStatePath(updateStateDir, profile))
  if (since === null) return false
  let age = nowEpoch - since
  if (age < 0) age = 0
  return age >= maxSecs
}

export const sessionDeferStaleLogLine = (
  sessionCount: number,
  readinessPort: string,
  maxSessionDefer: string,
): string =>
  `session guard: ${sessionCount} active session(s) on :${readinessPort} — deploy.maxSessionDefer=${maxSessionDefer} elapsed; applying despite standing sessions (staleness, not an operator override)`

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

  const nowEpoch = opts.nowEpoch ?? Math.floor(Date.now() / 1000)

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
    // independent of that promise. Unknown NEVER consults maxSessionDefer.
    let state = ""
    try {
      state = (opts.readUnitState ?? queryUnitStateSync)(opts.serviceName)
    } catch {
      state = ""
    }
    return unitStateVerdict(state)
  }
  if (n > 0) {
    const maxSecs = parseSystemdDuration(opts.maxSessionDefer) ?? 14400
    if (sessionDeferAged(opts.updateStateDir, opts.profile, maxSecs, nowEpoch)) {
      return {
        permitted: true,
        reason: "session-defer-stale",
        sessionCount: n,
        auditLine: sessionDeferStaleLogLine(n, opts.readinessPort, opts.maxSessionDefer),
      }
    }
    return { permitted: false, reason: "live-sessions", sessionCount: n }
  }
  sessionDeferClear(opts.updateStateDir, opts.profile)
  return { permitted: true, reason: "zero-sessions", sessionCount: n }
}
