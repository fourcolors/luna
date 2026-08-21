/**
 * chat-ctx.ts - the typed contract a future chat boot script builds against;
 * no runtime object is constructed anywhere in this PR. Today main-chat.tsx
 * assembles its own ad hoc `{ invoke }` inline for chat-chrome-mount (see
 * main-chat.tsx) and chat.html exposes no ChatCtx-shaped global - a real
 * ChatCtx lands once window.LunaTransport is retired (see connectWs below).
 *
 * Mirrors ../panels/panel-ctx.ts's PanelCtx shape (invoke/connectWs/hasTauri/
 * win/label). PanelCtx's connectWs types frames as `any` against the vendor
 * moon-ws.js registry, which is fine for panels (a handful of obs-event
 * kinds). Chat carries the FULL v2 wire protocol (thread lifecycle,
 * artifacts, vault, connectors, workflows, skills, subagents, mcp-apps,
 * ...) - hand-mirrored today across chat.html's vendored moon-protocol.js,
 * packages/ui-shared/src/wire.ts, and packages/ui-ws/src/protocol.ts - so
 * ChatCtx types connectWs directly against the canonical wire contract
 * instead: ClientFrame / ServerFrame from @luna/ui-ws
 * (packages/ui-ws/src/protocol.ts, the server-side source of truth). The
 * connection lifecycle is typed against RouteHandle from
 * @luna/ui-transport/browser - the handle type ConnectionManager.acquire()
 * resolves - the same pool primitive chat.html's own PoolEngine already
 * builds on top of the vendored window.LunaTransport global.
 *
 * connectWs has no runtime implementation here: wiring it up needs
 * window.LunaTransport retired first, so a single ConnectionManager owns
 * the socket instead of two competing ones (deferred to S18).
 */
import type { LunaConnectWsOptions } from "../panels/panel-ctx.js"
import type { RouteHandle } from "@luna/ui-transport/browser"
// @luna/ui-ws publishes only the "." export (packages/ui-ws/package.json),
// which re-exports server.js plus every node-side bridge module alongside
// protocol.js - see packages/ui-shared/src/wire.ts's header for why that
// barrel is normally kept out of browser bundles. `import type` erases
// before bundling, so this is safe only as long as it stays type-only: do
// not drop `type` here without first adding a `./protocol` subpath export
// to packages/ui-ws/package.json.
import type { ClientFrame, ServerFrame } from "@luna/ui-ws"

export interface ChatCtx {
  /**
   * Invoke a Tauri command. Off-Tauri (browser dev / jsdom / no __TAURI__)
   * this rejects - callers are expected to swallow that (matches PanelCtx's
   * and every vanilla panels/*.js module's `.catch(function () {})`
   * convention - see panel-ctx.ts).
   */
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  /**
   * Acquire the shared chat WebSocket connection (via ConnectionManager,
   * ref-counted like every other route) and register a typed frame handler.
   * Callers must await the resolved handle before assuming the route is
   * attached.
   */
  connectWs?: (registry: ChatFrameRegistry, opts?: ChatConnectWsOptions) => Promise<ChatWsHandle>
  /**
   * True once `window.__TAURI__.core` exists - mirrors PanelCtx.hasTauri.
   */
  hasTauri: boolean
  /**
   * The current Tauri window handle, or `null` off-Tauri. Typed `unknown`
   * here for the same reason as PanelCtx.win: consumers that need
   * `win.listen(...)` narrow it themselves.
   */
  win: unknown
  /**
   * The current Tauri window's label, or `null` off-Tauri / unresolved.
   * Optional so a ChatCtx test mock predating this field keeps compiling -
   * mirrors PanelCtx.label.
   */
  label?: string | null
}

/**
 * Dispatch-by-type registry for inbound ServerFrame traffic - the typed
 * counterpart of panel-ctx.ts's LunaFrameRegistry (mirrors vendor
 * moon-ws.js's `LunaWS.createFrameRegistry()`, which chat.html's own inline
 * script already uses as `MoonFrames` for every frame type it handles today).
 */
export interface ChatFrameRegistry {
  register: <T extends ServerFrame["type"]>(
    type: T,
    fn: (frame: Extract<ServerFrame, { type: T }>) => void,
  ) => ChatFrameRegistry
  /**
   * Untyped at the wire boundary: nothing in this module validates an
   * inbound frame before dispatch, so callers must not assume `unknown` is
   * actually a well-formed ServerFrame.
   */
  dispatch: (frame: unknown) => boolean
  has: (type: string) => boolean
}

/**
 * Connection-lifecycle callbacks for ChatCtx.connectWs. Structurally
 * the same shape PanelCtx uses - one type, aliased, so the two surfaces
 * cannot drift.
 */
export type ChatConnectWsOptions = LunaConnectWsOptions

/**
 * The live handle ChatCtx.connectWs resolves - the typed counterpart of
 * PanelCtx's LunaWsClient. `route` is the pooled ConnectionManager handle
 * (release() ref-counts down; the last release disposes the adapter), so a
 * chat window and any panel sharing the same routeKey share one socket.
 */
export interface ChatWsHandle {
  /** The pooled ConnectionManager handle - routeKey and release live HERE
   * (one name per action; release() ref-counts down and the last release
   * disposes the adapter), so a chat window and any panel sharing the same
   * routeKey share one socket. */
  readonly route: RouteHandle
  /** Send a typed client frame down the shared socket. */
  send: (frame: ClientFrame) => void
}
