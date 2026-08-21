# Moon window behavior

Moon panels and artifact cards are independent native macOS windows.

**Related:** thread sidebar pull-out / redock (Chrome-tab model) lives in
`docs/chrome-tab-interaction.md`. That file is the rulebook for Attached vs
Detached thread drags. This file remains the law for **OS window** drag and
resize only.

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

One deliberate exception: the moon orb (window `main`) and any window being
revealed by boot restore, expand-from-moon, or collapse-to-moon is clamped
back onto a currently visible display first
(`windows::ensure_window_on_visible_display`). The orb and the widgets are
mutually exclusive surfaces, so an orb stranded off-screen by a
display-topology change would leave the user with nothing clickable at all —
Moon would read as "won't open". If `layout.json` listed panels but restore
spawned none (stale rows, spawn failure), boot falls back to opening the chat
widget so the user is never left with only the orb.

Two further guards against external state (live incident, Aug 2026):

- A `Moved`-event guard (`windows::reclamp_if_stranded`) pulls the orb back
  whenever ANYTHING parks it with its top-left off every connected display —
  it fires only for fully-stranded positions, so legitimate edge-hanging
  drags are respected and the guard converges after its own corrective move.
- Every Moon window opts out of macOS window-state restoration
  (`windows::disable_window_state_restoration`, `NSWindow.restorable = false`).
  Moon's `layout.json` restore is the single source of truth; AppKit's saved
  state (applied after non-clean exits such as the auto-updater's relaunch)
  otherwise re-imposes stale frames and stale visibility — an off-screen orb
  frame, a panel that exists in the accessibility tree but never composites.
- Moon owns the orb's position. `tauri.conf.json` sets no position for the
  `main` window and nothing in the app ever wrote one, so placement was left
  to AppKit's default choice — which proved able to park the orb off every
  display on multi-monitor arrangements, deterministically, on every clean
  launch. `write_panel_layout` now saves a `"moon": {x, y}` entry (on every
  layout write and on orb drag end) and boot restores it clamped on-screen;
  first launches fall back to AppKit placement plus the stranded-check.
- Stage Manager (live incident): an inactive app's windows are shelved into
  the WindowManager-owned left-edge tile strip (icon-sized tiles around
  x≈−307) instead of compositing — a shelved orb reads as "Moon won't open"
  and a shelved chat panel is AX-visible with no CG surface. Two rules:
  the orb is a floating companion (`windows::configure_orb_window`:
  `CanJoinAllSpaces | Stationary | IgnoresCycle`) so it is never shelved and
  follows the user to every Space; and `expand_out_of_moon` focuses one
  revealed widget (the chat when present — `pick_expand_focus_target`),
  because `show()` orders a window in but only activation makes Stage
  Manager swap the app's real windows in.

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
