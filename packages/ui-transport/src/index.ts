/**
 * Default (Node) entry for @luna/ui-transport.
 *
 * Re-exports the Node surface from ./node.ts, which itself re-exports the
 * browser-safe surface (./browser.ts) plus the Node-only bootstrap parser and
 * the Node-backed token resolver. Browser consumers must import ./browser.js
 * directly (or via the bundled vendor/ui-transport.js) to avoid pulling in
 * node:fs / node:child_process.
 */

export * from "./node.js"
