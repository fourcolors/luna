// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * widget-render.test.ts — kind-aware rendering in widget.html (Slice 2).
 *
 * Drives the REAL page script: an `artifact-update` frame for the window's own
 * id flows through the frame registry to render(). Asserts each kind takes its
 * SAFE path:
 *   - kind=html      → a live sandboxed <iframe> (allow-scripts, NO
 *                      allow-same-origin, strict-CSP srcdoc), content executes
 *                      only inside the cage
 *   - kind=markdown  → formatted via the XSS-safe LunaMarkdown pipeline
 *   - kind=code      → escaped source in pre>code (raw tags stay inert text)
 *
 * No WebSocket is constructed: load_connection→null keeps init() on the
 * not-connected path (same trick as widget-window.test.ts).
 */

const ART_ID = 'doc:test'

function loadVendorInto(target: unknown, file: string) {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../frontend/vendor', file),
    'utf8',
  )
  new Function('globalThis', src)(target)
}

interface CapturedRegistry {
  dispatch: (frame: unknown) => boolean
}

describe('widget.html — kind-aware render', () => {
  let registry: CapturedRegistry | null = null

  beforeEach(() => {
    // The window's artifact id comes from ?id=… ; set it so artifact-update matches.
    window.history.replaceState({}, '', '/?id=' + encodeURIComponent(ART_ID))

    const html = fs.readFileSync(
      path.resolve(__dirname, '../frontend/widget.html'),
      'utf8',
    )
    const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/)
    document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

    const win = window as unknown as Record<string, unknown>
    win.__TAURI__ = {
      window: {
        getCurrentWindow: () => ({
          label: 'widget-test',
          listen: vi.fn(async () => () => {}),
          onMoved: vi.fn(() => Promise.resolve(() => {})),
          isMinimized: vi.fn(async () => false),
          scaleFactor: vi.fn(async () => 1),
          outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
          outerSize: vi.fn(async () => ({ width: 300, height: 200 })),
          setPosition: vi.fn(async () => {}),
        }),
        Window: { getByLabel: vi.fn(async () => null) },
        PhysicalPosition: class { constructor(public x: number, public y: number) {} },
        LogicalPosition: class { constructor(public x: number, public y: number) {} },
      },
      // load_connection → null: stays "not connected", no WebSocket.
      core: { invoke: vi.fn(async (cmd: string) => (cmd === 'list_widget_windows' ? [] : null)) },
      event: { listen: vi.fn(async () => () => {}) },
    }

    loadVendorInto(window, 'moon-protocol.js')
    loadVendorInto(window, 'moon-ws.js')
    loadVendorInto(window, 'deck-snap.js')
    loadVendorInto(window, 'moon-dock.js')
    loadVendorInto(window, 'widget-sandbox.js')
    loadVendorInto(window, 'moon-markdown.js')
    // highlight.min.js deliberately NOT loaded — renderCode guards on window.hljs
    // and degrades to plain escaped text, which is all these assertions need.

    // Capture the frame registry the page builds so we can dispatch to render().
    const lunaWs = win.LunaWS as { createFrameRegistry: () => CapturedRegistry }
    const realCreate = lunaWs.createFrameRegistry.bind(lunaWs)
    lunaWs.createFrameRegistry = () => {
      registry = realCreate()
      return registry
    }

    const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .filter((s) => s!.includes('LunaDock.wire'))
    expect(inlineScripts).toHaveLength(1)
    new Function(inlineScripts[0]!)()
    expect(registry).not.toBeNull()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    const win = window as unknown as Record<string, unknown>
    for (const k of ['__TAURI__', 'LunaProtocol', 'LunaWS', 'LunaDeckSnap', 'LunaDock', 'LunaWidgetSandbox', 'LunaMarkdown']) {
      delete win[k]
    }
    registry = null
    vi.restoreAllMocks()
  })

  const render = (artifact: Record<string, unknown>) =>
    registry!.dispatch({ type: 'artifact-update', artifact })
  const contentArea = () => document.getElementById('content-area')!

  it('kind=html → live sandboxed iframe (allow-scripts, NO allow-same-origin); content in a strict-CSP srcdoc', () => {
    render({ id: ART_ID, kind: 'html', title: 'Preview', version: 1, content: '<h1>live</h1>' })
    const iframe = contentArea().querySelector('iframe')
    expect(iframe).toBeTruthy()
    expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe!.getAttribute('sandbox')).not.toContain('allow-same-origin')
    const srcdoc = iframe!.getAttribute('srcdoc') || ''
    expect(srcdoc).toContain('<h1>live</h1>')
    expect(srcdoc).toContain("default-src 'none'") // the no-network cage
    expect(srcdoc).toContain("connect-src 'none'")
  })

  it('kind=markdown → formatted via LunaMarkdown (real <h1>, not raw text, not an iframe)', () => {
    render({ id: ART_ID, kind: 'markdown', title: 'Notes', version: 1, content: '# Hello\n\nbody' })
    const md = contentArea().querySelector('.markdown-doc')
    expect(md).toBeTruthy()
    const h1 = md!.querySelector('h1')
    expect(h1).toBeTruthy()
    expect(h1!.textContent).toContain('Hello')
    expect(contentArea().querySelector('iframe')).toBeNull()
  })

  it('kind=markdown is XSS-safe — embedded HTML is escaped, no live nodes injected', () => {
    render({ id: ART_ID, kind: 'markdown', title: 'x', version: 1, content: 'hi <img src=x onerror="window.__xss=1">' })
    const md = contentArea().querySelector('.markdown-doc')!
    expect(md.querySelector('img')).toBeNull() // raw HTML was escaped, not parsed
    expect((window as unknown as Record<string, unknown>).__xss).toBeUndefined()
  })

  it('kind=code → escaped source in pre>code; raw tags stay inert text (no iframe)', () => {
    render({ id: ART_ID, kind: 'code', title: 'snippet', lang: 'ts', version: 1, content: 'const x = "<b>not bold</b>"' })
    const code = contentArea().querySelector('pre code')
    expect(code).toBeTruthy()
    expect(code!.textContent).toBe('const x = "<b>not bold</b>"')
    expect(code!.querySelector('b')).toBeNull() // the <b> is text, not an element
    expect(contentArea().querySelector('iframe')).toBeNull()
  })

  it('html SOURCE shown under kind=code is inert — a <script> never executes', () => {
    render({ id: ART_ID, kind: 'code', title: 'x', lang: 'html', version: 1, content: '<script>window.__xss2=1<\/script>' })
    expect((window as unknown as Record<string, unknown>).__xss2).toBeUndefined()
    expect(contentArea().querySelector('iframe')).toBeNull()
  })

  // ── External-link handling (bugfix: links in artifact windows never opened) ──
  // A kind=markdown artifact emits real <a href> tags. Without a delegated
  // handler a click would navigate THIS widget webview away from its content;
  // with it, the click is intercepted and handed to the native open_external_url
  // command (now granted to widget-* in capabilities/widgets.json).
  const invokeMock = () =>
    (window as unknown as { __TAURI__: { core: { invoke: ReturnType<typeof vi.fn> } } })
      .__TAURI__.core.invoke
  const clickAnchor = (a: HTMLAnchorElement) => {
    const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(ev)
    return ev
  }

  it('markdown external https link → routed to open_external_url; webview NOT navigated', () => {
    render({ id: ART_ID, kind: 'markdown', title: 'L', version: 1, content: '[docs](https://example.com/x)' })
    const a = contentArea().querySelector('a[href]') as HTMLAnchorElement
    expect(a).toBeTruthy()
    expect(a.getAttribute('href')).toBe('https://example.com/x')
    const invoke = invokeMock()
    invoke.mockClear()
    const ev = clickAnchor(a)
    expect(ev.defaultPrevented).toBe(true) // the webview does not follow the link
    expect(invoke).toHaveBeenCalledWith('open_external_url', { url: 'https://example.com/x' })
  })

  it('markdown mailto link → routed to open_external_url', () => {
    render({ id: ART_ID, kind: 'markdown', title: 'M', version: 1, content: '[mail](mailto:a@b.com)' })
    const a = contentArea().querySelector('a[href]') as HTMLAnchorElement
    expect(a).toBeTruthy()
    const invoke = invokeMock()
    invoke.mockClear()
    const ev = clickAnchor(a)
    expect(ev.defaultPrevented).toBe(true)
    expect(invoke).toHaveBeenCalledWith('open_external_url', { url: 'mailto:a@b.com' })
  })

  it('non-external scheme is not handed to the opener (but is still prevented from navigating)', () => {
    // luna:// links have no handler in a widget window; they must neither reach
    // the system opener nor navigate the webview.
    render({ id: ART_ID, kind: 'markdown', title: 'N', version: 1, content: '[panel](luna://widget/x)' })
    const a = contentArea().querySelector('a[href]') as HTMLAnchorElement | null
    expect(a).toBeTruthy()
    const invoke = invokeMock()
    invoke.mockClear()
    const ev = clickAnchor(a!)
    expect(ev.defaultPrevented).toBe(true)
    expect(invoke).not.toHaveBeenCalledWith('open_external_url', expect.anything())
  })

  it('http:// (non-https) link → prevented from navigating but NOT handed to the opener', () => {
    // The JS scheme gate mirrors the Rust open_external_url allowlist (https +
    // mailto only). http:// is deliberately refused by Rust, so routing it there
    // would only waste an IPC round-trip and log a warn; instead it is dropped in
    // JS after preventDefault — the webview never navigates, and no invoke fires.
    render({ id: ART_ID, kind: 'markdown', title: 'H', version: 1, content: '[insecure](http://example.com/x)' })
    const a = contentArea().querySelector('a[href]') as HTMLAnchorElement | null
    expect(a).toBeTruthy()
    expect(a!.getAttribute('href')).toBe('http://example.com/x')
    const invoke = invokeMock()
    invoke.mockClear()
    const ev = clickAnchor(a!)
    expect(ev.defaultPrevented).toBe(true) // anti-navigation preserved for every scheme
    expect(invoke).not.toHaveBeenCalled() // http:// dropped in JS: zero wasted IPC, no warn
  })
})
