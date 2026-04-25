/**
 * Wire-format types for the ui-ws protocol (v1).
 *
 * IMPORTANT: keep in sync with
 *   - packages/core/src/observability/types.ts (ObsEvent shape)
 *   - packages/ui-ws/src/protocol.ts (ServerFrame / ClientFrame)
 *
 * We DON'T import from `@experiment-agent/core` directly: its package
 * barrel pulls node-only deps (fs, path, etc.) that would explode a Vite
 * browser bundle. Mirroring the wire types here is the standard solve;
 * the server-side Schema validator (observability/schema.ts) is the
 * single source of truth that catches drift at the emit boundary.
 */

export type ObsEventLevel = "info" | "warn" | "error"

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
  | "Error"

export interface ObsEventBase {
  readonly ts: string
  readonly kind: ObsEventKind
  readonly level: ObsEventLevel
  // Allow forward-compatible extra fields without breaking the UI.
  readonly [key: string]: unknown
}

/** Discriminated only on `kind` — UI displays the JSON of the rest. */
export type ObsEvent = ObsEventBase

export const UI_WS_PROTOCOL_VERSION = 1 as const

export interface HelloFrame {
  readonly type: "hello"
  readonly protocolVersion: 1
  readonly kinds: ReadonlyArray<string>
}
export interface EventFrame {
  readonly type: "event"
  readonly event: ObsEvent
}
export interface DropFrame {
  readonly type: "drop"
  readonly n: number
  readonly since: string
}
export interface PingFrame {
  readonly type: "ping"
  readonly ts: string
}
export interface ByeFrame {
  readonly type: "bye"
  readonly reason: string
}

export type ServerFrame =
  | HelloFrame
  | EventFrame
  | DropFrame
  | PingFrame
  | ByeFrame
