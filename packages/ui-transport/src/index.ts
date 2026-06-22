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
