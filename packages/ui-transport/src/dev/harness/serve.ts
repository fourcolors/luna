/**
 * Harness server: starts Luna stub + Hermes stub in-process, then serves
 * index.html (which loads harness.ts as an ES module).
 *
 * Bun.serve is used for the HTTP side; it bundles harness.ts + all
 * @luna/ui-transport imports for the browser at request time.
 *
 * Config injection: a GET /config endpoint returns the stub URLs + tokens
 * as JSON. index.html fetches it on load (via harness.ts) and sets
 * window.__HARNESS_CONFIG__ before initialising the panels.
 *
 * Usage:
 *   bun run src/dev/harness/serve.ts
 *   # → prints: Harness listening on http://127.0.0.1:7799
 *   #           Open that URL in a browser to see the acceptance harness.
 *
 * Port: HARNESS_PORT env var, default 7799.
 * Luna stub port: LUNA_STUB_PORT env var, default 0 (random).
 * Hermes stub port: HERMES_STUB_PORT env var, default 0 (random).
 */

import { startLunaStub } from "../luna-stub.js"
import { startHermesStub } from "../hermes-stub.js"
import * as path from "node:path"
import * as fs from "node:fs/promises"

// ── Bun-specific globals (this file is Bun-only) ────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const Bun: {
  serve(opts: {
    port: number
    hostname: string
    fetch(req: Request): Response | Promise<Response>
  }): { stop(force?: boolean): void }
  build(opts: {
    entrypoints: string[]
    target: string
    format: string
    minify: boolean
  }): Promise<{
    success: boolean
    logs: unknown[]
    outputs: Array<{ text(): Promise<string> }>
  }>
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const HARNESS_PORT = process.env["HARNESS_PORT"]
  ? parseInt(process.env["HARNESS_PORT"], 10)
  : 7799

const LUNA_TOKEN = process.env["LUNA_STUB_TOKEN"] ?? "luna-harness-token"
const HERMES_TOKEN = process.env["HERMES_STUB_TOKEN"] ?? "hermes-harness-token"

// ── Start both stubs ─────────────────────────────────────────────────────────

console.log("Starting Luna WS stub…")
const lunaStub = await startLunaStub({
  token: LUNA_TOKEN,
  port: process.env["LUNA_STUB_PORT"] ? parseInt(process.env["LUNA_STUB_PORT"], 10) : 0,
  version: "0.99.0-stub",
  deltaCount: 4,
})
console.log(`  Luna stub:   ${lunaStub.url}  (token: ${LUNA_TOKEN})`)

console.log("Starting Hermes HTTP+SSE stub…")
const hermesStub = await startHermesStub({
  token: HERMES_TOKEN,
  port: process.env["HERMES_STUB_PORT"] ? parseInt(process.env["HERMES_STUB_PORT"], 10) : 0,
  version: "0.17.0-stub",
  deltaCount: 3,
})
console.log(`  Hermes stub: ${hermesStub.url}  (token: ${HERMES_TOKEN})`)

// ── Config payload served to the browser ────────────────────────────────────

const harnessConfig = {
  lunaUrl: lunaStub.url,
  lunaToken: LUNA_TOKEN,
  // HermesHttpSseAdapter appends /health and /v1/capabilities itself —
  // pass the root URL (no /v1 suffix).
  hermesUrl: hermesStub.url,
  hermesToken: HERMES_TOKEN,
}

// ── Resolve paths ─────────────────────────────────────────────────────────────

const harnessDir = path.dirname(new URL(import.meta.url).pathname)
const indexHtmlPath = path.join(harnessDir, "index.html")
const harnessScriptPath = path.join(harnessDir, "harness.ts")

// ── Bun.serve ────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: HARNESS_PORT,
  hostname: "127.0.0.1",

  async fetch(req) {
    const url = new URL(req.url)

    // GET /config — injects stub URLs + tokens into the browser
    if (url.pathname === "/config") {
      return new Response(JSON.stringify(harnessConfig), {
        headers: { "Content-Type": "application/json" },
      })
    }

    // GET /health — quick liveness for the smoke test
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", luna: lunaStub.url, hermes: hermesStub.url }),
        { headers: { "Content-Type": "application/json" } },
      )
    }

    // GET /harness.ts — serve the bundled harness script
    if (url.pathname === "/harness.ts" || url.pathname === "/harness.js") {
      const built = await Bun.build({
        entrypoints: [harnessScriptPath],
        target: "browser",
        format: "esm",
        minify: false,
      })
      if (!built.success) {
        const errors = built.logs.map((l: unknown) => String(l)).join("\n")
        return new Response(`Build error:\n${errors}`, { status: 500 })
      }
      const artifact = built.outputs[0]
      if (!artifact) {
        return new Response("No build output", { status: 500 })
      }
      const text = await artifact.text()
      return new Response(text, {
        headers: { "Content-Type": "application/javascript" },
      })
    }

    // GET / or /index.html — serve the index page with config injected
    if (url.pathname === "/" || url.pathname === "/index.html") {
      let html = await fs.readFile(indexHtmlPath, "utf-8")

      // Inject config as a script tag before the module script.
      // Escape "<" so a value containing "</script>" can't break the tag.
      const safeConfig = JSON.stringify(harnessConfig).replace(/</g, "\\u003c")
      const configScript = `<script>window.__HARNESS_CONFIG__ = ${safeConfig};</script>`
      html = html.replace(
        "<!--\n    serve.ts injects window.__HARNESS_CONFIG__ before this script tag.",
        `${configScript}\n  <!--\n    serve.ts injects window.__HARNESS_CONFIG__ before this script tag.`,
      )

      return new Response(html, {
        headers: { "Content-Type": "text/html" },
      })
    }

    return new Response("Not found", { status: 404 })
  },
})

// ── Ready ─────────────────────────────────────────────────────────────────────

console.log("")
console.log(`Harness listening on http://127.0.0.1:${HARNESS_PORT}`)
console.log("")
console.log("Open in browser:  http://127.0.0.1:" + HARNESS_PORT)
console.log("")
console.log("What you will see:")
console.log("  LEFT  panel  (Luna WS)       — kind badge: luna-chat-server, origin: server-emitted")
console.log("                                  [⏪ Rollback] button PRESENT (update.revertible=true)")
console.log("  RIGHT panel  (Hermes HTTP)   — kind badge: hermes, origin: client-projected")
console.log("                                  No rollback button (update.revertible=false)")
console.log("")
console.log("Press Ctrl+C to stop.")

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on("SIGINT", async () => {
  console.log("\nShutting down…")
  server.stop(true)
  await Promise.allSettled([lunaStub.stop(), hermesStub.stop()])
  process.exit(0)
})
