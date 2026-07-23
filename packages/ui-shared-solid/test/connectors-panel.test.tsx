// @vitest-environment jsdom
/**
 * ConnectorsPanel render tests (M2.6 review — the web OAuth-client setup form
 * had zero automated coverage). Real Solid renders via solid-js/web into jsdom;
 * the Solid JSX transform comes from vite-plugin-solid in the root vitest
 * config.
 *
 * Pins:
 *   - configured:false renders the setup form; Save is disabled until a
 *     client id is typed
 *   - submitting calls onSetClient(defId, id, secret|undefined) and CLEARS
 *     both inputs (no credentials lingering in the DOM)
 *   - configured:true hides the form behind the ✓ badge + an Edit toggle
 *     (the recovery path), and re-rendering with configured flipped removes
 *     the form
 *
 * C1 multi-account pins:
 *   - two instances of one definition render two labeled rows, each with a
 *     Disconnect button wired to the correct instance id
 *   - the api-key connect form forwards the typed label to onConnectApiKey;
 *     empty label → undefined; button label reads "Add account" when instances
 *     already exist
 */
import { describe, expect, it, vi } from "vitest"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import type { ConnectorCatalogItem, ConnectorInstanceItem } from "@luna/ui-shared"
import { ConnectorsPanel } from "../src/ConnectorsPanel.jsx"

const gw = (configured: boolean): ConnectorCatalogItem => ({
  id: "google_workspace",
  name: "Google Workspace",
  blurb: "Mail & files.",
  category: "productivity",
  authKind: "oauth2",
  capabilities: [],
  clientSetup: { configured },
})

const slackDef = (): ConnectorCatalogItem => ({
  id: "slack",
  name: "Slack",
  blurb: "Messaging.",
  category: "messaging",
  authKind: "api-key",
  capabilities: [
    { id: "read", label: "Read messages", scopes: ["channels:read"], defaultGranted: true },
  ],
})

const makeInstance = (overrides: Partial<ConnectorInstanceItem> & { id: string; definitionId: string; label: string }): ConnectorInstanceItem => ({
  status: "connected",
  grantedScopes: [],
  createdAt: 0,
  lastHealthyAt: null,
  ...overrides,
})

interface Rig {
  readonly container: HTMLElement
  readonly setCatalog: (c: ReadonlyArray<ConnectorCatalogItem>) => void
  readonly calls: Array<{ defId: string; clientId: string; clientSecret: string | undefined }>
  readonly dispose: () => void
}

const mount = (initial: ReadonlyArray<ConnectorCatalogItem>): Rig => {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const [catalog, setCatalog] = createSignal(initial)
  const calls: Rig["calls"] = []
  const dispose = render(
    () => (
      <ConnectorsPanel
        catalog={catalog()}
        instances={[]}
        onConnectApiKey={() => {}}
        onDisconnect={() => {}}
        onSetClient={(defId, clientId, clientSecret) =>
          calls.push({ defId, clientId, clientSecret })
        }
      />
    ),
    container,
  )
  return {
    container,
    setCatalog,
    calls,
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}

const inputs = (c: HTMLElement) => ({
  id: c.querySelector("input[type=text]") as HTMLInputElement | null,
  secret: c.querySelector("input[type=password]") as HTMLInputElement | null,
  save: [...c.querySelectorAll("button")].find(
    (b) => b.textContent === "Save client",
  ) as HTMLButtonElement | undefined,
})

const type = (el: HTMLInputElement, value: string) => {
  el.value = value
  el.dispatchEvent(new Event("input", { bubbles: true }))
}

describe("ConnectorsPanel — OAuth client setup (M2.6)", () => {
  it("mentions publish-to-production trap in the setup form", () => {
    const rig = mount([gw(false)])
    try {
      expect(rig.container.textContent).toMatch(/Production/i)
      expect(rig.container.textContent).toMatch(/7 days/i)
    } finally {
      rig.dispose()
    }
  })

  it("configured:false renders the form; Save disabled until an id is typed", () => {
    const rig = mount([gw(false)])
    try {
      const { id, secret, save } = inputs(rig.container)
      expect(id).not.toBeNull()
      expect(secret).not.toBeNull()
      expect(save).toBeDefined()
      expect(save!.disabled).toBe(true)
      type(id!, "my-id.apps.googleusercontent.com")
      expect(save!.disabled).toBe(false)
    } finally {
      rig.dispose()
    }
  })

  it("submit calls onSetClient and clears both inputs; empty secret → undefined", () => {
    const rig = mount([gw(false)])
    try {
      const { id, secret, save } = inputs(rig.container)
      type(id!, "  my-id  ")
      type(secret!, "")
      save!.click()
      expect(rig.calls).toEqual([
        { defId: "google_workspace", clientId: "my-id", clientSecret: undefined },
      ])
      expect(id!.value).toBe("")
      expect(secret!.value).toBe("")
      // With a secret present it is forwarded (trimmed).
      type(id!, "id2")
      type(secret!, " s3cret ")
      save!.click()
      expect(rig.calls[1]).toEqual({
        defId: "google_workspace",
        clientId: "id2",
        clientSecret: "s3cret",
      })
      expect(secret!.value).toBe("")
    } finally {
      rig.dispose()
    }
  })

  it("configured:true hides the form behind ✓ + Edit; flipping configured removes the form reactively", () => {
    const rig = mount([gw(true)])
    try {
      expect(rig.container.textContent).toContain("✓ OAuth client configured")
      expect(inputs(rig.container).id).toBeNull() // no form while closed
      // Edit opens the form — the recovery path for a wrong credential.
      const edit = [...rig.container.querySelectorAll("button")].find(
        (b) => b.textContent === "edit",
      )!
      edit.click()
      expect(inputs(rig.container).id).not.toBeNull()
      // Reactive flip: a fresh catalog where configured stays true but the
      // panel re-renders (e.g. after a save broadcast) — submitting closes it.
      const { id, save } = inputs(rig.container)
      type(id!, "fixed-id")
      save!.click()
      expect(rig.calls[0]?.clientId).toBe("fixed-id")
      expect(inputs(rig.container).id).toBeNull() // edit mode closed on submit

      // And a catalog flip configured:true→false shows the form unprompted.
      rig.setCatalog([gw(false)])
      expect(inputs(rig.container).id).not.toBeNull()
    } finally {
      rig.dispose()
    }
  })
})

describe("ConnectorsPanel — multi-account (C1)", () => {
  it("two instances of one definition render two labeled rows each with per-instance Disconnect", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const onDisconnect = vi.fn()
    const inst1 = makeInstance({ id: "inst-1", definitionId: "google_workspace", label: "personal" })
    const inst2 = makeInstance({ id: "inst-2", definitionId: "google_workspace", label: "flowstay", status: "needs-reauth" })
    const dispose = render(
      () => (
        <ConnectorsPanel
          catalog={[gw(true)]}
          instances={[inst1, inst2]}
          onConnectApiKey={() => {}}
          onDisconnect={onDisconnect}
        />
      ),
      container,
    )
    try {
      // Both labels rendered
      expect(container.textContent).toContain("personal")
      expect(container.textContent).toContain("flowstay")
      // Status badges
      expect(container.textContent).toContain("connected")
      expect(container.textContent).toContain("needs-reauth")
      // Two Disconnect buttons, wired correctly
      const disconnectBtns = [...container.querySelectorAll("button")].filter(
        (b) => b.textContent === "Disconnect",
      ) as HTMLButtonElement[]
      expect(disconnectBtns).toHaveLength(2)
      disconnectBtns[0]!.click()
      expect(onDisconnect).toHaveBeenCalledWith("inst-1")
      disconnectBtns[1]!.click()
      expect(onDisconnect).toHaveBeenCalledWith("inst-2")
    } finally {
      dispose()
      container.remove()
    }
  })

  it("api-key form: button reads 'Add account' with existing instances; typed label forwarded; empty label → undefined", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const onConnectApiKey = vi.fn()
    const existingInst = makeInstance({ id: "inst-slack-1", definitionId: "slack", label: "personal" })
    const [instances, setInstances] = createSignal<ReadonlyArray<ConnectorInstanceItem>>([])
    const dispose = render(
      () => (
        <ConnectorsPanel
          catalog={[slackDef()]}
          instances={instances()}
          onConnectApiKey={onConnectApiKey}
          onDisconnect={() => {}}
        />
      ),
      container,
    )
    try {
      // 0 instances → button reads "Connect"
      const connectBtn0 = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Connect",
      ) as HTMLButtonElement | undefined
      expect(connectBtn0).toBeDefined()

      // Open the form, fill fields, submit with a label
      connectBtn0!.click()
      const allInputs = container.querySelectorAll("input[type=text]") as NodeListOf<HTMLInputElement>
      // first input = label, second = secret ref
      const labelInput = allInputs[0]!
      const refInput = allInputs[1]!
      type(labelInput, "work")
      type(refInput, "env:SLACK_TOKEN")
      const connectSubmitBtn = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Connect",
      ) as HTMLButtonElement | undefined
      connectSubmitBtn!.click()
      expect(onConnectApiKey).toHaveBeenCalledWith("slack", "env:SLACK_TOKEN", ["read"], "work")

      // Now add an existing instance → button reads "Add account"
      setInstances([existingInst])
      const addBtn = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Add account",
      ) as HTMLButtonElement | undefined
      expect(addBtn).toBeDefined()

      // Open form again, submit with empty label → undefined
      addBtn!.click()
      const allInputs2 = container.querySelectorAll("input[type=text]") as NodeListOf<HTMLInputElement>
      const labelInput2 = allInputs2[0]!
      const refInput2 = allInputs2[1]!
      type(labelInput2, "   ") // whitespace only → trimmed to empty → undefined
      type(refInput2, "env:SLACK_TOKEN_2")
      const connectSubmitBtn2 = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Connect",
      ) as HTMLButtonElement | undefined
      connectSubmitBtn2!.click()
      expect(onConnectApiKey).toHaveBeenLastCalledWith("slack", "env:SLACK_TOKEN_2", ["read"], undefined)
    } finally {
      dispose()
      container.remove()
    }
  })
})
