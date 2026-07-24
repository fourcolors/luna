// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * widget-window.test.ts - native window contract, ported onto the React 19 +
 * Astryx page (frontend-react/widget.html - this is what actually ships; see
 * src-tauri/tauri.conf.json's `frontendDist`). The superseded
 * frontend/widget.html this suite used to read has been deleted (nothing
 * else imported it - see the React chrome's own module docs).
 *
 * The drag-handle and mount-point assertions below still read the raw HTML,
 * exactly like the original suite. The one assertion that moved is
 * "keeps collapse-to-moon as a separate Luna action": that affordance is now
 * a React-mounted Astryx Button (src/widget/WidgetChrome.tsx) instead of
 * static markup with an inline listener, so its "clicking it invokes
 * collapse_to_moon, independent of window-drag" behavior is verified at the
 * component level in widget-chrome.test.tsx instead of by grepping HTML text.
 */
describe('widget.html native window contract', () => {
  const html = fs.readFileSync(
    path.resolve(__dirname, '../frontend-react/widget.html'),
    'utf8',
  )

  it('keeps a title-bar handle for native dragging', () => {
    expect(html).toContain('class="title-bar"')
    expect(html).toContain('LunaDock.wire({ win: W, label: label })')
  })

  it('does not load the magnetic snap engine', () => {
    expect(html).not.toContain('vendor/deck-snap.js')
  })

  it('mounts the React-owned title-bar chrome into dedicated slots, and never writes their DOM directly from the inline script', () => {
    // The React chrome (main-widget.tsx -> widget/widget-chrome-mount.tsx)
    // owns both the title text and the collapse button - see
    // widget-chrome.test.tsx for their behavior.
    expect(html).toContain('id="bar-title-root"')
    expect(html).toContain('id="bar-end-root"')
    expect(html).toContain('<script type="module" src="/src/main-widget.tsx"></script>')
    // The superseded static button + inline listener are gone…
    expect(html).not.toContain('id="collapse-moon-btn"')
    expect(html).not.toContain("invoke('collapse_to_moon')")
    // …and the inline script only ever calls the React handle, never pokes
    // title-bar DOM directly.
    expect(html).toContain('window.__widgetChrome.setTitle(titleText)')
    expect(html).not.toContain("getElementById('bar-title')")
  })
})
