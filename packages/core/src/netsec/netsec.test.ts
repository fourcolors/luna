import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { createServer, type Server } from "node:http"
import { NetSecClient } from "./netsec.js"

const listen = (handler: Parameters<typeof createServer>[1]): Promise<Server> =>
  new Promise((resolve) => {
    const s = createServer(handler)
    s.listen(0, "127.0.0.1", () => resolve(s))
  })

const portOf = (s: Server): number => (s.address() as { port: number }).port

describe("NetSecClient egress allowlist — redirects (strict mode)", () => {
  it("does NOT follow a redirect from an allowlisted host (fails closed)", async () => {
    // The egress allowlist is enforced only on the INITIAL url. If fetch
    // transparently follows a 3xx, the redirect target is never re-checked —
    // so an allowlisted host that 302s to a non-allowlisted host would slip
    // straight past the allowlist. Strict mode must refuse to follow redirects.
    const server = await listen((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, {
          Location: `http://127.0.0.1:${portOf(server)}/target`,
        })
        res.end()
        return
      }
      if (req.url === "/target") {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("FOLLOWED-PAST-ALLOWLIST")
        return
      }
      res.writeHead(404)
      res.end()
    })

    try {
      const port = portOf(server)
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const net = yield* NetSecClient
          return yield* net.fetch(`http://127.0.0.1:${port}/redirect`)
        }).pipe(
          Effect.provide(
            NetSecClient.makeLayer({
              strictMode: true,
              allowlist: [{ host: "127.0.0.1" }],
            }),
          ),
        ),
      )

      // The redirect must not be followed: the fetch fails rather than
      // returning the (post-redirect) body.
      expect(Exit.isFailure(exit)).toBe(true)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it("still fetches a non-redirecting allowlisted host normally", async () => {
    // Guard: the fix must not break ordinary (non-redirecting) requests.
    const server = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("OK-DIRECT")
    })
    try {
      const port = portOf(server)
      const body = await Effect.runPromise(
        Effect.gen(function* () {
          const net = yield* NetSecClient
          const resp = yield* net.fetch(`http://127.0.0.1:${port}/ok`)
          return resp.body
        }).pipe(
          Effect.provide(
            NetSecClient.makeLayer({
              strictMode: true,
              allowlist: [{ host: "127.0.0.1" }],
            }),
          ),
        ),
      )
      expect(body).toBe("OK-DIRECT")
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
