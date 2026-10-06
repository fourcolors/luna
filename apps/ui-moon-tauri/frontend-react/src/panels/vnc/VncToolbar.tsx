/**
 * VncToolbar.tsx - the footer while a session is live: who you're looking
 * at, the view controls, and Disconnect. Clipboard moves only on a click:
 * "Paste" sends this Mac's clipboard text to the remote; when the remote
 * copies something, a "Copy remote clipboard" button appears. Nothing ever
 * overwrites the local clipboard on its own.
 */
import { Button } from "../../astryx-kit"
import type { ScaleMode } from "./useVncSession"

export interface VncToolbarProps {
  title: string
  connected: boolean
  viewOnly: boolean
  scale: ScaleMode
  fullscreen: boolean
  hasRemoteClipboard: boolean
  onViewOnly: (on: boolean) => void
  onScale: (mode: ScaleMode) => void
  onFullscreen: () => void
  onCtrlAltDel: () => void
  onPaste: () => void
  onCopyRemote: () => void
  onDisconnect: () => void
}

export function VncToolbar(p: VncToolbarProps) {
  return (
    <div className="vnc-footer" role="toolbar" aria-label="Screen Share controls">
      <span className="vnc-footer-name" data-testid="vnc-status-line" title={p.title}>
        {p.title}
      </span>
      {p.connected && (
        <div className="vnc-tools">
          <Button
            label={p.viewOnly ? "View only: on" : "View only: off"}
            variant="ghost"
            size="sm"
            onClick={() => p.onViewOnly(!p.viewOnly)}
            data-testid="vnc-viewonly-btn"
          />
          <Button
            label={p.scale === "fit" ? "Fit to window" : "Actual size"}
            variant="ghost"
            size="sm"
            onClick={() => p.onScale(p.scale === "fit" ? "actual" : "fit")}
            data-testid="vnc-scale-btn"
          />
          <Button label={p.fullscreen ? "Exit full screen" : "Full screen"} variant="ghost" size="sm" onClick={p.onFullscreen} data-testid="vnc-fullscreen-btn" />
          {!p.viewOnly && (
            <>
              <Button label="Ctrl+Alt+Del" variant="ghost" size="sm" onClick={p.onCtrlAltDel} data-testid="vnc-cad-btn" />
              <Button label="Paste" variant="ghost" size="sm" onClick={p.onPaste} data-testid="vnc-paste-btn" />
            </>
          )}
          {p.hasRemoteClipboard && (
            <Button label="Copy remote clipboard" variant="ghost" size="sm" onClick={p.onCopyRemote} data-testid="vnc-copy-remote-btn" />
          )}
        </div>
      )}
      <Button label="Disconnect" variant="ghost" size="sm" onClick={p.onDisconnect} data-testid="vnc-disconnect-btn" />
    </div>
  )
}
