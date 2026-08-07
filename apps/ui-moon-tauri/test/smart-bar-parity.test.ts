// @vitest-environment jsdom
/**
 * smart-bar-parity.test.ts - the S16d GOLDEN PARITY ORACLE for the composer's
 * context-pill Smart Bar, mirroring the binary arc's bash-source-oracle
 * pattern (S22a) on the Moon side.
 *
 * `makeVanilla()` below is chat.html's PRE-S16d `SmartBarEngine` object,
 * pasted VERBATIM from `git show <pre-S16d>:apps/ui-moon-tauri/frontend-react/
 * chat.html`, with only the TypeScript `this`/param annotations added. It is a
 * FROZEN ORACLE: never "improve" it, never sync it to SmartBarEngine.tsx. Its
 * whole value is that it cannot drift, so the day someone edits the React
 * module in a way that changes rendered output, one of these cases goes red.
 *
 * Every case runs BOTH implementations over the same item list against a fresh
 * `#smart-bar` and compares an attribute-order-insensitive structural snapshot
 * (attribute order is not observable in rendering; text and element structure
 * are). Coverage deliberately concentrates on the paths a hand-written probe
 * forgets: falsy-but-present values (`0`, `''`, `null`, `false`), object
 * values, non-numeric `priority`, empty-string `tooltip`/`label`/`icon`,
 * malformed frames, duplicate ids, and multi-frame sequences.
 *
 * The readable behavioral pins for the same subsystem live in
 * slash-menu.test.ts's `SmartBar` describe, driven end-to-end through the real
 * `smart-bar` frame handler. This file is the narrower, stricter oracle: it
 * calls the mount directly, so it says nothing about the wiring.
 *
 * RETIRE AT S20, with the vanilla chat layer this oracle is frozen against.
 */
import { describe, it, expect, vi } from 'vitest'
import { mountSmartBar } from '../frontend-react/src/chat/SmartBarEngine'

// ─── verbatim pre-S16d vanilla object (frozen oracle - do not edit) ──────────
function makeVanilla(): any {
  return {
    _items: [] as any[],
    _el: null as HTMLElement | null,
    _getEl(this: any) {
      if (!this._el) this._el = document.getElementById('smart-bar')
      return this._el
    },
    applyFrame(this: any, frame: any) {
      const items = Array.isArray(frame.items) ? frame.items : []
      this._items = items
      this._render()
    },
    _render(this: any) {
      const el = this._getEl()
      if (!el) return
      const infoItems = this._items.filter((item: any) => item.kind === 'info')
      if (infoItems.length === 0) {
        el.hidden = true
        el.innerHTML = ''
        return
      }
      const sorted = infoItems.slice().sort((a: any, b: any) => {
        const ga = a.group || ''
        const gb = b.group || ''
        if (ga < gb) return -1
        if (ga > gb) return 1
        const pa = typeof a.priority === 'number' ? a.priority : 999
        const pb = typeof b.priority === 'number' ? b.priority : 999
        return pa - pb
      })
      el.innerHTML = sorted.map((item: any) => this._renderItem(item)).join('')
      el.hidden = false
    },
    _renderItem(this: any, item: any) {
      const toneClass = item.tone === 'good' ? ' sb-good' : item.tone === 'warn' ? ' sb-warn' : ''
      const flagshipClass = item.id === 'git.worktree' ? ' sb-flagship' : ''
      const iconHtml = item.icon ? `<span class="sb-ic" aria-hidden="true">${this._esc(item.icon)}</span>` : ''
      const labelHtml = item.label ? `<span class="sb-lbl">${this._esc(item.label)}</span>` : ''
      const valueHtml = item.value !== undefined ? `<span class="sb-val">${this._esc(String(item.value))}</span>` : ''
      const tooltip = item.tooltip ? ` title="${this._esc(item.tooltip)}"` : ''
      return `<span class="sb-item${flagshipClass}${toneClass}"${tooltip}>${iconHtml}${labelHtml}${valueHtml}</span>`
    },
    _esc(str: any) {
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    },
  }
}

/** Attribute-order-insensitive structural snapshot of the bar. */
function snapshot(el: HTMLElement): string {
  const node = (e: Element): any => ({
    tag: e.tagName.toLowerCase(),
    attrs: Array.from(e.attributes)
      .map((a) => `${a.name}=${a.value}`)
      .sort(),
    kids: Array.from(e.children).length
      ? Array.from(e.children).map(node)
      : e.textContent,
  })
  return JSON.stringify({ hidden: el.hidden, kids: Array.from(el.children).map(node) }, null, 1)
}

const CASES: Array<[string, any[]]> = [
  ['empty', []],
  ['single info item', [{ id: 'git.worktree', kind: 'info', label: 'branch', value: 'main', icon: '⎇' }]],
  ['non-info kind skipped', [{ id: 'x', kind: 'warning', label: 'a', value: 'b' }]],
  ['mixed kinds', [{ id: 'a', kind: 'info', value: '1' }, { id: 'b', kind: 'nope', value: '2' }]],
  ['group+priority sort', [
    { id: 'b', kind: 'info', group: 'z', priority: 1, value: 'B' },
    { id: 'a', kind: 'info', group: 'a', priority: 2, value: 'A2' },
    { id: 'c', kind: 'info', group: 'a', priority: 1, value: 'A1' },
  ]],
  ['missing priority defaults 999', [
    { id: 'a', kind: 'info', group: 'g', value: 'no-priority' },
    { id: 'b', kind: 'info', group: 'g', priority: 1, value: 'has-priority' },
  ]],
  ['non-numeric priority defaults 999', [
    { id: 'a', kind: 'info', group: 'g', priority: '1', value: 'string-priority' },
    { id: 'b', kind: 'info', group: 'g', priority: 5, value: 'real-priority' },
  ]],
  ['flagship', [{ id: 'git.worktree', kind: 'info', value: 'main' }, { id: 'other', kind: 'info', value: 'x' }]],
  ['tones', [
    { id: 'ok', kind: 'info', value: '1', tone: 'good' },
    { id: 'bad', kind: 'info', value: '2', tone: 'warn' },
    { id: 'plain', kind: 'info', value: '3' },
    { id: 'unknown-tone', kind: 'info', value: '4', tone: 'chartreuse' },
  ]],
  ['tooltips', [{ id: 'x', kind: 'info', value: '1', tooltip: 'hover' }, { id: 'y', kind: 'info', value: '2' }]],
  ['empty-string tooltip', [{ id: 'x', kind: 'info', value: '1', tooltip: '' }]],
  ['bare item, no icon/label/value', [{ id: 'x', kind: 'info' }]],
  ['falsy value 0', [{ id: 'x', kind: 'info', value: 0 }]],
  ['falsy value empty string', [{ id: 'x', kind: 'info', value: '' }]],
  ['null value', [{ id: 'x', kind: 'info', value: null }]],
  ['false value', [{ id: 'x', kind: 'info', value: false }]],
  ['object value', [{ id: 'x', kind: 'info', value: { a: 1 } }]],
  ['numeric value', [{ id: 'x', kind: 'info', value: 42 }]],
  ['empty-string label/icon omitted', [{ id: 'x', kind: 'info', label: '', icon: '', value: 'v' }]],
  ['html-special chars', [{ id: 'x', kind: 'info', label: '<b>&"', value: '<i>tag</i>', tooltip: '"><script>' }]],
  ['ampersand entity text', [{ id: 'x', kind: 'info', label: '&amp;', value: 'a & b' }]],
  ['duplicate ids', [{ id: 'dup', kind: 'info', value: 'first' }, { id: 'dup', kind: 'info', value: 'second' }]],
  ['undefined group sorts as empty', [
    { id: 'a', kind: 'info', value: 'no-group' },
    { id: 'b', kind: 'info', group: 'zz', value: 'grouped' },
  ]],
]

describe('S16d differential: vanilla SmartBarEngine vs React SmartBarEngine.tsx', () => {
  it.each(CASES)('renders identically: %s', (_name, items) => {
    // vanilla
    document.body.innerHTML = '<div id="smart-bar" class="smart-bar" hidden aria-label="Context bar"></div>'
    const vanilla = makeVanilla()
    vanilla.applyFrame({ items })
    const vanillaSnap = snapshot(document.getElementById('smart-bar')!)

    // react
    document.body.innerHTML = '<div id="smart-bar" class="smart-bar" hidden aria-label="Context bar"></div>'
    const mount = mountSmartBar(document.getElementById('smart-bar'))!
    mount.SmartBarEngine.applyFrame({ items })
    const reactSnap = snapshot(document.getElementById('smart-bar')!)

    expect(reactSnap).toBe(vanillaSnap)
  })

  it('sequential frames diverge nowhere: replace, then empty, then refill', () => {
    const seq = [
      [{ id: 'a', kind: 'info', value: '1' }, { id: 'b', kind: 'info', value: '2' }],
      [{ id: 'c', kind: 'info', value: '3' }],
      [],
      [{ id: 'd', kind: 'info', value: '4', tone: 'warn' }],
    ]
    document.body.innerHTML = '<div id="smart-bar" hidden></div>'
    const vanilla = makeVanilla()
    const vanillaSnaps = seq.map((items) => {
      vanilla.applyFrame({ items })
      return snapshot(document.getElementById('smart-bar')!)
    })

    document.body.innerHTML = '<div id="smart-bar" hidden></div>'
    const mount = mountSmartBar(document.getElementById('smart-bar'))!
    const reactSnaps = seq.map((items) => {
      mount.SmartBarEngine.applyFrame({ items })
      return snapshot(document.getElementById('smart-bar')!)
    })

    expect(reactSnaps).toEqual(vanillaSnaps)
  })

  // REVERSE CONTROL for the `key={`${item.id}:${index}`}` choice in
  // SmartBarEngine.tsx. The duplicate-ids case above already proves the
  // rendered DOM matches vanilla; this proves the port does not BUY that
  // match with React's documented-unsupported duplicate-key behavior. Keyed
  // by `item.id` alone this test goes red (React logs "Encountered two
  // children with the same key") while the DOM assertion above stays green -
  // which is exactly why the DOM assertion alone was not enough.
  it('duplicate ids emit no React key warning', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    document.body.innerHTML = '<div id="smart-bar" hidden></div>'
    const mount = mountSmartBar(document.getElementById('smart-bar'))!
    mount.SmartBarEngine.applyFrame({
      items: [
        { id: 'dup', kind: 'info', value: 'first' },
        { id: 'dup', kind: 'info', value: 'second' },
      ],
    })
    const keyWarnings = err.mock.calls.map((c) => String(c[0])).filter((s) => /same key/i.test(s))
    err.mockRestore()
    expect(keyWarnings).toEqual([])
  })

  it('a malformed frame (items missing / non-array) behaves identically', () => {
    for (const frame of [{}, { items: null }, { items: 'nope' }, { items: 42 }]) {
      document.body.innerHTML = '<div id="smart-bar" hidden></div>'
      const vanilla = makeVanilla()
      vanilla.applyFrame(frame)
      const v = snapshot(document.getElementById('smart-bar')!)

      document.body.innerHTML = '<div id="smart-bar" hidden></div>'
      const mount = mountSmartBar(document.getElementById('smart-bar'))!
      mount.SmartBarEngine.applyFrame(frame as any)
      expect(snapshot(document.getElementById('smart-bar')!), JSON.stringify(frame)).toBe(v)
    }
  })
})
