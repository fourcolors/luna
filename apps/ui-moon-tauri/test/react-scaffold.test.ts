/**
 * react-scaffold.test.ts — guards the React 19 + Astryx + Vite scaffold
 * (frontend-react/) added alongside the existing vanilla frontend/.
 *
 * Scope: this is a scaffold, not a panel conversion — chat.html, panel.html,
 * widget.html, and index.html keep running their existing vanilla content
 * unchanged. These tests pin the parts of the contract a future edit could
 * silently break:
 *   - the shared @luna/ui-shared store binding (createMoonStore) behaves
 *     like the reducer contract ui-web already relies on;
 *   - each of the four HTML shells still boots via a deferred React module
 *     script AFTER the existing vendor scripts, and still references
 *     vendor/* assets the way Vite's publicDir passthrough requires
 *     (root-absolute `="/vendor/`, never a relative `="vendor/` that Vite
 *     cannot resolve against publicDir);
 *   - the dynamic `panels/<type>.js` loader in panel.html stays a plain
 *     relative string (Vite must never touch it — that's what keeps
 *     unhashed panel modules loadable at runtime);
 *   - tauri.conf.json points at the Vite build output, not the old raw
 *     frontend/ directory.
 */
import { describe, it, expect } from "vitest"
import { readFileSync, existsSync, lstatSync, readlinkSync } from "node:fs"
import * as path from "node:path"

import { createMoonStore } from "../frontend-react/src/state/store"

const root = path.resolve(__dirname, "..")

describe("createMoonStore", () => {
  it("starts at the shared reducer's initial state and is a no-op store until dispatched", () => {
    const store = createMoonStore()
    expect(store.getState().events).toEqual([])
  })

  it("dispatch/subscribe notify listeners only on an actual state transition", () => {
    const store = createMoonStore()
    let notifications = 0
    const unsubscribe = store.subscribe(() => { notifications += 1 })

    // "optimistic-user" is an explicit no-op in the reducer today (a
    // placeholder for a future pending-bubble render) — it returns the same
    // state reference, so dispatch's Object.is(next, state) short-circuits
    // and no listener should fire.
    store.dispatch({ tag: "optimistic-user", threadId: "t1", text: "hi" })
    expect(notifications).toBe(0)

    unsubscribe()
  })
})

describe("frontend-react HTML shells (scaffold, compatibility-shell phase)", () => {
  const pages = ["index", "chat", "panel", "widget"] as const

  for (const page of pages) {
    const htmlPath = path.join(root, "frontend-react", `${page}.html`)
    const html = readFileSync(htmlPath, "utf8")

    it(`${page}.html mounts the React boot layer via a deferred module script`, () => {
      expect(html).toContain(`<script type="module" src="/src/main-${page}.tsx"></script>`)
    })

    it(`${page}.html references vendor/ assets via the publicDir root-absolute convention`, () => {
      // Every vendor href/src must be root-absolute ("/vendor/...") — Vite's
      // publicDir passthrough cannot resolve a relative "vendor/..." (it
      // isn't a real sibling file of the HTML source; it only exists via
      // frontend-react/public/vendor, a symlink to ../frontend/vendor).
      const relativeVendorRefs = html.match(/="vendor\//g)
      expect(relativeVendorRefs).toBeNull()
      const rootAbsoluteVendorRefs = html.match(/="\/vendor\//g)
      expect(rootAbsoluteVendorRefs).not.toBeNull()
      expect((rootAbsoluteVendorRefs ?? []).length).toBeGreaterThan(0)
    })

    it(`${page}.html's React boot script tag comes after every vendor <script>/<link> tag in source order`, () => {
      const bootIndex = html.indexOf(`src="/src/main-${page}.tsx"`)
      const lastVendorIndex = Math.max(
        ...[...html.matchAll(/="\/vendor\/[^"]*"/g)].map((m) => m.index ?? -1),
      )
      expect(bootIndex).toBeGreaterThan(lastVendorIndex)
    })
  }

  it("panel.html's dynamic panel-type loader stays a plain relative string (never Vite-processed)", () => {
    const html = readFileSync(path.join(root, "frontend-react", "panel.html"), "utf8")
    expect(html).toContain("s.src = 'panels/' + type.replace(/\\./g, '-') + '.js';")
  })
})

describe("frontend-react/public (vendor/panels passthrough)", () => {
  it("public/vendor and public/panels are symlinks back to frontend/{vendor,panels} — single source of truth, zero drift", () => {
    for (const dir of ["vendor", "panels"] as const) {
      const linkPath = path.join(root, "frontend-react", "public", dir)
      expect(existsSync(linkPath)).toBe(true)
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
      expect(readlinkSync(linkPath)).toBe(`../../frontend/${dir}`)
    }
  })
})

describe("tauri.conf.json", () => {
  it("frontendDist points at the Vite build output, not the raw frontend/ directory", () => {
    const conf = JSON.parse(
      readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
    ) as { build: { frontendDist: string; beforeBuildCommand: string; beforeDevCommand: string } }
    expect(conf.build.frontendDist).toBe("../frontend-react/dist")
    expect(conf.build.beforeBuildCommand).toContain("build:frontend")
    expect(conf.build.beforeDevCommand).toContain("build:frontend")
  })
})
