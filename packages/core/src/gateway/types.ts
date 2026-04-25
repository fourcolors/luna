/**
 * GatewayService — public types (Phase 17).
 *
 * The Gateway is the inbound message routing layer. It normalizes messages
 * from Discord, Telegram, CLI (stdio), and HTTP POST into a unified
 * `GatewayMessage` type and dispatches them to a registered handler.
 * Responses are routed back to the originating transport via the adapter.
 *
 * Plugin-play architecture:
 *   - Each transport implements `GatewayAdapter<A>`.
 *   - Adapters register at startup via `GatewayService.registerAdapter`.
 *   - The GatewayService listens on all active adapters concurrently using
 *     Stream.mergeAll and dispatches through the single handler.
 *
 * Design invariants:
 *   - Handler errors are caught and sent as error responses (never crash the
 *     gateway).
 *   - Each adapter gets its own Scope; adapter failure doesn't crash others.
 *   - GatewayService is Layer.scoped; teardown interrupts all adapter fibers.
 */
import type { Effect, Scope, Stream } from "effect"

/** Identifies which transport originated a message. */
export type TransportKind = "discord" | "telegram" | "cli" | "http" | string

/** A normalized inbound message from any transport. */
export interface GatewayMessage {
  readonly id: string
  /** Transport that delivered this message. */
  readonly transport: TransportKind
  /** Channel/thread/room identifier within the transport. */
  readonly channelId: string
  /** User/sender identifier within the transport. */
  readonly senderId: string
  /** Plain text content of the message. */
  readonly text: string
  /** Any transport-specific metadata. */
  readonly metadata: Record<string, unknown>
  /** ISO timestamp */
  readonly ts: string
}

/** A response to send back via the transport. */
export interface GatewayResponse {
  /** The original message this responds to. */
  readonly inReplyTo: GatewayMessage
  /** Response text. */
  readonly text: string
  /** Optional metadata (e.g., embeds, attachments). */
  readonly metadata?: Record<string, unknown>
}

/** A platform transport adapter. */
export interface GatewayAdapter {
  /** Unique identifier for this adapter. */
  readonly transport: TransportKind

  /**
   * Returns a Stream of inbound messages from this transport.
   * The stream should complete when the transport is shut down.
   */
  readonly messages: Stream.Stream<GatewayMessage>

  /**
   * Send a response back via this transport.
   * Never fails — errors are logged internally.
   */
  readonly send: (response: GatewayResponse) => Effect.Effect<void>

  /**
   * Optional: called when the adapter starts. May be used for transport
   * auth (e.g., bot login). Runs in the adapter's Scope.
   */
  readonly start?: Effect.Effect<void, never, Scope.Scope>
}

/** Handler function: receives a message, returns a response text. */
export type GatewayHandler = (
  msg: GatewayMessage,
) => Effect.Effect<string, never>

export interface GatewayConfig {
  /**
   * If true, the gateway logs all messages to the Effect logger.
   * Default: false.
   */
  readonly logMessages?: boolean
}

/** Tagged error for gateway failures. */
export class GatewayError extends Error {
  readonly _tag = "GatewayError" as const
  constructor(
    readonly transport: TransportKind,
    override readonly cause: unknown,
  ) {
    super(`Gateway error on ${transport}: ${String(cause)}`)
    this.name = "GatewayError"
  }
}

export interface GatewayApi {
  /**
   * Register a transport adapter. Must be called before `start()`.
   * Returns the gateway (for chaining).
   */
  readonly registerAdapter: (adapter: GatewayAdapter) => Effect.Effect<void>

  /**
   * Set the message handler. Only one handler is active at a time.
   * The handler receives every inbound message from all adapters.
   */
  readonly setHandler: (handler: GatewayHandler) => Effect.Effect<void>

  /**
   * Start the gateway: spin up all registered adapters and begin routing
   * messages through the handler. Returns when the gateway is fully started.
   * The gateway runs until the Scope closes.
   */
  readonly start: Effect.Effect<void, never, Scope.Scope>

  /**
   * Send a message directly via a specific transport.
   * Useful for push notifications (not in reply to an inbound message).
   */
  readonly send: (
    transport: TransportKind,
    channelId: string,
    text: string,
    metadata?: Record<string, unknown>,
  ) => Effect.Effect<void>
}
