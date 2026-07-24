// @vitest-environment jsdom
//
// Behavioral tests for the React 19 + Astryx port of the Connectors settings
// panel (frontend/panels/settings-connectors.js -> frontend-react/src/panels/
// settings-connectors/ConnectorsPanel.tsx + settings-connectors-mount.tsx).
// This file REPLACES the deleted vanilla-harness suite (test/panel-connectors.test.ts,
// which loaded frontend/panel.html + frontend/panels/settings-connectors.js —
// both gone, nothing else imports them) — every behavioral assertion below is
// ported 1:1 from that deleted suite, driving the REAL React component
// instead.
//
// WS transport: ConnectorsPanel reads window.LunaWS.createFrameRegistry() (the
// real vendor/moon-ws.js, loaded from disk exactly like panel-workflows.test.tsx)
// and calls ctx.connectWs(registry, opts) — a fake connectWs (no MockWebSocket
// needed, matching the WorkflowsPanel test's pattern) captures that registry so
// tests can fire frames directly via registry.dispatch(...) and inspect every
// outgoing frame the panel's client.send() call recorded.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

// Tells React this jsdom environment is a synchronous-act test environment
// (React 19 warns without it — see https://react.dev/warnings/react-dom-test-utils).
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { ConnectorsPanel, PANEL_TITLE } from "../frontend-react/src/panels/settings-connectors/ConnectorsPanel"
import {
  isSettingsConnectorsPanelType,
  mountSettingsConnectorsPanel,
} from "../frontend-react/src/panels/settings-connectors-mount"
import { formatOauthConsentError } from "../frontend-react/src/panels/settings-connectors/connectorsReducer"
import type { LunaFrameRegistry, PanelCtx } from "../frontend-react/src/panels/panel-ctx"

// ── Real LunaWS.createFrameRegistry() — loaded from the actual vendor file so
// dispatch semantics stay faithful to what panel.html hands every panel. ──
function loadLunaWs(): { createFrameRegistry: () => LunaFrameRegistry } {
  const src = fs.readFileSync(path.resolve(__dirname, "../frontend/vendor/moon-ws.js"), "utf8")
  const sandbox: any = {}
  new Function("globalThis", src)(sandbox)
  return sandbox.LunaWS
}

// ── Fake ctx.connectWs — the seam ConnectorsPanel actually depends on, one
// level above the real WebSocket (mirrors panel-workflows.test.tsx's makeConn). ──
interface FakeConn {
  ctx: PanelCtx
  invoke: ReturnType<typeof vi.fn>
  fireFrame: (frame: Record<string, unknown>) => void
  sentFrames: () => Record<string, unknown>[]
  closeFn: ReturnType<typeof vi.fn>
}

function makeConn(opts: { invoke?: (cmd: string, args?: any) => any; hasTauri?: boolean } = {}): FakeConn {
  let registry: LunaFrameRegistry | null = null
  const sent: Record<string, unknown>[] = []
  const closeFn = vi.fn()

  const connectWs = vi.fn((r: LunaFrameRegistry) => {
    registry = r
    return {
      connect: vi.fn(),
      send: (frame: Record<string, unknown>) => {
        sent.push(frame)
        return true
      },
      close: closeFn,
      registerCloseHook: vi.fn(),
      socket: () => null,
    }
  })
  const invoke = vi.fn(async (cmd: string, args?: any) => (opts.invoke ? opts.invoke(cmd, args) : null))

  const ctx = {
    invoke,
    connectWs,
    hasTauri: opts.hasTauri ?? true,
    win: null,
  } as unknown as PanelCtx

  return {
    ctx,
    invoke,
    fireFrame: (frame) => {
      if (!registry) throw new Error("connectWs was never called — panel did not wire up")
      registry.dispatch(frame)
    },
    sentFrames: () => sent,
    closeFn,
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(opts: { invoke?: (cmd: string, args?: any) => any; hasTauri?: boolean } = {}): FakeConn {
  const conn = makeConn(opts)
  ;(globalThis as any).LunaWS = loadLunaWs()
  container = document.createElement("div")
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(<ConnectorsPanel ctx={conn.ctx} />)
  })
  return conn
}

/** Boot + hello{connectors:true} in one step — most tests start here. */
function mountEnabled(opts: { invoke?: (cmd: string, args?: any) => any; hasTauri?: boolean } = {}): FakeConn {
  const conn = mount(opts)
  act(() => conn.fireFrame({ type: "hello", capabilities: { connectors: true } }))
  return conn
}

/** Flush microtasks (promise .then chains), wrapped in act(). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function changeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
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
  delete (globalThis as any).LunaWS
  vi.restoreAllMocks()
})

// ── Fixture data (identical to the deleted vanilla suite) ──────────────────
const OAUTH_DEF = {
  id: "gws",
  name: "Google Workspace",
  blurb: "Gmail, Calendar and Drive via Google OAuth.",
  authKind: "oauth2",
  capabilities: [
    { id: "gmail", label: "Gmail", defaultGranted: true, scopes: ["https://mail.google.com/"] },
    { id: "calendar", label: "Calendar", defaultGranted: false, scopes: [] },
  ],
}

const API_KEY_DEF = {
  id: "slack",
  name: "Slack",
  blurb: "Slack messaging via MCP.",
  authKind: "api-key",
  capabilities: [{ id: "slack-read", label: "Read messages", defaultGranted: true, scopes: [] }],
}

const OAUTH_DEF_UNCONFIGURED = { ...OAUTH_DEF, clientSetup: { configured: false } }
const OAUTH_DEF_CONFIGURED = { ...OAUTH_DEF, clientSetup: { configured: true } }

// ── Query helpers ────────────────────────────────────────────────────────
const errorEl = () => document.querySelector('[data-testid="connectors-error"]') as HTMLElement
const connectBtn = (defId: string) =>
  document.querySelector(`[data-testid="connector-connect-btn-${defId}"]`) as HTMLButtonElement
const goBtn = (defId: string) => document.querySelector(`[data-testid="connector-go-btn-${defId}"]`) as HTMLButtonElement
const consentSheet = (defId: string) => document.querySelector(`[data-testid="connector-consent-${defId}"]`) as HTMLElement
const labelInput = (defId: string) =>
  document.querySelector(`[data-testid="connector-label-input-${defId}"]`) as HTMLInputElement
const capCheckbox = (defId: string, capId: string) =>
  document.querySelector(`[data-testid="connector-cap-${defId}-${capId}"]`) as HTMLInputElement
const secretRefInput = (defId: string) =>
  document.querySelector(`[data-testid="connector-secretref-input-${defId}"]`) as HTMLInputElement
const disconnectBtn = (instId: string) =>
  document.querySelector(`[data-testid="connector-disconnect-btn-${instId}"]`) as HTMLButtonElement
const reconnectBtn = (instId: string) =>
  document.querySelector(`[data-testid="connector-reconnect-btn-${instId}"]`) as HTMLButtonElement

describe("ConnectorsPanel (React port of panels/settings-connectors.js)", () => {
  // 1. Initial render (synchronous — no WS needed yet)
  it('renders with title "Connectors" and empty placeholder', () => {
    mount()
    expect(PANEL_TITLE).toBe("Connectors")
    expect(document.querySelector('[data-testid="connectors-list"]')).toBeTruthy()
    const empty = document.querySelector('[data-testid="connectors-empty"]')
    expect(empty).toBeTruthy()
    expect(empty!.textContent).toContain("Not connected")
  })

  // 2. Capability absent → notice
  it("replaces content with a notice when hello has no connectors capability", () => {
    const conn = mount()
    act(() => conn.fireFrame({ type: "hello", capabilities: {} }))
    const notice = document.querySelector('[data-testid="connectors-unsupported"]')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toContain("does not support connectors")
  })

  // 3. Catalog renders connector cards
  it("renders a card for each definition after connector-catalog", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [OAUTH_DEF, API_KEY_DEF] }))
    const cards = document.querySelectorAll('[data-testid^="connector-card-"]')
    expect(cards.length).toBe(2)
    expect(document.querySelector('[data-testid="connector-card-gws"]')!.textContent).toContain("Google Workspace")
    expect(document.querySelector('[data-testid="connector-card-slack"]')!.textContent).toContain("Slack")
  })

  // 4. Connect button opens consent sheet (oauth def)
  it("opens the consent sheet when Connect is clicked on an oauth definition", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [OAUTH_DEF] }))

    expect(connectBtn("gws").textContent).toBe("Connect")
    act(() => connectBtn("gws").click())

    const sheet = consentSheet("gws")
    expect(sheet).toBeTruthy()
    expect(goBtn("gws").textContent).toBe("Authorize in browser")
    const gmailBox = capCheckbox("gws", "gmail")
    const calBox = capCheckbox("gws", "calendar")
    expect(gmailBox.checked).toBe(true) // defaultGranted: true
    expect(calBox.checked).toBe(false) // defaultGranted: false
  })

  // 5. OAuth connect sends connector-oauth-begin frame
  it("starts OAuth flow: invokes oauth_loopback_start and sends connector-oauth-begin", async () => {
    const conn = mountEnabled({ invoke: (cmd) => (cmd === "oauth_loopback_start" ? 54321 : null) })
    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [OAUTH_DEF] }))

    act(() => connectBtn("gws").click())
    act(() => goBtn("gws").click())

    await flush()

    expect(conn.invoke).toHaveBeenCalledWith("oauth_loopback_start")
    const beginFrame = conn.sentFrames().find((f) => f.type === "connector-oauth-begin")!
    expect(beginFrame).toBeTruthy()
    expect(beginFrame.definitionId).toBe("gws")
    expect(beginFrame.loopbackPort).toBe(54321)
    expect(typeof beginFrame.requestId).toBe("string")
    expect(Array.isArray(beginFrame.capabilityIds)).toBe(true)
  })

  // 6. OAuth redirect: opens browser + sends connector-oauth-code
  it("handles connector-oauth-redirect: invokes open_external_url + oauth_loopback_wait, sends connector-oauth-code", async () => {
    const capturedCode = { code: "auth_code_123", state: "state_xyz" }
    const conn = mountEnabled({
      invoke: (cmd) => {
        if (cmd === "oauth_loopback_start") return 54321
        if (cmd === "open_external_url") return null
        if (cmd === "oauth_loopback_wait") return capturedCode
        return null
      },
    })
    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [OAUTH_DEF] }))

    act(() => connectBtn("gws").click())
    act(() => goBtn("gws").click())
    await flush()

    const beginFrame = conn.sentFrames().find((f) => f.type === "connector-oauth-begin")!
    act(() =>
      conn.fireFrame({
        type: "connector-oauth-redirect",
        requestId: beginFrame.requestId,
        authUrl: "https://accounts.google.com/oauth?state=xyz",
        pendingId: "pend_abc",
      }),
    )
    await flush()

    expect(conn.invoke).toHaveBeenCalledWith("open_external_url", {
      url: "https://accounts.google.com/oauth?state=xyz",
    })
    expect(conn.invoke).toHaveBeenCalledWith("oauth_loopback_wait", { timeoutMs: 300000 })

    const codeFrame = conn.sentFrames().find((f) => f.type === "connector-oauth-code")!
    expect(codeFrame).toBeTruthy()
    expect(codeFrame.pendingId).toBe("pend_abc")
    expect(codeFrame.code).toBe("auth_code_123")
    expect(codeFrame.state).toBe("state_xyz")
  })

  // 7. Plain (api-key) connect sends connector-connect
  it("sends connector-connect for api-key connector with secretRef", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [API_KEY_DEF] }))

    act(() => connectBtn("slack").click())
    changeInputValue(secretRefInput("slack"), "env:SLACK_MCP_XOXB_TOKEN")
    act(() => goBtn("slack").click())

    const connectFrame = conn.sentFrames().find((f) => f.type === "connector-connect")!
    expect(connectFrame).toBeTruthy()
    expect(connectFrame.definitionId).toBe("slack")
    expect(connectFrame.secretRef).toBe("env:SLACK_MCP_XOXB_TOKEN")
    expect(typeof connectFrame.requestId).toBe("string")
  })

  // 8. connector-list renders instance rows with Disconnect button
  it("renders instance rows with Disconnect after connector-list, sends connector-disconnect on click", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [OAUTH_DEF] }))
    act(() =>
      conn.fireFrame({
        type: "connector-list",
        instances: [{ id: "inst-1", definitionId: "gws", label: "personal", status: "connected", grantedScopes: ["gmail"] }],
      }),
    )

    const row = document.querySelector('[data-testid="connector-instance-inst-1"]')
    expect(row).toBeTruthy()
    expect(row!.textContent).toContain("personal")
    expect(row!.textContent).toContain("Connected")

    act(() => disconnectBtn("inst-1").click())

    const discFrame = conn.sentFrames().find((f) => f.type === "connector-disconnect")!
    expect(discFrame).toBeTruthy()
    expect(discFrame.instanceId).toBe("inst-1")
  })

  // 9. connector-status (plain) clears busy and renders error on failure
  it("connector-status failure (plain) shows error text", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [API_KEY_DEF] }))

    act(() => connectBtn("slack").click())
    act(() => goBtn("slack").click())

    const sentFrame = conn.sentFrames().find((f) => f.type === "connector-connect")!
    act(() =>
      conn.fireFrame({ type: "connector-status", requestId: sentFrame.requestId, ok: false, message: "Token rejected." }),
    )

    expect(errorEl().hidden).toBe(false)
    expect(errorEl().textContent).toBe("Token rejected.")
  })

  // 10. Client setup form — unconfigured shows the form, configured shows badge
  it("shows client setup form for unconfigured oauth client, badge for configured", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [OAUTH_DEF_UNCONFIGURED] }))

    const setup = document.querySelector('[data-testid="connector-client-setup-gws"]')
    expect(setup).toBeTruthy()
    expect(setup!.textContent).toContain("Client ID")
    expect(setup!.textContent).toContain("Publish to Production")
    expect(setup!.querySelectorAll('a[href*="console.cloud.google.com"]').length).toBeGreaterThan(0)
    expect(connectBtn("gws")).toBeFalsy()

    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [OAUTH_DEF_CONFIGURED] }))
    const badge = document.querySelector('[data-testid="connector-client-badge-gws"]')
    expect(badge).toBeTruthy()
    expect(badge!.textContent).toContain("✓ OAuth client configured")
    expect(connectBtn("gws")).toBeTruthy()
  })

  // 11. Save client sends connector-set-client frame
  it("saves OAuth client credentials by sending connector-set-client", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [OAUTH_DEF_UNCONFIGURED] }))

    const cidInput = document.querySelector('[data-testid="connector-client-id-gws"]') as HTMLInputElement
    const csecInput = document.querySelector('[data-testid="connector-client-secret-gws"]') as HTMLInputElement
    changeInputValue(cidInput, "12345.apps.googleusercontent.com")
    changeInputValue(csecInput, "GOCSPX-secret")

    act(() => (document.querySelector('[data-testid="connector-client-save-gws"]') as HTMLButtonElement).click())

    const setFrame = conn.sentFrames().find((f) => f.type === "connector-set-client")!
    expect(setFrame).toBeTruthy()
    expect(setFrame.definitionId).toBe("gws")
    expect(setFrame.clientId).toBe("12345.apps.googleusercontent.com")
    expect(setFrame.clientSecret).toBe("GOCSPX-secret")
    // Inputs wiped after send
    expect(cidInput.value).toBe("")
    expect(csecInput.value).toBe("")
  })

  // 12. Multi-account: N instances per definition render as N rows
  it("renders multiple instance rows for multi-account (N instances per definition)", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [OAUTH_DEF] }))
    act(() =>
      conn.fireFrame({
        type: "connector-list",
        instances: [
          { id: "inst-1", definitionId: "gws", label: "personal", status: "connected", grantedScopes: ["gmail"] },
          { id: "inst-2", definitionId: "gws", label: "work", status: "connected", grantedScopes: ["gmail", "calendar"] },
        ],
      }),
    )

    const rows = document.querySelectorAll('[data-testid^="connector-instance-inst-"]')
    expect(rows.length).toBe(2)
    expect(document.querySelectorAll('[data-testid^="connector-card-"]').length).toBe(1)
    expect(connectBtn("gws").textContent).toBe("Add account")
  })

  // 13. Failure acks with no flow to attribute them to must still SHOW.
  it("a failed connector-set-client ack surfaces its message (no silent discard)", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [OAUTH_DEF_UNCONFIGURED] }))

    const cidInput = document.querySelector('[data-testid="connector-client-id-gws"]') as HTMLInputElement
    changeInputValue(cidInput, "12345.apps.googleusercontent.com")
    act(() => (document.querySelector('[data-testid="connector-client-save-gws"]') as HTMLButtonElement).click())

    const setFrame = conn.sentFrames().find((f) => f.type === "connector-set-client")!
    act(() =>
      conn.fireFrame({
        type: "connector-status",
        requestId: setFrame.requestId,
        ok: false,
        message: "credentials must not contain line breaks",
      }),
    )

    expect(errorEl().hidden).toBe(false)
    expect(errorEl().textContent).toContain("line breaks")
  })

  // 14. Same discard path for a failed disconnect (no requestId at all).
  it("a failed disconnect ack shows its message instead of clearing the banner", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [OAUTH_DEF] }))
    act(() =>
      conn.fireFrame({
        type: "connector-list",
        instances: [{ id: "inst-1", definitionId: "gws", label: "personal", status: "connected", grantedScopes: [] }],
      }),
    )

    act(() => disconnectBtn("inst-1").click())
    act(() => conn.fireFrame({ type: "connector-status", ok: false, message: "unknown instance" }))

    expect(errorEl().hidden).toBe(false)
    expect(errorEl().textContent).toContain("unknown instance")
  })

  // 15. Duplicate-label preflight
  it("blocks a duplicate account label before starting the OAuth flow", () => {
    const conn = mountEnabled({ invoke: (cmd) => (cmd === "oauth_loopback_start" ? 54321 : null) })
    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [OAUTH_DEF] }))
    act(() =>
      conn.fireFrame({
        type: "connector-list",
        instances: [{ id: "inst-1", definitionId: "gws", label: "Google Workspace", status: "connected", grantedScopes: [] }],
      }),
    )

    expect(connectBtn("gws").textContent).toBe("Add account")
    act(() => connectBtn("gws").click())
    // Leave the label empty → resolves to def.name → collides with inst-1.
    act(() => goBtn("gws").click())

    expect(errorEl().hidden).toBe(false)
    expect(errorEl().textContent).toContain("already connected")
    expect(errorEl().textContent).toContain("different label")
    expect(conn.invoke).not.toHaveBeenCalledWith("oauth_loopback_start")
    expect(conn.sentFrames().some((f) => f.type === "connector-oauth-begin")).toBe(false)
  })

  // 16. Provider decline reason + test-user hint
  it("shows the provider decline reason and test-user hint when consent is denied", async () => {
    const conn = mountEnabled({
      invoke: (cmd) => {
        if (cmd === "oauth_loopback_start") return 54321
        if (cmd === "oauth_loopback_wait") throw "consent was declined by the provider: access_denied"
        return null
      },
    })
    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [OAUTH_DEF] }))

    act(() => connectBtn("gws").click())
    act(() => goBtn("gws").click())
    await flush()

    const beginFrame = conn.sentFrames().find((f) => f.type === "connector-oauth-begin")!
    act(() =>
      conn.fireFrame({
        type: "connector-oauth-redirect",
        requestId: beginFrame.requestId,
        authUrl: "https://accounts.google.com/oauth?state=xyz",
        pendingId: "pend_abc",
      }),
    )
    await flush()

    expect(errorEl().hidden).toBe(false)
    expect(errorEl().textContent).toContain("access_denied")
    expect(errorEl().textContent).toContain("test user")
  })

  // 17. Consent timeout is a distinct, actionable banner (not a silent hang).
  it("shows timeout-specific retry guidance when loopback wait times out", async () => {
    const conn = mountEnabled({
      invoke: (cmd) => {
        if (cmd === "oauth_loopback_start") return 54321
        if (cmd === "oauth_loopback_wait") throw "timed out waiting for the browser consent"
        return null
      },
    })
    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [OAUTH_DEF] }))

    act(() => connectBtn("gws").click())
    act(() => goBtn("gws").click())
    await flush()

    const beginFrame = conn.sentFrames().find((f) => f.type === "connector-oauth-begin")!
    act(() =>
      conn.fireFrame({
        type: "connector-oauth-redirect",
        requestId: beginFrame.requestId,
        authUrl: "https://accounts.google.com/oauth?state=xyz",
        pendingId: "pend_timeout",
      }),
    )
    await flush()

    expect(errorEl().hidden).toBe(false)
    expect(errorEl().textContent).toMatch(/Timed out waiting for browser consent/i)
    expect(errorEl().textContent).toMatch(/personal Gmail/i)
  })

  // 18. Reconnect: disconnects the stale instance and reopens the sheet
  // pre-filled with its label.
  it("Reconnect on a needs-reauth instance disconnects it and reopens the consent sheet with its label", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [OAUTH_DEF] }))
    act(() =>
      conn.fireFrame({
        type: "connector-list",
        instances: [{ id: "inst-1", definitionId: "gws", label: "personal", status: "needs-reauth", grantedScopes: [] }],
      }),
    )

    act(() => reconnectBtn("inst-1").click())

    expect(conn.sentFrames().some((f) => f.type === "connector-disconnect" && f.instanceId === "inst-1")).toBe(true)
    expect(consentSheet("gws")).toBeTruthy()
    expect(labelInput("gws").value).toBe("personal")
  })

  // 19. hasTauri:false blocks OAuth connect with an actionable error.
  it("shows a desktop-app-required error when OAuth connect is attempted off-Tauri", () => {
    const conn = mountEnabled({ hasTauri: false })
    act(() => conn.fireFrame({ type: "connector-catalog", connectors: [OAUTH_DEF] }))

    act(() => connectBtn("gws").click())
    act(() => goBtn("gws").click())

    expect(errorEl().hidden).toBe(false)
    expect(errorEl().textContent).toContain("Moon desktop app")
    expect(conn.invoke).not.toHaveBeenCalledWith("oauth_loopback_start")
  })
})

// ── Pure helper: formatOauthConsentError (issue #107) ────────────────────────
describe("formatOauthConsentError", () => {
  it("maps access_denied to test-user + Workspace guidance", () => {
    const out = formatOauthConsentError("consent was declined by the provider: access_denied")
    expect(out).toContain("access_denied")
    expect(out).toMatch(/test user/i)
    expect(out).toMatch(/Publish/i)
    expect(out).toMatch(/Workspace/i)
  })

  it("maps admin_policy_enforced to org-policy guidance", () => {
    const out = formatOauthConsentError("consent was declined by the provider: admin_policy_enforced")
    expect(out).toMatch(/org policy|Workspace org/i)
    expect(out).toMatch(/personal Gmail|admin/i)
  })

  it("maps timeout to retry + account-chooser guidance", () => {
    const out = formatOauthConsentError("timed out waiting for the browser consent")
    expect(out).toMatch(/Timed out waiting for browser consent/i)
    expect(out).toMatch(/Click Connect again|retry/i)
    expect(out).toMatch(/personal Gmail/i)
  })

  it("maps cancel cleanly", () => {
    expect(formatOauthConsentError("OAuth flow cancelled")).toMatch(/Consent cancelled/i)
  })

  it("passes through unknown provider messages", () => {
    expect(formatOauthConsentError("provider returned weird_error")).toBe("provider returned weird_error")
  })

  it("coerces Error objects from Tauri invoke rejects", () => {
    const out = formatOauthConsentError(new Error("consent was declined by the provider: access_denied"))
    expect(out).toContain("access_denied")
    expect(out).toMatch(/test user/i)
  })
})

describe("isSettingsConnectorsPanelType", () => {
  it('routes the "settings.connectors" panel.html type and nothing else', () => {
    expect(isSettingsConnectorsPanelType("settings.connectors")).toBe(true)
    expect(isSettingsConnectorsPanelType("settings.connection")).toBe(false)
    expect(isSettingsConnectorsPanelType("flow")).toBe(false)
  })
})

describe("mountSettingsConnectorsPanel (panel.html contract parity)", () => {
  afterEach(() => {
    document.body.innerHTML = ""
    delete (window as any).__PanelInternals
    delete (globalThis as any).LunaWS
  })

  it("sets the bar title, document title, renders into #content-area, and sets __PanelInternals", () => {
    document.body.innerHTML = `
      <div class="widget-shell">
        <div class="title-bar" id="title-bar"><span id="bar-title">Loading…</span></div>
        <div class="content-area" id="content-area"></div>
      </div>
    `
    ;(globalThis as any).LunaWS = loadLunaWs()
    const conn = makeConn()
    act(() => {
      mountSettingsConnectorsPanel("settings.connectors", conn.ctx)
    })

    expect(document.getElementById("bar-title")!.textContent).toBe(PANEL_TITLE)
    expect(document.title).toBe(`Luna — ${PANEL_TITLE}`)
    expect(document.querySelectorAll("#content-area [data-testid]").length).toBeGreaterThan(0)
    expect((window as any).__PanelInternals).toEqual({
      type: "settings.connectors",
      hasModule: true,
      resolvedRouteKey: null,
      lastNotice: null,
    })
  })
})
