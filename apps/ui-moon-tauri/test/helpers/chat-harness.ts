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
export function evalChatInlineScriptWithBridge(htmlContent: string, mount: ChatMessageListMount): void {
  delete window.LunaChatHost
  const inlineScripts = [...htmlContent.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s): s is string => typeof s === 'string' && s.includes('WebSocketEngine'))
  expect(inlineScripts).toHaveLength(1)

  const attachmentsMount: AttachmentsMount | null = mountAttachments({
    strip: document.getElementById('attachments-strip'),
    error: document.getElementById('attach-error'),
  })
  if (!attachmentsMount) {
    throw new Error(
      'chat-harness: mountAttachments degraded to null - are #attachments-strip/#attach-error missing from the loaded body?',
    )
  }

  const composerConfigMount: ComposerConfigMount | null = mountComposerConfig(
    {
      cluster: document.getElementById('composer-config'),
      modelBtn: document.getElementById('model-cfg-btn'),
      modelMenu: document.getElementById('model-cfg-menu'),
      effortBtn: document.getElementById('effort-cfg-btn'),
      effortMenu: document.getElementById('effort-cfg-menu'),
      effortSep: document.getElementById('effort-cfg-sep'),
      deferredHint: document.getElementById('cfg-deferred-hint'),
    },
    chatHostComposerCtx(),
  )
  if (!composerConfigMount) {
    throw new Error(
      'chat-harness: mountComposerConfig degraded to null - is the composer-config cluster missing from the loaded body?',
    )
  }

  const slashMenuMount: SlashMenuMount | null = mountSlashMenu(
    {
      menu: document.getElementById('slash-menu'),
      messageInput: document.getElementById('message-input') as HTMLTextAreaElement | null,
      modelMenu: document.getElementById('model-cfg-menu'),
      modelBtn: document.getElementById('model-cfg-btn'),
      effortMenu: document.getElementById('effort-cfg-menu'),
      effortBtn: document.getElementById('effort-cfg-btn'),
    },
    chatHostSlashMenuCtx({
      getComposerConfig: () => composerConfigMount?.ComposerConfig ?? null,
      clearAttachments: () => attachmentsMount.Attachments.clear(),
    }),
  )
  if (!slashMenuMount) {
    throw new Error(
      'chat-harness: mountSlashMenu degraded to null - is #slash-menu/#message-input missing from the loaded body?',
    )
  }

  const smartBarMount: SmartBarMount | null = mountSmartBar(document.getElementById('smart-bar'))
  if (!smartBarMount) {
    throw new Error('chat-harness: mountSmartBar degraded to null - is #smart-bar missing from the loaded body?')
  }

  // A THUNK, not an instance. FeedbackEngine reads State and send through
  // LunaChatHost, which the classic script publishes - and in THIS harness the
  // modules mount BEFORE that script runs, so constructing eagerly would
  // capture an undefined State. The shipped page has the opposite order and is
  // unaffected; calling this from inside the bridged source below is what puts
  // the harness on the same footing.
  const byId = (id: string) => document.getElementById(id)
  const quietLogger = { info: () => {}, warn: () => {}, error: () => {} }
  const makeSurveyEngine = () =>
    createSurveyEngine({
      Logger: quietLogger,
      DOM: {
        userAskPanel: byId('user-ask-panel'),
        userAskBody: byId('user-ask-body'),
        userAskHint: byId('user-ask-hint'),
        userAskSubmit: byId('user-ask-submit'),
      },
      WebSocketEngine: { send: (f: unknown) => getChatHost()?.send(f as never) },
      ChatState: { appendBanner: (t: string) => (window as any).ChatState?.appendBanner(t) },
      ChatLoop: { flush: () => (window as any).ChatLoop?.flush() },
    })
  const makeSecretPromptEngine = () =>
    createSecretPromptEngine({
      Logger: quietLogger,
      DOM: {
        secretPromptPanel: byId('secret-prompt-panel'),
        secretPromptPrompt: byId('secret-prompt-prompt'),
        secretPromptConsent: byId('secret-prompt-consent'),
        secretPromptInput: byId('secret-prompt-input'),
        secretPromptStatus: byId('secret-prompt-status'),
      },
      State: getChatHost()?.state(),
      WebSocketEngine: { send: (f: unknown) => getChatHost()?.send(f as never) },
    })
  const makeSuggestedActionsEngine = (mf: any, mb: any) =>
    createSuggestedActionsEngine({
      DOM: {
        suggestedActionPanel: byId('suggested-action-panel'),
        suggestedActionType: byId('suggested-action-type'),
        suggestedActionText: byId('suggested-action-text'),
        suggestedActionRationale: byId('suggested-action-rationale'),
        secretPromptPanel: byId('secret-prompt-panel'),
        userAskPanel: byId('user-ask-panel'),
      },
      State: getChatHost()?.state(),
      WebSocketEngine: { send: (f: unknown) => getChatHost()?.send(f as never) },
      MoonBar: mb,
      MoonFace: mf,
    })
  const makeMoonFace = () => {
    const f = createMoonFace({ lunaFace: byId('luna-face') })
    f.init()
    return f
  }
  const makeMoonBar = () => {
    const b = createMoonBar({
      lunaQuip: byId('luna-quip'),
      lunaSuggestion: byId('luna-suggestion'),
      lunaSuggestionText: byId('luna-suggestion-text'),
    })
    b.init()
    return b
  }
  const makeArtifactsEngine = () =>
    createArtifactsEngine({
      DOM: {
        artifactsBtn: byId('artifacts-btn'),
        artifactsBadge: byId('artifacts-badge'),
        artifactsPanel: byId('artifacts-panel'),
        artifactsPinnedSection: byId('artifacts-pinned-section'),
        artifactsPinnedList: byId('artifacts-pinned-list'),
        artifactsSessionSection: byId('artifacts-session-section'),
        artifactsSessionList: byId('artifacts-session-list'),
        artifactsEmpty: byId('artifacts-empty'),
        artifactsPreview: byId('artifacts-preview'),
        artifactsPreviewTitle: byId('artifacts-preview-title'),
        artifactsPreviewCopy: byId('artifacts-preview-copy'),
        artifactsPreviewBody: byId('artifacts-preview-body'),
      },
      State: getChatHost()?.state(),
      WebSocketEngine: { send: (f: unknown) => getChatHost()?.send(f as never) },
      renderMarkdown: (md: string) => (window as any).LunaMarkdown.renderMarkdown(md),
      enhanceCodeBlocks: (r: unknown) => (window as any).LunaMarkdown.enhanceCodeBlocks(r),
    })

  const makeFeedbackEngine = () =>
    createFeedbackEngine({
      DOM: {
        feedbackBtn: document.getElementById('feedback-btn'),
        feedbackPickerOverlay: document.getElementById('feedback-picker-overlay'),
        feedbackPickerHighlight: document.getElementById('feedback-picker-highlight'),
        feedbackPanel: document.getElementById('feedback-panel'),
        feedbackTargetChip: document.getElementById('feedback-target-chip'),
        feedbackInput: document.getElementById('feedback-input'),
        feedbackStatus: document.getElementById('feedback-status'),
        feedbackSubmit: document.getElementById('feedback-submit-btn'),
      },
      State: getChatHost()?.state(),
      WebSocketEngine: { send: (f: unknown) => getChatHost()?.send(f as never) },
    })

  const bridged = `${inlineScripts[0]}
;ChatState = __mount.ChatState;
ChatLoop = __mount.ChatLoop;
Attachments = __attachmentsMount.Attachments;
ComposerConfig = __composerConfigMount.ComposerConfig;
SlashMenu = __slashMenuMount.SlashMenu;
SmartBarEngine = __smartBarMount.SmartBarEngine;
ThreadListLogic = __threadListLogic;
ThreadStrip = __threadStrip;
ThreadCacheLogic = __threadCacheLogic;
ThreadCreateLogic = __threadCreateLogic;
ThreadDrag = __threadDrag;
ResultToasts = __resultToasts;
UpdateBanner = __updateBanner;
FeedbackEngine = __feedbackEngine();
ArtifactsEngine = __artifactsEngine();
MoonFace = __moonFace();
MoonBar = __moonBar();
buildSurveyVerdicts = __buildSurveyVerdicts;
SurveyEngine = __surveyEngine();
SecretPromptEngine = __secretPromptEngine();
SuggestedActionsEngine = __suggestedActionsEngine(MoonFace, MoonBar);
window.ChatState = ChatState;
window.ChatLoop = ChatLoop;
window.Attachments = Attachments;
window.ComposerConfig = ComposerConfig;
window.SlashMenu = SlashMenu;
window.SmartBarEngine = SmartBarEngine;
window.ThreadListLogic = ThreadListLogic;
window.ThreadStrip = ThreadStrip;
window.ThreadCacheLogic = ThreadCacheLogic;
window.ThreadCreateLogic = ThreadCreateLogic;
window.ThreadDrag = ThreadDrag;
window.ResultToasts = ResultToasts;
window.UpdateBanner = UpdateBanner;
window.FeedbackEngine = FeedbackEngine;
window.ArtifactsEngine = ArtifactsEngine;
window.MoonFace = MoonFace;
window.MoonBar = MoonBar;
window.SurveyEngine = SurveyEngine;
window.SecretPromptEngine = SecretPromptEngine;
window.SuggestedActionsEngine = SuggestedActionsEngine;
if (window.__MoonInternals) {
  window.__MoonInternals.ChatState = ChatState;
  window.__MoonInternals.ChatLoop = ChatLoop;
  window.__MoonInternals.Attachments = Attachments;
  window.__MoonInternals.ComposerConfig = ComposerConfig;
  window.__MoonInternals.SlashMenu = SlashMenu;
  window.__MoonInternals.SmartBarEngine = SmartBarEngine;
  window.__MoonInternals.ThreadCache = ThreadCache;
  window.__MoonInternals.ResultToasts = ResultToasts;
  window.__MoonInternals.UpdateBanner = UpdateBanner;
  window.__MoonInternals.FeedbackEngine = FeedbackEngine;
  window.__MoonInternals.ArtifactsEngine = ArtifactsEngine;
  window.__MoonInternals.MoonFace = MoonFace;
  window.__MoonInternals.MoonBar = MoonBar;
  window.__MoonInternals.SurveyEngine = SurveyEngine;
  window.__MoonInternals.SecretPromptEngine = SecretPromptEngine;
  window.__MoonInternals.SuggestedActionsEngine = SuggestedActionsEngine;
  window.__MoonInternals.buildSurveyVerdicts = buildSurveyVerdicts;
  window.__MoonInternals.describeTarget = __describeTarget;
  window.__MoonInternals.cropAndEncodeFeedbackScreenshot = __cropAndEncode;
}
`
  new Function(
    '__mount',
    '__attachmentsMount',
    '__composerConfigMount',
    '__slashMenuMount',
    '__smartBarMount',
    '__threadListLogic',
    '__threadStrip',
    '__threadCacheLogic',
    '__threadCreateLogic',
    '__threadDrag',
    '__resultToasts',
    '__updateBanner',
    '__feedbackEngine',
    '__artifactsEngine',
    '__moonFace',
    '__moonBar',
    '__buildSurveyVerdicts',
    '__surveyEngine',
    '__secretPromptEngine',
    '__suggestedActionsEngine',
    '__describeTarget',
    '__cropAndEncode',
    bridged,
  )(mount, attachmentsMount, composerConfigMount, slashMenuMount, smartBarMount, ThreadListLogic, ThreadStrip, ThreadCacheLogic, ThreadCreateLogic, ThreadDrag, createResultToasts(), createUpdateBanner({ Logger: { warn: () => {} } }), makeFeedbackEngine, makeArtifactsEngine, makeMoonFace, makeMoonBar, __bsv, makeSurveyEngine, makeSecretPromptEngine, makeSuggestedActionsEngine, describeTarget, cropAndEncodeFeedbackScreenshot)
}

export type { ChatMessageListMount, AttachmentsMount, ComposerConfigMount, SlashMenuMount, SmartBarMount }
