/**
 * SessionOptionsSchema — validates OUR added fields strictly; passes SDK-shape
 * fields through opaque (§12.2 #6 + advisor Phase 4 verdict scope (c)).
 *
 * Rationale: The SDK's `Options` type has 40+ fields that change between
 * minor versions. Re-validating them here duplicates the SDK's own checks
 * and creates drift. Instead:
 *   - Strictly validate fields the framework owns: model, idleTimeoutMs,
 *     systemPrompt, title, tags, parentSessionId.
 *   - Treat `sdkOptions` as `Record<string, unknown>` — the adapter's
 *     merge-guard (§12.2 #7) is the authority on reserved keys, and the
 *     SDK itself will reject malformed shapes at runtime.
 */
import * as S from "effect/Schema"

const PositiveInt = S.Int.check(S.isGreaterThan(0))
const NonNegInt = S.Int.check(S.isGreaterThanOrEqualTo(0))

export const SystemPromptSchema = S.Union([
  S.String,
  S.Array(S.String),
  S.Struct({
    type: S.Literal("preset"),
    preset: S.Literal("claude_code"),
    append: S.optionalKey(S.String),
    excludeDynamicSections: S.optionalKey(S.Boolean),
  }),
])
export type SystemPromptSpec = typeof SystemPromptSchema.Type

export const SessionOptionsSchema = S.Struct({
  model: S.String.check(S.isMinLength(1)),
  idleTimeoutMs: S.optionalKey(PositiveInt),
  disableIdleTimeout: S.optionalKey(S.Boolean),
  // Turn-aware inactivity watchdog (chat threads). 0 = disabled, so the bound
  // is non-negative (unlike idleTimeoutMs, which is strictly positive).
  turnInactivityTimeoutMs: S.optionalKey(NonNegInt),
  hangCooldownMs: S.optionalKey(PositiveInt),
  systemPrompt: S.optionalKey(SystemPromptSchema),
  title: S.optionalKey(S.String),
  tags: S.optionalKey(S.Array(S.String)),
  parentSessionId: S.optionalKey(S.String),
  sdkOptions: S.optionalKey(S.Record(S.String, S.Unknown)),
})

export type ValidatedSessionOptions = typeof SessionOptionsSchema.Type

export const decodeSessionOptions = S.decodeUnknownEffect(SessionOptionsSchema)
