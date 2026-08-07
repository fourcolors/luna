// main-chat.tsx - React 19 + Astryx boot entry for chat.html.
//
// Mounts the invisible boot probe (see boot.tsx), the React-owned title-bar
// chrome shared with widget.html (chat/chat-chrome-mount.tsx: `.bar-title` +
// `.collapse-moon-btn`), the chat transcript (chat/MessageList.tsx, stack23
// S15) into `#chat-messages`, the composer's staged-attachment tray
// (chat/Attachments.tsx, stack23 S16a) into `#attachments-strip` /
// `#attach-error`, the composer's model + effort switcher
// (chat/ComposerConfig.tsx, stack23 S16b) into the composer-config cluster,
// the "/command" popover (chat/SlashMenu.tsx, stack23 S16c) into
// `#slash-menu`, and - as of stack23 S16d, completing the composer arc - the
// context-pill Smart Bar (chat/SmartBarEngine.tsx) into `#smart-bar`.
// chat.html's WebSocketEngine/PoolEngine/ThreadDrawerEngine-driven wire
// pipeline and every other title-bar control (new-thread-btn, redock-btn)
// keep running completely unchanged in chat.html's own inline <script> - see
// chat-chrome-mount.tsx's module doc for the chrome scope rationale,
// MessageList.tsx's module doc for the transcript-conversion seam (the
// `window.ChatState` / `window.ChatLoop` bridge this file assigns below),
// Attachments.tsx's / ComposerConfig.tsx's / SlashMenu.tsx's / SmartBarEngine
// .tsx's module docs for the `window.Attachments` / `window.ComposerConfig` /
// `window.SlashMenu` / `window.SmartBarEngine` bridges assigned the same way
// (module -> classic-script, the reverse direction), and chat-host.ts's
// module doc for the classic-script -> module direction this file reads
// FROM (`window.LunaChatHost`, stack23 S16c-host).
import "./chat/message-list.css"
// The transport surface PoolEngine reads as `window.LunaTransport`. Imported
// from the package's browser-safe subpath and re-published below, replacing
// the generated `vendor/ui-transport.js` IIFE this slice deletes (stack23
// S18). `./browser` exists precisely for this: it excludes the node: entry
// points (parseClientConfig, makeNodeTokenResolver, the dev stubs) that the
// package's "." export would pull in.
import * as LunaTransport from "@luna/ui-transport/browser"
import * as ThreadListLogic from "./chat/threadList"
import { mountMoonReactRoot } from "./boot"
import { mountAttachments } from "./chat/Attachments"
import { chatHostComposerCtx, chatHostSlashMenuCtx, getChatHost } from "./chat/chat-host"
import { mountChatChrome } from "./chat/chat-chrome-mount"
import { mountComposerConfig } from "./chat/ComposerConfig"
import { mountMessageList, WELCOME_ITEM } from "./chat/MessageList"
import { mountSlashMenu } from "./chat/SlashMenu"
import { mountSmartBar } from "./chat/SmartBarEngine"

/** Patches chat.html's forward-declared `var <name>` (== `window.<name>` for
 * a classic script) AND, when present, the `window.__MoonInternals.<name>`
 * copy chat.html's own end-of-script block captured before this module ever
 * mounted anything (see chat.html's "ChatState / ChatLoop / Attachments /
 * ComposerConfig / SlashMenu / SmartBarEngine: NOT assigned here" comment) -
 * one write site for the pattern every mount* call below repeats. This is
 * the module-to-classic-script direction; `window.LunaChatHost`
 * (chat-host.ts) is the opposite direction and is never touched here. */
function assignBridge(
  name: "Attachments" | "ComposerConfig" | "SlashMenu" | "SmartBarEngine" | "ChatState" | "ChatLoop",
  value: unknown,
): void {
  const w = window as unknown as Record<string, unknown> & { __MoonInternals?: Record<string, unknown> }
  w[name] = value
  if (w.__MoonInternals) {
    w.__MoonInternals[name] = value
  }
}

// ── Transport global (stack23 S18) ──────────────────────────────────────
//
// Republishes the ESM transport under the SAME `window.LunaTransport` name
// and shape the deleted `vendor/ui-transport.js` IIFE published, so
// chat.html's PoolEngine keeps reading its one call site unchanged. The
// vendor file was a CJS build of this exact module wrapped in an IIFE that
// assigned `module.exports` to the global; a namespace import IS that object,
// so the swap is shape-identical by construction rather than by hand-mirroring
// a member list.
//
// Assignment order is not delicate here, but it is deliberately FIRST among
// this file's side effects: PoolEngine's only read (`const LT =
// window.LunaTransport`) happens inside a method during connect, never at
// chat.html's classic-script top level, so any point before first connect
// would do - see that call site's own fallback branch.
;(window as unknown as { LunaTransport: typeof LunaTransport }).LunaTransport = LunaTransport

// ── Thread list logic (stack23 S17) ─────────────────────────────────────
//
// The drawer's pure selection-and-ordering functions. Published under the
// name chat.html forward-declares, so ThreadDrawerEngine's delegating
// methods resolve it at call time.
//
// This moves ahead of the rest of the drawer deliberately: S17 lands as one
// cohesive slice because render/_renderRow/_wireRow form a DOM-ownership
// cycle, and these functions touch no DOM, so they carry none of that risk.
// See threadList.ts's module doc.
;(window as unknown as { ThreadListLogic: typeof ThreadListLogic }).ThreadListLogic = ThreadListLogic

// ── Attachments (composer's staged-file tray) ───────────────────────────
//
// See Attachments.tsx's module doc for the mount itself and chat.html's own
// comment on the `var Attachments` declaration for why every call site
// (submit/addFiles/paste/drop/clear, all inside async event handlers) can
// keep calling that same bare identifier.
const attachmentsMount = mountAttachments({
  strip: document.getElementById("attachments-strip"),
  error: document.getElementById("attach-error"),
})

if (attachmentsMount) assignBridge("Attachments", attachmentsMount.Attachments)

// ── ComposerConfig (model + effort switcher) ────────────────────────────
//
// See ComposerConfig.tsx's module doc for the mount itself and chat.html's
// own comment on the `var ComposerConfig` declaration. `chatHostComposerCtx()`
// reads chat.html's live `State` object and sends over the live WS
// connection through `window.LunaChatHost` (chat-host.ts), exactly like
// `getChatHost()` below reads `State` for the transcript - both are
// populated by chat.html's classic script before this module ever runs.
const composerConfigMount = mountComposerConfig(
  {
    cluster: document.getElementById("composer-config"),
    modelBtn: document.getElementById("model-cfg-btn"),
    modelMenu: document.getElementById("model-cfg-menu"),
    effortBtn: document.getElementById("effort-cfg-btn"),
    effortMenu: document.getElementById("effort-cfg-menu"),
    effortSep: document.getElementById("effort-cfg-sep"),
    deferredHint: document.getElementById("cfg-deferred-hint"),
  },
  chatHostComposerCtx(),
)

if (composerConfigMount) assignBridge("ComposerConfig", composerConfigMount.ComposerConfig)

// ── SlashMenu ("/command" popover) ──────────────────────────────────────
//
// See SlashMenu.tsx's module doc for the mount itself and chat.html's own
// comment on the `var SlashMenu` declaration. `chatHostSlashMenuCtx()`'s two
// peers (`getComposerConfig`/`clearAttachments`) are React-module-to-React-
// module dependencies, DIRECT-passed here rather than laundered through a
// global - see chat-host.ts's module doc. Mounted AFTER ComposerConfig so
// `getComposerConfig()` has a real bridge to read the instant a user first
// types "/" - not required for correctness (every SlashMenu ctx call is
// lazy, read at interaction time, never at mount time), just keeps the
// mount order matching this module's own dependency order.
const slashMenuMount = mountSlashMenu(
  {
    menu: document.getElementById("slash-menu"),
    messageInput: document.getElementById("message-input") as HTMLTextAreaElement | null,
    modelMenu: document.getElementById("model-cfg-menu"),
    modelBtn: document.getElementById("model-cfg-btn"),
    effortMenu: document.getElementById("effort-cfg-menu"),
    effortBtn: document.getElementById("effort-cfg-btn"),
  },
  chatHostSlashMenuCtx({
    getComposerConfig: () => composerConfigMount?.ComposerConfig ?? null,
    clearAttachments: () => attachmentsMount?.Attachments.clear(),
  }),
)

if (slashMenuMount) assignBridge("SlashMenu", slashMenuMount.SlashMenu)

// ── SmartBarEngine (context-pill Smart Bar) ─────────────────────────────
//
// See SmartBarEngine.tsx's module doc for the mount itself and chat.html's
// own comment on the `var SmartBarEngine` declaration. No ctx object: this
// module reads no chat.html state - it only paints whatever `frame.items`
// the `smart-bar` frame handler hands to `applyFrame`.
const smartBarMount = mountSmartBar(document.getElementById("smart-bar"))

if (smartBarMount) assignBridge("SmartBarEngine", smartBarMount.SmartBarEngine)

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
// mountMessageList runs, chat.html has already published
// `window.LunaChatHost` (chat-host.ts) - read through `getChatHost()` here,
// the same seam SlashMenu.tsx/ComposerConfig.tsx read `State` through.

// The tool-card "view ↗" affordance (S4: open the live Agents panel for a
// top-level Agent/Task delegation) - reads State.activeThreadId /
// State.pinnedThread live, at click time, exactly like the vanilla
// buildToolStep's inline listener used to.
function openAgentsPanelForCurrentThread(): void {
  const state = getChatHost()?.state()
  const thread = state?.activeThreadId || state?.pinnedThread || null
  if (!thread) return
  invokeTauri("open_widget", { kind: "agents", params: { thread } }).catch((err: unknown) => {
    console.warn("open agents panel failed:", err)
  })
}

const messageListMount = mountMessageList(document.getElementById("chat-messages"), {
  getGrouped: () => getChatHost()?.state().serverSupportsTurnComplete !== false,
  onOpenAgentsPanel: openAgentsPanelForCurrentThread,
  // Shows the shipped welcome greeting until the first real turn lands (or
  // forever if the server never connects) - see chat.html's now-empty
  // #chat-messages: createRoot() clears any static markup on its first
  // commit, so the copy has to be a rendered React item, not static HTML.
  emptyStateItem: WELCOME_ITEM,
})

if (messageListMount) {
  // Refreshes the __MoonInternals copy too - chat.html's own end-of-script
  // assignment ran before this mount and captured the pre-mount `undefined`
  // placeholders (see the CHAT MODEL / RENDERER / LOOP comment there).
  assignBridge("ChatState", messageListMount.ChatState)
  assignBridge("ChatLoop", messageListMount.ChatLoop)
}
