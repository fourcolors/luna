// @vitest-environment jsdom
//
// Behavioral tests for the web appearance module (src/appearance.ts) — the
// TypeScript sibling of the moon's vendor/moon-appearance.js. Focused on the
// font + fontSize chat-typography dimensions added on top of the existing
// palette/theme/chrome/grain prefs, plus the data-attribute stamping contract
// that the watercolor.css [data-font]/[data-fontsize] rules depend on.
import { describe, it, expect, beforeEach } from "vitest"
import {
  applyAppearance,
  setAppearance,
  getAppearance,
  onAppearanceChange,
  FONTS,
  FONT_SIZES,
  FONT_LABELS,
  FONT_SIZE_LABELS,
} from "./appearance"

const el = () => document.documentElement

beforeEach(() => {
  window.localStorage.clear()
  for (const a of ["data-palette", "data-theme", "data-chrome", "data-grain", "data-font", "data-fontsize"]) {
    el().removeAttribute(a)
  }
})

describe("defaults", () => {
  it("getAppearance() returns sans / medium when nothing is stored", () => {
    const a = getAppearance()
    expect(a.font).toBe("sans")
    expect(a.fontSize).toBe("medium")
  })

  it("applyAppearance() stamps default data-font + data-fontsize", () => {
    applyAppearance()
    expect(el().getAttribute("data-font")).toBe("sans")
    expect(el().getAttribute("data-fontsize")).toBe("medium")
  })
})

describe("stored + invalid values", () => {
  it("reads a stored font + fontsize", () => {
    window.localStorage.setItem("luna_font", "serif")
    window.localStorage.setItem("luna_fontsize", "large")
    applyAppearance()
    expect(el().getAttribute("data-font")).toBe("serif")
    expect(el().getAttribute("data-fontsize")).toBe("large")
    expect(getAppearance().font).toBe("serif")
    expect(getAppearance().fontSize).toBe("large")
  })

  it("falls back to defaults on unknown stored values", () => {
    window.localStorage.setItem("luna_font", "papyrus")
    window.localStorage.setItem("luna_fontsize", "huge")
    applyAppearance()
    expect(el().getAttribute("data-font")).toBe("sans")
    expect(el().getAttribute("data-fontsize")).toBe("medium")
  })
})

describe("setAppearance()", () => {
  it("persists + stamps a valid font", () => {
    setAppearance("font", "hand")
    expect(window.localStorage.getItem("luna_font")).toBe("hand")
    expect(el().getAttribute("data-font")).toBe("hand")
  })

  it("persists + stamps a valid fontSize", () => {
    setAppearance("fontSize", "xlarge")
    expect(window.localStorage.getItem("luna_fontsize")).toBe("xlarge")
    expect(el().getAttribute("data-fontsize")).toBe("xlarge")
  })

  it("is a no-op on an invalid font", () => {
    setAppearance("font", "wingdings")
    expect(window.localStorage.getItem("luna_font")).toBeNull()
    expect(getAppearance().font).toBe("sans")
  })
})

describe("exported option lists", () => {
  it("FONTS + FONT_SIZES cover every label", () => {
    expect(FONTS).toEqual(["sans", "serif", "mono", "hand"])
    expect(FONT_SIZES).toEqual(["small", "medium", "large", "xlarge"])
    expect(FONTS.every((f) => typeof FONT_LABELS[f] === "string")).toBe(true)
    expect(FONT_SIZES.every((s) => typeof FONT_SIZE_LABELS[s] === "string")).toBe(true)
    // x-large is the only label that diverges from its stored value.
    expect(FONT_SIZE_LABELS.xlarge).toBe("x-large")
  })
})

describe("cross-tab sync (storage event)", () => {
  // Mirrors the moon-appearance suite so both clients have a regression net
  // for the new keys flowing through the shared storage-listener path.
  it("module storage listener re-applies data-font on a luna_font event", () => {
    window.localStorage.setItem("luna_font", "serif")
    // Listeners only read e.key; storageArea omitted to dodge jsdom's Storage IDL check.
    window.dispatchEvent(new StorageEvent("storage", { key: "luna_font", newValue: "serif" }))
    expect(el().getAttribute("data-font")).toBe("serif")
  })

  it("onAppearanceChange fires with the updated fontSize on a luna_fontsize event", () => {
    let seen: ReturnType<typeof getAppearance> | null = null
    const off = onAppearanceChange((a) => { seen = a })
    window.localStorage.setItem("luna_fontsize", "xlarge")
    window.dispatchEvent(new StorageEvent("storage", { key: "luna_fontsize", newValue: "xlarge" }))
    off()
    expect(seen).not.toBeNull()
    expect(seen!.fontSize).toBe("xlarge")
  })
})
