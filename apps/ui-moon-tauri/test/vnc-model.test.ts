// Pure rules behind Screen Share (frontend-react/src/panels/vnc/vncModel.ts).
import { describe, expect, it } from "vitest"
import {
  fingerprintOf,
  initialSession,
  isPlainHost,
  loadRecent,
  parsePort,
  readOpenParams,
  rememberRecent,
  RECENT_MAX,
  sessionReducer,
  toCredFields,
} from "../frontend-react/src/panels/vnc/vncModel"

const mem = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe("vncModel", () => {
  it("parsePort is strict", () => {
    expect(parsePort("5900")).toBe(5900)
    expect(parsePort(" 5901 ")).toBe(5901)
    for (const bad of ["", "0", "65536", "5900abc", "1e3", "59.0", "-1"]) expect(parsePort(bad)).toBeNull()
  })

  it("isPlainHost refuses credentials and junk", () => {
    expect(isPlainHost("10.0.0.9")).toBe(true)
    expect(isPlainHost("fe80::1")).toBe(true)
    // A URL is never "plain": its path or query can be a bearer secret.
    for (const bad of ["", "me@box", "ws://u:p@box", "a b", "x\u0000y", "wss://box/ws?token=t", "ws://box:6080/websockify", "wss://box/vnc/SECRET"])
      expect(isPlainHost(bad)).toBe(false)
  })

  it("readOpenParams pre-fills only a plain host and a valid port", () => {
    expect(readOpenParams("?host=10.0.0.9&port=5901&password=x")).toEqual({ host: "10.0.0.9", port: "5901", fromParams: true })
    expect(readOpenParams("?host=me%40box&port=99999")).toEqual({ host: "", port: "5900", fromParams: false })
    expect(readOpenParams("")).toEqual({ host: "", port: "5900", fromParams: false })
  })

  it("toCredFields accepts known fields only", () => {
    expect(toCredFields(["username", "password"])).toEqual(["username", "password"])
    expect(toCredFields(["password", "smartcard"])).toBeNull()
    expect(toCredFields([])).toBeNull()
  })

  it("a security-failure reason survives the disconnect that follows", () => {
    let s = sessionReducer(initialSession, { type: "start" })
    s = sessionReducer(s, { type: "securityFailure", reason: "Invalid password" })
    s = sessionReducer(s, { type: "disconnected", clean: false })
    expect(s).toMatchObject({ phase: "error", status: "Authentication failed: Invalid password" })
  })

  it("a disconnect after our own reset is ignored", () => {
    expect(sessionReducer(initialSession, { type: "disconnected", clean: false })).toBe(initialSession)
  })

  it("recent hosts: newest first, de-duplicated, capped, never with credentials", () => {
    const st = mem()
    for (let i = 0; i < RECENT_MAX + 2; i++) rememberRecent(st, { host: `10.0.0.${i}`, port: "5900" })
    rememberRecent(st, { host: "10.0.0.3", port: "5900" })
    const list = loadRecent(st)
    expect(list).toHaveLength(RECENT_MAX)
    expect(list[0]).toEqual({ host: "10.0.0.3", port: "5900" })
    expect(new Set(list.map((r) => r.host)).size).toBe(list.length)
    rememberRecent(st, { host: "me@box", port: "5900" })
    rememberRecent(st, { host: "wss://box/vnc/SECRET", port: "5900" })
    rememberRecent(st, { host: "10.9.9.9", port: "59x" })
    expect(loadRecent(st).some((r) => /[@/]/.test(r.host) || r.host === "10.9.9.9")).toBe(false)
  })

  it("loadRecent scrubs entries written by an older build", () => {
    const st = mem()
    st.setItem("luna.vnc.recent", JSON.stringify([{ host: "ws://box/secret", port: "5900" }, { host: "10.0.0.1", port: "5900" }]))
    expect(loadRecent(st)).toEqual([{ host: "10.0.0.1", port: "5900" }])
    // Removed from storage, not just hidden.
    expect(st.getItem("luna.vnc.recent")).not.toContain("secret")
  })

  it("fingerprintOf matches the RealVNC / noVNC format (SHA-1, 8 bytes, hyphens)", async () => {
    // SHA-1("abc") starts a9 99 3e 36 47 06 81 6a (FIPS 180 test vector)
    const fp = await fingerprintOf(new TextEncoder().encode("abc"))
    expect(fp).toBe("a9-99-3e-36-47-06-81-6a")
  })

  it("clipboardTaken clears only the text that was copied", () => {
    let s = sessionReducer(initialSession, { type: "remoteClipboard", text: "old" })
    s = sessionReducer(s, { type: "remoteClipboard", text: "new" })
    expect(sessionReducer(s, { type: "clipboardTaken", text: "old" }).remoteClipboard).toBe("new")
    expect(sessionReducer(s, { type: "clipboardTaken", text: "new" }).remoteClipboard).toBeNull()
  })
})
