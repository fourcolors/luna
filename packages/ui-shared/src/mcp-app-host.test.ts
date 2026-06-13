// @vitest-environment jsdom
/**
 * mcp-app-host tests — the CLIENT half of the MCP Apps host (Slice 4).
 *
 * Pins the JSON-RPC handshake + the trust boundary:
 *   - ui/initialize → host result (protocolVersion / host / capabilities)
 *   - ui/notifications/initialized → host pushes tool-input
 *   - tools/call → routed through transport.callTool; result + error replies
 *   - unknown request → method-not-found; unknown notification → ignored
 *   - messages whose source !== the frame's contentWindow are ignored
 *   - inline html mounts via the generated-app cage (window.mcp shim present)
 *   - dispose() stops handling
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  HOST_NAME,
  PROTOCOL_VERSION,
  host,
  isRpcNotification,
  isRpcRequest,
} from "./mcp-app-host.js"
import type { McpTransport } from "./mcp-app-host.js"

// Capture the host's window message listener so the test can drive it directly
// (jsdom MessageEvent.source plumbing is unreliable; calling the handler with a
// crafted event is deterministic).
let messageHandler: ((e: { source: unknown; data: unknown }) => void) | null = null
const realAdd = window.addEventListener.bind(window)
const realRemove = window.removeEventListener.bind(window)

const makeFrame = () => {
  const posted: unknown[] = []
  const contentWindow = { postMessage: (m: unknown) => posted.push(m) }
  const frameEl = { contentWindow, srcdoc: "" } as unknown as HTMLIFrameElement
  return { frameEl, contentWindow, posted, get srcdoc() { return (frameEl as unknown as { srcdoc: string }).srcdoc } }
}

const mountHost = (opts: {
  frameEl: HTMLIFrameElement
  uri?: string
  html?: string | null
  transport?: McpTransport
}) => {
  messageHandler = null
  const spy = vi.spyOn(window, "addEventListener").mockImplementation((type, fn) => {
    if (type === "message") messageHandler = fn as never
    else realAdd(type, fn as never)
  })
  const removeSpy = vi.spyOn(window, "removeEventListener").mockImplementation((type, fn) => {
    if (type === "message") messageHandler = null
    else realRemove(type, fn as never)
  })
  const transport: McpTransport = opts.transport ?? {
    readResource: async () => ({ ok: true, text: "<p>app</p>" }),
    callTool: async () => ({ ok: true, result: { ok: true } }),
  }
  const handle = host({
    frameEl: opts.frameEl,
    uri: opts.uri ?? "ui://luna/app/test",
    html: opts.html ?? null,
    transport,
  })
  spy.mockRestore()
  removeSpy.mockRestore()
  return handle
}

const send = (frame: ReturnType<typeof makeFrame>, data: unknown) =>
  messageHandler?.({ source: frame.contentWindow, data })

afterEach(() => {
  messageHandler = null
  vi.restoreAllMocks()
})

describe("mcp-app-host — JSON-RPC pure helpers", () => {
  it("classifies requests vs notifications vs garbage", () => {
    expect(isRpcRequest({ jsonrpc: "2.0", id: 1, method: "x" })).toBe(true)
    expect(isRpcRequest({ jsonrpc: "2.0", method: "x" })).toBe(false) // no id → notification
    expect(isRpcNotification({ jsonrpc: "2.0", method: "x" })).toBe(true)
    expect(isRpcNotification({ jsonrpc: "2.0", id: 1, method: "x" })).toBe(false)
    expect(isRpcRequest({ method: "x", id: 1 })).toBe(false) // not jsonrpc 2.0
    expect(isRpcRequest(null)).toBe(false)
  })
})

describe("mcp-app-host — host handshake + relay", () => {
  it("answers ui/initialize with protocol/host/capabilities", () => {
    const f = makeFrame()
    mountHost({ frameEl: f.frameEl, html: "<p>x</p>" })
    send(f, { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} })
    expect(f.posted).toContainEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: PROTOCOL_VERSION, host: { name: HOST_NAME }, capabilities: { serverTools: {} } },
    })
  })

  it("pushes tool-input after ui/notifications/initialized (once)", () => {
    const f = makeFrame()
    mountHost({ frameEl: f.frameEl, html: "<p>x</p>" })
    send(f, { jsonrpc: "2.0", method: "ui/notifications/initialized" })
    send(f, { jsonrpc: "2.0", method: "ui/notifications/initialized" }) // second is ignored
    const toolInputs = f.posted.filter(
      (m) => (m as { method?: string }).method === "ui/notifications/tool-input",
    )
    expect(toolInputs).toHaveLength(1)
    expect(toolInputs[0]).toEqual({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } })
  })

  it("routes tools/call through the transport and replies with the result", async () => {
    const f = makeFrame()
    const calls: Array<{ tool: string; args: unknown }> = []
    mountHost({
      frameEl: f.frameEl,
      html: "<p>x</p>",
      transport: {
        readResource: async () => ({ ok: true, text: "" }),
        callTool: async (tool, args) => {
          calls.push({ tool, args })
          return { ok: true, result: { value: 42 } }
        },
      },
    })
    send(f, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "pulse", arguments: { a: 1 } } })
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual([{ tool: "pulse", args: { a: 1 } }])
    expect(f.posted).toContainEqual({ jsonrpc: "2.0", id: 7, result: { value: 42 } })
  })

  it("replies JSON-RPC error when a tool call fails", async () => {
    const f = makeFrame()
    mountHost({
      frameEl: f.frameEl,
      html: "<p>x</p>",
      transport: {
        readResource: async () => ({ ok: true, text: "" }),
        callTool: async () => ({ ok: false, message: "nope" }),
      },
    })
    send(f, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "bad" } })
    await Promise.resolve()
    await Promise.resolve()
    expect(f.posted).toContainEqual({ jsonrpc: "2.0", id: 8, error: { code: -32000, message: "nope" } })
  })

  it("replies method-not-found for an unknown request; ignores unknown notifications", () => {
    const f = makeFrame()
    mountHost({ frameEl: f.frameEl, html: "<p>x</p>" })
    send(f, { jsonrpc: "2.0", id: 9, method: "wat" })
    send(f, { jsonrpc: "2.0", method: "some/notification" }) // ignored, no reply
    expect(f.posted).toContainEqual({ jsonrpc: "2.0", id: 9, error: { code: -32601, message: "method not found: wat" } })
    expect(f.posted).toHaveLength(1)
  })

  it("ignores messages whose source is NOT the frame's contentWindow (trust boundary)", () => {
    const f = makeFrame()
    mountHost({ frameEl: f.frameEl, html: "<p>x</p>" })
    messageHandler?.({ source: { postMessage() {} }, data: { jsonrpc: "2.0", id: 1, method: "ui/initialize" } })
    expect(f.posted).toHaveLength(0)
  })

  it("mounts inline html in the generated-app cage (window.mcp shim + content)", () => {
    const f = makeFrame()
    mountHost({ frameEl: f.frameEl, html: "<h1>my app</h1>" })
    const srcdoc = (f.frameEl as unknown as { srcdoc: string }).srcdoc
    expect(srcdoc).toContain("<h1>my app</h1>")
    expect(srcdoc).toContain("window.mcp")
    expect(srcdoc).toContain("default-src 'none'") // strict CSP cage
  })

  it("fetches the template for a pointer app (no inline html) via readResource", async () => {
    const f = makeFrame()
    let readUri = ""
    mountHost({
      frameEl: f.frameEl,
      uri: "ui://luna/app/ext",
      html: null,
      transport: {
        readResource: async (uri) => {
          readUri = uri
          return { ok: true, text: "<p>fetched</p>" }
        },
        callTool: async () => ({ ok: true }),
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(readUri).toBe("ui://luna/app/ext")
    const srcdoc = (f.frameEl as unknown as { srcdoc: string }).srcdoc
    expect(srcdoc).toContain("<p>fetched</p>")
    expect(srcdoc).not.toContain("window.mcp") // bare cage — external app brings its own client
  })

  it("dispose() stops handling further messages", () => {
    const f = makeFrame()
    const handle = mountHost({ frameEl: f.frameEl, html: "<p>x</p>" })
    handle.dispose()
    send(f, { jsonrpc: "2.0", id: 1, method: "ui/initialize" })
    expect(f.posted).toHaveLength(0)
  })
})
