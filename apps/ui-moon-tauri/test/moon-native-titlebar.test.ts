import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Native window chrome (traffic lights, resize, panel/artifact window
// builders) lives in src-tauri/src/windows.rs, split out of main.rs in the
// moon-next main.rs split - main.rs itself no longer has any of this code.
const windowsRs = fs.readFileSync(path.resolve(__dirname, '../src-tauri/src/windows.rs'), 'utf8')
const mainRs = fs.readFileSync(path.resolve(__dirname, '../src-tauri/src/main.rs'), 'utf8')
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
  it('places AppKit traffic lights only via the chrome finalize — never via a tao inset', () => {
    // tao re-applies a stored `traffic_light_position` inset inside the content
    // view's drawRect on EVERY repaint — silently undoing the centered cluster
    // configure_native_chrome_ns lays out (the live drag/reorder margin-collapse
    // bug). build_card_window must leave it unset so tao's re-apply is a no-op;
    // the finalize is the single placer.
    expect(windowsRs).not.toMatch(/\.traffic_light_position\(/)
    // One source of truth for the inset.
    // Values track --card-inset in vendor/moon-theme.css, which a natively
    // framed (macOS) window collapses to 0 — see test/moon-native-frame.test.ts,
    // which asserts the arithmetic rather than these literals.
    expect(windowsRs).toContain('const TRAFFIC_LIGHT_INSET_X: f64 = 14.0')
    expect(windowsRs).toContain('const TRAFFIC_LIGHT_INSET_Y: f64 = 8.0')
    expect(windowsRs).toContain('fn configure_native_window_chrome(')
    expect(windowsRs).toContain('fn configure_native_chrome_ns(')
    expect(windowsRs).toContain('button.setHidden(false)')
    // The finalize also re-asserts the layout at the native mutation choke
    // points (a programmatic move or attach/detach can hand the title bar back
    // to AppKit's layout) plus a deferred re-apply at gesture end.
    expect(windowsRs).toContain('chrome re-apply after native move')
    expect(windowsRs).toContain('chrome re-apply after attach/detach')
    // AppKit re-lays out the title bar on every resize tick, reverting the
    // cluster to the default inset — the macOS Resized arm in main.rs
    // re-asserts the chrome on the resized dock window itself.
    expect(mainRs).toContain('configure_native_window_chrome(&w)')
  })

  it('uses standard native traffic lights everywhere: the zoom (green) button is never disabled', () => {
    // Regression guard. Non-chat cards used to build with maximizable(false) and
    // call setEnabled(false) on the zoom button, so the green light rendered as a
    // gray DISABLED dot. Standard native chrome keeps all three buttons enabled:
    // no per-window zoom gating, no setEnabled call that could gray the green.
    expect(windowsRs).not.toContain('zoom_enabled')
    expect(windowsRs).not.toMatch(/setEnabled/)
    // The shared card-window builder (build_card_window, used by
    // spawn_panel_at + open_artifact_widget) opts the zoom button into the
    // style mask so AppKit renders it enabled/green.
    expect(windowsRs.match(/\.maximizable\(true\)/g)).toHaveLength(1)
    expect(windowsRs).not.toMatch(/\.maximizable\(false\)/)
  })

  it('zoom means zoom: card windows opt out of the native fullscreen Space', () => {
    expect(windowsRs).toContain('NSWindowCollectionBehavior::FullScreenNone')
  })

  it('has no runtime traffic-light commands or appearance IPC', () => {
    expect(windowsRs).not.toMatch(/sync_traffic_light_position|set_native_controls_visible/)
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
