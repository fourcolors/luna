/**
 * panel-ctx.ts - the minimal slice of panel.html's `ctx` object that React
 * panel components need.
 *
 * panel.html's vanilla inline script builds a much richer `ctx` (label, win,
 * hasTauri, invoke, connectWs - see panel.html) for every panel type and
 * assigns it to `window.__panelCtx` right after construction, so a React
 * panel mounted by panel-boot.tsx can read the exact same object the
 * still-vanilla panels/*.js modules use - no parallel connection/transport
 * logic to keep in sync. Widen this type (and panel.html's ctx object) if a
 * future React panel needs more of it.
 */
export interface PanelCtx {
  /**
   * Invoke a Tauri command. Off-Tauri (browser dev / jsdom / no __TAURI__)
   * this rejects - callers are expected to swallow that (matches every
   * vanilla panels/*.js module's `.catch(function () {})` convention).
   */
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  /**
   * Open a gen-gated UI-WS client over the shared transport, connected with
   * the stored credentials (see panel.html's connectWs doc for the full
   * MoonSession route-resolution / legacy load_connection fallback). Callers
   * register frame handlers on the registry they pass in.
   */
  connectWs?: (registry: LunaFrameRegistry, opts?: LunaConnectWsOptions) => LunaWsClient
  /**
   * True once `window.__TAURI__.core` exists - mirrors every vanilla
   * panels/*.js module's `ctx.hasTauri` gate for probes that should only run
   * inside the real app (never in browser dev / jsdom).
   */
  hasTauri: boolean
  /**
   * The current Tauri window handle (`getCurrentWindow()`'s result), or
   * `null` off-Tauri. Typed `unknown` here (not the Tauri SDK's own type) so
   * this file stays free of a `@tauri-apps/api` import; consumers that need
   * `win.listen(...)` narrow it themselves (see
   * src/panels/settings-voice/VoicePanel.tsx for the pattern) - same
   * approach panel.html's own vanilla `ctx.win` documentation takes.
   */
  win: unknown
  /**
   * The current Tauri window's label (`getCurrentWindow().label`), or `null`
   * off-Tauri / when the window handle couldn't be resolved. Optional so the
   * many existing PanelCtx test mocks that predate this field keep
   * compiling unchanged - only settings.updates' "Later" button
   * (`close_widget({ label })`, see UpdatesPanel.tsx) reads it today.
   */
  label?: string | null
}

/**
 * Forwarded verbatim to `LunaWS.createClient` (see panel.html's connectWs and
 * vendor/moon-ws.js) — widened beyond `autoPong` for the Workflows gallery
 * panel's connection-liveness indicator (onOpen/onClose flip its
 * "disconnected" hint; see src/panels/workflows/WorkflowsPanel.tsx).
 */
export interface LunaConnectWsOptions {
  autoPong?: boolean
  onOpen?: () => void
  onClose?: () => void
  onError?: () => void
  onUnhandled?: (frame: unknown) => void
}

/** Shape of the vendor/moon-ws.js `LunaWS.createFrameRegistry()` result. */
export interface LunaFrameRegistry {
  register: (type: string, fn: (frame: any) => void) => LunaFrameRegistry
  dispatch: (frame: unknown) => boolean
  has: (type: string) => boolean
}

/** Shape of the vendor/moon-ws.js `LunaWS.createClient()` result. */
export interface LunaWsClient {
  connect: (wsUrl: string, wsToken?: string | null) => unknown
  send: (frame: Record<string, unknown>) => boolean
  close: () => void
  registerCloseHook: (fn: (evt: unknown) => void) => void
  socket: () => unknown
}
