/**
 * The bounded readiness poll: a behavioral port of `readiness_ok` and
 * `readiness_restart_baseline` (scripts/luna-update-server:1060-1130).
 *
 * This is the gate that decides whether a deploy is promoted or rolled back,
 * so the ORDER of its checks is the contract, not an implementation detail.
 * Each rung only runs once the one above it passes:
 *
 *   1. the unit reports `active`
 *   2. NRestarts has not climbed past the post-restart baseline (crash loop)
 *   3. /healthz answers 200
 *   4. /readyz reports "mode":"normal" AND, when a build sha is expected,
 *      a buildSha that identifies it
 *
 * "Behavioral", not byte-exact, in the same sense restart.ts uses the term:
 * this returns a typed verdict instead of setting a global and warning
 * through `luna_warn`. The one artifact that IS byte-exact is
 * `ReadinessResult.detail` - bash's `READINESS_DETAIL`, which the give-up
 * warning interpolates verbatim and which is the only diagnosis an operator
 * gets for a rolled-back deploy. Every string below is transcribed from the
 * bash rather than paraphrased, including the parenthetical hints.
 *
 * THREE DISTINCTIONS THAT LOOK LIKE DETAILS AND ARE NOT:
 *
 * `000` IS NOT `404`. curl reports a transport failure as `000`, and the bash
 * comments why this must never be conflated with a real 404: the process
 * frequently dies BETWEEN the healthz and readyz probes, and treating that as
 * "legacy build without /readyz" would accept a corpse as ready. Only a
 * literal `404` takes the legacy-accept path (scripts/luna-update-server:
 * 1094-1097).
 *
 * THE BUILD SHA MATCHES BY PREFIX IN EITHER DIRECTION. `$EXPECTED == $build*`
 * OR `$build == $EXPECTED*`, because one side may be a short sha and the
 * other full (scripts/luna-update-server:1108). A strict equality port would
 * reject every correct deploy where the runtime resolved a 12-char sha.
 *
 * AN ABSENT buildSha IS ACCEPTED ONLY UNDER `allowMissingBuildSha`. That flag
 * is set exclusively by the rollback path, where PREV may legitimately predate
 * /readyz's additive buildSha field. On the forward path an absent sha is a
 * FAILURE - otherwise a runtime that resolved its sha to "unknown" (no
 * git/.git present) would promote any build at all.
 *
 * OUT OF SCOPE, deliberately: the `run_target_capture` incus routing. The
 * probes arrive here as injected functions, so the caller decides whether a
 * curl runs on the host or inside a container - the same seam restart.ts
 * draws around `runSystemctl`, and the reason this module needs no bare-host
 * caveat of its own.
 */

/** `LUNA_READINESS_PORT:-4753` (scripts/luna-update-server:86). */
export const READINESS_PORT_DEFAULT = 4753
/** `LUNA_READINESS_TIMEOUT:-60` (scripts/luna-update-server:87). */
export const READINESS_TIMEOUT_DEFAULT = 60
/** `LUNA_READINESS_INTERVAL:-2` (scripts/luna-update-server:88). */
export const READINESS_INTERVAL_DEFAULT = 2
/** `LUNA_READINESS_CURL_MAX_TIME:-5` (scripts/luna-update-server:89). */
export const READINESS_CURL_MAX_TIME_DEFAULT = 5

/** `[[ "$n" =~ ^[0-9]+$ ]]` - the restart-count validation both bash sites share. */
const RESTART_COUNT_FORMAT = /^[0-9]+$/

/**
 * The buildSha extraction, ported from the `sed -n` one-liner at
 * scripts/luna-update-server:1105 - which pulls the FIRST `"buildSha":"<hex>"`
 * out of the /readyz body and tolerates an empty capture. Its literal text is
 * not reproduced here: the bash contains the two characters that close a block
 * comment, and a transcription that silently truncates this file is a worse
 * kind of infidelity than a paraphrase.
 */
const BUILD_SHA_FROM_READYZ = /"buildSha":"([0-9a-fA-F]*)"/

/**
 * What the readyz probe hands back: curl is invoked with
 * `-w '\n%{http_code}'`, so the body and the code arrive in one string
 * separated by a newline, and the code is the segment after the LAST newline
 * (`${readyz##*$'\n'}`). Modelled as the raw string rather than a parsed pair
 * so the port keeps bash's exact splitting rather than a tidier one.
 */
export type ReadyzCapture = string

export interface ReadinessProbeOptions {
  readonly serviceName: string
  readonly readinessPort: number
  readonly timeoutSecs: number
  readonly intervalSecs: number
  /** "" when no sha is expected - bash's `EXPECTED_BUILD_SHA=""` initial state. */
  readonly expectedBuildSha: string
  /** Only the rollback path sets this; see the header. */
  readonly allowMissingBuildSha: boolean
  /** From readinessRestartBaseline, taken right after the restart was issued. */
  readonly baseline: number

  /** `sup_is_active` - returns the unit state, e.g. "active". */
  readonly isActive: () => string
  /** `sup_restart_count` - returns NRestarts as written, validated here. */
  readonly restartCount: () => string
  /** `/healthz` probe; returns the bare `%{http_code}`, or "000" on transport failure. */
  readonly probeHealthz: () => string
  /** `/readyz` probe; returns body + "\n" + code, or "\n000" on transport failure. */
  readonly probeReadyz: () => ReadyzCapture
  /** Monotonic seconds, standing in for bash's `SECONDS`. */
  readonly now: () => number
  /** `sleep "$READINESS_INTERVAL"`; injectable so tests do not pay real seconds. */
  readonly sleep: (secs: number) => void
}

export interface ReadinessResult {
  readonly ready: boolean
  /**
   * Byte-exact `READINESS_DETAIL`. Meaningful on failure; on success it holds
   * whatever the last rung set, exactly as the bash global does - callers
   * should read it only when `ready` is false, which is the sole thing bash's
   * give-up warning does with it.
   */
  readonly detail: string
}

/**
 * `readiness_restart_baseline` (scripts/luna-update-server:1060-1067): the
 * restart/launch count sampled immediately after the restart was issued. If it
 * climbs during the probe window the unit is crash-looping rather than
 * recovering, which is what rung 2 above compares against.
 */
export function readinessRestartBaseline(restartCount: () => string): number {
  const n = restartCount()
  return RESTART_COUNT_FORMAT.test(n) ? Number(n) : 0
}

/**
 * `readiness_ok` (scripts/luna-update-server:1069-1130).
 *
 * Returns as soon as a rung passes, otherwise sleeps the interval and retries
 * until the deadline. The loop condition is bash's `(( SECONDS < deadline ))`,
 * evaluated BEFORE each attempt - so a zero (or already-elapsed) budget makes
 * no attempt at all and reports the initial detail, which is exactly what the
 * bash does and is why that first string is "probe never observed ...".
 */
export function readinessOkSync(options: ReadinessProbeOptions): ReadinessResult {
  const {
    serviceName, readinessPort, timeoutSecs, intervalSecs,
    expectedBuildSha, allowMissingBuildSha, baseline,
    isActive, restartCount, probeHealthz, probeReadyz, now, sleep,
  } = options

  const deadline = now() + timeoutSecs
  let detail = `probe never observed ${serviceName} reach 'active'`

  while (now() < deadline) {
    const active = isActive()
    detail = `${serviceName} is not active (state=${active})`
    if (active === "active") {
      const rawRestarts = restartCount()
      const nrestarts = RESTART_COUNT_FORMAT.test(rawRestarts) ? rawRestarts : "0"
      detail = `${serviceName} is crash-looping (NRestarts ${nrestarts} > baseline ${baseline})`
      if (Number(nrestarts) <= baseline) {
        detail = `/healthz did not return 200 on :${readinessPort}`
        if (probeHealthz() === "200") {
          const readyz = probeReadyz()
          // `${readyz##*$'\n'}` - the segment after the LAST newline.
          const rcode = readyz.slice(readyz.lastIndexOf("\n") + 1)
          // ONLY a literal 404 means a legacy pre-/readyz build. See the header
          // on why `000` must not take this path.
          if (rcode === "404") {
            return { ready: true, detail }
          }
          detail = `/readyz did not report "mode":"normal" (still booting or in setup-mode; http=${rcode})`
          if (readyz.includes('"mode":"normal"')) {
            if (expectedBuildSha === "") {
              return { ready: true, detail }
            }
            const matched = BUILD_SHA_FROM_READYZ.exec(readyz)
            const buildSha = matched?.[1] ?? ""
            if (
              buildSha !== "" &&
              (expectedBuildSha.startsWith(buildSha) || buildSha.startsWith(expectedBuildSha))
            ) {
              return { ready: true, detail }
            }
            // Rollback targets may implement /readyz but predate its additive
            // buildSha field. Accept an absent field only for that path; a
            // sha that IS present must still identify PREV.
            if (buildSha === "" && allowMissingBuildSha) {
              return { ready: true, detail }
            }
            detail =
              buildSha === ""
                ? `/readyz reported no usable hex buildSha (runtime resolved it to a non-hex value such as 'unknown' when git/.git is unavailable); forward promotion requires a buildSha matching ${expectedBuildSha.slice(0, 12)} (set LUNA_BUILD_SHA in the server env to pin it)`
                : `/readyz buildSha ${buildSha} does not match expected ${expectedBuildSha.slice(0, 12)}`
          }
        }
      }
    }
    sleep(intervalSecs)
  }
  return { ready: false, detail }
}

/**
 * The give-up line `readiness_ok` emits before returning 1
 * (scripts/luna-update-server:1129). Byte-exact including the trailing detail,
 * because an operator reading a rolled-back deploy has only this string and
 * the `ROLLED BACK to` marker to work from.
 */
export function readinessGaveUpLine(timeoutSecs: number, detail: string): string {
  return `readiness gave up after ${timeoutSecs}s: ${detail}`
}
