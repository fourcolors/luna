import type { ClientTransportAdapter } from "./contract.js"
import type { RouteConfig } from "./contract.js"
import { LunaWsAdapter } from "./adapters/luna-ws.js"
import { HermesHttpSseAdapter } from "./adapters/hermes-http-sse.js"

/**
 * Select the appropriate adapter for a route based on its endpoint scheme.
 * This is the ONLY place that branches on serverKind / scheme.
 *
 * ws:// / wss://  → LunaWsAdapter   (Luna chat-server WebSocket protocol)
 * http:// / https:// → HermesHttpSseAdapter (Hermes OpenAI-compatible HTTP+SSE)
 */
export function selectAdapter(route: RouteConfig): ClientTransportAdapter {
  const firstEndpoint = route.endpoints[0]
  if (!firstEndpoint) {
    throw new Error(`selectAdapter: route "${route.routeKey}" has no endpoints`)
  }
  const scheme = new URL(firstEndpoint).protocol
  if (scheme === "ws:" || scheme === "wss:") {
    return new LunaWsAdapter(route)
  }
  if (scheme === "http:" || scheme === "https:") {
    return new HermesHttpSseAdapter(route)
  }
  throw new Error(`no adapter for scheme ${scheme} on route ${route.routeKey}`)
}
