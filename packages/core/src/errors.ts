/**
 * Root error taxonomy — see DESIGN.md §6.
 *
 * Every module extends these with module-specific tagged errors.
 * Error boundary rule: leaf services raise; composing services handle,
 * translate (Effect.mapError), or propagate — never swallow silently.
 */
import { Data } from "effect"

// §6.1 Root categories — used as base classes or as marker tags.

export class TransientError extends Data.TaggedError("TransientError")<{
  readonly module: string
  readonly op: string
  readonly cause: unknown
}> {}

export class RateLimitError extends Data.TaggedError("RateLimitError")<{
  readonly module: string
  readonly retryAfterMs?: number
  readonly cause: unknown
}> {}

export class PermissionError extends Data.TaggedError("PermissionError")<{
  readonly module: string
  readonly subject: string
  readonly action: string
  readonly reason: string
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly module: string
  readonly field: string
  readonly message: string
}> {}

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly module: string
  readonly key: string
  readonly message: string
}> {}

export class IntegrityError extends Data.TaggedError("IntegrityError")<{
  readonly module: string
  readonly resource: string
  readonly message: string
}> {}

export class SDKError extends Data.TaggedError("SDKError")<{
  readonly op: string
  readonly sessionId?: string
  readonly cause: unknown
}> {}
