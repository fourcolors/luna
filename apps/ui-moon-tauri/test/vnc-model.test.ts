// Pure rules behind Screen Share (frontend-react/src/panels/vnc/vncModel.ts).
import { describe, expect, it } from "vitest"
import {
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
    expect(isPlainHost("ws://box:6080/websockify")).toBe(true)
    for (const bad of ["", "me@box", "ws://u:p@box", "a b", "x\u0000y", "wss://box/ws?token=t"]) expect(isPlainHost(bad)).toBe(false)
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
    expect(loadRecent(st).some((r) => r.host.includes("@"))).toBe(false)
  })
})
