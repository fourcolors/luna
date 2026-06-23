/**
 * TokenResolver — the injection seam for resolving a route's `tokenRef` into a
 * concrete bearer token at connect time.
 *
 * BROWSER-SAFE: this module has NO `node:` imports. It defines the resolver
 * TYPE and a browser stub that throws until the host injects a real resolver.
 * The Node-backed resolver (which uses resolveTokenRef → node:fs /
 * node:child_process) lives in ./node.ts and must NEVER be imported from the
 * browser bundle (src/browser.ts).
 *
 * Why an injection seam at all?
 *   - In Node (CLI, server, tests) the resolver is `makeNodeTokenResolver()`,
 *     which calls resolveTokenRef and can read env:/file: and shell out to
 *     `op` for op://.
 *   - In the Moon WebKit frontend there is no fs/child_process. The browser
 *     host injects a resolver backed by a Tauri command (Rust resolves the ref
 *     and returns the token in-memory — §8: the token is held in memory only,
 *     never written back to disk).
 *
 * Adapters resolve their token lazily through this seam (only for the route
 * being connected) and fall back to the LITERAL tokenRef when no resolver is
 * injected — preserving backward compatibility with callers that already pass
 * a literal token in RouteConfig.tokenRef.
 *
 * SCOPE — single-account op:// only (DESIGN.md §8 division of labor):
 *   The Node resolver here (resolveTokenRef) handles plain single-account
 *   `op://<vault>/<item>/<field>`. It deliberately does NOT implement §8's
 *   multi-account routing — the `luna-op://<account-label>/...` explicit form,
 *   the "bare op:// is valid only when exactly one OP service-account is
 *   registered" rule, the `^[a-z][a-z0-9-]{0,30}$` label grammar, or the
 *   reserved labels {env,file,op}. That account-aware routing lives in the
 *   SERVER-SIDE RoutedOpSecretProvider (Phase 25d, a separate Effect/
 *   SecretProvider chain), not in this client transport slice. A `luna-op://`
 *   ref reaching this resolver simply hits the unrecognized-scheme throw
 *   (fail-closed), which is the intended boundary. If the client ever needs to
 *   honor §8 multi-account semantics directly, add luna-op:// recognition +
 *   account-count gating here; until then the client passes single-account
 *   refs only and defers multi-account routing to the server provider.
 */

/**
 * Resolve a `tokenRef` string (e.g. "env:LUNA_TOKEN", "file:/abs/path",
 * "op://vault/item/field", "none", or — for backward compat — a literal token)
 * to a concrete bearer-token string.
 *
 * FAIL-CLOSED: implementations MUST reject (throw / reject the promise) on any
 * resolution failure rather than returning a partial or empty credential. The
 * "none" sentinel resolving to "" is the only intentional empty result.
 */
export type TokenResolver = (tokenRef: string) => Promise<string>

/**
 * Browser resolver stub. The browser bundle has no fs/child_process, so it
 * cannot resolve env:/file:/op:// itself. The Moon host MUST inject a real
 * resolver (e.g. backed by a Tauri command) before any route is attached.
 *
 * This stub exists so the browser bundle ships a clear failure mode instead of
 * silently using a scheme prefix ("env:FOO") as a literal bearer token. If it
 * is ever invoked, the host forgot to wire its resolver.
 */
export const unconfiguredBrowserTokenResolver: TokenResolver = async (tokenRef: string) => {
  throw new Error(
    `ui-transport: no TokenResolver injected — the browser host must inject a ` +
      `Tauri-backed resolver before attaching routes (tried to resolve "${tokenRef}"). ` +
      `Pass a resolver via the adapter/ConnectionManager options.`,
  )
}
