/**
 * McpAppHost — the server half of the MCP Apps relay (widget-system.md
 * Phase 7, SEP-1865 v1).
 *
 * Pure request/response: no per-connection registration. The WS server hands
 * an inbound `mcp-resource-read` / `mcp-tool-call` frame in and sends the
 * returned result frame on the SAME connection (requestId-correlated).
 *
 * Design properties:
 *   - NEVER throws/rejects into the socket loop. Every failure — malformed
 *     frame, provider rejection, handler defect — collapses to an `ok:false`
 *     result frame with a short, non-sensitive message. Provider failures
 *     deliberately do NOT echo internals (a stack trace is not a UI message).
 *   - Provider-agnostic: `deps` is the seam. v1 wires the chat-server's
 *     in-process CoreAppRegistry (the Luna server is the first app provider);
 *     an external-MCP-server relay plugs in behind the same two functions.
 *   - The same-server tool rule (an app may only call its own app's tools) is
 *     enforced INSIDE deps.callTool by the provider — this module just
 *     relays (appUri, tool, args) faithfully so the provider can enforce it.
 *   - Tool results are the app's data: never logged here.
 */
import type {
  McpResourceReadFrame,
  McpResourceResultFrame,
  McpToolCallFrame,
  McpToolResultFrame,
} from "./protocol.js"

export interface McpResourceReadResult {
  readonly ok: boolean
  readonly mimeType?: string
  readonly text?: string
  readonly message?: string
}

export interface McpToolCallResult {
  readonly ok: boolean
  readonly result?: unknown
  readonly message?: string
}

export interface McpAppHostDeps {
  /** Resolve a `ui://` resource to its app HTML. Unknown uri → ok:false. */
  readonly readResource: (uri: string) => Promise<McpResourceReadResult>
  /**
   * Call `tool` with `args` ON BEHALF OF the app rendered from `appUri`.
   * The provider MUST enforce the spec's same-server rule: a (appUri, tool)
   * pair where the tool does not belong to that app → ok:false.
   */
  readonly callTool: (
    appUri: string,
    tool: string,
    args: unknown,
  ) => Promise<McpToolCallResult>
}

export interface McpAppHost {
  /** Resolves to the reply frame. Never rejects. */
  readonly handleResourceRead: (
    frame: McpResourceReadFrame,
  ) => Promise<McpResourceResultFrame>
  /** Resolves to the reply frame. Never rejects. */
  readonly handleToolCall: (frame: McpToolCallFrame) => Promise<McpToolResultFrame>
}

/** Coerce an attacker-controlled requestId so success + failure echo the
 *  same value (TS types are erased — a client can send anything). */
const coerceRequestId = (frame: { readonly requestId?: unknown }): string =>
  typeof frame.requestId === "string" ? frame.requestId : String(frame.requestId ?? "")

export const createMcpAppHost = (deps: McpAppHostDeps): McpAppHost => ({
  async handleResourceRead(frame) {
    const requestId = coerceRequestId(frame)
    if (typeof frame.uri !== "string" || frame.uri.trim().length === 0) {
      return {
        type: "mcp-resource-result",
        requestId,
        ok: false,
        message: "malformed mcp-resource-read frame",
      }
    }
    try {
      const res = await deps.readResource(frame.uri)
      if (!res || res.ok !== true || typeof res.text !== "string") {
        return {
          type: "mcp-resource-result",
          requestId,
          ok: false,
          message:
            res && typeof res.message === "string" && res.message.length > 0
              ? res.message
              : "resource read failed",
        }
      }
      return {
        type: "mcp-resource-result",
        requestId,
        ok: true,
        ...(res.mimeType !== undefined ? { mimeType: res.mimeType } : {}),
        text: res.text,
      }
    } catch {
      // Provider defect — generic line only, never internals.
      return {
        type: "mcp-resource-result",
        requestId,
        ok: false,
        message: "resource read failed",
      }
    }
  },

  async handleToolCall(frame) {
    const requestId = coerceRequestId(frame)
    if (
      typeof frame.appUri !== "string" ||
      frame.appUri.trim().length === 0 ||
      typeof frame.tool !== "string" ||
      frame.tool.trim().length === 0
    ) {
      return {
        type: "mcp-tool-result",
        requestId,
        ok: false,
        message: "malformed mcp-tool-call frame",
      }
    }
    try {
      const res = await deps.callTool(frame.appUri, frame.tool, frame.args)
      if (!res || res.ok !== true) {
        return {
          type: "mcp-tool-result",
          requestId,
          ok: false,
          message:
            res && typeof res.message === "string" && res.message.length > 0
              ? res.message
              : "tool call failed",
        }
      }
      return {
        type: "mcp-tool-result",
        requestId,
        ok: true,
        result: res.result ?? null,
      }
    } catch {
      return {
        type: "mcp-tool-result",
        requestId,
        ok: false,
        message: "tool call failed",
      }
    }
  },
})
