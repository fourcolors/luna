/**
 * @vitest-environment jsdom
 *
 * Proves panel-chat connect() / wire.boot() is independent of composer chrome
 * wiring. Live 0.0.71 evidence: MoonBar.init ran ("waking up…") but wire.boot
 * never did — a throw in #563 attach-menu wiring aborted sync bootChat()
 * before ignition. Chrome bugs must not skip the socket.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { flushSync } from "react-dom"
import { bootChat } from "../frontend-react/src/chat/bootChat"
import * as wiring from "../frontend-react/src/chat/wiring"
import {
  mountChatDomFromHtml,
  loadVendorInto,
} from "./helpers/chat-harness"

const htmlContent = fs.readFileSync(
  path.resolve(__dirname, "../frontend-react/chat.html"),
  "utf8",
)

function prepareDom(mutate?: (doc: Document) => void): void {
  mountChatDomFromHtml(htmlContent)
  document.body.querySelectorAll("script").forEach((s) => s.remove())

  ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = {
    core: { invoke: vi.fn(async () => null) },
    window: {
      getCurrentWindow: () => ({
        label: "panel-chat",
        listen: vi.fn(async () => () => {}),
        startDragging: vi.fn(async () => {}),
      }),
      Window: { getByLabel: vi.fn(async () => null) },
    },
    event: { listen: vi.fn(async () => () => {}) },
  }

  loadVendorInto(window, "moon-protocol.js")
  loadVendorInto(window, "moon-ws.js")
  loadVendorInto(window, "moon-markdown.js")
  loadVendorInto(window, "moon-dock.js")
  loadVendorInto(window, "pool-engine.js")
  loadVendorInto(window, "thread-drag-session.js")

  localStorage.clear()
  vi.stubGlobal(
    "WebSocket",
    class {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = 0
      url: string
      onopen: unknown = null
      onclose: unknown = null
      onerror: unknown = null
      onmessage: unknown = null
      constructor(url: string) {
        this.url = url
      }
      send() {}
      close() {
        this.readyState = 3
      }
      addEventListener() {}
      removeEventListener() {}
    },
  )

  mutate?.(document)
}

describe("boot ignition isolation from composer chrome", () => {
  beforeEach(() => {
    prepareDom()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ""
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
    delete (window as unknown as { __MoonInternals?: unknown }).__MoonInternals
    delete (window as unknown as { LunaChatHost?: unknown }).LunaChatHost
    delete (window as unknown as { loadConnectionAndConnect?: unknown }).loadConnectionAndConnect
    delete (window as unknown as { WebSocketEngine?: unknown }).WebSocketEngine
    delete (window as unknown as { PoolEngine?: unknown }).PoolEngine
    delete (window as unknown as { ViewMode?: unknown }).ViewMode
    delete (window as unknown as { LunaProtocol?: unknown }).LunaProtocol
    delete (window as unknown as { LunaWS?: unknown }).LunaWS
    delete (window as unknown as { LunaMarkdown?: unknown }).LunaMarkdown
    delete (window as unknown as { LunaDock?: unknown }).LunaDock
  })

  it("missing attach/scope/mic nodes cannot prevent connect()", () => {
    prepareDom((doc) => {
      for (const id of [
        "attach-plus-btn",
        "attach-menu",
        "attach-menu-attachment",
        "attach-btn",
        "scope-btn",
        "voice-mic-btn",
        "file-input",
      ]) {
        doc.getElementById(id)?.remove()
      }
    })

    let boot!: ReturnType<typeof bootChat>
    expect(() => {
      flushSync(() => {
        boot = bootChat()
      })
    }).not.toThrow()

    // wire.boot() / loadConnectionAndConnect ran (bridged after createWire)
    expect(typeof (window as unknown as { loadConnectionAndConnect?: unknown }).loadConnectionAndConnect).toBe(
      "function",
    )
    expect(boot.wire).toBeTruthy()
    expect(typeof boot.wire.boot).toBe("function")
    expect((window as unknown as { WebSocketEngine?: { updateStatus?: unknown } }).WebSocketEngine?.updateStatus).toBeTypeOf(
      "function",
    )
  })

  it("a throw in attach-menu wiring still reaches wire.boot()", () => {
    prepareDom()

    const realInstall = wiring.installWiring
    const attachBoom = new Error("attach-menu wiring boom")
    vi.spyOn(wiring, "installWiring").mockImplementation((ctx) => {
      const attachPlus = ctx.DOM.attachPlusBtn
      if (attachPlus) {
        attachPlus.addEventListener = (() => {
          throw attachBoom
        }) as typeof attachPlus.addEventListener
      }
      // Must return boot params even when attach wiring throws (caught inside).
      return realInstall(ctx)
    })

    let boot!: ReturnType<typeof bootChat>
    expect(() => {
      flushSync(() => {
        boot = bootChat()
      })
    }).not.toThrow()

    expect(typeof (window as unknown as { loadConnectionAndConnect?: unknown }).loadConnectionAndConnect).toBe(
      "function",
    )
    expect(boot.wire).toBeTruthy()
    // Ignition reached: boot() was invoked during bootChat (assignBridge set).
    expect((window as unknown as { WebSocketEngine?: unknown }).WebSocketEngine).toBeTruthy()
  })

  it("happy path still wires attach + menu (no mic/scope chrome)", () => {
    prepareDom()
    flushSync(() => {
      bootChat()
    })
    expect(document.getElementById("voice-mic-btn")).toBeNull()
    expect(document.getElementById("scope-btn")).toBeNull()
    expect(document.getElementById("attach-plus-btn")).toBeTruthy()
    expect(document.getElementById("attach-menu")).toBeTruthy()
    expect(document.getElementById("attach-menu-attachment")).toBeTruthy()
  })
})
