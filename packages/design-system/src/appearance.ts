/**
 * appearance.ts — applies the Luna Studio watercolor appearance preferences
 * to the document and keeps them live across tabs.
 *
 * TypeScript sibling of the moon's vendor/moon-appearance.js: same
 * localStorage keys, allowlists, and defaults, so the two clients share one
 * mental model (they run on different origins, so the storage itself is
 * per-client — only the convention is shared).
 *
 *   luna_palette  — 'dawn' | 'meadow' | 'tide'              (default 'tide')
 *   luna_theme    — 'light' | 'dark'                        (default 'dark')
 *   luna_chrome   — 'wash' | 'ink'                          (default 'wash')
 *   luna_grain    — 'true' | 'false'                        (default 'false')
 *   luna_font     — 'sans' | 'serif' | 'mono' | 'hand'      (default 'sans')
 *   luna_fontsize — 'small'|'medium'|'large'|'xlarge'       (default 'medium')
 *
 * font / fontsize only re-skin the CHAT reading + writing surfaces (bubbles,
 * markdown, composer) via the --font-chat / --font-scale tokens — NOT the
 * whole UI chrome, so panel/board layout never reflows.
 *
 * Import for its side effect from main.tsx BEFORE render() so the
 * data-attributes are stamped pre-paint. Cross-tab sync rides the `storage`
 * event (fires in every OTHER tab; setAppearance applies locally too).
 */

export type Palette = "dawn" | "meadow" | "tide"
export type Theme = "light" | "dark"
export type Chrome = "wash" | "ink"
export type Font = "sans" | "serif" | "mono" | "hand"
export type FontSize = "small" | "medium" | "large" | "xlarge"

export interface Appearance {
  readonly palette: Palette
  readonly theme: Theme
  readonly chrome: Chrome
  readonly grain: boolean
  readonly font: Font
  readonly fontSize: FontSize
}

export const PALETTES: ReadonlyArray<Palette> = ["dawn", "meadow", "tide"]
const THEMES: ReadonlyArray<Theme> = ["light", "dark"]
const CHROMES: ReadonlyArray<Chrome> = ["wash", "ink"]
export const FONTS: ReadonlyArray<Font> = ["sans", "serif", "mono", "hand"]
export const FONT_SIZES: ReadonlyArray<FontSize> = ["small", "medium", "large", "xlarge"]

/** Human labels for the font + size chips (chip text ↔ stored value). */
export const FONT_LABELS: Readonly<Record<Font, string>> = {
  sans: "sans",
  serif: "serif",
  mono: "mono",
  hand: "hand",
}
export const FONT_SIZE_LABELS: Readonly<Record<FontSize, string>> = {
  small: "small",
  medium: "medium",
  large: "large",
  xlarge: "x-large",
}

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
  font: "luna_font",
  fontSize: "luna_fontsize",
} as const

type PrefName = keyof typeof KEYS

const VALID: Record<PrefName, ReadonlyArray<string>> = {
  palette: PALETTES,
  theme: THEMES,
  chrome: CHROMES,
  grain: ["true", "false"],
  font: FONTS,
  fontSize: FONT_SIZES,
}

const DEFAULTS: Record<PrefName, string> = {
  palette: "tide",
  theme: "dark",
  chrome: "wash",
  grain: "false",
  font: "sans",
  fontSize: "medium",
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
  el.setAttribute("data-font", read("font"))
  el.setAttribute("data-fontsize", read("fontSize"))
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
  font: read("font") as Font,
  fontSize: read("fontSize") as FontSize,
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
