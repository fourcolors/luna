/**
 * ServerUpdateSection.tsx - the "Luna server" half of the Updates panel.
 *
 * Moon already self-updates in one click (the staged updater above). Server
 * updates are different: the control API is loopback-only by design, so a
 * remote Moon cannot trigger them, and firing a restart over the same
 * WebSocket Moon uses to report success is inherently fragile. So this
 * section checks GitHub for a newer `server-v*` release itself, compares it
 * against the connected server's version (cached from the WS hello frame),
 * and offers a one-click copy of the exact host-side update command.
 *
 * States: unknown (no cached server version) -> checking -> current |
 * available (copy button) | error (soft, never red - matches panel tone).
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Badge, Button, Card } from "../../astryx-kit"
import { getServerVersion } from "./server-version"
import { checkServerUpdate, type ServerUpdateInfo } from "./server-update-check"
import { notesLines } from "./updates-store"

type ServerPhase = "unknown" | "checking" | "current" | "available" | "error"

const PHASE_LABEL: Record<ServerPhase, string> = {
  unknown: "Not connected",
  checking: "Checking…",
  current: "Up to date",
  available: "Update available",
  error: "Couldn't check",
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard API unavailable (permissions / non-secure context) -
    // fall back to the legacy execCommand path.
    try {
      const ta = document.createElement("textarea")
      ta.value = text
      ta.style.position = "fixed"
      ta.style.opacity = "0"
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand("copy")
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

export function ServerUpdateSection() {
  const [phase, setPhase] = useState<ServerPhase>("unknown")
  const [info, setInfo] = useState<ServerUpdateInfo | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const version = getServerVersion()
    setCurrent(version)
    if (!version) {
      setPhase("unknown")
      return
    }
    setPhase("checking")
    checkServerUpdate()
      .then((result) => {
        if (cancelled) return
        if (result) {
          setInfo(result)
          setPhase("available")
        } else {
          setPhase("current")
        }
      })
      .catch(() => {
        if (!cancelled) setPhase("error")
      })
    return () => {
      cancelled = true
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    }
  }, [])

  const handleCopy = useCallback(async () => {
    if (!info) return
    const ok = await copyText(info.updateCommand)
    if (ok) {
      setCopied(true)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 2000)
    }
  }, [info])

  const lines = notesLines(info?.notes ?? null)

  return (
    <div className="upd-server">
      <div className="panel-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div className="upd-app">Luna server</div>
          <div className="panel-status">
            {current ? `Current version ${current}` : "Connect to a server to check"}
          </div>
        </div>
        <Badge role="status" variant={phase === "available" ? "success" : "info"} label={PHASE_LABEL[phase]} />
      </div>

      {phase === "available" && info && (
        <Card className="panel-row" variant="muted">
          <div className="upd-card-version">Version {info.latest}</div>
          <div className="panel-status">A newer server release is available.</div>
          {lines.length > 0 && (
            <>
              <div className="upd-notes-label">What's new</div>
              <ul className="upd-notes">
                {lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </>
          )}
          <div className="upd-notes-label">Run this on your server host</div>
          <code className="upd-cmd">{info.updateCommand}</code>
          <div style={{ marginTop: 8 }}>
            <Button
              label={copied ? "Copied!" : "Copy update command"}
              variant="primary"
              onClick={handleCopy}
            />
          </div>
        </Card>
      )}

      {phase === "error" && (
        <div className="panel-status" role="status">
          Couldn't reach GitHub to check for server updates.
        </div>
      )}
    </div>
  )
}
