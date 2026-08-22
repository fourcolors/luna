import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

/**
 * REGRESSION GUARD - Astryx cascade-layer ordering.
 *
 * @astryxdesign/core ships EVERY rule inside a cascade layer (`@layer reset` in
 * reset.css, `@layer astryx-base` in astryx.css). Per the CSS cascade-layers
 * spec, UNLAYERED author rules beat LAYERED ones regardless of specificity - so
 * an unlayered universal reset in a Moon shell silently stomps the padding and
 * margin of every Astryx component in the app.
 *
 * That is not hypothetical: it shipped. Astryx's Button declares
 * paddingInline/paddingBlock, and rendered at `padding: 0` in every Moon panel
 * (measured), which is why the General settings panel's Record / Start fresh
 * buttons had text jammed against their edges.
 *
 * The fix: each shell wraps its box-model reset in `@layer moon-reset` and
 * declares `@layer moon-reset, reset, astryx-base, astryx-theme;` so Astryx's
 * layers win over the reset, while everything Astryx does not style still gets
 * the reset's zeroing (no UA default margins leak back in).
 *
 * This test fails if a shell reintroduces an UNLAYERED universal box-model
 * reset, or drops the layer-order statement.
 *
 * If this test fails: you re-broke every Astryx component's spacing. Put the
 * reset back inside `@layer moon-reset` - do NOT weaken this test.
 */
const SHELLS = ['index.html', 'chat.html', 'panel.html', 'widget.html']

/** Strip `@layer NAME { ... }` blocks so what remains is the UNLAYERED css. */
function stripLayerBlocks(css: string): string {
  let out = ''
  let i = 0
  while (i < css.length) {
    const at = css.indexOf('@layer', i)
    if (at === -1) { out += css.slice(i); break }
    const brace = css.indexOf('{', at)
    const semi = css.indexOf(';', at)
    // A bare `@layer a, b;` statement has no block - keep scanning past it.
    if (brace === -1 || (semi !== -1 && semi < brace)) {
      out += css.slice(i, semi === -1 ? css.length : semi + 1)
      i = semi === -1 ? css.length : semi + 1
      continue
    }
    out += css.slice(i, at)
    let depth = 0
    let j = brace
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') { depth--; if (depth === 0) { j++; break } }
    }
    i = j
  }
  return out
}

function inlineStyles(html: string): string {
  // Strip HTML comments FIRST. index.html's head prose contains the literal
  // text "<style>" inside a comment, and matching that as a real <style> tag
  // made an earlier version of this guard pass against markup where the layer
  // statement had actually been injected into the comment (i.e. dead CSS).
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '')
  return [...noComments.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
}

describe('Astryx cascade-layer order (src/styles/astryx-layer-order.css)', () => {
  for (const shell of SHELLS) {
    const html = () => readFileSync(resolve(__dirname, '../frontend-react', shell), 'utf8')

    it(`${shell} declares the moon-reset -> astryx layer order`, () => {
      expect(inlineStyles(html())).toContain('@layer moon-reset, reset, astryx-base, astryx-theme;')
    })

    it(`${shell} keeps its box-model reset OUT of the unlayered cascade`, () => {
      const unlayered = stripLayerBlocks(inlineStyles(html()))
        .replace(/\/\*[\s\S]*?\*\//g, '')

      const offenders: string[] = []
      const re = /([^{}]+)\{([^{}]*)\}/g
      let m: RegExpExecArray | null
      while ((m = re.exec(unlayered))) {
        const selector = m[1].trim()
        const body = m[2]
        // Only universal selectors can stomp arbitrary Astryx components.
        if (!/(^|,)\s*\*(\s*(,|$)|::)/.test(selector)) continue
        for (const prop of ['padding', 'margin']) {
          if (new RegExp(`\\b${prop}(-[a-z]+)?\\s*:`).test(body)) {
            offenders.push(`${selector}  ->  sets ${prop} while UNLAYERED`)
          }
        }
      }
      expect(offenders).toEqual([])
    })
  }
})
