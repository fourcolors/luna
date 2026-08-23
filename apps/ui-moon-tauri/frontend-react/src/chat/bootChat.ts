/**
 * bootChat.ts - the ONE boot sequence, used by production and by the tests
 * (stack23 S20d).
 *
 * Everything chat.html's inline <script> used to do, in the order it has to
 * happen. main-chat.tsx calls it; test/helpers/chat-harness.ts calls the same
 * function instead of evaluating chat.html.
 *
 * THAT SHARING IS THE POINT, NOT A CONVENIENCE. Until this slice the harness
 * re-implemented the order by hand, and that divergence caused two separate
 * multi-test failures in this arc alone: in S20b it built the frame layer
 * before the wire, so a destructured getter captured undefined; in S20c it
 * built the wire before the wiring, so `winLabel` was silently null and the
 * per-panel last-thread path stopped resolving. Both were harness-only bugs
 * that production never had. With one sequence the whole class is
 * unexpressible.
 *
 * THE ORDER IS LOAD-BEARING AND IS THE PRODUCT OF THE WHOLE S19/S20 ARC:
 *
 *   leaves + engines   nothing reaches the wire yet
 *   panel stack        secret > survey > suggestion share a precedence rule
 *   drawer + chat      two reference cycles, each built as one unit
 *   wiring             sets State.pinnedThread / winLabel, RETURNS boot params
 *   wire               reads those params AT CONSTRUCTION, not lazily
 *   frames             needs the real engines, so it comes after the wire
 *   boot()             ignition, last, when every collaborator exists
 *
 * ctx values are read at construction; only lambdas are lazy. That single
 * sentence explains most of the ordering constraints above.
 */
// (moved here from main-chat.tsx by S20d)
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
// pipeline and every other title-bar control (redock-btn)
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
import "./message-list.css"
// The transport surface PoolEngine reads as `window.LunaTransport`. Imported
// from the package's browser-safe subpath and re-published below, replacing
// the generated `vendor/ui-transport.js` IIFE this slice deletes (stack23
// S18). `./browser` exists precisely for this: it excludes the node: entry
// points (parseClientConfig, makeNodeTokenResolver, the dev stubs) that the
// package's "." export would pull in.
import * as LunaTransport from "@luna/ui-transport/browser"
import * as ThreadListLogic from "./threadList"
import * as ThreadStrip from "./threadStrip"
import * as ThreadCacheLogic from "./threadCache"
import * as ThreadCreateLogic from "./threadCreate"
import * as ThreadDrag from "./threadDrag"
import { createResultToasts } from "./resultToasts"
import { createUpdateBanner } from "./updateBanner"
import { Logger } from "./logger"
import { createMoonFace } from "./moonFace"
import { createMoonLife } from "./moonLife"
import { createMoonBar } from "./moonBar"
import { createSurveyEngine, buildSurveyVerdicts } from "./surveyEngine"
import { createLocalShell } from "./localShell"
import { createNotifier } from "./notifier"
import { MoonClient } from "./moonClient"
import { buildMessageCopyButton, buildMessageMeta, formatRelTime } from "./messageMeta"
import { createThreadDrawer, moonDragDebugNote } from "./threadDrawer"
import { createChatEngine, CSS_escape, splitSpeakableSentences, toSpeakable } from "./chatEngine"
import { createWire } from "./wire"
import { createState } from "./state"
import { createDom } from "./domMap"
import { createFrames } from "./frames"
import { installWiring } from "./wiring"
import { createSecretPromptEngine } from "./secretPromptEngine"
import { createSuggestedActionsEngine } from "./suggestedActionsEngine"
import { createFeedbackEngine, describeTarget, cropAndEncodeFeedbackScreenshot } from "./feedbackEngine"
import { createArtifactsEngine } from "./artifactsEngine"
import { mountMoonReactRoot } from "../boot"
import { mountAttachments } from "./Attachments"
import type { LunaChatHostApi } from "./luna-chat-host"
import { chatHostComposerCtx, chatHostSlashMenuCtx, getChatHost, setChatHost } from "./chat-host"
import { mountChatChrome } from "./chat-chrome-mount"
import { mountComposerConfig } from "./ComposerConfig"
import { mountMessageList, WELCOME_ITEM } from "./MessageList"
import { mountSlashMenu } from "./SlashMenu"
import { mountSmartBar } from "./SmartBarEngine"

/** Patches chat.html's forward-declared `var <name>` (== `window.<name>` for
 * a classic script) AND, when present, the `window.__MoonInternals.<name>`
 * copy chat.html's own end-of-script block captured before this module ever
 * mounted anything (see chat.html's "ChatState / ChatLoop / Attachments /
 * ComposerConfig / SlashMenu / SmartBarEngine: NOT assigned here" comment) -
 * one write site for the pattern every mount* call below repeats. This is
 * the module-to-classic-script direction; `window.LunaChatHost`
 * (chat-host.ts) is the opposite direction and is never touched here. */
function assignBridge(
  name:
    | "Attachments"
    | "ComposerConfig"
    | "SlashMenu"
    | "SmartBarEngine"
    | "ResultToasts"
    | "UpdateBanner"
    | "LocalShell"
    | "Notifier"
    | "MoonClient"
    | "formatRelTime"
    | "buildMessageMeta"
    | "buildMessageCopyButton"
    | "ThreadDrawerEngine"
    | "ThreadCache"
    | "ThreadCreateState"
    | "moonDragDebugNote"
    | "ChatEngine"
    | "VoiceEngine"
    | "CSS_escape"
    | "splitSpeakableSentences"
    | "toSpeakable"
    | "WebSocketEngine"
    | "PoolEngine"
    | "USE_POOL_ENGINE"
    | "ViewMode"
    | "SurveyEngine"
    | "SecretPromptEngine"
    | "SuggestedActionsEngine"
    | "buildSurveyVerdicts"
    | "MoonFace"
    | "MoonBar"
    | "FeedbackEngine"
    | "ArtifactsEngine"
    | "ChatState"
    | "ChatLoop"
    | "loadConnectionAndConnect",
  value: unknown,
): void {
  const w = window as unknown as Record<string, unknown> & { __MoonInternals?: Record<string, unknown> }
  w[name] = value
  if (w.__MoonInternals) {
    w.__MoonInternals[name] = value
  }
}


export function bootChat() {
  // The two leaves chat.html used to own. Per WINDOW, never module singletons:
  // every engine takes these BY REFERENCE and mutates them in place.
  const State = createState()
  const DOM = createDom()

  // Declared before the host so its members can close over it. They are all
  // lambdas and none is called until after boot(), so the assignment below
  // lands long before anything reads it.
  let wire: ReturnType<typeof createWire>

  // Published FIRST, because most ctx values below read State through it.
  // `state()` is live immediately; the wire members resolve later.
  // FROZEN, as chat.html published it. The contract is one-directional and its
  // membership is guarded in two places; a mutable host would let a test (or a
  // stray assignment) add a member that neither guard would ever see.
  const host: LunaChatHostApi = {
    state: () => State as never,
    send: (frame) => wire.WebSocketEngine.send(frame as never),
    isConnected: () => wire.WebSocketEngine.isConnected(),
    clearTurnTimeout: () => wire.WebSocketEngine.clearTurnTimeout(),
    startTurnTimeout: () => wire.WebSocketEngine.startTurnTimeout(),
    startSubscribeTimeout: () => wire.WebSocketEngine.startSubscribeTimeout(),
    sendNewThread: () => wire.WebSocketEngine.sendNewThread(),
  }
  setChatHost(Object.freeze(host))

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
  ;(window as unknown as { ThreadStrip: typeof ThreadStrip }).ThreadStrip = ThreadStrip
  ;(window as unknown as { ThreadCacheLogic: typeof ThreadCacheLogic }).ThreadCacheLogic = ThreadCacheLogic
  ;(window as unknown as { ThreadCreateLogic: typeof ThreadCreateLogic }).ThreadCreateLogic = ThreadCreateLogic
  ;(window as unknown as { ThreadDrag: typeof ThreadDrag }).ThreadDrag = ThreadDrag
  // One instance per window: the toast list owns real per-instance state.
  // Through assignBridge so the __MoonInternals copy is refreshed too - chat.html
  // captured the pre-mount `undefined`, and that copy is what the screenshot /
  // agent-browser harnesses read (see chat.html's own "#124 toast harness" note).
  const resultToasts = createResultToasts()
  assignBridge("ResultToasts", resultToasts)
  // The banner gets the REAL Logger now (S19f). It used to get a bare
  // and the real Logger when chat.html is the one constructing it. Only the
  // `warn` arm is used (apply_update / open-updates failures).
  const updateBanner = createUpdateBanner({ Logger })
  assignBridge("UpdateBanner", updateBanner)

  // ── The leaf controllers: LocalShell, Notifier, MoonClient (stack23 S19h) ──
  //
  // LocalShell is a SECURITY surface - the frame it sends is the authority for
  // what the agent may touch on this machine - so it moved character-identical.
  // State arrives from host.state(), the LIVE object, because `State.localShell`
  // is mutated in place rather than replaced.
  const localShell = createLocalShell({
    Logger,
    DOM: {
      scopeBtn: document.getElementById("scope-btn"),
      scopeMenu: document.getElementById("scope-menu"),
      scopeFullAccess: document.getElementById("scope-full-access"),
    },
    State: getChatHost()?.state(),
    WebSocketEngine: { send: (frame: unknown) => getChatHost()?.send(frame as never) },
  })
  // Called HERE, not at chat.html's top level, for the reason MoonFace.init()
  // moved in S19e: a classic-top-level call cannot see a module-published
  // global. It is only read when the capability frame goes out after hello.
  localShell.refreshPlatform()
  assignBridge("LocalShell", localShell)
  const notifier = createNotifier({ Logger })
  assignBridge("Notifier", notifier)
  assignBridge("MoonClient", MoonClient)
  // chat.html still reads formatRelTime (the drawer stamps, the msg-time refresh
  // listener); buildMessageMeta stays bridged only for __MoonInternals.
  assignBridge("formatRelTime", formatRelTime)
  assignBridge("buildMessageMeta", buildMessageMeta)
  assignBridge("buildMessageCopyButton", buildMessageCopyButton)

  // ── MoonFace + MoonBar (the header's expression + message zone, S19e) ───
  //
  // These two move together and FIRST in their group because they are the
  // outbound edges of SuggestedActionsEngine: that engine calls both, so neither
  // could stay a chat.html-private const if it was ever to follow (the
  // OUTBOUND-EDGE RULE). They in turn reach nothing but their own elements.
  //
  // init() IS CALLED HERE, not in chat.html. chat.html used to call it at
  // classic top level, where a module-published global is still undefined - so
  // the boot call relocates to the construction site rather than getting a shim.
  // It only reads the DOM, and this module is deferred, so later is still valid.
  const moonFace = createMoonFace({
    lunaFace: document.getElementById("luna-face"),
    lunaFaceStatus: document.getElementById("luna-face-status"),
  })
  // Gaze is the only rAF loop on the face; everything else is a CSS keyframe.
  const moonLife = createMoonLife({
    lunaFace: document.getElementById("luna-face"),
    lunaEyes: document.querySelector("#luna-face .luna-eyes"),
  })
  moonLife.start()
  const moonBar = createMoonBar({
    lunaQuip: document.getElementById("luna-quip"),
    lunaSuggestion: document.getElementById("luna-suggestion"),
    lunaSuggestionText: document.getElementById("luna-suggestion-text"),
  })
  moonFace.init()
  moonBar.init()
  assignBridge("MoonFace", moonFace)
  assignBridge("MoonBar", moonBar)

  // ── FeedbackEngine (point-at-the-UI crosshair, stack23 S19c) ────────────
  //
  // Constructed HERE rather than in chat.html because everything it needs is
  // already reachable through the EXISTING host contract - no new LunaChatHost
  // member, which matters because S19 is the slice that DELETES Group C rather
  // than growing it:
  //   WebSocketEngine.send -> host.send
  //   State.*              -> host.state(), which returns the LIVE object, so
  //                           capturing it once is the same reference chat.html
  //                           mutates (never a copy)
  //   DOM.*                -> eight element lookups, resolved here because the
  //                           deferred module runs after the body is parsed
  const feedbackEngine = createFeedbackEngine({
      DOM: {
        feedbackBtn: document.getElementById("feedback-btn"),
        feedbackPickerOverlay: document.getElementById("feedback-picker-overlay"),
        feedbackPickerHighlight: document.getElementById("feedback-picker-highlight"),
        feedbackPanel: document.getElementById("feedback-panel"),
        feedbackTargetChip: document.getElementById("feedback-target-chip"),
        feedbackInput: document.getElementById("feedback-input"),
        feedbackStatus: document.getElementById("feedback-status"),
        feedbackSubmit: document.getElementById("feedback-submit-btn"),
      },
      State: getChatHost()?.state(),
      isConnected: () => getChatHost()?.isConnected() ?? false,
      WebSocketEngine: { send: (frame: unknown) => getChatHost()?.send(frame as never) },
    })
  assignBridge("FeedbackEngine", feedbackEngine)

  // ── ArtifactsEngine (overlay panel, stack23 S19d) ───────────────────────
  //
  // The two markdown functions come from the vendor global rather than a
  // chat.html alias, because S19d deleted that alias block - this engine was its
  // last production reader. `renderMarkdown` is the AUDITED sanitizer; the
  // preview pane feeds untrusted artifact content through it, so it must stay
  // exactly that function and not a lookalike.
  const artifactsEngine = createArtifactsEngine({
      // Ids read from chat.html's own DOM object, not guessed - S19c and this
      // slice both cost time to a guessed list.
      DOM: {
        artifactsBtn: document.getElementById("artifacts-btn"),
        artifactsBadge: document.getElementById("artifacts-badge"),
        artifactsPanel: document.getElementById("artifacts-panel"),
        artifactsPinnedSection: document.getElementById("artifacts-pinned-section"),
        artifactsPinnedList: document.getElementById("artifacts-pinned-list"),
        artifactsSessionSection: document.getElementById("artifacts-session-section"),
        artifactsSessionList: document.getElementById("artifacts-session-list"),
        artifactsEmpty: document.getElementById("artifacts-empty"),
        artifactsPreview: document.getElementById("artifacts-preview"),
        artifactsPreviewTitle: document.getElementById("artifacts-preview-title"),
        artifactsPreviewCopy: document.getElementById("artifacts-preview-copy"),
        artifactsPreviewBody: document.getElementById("artifacts-preview-body"),
      },
      State: getChatHost()?.state(),
      WebSocketEngine: { send: (frame: unknown) => getChatHost()?.send(frame as never) },
      renderMarkdown: (md: string) =>
        (window as unknown as { LunaMarkdown: { renderMarkdown: (m: string) => string } }).LunaMarkdown.renderMarkdown(md),
      enhanceCodeBlocks: (root: unknown) =>
        (window as unknown as { LunaMarkdown: { enhanceCodeBlocks: (r: unknown) => void } }).LunaMarkdown.enhanceCodeBlocks(root),
    })
  assignBridge("ArtifactsEngine", artifactsEngine)

  // Test hooks that moved with the feedback cluster. chat.html exposed these two
  // directly until S19c; the namespace is unchanged so the suites reading them
  // need no edit.
  {
    const internals = (window as unknown as { __MoonInternals?: Record<string, unknown> }).__MoonInternals
    if (internals) {
      internals["describeTarget"] = describeTarget
      internals["cropAndEncodeFeedbackScreenshot"] = cropAndEncodeFeedbackScreenshot
    }
  }

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
      accountBtn: document.getElementById("account-cfg-btn"),
      accountMenu: document.getElementById("account-cfg-menu"),
      accountSep: document.getElementById("account-cfg-sep"),
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
      // Straight to the engine. These three were LunaChatHost's last Group C
      // members; S19k made ChatEngine a module and the category went to zero.
      // Late-bound: SlashMenu mounts before the engine is built, and a dispatch
      // can only happen on a user action, which is far later than either.
      getBackendCommands: () => frames.backendCapabilities(),
      executeCapability: (req) => frames.executeCapability(req),
      appendMessage: (role: string, text: string) => chatEngine.ChatEngine.appendMessage(role, text),
      newConversation: () => chatEngine.ChatEngine.newConversation(),
      autoGrowMessageInput: () => chatEngine.ChatEngine.autoGrowMessageInput(),
      // Straight to the module. This used to be
      // `getChatHost()?.closeLocalShellMenu()`, a Group C member that existed
      // only to bridge module -> vanilla const. S19h DELETED it.
      closeLocalShellMenu: () => localShell.openMenu(false),
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

  // ── The thread drawer knot (stack23 S19j) ───────────────────────────────
  //
  // Built as ONE unit because ThreadCache and ThreadDrawerEngine reference each
  // other (#484). The five logic modules it takes have been modules since S17;
  // this slice is what finally gives them a module-side owner instead of a
  // chat.html const calling into them.
  const threadDrawer = createThreadDrawer({
    Logger,
    DOM: {
      chatPanel: document.getElementById("chat-panel"),
      threadDrawer: document.getElementById("thread-drawer"),
      threadDrawerList: document.getElementById("thread-drawer-list"),
      threadDrawerEmpty: document.getElementById("thread-drawer-empty"),
      threadDivider: document.getElementById("thread-divider"),
      // The title-bar disclosure control for this drawer. _applyWidth keeps
      // its lit/aria-expanded state in lockstep with the panel, so it has to
      // be in the drawer's OWN DOM slice - the global map is not what this
      // module reads.
      toggleThreads: document.getElementById("toggle-threads"),
    },
    State: getChatHost()?.state() as never,
    WebSocketEngine: {
      send: (frame: unknown) => getChatHost()?.send(frame as never),
      isConnected: () => getChatHost()?.isConnected() ?? false,
      clearTurnTimeout: () => getChatHost()?.clearTurnTimeout(),
      startSubscribeTimeout: () => getChatHost()?.startSubscribeTimeout(),
    },
    // The WHOLE objects, not a narrowed {reset}/{flush}. The drawer's own
    // text only calls those two, but it hands ChatState/ChatLoop straight
    // through to ThreadCacheLogic, which uses more of them - a narrowed stub
    // made ThreadCache.paint() return false with nothing else failing.
    ChatState: messageListMount?.ChatState as never,
    ChatLoop: messageListMount?.ChatLoop as never,
    MoonFace: moonFace,
    ThreadListLogic,
    ThreadStrip,
    ThreadCacheLogic,
    ThreadCreateLogic,
    ThreadDrag,
    formatRelTime,
    // Late-bound: suggestedActionsEngine is constructed further down, so this
    // closure resolves it at call time. Thread switches are user-driven and
    // always happen long after boot, so the binding is always live by then.
    onThreadSwitch: () => { suggestedActionsEngine.refresh() },
    LunaThreadDrag: (window as unknown as { LunaThreadDrag?: unknown }).LunaThreadDrag,
  })
  assignBridge("ThreadDrawerEngine", threadDrawer.ThreadDrawerEngine)
  assignBridge("ThreadCache", threadDrawer.ThreadCache)
  assignBridge("ThreadCreateState", threadDrawer.ThreadCreateState)
  assignBridge("moonDragDebugNote", moonDragDebugNote)

  // ── ChatEngine + VoiceEngine (stack23 S19k) ─────────────────────────────
  //
  // One factory because they reference each other. Every collaborator is passed
  // WHOLE rather than narrowed to the members this call site can see used -
  // S19j lost time to exactly that narrowing.
  const chatEngine = createChatEngine({
    Logger,
    DOM: {
      chatMessages: document.getElementById("chat-messages"),
      messageInput: document.getElementById("message-input"),
      chatForm: document.getElementById("chat-form"),
      moonWrapper: document.getElementById("moon-wrapper"),
    },
    State: getChatHost()?.state() as never,
    WebSocketEngine: {
      send: (frame: unknown) => getChatHost()?.send(frame as never),
      isConnected: () => getChatHost()?.isConnected() ?? false,
      clearTurnTimeout: () => getChatHost()?.clearTurnTimeout(),
      startTurnTimeout: () => getChatHost()?.startTurnTimeout(),
      sendNewThread: () => getChatHost()?.sendNewThread(),
    },
    ChatState: messageListMount?.ChatState as never,
    ChatLoop: messageListMount?.ChatLoop as never,
    MoonFace: moonFace,
    MoonClient,
    SlashMenu: slashMenuMount?.SlashMenu as never,
    Attachments: attachmentsMount?.Attachments as never,
    ThreadCache: threadDrawer.ThreadCache,
  })
  assignBridge("ChatEngine", chatEngine.ChatEngine)
  assignBridge("VoiceEngine", chatEngine.VoiceEngine)
  assignBridge("CSS_escape", CSS_escape)
  assignBridge("splitSpeakableSentences", splitSpeakableSentences)
  assignBridge("toSpeakable", toSpeakable)
  // Relocated from chat.html's top level (S19k). It was already
  // fire-and-forget with a non-fatal catch, so running a tick later changes
  // nothing except that the engine now exists when it is called.
  Promise.resolve(chatEngine.VoiceEngine.init()).catch((e: unknown) =>
    Logger.warn("Voice init failed (non-fatal):", e),
  )

  // ── The docked panel stack: secret > survey > suggestion (stack23 S19f) ──
  //
  // All three move in ONE slice because the precedence rule spans them:
  // SuggestedActionsEngine hides its chip by reading the OTHER TWO panels'
  // `hidden` flags. Splitting them would have put that rule across the boundary.
  //
  // State arrives from host.state(), which returns the LIVE object chat.html
  // mutates - never a copy. That matters most for SecretPromptEngine, whose
  // OPEN-socket guard reads `State.ws` and must see the CURRENT socket after a
  // reconnect, not the one that existed when this module ran.
  const byId = (id: string) => document.getElementById(id)

  assignBridge("buildSurveyVerdicts", buildSurveyVerdicts)

  const surveyEngine = createSurveyEngine({
      Logger,
      DOM: {
        userAskPanel: byId("user-ask-panel"),
        userAskBody: byId("user-ask-body"),
        userAskHint: byId("user-ask-hint"),
        userAskSubmit: byId("user-ask-submit"),
      },
      WebSocketEngine: { send: (frame: unknown) => getChatHost()?.send(frame as never) },
      // The REAL pair, captured from the MessageList mount above rather than
      // routed through host.appendMessage. appendBanner renders a PLAIN-TEXT
      // bubble; appendMessage renders markdown, which would have turned the
      // survey confirmation into a different thing.
      ChatState: { appendBanner: (text: string) => messageListMount?.ChatState.appendBanner(text) },
      ChatLoop: { flush: () => messageListMount?.ChatLoop.flush() },
    })
  assignBridge("SurveyEngine", surveyEngine)

  const secretPromptEngine = createSecretPromptEngine({
      Logger,
      DOM: {
        secretPromptPanel: byId("secret-prompt-panel"),
        secretPromptPrompt: byId("secret-prompt-prompt"),
        secretPromptConsent: byId("secret-prompt-consent"),
        secretPromptInput: byId("secret-prompt-input"),
        secretPromptStatus: byId("secret-prompt-status"),
      },
      isConnected: () => getChatHost()?.isConnected() ?? false,
      WebSocketEngine: { send: (frame: unknown) => getChatHost()?.send(frame as never) },
    })
  assignBridge("SecretPromptEngine", secretPromptEngine)

  // MoonBar/MoonFace are passed as the very instances constructed above -
  // module to module, with no bridge in between. That is the whole payoff of
  // having moved them first in S19e.
  const suggestedActionsEngine = createSuggestedActionsEngine({
      DOM: {
        suggestedActionPanel: byId("suggested-action-panel"),
        suggestedActionType: byId("suggested-action-type"),
        suggestedActionText: byId("suggested-action-text"),
        suggestedActionRationale: byId("suggested-action-rationale"),
        secretPromptPanel: byId("secret-prompt-panel"),
        userAskPanel: byId("user-ask-panel"),
      },
      State: getChatHost()?.state(),
      WebSocketEngine: { send: (frame: unknown) => getChatHost()?.send(frame as never) },
      MoonBar: moonBar,
      MoonFace: moonFace,
    })
  assignBridge("SuggestedActionsEngine", suggestedActionsEngine)



  // ── DOM event wiring + boot params (stack23 S20c) ───────────────────────
  //
  // AFTER every engine (its 33 listeners call them) and BEFORE the wire (which
  // needs the params, and whose boot reads the State.pinnedThread this sets).
  // Nothing here touches the wire, which is what makes that slot available.
  //
  // IGNITION ISOLATION (0.0.71 / #563): composer chrome wiring must never
  // skip wire.boot(). installWiring derives boot params first and catches
  // chrome throws; this try/catch is belt-and-suspenders so a total abort
  // still leaves URL-derived params and we reach connect().
  let SPAWN_FRESH: boolean
  let PINNED_THREAD: string | null
  let INITIAL_VIEW_MODE: boolean
  try {
    ;({ SPAWN_FRESH, PINNED_THREAD, INITIAL_VIEW_MODE } = installWiring({
      Logger,
      DOM: DOM as never,
      State: getChatHost()?.state() as never,
      engines: {
        ArtifactsEngine: artifactsEngine,
        Attachments: attachmentsMount?.Attachments,
        ChatLoop: messageListMount?.ChatLoop,
        ChatState: messageListMount?.ChatState,
        ComposerConfig: composerConfigMount?.ComposerConfig,
        FeedbackEngine: feedbackEngine,
        LocalShell: localShell,
        SecretPromptEngine: secretPromptEngine,
        SlashMenu: slashMenuMount?.SlashMenu,
        SuggestedActionsEngine: suggestedActionsEngine,
        SurveyEngine: surveyEngine,
        ThreadCache: threadDrawer.ThreadCache,
        ThreadDrawerEngine: threadDrawer.ThreadDrawerEngine,
        ChatEngine: chatEngine.ChatEngine,
        VoiceEngine: chatEngine.VoiceEngine,
        formatRelTime,
        buildMessageMeta,
        moonDragDebugNote,
      },
    }))
  } catch (err) {
    Logger.error(
      "installWiring aborted; using URL boot params so wire.boot() still dials:",
      err,
    )
    const threadParam = new URLSearchParams(location.search).get("thread") || null
    SPAWN_FRESH = threadParam === "new"
    PINNED_THREAD = SPAWN_FRESH ? null : threadParam
    INITIAL_VIEW_MODE = new URLSearchParams(location.search).get("viewMode") === "true"
    const st = getChatHost()?.state() as { pinnedThread?: string | null } | undefined
    if (st) st.pinnedThread = PINNED_THREAD
  }

  // The drawer's two boot calls run HERE, not at its construction: wireDivider is
  // gated on State.pinnedThread, which installWiring above is what sets.
  try {
    threadDrawer.ThreadDrawerEngine.initSidebar()
    if (!getChatHost()?.state().pinnedThread) {
      threadDrawer.ThreadDrawerEngine.wireDivider(document.getElementById("thread-divider"))
    }
  } catch (err) {
    Logger.error("thread drawer boot failed (non-fatal; connect continues):", err)
  }

  // ── The wire, and its ignition (stack23 S20a) ───────────────────────────
  //
  // Both socket engines plus loadConnectionAndConnect. The ignition moved with
  // them because its SYNCHRONOUS prefix reaches connect() in a plain browser, so
  // a module-published engine would have been undefined exactly when boot needed
  // it - fine in the installed Tauri app, broken in dev and every test.
  //
  // SPAWN_FRESH / PINNED_THREAD are derived ONCE, here, and passed in: `new` is a
  // SENTINEL meaning "mint your own fresh thread", not a real thread id, and two
  // readers of that rule is one too many.
  wire = createWire({
    Logger,
    DOM: {
      connectionStatus: document.getElementById("connection-status"),
      routeIndicator: document.getElementById("route-indicator"),
      // Step 4: the inner span _paintRouteIndicator writes text into - see
      // chat.html's CSS comment on #route-indicator-text for why the
      // ellipsis rule cannot live on the flex/dot-owning outer element.
      routeIndicatorText: document.getElementById("route-indicator-text"),
      buildSha: document.getElementById("build-sha"),
      modelSelect: document.getElementById("model-select"),
      secretPromptInput: document.getElementById("secret-prompt-input"),
    },
    State: getChatHost()?.state() as never,
    MoonFrames: { dispatch: (frame: unknown) => frames.dispatch(frame) },
    ChatEngine: chatEngine.ChatEngine as never,
    ChatState: messageListMount?.ChatState as never,
    ChatLoop: messageListMount?.ChatLoop as never,
    ComposerConfig: composerConfigMount?.ComposerConfig as never,
    MoonBar: moonBar as never,
    MoonFace: moonFace as never,
    ThreadCreateState: threadDrawer.ThreadCreateState as never,
    ThreadDrawerEngine: threadDrawer.ThreadDrawerEngine as never,
    MOON_EXPECTED_PROTOCOL_VERSION: (window as unknown as { LunaProtocol?: { PROTOCOL_VERSION: number } })
      .LunaProtocol?.PROTOCOL_VERSION ?? 2,
    SPAWN_FRESH,
    PINNED_THREAD,
    winLabel: (getChatHost()?.state() as { winLabel?: string | null } | undefined)?.winLabel ?? null,
  })
  assignBridge("WebSocketEngine", wire.WebSocketEngine)
  assignBridge("PoolEngine", wire.PoolEngine)
  assignBridge("USE_POOL_ENGINE", wire.USE_POOL_ENGINE)
  assignBridge("ViewMode", wire.ViewMode)
  // View mode (plan Step 3): a detached floater boots verbose when its
  // source window was verbose at drag-out time (threadDrawer.ts stamps
  // ?viewMode= into open_widget's params; wiring.ts reads it back as
  // INITIAL_VIEW_MODE). Applied here, once, right after ViewMode exists -
  // never touches the socket, so it cannot race or interact with connect().
  if (INITIAL_VIEW_MODE) wire.ViewMode.enable()
  // View mode toggle: clicking the route indicator chip flips this window's
  // verbose view. The chip only ever appears when PoolEngine paints it
  // (see wire.ts's F2 comment) - a window whose chip stays hidden (no route
  // model, or the legacy WebSocketEngine escape hatch) has nothing to
  // click, and that is by design, not an oversight: there is no separate
  // toggle affordance to hide alongside it.
  //
  // KEYBOARD (F1, opus review on plan Step 3): role="button" alone does not
  // make Enter/Space activate a <span> - only a real <button> element
  // synthesizes click from keys, and a span never does (WCAG 2.1.1). The
  // role/tabindex without this handler was decorative: focusable and
  // announced as a button, but silently inert from the keyboard. Space
  // additionally gets preventDefault() so it toggles instead of scrolling
  // the page (the browser's default action for Space on a non-form,
  // non-naturally-interactive element).
  {
    const routeIndicatorEl = document.getElementById("route-indicator")
    if (routeIndicatorEl) {
      routeIndicatorEl.setAttribute("role", "button")
      routeIndicatorEl.setAttribute("tabindex", "0")
      routeIndicatorEl.addEventListener("click", () => {
        wire.ViewMode.toggle()
      })
      routeIndicatorEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          if (e.key !== "Enter") e.preventDefault()
          wire.ViewMode.toggle()
        }
      })
    }
  }
  // wiring.ts's hub-event listener (installed BEFORE this function runs, so
  // it cannot receive loadConnectionAndConnect as a constructor param) looks
  // this up late via the BARE window.loadConnectionAndConnect global (never
  // window.__MoonInternals.loadConnectionAndConnect - see wire.ts's doc
  // comment on the returned loadConnectionAndConnect field for why reading
  // through the test-only mirror was itself a production bug) on a
  // profile-changed/connection-changed event.
  //
  // INVARIANT (F2, opus review on Step 1c): bootChat() stays SYNCHRONOUS
  // from installWiring() through this assignBridge call. wiring.ts's
  // hub-event handler cannot fire until AFTER this function returns (event
  // listeners only run on a later microtask/macrotask), so this bridge is
  // always populated by the time it's read - THAT is what makes the
  // "install before construct" ordering safe. If bootChat() is ever made
  // async, or ANY `await` is introduced between installWiring() and this
  // line, that guarantee breaks: an event could fire while the bridge is
  // still unset, silently stranding a window on stale credentials (the
  // wiring.ts F2 guard makes that failure loud, but the right fix is to
  // never let it happen). Keep this span synchronous.
  assignBridge("loadConnectionAndConnect", wire.loadConnectionAndConnect)

  // Never retain a typed secret across a socket drop. Clear the VALUE only - do
  // NOT hide the panel, so the success flow's brief "saved" message (server
  // restarts, socket closes, auto-reconnect) is not killed early. Relocated from
  // chat.html's top level with the engine it registers on.
  wire.WebSocketEngine.registerCloseHook(() => {
    const el = document.getElementById("secret-prompt-input") as HTMLInputElement | null
    if (el) el.value = ""
  })

  // ── The frame layer (stack23 S20b) ──────────────────────────────────────
  //
  // Constructed AFTER the wire, so the engines arrive as real objects rather
  // than getters. The reverse edge - the wire dispatching INTO here - is safe
  // because its `dispatch` is a lambda that closes over `frames` and is only
  // ever called on an inbound frame, which cannot happen before boot() below.
  //
  // Destructuring is why the order matters: `const { WebSocketEngine } =
  // ctx.engines` runs ONCE at construction, so a getter here would have been
  // read eagerly and captured undefined.
  const frames = createFrames({
    Logger,
    State: getChatHost()?.state() as never,
    SPAWN_FRESH,
    PINNED_THREAD,
    winLabel: (getChatHost()?.state() as { winLabel?: string | null } | undefined)?.winLabel ?? null,
    engines: {
      ArtifactsEngine: artifactsEngine,
      ChatEngine: chatEngine.ChatEngine,
      ChatLoop: messageListMount?.ChatLoop,
      ChatState: messageListMount?.ChatState,
      ComposerConfig: composerConfigMount?.ComposerConfig,
      FeedbackEngine: feedbackEngine,
      LocalShell: localShell,
      MoonClient,
      MoonFace: moonFace,
      Notifier: notifier,
      ResultToasts: resultToasts,
      SecretPromptEngine: secretPromptEngine,
      SmartBarEngine: smartBarMount?.SmartBarEngine,
      SuggestedActionsEngine: suggestedActionsEngine,
      SurveyEngine: surveyEngine,
      ThreadCache: threadDrawer.ThreadCache,
      ThreadCreateState: threadDrawer.ThreadCreateState,
      ThreadDrawerEngine: threadDrawer.ThreadDrawerEngine,
      VoiceEngine: chatEngine.VoiceEngine,
      PoolEngine: wire.PoolEngine,
      WebSocketEngine: wire.WebSocketEngine,
    },
  })

  // IGNITION LAST. Everything the engines reach is constructed by this point,
  // which is the property chat.html's top-level call could not offer a module.
  wire.boot()

  return {
    State,
    DOM,
    updateBanner,
    wire,
    frames,
    threadDrawer,
    chatEngine,
    messageListMount,
    attachmentsMount,
    composerConfigMount,
    slashMenuMount,
    smartBarMount,
    localShell,
    notifier,
    resultToasts,
    moonFace,
    moonBar,
    feedbackEngine,
    artifactsEngine,
    surveyEngine,
    secretPromptEngine,
    suggestedActionsEngine,
  }
}
