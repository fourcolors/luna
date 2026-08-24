// @vitest-environment jsdom
//
// REGRESSION GUARD — the "invisible border".
//
// Panel/screen windows are transparent. On macOS they are ALSO natively
// decorated (decorations(true) + TitleBarStyle::Overlay in
// src-tauri/src/windows.rs), so AppKit draws the frame. The CSS card used to
// inset itself by --card-inset (22px) to leave room for its own halo — correct
// for a borderless window, but on a native frame that gutter is transparent
// WINDOW, so it showed the desktop as a band around every panel and screen and
// swallowed clicks near the edge.
//
// The fix keys the card geometry off html[data-native-frame], stamped pre-paint
// by moon-appearance.js. These tests pin the couplings that would silently
// bring the gutter back.
import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8')
const theme = read('frontend/vendor/moon-theme.css')
const appearance = read('frontend/vendor/moon-appearance.js')
const windowsRs = read('src-tauri/src/windows.rs')

/** Body of the first rule whose selector matches `pred` (and body matches `bodyPred`). */
function ruleBody(
  css: string,
  pred: (sel: string) => boolean,
  bodyPred: (body: string) => boolean = () => true,
): string | null {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(noComments))) if (pred(m[1].trim()) && bodyPred(m[2])) return m[2]
  return null
}
const decl = (body: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body)
  return m ? m[1].trim() : null
}
const px = (v: string | null): number | null => {
  if (v == null) return null
  const m = /^(-?[\d.]+)px$/.exec(v.trim())
  return m ? Number(m[1]) : null
}

describe('native frame collapses the card gutter (the "invisible border")', () => {
  const nativeTokens = ruleBody(theme, (s) => s === "html[data-native-frame='true']")

  it('zeroes both card insets when the OS draws the frame', () => {
    expect(
      nativeTokens,
      "no html[data-native-frame='true'] token block in moon-theme.css",
    ).toBeTruthy()
    // A non-zero inset on a TRANSPARENT, natively-framed window IS the bug:
    // it is a band of see-through window around the card.
    expect(px(decl(nativeTokens!, '--card-inset'))).toBe(0)
    expect(px(decl(nativeTokens!, '--card-inset-top'))).toBe(0)
  })

  it('keeps the card corner no larger than the OS window corner', () => {
    // The fill must reach whatever AppKit masks to. A radius LARGER than the
    // window's own leaves transparent wedges in the four corners — the same
    // class of bug, just localized to the corners.
    const r = px(decl(nativeTokens!, '--dk-radius'))
    expect(r).not.toBeNull()
    expect(r!).toBeGreaterThan(0)
    expect(r!).toBeLessThanOrEqual(10)
  })

  it('drops the CSS halo, including the dark-theme override', () => {
    // With a zero inset there is no transparent margin to cast into, so the
    // halo could only shear square against the window bounds.
    for (const sel of [
      "html[data-native-frame='true'] .widget-shell",
      "html[data-native-frame='true'][data-theme='dark'] .widget-shell",
    ]) {
      const body = ruleBody(theme, (s) =>
        s
          .split(',')
          .map((x) => x.trim())
          .includes(sel),
      )
      expect(body, `no box-shadow reset for ${sel}`).toBeTruthy()
      expect(decl(body!, 'box-shadow')).toBe('none')
    }
  })

  it('leaves the borderless-platform geometry untouched', () => {
    // Linux/Windows build with decorations(false): there the CSS card IS the
    // whole chrome and still needs its gutter + halo.
    const root = ruleBody(theme, (s) => s === ':root')
    expect(px(decl(root!, '--card-inset'))).toBe(22)
    expect(px(decl(root!, '--card-inset-top'))).toBe(6)
  })
})

describe('traffic lights track the card offset', () => {
  // The lights are placed in WINDOW coordinates but must land inside the CSS
  // header, which starts at --card-inset. Collapsing the inset without moving
  // them pushes the cluster 22px deeper into a header that reserves only 68px
  // for it. This is the coupling that drifts, so assert it arithmetically
  // rather than pinning magic numbers on both sides.
  const nativeTokens = ruleBody(theme, (s) => s === "html[data-native-frame='true']")!
  // Two rules share the `.title-bar` selector; the layout one carries padding.
  const titleBar = ruleBody(theme, (s) => s === '.title-bar', (b) => /padding\s*:/.test(b))!

  const rustConst = (name: string): number => {
    const m = new RegExp(`const ${name}: f64 = ([\\d.]+);`).exec(windowsRs)
    expect(m, `${name} not found in windows.rs`).toBeTruthy()
    return Number(m![1])
  }
  // .title-bar declares `padding: 0 14px` — take the horizontal component.
  const barPaddingX = (): number => {
    const m = /padding:\s*[\d.]+\w*\s+([\d.]+)px/.exec(titleBar)
    expect(m, '.title-bar horizontal padding not parseable').toBeTruthy()
    return Number(m![1])
  }

  it('x = --card-inset + title-bar horizontal padding', () => {
    const inset = px(decl(nativeTokens, '--card-inset'))!
    expect(rustConst('TRAFFIC_LIGHT_INSET_X')).toBe(inset + barPaddingX())
  })

  it('y clears the top inset and still fits the header', () => {
    const insetTop = px(decl(nativeTokens, '--card-inset-top'))!
    const y = rustConst('TRAFFIC_LIGHT_INSET_Y')
    expect(y).toBeGreaterThanOrEqual(insetTop)
    // Lights are ~12pt tall and the header is min-height:36px.
    expect(y + 12).toBeLessThanOrEqual(36)
  })
})

describe('shadow ownership follows frame ownership', () => {
  it('windows.rs never disables the shadow unconditionally', () => {
    // A native frame gets AppKit's shadow (the CSS halo is off there); a
    // borderless one keeps the CSS halo and no OS shadow. Either way the call
    // must be cfg-gated, never a bare `false`.
    expect(windowsRs).not.toMatch(/\.shadow\(false\)/)
    expect(windowsRs.match(/\.shadow\(cfg!\(target_os = "macos"\)\)/g)).toHaveLength(2)
  })

  it('the CSS and the Rust agree on which platform is natively framed', () => {
    // Both sides must say macOS, or the card geometry and the real window
    // frame disagree.
    expect(windowsRs.match(/\.decorations\(cfg!\(target_os = "macos"\)\)/g)).toHaveLength(2)
    expect(appearance).toMatch(/data-native-frame/)
    expect(appearance).toMatch(/Macintosh|Mac OS X/)
  })
})

describe('moon-appearance stamps data-native-frame pre-paint', () => {
  const load = (target: any) => new Function('globalThis', appearance)(target)
  const el = () => window.document.documentElement

  beforeEach(() => {
    window.localStorage.clear()
    el().removeAttribute('data-native-frame')
    delete (window as any).LunaAppearance
  })

  it('stamps false off macOS (borderless: keep the card + halo)', () => {
    load(window)
    expect(el().getAttribute('data-native-frame')).toBe('false')
  })

  it('stamps true on macOS', () => {
    // jsdom's navigator is read-only; shim just what the sniff reads.
    const fake = Object.create(window)
    fake.navigator = {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      platform: 'MacIntel',
    }
    load(fake)
    expect(el().getAttribute('data-native-frame')).toBe('true')
  })

  it('does not throw when navigator is absent', () => {
    const fake = Object.create(window)
    fake.navigator = undefined
    expect(() => load(fake)).not.toThrow()
    expect(el().getAttribute('data-native-frame')).toBe('false')
  })
})
