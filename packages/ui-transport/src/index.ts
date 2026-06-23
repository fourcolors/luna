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
