/**
 * vncModel.ts - the pure half of Screen Share: input parsing, the session
 * state machine, and the recent-hosts list. No React, no noVNC, no Tauri,
 * so every rule here is unit-tested directly.
 */

/** `ws://` / `wss://` endpoints (websockify, novnc_proxy) skip the bridge. */
export const WS_URL_RE = /^wss?:\/\//i

/**
 * Strict port parse: digits only, 1-65535. parseInt would silently accept
 * "5900abc" or "1e3", and a mistyped port must error, not connect elsewhere.
 */
export function parsePort(portStr: string): number | null {
  const s = portStr.trim()
  if (!/^\d+$/.test(s)) return null
  const p = Number(s)
  return p > 0 && p <= 65535 ? p : null
}

/**
 * A host that is safe to show, store, or pre-fill: no credentials (`@`), no
 * query or fragment (a websockify `?token=` is a secret too), no whitespace
 * or control characters. Mirrors the Rust-side allowlist in
 * windows.rs `sanitize_widget_params`.
 */
export function isPlainHost(host: string): boolean {
  const h = host.trim()
  return h.length > 0 && h.length <= 255 && !/[@?#\s\p{Cc}]/u.test(h)
}

/**
 * Widget-open params pre-fill the form only. They NEVER connect on their own:
 * the operator clicks Connect. `fromParams` lets the card say who filled it.
 */
export function readOpenParams(search: string): { host: string; port: string; fromParams: boolean } {
  const q = new URLSearchParams(search)
  const host = q.get("host") ?? ""
  const port = q.get("port") ?? ""
  const okHost = isPlainHost(host)
  const okPort = parsePort(port) != null
  return {
    host: okHost ? host.trim() : "",
    port: okPort ? port.trim() : "5900",
    fromParams: okHost,
  }
}

// ── session state machine ────────────────────────────────────────────────

/** What the server asked for in `credentialsrequired`. */
export type CredField = "username" | "password" | "target"

export type Phase =
  | "idle" //        connect card
  | "connecting" //  dialing / RFB handshake
  | "credentials" // server asked for a login (CredField list)
  | "verify" //      RA2: confirm the server's key fingerprint
  | "connected" //   screen is live
  | "error" //       connect card, with the error shown

export interface SessionState {
  phase: Phase
  /** Message under the connect card (error or "host ended the session"). */
  status: string | null
  credFields: CredField[]
  /** Server key fingerprint shown in the verify card. */
  fingerprint: string | null
  desktopName: string
  /** Last text the remote put on ITS clipboard; copied only on click. */
  remoteClipboard: string | null
}

export const initialSession: SessionState = {
  phase: "idle",
  status: null,
  credFields: [],
  fingerprint: null,
  desktopName: "",
  remoteClipboard: null,
}

export type SessionEvent =
  | { type: "start" }
  | { type: "fail"; message: string }
  | { type: "connected" }
  | { type: "credentials"; fields: CredField[] }
  | { type: "credentialsSent" }
  | { type: "verify"; fingerprint: string }
  | { type: "verified" }
  | { type: "securityFailure"; reason?: string }
  | { type: "disconnected"; clean: boolean }
  | { type: "desktopName"; name: string }
  | { type: "remoteClipboard"; text: string }
  | { type: "clipboardTaken" }
  | { type: "reset" }

const KNOWN_FIELDS: ReadonlyArray<CredField> = ["username", "password", "target"]

/** Keep only fields we can render; an unknown request is surfaced as an error. */
export function toCredFields(types: ReadonlyArray<string>): CredField[] | null {
  const fields = types.filter((t): t is CredField => (KNOWN_FIELDS as string[]).includes(t))
  return fields.length === types.length && fields.length > 0 ? fields : null
}

export function sessionReducer(s: SessionState, e: SessionEvent): SessionState {
  switch (e.type) {
    case "start":
      return { ...initialSession, phase: "connecting" }
    case "fail":
      return { ...initialSession, phase: "error", status: e.message }
    case "connected":
      return { ...s, phase: "connected", credFields: [], fingerprint: null }
    case "credentials":
      return { ...s, phase: "credentials", credFields: e.fields }
    case "credentialsSent":
      return { ...s, phase: "connecting", credFields: [] }
    case "verify":
      return { ...s, phase: "verify", fingerprint: e.fingerprint }
    case "verified":
      return { ...s, phase: "connecting", fingerprint: null }
    case "securityFailure":
      // The disconnect that follows must not overwrite this reason.
      return { ...s, status: e.reason ? `Authentication failed: ${e.reason}` : "Authentication failed" }
    case "disconnected":
      if (s.phase === "idle") return s // our own Disconnect already reset
      return {
        ...initialSession,
        phase: e.clean ? "idle" : "error",
        status: s.status ?? (e.clean ? "Remote host ended the session." : "Connection lost."),
      }
    case "desktopName":
      return { ...s, desktopName: e.name }
    case "remoteClipboard":
      return { ...s, remoteClipboard: e.text }
    case "clipboardTaken":
      return { ...s, remoteClipboard: null }
    case "reset":
      return initialSession
  }
}

// ── recent hosts ─────────────────────────────────────────────────────────

export interface RecentHost {
  host: string
  port: string
}

export const RECENT_KEY = "luna.vnc.recent"
export const RECENT_MAX = 5

/** Host + port only. Never a password; a host with credentials is refused. */
export function loadRecent(storage: Pick<Storage, "getItem"> | null): RecentHost[] {
  try {
    const raw = storage?.getItem(RECENT_KEY)
    const arr = raw ? JSON.parse(raw) : []
    if (!Array.isArray(arr)) return []
    return arr
      .filter((r) => r && typeof r.host === "string" && typeof r.port === "string")
      .filter((r) => isPlainHost(r.host))
      .slice(0, RECENT_MAX)
      .map((r) => ({ host: r.host, port: r.port }))
  } catch {
    return []
  }
}

export function rememberRecent(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  entry: RecentHost,
): RecentHost[] {
  if (!isPlainHost(entry.host)) return loadRecent(storage)
  const next = [entry, ...loadRecent(storage).filter((r) => !(r.host === entry.host && r.port === entry.port))]
    .slice(0, RECENT_MAX)
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* private mode / quota: the list is a convenience */
  }
  return next
}

export function forgetRecent(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  entry: RecentHost,
): RecentHost[] {
  const next = loadRecent(storage).filter((r) => !(r.host === entry.host && r.port === entry.port))
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  return next
}

/** Short, readable SHA-256 fingerprint ("ab:cd:..." of the first 16 bytes). */
export async function fingerprintOf(key: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer: subtle.digest wants a plain BufferSource.
  const bytes = new Uint8Array(key.byteLength)
  bytes.set(key)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer))
  return Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join(":")
}
