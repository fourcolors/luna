/**
 * Browser entry point for @luna/ui-transport.
 *
 * Exports ONLY the browser-safe surface — types + classes that use
 * WebSocket/fetch only. Deliberately excludes:
 *   - parseClientConfig / resolveTokenRef (uses node:fs + smol-toml)
 *   - ParsedClientConfig (node-side bootstrap type)
 *   - dev/** stubs (test harness)
 *
 * In the Moon WebKit frontend this is bundled as vendor/ui-transport.js
 * and exposed as window.LunaTransport via an IIFE wrapper.
 * Regen: `bun run bundle:ui-transport` (from repo root).
 */

// Contract types
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

// Connection pool
export { ConnectionManager } from "./pool/connection-manager.js"
export type { RouteHandle } from "./pool/connection-manager.js"
