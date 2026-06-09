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
