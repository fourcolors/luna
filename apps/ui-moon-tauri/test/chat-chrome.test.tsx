// @vitest-environment jsdom
//
// Behavioral tests for chat.html's React 19 + Astryx title-bar chrome
// (frontend-react/chat.html's `#bar-title-root` / `#collapse-moon-btn-root`
// mount points -> frontend-react/src/chat/chat-chrome-mount.tsx, which
// reuses widget.html's CollapseMoonButton verbatim - see
// widget-chrome.test.tsx for that component's own direct coverage).
//
// Ports the two behavioral assertions the superseded suite made about this
// chrome:
//   - moon-dock.test.ts / chat-window.test.ts implicitly relied on
//     `#bar-title`'s static "Luna" textContent and `#collapse-moon-btn`'s
//     `invoke('collapse_to_moon')` click wiring - both covered here directly
//     against the real mount function.
//   - the redock-drag title() callback (chat.html's own inline script) reads
//     `#bar-title-root`'s textContent, which must still resolve to "Luna"
//     after mount (recursive text-node concatenation through the nested
//     Text span) - covered here too.
//
// Follows widget-chrome.test.tsx's createRoot + act pattern (no
// testing-library).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Tells React this jsdom environment is a synchronous-act test environment
// (React 19 warns without it - see https://react.dev/warnings/react-dom-test-utils).
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { mountChatChrome } from '../frontend-react/src/chat/chat-chrome-mount'

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

describe('mountChatChrome', () => {
  function domFixture() {
    document.body.innerHTML = `
      <div class="title-bar" id="title-bar">
        <div class="bar-start" aria-hidden="true"></div>
        <span class="bar-title" id="bar-title-root">Luna</span>
        <button class="redock-btn" id="redock-btn" type="button" hidden></button>
        <button class="newthread-btn" id="new-thread-btn"></button>
        <span id="collapse-moon-btn-root"></span>
      </div>
    `
  }

  it('mounts the static "Luna" title into #bar-title-root as a real .bar-title element', () => {
    domFixture()
    const invoke = vi.fn(async () => null)
    act(() => {
      mountChatChrome({ invoke })
    })
    expect(document.querySelector('#bar-title-root .bar-title')?.textContent).toBe('Luna')
    // The redock title() callback reads #bar-title-root's textContent
    // directly (recursive text-node concatenation) - confirm that still
    // resolves correctly through the nested mount.
    expect(document.getElementById('bar-title-root')?.textContent?.trim()).toBe('Luna')
  })

  it('mounts the collapse button into #collapse-moon-btn-root, carrying the original class', () => {
    domFixture()
    const invoke = vi.fn(async () => null)
    act(() => {
      mountChatChrome({ invoke })
    })
    const btn = document.querySelector('#collapse-moon-btn-root button.collapse-moon-btn')
    expect(btn).toBeTruthy()
    expect(btn!.getAttribute('aria-label')).toBe('Collapse into the moon')
  })

  it('clicking the collapse button invokes collapse_to_moon', () => {
    domFixture()
    const invoke = vi.fn(async () => null)
    act(() => {
      mountChatChrome({ invoke })
    })
    const btn = document.querySelector(
      '#collapse-moon-btn-root button.collapse-moon-btn',
    ) as HTMLButtonElement
    act(() => {
      btn.click()
    })
    expect(invoke).toHaveBeenCalledWith('collapse_to_moon')
  })

  it('leaves the redock-btn / new-thread-btn DOM completely untouched (outside this mount)', () => {
    domFixture()
    const invoke = vi.fn(async () => null)
    act(() => {
      mountChatChrome({ invoke })
    })
    const redock = document.getElementById('redock-btn')
    const newThread = document.getElementById('new-thread-btn')
    expect(redock).toBeTruthy()
    expect(redock!.hidden).toBe(true)
    expect(newThread).toBeTruthy()
  })

  it('degrades to a no-op mount when a slot is missing (matches every mount*Panel guard)', () => {
    document.body.innerHTML = '<div></div>'
    const invoke = vi.fn(async () => null)
    expect(() => {
      act(() => {
        mountChatChrome({ invoke })
      })
    }).not.toThrow()
  })
})

describe('chat.html chrome markup', () => {
  it('never writes bar-title/collapse-moon-btn DOM directly from the inline script', () => {
    const html = fs.readFileSync(
      path.resolve(__dirname, '../frontend-react/chat.html'),
      'utf8',
    )
    expect(html).toContain('id="bar-title-root"')
    expect(html).toContain('id="collapse-moon-btn-root"')
    expect(html).toContain('<script type="module" src="/src/main-chat.tsx"></script>')
    // The superseded static button + inline listener are gone…
    expect(html).not.toContain('id="collapse-moon-btn"')
    expect(html).not.toContain("invoke('collapse_to_moon')")
    // …and the inline script never reads/writes the old #bar-title id.
    expect(html).not.toContain("getElementById('bar-title')")
    // …while the redock-btn / new-thread-btn stay vanilla-owned, unchanged.
    expect(html).toContain('id="redock-btn"')
    expect(html).toContain('id="new-thread-btn"')
  })
})
