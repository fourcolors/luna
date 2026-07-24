// @vitest-environment node
/**
 * Pure unit tests for LunaThreadDrag session (chrome-tab-interaction Phase A/B).
 * Loads the shipped vendor module — no reimplementation of the state machine.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

type Session = {
  getState: () => string
  pointerMove: (p: {
    clientX: number
    clientY: number
    stripRect: { left: number; top: number; right: number; bottom: number } | null
    rowCount?: number
  }) => { state: string; action: string; insertIndex: number; inStrip: boolean }
  pointerUp: (p: {
    clientX: number
    clientY: number
    stripRect: { left: number; top: number; right: number; bottom: number } | null
    rowCount?: number
  }) => {
    state: string
    outcome: string
    insertIndex: number
    inStrip: boolean
    detachedOnce: boolean
  }
  cancel: () => unknown
  constants: { ELASTICITY_PX: number; VERTICAL_MAGNET_PX: number }
}

type StorageLike = {
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
  removeItem: (k: string) => void
}

type LunaThreadDragApi = {
  STATE: Record<string, string>
  ELASTICITY_PX: number
  VERTICAL_MAGNET_PX: number
  SEED_TTL_MS: number
  pointInStripBand: (
    stripRect: { left: number; top: number; right: number; bottom: number } | null,
    cx: number,
    cy: number,
    magnetY?: number,
  ) => boolean
  insertIndexForRatio: (n: number, yRatio: number) => number
  writeThreadSeed: (
    storage: StorageLike,
    threadId: string,
    entry: { messages: unknown[]; throughSeq?: number },
    now?: number,
  ) => boolean
  consumeThreadSeed: (
    storage: StorageLike,
    threadId: string,
    now?: number,
  ) => { messages: unknown[]; throughSeq: number } | null
  createSession: (opts: {
    threadId: string
    startClientX: number
    startClientY: number
    rowCount?: number
    elasticityPx?: number
    magnetYPx?: number
    onEvent?: (ev: { kind: string; session: unknown; extra: unknown }) => void
  }) => Session
}

function loadShippedModule(): LunaThreadDragApi {
  const file = path.resolve(__dirname, '../frontend/vendor/thread-drag-session.js')
  const src = fs.readFileSync(file, 'utf8')
  const sandbox: { window: Record<string, unknown>; LunaThreadDrag?: LunaThreadDragApi } = {
    window: {},
  }
  sandbox.window = sandbox as unknown as Record<string, unknown>
  vm.runInNewContext(src, sandbox, { filename: 'thread-drag-session.js' })
  const api = (sandbox as { LunaThreadDrag?: LunaThreadDragApi }).LunaThreadDrag
    || (sandbox.window as { LunaThreadDrag?: LunaThreadDragApi }).LunaThreadDrag
  if (!api) throw new Error('LunaThreadDrag not exported by shipped vendor module')
  return api
}

const STRIP = { left: 0, top: 0, right: 200, bottom: 400 }

describe('LunaThreadDrag session (Phase A/B contract)', () => {
  let API: LunaThreadDragApi

  beforeAll(() => {
    API = loadShippedModule()
  })

  it('starts not_started and stays until elasticity is exceeded', () => {
    const s = API.createSession({
      threadId: 't1',
      startClientX: 50,
      startClientY: 100,
      rowCount: 3,
    })
    expect(s.getState()).toBe(API.STATE.NOT_STARTED)
    const r = s.pointerMove({
      clientX: 50 + 5,
      clientY: 100,
      stripRect: STRIP,
      rowCount: 3,
    })
    expect(r.action).toBe('none')
    expect(s.getState()).toBe(API.STATE.NOT_STARTED)
  })

  it('enters attached after elasticity while still in strip (no detach)', () => {
    const s = API.createSession({
      threadId: 't1',
      startClientX: 50,
      startClientY: 100,
      rowCount: 4,
      elasticityPx: 10,
    })
    const r = s.pointerMove({
      clientX: 50 + 12,
      clientY: 120,
      stripRect: STRIP,
      rowCount: 4,
    })
    expect(r.action).toBe('enter_attached')
    expect(s.getState()).toBe(API.STATE.ATTACHED)
    expect(r.inStrip).toBe(true)
  })

  it('does not report detach while attached inside strip', () => {
    const s = API.createSession({
      threadId: 't1',
      startClientX: 50,
      startClientY: 100,
    })
    s.pointerMove({ clientX: 70, clientY: 100, stripRect: STRIP })
    const r = s.pointerMove({ clientX: 80, clientY: 150, stripRect: STRIP, rowCount: 5 })
    expect(r.action).toBe('stay_attached')
    expect(s.getState()).toBe(API.STATE.ATTACHED)
  })

  it('detaches only after leaving the strip band (with magnetism)', () => {
    const s = API.createSession({
      threadId: 't1',
      startClientX: 50,
      startClientY: 100,
      magnetYPx: 15,
    })
    s.pointerMove({ clientX: 70, clientY: 100, stripRect: STRIP }) // attached
    // Still within vertical magnet below bottom (400 + 10)
    const still = s.pointerMove({
      clientX: 100,
      clientY: 410,
      stripRect: STRIP,
    })
    expect(still.action).toBe('stay_attached')
    // Outside magnet
    const det = s.pointerMove({
      clientX: 250,
      clientY: 200,
      stripRect: STRIP,
    })
    expect(det.action).toBe('detach')
    expect(s.getState()).toBe(API.STATE.DETACHED)
  })

  it('pointerUp inside strip after attached yields reorder (never keep_floater without detach)', () => {
    const s = API.createSession({
      threadId: 't1',
      startClientX: 50,
      startClientY: 100,
      rowCount: 3,
    })
    s.pointerMove({ clientX: 70, clientY: 100, stripRect: STRIP, rowCount: 3 })
    const up = s.pointerUp({ clientX: 80, clientY: 200, stripRect: STRIP, rowCount: 3 })
    expect(up.outcome).toBe('reorder')
    expect(up.detachedOnce).toBe(false)
    expect(s.getState()).toBe(API.STATE.STOPPED)
  })

  it('pointerUp without movement yields click', () => {
    const s = API.createSession({
      threadId: 't1',
      startClientX: 50,
      startClientY: 100,
    })
    const up = s.pointerUp({ clientX: 52, clientY: 101, stripRect: STRIP })
    expect(up.outcome).toBe('click')
  })

  it('pointerUp after detach outside strip yields keep_floater', () => {
    const s = API.createSession({
      threadId: 't1',
      startClientX: 50,
      startClientY: 100,
    })
    s.pointerMove({ clientX: 70, clientY: 100, stripRect: STRIP })
    s.pointerMove({ clientX: 300, clientY: 200, stripRect: STRIP })
    const up = s.pointerUp({ clientX: 320, clientY: 220, stripRect: STRIP })
    expect(up.outcome).toBe('keep_floater')
    expect(up.detachedOnce).toBe(true)
  })

  it('onEvent fires for move and up (E2E debug hook)', () => {
    const events: Array<{ kind: string; action?: string; outcome?: string }> = []
    const s = API.createSession({
      threadId: 't-debug',
      startClientX: 50,
      startClientY: 100,
      onEvent: (ev) => {
        const extra = (ev.extra || {}) as { action?: string; outcome?: string }
        events.push({ kind: ev.kind, action: extra.action, outcome: extra.outcome })
      },
    })
    s.pointerMove({ clientX: 70, clientY: 100, stripRect: STRIP })
    s.pointerMove({ clientX: 300, clientY: 200, stripRect: STRIP })
    s.pointerUp({ clientX: 320, clientY: 220, stripRect: STRIP })
    expect(events.some((e) => e.kind === 'move' && e.action === 'detach')).toBe(true)
    expect(events.some((e) => e.kind === 'up' && e.outcome === 'keep_floater')).toBe(true)
  })

  it('pointerUp after detach over strip yields redock', () => {
    const s = API.createSession({
      threadId: 't1',
      startClientX: 50,
      startClientY: 100,
      rowCount: 4,
    })
    s.pointerMove({ clientX: 70, clientY: 100, stripRect: STRIP })
    s.pointerMove({ clientX: 300, clientY: 200, stripRect: STRIP })
    const up = s.pointerUp({ clientX: 100, clientY: 50, stripRect: STRIP, rowCount: 4 })
    expect(up.outcome).toBe('redock')
    expect(up.inStrip).toBe(true)
  })

  it('insertIndexForRatio maps 0..1 onto 0..n slots', () => {
    expect(API.insertIndexForRatio(0, 0.5)).toBe(0)
    expect(API.insertIndexForRatio(4, 0)).toBe(0)
    expect(API.insertIndexForRatio(4, 1)).toBe(4)
    expect(API.insertIndexForRatio(4, 0.5)).toBe(2)
  })

  it('pointInStripBand uses vertical magnetism', () => {
    expect(API.pointInStripBand(STRIP, 100, 200, 15)).toBe(true)
    expect(API.pointInStripBand(STRIP, 100, 410, 15)).toBe(true)
    expect(API.pointInStripBand(STRIP, 100, 420, 15)).toBe(false)
    expect(API.pointInStripBand(STRIP, 250, 200, 15)).toBe(false)
  })

  it('constants match chrome-tab-interaction elasticity/magnetism defaults', () => {
    expect(API.ELASTICITY_PX).toBe(10)
    expect(API.VERTICAL_MAGNET_PX).toBe(15)
  })

  it('Phase C seed: isolated Storage cannot transfer; shared Storage can (cross-webview)', () => {
    const makeStore = () => {
      const map = new Map<string, string>()
      return {
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => { map.set(k, v) },
        removeItem: (k: string) => { map.delete(k) },
      }
    }
    const ownerOnly = makeStore()
    const floaterOnly = makeStore()
    const shared = makeStore()
    const entry = { messages: [{ role: 'user', text: 'seed' }], throughSeq: 9 }

    expect(API.writeThreadSeed(ownerOnly, 'tid', entry, 1000)).toBe(true)
    // sessionStorage-like isolation: other context sees nothing
    expect(API.consumeThreadSeed(floaterOnly, 'tid', 1001)).toBeNull()
    // localStorage-like shared origin store
    expect(API.writeThreadSeed(shared, 'tid', entry, 1000)).toBe(true)
    expect(API.consumeThreadSeed(shared, 'tid', 1001)).toEqual({
      messages: [{ role: 'user', text: 'seed' }],
      throughSeq: 9,
    })
    // consume-delete
    expect(API.consumeThreadSeed(shared, 'tid', 1002)).toBeNull()
  })

  it('Phase C seed: TTL expires stale seeds', () => {
    const map = new Map<string, string>()
    const store = {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => { map.set(k, v) },
      removeItem: (k: string) => { map.delete(k) },
    }
    API.writeThreadSeed(store, 'old', { messages: [{ role: 'user', text: 'x' }], throughSeq: 0 }, 0)
    expect(API.consumeThreadSeed(store, 'old', API.SEED_TTL_MS + 1)).toBeNull()
  })
})
