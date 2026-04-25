/**
 * UIService — public types (Phase 22).
 *
 * Server-side primitive only. Provides a typed Stream of UIEvent for a
 * Tauri/React (or any) client to consume. NO transport layer in this
 * phase — a separate adapter package (e.g. `gateway/ui-ws`) will turn
 * this Stream into WebSocket/SSE traffic.
 *
 * Per DESIGN §9: "Non-goal for M1–M3; targeted at M4+." This is the
 * M4 server primitive. The actual Tauri/React client is M5+.
 *
 * UIEvent is a projection of ObsEvent — only kinds the UI cares about
 * are forwarded; sensitive fields (input digests, full traces) are
 * redacted at this boundary.
 */
import type { Effect, Scope, Stream } from "effect"
import type { ObsEvent, ObsEventKind } from "../observability/types.js"

/** Kinds of ObsEvent forwarded to the UI by default. */
export const DEFAULT_UI_KINDS: ReadonlyArray<ObsEventKind> = [
  "SessionStart",
  "SessionEnd",
  "ToolCall",
  "TeammateStart",
  "TeammateIdle",
  "TeammateStop",
  "WorkflowTransition",
  "CostAccrued",
  "Error",
] as const

/**
 * UIEvent: a UI-safe projection of an ObsEvent. For Phase 22 we forward
 * the full ObsEvent (which is already structured). Future phases can
 * narrow the projection per kind if/when sensitive fields appear in
 * §16's schema.
 */
export type UIEvent = ObsEvent

export interface UIConfig {
  /**
   * Whitelist of ObsEvent kinds to forward. Defaults to DEFAULT_UI_KINDS.
   */
  readonly kinds?: ReadonlyArray<ObsEventKind>
}

export interface UIApi {
  /**
   * Subscribe to the UI event stream. The returned Stream is
   * eagerly attached to the underlying PubSub at the moment this
   * Effect runs (NOT lazily on Stream consumption — this avoids the
   * Phase-14 fan-out race where events emitted before consumption
   * are dropped).
   *
   * The subscription's lifetime is the caller's Scope: when the
   * Scope closes, the underlying PubSub queue is shut down.
   */
  readonly subscribe: Effect.Effect<Stream.Stream<UIEvent>, never, Scope.Scope>
}
