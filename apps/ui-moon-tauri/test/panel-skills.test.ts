// @vitest-environment jsdom
//
// Behavioral tests for the settings.skills panel - ported from the vanilla
// frontend/panels/settings-skills.js module (see git history for the prior
// version of this file) onto the React/Astryx implementation,
// src/panels/settings-skills/SettingsSkillsPanel.tsx.
//
// Unlike the vanilla test (which booted the real panel.html string through a
// `new Function` harness), this drives the real React component directly:
// panel.html's own dispatch wiring (REACT_PANEL_TYPES -> panel-boot.tsx ->
// settings-skills-mount.tsx) hands this exact component the exact `ctx`
// contract built here - the component's own behavior is identical regardless
// of how it gets mounted. `ctx` is built by hand to mirror panel.html's real
// `ctx` object's legacy (no MoonSession) connectWs path byte-for-byte:
// `invoke('load_connection')` then `LunaWS.createClient(...).connect(wsUrl,
// wsToken)` - the same contract panel.html's inline script and every other
// panel test in this directory rely on.
//
// DOM lookups use data-testid (Astryx components generate their own ids via
// useId(), so getElementById-by-hardcoded-id - the vanilla test's approach -
// no longer applies to Astryx-rendered controls) except where this module
// still owns a plain element outright (search input, chips wrapper, list,
// error line, count).
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  SettingsSkillsPanel,
  SETTINGS_SKILLS_TITLE,
} from '../frontend-react/src/panels/settings-skills/SettingsSkillsPanel'
import {
  isSettingsSkillsPanelType,
  mountSettingsSkillsPanel,
} from '../frontend-react/src/panels/settings-skills-mount'
import type { PanelCtx } from '../frontend-react/src/panels/panel-ctx'

// Silences React's "not configured to support act(...)" warning noise - this
// file drives every render/state update through `act()` already; this flag
// just tells React the environment is test-aware so it stops asking.
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// jsdom does not implement window.matchMedia. @astryxdesign/core's useTheme
// (pulled in by Spinner, rendered by Switch/ToggleButton while
// isLoading/isPending - both hit by the toggle-pending and chip-click tests
// below) calls it unconditionally via its own useMediaQuery hook. This
// package's own test/vitest-setup.ts already installs the same stub, but
// that setupFile is wired into apps/ui-moon-tauri/vitest.config.ts only - the
// REPO-ROOT vitest.config.ts (the "root-level `bunx vitest run <path>`"
// runner) has no setupFiles at all, so this file stays self-sufficient
// under both invocations rather than depending on which config resolves.
// Static "no match, no listeners fire" implementation - nothing here asserts
// on live media-query changes, only that mounting doesn't throw.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = function matchMedia(query: string): MediaQueryList {
    return {
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false
      },
    } as MediaQueryList
  }
}

// ── MockWebSocket ─────────────────────────────────────────────────────────
// Same scriptable transport used by every other WS-backed panel test in this
// directory (moon-vendor.test.ts, the prior panel-skills.test.ts).
class MockWebSocket {
  static instances: MockWebSocket[] = []
  static OPEN = 1
  static CLOSED = 3
  url: string
  readyState = MockWebSocket.OPEN
  sent: string[] = []
  closed = false
  private listeners: Record<string, ((evt: any) => void)[]> = {}
  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }
  addEventListener(type: string, fn: (evt: any) => void) {
    ;(this.listeners[type] ||= []).push(fn)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
    this.readyState = MockWebSocket.CLOSED
  }
  fire(type: string, evt: any = {}) {
    for (const fn of this.listeners[type] || []) fn(evt)
  }
}

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

// Builds a `ctx` matching panel.html's real object's legacy connectWs branch
// (no MoonSession in this test environment -> `ctx.invoke('load_connection')`
// then `client.connect(wsUrl, wsToken)`, synchronously kicked off from
// connectWs() itself, exactly like panel.html's inline script does).
function makeCtx(opts: { invoke?: (cmd: string, args?: any) => any } = {}): { ctx: PanelCtx; invoke: any } {
  const invoke = vi.fn(async (cmd: string, args?: any) => {
    if (cmd === 'load_connection') return { wsUrl: 'ws://test-host/ui', wsToken: 'test-tok' }
    return opts.invoke ? opts.invoke(cmd, args) : null
  })
  const ctx: PanelCtx = {
    invoke,
    connectWs: (registry, wsOpts) => {
      const client = (window as any).LunaWS.createClient(Object.assign({ registry }, wsOpts || {}))
      invoke('load_connection').then((creds: any) => {
        if (creds && creds.wsUrl) client.connect(creds.wsUrl, creds.wsToken || null)
      })
      return client
    },
  }
  return { ctx, invoke }
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function lastSocket(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]!
}

function fireFrame(frame: object) {
  act(() => {
    lastSocket().fire('message', { data: JSON.stringify(frame) })
  })
}

function lastSent(): any {
  const sock = lastSocket()
  const raw = sock.sent[sock.sent.length - 1]
  return raw ? JSON.parse(raw) : null
}

const SKILL_A = { id: 'skill-a', name: 'Alpha', description: 'Does alpha things', enabled: true, source: 'builtin', category: 'writing', tags: [] }
const SKILL_B = { id: 'skill-b', name: 'Beta', description: 'Does beta things', enabled: false, source: 'user', category: 'code', tags: ['js'] }

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(ctx: PanelCtx) {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(createElement(SettingsSkillsPanel, { ctx }))
  })
}

function q(testId: string): HTMLElement | null {
  return container!.querySelector(`[data-testid="${testId}"]`)
}

function qAll(selector: string): NodeListOf<HTMLElement> {
  return container!.querySelectorAll(selector)
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  if (container) container.remove()
  container = null
  root = null
  delete (window as any).LunaWS
  delete (window as any).WebSocket
  MockWebSocket.instances = []
  vi.restoreAllMocks()
})

function bootPanel(opts: { invoke?: (cmd: string, args?: any) => any } = {}) {
  ;(window as any).WebSocket = MockWebSocket
  loadVendorInto(window, 'moon-ws.js')
  const { ctx, invoke } = makeCtx(opts)
  mount(ctx)
  return { invoke }
}

describe('settings.skills panel (React)', () => {
  it('initial render: key DOM regions are present', () => {
    bootPanel()
    expect(q('settings-skills-panel')).toBeTruthy()
    expect(q('skills-search-input')).toBeTruthy()
    expect(q('skills-list')).toBeTruthy()
    expect(q('skills-count')).toBeTruthy()
    expect(q('skills-chips')).toBeTruthy()
  })

  it('initial render: list shows "Not connected" placeholder before WS connects', () => {
    bootPanel()
    expect(q('skills-list')!.textContent).toContain('Not connected')
  })

  it('load_connection is invoked to get WS credentials', () => {
    const { invoke } = bootPanel()
    expect(invoke).toHaveBeenCalledWith('load_connection')
  })

  it('hello without skills capability: replaces content with notice, no list', async () => {
    bootPanel()
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: {} })
    expect(q('skills-notice')!.textContent).toBe("This server doesn't list skills.")
    expect(q('skills-list')).toBeNull()
  })

  it('hello with skills capability: controls stay rendered, no notice', async () => {
    bootPanel()
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    expect(q('skills-list')).toBeTruthy()
    expect(q('skills-notice')).toBeNull()
  })

  it('skill-catalog frame: renders skill rows with correct names and enabled state', async () => {
    bootPanel()
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    fireFrame({ type: 'skill-catalog', skills: [SKILL_A, SKILL_B] })

    const alphaRow = q('skill-row-skill-a')!
    expect(alphaRow.textContent).toContain('Alpha')
    expect(alphaRow.classList.contains('off')).toBe(false)
    expect((alphaRow.querySelector('input[role="switch"]') as HTMLInputElement).checked).toBe(true)

    const betaRow = q('skill-row-skill-b')!
    expect(betaRow.textContent).toContain('Beta')
    expect(betaRow.classList.contains('off')).toBe(true)
    expect((betaRow.querySelector('input[role="switch"]') as HTMLInputElement).checked).toBe(false)
  })

  it('skill-catalog frame: count badge reflects enabled/total', async () => {
    bootPanel()
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    fireFrame({ type: 'skill-catalog', skills: [SKILL_A, SKILL_B] })
    expect(q('skills-count')!.textContent).toContain('1/2')
  })

  it('clicking an enabled skill switch sends skill-toggle with enabled:false', async () => {
    bootPanel()
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    fireFrame({ type: 'skill-catalog', skills: [SKILL_A, SKILL_B] })

    const alphaSwitch = q('skill-row-skill-a')!.querySelector('input[role="switch"]') as HTMLInputElement
    act(() => {
      alphaSwitch.click()
    })

    expect(lastSent()).toEqual({ type: 'skill-toggle', id: 'skill-a', enabled: false })
  })

  it('clicking a disabled skill switch sends skill-toggle with enabled:true', async () => {
    bootPanel()
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    fireFrame({ type: 'skill-catalog', skills: [SKILL_A, SKILL_B] })

    const betaSwitch = q('skill-row-skill-b')!.querySelector('input[role="switch"]') as HTMLInputElement
    act(() => {
      betaSwitch.click()
    })

    expect(lastSent()).toEqual({ type: 'skill-toggle', id: 'skill-b', enabled: true })
  })

  it('toggle puts the switch into aria-busy until skill-status acks', async () => {
    bootPanel()
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    fireFrame({ type: 'skill-catalog', skills: [SKILL_A, SKILL_B] })

    const alphaSwitch = q('skill-row-skill-a')!.querySelector('input[role="switch"]') as HTMLInputElement
    act(() => {
      alphaSwitch.click()
    })
    expect(alphaSwitch.getAttribute('aria-busy')).toBe('true')

    fireFrame({ type: 'skill-status', id: 'skill-a', ok: true, enabled: false })
    const settled = q('skill-row-skill-a')!.querySelector('input[role="switch"]') as HTMLInputElement
    expect(settled.getAttribute('aria-busy')).toBeNull()
    expect(settled.checked).toBe(false)
  })

  it('skill-status with ok:false shows the error message', async () => {
    bootPanel()
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    fireFrame({ type: 'skill-catalog', skills: [SKILL_A] })

    const sw = q('skill-row-skill-a')!.querySelector('input[role="switch"]') as HTMLInputElement
    act(() => {
      sw.click()
    })

    fireFrame({ type: 'skill-status', id: 'skill-a', ok: false, message: 'Server rejected toggle' })

    expect(q('skills-error')!.textContent).toBe('Server rejected toggle')
  })

  it('search input filters the list by skill name', async () => {
    bootPanel()
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    fireFrame({ type: 'skill-catalog', skills: [SKILL_A, SKILL_B] })

    const input = q('skills-search-input') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, 'Beta')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(qAll('[data-testid^="skill-row-"]')).toHaveLength(1)
    expect(q('skill-row-skill-b')).toBeTruthy()
  })

  it('category chip filters the list', async () => {
    bootPanel()
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    fireFrame({ type: 'skill-catalog', skills: [SKILL_A, SKILL_B] })

    // ToggleButton renders its label twice (visible span + an aria-hidden
    // width-reservation span, both with the same text) - match by substring,
    // not exact equality, and rely on 'code' not being a substring of any
    // other chip's label ('all' / 'writing' / 'built-in' / 'yours' /
    // 'enabled only').
    const chips = qAll('[data-testid="skills-chips"] button')
    let codeChip: HTMLElement | null = null
    chips.forEach((c) => {
      if (c.textContent?.includes('code')) codeChip = c
    })
    expect(codeChip).toBeTruthy()
    // ToggleButton's clickAction runs inside a React transition (see the
    // installed 0.1.8 source) - await act() so that microtask settles before
    // asserting, instead of leaving it to resolve after the test returns.
    await act(async () => {
      ;(codeChip as unknown as HTMLElement).click()
    })

    expect(qAll('[data-testid^="skill-row-"]')).toHaveLength(1)
    expect(q('skill-row-skill-b')).toBeTruthy()
  })

  it('"enabled only" chip hides disabled skills', async () => {
    bootPanel()
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    fireFrame({ type: 'skill-catalog', skills: [SKILL_A, SKILL_B] })

    const chips = qAll('[data-testid="skills-chips"] button')
    let enabledOnlyChip: HTMLElement | null = null
    chips.forEach((c) => {
      if (c.textContent?.includes('enabled only')) enabledOnlyChip = c
    })
    expect(enabledOnlyChip).toBeTruthy()
    await act(async () => {
      ;(enabledOnlyChip as unknown as HTMLElement).click()
    })

    expect(qAll('[data-testid^="skill-row-"]')).toHaveLength(1)
    expect(q('skill-row-skill-a')).toBeTruthy()
  })
})

describe('isSettingsSkillsPanelType', () => {
  it('routes "settings.skills" and nothing else', () => {
    expect(isSettingsSkillsPanelType('settings.skills')).toBe(true)
    expect(isSettingsSkillsPanelType('settings.connectors')).toBe(false)
    expect(isSettingsSkillsPanelType('flow')).toBe(false)
  })
})

describe('mountSettingsSkillsPanel (panel.html contract parity)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).__PanelInternals
  })

  it('sets the bar title, document title, renders into #content-area, and sets __PanelInternals - matching what panel.html\'s bootModule() sets for vanilla panel types', () => {
    document.body.innerHTML = `
      <div class="widget-shell">
        <div class="title-bar" id="title-bar"><span id="bar-title">Loading…</span></div>
        <div class="content-area" id="content-area"></div>
      </div>
    `
    const { ctx } = makeCtx()
    act(() => {
      mountSettingsSkillsPanel('settings.skills', ctx)
    })

    expect(document.getElementById('bar-title')!.textContent).toBe(SETTINGS_SKILLS_TITLE)
    expect(document.title).toBe(`Luna — ${SETTINGS_SKILLS_TITLE}`)
    expect(document.querySelector('#content-area [data-testid="settings-skills-panel"]')).toBeTruthy()
    expect((window as any).__PanelInternals).toEqual({
      type: 'settings.skills',
      hasModule: true,
      resolvedRouteKey: null,
      lastNotice: null,
    })
  })
})
