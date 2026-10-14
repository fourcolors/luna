// @vitest-environment jsdom
/**
 * updateBannerWiring.test.ts — regression tests for the in-chat update banner
 * wiring in wiring.ts (PR #781).
 *
 * Guards against the 2026-10-11 review finding: the `update://ready` listener
 * and the `update_state` replay were installed inside
 * `installWiringChromeAndWindow`, but `UpdateBanner` was never forwarded into
 * that function's engine bag — so every reference threw a ReferenceError that
 * the inner catch swallowed, and the banner never appeared in any chat window.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { installWiring } from './wiring'

type Handler = (e?: any) => void

function makeTauri() {
  const handlers: Record<string, Handler> = {}
  const fakeW = {
    label: 'chat',
    listen: vi.fn((event: string, handler: Handler) => {
      handlers[event] = handler
      return Promise.resolve(() => {})
    }),
  }
  const tauri = {
    window: { getCurrentWindow: () => fakeW },
    core: {
      invoke: vi.fn(async (cmd: string) =>
        cmd === 'update_state' ? { phase: 'ready', version: '1.2.3', notes: 'notes-here' } : null,
      ),
    },
  }
  return { tauri, handlers, fakeW }
}

function makeCtx(UpdateBanner: unknown) {
  return {
    Logger: { info: () => {}, warn: () => {}, error: () => {} },
    DOM: {},
    State: {} as Record<string, unknown>,
    engines: { UpdateBanner },
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('update banner wiring (PR #781)', () => {
  let prevTauri: unknown
  beforeEach(() => {
    prevTauri = (window as any).__TAURI__
  })
  afterEach(() => {
    ;(window as any).__TAURI__ = prevTauri
    vi.restoreAllMocks()
  })

  it('fires UpdateBanner.onReady when update://ready is broadcast', async () => {
    const { tauri, handlers } = makeTauri()
    ;(window as any).__TAURI__ = tauri
    const UpdateBanner = { onReady: vi.fn(), hide: vi.fn() }

    installWiring(makeCtx(UpdateBanner))
    expect(handlers['update://ready']).toBeTypeOf('function')

    handlers['update://ready']({ payload: { version: '1.2.3' } })
    expect(UpdateBanner.onReady).toHaveBeenCalledTimes(1)
    expect(UpdateBanner.onReady).toHaveBeenCalledWith({ version: '1.2.3' })
  })

  it('replays update_state on boot so a pre-staged build shows the banner', async () => {
    const { tauri } = makeTauri()
    ;(window as any).__TAURI__ = tauri
    const UpdateBanner = { onReady: vi.fn(), hide: vi.fn() }

    installWiring(makeCtx(UpdateBanner))
    await tick(); await tick()

    expect(tauri.core.invoke).toHaveBeenCalledWith('update_state')
    expect(UpdateBanner.onReady).toHaveBeenCalledWith({ version: '1.2.3', notes: 'notes-here' })
  })

  it('hides the banner when a later updater error invalidates the stage', async () => {
    const { tauri, handlers } = makeTauri()
    ;(window as any).__TAURI__ = tauri
    const UpdateBanner = { onReady: vi.fn(), hide: vi.fn() }

    installWiring(makeCtx(UpdateBanner))
    expect(handlers['update://error']).toBeTypeOf('function')

    handlers['update://error']({ payload: { message: 'offline' } })
    expect(UpdateBanner.hide).toHaveBeenCalledTimes(1)
  })

  it('hides the banner on update://none (up-to-date check, no valid stage)', async () => {
    const { tauri, handlers } = makeTauri()
    ;(window as any).__TAURI__ = tauri
    const UpdateBanner = { onReady: vi.fn(), hide: vi.fn() }

    installWiring(makeCtx(UpdateBanner))
    expect(handlers['update://none']).toBeTypeOf('function')

    handlers['update://none']({})
    expect(UpdateBanner.hide).toHaveBeenCalledTimes(1)
  })

  it('stays inert without Tauri (tests/browser)', () => {
    ;(window as any).__TAURI__ = undefined
    const UpdateBanner = { onReady: vi.fn(), hide: vi.fn() }
    expect(() => installWiring(makeCtx(UpdateBanner))).not.toThrow()
    expect(UpdateBanner.onReady).not.toHaveBeenCalled()
  })
})
