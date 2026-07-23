/**
 * external-mcp-app-registry.test.ts — proves the G4 relay against a REAL MCP
 * client ↔ a REAL MCP server (the in-repo example server), two ways:
 *   1. InMemoryTransport — deterministic full-protocol round-trip (initialize →
 *      resources/read → tools/call), no subprocess.
 *   2. real STDIO — spawns the example server as a separate `bun` process and
 *      reads its app over the wire, proving the actual transport.
 *
 * Both feed the same createExternalMcpAppRegistry provider, asserting it serves
 * the external server's ui:// HTML, relays its tool, and enforces same-server.
 */
import { describe, it, expect } from "vitest"
import * as path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createExampleServer, EXAMPLE_APP_URI, EXAMPLE_TOOL } from "../example-mcp-ui-server.js"
import {
  createExternalMcpAppRegistry,
  connectExternalStdioServer,
  parseExternalMcpServersEnv,
  type ConnectedExternalServer,
} from "../external-mcp-app-registry.js"

describe("parseExternalMcpServersEnv (LUNA_EXTERNAL_MCP_SERVERS, #161)", () => {
  it("returns [] for unset / empty / whitespace (default-off)", () => {
    expect(parseExternalMcpServersEnv(undefined)).toEqual([])
    expect(parseExternalMcpServersEnv(null)).toEqual([])
    expect(parseExternalMcpServersEnv("")).toEqual([])
    expect(parseExternalMcpServersEnv("   ")).toEqual([])
  })

  it("returns [] for invalid JSON or non-array root", () => {
    expect(parseExternalMcpServersEnv("{not json")).toEqual([])
    expect(parseExternalMcpServersEnv('{"id":"x"}')).toEqual([])
    expect(parseExternalMcpServersEnv("null")).toEqual([])
  })

  it("parses a well-formed array of stdio specs", () => {
    const raw = JSON.stringify([
      {
        id: "example",
        command: "bun",
        args: ["run", "example-mcp-ui-server.ts"],
        env: { FOO: "bar" },
      },
    ])
    expect(parseExternalMcpServersEnv(raw)).toEqual([
      {
        id: "example",
        command: "bun",
        args: ["run", "example-mcp-ui-server.ts"],
        env: { FOO: "bar" },
      },
    ])
  })

  it("skips invalid entries and duplicate ids; keeps valid siblings", () => {
    const raw = JSON.stringify([
      { id: "ok", command: "bun", args: ["run", "a.ts"] },
      { id: "", command: "bun" },
      { id: "no-cmd", command: "  " },
      { id: "ok", command: "dupe-ignored" },
      { command: "only-cmd" },
      { id: "bad-args", command: "bun", args: [1, "x"] },
      { id: "bad-env", command: "bun", env: { A: 1 } },
      null,
      "string-entry",
      { id: "second", command: "node" },
    ])
    expect(parseExternalMcpServersEnv(raw)).toEqual([
      { id: "ok", command: "bun", args: ["run", "a.ts"] },
      { id: "second", command: "node" },
    ])
  })
})

async function linkInMemory(): Promise<{
  server: ConnectedExternalServer
  close: () => Promise<void>
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const mcp = createExampleServer()
  await mcp.connect(serverTransport)
  const client = new Client({ name: "test-host", version: "0.0.0" }, { capabilities: {} })
  await client.connect(clientTransport)

  const resources = await client.listResources()
  const tools = await client.listTools()
  const server: ConnectedExternalServer = {
    id: "example",
    client: client as never,
    resourceUris: new Set(resources.resources.map((r) => r.uri)),
    toolNames: new Set(tools.tools.map((t) => t.name)),
  }
  return { server, close: async () => void (await client.close()) }
}

describe("G4 external MCP app registry — in-memory (real SDK client ↔ example server)", () => {
  it("readResource serves the external server's ui:// app HTML", async () => {
    const { server, close } = await linkInMemory()
    try {
      const reg = createExternalMcpAppRegistry([server])
      const res = await reg.readResource(EXAMPLE_APP_URI)
      expect(res.ok).toBe(true)
      expect(res.mimeType).toContain("text/html")
      // zero theme code in the app — only var(--color-*), themed by the G1.5 cage shim
      expect(res.text).toContain("var(--color-background-primary")
      expect(res.text).not.toContain("window.luna")
    } finally {
      await close()
    }
  })

  it("callTool relays a same-server tool and returns its structuredContent", async () => {
    const { server, close } = await linkInMemory()
    try {
      const reg = createExternalMcpAppRegistry([server])
      const res = await reg.callTool(EXAMPLE_APP_URI, EXAMPLE_TOOL, {})
      expect(res.ok).toBe(true)
      const structured = (res.result as { structuredContent?: { openTasks?: number } })
        .structuredContent
      expect(structured?.openTasks).toBe(7)
    } finally {
      await close()
    }
  })

  it("enforces the same-server rule: a tool the server never advertised is rejected", async () => {
    const { server, close } = await linkInMemory()
    try {
      const reg = createExternalMcpAppRegistry([server])
      const res = await reg.callTool(EXAMPLE_APP_URI, "evil-tool", {})
      expect(res.ok).toBe(false)
      expect(res.message).toContain("not provided")
    } finally {
      await close()
    }
  })

  it("unknown uri → ok:false so composeAppRegistries falls through cleanly", async () => {
    const { server, close } = await linkInMemory()
    try {
      const reg = createExternalMcpAppRegistry([server])
      const res = await reg.readResource("ui://luna/workspace-pulse")
      expect(res.ok).toBe(false)
    } finally {
      await close()
    }
  })
})

describe("G4 external MCP app registry — REAL stdio subprocess", () => {
  it("connects to the example server over real stdio and serves its app", async () => {
    const serverPath = path.resolve(__dirname, "../example-mcp-ui-server.ts")
    const conn = await connectExternalStdioServer({
      id: "example",
      command: "bun",
      args: ["run", serverPath],
    })
    try {
      expect(conn.resourceUris.has(EXAMPLE_APP_URI)).toBe(true)
      expect(conn.toolNames.has(EXAMPLE_TOOL)).toBe(true)
      const reg = createExternalMcpAppRegistry([conn])
      const res = await reg.readResource(EXAMPLE_APP_URI)
      expect(res.ok).toBe(true)
      expect(res.text).toContain("var(--color-background-primary")
      const tool = await reg.callTool(EXAMPLE_APP_URI, EXAMPLE_TOOL, {})
      expect(tool.ok).toBe(true)
    } finally {
      await conn.close()
    }
  }, 30000)
})
