/**
 * external-mcp-app-registry.ts — G4: render a THIRD-PARTY MCP server's apps as
 * Luna panels. This is the `McpAppHostDeps` provider the widget-system.md Phase 7
 * follow-up always named ("external MCP servers plug in behind the same seam").
 *
 * It composes into `composeAppRegistries(...)` (apps/ui-web/scripts/chat-server.ts)
 * AFTER the core + store providers, so:
 *   - `ui://luna/*`      → core provider
 *   - `ui://luna/app/*`  → store provider
 *   - anything else a connected external server serves (e.g. `ui://example/*`)
 *     → this provider; unknown → ok:false so the chain ends cleanly.
 *
 * Security — the spec's SAME-SERVER rule, enforced here: an app rendered from a
 * server's `ui://` resource may ONLY call tools that THAT server exposed at
 * connect (tools/list). A tool that the owning server didn't advertise → ok:false,
 * even if some OTHER connected server has it. Provider defects collapse to ok:false
 * (createMcpAppHost never lets internals reach the wire).
 *
 * The provider is decoupled from the MCP SDK via the structural ExternalMcpClient
 * interface (test mocks + the real @modelcontextprotocol/sdk Client both satisfy
 * it); the SDK is imported only by the connect helper.
 */
import type { McpAppHostDeps } from "@luna/ui-ws"

/** The slice of an MCP client this relay uses. The official SDK `Client`
 *  satisfies it structurally; tests pass a fake. */
export interface ExternalMcpClient {
  readResource(params: { uri: string }): Promise<{
    contents: ReadonlyArray<{
      uri: string
      mimeType?: string
      text?: string
      blob?: string
    }>
  }>
  callTool(params: { name: string; arguments?: unknown }): Promise<{
    content?: unknown
    structuredContent?: unknown
    isError?: boolean
  }>
}

/** A connected external server + the routing facts gathered at connect time. */
export interface ConnectedExternalServer {
  readonly id: string
  readonly client: ExternalMcpClient
  /** `ui://` resource uris this server serves (from resources/list). The relay
   *  claims a uri iff some connected server serves it. */
  readonly resourceUris: ReadonlySet<string>
  /** Tool names this server exposed (from tools/list) — the same-server allowlist. */
  readonly toolNames: ReadonlySet<string>
}

/**
 * Build an `McpAppHostDeps` over a set of connected external servers. Pure +
 * synchronous to construct (no I/O), so it's trivial to unit-test with fakes.
 */
export const createExternalMcpAppRegistry = (
  servers: ReadonlyArray<ConnectedExternalServer>,
): McpAppHostDeps => {
  const ownerOf = (uri: string): ConnectedExternalServer | undefined =>
    servers.find((s) => s.resourceUris.has(uri))

  return {
    async readResource(uri) {
      const server = ownerOf(uri)
      if (server === undefined) {
        return { ok: false, message: `unknown app resource: ${uri}` }
      }
      try {
        const res = await server.client.readResource({ uri })
        const entry = Array.isArray(res?.contents)
          ? res.contents.find((c) => typeof c.text === "string")
          : undefined
        if (entry === undefined || typeof entry.text !== "string") {
          return { ok: false, message: `external app has no html body: ${uri}` }
        }
        return {
          ok: true,
          ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
          text: entry.text,
        }
      } catch {
        return { ok: false, message: `external resource read failed: ${uri}` }
      }
    },

    async callTool(appUri, tool, args) {
      const server = ownerOf(appUri)
      if (server === undefined) {
        return { ok: false, message: `unknown app: ${appUri}` }
      }
      // SAME-SERVER RULE: only tools the OWNING server advertised are callable
      // from its app — cross-server names are rejected even if they exist elsewhere.
      if (!server.toolNames.has(tool)) {
        return { ok: false, message: `tool "${tool}" is not provided by ${appUri}` }
      }
      try {
        const res = await server.client.callTool({ name: tool, arguments: args })
        // Pass the spec-shaped CallToolResult through; the cage app reads
        // structuredContent (the host never logs tool results).
        return {
          ok: true,
          result: {
            content: res.content ?? [],
            structuredContent: res.structuredContent,
          },
        }
      } catch {
        return { ok: false, message: `tool "${tool}" failed` }
      }
    },
  }
}

/* ── Real transport: connect to an external stdio MCP server ──────────────────
 * Uses the official SDK Client + StdioClientTransport. Imported lazily so the
 * pure registry above carries no SDK dependency for tests/mocks. */

/** How to launch/reach an external MCP server (stdio variant for v1). */
export interface StdioServerSpec {
  readonly id: string
  readonly command: string
  readonly args?: ReadonlyArray<string>
  /** Extra env for the child (merged onto the SDK's safe default environment). */
  readonly env?: Record<string, string>
}

/**
 * Parse `LUNA_EXTERNAL_MCP_SERVERS` (JSON array of StdioServerSpec).
 *
 * Env-gated, default-off (#161): empty / unset / invalid JSON ⇒ `[]` so the
 * chat-server wires an inert external registry and production behavior is
 * unchanged. Invalid array entries are skipped (never throw).
 *
 * Shape per entry: `{ "id": string, "command": string, "args"?: string[],
 * "env"?: Record<string, string> }`.
 */
export const parseExternalMcpServersEnv = (
  raw: string | undefined | null,
): ReadonlyArray<StdioServerSpec> => {
  if (raw === undefined || raw === null) return []
  const trimmed = raw.trim()
  if (trimmed.length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: StdioServerSpec[] = []
  const seenIds = new Set<string>()
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue
    const rec = entry as Record<string, unknown>
    const id = typeof rec.id === "string" ? rec.id.trim() : ""
    const command = typeof rec.command === "string" ? rec.command.trim() : ""
    if (id.length === 0 || command.length === 0) continue
    if (seenIds.has(id)) continue
    seenIds.add(id)
    let args: ReadonlyArray<string> | undefined
    if (Array.isArray(rec.args)) {
      const cleaned = rec.args.filter((a): a is string => typeof a === "string")
      if (cleaned.length === rec.args.length) args = cleaned
      else continue // mixed-type args = reject the entry
    } else if (rec.args !== undefined) {
      continue
    }
    let env: Record<string, string> | undefined
    if (rec.env !== undefined) {
      if (rec.env === null || typeof rec.env !== "object" || Array.isArray(rec.env)) {
        continue
      }
      const envOut: Record<string, string> = {}
      let envOk = true
      for (const [k, v] of Object.entries(rec.env as Record<string, unknown>)) {
        if (typeof v !== "string") {
          envOk = false
          break
        }
        envOut[k] = v
      }
      if (!envOk) continue
      env = envOut
    }
    out.push({
      id,
      command,
      ...(args !== undefined ? { args } : {}),
      ...(env !== undefined ? { env } : {}),
    })
  }
  return out
}

/** A connected server plus a `close()` that tears the subprocess down (important:
 *  the chat-server has a memory-leak history — every connection must be disposed). */
export type LiveExternalServer = ConnectedExternalServer & {
  readonly close: () => Promise<void>
}

/**
 * Connect to a stdio MCP server, advertise MCP-Apps render capability in the
 * initialize handshake, and snapshot its resources + tools for routing.
 */
export const connectExternalStdioServer = async (
  spec: StdioServerSpec,
): Promise<LiveExternalServer> => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  )

  const client = new Client(
    { name: "luna-relay", version: "1.0.0" },
    {
      // Host advertises it can render MCP Apps UI (SEP-1865 capability negotiation).
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
        },
      },
    },
  )

  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args !== undefined ? [...spec.args] : undefined,
    ...(spec.env !== undefined ? { env: spec.env } : {}),
  })
  await client.connect(transport)

  const resourceUris = new Set<string>()
  try {
    const r = await client.listResources()
    for (const res of r.resources) resourceUris.add(res.uri)
  } catch {
    /* server exposes no resources — leave empty (it serves no UI) */
  }
  const toolNames = new Set<string>()
  try {
    const t = await client.listTools()
    for (const tool of t.tools) toolNames.add(tool.name)
  } catch {
    /* server exposes no tools */
  }

  return {
    id: spec.id,
    client: client as unknown as ExternalMcpClient,
    resourceUris,
    toolNames,
    close: async () => {
      try {
        await client.close()
      } catch {
        /* already gone */
      }
    },
  }
}
