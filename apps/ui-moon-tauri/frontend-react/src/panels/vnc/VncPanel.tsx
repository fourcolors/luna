/**
 * VncPanel.tsx - "Screen Share": a VNC client living inside a Moon widget
 * window (registry kind 'vnc', opened via open_widget('vnc'[, {host,port}])).
 *
 * The remote desktop is rendered by noVNC (an RFB client speaking over
 * WebSocket binary frames). Real VNC servers listen on raw TCP, so for a
 * plain `host` + `port` the panel first asks Rust's `vnc_connect` for a
 * one-shot loopback WS<->TCP bridge (src-tauri/src/vnc.rs) and points noVNC
 * at the returned ws:// URL. A `ws://`/`wss://` value in the host field
 * skips the bridge entirely (websockify-style endpoints need no help).
 *
 * Security shape: the VNC password never leaves this webview - RFB's own
 * auth handshake carries it over the pipe - and it is never accepted as a
 * widget-open param, so instance params in the layout file only ever hold
 * {host, port}.
 *
 * Credentials re-prompt: the RFB 'credentialsrequired' event opens an inline
 * password (and username, when the server lists it) card whose submit calls
 * rfb.sendCredentials - no page reload, no second connect.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type RFB from "@novnc/novnc"
import { Button, TextInput } from "../../astryx-kit"
import type { PanelCtx } from "../panel-ctx"
import "./VncPanel.css"

export const VNC_PANEL_TITLE = "Screen Share"

declare global {
  interface Window {
    __panelCtx?: PanelCtx
  }
}

export interface VncPanelProps {
  /** Defaults to window.__panelCtx (panel.html's hand-off - see ../panel-ctx.ts)
   *  so production mounts need not thread it explicitly; tests inject a mock. */
  ctx?: PanelCtx
}

type ConnState = "idle" | "connecting" | "connected" | "error"

/** Rust's vnc_connect reply shape (src-tauri/src/vnc.rs VncBridgeInfo). */
interface VncBridgeInfo {
  id: number
  url: string
}

const WS_URL_RE = /^wss?:\/\//i

function defaultPort(portStr: string): number | null {
  const p = Number.parseInt(portStr, 10)
  return Number.isInteger(p) && p > 0 && p <= 65535 ? p : null
}

export function VncPanel({ ctx: ctxProp }: VncPanelProps) {
  const ctx = ctxProp ?? window.__panelCtx
  // Widget-open params (open_widget('vnc', {host, port})): prefill, and a
  // supplied host auto-connects once on mount. `password` is deliberately
  // NOT read - see the module doc for why.
  const params = useMemo(() => new URLSearchParams(location.search), [])
  const [host, setHost] = useState(params.get("host") ?? "")
  const [port, setPort] = useState(params.get("port") ?? "5900")
  const [password, setPassword] = useState("")
  const [credUser, setCredUser] = useState("")
  const [connState, setConnState] = useState<ConnState>("idle")
  const [status, setStatus] = useState<string | null>(null)
  const [needCreds, setNeedCreds] = useState(false)
  const [needUser, setNeedUser] = useState(false)
  const [desktopName, setDesktopName] = useState("")

  const viewportRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFB | null>(null)
  const bridgeIdRef = useRef<number | null>(null)
  // Guards the disconnect bookkeeping: the 'disconnect' RFB event fires for
  // BOTH a remote drop and our own rfb.disconnect() call, and unmount can
  // race either - the bridge close must run exactly once.
  const bridgeClosedRef = useRef(true)
  // Connect generation: bumped by every teardown() (Disconnect, unmount, the
  // start of a new connect). connect() captures it and re-checks after each
  // await, so a dial or lazy import that resolves AFTER the user cancelled or
  // reconnected can neither touch state nor resurrect a stale session.
  const genRef = useRef(0)

  const closeBridge = useCallback(() => {
    if (bridgeClosedRef.current) return
    bridgeClosedRef.current = true
    const id = bridgeIdRef.current
    bridgeIdRef.current = null
    if (id != null && ctx?.invoke) {
      ctx.invoke("vnc_disconnect", { id }).catch(() => {})
    }
  }, [ctx])

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

  // Unmount (window closed / panel remounted): the ws close also ends the
  // bridge, but ask Rust to abort it anyway so nothing lingers.
  // Cleanup-only: `useEffect(teardown)` would *run* teardown on mount
  // (harmless) and register no unmount cleanup (the return is undefined),
  // leaking the bridge until the 30s accept timeout or the remote close.
  useEffect(() => () => { teardown() }, [teardown])

  const connect = useCallback(
    async (hostStr: string, portStr: string, passwordStr: string) => {
      const h = hostStr.trim()
      if (!h) {
        setStatus("Enter a host name or IP.")
        setConnState("error")
        return
      }
      teardown()
      const gen = genRef.current
      setConnState("connecting")
      setStatus(null)
      setNeedCreds(false)
      setDesktopName("")

      let url = h
      if (!WS_URL_RE.test(h)) {
        const p = defaultPort(portStr)
        if (p == null) {
          setStatus("Port must be 1-65535.")
          setConnState("error")
          return
        }
        try {
          const info = (await ctx?.invoke("vnc_connect", { host: h, port: p })) as VncBridgeInfo
          if (gen !== genRef.current) {
            // Cancelled (or superseded) while dialing: the bridge Rust just
            // opened belongs to nobody, so abort it and leave state alone.
            ctx?.invoke("vnc_disconnect", { id: info.id }).catch(() => {})
            return
          }
          bridgeIdRef.current = info.id
          bridgeClosedRef.current = false
          url = info.url
        } catch (e) {
          if (gen !== genRef.current) return
          setStatus(e instanceof Error ? e.message : String(e))
          setConnState("error")
          return
        }
      }

      const target = viewportRef.current
      if (!target) {
        setStatus("Screen view not ready.")
        setConnState("error")
        closeBridge()
        return
      }
      let RfbCtor: typeof RFB
      try {
        // Lazy: ~300kB of RFB/decoders loads only when a user actually
        // connects, so every other panel type on this bundle never pays it.
        RfbCtor = (await import("@novnc/novnc")).default
      } catch (e) {
        if (gen !== genRef.current) return
        setStatus("Viewer failed to load.")
        setConnState("error")
        closeBridge()
        return
      }
      // Cancelled during the lazy import: teardown() already closed our bridge
      // (bridgeClosedRef was false), and a newer connect may own the refs now.
      if (gen !== genRef.current) return
      try {
        const rfb = new RfbCtor(target, url, {
          shared: true,
          credentials: passwordStr ? { password: passwordStr } : {},
        })
        rfb.scaleViewport = true
        // Every listener ignores events from an RFB that is no longer current:
        // noVNC fires 'disconnect' asynchronously after rfb.disconnect(), so
        // an old instance would otherwise null the new rfbRef / abort the new
        // bridge when the user reconnects quickly.
        rfb.addEventListener("connect", () => {
          if (rfbRef.current !== rfb) return
          setConnState("connected")
          target.querySelector("canvas")?.focus()
        })
        rfb.addEventListener("disconnect", (e) => {
          if (rfbRef.current !== rfb) return
          const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean
          rfbRef.current = null
          closeBridge()
          setNeedCreds(false)
          if (clean) {
            setConnState("idle")
            setStatus(null)
          } else {
            setConnState("error")
            setStatus("Connection lost.")
          }
        })
        rfb.addEventListener("credentialsrequired", (e) => {
          if (rfbRef.current !== rfb) return
          const types = (e as CustomEvent<{ types: string[] }>).detail?.types ?? []
          setNeedUser(types.includes("username"))
          setNeedCreds(true)
        })
        rfb.addEventListener("securityfailure", (e) => {
          if (rfbRef.current !== rfb) return
          const reason = (e as CustomEvent<{ reason?: string }>).detail?.reason
          setStatus(reason ? `Authentication failed: ${reason}` : "Authentication failed")
        })
        rfb.addEventListener("desktopname", (e) => {
          if (rfbRef.current !== rfb) return
          setDesktopName((e as CustomEvent<{ name: string }>).detail?.name ?? "")
        })
        rfbRef.current = rfb
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e))
        setConnState("error")
        closeBridge()
      }
    },
    [ctx, teardown, closeBridge],
  )

  // Auto-connect once when the widget was opened with a host param.
  const autoConnectRef = useRef(false)
  useEffect(() => {
    if (autoConnectRef.current) return
    autoConnectRef.current = true
    const h = params.get("host")
    if (h) {
      void connect(h, params.get("port") ?? "5900", "")
    }
  }, [connect, params])

  const handleSubmitCreds = () => {
    const rfb = rfbRef.current
    if (!rfb) return
    const creds: Record<string, string> = { password }
    if (needUser) creds.username = credUser
    setNeedCreds(false)
    rfb.sendCredentials(creds)
  }

  const handleDisconnect = () => {
    teardown()
    setConnState("idle")
    setStatus(null)
    setNeedCreds(false)
  }

  const live = connState === "connecting" || connState === "connected"

  return (
    <div className="vnc-panel">
      <div className="vnc-stage">
        <div className="vnc-viewport" ref={viewportRef} data-testid="vnc-viewport" />

        {connState === "connecting" && !needCreds && (
          <div className="vnc-overlay vnc-overlay-status">
            <div className="vnc-connecting">Connecting</div>
          </div>
        )}

        {!live && (
          <div className="vnc-overlay">
            <div className="vnc-connect-card">
              <div className="vnc-connect-title">Connect</div>
              <div className="vnc-fields">
                <div className="vnc-field-row">
                  <div className="vnc-field">
                    <span>Host</span>
                    <TextInput
                      label="Host"
                      isLabelHidden
                      placeholder="host or ws://"
                      value={host}
                      onChange={setHost}
                      data-testid="vnc-host-input"
                    />
                  </div>
                  <div className="vnc-field vnc-field-port">
                    <span>Port</span>
                    <TextInput
                      label="Port"
                      isLabelHidden
                      placeholder="5900"
                      value={port}
                      onChange={setPort}
                      width={72}
                      data-testid="vnc-port-input"
                    />
                  </div>
                </div>
                <div className="vnc-field">
                  <span>Password</span>
                  <TextInput
                    label="Password"
                    isLabelHidden
                    type="password"
                    placeholder="optional"
                    value={password}
                    onChange={setPassword}
                    data-testid="vnc-password-input"
                  />
                </div>
                <div className="vnc-actions">
                  <Button
                    label={connState === "error" ? "Try again" : "Connect"}
                    variant="primary"
                    size="sm"
                    onClick={() => void connect(host, port, password)}
                    data-testid="vnc-connect-btn"
                  />
                </div>
              </div>
              {status && (
                <div className={"vnc-status" + (connState === "error" ? " error" : "")} data-testid="vnc-status">
                  {status}
                </div>
              )}
              <div className="vnc-connect-hint">Password stays on this device.</div>
            </div>
          </div>
        )}

        {live && needCreds && (
          <div className="vnc-overlay">
            <div className="vnc-connect-card">
              <div className="vnc-connect-title">Password required</div>
              <div className="vnc-fields">
                {needUser && (
                  <div className="vnc-field">
                    <span>Username</span>
                    <TextInput
                      label="Username"
                      isLabelHidden
                      placeholder="Username"
                      value={credUser}
                      onChange={setCredUser}
                      data-testid="vnc-cred-user"
                    />
                  </div>
                )}
                <div className="vnc-field">
                  <span>Password</span>
                  <TextInput
                    label="Password"
                    isLabelHidden
                    type="password"
                    placeholder="Password"
                    value={password}
                    onChange={setPassword}
                    data-testid="vnc-cred-password"
                  />
                </div>
                <div className="vnc-actions">
                  <Button
                    label="Continue"
                    variant="primary"
                    size="sm"
                    onClick={handleSubmitCreds}
                    data-testid="vnc-cred-submit"
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {live && (
        <div className="vnc-footer">
          <span className="vnc-footer-name" data-testid="vnc-status-line">
            {connState === "connecting"
              ? host || "Connecting"
              : needCreds
                ? "Password required"
                : desktopName || host}
          </span>
          <Button
            label="Disconnect"
            variant="ghost"
            size="sm"
            onClick={handleDisconnect}
            data-testid="vnc-disconnect-btn"
          />
        </div>
      )}
    </div>
  )
}
