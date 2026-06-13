/**
 * mcp-app-host.ts — the CLIENT half of the MCP Apps host (widget-system.md
 * Phase 7, SEP-1865 v1, spec rev 2026-01-26), shared ES port of Moon's
 * apps/ui-moon-tauri/frontend/vendor/mcp-app-host.js for the web client.
 *
 * `host({ frameEl, uri, html?, transport, onError })` turns a sandboxed iframe
 * into an MCP App frame:
 *   1. mount the app HTML — inline (generated app, window.mcp helper via
 *      buildGeneratedAppSrcdoc) or fetched via transport.readResource(uri)
 *      (static/external app, bare cage via buildMcpSrcdoc),
 *   2. speak the HOST side of MCP Apps JSON-RPC 2.0 over postMessage:
 *        - answer `ui/initialize`,
 *        - accept `ui/notifications/initialized`, then push `tool-input`,
 *        - route `tools/call` through transport.callTool,
 *        - method-not-found for unknown requests; ignore unknown notifications
 *          and malformed messages,
 *        - trust ONLY e.source === frameEl.contentWindow.
 *
 * The sandbox cage (buildGeneratedAppSrcdoc/buildMcpSrcdoc) is the SAME one Moon
 * uses, parity-pinned in widget-sandbox.parity.test.ts.
 */
import { buildGeneratedAppSrcdoc, buildMcpSrcdoc } from "./widget-sandbox.js"

export const PROTOCOL_VERSION = "2026-01-26"
export const HOST_NAME = "luna-web"

interface RpcMessage {
  jsonrpc?: string
  method?: string
  id?: unknown
  params?: { name?: unknown; arguments?: unknown } | undefined
}

// Plain boolean predicates (NOT `m is RpcMessage`): the caller keeps `m` typed
// as RpcMessage throughout onMessage, so chaining `if (isRpcRequest(m)) {…}`
// then `if (isRpcNotification(m)) {…}` must not narrow `m` away to `never`.
/** A JSON-RPC 2.0 envelope. */
export const isRpc = (m: unknown): boolean =>
  !!m && typeof m === "object" && (m as RpcMessage).jsonrpc === "2.0"
/** A request: a method AND a non-null id. */
export const isRpcRequest = (m: unknown): boolean =>
  isRpc(m) &&
  typeof (m as RpcMessage).method === "string" &&
  (m as RpcMessage).id !== undefined &&
  (m as RpcMessage).id !== null
/** A notification: a method and NO id. */
export const isRpcNotification = (m: unknown): boolean =>
  isRpc(m) &&
  typeof (m as RpcMessage).method === "string" &&
  ((m as RpcMessage).id === undefined || (m as RpcMessage).id === null)

export interface McpTransport {
  readResource: (
    uri: string,
  ) => Promise<{ ok: boolean; mimeType?: string; text?: string; message?: string }>
  callTool: (
    tool: string,
    args: unknown,
  ) => Promise<{ ok: boolean; result?: unknown; message?: string }>
}

export interface McpHostOptions {
  frameEl: HTMLIFrameElement
  /** The ui:// resource identifying the app (used for fetch-mode + identity). */
  uri: string
  /** Inline app HTML (generated/store-backed app). When present, mounted via
   *  the generated-app cage and readResource is NOT called. */
  html?: string | null
  transport: McpTransport
  onError?: (message: string) => void
}

export interface McpHostHandle {
  dispose: () => void
}

/**
 * Mount + host an MCP app in the given (already sandboxed) iframe. Returns a
 * handle whose `dispose()` removes the message listener and inerts in-flight
 * callbacks (call on re-render / teardown).
 */
export const host = (opts: McpHostOptions): McpHostHandle => {
  const frameEl = opts.frameEl
  const uri = opts.uri
  const inlineHtml = typeof opts.html === "string" ? opts.html : null
  const transport = opts.transport
  const onError = typeof opts.onError === "function" ? opts.onError : () => {}
  let disposed = false
  let initializedSeen = false

  const reply = (msg: unknown): void => {
    try {
      if (frameEl.contentWindow) frameEl.contentWindow.postMessage(msg, "*")
    } catch {
      /* iframe gone */
    }
  }

  const onMessage = (e: MessageEvent): void => {
    if (disposed) return
    // Trust boundary: only the rendered app's window.
    if (!frameEl.contentWindow || e.source !== frameEl.contentWindow) return
    const m = e.data as RpcMessage

    if (isRpcRequest(m)) {
      if (m.method === "ui/initialize") {
        reply({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            host: { name: HOST_NAME },
            capabilities: { serverTools: {} },
          },
        })
        return
      }
      if (m.method === "tools/call") {
        const params = m.params && typeof m.params === "object" ? m.params : {}
        const name = typeof params.name === "string" ? params.name : ""
        const args = params.arguments !== undefined ? params.arguments : {}
        transport.callTool(name, args).then(
          (res) => {
            if (disposed) return
            if (res && res.ok) {
              reply({ jsonrpc: "2.0", id: m.id, result: res.result !== undefined ? res.result : null })
            } else {
              reply({
                jsonrpc: "2.0",
                id: m.id,
                error: { code: -32000, message: (res && res.message) || "tool call failed" },
              })
            }
          },
          () => {
            if (disposed) return
            reply({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "tool call failed" } })
          },
        )
        return
      }
      // Unknown REQUEST → method-not-found (requests demand replies).
      reply({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found: " + m.method } })
      return
    }

    if (isRpcNotification(m)) {
      if (m.method === "ui/notifications/initialized" && !initializedSeen) {
        initializedSeen = true
        // Spec: push tool-input after init. v1 apps pull their own data, so the
        // payload is an empty arguments object.
        reply({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } })
      }
      // Other notifications: ignore (spec-sanctioned for unknowns).
      return
    }
    // Not JSON-RPC 2.0 → ignore.
  }

  window.addEventListener("message", onMessage)

  if (inlineHtml !== null) {
    // Generated / store-backed app: mount inline in the generated-app cage
    // (CSP + window.mcp helper). The same-server tool rule + curated allowlist
    // are still enforced server-side on every tools/call.
    frameEl.srcdoc = buildGeneratedAppSrcdoc(inlineHtml)
  } else {
    // Static / external app: fetch the template, mount in the bare cage.
    transport.readResource(uri).then(
      (res) => {
        if (disposed) return
        if (!res || !res.ok || typeof res.text !== "string") {
          onError((res && res.message) || "Could not load MCP app: " + uri)
          return
        }
        frameEl.srcdoc = buildMcpSrcdoc(res.text)
      },
      () => {
        if (disposed) return
        onError("Could not load MCP app: " + uri)
      },
    )
  }

  return {
    dispose: () => {
      disposed = true
      window.removeEventListener("message", onMessage)
    },
  }
}
