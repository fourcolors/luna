/**
 * Unit tests for createMcpAppHost — the server half of the MCP Apps relay
 * (widget-system.md Phase 7). Focus: requestId correlation (success and
 * failure echo the same coerced id), ok:false on unknown resources / wrong-app
 * tools / provider failures, the NEVER-rejects contract (a throwing provider
 * collapses to a generic ok:false — internals never reach the wire), and
 * malformed-frame rejection (TS types are erased; clients can send junk).
 */
import { describe, expect, it, vi } from "vitest"
import { createMcpAppHost, type McpAppHostDeps } from "../src/mcp-app-host.js"
import type { McpResourceReadFrame, McpToolCallFrame } from "../src/protocol.js"

const APP_URI = "ui://luna/workspace-pulse"
const HTML = "<style>x</style><script>y</script>"

const happyDeps = (): McpAppHostDeps => ({
  readResource: vi.fn(async (uri: string) =>
    uri === APP_URI
      ? { ok: true, mimeType: "text/html;profile=mcp-app", text: HTML }
      : { ok: false, message: `unknown app resource: ${uri}` },
  ),
  callTool: vi.fn(async (appUri: string, tool: string, _args: unknown) =>
    appUri === APP_URI && tool === "pulse-snapshot"
      ? { ok: true, result: { structuredContent: { toolsCalled: 3 } } }
      : { ok: false, message: `tool "${tool}" is not provided by ${appUri}` },
  ),
})

const readFrame = (over: Partial<McpResourceReadFrame> = {}): McpResourceReadFrame => ({
  type: "mcp-resource-read",
  requestId: "r1",
  uri: APP_URI,
  ...over,
})

const callFrame = (over: Partial<McpToolCallFrame> = {}): McpToolCallFrame => ({
  type: "mcp-tool-call",
  requestId: "t1",
  appUri: APP_URI,
  tool: "pulse-snapshot",
  args: {},
  ...over,
})

describe("McpAppHost — resource reads", () => {
  it("resolves a known uri with the html + mimeType, echoing the requestId", async () => {
    const host = createMcpAppHost(happyDeps())
    const out = await host.handleResourceRead(readFrame())
    expect(out).toEqual({
      type: "mcp-resource-result",
      requestId: "r1",
      ok: true,
      mimeType: "text/html;profile=mcp-app",
      text: HTML,
    })
  })

  it("relays the provider's ok:false (unknown uri) with its message", async () => {
    const host = createMcpAppHost(happyDeps())
    const out = await host.handleResourceRead(readFrame({ requestId: "r2", uri: "ui://evil/x" }))
    expect(out.ok).toBe(false)
    expect(out.requestId).toBe("r2")
    expect(out.message).toContain("ui://evil/x")
    expect(out.text).toBeUndefined()
  })

  it("a REJECTING provider collapses to a generic ok:false (never throws, no internals)", async () => {
    const deps = happyDeps()
    ;(deps.readResource as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ENOENT /secret/path/luna.db"),
    )
    const host = createMcpAppHost(deps)
    const out = await host.handleResourceRead(readFrame({ requestId: "r3" }))
    expect(out).toEqual({
      type: "mcp-resource-result",
      requestId: "r3",
      ok: false,
      message: "resource read failed",
    })
  })

  it("rejects a malformed frame (non-string / empty uri) without touching the provider", async () => {
    const deps = happyDeps()
    const host = createMcpAppHost(deps)
    const out = await host.handleResourceRead(
      readFrame({ uri: 42 as unknown as string, requestId: "r4" }),
    )
    expect(out.ok).toBe(false)
    expect(out.requestId).toBe("r4")
    expect(out.message).toBe("malformed mcp-resource-read frame")
    expect(deps.readResource).not.toHaveBeenCalled()
  })
})

describe("McpAppHost — tool calls", () => {
  it("round-trips a same-app tool call with the result, echoing the requestId", async () => {
    const deps = happyDeps()
    const host = createMcpAppHost(deps)
    const out = await host.handleToolCall(callFrame({ args: { a: 1 } }))
    expect(out).toEqual({
      type: "mcp-tool-result",
      requestId: "t1",
      ok: true,
      result: { structuredContent: { toolsCalled: 3 } },
    })
    // args pass through verbatim — the provider owns interpretation.
    expect(deps.callTool).toHaveBeenCalledWith(APP_URI, "pulse-snapshot", { a: 1 })
  })

  it("relays the provider's wrong-app refusal (the same-server rule) as ok:false", async () => {
    const host = createMcpAppHost(happyDeps())
    const out = await host.handleToolCall(
      callFrame({ requestId: "t2", appUri: "ui://luna/other-app" }),
    )
    expect(out.ok).toBe(false)
    expect(out.requestId).toBe("t2")
    expect(out.result).toBeUndefined()
  })

  it("a REJECTING callTool collapses to a generic ok:false", async () => {
    const deps = happyDeps()
    ;(deps.callTool as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom: stack"))
    const host = createMcpAppHost(deps)
    const out = await host.handleToolCall(callFrame({ requestId: "t3" }))
    expect(out).toEqual({
      type: "mcp-tool-result",
      requestId: "t3",
      ok: false,
      message: "tool call failed",
    })
  })

  it("rejects malformed frames (missing tool / appUri) without touching the provider", async () => {
    const deps = happyDeps()
    const host = createMcpAppHost(deps)
    const noTool = await host.handleToolCall(callFrame({ tool: "" }))
    const noApp = await host.handleToolCall(
      callFrame({ appUri: undefined as unknown as string }),
    )
    expect(noTool.ok).toBe(false)
    expect(noApp.ok).toBe(false)
    expect(noTool.message).toBe("malformed mcp-tool-call frame")
    expect(deps.callTool).not.toHaveBeenCalled()
  })

  it("coerces a junk requestId identically on success and failure (correlation never breaks)", async () => {
    const host = createMcpAppHost(happyDeps())
    const okOut = await host.handleToolCall(
      callFrame({ requestId: 7 as unknown as string }),
    )
    const errOut = await host.handleToolCall(
      callFrame({ requestId: 7 as unknown as string, tool: "" }),
    )
    expect(okOut.requestId).toBe("7")
    expect(errOut.requestId).toBe("7")
  })

  it("a missing result on ok:true is normalized to null (JSON-safe reply)", async () => {
    const deps = happyDeps()
    ;(deps.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
    const host = createMcpAppHost(deps)
    const out = await host.handleToolCall(callFrame())
    expect(out.ok).toBe(true)
    expect(out.result).toBeNull()
  })
})
