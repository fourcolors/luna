// @vitest-environment jsdom
/**
 * machine-access.test.ts
 *
 * Covers the default-on machine-access behavior introduced in this PR:
 *   - State default is ON when `luna_machine_access` is absent from localStorage
 *   - `"off"` in localStorage yields fullAccess:false at boot
 *   - toggleFullAccess() writes the localStorage key
 *   - sendCapability() emits approvalMode:'auto' and fullAccess:true by default
 *
 * Test conventions match the project pattern: jsdom environment (global default
 * from vitest.config.ts), direct module imports, vi spies on Storage.prototype
 * (the vitest-setup.ts patch makes these reliable under Bun).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createState } from '../frontend-react/src/chat/state'
import { createLocalShell } from '../frontend-react/src/chat/localShell'

// ── helpers ────────────────────────────────────────────────────────────────────

/** Build a minimal LocalShellCtx. wsFrames accumulates every WebSocketEngine.send call. */
function makeCtx(stateOverride?: ReturnType<typeof createState>) {
  const state = stateOverride ?? createState()
  const wsFrames: unknown[] = []
  // seed activeThreadId so sendCapability() doesn't short-circuit
  state.activeThreadId = 'test-thread-1'
  const ctx = {
    Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    DOM: {},
    State: state,
    WebSocketEngine: {
      send: vi.fn((frame: unknown) => { wsFrames.push(frame) }),
    },
  }
  return { ctx, state, wsFrames }
}

// ── Feature: default-on state at boot ─────────────────────────────────────────

describe('Feature: machine access default-on state', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('Scenario: luna_machine_access absent => fullAccess:true and enabled:true', () => {
    const state = createState()
    expect(state.localShell.fullAccess).toBe(true)
    expect(state.localShell.enabled).toBe(true)
  })

  it('Scenario: luna_machine_access = "on" => fullAccess:true', () => {
    localStorage.setItem('luna_machine_access', 'on')
    const state = createState()
    expect(state.localShell.fullAccess).toBe(true)
    expect(state.localShell.enabled).toBe(true)
  })

  it('Scenario: luna_machine_access = "off" => fullAccess:false and enabled:false', () => {
    localStorage.setItem('luna_machine_access', 'off')
    const state = createState()
    expect(state.localShell.fullAccess).toBe(false)
    expect(state.localShell.enabled).toBe(false)
  })

  it('Scenario: roots are always empty at boot; enabled === fullAccess when roots is []', () => {
    const state = createState()
    expect(state.localShell.roots).toEqual([])
    // enabled is derived: fullAccess || roots.length > 0
    expect(state.localShell.enabled).toBe(state.localShell.fullAccess)
  })
})

// ── Feature: toggleFullAccess() persists the choice ───────────────────────────

describe('Feature: toggleFullAccess() persists to localStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('Scenario: toggling OFF from default-on writes "off" to luna_machine_access', () => {
    const { ctx } = makeCtx()
    const ls = createLocalShell(ctx)
    // default is ON
    expect(ctx.State.localShell.fullAccess).toBe(true)
    ls.toggleFullAccess()
    expect(ctx.State.localShell.fullAccess).toBe(false)
    expect(localStorage.getItem('luna_machine_access')).toBe('off')
  })

  it('Scenario: toggling ON from OFF writes "on" to luna_machine_access', () => {
    localStorage.setItem('luna_machine_access', 'off')
    const state = createState()
    expect(state.localShell.fullAccess).toBe(false)
    const { ctx } = makeCtx(state)
    const ls = createLocalShell(ctx)
    ls.toggleFullAccess()
    expect(ctx.State.localShell.fullAccess).toBe(true)
    expect(localStorage.getItem('luna_machine_access')).toBe('on')
  })

  it('Scenario: toggleFullAccess recomputes enabled correctly', () => {
    const { ctx } = makeCtx()
    const ls = createLocalShell(ctx)
    ls.toggleFullAccess() // ON => OFF
    expect(ctx.State.localShell.enabled).toBe(false)
    ls.toggleFullAccess() // OFF => ON
    expect(ctx.State.localShell.enabled).toBe(true)
  })
})

// ── Feature: sendCapability() emits approvalMode:'auto' ───────────────────────

describe('Feature: sendCapability() emits correct frame', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('Scenario: default-on => frame has approvalMode:"auto" and fullAccess:true', () => {
    const { ctx, wsFrames } = makeCtx()
    const ls = createLocalShell(ctx)
    ls.sendCapability()
    expect(wsFrames).toHaveLength(1)
    const frame = wsFrames[0] as Record<string, unknown>
    expect(frame.type).toBe('local-shell-capability')
    expect(frame.approvalMode).toBe('auto')
    expect(frame.fullAccess).toBe(true)
    expect(frame.enabled).toBe(true)
  })

  it('Scenario: after toggle-off => frame has fullAccess:false and enabled:false', () => {
    const { ctx, wsFrames } = makeCtx()
    const ls = createLocalShell(ctx)
    ls.toggleFullAccess() // ON => OFF; this also calls sendCapability internally
    // The last frame (from toggleFullAccess) should reflect the OFF state
    const last = wsFrames[wsFrames.length - 1] as Record<string, unknown>
    expect(last.approvalMode).toBe('auto')
    expect(last.fullAccess).toBe(false)
    expect(last.enabled).toBe(false)
  })

  it('Scenario: approvalMode is never "prompt"', () => {
    const { ctx, wsFrames } = makeCtx()
    const ls = createLocalShell(ctx)
    ls.sendCapability()
    const frame = wsFrames[0] as Record<string, unknown>
    expect(frame.approvalMode).not.toBe('prompt')
  })
})

// ── Feature: handleRequest() runs cwd-less commands at the advertised default ──

describe('Feature: handleRequest() cwd defaulting', () => {
  const invokeMock = vi.fn()
  const ROOT = '/Users/op/work'
  const HOME = '/Users/op'

  beforeEach(() => {
    localStorage.clear()
    invokeMock.mockReset()
    invokeMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false })
    ;(window as any).__TAURI__ = { core: { invoke: invokeMock } }
  })

  afterEach(() => {
    delete (window as any).__TAURI__
  })

  const resultFrame = (ctx: ReturnType<typeof makeCtx>['ctx']) =>
    (ctx.WebSocketEngine.send as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((f) => f.type === 'local-shell-result')

  it('Scenario: a request without cwd executes at roots[0], the advertised default', async () => {
    const { ctx, state } = makeCtx()
    state.localShell.roots = [ROOT]
    state.localShell.fullAccess = false
    const ls = createLocalShell(ctx)

    await ls.handleRequest({ requestId: 'r1', threadId: 't1', command: 'pwd' })

    expect(invokeMock).toHaveBeenCalledWith(
      'local_shell_exec',
      expect.objectContaining({ command: 'pwd', cwd: ROOT }),
    )
    expect(resultFrame(ctx)?.approved).toBe(true)
  })

  it('Scenario: an explicit cwd is passed through unchanged', async () => {
    const { ctx, state } = makeCtx()
    state.localShell.roots = [ROOT]
    state.localShell.fullAccess = false
    const ls = createLocalShell(ctx)

    await ls.handleRequest({ requestId: 'r2', threadId: 't1', command: 'pwd', cwd: `${ROOT}/sub` })

    expect(invokeMock).toHaveBeenCalledWith(
      'local_shell_exec',
      expect.objectContaining({ cwd: `${ROOT}/sub` }),
    )
  })

  it('Scenario: no roots but a homeDir runs at homeDir', async () => {
    const { ctx, state } = makeCtx()
    state.localShell.roots = []
    Object.assign(state.localShell, { homeDir: HOME })
    state.localShell.fullAccess = true
    const ls = createLocalShell(ctx)

    await ls.handleRequest({ requestId: 'r5', threadId: 't1', command: 'pwd' })

    expect(invokeMock).toHaveBeenCalledWith(
      'local_shell_exec',
      expect.objectContaining({ cwd: HOME }),
    )
    expect(resultFrame(ctx)?.approved).toBe(true)
  })

  it('Scenario: no roots and no homeDir keeps the legacy null (process cwd)', async () => {
    const { ctx, state } = makeCtx()
    state.localShell.roots = []
    state.localShell.fullAccess = true
    const ls = createLocalShell(ctx)

    await ls.handleRequest({ requestId: 'r3', threadId: 't1', command: 'pwd' })

    expect(invokeMock).toHaveBeenCalledWith(
      'local_shell_exec',
      expect.objectContaining({ cwd: null }),
    )
  })

  it('Scenario: a cwd-less command outside no roots is still denied', async () => {
    // Mirror the production boot state: 'off' in localStorage derives
    // fullAccess:false AND enabled:false (enabled is derived as
    // fullAccess || roots.length > 0), so this exercises the real
    // `!ls.enabled` denial path instead of a hand-mutated state.
    localStorage.setItem('luna_machine_access', 'off')
    const { ctx, state } = makeCtx()
    state.localShell.roots = []
    // Pin the production boot invariant: machine access OFF with empty roots
    // means enabled:false, so denial goes through the !ls.enabled path.
    expect(state.localShell.enabled).toBe(false)
    const ls = createLocalShell(ctx)

    await ls.handleRequest({ requestId: 'r4', threadId: 't1', command: 'pwd' })

    expect(invokeMock).not.toHaveBeenCalled()
    expect(resultFrame(ctx)?.approved).toBe(false)
  })

  it('Scenario: an empty-string cwd is treated as unnamed and gets the default', async () => {
    const { ctx, state } = makeCtx()
    state.localShell.roots = [ROOT]
    state.localShell.fullAccess = true
    const ls = createLocalShell(ctx)

    await ls.handleRequest({ requestId: 'r7', threadId: 't1', command: 'pwd', cwd: '' })

    expect(invokeMock).toHaveBeenCalledWith(
      'local_shell_exec',
      expect.objectContaining({ cwd: ROOT }),
    )
  })

  it('Scenario: a rejected invoke still replies instead of hanging the bridge', async () => {
    const { ctx, state } = makeCtx()
    state.localShell.roots = [ROOT]
    state.localShell.fullAccess = false
    invokeMock.mockRejectedValueOnce(new Error('transport down'))
    const ls = createLocalShell(ctx)

    await ls.handleRequest({ requestId: 'r6', threadId: 't1', command: 'pwd' })

    const f = resultFrame(ctx)
    expect(f?.approved).toBe(true)
    expect(f?.exitCode).toBeNull()
    expect(String(f?.stderr)).toMatch(/exec failed/)
  })
})

// ── Feature: refreshPlatform() populates homeDir via get_home_dir ──────────────

describe('Feature: refreshPlatform() fetches homeDir', () => {
  const invokeMock = vi.fn()
  const HOME = '/Users/op'

  beforeEach(() => {
    localStorage.clear()
    invokeMock.mockReset()
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === 'get_platform' ? 'macos'
        : cmd === 'get_host_label' ? 'op-mac'
        : cmd === 'get_home_dir' ? HOME
        : null,
      ),
    )
    ;(window as any).__TAURI__ = { core: { invoke: invokeMock } }
  })

  afterEach(() => {
    delete (window as any).__TAURI__
  })

  it('Scenario: refreshPlatform stores the home dir the capability advertises', async () => {
    const { ctx, state } = makeCtx()
    const ls = createLocalShell(ctx)

    await ls.refreshPlatform()

    expect(invokeMock).toHaveBeenCalledWith('get_home_dir')
    expect(state.localShell.homeDir).toBe(HOME)
  })

  it('Scenario: a get_home_dir invoke failure leaves homeDir empty', async () => {
    const { ctx, state } = makeCtx()
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'get_home_dir'
        ? Promise.reject(new Error('not permitted'))
        : Promise.resolve('macos'),
    )
    const ls = createLocalShell(ctx)

    await ls.refreshPlatform()

    expect(state.localShell.homeDir).toBe('')
    expect(ctx.Logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('get_home_dir'),
      expect.any(Error),
    )
  })
})
