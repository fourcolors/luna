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

export const SystemPromptSchema = S.Union(
  S.String,
  S.Array(S.String),
  S.Struct({
    type: S.Literal("preset"),
    preset: S.Literal("claude_code"),
    append: S.optional(S.String),
    excludeDynamicSections: S.optional(S.Boolean),
  }),
)
export type SystemPromptSpec = typeof SystemPromptSchema.Type

export const SessionOptionsSchema = S.Struct({
  model: S.String.pipe(S.minLength(1)),
  idleTimeoutMs: S.optional(S.Number.pipe(S.int(), S.positive())),
  disableIdleTimeout: S.optional(S.Boolean),
  // Turn-aware inactivity watchdog (chat threads). 0 = disabled, so the bound
  // is non-negative (unlike idleTimeoutMs, which is strictly positive).
  turnInactivityTimeoutMs: S.optional(
    S.Number.pipe(S.int(), S.greaterThanOrEqualTo(0)),
  ),
  hangCooldownMs: S.optional(S.Number.pipe(S.int(), S.positive())),
  systemPrompt: S.optional(SystemPromptSchema),
  title: S.optional(S.String),
  tags: S.optional(S.Array(S.String)),
  parentSessionId: S.optional(S.String),
  sdkOptions: S.optional(S.Record({ key: S.String, value: S.Unknown })),
})

export type ValidatedSessionOptions = typeof SessionOptionsSchema.Type

export const decodeSessionOptions = S.decodeUnknown(SessionOptionsSchema)
export const decodeSessionOptionsSync = S.decodeUnknownSync(SessionOptionsSchema)
