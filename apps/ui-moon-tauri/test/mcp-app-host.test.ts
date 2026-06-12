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
})

describe('LunaMcpHost — handshake', () => {
  it('answers ui/initialize with protocolVersion/host/capabilities under the SAME id', async () => {
    const rig = makeRig()
    await flush()
    rig.fromApp({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
      params: { protocolVersion: '2026-01-26', appInfo: { name: 'x' } },
    })
    expect(rig.posted).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2026-01-26',
          host: { name: 'luna-moon' },
          capabilities: { serverTools: {} },
        },
      },
    ])
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
