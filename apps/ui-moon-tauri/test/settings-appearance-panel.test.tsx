// @vitest-environment jsdom
//
// Behavioral tests for the React 19 + Astryx port of the Appearance settings
// panel (frontend/panels/settings-appearance.js -> frontend-react/src/panels/
// SettingsAppearancePanel.tsx + settings-appearance-mount.tsx). Ports every
// behavioral assertion from the now-deleted test/panel-appearance.test.ts
// (which drove the vanilla frontend/panel.html + frontend/panels/
// settings-appearance.js through jsdom) onto the React implementation:
//   - boots with the Appearance title
//   - default state: tide/dark/wash/studio/no-grain/sans/medium
//   - every control writes its localStorage key AND re-stamps the matching
//     data-* attribute on <html> (vendor/moon-appearance.js's contract,
//     unchanged - this panel never stamps those attributes itself)
//   - a storage event from ANOTHER window re-syncs every control's active
//     state (cross-window sync)
//   - graceful fallback notice when window.LunaAppearance is unavailable
//
// This intentionally does NOT re-assert the vanilla version's `.chip`/`.on` /
// `.swatch`/`.active` class-based DOM contract - SegmentedControl/
// SegmentedControlItem (real role="radio" items) and ToggleButtonGroup/
// ToggleButton (real aria-pressed buttons) are the correct Astryx primitives
// for these single-select rows, so active state is asserted via
// aria-checked/aria-pressed instead. Every localStorage write and data-*
// stamp assertion carries over unchanged - that is the actual behavioral
// contract vendor/moon-appearance.js and every other Moon page depend on.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Tells React this jsdom environment is a synchronous-act test environment
// (React 19 warns without it - see https://react.dev/warnings/react-dom-test-utils).
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { SETTINGS_APPEARANCE_TITLE, SettingsAppearancePanel } from '../frontend-react/src/panels/SettingsAppearancePanel'
import {
  isSettingsAppearancePanelType,
  mountSettingsAppearancePanel,
} from '../frontend-react/src/panels/settings-appearance-mount'

/** Loads the REAL vendor/moon-appearance.js as a classic script into `target`
 *  - the same module every Moon page loads pre-paint in <head>, so this
 *  panel's behavior is verified against the actual localStorage/data-*
 *  contract, not a mock of it. */
function loadLunaAppearance(target: any) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor/moon-appearance.js'), 'utf8')
  new Function('globalThis', src)(target)
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderPanel() {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root!.render(<SettingsAppearancePanel />)
  })
  return container
}

function testid(id: string): HTMLElement {
  const el = document.querySelector(`[data-testid="${id}"]`)
  expect(el).not.toBeNull()
  return el as HTMLElement
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-palette')
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-chrome')
  document.documentElement.removeAttribute('data-skin')
  document.documentElement.removeAttribute('data-grain')
  document.documentElement.removeAttribute('data-font')
  document.documentElement.removeAttribute('data-fontsize')
  loadLunaAppearance(window)
})

afterEach(() => {
  if (root && container) {
    act(() => {
      root!.unmount()
    })
  }
  if (container) container.remove()
  container = null
  root = null
  delete (window as any).LunaAppearance
  localStorage.clear()
})

describe('SettingsAppearancePanel (React port of panels/settings-appearance.js)', () => {
  it('exports the same title bootModule()/mount used to render into #bar-title', () => {
    expect(SETTINGS_APPEARANCE_TITLE).toBe('Appearance')
  })

  it('renders 3 palette swatches - tide is active by default', () => {
    renderPanel()
    expect(testid('palette-dawn')).not.toBeNull()
    expect(testid('palette-meadow')).not.toBeNull()
    const tide = testid('palette-tide')
    expect(tide.getAttribute('aria-pressed')).toBe('true')
    expect(testid('palette-dawn').getAttribute('aria-pressed')).toBe('false')
  })

  it('"dark" is active by default', () => {
    renderPanel()
    expect(testid('theme-dark').getAttribute('aria-checked')).toBe('true')
    expect(testid('theme-light').getAttribute('aria-checked')).toBe('false')
  })

  it('"soft wash" chrome is active by default', () => {
    renderPanel()
    expect(testid('chrome-wash').getAttribute('aria-checked')).toBe('true')
    expect(testid('chrome-ink').getAttribute('aria-checked')).toBe('false')
  })

  it('"studio" skin is active by default', () => {
    renderPanel()
    expect(testid('skin-studio').getAttribute('aria-checked')).toBe('true')
    expect(testid('skin-classic').getAttribute('aria-checked')).toBe('false')
  })

  it('grain toggle is unchecked by default', () => {
    renderPanel()
    const toggle = testid('grain-toggle').querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(toggle.checked).toBe(false)
  })

  it('"sans" font and "medium" size are active by default', () => {
    renderPanel()
    expect(testid('font-sans').getAttribute('aria-pressed')).toBe('true')
    expect(testid('fontsize-medium').getAttribute('aria-checked')).toBe('true')
  })

  it('clicking the aqua skin chip writes luna_skin=aqua + stamps data-skin, moving the active state', () => {
    renderPanel()
    act(() => {
      testid('skin-aqua').click()
    })
    expect(localStorage.getItem('luna_skin')).toBe('aqua')
    expect(document.documentElement.getAttribute('data-skin')).toBe('aqua')
    expect(testid('skin-aqua').getAttribute('aria-checked')).toBe('true')
    expect(testid('skin-studio').getAttribute('aria-checked')).toBe('false')
  })

  it('clicking the dawn swatch writes luna_palette=dawn, stamps data-palette, and moves the active state', () => {
    renderPanel()
    act(() => {
      testid('palette-dawn').click()
    })
    expect(localStorage.getItem('luna_palette')).toBe('dawn')
    expect(document.documentElement.getAttribute('data-palette')).toBe('dawn')
    expect(testid('palette-dawn').getAttribute('aria-pressed')).toBe('true')
    expect(testid('palette-tide').getAttribute('aria-pressed')).toBe('false')
  })

  it('clicking "light" writes luna_theme=light, stamps data-theme, and moves the active state from dark', () => {
    renderPanel()
    act(() => {
      testid('theme-light').click()
    })
    expect(localStorage.getItem('luna_theme')).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(testid('theme-light').getAttribute('aria-checked')).toBe('true')
    expect(testid('theme-dark').getAttribute('aria-checked')).toBe('false')
  })

  it('checking the grain toggle writes luna_grain=true and stamps data-grain="on"', () => {
    renderPanel()
    const toggle = testid('grain-toggle').querySelector('input[type="checkbox"]') as HTMLInputElement
    act(() => {
      toggle.click()
    })
    expect(localStorage.getItem('luna_grain')).toBe('true')
    expect(document.documentElement.getAttribute('data-grain')).toBe('on')
  })

  it('unchecking the grain toggle writes luna_grain=false and stamps data-grain="off"', () => {
    localStorage.setItem('luna_grain', 'true')
    renderPanel()
    const toggle = testid('grain-toggle').querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    act(() => {
      toggle.click()
    })
    expect(localStorage.getItem('luna_grain')).toBe('false')
    expect(document.documentElement.getAttribute('data-grain')).toBe('off')
  })

  it('clicking the "serif" font chip writes luna_font=serif and stamps data-font', () => {
    renderPanel()
    act(() => {
      testid('font-serif').click()
    })
    expect(localStorage.getItem('luna_font')).toBe('serif')
    expect(document.documentElement.getAttribute('data-font')).toBe('serif')
    expect(testid('font-serif').getAttribute('aria-pressed')).toBe('true')
    expect(testid('font-sans').getAttribute('aria-pressed')).toBe('false')
  })

  it('clicking the "x-large" size chip writes luna_fontsize=xlarge and stamps data-fontsize', () => {
    renderPanel()
    act(() => {
      testid('fontsize-xlarge').click()
    })
    expect(localStorage.getItem('luna_fontsize')).toBe('xlarge')
    expect(document.documentElement.getAttribute('data-fontsize')).toBe('xlarge')
  })

  it('clicking "ink outline" writes luna_chrome=ink and stamps data-chrome', () => {
    renderPanel()
    act(() => {
      testid('chrome-ink').click()
    })
    expect(localStorage.getItem('luna_chrome')).toBe('ink')
    expect(document.documentElement.getAttribute('data-chrome')).toBe('ink')
  })

  it('reflects stored values (meadow/light/ink/grain/hand/small) on initial render', () => {
    localStorage.setItem('luna_palette', 'meadow')
    localStorage.setItem('luna_theme', 'light')
    localStorage.setItem('luna_chrome', 'ink')
    localStorage.setItem('luna_grain', 'true')
    localStorage.setItem('luna_font', 'hand')
    localStorage.setItem('luna_fontsize', 'small')
    renderPanel()

    expect(testid('palette-meadow').getAttribute('aria-pressed')).toBe('true')
    expect(testid('theme-light').getAttribute('aria-checked')).toBe('true')
    expect(testid('chrome-ink').getAttribute('aria-checked')).toBe('true')
    expect(testid('font-hand').getAttribute('aria-pressed')).toBe('true')
    expect(testid('fontsize-small').getAttribute('aria-checked')).toBe('true')
    const toggle = testid('grain-toggle').querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(toggle.checked).toBe(true)
  })

  // ── Cross-window sync: a `storage` event fired by ANOTHER window ─────────

  it('a storage event for luna_palette updates the active swatch', () => {
    renderPanel()
    localStorage.setItem('luna_palette', 'meadow')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'luna_palette', newValue: 'meadow' }))
    })
    expect(testid('palette-meadow').getAttribute('aria-pressed')).toBe('true')
    expect(testid('palette-tide').getAttribute('aria-pressed')).toBe('false')
  })

  it('a storage event for luna_theme updates the active theme chip', () => {
    renderPanel()
    localStorage.setItem('luna_theme', 'light')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'luna_theme', newValue: 'light' }))
    })
    expect(testid('theme-light').getAttribute('aria-checked')).toBe('true')
    expect(testid('theme-dark').getAttribute('aria-checked')).toBe('false')
  })

  it('a storage event for luna_grain updates the grain checkbox', () => {
    renderPanel()
    localStorage.setItem('luna_grain', 'true')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'luna_grain', newValue: 'true' }))
    })
    const toggle = testid('grain-toggle').querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(toggle.checked).toBe(true)
  })

  it('a storage event with key === null (localStorage.clear() elsewhere) re-syncs to defaults', () => {
    localStorage.setItem('luna_theme', 'light')
    renderPanel()
    expect(testid('theme-light').getAttribute('aria-checked')).toBe('true')
    localStorage.clear()
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }))
    })
    expect(testid('theme-dark').getAttribute('aria-checked')).toBe('true')
  })

  // ── LunaAppearance unavailable graceful fallback ──────────────────────────

  it('renders a fallback notice when LunaAppearance is not available', () => {
    delete (window as any).LunaAppearance
    renderPanel()
    const notice = document.querySelector('.notice')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toBe('Appearance controls are unavailable in this window.')
    expect(document.querySelectorAll('[data-testid="palette-tide"]')).toHaveLength(0)
  })
})

describe('isSettingsAppearancePanelType', () => {
  it('routes settings.appearance and nothing else', () => {
    expect(isSettingsAppearancePanelType('settings.appearance')).toBe(true)
    expect(isSettingsAppearancePanelType('settings.general')).toBe(false)
    expect(isSettingsAppearancePanelType('settings')).toBe(false)
  })
})

describe('mountSettingsAppearancePanel (panel.html contract parity)', () => {
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
    act(() => {
      mountSettingsAppearancePanel('settings.appearance', {} as any)
    })

    expect(document.getElementById('bar-title')!.textContent).toBe(SETTINGS_APPEARANCE_TITLE)
    expect(document.title).toBe(`Luna — ${SETTINGS_APPEARANCE_TITLE}`)
    expect(document.querySelectorAll('#content-area [data-testid]').length).toBeGreaterThan(0)
    expect((window as any).__PanelInternals).toEqual({
      type: 'settings.appearance',
      hasModule: true,
      resolvedRouteKey: null,
      lastNotice: null,
    })
  })
})
