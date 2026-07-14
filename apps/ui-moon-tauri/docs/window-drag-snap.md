# Moon window behavior

Moon panels and artifact cards are independent native macOS windows.

## Title bar

- Tauri creates decorated macOS windows with an overlay title bar.
- `WebviewWindowBuilder::traffic_light_position` places AppKit's native close,
  minimize, and zoom controls once at construction time. The 36px horizontal
  inset keeps the complete cluster inside the opaque rounded title bar.
- The controls stay visible on every Moon skin and AppKit owns hover, focus,
  hit testing, minimize, and zoom behavior.
- Every window uses the standard native traffic lights with all three controls
  enabled: the green (zoom) button is never disabled. A disabled AppKit zoom
  button renders as a gray dot instead of green, which reads as broken chrome,
  so all Moon windows build with `maximizable(true)` and never call
  `setEnabled(false)` on a traffic light.
- Zoom always means zoom, never native fullscreen: every card window carries
  `NSWindowCollectionBehaviorFullScreenNone`, so the green button resizes
  within the current screen instead of moving the transparent card onto a
  black fullscreen Space.
- The chrome finalize runs at construction, once more after AppKit's deferred
  title-bar layout pass, and again on window focus as a self-healing fallback.
  It is best-effort and never fails the command that opened the window.
- There is no JavaScript-to-Rust traffic-light visibility or positioning IPC.
- Non-macOS builds keep these windows borderless and chrome-less by design
  (decorations are macOS-only); collapse-to-moon is the only window control
  there. Moon ships on macOS only today.

## Dragging

`frontend/vendor/moon-dock.js` is now a small compatibility-named module that
hands title-bar pointer gestures directly to `WebviewWindow.startDragging()`.
AppKit owns the complete gesture.

Moon deliberately has no magnetic edge snap, snap-on-open, overlap correction,
weld graph, release watcher, or multi-window cluster towing. A window stays
where the user puts it. Saved system-panel positions continue to restore from
`~/.luna/layout.json` and are clamped on-screen when displays change.

## Resize

Borderless card resizing still uses `begin_native_resize` because tao's native
resize-drag API is not implemented on macOS. This path changes only the active
window and persists its final layout; it does not inspect or move siblings.

## Tests

- `test/moon-native-titlebar.test.ts` prevents runtime traffic-light IPC from
  returning.
- `test/moon-dock.test.ts` verifies direct native dragging and guards against
  reintroducing snap, weld, and cluster commands.
- `test/widget-window.test.ts` verifies widget pages do not load the old snap
  engine.
