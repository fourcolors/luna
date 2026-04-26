/**
 * Transport abstraction: a function from (url, token) → live frame stream.
 *
 * v2 adds bi-directional flow: callers can also `send(ClientFrame)` to
 * drive chat ops (subscribe, new-thread, user-message, interrupt). The
 * transport buffers sends issued before the socket opens and flushes on
 * `open` so callers don't have to coordinate with connection state.
 *
 * Why an interface, not a hardcoded WebSocket: when we wrap this app in
 * Tauri later, we may swap the browser WebSocket for `tauri-plugin-
 * websocket` (or a Rust-side connection forwarded via IPC). Keeping the
 * caller honest with this signature means the swap is a one-line change.
 */
import type { ClientFrame, ServerFrame } from "./wire.js"

export type ConnectionStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "open" }
  | { kind: "closed"; code: number; reason: string }
  | { kind: "error"; message: string }

export interface TransportHandle {
  readonly send: (frame: ClientFrame) => void
  readonly disconnect: () => void
}

export interface Transport {
  readonly connect: (params: {
    url: string
    token: string
    onFrame: (frame: ServerFrame) => void
    onStatus: (status: ConnectionStatus) => void
  }) => TransportHandle
}

/** Browser WebSocket transport. Uses ?token= query-string auth. */
export const browserWebSocketTransport: Transport = {
  connect: ({ url, token, onFrame, onStatus }) => {
    const sep = url.includes("?") ? "&" : "?"
    const fullUrl = `${url}${sep}token=${encodeURIComponent(token)}`
    onStatus({ kind: "connecting" })
    let ws: WebSocket
    const sendBuffer: ClientFrame[] = []
    let opened = false
    try {
      ws = new WebSocket(fullUrl)
    } catch (e) {
      onStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      })
      return {
        send: () => {
          // no-op (already failed)
        },
        disconnect: () => {
          // no-op
        },
      }
    }

    ws.addEventListener("open", () => {
      opened = true
      onStatus({ kind: "open" })
      // Flush queued sends.
      for (const f of sendBuffer.splice(0)) {
        try {
          ws.send(JSON.stringify(f))
        } catch {
          // ignore — close handler will surface state
        }
      }
    })
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

    return {
      send: (frame) => {
        if (!opened || ws.readyState !== ws.OPEN) {
          sendBuffer.push(frame)
          return
        }
        try {
          ws.send(JSON.stringify(frame))
        } catch {
          // Connection died between the readyState check and send;
          // drop and let the close handler surface state.
        }
      },
      disconnect: () => {
        try {
          ws.close()
        } catch {
          // ignore
        }
      },
    }
  },
}
