# Moon window behavior

Moon panels and artifact cards are independent native macOS windows that snap
together WinAmp-style.

**Related:** thread sidebar pull-out / redock (Chrome-tab model) lives in
`docs/chrome-tab-interaction.md`. That file is the rulebook for Attached vs
Detached thread drags. This file remains the law for **OS window** drag,
resize, and snapping.

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

`frontend/vendor/moon-dock.js` hands title-bar pointer gestures to
`WebviewWindow.startDragging()`; AppKit owns the complete gesture.

The snap settle does NOT rely on per-gesture arming: a large share of real
title-bar presses are swallowed by the transparent NSWindow title-bar zone
before the webview ever sees `pointerdown`, so an arm-IPC can miss the
gesture while the window still drags natively. Instead the settle keys on
GEOMETRY — a persistent native watcher (`windows::install_snap_watcher`)
snapshots every dock window's frame on `LeftMouseDown`, and on
`LeftMouseUp` settles each window whose frame changed:
`windows::snap_to_flush_edge` moves it flush to the nearest qualifying
edge (within `SNAP_GAP`, or shallow overlap within `SNAP_OVERLAP`), then
`windows::apply_attachment_plan` re-derives the whole parent/child graph
from the new geometry. A flick released before tao can deliver a queued
`Moved` event still diffs; a press that never moves anything settles
nothing; programmatic moves (boot restore, a settle's own corrective
move, resize re-flush) only settle when they coincide with a real press.

`begin_redock_drag` (pinned chat floaters only) is still armed per-gesture
from JS before `startDragging` — its hit-probe must be live DURING the
drag, so unlike the mouse-up settle it cannot be re-derived from Moved
events.

JavaScript never moves windows mid-gesture, never enumerates siblings, and
never runs a `setPosition` loop — the snap settle is one native move at
mouse-up.

## Snapping (WinAmp model)

Dock windows (`panel-*`, `widget-*`; never the `main` orb) snap flush to each
other's edges:

- **Snap-on-open:** a fresh widget or panel with no explicit position is
  placed flush on the chat's edge (`windows::open_snap_top_left`), cascading
  past already-snapped siblings so a run of opens stacks instead of piling.
  Edges are tried right / below / left / above; the first whose cascaded
  rect fits the anchor's monitor wins. The chat itself and the transient
  launcher never snap-on-open.
- **Snap-on-release:** dropping a window within `SNAP_GAP` of a neighbor's
  edge settles it flush and attaches it; releasing out of range detaches.
  Coverage is total — the snapshot watcher catches drags the webview never
  saw start, with no dependence on `Moved`-event queue timing.
- **Cluster towing:** attachment is the real AppKit parent/child
  (`NSWindow.addChildWindow`/`removeChildWindow`). Moving a window tows its
  snapped children natively in the same gesture — atomic, zero IPC. A
  middle-of-stack grab tows the tail; a leaf grab peels off alone.

  The graph itself is a PURE function of geometry
  (`windows::plan_attachments`): the flush-adjacency graph is built over
  the current frames, and each connected component becomes a BFS spanning
  tree rooted at the chat when it contains one — the chat is the cluster
  hub, so a widget snapped on any side tows with the next chat drag
  instead of being stranded — or at the smallest label when it does not.
  Each non-root node parents to its adjacent node nearest the root; ties
  break on the longest shared edge, then the smaller label. Because the
  tree is a spanning forest by construction, cycles cannot form; because
  the plan is order-independent, boot restore, open-time placement, and
  the mouse-up settle always produce the same graph for the same
  geometry. `apply_attachment_plan` is the single AppKit adapter: it
  diffs live links against the plan — detaching mismatches first (a
  direction reversal must drop the old edge before the new one takes),
  then attaching planned edges — so no entry point ever decides a parent
  on its own. Children also follow the parent's visibility: hiding or
  minimizing the chat shelves its snapped widgets with it, and they
  return when it does — intended, since a snapped stack reads as one
  surface (verify manually after windowing changes).
- **Resize re-flush:** AppKit children follow position, never size — a
  parent's `Resized` event re-flushes each snapped child against its
  nearest parent edge (`windows::reflush_snap_children`) so stacks never
  open a seam.

The snap graph is emergent geometry, never stored: flush-adjacency means an
edge gap `<= SNAP_FLUSH` with real perpendicular overlap. `layout.json`
stores plain positions only; boot restore moves every restored dock window
flush to its snap target, then applies the same plan
(`windows::reattach_flushed_windows`), so a window restored inside the snap
zone goes flush and attaches — no gutter hovering next to a neighbor — and
a saved stack tows again with no schema change. Windows parked further out
stay put and stay detached.

One deliberate exception unchanged: the moon orb (window `main`) and any
window being revealed by boot restore, expand-from-moon, or collapse-to-moon
is clamped back onto a currently visible display first
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
resize-drag API is not implemented on macOS. The active window's own frame
changes; its snapped children are re-flushed by the `Resized` arm so a stack
tracks a live resize instead of opening a seam.

## Tests

- `test/moon-native-titlebar.test.ts` prevents runtime traffic-light IPC from
  returning.
- `test/moon-dock.test.ts` verifies direct native dragging and guards against
  reintroducing JS-side snap/cluster machinery (snap lives on the native
  side only — the Moved-event watcher needs no arming IPC).
- `test/widget-window.test.ts` verifies widget pages do not load the old
  `deck-snap.js` engine.
- `windows::tests` cover the pure snap geometry: edge candidates, flush
  detection, cheapest-target choice, open-time cascade, resize re-flush,
  and the attachment planner (input-order independence, the chat-hub
  stranding case, two-neighbor tie-breaks, no-chat components).
