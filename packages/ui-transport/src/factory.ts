import type { ClientTransportAdapter } from "./contract.js"
import type { RouteConfig } from "./contract.js"
import type { TokenResolver } from "./token-resolver.js"
import { LunaWsAdapter } from "./adapters/luna-ws.js"
import { HermesHttpSseAdapter } from "./adapters/hermes-http-sse.js"

/**
 * Select the appropriate adapter for a route based on its endpoint scheme.
 * This is the ONLY place that branches on serverKind / scheme.
 *
 * ws:// / wss://  → LunaWsAdapter   (Luna chat-server WebSocket protocol)
 * http:// / https:// → HermesHttpSseAdapter (Hermes OpenAI-compatible HTTP+SSE)
 *
 * @param tokenResolver Optional resolver threaded into the adapter so it
 *   resolves route.tokenRef (env:/file:/op:/none) at connect time. When omitted,
 *   the adapter uses the literal route.tokenRef (backward compat).
 */
export function selectAdapter(
  route: RouteConfig,
  tokenResolver?: TokenResolver,
): ClientTransportAdapter {
  const firstEndpoint = route.endpoints[0]
  if (!firstEndpoint) {
    throw new Error(`selectAdapter: route "${route.routeKey}" has no endpoints`)
  }
  const scheme = new URL(firstEndpoint).protocol
  if (scheme === "ws:" || scheme === "wss:") {
    return new LunaWsAdapter(route, undefined, undefined, undefined, tokenResolver)
  }
  if (scheme === "http:" || scheme === "https:") {
    return new HermesHttpSseAdapter(route, undefined, tokenResolver)
  }
  throw new Error(`no adapter for scheme ${scheme} on route ${route.routeKey}`)
}
