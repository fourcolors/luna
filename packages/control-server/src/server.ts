/**
 * Control server — Bun HTTP server wrapping the tRPC router.
 *
 * Uses the fetch-adapter so it works natively with Bun's `Bun.serve()`.
 *
 * Security (mirrors the ui-ws server's posture — this surface exposes
 * `control.restart`, so it must be just as locked down):
 *   - Binds 127.0.0.1 ONLY. It must never be reachable off-host; cross-machine
 *     control goes over the same SSH tunnel as the WS surface.
 *   - Requires `Authorization: Bearer <token>` — the SAME LUNA_UI_WS_TOKEN that
 *     gates the WS server. Constant-time compare.
 *   - CORS allows the Authorization header so the browser UI (served from a
 *     different origin/port) can send the bearer token on its control calls.
 *
 * `@types/bun` is intentionally NOT in the root tsconfig (matches the
 * convention in packages/memory and packages/core).  We declare the
 * minimal subset we need here so tsc can type-check without pulling in
 * the full Bun type definitions.
 */
import { Effect } from "effect"
import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import { createAppRouter } from "./router.js"

// Minimal Bun global shim — keeps @types/bun out of the root tsconfig.
declare const Bun: {
  serve(options: {
    port: number
    hostname?: string
    fetch(req: Request): Response | Promise<Response>
  }): void
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
} as const

/**
 * Constant-time bearer-token check for control-server requests. Mirrors the
 * ui-ws server's `tokenEq` so the same LUNA_UI_WS_TOKEN gates both surfaces.
 * Returns false for an empty server token so a misconfiguration can never
 * authorize an empty bearer.
 */
export const isAuthorized = (
  authHeader: string | null,
  token: string,
): boolean => {
  if (!token) return false
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false
  const provided = authHeader.slice("Bearer ".length)
  if (provided.length !== token.length) return false
  let diff = 0
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ token.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Start the tRPC control server on `port`, bound to loopback and gated by
 * `token` (the LUNA_UI_WS_TOKEN). Returns an Effect that synchronously starts
 * the Bun HTTP server and resolves to `{ port }`. The server continues running
 * in the Bun event loop — no need to await or park.
 *
 * `buildSha` (optional) is the git short-SHA of this build, surfaced in
 * `control.status`. Omitted → "unknown" (additive; older callers unaffected).
 */
export function startControlServer(
  port: number,
  token: string,
  buildSha?: string,
): Effect.Effect<{ port: number }> {
  const router = createAppRouter(buildSha)
  return Effect.sync(() => {
    Bun.serve({
      port,
      // Loopback only — the control surface (control.restart) must never be
      // reachable off-host. The bearer token below is the second layer.
      hostname: "127.0.0.1",
      fetch(req) {
        // CORS pre-flight carries no auth — answer it before the token gate.
        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: CORS_HEADERS })
        }
        if (!isAuthorized(req.headers.get("authorization"), token)) {
          return new Response("unauthorized", {
            status: 401,
            headers: CORS_HEADERS,
          })
        }
        return fetchRequestHandler({
          endpoint: "/trpc",
          req,
          router,
          createContext: () => ({}),
          responseMeta() {
            return { headers: CORS_HEADERS }
          },
        })
      },
    })

    return { port }
  })
}
