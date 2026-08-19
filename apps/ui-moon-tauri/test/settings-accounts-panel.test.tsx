// @vitest-environment jsdom
/**
 * Settings Accounts: list two Anthropic rows; add/remove frames; capability gate.
 * Does not touch composer-config (#545).
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import {
  SETTINGS_ACCOUNTS_TITLE,
  SettingsAccountsPanel,
} from "../frontend-react/src/panels/settings-accounts/SettingsAccountsPanel"
import {
  isSettingsAccountsPanelType,
  mountSettingsAccountsPanel,
  SETTINGS_ACCOUNTS_PANEL_TYPES,
} from "../frontend-react/src/panels/settings-accounts-mount"
import {
  FIXED_ACCOUNT_KIND,
  healthLabel,
  initialAccountsPanelState,
  reduceAccountsPanel,
} from "../frontend-react/src/panels/settings-accounts/accountsReducer"
import type { LunaFrameRegistry, LunaWsClient, PanelCtx } from "../frontend-react/src/panels/panel-ctx"

function makeFrameRegistry(): LunaFrameRegistry {
  const handlers: Record<string, (frame: any) => void> = {}
  const registry: LunaFrameRegistry = {
    register(type, fn) {
      handlers[type] = fn
      return registry
    },
    dispatch(frame) {
      if (!frame || typeof (frame as { type?: unknown }).type !== "string") return false
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

function makeCtx(): {
  ctx: PanelCtx
  fireFrame: (frame: Record<string, unknown>) => void
  sent: Record<string, unknown>[]
} {
  let registry: LunaFrameRegistry | null = null
  let open = true
  const sent: Record<string, unknown>[] = []
  const sock = {
    get readyState() {
      return open ? 1 : 3
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
    registerCloseHook: () => {},
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
      if (!registry) throw new Error("connectWs was not called yet")
      registry.dispatch(frame)
    },
    sent,
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderPanel(ctx: PanelCtx) {
  container = document.createElement("div")
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(<SettingsAccountsPanel ctx={ctx} />)
  })
  return container
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

function findInput(testId: string): HTMLInputElement {
  const host = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null
  expect(host).not.toBeNull()
  if (host!.tagName === "INPUT") return host as HTMLInputElement
  const inner = host!.querySelector("input") as HTMLInputElement | null
  expect(inner).not.toBeNull()
  return inner!
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
  document.body.innerHTML = ""
  delete (window as any).__PanelInternals
})

describe("accountsReducer", () => {
  it("wipes secret-ref on submit-add-started and clears form on ok add", () => {
    let s = initialAccountsPanelState()
    s = reduceAccountsPanel(s, { type: "capability", supported: true })
    s = reduceAccountsPanel(s, { type: "id-changed", value: "account-secondary-1" })
    s = reduceAccountsPanel(s, { type: "label-changed", value: "secondary" })
    s = reduceAccountsPanel(s, {
      type: "secret-ref-changed",
      value: "claude-code:login",
    })
    s = reduceAccountsPanel(s, { type: "submit-add-started", requestId: "r1" })
    expect(s.secretRefInput).toBe("")
    s = reduceAccountsPanel(s, {
      type: "account-status-received",
      frame: { requestId: "r1", ok: true, message: "Account added. Restarting to apply." },
    })
    expect(s.idInput).toBe("")
    expect(s.statusLine?.kind).toBe("ok")
    expect(s.statusLine?.text).not.toContain("claude-code:login")
  })

  it("healthLabel maps rate_limited", () => {
    expect(healthLabel("rate_limited")).toBe("rate limited")
    expect(healthLabel("healthy")).toBe("healthy")
  })

  it("FIXED_ACCOUNT_KIND is anthropic", () => {
    expect(FIXED_ACCOUNT_KIND).toBe("anthropic")
  })
})

describe("SettingsAccountsPanel", () => {
  it("hides manage UI when hello lacks accountManage", () => {
    const { ctx, fireFrame } = makeCtx()
    renderPanel(ctx)
    act(() => {
      fireFrame({
        type: "hello",
        protocolVersion: 2,
        kinds: [],
        capabilities: { chat: true, streamingDeltas: true, setup: false },
      })
    })
    expect(document.querySelector('[data-testid="account-manage-unsupported"]')).toBeTruthy()
    expect(document.querySelector('[data-testid="account-add-submit"]')).toBeNull()
  })

  it("renders two Anthropic rows from account-list", () => {
    const { ctx, fireFrame } = makeCtx()
    renderPanel(ctx)
    act(() => {
      fireFrame({
        type: "hello",
        protocolVersion: 2,
        kinds: [],
        capabilities: {
          chat: true,
          streamingDeltas: true,
          setup: false,
          accountManage: true,
        },
      })
      fireFrame({
        type: "account-list",
        accounts: [
          { id: "default", label: "Claude.ai", kind: "anthropic", health: "healthy" },
          {
            id: "account-secondary-1",
            label: "secondary",
            kind: "anthropic",
            health: "rate_limited",
          },
        ],
      })
    })
    expect(document.querySelector('[data-testid="account-row-default"]')).toBeTruthy()
    expect(document.querySelector('[data-testid="account-row-account-secondary-1"]')).toBeTruthy()
    expect(container!.textContent).toContain("Claude.ai")
    expect(container!.textContent).toContain("secondary")
  })

  it("add then remove updates the list via account-list pushes", () => {
    const { ctx, fireFrame, sent } = makeCtx()
    renderPanel(ctx)

    act(() => {
      fireFrame({
        type: "hello",
        protocolVersion: 2,
        kinds: [],
        capabilities: {
          chat: true,
          streamingDeltas: true,
          setup: false,
          accountManage: true,
        },
      })
      fireFrame({
        type: "account-list",
        accounts: [
          { id: "default", label: "Claude.ai", kind: "anthropic", health: "healthy" },
        ],
      })
    })

    typeInto(findInput("account-id-input"), "account-secondary-1")
    typeInto(findInput("account-label-input"), "secondary")
    typeInto(findInput("account-secret-ref-input"), "claude-code:login")

    act(() => {
      ;(document.querySelector('[data-testid="account-add-submit"]') as HTMLElement).click()
    })

    const addFrame = sent.find((f) => f.type === "account-add")
    expect(addFrame).toMatchObject({
      type: "account-add",
      id: "account-secondary-1",
      label: "secondary",
      kind: "anthropic",
      secretRef: "claude-code:login",
    })
    expect(JSON.stringify(addFrame)).not.toMatch(/sk-ant|tok-/)

    act(() => {
      fireFrame({
        type: "account-status",
        requestId: addFrame!.requestId,
        ok: true,
        message: "Account added. Restarting to apply.",
      })
      fireFrame({
        type: "account-list",
        accounts: [
          { id: "default", label: "Claude.ai", kind: "anthropic", health: "healthy" },
          {
            id: "account-secondary-1",
            label: "secondary",
            kind: "anthropic",
            health: "healthy",
          },
        ],
      })
    })
    expect(document.querySelector('[data-testid="account-row-account-secondary-1"]')).toBeTruthy()

    act(() => {
      ;(
        document.querySelector('[data-testid="account-rm-account-secondary-1"]') as HTMLElement
      ).click()
    })
    act(() => {
      ;(
        document.querySelector(
          '[data-testid="account-rm-confirm-account-secondary-1"]',
        ) as HTMLElement
      ).click()
    })

    const rmFrame = sent.find((f) => f.type === "account-rm")
    expect(rmFrame).toMatchObject({ type: "account-rm", id: "account-secondary-1" })

    act(() => {
      fireFrame({
        type: "account-status",
        requestId: rmFrame!.requestId,
        ok: true,
        message: "Account removed. Restarting to apply.",
      })
      fireFrame({
        type: "account-list",
        accounts: [
          { id: "default", label: "Claude.ai", kind: "anthropic", health: "healthy" },
        ],
      })
    })
    expect(document.querySelector('[data-testid="account-row-account-secondary-1"]')).toBeNull()
  })

  it("mount routes settings.accounts", () => {
    expect(SETTINGS_ACCOUNTS_PANEL_TYPES).toEqual(["settings.accounts"])
    expect(isSettingsAccountsPanelType("settings.accounts")).toBe(true)
    document.body.innerHTML = `
      <div id="bar-title"></div>
      <div id="content-area"></div>
    `
    const ctx = { invoke: async () => null, hasTauri: false, win: null } as unknown as PanelCtx
    act(() => {
      mountSettingsAccountsPanel("settings.accounts", ctx)
    })
    expect(document.getElementById("bar-title")!.textContent).toBe(SETTINGS_ACCOUNTS_TITLE)
    expect((window as any).__PanelInternals.type).toBe("settings.accounts")
  })
})
