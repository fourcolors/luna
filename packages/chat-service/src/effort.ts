/**
 * Effort-level primitives for chat-service.
 *
 * The server-side effort-validity matrix lives in chat-server.ts
 * (buildAvailableModels / effortsForModel). This module provides only what
 * chat-service itself needs: the ordered enum constant and a type-guard that
 * validates a wire value before it reaches the SDK.
 *
 * Per-model clamping is the server's job (chat-server.ts clampEffort) — the
 * values that arrive here have already been validated by the server before
 * being stored in thread-session-map.json or forwarded to setThreadConfig().
 */

/** All valid effort level strings in ascending strength order. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const

/** The wire type for an effort level. */
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/**
 * Type-guard: returns true iff `v` is one of the five valid effort strings.
 * Use this before persisting or forwarding a wire value to the SDK.
 */
export const isEffort = (v: unknown): v is EffortLevel =>
  typeof v === "string" && (EFFORT_LEVELS as ReadonlyArray<string>).includes(v)
