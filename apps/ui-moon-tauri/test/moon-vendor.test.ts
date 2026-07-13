// @vitest-environment jsdom
//
// Behavioral tests for the Phase 1 vendor modules: moon-protocol.js and
// moon-ws.js. These drive the REAL files (same loadVendorInto mechanism as
// widget-window.test.ts), with a scriptable mock WebSocket standing in for
// the transport.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

// Minimal scriptable WebSocket: captures instances, lets tests fire events.
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

beforeEach(() => {
  MockWebSocket.instances = []
  ;(window as any).WebSocket = MockWebSocket
  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')
})

afterEach(() => {
  delete (window as any).LunaProtocol
  delete (window as any).LunaWS
  delete (window as any).WebSocket
  vi.restoreAllMocks()
})

const P = () => (window as any).LunaProtocol
const W = () => (window as any).LunaWS

describe('moon-protocol.js', () => {
  it('exposes the protocol version as a number (mirrors packages/ui-ws)', () => {
    expect(P().PROTOCOL_VERSION).toBe(2)
  })

  it('buildWsUrl appends ?token= and URL-encodes it', () => {
    expect(P().buildWsUrl('ws://h:1/ui', 'a b&c')).toBe('ws://h:1/ui?token=a%20b%26c')
  })

  it('buildWsUrl respects an existing query string with &', () => {
    expect(P().buildWsUrl('ws://h:1/ui?x=1', 't')).toBe('ws://h:1/ui?x=1&token=t')
  })

  it('buildWsUrl returns the URL unchanged without a token', () => {
    expect(P().buildWsUrl('ws://h:1/ui', '')).toBe('ws://h:1/ui')
    expect(P().buildWsUrl('ws://h:1/ui', null)).toBe('ws://h:1/ui')
  })

  it('parseHelloCapabilities coerces every absent flag to false (fail closed)', () => {
    expect(P().parseHelloCapabilities({})).toEqual({
      turnComplete: false, skills: false, connectors: false,
      artifacts: false, workflows: false, vault: false, mcpApps: false,
      subagents: false, effortSelection: false, modelRouting: false,
      commands: false, feedback: false,
    })
    expect(P().parseHelloCapabilities(undefined).vault).toBe(false)
    expect(P().parseHelloCapabilities(undefined).effortSelection).toBe(false)
  })

  it('parseHelloCapabilities passes advertised flags through', () => {
    const caps = P().parseHelloCapabilities({ capabilities: { artifacts: true, vault: 1, mcpApps: true } })
    expect(caps.artifacts).toBe(true)
    expect(caps.vault).toBe(true)
    expect(caps.mcpApps).toBe(true)
    expect(caps.skills).toBe(false)
  })
})

describe('moon-ws.js frame registry', () => {
  it('dispatches to the registered handler and reports handled', () => {
    const reg = W().createFrameRegistry()
    const seen: any[] = []
    reg.register('hello', (f: any) => seen.push(f))
    expect(reg.dispatch({ type: 'hello', n: 1 })).toBe(true)
    expect(seen).toEqual([{ type: 'hello', n: 1 }])
  })

  it('returns false for unknown frames and malformed input', () => {
    const reg = W().createFrameRegistry()
    expect(reg.dispatch({ type: 'nope' })).toBe(false)
    expect(reg.dispatch(null)).toBe(false)
    expect(reg.dispatch({})).toBe(false)
  })

  it('register is chainable and last registration wins', () => {
    const calls: string[] = []
    const reg = W().createFrameRegistry()
      .register('a', () => calls.push('first'))
      .register('a', () => calls.push('second'))
    reg.dispatch({ type: 'a' })
    expect(calls).toEqual(['second'])
  })
})

describe('moon-ws.js client', () => {
  it('builds the URL through LunaProtocol and dispatches frames to the registry', () => {
    const reg = W().createFrameRegistry()
    const got: any[] = []
    reg.register('artifact-update', (f: any) => got.push(f.artifact.id))
    const client = W().createClient({ registry: reg })
    client.connect('ws://h:1/ui', 'tok')
    const sock = MockWebSocket.instances[0]
    expect(sock.url).toBe('ws://h:1/ui?token=tok')
    sock.fire('message', { data: JSON.stringify({ type: 'artifact-update', artifact: { id: 'x' } }) })
    expect(got).toEqual(['x'])
  })

  it('autoPong replies {type:pong, ts} without touching the registry', () => {
    const reg = W().createFrameRegistry()
    const spy = vi.fn()
    reg.register('ping', spy)
    const client = W().createClient({ registry: reg, autoPong: true })
    client.connect('ws://h:1/ui', null)
    const sock = MockWebSocket.instances[0]
    sock.fire('message', { data: JSON.stringify({ type: 'ping', ts: 42 }) })
    expect(JSON.parse(sock.sent[0])).toEqual({ type: 'pong', ts: 42 })
    expect(spy).not.toHaveBeenCalled()
  })

  it('gen-gating: a superseded socket cannot deliver frames or close events', () => {
    const reg = W().createFrameRegistry()
    const got: string[] = []
    reg.register('hello', () => got.push('hello'))
    const onClose = vi.fn()
    const client = W().createClient({ registry: reg, onClose })
    client.connect('ws://h:1/ui', null)
    const stale = MockWebSocket.instances[0]
    client.connect('ws://h:1/ui', null) // supersede
    expect(stale.closed).toBe(true)
    stale.fire('message', { data: JSON.stringify({ type: 'hello' }) })
    stale.fire('close', {})
    expect(got).toEqual([])
    expect(onClose).not.toHaveBeenCalled()
    // the live socket still works
    MockWebSocket.instances[1].fire('message', { data: JSON.stringify({ type: 'hello' }) })
    expect(got).toEqual(['hello'])
  })

  it('close hooks run before onClose and a throwing hook never blocks recovery', () => {
    const order: string[] = []
    const client = W().createClient({ onClose: () => order.push('onClose') })
    client.registerCloseHook(() => { order.push('hook1'); throw new Error('boom') })
    client.registerCloseHook(() => order.push('hook2'))
    client.connect('ws://h:1/ui', null)
    MockWebSocket.instances[0].fire('close', {})
    expect(order).toEqual(['hook1', 'hook2', 'onClose'])
  })

  it('send serializes JSON when OPEN and reports failure when not', () => {
    const client = W().createClient({})
    expect(client.send({ type: 'x' })).toBe(false) // never connected
    client.connect('ws://h:1/ui', null)
    const sock = MockWebSocket.instances[0]
    expect(client.send({ type: 'x', a: 1 })).toBe(true)
    expect(JSON.parse(sock.sent[0])).toEqual({ type: 'x', a: 1 })
    sock.readyState = MockWebSocket.CLOSED
    expect(client.send({ type: 'y' })).toBe(false)
  })

  it('malformed JSON frames are dropped without throwing', () => {
    const reg = W().createFrameRegistry()
    const client = W().createClient({ registry: reg })
    client.connect('ws://h:1/ui', null)
    expect(() => MockWebSocket.instances[0].fire('message', { data: '{nope' })).not.toThrow()
  })

  it('unhandled frames route to onUnhandled', () => {
    const reg = W().createFrameRegistry()
    const onUnhandled = vi.fn()
    const client = W().createClient({ registry: reg, onUnhandled })
    client.connect('ws://h:1/ui', null)
    MockWebSocket.instances[0].fire('message', { data: JSON.stringify({ type: 'mystery' }) })
    expect(onUnhandled).toHaveBeenCalledWith({ type: 'mystery' })
  })
})
