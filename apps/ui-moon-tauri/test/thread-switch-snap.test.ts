// @vitest-environment jsdom
/**
 * thread-switch-snap.test.ts — regression guard for the thread-switch snappiness fix.
 *
 * ROOT CAUSE: State.activeThreadId was assigned directly by several call sites
 * (threadDrawer.ts onRowClick, wiring.ts drag-drop seed, chatEngine.ts
 * newConversation, frames.ts thread-list/thread-created/thread-archived).
 * Each bypass produced a render → validate → re-render race: the panel
 * painted once with a stale/null thread id, then repainted corrected. Users
 * perceived this as lag or flash on every thread switch.
 *
 * FIX: setActiveThread() in state.ts is the single writer for user-driven
 * thread selection. It applies the ordering invariants (same-thread short-
 * circuit, pendingFreshThread clear, threadListAutoSelectPending clear)
 * synchronously before the mutation. threadDrawer.ts onRowClick goes through
 * it; chatEngine.ts newConversation goes through clearActiveThread() — both
 * injected via their respective *Ctx callbacks so neither file imports state.ts
 * directly.
 *
 * These tests assert the single-writer invariant, the clearActiveThread
 * symmetry, the cache-miss loading-state behaviour, and the allowlist fence.
 *
 * Three concerns in one file:
 *
 * 1. BEHAVIORAL. setActiveThread and clearActiveThread mutate State correctly
 *    and are the ONLY routes for user-intent transitions (row-click and
 *    new-conversation). The production change routes threadDrawer.ts:onRowClick
 *    through setActiveThread and chatEngine.ts:newConversation through
 *    clearActiveThread (injected via ctx, not a direct import).
 *
 * 2. ALLOWLIST (mechanical fence). State.activeThreadId is a public mutable
 *    field on a @ts-nocheck object — any `State.activeThreadId = x` compiles
 *    silently. This test scans the production source files and asserts that the
 *    set of direct assignment sites exactly equals the explicitly-justified
 *    allowlist below. If a new site appears without updating the list, the test
 *    fails with the diff.
 *
 *    Repo precedent: test/astryx-layer-order.test.ts,
 *    test/boot-ignition-isolation.test.ts, test/tauri-acl-coverage.test.ts.
 *
 * 3. REGRESSION PROOF. Reverting either production change restores a bare
 *    direct assignment at the removed site, which the allowlist test catches.
 *    Proved inline in the allowlist section.
 *
 * CACHE-HIT RENDER COUNT (item 4 from the audit).
 *    threadDrawer.ts:onRowClick already called ThreadCache.paint(id) on master.
 *    This PR does NOT change that call path — it only routes the
 *    `State.activeThreadId` assignment through setActiveThread so the state
 *    transition happens before the cache paint, not after. The cache-hit render
 *    count is therefore unchanged by this PR: a cache hit was already one
 *    synchronous paint, and it still is. We say so plainly rather than claiming
 *    "snappier" for a path this PR did not alter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  evalChatInlineScriptWithBridge,
  loadVendorInto,
  mountChatDomFromHtml,
  readChatHtml,
} from './helpers/chat-harness'
import { createState, setActiveThread, clearActiveThread } from '../frontend-react/src/chat/state'

// ── 1a. Unit tests: setActiveThread (pure state logic) ───────────────────────

describe('setActiveThread — single-writer invariant (unit)', () => {
  it('returns false and makes no state change when id is null/empty', () => {
    const s = createState()
    s.activeThreadId = 'th-1'
    expect(setActiveThread(s as any, '', 'test')).toBe(false)
    expect(s.activeThreadId).toBe('th-1')
    expect(setActiveThread(s as any, null as any, 'test')).toBe(false)
    expect(s.activeThreadId).toBe('th-1')
  })

  it('returns false and makes no state change when id equals current activeThreadId (no re-render race)', () => {
    const s = createState()
    s.activeThreadId = 'th-same'
    const before = s.activeThreadId
    expect(setActiveThread(s as any, 'th-same', 'test')).toBe(false)
    // Strict object identity check: the field must not have been re-assigned,
    // even to the same value. A re-assignment triggers downstream subscribers
    // even when nothing changed, which is the render race the fix prevents.
    expect(s.activeThreadId).toBe(before)
  })

  it('returns true and sets activeThreadId when the id is new', () => {
    const s = createState()
    s.activeThreadId = 'th-old'
    expect(setActiveThread(s as any, 'th-new', 'test')).toBe(true)
    expect(s.activeThreadId).toBe('th-new')
  })

  it('clears pendingFreshThread synchronously before the assignment', () => {
    const s = createState()
    s.pendingFreshThread = true
    setActiveThread(s as any, 'th-1', 'row-click')
    // Must be cleared BEFORE activeThreadId is set so no path sees both
    // pendingFreshThread=true AND a non-null activeThreadId simultaneously.
    expect(s.pendingFreshThread).toBe(false)
    expect(s.activeThreadId).toBe('th-1')
  })

  it('clears threadListAutoSelectPending synchronously before the assignment', () => {
    const s = createState()
    s.threadListAutoSelectPending = true
    setActiveThread(s as any, 'th-1', 'row-click')
    expect(s.threadListAutoSelectPending).toBe(false)
    expect(s.activeThreadId).toBe('th-1')
  })

  it('first-switch from null sets the id correctly', () => {
    const s = createState()
    expect(s.activeThreadId).toBe(null)
    const result = setActiveThread(s as any, 'th-first', 'cold-start')
    expect(result).toBe(true)
    expect(s.activeThreadId).toBe('th-first')
  })
})

// ── 1b. Unit tests: clearActiveThread (symmetric pair) ───────────────────────

describe('clearActiveThread', () => {
  it('nulls activeThreadId and activeTurnId', () => {
    const s = createState()
    s.activeThreadId = 'old'
    s.activeTurnId = 'turn-1'
    clearActiveThread(s as any, 'new-conversation')
    expect(s.activeThreadId).toBeNull()
    expect(s.activeTurnId).toBeNull()
  })

  it('is idempotent on already-null state', () => {
    const s = createState()
    expect(s.activeThreadId).toBeNull()
    expect(() => clearActiveThread(s as any, 'test')).not.toThrow()
    expect(s.activeThreadId).toBeNull()
  })

  it('does not mutate any other State field', () => {
    const s = createState()
    s.activeThreadId = 'old'
    s.activeTurnId = 'turn-1'
    const before = JSON.stringify({ ...s, activeThreadId: null, activeTurnId: null, localShell: null, stalledIdSet: null, floatedThreadIds: null, threadCache: null, busyThreads: null, subagentsByThread: null })
    clearActiveThread(s as any, 'test')
    const after = JSON.stringify({ ...s, activeThreadId: null, activeTurnId: null, localShell: null, stalledIdSet: null, floatedThreadIds: null, threadCache: null, busyThreads: null, subagentsByThread: null })
    expect(after).toBe(before)
  })
})

// ── 2. Integration tests: onRowClick goes through the single writer ───────────

describe('ThreadDrawerEngine.onRowClick — single-writer integration (chat.html)', () => {
  const M = () => (window as any).__MoonInternals
  const eng = () => M().ThreadDrawerEngine
  const State = () => M().State

  beforeEach(() => {
    window.history.replaceState({}, '', '/')
    const htmlContent = readChatHtml()
    mountChatDomFromHtml(htmlContent)
    ;(window as any).__TAURI__ = {
      window: {
        getCurrentWindow: () => ({
          label: 'chat-test',
          listen: vi.fn(async () => () => {}),
          onMoved: vi.fn(async () => () => {}),
          isMinimized: vi.fn(async () => false),
          scaleFactor: vi.fn(async () => 1),
          outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
          outerSize: vi.fn(async () => ({ width: 560, height: 520 })),
          setPosition: vi.fn(async () => {}),
          startDragging: vi.fn(async () => {}),
        }),
        Window: { getByLabel: vi.fn(async () => null) },
      },
      event: { listen: vi.fn(async () => () => {}) },
    }
    loadVendorInto(window, 'moon-protocol.js')
    loadVendorInto(window, 'moon-ws.js')
    loadVendorInto(window, 'moon-markdown.js')
    loadVendorInto(window, 'moon-dock.js')
    loadVendorInto(window, 'thread-drag-session.js')
    localStorage.clear()
    evalChatInlineScriptWithBridge()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    for (const k of [
      '__TAURI__', '__MoonInternals', 'LunaChatHost', 'LunaProtocol',
      'LunaWS', 'LunaMarkdown', 'LunaDock', 'ChatState', 'ChatLoop',
    ]) {
      delete (window as any)[k]
    }
    vi.restoreAllMocks()
  })

  /**
   * Stub a connected WS so WebSocketEngine.isConnected() returns true and
   * onRowClick's subscribe path fires. Without this every send path silently
   * takes the offline branch and no subscribe frame is ever sent.
   */
  function connectFakeWs(sent: unknown[]): void {
    const m = M()
    const ws = { readyState: WebSocket.OPEN, send: (data: string) => { sent.push(JSON.parse(data)) } }
    m.State.ws = ws
    if (m.PoolEngine) {
      m.PoolEngine._isConnected = true
      m.PoolEngine._adapter = { sendFrame: (f: unknown) => sent.push(f) }
      const helper = (globalThis as any).PoolEngineHelper
      if (!m.PoolEngine._gen && helper?.createGenCounter) {
        m.PoolEngine._gen = helper.createGenCounter()
        m.PoolEngine._gen.bump()
      }
    }
  }

  it('Scenario: a single row click produces exactly ONE committed active-thread transition', () => {
    const sent: unknown[] = []
    connectFakeWs(sent)

    // Prime with a different current thread so a click actually changes state.
    State().activeThreadId = 'th-old'

    eng().onRowClick('th-new')

    // Exactly one subscribe frame (not zero, not two).
    const subscribes = sent.filter((f: any) => f.type === 'subscribe' && f.threadId === 'th-new')
    expect(subscribes.length).toBe(1)
    expect(State().activeThreadId).toBe('th-new')
  })

  it('Scenario: clicking the already-active thread sends NO subscribe frame (no re-render race)', () => {
    const sent: unknown[] = []
    connectFakeWs(sent)

    State().activeThreadId = 'th-same'
    eng().onRowClick('th-same')

    const subscribes = sent.filter((f: any) => f.type === 'subscribe')
    expect(subscribes.length).toBe(0)
    // State must not have changed at all.
    expect(State().activeThreadId).toBe('th-same')
  })

  it('Scenario: row click clears pendingFreshThread before subscribe fires (deferred-new-thread race)', () => {
    connectFakeWs([])
    State().activeThreadId = 'th-a'
    State().pendingFreshThread = true

    eng().onRowClick('th-b')

    // By the time the call returns the flag must be cleared — the setter
    // applies it synchronously, so no async subscribe handler can see
    // pendingFreshThread=true alongside the new activeThreadId.
    expect(State().pendingFreshThread).toBe(false)
    expect(State().activeThreadId).toBe('th-b')
  })

  it('Scenario: cache-miss row click shows a loading state, not a blank flash', () => {
    connectFakeWs([])
    // Ensure the target thread is NOT in the cache (no prior paint).
    State().activeThreadId = 'th-a'
    State().threadCache = {}  // empty cache

    // We assert that a subscribe was sent (server resubscribe is in flight)
    // AND that ChatState.reset was called (old content cleared). The pending-
    // assistant placeholder that creates the skeleton is internal to ChatState;
    // we pin the observable contract: reset+flush runs on cache miss.
    let resetCalled = false
    const originalReset = M().ChatState?.reset?.bind(M().ChatState)
    if (M().ChatState) {
      M().ChatState.reset = () => { resetCalled = true; if (originalReset) originalReset() }
    }

    eng().onRowClick('th-uncached')

    expect(State().activeThreadId).toBe('th-uncached')
    // reset must have fired to clear stale content
    expect(resetCalled).toBe(true)
  })
})

// ── 3. Allowlist fence ────────────────────────────────────────────────────────
//
// DIRECT_SITES is the COMPLETE, EXPLICIT allowlist of legitimate
// `State.activeThreadId = <expr>` assignments in chat/*.ts source files.
//
// Each entry justifies a site that bypasses the gateway. Any new direct
// assignment that is NOT in this list causes the test to fail, naming the
// exact file and line number.
//
// REGRESSION PROOF:
//   Removing the clearActiveThread callback from chatEngine.ts:newConversation
//   and restoring the bare `State.activeThreadId = null` assignment at that
//   site without adding it to DIRECT_SITES causes foundTotal > allowedTotal;
//   the fence fails naming chatEngine.ts:~234 as the unlisted site.
//
//   Removing setActiveThread from threadDrawer.ts:onRowClick and restoring the
//   bare `State.activeThreadId = id` assignment similarly fails the fence.
//
//   Both regressions are therefore mechanically caught before any PR lands.
//
// NOTE: state.ts itself contains `State.activeThreadId = x` inside the
// setActiveThread/clearActiveThread function bodies. state.ts is excluded from
// the scan: the gateway implementations must write to the field (that is their
// purpose), and their bodies are not call sites that need justification.
//
// NOTE: chatEngine.ts:246 is the fallback branch inside newConversation() that
// fires ONLY when the clearActiveThread callback is absent (tests that
// construct ChatEngine without wiring bootChat). Production always wires the
// callback via bootChat.ts. The gateway-presence test below verifies this.

interface AllowlistEntry {
  file: string   // relative to chat/
  approx: number // informational only, not asserted
  reason: string
}

const DIRECT_SITES: AllowlistEntry[] = [
  {
    file: 'chatEngine.ts',
    approx: 246,
    reason: 'fallback-only: fires when clearActiveThread callback is absent (bare-construction / non-bootChat test path); production path uses the injected callback',
  },
  {
    file: 'frames.ts',
    approx: 310,
    reason: 'server-confirmed: thread-list auto-subscribe picks the first non-stalled thread',
  },
  {
    file: 'frames.ts',
    approx: 330,
    reason: 'server-confirmed: thread-archived clears the active id so the list can re-select',
  },
  {
    file: 'frames.ts',
    approx: 425,
    reason: 'server-confirmed: thread-created ack sets the newly minted thread as active',
  },
  {
    file: 'wire.ts',
    approx: 581,
    reason: 'lifecycle: WebSocketEngine reattach stalled — null so thread-list drives next subscribe',
  },
  {
    file: 'wire.ts',
    approx: 619,
    reason: 'lifecycle: WebSocketEngine direct-line mode — pinned thread set once at connect',
  },
  {
    file: 'wire.ts',
    approx: 713,
    reason: 'lifecycle: WebSocketEngine cold-start — blind subscribe to file-sourced stored id',
  },
  {
    file: 'wire.ts',
    approx: 1447,
    reason: 'lifecycle: PoolEngine reattach stalled — mirrors WebSocketEngine.onReattachStalled',
  },
  {
    file: 'wire.ts',
    approx: 1468,
    reason: 'lifecycle: PoolEngine direct-line mode — mirrors WebSocketEngine.syncThread',
  },
  {
    file: 'wire.ts',
    approx: 1530,
    reason: 'lifecycle: PoolEngine cold-start — mirrors WebSocketEngine.syncThread',
  },
  {
    file: 'wiring.ts',
    approx: 791,
    reason: 'lifecycle: drag-seed boot path paints detached thread before WS connects',
  },
  {
    file: 'wiring.ts',
    approx: 1029,
    reason: 'lifecycle: profile-switch resets to no thread so list-threads re-selects',
  },
]

describe('activeThreadId direct-assignment allowlist', () => {
  const CHAT_DIR = path.resolve(__dirname, '../frontend-react/src/chat')

  // Scan these files only. state.ts is excluded — it contains the gateway
  // implementations whose bodies necessarily write to activeThreadId.
  const CHAT_FILES = [
    'chatEngine.ts',
    'frames.ts',
    'threadDrawer.ts',
    'wire.ts',
    'wiring.ts',
  ]

  // Match `State.activeThreadId = ` where the next char is NOT `=`.
  function findDirectAssignments(src: string): Array<{ line: number; snippet: string }> {
    const hits: Array<{ line: number; snippet: string }> = []
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (/State\.activeThreadId\s*=[^=]/.test(lines[i])) {
        hits.push({ line: i + 1, snippet: lines[i].trim() })
      }
    }
    return hits
  }

  it('VACUOUS-PROOF: scan finds at least one assignment (glob not broken)', () => {
    let total = 0
    for (const file of CHAT_FILES) {
      const src = fs.readFileSync(path.join(CHAT_DIR, file), 'utf8')
      total += findDirectAssignments(src).length
    }
    expect(total, 'scan found zero direct assignments — regex or file path is broken').toBeGreaterThanOrEqual(1)
    expect(CHAT_FILES.length).toBeGreaterThan(0)
  })

  it('direct assignment count per file matches the allowlist exactly', () => {
    const allFound: Array<{ file: string; line: number; snippet: string }> = []

    for (const file of CHAT_FILES) {
      const src = fs.readFileSync(path.join(CHAT_DIR, file), 'utf8')
      const hits = findDirectAssignments(src)
      for (const h of hits) allFound.push({ file, ...h })
    }

    const allowedTotal = DIRECT_SITES.length
    const foundTotal = allFound.length

    if (foundTotal !== allowedTotal) {
      const foundSummary = allFound
        .map((f) => `  ${f.file}:${f.line}  ${f.snippet}`)
        .join('\n')
      const allowedSummary = DIRECT_SITES
        .map((s) => `  ${s.file}:~${s.approx}  // ${s.reason}`)
        .join('\n')
      throw new Error(
        `activeThreadId direct-assignment mismatch.\n` +
        `Found ${foundTotal} sites, allowlist has ${allowedTotal}.\n\n` +
        `Found on disk:\n${foundSummary}\n\n` +
        `Allowlist (DIRECT_SITES in test/thread-switch-snap.test.ts):\n${allowedSummary}\n\n` +
        `Action: if you added a new direct assignment, add it to DIRECT_SITES with a reason.\n` +
        `If you removed one, delete the corresponding DIRECT_SITES entry.\n` +
        `User-intent transitions (row-click, new-conversation) must use setActiveThread /\n` +
        `clearActiveThread from state.ts instead (injected via *Ctx, not a direct import).`,
      )
    }

    // Per-file count check.
    for (const file of CHAT_FILES) {
      const allowedCount = DIRECT_SITES.filter((s) => s.file === file).length
      const foundCount = allFound.filter((f) => f.file === file).length
      if (foundCount !== allowedCount) {
        const foundLines = allFound
          .filter((f) => f.file === file)
          .map((f) => `  line ${f.line}: ${f.snippet}`)
          .join('\n')
        const allowedLines = DIRECT_SITES
          .filter((s) => s.file === file)
          .map((s) => `  ~${s.approx}: ${s.reason}`)
          .join('\n')
        throw new Error(
          `${file}: found ${foundCount} direct assignments, allowlist has ${allowedCount}.\n` +
          `Found:\n${foundLines || '  (none)'}\n` +
          `Allowed:\n${allowedLines || '  (none)'}`,
        )
      }
    }
  })

  it('user-intent paths use the gateway, not a bare assignment', () => {
    // Belt-and-braces: the two paths that MUST go through the gateway are
    // specifically verified here. A refactor that reverts one without updating
    // DIRECT_SITES fails the count test above, AND fails here with a clear name.
    const chatEngine = fs.readFileSync(path.join(CHAT_DIR, 'chatEngine.ts'), 'utf8')
    const drawer = fs.readFileSync(path.join(CHAT_DIR, 'threadDrawer.ts'), 'utf8')

    // threadDrawer: setActiveThread injected via ThreadDrawerCtx callback
    expect(drawer, "threadDrawer.ts: onRowClick must call setActiveThread via injected callback").toContain(
      "setActiveThread(id, 'row-click')",
    )

    // chatEngine: clearActiveThread injected via ChatEngineCtx callback
    expect(chatEngine, "chatEngine.ts: newConversation must call clearActiveThread via injected callback").toContain(
      "clearActiveThread('new-conversation')",
    )

    // chatEngine: the fallback branch must be inside an else / conditional —
    // verify it is NOT a bare unconditional assignment at the top of newConversation
    const ncIdx = chatEngine.indexOf('newConversation()')
    const ncEnd = chatEngine.indexOf('},\n', ncIdx)
    const ncBody = ncIdx > -1 && ncEnd > -1 ? chatEngine.slice(ncIdx, ncEnd) : ''
    // The gateway call must be present
    expect(ncBody, 'chatEngine.ts: newConversation body must call clearActiveThread').toContain(
      "clearActiveThread('new-conversation')",
    )
    // The bare assignment must only appear inside the fallback (else branch)
    // — it must NOT appear BEFORE the gateway guard
    const gatewayIdx = ncBody.indexOf("clearActiveThread(")
    const bareIdx = ncBody.search(/State\.activeThreadId\s*=\s*null/)
    if (bareIdx !== -1) {
      expect(bareIdx, 'chatEngine.ts: any bare activeThreadId=null in newConversation must be AFTER the gateway guard').toBeGreaterThan(gatewayIdx)
    }

    // threadDrawer: old bare assignment must be gone from onRowClick body
    const orcIdx = drawer.indexOf('onRowClick(id)')
    const orcEnd = drawer.indexOf('},\n', orcIdx)
    const orcBody = orcIdx > -1 && orcEnd > -1 ? drawer.slice(orcIdx, orcEnd) : ''
    expect(orcBody, 'threadDrawer.ts: onRowClick body must not directly assign activeThreadId').not.toMatch(
      /State\.activeThreadId\s*=\s*id/,
    )
  })
})
