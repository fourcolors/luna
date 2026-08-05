/**
 * sd_notify integration for systemd `Type=notify` units (liveness ladder L1).
 *
 * The chat-server unit declares `Type=notify` + `WatchdogSec=`: systemd holds
 * the unit in `activating` until READY=1 arrives, then expects WATCHDOG=1
 * beats or it SIGABRTs the process (and `Restart=always` respawns it). That
 * turns "alive but wedged" — the failure class plain Restart= can never see —
 * into an automatic restart.
 *
 * Two design constraints shape this module:
 *
 * 1. Bun has no unix-datagram socket API, so beats shell out to the
 *    `systemd-notify` binary instead of writing NOTIFY_SOCKET directly. The
 *    sender is therefore a CHILD pid, which is why the unit must set
 *    `NotifyAccess=all`, and why `--pid=parent` is passed so attribution
 *    points at the main pid (root-run units may fake sender ucreds). Floor:
 *    systemd >= 246 — older systemd-notify races its own exit against pid-1
 *    attribution ("Cannot find unit for notify message") and silently drops
 *    messages; a dropped READY=1 turns into a start-timeout cycle. The
 *    production containers run systemd 259. Outside systemd (macOS dev,
 *    tests, plain `bun run`) NOTIFY_SOCKET is absent and the whole module is
 *    an inert no-op.
 *
 * 2. A heartbeat that ticks while the server is wedged is worse than none
 *    (that exact bug let Sol's liveness file tick to the end). Every beat is
 *    GATED: the interval's own wake-up drift is the event-loop-lag sensor,
 *    and each tick must also pass a real end-to-end `/healthz` probe on the
 *    serving socket plus a state-dir writability check before WATCHDOG=1 is
 *    sent. A wedged event loop stops the timer itself — beats stop, systemd
 *    fires. A healthy loop with a broken server skips the beat — same result.
 */
import { spawnSync } from "node:child_process"
import { accessSync, constants } from "node:fs"

export type SdNotifyEnv = Readonly<Record<string, string | undefined>>

/**
 * Capture the notify env at module load and SCRUB it from process.env: the
 * chat-server spawns agent-controlled descendants (SDK subprocess, tool
 * commands, MCP servers) which would otherwise inherit NOTIFY_SOCKET and —
 * under NotifyAccess=all — could spoof STOPPING=1/WATCHDOG=1/MAINPID= at
 * Luna's unit, keeping a wedged server "beating" or wedging a healthy one.
 * Only the deliberate systemd-notify sender child gets the socket back
 * (explicitly, in makeSpawnNotifySender). The supervised-restart checks
 * elsewhere use INVOCATION_ID, which systemd always sets and which stays.
 */
const CAPTURED_NOTIFY_ENV: SdNotifyEnv = {
  NOTIFY_SOCKET: process.env["NOTIFY_SOCKET"],
  WATCHDOG_USEC: process.env["WATCHDOG_USEC"],
}
delete process.env["NOTIFY_SOCKET"]
delete process.env["WATCHDOG_USEC"]

/** The runtime notify env (captured pre-scrub). Tests pass their own env. */
export const capturedNotifyEnv = (): SdNotifyEnv => CAPTURED_NOTIFY_ENV

export type NotifySender = (state: string) => boolean

/**
 * Beat at one third of the WatchdogSec budget (systemd's own recommendation),
 * clamped to [5s, 30s]. Falls back to 30s when WATCHDOG_USEC is absent or
 * unparseable — with WatchdogSec=90 that still leaves three chances per window.
 */
export const resolveWatchdogIntervalMs = (env: SdNotifyEnv): number => {
  const usec = Number(env["WATCHDOG_USEC"] ?? "")
  if (!Number.isFinite(usec) || usec <= 0) return 30_000
  const thirdMs = Math.floor(usec / 1000 / 3)
  return Math.min(30_000, Math.max(5_000, thirdMs))
}

export const sdNotifyActive = (env: SdNotifyEnv): boolean =>
  (env["NOTIFY_SOCKET"] ?? "").length > 0

/**
 * Sender backed by the `systemd-notify` binary. Latches itself off after a
 * spawn-level failure (binary missing) so a misconfigured host logs once and
 * never pays the spawn cost again; a non-zero exit does NOT latch (transient).
 */
export const makeSpawnNotifySender = (deps?: {
  readonly spawn?: typeof spawnSync
  readonly log?: (msg: string) => void
  readonly env?: SdNotifyEnv
}): NotifySender => {
  const spawn = deps?.spawn ?? spawnSync
  const log = deps?.log ?? ((msg) => console.warn(msg))
  const notifyEnv = deps?.env ?? CAPTURED_NOTIFY_ENV
  let disabled = false
  return (state) => {
    if (disabled) return false
    const result = spawn("systemd-notify", ["--pid=parent", state], {
      stdio: "ignore",
      timeout: 5_000,
      // process.env was scrubbed of NOTIFY_SOCKET at module load; hand it
      // back to this one deliberate child only.
      env: { ...process.env, ...notifyEnv } as NodeJS.ProcessEnv,
    })
    if (result.error !== undefined) {
      // Latch off ONLY on the permanent case (binary missing). ETIMEDOUT and
      // other transient spawn errors must NOT kill the heartbeat for the
      // life of the process — one 5s pid-1 hiccup would otherwise turn into
      // a guaranteed watchdog SIGABRT ~90s later.
      const code = (result.error as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        disabled = true
        log(
          `sd-notify: systemd-notify unavailable (${String(result.error)}) — heartbeat disabled`,
        )
      } else {
        log(
          `sd-notify: systemd-notify transient failure (${String(result.error)}) — will retry next beat`,
        )
      }
      return false
    }
    return result.status === 0
  }
}

export interface BeatProbeResult {
  readonly healthzOk: boolean
  readonly stateDirWritable: boolean
  readonly wakeLagMs: number
}

/**
 * Pure beat gate. `lagThresholdMs` is deliberately generous (10s): the lag
 * sensor exists to catch a *wedged* event loop, not a busy one — a legitimate
 * heavy turn must never starve the beat into a false restart.
 */
export const shouldBeat = (
  probe: BeatProbeResult,
  lagThresholdMs = 10_000,
): boolean =>
  probe.healthzOk &&
  probe.stateDirWritable &&
  probe.wakeLagMs < lagThresholdMs

export interface StartSdWatchdogOptions {
  /** Port the ui-ws HTTP listener serves on. */
  readonly port: number
  /**
   * Host the listener is BOUND to. Production binds the Tailscale IP only
   * (LUNA_UI_WS_HOST), so probing loopback there would ECONNREFUSED forever
   * and the withheld beats would watchdog-kill a healthy server. Wildcard
   * binds (0.0.0.0/::) and absence map to 127.0.0.1.
   */
  readonly host?: string
  /** LUNA_HOME — the dir the DBs/logs/.env live in; probed for W_OK. */
  readonly lunaHome: string
  readonly env?: SdNotifyEnv
  readonly sender?: NotifySender
  readonly fetchFn?: typeof fetch
  readonly setIntervalFn?: typeof setInterval
  readonly now?: () => number
  readonly log?: (msg: string) => void
}

export interface SdWatchdogHandle {
  readonly active: boolean
  readonly stop: () => void
}

const INACTIVE_HANDLE: SdWatchdogHandle = { active: false, stop: () => {} }

/** Map the listener's bind host to a probe-able address. Exported for tests. */
export const resolveProbeHost = (host: string | undefined): string => {
  const bare = (host ?? "").replace(/^\[|\]$/g, "")
  if (bare === "" || bare === "0.0.0.0") return "127.0.0.1"
  // Any all-zeros IPv6 spelling ("::", "0:0:0:0:0:0:0:0", "0000:…") is a
  // wildcard bind.
  if (bare.includes(":") && /^[0:]+$/.test(bare)) return "127.0.0.1"
  return bare
}

/** IPv6 literals must be bracketed in URLs (tailnet fd7a:… binds are real). */
export const probeUrlHost = (probeHost: string): string =>
  probeHost.includes(":") ? `[${probeHost}]` : probeHost

/**
 * One-shot STOPPING=1 for self-initiated shutdowns (SIGTERM restarts): tells
 * systemd the unit is deactivating so a slow drain is judged by
 * TimeoutStopSec, not SIGABRTed mid-shutdown by the still-armed watchdog.
 * No-op outside systemd.
 */
export const notifyStopping = (
  env: SdNotifyEnv = CAPTURED_NOTIFY_ENV,
  sender?: NotifySender,
): void => {
  if (!sdNotifyActive(env)) return
  const send = sender ?? makeSpawnNotifySender({ env })
  send("STOPPING=1")
}

/**
 * Send READY=1 and start the gated WATCHDOG=1 loop. Call exactly once, at the
 * moment the server is genuinely accepting connections (both normal and
 * setup mode — the unit's WatchdogSec applies to either). No-op without
 * NOTIFY_SOCKET. The interval is unref'd: it never keeps the process alive.
 */
export const startSdWatchdog = (
  opts: StartSdWatchdogOptions,
): SdWatchdogHandle => {
  // Default to the CAPTURED env — process.env was scrubbed at module load.
  const env = opts.env ?? CAPTURED_NOTIFY_ENV
  const log = opts.log ?? ((msg) => console.log(msg))
  if (!sdNotifyActive(env)) {
    return INACTIVE_HANDLE
  }
  const sender = opts.sender ?? makeSpawnNotifySender({ env })
  const fetchFn = opts.fetchFn ?? fetch
  const setIntervalFn = opts.setIntervalFn ?? setInterval
  const now = opts.now ?? Date.now
  const intervalMs = resolveWatchdogIntervalMs(env)

  const readyOk = sender("READY=1")
  if (readyOk) {
    log(
      `🫀 sd-notify: READY sent; gated watchdog heartbeat every ${Math.round(intervalMs / 1000)}s`,
    )
  } else {
    // A dropped READY leaves the unit in `activating` until TimeoutStartSec,
    // then a restart cycle — make the cause findable in the append-file log.
    log(
      `sd-notify: READY=1 send FAILED — unit will start-timeout unless a later beat lands; check systemd-notify availability`,
    )
  }

  const probeHost = resolveProbeHost(opts.host)
  let lastTick = now()
  let inFlight = false
  let skipStreak = 0

  const logSkip = (reason: string): void => {
    skipStreak += 1
    // First skip and every 4th after: loud enough to diagnose from the
    // append-file log, quiet enough not to flood it while systemd counts
    // down to the restart this skip is asking for.
    if (skipStreak === 1 || skipStreak % 4 === 0) {
      log(
        `sd-notify: heartbeat SKIPPED (streak=${skipStreak} ${reason}) — systemd will restart if this persists`,
      )
    }
  }

  const timer = setIntervalFn(() => {
    const tickAt = now()
    const wakeLagMs = Math.max(0, tickAt - lastTick - intervalMs)
    lastTick = tickAt
    if (inFlight) {
      // Previous probe still running (stalled fetch) — a real skip: count and
      // log it, or a persistently-stalling probe would starve beats silently.
      logSkip("probe-still-in-flight")
      return
    }
    inFlight = true
    void (async () => {
      let healthzOk = false
      try {
        const res = await fetchFn(
          `http://${probeUrlHost(probeHost)}:${opts.port}/healthz`,
          {
            signal: AbortSignal.timeout(3_000),
          },
        )
        healthzOk = res.ok
      } catch {
        healthzOk = false
      }
      let stateDirWritable = false
      try {
        accessSync(opts.lunaHome, constants.W_OK)
        stateDirWritable = true
      } catch {
        stateDirWritable = false
      }
      const probe: BeatProbeResult = { healthzOk, stateDirWritable, wakeLagMs }
      if (shouldBeat(probe)) {
        sender("WATCHDOG=1")
        skipStreak = 0
      } else {
        logSkip(
          `healthz=${healthzOk} writable=${stateDirWritable} lagMs=${wakeLagMs}`,
        )
      }
      inFlight = false
    })()
  }, intervalMs)
  timer.unref?.()

  return { active: true, stop: () => clearInterval(timer) }
}
