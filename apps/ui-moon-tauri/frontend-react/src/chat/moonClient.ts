/**
 * moonClient.ts - the client identity the server labels connections with
 * (stack23 S19h).
 *
 * The smallest thing in the conversion and the only one with NO dependencies
 * at all, which is why it moves as a constant rather than a factory.
 */

export interface ClientInfo {
  readonly name: string
  readonly version: string
  readonly platform: string
}

export const MoonClient: { readonly CLIENT_INFO: ClientInfo } = {
    // NOTE: bumped manually with each tauri.conf.json/Cargo.toml version
    // bump until we plumb the bundle version through to the WebView. The
    // server uses this field to label the client in its identity tag; an
    // out-of-sync value is cosmetic but lies to the operator about which
    // build they're talking to.
    CLIENT_INFO: {
      name: 'luna-moon',
      version: '0.0.54',
      platform: 'tauri-darwin',
    },
}
