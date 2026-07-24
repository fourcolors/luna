import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const main = fs.readFileSync(path.resolve(__dirname, '../src-tauri/src/main.rs'), 'utf8')
const appearance = fs.readFileSync(
  path.resolve(__dirname, '../frontend/vendor/moon-appearance.js'),
  'utf8',
)
const theme = fs.readFileSync(
  path.resolve(__dirname, '../frontend/vendor/moon-theme.css'),
  'utf8',
)
// widget.html and chat.html have converted title-bar chrome (React 19 +
// Astryx, see frontend-react/src/widget/WidgetChrome.tsx and
// frontend-react/src/chat/chat-chrome-mount.tsx) - their superseded
// frontend/ copies were deleted since nothing else imported them, so both
// read from frontend-react/ here. panel.html is still an unconverted shell
// and reads from frontend/ as before.
const pages = [
  path.resolve(__dirname, '../frontend-react/chat.html'),
  path.resolve(__dirname, '../frontend/panel.html'),
  path.resolve(__dirname, '../frontend-react/widget.html'),
].map((p) => fs.readFileSync(p, 'utf8'))

describe('native macOS titlebar ownership', () => {
  it('configures AppKit traffic lights once when each native window is created', () => {
    const placements = main.match(
      /\.traffic_light_position\(tauri::LogicalPosition::new\(\s*TRAFFIC_LIGHT_INSET_X,\s*TRAFFIC_LIGHT_INSET_Y,?\s*\)\)/g,
    )
    expect(placements).toHaveLength(2)
    // One source of truth for the inset — builders and the AppKit re-apply
    // share these consts so the two placements cannot drift apart.
    expect(main).toContain('const TRAFFIC_LIGHT_INSET_X: f64 = 36.0')
    expect(main).toContain('const TRAFFIC_LIGHT_INSET_Y: f64 = 14.0')
    expect(main).toContain('fn configure_native_window_chrome(')
    expect(main).toContain('button.setHidden(false)')
  })

  it('uses standard native traffic lights everywhere: the zoom (green) button is never disabled', () => {
    // Regression guard. Non-chat cards used to build with maximizable(false) and
    // call setEnabled(false) on the zoom button, so the green light rendered as a
    // gray DISABLED dot. Standard native chrome keeps all three buttons enabled:
    // no per-window zoom gating, no setEnabled call that could gray the green.
    expect(main).not.toContain('zoom_enabled')
    expect(main).not.toMatch(/setEnabled/)
    // Both native window builders (spawn_panel_at + open_artifact_widget) opt the
    // zoom button into the style mask so AppKit renders it enabled/green.
    expect(main.match(/\.maximizable\(true\)/g)).toHaveLength(2)
    expect(main).not.toMatch(/\.maximizable\(false\)/)
  })

  it('zoom means zoom: card windows opt out of the native fullscreen Space', () => {
    expect(main).toContain('NSWindowCollectionBehavior::FullScreenNone')
  })

  it('has no runtime traffic-light commands or appearance IPC', () => {
    expect(main).not.toMatch(/sync_traffic_light_position|set_native_controls_visible/)
    expect(appearance).not.toMatch(/sync_traffic_light_position|set_native_controls_visible/)
  })

  it('has one control model: native AppKit controls, never hidden faux lights', () => {
    for (const page of pages) {
      expect(page).not.toMatch(/dock-lights|light-close|light-min|light-zoom/)
      expect(page).not.toMatch(/id="(?:close|min|zoom)-btn"/)
    }
    expect(theme).not.toMatch(/\.dock-lights|\.light-close|\.light-min|\.light-zoom/)
  })

  it('does not ship dead snap-era seam, weld, or transition chrome', () => {
    for (const page of pages) {
      expect(page).not.toMatch(/id="(?:seam|outline)"/)
    }
    expect(theme).not.toMatch(/#seam|#outline|data-weld|dock-pop|\.widget-shell\.dragging/)
  })
})
