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
    state.localShell.roots = ['/Users/op/work']
    state.localShell.fullAccess = false
    const ls = createLocalShell(ctx)

    await ls.handleRequest({ requestId: 'r1', threadId: 't1', command: 'pwd' })

    expect(invokeMock).toHaveBeenCalledWith(
      'local_shell_exec',
      expect.objectContaining({ command: 'pwd', cwd: '/Users/op/work' }),
    )
    expect(resultFrame(ctx)?.approved).toBe(true)
  })

  it('Scenario: an explicit cwd is passed through unchanged', async () => {
    const { ctx, state } = makeCtx()
    state.localShell.roots = ['/Users/op/work']
    state.localShell.fullAccess = false
    const ls = createLocalShell(ctx)

    await ls.handleRequest({ requestId: 'r2', threadId: 't1', command: 'pwd', cwd: '/Users/op/work/sub' })

    expect(invokeMock).toHaveBeenCalledWith(
      'local_shell_exec',
      expect.objectContaining({ cwd: '/Users/op/work/sub' }),
    )
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
    const { ctx, state } = makeCtx()
    state.localShell.roots = []
    state.localShell.fullAccess = false
    const ls = createLocalShell(ctx)

    await ls.handleRequest({ requestId: 'r4', threadId: 't1', command: 'pwd' })

    expect(invokeMock).not.toHaveBeenCalled()
    expect(resultFrame(ctx)?.approved).toBe(false)
  })
})
