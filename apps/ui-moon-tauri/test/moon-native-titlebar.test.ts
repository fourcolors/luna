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
const pages = ['chat.html', 'panel.html', 'widget.html'].map((name) =>
  fs.readFileSync(path.resolve(__dirname, '../frontend', name), 'utf8'),
)

describe('native macOS titlebar ownership', () => {
  it('configures AppKit traffic lights once when each native window is created', () => {
    const placements = main.match(
      /\.traffic_light_position\(tauri::LogicalPosition::new\(\s*TRAFFIC_LIGHT_INSET_X,\s*TRAFFIC_LIGHT_INSET_Y,?\s*\)\)/g,
    )
    expect(placements).toHaveLength(2)
    // One source of truth for the inset — builders and the AppKit re-apply
    // share these consts so the two placements cannot drift apart.
    expect(main).toContain('const TRAFFIC_LIGHT_INSET_X: f64 = 36.0')
    expect(main).toContain('const TRAFFIC_LIGHT_INSET_Y: f64 = 12.0')
    expect(main).toContain('.maximizable(desc.kind == "chat")')
    expect(main.match(/\.maximizable\(true\)/g)).toHaveLength(1)
    expect(main).toContain('fn configure_native_window_chrome(')
    expect(main).toContain('button.setHidden(false)')
    expect(main).toContain('button.setEnabled(zoom_enabled)')
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
