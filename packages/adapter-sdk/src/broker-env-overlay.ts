// packages/adapter-sdk/src/broker-env-overlay.ts
import { Redacted } from "effect"
import type { ProviderProfile } from "@luna/core"

/**
 * buildBrokerEnvOverlay — THE single secret-unwrap site (§-frozen invariant).
 *
 * `Redacted.value(...)` is called HERE and only here in production source. The
 * acceptance gate
 *   `grep -rnE 'Redacted\.value' packages/*​/src | grep -v test | grep -v secret-provider`
 * must return exactly this one hit. The unwrapped plaintext is handed straight
 * into the SDK Options `env` overlay and is NEVER stored in a Ref, logged, or
 * passed to anything that stringifies. The profile only selects the auth-var
 * NAME and adds non-secret base-URL / extra env. Any change here must preserve
 * that invariant.
 *
 * Used by the adapter (chat/worker path) and the wake/dream reasoners — every
 * broker-credentialed SDK call builds its env overlay through this one helper.
 */
export function buildBrokerEnvOverlay(
  profile: ProviderProfile,
  resolvedSecret: Redacted.Redacted<string>,
): Record<string, string> {
  return {
    [profile.authVar]: Redacted.value(resolvedSecret),
    ...(profile.baseUrl ? { ANTHROPIC_BASE_URL: profile.baseUrl } : {}),
    ...(profile.extraEnv ?? {}),
  }
}

/**
 * Auth/routing vars scrubbed from the inherited base env on every brokered
 * (non-login) turn. Two reasons:
 *   1. ISOLATION — the operator's ambient Anthropic login must never ride
 *      along into (or take auth precedence inside) a subprocess the broker
 *      routed to a different provider/credential.
 *   2. DETERMINISM — a stale ambient ANTHROPIC_BASE_URL must not survive
 *      under the overlay when the profile sets none (the anthropic profile
 *      has no baseUrl — inheriting one would silently re-route it).
 */
const BROKER_ENV_SCRUB_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
] as const

/**
 * Full base env for a brokered SDK subprocess. The SDK's `Options.env` is
 * REPLACE, not merge (`sdk.mjs`: `bt ? {...bt} : {...process.env}`) — passing
 * the bare auth overlay spawned the subprocess with ~3 vars, losing PATH /
 * HOME and breaking tools, MCP servers, and config resolution on every
 * non-login account. So the broker constructs the whole env itself:
 * inherited `process.env` minus {@link BROKER_ENV_SCRUB_VARS}, with the
 * caller's env applied on top (caller wins over inherited; the broker
 * overlay is applied above BOTH by the call sites).
 */
export function buildBrokerBaseEnv(
  callerEnv?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = { ...process.env }
  for (const k of BROKER_ENV_SCRUB_VARS) delete base[k]
  return { ...base, ...(callerEnv ?? {}) }
}
