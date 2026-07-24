// @vitest-environment jsdom
//
// Behavioral tests for the React 19 + Astryx port of the Vault settings
// panel (frontend/panels/settings-vault.js -> frontend-react/src/panels/
// settings-vault/SettingsVaultPanel.tsx + settings-vault-mount.tsx). Ports
// every behavioral assertion from test/panel-vault.test.ts (which drove the
// vanilla frontend/panel.html + frontend/panels/settings-vault.js through
// jsdom with a scriptable MockWebSocket) onto the React implementation,
// following settings-skills-panel.test.tsx's harness shape (a ctx.connectWs
// test double that records the registry it was given + the frames sent,
// plus a controllable `socket()` stub so the "not connected" guard can be
// exercised without a real transport):
//   - pre-hello: legacy op-token form visible, vault section hidden
//   - hello {vault:true} reveals the vault UI; hello without it keeps legacy
//   - legacy form: register-op-token send/wipe/ack (stale ack ignored)
//   - vault-list renders metadata + pointer rows only; empty -> empty state
//   - env-secret add: derived var preview, exact vault-put shape, immediate
//     wipe, ok-ack clears the form
//   - local validation failures never send a frame and never wipe the value
//   - manual env-var override drives the put varName
//   - op-token kind: label field + restart note, label defaults to primary,
//     no varName on the frame
//   - two-step inline delete confirm
//   - not connected: submit refuses, keeps the typed value, sends nothing
//   - 1Password sync: renders server state, saves (poll clamped to 60s min),
//     dirty-flag survives broadcasts until a successful save ack clears it
//   - socket close hygiene: wipes both secret inputs, fails over in-flight
//     add + sync statuses, never re-sends secrets
//   - op-token put in flight keeps its Verifying status across the
//     restart-induced close
//   - storage status line (slice W3): every phrasing variant + hide/re-hide
//
// This intentionally does NOT reassert the vanilla version's hand-rolled
// `<select>` for the kind choice - Astryx SegmentedControl/SegmentedControlItem
// (real role="radio" items) replace it, same precedent
// SettingsAppearancePanel.tsx documents; rows are queried by data-testid +
// Astryx Badge, not the vanilla `.skill-row-badge` span. The sync-enabled
// checkbox is Astryx Switch - queried by its real `input[type="checkbox"]`
// inside the `vault-sync-enabled` wrapper, same pattern
// settings-skills-panel.test.tsx uses for its row switches (Switch does not
// forward data-testid onto the input itself, only its wrapper).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

// Tells React this jsdom environment is a synchronous-act test environment
// (React 19 warns without it — see https://react.dev/warnings/react-dom-test-utils).
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import {
  SettingsVaultPanel,
  SETTINGS_VAULT_TITLE,
} from '../frontend-react/src/panels/settings-vault/SettingsVaultPanel'
import {
  isSettingsVaultPanelType,
  mountSettingsVaultPanel,
} from '../frontend-react/src/panels/settings-vault-mount'
import type { LunaFrameRegistry, LunaWsClient, PanelCtx } from '../frontend-react/src/panels/panel-ctx'

// ── window.LunaWS test double ───────────────────────────────────────────────
// Mirrors frontend/vendor/moon-ws.js's createFrameRegistry() exactly (last
// registration per type wins; dispatch() looks up by frame.type) - see that
// file for the real implementation this stands in for.
function makeFrameRegistry(): LunaFrameRegistry {
  const handlers: Record<string, (frame: any) => void> = {}
  const registry: LunaFrameRegistry = {
    register(type, fn) {
      handlers[type] = fn
      return registry
    },
    dispatch(frame) {
      if (!frame || typeof (frame as { type?: unknown }).type !== 'string') return false
      const fn = handlers[(frame as { type: string }).type]
      if (!fn) return false
      fn(frame as Record<string, unknown>)
      return true
    },
    has(type) {
      return type in handlers
    },
  }
  return registry
}

;(window as any).LunaWS = { createFrameRegistry: makeFrameRegistry }

// ── ctx.connectWs test double ───────────────────────────────────────────────
function makeCtx(): {
  ctx: PanelCtx
  fireFrame: (frame: Record<string, unknown>) => void
  fireClose: () => void
  sent: Record<string, unknown>[]
  setSocketOpen: (open: boolean) => void
} {
  let registry: LunaFrameRegistry | null = null
  let closeHook: (() => void) | null = null
  let open = true
  const sent: Record<string, unknown>[] = []
  const sock = {
    get readyState() {
      return open ? 1 /* WebSocket.OPEN */ : 3 /* WebSocket.CLOSED */
    },
  }
  const client: LunaWsClient = {
    connect: () => null,
    send: (frame) => {
      if (!open) return false
      sent.push(frame)
      return true
    },
    close: () => {},
    registerCloseHook: (fn) => {
      closeHook = fn
    },
    socket: () => sock,
  }
  const ctx: PanelCtx = {
    win: null,
    hasTauri: true,
    invoke: async () => null,
    connectWs: (reg) => {
      registry = reg
      return client
    },
  }
  return {
    ctx,
    fireFrame: (frame) => {
      if (!registry) throw new Error('connectWs was not called yet')
      registry.dispatch(frame)
    },
    fireClose: () => {
      closeHook?.()
    },
    sent,
    setSocketOpen: (v) => {
      open = v
    },
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderPanel(ctx: PanelCtx) {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(<SettingsVaultPanel ctx={ctx} />)
  })
  return container
}

/** Sets a controlled React input's value the way user input does (bypasses
 *  React's value tracker via the native property setter) then fires a real
 *  bubbling `input` event so the panel's onChange runs. */
function typeInto(input: HTMLInputElement, value: string) {
  const proto = input.type === 'number' ? HTMLInputElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const byTestId = <T extends HTMLElement>(id: string): T => {
  const el = document.querySelector(`[data-testid="${id}"]`) as T | null
  expect(el).not.toBeNull()
  return el!
}
const queryTestId = <T extends HTMLElement>(id: string): T | null =>
  document.querySelector(`[data-testid="${id}"]`) as T | null

function syncEnabledCheckbox(): HTMLInputElement {
  return byTestId<HTMLElement>('vault-sync-enabled').querySelector('input[type="checkbox"]') as HTMLInputElement
}

function findButton(text: string, root: ParentNode = document): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement
  expect(btn).not.toBeUndefined()
  return btn
}

afterEach(() => {
  if (root && container) {
    act(() => {
      root!.unmount()
    })
  }
  if (container) container.remove()
  container = null
  root = null
  document.body.innerHTML = ''
  delete (window as any).__PanelInternals
})

describe('SettingsVaultPanel (React port of panels/settings-vault.js)', () => {
  it('boots with the legacy form visible pre-hello, vault section hidden', () => {
    const { ctx } = makeCtx()
    renderPanel(ctx)
    expect(byTestId('vault-section').hidden).toBe(true)
    expect(byTestId('legacy-op-token-section').hidden).toBe(false)
  })

  it('hello {vault:true} reveals the vault UI; legacy hides', () => {
    const { ctx, fireFrame } = makeCtx()
    renderPanel(ctx)
    act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))
    expect(byTestId('vault-section').hidden).toBe(false)
    expect(byTestId('legacy-op-token-section').hidden).toBe(true)
  })

  it('old server (no vault cap): legacy form sends register-op-token, wipes the token one-shot, renders the ack', () => {
    const { ctx, fireFrame, sent } = makeCtx()
    renderPanel(ctx)
    act(() => fireFrame({ type: 'hello', capabilities: {} }))
    expect(byTestId('legacy-op-token-section').hidden).toBe(false)
    expect(byTestId('vault-section').hidden).toBe(true)

    typeInto(byTestId('op-label-input'), 'work')
    typeInto(byTestId('op-token-input'), 'ops_SUPERSECRET')
    act(() => byTestId<HTMLButtonElement>('save-op-token-btn').click())

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'register-op-token', label: 'work', token: 'ops_SUPERSECRET' })
    expect(sent[0]!.requestId).toMatch(/^op_/)
    expect(byTestId<HTMLInputElement>('op-token-input').value).toBe('')
    expect(byTestId('op-token-status').textContent).toBe('Verifying…')

    act(() => fireFrame({ type: 'register-op-token-status', requestId: 'op_other', ok: true }))
    expect(byTestId('op-token-status').textContent).toBe('Verifying…')
    act(() =>
      fireFrame({ type: 'register-op-token-status', requestId: sent[0]!.requestId, ok: false, message: 'bad token' }),
    )
    expect(byTestId('op-token-status').textContent).toBe('bad token')
  })

  it('vault-list renders metadata + pointer rows only', () => {
    const { ctx, fireFrame } = makeCtx()
    renderPanel(ctx)
    act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))
    act(() =>
      fireFrame({
        type: 'vault-list',
        items: [
          { id: 'a', name: 'Notion API Key', kind: 'env-secret', ref: 'env://NOTION_API_KEY', source: 'manual', description: 'for notion' },
          { id: 'b', name: 'Main 1P', kind: 'op-token', ref: 'luna-op://primary/token', source: '1password', synced: true, shadowed: true },
        ],
      }),
    )

    const rowA = byTestId('vault-row-a')
    expect(rowA.querySelector('.vault-row-name')!.textContent).toContain('Notion API Key')
    expect(byTestId('vault-row-a-kind').textContent).toBe('API key')
    expect(rowA.querySelector('.vault-ref')!.textContent).toBe('env://NOTION_API_KEY')
    expect(rowA.querySelector('.vault-source')!.textContent).toBe('added by you')
    expect(rowA.querySelector('.skill-row-desc')!.textContent).toBe('for notion')

    const rowB = byTestId('vault-row-b')
    expect(byTestId('vault-row-b-kind').textContent).toBe('1P token')
    expect(rowB.querySelector('.vault-chip.synced')!.textContent).toBe('1P')
    expect(rowB.querySelector('.vault-chip.shadowed')!.textContent).toBe('⚠ shadowed')
    expect(rowB.classList.contains('shadowed')).toBe(true)

    act(() => fireFrame({ type: 'vault-list', items: [] }))
    expect(byTestId('vault-list').textContent).toContain('Nothing stored yet')
  })

  it('env-secret add: derived var preview, exact vault-put shape, immediate wipe, ok-ack clears the form', () => {
    const { ctx, fireFrame, sent } = makeCtx()
    renderPanel(ctx)
    act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))

    typeInto(byTestId('vault-name-input'), 'Notion API Key')
    expect(byTestId('vault-var-preview').textContent).toBe('NOTION_API_KEY')
    typeInto(byTestId('vault-value-input'), 'sk-123-SECRET')
    typeInto(byTestId('vault-desc-input'), 'a note')
    act(() => byTestId<HTMLButtonElement>('vault-add-btn').click())

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'vault-put', name: 'Notion API Key', kind: 'env-secret',
      varName: 'NOTION_API_KEY', description: 'a note', value: 'sk-123-SECRET',
    })
    expect(sent[0]!.requestId).toMatch(/^vlt_/)
    expect(byTestId<HTMLInputElement>('vault-value-input').value).toBe('')
    expect(byTestId('vault-status-line').textContent).toBe('Saving…')

    act(() => fireFrame({ type: 'vault-status', requestId: 'vlt_stale', ok: true }))
    expect(byTestId('vault-status-line').textContent).toBe('Saving…')
    act(() => fireFrame({ type: 'vault-status', requestId: sent[0]!.requestId, ok: true, message: 'Saved.' }))
    expect(byTestId('vault-status-line').textContent).toBe('Saved.')
    expect(byTestId<HTMLInputElement>('vault-name-input').value).toBe('')
    expect(byTestId<HTMLInputElement>('vault-desc-input').value).toBe('')
  })

  it('local validation failures never send a frame and never wipe the typed value', () => {
    const { ctx, fireFrame, sent } = makeCtx()
    renderPanel(ctx)
    act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))

    act(() => byTestId<HTMLButtonElement>('vault-add-btn').click())
    expect(byTestId('vault-status-line').textContent).toBe('Give it a name (1–64 characters).')

    typeInto(byTestId('vault-name-input'), '!!!')
    typeInto(byTestId('vault-value-input'), 'sek')
    act(() => byTestId<HTMLButtonElement>('vault-add-btn').click())
    expect(byTestId('vault-status-line').textContent)
      .toBe('That name can’t become a key — add some letters, or set one under “change”.')

    typeInto(byTestId('vault-name-input'), 'Good Name')
    typeInto(byTestId('vault-value-input'), '')
    act(() => byTestId<HTMLButtonElement>('vault-add-btn').click())
    expect(byTestId('vault-status-line').textContent).toBe('Paste the secret value first.')

    typeInto(byTestId('vault-value-input'), 'sek-keep')
    typeInto(byTestId('vault-name-input'), '')
    act(() => byTestId<HTMLButtonElement>('vault-add-btn').click())
    expect(byTestId('vault-status-line').textContent).toBe('Give it a name (1–64 characters).')
    expect(byTestId<HTMLInputElement>('vault-value-input').value).toBe('sek-keep')
    expect(sent).toHaveLength(0)
  })

  it('manual env-var override drives the put varName', () => {
    const { ctx, fireFrame, sent } = makeCtx()
    renderPanel(ctx)
    act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))

    typeInto(byTestId('vault-name-input'), 'Notion API Key')
    act(() => byTestId<HTMLButtonElement>('vault-var-edit').click())
    const varInput = byTestId<HTMLInputElement>('vault-var-input')
    expect(varInput.value).toBe('NOTION_API_KEY')
    expect(byTestId('vault-var-edit').textContent).toBe('auto')
    typeInto(varInput, 'MY_KEY')
    expect(byTestId('vault-var-preview').textContent).toBe('MY_KEY')
    typeInto(byTestId('vault-value-input'), 'sek')
    act(() => byTestId<HTMLButtonElement>('vault-add-btn').click())
    expect(sent[0]).toMatchObject({ type: 'vault-put', varName: 'MY_KEY' })
  })

  it('op-token kind: label field + restart note, label defaults to primary, no varName on the frame', () => {
    const { ctx, fireFrame, sent } = makeCtx()
    renderPanel(ctx)
    act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))

    act(() => byTestId<HTMLButtonElement>('vault-kind-op-token').click())
    expect(queryTestId('vault-var-row')).toBeNull()
    expect(byTestId<HTMLInputElement>('vault-value-input').placeholder).toBe('ops_… service-account token')
    expect(byTestId('vault-restart-note')).not.toBeNull()
    expect(byTestId('vault-label-input')).not.toBeNull()

    typeInto(byTestId('vault-name-input'), 'Work 1P')
    act(() => byTestId<HTMLButtonElement>('vault-add-btn').click())
    expect(byTestId('vault-status-line').textContent).toBe('Paste the ops_… token first.')
    expect(sent).toHaveLength(0)

    typeInto(byTestId('vault-value-input'), 'ops_tok123')
    act(() => byTestId<HTMLButtonElement>('vault-add-btn').click())
    expect(sent[0]).toMatchObject({ type: 'vault-put', name: 'Work 1P', kind: 'op-token', label: 'primary', value: 'ops_tok123' })
    expect('varName' in sent[0]!).toBe(false)
    expect(byTestId<HTMLInputElement>('vault-value-input').value).toBe('')
    expect(byTestId('vault-status-line').textContent).toBe('Verifying… the server will restart briefly.')
  })

  it('delete is a two-step inline confirm (Keep cancels; second Delete sends vault-delete)', () => {
    const { ctx, fireFrame, sent } = makeCtx()
    renderPanel(ctx)
    act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))
    act(() =>
      fireFrame({ type: 'vault-list', items: [{ id: 'a', name: 'Key', kind: 'env-secret', ref: 'env://K', source: 'manual' }] }),
    )

    const row = byTestId('vault-row-a')
    act(() => findButton('Delete', row).click())
    expect(sent).toHaveLength(0)
    expect(row.querySelector('.vault-confirm-note')!.textContent).toBe('Remove this credential?')

    act(() => findButton('Keep', row).click())
    expect(row.querySelector('.vault-confirm-note')).toBeNull()
    expect(sent).toHaveLength(0)

    act(() => findButton('Delete', row).click())
    act(() => findButton('Delete', row).click())
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'vault-delete', id: 'a' })
    expect(sent[0]!.requestId).toMatch(/^vlt_/)
    expect(byTestId('vault-status-line').textContent).toBe('Removing…')
  })

  it('not connected: submit refuses, keeps the typed value, sends nothing', () => {
    const { ctx, fireFrame, sent, setSocketOpen } = makeCtx()
    renderPanel(ctx)
    act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))
    setSocketOpen(false)

    typeInto(byTestId('vault-name-input'), 'Key')
    typeInto(byTestId('vault-value-input'), 'sek-keep-me')
    act(() => byTestId<HTMLButtonElement>('vault-add-btn').click())
    expect(byTestId('vault-status-line').textContent).toBe('Not connected to a server.')
    expect(byTestId<HTMLInputElement>('vault-value-input').value).toBe('sek-keep-me')
    expect(sent).toHaveLength(0)
  })

  it('sync section renders server state and saves vault-sync-config (poll clamped to 60s min)', () => {
    const { ctx, fireFrame, sent } = makeCtx()
    renderPanel(ctx)
    act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))
    act(() =>
      fireFrame({
        type: 'vault-list',
        items: [{ id: 'b', name: 'Main 1P', kind: 'op-token', ref: 'luna-op://work/token', source: 'manual' }],
        sync: { enabled: true, opLabel: 'work', opVault: 'Luna', pollSeconds: 600, lastSyncedAt: Date.now() - 90_000, lastError: 'op exploded' },
      }),
    )

    expect(byTestId('vault-sync-state').textContent).toBe('Sync: on · 1m ago')
    expect(byTestId('vault-sync-error').textContent).toBe('op exploded')
    expect(syncEnabledCheckbox().checked).toBe(true)
    expect(byTestId<HTMLInputElement>('vault-sync-op-label').value).toBe('work')
    expect(byTestId<HTMLInputElement>('vault-sync-op-label').placeholder).toBe('work')
    expect(byTestId<HTMLInputElement>('vault-sync-poll').value).toBe('600')
    expect(byTestId('vault-sync-import-note')).not.toBeNull()

    typeInto(byTestId('vault-sync-poll'), '30')
    act(() => byTestId<HTMLButtonElement>('vault-sync-save-btn').click())
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'vault-sync-config', enabled: true, opLabel: 'work', opVault: 'Luna', pollSeconds: 60 })
    expect(sent[0]!.requestId).toMatch(/^vlt_/)
    expect(byTestId('vault-sync-status').textContent).toBe('Saving sync settings…')
    act(() => fireFrame({ type: 'vault-status', requestId: sent[0]!.requestId, ok: true }))
    expect(byTestId('vault-sync-status').textContent).toBe('Saved.')
  })

  it('sync checkbox dirty-flag survives broadcasts until a successful save ack clears it', () => {
    const { ctx, fireFrame, sent } = makeCtx()
    renderPanel(ctx)
    act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))
    act(() => fireFrame({ type: 'vault-list', items: [], sync: { enabled: false, opLabel: '', opVault: 'Luna' } }))
    const box = syncEnabledCheckbox()
    expect(box.checked).toBe(false)

    act(() => box.click())
    expect(box.checked).toBe(true)
    act(() => fireFrame({ type: 'vault-list', items: [], sync: { enabled: false } }))
    expect(box.checked).toBe(true)

    act(() => byTestId<HTMLButtonElement>('vault-sync-save-btn').click())
    const req = sent.find((f) => f.type === 'vault-sync-config')!
    act(() => fireFrame({ type: 'vault-status', requestId: req.requestId, ok: true }))
    act(() => fireFrame({ type: 'vault-list', items: [], sync: { enabled: false } }))
    expect(box.checked).toBe(false)
  })

  it('socket close hygiene: wipes both secret inputs, fails over in-flight add + sync statuses, never re-sends secrets', () => {
    const { ctx, fireFrame, fireClose, sent } = makeCtx()
    renderPanel(ctx)
    act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))
    act(() => fireFrame({ type: 'vault-list', items: [], sync: { enabled: false } }))

    typeInto(byTestId('vault-name-input'), 'Key')
    typeInto(byTestId('vault-value-input'), 'sent-secret')
    act(() => byTestId<HTMLButtonElement>('vault-add-btn').click())
    act(() => byTestId<HTMLButtonElement>('vault-sync-save-btn').click())
    typeInto(byTestId('vault-value-input'), 'draft-secret')
    typeInto(byTestId('op-token-input'), 'ops_draft')

    act(() => fireClose())
    expect(byTestId<HTMLInputElement>('vault-value-input').value).toBe('')
    expect(byTestId<HTMLInputElement>('op-token-input').value).toBe('')
    expect(byTestId('vault-status-line').textContent).toBe('Connection lost — check the list after reconnecting.')
    expect(byTestId('vault-sync-status').textContent).toBe('Connection lost — check sync state after reconnecting.')

    const all = sent.map((f) => JSON.stringify(f)).join(' ')
    expect(all).not.toContain('draft-secret')
    expect(all).not.toContain('ops_draft')
    expect(sent.filter((f) => JSON.stringify(f).includes('sent-secret'))).toHaveLength(1)
    expect(sent.find((f) => JSON.stringify(f).includes('sent-secret'))!.type).toBe('vault-put')
  })

  it('op-token put in flight keeps its Verifying status across the restart-induced close', () => {
    const { ctx, fireFrame, fireClose } = makeCtx()
    renderPanel(ctx)
    act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))
    act(() => byTestId<HTMLButtonElement>('vault-kind-op-token').click())
    typeInto(byTestId('vault-name-input'), 'Work 1P')
    typeInto(byTestId('vault-value-input'), 'ops_tok')
    act(() => byTestId<HTMLButtonElement>('vault-add-btn').click())
    expect(byTestId('vault-status-line').textContent).toBe('Verifying… the server will restart briefly.')
    act(() => fireClose())
    expect(byTestId('vault-status-line').textContent).toBe('Verifying… the server will restart briefly.')
    expect(byTestId<HTMLInputElement>('vault-value-input').value).toBe('')
  })

  describe('storage status line (slice W3)', () => {
    it('renders exact text for keychain + 1Password active + residue (plural)', () => {
      const { ctx, fireFrame } = makeCtx()
      renderPanel(ctx)
      act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))
      act(() =>
        fireFrame({
          type: 'vault-list', items: [],
          storage: { mode: 'auto', writeTier: 'keychain', onePassword: 'active', osKeychain: true, lunaVault: false, envResidue: 3 },
        }),
      )
      expect(byTestId('vault-storage-line').textContent).toBe(
        'New secrets → macOS Keychain · 1Password: connected · 3 secrets still in plaintext .env - run the migration script to secure them',
      )
    })

    it('renders exact text for luna-vault tier with no 1Password and no residue', () => {
      const { ctx, fireFrame } = makeCtx()
      renderPanel(ctx)
      act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))
      act(() =>
        fireFrame({
          type: 'vault-list', items: [],
          storage: { mode: 'auto', writeTier: 'luna-vault', onePassword: 'absent', osKeychain: false, lunaVault: true, envResidue: 0 },
        }),
      )
      expect(byTestId('vault-storage-line').textContent).toBe('New secrets → Luna encrypted vault')
    })

    it('renders the env write-tier phrasing (plaintext escape hatch)', () => {
      const { ctx, fireFrame } = makeCtx()
      renderPanel(ctx)
      act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))
      act(() =>
        fireFrame({
          type: 'vault-list', items: [],
          storage: { mode: 'env', writeTier: 'env', onePassword: 'absent', osKeychain: false, lunaVault: false, envResidue: 0 },
        }),
      )
      expect(byTestId('vault-storage-line').textContent).toBe('New secrets → plaintext .env (LUNA_VAULT_STORAGE=env)')
    })

    it('shows the 1Password detected nudge distinctly from active', () => {
      const { ctx, fireFrame } = makeCtx()
      renderPanel(ctx)
      act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))
      act(() =>
        fireFrame({
          type: 'vault-list', items: [],
          storage: { mode: 'auto', writeTier: 'keychain', onePassword: 'detected', osKeychain: true, lunaVault: false, envResidue: 0 },
        }),
      )
      expect(byTestId('vault-storage-line').textContent).toBe(
        'New secrets → macOS Keychain · 1Password: CLI detected - connect a service account to use it',
      )
    })

    it('singular residue phrasing for exactly 1 secret', () => {
      const { ctx, fireFrame } = makeCtx()
      renderPanel(ctx)
      act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))
      act(() =>
        fireFrame({
          type: 'vault-list', items: [],
          storage: { mode: 'auto', writeTier: 'keychain', onePassword: 'absent', osKeychain: true, lunaVault: false, envResidue: 1 },
        }),
      )
      expect(byTestId('vault-storage-line').textContent).toBe(
        'New secrets → macOS Keychain · 1 secret still in plaintext .env - run the migration script to secure them',
      )
    })

    it('omits the residue clause when envResidue is 0', () => {
      const { ctx, fireFrame } = makeCtx()
      renderPanel(ctx)
      act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))
      act(() =>
        fireFrame({
          type: 'vault-list', items: [],
          storage: { mode: 'auto', writeTier: 'keychain', onePassword: 'absent', osKeychain: true, lunaVault: false, envResidue: 0 },
        }),
      )
      expect(byTestId('vault-storage-line').textContent).not.toContain('still in plaintext')
    })

    it('hides the line entirely when the frame lacks storage (old server)', () => {
      const { ctx, fireFrame } = makeCtx()
      renderPanel(ctx)
      act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))
      act(() => fireFrame({ type: 'vault-list', items: [] }))
      expect(queryTestId('vault-storage-line')).toBeNull()
    })

    it('re-hides the line when a later broadcast omits storage (channel switch to an older server)', () => {
      const { ctx, fireFrame } = makeCtx()
      renderPanel(ctx)
      act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))
      act(() =>
        fireFrame({
          type: 'vault-list', items: [],
          storage: { mode: 'auto', writeTier: 'keychain', onePassword: 'active', osKeychain: true, lunaVault: false, envResidue: 0 },
        }),
      )
      expect(queryTestId('vault-storage-line')).not.toBeNull()
      act(() => fireFrame({ type: 'vault-list', items: [] }))
      expect(queryTestId('vault-storage-line')).toBeNull()
    })

    it('never uses innerHTML - the line has no element children', () => {
      const { ctx, fireFrame } = makeCtx()
      renderPanel(ctx)
      act(() => fireFrame({ type: 'hello', capabilities: { vault: true } }))
      act(() =>
        fireFrame({
          type: 'vault-list', items: [],
          storage: { mode: 'auto', writeTier: 'keychain', onePassword: 'active', osKeychain: true, lunaVault: false, envResidue: 2 },
        }),
      )
      const line = byTestId('vault-storage-line')
      expect(line.children.length).toBe(0)
      expect(line.textContent).toContain('2 secrets')
    })
  })
})

describe('isSettingsVaultPanelType', () => {
  it('routes "settings.vault" and nothing else', () => {
    expect(isSettingsVaultPanelType('settings.vault')).toBe(true)
    expect(isSettingsVaultPanelType('settings.connectors')).toBe(false)
    expect(isSettingsVaultPanelType('flow')).toBe(false)
  })
})

describe('mountSettingsVaultPanel (panel.html contract parity)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).__PanelInternals
  })

  it('sets the bar title, document title, renders into #content-area, and sets __PanelInternals — matching what panel.html\'s bootModule() sets for vanilla panel types', () => {
    document.body.innerHTML = `
      <div class="widget-shell">
        <div class="title-bar" id="title-bar"><span id="bar-title">Loading…</span></div>
        <div class="content-area" id="content-area"></div>
      </div>
    `
    const { ctx } = makeCtx()
    act(() => {
      mountSettingsVaultPanel('settings.vault', ctx)
    })

    expect(document.getElementById('bar-title')!.textContent).toBe(SETTINGS_VAULT_TITLE)
    expect(document.title).toBe(`Luna — ${SETTINGS_VAULT_TITLE}`)
    expect(document.querySelector('#content-area [data-testid="settings-vault-panel"]')).toBeTruthy()
    expect((window as any).__PanelInternals).toEqual({
      type: 'settings.vault',
      hasModule: true,
      resolvedRouteKey: null,
      lastNotice: null,
    })
  })
})
