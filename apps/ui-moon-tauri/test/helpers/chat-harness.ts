/**
 * chat-harness.ts - the shared jsdom loader for frontend-react/chat.html's
 * classic inline script AND its React module graph (stack23 S15's chat
 * transcript conversion, continuation slice). Used by chat-window.test.ts,
 * ws-contract.test.ts and slash-menu.test.ts so a future conversion slice
 * (S16-S20, more of chat.html's inline script moving into src/chat/*.tsx)
 * only ever has to update THIS file, not each test file's own beforeEach.
 *
 * THE WALL this works around: chat.html's inline <script> is a classic
 * (non-module) script. In the real page it runs at true top level, so its
 * `var ChatState;` / `var ChatLoop;` forward-declarations (see chat.html's
 * "CHAT MODEL / RENDERER / LOOP" comment) ARE `window.ChatState` /
 * `window.ChatLoop` - every bare reference anywhere on the page, including
 * from main-chat.tsx's `type="module"` script that runs after it, resolves
 * to the SAME global binding.
 *
 * `new Function(src)()` does not have that property: it hands the script a
 * fresh function-call scope, so `var ChatState` is LOCAL to that one
 * invocation, not a real `window` property. Assigning `window.ChatState = …`
 * from OUTSIDE that call (the way main-chat.tsx does in the browser) only
 * ever creates a same-named but DIFFERENT binding - every closure the
 * classic script itself defined (ChatEngine.appendToolCallCard, the
 * WebSocketEngine frame handlers, …) would keep reading their own local
 * `undefined` forever. `evalChatInlineScriptWithBridge` fixes this by
 * appending the bridge assignment as literal source text onto the SAME
 * `new Function(...)` body, so it runs in the SAME scope as the `var`
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
import { mountMessageList, type ChatMessageListMount } from '../../frontend-react/src/chat/MessageList'

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
// Mirrors main-chat.tsx's own getChatGlobalState/openAgentsPanelForCurrentThread
// wiring exactly (see that file's module doc) so the "view ↗" agent-panel
// link and the grouped/ungrouped timeline planning behave identically to the
// shipped boot path, not a test-only stand-in.

interface ChatGlobalState {
  serverSupportsTurnComplete?: boolean
  activeThreadId?: string | null
  pinnedThread?: string | null
}

function getChatGlobalState(): ChatGlobalState | null {
  return (window as unknown as { __MoonInternals?: { State?: ChatGlobalState } }).__MoonInternals?.State ?? null
}

function invokeTauriFromHarness(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }
  }
  const core = w.__TAURI__?.core
  if (!core) return Promise.reject(new Error('not in Tauri'))
  return args === undefined ? core.invoke(cmd) : core.invoke(cmd, args)
}

function openAgentsPanelForCurrentThread(): void {
  const state = getChatGlobalState()
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
      getGrouped: () => getChatGlobalState()?.serverSupportsTurnComplete !== false,
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
 * / `ChatLoop` forward-declarations to `mount`'s real bridge - see this
 * file's module doc for why that patch has to live inside the same
 * `new Function(...)` body instead of being a separate `window.ChatState = …`
 * assignment from outside.
 *
 * Also mirrors main-chat.tsx's own post-mount step of refreshing
 * `window.__MoonInternals.ChatState/.ChatLoop` (captured `undefined` by the
 * script's own end-of-script assignment, which runs before this bridge
 * patch - see chat.html's "ChatState / ChatLoop: NOT assigned here" note).
 */
export function evalChatInlineScriptWithBridge(htmlContent: string, mount: ChatMessageListMount): void {
  const inlineScripts = [...htmlContent.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s): s is string => typeof s === 'string' && s.includes('WebSocketEngine'))
  expect(inlineScripts).toHaveLength(1)

  const bridged = `${inlineScripts[0]}
;ChatState = __mount.ChatState;
ChatLoop = __mount.ChatLoop;
window.ChatState = ChatState;
window.ChatLoop = ChatLoop;
if (window.__MoonInternals) {
  window.__MoonInternals.ChatState = ChatState;
  window.__MoonInternals.ChatLoop = ChatLoop;
}
`
  new Function('__mount', bridged)(mount)
}

export type { ChatMessageListMount }
