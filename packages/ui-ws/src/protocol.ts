/**
 * UI WebSocket wire protocol.
 *
 * Frames are JSON objects with a `type` discriminant:
 *
 *   { type: "hello",  protocolVersion: 1, kinds: string[] }       // server → client (on connect)
 *   { type: "event",  event: ObsEvent }                            // server → client
 *   { type: "drop",   n: number, since: string }                   // server → client (overflow notice)
 *   { type: "ping",   ts: string }                                 // server → client (keep-alive)
 *   { type: "pong",   ts: string }                                 // client → server (keep-alive ack — optional)
 *   { type: "bye",    reason: string }                             // either direction (graceful close)
 *
 * The server pushes only — clients are pure subscribers. There is no
 * client→server command channel in this phase.
 */
import type { ObsEvent } from "@experiment-agent/core"

export const UI_WS_PROTOCOL_VERSION = 1 as const

export interface HelloFrame {
  readonly type: "hello"
  readonly protocolVersion: typeof UI_WS_PROTOCOL_VERSION
  readonly kinds: ReadonlyArray<string>
}

export interface EventFrame {
  readonly type: "event"
  readonly event: ObsEvent
}

export interface DropFrame {
  readonly type: "drop"
  readonly n: number
  readonly since: string // ISO ts of the oldest dropped event
}

export interface PingFrame {
  readonly type: "ping"
  readonly ts: string
}

export interface PongFrame {
  readonly type: "pong"
  readonly ts: string
}

export interface ByeFrame {
  readonly type: "bye"
  readonly reason: string
}

export type ServerFrame = HelloFrame | EventFrame | DropFrame | PingFrame | ByeFrame
export type ClientFrame = PongFrame | ByeFrame
