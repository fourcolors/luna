// @vitest-environment jsdom
//
// Behavioral tests for widget.html's React 19 + Astryx title-bar chrome
// (frontend/widget.html's inline `#bar-title` textContent write +
// `#collapse-moon-btn` click listener -> frontend-react/src/widget/
// WidgetChrome.tsx + widget-chrome-mount.tsx).
//
// Ports the two behavioral assertions the superseded suites made about this
// chrome:
//   - widget-window.test.ts: "keeps collapse-to-moon as a separate Luna
//     action" (`id="collapse-moon-btn"` + `invoke('collapse_to_moon')`) —
//     covered here by rendering the real Button and clicking it.
//   - widget-mcp.test.ts / widget-render.test.ts implicitly relied on
//     `#bar-title`'s textContent tracking whatever render() computed — that
//     contract is now `window.__widgetChrome.setTitle(text)` driving this
//     component's store, covered here directly.
//
// Follows settings-launcher-panel.test.tsx's createRoot + act pattern (no
// testing-library), same as panel-briefing.test.tsx.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Tells React this jsdom environment is a synchronous-act test environment
// (React 19 warns without it — see https://react.dev/warnings/react-dom-test-utils).
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import {
  CollapseMoonButton,
  WidgetTitleText,
  type WidgetChromeCtx,
} from '../frontend-react/src/widget/WidgetChrome'
import { mountWidgetChrome } from '../frontend-react/src/widget/widget-chrome-mount'
import {
  WIDGET_DEFAULT_TITLE,
  initialWidgetTitleState,
  reduceWidgetTitle,
} from '../frontend-react/src/widget/widgetTitleReducer'
import { createStore } from '../frontend-react/src/state/store'

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root!.render(el)
  })
  return container
}

afterEach(() => {
  if (root && container) {
    act(() => {
      root!.unmount()
    })
  }
  if (container) container.remove()
  container = null
  root = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('WidgetTitleText', () => {
  it('renders the store title inside a .bar-title element', () => {
    const store = createStore(reduceWidgetTitle, initialWidgetTitleState())
    const el = mount(<WidgetTitleText store={store} />)
    expect(el.querySelector('.bar-title')?.textContent).toBe(WIDGET_DEFAULT_TITLE)
  })

  it('re-renders when the store title changes (setTitle contract)', () => {
    const store = createStore(reduceWidgetTitle, initialWidgetTitleState())
    const el = mount(<WidgetTitleText store={store} />)
    act(() => {
      store.dispatch({ type: 'set-title', title: 'Workspace Pulse (MCP) · v1' })
    })
    expect(el.querySelector('.bar-title')?.textContent).toBe('Workspace Pulse (MCP) · v1')
  })
})

describe('CollapseMoonButton', () => {
  function makeCtx() {
    const invoke = vi.fn(async () => null)
    const ctx: WidgetChromeCtx = { invoke }
    return { ctx, invoke }
  }

  it('renders as a real <button> carrying the collapse-moon-btn class (unlayered CSS parity)', () => {
    const { ctx } = makeCtx()
    const el = mount(<CollapseMoonButton ctx={ctx} />)
    const btn = el.querySelector('button.collapse-moon-btn')
    expect(btn).toBeTruthy()
    expect(btn!.getAttribute('aria-label')).toBe('Collapse into the moon')
  })

  it('clicking it invokes collapse_to_moon — a separate Luna action from native window drag', () => {
    const { ctx, invoke } = makeCtx()
    const el = mount(<CollapseMoonButton ctx={ctx} />)
    const btn = el.querySelector('button.collapse-moon-btn') as HTMLButtonElement
    act(() => {
      btn.click()
    })
    expect(invoke).toHaveBeenCalledWith('collapse_to_moon')
  })

  it('swallows a rejected invoke (best-effort, matches the superseded inline listener)', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('not in Tauri')
    })
    const ctx: WidgetChromeCtx = { invoke }
    const el = mount(<CollapseMoonButton ctx={ctx} />)
    const btn = el.querySelector('button.collapse-moon-btn') as HTMLButtonElement
    await act(async () => {
      btn.click()
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith('collapse_to_moon')
  })
})

describe('mountWidgetChrome', () => {
  it('mounts the title text and collapse button into #bar-title-root/#bar-end-root, and returns a setTitle handle', () => {
    document.body.innerHTML = `
      <div class="title-bar" id="title-bar">
        <div class="bar-start" aria-hidden="true"></div>
        <span class="bar-title" id="bar-title-root">Loading…</span>
        <div class="bar-end" id="bar-end-root"></div>
      </div>
    `
    const invoke = vi.fn(async () => null)
    let handle: ReturnType<typeof mountWidgetChrome>
    act(() => {
      handle = mountWidgetChrome({ invoke })
    })

    expect(document.querySelector('#bar-title-root .bar-title')?.textContent).toBe(
      WIDGET_DEFAULT_TITLE,
    )
    expect(document.querySelector('#bar-end-root button.collapse-moon-btn')).toBeTruthy()

    act(() => {
      handle!.setTitle('Notes · v3')
    })
    expect(document.querySelector('#bar-title-root .bar-title')?.textContent).toBe('Notes · v3')
  })

  it('degrades to a no-op mount when a slot is missing (matches every mount*Panel guard)', () => {
    document.body.innerHTML = '<div></div>'
    const invoke = vi.fn(async () => null)
    expect(() => {
      act(() => {
        mountWidgetChrome({ invoke })
      })
    }).not.toThrow()
  })
})
