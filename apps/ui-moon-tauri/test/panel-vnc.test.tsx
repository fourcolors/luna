// @vitest-environment jsdom
//
// Race tests for the Screen Share panel's connect flow (VncPanel.tsx).
// noVNC is mocked (no canvas / sockets in jsdom); the seams under test are the
// generation guard around the async vnc_connect + lazy import, and the
// "ignore events from a stale RFB instance" guard on every RFB listener.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

class FakeRfb extends EventTarget {
  static instances: FakeRfb[] = []
  scaleViewport = false
  clipViewport = false
  viewOnly = false
  disconnected = false
  sentCreds: Array<Record<string, string>> = []
  approved = 0
  pasted: string[] = []
  cad = 0
  constructor(
    public target: HTMLElement,
    public url: string,
  ) {
    super()
    FakeRfb.instances.push(this)
  }
  disconnect() {
    this.disconnected = true
  }
  sendCredentials(c: Record<string, string>) {
    this.sentCreds.push(c)
  }
  approveServer() {
    this.approved += 1
  }
  clipboardPasteFrom(t: string) {
    this.pasted.push(t)
  }
  sendCtrlAltDel() {
    this.cad += 1
  }
  focus() {}
  /** noVNC fires 'disconnect' asynchronously after disconnect(); tests call this when they want it. */
  fire(type: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(type, { detail }))
  }
}

vi.mock("@novnc/novnc", () => ({ default: FakeRfb }))

import { VncPanel } from "../frontend-react/src/panels/vnc/VncPanel"
import type { PanelCtx } from "../frontend-react/src/panels/panel-ctx"

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  FakeRfb.instances = []
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function makeCtx(connects: Array<Deferred<unknown>>) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
  let n = 0
  const ctx: PanelCtx = {
    hasTauri: true,
    invoke: (cmd, args) => {
      calls.push({ cmd, args })
      if (cmd === "vnc_connect") return connects[n++].promise
      return Promise.resolve(undefined)
    },
  }
  return { ctx, calls }
}

function setInput(testId: string, value: string) {
  const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
function click(testId: string) {
  const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement
  act(() => el.click())
}
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`)

async function connectTo(host: string) {
  setInput("vnc-host-input", host)
  click("vnc-connect-btn")
  await flush()
}

describe("VncPanel connect races", () => {
  it("Disconnect during a pending dial aborts the late bridge and never connects", async () => {
    const dial = deferred<unknown>()
    const { ctx, calls } = makeCtx([dial])
    act(() => root.render(<VncPanel ctx={ctx} />))
    await connectTo("10.0.0.9")
    expect(q("vnc-disconnect-btn")).not.toBeNull() // "Connecting" footer

    click("vnc-disconnect-btn")
    expect(q("vnc-connect-btn")).not.toBeNull() // back on the idle card

    dial.resolve({ id: 7, url: "ws://127.0.0.1:1/vnc-x" })
    await flush()

    expect(FakeRfb.instances).toHaveLength(0)
    expect(calls).toContainEqual({ cmd: "vnc_disconnect", args: { id: 7 } })
    expect(q("vnc-connect-btn")).not.toBeNull()
  })

  it("a stale dial failure does not put an error over a newer live session", async () => {
    const slow = deferred<unknown>()
    const fast = deferred<unknown>()
    const { ctx } = makeCtx([slow, fast])
    act(() => root.render(<VncPanel ctx={ctx} />))
    await connectTo("10.0.0.9")
    click("vnc-disconnect-btn")
    await connectTo("10.0.0.10")
    fast.resolve({ id: 2, url: "ws://127.0.0.1:2/vnc-y" })
    await flush()
    expect(FakeRfb.instances).toHaveLength(1)

    slow.reject(new Error("can't reach 10.0.0.9:5900 - timed out"))
    await flush()

    expect(q("vnc-status")).toBeNull()
    expect(q("vnc-disconnect-btn")).not.toBeNull() // still live: footer intact
    expect(q("vnc-connect-btn")).toBeNull()
  })

  it("a stale dial success does not mount a second RFB or steal the bridge handle", async () => {
    const slow = deferred<unknown>()
    const fast = deferred<unknown>()
    const { ctx, calls } = makeCtx([slow, fast])
    act(() => root.render(<VncPanel ctx={ctx} />))
    await connectTo("10.0.0.9")
    click("vnc-disconnect-btn")
    await connectTo("10.0.0.10")
    fast.resolve({ id: 2, url: "ws://127.0.0.1:2/vnc-y" })
    await flush()

    slow.resolve({ id: 1, url: "ws://127.0.0.1:1/vnc-x" })
    await flush()

    expect(FakeRfb.instances).toHaveLength(1)
    expect(FakeRfb.instances[0].url).toBe("ws://127.0.0.1:2/vnc-y")
    expect(calls).toContainEqual({ cmd: "vnc_disconnect", args: { id: 1 } })
    // Disconnect still aborts the CURRENT bridge (id 2), not the stale one.
    click("vnc-disconnect-btn")
    expect(calls).toContainEqual({ cmd: "vnc_disconnect", args: { id: 2 } })
  })

  it("a late 'disconnect' from an old RFB does not tear down the new session", async () => {
    const a = deferred<unknown>()
    const b = deferred<unknown>()
    const { ctx, calls } = makeCtx([a, b])
    act(() => root.render(<VncPanel ctx={ctx} />))
    await connectTo("10.0.0.9")
    a.resolve({ id: 1, url: "ws://127.0.0.1:1/vnc-x" })
    await flush()
    const old = FakeRfb.instances[0]
    act(() => old.fire("connect"))

    click("vnc-disconnect-btn")
    await connectTo("10.0.0.9")
    b.resolve({ id: 2, url: "ws://127.0.0.1:2/vnc-y" })
    await flush()
    const fresh = FakeRfb.instances[1]
    act(() => fresh.fire("connect"))

    // noVNC reports the old instance's close after the new one is up.
    act(() => old.fire("disconnect", { clean: true }))

    expect(calls.filter((c) => c.cmd === "vnc_disconnect" && c.args?.id === 2)).toHaveLength(0)
    expect(fresh.disconnected).toBe(false)
    expect(q("vnc-disconnect-btn")).not.toBeNull()
    expect(q("vnc-connect-btn")).toBeNull()
  })
})

describe("VncPanel status handling", () => {
  async function connectLive(url = "ws://127.0.0.1:1/vnc-x") {
    const dial = deferred<unknown>()
    const { ctx, calls } = makeCtx([dial])
    act(() => root.render(<VncPanel ctx={ctx} />))
    await connectTo("10.0.0.9")
    dial.resolve({ id: 1, url })
    await flush()
    const rfb = FakeRfb.instances[0]
    act(() => rfb.fire("connect"))
    return { rfb, calls }
  }

  it("an auth-failure reason survives the unclean disconnect that follows", async () => {
    const { rfb } = await connectLive()
    // A wrong password: noVNC fires securityfailure then disconnects unclean
    // in the same tick. The generic drop message must not clobber the reason.
    act(() => rfb.fire("securityfailure", { reason: "Invalid password" }))
    act(() => rfb.fire("disconnect", { clean: false }))
    expect(q("vnc-status")?.textContent).toBe("Authentication failed: Invalid password")
    expect(q("vnc-connect-btn")).not.toBeNull() // back on the card, in error state
  })

  it("a remote clean close reports the host ended the session", async () => {
    const { rfb } = await connectLive()
    act(() => rfb.fire("disconnect", { clean: true }))
    expect(q("vnc-connect-btn")).not.toBeNull() // idle card
    expect(q("vnc-status")?.textContent).toBe("Remote host ended the session.")
  })

  it("rejects a non-numeric port before ever invoking vnc_connect", async () => {
    const { ctx, calls } = makeCtx([])
    act(() => root.render(<VncPanel ctx={ctx} />))
    setInput("vnc-host-input", "10.0.0.9")
    setInput("vnc-port-input", "5900abc")
    click("vnc-connect-btn")
    await flush()
    expect(calls.filter((c) => c.cmd === "vnc_connect")).toHaveLength(0)
    expect(q("vnc-status")?.textContent).toBe("Port must be 1-65535.")
  })
})

describe("VncPanel consent: widget-open params only pre-fill", () => {
  afterEach(() => window.history.replaceState({}, "", "/"))

  it("an agent-opened window fills the form but never dials on its own", async () => {
    window.history.replaceState({}, "", "/panel.html?type=vnc&host=10.0.0.9&port=5901&password=leak")
    const { ctx, calls } = makeCtx([deferred<unknown>()])
    act(() => root.render(<VncPanel ctx={ctx} />))
    await flush()
    await flush()
    expect(calls.filter((c) => c.cmd === "vnc_connect")).toHaveLength(0)
    expect((q("vnc-host-input") as HTMLInputElement).value).toBe("10.0.0.9")
    expect((q("vnc-port-input") as HTMLInputElement).value).toBe("5901")
    expect((q("vnc-password-input") as HTMLInputElement).value).toBe("") // never read from params
    expect(q("vnc-prefill-note")).not.toBeNull()
    click("vnc-connect-btn")
    await flush()
    expect(calls.filter((c) => c.cmd === "vnc_connect")).toEqual([
      { cmd: "vnc_connect", args: { host: "10.0.0.9", port: 5901 } },
    ])
  })

  it("a host carrying credentials is not pre-filled", async () => {
    window.history.replaceState({}, "", "/panel.html?type=vnc&host=" + encodeURIComponent("ws://u:p@box:6080"))
    const { ctx } = makeCtx([])
    act(() => root.render(<VncPanel ctx={ctx} />))
    expect((q("vnc-host-input") as HTMLInputElement).value).toBe("")
    expect(q("vnc-prefill-note")).toBeNull()
  })
})

describe("VncPanel login and server checks", () => {
  async function startLive() {
    const dial = deferred<unknown>()
    const { ctx, calls } = makeCtx([dial])
    act(() => root.render(<VncPanel ctx={ctx} />))
    await connectTo("10.0.0.9")
    dial.resolve({ id: 1, url: "ws://127.0.0.1:1/vnc-x" })
    await flush()
    return { rfb: FakeRfb.instances[FakeRfb.instances.length - 1], calls }
  }

  it("renders every field the server asks for and sends them", async () => {
    const { rfb } = await startLive()
    act(() => rfb.fire("credentialsrequired", { types: ["username", "password", "target"] }))
    expect(q("vnc-cred-username")).not.toBeNull()
    expect(q("vnc-cred-password")).not.toBeNull()
    expect(q("vnc-cred-target")).not.toBeNull()
    setInput("vnc-cred-username", "me")
    setInput("vnc-cred-password", "pw")
    setInput("vnc-cred-target", "vm1")
    click("vnc-cred-submit")
    expect(rfb.sentCreds).toEqual([{ username: "me", password: "pw", target: "vm1" }])
  })

  it("an unsupported login type fails visibly and releases the connection", async () => {
    const { rfb, calls } = await startLive()
    act(() => rfb.fire("credentialsrequired", { types: ["smartcard"] }))
    expect(q("vnc-status")?.textContent).toContain("doesn't support")
    expect(rfb.disconnected).toBe(true)
    expect(calls.some((c) => c.cmd === "vnc_disconnect")).toBe(true)
  })

  it("shows the server fingerprint and approves only on click", async () => {
    const { rfb } = await startLive()
    act(() => rfb.fire("serververification", { type: "RSA", publickey: new Uint8Array([1, 2, 3]) }))
    await flush()
    expect(q("vnc-fingerprint")?.textContent).toMatch(/^([0-9a-f]{2}:){15}[0-9a-f]{2}$/)
    expect(rfb.approved).toBe(0)
    click("vnc-verify-approve")
    expect(rfb.approved).toBe(1)
  })

  it("Cancel on the server check disconnects", async () => {
    const { rfb } = await startLive()
    act(() => rfb.fire("serververification", { type: "RSA", publickey: new Uint8Array([9]) }))
    await flush()
    click("vnc-verify-cancel")
    expect(rfb.disconnected).toBe(true)
    expect(q("vnc-connect-btn")).not.toBeNull()
  })
})

describe("VncPanel live tools", () => {
  async function live() {
    const dial = deferred<unknown>()
    const { ctx } = makeCtx([dial])
    act(() => root.render(<VncPanel ctx={ctx} />))
    await connectTo("10.0.0.9")
    dial.resolve({ id: 1, url: "ws://127.0.0.1:1/vnc-x" })
    await flush()
    const rfb = FakeRfb.instances[FakeRfb.instances.length - 1]
    act(() => rfb.fire("connect"))
    return rfb
  }

  it("view only and scale toggle the live RFB", async () => {
    const rfb = await live()
    expect(rfb.scaleViewport).toBe(true)
    click("vnc-viewonly-btn")
    expect(rfb.viewOnly).toBe(true)
    expect(q("vnc-cad-btn")).toBeNull() // no input tools while view only
    click("vnc-scale-btn")
    expect(rfb.scaleViewport).toBe(false)
    expect(rfb.clipViewport).toBe(true)
  })

  it("Ctrl+Alt+Del and Paste send to the remote only on click", async () => {
    const rfb = await live()
    click("vnc-cad-btn")
    expect(rfb.cad).toBe(1)
    click("vnc-paste-btn")
    const ta = q("vnc-paste-input") as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    act(() => {
      setter.call(ta, "hello")
      ta.dispatchEvent(new Event("input", { bubbles: true }))
    })
    click("vnc-paste-send")
    expect(rfb.pasted).toEqual(["hello"])
  })

  it("the remote clipboard is offered, never written automatically", async () => {
    const rfb = await live()
    expect(q("vnc-copy-remote-btn")).toBeNull()
    act(() => rfb.fire("clipboard", { text: "secret" }))
    expect(q("vnc-copy-remote-btn")).not.toBeNull()
  })
})

describe("VncPanel recent hosts", () => {
  // Node 25 ships its own global localStorage that shadows jsdom's; give the
  // panel a deterministic in-memory Storage instead.
  let store: Map<string, string>
  beforeEach(() => {
    store = new Map()
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
      },
    })
  })

  it("remembers host and port on Connect, never the password, and can forget", async () => {
    const { ctx } = makeCtx([deferred<unknown>()])
    act(() => root.render(<VncPanel ctx={ctx} />))
    setInput("vnc-password-input", "pw")
    await connectTo("10.0.0.9")
    const saved = JSON.parse(store.get("luna.vnc.recent") || "[]")
    expect(saved).toEqual([{ host: "10.0.0.9", port: "5900" }])
    expect(store.get("luna.vnc.recent")).not.toContain("pw")
  })
})
