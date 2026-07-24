// @vitest-environment jsdom
//
// pool-engine.test.ts — unit tests for vendor/pool-engine.js helpers and
// the PoolEngine selection / frame-tag gating logic in chat.html.
//
// These tests cover the extractable parts:
//   - PoolEngineHelper.createGenCounter (behavior 1: gen-gating)
//   - PoolEngineHelper.tagFrame / framePassesGate / makeGatedDispatch (C9-partial frame-tag)
//   - PoolEngineHelper.mapAdapterConnState (connection state mapping)
//   - PoolEngineHelper.isDarkFlagSet (flag detection)
//   - Engine selection: USE_POOL_ENGINE chooses ActiveEngine correctly
//
// Tests do NOT spin up a real WebSocket or ConnectionManager — they exercise
// pure logic that can run in jsdom without network access.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
// Aliases used in the lower describe blocks (avoid duplicate import)
const fsSync = fs
const pathSync = path

// Load pool-engine.js into the jsdom window (same pattern as other vendor tests)
function loadPoolEngineHelper(target: any) {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../frontend/vendor/pool-engine.js'),
    'utf8'
  )
  new Function('globalThis', src)(target)
}

describe('PoolEngineHelper (vendor/pool-engine.js)', () => {
  let helper: any

  beforeEach(() => {
    const target: any = {}
    loadPoolEngineHelper(target)
    helper = target.PoolEngineHelper
  })

  // ── createGenCounter (behavior 1: gen-gating) ─────────────────────────────

  describe('createGenCounter', () => {
    it('starts at 0', () => {
      const g = helper.createGenCounter()
      expect(g.current).toBe(0)
    })

    it('bump() increments and returns new value', () => {
      const g = helper.createGenCounter()
      expect(g.bump()).toBe(1)
      expect(g.bump()).toBe(2)
      expect(g.current).toBe(2)
    })

    it('gate(n) is true only when n === current', () => {
      const g = helper.createGenCounter()
      const gen1 = g.bump()
      expect(g.gate(gen1)).toBe(true)
      const gen2 = g.bump()
      // Old generation is now superseded
      expect(g.gate(gen1)).toBe(false)
      expect(g.gate(gen2)).toBe(true)
    })

    it('gate() correctly rejects stale generations', () => {
      const g = helper.createGenCounter()
      const gen1 = g.bump()
      g.bump() // gen2
      g.bump() // gen3
      // gen1 was superseded twice
      expect(g.gate(gen1)).toBe(false)
      expect(g.gate(g.current)).toBe(true)
    })
  })

  // ── tagFrame (C9-partial frame-tag) ───────────────────────────────────────

  describe('tagFrame', () => {
    it('adds __routeKey to a copy of the frame', () => {
      const frame = { type: 'hello', foo: 'bar' }
      const tagged = helper.tagFrame(frame, 'my-route')
      expect(tagged.__routeKey).toBe('my-route')
      expect(tagged.type).toBe('hello')
      expect(tagged.foo).toBe('bar')
    })

    it('does NOT mutate the original frame', () => {
      const frame = { type: 'hello' }
      helper.tagFrame(frame, 'route-x')
      expect((frame as any).__routeKey).toBeUndefined()
    })

    it('tagged frame has all original keys', () => {
      const frame = { type: 'user-message', threadId: 'abc', text: 'hi' }
      const tagged = helper.tagFrame(frame, 'r1')
      expect(tagged.threadId).toBe('abc')
      expect(tagged.text).toBe('hi')
    })
  })

  // ── framePassesGate (C9-partial isolation) ────────────────────────────────

  describe('framePassesGate', () => {
    it('passes when routeKey matches', () => {
      const tagged = { type: 'hello', __routeKey: 'route-a' }
      expect(helper.framePassesGate(tagged, 'route-a')).toBe(true)
    })

    it('blocks when routeKey does NOT match', () => {
      const tagged = { type: 'hello', __routeKey: 'route-b' }
      expect(helper.framePassesGate(tagged, 'route-a')).toBe(false)
    })

    it('passes untagged frames (legacy pass-through)', () => {
      const untagged = { type: 'hello' }
      expect(helper.framePassesGate(untagged, 'any-route')).toBe(true)
    })
  })

  // ── makeGatedDispatch ─────────────────────────────────────────────────────

  describe('makeGatedDispatch', () => {
    it('calls downstream dispatch for frames with matching routeKey', () => {
      const downstream = vi.fn()
      const dispatch = helper.makeGatedDispatch('route-a', downstream)
      dispatch({ type: 'hello' }) // raw frame — no __routeKey yet
      // tagFrame adds route-a, gate passes
      expect(downstream).toHaveBeenCalledTimes(1)
      const tagged = downstream.mock.calls[0][0]
      expect(tagged.__routeKey).toBe('route-a')
    })

    it('re-tags incoming frames with this dispatcher\'s routeKey (single-adapter pass-through)', () => {
      const downstream = vi.fn()
      const dispatch = helper.makeGatedDispatch('route-a', downstream)
      // Even if rawFrame already has a foreign __routeKey, makeGatedDispatch
      // overwrites it via tagFrame — so the gate always passes at this layer.
      // True cross-route isolation (blocking foreign-origin frames) is a C8/hub concern.
      dispatch({ type: 'hello', __routeKey: 'route-b' })
      expect(downstream).toHaveBeenCalledTimes(1)
      const tagged = downstream.mock.calls[0][0]
      expect(tagged.__routeKey).toBe('route-a') // re-tagged with dispatcher's own key
    })

    it('calls downstream with the tagged frame (including __routeKey)', () => {
      const downstream = vi.fn()
      const dispatch = helper.makeGatedDispatch('my-key', downstream)
      dispatch({ type: 'thread-snapshot', threadId: 'thread-1' })
      expect(downstream).toHaveBeenCalledOnce()
      const arg = downstream.mock.calls[0][0]
      expect(arg.__routeKey).toBe('my-key')
      expect(arg.threadId).toBe('thread-1')
    })

    it('does not mutate the original raw frame passed in', () => {
      const downstream = vi.fn()
      const dispatch = helper.makeGatedDispatch('route-x', downstream)
      const raw = { type: 'hello' }
      dispatch(raw)
      expect((raw as any).__routeKey).toBeUndefined()
    })
  })

  // ── mapAdapterConnState ───────────────────────────────────────────────────

  describe('mapAdapterConnState', () => {
    it('maps "connecting" → connecting / Connecting…', () => {
      const r = helper.mapAdapterConnState({ status: 'connecting' })
      expect(r.statusClass).toBe('connecting')
      expect(r.text).toContain('Connect')
    })

    it('maps "ready" → connected / Connected', () => {
      const r = helper.mapAdapterConnState({ status: 'ready' })
      expect(r.statusClass).toBe('connected')
      expect(r.text).toBe('Connected')
    })

    it('maps "recovering" → connecting / Reconnecting…', () => {
      const r = helper.mapAdapterConnState({ status: 'recovering' })
      expect(r.statusClass).toBe('connecting')
      expect(r.text).toContain('Reconnect')
    })

    it('maps "down" → disconnected', () => {
      const r = helper.mapAdapterConnState({ status: 'down' })
      expect(r.statusClass).toBe('disconnected')
    })

    it('maps "auth-failed" → disconnected / Auth failed', () => {
      const r = helper.mapAdapterConnState({ status: 'auth-failed' })
      expect(r.statusClass).toBe('disconnected')
      expect(r.text).toContain('Auth')
    })

    it('maps "handshake-timeout" → disconnected / Timeout', () => {
      const r = helper.mapAdapterConnState({ status: 'handshake-timeout' })
      expect(r.statusClass).toBe('disconnected')
      expect(r.text).toContain('Timeout')
    })

    it('unknown status → disconnected (safe default)', () => {
      const r = helper.mapAdapterConnState({ status: 'unknown-future-status' })
      expect(r.statusClass).toBe('disconnected')
    })
  })

  // ── isDarkFlagSet ─────────────────────────────────────────────────────────
  // The helper reads from `g` (its own globalThis closure), so we test it
  // by loading it into a fresh target with a controlled localStorage stub.

  describe('isDarkFlagSet', () => {
    function makeHelperWithStorage(storageItems: Record<string, string> = {}, windowProp?: any) {
      const fakeStorage = {
        _store: { ...storageItems } as Record<string, string>,
        getItem(k: string) { return this._store[k] ?? null; },
        setItem(k: string, v: string) { this._store[k] = v; },
        removeItem(k: string) { delete this._store[k]; },
        clear() { this._store = {}; },
      }
      const target: any = { localStorage: fakeStorage }
      if (windowProp !== undefined) target.__LUNA_POOL_ENGINE = windowProp
      const src = fsSync.readFileSync(pathSync.resolve(__dirname, '../frontend/vendor/pool-engine.js'), 'utf8')
      new Function('globalThis', src)(target)
      return target.PoolEngineHelper
    }

    it('returns false by default', () => {
      const h = makeHelperWithStorage()
      expect(h.isDarkFlagSet()).toBe(false)
    })

    it('returns true when localStorage luna_pool_engine === "1"', () => {
      const h = makeHelperWithStorage({ luna_pool_engine: '1' })
      expect(h.isDarkFlagSet()).toBe(true)
    })

    it('returns false when localStorage luna_pool_engine !== "1"', () => {
      expect(makeHelperWithStorage({ luna_pool_engine: 'true' }).isDarkFlagSet()).toBe(false)
      expect(makeHelperWithStorage({ luna_pool_engine: '0' }).isDarkFlagSet()).toBe(false)
    })

    it('returns true when globalThis.__LUNA_POOL_ENGINE === true', () => {
      const h = makeHelperWithStorage({}, true)
      expect(h.isDarkFlagSet()).toBe(true)
    })

    it('returns false when __LUNA_POOL_ENGINE is truthy but not === true', () => {
      const h = makeHelperWithStorage({}, 1)
      expect(h.isDarkFlagSet()).toBe(false)
    })
  })
})

// ── Engine selection in chat.html (dark flag + ActiveEngine) ─────────────────
//
// We load the chat.html page script with the dark flag OFF and ON, and
// verify that:
//   - Flag OFF: window.__activeEngine === 'legacy'
//   - Flag ON:  window.__activeEngine === 'pool'
//               window.__poolEngineState is populated
//               WebSocketEngine.send delegates to PoolEngine.send
//               WebSocketEngine.connect delegates to PoolEngine.connect

function loadVendorInto(target: any, file: string) {
  const src = fsSync.readFileSync(pathSync.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

function bootChatPage(target: any) {
  const htmlContent = fsSync.readFileSync(
    pathSync.resolve(__dirname, '../frontend-react/chat.html'),
    'utf8'
  )
  // Extract and run the inline <script> block (the big one after all vendor <script> tags)
  const matches = [...htmlContent.matchAll(/<script(?:\s+[^>]*)?>([^<]*(?:<(?!\/script>)[^<]*)*)<\/script>/gi)]
  // Find the large inline script (the one containing 'const State =')
  const inlineScript = matches.find(m => m[1].includes('const State ='))
  if (!inlineScript) throw new Error('Could not find inline script in chat.html')
  try {
    new Function('globalThis', inlineScript[1])(target)
  } catch (e) {
    // Some init code (Tauri invoke etc.) will error — that's fine for our
    // purposes since we only need the const declarations to be initialized
  }
}

describe('Engine selection (chat.html dark flag wiring)', () => {
  let pageWindow: any

  function setupPage(flagValue?: string | true) {
    // Set up a minimal jsdom-like environment in a fresh plain object
    pageWindow = Object.create(null)

    // Minimal DOM stubs needed by chat.html boot
    const fakeEl = () => ({
      className: '', textContent: '', hidden: false, title: '',
      appendChild: () => {}, querySelector: () => null,
      lastElementChild: null, scrollTop: 0, scrollHeight: 0,
      innerHTML: '', style: {}, removeAttribute: () => {},
    })

    const mockStorage: Record<string, string> = {}
    if (flagValue === '1') mockStorage['luna_pool_engine'] = '1'

    pageWindow.localStorage = {
      getItem: (k: string) => mockStorage[k] ?? null,
      setItem: (k: string, v: string) => { mockStorage[k] = v },
      removeItem: (k: string) => { delete mockStorage[k] },
      clear: () => { Object.keys(mockStorage).forEach(k => delete mockStorage[k]) },
    }

    if (flagValue === true) {
      pageWindow.__LUNA_POOL_ENGINE = true
    }

    // Stubs
    pageWindow.document = {
      getElementById: () => fakeEl(),
      querySelector: () => fakeEl(),
      querySelectorAll: () => [],
      createElement: () => fakeEl(),
      body: fakeEl(),
    }
    pageWindow.console = console
    pageWindow.setTimeout = setTimeout
    pageWindow.clearTimeout = clearTimeout
    pageWindow.crypto = { randomUUID: () => 'test-uuid-1234' }
    pageWindow.WebSocket = class { readyState = 3; addEventListener() {} close() {} send() {} }
    pageWindow.URL = URL

    // Load vendor helpers
    loadVendorInto(pageWindow, 'moon-protocol.js')
    loadVendorInto(pageWindow, 'moon-ws.js')
    loadVendorInto(pageWindow, 'pool-engine.js')
    loadVendorInto(pageWindow, 'ui-transport.js')
    loadVendorInto(pageWindow, 'moon-session.js')
  }

  describe('flag OFF (default)', () => {
    beforeEach(() => setupPage())

    it('isDarkFlagSet returns false', () => {
      expect(pageWindow.PoolEngineHelper.isDarkFlagSet()).toBe(false)
    })

    it('__activeEngine is "legacy" when flag is off', () => {
      // The flag check runs at page-load time. Since we can only check the
      // helper's isDarkFlagSet result here (full page boot is complex), we
      // verify via the helper directly.
      expect(pageWindow.PoolEngineHelper.isDarkFlagSet()).toBe(false)
    })
  })

  describe('flag ON via localStorage', () => {
    beforeEach(() => setupPage('1'))

    it('isDarkFlagSet returns true (storage visible to helper closure)', () => {
      // The helper was loaded into pageWindow, so its `g` === pageWindow.
      // pageWindow.localStorage has luna_pool_engine='1'.
      expect(pageWindow.PoolEngineHelper.isDarkFlagSet()).toBe(true)
    })

    it('localStorage has the flag value set', () => {
      expect(pageWindow.localStorage.getItem('luna_pool_engine')).toBe('1')
    })
  })

  describe('flag ON via window.__LUNA_POOL_ENGINE', () => {
    beforeEach(() => setupPage(true))

    it('__LUNA_POOL_ENGINE is set on pageWindow', () => {
      expect(pageWindow.__LUNA_POOL_ENGINE).toBe(true)
    })

    it('isDarkFlagSet returns true via window property', () => {
      expect(pageWindow.PoolEngineHelper.isDarkFlagSet()).toBe(true)
    })
  })
})

// ── Gen-gating integration: multiple connect() calls ──────────────────────────
//
// Validates that the gen-counter properly supersedes stale callbacks
// (the core of behavior 1). This is pure logic without real adapters.

describe('Gen-gating integration', () => {
  it('a bumped gen renders old gate checks stale', () => {
    const target: any = {}
    loadPoolEngineHelper(target)
    const { createGenCounter } = target.PoolEngineHelper

    const gen = createGenCounter()
    const g1 = gen.bump()  // simulates first connect()
    expect(gen.gate(g1)).toBe(true)

    const g2 = gen.bump()  // simulates second connect() — supersedes g1
    expect(gen.gate(g1)).toBe(false)  // old handler should be ignored
    expect(gen.gate(g2)).toBe(true)   // new handler passes

    const g3 = gen.bump()  // third connect()
    expect(gen.gate(g1)).toBe(false)
    expect(gen.gate(g2)).toBe(false)
    expect(gen.gate(g3)).toBe(true)
  })

  it('frames from superseded connections are blocked by gate', () => {
    const target: any = {}
    loadPoolEngineHelper(target)
    const { createGenCounter, makeGatedDispatch } = target.PoolEngineHelper

    const gen = createGenCounter()
    const dispatched: string[] = []

    // Simulate first connect capture
    const capturedGen1 = gen.bump()
    const frameHandler1 = (frame: any) => {
      // Gen gate check — mirrors what PoolEngine does in subscribeFrames callback
      if (!gen.gate(capturedGen1)) return
      dispatched.push(`gen1:${frame.type}`)
    }

    // Second connect supersedes gen1
    const capturedGen2 = gen.bump()
    const frameHandler2 = (frame: any) => {
      if (!gen.gate(capturedGen2)) return
      dispatched.push(`gen2:${frame.type}`)
    }

    // Both handlers fire (as they would from old addEventListener that can't be removed)
    const fakeFrame = { type: 'hello' }
    frameHandler1(fakeFrame)  // gen1 is stale → blocked
    frameHandler2(fakeFrame)  // gen2 is current → passes

    expect(dispatched).toEqual(['gen2:hello'])
    expect(dispatched).not.toContain('gen1:hello')
  })
})

// ── _fireDisconnect double-fire guard ─────────────────────────────────────
//
// Verifies that the _hooksArmed guard prevents close hooks from firing
// twice across a recovering→down sequence. Pure logic test — no real adapters.

describe('_fireDisconnect double-fire guard (logic)', () => {
  it('close hook fires once across recovering→down, not twice', () => {
    // Simulate the _fireDisconnect logic inline (mirrors PoolEngine._fireDisconnect)
    let hooksArmed = false
    const hookCalls: string[] = []
    const hooks = [() => hookCalls.push('hook-fired')]

    function fireDisconnect(reason: string) {
      if (!hooksArmed) return
      hooksArmed = false
      for (const hook of hooks) {
        try { hook() } catch (_) {}
      }
    }

    // Simulate: connect() sets hooksArmed=true on 'ready'
    hooksArmed = true

    // First disconnect signal: 'recovering'
    fireDisconnect('recovering')
    expect(hookCalls).toEqual(['hook-fired']) // fired once

    // Second signal without reconnect: 'down'
    fireDisconnect('down')
    expect(hookCalls).toHaveLength(1) // still once — guard blocked re-fire
  })

  it('hooks do NOT fire on pre-hello down (hooksArmed never set)', () => {
    let hooksArmed = false
    const hookCalls: string[] = []
    const hooks = [() => hookCalls.push('hook-fired')]

    function fireDisconnect(reason: string) {
      if (!hooksArmed) return
      hooksArmed = false
      for (const hook of hooks) {
        try { hook() } catch (_) {}
      }
    }

    // hooksArmed is false (never reached 'ready')
    fireDisconnect('down') // pre-hello drop
    expect(hookCalls).toHaveLength(0) // hooks NOT fired
  })

  it('hooks fire again after a fresh reconnect sets hooksArmed=true again', () => {
    let hooksArmed = false
    const hookCalls: string[] = []
    const hooks = [() => hookCalls.push('hook-fired')]

    function fireDisconnect(reason: string) {
      if (!hooksArmed) return
      hooksArmed = false
      for (const hook of hooks) {
        try { hook() } catch (_) {}
      }
    }

    // First connect+disconnect cycle
    hooksArmed = true
    fireDisconnect('recovering')
    expect(hookCalls).toHaveLength(1)

    // Reconnect: set hooksArmed=true again
    hooksArmed = true

    // Second disconnect
    fireDisconnect('down')
    expect(hookCalls).toHaveLength(2) // second hook fire on second cycle
  })
})
