/**
 * moonClient.ts - the client identity the server labels connections with
 * (stack23 S19h).
 *
 * The smallest thing in the conversion and the only one with NO dependencies
 * at all, which is why it moves as a constant rather than a factory.
 *
 * VERSION IS IMPORTED, NOT HAND-EDITED. It comes straight from this app's
 * package.json - one of the four files `bun run scripts/bump-moon.ts` keeps in
 * lockstep (package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json and
 * the luna-moon-ui entry in src-tauri/Cargo.lock).
 *
 * This replaces a hand-bumped literal that sat at 0.0.54 while the shipped app
 * reached 0.0.77 - 23 releases of drift. The server writes this field into its
 * connection identity tag AND into every feedback submission's `appVersion`,
 * so a stale value does not just mislabel the connection: it silently files
 * every bug report against a build that is not the one running.
 *
 * A PLAIN IMPORT, DELIBERATELY - NOT a Vite `define`. A define has to be
 * declared once per build graph, and this module is compiled by three of them:
 * vite.config.ts (the shipped bundle), apps/ui-moon-tauri/vitest.config.ts
 * (the app-scoped test run) and the ROOT vitest.config.ts (what CI's
 * `bun run test` actually executes, via its `apps/**` include). The first
 * attempt at this fix declared the define in the first two and was caught by
 * CI failing in the third. An import needs no per-graph registration, so it
 * cannot be half-wired: `resolveJsonModule` is already on in this app's
 * tsconfig, and Vite's JSON named exports let the bundler tree-shake the
 * import down to the version string alone rather than inlining the whole
 * manifest.
 */
import { version } from "../../../package.json"

export interface ClientInfo {
  readonly name: string
  readonly version: string
  readonly platform: string
}

export const MoonClient: { readonly CLIENT_INFO: ClientInfo } = {
    CLIENT_INFO: {
      name: 'luna-moon',
      version,
      platform: 'tauri-darwin',
    },
}
