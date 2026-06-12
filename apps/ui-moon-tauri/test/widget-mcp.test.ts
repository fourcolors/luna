// @vitest-environment jsdom
/**
 * widget-mcp.test.ts — widget.html's kind='mcp-app' render path
 * (widget-system.md Phase 7).
 *
 * Drives the REAL inline script over the panel-test MockWebSocket harness:
 * an mcp-app artifact (content = its ui:// uri) must fetch the app template
 * through the `mcp-resource-read` relay frame, mount it in the SAME sandbox
 * cage WITHOUT the luna.* shim, stamp every app `tools/call` with its OWN
 * appUri on the `mcp-tool-call` frame, and degrade honestly when the server
 * lacks the mcpApps capability.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── MockWebSocket (verbatim pattern from panel-now.test.ts) ───────────────
class MockWebSocket {
  static instances: MockWebSocket[] = []
  static OPEN = 1
  static CLOSED = 3
  url: string
  readyState = MockWebSocket.OPEN
  sent: string[] = []
  closed = false
  private listeners: Record<string, ((evt: any) => void)[]> = {}
  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }
  addEventListener(type: string, fn: (evt: any) => void) {
    ;(this.listeners[type] ||= []).push(fn)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
    this.readyState = MockWebSocket.CLOSED
  }
  fire(type: string, evt: any = {}) {
    for (const fn of this.listeners[type] || []) fn(evt)
  }
}

function loadVendorInto(target: unknown, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

const html = fs.readFileSync(path.resolve(__dirname, '../frontend/widget.html'), 'utf8')

const ARTIFACT_ID = 'probe-mcp-pulse'
const APP_URI = 'ui://luna/workspace-pulse'
const APP_HTML = '<p id="mcp-app-body">pulse</p>'

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

function sock(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]
}
function allSent(): any[] {
  return sock().sent.map((s) => JSON.parse(s))
}
function fireFrame(frame: object) {
  sock().fire('message', { data: JSON.stringify(frame) })
}

async function boot(opts: { mcpApps: boolean } = { mcpApps: true }) {
  const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/)
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'load_connection') return { wsUrl: 'ws://test-host/ui', wsToken: 'tok' }
    return null
  })
  // No `window` key → W stays null; LunaDock is not loaded (guarded ref).
  ;(window as any).__TAURI__ = { core: { invoke } }
  ;(window as any).WebSocket = MockWebSocket
  window.history.replaceState({}, '', '/widget.html?id=' + ARTIFACT_ID)

  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')
  loadVendorInto(window, 'widget-sandbox.js')
  loadVendorInto(window, 'mcp-app-host.js')

  const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.includes('LunaDock.wire'))
  expect(inlineScripts).toHaveLength(1)
  new Function(inlineScripts[0])()

  await flush() // init() → load_connection → connect
  sock().fire('open')
  fireFrame({
    type: 'hello',
    protocolVersion: 2,
    kinds: [],
    capabilities: { chat: true, streamingDeltas: true, localShell: false, setup: false,
      turnComplete: true, artifacts: true, mcpApps: opts.mcpApps },
  })
  fireFrame({
    type: 'artifact-list',
    artifacts: [{
      id: ARTIFACT_ID, kind: 'mcp-app', title: 'Workspace Pulse (MCP)', lang: null,
      content: APP_URI, origin: null, version: 1, pinnedAt: 0, updatedAt: 0, bridgeCaps: null,
    }],
  })
  await flush()
}

afterEach(() => {
  document.body.innerHTML = ''
  MockWebSocket.instances = []
  delete (window as any).__TAURI__
  delete (window as any).WebSocket
  delete (window as any).LunaProtocol
  delete (window as any).LunaWS
  delete (window as any).LunaWidgetSandbox
  delete (window as any).LunaMcpHost
  vi.restoreAllMocks()
})

describe('widget.html — kind=mcp-app renders through LunaMcpHost', () => {
  it('fetches the ui:// resource over the relay and mounts a NO-SHIM sandboxed iframe', async () => {
    await boot()

    // The render path asked the server for the app template…
    const read = allSent().find((f) => f.type === 'mcp-resource-read')
    expect(read).toBeTruthy()
    expect(read.uri).toBe(APP_URI)
    expect(typeof read.requestId).toBe('string')

    // …and mounts the result in the widget sandbox, WITHOUT the luna shim.
    fireFrame({
      type: 'mcp-resource-result', requestId: read.requestId, ok: true,
      mimeType: 'text/html;profile=mcp-app', text: APP_HTML,
    })
    await flush()
    const iframe = document.querySelector('.content-area iframe') as HTMLIFrameElement
    expect(iframe).toBeTruthy()
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.srcdoc).toContain(APP_HTML)
    expect(iframe.srcdoc).toContain("connect-src 'none'")
    expect(iframe.srcdoc).not.toContain('window.luna')
    // Title bar renders like any artifact window.
    expect(document.getElementById('bar-title')!.textContent).toBe('Workspace Pulse (MCP) · v1')
  })

  it("relays the app's tools/call stamped with ITS OWN appUri and routes the result back in", async () => {
    await boot()
    const read = allSent().find((f) => f.type === 'mcp-resource-read')
    fireFrame({ type: 'mcp-resource-result', requestId: read.requestId, ok: true, text: APP_HTML })
    await flush()

    const iframe = document.querySelector('.content-area iframe') as HTMLIFrameElement
    const posted: unknown[] = []
    vi.spyOn(iframe.contentWindow as Window, 'postMessage').mockImplementation(
      ((msg: unknown) => { posted.push(msg) }) as any,
    )

    // The app calls pulse-snapshot.
    const ev = new MessageEvent('message', {
      data: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pulse-snapshot', arguments: {} } },
    })
    Object.defineProperty(ev, 'source', { value: iframe.contentWindow })
    window.dispatchEvent(ev)

    const call = allSent().find((f) => f.type === 'mcp-tool-call')
    expect(call).toBeTruthy()
    expect(call.appUri).toBe(APP_URI) // the same-app rule's client-side half
    expect(call.tool).toBe('pulse-snapshot')
    expect(call.args).toEqual({})

    // Server replies → the host answers the app's JSON-RPC request.
    fireFrame({
      type: 'mcp-tool-result', requestId: call.requestId, ok: true,
      result: { structuredContent: { toolsCalled: 5 } },
    })
    await flush()
    expect(posted).toEqual([
      { jsonrpc: '2.0', id: 3, result: { structuredContent: { toolsCalled: 5 } } },
    ])
  })

  it('a failed resource read shows a notice instead of a frame', async () => {
    await boot()
    const read = allSent().find((f) => f.type === 'mcp-resource-read')
    fireFrame({
      type: 'mcp-resource-result', requestId: read.requestId, ok: false,
      message: 'unknown app resource: ' + APP_URI,
    })
    await flush()
    expect(document.querySelector('.content-area iframe')).toBeNull()
    expect(document.querySelector('.notice')!.textContent).toContain('unknown app resource')
  })

  it('degrades honestly when the server lacks the mcpApps capability (no relay frames sent)', async () => {
    await boot({ mcpApps: false })
    expect(allSent().some((f) => f.type === 'mcp-resource-read')).toBe(false)
    expect(document.querySelector('.content-area iframe')).toBeNull()
    expect(document.querySelector('.notice')!.textContent).toContain("doesn't support MCP apps")
  })
})
