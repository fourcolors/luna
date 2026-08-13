// @vitest-environment jsdom
//
// Step 1c Part 3d (opus review, plan Step 1c): MoonHubApp.tsx's luna-config
// consumer no longer trusts a raw wsToken field on the event payload - Rust
// now seeds ~/.luna/moon-connection.json directly and the payload carries
// ONLY wsUrl (plus a seeded flag). This pins the plan's payload scenario:
// the payload has wsUrl and NO wsToken field, and the consumer invokes
// load_connection to pick up the now-seeded store.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { MoonHubApp } from '../frontend-react/src/hub/MoonHubApp'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderHub() {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(<MoonHubApp />)
  })
  return container
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  localStorage.clear()
  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')
})

afterEach(() => {
  if (root && container) {
    act(() => {
      root!.unmount()
    })
  }
  if (container) container.remove()
  container = null
  root = null
  delete (window as any).__TAURI__
  delete (window as any).__MoonInternals
  delete (window as any).LunaWS
  delete (window as any).LunaProtocol
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('MoonHubApp luna-config consumer (Step 1c Part 3d)', () => {
  it('a payload with wsUrl and NO wsToken field invokes load_connection and connects from its response', async () => {
    let lunaConfigHandler: ((e: { payload: any }) => void) | null = null
    // Fresh-install race, matching production: boot's OWN load_connection
    // call runs BEFORE Rust's .env-seeding write can have landed, so it
    // returns nothing yet. Only AFTER the luna-config event fires (proving
    // Rust seeded the store) does load_connection return real creds.
    let seeded = false
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'load_connection') {
        return seeded ? { wsUrl: 'ws://seeded-host:4753/ui', wsToken: 'seeded-real-token' } : null
      }
      if (cmd === 'load_profiles') return { activeProfile: 'stable', profiles: {} }
      if (cmd === 'migrate_legacy_connection') return null
      if (cmd === 'update_state') return null
      if (cmd === 'take_pending_update') return null
      return null
    })
    ;(window as any).__TAURI__ = {
      core: { invoke },
      event: {
        listen: vi.fn(async (name: string, cb: (e: { payload: any }) => void) => {
          if (name === 'luna-config') lunaConfigHandler = cb
          return () => {}
        }),
      },
      window: { getCurrentWindow: () => null },
    }

    renderHub()
    await flush()
    await flush()

    expect(lunaConfigHandler).toBeTypeOf('function')
    expect((window as any).__MoonInternals.State.wsToken, 'boot found nothing yet').toBeFalsy()
    seeded = true
    invoke.mockClear()

    // The exact plan scenario: wsUrl present, wsToken ABSENT entirely.
    const payload = { wsUrl: 'ws://seeded-host:4753/ui', seeded: true }
    expect('wsToken' in payload).toBe(false)

    act(() => {
      lunaConfigHandler!({ payload })
    })
    await flush()
    await flush()

    expect(invoke).toHaveBeenCalledWith('load_connection')
    const internals = (window as any).__MoonInternals
    expect(internals.State.wsToken).toBe('seeded-real-token')
    expect(internals.State.wsUrl).toBe('ws://seeded-host:4753/ui')
  })

  it('is a no-op when already connected (State.wsToken already set)', async () => {
    let lunaConfigHandler: ((e: { payload: any }) => void) | null = null
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'load_connection') return { wsUrl: 'ws://should-not-be-read:4753/ui', wsToken: 'should-not-apply' }
      if (cmd === 'load_profiles') return { activeProfile: 'stable', profiles: {} }
      return null
    })
    ;(window as any).__TAURI__ = {
      core: { invoke },
      event: {
        listen: vi.fn(async (name: string, cb: (e: { payload: any }) => void) => {
          if (name === 'luna-config') lunaConfigHandler = cb
          return () => {}
        }),
      },
      window: { getCurrentWindow: () => null },
    }

    renderHub()
    await flush()
    await flush()

    const internals = (window as any).__MoonInternals
    internals.State.wsToken = 'already-connected-token'
    invoke.mockClear()

    act(() => {
      lunaConfigHandler!({ payload: { wsUrl: 'ws://seeded-host:4753/ui', seeded: true } })
    })
    await flush()
    await flush()

    expect(invoke).not.toHaveBeenCalledWith('load_connection')
    expect(internals.State.wsToken).toBe('already-connected-token')
  })
})
