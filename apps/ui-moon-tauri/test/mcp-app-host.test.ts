// @vitest-environment jsdom
/**
 * mcp-app-host.test.ts — the CLIENT half of the MCP Apps host
 * (vendor/mcp-app-host.js, widget-system.md Phase 7).
 *
 * Drives the full JSON-RPC handshake against a real jsdom iframe:
 * initialize → initialized → tool-input, the tools/call round-trip through
 * the transport, the e.source trust boundary, and malformed-message
 * tolerance. The srcdoc must come from buildMcpSrcdoc — same CSP cage as
 * widgets but with NO luna.* shim (an MCP app brings its own protocol).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

function loadVendorInto(target: unknown, file: string) {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../frontend/vendor', file),
    'utf8',
  )
  new Function('globalThis', src)(target)
}

interface Transport {
  readResource: ReturnType<typeof vi.fn>
  callTool: ReturnType<typeof vi.fn>
}

interface Rig {
  iframe: HTMLIFrameElement
  transport: Transport
  onError: ReturnType<typeof vi.fn>
  handle: { dispose: () => void }
  /** Messages the host posted INTO the iframe. */
  posted: unknown[]
  /** Post a message to the host AS the app (source = iframe.contentWindow). */
  fromApp: (data: unknown) => void
  /** Post a message with a foreign/absent source. */
  fromStranger: (data: unknown) => void
}

const APP_HTML = '<p id="app">hello</p>'

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

function makeRig(overrides: Partial<Record<'readResource' | 'callTool', any>> = {}): Rig {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)

  const transport: Transport = {
    readResource: vi.fn(
      overrides.readResource ??
        (async () => ({ ok: true, mimeType: 'text/html;profile=mcp-app', text: APP_HTML })),
    ),
    callTool: vi.fn(
      overrides.callTool ??
        (async () => ({ ok: true, result: { structuredContent: { n: 1 } } })),
    ),
  }
  const onError = vi.fn()

  const handle = (window as any).LunaMcpHost.host({
    frameEl: iframe,
    uri: 'ui://luna/test-app',
    transport,
    onError,
  })

  const posted: unknown[] = []
  vi.spyOn(iframe.contentWindow as Window, 'postMessage').mockImplementation(
    ((msg: unknown) => {
      posted.push(msg)
    }) as any,
  )

  const dispatch = (data: unknown, source: unknown) => {
    const ev = new MessageEvent('message', { data })
    Object.defineProperty(ev, 'source', { value: source })
    window.dispatchEvent(ev)
  }

  return {
    iframe,
    transport,
    onError,
    handle,
    posted,
    fromApp: (data) => dispatch(data, iframe.contentWindow),
    fromStranger: (data) => dispatch(data, null),
  }
}

beforeEach(() => {
  loadVendorInto(window, 'widget-sandbox.js')
  loadVendorInto(window, 'mcp-app-host.js')
})

afterEach(() => {
  document.body.innerHTML = ''
  delete (window as any).LunaMcpHost
  delete (window as any).LunaWidgetSandbox
  vi.restoreAllMocks()
})

describe('LunaMcpHost — mount', () => {
  it('fetches the resource via the transport and mounts a NO-SHIM srcdoc with the widget CSP', async () => {
    const rig = makeRig()
    await flush()
    expect(rig.transport.readResource).toHaveBeenCalledWith('ui://luna/test-app')
    const doc = rig.iframe.srcdoc
    expect(doc).toContain(APP_HTML)
    expect(doc).toContain('http-equiv="Content-Security-Policy"')
    expect(doc).toContain("default-src 'none'")
    expect(doc).toContain("connect-src 'none'")
    // The whole point of buildMcpSrcdoc: NO luna.* bridge shim.
    expect(doc).not.toContain('window.luna')
    rig.handle.dispose()
  })

  it('surfaces a failed resource read through onError and never sets srcdoc', async () => {
    const rig = makeRig({
      readResource: async () => ({ ok: false, message: 'unknown app resource: ui://luna/test-app' }),
    })
    await flush()
    expect(rig.onError).toHaveBeenCalledWith('unknown app resource: ui://luna/test-app')
    expect(rig.iframe.srcdoc).toBe('')
    rig.handle.dispose()
  })

  it('inline html mode mounts the GENERATED cage (window.mcp helper) and never reads a resource', async () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const transport = {
      readResource: vi.fn(async () => ({ ok: true, text: '<p>x</p>' })),
      callTool: vi.fn(async () => ({ ok: true, result: {} })),
    }
    const onError = vi.fn()
    const handle = (window as any).LunaMcpHost.host({
      frameEl: iframe,
      uri: 'ui://luna/app/mcp-app%3Adash',
      html: '<h1 id="gen">GEN APP</h1>',
      transport,
      onError,
    })
    await flush()
    // Generated/inline apps render their HTML directly — no resource fetch.
    expect(transport.readResource).not.toHaveBeenCalled()
    const doc = iframe.srcdoc
    expect(doc).toContain('GEN APP')
    expect(doc).toContain('window.mcp') // the generated-cage client helper
    expect(doc).not.toContain('window.luna')
    expect(onError).not.toHaveBeenCalled()
    handle.dispose()
  })
})

describe('LunaMcpHost — handshake', () => {
  it('answers ui/initialize with protocolVersion/host/capabilities (+ G1 theme/styles) under the SAME id', async () => {
    const rig = makeRig()
    await flush()
    rig.fromApp({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
      params: { protocolVersion: '2026-01-26', appInfo: { name: 'x' } },
    })
    expect(rig.posted).toHaveLength(1)
    const reply = rig.posted[0] as any
    expect(reply.id).toBe(1)
    expect(reply.result.protocolVersion).toBe('2026-01-26')
    expect(reply.result.host).toEqual({ name: 'luna-moon' })
    expect(reply.result.capabilities).toEqual({ serverTools: {} })
    // G1: the host hands the app a theme + standardized style variables.
    expect(['dark', 'light']).toContain(reply.result.theme)
    expect(reply.result.styles).toHaveProperty('variables')
    rig.handle.dispose()
  })

  it('pushes ui/notifications/tool-input exactly once after the initialized notification', async () => {
    const rig = makeRig()
    await flush()
    rig.fromApp({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })
    rig.fromApp({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }) // dupe → no second push
    const toolInputs = rig.posted.filter(
      (m: any) => m && m.method === 'ui/notifications/tool-input',
    )
    expect(toolInputs).toEqual([
      { jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: {} } },
    ])
    rig.handle.dispose()
  })
})

describe('LunaMcpHost — tools/call', () => {
  it('routes tools/call through the transport and replies with the JSON-RPC result', async () => {
    const rig = makeRig()
    await flush()
    rig.fromApp({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'pulse-snapshot', arguments: { a: 1 } },
    })
    await flush()
    expect(rig.transport.callTool).toHaveBeenCalledWith('pulse-snapshot', { a: 1 })
    expect(rig.posted).toEqual([
      { jsonrpc: '2.0', id: 7, result: { structuredContent: { n: 1 } } },
    ])
    rig.handle.dispose()
  })

  it('maps a transport ok:false to a JSON-RPC error reply (same id)', async () => {
    const rig = makeRig({
      callTool: async () => ({ ok: false, message: 'tool "x" is not provided by ui://luna/test-app' }),
    })
    await flush()
    rig.fromApp({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'x' } })
    await flush()
    const reply = rig.posted[0] as any
    expect(reply.id).toBe(8)
    expect(reply.result).toBeUndefined()
    expect(reply.error.code).toBe(-32000)
    expect(reply.error.message).toContain('not provided')
    rig.handle.dispose()
  })

  it('replies method-not-found to unknown REQUESTS but stays silent on unknown notifications', async () => {
    const rig = makeRig()
    await flush()
    rig.fromApp({ jsonrpc: '2.0', id: 9, method: 'ui/request-display-mode', params: {} })
    const reply = rig.posted[0] as any
    expect(reply.error.code).toBe(-32601)
    rig.posted.length = 0
    rig.fromApp({ jsonrpc: '2.0', method: 'ui/notifications/whatever' })
    expect(rig.posted).toEqual([])
    rig.handle.dispose()
  })
})

describe('LunaMcpHost — trust boundary + robustness', () => {
  it('ignores messages whose source is NOT the app iframe (even a valid initialize)', async () => {
    const rig = makeRig()
    await flush()
    rig.fromStranger({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} })
    expect(rig.posted).toEqual([])
    expect(rig.transport.callTool).not.toHaveBeenCalled()
    rig.handle.dispose()
  })

  it('ignores malformed JSON-RPC (wrong version, no method, plain junk)', async () => {
    const rig = makeRig()
    await flush()
    rig.fromApp('just a string')
    rig.fromApp(null)
    rig.fromApp({ jsonrpc: '1.0', id: 1, method: 'ui/initialize' })
    rig.fromApp({ jsonrpc: '2.0', id: 2 }) // no method, no result/error
    rig.fromApp({ method: 'tools/call', id: 3 }) // missing jsonrpc
    expect(rig.posted).toEqual([])
    expect(rig.transport.callTool).not.toHaveBeenCalled()
    rig.handle.dispose()
  })

  it('dispose() inerts the listener — later app messages get no replies', async () => {
    const rig = makeRig()
    await flush()
    rig.handle.dispose()
    rig.fromApp({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} })
    expect(rig.posted).toEqual([])
  })
})

describe('LunaMcpHost — G1 host theme injection', () => {
  const SEP = () => (window as any).LunaMcpHost

  it('maps Luna tokens → SEP-1865 variables (canonical contract)', () => {
    const tokens: Record<string, string> = {
      '--paper': '#111',
      '--paper-2': '#222',
      '--wash-1': '#333',
      '--ink': '#eee',
      '--ink-soft': '#ccc',
      '--ink-faint': '#444',
      '--accent': '#5af',
      '--font-chat': 'Inter',
      '--font-mono': 'Menlo',
      '--radius': '10px',
    }
    const ctx = SEP().buildHostStyleContext((n: string) => tokens[n] ?? '', 'light')
    // This expected object is the canonical mapping contract — it MUST stay in
    // lockstep with the ui-shared ES source of truth
    // (packages/ui-shared/src/mcp-app-host.ts, asserted there too). If the two
    // maps drift, one of these two tests fails.
    expect(ctx).toEqual({
      theme: 'light',
      styles: {
        variables: {
          '--color-background-primary': '#111',
          '--color-background-secondary': '#222',
          '--color-background-tertiary': '#333',
          '--color-text-primary': '#eee',
          '--color-text-secondary': '#ccc',
          '--color-text-tertiary': '#444',
          '--color-border-primary': '#444',
          '--color-ring-primary': '#5af',
          '--font-sans': 'Inter',
          '--font-mono': 'Menlo',
          '--border-radius-md': '10px',
        },
      },
    })
  })

  it('omits empty tokens and normalizes an unknown theme to dark', () => {
    const ctx = SEP().buildHostStyleContext(() => '', 'weird')
    expect(ctx.theme).toBe('dark')
    expect(ctx.styles.variables).toEqual({})
  })

  it('pushes host-context-changed when the host theme attribute flips', async () => {
    const rig = makeRig()
    await flush()
    document.documentElement.setAttribute('data-theme', 'light')
    await flush()
    const changes = rig.posted.filter(
      (m: any) => m && m.method === 'ui/notifications/host-context-changed',
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    expect((changes[changes.length - 1] as any).params.theme).toBe('light')
    rig.handle.dispose()
    document.documentElement.removeAttribute('data-theme')
  })
})
