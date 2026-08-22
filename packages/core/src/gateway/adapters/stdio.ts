/**
 * StdioAdapter — CLI transport for GatewayService.
 *
 * Reads lines from process.stdin (one message per line) and writes
 * responses to process.stdout.
 *
 * Useful for:
 *   - CLI-mode agent: pipe messages via stdin, get responses on stdout.
 *   - Testing: inject messages programmatically via a passthrough stream.
 *
 * Implementation:
 *   - `messages` is a Stream.callback that reads from stdin line-by-line.
 *   - `send` writes the response text to stdout.
 *   - The stream completes when stdin closes (EOF).
 */
import {
  Effect,
  Queue,
  Stream,
} from "effect"
import * as readline from "node:readline"
import type { GatewayAdapter, GatewayMessage, GatewayResponse } from "../types.js"

let _msgCounter = 0
function nextId(): string {
  return `cli-${++_msgCounter}`
}

export function makeStdioAdapter(opts?: {
  /**
   * Inject a custom input stream instead of process.stdin.
   * Useful for testing: pass a Node.js Readable.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly input?: NodeJS.ReadableStream
  /**
   * Custom output writer instead of process.stdout.write.
   */
  readonly output?: (line: string) => void
}): GatewayAdapter {
  const inputStream = opts?.input ?? process.stdin
  const writer = opts?.output ?? ((line: string) => process.stdout.write(line + "\n"))

  const messages: GatewayAdapter["messages"] = Stream.callback<GatewayMessage>((queue) =>
    Effect.gen(function* () {
      const rl = readline.createInterface({ input: inputStream, crlfDelay: Infinity })

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rl.close()
        }),
      )

      rl.on("line", (line: string) => {
        const trimmed = line.trim()
        if (trimmed.length === 0) return
        const msg: GatewayMessage = {
          id: nextId(),
          transport: "cli",
          channelId: "stdio",
          senderId: "user",
          text: trimmed,
          metadata: {},
          ts: new Date().toISOString(),
        }
        void Effect.runPromise(Queue.offer(queue, msg))
      })

      rl.on("close", () => {
        void Effect.runPromise(Queue.end(queue))
      })

      rl.on("error", () => {
        void Effect.runPromise(Queue.end(queue))
      })
    }),
  )

  const send = (response: GatewayResponse): Effect.Effect<void> =>
    Effect.sync(() => {
      writer(response.text)
    })

  return {
    transport: "cli" as const,
    messages,
    send,
  }
}
