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

// ── Feature: a cwd-less request executes at the advertised default ──────────
//
// The server bridge (packages/ui-ws/local-shell-bridge.ts) omits `cwd` from the
// request frame when the agent doesn't name one — "the client's own cwd" is
// resolved client-side. The approval check treats an absent cwd as "runs at
// roots[0]"; the exec call must land in that same place, not the app process
// cwd ('/' for a packaged .app). Regression: #646 fixed the ADVERTISED cwd but
// left the EXECUTED one as null, so a roots-scoped client approved "roots[0]"
// while the command actually ran wherever the app was started.

function makeTauriExec() {
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = []
  ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = {
    core: {
      invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args })
        if (cmd === 'local_shell_exec') {
          return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false }
        }
        return null
      }),
    },
  }
  return calls
}

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
})

describe('Feature: handleRequest applies the advertised default cwd', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  function requestFrame(extra?: Record<string, unknown>) {
    return {
      type: 'local-shell-request',
      requestId: 'req-1',
      threadId: 'test-thread-1',
      command: 'pwd',
      timeoutMs: 1000,
      ...extra,
    }
  }

  it('Scenario: roots attached + no cwd => exec runs at roots[0], not the process cwd', async () => {
    const calls = makeTauriExec()
    const { ctx, wsFrames } = makeCtx()
    ctx.State.localShell.fullAccess = false
    ctx.State.localShell.enabled = true
    ctx.State.localShell.roots = ['/work/project']
    const ls = createLocalShell(ctx)

    await ls.handleRequest(requestFrame())

    const exec = calls.find((c) => c.cmd === 'local_shell_exec')
    expect(exec).toBeDefined()
    expect(exec!.args.cwd).toBe('/work/project')
    const result = wsFrames[wsFrames.length - 1] as Record<string, unknown>
    expect(result.approved).toBe(true)
  })

  it('Scenario: no roots + fullAccess + homeDir known => exec runs at homeDir, matching the advertised default', async () => {
    const calls = makeTauriExec()
    const { ctx } = makeCtx()
    ctx.State.localShell.homeDir = '/Users/moon'
    const ls = createLocalShell(ctx)

    await ls.handleRequest(requestFrame())

    const exec = calls.find((c) => c.cmd === 'local_shell_exec')
    expect(exec).toBeDefined()
    expect(exec!.args.cwd).toBe('/Users/moon')
  })

  it('Scenario: an explicit cwd still wins over the default', async () => {
    const calls = makeTauriExec()
    const { ctx } = makeCtx()
    ctx.State.localShell.roots = ['/work/project']
    const ls = createLocalShell(ctx)

    await ls.handleRequest(requestFrame({ cwd: '/tmp/elsewhere' }))

    const exec = calls.find((c) => c.cmd === 'local_shell_exec')
    expect(exec!.args.cwd).toBe('/tmp/elsewhere')
  })

  it('Scenario: explicit cwd outside attached roots is still denied when fullAccess is off', async () => {
    const calls = makeTauriExec()
    const { ctx, wsFrames } = makeCtx()
    ctx.State.localShell.fullAccess = false
    ctx.State.localShell.enabled = true
    ctx.State.localShell.roots = ['/work/project']
    const ls = createLocalShell(ctx)

    await ls.handleRequest(requestFrame({ cwd: '/etc' }))

    expect(calls.find((c) => c.cmd === 'local_shell_exec')).toBeUndefined()
    const result = wsFrames[wsFrames.length - 1] as Record<string, unknown>
    expect(result.approved).toBe(false)
  })

  it('Scenario: no roots and fullAccess off => a cwd-less request stays denied (homeDir alone never grants)', async () => {
    const calls = makeTauriExec()
    const { ctx, wsFrames } = makeCtx()
    ctx.State.localShell.fullAccess = false
    ctx.State.localShell.enabled = false
    ctx.State.localShell.homeDir = '/Users/moon'
    const ls = createLocalShell(ctx)

    await ls.handleRequest(requestFrame())

    expect(calls.find((c) => c.cmd === 'local_shell_exec')).toBeUndefined()
    const result = wsFrames[wsFrames.length - 1] as Record<string, unknown>
    expect(result.approved).toBe(false)
  })
})
