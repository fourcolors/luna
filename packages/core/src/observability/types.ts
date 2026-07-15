/**
 * ObservabilityService — public types (Phase 14).
 *
 * Structured event emission per DESIGN §16. Events are written to a local
 * JSONL sink; OTLP export is deferred until @effect/opentelemetry publishes
 * a v3-compatible release.
 *
 * Event schema follows §16 exactly:
 *   SessionStart/End, ToolCall, HookFire, PermissionDecision,
 *   TeammateStart/Idle/Stop, WorkflowTransition, AccountSwitch,
 *   CostAccrued, Error.
 *
 * All events include: ts (ISO timestamp), level ("info"|"warn"|"error"),
 * and a `kind` discriminant.
 */
import type { Effect, Scope, Stream } from "effect"

export type ObsEventKind =
  | "SessionStart"
  | "SessionEnd"
  | "ToolCall"
  | "HookFire"
  | "PermissionDecision"
  | "TeammateStart"
  | "TeammateIdle"
  | "TeammateStop"
  | "WorkflowTransition"
  | "AccountSwitch"
  | "CostAccrued"
  | "RetrievalCall"
  | "Error"

export interface ObsEventBase {
  readonly ts: string
  readonly kind: ObsEventKind
  readonly level: "info" | "warn" | "error"
}

export interface SessionStartEvent extends ObsEventBase {
  readonly kind: "SessionStart"
  readonly sessionId: string
  readonly model: string
  readonly optionsDigest?: string
  readonly parentId?: string
  readonly tags?: ReadonlyArray<string>
  readonly title?: string
}

export interface SessionEndEvent extends ObsEventBase {
  readonly kind: "SessionEnd"
  readonly sessionId: string
  readonly durationMs: number
}

export interface ToolCallEvent extends ObsEventBase {
  readonly kind: "ToolCall"
  readonly sessionId?: string
  readonly toolName: string
  readonly inputDigest?: string
  readonly durationMs: number
  readonly status: "success" | "error" | "permission_denied"
}

export interface HookFireEvent extends ObsEventBase {
  readonly kind: "HookFire"
  readonly event: string
  readonly matcher?: string
  readonly decision: string
}

export interface PermissionDecisionEvent extends ObsEventBase {
  readonly kind: "PermissionDecision"
  readonly tool: string
  readonly decision: string
  readonly rulePath: string
}

export interface TeammateStartEvent extends ObsEventBase {
  readonly kind: "TeammateStart"
  readonly team: string
  readonly teammate: string
}

export interface TeammateIdleEvent extends ObsEventBase {
  readonly kind: "TeammateIdle"
  readonly team: string
  readonly teammate: string
  readonly idleMs: number
}

export interface TeammateStopEvent extends ObsEventBase {
  readonly kind: "TeammateStop"
  readonly team: string
  readonly teammate: string
  readonly reason: string
}

export interface WorkflowTransitionEvent extends ObsEventBase {
  readonly kind: "WorkflowTransition"
  readonly workflowId: string
  readonly from: string
  readonly to: string
}

export interface AccountSwitchEvent extends ObsEventBase {
  readonly kind: "AccountSwitch"
  readonly from: string
  readonly to: string
  readonly reason: string
}

export interface CostAccruedEvent extends ObsEventBase {
  readonly kind: "CostAccrued"
  readonly sessionId?: string
  readonly teamName?: string
  readonly workflowId?: string
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly estimatedUsd: number
}

export interface RetrievalCallEvent extends ObsEventBase {
  readonly kind: "RetrievalCall"
  readonly sessionId?: string
  readonly namespace?: string
  readonly mode: "vec" | "hybrid" | "bm25"
  readonly queryDigest: string
  readonly embedderProvider: string
  readonly embedderModel: string
  readonly embedderDimension: number
  readonly candidateCount: number
  readonly topScore?: number
  readonly durationMs: number
  readonly status: "success" | "error"
}

export interface ErrorEvent extends ObsEventBase {
  readonly kind: "Error"
  readonly errorTag: string
  readonly message: string
  readonly context?: Record<string, unknown>
}

export type ObsEvent =
  | SessionStartEvent
  | SessionEndEvent
  | ToolCallEvent
  | HookFireEvent
  | PermissionDecisionEvent
  | TeammateStartEvent
  | TeammateIdleEvent
  | TeammateStopEvent
  | WorkflowTransitionEvent
  | AccountSwitchEvent
  | CostAccruedEvent
  | RetrievalCallEvent
  | ErrorEvent

export interface ObservabilityConfig {
  /**
   * Path to the JSONL file for local event storage.
   * Default: `~/.luna/events.jsonl`.
   */
  readonly jsonlPath?: string
  /**
   * If true, also emit events to the Effect logger (console).
   * Default: false.
   */
  readonly logToConsole?: boolean
  /**
   * Minimum event level to emit. Default: "info".
   */
  readonly minLevel?: "info" | "warn" | "error"
}

export interface ObservabilityApi {
  /**
   * Emit a structured observability event. Non-blocking (fire-and-forget
   * internally; errors writing to JSONL are logged but do not fail the
   * caller).
   */
  readonly emit: (event: ObsEvent) => Effect.Effect<void>

  /**
   * Convenience: emit a CostAccrued event.
   */
  readonly recordCost: (opts: {
    sessionId?: string
    teamName?: string
    workflowId?: string
    tokensIn: number
    tokensOut: number
    cacheRead?: number
    cacheWrite?: number
    pricePerMillionInputTokens?: number
    pricePerMillionOutputTokens?: number
  }) => Effect.Effect<void>

  /**
   * Live stream of all events emitted since subscription start.
   * Backed by an in-memory PubSub; lazy — subscription is created when the
   * stream is consumed. NOTE: emits published BEFORE the stream is consumed
   * are NOT delivered (missed events). For reliable capture, use
   * `subscribeEvents()` to eagerly subscribe before calling `emit`.
   */
  readonly events: Stream.Stream<ObsEvent>

  /**
   * Eagerly subscribe to the event hub. Returns a Stream backed by a
   * pre-created dequeue so NO events are missed after this Effect resolves.
   * Requires a `Scope` — the subscription is released when the scope closes.
   */
  readonly subscribeEvents: Effect.Effect<
    Stream.Stream<ObsEvent>,
    never,
    Scope.Scope
  >
}
