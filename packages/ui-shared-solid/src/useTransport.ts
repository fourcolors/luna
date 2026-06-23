/**
 * createTransport — Solid composable wrapping the framework-agnostic
 * `Transport` from `@luna/ui-shared/core`.
 *
 * Mirrors the React `useTransport`-style block in apps/ui-web/src/App.tsx
 * (`handleRef = browserWebSocketTransport.connect({...})`) but with
 * Solid primitives:
 *   - `status` is a `createSignal` so components subscribe to status
 *     changes with fine-grained updates
 *   - `connect()` / `disconnect()` are imperative helpers
 *   - `send()` forwards to the live handle (or no-ops when idle)
 *   - `onCleanup` disconnects the socket when the owning component
 *     unmounts (parity with React's unmount-cleanup useEffect)
 *
 * The caller supplies an `onFrame` callback (typically `store.dispatch`)
 * plus an optional `onOpen` for connection-established side effects
 * (e.g. requesting `list-threads` once the socket opens).
 */
import { createSignal, onCleanup } from "solid-js"
import {
  type ClientFrame,
  type ConnectionStatus,
  type ServerFrame,
  type Transport,
  type TransportHandle,
} from "@luna/ui-shared/core"
import { pooledWebSocketTransport } from "./pooled-transport.js"

export interface CreateTransportParams {
  readonly transport?: Transport
  readonly onFrame: (frame: ServerFrame) => void
  readonly onOpen?: ((handle: TransportHandle) => void) | undefined
}

export interface TransportComposable {
  /** Reactive accessor for the current connection status. */
  readonly status: () => ConnectionStatus
  /** Open a new socket. Tears down any previous handle first. */
  readonly connect: (url: string, token: string) => void
  /** Send a client frame; no-op if not connected. */
  readonly send: (frame: ClientFrame) => void
  /** Tear down the live socket (if any) and reset status to idle. */
  readonly disconnect: () => void
}

export const createTransport = (
  params: CreateTransportParams,
): TransportComposable => {
  const transport = params.transport ?? pooledWebSocketTransport
  const [status, setStatus] = createSignal<ConnectionStatus>({ kind: "idle" })
  let handle: TransportHandle | null = null

  const tearDown = (): void => {
    if (handle) {
      try {
        handle.disconnect()
      } catch {
        // ignore — close handler will surface state
      }
      handle = null
    }
  }

  const connect = (url: string, token: string): void => {
    tearDown()
    handle = transport.connect({
      url,
      token,
      onFrame: params.onFrame,
      onStatus: (s) => {
        setStatus(s)
        // NOTE: onOpen can fire multiple times per logical session — each transparent
        // reconnect re-emits ready→open, so onOpen handlers must be idempotent.
        if (s.kind === "open" && handle && params.onOpen) {
          params.onOpen(handle)
        }
      },
    })
  }

  const send = (frame: ClientFrame): void => {
    handle?.send(frame)
  }

  const disconnect = (): void => {
    tearDown()
    setStatus({ kind: "idle" })
  }

  // Auto-disconnect on owner cleanup (component unmount).
  onCleanup(() => {
    tearDown()
  })

  return { status, connect, send, disconnect }
}
