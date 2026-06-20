import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

/**
 * REGRESSION GUARD — see docs/no-window-outline.md.
 *
 * The Moon card window (.widget-shell / ::before) must NEVER carry a crisp edge
 * ring, border, or outline — it renders as an unwanted hard line tracing the
 * whole window ("the outline" / "focus border"). Only the soft, blurred
 * --dk-win-shadow halo is allowed.
 *
 * This test fails if any skin or chrome re-introduces, on a .widget-shell rule:
 *   - a `box-shadow: 0 0 0 Npx …` ring (spread-only, no blur), or
 *   - a `border: …` (anything but none/0), or
 *   - an `outline: …` (anything but none/0).
 *
 * Transient affordances are exempt (they are not the persistent window edge):
 * .snapping / .dragging / .entering / .resize-* and the ::after snap ring.
 *
 * If this test fails: you brought the window outline back. Remove the offending
 * declaration — do NOT weaken this test.
 */
const FILES = ['vendor/moon-theme.css', 'vendor/moon-skins.css']

function ruleBlocks(css: string): { selector: string; body: string }[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks: { selector: string; body: string }[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(noComments))) blocks.push({ selector: m[1].trim(), body: m[2] })
  return blocks
}

describe('no window outline (docs/no-window-outline.md)', () => {
  for (const rel of FILES) {
    it(`${rel} draws no crisp ring / border / outline on .widget-shell`, () => {
      const css = readFileSync(resolve(__dirname, '../frontend', rel), 'utf8')
      const offenders: string[] = []
      for (const { selector, body } of ruleBlocks(css)) {
        if (!selector.includes('.widget-shell')) continue
        // Exempt the transient affordances + resize grips + the ::after snap ring.
        if (/\.(snapping|dragging|entering|resize)|::after/.test(selector)) continue
        if (/box-shadow:[^;]*\b0\s+0\s+0\s+[\d.]/.test(body)) offenders.push(`${selector}  →  crisp 0 0 0 Npx box-shadow ring`)
        if (/\bborder:\s*(?!none\b|0\b)/.test(body)) offenders.push(`${selector}  →  border`)
        if (/\boutline:\s*(?!none\b|0\b)/.test(body)) offenders.push(`${selector}  →  outline`)
      }
      expect(offenders, 'window-outline regression — see docs/no-window-outline.md').toEqual([])
    })
  }
})
