/**
 * Node-only entry for @luna/ui-transport.
 *
 * This module pulls in resolveTokenRef (node:fs + node:child_process via
 * ./bootstrap/client-config.js) and therefore MUST NOT be imported from the
 * browser bundle (src/browser.ts). The browser host injects its own
 * Tauri-backed TokenResolver instead (see ./token-resolver.ts).
 *
 * Re-exports the browser-safe surface plus the Node-backed token resolver and
 * the bootstrap config parser so Node callers have a single import point.
 */

import { resolveTokenRef, type ResolveTokenRefOptions } from "./bootstrap/client-config.js"
import type { TokenResolver } from "./token-resolver.js"

// Re-export the full browser-safe surface (types + adapters + pool).
export * from "./browser.js"

// Bootstrap config parser + the raw resolver (Node-only).
export { parseClientConfig, resolveTokenRef } from "./bootstrap/client-config.js"
export type {
  ParsedClientConfig,
} from "./bootstrap/client-config.js"
export type {
  OpSpawnFn,
  OpSpawnResult,
  ResolveTokenRefOptions,
} from "./bootstrap/client-config.js"

// The injection seam type + browser stub (re-exported for convenience).
export type { TokenResolver } from "./token-resolver.js"
export { unconfiguredBrowserTokenResolver } from "./token-resolver.js"

/**
 * Build a Node-backed {@link TokenResolver} over {@link resolveTokenRef}.
 *
 * Use this as the resolver injected into adapters / ConnectionManager in Node
 * contexts (CLI, server, tests). It resolves env:/file:/none locally and, when
 * `options.allowInteractive===true`, op:// via the hardened 1Password path.
 *
 * @param options op:// resolution options (interactive gate, pinned binary,
 *                 timeout, injectable spawn). Defaults make op:// fail closed in
 *                 headless contexts. env:/file:/none ignore these.
 */
export function makeNodeTokenResolver(
  options: ResolveTokenRefOptions = {},
): TokenResolver {
  return (tokenRef: string) => resolveTokenRef(tokenRef, undefined, undefined, undefined, options)
}
