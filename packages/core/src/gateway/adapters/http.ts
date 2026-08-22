/**
 * HttpAdapter — HTTP POST transport for GatewayService.
 *
 * Listens on an HTTP server for POST /message requests.
 * Request body: `{ text: string; channelId?: string; senderId?: string }`
 * Response: `{ text: string }` (the agent response).
 *
 * Uses Node.js `http` module (no external framework dependency).
 * The stream emits each incoming request as a GatewayMessage.
 * The response is buffered via a Deferred: the `send()` call resolves
 * the HTTP response for the corresponding message.
 *
 * NOTE: This is a simple synchronous request-response model. For
 * streaming/SSE responses, a later phase will add that capability.
 */
import {
  Deferred,
  Effect,
  Queue,
  Ref,
  Stream,
} from "effect"
import * as http from "node:http"
import type { GatewayAdapter, GatewayMessage, GatewayResponse } from "../types.js"

interface HttpAdapterConfig {
  /** Port to listen on. Default: 3000. */
  readonly port?: number
  /** Host to bind. Default: "127.0.0.1". */
  readonly host?: string
}

let _msgCounter = 0
function nextId(): string {
  return `http-${++_msgCounter}`
}

export function makeHttpAdapter(config?: HttpAdapterConfig): GatewayAdapter {
  const port = config?.port ?? 3000
  const host = config?.host ?? "127.0.0.1"

  // Map from message id → Deferred<string> for HTTP response correlation.
  // The gateway calls send(response) which resolves the deferred.
  let pendingResponses: Map<string, Deferred.Deferred<string, never>> = new Map()

  const messages: GatewayAdapter["messages"] = Stream.asyncScoped((emit) =>
    Effect.gen(function* () {
      const q = yield* Queue.unbounded<GatewayMessage | null>()
      yield* Effect.addFinalizer(() => Queue.shutdown(q))

      const server = http.createServer((req, res) => {
        if (req.method !== "POST" || req.url !== "/message") {
          res.writeHead(404)
          res.end()
          return
        }

        let body = ""
        req.on("data", (chunk: Buffer) => { body += chunk.toString() })
        req.on("end", () => {
          let parsed: { text?: string; channelId?: string; senderId?: string } = {}
          try { parsed = JSON.parse(body) as typeof parsed } catch { /**/ }

          const msgId = nextId()
          const msg: GatewayMessage = {
            id: msgId,
            transport: "http",
            channelId: parsed.channelId ?? "http",
            senderId: parsed.senderId ?? "anonymous",
            text: parsed.text ?? "",
            metadata: { _res: res },
            ts: new Date().toISOString(),
          }

          // Store res in pendingResponses via a Deferred
          void Effect.runPromise(
            Effect.gen(function* () {
              const deferred = yield* Deferred.make<string, never>()
              pendingResponses.set(msgId, deferred)
              yield* Queue.offer(q, msg)
              // Wait for the response then write it
              const responseText = yield* Deferred.await(deferred)
              res.writeHead(200, { "Content-Type": "application/json" })
              res.end(JSON.stringify({ text: responseText }))
            }).pipe(Effect.catchCause(() => {
              res.writeHead(500)
              res.end()
              return Effect.void
            })),
          )
        })
      })

      server.listen(port, host)
      yield* Effect.addFinalizer(() =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void))
        }),
      )

      return yield* Effect.forkDetach(
        Effect.gen(function* () {
          while (true) {
            const item = yield* Queue.take(q)
            if (item === null) {
              emit.end()
              return
            }
            emit.single(item)
          }
        }).pipe(Effect.catchCause(() => Effect.void)),
      )
    }),
  )

  const send = (response: GatewayResponse): Effect.Effect<void> =>
    Effect.gen(function* () {
      const deferred = pendingResponses.get(response.inReplyTo.id)
      if (deferred === undefined) return
      pendingResponses.delete(response.inReplyTo.id)
      yield* Deferred.succeed(deferred, response.text)
    })

  return {
    transport: "http" as const,
    messages,
    send,
    start: Effect.void,
  }
}
