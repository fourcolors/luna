# Moon window drag, snap, and resize

This documents how Moon's panel windows drag, magnet-snap, resize, and weld, and the design rules that keep it correct.
It reflects the system after the drag/snap/resize overhaul.

## Model

Every panel is its own native macOS `NSWindow` (one window per card), created borderless and transparent.
The visible "card" sits inside a transparent margin so the watercolor halo can bleed past the card edge.
That margin is the `--card-inset` (22px on left/right/bottom, 4px on top so the header meets the native traffic lights).

All snap geometry runs in **card-face space**: window frames are inset by `--card-inset` (`insetRect` in `deck-snap.js`) so windows align by what the user SEES, not by the larger OS frame.
The magnet, the no-overlap pass, and weld detection all operate on card rects.

## Dragging is native + snap-on-release

Every drag goes through the OS via `W.startDragging()` (`startNativeDrag` in `moon-dock.js`).
The OS owns the position during the drag, so the window tracks the cursor 1:1 with zero per-frame IPC, and the snap happens ONCE on release.

There used to be a second, "emulated" path for the chat window towing a welded cluster: it wrote `setPosition` every frame and ran a live magnet.
That live magnet LOCKED the window at the snap point and held it (hysteresis), which read as an "invisible wall" the user had to push past during a slow drag.
A stale `groupMembers` could even route a lone window onto that path.
So the emulated path is now only a non-Tauri / test fallback (when `startDragging` is unavailable); in the real app every drag is native and cannot wall.

Trade-off: a welded cluster no longer tows as one unit DURING the drag.
Dragging the anchor moves just the anchor and re-docks on release.
A "re-tow welded children on release" affordance is a possible follow-up if towing-as-one is wanted back.

### Reliable release detection

The OS swallows the webview's pointer events during a `startDragging` gesture, so "you let go" cannot be detected from the DOM, and a motion-stopped timer fires prematurely when you pause to aim.
`watch_drag_release` (Rust, `main.rs`) installs a local + global `NSEvent` `LeftMouseUp` monitor and emits `luna-drag-released` on the REAL button release.
`startNativeDrag` finishes (and snaps) on that event, with a `pointerup` fallback and a long safety timeout.

### Drag-in redock overrides the snap (thread-drawer floaters)

A thread-drawer row dragged OUT spawns a chat window pinned to that thread (`chat.html?thread=<id>&redockTo=<owner-label>`), mirroring the `+` button.
Dragging that floater back over its owner folds the thread back in instead of leaving a second window, so `LunaDock.wire` takes an optional `redock` config for exactly these floaters (`{ threadId, ownerLabel, getDraft }`); it is null for every ordinary window.
When present, the release handler invokes the Rust `redock_thread` command BEFORE it would snap: if the command redocked, there is nothing to snap; if it declined (returned `false`) or the probe threw, the release falls through to the normal `snapOnRelease`.
`redock_thread` (Rust, `main.rs`) trusts only the INVOKING window's label as the caller (never a page-supplied label, same discipline as `begin_cluster_drag`), refuses to redock a window into itself, and only closes a closable widget-family window.
It computes the floater's center in global physical coordinates and runs a scale-independent `center_in_rect` test against the owner's LEFT drawer strip (~320 logical px, the drawer width plus card inset, clamped to the window width) rather than the whole owner window, so an accidental drop anywhere over the owner does not trigger it.
On a hit it emits `redock-thread` (carrying the thread id and the floater's unsent composer draft) to the owner and closes the floater, returning `true`; the owner re-adopts the thread in place and carries the draft only when its own composer is empty.
A floater closed by its own X (not a redock) instead emits `floater-closed` so the owner un-greys that thread's drawer row.

## The magnet (`computeEdgeSnap`)

On release, `snapOnRelease` runs `LunaDeckSnap.computeEdgeSnap` over the candidate cards:

- It is **edge-proximity** based: a window edge within `EDGE_SNAP_THRESHOLD` (30px) of a neighbour edge, with perpendicular overlap, snaps flush to that edge.
  The threshold is kept TIGHT on purpose: it is the "magnet zone", so a large value reads as an invisible layer that engages well before the edges meet.
- The perpendicular axis snaps flush only when within `CORNER_ALIGN_THRESHOLD` (26px) of a corner; otherwise it preserves the offset you chose.
- The touching seam is positioned **pixel-exact** by `physicalSnapEdge`: the dragged window's physical frame is anchored to the neighbour's ACTUAL physical frame so the two card edges land on the SAME physical pixel.
  This closed the original "transparent strip at the seam" bug, where each window rounded logical to physical independently and the edges drifted a pixel apart.

The magnet snaps to the VISIBLE card edge, never the padded OS-frame edge (everything is computed in card-face space).

## The hard no-overlap guarantee (`resolveOverlap`)

The edge magnet only clears the ONE neighbour it docks against.
`resolveOverlap` is a separate pass that pushes the snapped window clear of EVERY other panel so a released window can never end up layered on a second window or a just-peeled card.
It is independent of the magnet threshold, so the threshold can be tight without reintroducing overlap.

`resolveOverlap` is **bounds-aware**: it clamps the start position into the monitor work area and prefers the shortest push that keeps the window on-screen, so resolving an overlap never shoves the window off-screen (where the OS would clamp it back and re-introduce the overlap).

## Candidate filtering (`candidateRects`)

A window magnets to other PANELS only:

- The moon hub / orb is excluded.
  It is small and always somewhere on screen, so magneting to it read as an invisible wall, and a lone window jumped flush to it on release.
- Hidden and minimized windows are excluded (an unseen window must not be a magnet target).
- A panel with less than ~15% of its visible card on the monitor is excluded.
  A substantially-visible panel stays dockable (you snap to its visible edge).
- In `snapOnRelease`, a snap TARGET that would land the card off-screen is discarded.
  So docking to a partly-off-screen panel's VISIBLE edge is flush and on-screen, while docking to its off-screen edge is declined rather than clamped into a large gap.

## Resize is native-speed via objc2

`startResizeDragging` / tao `drag_resize_window` is an unimplemented no-op on macOS, so resize cannot use the native edge handles on a borderless window.
`begin_native_resize` (Rust, `main.rs`) drives `NSWindow.setFrame:` directly from an event-driven `NSEvent` monitor (local `LeftMouseDragged` for the move, local + global `LeftMouseUp` to end).
All math is in Cocoa screen coordinates, so there is no logical/physical/flip conversion.
This is event-driven, not a polling pacer and not a modal `nextEventMatchingMask` loop (which would freeze the WKWebView), so it tracks the cursor at native speed without starving the webview.

On its `NSEvent`-monitor teardown `begin_native_resize` emits `luna-resize-ended` to the resizing window (mirroring `luna-drag-released` for drags).
`moon-resize.js` resets its state on that event, so the resize always tears down even when the button is released OUTSIDE the window (where the webview sees no `pointerup`); a `pointerup`/`blur` listener is the in-window fallback.

During a native resize, `moon-native-titlebar.js` suppresses the per-frame traffic-light position sync (it re-syncs once on release, gated on the `__LUNA_NATIVE_RESIZING__` flag) so that IPC does not contend with the resize on the main thread.

## Weld visuals

When cards land flush they "weld": `applyWeldVisuals` squares the seam corners, suppresses the halo on welded sides, and shows one perimeter outline on free sides.
While dragging, `#outline` is hidden (`.widget-shell.dragging #outline { opacity: 0 }`) because its weld-accent class is frozen from the last settled state and otherwise paints a faint hairline on the card edge throughout the drag.

### The weld must settle deterministically (the seam-band race)

The weld is recomputed from the live rects of every sibling, read over IPC (`weldMembers` → `paintWeldFrom`).
Those reads are async, and every window broadcasts `dock-geometry-changed` on settle, so a single dock fires a STORM of weld refreshes at each window — each reading geometry that may still be mid-transit (the OS applies `setPosition` slightly after the event fires).
The old `refreshWeld` did `if (refreshing) return`, which DROPPED the trailing refresh — the one that would read the FINAL flush geometry — so a card could stay stuck on a stale `grouped=false`, never suppressing its seam-side halo.
That left the full soft halo at the join: the visible **seam band**.
Because it was a race, it resolved differently under the dev server's timing than under a bundled release (it read as "the seam looks welded in dev but bordered in the release build").

The fix, in `moon-dock.js`:

- `refreshWeld` is immediate + **coalescing** (never drops a trailing call: if one lands mid-flight it re-runs after, so the latest geometry always wins). It stays awaitable, which boot and the jsdom tests rely on.
- `scheduleWeld` is a **trailing debounce** (~80ms) used by the event-storm sources (`dock-geometry-changed`, `dock-link`, `onResized`). After the immediate repaint it re-reads once the storm goes quiet, so the final weld is computed from SETTLED (flush) positions. The weld is a settle-time visual (never painted per drag-frame), so the delay is imperceptible.

### Known follow-up

A welded cluster is still N separate transparent `NSWindow`s abutting, so a ~1px hairline can remain at the exact join even when the weld is correct (corners squared, seam halos suppressed) — it is the two-window boundary, not the halo-suppression race above, and it is present identically in dev and release.
Closing it fully is delicate border-system work (e.g. bridging the welded card's fill across the seam) and must respect the `no-window-outline` invariant (`docs/no-window-outline.md`, enforced by `test/no-window-outline.test.ts`).

## Tests

Pure geometry is unit-tested and must stay green:

- `test/edge-snap.test.ts` — `computeEdgeSnap` (edge-flush, corner-align, free offset, anti-overlap, threshold boundary, nearest-of-many).
- `test/physical-snap.test.ts` — `physicalSnapEdge` (touching seam pixel-exact across scale factors; perpendicular offset preserved).
- `test/resolve-overlap.test.ts` — `resolveOverlap` (clears overlap with one and many neighbours; bounds-aware, never off-screen).
- `test/deck-snap.test.ts`, `test/deck-weld.test.ts` — existing snap + weld geometry.
- `src-tauri/src/main.rs` `redock_geometry_tests` - `center_in_rect` (the drag-in redock hit-test: inside, inclusive edges, and just-outside).

The live behaviours (the actual wall, the off-screen gap, the welded seam) were verified by driving the REAL app: a local harness opened real panels, fired the real snap path, and pixel-measured the result.
That harness is intentionally not committed.
