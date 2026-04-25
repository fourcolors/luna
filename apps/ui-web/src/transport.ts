/**
 * Transport abstraction: a function from (url, token) → live frame stream.
 *
 * Why an interface, not a hardcoded WebSocket: when we wrap this app in
 * Tauri later, we may swap the browser WebSocket for `tauri-plugin-
 * websocket` (or a Rust-side connection forwarded via IPC). Keeping the
 * caller honest with this signature means the swap is a one-line change.
 */
import type { ServerFrame } from "./wire.js"

export type ConnectionStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "open" }
  | { kind: "closed"; code: number; reason: string }
  | { kind: "error"; message: string }

export interface Transport {
  readonly connect: (params: {
    url: string
    token: string
    onFrame: (frame: ServerFrame) => void
    onStatus: (status: ConnectionStatus) => void
  }) => () => void // disconnect fn
}

/** Browser WebSocket transport. Uses ?token= query-string auth. */
export const browserWebSocketTransport: Transport = {
  connect: ({ url, token, onFrame, onStatus }) => {
    const sep = url.includes("?") ? "&" : "?"
    const fullUrl = `${url}${sep}token=${encodeURIComponent(token)}`
    onStatus({ kind: "connecting" })
    let ws: WebSocket
    try {
      ws = new WebSocket(fullUrl)
    } catch (e) {
      onStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      })
      return () => {
        // no-op
      }
    }

    ws.addEventListener("open", () => onStatus({ kind: "open" }))
    ws.addEventListener("message", (ev) => {
      try {
        const frame = JSON.parse(String(ev.data)) as ServerFrame
        onFrame(frame)
      } catch {
        // Drop malformed frame silently — server is the source of truth.
      }
    })
    ws.addEventListener("close", (ev) =>
      onStatus({ kind: "closed", code: ev.code, reason: ev.reason }),
    )
    ws.addEventListener("error", () =>
      onStatus({
        kind: "error",
        message: "websocket error (open browser devtools for details)",
      }),
    )

    return () => {
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
  },
}
