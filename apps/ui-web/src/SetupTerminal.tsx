/**
 * SetupTerminal — renders an xterm.js terminal when the server is in
 * setup-mode (capabilities.setup === true).
 *
 * The operator sees `claude setup-token` output here, types the auth code,
 * and completes login. The server then restarts into normal chat-mode; the
 * client reconnects and the terminal unmounts automatically (setupMode → false).
 *
 * byte-accurate base64:
 *   b64ToBytes: base64 → Uint8Array (safe: each decoded char is 0-255)
 *   bytesToB64:  Uint8Array → base64 (via single-byte string, avoids btoa UTF-8 trap)
 *   strToB64:   UTF-8 string → base64 (TextEncoder first, then bytesToB64)
 *
 * Exported so App.tsx's onFrame can decode pty-output without duplication.
 */
import { onCleanup, onMount } from "solid-js"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"

// ── base64 helpers ────────────────────────────────────────────────────────────

/** base64 → raw bytes. Safe because each atob output char is in [0, 255]. */
export const b64ToBytes = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

/** Uint8Array → base64 via Latin1 passthrough (not btoa-on-string). */
const bytesToB64 = (bytes: Uint8Array): string => {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/** UTF-8 string → base64 (TextEncoder → bytes → base64). */
const strToB64 = (s: string): string =>
  bytesToB64(new TextEncoder().encode(s))

// ── component ─────────────────────────────────────────────────────────────────

export interface SetupTerminalProps {
  send: (frame:
    | { type: "pty-input"; data: string }
    | { type: "pty-resize"; cols: number; rows: number }
  ) => void
  registerWrite: (fn: ((bytes: Uint8Array) => void) | null) => void
}

export const SetupTerminal = (props: SetupTerminalProps) => {
  let host!: HTMLDivElement

  onMount(() => {
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"SF Mono", Menlo, "JetBrains Mono", "Fira Code", monospace',
      theme: {
        background: "#0a0b0e",
        foreground: "#e6e6e6",
        cursor: "#e6e6e6",
        black: "#0c0d10",
        brightBlack: "#555",
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    // Focus so the operator can paste the auth code without clicking first.
    term.focus()

    // Register this terminal as the live pty-output receiver.
    props.registerWrite((bytes) => term.write(bytes))

    // Send keystrokes to the server as UTF-8 → base64.
    const dataDisp = term.onData((d) =>
      props.send({ type: "pty-input", data: strToB64(d) })
    )

    // Notify server of initial + resized dimensions.
    const sendResize = (): void => {
      fit.fit()
      props.send({ type: "pty-resize", cols: term.cols, rows: term.rows })
    }
    sendResize()

    const ro = new ResizeObserver(() => sendResize())
    ro.observe(host)

    onCleanup(() => {
      props.registerWrite(null)
      dataDisp.dispose()
      ro.disconnect()
      term.dispose()
    })
  })

  return (
    <div
      style={{
        flex: "1 1 auto",
        "min-height": "0",
        display: "flex",
        "flex-direction": "column",
        padding: "16px",
        gap: "10px",
        background: "#0c0d10",
      }}
    >
      <div style={{ "font-weight": "600", "font-size": "14px", color: "#e6e6e6" }}>
        Log in to Claude
      </div>
      <div style={{ "font-size": "12px", color: "#aaa", "line-height": "1.5" }}>
        A URL will appear in the terminal below. Open it in your browser, sign
        in to Claude, then paste the confirmation code back here.
      </div>
      <div
        ref={host}
        style={{
          flex: "1 1 auto",
          "min-height": "320px",
          background: "#0a0b0e",
          border: "1px solid #222",
          "border-radius": "4px",
          overflow: "hidden",
        }}
      />
    </div>
  )
}
