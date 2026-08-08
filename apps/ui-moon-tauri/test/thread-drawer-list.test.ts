// @vitest-environment jsdom
/**
 * thread-drawer-list.test.ts - behavior pins for ThreadDrawerEngine's list
 * core: which threads are visible, in what order, and where a redock drop
 * lands.
 *
 * WHY THIS EXISTS, WRITTEN BEFORE S17 RATHER THAN DURING IT. S17 converts the
 * drawer's list + rows + drag as ONE cohesive slice (Option A, see
 * docs/next/stack23-slices.md), and this is the exact surface it rewrites -
 * yet a coverage census over the whole Moon suite found `applyList`,
 * `_renderRow`, `_wireRow`, `_ts`, `_relTime` and `_insertIndexForRatio` with
 * ZERO direct assertions between them, while `render` and `_visibleThreads`
 * had one apiece. Rewriting untested selection-and-ordering logic is how a
 * drawer silently starts showing the wrong threads in the wrong order.
 *
 * These pin the REAL engine through `__MoonInternals` rather than embedding a
 * frozen copy of the vanilla source (the smart-bar-parity.test.ts pattern).
 * That is deliberate: SmartBar was converted in the same PR as its oracle, so
 * a frozen copy was the only way to compare. Here the conversion lands later,
 * so pinning observable behavior against the live object gives the same
 * differential guarantee - S17 must keep every assertion below green - with
 * nothing to keep in sync in the meantime.
 *
 * SCOPE NOTE: geometry (`initSidebar`/`wireDivider`/`setSidebarWidth`/...) is
 * deliberately NOT here. It stays vanilla through S17 and already has ~50
 * assertions in chat-window.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  evalChatInlineScriptWithBridge,
  loadVendorInto,
  mountChatDomFromHtml,
  readChatHtml,
} from './helpers/chat-harness'

describe('ThreadDrawerEngine list core (chat.html)', () => {
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
    for (const k of ['__TAURI__', '__MoonInternals', 'LunaChatHost', 'LunaProtocol', 'LunaWS', 'LunaMarkdown', 'LunaDock', 'ChatState', 'ChatLoop']) {
      delete (window as any)[k]
    }
    vi.restoreAllMocks()
  })

  const ids = () => eng()._visibleThreads().map((t: any) => t.id)

  // ── _ts: which timestamp field wins ───────────────────────────────────────
  describe('_ts timestamp extraction', () => {
    it('prefers lastMessageAt, then updatedAt, then createdAt', () => {
      expect(eng()._ts({ lastMessageAt: 3, updatedAt: 2, createdAt: 1 })).toBe(3)
      expect(eng()._ts({ updatedAt: 2, createdAt: 1 })).toBe(2)
      expect(eng()._ts({ createdAt: 1 })).toBe(1)
    })

    it('parses ISO string dates', () => {
      expect(eng()._ts({ lastMessageAt: '2026-01-02T03:04:05.000Z' })).toBe(
        Date.parse('2026-01-02T03:04:05.000Z'),
      )
    })

    it('returns 0 for missing, unparseable, or absent-thread inputs', () => {
      expect(eng()._ts({})).toBe(0)
      expect(eng()._ts({ lastMessageAt: 'not-a-date' })).toBe(0)
      expect(eng()._ts(null)).toBe(0)
      expect(eng()._ts(undefined)).toBe(0)
    })

    it('treats a 0 timestamp as absent rather than as the epoch', () => {
      // `(t.lastMessageAt || t.updatedAt || t.createdAt)` is a falsy chain, so
      // a literal 0 falls through to the next field. Pinned because a rewrite
      // using `??` instead would change ordering for epoch-stamped rows.
      expect(eng()._ts({ lastMessageAt: 0, updatedAt: 5 })).toBe(5)
    })
  })

  // ── _visibleThreads: filtering ────────────────────────────────────────────
  describe('_visibleThreads filtering', () => {
    it('drops system threads, and rows with no id', () => {
      State().threads = [
        { id: 'a', title: 'A' },
        { id: 'sys', title: 'S', system: true },
        { title: 'no-id' },
        null,
      ]
      expect(ids()).toEqual(['a'])
    })

    it('drops threads detached into floaters', () => {
      State().threads = [{ id: 'a' }, { id: 'b' }]
      State().floatedThreadIds = { b: true }
      expect(ids()).toEqual(['a'])
    })

    it('search matches title OR lastMessagePreview, case-insensitively', () => {
      State().threads = [
        { id: 'a', title: 'Deploy notes' },
        { id: 'b', title: 'Other', lastMessagePreview: 'about DEPLOYing' },
        { id: 'c', title: 'Unrelated' },
      ]
      State().threadSearch = 'deploy'
      expect(ids().sort()).toEqual(['a', 'b'])
    })

    it('a whitespace-only search is treated as no search', () => {
      State().threads = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]
      State().threadSearch = '   '
      expect(ids().sort()).toEqual(['a', 'b'])
    })

    it('a search matching nothing yields an empty list, not everything', () => {
      State().threads = [{ id: 'a', title: 'A' }]
      State().threadSearch = 'zzzz'
      expect(ids()).toEqual([])
    })

    it('threads missing title and preview survive an empty search', () => {
      State().threads = [{ id: 'a' }]
      expect(ids()).toEqual(['a'])
    })
  })

  // ── _visibleThreads: ordering ─────────────────────────────────────────────
  describe('_visibleThreads ordering', () => {
    it('sorts newest first by _ts when no session order is set', () => {
      State().threads = [
        { id: 'old', lastMessageAt: 1 },
        { id: 'new', lastMessageAt: 3 },
        { id: 'mid', lastMessageAt: 2 },
      ]
      expect(ids()).toEqual(['new', 'mid', 'old'])
    })

    it('threadOrder outranks recency for the ids it names', () => {
      State().threads = [
        { id: 'a', lastMessageAt: 1 },
        { id: 'b', lastMessageAt: 3 },
      ]
      State().threadOrder = ['a', 'b']
      expect(ids()).toEqual(['a', 'b'])
    })

    it('ids absent from threadOrder sort after every ranked id, by recency', () => {
      State().threads = [
        { id: 'ranked', lastMessageAt: 1 },
        { id: 'loose-old', lastMessageAt: 2 },
        { id: 'loose-new', lastMessageAt: 9 },
      ]
      State().threadOrder = ['ranked']
      expect(ids()).toEqual(['ranked', 'loose-new', 'loose-old'])
    })

    it('an empty threadOrder falls back to pure recency', () => {
      State().threads = [{ id: 'a', lastMessageAt: 1 }, { id: 'b', lastMessageAt: 2 }]
      State().threadOrder = []
      expect(ids()).toEqual(['b', 'a'])
    })

    it('does not mutate State.threads while sorting', () => {
      const rows = [{ id: 'a', lastMessageAt: 1 }, { id: 'b', lastMessageAt: 2 }]
      State().threads = rows
      eng()._visibleThreads()
      // A rewrite that sorts in place would reorder the caller's array and
      // make list order depend on how many times render() happened to run.
      expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
    })
  })

  // ── applyList ─────────────────────────────────────────────────────────────
  describe('applyList', () => {
    it('replaces the thread list wholesale', () => {
      eng().applyList([{ id: 'a' }, { id: 'b' }])
      expect(ids().sort()).toEqual(['a', 'b'])
      eng().applyList([{ id: 'c' }])
      expect(ids()).toEqual(['c'])
    })

    it('a non-array payload empties the list instead of throwing', () => {
      eng().applyList([{ id: 'a' }])
      for (const bad of [null, undefined, 'nope', 42, {}]) {
        expect(() => eng().applyList(bad)).not.toThrow()
        expect(ids()).toEqual([])
      }
    })

    it('copies the incoming array rather than aliasing the caller\'s', () => {
      const incoming = [{ id: 'a' }]
      eng().applyList(incoming)
      incoming.push({ id: 'sneaky' })
      expect(ids()).toEqual(['a'])
    })
  })

  // ── _insertIndexForRatio: where a redock drop lands ───────────────────────
  describe('_insertIndexForRatio', () => {
    it('maps a vertical ratio onto n+1 insert slots', () => {
      expect(eng()._insertIndexForRatio(4, 0)).toBe(0)
      expect(eng()._insertIndexForRatio(4, 0.5)).toBe(2)
      expect(eng()._insertIndexForRatio(4, 1)).toBe(4)
    })

    it('clamps out-of-range ratios instead of returning an out-of-range slot', () => {
      expect(eng()._insertIndexForRatio(4, -5)).toBe(0)
      expect(eng()._insertIndexForRatio(4, 5)).toBe(4)
    })

    it('an empty strip always drops at slot 0', () => {
      expect(eng()._insertIndexForRatio(0, 0.5)).toBe(0)
      expect(eng()._insertIndexForRatio(-1, 0.5)).toBe(0)
    })

    it('a non-numeric ratio degrades to the top slot, never NaN', () => {
      for (const bad of [NaN, undefined, null, 'x', {}]) {
        const got = eng()._insertIndexForRatio(4, bad)
        expect(Number.isInteger(got), String(bad)).toBe(true)
        expect(got).toBe(0)
      }
    })
  })

  // ── render: the mid-drag guard ────────────────────────────────────────────
  describe('render', () => {
    const rowIds = () =>
      Array.from(document.querySelectorAll('#thread-drawer-list .thread-row')).map(
        (el) => (el as HTMLElement).dataset.threadId,
      )

    it('paints one row per visible thread, newest first', () => {
      eng().applyList([
        { id: 'a', title: 'A', lastMessageAt: 1 },
        { id: 'b', title: 'B', lastMessageAt: 2 },
      ])
      expect(rowIds()).toEqual(['b', 'a'])
    })

    it('rebuilds wholesale rather than appending on every call', () => {
      eng().applyList([{ id: 'a' }, { id: 'b' }])
      eng().render()
      eng().render()
      expect(rowIds().length).toBe(2)
    })

    it('DEFERS a repaint while a row drag holds pointer capture', () => {
      // Rebuilding the list mid-gesture detaches the captured node and
      // silently aborts the pull-out - the reason this guard exists at all.
      // No timestamps here on purpose: `_ts` returns 0 for both, and the sort
      // is stable, so insertion order survives - which keeps this test about
      // the drag guard rather than about ordering.
      eng().applyList([{ id: 'a' }, { id: 'b' }])
      expect(rowIds()).toEqual(['a', 'b'])
      State().threadDragActive = true
      eng().applyList([{ id: 'c' }])
      expect(rowIds(), 'the strip must not be rebuilt mid-drag').toEqual(['a', 'b'])
      // ...and the frame was not simply dropped: clearing the flag and
      // repainting shows the list that arrived DURING the gesture.
      State().threadDragActive = false
      eng().render()
      expect(rowIds()).toEqual(['c'])
    })

    it('renders a title fallback and never injects markup from a server title', () => {
      eng().applyList([{ id: 'a', title: '' }, { id: 'b', title: '<img src=x onerror=alert(1)>' }])
      const titles = Array.from(
        document.querySelectorAll('#thread-drawer-list .thread-row-title'),
      ).map((el) => el.textContent)
      expect(titles).toContain('Untitled thread')
      expect(titles).toContain('<img src=x onerror=alert(1)>')
      expect(document.querySelector('#thread-drawer-list img')).toBeNull()
    })
  })
})
