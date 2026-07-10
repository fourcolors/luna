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

/** Adapts the production LunaWsAdapter (bounded exponential reconnect) to the
 * small Transport contract consumed by useLunaData. JSON heartbeat replies
 * live here so every Studio connection answers them, including after retry. */
export function createReconnectingLunaTransport(
  makeAdapter: AdapterFactory = (route) => new LunaWsAdapter(route),
): Transport {
  return {
    connect: ({ url, token, onFrame, onStatus }) => {
      const adapter = makeAdapter({ routeKey: "studio", endpoints: [url], tokenRef: token })
      let disconnected = false
      let terminalStatePublished = false

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
        onStatus(toStudioStatus(state))
      })

      void adapter.attach().catch((error: unknown) => {
        if (disconnected || terminalStatePublished) return
        onStatus({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        })
      })

      return {
        send: (frame: ClientFrame) => adapter.sendFrame(frame),
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
