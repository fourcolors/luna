# Luna Dock — Window Drag / Resize / Magnet / Border System (extraction)

> **Historical (superseded 2026-07-10):** Moon retired the magnet, weld, and
> cluster-tow system these rules were extracted for. Panels are now independent
> native macOS windows with no snapping.
> See `apps/ui-moon-tauri/docs/window-drag-snap.md` for the active behavior.

**Status:** canonical extraction from the reference design.
**Source of truth:** `~/Downloads/Luna Dock (standalone).html` (modified 2026-06-15).
The HTML is a React + in-browser-Babel bundle; the relevant module decodes to
`luna-dock.jsx` (the dock controller) and an inline `<style>` block (the dock
CSS). Both are extracted, verbatim, to:

- JS: `.scratch/luna-dock/js/04_3aefd23a.jsx` (the `LunaDock` component — drag,
  resize, snap, weld, radius).
- CSS: `.scratch/dock-border-extract/dock.css` (604 lines — the `.dock-win` /
  `.dock-wash` / skin tokens).

This document captures **the rules**, not the implementation, so they can be
applied to any host (the single-DOM reference, or Moon's multi-OS-window dock).
Line citations are to the two extracted files above unless noted.

> **One-sentence model:** a flat list of rectangles; magnetism snaps a dragged
> rectangle's **corner** flush to a neighbour's corner; adjacency is recomputed
> from the rects every frame ("emergent welding"); a welded cluster moves as one;
> rendering is **crisp** — rounded outer corners, square interior-seam corners,
> one soft halo around the cluster silhouette, and **no edge filter**.

---

## 1. Coordinate model & window data

Every window is a plain record (`mod04` `initialWins`, :31):

```
{ id, type, x, y, w, h, z, min?, zoom?, closed?, entering? }
```

- `x, y, w, h` are logical pixels, top-left origin.
- There is **no stored group / weld graph**. Membership is derived from the
  rectangles on every render (§7). This is the single most important structural
  decision: delete-the-graph, recompute-from-geometry.
- `min` (collapsed to titlebar) and `zoom` (grown tall) mutate `h`/visible
  height but never change the record's identity.

**Visible height** (`vh`, :44): `min ? BAR_H : h`. All adjacency/snap math uses
*visible* height so a collapsed window still welds at its titlebar edge.

---

## 2. Constants (the magic numbers)

| Name | Value | Meaning | mod04 |
|---|---|---|---|
| `DOCK_W` | `336` | shared module width → seamless vertical welding | :8 |
| `SNAP` | `30` | magnet threshold (px); snap when corner within this 2-D distance | :9 |
| `TOUCH` | `4` | adjacency tolerance — edges within 4px count as "flush/welded" | :10 |
| `BAR_H` | `28` | titlebar height = collapsed visible height | :42 |
| overlap min | `> 8` | perpendicular overlap required to count as adjacent | :51, :65 |
| `IN` (weld probe) | `6` | inset from a corner when testing if a neighbour reaches it | :81 |
| `MINW` | `228` | min window width on resize | :217 |
| `MINH` | `96` | min window height on resize | :217 |
| `RS` | `14` | resize edge-alignment snap threshold (px) | :217 |
| `MOON` | `84` | collapsed-orb diameter | :302 |
| snap-clear delay | `220ms` | how long the accent "snapping" ring lingers after drop | :262 |
| `SKIN_RADIUS` | studio 13 / classic 4 / aqua 18 / kawaii 22 / puppy 20 | per-skin outer radius `R` | :43 |

**Lockstep rule:** `SNAP`, `TOUCH`, overlap-min, and `IN` are the contract. Any
port must use the *same* values or the feel diverges. (Moon today: `SNAP`→
`DEFAULT_THRESHOLD=30` ✅, overlap→`WELD_MIN_OVERLAP=8` ✅, `IN`→`WELD_IN=6` ✅,
but `TOUCH=4` is implemented as `WELD_EPS=2` ❌ — see the plan.)

---

## 3. The magnet system (`dockSnap`, mod04 :164-185)

While dragging a window `a`, against every other open window `b` (skipping the
dragged group), generate **8 corner-aligned candidate positions** for `a`'s
top-left:

```
// vertical docking (a sits below / above b), left- or right-aligned
(b.x,            b.y + bh)        // below, left edges aligned
(b.x + b.w - a.w, b.y + bh)       // below, right edges aligned
(b.x,            b.y - a.h)       // above, left edges aligned
(b.x + b.w - a.w, b.y - a.h)      // above, right edges aligned
// horizontal docking (a sits right / left of b), top- or bottom-aligned
(b.x + b.w,      b.y)             // right, top edges aligned
(b.x + b.w,      b.y + bh - a.h)  // right, bottom edges aligned
(b.x - a.w,      b.y)             // left, top edges aligned
(b.x - a.w,      b.y + bh - a.h)  // left, bottom edges aligned
```

Pick the candidate with the smallest 2-D distance `hypot(a.x - cx, a.y - cy)`
that is `<= SNAP`. (`bh` = neighbour's *visible* height.)

**Laws of the magnet:**
1. Snapping aligns a **corner to a corner** — windows dock edge-flush *and*
   share a corner, never half-overlapping.
2. The threshold is a **2-D radius** (`hypot`), not per-axis — you feel a circular
   pull toward each candidate corner.
3. The dragged window's own cluster is excluded from candidates (`skip`) so a
   cluster never snaps to itself.
4. Snap is evaluated **live, every `pointermove`** (§4), not on release.

---

## 4. Drag / move (`startDrag` + `onMove`, mod04 :188-257)

**Grouping — what travels with the grabbed window** (`dragGroupOf`, :140):
- **Anchor (chat)** → the entire transitively-welded cluster (`clusterOf`).
- **Module + Shift** → it plus every non-anchor module reachable below it.
- **Module (plain)** → just itself; it **peels cleanly** off the stack.

**On `pointerdown`:** snapshot `sx,sy` (cursor), each group member's origin
`{x,y}`, bring to front, attach window-level `pointermove`/`pointerup`.

**On `pointermove`** (move branch, :245-256):
1. `lead = { x: ox+dx, y: oy+dy, w, h: visible }` — where the grabbed window
   *wants* to be.
2. `snap = dockSnap(lead, group)`; target = snap ?? lead.
3. Final delta `fdx,fdy = target - origin`.
4. **Tow the whole group by the same delta** — every member is
   `origin + (fdx,fdy)`. Cluster moves 1:1, rigidly.
5. `setSnapId(snap ? id : null)` → toggles the accent "this will stick" ring.

**On `pointerup`:** clear drag; clear the snap ring after `220ms`.

**Laws of drag:**
1. The cluster is **rigid** during a drag — all members share one delta; no
   internal re-snap.
2. Snapping is **predictive and live** — the window jumps to the magnet target
   *while* dragging, with the ring showing intent before release.
3. Positional CSS transitions are **killed during a drag**
   (`[data-dragging="true"] .dock-win { transition: none }`, dock.css:292) so
   towed members track the cursor with zero lag.

---

## 5. Resize (`onMove` resize branch, mod04 :216-243; handles :459-463, :434-456)

**Handles** (CSS `.re-l/.re-r/.re-b` + corner `.dock-resize`):
- Left, right, bottom **edge strips** (8px thick, inset 3px outside the card) +
  a bottom-right **corner** grip. **No top resize** (the titlebar lives there).
- Corner grip `rb` resizes right **and** bottom together (`edge.includes('r')`,
  `…('b')`).

**Constraints:** `MINW=228`, `MINH=96`.

**Edge-alignment snapping while resizing** (`RS=14`):
- Build alignment lines from *every other* open window: `vlines` = each other
  window's `x` and `x+w`; `hlines` = each other's `y` and `y+vh`.
- `snapTo(value, lines)` snaps the moving edge to the nearest line within `RS`.
- Right edge → snap `ox+ow+dx` to `vlines`, `w = max(MINW, snapped - ox)`.
- Left edge → `right = ox+ow`; snap `ox+dx` to `vlines`; `w = max(MINW, right -
  snapped)`; `x = right - w`.
- Bottom edge → snap `oy+oh+dy` to `hlines`; `h = max(MINH, snapped - oy)`.
- Any snap lights the accent ring (`setSnapId`).
- Resizing clears `zoom` (`zoom:false`).

**Laws of resize:**
1. Resize edges **snap to neighbours' edges** (alignment lines), the
   complement of the move magnet (which snaps corners).
2. Resize is **single-window** — it never tows the cluster; only the dragged
   edge moves. (A welded neighbour simply re-welds or un-welds on the next frame
   from the new geometry.)
3. Top edge is reserved for the titlebar drag region — never a resize edge.

---

## 6. Welding — emergent adjacency (`welded`, `weldEdges`, mod04 :49-73)

Two windows are **welded** (`welded(a,b)`, :49) when an edge pair is flush
within `TOUCH` **and** they overlap on the perpendicular axis by `> 8`px, using
*visible* heights:

```
hOverlap = min(a.x+a.w, b.x+b.w) - max(a.x, b.x) > 8
vOverlap = min(a.y+ah,  b.y+bh)  - max(a.y, b.y) > 8
vFlush   = |a.y+ah - b.y| <= TOUCH  ||  |b.y+bh - a.y| <= TOUCH
hFlush   = |a.x+a.w - b.x| <= TOUCH ||  |b.x+b.w - a.x| <= TOUCH
welded   = (hOverlap && vFlush) || (vOverlap && hFlush)
```

**Clusters** are connected components over `welded` (`reachable`, :149) —
recomputed on demand, never stored.

`weldEdges(a, list)` (:59) returns which of `a`'s four edges `{t,b,l,r}` are
flush against a welded neighbour. This drives the `data-weld` attribute and the
per-seam border/shadow rules (§9).

**Laws of welding:**
1. Welding is **emergent** — derived from rects each render, with **no stored
   graph, no IPC bookkeeping**. Move a window away and it un-welds automatically
   next frame.
2. A weld needs **flush + meaningful overlap** (`>8`), so two windows merely
   sharing a corner point (zero overlap) do **not** weld.

---

## 7. The radius system — outer round, inner square (`weldRadius`, mod04 :74-110)

This is the visual heart of the system and the part most worth getting exactly
right. **Per-corner**, not per-edge:

> "ALL outer corners stay rounded. A corner only goes square when it sits at an
> interior seam — i.e. a welded neighbour is flush against one of its edges AND
> actually reaches that specific corner point." (mod04 :74-78)

Algorithm (`weldRadius(a, list, R)`):
1. Probe each corner **`IN=6`px inside** the card: `xL=a.x+6`, `xR=a.x+a.w-6`,
   `yT=a.y+6`, `yB=a.y+ah-6`.
2. For every neighbour `o`, if an edge of `o` is flush to an edge of `a`
   (within `TOUCH`), check whether `o` **covers** the probe point on the shared
   edge (`coversX`/`coversY`, with a `TOUCH` slop). If so, that corner is at an
   interior seam → mark it **square**.
   - neighbour **above** (`o.y+oh ≈ a.y`): squares `tl`/`tr` if it covers `xL`/`xR`.
   - neighbour **below** (`a.y+ah ≈ o.y`): squares `bl`/`br`.
   - neighbour **left** (`o.x+o.w ≈ a.x`): squares `tl`/`bl`.
   - neighbour **right** (`a.x+a.w ≈ o.x`): squares `tr`/`br`.
3. Emit a `border-radius` shorthand string `"TL TR BR BL"` where each value is
   `0` (square) or `R` (round).

**Probing per-corner (not per-edge) is the subtle correctness win:** a narrower
neighbour that welds along only *part* of an edge squares **only** the corners it
actually reaches; the exposed corners of the wider window stay rounded.

**Titlebar must mirror it** (mod04 :505, dock.css :332-334): the titlebar carries
its own `border-radius: R R 0 0`; its **top** corners are squared in lockstep
with the shell's `tl`/`tr` (`borderTopLeftRadius`/`borderTopRightRadius`),
otherwise a rounded titlebar cap pokes out above a flush seam.

**The wash layer inherits the radius** (dock.css :299): `.dock-wash` has
`border-radius: inherit`, so the per-corner squaring flows to the painted fill
automatically.

**Laws of radius:**
1. Outer (free) corners are always `R`; interior-seam corners are always `0`.
2. A corner squares **only if a neighbour reaches that exact corner** — partial
   welds keep exposed corners round.
3. Three surfaces must agree on each corner: the **shell** (clip), the **wash**
   (`inherit`), and the **titlebar top** (explicit mirror).
4. Squaring is eased with `transition: border-radius 0.2s` and recomputed on
   **settle**, not per drag-frame, so corners don't strobe mid-drag.

---

## 8. The border / edge rendering — **no wobble filter** (dock.css :278-344)

The reference window edge is **crisp**. The "watercolor / hand-painted" feel
comes from soft fills and shadows, **never** an SVG displacement filter on the
window outline. Search the dock CSS: **zero `filter: url(#wc-wobble)` on
`.dock-win`/`.dock-wash`.** (The 12 `wc-wobble` uses elsewhere in the file are on
*decorative app internals* — blooms, orbs, chat bubbles — not window edges.)

**Two-layer structure:**

```
.dock-win        // positioned shell. Owns border-radius (per-corner) + transitions.
  └ .dock-wash   // position:absolute; inset:0; border-radius:inherit.
                 //   Owns the PAPER FILL (tint-bleed gradient + paper),
                 //   the border (--dk-win-border), and the soft halo (box-shadow).
  └ .dock-bar    // titlebar; top corners mirror the shell.
  └ .dock-body   // content.
```

- **Fill** (`.dock-wash`, :295-309): a head-tint gradient
  (`color-mix(tint, --dk-tint-amt) → transparent` over `--dk-tint-bleed`) over
  `--dk-win-paper`, plus `--dk-win-border`, `--dk-win-shadow`, and
  `backdrop-filter: blur(var(--dk-blur))` (a no-op at studio's `0px`; the frost
  for aqua's `16px`).
- **Halo** = `box-shadow` on the **wash**, soft and warm, never pure black.
  Dark theme deepens it via `[data-theme="dark"] .dock-wash` overrides (:538-539).

**Per-seam rendering (so a welded cluster reads as ONE card):**
- Only **two** drop rules exist: `[data-weld~="t"] .dock-wash { border-top: 0 }`
  and `[data-weld~="l"] .dock-wash { border-left: 0 }` (:320-321). There is
  deliberately **no** `border-right:0` / `border-bottom:0`. That asymmetry is the
  mechanism: at a vertical seam the lower window drops its top border while the
  upper keeps its bottom → exactly **one** divider survives (the upper's bottom /
  the left's right); a doubled hairline is impossible.
- `[data-weld~="b"] .dock-wash { box-shadow: --dk-win-shadow-flat }` (:323) —
  a window welded on its bottom must not cast its drop-"lip" shadow onto the
  window below, so the seam reads flat, not raised. The anchor has its own
  variant: `.dock-win.anchor[data-weld~="b"] .dock-wash { box-shadow:
  --dk-win-shadow-anchor-flat }` (:324).

**Cluster silhouette shadow (studio skin, mod04 :472-482 + dock.css :28-37):**
- Instead of each window casting its own box-shadow, the JS assembles
  `box-shadow` from per-edge directional pieces (`--dk-edge-t/-b/-l/-r`) emitting
  **only the edges that are NOT welded**. There is deliberately no symmetric
  ambient piece (a spread-0 ambient radiates on all four sides and would lip onto
  welded seams). The result: a stuck cluster is shadowed around its **combined
  outer silhouette** and perfectly flat at every interior seam — it looks like one
  object, not a pile. A fully-interior member (0 free sides) casts `none`.
- This inline shadow overrides the per-panel rules. Skins without `--dk-edge-*`
  fall back to the flat-seam rules above.

**Drag/snap affordances:**
- `.dock-win.dragging .dock-wash` (:335-339): a deeper lift shadow.
- `.dock-win.snapping .dock-wash` (:340-344): accent ring + lift — the
  predictive "this will stick" cue.

**Laws of border rendering:**
1. **No displacement filter on the window outline.** Crisp `border-radius`. The
   paper character is fills + shadows + background blooms only.
2. Exactly **one** divider per interior seam; never a doubled border.
3. A welded cluster casts **one silhouette shadow**, flat at interior seams.
4. The halo's reach must stay within whatever margin the host gives the card, or
   it shears at the card/window bounds.

---

## 9. Skins (dock.css :5-250)

A "skin" is just a bundle of `--dk-*` tokens on `.dock-root[data-skin=…]`. The
only ones relevant to the border/radius system:

| skin | `--dk-radius` | edge character | wobble? |
|---|---|---|---|
| studio (default) | `13px` | soft warm halo + cluster silhouette shadow; transparent border | **none** |
| classic | `4px` | crisp 1px hairline border, solid tinted bars, no tint bleed | **none** |
| aqua | `18px` | frosted (`--dk-blur:16px`), translucent paper, white 1px ring | **none** |
| kawaii / puppy | 22 / 20 | candy / pup shape demos (out of scope for Moon) | **none** |

No skin uses an edge displacement filter. Classic is the crisp-hairline extreme;
studio/aqua get softness from blur and shadow, not from roughening the outline.

---

## 10. Window ops (brief — already shipped in Moon)

- **Close** (`closeWin`): non-anchor only; anchor is permanent.
- **Minimize** (`toggleMin`, :273): collapse a module to its titlebar; windows
  welded **below** reflow up like an accordion (`transition: top/height 0.26s`).
- **Zoom** (`toggleZoom`, :290): grow to a comfortable tall height; click to
  restore.
- **Moon** (`collapseToMoon`/`wakeFromMoon`, :303-336): the anchor + its whole
  welded cluster collapse into a draggable orb that restores the exact
  arrangement. (Moon already ships this — PR #163.)

---

## 11. The rules, condensed (the "laws")

1. **Geometry is the only source of truth.** No stored groups/welds/IPC; derive
   clusters from rects every frame.
2. **Magnet = corner-to-corner, 2-D radius `SNAP=30`, live every pointermove.**
3. **A cluster is rigid while dragged** (one shared delta); resize is
   single-window and snaps **edges** to neighbour alignment lines (`RS=14`).
4. **Welding needs flush (`TOUCH`) + overlap (`>8`).**
5. **Radius is per-corner:** outer corners `R`, interior-seam corners `0`, squared
   only where a neighbour actually reaches that corner (`IN=6` probe). Shell,
   wash (`inherit`), and titlebar top must agree.
6. **The window outline is crisp — no edge filter.** Paper feel = fills +
   shadows + background, not displacement.
7. **A welded cluster renders as one object:** one divider per seam, flat seam
   shadow, one silhouette shadow around the outer edges.
8. **Kill positional transitions during a drag; ease radius squaring on settle.**

---

## Appendix — extraction provenance

- Decode recipe: the bundle stores modules gzip+base64 in a `__bundler/manifest`
  block; the dock CSS is an escaped `<style>` string (`\n`/`\"`/`/`). See
  `.scratch/dock-border-extract/extract3.py` (CSS) and the pre-decoded
  `.scratch/luna-dock/js/*.jsx` (JS).
- These rules are consumed by `docs/luna-dock-moon-alignment-plan.md`
  (gap analysis + plan to apply them to the Moon multi-window dock).
