import type { ClientTransportAdapter } from "./contract.js"
import type { RouteConfig } from "./contract.js"
import { LunaWsAdapter } from "./adapters/luna-ws.js"

/**
 * Select the appropriate adapter for a route based on its endpoint scheme.
 * This is the ONLY place that branches on serverKind / scheme.
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
    throw new Error(
      `hermes-http-sse adapter not yet implemented (Chunk 3); scheme=${scheme} route=${route.routeKey}`,
    )
  }
  throw new Error(`no adapter for scheme ${scheme} on route ${route.routeKey}`)
}
