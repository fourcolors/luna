import type { ServerDescriptor, ServerKind } from "@luna/ui-shared/core"

export type { ServerDescriptor, ServerKind }

export type DescriptorOrigin =
  | "server-emitted"
  | "client-projected"
  | "synthesized-legacy"
  | "cache"

export interface AttachResult {
  readonly descriptor: ServerDescriptor
  readonly origin: DescriptorOrigin
}

export interface ConnectionState {
  readonly status:
    | "connecting"
    | "ready"
    | "recovering"
    | "down"
    | "handshake-timeout"
    | "auth-failed"
    | "identity-failed"
    | "route-missing"
  readonly reason?: string
}

export interface RouteConfig {
  readonly routeKey: string
  readonly endpoints: readonly string[]
  readonly tokenRef: string
  readonly expect?: { readonly spki?: string }
  readonly label?: string
}

export interface NormalizedMessage {
  readonly id: string
  readonly role: "user" | "assistant" | "system"
  readonly content: string
}

export interface NormalizedToolCall {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

export type ChatInput = {
  readonly text: string
  readonly threadId?: string
}

export type ChatFrame =
  | { readonly t: "thread-snapshot"; readonly messages: readonly NormalizedMessage[] }
  | { readonly t: "delta"; readonly messageId: string; readonly text: string }
  | { readonly t: "message"; readonly message: NormalizedMessage }
  | { readonly t: "tool"; readonly call: NormalizedToolCall }
  | { readonly t: "done"; readonly messageId: string; readonly stopReason?: string }
  | { readonly t: "error"; readonly code: string; readonly message: string }

export interface ChatSession {
  readonly threadId: string
  readonly messages: AsyncIterable<ChatFrame>
  send(input: ChatInput): Promise<void>
  stop(): Promise<void>
  close(): void
}

export interface ClientTransportAdapter {
  readonly routeKey: string
  readonly transportKind: string
  attach(): Promise<AttachResult>
  describe(): Promise<AttachResult>
  readonly descriptorChanges: AsyncIterable<AttachResult>
  readonly connection: AsyncIterable<ConnectionState>
  openSession(opts: { readonly threadId?: string; readonly model?: string }): Promise<ChatSession>
  dispose(): Promise<void>
}
