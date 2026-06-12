/**
 * appearance.ts — applies the Luna Studio watercolor appearance preferences
 * to the document and keeps them live across tabs.
 *
 * TypeScript sibling of the moon's vendor/moon-appearance.js: same
 * localStorage keys, allowlists, and defaults, so the two clients share one
 * mental model (they run on different origins, so the storage itself is
 * per-client — only the convention is shared).
 *
 *   luna_palette — 'dawn' | 'meadow' | 'tide'      (default 'tide')
 *   luna_theme   — 'light' | 'dark'                (default 'dark')
 *   luna_chrome  — 'wash' | 'ink'                  (default 'wash')
 *   luna_grain   — 'true' | 'false'                (default 'false')
 *
 * Import for its side effect from main.tsx BEFORE render() so the
 * data-attributes are stamped pre-paint. Cross-tab sync rides the `storage`
 * event (fires in every OTHER tab; setAppearance applies locally too).
 */

export type Palette = "dawn" | "meadow" | "tide"
export type Theme = "light" | "dark"
export type Chrome = "wash" | "ink"

export interface Appearance {
  readonly palette: Palette
  readonly theme: Theme
  readonly chrome: Chrome
  readonly grain: boolean
}

export const PALETTES: ReadonlyArray<Palette> = ["dawn", "meadow", "tide"]
export const THEMES: ReadonlyArray<Theme> = ["light", "dark"]
export const CHROMES: ReadonlyArray<Chrome> = ["wash", "ink"]

/** Swatch preview colors (the LIGHT washes of each palette, left→right). */
export const PALETTE_SWATCHES: Readonly<Record<Palette, ReadonlyArray<string>>> = {
  dawn: ["#e8a7b0", "#f2c29a", "#ecd29a", "#c9b6d9", "#a8c5c0"],
  meadow: ["#b5c9a3", "#ecd9a0", "#aac9cf", "#d9c3a8", "#c2b4d6"],
  tide: ["#a9b8dc", "#93c2c4", "#d9b3bd", "#b8cde0", "#cfc3a4"],
}

const KEYS = {
  palette: "luna_palette",
  theme: "luna_theme",
  chrome: "luna_chrome",
  grain: "luna_grain",
} as const

type PrefName = keyof typeof KEYS

const VALID: Record<PrefName, ReadonlyArray<string>> = {
  palette: PALETTES,
  theme: THEMES,
  chrome: CHROMES,
  grain: ["true", "false"],
}

const DEFAULTS: Record<PrefName, string> = {
  palette: "tide",
  theme: "dark",
  chrome: "wash",
  grain: "false",
}

// Unknown/corrupt stored values fall back to the default; localStorage may
// be unavailable in exotic embeds (never throw).
const read = (name: PrefName): string => {
  let v: string | null = null
  try {
    v = window.localStorage.getItem(KEYS[name])
  } catch {
    /* unavailable */
  }
  return v !== null && VALID[name].includes(v) ? v : DEFAULTS[name]
}

export const applyAppearance = (): void => {
  const el = document.documentElement
  el.setAttribute("data-palette", read("palette"))
  el.setAttribute("data-theme", read("theme"))
  el.setAttribute("data-chrome", read("chrome"))
  el.setAttribute("data-grain", read("grain") === "true" ? "on" : "off")
}

export const setAppearance = (name: PrefName, value: string): void => {
  if (!VALID[name].includes(value)) return
  try {
    window.localStorage.setItem(KEYS[name], value)
  } catch {
    /* unavailable */
  }
  applyAppearance()
}

export const getAppearance = (): Appearance => ({
  palette: read("palette") as Palette,
  theme: read("theme") as Theme,
  chrome: read("chrome") as Chrome,
  grain: read("grain") === "true",
})

/**
 * Subscribe to appearance changes from OTHER tabs (and re-apply them to this
 * document). Returns an unsubscribe. The module's import-time listener
 * already keeps the DOM attributes fresh; components subscribe to refresh
 * their own control state.
 */
export const onAppearanceChange = (cb: (a: Appearance) => void): (() => void) => {
  const handler = (e: StorageEvent): void => {
    if (e.key === null || (Object.values(KEYS) as string[]).includes(e.key)) {
      applyAppearance()
      cb(getAppearance())
    }
  }
  window.addEventListener("storage", handler)
  return () => window.removeEventListener("storage", handler)
}

// Import-time side effects: stamp pre-paint + keep live on cross-tab writes.
applyAppearance()
window.addEventListener("storage", (e) => {
  if (e.key === null || (Object.values(KEYS) as string[]).includes(e.key)) {
    applyAppearance()
  }
})
