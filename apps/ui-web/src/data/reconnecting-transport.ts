import { LunaWsAdapter } from "@luna/ui-transport/browser"
import type { ConnectionState, RouteConfig } from "@luna/ui-transport/browser"
import type {
  ClientFrame,
  ConnectionStatus,
  ServerFrame,
  Transport,
} from "@luna/ui-shared/core"

/** Narrow structural surface used by Studio. Keeping the factory injectable
 * makes the bridge testable while LunaWsAdapter's own suite owns retry timing. */
export interface StudioLunaAdapter {
  subscribeFrames(listener: (frame: ServerFrame) => void): () => void
  subscribeConnection(listener: (state: ConnectionState) => void): () => void
  attach(): Promise<unknown>
  sendFrame(frame: unknown): void
  dispose(): Promise<void>
}

type AdapterFactory = (route: RouteConfig) => StudioLunaAdapter

function toStudioStatus(state: ConnectionState): ConnectionStatus {
  switch (state.status) {
    case "connecting":
    case "recovering":
      return { kind: "connecting" }
    case "ready":
      return { kind: "open" }
    case "auth-failed":
      return { kind: "closed", code: 1008, reason: state.reason ?? "authentication failed" }
    default:
      return { kind: "error", message: state.reason ?? state.status }
  }
}

/** Adapts the production LunaWsAdapter to the small Transport contract consumed
 * by useLunaData. JSON heartbeat replies live here so every Studio connection
 * answers them, including after retry.
 *
 * Reconnect is UNBOUNDED for Studio (the default factory raises maxAttempts):
 * a daily-driver window must self-heal across any-length outage (a long deploy,
 * a laptop sleep), not give up after the adapter's CLI-tuned 6-attempt default.
 * Auth failure stays terminal (see the subscribeConnection handler) so a
 * rejected token is never hammered forever. */
export function createReconnectingLunaTransport(
  makeAdapter: AdapterFactory = (route) =>
    new LunaWsAdapter(route, undefined, undefined, { maxAttempts: Number.MAX_SAFE_INTEGER }),
): Transport {
  return {
    connect: ({ url, token, onFrame, onStatus }) => {
      const adapter = makeAdapter({ routeKey: "studio", endpoints: [url], tokenRef: token })
      let disconnected = false
      let terminalStatePublished = false
      // The adapter drops sendFrame silently while its socket isn't OPEN, so
      // the bridge owns the send buffer (as browserWebSocketTransport did):
      // frames sent before the handshake completes, or during a transparent
      // recovery window, queue here and flush once the adapter reports ready.
      let ready = false
      const sendBuffer: ClientFrame[] = []

      const unsubscribeFrames = adapter.subscribeFrames((frame) => {
        if (disconnected) return
        if (frame.type === "ping") adapter.sendFrame({ type: "pong", ts: frame.ts })
        onFrame(frame)
      })
      const unsubscribeConnection = adapter.subscribeConnection((state) => {
        if (disconnected) return
        terminalStatePublished = [
          "down",
          "handshake-timeout",
          "auth-failed",
          "identity-failed",
          "route-missing",
        ].includes(state.status)
        ready = state.status === "ready"
        onStatus(toStudioStatus(state))
        // Auth failure is terminal for this credential. With unbounded retry
        // the adapter would otherwise keep hammering a token the server already
        // rejected (its reconnect path overrides auth-failed with recovering
        // and reschedules), so dispose here to stop the loop. The surfaced
        // closed/1008 status drives the UI to prompt for a new token; a fresh
        // connect() then builds a new adapter with it.
        if (state.status === "auth-failed") {
          disconnected = true
          void adapter.dispose()
          return
        }
        if (ready && !disconnected) {
          for (const buffered of sendBuffer.splice(0)) adapter.sendFrame(buffered)
        }
      })

      void adapter.attach().catch((error: unknown) => {
        if (disconnected || terminalStatePublished) return
        onStatus({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        })
      })

      return {
        send: (frame: ClientFrame) => {
          if (ready) {
            adapter.sendFrame(frame)
          } else {
            sendBuffer.push(frame)
          }
        },
        disconnect: () => {
          if (disconnected) return
          disconnected = true
          unsubscribeFrames()
          unsubscribeConnection()
          void adapter.dispose()
        },
      }
    },
  }
}

export const reconnectingLunaTransport = createReconnectingLunaTransport()
