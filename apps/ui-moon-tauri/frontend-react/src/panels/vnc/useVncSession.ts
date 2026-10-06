/**
 * useVncSession.ts - one Screen Share connection: bridge + noVNC RFB client.
 *
 * Owns everything with a lifetime: the Rust loopback bridge id, the RFB
 * instance, and a generation counter. Every async step (bridge dial, lazy
 * noVNC import) re-checks the generation after it resolves, so a result that
 * lands after Disconnect or a newer Connect can neither change state nor
 * revive a dead session. Every RFB listener ignores events from an instance
 * that is no longer current (noVNC fires 'disconnect' asynchronously).
 *
 * UI state lives in the pure `sessionReducer` (vncModel.ts).
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import type RFB from "@novnc/novnc"
import type { PanelCtx } from "../panel-ctx"
import {
  fingerprintOf,
  initialSession,
  parsePort,
  sessionReducer,
  toCredFields,
  WS_URL_RE,
  type CredField,
} from "./vncModel"

/** Rust's vnc_connect reply (src-tauri/src/vnc.rs VncBridgeInfo). */
interface VncBridgeInfo {
  id: number
  url: string
}

export type ScaleMode = "fit" | "actual"

export function useVncSession(ctx: PanelCtx | undefined) {
  const [state, dispatch] = useReducer(sessionReducer, initialSession)
  const [viewOnly, setViewOnlyState] = useState(false)
  const [scale, setScaleState] = useState<ScaleMode>("fit")

  const viewportRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFB | null>(null)
  const bridgeIdRef = useRef<number | null>(null)
  const genRef = useRef(0)
  // Read inside connect() so a new session starts with the current toggles.
  const viewOnlyRef = useRef(viewOnly)
  const scaleRef = useRef(scale)

  /** Close the Rust bridge exactly once (idempotent). */
  const closeBridge = useCallback(() => {
    const id = bridgeIdRef.current
    bridgeIdRef.current = null
    if (id != null) ctx?.invoke("vnc_disconnect", { id }).catch(() => {})
  }, [ctx])

  /** End the current session (if any) and invalidate in-flight steps. */
  const teardown = useCallback(() => {
    genRef.current += 1
    const rfb = rfbRef.current
    rfbRef.current = null
    try {
      rfb?.disconnect()
    } catch {
      /* already dead */
    }
    closeBridge()
  }, [closeBridge])

  // Unmount: end the session. The native side also aborts this window's
  // bridges on destroy (vnc.rs abort_for_window), since React cleanup is not
  // guaranteed to run when a webview is torn down.
  useEffect(() => () => teardown(), [teardown])

  const fail = useCallback(
    (gen: number, message: string) => {
      if (gen !== genRef.current) return
      closeBridge()
      dispatch({ type: "fail", message })
    },
    [closeBridge],
  )

  const connect = useCallback(
    async (hostStr: string, portStr: string, password: string) => {
      const host = hostStr.trim()
      if (!host) return dispatch({ type: "fail", message: "Enter a host name or IP." })
      teardown()
      const gen = genRef.current
      dispatch({ type: "start" })

      let url = host
      if (!WS_URL_RE.test(host)) {
        const port = parsePort(portStr)
        if (port == null) return fail(gen, "Port must be 1-65535.")
        try {
          const info = (await ctx?.invoke("vnc_connect", { host, port })) as VncBridgeInfo | undefined
          if (!info) return fail(gen, "Screen Share needs the Luna app.")
          if (gen !== genRef.current) {
            // Cancelled or superseded while dialing: this bridge is orphaned.
            ctx?.invoke("vnc_disconnect", { id: info.id }).catch(() => {})
            return
          }
          bridgeIdRef.current = info.id
          url = info.url
        } catch (e) {
          return fail(gen, e instanceof Error ? e.message : String(e))
        }
      }

      const target = viewportRef.current
      if (!target) return fail(gen, "Screen view not ready.")
      let RfbCtor: typeof RFB
      try {
        // Lazy: the RFB client and its decoders load only on first connect.
        RfbCtor = (await import("@novnc/novnc")).default
      } catch {
        return fail(gen, "Viewer failed to load.")
      }
      if (gen !== genRef.current) return

      let rfb: RFB
      try {
        rfb = new RfbCtor(target, url, {
          shared: true,
          credentials: password ? { password } : {},
        })
      } catch (e) {
        return fail(gen, e instanceof Error ? e.message : String(e))
      }
      rfbRef.current = rfb
      rfb.viewOnly = viewOnlyRef.current
      rfb.scaleViewport = scaleRef.current === "fit"
      rfb.clipViewport = scaleRef.current === "actual"
      const current = () => rfbRef.current === rfb

      rfb.addEventListener("connect", () => {
        if (!current()) return
        dispatch({ type: "connected" })
        rfb.focus()
      })
      rfb.addEventListener("disconnect", (e) => {
        if (!current()) return
        rfbRef.current = null
        closeBridge()
        dispatch({ type: "disconnected", clean: !!(e as CustomEvent<{ clean: boolean }>).detail?.clean })
      })
      rfb.addEventListener("credentialsrequired", (e) => {
        if (!current()) return
        const types = (e as CustomEvent<{ types?: string[] }>).detail?.types ?? ["password"]
        const fields = toCredFields(types)
        if (fields) return dispatch({ type: "credentials", fields })
        // A login step we cannot render: say so and release the connection
        // instead of leaving the panel on "Connecting" forever.
        teardown()
        dispatch({ type: "fail", message: `This server asks for a login Luna doesn't support yet (${types.join(", ")}).` })
      })
      rfb.addEventListener("serververification", (e) => {
        if (!current()) return
        const key = (e as CustomEvent<{ publickey?: Uint8Array }>).detail?.publickey
        if (!key) {
          teardown()
          return dispatch({ type: "fail", message: "The server sent an identity check Luna can't show." })
        }
        void fingerprintOf(key).then((fp) => {
          if (current()) dispatch({ type: "verify", fingerprint: fp })
        })
      })
      rfb.addEventListener("securityfailure", (e) => {
        if (!current()) return
        const reason = (e as CustomEvent<{ reason?: string }>).detail?.reason
        dispatch(reason ? { type: "securityFailure", reason } : { type: "securityFailure" })
      })
      rfb.addEventListener("desktopname", (e) => {
        if (current()) dispatch({ type: "desktopName", name: (e as CustomEvent<{ name?: string }>).detail?.name ?? "" })
      })
      rfb.addEventListener("clipboard", (e) => {
        if (current()) dispatch({ type: "remoteClipboard", text: (e as CustomEvent<{ text?: string }>).detail?.text ?? "" })
      })
    },
    [ctx, teardown, closeBridge, fail],
  )

  const disconnect = useCallback(() => {
    teardown()
    dispatch({ type: "reset" })
  }, [teardown])

  const sendCredentials = useCallback((creds: Partial<Record<CredField, string>>) => {
    const rfb = rfbRef.current
    if (!rfb) return
    dispatch({ type: "credentialsSent" })
    rfb.sendCredentials(creds as Record<string, string>)
  }, [])

  const approveServer = useCallback(() => {
    const rfb = rfbRef.current
    if (!rfb) return
    dispatch({ type: "verified" })
    rfb.approveServer()
  }, [])

  const setViewOnly = useCallback((on: boolean) => {
    viewOnlyRef.current = on
    setViewOnlyState(on)
    if (rfbRef.current) rfbRef.current.viewOnly = on
  }, [])

  const setScale = useCallback((mode: ScaleMode) => {
    scaleRef.current = mode
    setScaleState(mode)
    const rfb = rfbRef.current
    if (rfb) {
      rfb.scaleViewport = mode === "fit"
      rfb.clipViewport = mode === "actual"
    }
  }, [])

  const sendCtrlAltDel = useCallback(() => rfbRef.current?.sendCtrlAltDel(), [])

  /** Type text into the remote's clipboard (explicit operator action). */
  const pasteToRemote = useCallback((text: string) => {
    if (text) rfbRef.current?.clipboardPasteFrom(text)
  }, [])

  const takeRemoteClipboard = useCallback(() => dispatch({ type: "clipboardTaken" }), [])

  return {
    state,
    viewOnly,
    scale,
    viewportRef,
    connect,
    disconnect,
    sendCredentials,
    approveServer,
    setViewOnly,
    setScale,
    sendCtrlAltDel,
    pasteToRemote,
    takeRemoteClipboard,
  }
}

export type VncSession = ReturnType<typeof useVncSession>
