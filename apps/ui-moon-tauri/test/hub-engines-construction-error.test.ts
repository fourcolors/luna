// @vitest-environment jsdom
//
// Step 1c Part 3c (opus review, plan Step 1c): the hub's HubController.connect()
// must never log a raw exception or e.message from a WebSocket construction
// failure - new WebSocket(fullUrl) embeds the token-bearing URL verbatim in
// its thrown message (Gate 0.4 proved this live with a jsdom probe; see
// docs/next/routes-and-view-mode-plan.md's "The security invariant, which is
// not deferrable"). This is the hubEngines.ts twin of chat-window.test.ts's
// "the legacy WebSocketEngine construction-error log never leaks the token"
// fence - wire.ts and hubEngines.ts are the two named sinks in the plan
// (`wire.ts:107`, `hubEngines.ts:200`).
//
// HubController has no HTML boot harness of its own (the hub keeps its OWN
// bespoke transport - see hubEngines.ts's module doc), so this drives the
// class directly: construct with a no-op dispatch, load the real
// moon-protocol.js vendor module (for LunaProtocol.buildWsUrl/describeWsUrl),
// stub a throwing WebSocket, and call connect().
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { HubController } from '../frontend-react/src/hub/hubEngines'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

beforeEach(() => {
  loadVendorInto(window, 'moon-protocol.js')
})

afterEach(() => {
  delete (window as any).LunaProtocol
  delete (window as any).__TAURI__
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('HubController.connect() construction-error logging never leaks the token', () => {
  it('new WebSocket() throwing (embedding the token in its message) never reaches console.error', () => {
    const SECRET = 'SECRET-do-not-log-me-13579'

    vi.stubGlobal('WebSocket', class {
      constructor(url: string) {
        // Mirrors the real browser behavior Gate 0.4's jsdom probe proved:
        // the thrown message embeds the full dialed URL, token included.
        throw new Error(`Failed to construct 'WebSocket': ${url}`)
      }
    })

    const errorSpy = vi.spyOn(console, 'error')

    const hub = new HubController(() => {})
    hub.State.wsUrl = 'ws://hub-test-host:4753/ui'
    hub.State.wsToken = SECRET

    hub.connect()

    expect(errorSpy).toHaveBeenCalled()
    // Error.prototype.message/.stack are NON-ENUMERABLE in V8, so
    // JSON.stringify(someError) silently drops them (returns '{}') - a naive
    // stringify-everything check would pass even while the raw exception
    // reached console.error. Extract Error fields explicitly.
    const allLoggedText = errorSpy.mock.calls
      .flat()
      .map((a) => {
        if (a instanceof Error) return `${a.message} ${a.stack ?? ''}`
        return typeof a === 'string' ? a : JSON.stringify(a)
      })
      .join(' ')
    expect(allLoggedText).not.toContain(SECRET)
    expect(allLoggedText).not.toContain('token=')
    // The redacted describeWsUrl(url) IS expected to appear - a url adds
    // value here (which endpoint failed).
    expect(allLoggedText).toContain('ws://hub-test-host:4753/ui')
  })
})
