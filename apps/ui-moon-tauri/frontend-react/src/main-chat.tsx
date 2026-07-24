// main-chat.tsx - React 19 + Astryx boot entry for chat.html.
//
// Mounts the invisible boot probe (see boot.tsx) plus the React-owned
// title-bar chrome shared with widget.html (chat/chat-chrome-mount.tsx): the
// `.bar-title` text and the `.collapse-moon-btn` glyph. chat.html's existing
// `#content-area`-equivalent (the WebSocketEngine/PoolEngine/
// ThreadDrawerEngine-driven message pipeline) and every other title-bar
// control (new-thread-btn, redock-btn) keep running completely unchanged in
// chat.html's own inline <script> - see chat-chrome-mount.tsx's module doc
// for the full scope rationale.
import { mountMoonReactRoot } from "./boot"
import { mountChatChrome } from "./chat/chat-chrome-mount"

mountMoonReactRoot("chat")

interface TauriCore {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

function invokeTauri(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const w = window as unknown as { __TAURI__?: { core?: TauriCore } }
  const core = w.__TAURI__?.core
  if (!core) return Promise.reject(new Error("not in Tauri"))
  return args === undefined ? core.invoke(cmd) : core.invoke(cmd, args)
}

mountChatChrome({ invoke: invokeTauri })
