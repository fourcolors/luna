/**
 * VncPanel.tsx - "Screen Share": view and control a VNC host in a Moon
 * window (registry kind 'vnc', opened from Cmd+K or open_widget('vnc'[,
 * {host, port}])).
 *
 * Layout of the feature:
 *   vncModel.ts       pure rules: input parsing, session state machine,
 *                     recent hosts (unit-tested)
 *   useVncSession.ts  one live connection: Rust bridge + noVNC RFB
 *   VncCards.tsx      Connect / Sign in / Check-this-server cards
 *   VncToolbar.tsx    the live-session footer
 *   src-tauri/src/vnc.rs  the loopback WebSocket-to-TCP bridge
 *
 * Consent: widget-open params only PRE-FILL the Connect card. Nothing dials
 * until the operator presses Connect, so neither the agent nor a restored
 * layout can make this Mac open a connection on its own. (Rust also strips
 * any param but a plain host and port before it is stored.)
 *
 * Secrets: the password lives in component state for the life of the card,
 * goes to the server only inside the RFB handshake, and is never stored.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "../../astryx-kit"
import type { PanelCtx } from "../panel-ctx"
import { ConnectCard, CredentialsCard, VerifyCard } from "./VncCards"
import { VncToolbar } from "./VncToolbar"
import { forgetRecent, loadRecent, readOpenParams, rememberRecent, type RecentHost } from "./vncModel"
import { useVncSession } from "./useVncSession"
import "./VncPanel.css"

export const VNC_PANEL_TITLE = "Screen Share"
const NOVNC_SOURCE_URL = "https://github.com/novnc/noVNC/tree/v1.7.0"

declare global {
  interface Window {
    __panelCtx?: PanelCtx
  }
}

export interface VncPanelProps {
  /** Defaults to window.__panelCtx (panel.html's hand-off); tests inject a mock. */
  ctx?: PanelCtx
}

interface FullscreenWindow {
  isFullscreen(): Promise<boolean>
  setFullscreen(on: boolean): Promise<void>
}

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement("textarea")
      ta.value = text
      ta.style.position = "fixed"
      ta.style.opacity = "0"
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand("copy")
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

export function VncPanel({ ctx: ctxProp }: VncPanelProps) {
  const ctx = ctxProp ?? window.__panelCtx
  const opened = useMemo(() => readOpenParams(location.search), [])
  const [host, setHost] = useState(opened.host)
  const [port, setPort] = useState(opened.port)
  const [password, setPassword] = useState("")
  const [prefilled, setPrefilled] = useState(opened.fromParams)
  const [recent, setRecent] = useState<RecentHost[]>(() => loadRecent(storage()))
  const [fullscreen, setFullscreen] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState("")
  const [notice, setNotice] = useState<string | null>(null)

  const session = useVncSession(ctx)
  const { state, connect: sessionConnect, disconnect: sessionDisconnect, takeRemoteClipboard, pasteToRemote } = session

  // A password belongs to one endpoint: changing host or port (or picking a
  // recent host) clears it, so it is never sent to a different computer.
  const editEndpoint = useCallback((next: Partial<RecentHost>) => {
    if (next.host !== undefined) setHost(next.host)
    if (next.port !== undefined) setPort(next.port)
    setPassword("")
    setPrefilled(false)
  }, [])

  const connect = useCallback(() => {
    setPrefilled(false)
    setNotice(null)
    setPasteOpen(false)
    // Remember only a plain host + valid port the operator connected to.
    setRecent(rememberRecent(storage(), { host: host.trim(), port: port.trim() || "5900" }))
    void sessionConnect(host, port, password)
  }, [host, port, password, sessionConnect])

  const win = (ctx?.win ?? null) as FullscreenWindow | null
  const toggleFullscreen = useCallback(async () => {
    if (!win) return
    try {
      const next = !(await win.isFullscreen())
      await win.setFullscreen(next)
      setFullscreen(next)
    } catch {
      setNotice("Full screen isn't available here.")
    }
  }, [win])

  const disconnect = useCallback(() => {
    sessionDisconnect()
    setPasteOpen(false)
    if (fullscreen) void win?.setFullscreen(false).catch(() => {})
    setFullscreen(false)
  }, [sessionDisconnect, fullscreen, win])

  const copyRemote = useCallback(async () => {
    const text = state.remoteClipboard
    if (text == null) return
    if (await copyText(text)) {
      takeRemoteClipboard(text)
      setNotice("Copied the remote clipboard.")
    } else {
      setNotice("Couldn't copy. Try again.") // stays offered for a retry
    }
  }, [state.remoteClipboard, takeRemoteClipboard])

  const sendPaste = useCallback(() => {
    pasteToRemote(pasteText)
    setPasteText("")
    setPasteOpen(false)
    setNotice("Sent to the remote clipboard. Paste it there.")
  }, [pasteText, pasteToRemote])

  const { phase } = state
  // A session that ends while full screen (remote close, network drop)
  // returns the window to normal so the Connect card isn't stranded.
  useEffect(() => {
    if ((phase === "idle" || phase === "error") && fullscreen) {
      void win?.setFullscreen(false).catch(() => {})
      setFullscreen(false)
    }
  }, [phase, fullscreen, win])
  const showConnect = phase === "idle" || phase === "error"
  const live = !showConnect
  const title =
    phase === "connecting"
      ? `Connecting to ${host}`
      : phase === "credentials"
        ? "Sign in required"
        : phase === "verify"
          ? "Checking the server"
          : state.desktopName || host

  return (
    <div className="vnc-panel">
      <div className="vnc-stage">
        <div className="vnc-viewport" ref={session.viewportRef} data-testid="vnc-viewport" />

        {phase === "connecting" && (
          <div className="vnc-overlay">
            <div className="vnc-connect-card vnc-status-card">
              <div className="vnc-connect-title">Connecting</div>
              {host ? <div className="vnc-connect-hint">{host}</div> : null}
            </div>
          </div>
        )}

        {showConnect && (
          <div className="vnc-overlay">
            <ConnectCard
              host={host}
              port={port}
              password={password}
              onHost={(v) => editEndpoint({ host: v })}
              onPort={(v) => editEndpoint({ port: v })}
              onPassword={setPassword}
              onConnect={connect}
              prefilled={prefilled}
              isError={phase === "error"}
              status={state.status}
              recent={recent}
              onPickRecent={(r) => editEndpoint(r)}
              onForgetRecent={(r) => setRecent(forgetRecent(storage(), r))}
              onOpenViewerSource={() => {
                ctx?.invoke("open_external_url", { url: NOVNC_SOURCE_URL }).catch(() => {})
              }}
            />
          </div>
        )}

        {phase === "credentials" && (
          <div className="vnc-overlay">
            <CredentialsCard
              fields={state.credFields}
              initialPassword={password}
              onSubmit={session.sendCredentials}
              onCancel={disconnect}
            />
          </div>
        )}

        {phase === "verify" && state.fingerprint && (
          <div className="vnc-overlay">
            <VerifyCard fingerprint={state.fingerprint} onApprove={session.approveServer} onCancel={disconnect} />
          </div>
        )}

        {pasteOpen && phase === "connected" && (
          <div className="vnc-paste" data-testid="vnc-paste-box">
            <textarea
              autoFocus
              placeholder="Paste text, then Send"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              data-testid="vnc-paste-input"
            />
            <div className="vnc-actions">
              <Button label="Cancel" variant="ghost" size="sm" onClick={() => setPasteOpen(false)} />
              <Button
                label="Send"
                variant="primary"
                size="sm"
                isDisabled={!pasteText}
                onClick={sendPaste}
                data-testid="vnc-paste-send"
              />
            </div>
          </div>
        )}
      </div>

      {notice && live && (
        <div className="vnc-notice" role="status" data-testid="vnc-notice">
          {notice}
        </div>
      )}

      {live && (
        <VncToolbar
          title={title}
          connected={phase === "connected"}
          viewOnly={session.viewOnly}
          scale={session.scale}
          fullscreen={fullscreen}
          hasRemoteClipboard={state.remoteClipboard != null}
          onViewOnly={session.setViewOnly}
          onScale={session.setScale}
          onFullscreen={() => void toggleFullscreen()}
          onCtrlAltDel={session.sendCtrlAltDel}
          onPaste={() => setPasteOpen((o) => !o)}
          onCopyRemote={() => void copyRemote()}
          onDisconnect={disconnect}
        />
      )}
    </div>
  )
}
