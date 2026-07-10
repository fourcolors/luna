/**
 * Browser entry point for @luna/ui-transport.
 *
 * Exports ONLY the browser-safe surface — types + classes that use
 * WebSocket/fetch only. Deliberately excludes:
 *   - parseClientConfig / resolveTokenRef (uses node:fs + node:child_process)
 *   - makeNodeTokenResolver / the Node entry ./node.ts (pulls node: in)
 *   - ParsedClientConfig (node-side bootstrap type)
 *   - dev/** stubs (test harness)
 *
 * It DOES export the TokenResolver injection TYPE and the unconfigured browser
 * resolver stub (both node:-free) — the Moon host injects a Tauri-backed
 * resolver via the adapter/ConnectionManager options.
 *
 * In the Moon WebKit frontend this is bundled as vendor/ui-transport.js
 * and exposed as window.LunaTransport via an IIFE wrapper.
 * Regen: `bun run bundle:ui-transport` (from repo root).
 *
 * Studio (ui-web) also imports this entry directly: its reconnecting
 * transport bridge (apps/ui-web/src/data/reconnecting-transport.ts) wraps
 * LunaWsAdapter to get bounded exponential reconnect.
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

// Token resolution injection seam (node:-free — type + browser stub only).
// The Node-backed resolver lives in ./node.ts and is NOT exported here so the
// browser bundle never pulls in node:fs / node:child_process.
export type { TokenResolver } from "./token-resolver.js"
export { unconfiguredBrowserTokenResolver } from "./token-resolver.js"
