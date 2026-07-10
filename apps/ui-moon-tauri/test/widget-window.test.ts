// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('widget.html native window contract', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../frontend/widget.html'), 'utf8')

  it('keeps a title-bar handle for native dragging', () => {
    expect(html).toContain('class="title-bar"')
    expect(html).toContain('LunaDock.wire({ win: W, label: label })')
  })

  it('does not load the magnetic snap engine', () => {
    expect(html).not.toContain('vendor/deck-snap.js')
  })

  it('keeps collapse-to-moon as a separate Luna action', () => {
    expect(html).toContain('id="collapse-moon-btn"')
    expect(html).toContain("invoke('collapse_to_moon')")
  })
})
