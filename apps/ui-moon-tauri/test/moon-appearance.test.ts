// @vitest-environment jsdom
//
// Behavioral tests for moon-appearance.js — the IIFE that stamps
// data-palette/data-theme/data-chrome/data-grain on documentElement from
// localStorage and keeps them live via storage events.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Same loader pattern as moon-vendor.test.ts: inject the file's source into
// the window context so the IIFE receives `window` as its `globalThis`.
function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

// Convenience aliases
const el = () => window.document.documentElement
const A = () => (window as any).LunaAppearance

beforeEach(() => {
  // Start each test with a clean slate: no stored prefs, no data attributes,
  // no LunaAppearance global from a prior load.
  window.localStorage.clear()
  el().removeAttribute('data-palette')
  el().removeAttribute('data-theme')
  el().removeAttribute('data-chrome')
  el().removeAttribute('data-grain')
  delete (window as any).LunaAppearance
})

afterEach(() => {
  delete (window as any).LunaAppearance
  window.localStorage.clear()
})

// ---------------------------------------------------------------------------
// 1. Fresh load — no stored keys → defaults
// ---------------------------------------------------------------------------
describe('fresh load (no stored keys)', () => {
  it('stamps default data-palette="tide"', () => {
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-palette')).toBe('tide')
  })

  it('stamps default data-theme="dark"', () => {
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-theme')).toBe('dark')
  })

  it('stamps default data-chrome="wash"', () => {
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-chrome')).toBe('wash')
  })

  it('stamps default data-grain="off" (grain default is false)', () => {
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-grain')).toBe('off')
  })

  it('get() returns all defaults with grain as boolean false', () => {
    loadVendorInto(window, 'moon-appearance.js')
    expect(A().get()).toEqual({
      palette: 'tide',
      theme: 'dark',
      chrome: 'wash',
      grain: false,
      font: 'sans',
      fontSize: 'medium',
    })
  })

  it('stamps default data-font="sans" and data-fontsize="medium"', () => {
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-font')).toBe('sans')
    expect(el().getAttribute('data-fontsize')).toBe('medium')
  })
})

// ---------------------------------------------------------------------------
// 2. Stored valid values → attributes reflect them
// ---------------------------------------------------------------------------
describe('stored valid values', () => {
  it('reads palette=dawn from localStorage', () => {
    window.localStorage.setItem('luna_palette', 'dawn')
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-palette')).toBe('dawn')
  })

  it('reads palette=meadow from localStorage', () => {
    window.localStorage.setItem('luna_palette', 'meadow')
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-palette')).toBe('meadow')
  })

  it('reads theme=light from localStorage', () => {
    window.localStorage.setItem('luna_theme', 'light')
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-theme')).toBe('light')
  })

  it('reads chrome=ink from localStorage', () => {
    window.localStorage.setItem('luna_chrome', 'ink')
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-chrome')).toBe('ink')
  })

  it('grain=true maps to data-grain="on"', () => {
    window.localStorage.setItem('luna_grain', 'true')
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-grain')).toBe('on')
  })

  it('grain=false maps to data-grain="off"', () => {
    window.localStorage.setItem('luna_grain', 'false')
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-grain')).toBe('off')
  })

  it('get().grain is boolean true when luna_grain="true"', () => {
    window.localStorage.setItem('luna_grain', 'true')
    loadVendorInto(window, 'moon-appearance.js')
    expect(A().get().grain).toBe(true)
    expect(typeof A().get().grain).toBe('boolean')
  })
})

// ---------------------------------------------------------------------------
// 3. Invalid stored values → fall back to defaults
// ---------------------------------------------------------------------------
describe('invalid stored values fall back to defaults', () => {
  it('unknown palette value falls back to "tide"', () => {
    window.localStorage.setItem('luna_palette', 'neon')
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-palette')).toBe('tide')
  })

  it('unknown theme value falls back to "dark"', () => {
    window.localStorage.setItem('luna_theme', 'blurple')
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-theme')).toBe('dark')
  })

  it('unknown chrome value falls back to "wash"', () => {
    window.localStorage.setItem('luna_chrome', 'garbage')
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-chrome')).toBe('wash')
  })

  it('unknown grain value falls back to "off"', () => {
    window.localStorage.setItem('luna_grain', 'yes')
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-grain')).toBe('off')
  })

  it('empty-string palette value falls back to "tide"', () => {
    window.localStorage.setItem('luna_palette', '')
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-palette')).toBe('tide')
  })
})

// ---------------------------------------------------------------------------
// 4. set() persists + applies; invalid set is a no-op
// ---------------------------------------------------------------------------
describe('set()', () => {
  beforeEach(() => {
    loadVendorInto(window, 'moon-appearance.js')
  })

  it('set("palette","meadow") updates localStorage', () => {
    A().set('palette', 'meadow')
    expect(window.localStorage.getItem('luna_palette')).toBe('meadow')
  })

  it('set("palette","meadow") updates the data-palette attribute immediately', () => {
    A().set('palette', 'meadow')
    expect(el().getAttribute('data-palette')).toBe('meadow')
  })

  it('set("theme","light") updates localStorage and attribute', () => {
    A().set('theme', 'light')
    expect(window.localStorage.getItem('luna_theme')).toBe('light')
    expect(el().getAttribute('data-theme')).toBe('light')
  })

  it('set("chrome","ink") updates localStorage and attribute', () => {
    A().set('chrome', 'ink')
    expect(window.localStorage.getItem('luna_chrome')).toBe('ink')
    expect(el().getAttribute('data-chrome')).toBe('ink')
  })

  it('set("grain","true") maps to data-grain="on"', () => {
    A().set('grain', 'true')
    expect(el().getAttribute('data-grain')).toBe('on')
    expect(window.localStorage.getItem('luna_grain')).toBe('true')
  })

  it('set with invalid value is a no-op — localStorage unchanged', () => {
    const before = window.localStorage.getItem('luna_palette')
    A().set('palette', 'invalid-value')
    expect(window.localStorage.getItem('luna_palette')).toBe(before)
  })

  it('set with invalid value is a no-op — attribute unchanged', () => {
    const before = el().getAttribute('data-palette')
    A().set('palette', 'invalid-value')
    expect(el().getAttribute('data-palette')).toBe(before)
  })

  it('set with unknown key is a no-op', () => {
    A().set('nonexistent', 'tide')
    expect((window as any).LunaAppearance).toBeDefined()
    expect(el().getAttribute('data-palette')).toBe('tide') // default unchanged
  })
})

// ---------------------------------------------------------------------------
// 5. storage event for a specific key → attributes re-stamped
// ---------------------------------------------------------------------------
describe('storage event — specific key', () => {
  it('storage event for luna_theme triggers re-apply with new value', () => {
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-theme')).toBe('dark')

    // Simulate another window writing luna_theme=light
    window.localStorage.setItem('luna_theme', 'light')
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'luna_theme',
      newValue: 'light',
      storageArea: window.localStorage,
    }))
    expect(el().getAttribute('data-theme')).toBe('light')
  })

  it('storage event for luna_palette triggers re-apply', () => {
    loadVendorInto(window, 'moon-appearance.js')
    window.localStorage.setItem('luna_palette', 'dawn')
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'luna_palette',
      newValue: 'dawn',
      storageArea: window.localStorage,
    }))
    expect(el().getAttribute('data-palette')).toBe('dawn')
  })

  it('storage event for luna_chrome triggers re-apply', () => {
    loadVendorInto(window, 'moon-appearance.js')
    window.localStorage.setItem('luna_chrome', 'ink')
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'luna_chrome',
      newValue: 'ink',
      storageArea: window.localStorage,
    }))
    expect(el().getAttribute('data-chrome')).toBe('ink')
  })

  it('storage event for luna_grain triggers re-apply', () => {
    loadVendorInto(window, 'moon-appearance.js')
    window.localStorage.setItem('luna_grain', 'true')
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'luna_grain',
      newValue: 'true',
      storageArea: window.localStorage,
    }))
    expect(el().getAttribute('data-grain')).toBe('on')
  })

  it('storage event for an unrelated key does NOT re-apply', () => {
    // Pre-set a valid theme so we can verify it was NOT overwritten
    window.localStorage.setItem('luna_theme', 'light')
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-theme')).toBe('light')

    // Change luna_theme in storage but fire an unrelated key
    window.localStorage.setItem('luna_theme', 'dark')
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'some_other_key',
      newValue: 'anything',
      storageArea: window.localStorage,
    }))
    // apply() was NOT called — attribute reflects the load-time value
    expect(el().getAttribute('data-theme')).toBe('light')
  })
})

// ---------------------------------------------------------------------------
// 6. storage event with key=null (localStorage.clear()) → back to defaults
// ---------------------------------------------------------------------------
describe('storage event — key null (clear)', () => {
  it('key=null event re-applies and attributes return to defaults', () => {
    window.localStorage.setItem('luna_palette', 'dawn')
    window.localStorage.setItem('luna_theme', 'light')
    window.localStorage.setItem('luna_chrome', 'ink')
    window.localStorage.setItem('luna_grain', 'true')
    loadVendorInto(window, 'moon-appearance.js')

    // Verify non-default state was applied
    expect(el().getAttribute('data-palette')).toBe('dawn')
    expect(el().getAttribute('data-grain')).toBe('on')

    // Simulate another window calling localStorage.clear()
    window.localStorage.clear()
    window.dispatchEvent(new StorageEvent('storage', {
      key: null,
      storageArea: window.localStorage,
    }))

    expect(el().getAttribute('data-palette')).toBe('tide')
    expect(el().getAttribute('data-theme')).toBe('dark')
    expect(el().getAttribute('data-chrome')).toBe('wash')
    expect(el().getAttribute('data-grain')).toBe('off')
  })
})

// ---------------------------------------------------------------------------
// 6b. font + fontSize — the chat typeface/size dimensions
// ---------------------------------------------------------------------------
describe('font + fontSize', () => {
  it('reads stored font=serif and fontsize=large', () => {
    window.localStorage.setItem('luna_font', 'serif')
    window.localStorage.setItem('luna_fontsize', 'large')
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-font')).toBe('serif')
    expect(el().getAttribute('data-fontsize')).toBe('large')
    expect(A().get().font).toBe('serif')
    expect(A().get().fontSize).toBe('large')
  })

  it('unknown font / fontsize values fall back to defaults', () => {
    window.localStorage.setItem('luna_font', 'comic-sans')
    window.localStorage.setItem('luna_fontsize', 'gigantic')
    loadVendorInto(window, 'moon-appearance.js')
    expect(el().getAttribute('data-font')).toBe('sans')
    expect(el().getAttribute('data-fontsize')).toBe('medium')
  })

  it('set("font","hand") persists + stamps data-font', () => {
    loadVendorInto(window, 'moon-appearance.js')
    A().set('font', 'hand')
    expect(window.localStorage.getItem('luna_font')).toBe('hand')
    expect(el().getAttribute('data-font')).toBe('hand')
  })

  it('set("fontSize","xlarge") persists + stamps data-fontsize', () => {
    loadVendorInto(window, 'moon-appearance.js')
    A().set('fontSize', 'xlarge')
    expect(window.localStorage.getItem('luna_fontsize')).toBe('xlarge')
    expect(el().getAttribute('data-fontsize')).toBe('xlarge')
  })

  it('set with an invalid font is a no-op', () => {
    loadVendorInto(window, 'moon-appearance.js')
    A().set('font', 'wingdings')
    expect(el().getAttribute('data-font')).toBe('sans')
  })

  it('storage event for luna_font re-applies the new value', () => {
    loadVendorInto(window, 'moon-appearance.js')
    window.localStorage.setItem('luna_font', 'mono')
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'luna_font',
      newValue: 'mono',
      storageArea: window.localStorage,
    }))
    expect(el().getAttribute('data-font')).toBe('mono')
  })

  it('storage event for luna_fontsize re-applies the new value', () => {
    loadVendorInto(window, 'moon-appearance.js')
    window.localStorage.setItem('luna_fontsize', 'small')
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'luna_fontsize',
      newValue: 'small',
      storageArea: window.localStorage,
    }))
    expect(el().getAttribute('data-fontsize')).toBe('small')
  })
})

// ---------------------------------------------------------------------------
// 7. API surface — get().grain is boolean; KEYS/DEFAULTS exposed
// ---------------------------------------------------------------------------
describe('API surface', () => {
  beforeEach(() => {
    loadVendorInto(window, 'moon-appearance.js')
  })

  it('get().grain is always a boolean (not a string)', () => {
    expect(typeof A().get().grain).toBe('boolean')
  })

  it('KEYS maps the six preference names', () => {
    const keys = A().KEYS
    expect(keys.palette).toBe('luna_palette')
    expect(keys.theme).toBe('luna_theme')
    expect(keys.chrome).toBe('luna_chrome')
    expect(keys.grain).toBe('luna_grain')
    expect(keys.font).toBe('luna_font')
    expect(keys.fontSize).toBe('luna_fontsize')
  })

  it('DEFAULTS maps the six preference names', () => {
    const defaults = A().DEFAULTS
    expect(defaults.palette).toBe('tide')
    expect(defaults.theme).toBe('dark')
    expect(defaults.chrome).toBe('wash')
    expect(defaults.grain).toBe('false')
    expect(defaults.font).toBe('sans')
    expect(defaults.fontSize).toBe('medium')
  })

  it('DEFAULTS.grain is the string "false" (as stored in localStorage)', () => {
    // The module stores 'true'/'false' as strings; get() converts to boolean.
    // DEFAULTS.grain must be the raw string 'false', not the boolean false.
    expect(A().DEFAULTS.grain).toBe('false')
    expect(typeof A().DEFAULTS.grain).toBe('string')
  })

  it('exposes apply() as a callable function', () => {
    expect(typeof A().apply).toBe('function')
  })

  it('apply() can be called directly and re-stamps attributes', () => {
    window.localStorage.setItem('luna_palette', 'meadow')
    A().apply()
    expect(el().getAttribute('data-palette')).toBe('meadow')
  })

  it('LunaAppearance is exposed on window', () => {
    expect((window as any).LunaAppearance).toBeDefined()
    expect(typeof (window as any).LunaAppearance).toBe('object')
  })
})
