// @vitest-environment jsdom
//
// Behavioral tests for the settings.connectors panel module.
// Drives the REAL panel module through the REAL panel.html inline script
// (bootPanel harness), with a scriptable MockWebSocket for the WS transport.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── MockWebSocket ─────────────────────────────────────────────────────────────
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
  sentFrames(): any[] {
    return this.sent.map((s) => JSON.parse(s))
  }
}

// ── Harness helpers ───────────────────────────────────────────────────────────
function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

const html = fs.readFileSync(path.resolve(__dirname, '../frontend/panel.html'), 'utf8')

// Default load_connection creds — used by every test so the WS always connects.
const DEFAULT_CREDS = { wsUrl: 'ws://localhost:4753/ui', wsToken: 'tok' }

function bootPanel(opts: { type: string; invoke?: (cmd: string, args?: any) => any }) {
  const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/)
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

  const invoke = vi.fn(async (cmd: string, args?: any) => {
    // Always satisfy load_connection so connectWs can create the WebSocket.
    if (cmd === 'load_connection') return DEFAULT_CREDS
    return opts.invoke ? opts.invoke(cmd, args) : null
  })

  const me = {
    label: 'panel-' + opts.type.replace(/\./g, '-'),
    listen: vi.fn(async () => () => {}),
    onMoved: vi.fn(async () => () => {}),
    outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    outerSize: vi.fn(async () => ({ width: 360, height: 500 })),
    scaleFactor: vi.fn(async () => 1),
  }
  ;(window as any).__TAURI__ = {
    window: { getCurrentWindow: () => me, Window: { getByLabel: vi.fn(async () => null) } },
    core: { invoke },
    event: { listen: vi.fn(async () => () => {}) },
  }

  window.history.replaceState({}, '', '/panel.html?type=' + encodeURIComponent(opts.type))

  // Install MockWebSocket BEFORE vendor files load (moon-ws.js uses `new WebSocket`)
  ;(window as any).WebSocket = MockWebSocket

  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')
  loadVendorInto(window, 'moon-dock.js')

  // Preload the panel module (jsdom never fetches the loader's injected <script src>)
  const moduleFile = path.resolve(__dirname, '../frontend/panels', opts.type.replace(/\./g, '-') + '.js')
  if (fs.existsSync(moduleFile)) {
    new Function('globalThis', fs.readFileSync(moduleFile, 'utf8'))(window)
  }

  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.includes('LunaPanelTypes'))
  expect(inline).toHaveLength(1)
  new Function(inline[0])()

  // jsdom never loads injected <script src> tags — fire error for unknown types
  const injected = document.head.querySelector('script[src^="panels/"]')
  if (injected) injected.dispatchEvent(new Event('error'))

  return { invoke }
}

/**
 * Wait for the MockWebSocket connection to be established (connectWs is async
 * because it awaits load_connection before calling client.connect).
 */
async function waitForSocket(): Promise<MockWebSocket> {
  await vi.waitFor(() => {
    if (!MockWebSocket.instances.length) throw new Error('WebSocket not connected yet')
  })
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]
}

/** Send a frame to the panel via the mock WebSocket's message event. */
async function fireFrame(frame: object) {
  const sock = await waitForSocket()
  sock.fire('message', { data: JSON.stringify(frame) })
}

// ── Fixture data ──────────────────────────────────────────────────────────────
const OAUTH_DEF = {
  id: 'gws',
  name: 'Google Workspace',
  blurb: 'Gmail, Calendar and Drive via Google OAuth.',
  authKind: 'oauth2',
  capabilities: [
    { id: 'gmail', label: 'Gmail', defaultGranted: true, scopes: ['https://mail.google.com/'] },
    { id: 'calendar', label: 'Calendar', defaultGranted: false, scopes: [] },
  ],
}

const API_KEY_DEF = {
  id: 'slack',
  name: 'Slack',
  blurb: 'Slack messaging via MCP.',
  authKind: 'api-key',
  capabilities: [
    { id: 'slack-read', label: 'Read messages', defaultGranted: true, scopes: [] },
  ],
}

const OAUTH_DEF_UNCONFIGURED = {
  ...OAUTH_DEF,
  clientSetup: { configured: false },
}

const OAUTH_DEF_CONFIGURED = {
  ...OAUTH_DEF,
  clientSetup: { configured: true },
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
beforeEach(() => {
  MockWebSocket.instances = []
})

afterEach(() => {
  document.body.innerHTML = ''
  delete (window as any).__TAURI__
  delete (window as any).__PanelInternals
  delete (window as any).LunaPanelTypes
  delete (window as any).LunaProtocol
  delete (window as any).LunaWS
  delete (window as any).LunaDock
  delete (window as any).WebSocket
  vi.restoreAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('settings.connectors panel', () => {
  // 1. Initial render (synchronous — no WS needed yet)
  it('renders with title "Connectors" and empty placeholder', () => {
    bootPanel({ type: 'settings.connectors' })
    expect(document.getElementById('bar-title')!.textContent).toBe('Connectors')
    expect(document.getElementById('connectors-list')).toBeTruthy()
    const list = document.getElementById('connectors-list')!
    expect(list.textContent).toContain('Not connected')
  })

  // 2. Capability absent → notice
  it('replaces content with a notice when hello has no connectors capability', async () => {
    bootPanel({ type: 'settings.connectors' })
    await fireFrame({ type: 'hello', capabilities: {} })
    const notice = document.querySelector('.notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toContain('does not support connectors')
  })

  // 3. Catalog renders connector cards
  it('renders a card for each definition after connector-catalog', async () => {
    bootPanel({ type: 'settings.connectors' })
    await fireFrame({ type: 'hello', capabilities: { connectors: true } })
    await fireFrame({ type: 'connector-catalog', connectors: [OAUTH_DEF, API_KEY_DEF] })
    const cards = document.querySelectorAll('.connector-card')
    expect(cards.length).toBe(2)
    expect(cards[0].textContent).toContain('Google Workspace')
    expect(cards[1].textContent).toContain('Slack')
  })

  // 4. Connect button opens consent sheet (oauth def)
  it('opens the consent sheet when Connect is clicked on an oauth definition', async () => {
    bootPanel({ type: 'settings.connectors' })
    await fireFrame({ type: 'hello', capabilities: { connectors: true } })
    await fireFrame({ type: 'connector-catalog', connectors: [OAUTH_DEF] })

    const connectBtn = document.querySelector('.connector-actions .connector-btn') as HTMLButtonElement
    expect(connectBtn.textContent).toBe('Connect')
    connectBtn.click()

    const sheet = document.querySelector('.connector-consent')
    expect(sheet).toBeTruthy()
    // Should show the Authorize button
    expect(sheet!.textContent).toContain('Authorize in browser')
    // Should have capability checkboxes
    const checkboxes = sheet!.querySelectorAll('input[type="checkbox"]')
    expect(checkboxes.length).toBe(2)
    // Gmail is defaultGranted=true, Calendar is false
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true)
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false)
  })

  // 5. OAuth connect sends connector-oauth-begin frame
  it('starts OAuth flow: invokes oauth_loopback_start and sends connector-oauth-begin', async () => {
    const { invoke } = bootPanel({
      type: 'settings.connectors',
      invoke: (cmd) => {
        if (cmd === 'oauth_loopback_start') return 54321
        return null
      },
    })

    await fireFrame({ type: 'hello', capabilities: { connectors: true } })
    await fireFrame({ type: 'connector-catalog', connectors: [OAUTH_DEF] })

    // Open consent sheet
    const connectBtn = document.querySelector('.connector-actions .connector-btn') as HTMLButtonElement
    connectBtn.click()

    // Click Authorize in browser
    const goBtn = document.querySelector('.connector-consent .panel-btn.primary') as HTMLButtonElement
    goBtn.click()

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('oauth_loopback_start'))

    // After the loopback start, a connector-oauth-begin frame should be sent
    const sock = await waitForSocket()
    await vi.waitFor(() => {
      const frames = sock.sentFrames()
      return frames.some((f) => f.type === 'connector-oauth-begin')
    })
    const beginFrame = sock.sentFrames().find((f) => f.type === 'connector-oauth-begin')!
    expect(beginFrame.definitionId).toBe('gws')
    expect(beginFrame.loopbackPort).toBe(54321)
    expect(typeof beginFrame.requestId).toBe('string')
    expect(Array.isArray(beginFrame.capabilityIds)).toBe(true)
  })

  // 6. OAuth redirect: opens browser + sends connector-oauth-code
  it('handles connector-oauth-redirect: invokes open_external_url + oauth_loopback_wait, sends connector-oauth-code', async () => {
    const capturedCode = { code: 'auth_code_123', state: 'state_xyz' }
    const { invoke } = bootPanel({
      type: 'settings.connectors',
      invoke: (cmd) => {
        if (cmd === 'oauth_loopback_start') return 54321
        if (cmd === 'open_external_url') return null
        if (cmd === 'oauth_loopback_wait') return capturedCode
        return null
      },
    })

    await fireFrame({ type: 'hello', capabilities: { connectors: true } })
    await fireFrame({ type: 'connector-catalog', connectors: [OAUTH_DEF] })

    // Open consent and click authorize
    const connectBtn = document.querySelector('.connector-actions .connector-btn') as HTMLButtonElement
    connectBtn.click()
    const goBtn = document.querySelector('.connector-consent .panel-btn.primary') as HTMLButtonElement
    goBtn.click()

    // Wait for the oauth-begin frame to be sent, then fire the redirect
    const sock = await waitForSocket()
    await vi.waitFor(() => sock.sentFrames().some((f) => f.type === 'connector-oauth-begin'))
    const beginFrame = sock.sentFrames().find((f) => f.type === 'connector-oauth-begin')!

    // Server responds with the consent URL
    sock.fire('message', {
      data: JSON.stringify({
        type: 'connector-oauth-redirect',
        requestId: beginFrame.requestId,
        authUrl: 'https://accounts.google.com/oauth?state=xyz',
        pendingId: 'pend_abc',
      }),
    })

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('open_external_url', { url: 'https://accounts.google.com/oauth?state=xyz' })
    )
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('oauth_loopback_wait', { timeoutMs: 300000 })
    )

    // Give the .then() chained on oauth_loopback_wait time to run client.send
    await vi.waitFor(() => {
      const frames = sock.sentFrames()
      const found = frames.find((f) => f.type === 'connector-oauth-code')
      if (!found) throw new Error('connector-oauth-code not sent yet')
      return found
    })
    const codeFrame = sock.sentFrames().find((f) => f.type === 'connector-oauth-code')!
    expect(codeFrame.pendingId).toBe('pend_abc')
    expect(codeFrame.code).toBe('auth_code_123')
    expect(codeFrame.state).toBe('state_xyz')
  })

  // 7. Plain (api-key) connect sends connector-connect
  it('sends connector-connect for api-key connector with secretRef', async () => {
    bootPanel({ type: 'settings.connectors' })

    await fireFrame({ type: 'hello', capabilities: { connectors: true } })
    await fireFrame({ type: 'connector-catalog', connectors: [API_KEY_DEF] })

    // Open consent sheet
    const connectBtn = document.querySelector('.connector-actions .connector-btn') as HTMLButtonElement
    connectBtn.click()

    // Fill in secret ref
    const refInput = document.querySelector('.connector-secretref-input') as HTMLInputElement
    refInput.value = 'env:SLACK_MCP_XOXB_TOKEN'

    // Click Connect
    const goBtn = document.querySelector('.connector-consent .panel-btn.primary') as HTMLButtonElement
    goBtn.click()

    const sock = await waitForSocket()
    await vi.waitFor(() => sock.sentFrames().some((f) => f.type === 'connector-connect'))
    const connectFrame = sock.sentFrames().find((f) => f.type === 'connector-connect')!
    expect(connectFrame.definitionId).toBe('slack')
    expect(connectFrame.secretRef).toBe('env:SLACK_MCP_XOXB_TOKEN')
    expect(typeof connectFrame.requestId).toBe('string')
  })

  // 8. connector-list renders instance rows with Disconnect button
  it('renders instance rows with Disconnect after connector-list, sends connector-disconnect on click', async () => {
    bootPanel({ type: 'settings.connectors' })

    await fireFrame({ type: 'hello', capabilities: { connectors: true } })
    await fireFrame({ type: 'connector-catalog', connectors: [OAUTH_DEF] })
    await fireFrame({
      type: 'connector-list',
      instances: [
        {
          id: 'inst-1',
          definitionId: 'gws',
          label: 'personal',
          status: 'connected',
          grantedScopes: ['gmail'],
        },
      ],
    })

    const instanceRow = document.querySelector('.connector-instance-row')
    expect(instanceRow).toBeTruthy()
    expect(instanceRow!.textContent).toContain('personal')
    expect(instanceRow!.textContent).toContain('Connected')

    // Click Disconnect
    const disBtn = instanceRow!.querySelector('button') as HTMLButtonElement
    expect(disBtn.textContent).toBe('Disconnect')
    disBtn.click()

    const sock = await waitForSocket()
    await vi.waitFor(() => sock.sentFrames().some((f) => f.type === 'connector-disconnect'))
    const discFrame = sock.sentFrames().find((f) => f.type === 'connector-disconnect')!
    expect(discFrame.instanceId).toBe('inst-1')
  })

  // 9. connector-status (plain) clears busy and renders error on failure
  it('connector-status failure (plain) shows error text', async () => {
    bootPanel({ type: 'settings.connectors' })

    await fireFrame({ type: 'hello', capabilities: { connectors: true } })
    await fireFrame({ type: 'connector-catalog', connectors: [API_KEY_DEF] })

    // Trigger a plain connect to get a requestId in flight
    const connectBtn = document.querySelector('.connector-actions .connector-btn') as HTMLButtonElement
    connectBtn.click()
    const goBtn = document.querySelector('.connector-consent .panel-btn.primary') as HTMLButtonElement
    goBtn.click()

    const sock = await waitForSocket()
    await vi.waitFor(() => sock.sentFrames().some((f) => f.type === 'connector-connect'))
    const sentFrame = sock.sentFrames().find((f) => f.type === 'connector-connect')!

    // Server responds with failure
    sock.fire('message', {
      data: JSON.stringify({
        type: 'connector-status',
        requestId: sentFrame.requestId,
        ok: false,
        message: 'Token rejected.',
      }),
    })

    await vi.waitFor(() => {
      const err = document.getElementById('connectors-error')
      return err && !err.hidden && err.textContent === 'Token rejected.'
    })
  })

  // 10. Client setup form — unconfigured shows the form, configured shows badge
  it('shows client setup form for unconfigured oauth client, badge for configured', async () => {
    bootPanel({ type: 'settings.connectors' })
    await fireFrame({ type: 'hello', capabilities: { connectors: true } })
    await fireFrame({ type: 'connector-catalog', connectors: [OAUTH_DEF_UNCONFIGURED] })

    // Should show the client setup form (not the connect button)
    const setup = document.querySelector('.connector-client-setup')
    expect(setup).toBeTruthy()
    expect(setup!.textContent).toContain('Client ID')
    // Guided Google ritual (issue #107): publish-to-production trap + Console deep links
    expect(setup!.textContent).toContain('Publish to Production')
    expect(setup!.querySelectorAll('a[href*="console.cloud.google.com"]').length).toBeGreaterThan(0)
    // Connect button should NOT be present (clientSetup not configured)
    const connectBtn = document.querySelector('.connector-actions .connector-btn')
    expect(connectBtn).toBeFalsy()

    // Now send configured=true
    await fireFrame({ type: 'connector-catalog', connectors: [OAUTH_DEF_CONFIGURED] })
    const badge = document.querySelector('.connector-client-configured')
    expect(badge).toBeTruthy()
    expect(badge!.textContent).toContain('✓ OAuth client configured')
    // Connect button should NOW be present
    const connectBtn2 = document.querySelector('.connector-actions .connector-btn')
    expect(connectBtn2).toBeTruthy()
  })

  // 11. Save client sends connector-set-client frame
  it('saves OAuth client credentials by sending connector-set-client', async () => {
    bootPanel({ type: 'settings.connectors' })
    await fireFrame({ type: 'hello', capabilities: { connectors: true } })
    await fireFrame({ type: 'connector-catalog', connectors: [OAUTH_DEF_UNCONFIGURED] })

    const cidInput = document.querySelector('input[placeholder*="googleusercontent"]') as HTMLInputElement
    const csecInput = document.querySelector('input[type="password"]') as HTMLInputElement
    cidInput.value = '12345.apps.googleusercontent.com'
    csecInput.value = 'GOCSPX-secret'

    const saveBtn = document.querySelector('.connector-client-setup .connector-btn') as HTMLButtonElement
    saveBtn.click()

    const sock = await waitForSocket()
    await vi.waitFor(() => sock.sentFrames().some((f) => f.type === 'connector-set-client'))
    const setFrame = sock.sentFrames().find((f) => f.type === 'connector-set-client')!
    expect(setFrame.definitionId).toBe('gws')
    expect(setFrame.clientId).toBe('12345.apps.googleusercontent.com')
    expect(setFrame.clientSecret).toBe('GOCSPX-secret')
    // Inputs wiped after send
    expect(cidInput.value).toBe('')
    expect(csecInput.value).toBe('')
  })

  // 12. Multi-account: N instances per definition render as N rows
  it('renders multiple instance rows for multi-account (N instances per definition)', async () => {
    bootPanel({ type: 'settings.connectors' })
    await fireFrame({ type: 'hello', capabilities: { connectors: true } })
    await fireFrame({ type: 'connector-catalog', connectors: [OAUTH_DEF] })
    await fireFrame({
      type: 'connector-list',
      instances: [
        { id: 'inst-1', definitionId: 'gws', label: 'personal', status: 'connected', grantedScopes: ['gmail'] },
        { id: 'inst-2', definitionId: 'gws', label: 'work', status: 'connected', grantedScopes: ['gmail', 'calendar'] },
      ],
    })

    const rows = document.querySelectorAll('.connector-instance-row')
    expect(rows.length).toBe(2)
    expect(rows[0].textContent).toContain('personal')
    expect(rows[1].textContent).toContain('work')
    // Only one card (for the one definition)
    expect(document.querySelectorAll('.connector-card').length).toBe(1)
    // Button should say "Add account" since there are existing instances
    const addBtn = document.querySelector('.connector-actions .connector-btn') as HTMLButtonElement
    expect(addBtn.textContent).toBe('Add account')
  })

  // 13. Failure acks with no flow to attribute them to must still SHOW.
  // Regression: the applyStatus tail used to clear the error banner
  // unconditionally, so a rejected connector-set-client looked like success.
  it('a failed connector-set-client ack surfaces its message (no silent discard)', async () => {
    bootPanel({ type: 'settings.connectors' })
    await fireFrame({ type: 'hello', capabilities: { connectors: true } })
    await fireFrame({ type: 'connector-catalog', connectors: [OAUTH_DEF_UNCONFIGURED] })

    const cidInput = document.querySelector('input[placeholder*="googleusercontent"]') as HTMLInputElement
    cidInput.value = '12345.apps.googleusercontent.com'
    const saveBtn = document.querySelector('.connector-client-setup .connector-btn') as HTMLButtonElement
    saveBtn.click()

    const sock = await waitForSocket()
    await vi.waitFor(() => sock.sentFrames().some((f) => f.type === 'connector-set-client'))
    const setFrame = sock.sentFrames().find((f) => f.type === 'connector-set-client')!

    sock.fire('message', {
      data: JSON.stringify({
        type: 'connector-status',
        requestId: setFrame.requestId,
        ok: false,
        message: 'credentials must not contain line breaks',
      }),
    })

    await vi.waitFor(() => {
      const err = document.getElementById('connectors-error')!
      if (err.hidden || !err.textContent!.includes('line breaks')) throw new Error('error not shown')
    })
  })

  // 14. Same discard path for a failed disconnect (no requestId at all).
  it('a failed disconnect ack shows its message instead of clearing the banner', async () => {
    bootPanel({ type: 'settings.connectors' })
    await fireFrame({ type: 'hello', capabilities: { connectors: true } })
    await fireFrame({ type: 'connector-catalog', connectors: [OAUTH_DEF] })
    await fireFrame({
      type: 'connector-list',
      instances: [
        { id: 'inst-1', definitionId: 'gws', label: 'personal', status: 'connected', grantedScopes: [] },
      ],
    })

    const disBtn = document.querySelector('.connector-instance-row button') as HTMLButtonElement
    disBtn.click()
    const sock = await waitForSocket()
    await vi.waitFor(() => sock.sentFrames().some((f) => f.type === 'connector-disconnect'))

    sock.fire('message', {
      data: JSON.stringify({ type: 'connector-status', ok: false, message: 'unknown instance' }),
    })

    await vi.waitFor(() => {
      const err = document.getElementById('connectors-error')!
      if (err.hidden || !err.textContent!.includes('unknown instance')) throw new Error('error not shown')
    })
  })

  // 15. Duplicate-label preflight: a second account left on the default
  // label must be rejected BEFORE a loopback binds or a browser tab opens.
  it('blocks a duplicate account label before starting the OAuth flow', async () => {
    const { invoke } = bootPanel({
      type: 'settings.connectors',
      invoke: (cmd) => (cmd === 'oauth_loopback_start' ? 54321 : null),
    })
    await fireFrame({ type: 'hello', capabilities: { connectors: true } })
    await fireFrame({ type: 'connector-catalog', connectors: [OAUTH_DEF] })
    await fireFrame({
      type: 'connector-list',
      instances: [
        // First account was created on the default label (= def.name).
        { id: 'inst-1', definitionId: 'gws', label: 'Google Workspace', status: 'connected', grantedScopes: [] },
      ],
    })

    const addBtn = document.querySelector('.connector-actions .connector-btn') as HTMLButtonElement
    expect(addBtn.textContent).toBe('Add account')
    addBtn.click()
    // Leave the label empty → resolves to def.name → collides with inst-1.
    const goBtn = document.querySelector('.connector-consent .panel-btn.primary') as HTMLButtonElement
    goBtn.click()

    const err = document.getElementById('connectors-error')!
    expect(err.hidden).toBe(false)
    expect(err.textContent).toContain('already connected')
    expect(err.textContent).toContain('different label')
    expect(invoke).not.toHaveBeenCalledWith('oauth_loopback_start')
    const sock = await waitForSocket()
    expect(sock.sentFrames().some((f) => f.type === 'connector-oauth-begin')).toBe(false)
  })

  // 16. A provider error redirect (e.g. Testing-mode access_denied) rejects
  // oauth_loopback_wait immediately — the panel shows the reason plus the
  // test-user hint instead of hanging into the 5-minute timeout.
  it('shows the provider decline reason and test-user hint when consent is denied', async () => {
    bootPanel({
      type: 'settings.connectors',
      invoke: (cmd) => {
        if (cmd === 'oauth_loopback_start') return 54321
        if (cmd === 'oauth_loopback_wait') {
          throw 'consent was declined by the provider: access_denied'
        }
        return null
      },
    })
    await fireFrame({ type: 'hello', capabilities: { connectors: true } })
    await fireFrame({ type: 'connector-catalog', connectors: [OAUTH_DEF] })

    const connectBtn = document.querySelector('.connector-actions .connector-btn') as HTMLButtonElement
    connectBtn.click()
    const goBtn = document.querySelector('.connector-consent .panel-btn.primary') as HTMLButtonElement
    goBtn.click()

    const sock = await waitForSocket()
    await vi.waitFor(() => sock.sentFrames().some((f) => f.type === 'connector-oauth-begin'))
    const beginFrame = sock.sentFrames().find((f) => f.type === 'connector-oauth-begin')!

    sock.fire('message', {
      data: JSON.stringify({
        type: 'connector-oauth-redirect',
        requestId: beginFrame.requestId,
        authUrl: 'https://accounts.google.com/oauth?state=xyz',
        pendingId: 'pend_abc',
      }),
    })

    await vi.waitFor(() => {
      const err = document.getElementById('connectors-error')!
      if (err.hidden) throw new Error('error not shown')
      if (!err.textContent!.includes('access_denied')) throw new Error('missing provider reason')
      if (!err.textContent!.includes('test user')) throw new Error('missing test-user hint')
    })
  })

  // 17. Consent timeout is a distinct, actionable banner (not a silent hang).
  it('shows timeout-specific retry guidance when loopback wait times out', async () => {
    bootPanel({
      type: 'settings.connectors',
      invoke: (cmd) => {
        if (cmd === 'oauth_loopback_start') return 54321
        if (cmd === 'oauth_loopback_wait') {
          throw 'timed out waiting for the browser consent'
        }
        return null
      },
    })
    await fireFrame({ type: 'hello', capabilities: { connectors: true } })
    await fireFrame({ type: 'connector-catalog', connectors: [OAUTH_DEF] })

    const connectBtn = document.querySelector('.connector-actions .connector-btn') as HTMLButtonElement
    connectBtn.click()
    const goBtn = document.querySelector('.connector-consent .panel-btn.primary') as HTMLButtonElement
    goBtn.click()

    const sock = await waitForSocket()
    await vi.waitFor(() => sock.sentFrames().some((f) => f.type === 'connector-oauth-begin'))
    const beginFrame = sock.sentFrames().find((f) => f.type === 'connector-oauth-begin')!

    sock.fire('message', {
      data: JSON.stringify({
        type: 'connector-oauth-redirect',
        requestId: beginFrame.requestId,
        authUrl: 'https://accounts.google.com/oauth?state=xyz',
        pendingId: 'pend_timeout',
      }),
    })

    await vi.waitFor(() => {
      const err = document.getElementById('connectors-error')!
      if (err.hidden) throw new Error('error not shown')
      if (!/Timed out waiting for browser consent/i.test(err.textContent || '')) {
        throw new Error('missing timeout guidance: ' + err.textContent)
      }
      if (!/personal Gmail/i.test(err.textContent || '')) {
        throw new Error('missing account-chooser hint: ' + err.textContent)
      }
    })
  })
})

// ── Pure helper: formatOauthConsentError (issue #107) ────────────────────────
describe('LunaConnectorsPanelHelpers.formatOauthConsentError', () => {
  function loadHelpers() {
    const moduleFile = path.resolve(__dirname, '../frontend/panels/settings-connectors.js')
    new Function('globalThis', fs.readFileSync(moduleFile, 'utf8'))(window)
    return (window as any).LunaConnectorsPanelHelpers.formatOauthConsentError as (raw: unknown) => string
  }

  it('maps access_denied to test-user + Workspace guidance', () => {
    const fmt = loadHelpers()
    const out = fmt('consent was declined by the provider: access_denied')
    expect(out).toContain('access_denied')
    expect(out).toMatch(/test user/i)
    expect(out).toMatch(/Publish/i)
    expect(out).toMatch(/Workspace/i)
  })

  it('maps admin_policy_enforced to org-policy guidance', () => {
    const fmt = loadHelpers()
    const out = fmt('consent was declined by the provider: admin_policy_enforced')
    expect(out).toMatch(/org policy|Workspace org/i)
    expect(out).toMatch(/personal Gmail|admin/i)
  })

  it('maps timeout to retry + account-chooser guidance', () => {
    const fmt = loadHelpers()
    const out = fmt('timed out waiting for the browser consent')
    expect(out).toMatch(/Timed out waiting for browser consent/i)
    expect(out).toMatch(/Click Connect again|retry/i)
    expect(out).toMatch(/personal Gmail/i)
  })

  it('maps cancel cleanly', () => {
    const fmt = loadHelpers()
    expect(fmt('OAuth flow cancelled')).toMatch(/Consent cancelled/i)
  })

  it('passes through unknown provider messages', () => {
    const fmt = loadHelpers()
    expect(fmt('provider returned weird_error')).toBe('provider returned weird_error')
  })

  it('coerces Error objects from Tauri invoke rejects', () => {
    const fmt = loadHelpers()
    const out = fmt(new Error('consent was declined by the provider: access_denied'))
    expect(out).toContain('access_denied')
    expect(out).toMatch(/test user/i)
  })
})
