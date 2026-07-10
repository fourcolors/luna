# Moon window behavior

Moon panels and artifact cards are independent native macOS windows.

## Title bar

- Tauri creates decorated macOS windows with an overlay title bar.
- `WebviewWindowBuilder::traffic_light_position` places AppKit's native close,
  minimize, and zoom controls once at construction time. The 36px horizontal
  inset keeps the complete cluster inside the opaque rounded title bar.
- The controls stay visible on every Moon skin and AppKit owns hover, focus,
  hit testing, minimize, and zoom behavior.
- Chat and artifact windows allow native zoom. Compact utility and settings
  panels disable zoom because their fixed-purpose layouts do not gain useful
  space when maximized.
- There is no JavaScript-to-Rust traffic-light visibility or positioning IPC.

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
