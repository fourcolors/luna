/**
 * Core message types — the minimum every downstream service needs.
 *
 * Per DESIGN.md §12.2 invariant #6: core is SDK-dependency-free at runtime.
 * The full `SDKMessage` tagged union lives in `@experiment-agent/adapter-sdk`
 * (which imports it from `@anthropic-ai/claude-agent-sdk` via `import type`).
 * Core stores SDK payloads as an opaque `unknown` inside a versioned envelope
 * (`StoredMessage`) so at-rest data is insulated from SDK shape drift.
 *
 * The five-case tagged union we hand-modeled previously (`user | assistant |
 * system | result | stream_event`) was an incomplete subset — the SDK ships
 * ~28 variants (hook messages, plugin/task/tool/auth/notification/memory/
 * rate-limit/elicitation events, etc.). Rather than chase drift in core, we
 * treat the payload as opaque here and let the adapter own the typed surface.
 */

/**
 * Current on-disk envelope version. Bump when the envelope shape changes
 * (not when the SDK changes — that's what the `payload` opaque bag is for).
 */
export const MESSAGE_ENVELOPE_VERSION = 1 as const

/**
 * Universal message-kind tag we do control — used for fast filtering without
 * decoding the opaque payload. Mirrors the top-level `type` discriminator of
 * the SDK's SDKMessage union at the coarse level we care about in core.
 *
 * Adapters are free to record a finer-grained subtype inside `payload` or
 * alongside it; this is the "what's in the envelope?" summary for indexing.
 */
export type MessageKind =
  | "user"
  | "assistant"
  | "system"
  | "result"
  | "stream_event"
  | "hook"
  | "status"
  | "other"

/**
 * Persisted envelope. `payload` is an opaque record of the adapter's native
 * message shape; readers MUST validate with a schema appropriate to their
 * adapter version before acting on its contents. See DESIGN.md §12.2 #6.
 */
export interface StoredMessage {
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly ts: number
  readonly parentId: string | null
  readonly kind: MessageKind
  readonly schemaVersion: typeof MESSAGE_ENVELOPE_VERSION
  /** Adapter-owned payload. Opaque to core. */
  readonly payload: unknown
}
