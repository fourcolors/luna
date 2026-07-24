// main-widget.tsx - React 19 + Astryx boot entry for widget.html.
//
// Mounts the invisible boot probe (see boot.tsx) plus the React-owned
// title-bar chrome (widget/widget-chrome-mount.tsx): the `.bar-title` text
// and the `.collapse-moon-btn` glyph. widget.html's existing vanilla
// `#content-area` rendering (the frozen sandboxed-iframe/markdown/code
// pipeline) and its WebSocket wiring keep running completely unchanged in
// widget.html's own inline <script> - see that file's module doc and
// widget/WidgetChrome.tsx's module doc for the full scope rationale.
//
// window.__widgetChrome is assigned here, before the inline script's async
// WS-driven render() calls can ever fire (a deferred `type="module"` script
// always finishes evaluating before any network/Tauri-invoke round trip
// completes), so `render()`'s `window.__widgetChrome.setTitle(...)` call
// always finds a live handle.
import { mountMoonReactRoot } from "./boot"
import { mountWidgetChrome } from "./widget/widget-chrome-mount"

mountMoonReactRoot("widget")

interface TauriCore {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

function invokeTauri(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const w = window as unknown as { __TAURI__?: { core?: TauriCore } }
  const core = w.__TAURI__?.core
  if (!core) return Promise.reject(new Error("not in Tauri"))
  return args === undefined ? core.invoke(cmd) : core.invoke(cmd, args)
}

window.__widgetChrome = mountWidgetChrome({ invoke: invokeTauri })
