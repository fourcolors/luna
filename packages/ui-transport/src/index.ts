// Contract types and interfaces
export type {
  AttachResult,
  ChatFrame,
  ChatInput,
  ChatSession,
  ClientTransportAdapter,
  ConnectionState,
  DescriptorOrigin,
  NormalizedMessage,
  NormalizedToolCall,
  RouteConfig,
  ServerDescriptor,
  ServerKind,
} from "./contract.js"

// Factory
export { selectAdapter } from "./factory.js"

// Adapters
export { LunaWsAdapter } from "./adapters/luna-ws.js"
export type { WsFactory } from "./adapters/luna-ws.js"

export { HermesHttpSseAdapter, projectHermesDescriptor } from "./adapters/hermes-http-sse.js"
export type { FetchFn } from "./adapters/hermes-http-sse.js"

// Dev / stub server (for tests and local development)
export { startHermesStub } from "./dev/hermes-stub.js"
export type { HermesStubHandle, HermesStubOptions } from "./dev/hermes-stub.js"

// Connection pool (Chunk 4-A)
export { ConnectionManager } from "./pool/connection-manager.js"
export type { RouteHandle } from "./pool/connection-manager.js"

// Bootstrap config parser + tokenRef resolver (Chunk 4-B)
export { parseClientConfig, resolveTokenRef } from "./bootstrap/client-config.js"
export type { ParsedClientConfig } from "./bootstrap/client-config.js"
