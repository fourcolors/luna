/**
 * Control server — Bun HTTP server wrapping the tRPC router.
 *
 * Uses the fetch-adapter so it works natively with Bun's `Bun.serve()`.
 * CORS is set to allow all origins (local-only service).
 *
 * `@types/bun` is intentionally NOT in the root tsconfig (matches the
 * convention in packages/memory and packages/core).  We declare the
 * minimal subset we need here so tsc can type-check without pulling in
 * the full Bun type definitions.
 */
import { Effect } from "effect"
import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import { appRouter } from "./router.js"

// Minimal Bun global shim — keeps @types/bun out of the root tsconfig.
declare const Bun: {
  serve(options: {
    port: number
    fetch(req: Request): Response | Promise<Response>
  }): void
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
} as const

/**
 * Start the tRPC control server on `port`.
 *
 * Returns an `Effect` that synchronously starts the Bun HTTP server and
 * resolves to `{ port }`. The server continues running in the Bun event loop —
 * no need to await or park.
 */
export function startControlServer(
  port: number,
): Effect.Effect<{ port: number }> {
  return Effect.sync(() => {
    Bun.serve({
      port,
      fetch(req) {
        // Handle CORS pre-flight
        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: CORS_HEADERS })
        }

        return fetchRequestHandler({
          endpoint: "/trpc",
          req,
          router: appRouter,
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
