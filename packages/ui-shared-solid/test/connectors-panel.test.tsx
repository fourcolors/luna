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
 */
import { describe, expect, it } from "vitest"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import type { ConnectorCatalogItem } from "@luna/ui-shared"
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
