/**
 * pooledWebSocketTransport — a Transport implementation backed by the
 * ui-transport ConnectionManager / LunaWsAdapter pool.
 *
 * Drop-in replacement for browserWebSocketTransport: it implements the same
 * Transport interface and can be passed as `params.transport` to createTransport,
 * or used as the default in useTransport.ts.
 *
 * Design:
 *   - Each `connect()` call creates a fresh single-route ConnectionManager and
 *     acquires a LunaWsAdapter.
 *   - ALL raw server frames (including hello) are forwarded to `onFrame` via the
 *     adapter's synchronous subscribeFrames() callback hook.
 *   - Connection state transitions are mapped from ConnectionState → ConnectionStatus
 *     and forwarded to `onStatus`.
 *   - `send()` uses the adapter's sendFrame() method; frames queued before acquire
 *     resolves are buffered and flushed on open.
 *   - `disconnect()` releases the adapter back to the pool (which disposes it
 *     since it is the sole reference holder).
 *
 * The pool benefit (dedup of concurrent acquires for the same routeKey) applies
 * within a single connect call if two callers were sharing a manager instance.
 * For v1 each connect creates its own manager, so the primary benefit here is
 * using the LunaWsAdapter's reconnect/descriptor logic instead of bare WebSocket.
 */
import { ConnectionManager, LunaWsAdapter } from "@luna/ui-transport"
import type { RouteHandle } from "@luna/ui-transport"
import type { ConnectionState } from "@luna/ui-transport"
import type { ClientFrame, Transport, TransportHandle, ConnectionStatus } from "@luna/ui-shared/core"

// UX semantics:
//   connecting / recovering → {kind:"connecting"} — self-heals silently (no banner)
//   ready                   → {kind:"open"}
//   down (terminal)         → {kind:"closed"}   — disconnect banner + Reconnect button
//   auth-failed             → {kind:"error"}    — error banner (token refresh needed)

/** Map adapter ConnectionState → Transport ConnectionStatus. Returns null for unknown states. */
export function mapConnectionState(state: ConnectionState): ConnectionStatus | null {
  switch (state.status) {
    case "connecting":
      return { kind: "connecting" }
    case "ready":
      return { kind: "open" }
    case "recovering":
      return { kind: "connecting" }
    case "down":
      return { kind: "closed", code: 1000, reason: state.reason ?? "server unreachable" }
    case "auth-failed":
      return { kind: "error", message: state.reason ? `auth-failed: ${state.reason}` : "auth-failed" }
    case "handshake-timeout":
      return { kind: "error", message: "handshake-timeout" }
    case "identity-failed":
      return { kind: "error", message: "identity-failed" }
    case "route-missing":
      return { kind: "error", message: "route-missing" }
    default:
      return null
  }
}

/**
 * A Transport singleton backed by the ConnectionManager pool.
 * Each connect() call creates an independent single-route manager.
 */
export const pooledWebSocketTransport: Transport = {
  connect({ url, token, onFrame, onStatus }): TransportHandle {
    const routeKey = url
    const manager = new ConnectionManager(
      new Map([[routeKey, { routeKey, endpoints: [url], tokenRef: token }]]),
    )

    let released = false
    let routeHandle: RouteHandle | null = null
    let adapter: LunaWsAdapter | null = null
    let unsubFrames: (() => void) | null = null
    let unsubState: (() => void) | null = null

    // Buffer for frames sent before acquire() resolves.
    const sendBuffer: ClientFrame[] = []

    onStatus({ kind: "connecting" })

    manager.acquire(routeKey).then((handle) => {
      if (released) {
        // disconnect() was called before acquire completed; tear down immediately.
        void handle.release()
        return
      }

      routeHandle = handle
      const adapterUncast = handle.adapter
      if (!(adapterUncast instanceof LunaWsAdapter)) {
        // Fallback: adapter isn't a LunaWsAdapter — this shouldn't happen in
        // normal use since selectAdapter returns LunaWsAdapter for ws/wss routes.
        onStatus({ kind: "error", message: "unexpected adapter type" })
        return
      }
      adapter = adapterUncast

      // Subscribe to all raw server frames (including hello).
      unsubFrames = adapter.subscribeFrames((frame) => {
        if (!released) onFrame(frame)
      })

      // Subscribe to connection state transitions.
      unsubState = adapter.subscribeConnection((state) => {
        if (released) return
        const status = mapConnectionState(state)
        if (status) onStatus(status)
      })

      // The adapter already completed attach() (ready), so notify open.
      onStatus({ kind: "open" })

      // Flush any frames queued before the adapter was ready.
      for (const frame of sendBuffer.splice(0)) {
        adapter.sendFrame(frame)
      }
    }).catch((err: unknown) => {
      if (!released) {
        onStatus({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        })
      }
    })

    return {
      send(frame: ClientFrame): void {
        if (adapter) {
          adapter.sendFrame(frame)
        } else {
          // Queue until adapter is ready.
          sendBuffer.push(frame)
        }
      },
      disconnect(): void {
        if (released) return
        released = true
        unsubFrames?.()
        unsubState?.()
        sendBuffer.length = 0
        if (routeHandle) {
          void routeHandle.release()
          routeHandle = null
        }
        // If acquire is still in-flight, the .then() guard handles cleanup.
        // Dispose the manager itself to cancel any pending attach.
        void manager.disposeAll()
        onStatus({ kind: "idle" })
      },
    }
  },
}
