// @vitest-environment jsdom
//
// Behavioral tests for the settings.vault panel module — the Vault credential
// registry (Luna Vault V1) ported out of the monolithic settings modal. Drives
// the REAL module through the REAL panel.html inline script with a scriptable
// MockWebSocket (secret hygiene is load-bearing: every test that touches a
// secret also asserts where it must NOT appear).
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

const html = fs.readFileSync(path.resolve(__dirname, '../frontend/panel.html'), 'utf8')

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

function bootPanel(opts: { type: string; invoke?: (cmd: string, args?: any) => any }) {
  const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/)
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

  const invoke = vi.fn(async (cmd: string, args?: any) => (opts.invoke ? opts.invoke(cmd, args) : null))
  const me = {
    label: 'panel-' + opts.type.replace(/\./g, '-'),
    listen: vi.fn(async () => () => {}),
    onMoved: vi.fn(async () => () => {}),
    outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    outerSize: vi.fn(async () => ({ width: 360, height: 200 })),
    scaleFactor: vi.fn(async () => 1),
  }
  ;(window as any).__TAURI__ = {
    window: { getCurrentWindow: () => me, Window: { getByLabel: vi.fn(async () => null) } },
    core: { invoke },
    event: { listen: vi.fn(async () => () => {}) },
  }

  // The scriptable transport must be installed BEFORE the vendor files load.
  MockWebSocket.instances = []
  ;(window as any).WebSocket = MockWebSocket

  // location.search is read-only in jsdom — the page reads
  // new URLSearchParams(location.search), so stub history state instead.
  window.history.replaceState({}, '', '/panel.html?type=' + encodeURIComponent(opts.type))

  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')
  loadVendorInto(window, 'moon-dock.js')

  // Preload the panel module the way the harness must (jsdom never fetches
  // the loader's injected <script src>); the loader sees it registered and
  // boots it directly.
  const moduleFile = path.resolve(__dirname, '../frontend/panels', opts.type.replace(/\./g, '-') + '.js')
  if (fs.existsSync(moduleFile)) {
    new Function('globalThis', fs.readFileSync(moduleFile, 'utf8'))(window)
  }

  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.includes('LunaPanelTypes'))
  expect(inline).toHaveLength(1)
  new Function(inline[0])()

  const injected = document.head.querySelector('script[src^="panels/"]')
  if (injected) injected.dispatchEvent(new Event('error'))

  return { invoke }
}

// Boot the vault panel with stored creds and complete the WS handshake.
async function bootVault(capabilities: any = { vault: true }) {
  const boot = bootPanel({
    type: 'settings.vault',
    invoke: (cmd) => (cmd === 'load_connection' ? { wsUrl: 'ws://h:1/ui', wsToken: 'tok' } : null),
  })
  await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1))
  const sock = MockWebSocket.instances[0]
  sock.fire('open', {})
  sock.fire('message', { data: JSON.stringify({ type: 'hello', capabilities }) })
  return { sock, ...boot }
}

const frames = (sock: MockWebSocket) => sock.sent.map((s) => JSON.parse(s))
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const setVal = (id: string, v: string) => {
  const i = byId<HTMLInputElement>(id)
  i.value = v
  i.dispatchEvent(new Event('input', { bubbles: true }))
}
const listFrame = (items: any[], sync?: any, storage?: any) =>
  JSON.stringify({
    type: 'vault-list',
    items,
    ...(sync !== undefined ? { sync } : {}),
    ...(storage !== undefined ? { storage } : {}),
  })

afterEach(() => {
  document.body.innerHTML = ''
  document.head.querySelectorAll('style, script[src^="panels/"]').forEach((n) => n.remove())
  delete (window as any).__TAURI__
  delete (window as any).__PanelInternals
  delete (window as any).LunaPanelTypes
  delete (window as any).LunaProtocol
  delete (window as any).LunaWS
  delete (window as any).LunaDock
  delete (window as any).WebSocket
  MockWebSocket.instances = []
  vi.restoreAllMocks()
})

describe('settings.vault panel', () => {
  it('boots with the legacy form (pre-hello), then hello {vault:true} reveals the vault UI', async () => {
    await bootVault({ vault: true })
    expect(byId('bar-title').textContent).toBe('Vault')
    expect(byId('vault-section').hidden).toBe(false)
    expect(byId('legacy-op-token-section').hidden).toBe(true)
    // pre-hello default = legacy visible (hub markup parity) — verify on a fresh boot
    document.body.innerHTML = ''
    bootPanel({ type: 'settings.vault' })
    expect(byId('vault-section').hidden).toBe(true)
    expect(byId('legacy-op-token-section').hidden).toBe(false)
  })

  it('old server (no vault cap): legacy form sends register-op-token, wipes the token one-shot, renders the ack', async () => {
    const { sock } = await bootVault({})
    expect(byId('legacy-op-token-section').hidden).toBe(false)
    expect(byId('vault-section').hidden).toBe(true)

    setVal('op-label-input', 'work')
    setVal('op-token-input', 'ops_SUPERSECRET')
    byId('save-op-token-btn').click()

    const sent = frames(sock)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'register-op-token', label: 'work', token: 'ops_SUPERSECRET' })
    expect(sent[0].requestId).toMatch(/^op_/)
    expect(byId<HTMLInputElement>('op-token-input').value).toBe('')   // wiped immediately
    expect(byId('op-token-status').textContent).toBe('Verifying…')

    // stale ack ignored, matching ack painted
    sock.fire('message', { data: JSON.stringify({ type: 'register-op-token-status', requestId: 'op_other', ok: true }) })
    expect(byId('op-token-status').textContent).toBe('Verifying…')
    sock.fire('message', { data: JSON.stringify({ type: 'register-op-token-status', requestId: sent[0].requestId, ok: false, message: 'bad token' }) })
    expect(byId('op-token-status').textContent).toBe('bad token')
  })

  it('vault-list renders metadata + pointer rows only', async () => {
    const { sock } = await bootVault()
    sock.fire('message', {
      data: listFrame([
        { id: 'a', name: 'Notion API Key', kind: 'env-secret', ref: 'env://NOTION_API_KEY', source: 'manual', description: 'for notion' },
        { id: 'b', name: 'Main 1P', kind: 'op-token', ref: 'luna-op://primary/token', source: '1password', synced: true, shadowed: true },
      ]),
    })
    const rows = document.querySelectorAll('#vault-list .vault-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('.vault-row-name')!.textContent).toContain('Notion API Key')
    expect(rows[0].querySelector('.skill-row-badge')!.textContent).toBe('API key')
    expect(rows[0].querySelector('.vault-ref')!.textContent).toBe('env://NOTION_API_KEY')
    expect(rows[0].querySelector('.vault-source')!.textContent).toBe('added by you')
    expect(rows[0].querySelector('.skill-row-desc')!.textContent).toBe('for notion')
    expect(rows[1].querySelector('.skill-row-badge')!.textContent).toBe('1P token')
    expect(rows[1].querySelector('.vault-chip.synced')!.textContent).toBe('1P')
    expect(rows[1].querySelector('.vault-chip.shadowed')!.textContent).toBe('⚠ shadowed')
    expect(rows[1].classList.contains('shadowed')).toBe(true)

    // empty broadcast → empty-state message
    sock.fire('message', { data: listFrame([]) })
    expect(byId('vault-list').textContent).toContain('Nothing stored yet')
  })

  it('env-secret add: derived var preview, exact vault-put shape, immediate wipe, ok-ack clears the form', async () => {
    const { sock } = await bootVault()
    setVal('vault-name-input', 'Notion API Key')
    expect(byId('vault-var-preview').textContent).toBe('NOTION_API_KEY')
    setVal('vault-value-input', 'sk-123-SECRET')
    setVal('vault-desc-input', 'a note')
    byId('vault-add-btn').click()

    const sent = frames(sock)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'vault-put', name: 'Notion API Key', kind: 'env-secret',
      varName: 'NOTION_API_KEY', description: 'a note', value: 'sk-123-SECRET',
    })
    expect(sent[0].requestId).toMatch(/^vlt_/)
    expect(byId<HTMLInputElement>('vault-value-input').value).toBe('')   // one-shot wipe on send
    expect(byId('vault-status-line').textContent).toBe('Saving…')

    // stale ack ignored
    sock.fire('message', { data: JSON.stringify({ type: 'vault-status', requestId: 'vlt_stale', ok: true }) })
    expect(byId('vault-status-line').textContent).toBe('Saving…')
    // matching ok ack → status + full form clear
    sock.fire('message', { data: JSON.stringify({ type: 'vault-status', requestId: sent[0].requestId, ok: true, message: 'Saved.' }) })
    expect(byId('vault-status-line').textContent).toBe('Saved.')
    expect(byId<HTMLInputElement>('vault-name-input').value).toBe('')
    expect(byId<HTMLInputElement>('vault-desc-input').value).toBe('')
  })

  it('local validation failures never send a frame and never wipe the typed value', async () => {
    const { sock } = await bootVault()
    // no name
    byId('vault-add-btn').click()
    expect(byId('vault-status-line').textContent).toBe('Give it a name (1–64 characters).')
    // underivable name
    setVal('vault-name-input', '!!!')
    setVal('vault-value-input', 'sek')
    byId('vault-add-btn').click()
    expect(byId('vault-status-line').textContent)
      .toBe('That name can’t become a key — add some letters, or set one under “change”.')
    // empty value
    setVal('vault-name-input', 'Good Name')
    setVal('vault-value-input', '')
    byId('vault-add-btn').click()
    expect(byId('vault-status-line').textContent).toBe('Paste the secret value first.')
    // a failed validation never wipes the typed value (kept for correction).
    // NOTE: the engine's line-break check can't be driven through a real
    // input — browsers (and jsdom) sanitize \r\n out of single-line values;
    // it remains as defense-in-depth.
    setVal('vault-value-input', 'sek-keep')
    setVal('vault-name-input', '')
    byId('vault-add-btn').click()
    expect(byId('vault-status-line').textContent).toBe('Give it a name (1–64 characters).')
    expect(byId<HTMLInputElement>('vault-value-input').value).toBe('sek-keep')
    expect(sock.sent).toHaveLength(0)
  })

  it('manual env-var override drives the put varName', async () => {
    const { sock } = await bootVault()
    setVal('vault-name-input', 'Notion API Key')
    byId('vault-var-edit').click()   // open override
    const varInput = byId<HTMLInputElement>('vault-var-input')
    expect(varInput.hidden).toBe(false)
    expect(varInput.value).toBe('NOTION_API_KEY')   // prefilled from derivation
    expect(byId('vault-var-edit').textContent).toBe('auto')
    setVal('vault-var-input', 'MY_KEY')
    expect(byId('vault-var-preview').textContent).toBe('MY_KEY')
    setVal('vault-value-input', 'sek')
    byId('vault-add-btn').click()
    expect(frames(sock)[0]).toMatchObject({ type: 'vault-put', varName: 'MY_KEY' })
  })

  it('op-token kind: label field + restart note, label defaults to primary, no varName on the frame', async () => {
    const { sock } = await bootVault()
    const kind = byId<HTMLSelectElement>('vault-kind-select')
    kind.value = 'op-token'
    kind.dispatchEvent(new Event('change', { bubbles: true }))
    expect(byId('vault-var-row').hidden).toBe(true)
    expect(byId('vault-label-input').hidden).toBe(false)
    expect(byId('vault-restart-note').hidden).toBe(false)
    expect(byId<HTMLInputElement>('vault-value-input').placeholder).toBe('ops_… service-account token')

    setVal('vault-name-input', 'Work 1P')
    byId('vault-add-btn').click()   // empty token
    expect(byId('vault-status-line').textContent).toBe('Paste the ops_… token first.')
    expect(sock.sent).toHaveLength(0)

    setVal('vault-value-input', 'ops_tok123')
    byId('vault-add-btn').click()
    const sent = frames(sock)
    expect(sent[0]).toMatchObject({ type: 'vault-put', name: 'Work 1P', kind: 'op-token', label: 'primary', value: 'ops_tok123' })
    expect('varName' in sent[0]).toBe(false)
    expect(byId<HTMLInputElement>('vault-value-input').value).toBe('')
    expect(byId('vault-status-line').textContent).toBe('Verifying… the server will restart briefly.')
  })

  it('delete is a two-step inline confirm (Keep cancels; second Delete sends vault-delete)', async () => {
    const { sock } = await bootVault()
    sock.fire('message', { data: listFrame([{ id: 'a', name: 'Key', kind: 'env-secret', ref: 'env://K', source: 'manual' }]) })

    const delBtn = () => [...document.querySelectorAll('#vault-list button')]
      .find((b) => b.textContent === 'Delete') as HTMLButtonElement
    delBtn().click()   // arm
    expect(sock.sent).toHaveLength(0)
    expect(document.querySelector('.vault-confirm-note')!.textContent).toBe('Remove this credential?')

    const keep = [...document.querySelectorAll('#vault-list button')].find((b) => b.textContent === 'Keep') as HTMLButtonElement
    keep.click()   // cancel
    expect(document.querySelector('.vault-confirm-note')).toBeNull()
    expect(sock.sent).toHaveLength(0)

    delBtn().click()   // re-arm
    delBtn().click()   // confirm
    const sent = frames(sock)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'vault-delete', id: 'a' })
    expect(sent[0].requestId).toMatch(/^vlt_/)
    expect(byId('vault-status-line').textContent).toBe('Removing…')
  })

  it('not connected: submit refuses, keeps the typed value, sends nothing', async () => {
    const { sock } = await bootVault()
    sock.readyState = MockWebSocket.CLOSED
    setVal('vault-name-input', 'Key')
    setVal('vault-value-input', 'sek-keep-me')
    byId('vault-add-btn').click()
    expect(byId('vault-status-line').textContent).toBe('Not connected to a server.')
    expect(byId<HTMLInputElement>('vault-value-input').value).toBe('sek-keep-me')   // retained for retry
    expect(sock.sent).toHaveLength(0)
  })

  it('sync section renders server state and saves vault-sync-config (poll clamped to 60s min)', async () => {
    const { sock } = await bootVault()
    sock.fire('message', {
      data: listFrame(
        [{ id: 'b', name: 'Main 1P', kind: 'op-token', ref: 'luna-op://work/token', source: 'manual' }],
        { enabled: true, opLabel: 'work', opVault: 'Luna', pollSeconds: 600, lastSyncedAt: Date.now() - 90_000, lastError: 'op exploded' },
      ),
    })
    expect(byId('vault-sync-state').textContent).toBe('Sync: on · 1m ago')
    expect(byId('vault-sync-error').hidden).toBe(false)
    expect(byId('vault-sync-error').textContent).toBe('op exploded')
    expect(byId('vault-sync-fields').hidden).toBe(false)
    expect(byId<HTMLInputElement>('vault-sync-enabled').checked).toBe(true)
    expect(byId<HTMLInputElement>('vault-sync-op-label').value).toBe('work')
    expect(byId<HTMLInputElement>('vault-sync-op-label').placeholder).toBe('work')   // derived from the op-token ref
    expect(byId<HTMLInputElement>('vault-sync-poll').value).toBe('600')
    expect(byId('vault-sync-import-note').hidden).toBe(false)

    setVal('vault-sync-poll', '30')   // below the floor
    byId('vault-sync-save-btn').click()
    const sent = frames(sock)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'vault-sync-config', enabled: true, opLabel: 'work', opVault: 'Luna', pollSeconds: 60,
    })
    expect(sent[0].requestId).toMatch(/^vlt_/)
    expect(byId('vault-sync-status').textContent).toBe('Saving sync settings…')
    sock.fire('message', { data: JSON.stringify({ type: 'vault-status', requestId: sent[0].requestId, ok: true }) })
    expect(byId('vault-sync-status').textContent).toBe('Saved.')
  })

  it('sync checkbox dirty-flag survives broadcasts until a successful save ack clears it', async () => {
    const { sock } = await bootVault()
    sock.fire('message', { data: listFrame([], { enabled: false, opLabel: '', opVault: 'Luna' }) })
    const box = byId<HTMLInputElement>('vault-sync-enabled')
    expect(box.checked).toBe(false)

    box.checked = true   // user toggles → dirty
    box.dispatchEvent(new Event('change', { bubbles: true }))
    sock.fire('message', { data: listFrame([], { enabled: false }) })   // broadcast must not clobber intent
    expect(box.checked).toBe(true)

    byId('vault-sync-save-btn').click()
    const req = frames(sock).find((f) => f.type === 'vault-sync-config')!
    sock.fire('message', { data: JSON.stringify({ type: 'vault-status', requestId: req.requestId, ok: true }) })
    sock.fire('message', { data: listFrame([], { enabled: false }) })   // dirty cleared → server state applies again
    expect(box.checked).toBe(false)
  })

  it('socket close hygiene: wipes both secret inputs, fails over in-flight add + sync statuses, never re-sends secrets', async () => {
    const { sock } = await bootVault()
    sock.fire('message', { data: listFrame([], { enabled: false }) })
    // in-flight env-secret put + in-flight sync save
    setVal('vault-name-input', 'Key')
    setVal('vault-value-input', 'sent-secret')
    byId('vault-add-btn').click()
    byId('vault-sync-save-btn').click()
    // freshly typed (unsent) secrets sitting in both inputs when the socket drops
    setVal('vault-value-input', 'draft-secret')
    byId<HTMLInputElement>('op-token-input').value = 'ops_draft'

    sock.fire('close', {})
    expect(byId<HTMLInputElement>('vault-value-input').value).toBe('')
    expect(byId<HTMLInputElement>('op-token-input').value).toBe('')
    expect(byId('vault-status-line').textContent).toBe('Connection lost — check the list after reconnecting.')
    expect(byId('vault-sync-status').textContent).toBe('Connection lost — check sync state after reconnecting.')
    // the secrets appear ONLY where they were deliberately sent (the one vault-put value)
    const all = sock.sent.join(' ')
    expect(all).not.toContain('draft-secret')
    expect(all).not.toContain('ops_draft')
    expect(sock.sent.filter((s) => s.includes('sent-secret'))).toHaveLength(1)
    expect(JSON.parse(sock.sent.find((s) => s.includes('sent-secret'))!).type).toBe('vault-put')
  })

  it('op-token put in flight keeps its Verifying status across the restart-induced close', async () => {
    const { sock } = await bootVault()
    const kind = byId<HTMLSelectElement>('vault-kind-select')
    kind.value = 'op-token'
    kind.dispatchEvent(new Event('change', { bubbles: true }))
    setVal('vault-name-input', 'Work 1P')
    setVal('vault-value-input', 'ops_tok')
    byId('vault-add-btn').click()
    expect(byId('vault-status-line').textContent).toBe('Verifying… the server will restart briefly.')
    sock.fire('close', {})   // the save restarts the server — this drop is expected
    expect(byId('vault-status-line').textContent).toBe('Verifying… the server will restart briefly.')
    expect(byId<HTMLInputElement>('vault-value-input').value).toBe('')
  })

  describe('storage status line (slice W3)', () => {
    it('renders exact text for keychain + 1Password active + residue (plural)', async () => {
      const { sock } = await bootVault()
      sock.fire('message', {
        data: listFrame([], undefined, {
          mode: 'auto', writeTier: 'keychain', onePassword: 'active',
          osKeychain: true, lunaVault: false, envResidue: 3,
        }),
      })
      const line = byId('vault-storage-line')
      expect(line.hidden).toBe(false)
      expect(line.textContent).toBe(
        'New secrets → macOS Keychain · 1Password: connected · 3 secrets still in plaintext .env - run the migration script to secure them',
      )
    })

    it('renders exact text for luna-vault tier with no 1Password and no residue', async () => {
      const { sock } = await bootVault()
      sock.fire('message', {
        data: listFrame([], undefined, {
          mode: 'auto', writeTier: 'luna-vault', onePassword: 'absent',
          osKeychain: false, lunaVault: true, envResidue: 0,
        }),
      })
      const line = byId('vault-storage-line')
      expect(line.hidden).toBe(false)
      expect(line.textContent).toBe('New secrets → Luna encrypted vault')
    })

    it('renders the env write-tier phrasing (plaintext escape hatch)', async () => {
      const { sock } = await bootVault()
      sock.fire('message', {
        data: listFrame([], undefined, {
          mode: 'env', writeTier: 'env', onePassword: 'absent',
          osKeychain: false, lunaVault: false, envResidue: 0,
        }),
      })
      expect(byId('vault-storage-line').textContent).toBe('New secrets → plaintext .env (LUNA_VAULT_STORAGE=env)')
    })

    it('shows the 1Password detected nudge distinctly from active', async () => {
      const { sock } = await bootVault()
      sock.fire('message', {
        data: listFrame([], undefined, {
          mode: 'auto', writeTier: 'keychain', onePassword: 'detected',
          osKeychain: true, lunaVault: false, envResidue: 0,
        }),
      })
      expect(byId('vault-storage-line').textContent).toBe(
        'New secrets → macOS Keychain · 1Password: CLI detected - connect a service account to use it',
      )
    })

    it('singular residue phrasing for exactly 1 secret', async () => {
      const { sock } = await bootVault()
      sock.fire('message', {
        data: listFrame([], undefined, {
          mode: 'auto', writeTier: 'keychain', onePassword: 'absent',
          osKeychain: true, lunaVault: false, envResidue: 1,
        }),
      })
      expect(byId('vault-storage-line').textContent).toBe(
        'New secrets → macOS Keychain · 1 secret still in plaintext .env - run the migration script to secure them',
      )
    })

    it('omits the residue clause when envResidue is 0', async () => {
      const { sock } = await bootVault()
      sock.fire('message', {
        data: listFrame([], undefined, {
          mode: 'auto', writeTier: 'keychain', onePassword: 'absent',
          osKeychain: true, lunaVault: false, envResidue: 0,
        }),
      })
      expect(byId('vault-storage-line').textContent).not.toContain('still in plaintext')
    })

    it('hides the line entirely when the frame lacks storage (old server)', async () => {
      const { sock } = await bootVault()
      sock.fire('message', { data: listFrame([]) })   // no storage key at all
      const line = byId('vault-storage-line')
      expect(line.hidden).toBe(true)
      expect(line.textContent).toBe('')
    })

    it('re-hides the line when a later broadcast omits storage (channel switch to an older server)', async () => {
      const { sock } = await bootVault()
      sock.fire('message', {
        data: listFrame([], undefined, {
          mode: 'auto', writeTier: 'keychain', onePassword: 'active',
          osKeychain: true, lunaVault: false, envResidue: 0,
        }),
      })
      expect(byId('vault-storage-line').hidden).toBe(false)
      sock.fire('message', { data: listFrame([]) })
      expect(byId('vault-storage-line').hidden).toBe(true)
    })

    it('never uses innerHTML - the line has no element children', async () => {
      const { sock } = await bootVault()
      sock.fire('message', {
        data: listFrame([], undefined, {
          mode: 'auto', writeTier: 'keychain', onePassword: 'active',
          osKeychain: true, lunaVault: false, envResidue: 2,
        }),
      })
      const line = byId('vault-storage-line')
      expect(line.children.length).toBe(0)
      expect(line.textContent).toContain('2 secrets')
    })
  })
})
