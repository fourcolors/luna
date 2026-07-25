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

export class SessionLimitError extends Data.TaggedError("SessionLimitError")<{
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
}> {
  /**
   * Effect's `Data.TaggedError` renders as the generic "An error has occurred"
   * when the error declares no `message` — which hid the REAL SDK failure (e.g.
   * `ReferenceError: Claude Code native binary not found … specify
   * options.pathToClaudeCodeExecutable`) behind an opaque "SDKError: An error
   * has occurred at adapter.ts:NNN". This getter surfaces `op`, `sessionId`,
   * and the underlying `cause` so every consumer — the chat-service user
   * frame, server logs, and the wake/dream reasoners' `String(cause)` — sees
   * WHY the SDK stream died. The `cause` field is preserved untouched for
   * programmatic inspection / pattern matching.
   */
  override get message(): string {
    const c = this.cause
    const rendered = c instanceof Error ? `${c.name}: ${c.message}` : String(c)
    const sid = this.sessionId !== undefined ? ` [${this.sessionId}]` : ""
    return `SDK ${this.op} failed${sid}: ${rendered}`
  }
}

// §6.2 — MemoryBackend leaf errors. Raised by concrete backends
// (sqlite/file/in-memory/vector) and composed by MemoryRouter.
export class MemoryBackendError extends Data.TaggedError("MemoryBackendError")<{
  readonly backend: string
  readonly op: string
  readonly namespace?: string
  readonly id?: string
  readonly cause: unknown
}> {}

// §6.2 — Embedder leaf error. Raised by EmbedderService implementations
// (stub/ollama/anthropic/...) when embedding fails (network, model load,
// dimension mismatch). Vector backends compose over this via mapError to
// MemoryBackendError("embed", ...).
export class EmbedderError extends Data.TaggedError("EmbedderError")<{
  readonly provider: string
  readonly op: string
  readonly cause: unknown
}> {}

// §6.2 — Account rotation exhaustion (all accounts in cooldown or unavailable).
export class AllAccountsExhaustedError extends Data.TaggedError("AllAccountsExhaustedError")<{
  readonly kind: string
}> {}

// §6.2 — Teams (TeamBroker, Phase 11c). Per DESIGN.md §6.2 lines 414-419.
export class TeammateOrphanedError extends Data.TaggedError("TeammateOrphanedError")<{
  readonly teamName: string
  readonly teammate: string
  readonly reason: "lead_exited" | "scope_closed"
}> {}

export class TaskCompletionLagError extends Data.TaggedError("TaskCompletionLagError")<{
  readonly taskId: string
  readonly stuckMs: number
}> {}

// §6.2 — Workflows (WorkflowRuntime, Phase 12). Per DESIGN.md §6.2 lines 421-424.
export class WorkflowCompensationError extends Data.TaggedError("WorkflowCompensationError")<{
  readonly workflowId: string
  readonly stepId: string
  readonly cause: unknown
}> {}

// §6.2 — Labs (LabsService, Phase 21). Scientist-loop budget + scoring boundaries.
export class ExperimentBudgetExceededError extends Data.TaggedError(
  "ExperimentBudgetExceededError",
)<{
  readonly experimentName: string
  readonly bucketKey: string
  readonly limitUsd: number
}> {}

export class ScoringError extends Data.TaggedError("ScoringError")<{
  readonly experimentName: string
  readonly iteration: number
  readonly cause: unknown
}> {}
