/**
 * chat-harness.ts - the shared jsdom loader for frontend-react/chat.html's
 * classic inline script AND its React module graph (stack23 S15's chat
 * transcript conversion, S16a's attachments-tray conversion, S16b's composer
 * model/effort switcher conversion, S16c's SlashMenu conversion, and S16d's
 * SmartBarEngine conversion). Used by chat-window.test.ts, ws-contract.test.ts,
 * slash-menu.test.ts and composer-config.test.ts so a future conversion
 * slice (more of chat.html's inline script moving into src/chat/*.tsx) only
 * ever has to update THIS file, not each test file's own beforeEach.
 *
 * THE WALL this works around: chat.html's inline <script> is a classic
 * (non-module) script. In the real page it runs at true top level, so its
 * `var ChatState;` / `var ChatLoop;` / `var Attachments;` / `var
 * ComposerConfig;` / `var SlashMenu;` / `var SmartBarEngine;`
 * forward-declarations (see chat.html's "CHAT MODEL / RENDERER / LOOP"
 * comment and its Attachments/ComposerConfig/SlashMenu/SmartBarEngine
 * comments) ARE `window.ChatState` / `window.ChatLoop` / `window.Attachments`
 * / `window.ComposerConfig` / `window.SlashMenu` / `window.SmartBarEngine` -
 * every bare reference anywhere on the page, including from main-chat.tsx's
 * `type="module"` script that runs after it, resolves to the SAME global
 * binding.
 *
 * `new Function(src)()` does not have that property: it hands the script a
 * fresh function-call scope, so `var ChatState` is LOCAL to that one
 * invocation, not a real `window` property. Assigning `window.ChatState = …`
 * from OUTSIDE that call (the way main-chat.tsx does in the browser) only
 * ever creates a same-named but DIFFERENT binding - every closure the
 * classic script itself defined (ChatEngine.appendToolCallCard, the
 * WebSocketEngine frame handlers, …) would keep reading their own local
 * `undefined` forever. `evalChatInlineScriptWithBridge` fixes this by
 * appending the bridge assignment (ChatState/ChatLoop/Attachments/
 * ComposerConfig/SlashMenu/SmartBarEngine) as literal source text onto the
 * SAME `new Function(...)` body, so it runs in the SAME scope as the `var`
 * declarations and can actually reassign them.
 *
 * jsdom vs happy-dom: not a concern here - apps/ui-moon-tauri has exactly
 * one environment (`@vitest-environment jsdom` on every suite, incl. this
 * one's MessageList.tsx import), so importing the real module graph
 * alongside the classic-script eval never crosses a DOM implementation.
 *
 * SYNCHRONOUS COMMITS: `mountMessageList`'s `createRoot(...).render(...)`
 * and `ChatLoop.schedule()`'s rAF-deferred `store.notify()` both go through
 * React's own (non-`act()`) scheduler, which does NOT commit synchronously
 * just because a test stubs `requestAnimationFrame` to invoke its callback
 * inline - confirmed empirically: a bare `store.notify()` right after mount
 * leaves the container with zero children even though the reducer state is
 * already up to date. `mountChatMessageListBridge` wraps the initial mount
 * in `flushSync`, and `installSyncRequestAnimationFrame` wraps the stubbed
 * rAF callback in `flushSync` too, so a synchronous rAF stub really does
 * yield a synchronously-painted DOM, matching every existing assertion's
 * assumption (inherited from the pre-conversion imperative renderer, which
 * had no scheduler to defer through).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { expect } from 'vitest'
import { flushSync } from 'react-dom'
import { mountAttachments, type AttachmentsMount } from '../../frontend-react/src/chat/Attachments'
import { chatHostComposerCtx, chatHostSlashMenuCtx, getChatHost } from '../../frontend-react/src/chat/chat-host'
import { mountComposerConfig, type ComposerConfigMount } from '../../frontend-react/src/chat/ComposerConfig'
import { mountMessageList, type ChatMessageListMount } from '../../frontend-react/src/chat/MessageList'
import { mountSlashMenu, type SlashMenuMount } from '../../frontend-react/src/chat/SlashMenu'
import { mountSmartBar, type SmartBarMount } from '../../frontend-react/src/chat/SmartBarEngine'
// Pure drawer selection/ordering logic. chat.html forward-declares
// `var ThreadListLogic` and ThreadDrawerEngine delegates to it, so the harness
// must publish it exactly as main-chat.tsx does in the shipped page (S17).
import * as ThreadListLogic from '../../frontend-react/src/chat/threadList'
import * as ThreadStrip from '../../frontend-react/src/chat/threadStrip'
import * as ThreadCacheLogic from '../../frontend-react/src/chat/threadCache'
import * as ThreadCreateLogic from '../../frontend-react/src/chat/threadCreate'
import * as ThreadDrag from '../../frontend-react/src/chat/threadDrag'
import { createResultToasts } from '../../frontend-react/src/chat/resultToasts'
import { createUpdateBanner } from '../../frontend-react/src/chat/updateBanner'
import { createFeedbackEngine, describeTarget, cropAndEncodeFeedbackScreenshot } from '../../frontend-react/src/chat/feedbackEngine'
import { Logger as LunaLogger } from '../../frontend-react/src/chat/logger'
import { createSurveyEngine, buildSurveyVerdicts as __bsv } from '../../frontend-react/src/chat/surveyEngine'
import { createSecretPromptEngine } from '../../frontend-react/src/chat/secretPromptEngine'
import { createSuggestedActionsEngine } from '../../frontend-react/src/chat/suggestedActionsEngine'
import { createLocalShell } from '../../frontend-react/src/chat/localShell'
import { createNotifier } from '../../frontend-react/src/chat/notifier'
import { MoonClient as __moonClientConst } from '../../frontend-react/src/chat/moonClient'
import { createThreadDrawer, moonDragDebugNote as __mddn } from '../../frontend-react/src/chat/threadDrawer'
import { bootChat } from '../../frontend-react/src/chat/bootChat'
import { createWire } from '../../frontend-react/src/chat/wire'
import { createFrames } from '../../frontend-react/src/chat/frames'
import { installWiring } from '../../frontend-react/src/chat/wiring'
import { createChatEngine, CSS_escape as __cssesc, splitSpeakableSentences as __splitsp, toSpeakable as __tospk } from '../../frontend-react/src/chat/chatEngine'
import { buildMessageCopyButton as __bmcb, buildMessageMeta as __bmm, formatRelTime as __frt } from '../../frontend-react/src/chat/messageMeta'
import { createMoonFace } from '../../frontend-react/src/chat/moonFace'
import { createMoonBar } from '../../frontend-react/src/chat/moonBar'
import { createArtifactsEngine } from '../../frontend-react/src/chat/artifactsEngine'

const CHAT_HTML_PATH = path.resolve(__dirname, '../../frontend-react/chat.html')
const VENDOR_DIR = path.resolve(__dirname, '../../frontend/vendor')

/** Reads frontend-react/chat.html fresh - same source chat-window.test.ts,
 * ws-contract.test.ts and slash-menu.test.ts have always read directly. */
export function readChatHtml(): string {
  return fs.readFileSync(CHAT_HTML_PATH, 'utf8')
}

/** Loads `htmlContent`'s <body> markup into the live jsdom document. `<body[^>]*>`,
 * NOT `<body>` - the shipped tag carries a class, and a bare `<body>` regex can
 * match a LITERAL `<body>` string sitting inside the inline script's own JS
 * comments further down the file (see ws-contract.test.ts's original note). */
export function mountChatDomFromHtml(htmlContent: string): void {
  const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*?)<\/body>/)
  if (!bodyMatch) {
    throw new Error('chat-harness: could not find a <body> tag in frontend-react/chat.html')
  }
  document.body.innerHTML = bodyMatch[1] ?? ''
}

/** jsdom never fetches external <script src> tags, so required vendor files are
 * loaded by hand, in the same order the page declares them. */
export function loadVendorInto(target: Window & typeof globalThis, file: string): void {
  const src = fs.readFileSync(path.resolve(VENDOR_DIR, file), 'utf8')
  new Function('globalThis', src)(target)
}

// ── React module graph: src/chat/MessageList.tsx's mountMessageList ────────
//
// Mirrors main-chat.tsx's own getChatHost/openAgentsPanelForCurrentThread
// wiring exactly (see that file's module doc) so the "view ↗" agent-panel
// link and the grouped/ungrouped timeline planning behave identically to the
// shipped boot path, not a test-only stand-in.

function invokeTauriFromHarness(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }
  }
  const core = w.__TAURI__?.core
  if (!core) return Promise.reject(new Error('not in Tauri'))
  return args === undefined ? core.invoke(cmd) : core.invoke(cmd, args)
}

function openAgentsPanelForCurrentThread(): void {
  const state = getChatHost()?.state()
  const thread = state?.activeThreadId || state?.pinnedThread || null
  if (!thread) return
  invokeTauriFromHarness('open_widget', { kind: 'agents', params: { thread } }).catch((err: unknown) => {
    console.warn('open agents panel failed:', err)
  })
}

/** Mounts the REAL MessageList.tsx tree into `container` (chat.html's
 * `#chat-messages`, already in the DOM via mountChatDomFromHtml) exactly the
 * way main-chat.tsx mounts it in the shipped page - wrapped in `flushSync`
 * so the initial commit (replacing the static welcome bubble) has actually
 * happened by the time this returns (see this file's SYNCHRONOUS COMMITS
 * note). Throws rather than degrading to a no-op - a null container here
 * means the harness itself is broken (body markup didn't load), not a
 * legitimate missing-host case. */
export function mountChatMessageListBridge(container: HTMLElement | null): ChatMessageListMount {
  let mount: ChatMessageListMount | null = null
  flushSync(() => {
    mount = mountMessageList(container, {
      getGrouped: () => getChatHost()?.state().serverSupportsTurnComplete !== false,
      onOpenAgentsPanel: openAgentsPanelForCurrentThread,
    })
  })
  if (!mount) {
    throw new Error('chat-harness: mountMessageList degraded to null - is #chat-messages missing from the loaded body?')
  }
  return mount
}

/**
 * Installs a `requestAnimationFrame`/`cancelAnimationFrame` stub whose
 * callback runs synchronously AND inside `flushSync`, so a test driving
 * `ChatLoop.schedule()` (the rAF-coalesced path - applyDelta/applyToolCall/
 * toggleTimelineCollapsed, see chat.html's call sites) can assert against
 * the DOM immediately afterward, exactly like the pre-conversion imperative
 * renderer's synchronous-stub tests already assumed (see this file's
 * SYNCHRONOUS COMMITS note for why a plain sync stub is not enough on its
 * own once a real React root is involved).
 */
export function installSyncRequestAnimationFrame(target: Window & typeof globalThis = window): void {
  target.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    flushSync(() => cb(0))
    return 1
  }) as typeof target.requestAnimationFrame
  target.cancelAnimationFrame = (() => {}) as typeof target.cancelAnimationFrame
}

/**
 * Evaluates chat.html's single classic <script> (selected by CONTENT, not
 * position - an added config stub must fail loudly here, not silently run
 * the wrong script) and, in the SAME function scope, patches its `ChatState`
 * / `ChatLoop` / `Attachments` / `ComposerConfig` / `SlashMenu` forward-
 * declarations to the real bridges - see this file's module doc for why
 * that patch has to live inside the same `new Function(...)` body instead
 * of being a separate `window.ChatState = …` assignment from outside.
 *
 * `Attachments.tsx`, `ComposerConfig.tsx`, `SlashMenu.tsx` and
 * `SmartBarEngine.tsx` mount into their respective DOM anchors here exactly
 * the way main-chat.tsx mounts them in the shipped page (all already present
 * in the live document via `mountChatDomFromHtml`, called before this
 * function in every suite) - throws rather than degrading to a no-op for the
 * same reason `mountChatMessageListBridge` does.
 *
 * Also mirrors main-chat.tsx's own post-mount step of refreshing
 * `window.__MoonInternals.ChatState/.ChatLoop/.Attachments/.ComposerConfig/
 * .SlashMenu/.SmartBarEngine` (captured `undefined`/never-set by the
 * script's own end-of-script assignment, which runs before this bridge
 * patch - see chat.html's "ChatState / ChatLoop / Attachments /
 * ComposerConfig / SlashMenu / SmartBarEngine: NOT assigned here" note).
 *
 * Deletes any prior boot's `window.LunaChatHost` before mounting: the mounts
 * below run BEFORE the classic script's own `window.LunaChatHost =
 * Object.freeze(...)` (only published at the end of the `bridged` source
 * text below), so chat-host.ts's late-bound `getChatHost()` reads would
 * otherwise resolve a PREVIOUS test's frozen host instead of degrading to
 * null, the same cross-test bleed `window.__MoonInternals` deletion in each
 * suite's own `afterEach` already guards against.
 */
/**
 * Boot the chat window the way production boots it (stack23 S20d).
 *
 * This used to evaluate chat.html's inline <script> and inject module
 * instances into its scope through a hand-maintained prologue. chat.html has
 * no script any more, and - more importantly - that prologue was a SECOND
 * implementation of the boot ORDER. It drifted twice in the S20 arc alone
 * (frames before wire; wire before wiring), each time producing failures
 * production never had.
 *
 * So it calls bootChat(), the same function main-chat.tsx calls, and then
 * publishes the test surface from what that returns. There is no second order
 * to keep in sync.
 *
 * The `htmlContent` / `mount` parameters are kept so the 11 call sites did not
 * all have to change shape in the same commit; both are now unused, and
 * mountChatDomFromHtml (which the callers already run) is what puts the body
 * in place.
 */
export function evalChatInlineScriptWithBridge(_htmlContent?: string, _mount?: unknown): void {
  // flushSync around the WHOLE boot, which is what mountChatMessageListBridge
  // used to do around its single mount. jsdom tests assert synchronously right
  // after an action, so React's default async commit would leave them reading
  // an empty transcript.
  let boot!: ReturnType<typeof bootChat>
  flushSync(() => {
    boot = bootChat()
  })

  const w = window as unknown as Record<string, unknown> & {
    __MoonInternals?: Record<string, unknown>
  }
  w.__MoonInternals = w.__MoonInternals || {}
  const M = w.__MoonInternals

  // bootChat's own assignBridge already published most of these; this fills in
  // the pieces that were only ever test hooks.
  M.State = boot.State
  M.DOM = boot.DOM
  M.WebSocketEngine = boot.wire.WebSocketEngine
  M.PoolEngine = boot.wire.PoolEngine
  M.USE_POOL_ENGINE = boot.wire.USE_POOL_ENGINE
  M.MoonFrames = boot.frames.MoonFrames
  M.frames = boot.frames
  M.ThreadDrawerEngine = boot.threadDrawer.ThreadDrawerEngine
  M.ThreadCache = boot.threadDrawer.ThreadCache
  M.ThreadCreateState = boot.threadDrawer.ThreadCreateState
  M.ChatEngine = boot.chatEngine.ChatEngine
  M.VoiceEngine = boot.chatEngine.VoiceEngine
  M.ChatState = boot.messageListMount?.ChatState
  M.ChatLoop = boot.messageListMount?.ChatLoop
  M.SecretPromptEngine = boot.secretPromptEngine
  M.SurveyEngine = boot.surveyEngine
  M.SuggestedActionsEngine = boot.suggestedActionsEngine
  M.FeedbackEngine = boot.feedbackEngine
  M.ArtifactsEngine = boot.artifactsEngine
  M.LocalShell = boot.localShell
  M.Notifier = boot.notifier
  M.ResultToasts = boot.resultToasts
  M.MoonFace = boot.moonFace
  M.MoonBar = boot.moonBar
  M.SlashMenu = boot.slashMenuMount?.SlashMenu
  M.SmartBarEngine = boot.smartBarMount?.SmartBarEngine
  M.ComposerConfig = boot.composerConfigMount?.ComposerConfig
  M.Attachments = boot.attachmentsMount?.Attachments
  // handleFrame goes through the ENGINE, not frames.dispatch directly - that is
  // what chat.html published, and the engine adds generation gating the raw
  // registry does not.
  // handleFrame goes through the ENGINE, not frames.dispatch directly - that is
  // what chat.html published, and the engine adds generation gating the raw
  // registry does not.
  M.handleFrame = (frame: unknown) => boot.wire.WebSocketEngine.handleFrame(frame)
  M.appendToolCallCard = (f: unknown) => boot.chatEngine.ChatEngine.appendToolCallCard(f)
  M.attachToolResult = (f: unknown) => boot.chatEngine.ChatEngine.attachToolResult(f)
  M.autoGrowMessageInput = () => boot.chatEngine.ChatEngine.autoGrowMessageInput()
  M.UpdateBanner = boot.updateBanner
  const md = (window as unknown as { LunaMarkdown: Record<string, unknown> }).LunaMarkdown
  M.renderMarkdown = md.renderMarkdown
  M.renderMarkdownStreaming = md.renderMarkdownStreaming
  M.closeOpenFences = md.closeOpenFences
  M.enhanceCodeBlocks = md.enhanceCodeBlocks
  M.moonDragDebug = (window as unknown as { __moonDragDebug?: unknown }).__moonDragDebug ?? null
  M.moonE2E = (window as unknown as { __moonE2E?: unknown }).__moonE2E ?? null
  M.StreamRender = (window as unknown as { LunaMarkdown: { StreamRender: unknown } }).LunaMarkdown.StreamRender
  M.LunaThreadDrag = (window as unknown as { LunaThreadDrag?: unknown }).LunaThreadDrag ?? null
  M.buildSurveyVerdicts = __bsv
  M.formatRelTime = __frt
  M.buildMessageMeta = __bmm
  M.buildMessageCopyButton = __bmcb
  M.splitSpeakableSentences = __splitsp
  M.toSpeakable = __tospk
  M.CSS_escape = __cssesc
  M.moonDragDebugNote = __mddn
  M.describeTarget = describeTarget
  M.cropAndEncodeFeedbackScreenshot = cropAndEncodeFeedbackScreenshot
}
