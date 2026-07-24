// @vitest-environment jsdom
//
// Registry <-> module conformance guard, general-purpose across every
// panel.html?type=X entry in widget-registry.json (not specific to any one
// panel). Moved out of panel-workflows.test.ts (its original home, back when
// the Workflows panel was the only converted one) once the 'workflows' type
// stopped having a frontend/panels/workflows.js - see WorkflowsPanel.tsx.
//
// A typo in widget-registry.json's `page` (e.g. type=workflow) would ship
// the unknown-panel fallback while every behavioral test stays green - pin
// the contract: every panel.html?type=X entry either
//   (a) has a panels/<X with . -> -.js module registering LunaPanelTypes[X]
//       (the vanilla path), or
//   (b) is a React-owned type per panel.html's REACT_PANEL_TYPES map, in
//       which case panel-boot.tsx's mountReactPanel(X, ctx) must actually
//       dispatch it - parsed straight out of the live panel.html source so
//       this guard self-updates as more panels convert, instead of a
//       hardcoded exception list this file would silently rot against.
import { describe, it, expect, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { mountReactPanel } from "../frontend-react/src/panel-boot"
import type { PanelCtx } from "../frontend-react/src/panels/panel-ctx"

const registry = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../frontend/vendor/widget-registry.json"), "utf8"),
)
const panelKinds: string[] = registry.widgets
  .map((w: any) => /^panel\.html\?type=([a-z0-9.]+)$/.exec(w.page)?.[1])
  .filter(Boolean)

/** Extract panel.html's `var REACT_PANEL_TYPES = { ... };` object's keys. */
function reactOwnedPanelKinds(): Set<string> {
  const html = fs.readFileSync(path.resolve(__dirname, "../frontend-react/panel.html"), "utf8")
  const match = html.match(/var REACT_PANEL_TYPES = \{([\s\S]*?)\};/)
  const keys = new Set<string>()
  if (!match) return keys
  for (const part of match[1].split(",")) {
    const keyMatch = part.trim().match(/^'([^']+)'|^([a-zA-Z_$][\w$]*)/)
    const key = keyMatch?.[1] ?? keyMatch?.[2]
    if (key) keys.add(key)
  }
  return keys
}

describe("widget-registry panel conformance", () => {
  it("covers every panel-page registry entry", () => {
    expect(panelKinds.length).toBeGreaterThan(0)
    const panelPages = registry.widgets.filter((w: any) => String(w.page).startsWith("panel.html"))
    expect(panelKinds).toHaveLength(panelPages.length)
  })

  describe("every React-owned panel.html type is actually dispatched by mountReactPanel", () => {
    // Not every REACT_PANEL_TYPES key is a widget-registry page type - e.g.
    // 'settings-launcher' is a dual-dispatch alias panel.html also accepts
    // (see settings-launcher-mount.tsx's isSettingsLauncherPanelType), never
    // itself a `panel.html?type=` value in widget-registry.json. So this
    // checks the dispatcher directly, not registry membership.
    afterEach(() => {
      document.body.innerHTML = ""
      delete (window as any).__PanelInternals
    })

    it.each([...reactOwnedPanelKinds()])("mountReactPanel dispatches '%s'", (kind) => {
      document.body.innerHTML = `
        <div class="widget-shell">
          <div class="title-bar" id="title-bar"><span id="bar-title">Loading…</span></div>
          <div class="content-area" id="content-area"></div>
        </div>
      `
      const ctx = { invoke: async () => null, hasTauri: false, win: null } as unknown as PanelCtx
      expect(mountReactPanel(kind, ctx)).toBe(true)
    })
  })

  describe("each registry entry has a real implementation", () => {
    afterEach(() => {
      document.body.innerHTML = ""
      delete (window as any).__PanelInternals
    })

    const reactOwned = reactOwnedPanelKinds()

    it.each(panelKinds)("panels/%s resolves to a vanilla module or a React mount", (kind) => {
      const file = path.resolve(__dirname, "../frontend/panels", kind.replace(/\./g, "-") + ".js")
      if (fs.existsSync(file)) {
        const sandbox: any = {}
        new Function("globalThis", fs.readFileSync(file, "utf8"))(sandbox)
        expect(sandbox.LunaPanelTypes?.[kind]).toBeDefined()
        expect(typeof sandbox.LunaPanelTypes[kind].render).toBe("function")
        return
      }
      // No vanilla module on disk - must be React-owned per panel.html AND
      // actually claimed by the dispatcher, or this kind is dead: neither
      // renderer would ever produce anything but "Unknown panel type".
      expect(reactOwned.has(kind)).toBe(true)
      document.body.innerHTML = `
        <div class="widget-shell">
          <div class="title-bar" id="title-bar"><span id="bar-title">Loading…</span></div>
          <div class="content-area" id="content-area"></div>
        </div>
      `
      const ctx = { invoke: async () => null, hasTauri: false, win: null } as unknown as PanelCtx
      const dispatched = mountReactPanel(kind, ctx)
      expect(dispatched).toBe(true)
    })
  })
})
