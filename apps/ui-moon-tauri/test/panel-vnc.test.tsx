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
  disconnected = false
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
  sendCredentials() {}
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
