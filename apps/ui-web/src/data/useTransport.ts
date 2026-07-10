/**
 * useTransport — React hook wrapping the framework-agnostic `Transport` from
 * @luna/ui-shared/core. React idiom of the Solid `createTransport` composable:
 *   - `status` is useState so consumers re-render on connection changes
 *   - `connect` tears down any prior handle, then opens a fresh socket
 *   - `send` forwards to the live handle (no-op when idle)
 *   - unmount cleanup disconnects the socket
 *
 * The caller supplies `onFrame` (typically the store dispatch) plus optional
 * `onOpen` for connection-established side effects (list-threads,
 * widget-directory). Callbacks are held in refs so `connect` stays stable
 * while always calling the latest closure.
 *
 * NOTE: onOpen can fire multiple times per logical session — every transparent
 * reconnect re-emits open — so onOpen handlers MUST be idempotent.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import {
  type ClientFrame,
  type ConnectionStatus,
  type ServerFrame,
  type Transport,
  type TransportHandle,
} from "@luna/ui-shared/core"
import { reconnectingLunaTransport } from "./reconnecting-transport"

export interface UseTransportParams {
  readonly transport?: Transport
  readonly onFrame: (frame: ServerFrame) => void
  readonly onOpen?: ((handle: TransportHandle) => void) | undefined
}

export interface TransportApi {
  readonly status: ConnectionStatus
  readonly connect: (url: string, token: string) => void
  readonly send: (frame: ClientFrame) => void
  readonly disconnect: () => void
}

export function useTransport(params: UseTransportParams): TransportApi {
  const transport = params.transport ?? reconnectingLunaTransport
  const [status, setStatus] = useState<ConnectionStatus>({ kind: "idle" })
  const handleRef = useRef<TransportHandle | null>(null)

  // Latest callbacks in refs so `connect` stays referentially stable while
  // always invoking the current closure.
  const onFrameRef = useRef(params.onFrame)
  onFrameRef.current = params.onFrame
  const onOpenRef = useRef(params.onOpen)
  onOpenRef.current = params.onOpen

  const tearDown = useCallback((): void => {
    if (handleRef.current) {
      try {
        handleRef.current.disconnect()
      } catch {
        // ignore — close handler surfaces state
      }
      handleRef.current = null
    }
  }, [])

  const connect = useCallback(
    (url: string, token: string): void => {
      tearDown()
      handleRef.current = transport.connect({
        url,
        token,
        onFrame: (frame) => onFrameRef.current(frame),
        onStatus: (s) => {
          setStatus(s)
          if (s.kind === "open" && handleRef.current && onOpenRef.current) {
            onOpenRef.current(handleRef.current)
          }
        },
      })
    },
    [transport, tearDown],
  )

  const send = useCallback((frame: ClientFrame): void => {
    handleRef.current?.send(frame)
  }, [])

  const disconnect = useCallback((): void => {
    tearDown()
    setStatus({ kind: "idle" })
  }, [tearDown])

  // Disconnect on unmount.
  useEffect(() => () => tearDown(), [tearDown])

  return { status, connect, send, disconnect }
}
