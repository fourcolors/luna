// main-chat.tsx - React 19 + Astryx boot entry for chat.html.
//
// Mounts the invisible boot probe (see boot.tsx), the React-owned title-bar
// chrome shared with widget.html (chat/chat-chrome-mount.tsx: `.bar-title` +
// `.collapse-moon-btn`), the chat transcript (chat/MessageList.tsx, stack23
// S15) into `#chat-messages`, and - as of stack23 S16a - the composer's
// staged-attachment tray (chat/Attachments.tsx) into `#attachments-strip` /
// `#attach-error`. chat.html's WebSocketEngine/PoolEngine/ThreadDrawerEngine
// -driven wire pipeline and every other title-bar control (new-thread-btn,
// redock-btn) keep running completely unchanged in chat.html's own inline
// <script> - see chat-chrome-mount.tsx's module doc for the chrome scope
// rationale, MessageList.tsx's module doc for the transcript-conversion seam
// (the `window.ChatState` / `window.ChatLoop` bridge this file assigns
// below), and Attachments.tsx's module doc for the `window.Attachments`
// bridge assigned the same way.
import "./chat/message-list.css"
import { mountMoonReactRoot } from "./boot"
import { mountAttachments } from "./chat/Attachments"
import { mountChatChrome } from "./chat/chat-chrome-mount"
import { mountMessageList, WELCOME_ITEM } from "./chat/MessageList"

// ── Attachments (composer's staged-file tray) ───────────────────────────
//
// Mirrors the ChatState/ChatLoop bridge below exactly: chat.html forward-
// declares `var Attachments` (== window.Attachments for a classic script)
// and every call site (submit/addFiles/paste/drop/clear, all inside async
// event handlers) calls that bare identifier - see Attachments.tsx's module
// doc for the mount itself and chat.html's own comment on the `var Attachments`
// declaration for why the assignment is safe here, not in chat.html's own
// end-of-script __MoonInternals block.
const attachmentsMount = mountAttachments({
  strip: document.getElementById("attachments-strip"),
  error: document.getElementById("attach-error"),
})

if (attachmentsMount) {
  const w = window as unknown as {
    Attachments?: unknown
    __MoonInternals?: { Attachments?: unknown }
  }
  w.Attachments = attachmentsMount.Attachments
  if (w.__MoonInternals) {
    w.__MoonInternals.Attachments = attachmentsMount.Attachments
  }
}

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

// ── Chat transcript (MessageList.tsx) ───────────────────────────────────
//
// chat.html's inline script is a classic (non-module) script, so it cannot
// `import` React/MessageList itself - it forward-declares `var ChatState` /
// `var ChatLoop` (== window.ChatState / window.ChatLoop for a classic
// script) and every frame handler calls those bare identifiers. This module
// script always runs after that classic script finishes (deferred
// type="module" load - see boot.tsx's header comment), so by the time
// mountMessageList runs, chat.html has already populated
// window.__MoonInternals.State (the live `State` object every frame handler
// mutates) - read through it here rather than declaring a competing
// `Window.__MoonInternals` augmentation (index.html's hub already claims
// that slot with an unrelated shape - see MessageList.tsx's own note).
interface ChatGlobalState {
  serverSupportsTurnComplete?: boolean
  activeThreadId?: string | null
  pinnedThread?: string | null
}

function getChatGlobalState(): ChatGlobalState | null {
  return (window as unknown as { __MoonInternals?: { State?: ChatGlobalState } }).__MoonInternals?.State ?? null
}

// The tool-card "view ↗" affordance (S4: open the live Agents panel for a
// top-level Agent/Task delegation) - reads State.activeThreadId /
// State.pinnedThread live, at click time, exactly like the vanilla
// buildToolStep's inline listener used to.
function openAgentsPanelForCurrentThread(): void {
  const state = getChatGlobalState()
  const thread = state?.activeThreadId || state?.pinnedThread || null
  if (!thread) return
  invokeTauri("open_widget", { kind: "agents", params: { thread } }).catch((err: unknown) => {
    console.warn("open agents panel failed:", err)
  })
}

const messageListMount = mountMessageList(document.getElementById("chat-messages"), {
  getGrouped: () => getChatGlobalState()?.serverSupportsTurnComplete !== false,
  onOpenAgentsPanel: openAgentsPanelForCurrentThread,
  // Shows the shipped welcome greeting until the first real turn lands (or
  // forever if the server never connects) - see chat.html's now-empty
  // #chat-messages: createRoot() clears any static markup on its first
  // commit, so the copy has to be a rendered React item, not static HTML.
  emptyStateItem: WELCOME_ITEM,
})

if (messageListMount) {
  const w = window as unknown as {
    ChatState?: unknown
    ChatLoop?: unknown
    __MoonInternals?: { ChatState?: unknown; ChatLoop?: unknown }
  }
  w.ChatState = messageListMount.ChatState
  w.ChatLoop = messageListMount.ChatLoop
  // Refresh the __MoonInternals copy too - chat.html's own end-of-script
  // assignment ran before this mount and captured the pre-mount `undefined`
  // placeholders (see the CHAT MODEL / RENDERER / LOOP comment there).
  if (w.__MoonInternals) {
    w.__MoonInternals.ChatState = messageListMount.ChatState
    w.__MoonInternals.ChatLoop = messageListMount.ChatLoop
  }
}
