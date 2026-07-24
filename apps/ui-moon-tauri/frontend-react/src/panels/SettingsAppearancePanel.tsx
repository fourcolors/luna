/**
 * SettingsAppearancePanel.tsx - React 19 + Astryx port of
 * apps/ui-moon-tauri/frontend/panels/settings-appearance.js (registered there
 * as `LunaPanelTypes['settings.appearance']`): the watercolor palette,
 * light/dark theme, panel chrome, window skin, paper grain, chat font and
 * chat text-size controls.
 *
 * PRE-PAINT STAMPING IS UNTOUCHED: vendor/moon-appearance.js still owns
 * data-palette/data-theme/data-chrome/data-skin/data-grain/data-font/
 * data-fontsize on <html>, applied synchronously in <head> before this (or
 * any) page's body paints - see panel.html/chat.html/index.html/widget.html.
 * This panel never stamps those attributes itself; every control here calls
 * through to `window.LunaAppearance.set(name, value)`, the SAME function the
 * vanilla module called, which writes localStorage AND re-stamps <html>
 * synchronously. This component only decides what to *show* as active.
 *
 * STATE SOURCE (mirrors settings-general/SettingsGeneralPanel.tsx's "STATE
 * SOURCE" note - localStorage-backed panel preferences have no representation
 * in the shared @luna/ui-shared reducer, so there is nothing to bind through
 * useMoonSelector/src/state/store.ts): state lives in plain React state,
 * seeded once from `LunaAppearance.get()` on mount. Two differences from the
 * settings-general precedent, both required by the vanilla behavior this
 * ports and covered by this file's test:
 *   1. `LunaAppearance.set()` does NOT fire a `storage` event in the WRITING
 *      window (browser spec: storage events only fire in *other* documents),
 *      so every local mutation re-reads `.get()` into state immediately
 *      after calling `set()` - exactly like the vanilla module's click
 *      handlers directly toggling DOM classes locally.
 *   2. A `storage` listener re-reads `.get()` whenever ANOTHER window changes
 *      a `luna_*` appearance key (or clears localStorage entirely, e.g. key
 *      === null), so this panel stays in sync across every open Luna window
 *      - the vanilla module's own `onStorage` handler did the same.
 *
 * Astryx mapping: SegmentedControl for every plain-text single-select row
 * (window skin, theme, panel chrome, chat text size) - real role="radio"
 * items via SegmentedControlItem, replacing the vanilla `.chip`/`.on` button
 * row. ToggleButtonGroup (type="single") for the two rows that need custom
 * visible content per option instead of plain text - the palette swatches
 * (5 color dots) and the chat-font chips (each previews in its own
 * typeface) - SegmentedControlItem's `label` is text-only, but ToggleButton
 * accepts `children` for the visible content while `label` still supplies
 * the accessible name. Switch for the paper-grain boolean.
 */
import { useEffect, useState } from "react"
import {
  SegmentedControl,
  SegmentedControlItem,
  Switch,
  Text,
  ToggleButton,
  ToggleButtonGroup,
  VStack,
} from "../astryx-kit"

export const SETTINGS_APPEARANCE_TITLE = "Appearance"

type Palette = "dawn" | "meadow" | "tide"
type Theme = "light" | "dark"
type Chrome = "wash" | "ink"
type Skin = "studio" | "classic" | "aqua"
type Font = "sans" | "serif" | "mono" | "hand"
type FontSize = "small" | "medium" | "large" | "xlarge"

export interface AppearanceState {
  palette: Palette
  theme: Theme
  chrome: Chrome
  skin: Skin
  grain: boolean
  font: Font
  fontSize: FontSize
}

type AppearanceKey = keyof AppearanceState

/** Mirrors window.LunaAppearance's public surface (frontend/vendor/moon-appearance.js). */
export interface LunaAppearanceGlobal {
  get(): AppearanceState
  set(name: AppearanceKey, value: string): void
  apply(): void
  readonly KEYS: Record<AppearanceKey, string>
  readonly DEFAULTS: Record<AppearanceKey, string>
}

declare global {
  interface Window {
    /** Attached by frontend/vendor/moon-appearance.js (classic script,
     *  loaded pre-paint in every Moon page's <head> - see that file's doc
     *  comment for the full localStorage-key/data-attribute contract). */
    LunaAppearance?: LunaAppearanceGlobal
  }
}

// 5 LIGHT watercolor washes per palette (left to right) - identical values to
// the vanilla module's PALETTE_COLORS, purely decorative swatch previews.
const PALETTE_COLORS: Record<Palette, readonly string[]> = {
  dawn: ["#e8a7b0", "#f2c29a", "#ecd29a", "#c9b6d9", "#a8c5c0"],
  meadow: ["#b5c9a3", "#ecd9a0", "#aac9cf", "#d9c3a8", "#c2b4d6"],
  tide: ["#a9b8dc", "#93c2c4", "#d9b3bd", "#b8cde0", "#cfc3a4"],
}

const PALETTES: readonly Palette[] = ["dawn", "meadow", "tide"]

const SKIN_OPTIONS: ReadonlyArray<{ value: Skin; label: string }> = [
  { value: "studio", label: "studio" },
  { value: "classic", label: "classic" },
  { value: "aqua", label: "aqua" },
]

const CHROME_OPTIONS: ReadonlyArray<{ value: Chrome; label: string }> = [
  { value: "wash", label: "soft wash" },
  { value: "ink", label: "ink outline" },
]

const FONT_OPTIONS: ReadonlyArray<{ value: Font; label: string; token: string }> = [
  { value: "sans", label: "sans", token: "var(--font-body)" },
  { value: "serif", label: "serif", token: "var(--font-serif)" },
  { value: "mono", label: "mono", token: "var(--font-mono)" },
  { value: "hand", label: "hand", token: "var(--font-hand)" },
]

const SIZE_OPTIONS: ReadonlyArray<{ value: FontSize; label: string }> = [
  { value: "small", label: "small" },
  { value: "medium", label: "medium" },
  { value: "large", label: "large" },
  { value: "xlarge", label: "x-large" },
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <VStack gap={1}>
      <Text type="label">{title}</Text>
      {children}
    </VStack>
  )
}

/** 5 mini color-wash dots, previewing a palette inside a ToggleButton. */
function PaletteSwatch({ colors }: { colors: readonly string[] }) {
  return (
    <span style={{ display: "inline-flex" }}>
      {colors.map((color, i) => (
        <span
          key={i}
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 12,
            height: 12,
            borderRadius: "50%",
            marginLeft: i === 0 ? 0 : -3,
            background: color,
            boxShadow: "0 0 0 1px color-mix(in oklab, var(--ink, #000) 15%, transparent)",
          }}
        />
      ))}
    </span>
  )
}

export function SettingsAppearancePanel() {
  const [appearance, setAppearanceState] = useState<AppearanceState | null>(() =>
    window.LunaAppearance ? window.LunaAppearance.get() : null,
  )

  // Cross-window sync: another Luna window changed a luna_* appearance key
  // (or cleared localStorage entirely - e.key === null) - re-read and
  // re-render. Mirrors the vanilla module's own `onStorage` handler.
  useEffect(() => {
    const appearanceApi = window.LunaAppearance
    if (!appearanceApi) return
    function onStorage(e: StorageEvent) {
      const keys = appearanceApi!.KEYS
      if (e.key === null || (Object.values(keys) as string[]).includes(e.key)) {
        setAppearanceState(appearanceApi!.get())
      }
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  if (!appearance) {
    return <div className="notice">Appearance controls are unavailable in this window.</div>
  }

  // LunaAppearance.set() writes localStorage + re-stamps <html> synchronously
  // but does not fire a `storage` event in this (the writing) window, so
  // every local change re-reads .get() into state right after - exactly like
  // the vanilla module's click handlers toggling DOM classes locally.
  function set(name: AppearanceKey, value: string): void {
    const appearanceApi = window.LunaAppearance
    if (!appearanceApi) return
    appearanceApi.set(name, value)
    setAppearanceState(appearanceApi.get())
  }

  return (
    <div className="moon-astryx-root settings-appearance-panel" data-testid="settings-appearance-panel">
      <VStack gap={4}>
        <Section title="Window skin">
          <SegmentedControl
            label="Window skin"
            value={appearance.skin}
            onChange={(value) => set("skin", value)}
            data-testid="skin-control"
          >
            {SKIN_OPTIONS.map((opt) => (
              <SegmentedControlItem key={opt.value} value={opt.value} label={opt.label} data-testid={`skin-${opt.value}`} />
            ))}
          </SegmentedControl>
        </Section>

        <Section title="Watercolor palette">
          <ToggleButtonGroup
            label="Watercolor palette"
            value={appearance.palette}
            onChange={(value) => value && set("palette", value)}
            data-testid="palette-control"
          >
            {PALETTES.map((name) => (
              <ToggleButton key={name} value={name} label={name} data-testid={`palette-${name}`}>
                <PaletteSwatch colors={PALETTE_COLORS[name]} />
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Section>

        <Section title="Appearance">
          <SegmentedControl
            label="Appearance"
            value={appearance.theme}
            onChange={(value) => set("theme", value)}
            data-testid="theme-control"
          >
            <SegmentedControlItem value="light" label="light" data-testid="theme-light" />
            <SegmentedControlItem value="dark" label="dark" data-testid="theme-dark" />
          </SegmentedControl>
        </Section>

        <Section title="Panel chrome">
          <SegmentedControl
            label="Panel chrome"
            value={appearance.chrome}
            onChange={(value) => set("chrome", value)}
            data-testid="chrome-control"
          >
            {CHROME_OPTIONS.map((opt) => (
              <SegmentedControlItem key={opt.value} value={opt.value} label={opt.label} data-testid={`chrome-${opt.value}`} />
            ))}
          </SegmentedControl>
        </Section>

        <Switch
          label="Paper grain"
          description="Subtle fractal-noise texture over every window"
          value={appearance.grain}
          onChange={(checked) => set("grain", String(checked))}
          labelPosition="start"
          labelSpacing="spread"
          data-testid="grain-toggle"
        />

        <Section title="Chat font">
          <ToggleButtonGroup
            label="Chat font"
            value={appearance.font}
            onChange={(value) => value && set("font", value)}
            data-testid="font-control"
          >
            {FONT_OPTIONS.map((opt) => (
              <ToggleButton key={opt.value} value={opt.value} label={opt.label} data-testid={`font-${opt.value}`}>
                <span style={{ fontFamily: opt.token }}>{opt.label}</span>
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Section>

        <Section title="Chat text size">
          <SegmentedControl
            label="Chat text size"
            value={appearance.fontSize}
            onChange={(value) => set("fontSize", value)}
            data-testid="fontsize-control"
          >
            {SIZE_OPTIONS.map((opt) => (
              <SegmentedControlItem key={opt.value} value={opt.value} label={opt.label} data-testid={`fontsize-${opt.value}`} />
            ))}
          </SegmentedControl>
        </Section>

        <Text type="supporting">Changes apply to every open Luna window instantly.</Text>
      </VStack>
    </div>
  )
}
