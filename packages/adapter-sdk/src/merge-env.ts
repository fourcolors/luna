/**
 * Env-overlay merge — DESIGN.md §0.2 rotation mechanism.
 *
 * This is a targeted-key overlay, parallel to but DISTINCT from
 * RESERVED_SDK_OPTION_KEYS (§12.2 #7). `env` remains caller-extensible;
 * only broker-owned keys within env are overlay-managed. Per Option A
 * merge policy approved by owner 2026-04-24:
 *
 *   - The broker owns a NAMED SET of env keys (currently just
 *     `CLAUDE_CODE_OAUTH_TOKEN`) and overlays them on top of the
 *     caller-supplied `sdkOptions.env`.
 *   - Caller-supplied env keys outside the broker-owned set pass through
 *     unchanged.
 *   - On collision (caller already set a broker-owned key), the broker
 *     value wins and a warning is recorded for logging.
 *
 * This module is INTENTIONALLY independent from `merge-options.ts` —
 * `env` MUST NOT be added to `RESERVED_SDK_OPTION_KEYS`, since callers
 * are still allowed to pass arbitrary other env entries. Env overlay is
 * a separate concern handled at the adapter query site.
 */
import { Effect } from "effect"

export interface EnvOverlayWarning {
  readonly key: string
}

export interface EnvOverlayResult {
  /**
   * Merged env. `string | undefined` matches the SDK `Options.env` shape
   * (undefined values explicitly clear env keys for the spawned process).
   */
  readonly env: Record<string, string | undefined>
  readonly warnings: ReadonlyArray<EnvOverlayWarning>
}

/**
 * Merge a caller's env with a broker-owned overlay. Pure; no I/O.
 *
 * Semantics:
 *   - Start from a shallow clone of `callerEnv` (or `{}` if undefined).
 *   - For each key in `brokerOwnedEnv`:
 *       - if the caller had the same key → record warning, then overwrite
 *       - otherwise → set the key
 *   - Return the merged env + warnings.
 */
export const mergeEnvOverlay = (
  callerEnv: Readonly<Record<string, string | undefined>> | undefined,
  brokerOwnedEnv: Readonly<Record<string, string>>,
): EnvOverlayResult => {
  const env: Record<string, string | undefined> = { ...(callerEnv ?? {}) }
  const warnings: EnvOverlayWarning[] = []
  for (const [k, v] of Object.entries(brokerOwnedEnv)) {
    if (callerEnv && Object.prototype.hasOwnProperty.call(callerEnv, k)) {
      warnings.push({ key: k })
    }
    env[k] = v
  }
  return { env, warnings }
}

/**
 * Effectful wrapper that emits `Effect.logWarning` for each overlay
 * collision before returning the merged env. Mirrors the shape of
 * `mergeOptionsLogged` in merge-options.ts.
 *
 * NOTE: warning messages MUST NOT include the secret value — only the
 * key name. The secret stays inside `Redacted` until the single
 * overlay-construction site in adapter.ts unwraps it.
 */
export const mergeEnvOverlayLogged = (
  callerEnv: Readonly<Record<string, string | undefined>> | undefined,
  brokerOwnedEnv: Readonly<Record<string, string>>,
): Effect.Effect<Record<string, string | undefined>, never> =>
  Effect.gen(function* () {
    const { env, warnings } = mergeEnvOverlay(callerEnv, brokerOwnedEnv)
    for (const w of warnings) {
      yield* Effect.logWarning(
        `[SDKAdapter] Broker-owned env key "${w.key}" overrode caller-supplied value`,
      )
    }
    return env
  })
