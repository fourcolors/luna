/**
 * serve-static.ts — serve the built Vite SPA (dist/) over HTTP so the deploy
 * pipeline can front it on the tailnet (behind the same Incus proxy / systemd
 * that fronts chat-server). SPA-fallback: unknown paths return index.html so
 * client routing works. Binds 127.0.0.1 by default (the tailnet exposure is a
 * proxy device, not a direct bind) — override with LUNA_WEB_HOST/LUNA_WEB_PORT.
 *
 *   bun run apps/ui-web/scripts/serve-static.ts
 *
 * SECURITY: this serves static files only; it NEVER embeds the UI_WS_TOKEN.
 * The build guard (see build:guarded) asserts VITE_UI_WS_TOKEN is unset at
 * build time so the shared secret is never baked into on-disk dist/ JS.
 */
import { file } from "bun"
import { join, normalize } from "node:path"
import { existsSync } from "node:fs"

const DIST = join(import.meta.dir, "..", "dist")
const HOST = process.env["LUNA_WEB_HOST"] ?? "127.0.0.1"
const PORT = Number(process.env["LUNA_WEB_PORT"] ?? "5175")

if (!existsSync(join(DIST, "index.html"))) {
  console.error(`[web-static] no build found at ${DIST} — run \`bun run build\` first`)
  process.exit(1)
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/healthz") return new Response("ok")
    // Resolve within dist/, blocking path traversal.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "")
    const candidate = join(DIST, rel)
    if (candidate.startsWith(DIST) && rel !== "/" && existsSync(candidate)) {
      const f = file(candidate)
      if (await f.exists()) return new Response(f)
    }
    // SPA fallback.
    return new Response(file(join(DIST, "index.html")), {
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  },
})

console.log(`[web-static] serving ${DIST} at http://${server.hostname}:${server.port}`)
