/**
 * deck-snap.js — the WinAmp-style magnetic snap math for the Moon Deck
 * (PRD Part C / W2). Pure, framework-free, side-effect-free so it can be
 * unit-tested in isolation and shared by the widget window + (later) the
 * window manager.
 *
 * Ported 1:1 from the Luna Dock design file's `dockSnap` (luna-dock.jsx): a
 * dragged window clicks into one of 8 fully-specified tile positions flush at a
 * SHARED CORNER of the anchor — BOTH axes pinned — chosen by nearest 2D
 * distance from where it's dropped, within a magnet threshold. This
 * corner-aligns docked windows into a clean stack/grid (Winamp main + EQ +
 * playlist) instead of merely flushing the contact edge and leaving the
 * perpendicular axis wherever the window happened to be released (which
 * produced offset, ragged welds).
 *
 * Exposes `globalThis.LunaDeckSnap.computeSnap`. All rects are
 * `{ x, y, w, h }` in the SAME coordinate space (screen px). Returns the
 * snapped top-left `{ x, y, edge }` (edge ∈ 'l'|'r'|'t'|'b', the side of the
 * anchor the widget lands on) or null when no corner-aligned tile is within
 * threshold.
 */
;(function (g) {
  "use strict"

  var DEFAULT_THRESHOLD = 30 // px — matches the Luna Dock design file's SNAP=30
  var ZERO_INSETS = { l: 0, r: 0, t: 0, b: 0 }

  // Inset an OS-frame rect by the card insets → the VISIBLE CARD rect. All magnet
  // geometry (snap + weld detection) runs in this card-face space so windows
  // align by what the user SEES, not by the larger transparent OS frame. The
  // card sits `--card-inset` inside the frame on l/r/b and `--card-inset-top` on
  // top; passing ZERO_INSETS makes this the identity (raw frame space).
  function insetRect(rect, ins) {
    var i = ins || ZERO_INSETS
    return { x: rect.x + i.l, y: rect.y + i.t, w: rect.w - i.l - i.r, h: rect.h - i.t - i.b }
  }

  function computeSnap(anchor, widget, threshold) {
    if (!anchor || !widget) return null
    var t = typeof threshold === "number" ? threshold : DEFAULT_THRESHOLD
    var ax = anchor.x,
      ay = anchor.y,
      aw = anchor.w,
      ah = anchor.h
    var ww = widget.w,
      wh = widget.h

    // 8 corner-aligned candidate positions. `edge` = which side of the anchor
    // the widget lands on (drives the seam / dock-link side). Order + geometry
    // match the design's dockSnap candidate list exactly.
    var cands = [
      { edge: "b", x: ax, y: ay + ah }, //            below · left-aligned
      { edge: "b", x: ax + aw - ww, y: ay + ah }, //  below · right-aligned
      { edge: "t", x: ax, y: ay - wh }, //            above · left-aligned
      { edge: "t", x: ax + aw - ww, y: ay - wh }, //  above · right-aligned
      { edge: "r", x: ax + aw, y: ay }, //            right · top-aligned
      { edge: "r", x: ax + aw, y: ay + ah - wh }, //  right · bottom-aligned
      { edge: "l", x: ax - ww, y: ay }, //            left  · top-aligned
      { edge: "l", x: ax - ww, y: ay + ah - wh }, //  left  · bottom-aligned
    ]

    var best = null
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i]
      var d = Math.hypot(widget.x - c.x, widget.y - c.y)
      if (d <= t && (best === null || d < best.d)) {
        best = { x: c.x, y: c.y, edge: c.edge, d: d }
      }
    }
    if (!best) return null
    return { x: Math.round(best.x), y: Math.round(best.y), edge: best.edge }
  }

  // ── Forgiving edge-snapping (the new lone-window magnet) ───────────────────
  // computeEdgeSnap — replaces the corner-only computeSnap for lone-window
  // drags. Instead of 8 fully-pinned corner tiles caught only within a tiny
  // zone, it docks the dragged window FLUSH against whichever NEIGHBOUR edge it
  // is near (forgiving threshold), preserving the user's perpendicular offset
  // unless they're near a corner (then it corner-aligns), and ALWAYS resolving a
  // drop that overlaps a neighbour on both axes to a flush-adjacent position
  // (anti-layer). All rects are CARD rects {x,y,w,h} in the SAME logical space.
  //   lead       = the dragged window's CARD rect {x,y,w,h}
  //   candidates = [{label, rect:{x,y,w,h}}] neighbour CARD rects
  //   opts       = { threshold, cornerThreshold, minOverlap }
  // Returns { x, y, edge, label } = the snapped lead CARD top-left (logical) +
  // which side of the NEIGHBOUR the lead lands on (edge ∈ 'l'|'r'|'t'|'b'), or
  // null when nothing is in range.
  var EDGE_SNAP_DEFAULTS = { threshold: 80, cornerThreshold: 40, minOverlap: 8 }
  function computeEdgeSnap(lead, candidates, opts) {
    if (!lead) return null
    var o = opts || {}
    var threshold = typeof o.threshold === "number" ? o.threshold : EDGE_SNAP_DEFAULTS.threshold
    var cornerThreshold = typeof o.cornerThreshold === "number" ? o.cornerThreshold : EDGE_SNAP_DEFAULTS.cornerThreshold
    var minOverlap = typeof o.minOverlap === "number" ? o.minOverlap : EDGE_SNAP_DEFAULTS.minOverlap
    var cands = candidates || []
    var lL = lead.x, lR = lead.x + lead.w, lT = lead.y, lB = lead.y + lead.h
    var best = null
    // Consider a candidate direction; record it if it's the new global minimum
    // movement (tie-break by smaller label for determinism).
    function consider(snappedX, snappedY, edge, label) {
      var dist = Math.hypot(snappedX - lead.x, snappedY - lead.y)
      if (
        best === null ||
        dist < best.dist ||
        (dist === best.dist && String(label) < String(best.label))
      ) {
        best = { x: snappedX, y: snappedY, edge: edge, label: label, dist: dist }
      }
    }
    for (var i = 0; i < cands.length; i++) {
      var n = cands[i].rect
      var label = cands[i].label
      var nL = n.x, nR = n.x + n.w, nT = n.y, nB = n.y + n.h
      // Perpendicular overlap lengths (how much they sit beside each other).
      var vOverlap = Math.min(lB, nB) - Math.max(lT, nT)
      var hOverlap = Math.min(lR, nR) - Math.max(lL, nL)
      var overlapBoth = vOverlap > 0 && hOverlap > 0 // currently layered → must resolve

      // Perpendicular Y placement for a horizontal dock: corner-align tops/
      // bottoms when near, else preserve the user's free offset.
      var snappedYForH = lead.y
      if (Math.abs(lead.y - n.y) <= cornerThreshold) snappedYForH = n.y
      else if (Math.abs(lB - nB) <= cornerThreshold) snappedYForH = nB - lead.h
      // Perpendicular X placement for a vertical dock.
      var snappedXForV = lead.x
      if (Math.abs(lead.x - n.x) <= cornerThreshold) snappedXForV = n.x
      else if (Math.abs(lR - nR) <= cornerThreshold) snappedXForV = nR - lead.w

      // Horizontal docking (they're genuinely beside each other vertically).
      if (vOverlap > minOverlap || overlapBoth) {
        // lead RIGHT-of-n: lead.left ↔ n.right
        var rTouchX = nR
        var rGap = lead.x - rTouchX
        if (Math.abs(rGap) <= threshold || overlapBoth) consider(rTouchX, snappedYForH, "r", label)
        // lead LEFT-of-n: lead.right ↔ n.left
        var lTouchX = nL - lead.w
        var lGap = lR - nL
        if (Math.abs(lGap) <= threshold || overlapBoth) consider(lTouchX, snappedYForH, "l", label)
      }
      // Vertical docking (beside each other horizontally).
      if (hOverlap > minOverlap || overlapBoth) {
        // lead BELOW-n: lead.top ↔ n.bottom
        var bTouchY = nB
        var bGap = lead.y - bTouchY
        if (Math.abs(bGap) <= threshold || overlapBoth) consider(snappedXForV, bTouchY, "b", label)
        // lead ABOVE-n: lead.bottom ↔ n.top
        var tTouchY = nT - lead.h
        var tGap = lB - nT
        if (Math.abs(tGap) <= threshold || overlapBoth) consider(snappedXForV, tTouchY, "t", label)
      }
    }
    if (!best) return null
    return { x: best.x, y: best.y, edge: best.edge, label: best.label }
  }

  // computeLiveDrag — the LIVE drag step, ported 1:1 from the design's onMove
  // (luna-dock.jsx): apply the magnetic snap to the dragged window's LEAD
  // position, then translate the WHOLE drag group by that same delta so the
  // cluster moves as one (1:1). Pure — the caller performs the per-window
  // setPosition each pointermove frame.
  //   drag = { ox,oy,ow,oh, dx,dy, members:[{label,ox,oy}] }
  //     ox..oh = the dragged window's ORIGIN rect (captured at drag start)
  //     dx,dy  = cursor delta since drag start
  //     members = every window that travels with this drag (incl. itself),
  //               each with its OWN origin — anchor drag = whole cluster,
  //               plain module drag = just itself.
  //   candidates = [{label, rect:{x,y,w,h}}] — windows NOT in the drag group.
  // Returns { targets:[{label,x,y}], snapped, anchor, edge }.
  function computeLiveDrag(drag, candidates, threshold, insets) {
    var ins = insets || ZERO_INSETS
    // Snap in CARD-FACE space: inset the lead + every candidate so faces (not OS
    // frames) align flush. The snap DELTA is identical in card- and frame-space
    // (card = frame + constant inset), so we apply it straight to frame origins.
    var leadFrame = { x: drag.ox + drag.dx, y: drag.oy + drag.dy, w: drag.ow, h: drag.oh }
    var lead = insetRect(leadFrame, ins)
    var best = null
    var cands = candidates || []
    for (var i = 0; i < cands.length; i++) {
      var s = computeSnap(insetRect(cands[i].rect, ins), lead, threshold)
      if (!s) continue
      var d = Math.hypot(s.x - lead.x, s.y - lead.y)
      if (best === null || d < best.d) {
        best = { x: s.x, y: s.y, edge: s.edge, label: cands[i].label, d: d }
      }
    }
    // best.x/y are the lead CARD top-left; convert back to a FRAME top-left
    // (subtract the lead's own top/left inset) before deriving the group delta.
    var tx = best ? best.x - ins.l : leadFrame.x
    var ty = best ? best.y - ins.t : leadFrame.y
    var fdx = tx - drag.ox
    var fdy = ty - drag.oy
    var members = drag.members || []
    var targets = []
    for (var j = 0; j < members.length; j++) {
      targets.push({ label: members[j].label, x: members[j].ox + fdx, y: members[j].oy + fdy })
    }
    return { targets: targets, snapped: !!best, anchor: best ? best.label : null, edge: best ? best.edge : null }
  }

  // ── Emergent welding geometry ──────────────────────────────────────────
  // Ported from the Rust dock graph (main.rs dock_rects_touch /
  // dock_components / dock_outline_sides / dock_weld_corners) with the SAME
  // constants, proven byte-identical against Rust's own unit-test fixtures.
  // With these, every welding fact a window needs — cluster membership, the
  // perimeter (free) sides, and the corners to square at an interior seam — is
  // derivable CLIENT-SIDE from sibling rects, so there is no central group graph
  // and no dock-group IPC to keep in sync. Pure; all rects are { x, y, w, h } in
  // logical px and members are [{ label, rect }].
  var WELD_EPS = 2 // flush tolerance (matches Rust EPS)
  var WELD_MIN_OVERLAP = 8 // perpendicular overlap that counts as adjacency
  var WELD_IN = 6 // probe inset from a corner along each meeting edge

  // Two rects are welded when an edge is flush (≤EPS) AND they overlap on the
  // perpendicular axis (≥MIN_OVERLAP).
  function rectsTouch(a, b) {
    var al = a.x, at = a.y, ar = a.x + a.w, ab = a.y + a.h
    var bl = b.x, bt = b.y, br = b.x + b.w, bb = b.y + b.h
    var vOverlap = Math.min(ab, bb) - Math.max(at, bt) >= WELD_MIN_OVERLAP
    var hOverlap = Math.min(ar, br) - Math.max(al, bl) >= WELD_MIN_OVERLAP
    return (
      (vOverlap && (Math.abs(al - br) <= WELD_EPS || Math.abs(ar - bl) <= WELD_EPS)) ||
      (hOverlap && (Math.abs(at - bb) <= WELD_EPS || Math.abs(ab - bt) <= WELD_EPS))
    )
  }

  // Flood-fill connected components over rectsTouch → array of label arrays.
  function weldComponents(members) {
    var n = members.length
    var seen = new Array(n)
    var out = []
    for (var s = 0; s < n; s++) {
      if (seen[s]) continue
      var comp = []
      var stack = [s]
      seen[s] = true
      while (stack.length) {
        var i = stack.pop()
        comp.push(members[i].label)
        for (var j = 0; j < n; j++) {
          if (!seen[j] && rectsTouch(members[i].rect, members[j].rect)) {
            seen[j] = true
            stack.push(j)
          }
        }
      }
      out.push(comp)
    }
    return out
  }

  // Every label transitively welded to `label` (its cluster), including itself.
  function weldClusterOf(label, members) {
    var comps = weldComponents(members)
    for (var i = 0; i < comps.length; i++) {
      if (comps[i].indexOf(label) !== -1) return comps[i]
    }
    return [label]
  }

  // The FREE (non-touching) sides of each member — drives the perimeter
  // silhouette. Push order l,r,t,b. Returns { [label]: Array<'l'|'r'|'t'|'b'> }.
  function weldOutlineSides(members) {
    var out = {}
    for (var i = 0; i < members.length; i++) {
      var a = members[i].rect
      var l = a.x, t = a.y, r = a.x + a.w, b = a.y + a.h
      var touched = { l: false, r: false, t: false, b: false }
      for (var j = 0; j < members.length; j++) {
        if (j === i) continue
        var o = members[j].rect
        var ol = o.x, ot = o.y, or_ = o.x + o.w, ob = o.y + o.h
        var vOverlap = Math.min(b, ob) - Math.max(t, ot) >= WELD_MIN_OVERLAP
        var hOverlap = Math.min(r, or_) - Math.max(l, ol) >= WELD_MIN_OVERLAP
        if (vOverlap && Math.abs(l - or_) <= WELD_EPS) touched.l = true
        if (vOverlap && Math.abs(r - ol) <= WELD_EPS) touched.r = true
        if (hOverlap && Math.abs(t - ob) <= WELD_EPS) touched.t = true
        if (hOverlap && Math.abs(b - ot) <= WELD_EPS) touched.b = true
      }
      var sides = []
      if (!touched.l) sides.push("l")
      if (!touched.r) sides.push("r")
      if (!touched.t) sides.push("t")
      if (!touched.b) sides.push("b")
      out[members[i].label] = sides
    }
    return out
  }

  // Which CORNERS of each member sit at an interior weld seam (square them). A
  // corner squares only when a flush neighbour REACHES it (probed WELD_IN px in),
  // so a partial-width weld keeps its still-exposed corners round. The hub label
  // (default "main") is alignment-only and never welds. Push order tl,tr,br,bl.
  // Returns { [label]: Array<'tl'|'tr'|'br'|'bl'> }.
  function weldCorners(members, hubLabel) {
    var hub = hubLabel || "main"
    var out = {}
    for (var i = 0; i < members.length; i++) {
      var a = members[i].rect
      var l = a.x, t = a.y, r = a.x + a.w, b = a.y + a.h
      var tl = false, tr = false, br = false, bl = false
      var pyT = t + WELD_IN, pyB = b - WELD_IN, pxL = l + WELD_IN, pxR = r - WELD_IN
      for (var j = 0; j < members.length; j++) {
        if (j === i || members[j].label === hub) continue
        var o = members[j].rect
        var ol = o.x, ot = o.y, or_ = o.x + o.w, ob = o.y + o.h
        var flushLeft = Math.abs(l - or_) <= WELD_EPS
        var flushRight = Math.abs(r - ol) <= WELD_EPS
        var flushTop = Math.abs(t - ob) <= WELD_EPS
        var flushBottom = Math.abs(b - ot) <= WELD_EPS
        var covYpyT = ot - WELD_EPS <= pyT && pyT <= ob + WELD_EPS
        var covYpyB = ot - WELD_EPS <= pyB && pyB <= ob + WELD_EPS
        var covXpxL = ol - WELD_EPS <= pxL && pxL <= or_ + WELD_EPS
        var covXpxR = ol - WELD_EPS <= pxR && pxR <= or_ + WELD_EPS
        if ((flushLeft && covYpyT) || (flushTop && covXpxL)) tl = true
        if ((flushRight && covYpyT) || (flushTop && covXpxR)) tr = true
        if ((flushRight && covYpyB) || (flushBottom && covXpxR)) br = true
        if ((flushLeft && covYpyB) || (flushBottom && covXpxL)) bl = true
      }
      var corners = []
      if (tl) corners.push("tl")
      if (tr) corners.push("tr")
      if (br) corners.push("br")
      if (bl) corners.push("bl")
      out[members[i].label] = corners
    }
    return out
  }

  // weldStyle — PURE mapping from weld geometry → a card's visual style (no DOM).
  // Separating this from the DOM applier (moon-dock.js applyWeldVisuals) makes the
  // corner/edge tables unit-testable and keeps all the {tl,tr,br,bl}/{t,r,b,l}
  // repetition in ONE place.
  //   grouped       — is this window part of a multi-window cluster?
  //   outlineSides  — its FREE (non-welded) perimeter sides (from weldOutlineSides)
  //   weldCorners   — its corners that sit at an interior seam (from weldCorners)
  //   isAnchor      — the chat anchor casts a distinct bottom accent edge
  // Returns { radii:{tl,tr,br,bl}(bool, true=square), grouped, weld(string),
  //           boxShadow(string), outlineClass(string) }.
  function weldStyle(grouped, outlineSides, weldCorners, isAnchor) {
    var wc = weldCorners || []
    var sq = function (c) { return grouped && wc.indexOf(c) !== -1 }
    var radii = { tl: sq("tl"), tr: sq("tr"), br: sq("br"), bl: sq("bl") }
    if (!grouped) return { radii: radii, grouped: false, weld: "", boxShadow: "", outlineClass: "" }
    var sides = outlineSides || []
    var has = function (s) { return sides.indexOf(s) !== -1 }
    // Per-edge silhouette ONLY — one directional piece per FREE (non-welded) side.
    // The old symmetric --dk-edge-amb seed was prepended unconditionally and, being
    // spread-0, cast a soft lip on ALL four sides — including welded seams (the
    // "ring was inside the cluster, not on the outer border" bug). Dropping it keeps
    // the cluster's outer halo (the directional pieces) while a welded seam — and a
    // fully-interior member (0 free sides) — casts nothing. See moon-skins.css --dk-edge-*.
    var pieces = []
    if (has("t")) pieces.push("var(--dk-edge-t)")
    if (has("b")) pieces.push(isAnchor ? "var(--dk-edge-b-anchor)" : "var(--dk-edge-b)")
    if (has("l")) pieces.push("var(--dk-edge-l)")
    if (has("r")) pieces.push("var(--dk-edge-r)")
    // welded sides = the complement of the free sides (drives the data-weld marker).
    var welded = ["t", "b", "l", "r"].filter(function (e) { return !has(e) })
    return {
      radii: radii,
      grouped: true,
      weld: welded.join(""),
      // "none" (NOT "") when fully interior: moon-dock.js applies this inline, and an
      // empty string would clear the inline prop and let the CSS --dk-win-shadow solo
      // halo bleed back onto a buried card. "none" explicitly suppresses it (flat).
      boxShadow: pieces.length ? pieces.join(", ") : "none",
      outlineClass: sides.map(function (s) { return "g" + s }).join(" "),
    }
  }

  // dockOnOpenPosition — PURE snap-on-open placement (the JS owner of what Rust
  // used to compute via dock_rects_touch/dock_components/group_bbox_of +
  // panel_spawn_pos). Where should a freshly-opened panel dock, CARD-flush
  // against the preferred/nearest existing cluster?
  //   self     = the new window's FRAME rect {x,y,w,h} (x,y only used for the
  //              nearest-anchor tie-break; w,h are its size)
  //   members  = OTHER visible dock windows [{label, rect}] (FRAME rects; hub +
  //              the new window excluded by the caller)
  //   insets   = card insets {l,r,t,b}
  //   prefer   = a member label to prefer joining (e.g. 'panel-chat'); ignored
  //              if absent from members
  //   monitorRight = logical-px right edge for the overflow → left fallback
  //                  (omit/Infinity = never overflow)
  // Runs in CARD-FACE space so it clusters by what the user SEES (face-flush =
  // frame-overlap) and lands the new card flush against the cluster's card edge.
  // Returns { x, y, anchor, edge } in FRAME coords, or null when nothing dockable.
  function dockOnOpenPosition(self, members, insets, prefer, monitorRight) {
    var ms = members || []
    if (!ms.length) return null
    var ins = insets || ZERO_INSETS
    // anchor: the preferred member if present, else nearest centre to self
    // (deterministic label tie-break — mirrors Rust pick_nearest_label).
    var anchor = null
    if (prefer) {
      for (var i = 0; i < ms.length; i++) if (ms[i].label === prefer) { anchor = prefer; break }
    }
    if (!anchor) {
      var fcx = self.x + self.w / 2, fcy = self.y + self.h / 2
      var best = null
      for (var j = 0; j < ms.length; j++) {
        var r = ms[j].rect, cx = r.x + r.w / 2, cy = r.y + r.h / 2
        var d = (cx - fcx) * (cx - fcx) + (cy - fcy) * (cy - fcy)
        if (best === null || d < best.d || (d === best.d && ms[j].label < best.label)) {
          best = { d: d, label: ms[j].label }
        }
      }
      anchor = best && best.label
    }
    if (!anchor) return null
    // Cluster membership + bbox in CARD-face space (frame-flush would miss the
    // now-overlapping frames of face-aligned neighbours).
    var cards = ms.map(function (m) { return { label: m.label, rect: insetRect(m.rect, ins) } })
    var cluster = weldClusterOf(anchor, cards)
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (var k = 0; k < cards.length; k++) {
      if (cluster.indexOf(cards[k].label) === -1) continue
      var c = cards[k].rect
      if (c.x < x0) x0 = c.x
      if (c.y < y0) y0 = c.y
      if (c.x + c.w > x1) x1 = c.x + c.w
      if (c.y + c.h > y1) y1 = c.y + c.h
    }
    if (!isFinite(x0)) return null
    // Dock the new card flush to the cluster's card edge; top-aligned. Convert
    // the resulting card top-left back to a FRAME top-left for setPosition.
    var selfCardW = self.w - ins.l - ins.r
    var rightFrameX = x1 - ins.l // self card-left = cluster card-right (x1)
    var frameY = y0 - ins.t      // self card-top  = cluster card-top  (y0)
    var lim = (monitorRight == null) ? Infinity : monitorRight
    if (rightFrameX + self.w <= lim) {
      return { x: Math.round(rightFrameX), y: Math.round(frameY), anchor: anchor, edge: "r" }
    }
    var leftFrameX = (x0 - selfCardW) - ins.l // self card-right = cluster card-left (x0)
    return { x: Math.round(leftFrameX), y: Math.round(frameY), anchor: anchor, edge: "l" }
  }

  // logicalToPhysical — resolve a LOGICAL (CSS-point) top-left to the PHYSICAL
  // pixel position to hand Tauri's setPosition, anchored to whichever monitor
  // contains the point. This is what makes a cross-display drag mixed-DPI safe.
  //
  // A window dragged from a 2× Retina laptop onto a 1× external must be PLACED
  // using the DESTINATION display's scale factor. Writing a LogicalPosition
  // instead lets the platform re-resolve the coordinate with the dragged
  // window's OWN scale factor — and while the window straddles the seam that
  // factor rapidly flip-flops 2×↔1×, so the same logical value lands at two
  // different physical spots on alternating frames: the violent flicker.
  //
  //   monitors = [{ x, y, w, h, sf }] — PHYSICAL px + scale factor, exactly as
  //     Tauri's availableMonitors() reports (position, size, scaleFactor).
  //   Returns { x, y } in PHYSICAL px, or null when the layout is unknown (no
  //     monitors) so the caller can fall back to a LogicalPosition write.
  //
  // Each monitor's logical rect is its physical rect ÷ its own sf; the target
  // point lives in that same shared point space (Tauri's physical/sf == the
  // browser's screenX/Y point space). Selecting the monitor by the POINT keeps
  // the chosen scale factor stable no matter how much of the window has
  // crossed, so the placement stops oscillating.
  function resolveLogicalOrigins(monitors) {
    var isMac = false;
    for (var i = 0; i < monitors.length; i++) {
      for (var j = 0; j < monitors.length; j++) {
        if (i === j) continue;
        var mi = monitors[i], mj = monitors[j];
        if ((mi.x > mj.x && mi.x < mj.x + mj.w) || (mi.y > mj.y && mi.y < mj.y + mj.h)) {
          isMac = true;
          break;
        }
      }
      if (isMac) break;
    }

    var result = [];
    if (isMac) {
      for (var k = 0; k < monitors.length; k++) {
        var m = monitors[k];
        result.push({ m: m, lx: m.x / m.sf, ly: m.y / m.sf });
      }
      return result;
    }

    var primary = null;
    for (var n = 0; n < monitors.length; n++) {
      if (monitors[n].x === 0 && monitors[n].y === 0) {
        primary = monitors[n];
        break;
      }
    }
    if (!primary) primary = monitors[0];

    var solved = new Map();
    solved.set(primary, { lx: 0, ly: 0 });
    var queue = [primary];

    while (queue.length > 0) {
      var u = queue.shift();
      var uLoc = solved.get(u);

      for (var idx = 0; idx < monitors.length; idx++) {
        var v = monitors[idx];
        if (solved.has(v)) continue;

        var touches = false;
        var lx = 0, ly = 0;

        if (Math.abs(v.x - (u.x + u.w)) < 2) {
          lx = uLoc.lx + u.w / u.sf;
          ly = uLoc.ly + (v.y - u.y) / u.sf;
          touches = true;
        } else if (Math.abs((v.x + v.w) - u.x) < 2) {
          lx = uLoc.lx - v.w / v.sf;
          ly = uLoc.ly + (v.y - u.y) / v.sf;
          touches = true;
        } else if (Math.abs(v.y - (u.y + u.h)) < 2) {
          ly = uLoc.ly + u.h / u.sf;
          lx = uLoc.lx + (v.x - u.x) / u.sf;
          touches = true;
        } else if (Math.abs((v.y + v.h) - u.y) < 2) {
          ly = uLoc.ly - v.h / v.sf;
          lx = uLoc.lx + (v.x - u.x) / v.sf;
          touches = true;
        }

        if (touches) {
          solved.set(v, { lx: lx, ly: ly });
          queue.push(v);
        }
      }
    }

    for (var idx2 = 0; idx2 < monitors.length; idx2++) {
      var m2 = monitors[idx2];
      if (!solved.has(m2)) {
        solved.set(m2, { lx: m2.x / m2.sf, ly: m2.y / m2.sf });
      }
    }

    for (var idx3 = 0; idx3 < monitors.length; idx3++) {
      var m3 = monitors[idx3];
      var loc = solved.get(m3);
      result.push({ m: m3, lx: loc.lx, ly: loc.ly });
    }
    return result;
  }

  function logicalToPhysical(x, y, monitors) {
    if (!monitors || !monitors.length) return null;
    var resolved = resolveLogicalOrigins(monitors);
    var pick = null;
    var pickLoc = null;

    for (var i = 0; i < resolved.length; i++) {
      var item = resolved[i];
      var m = item.m;
      var lx = item.lx, ly = item.ly;
      if (x >= lx && x < lx + m.w / m.sf && y >= ly && y < ly + m.h / m.sf) {
        pick = m;
        pickLoc = item;
        break;
      }
    }
    if (!pick) {
      var best = Infinity;
      for (var j = 0; j < resolved.length; j++) {
        var item2 = resolved[j];
        var mm = item2.m;
        var d = Math.hypot(x - (item2.lx + (mm.w / 2) / mm.sf), y - (item2.ly + (mm.h / 2) / mm.sf));
        if (d < best) {
          best = d;
          pick = mm;
          pickLoc = item2;
        }
      }
    }

    return {
      x: Math.round(pick.x + (x - pickLoc.lx) * pick.sf),
      y: Math.round(pick.y + (y - pickLoc.ly) * pick.sf)
    };
  }


  // physicalSnapEdge — compute the PHYSICAL frame top-left for a window snapping
  // flush against a neighbour. Supersedes physicalSnapOrigin: it does NOT assume
  // a fully corner-aligned snap (start/end) — instead it carries the EXACT
  // perpendicular offset chosen by computeEdgeSnap, anchored to the neighbour's
  // PHYSICAL card frame so the rounding is consistent.
  //
  // The touching seam is PIXEL-EXACT (the drift fix that closed the transparent
  // seam): self's touching card edge coincides with the neighbour's on the same
  // physical pixel. The perpendicular axis preserves the snapped logical offset,
  // anchored to the neighbour's physical card edge and rounded ONCE.
  //
  //   neighborPhys    = neighbour PHYSICAL frame { x, y, w, h }
  //   neighborCard    = neighbour LOGICAL card rect { x, y, w, h }
  //   snappedLeadCard = { x, y } — lead's snapped LOGICAL card top-left
  //                     (the {x,y} computeEdgeSnap returned)
  //   selfPhys        = this window's PHYSICAL size { w, h }
  //   edge            = 'l'|'r'|'t'|'b' — which side of the neighbour self lands on
  //   ins             = LOGICAL insets { l, r, t, b } (--card-inset values)
  //   sf              = scale factor (e.g. 2 on a Retina display)
  //
  // Lp(v) = Math.round(v * sf). For a corner-aligned snap the perpendicular
  // delta (snappedLeadCard.perp − neighborCard.perp) is 0 → both axes exact; for
  // a free-offset snap the delta preserves the offset, rounded once.
  function physicalSnapEdge(neighborPhys, neighborCard, snappedLeadCard, selfPhys, edge, ins, sf) {
    function Lp(v) { return Math.round(v * sf); }
    // Neighbour physical card edges.
    var nCardL = neighborPhys.x + Lp(ins.l)
    var nCardR = neighborPhys.x + neighborPhys.w - Lp(ins.r)
    var nCardT = neighborPhys.y + Lp(ins.t)
    var nCardB = neighborPhys.y + neighborPhys.h - Lp(ins.b)
    // Self physical card dims.
    var selfCardW = selfPhys.w - Lp(ins.l) - Lp(ins.r)
    var selfCardH = selfPhys.h - Lp(ins.t) - Lp(ins.b)
    var cardX, cardY
    if (edge === "r") {
      cardX = nCardR
      cardY = nCardT + Lp(snappedLeadCard.y - neighborCard.y)
    } else if (edge === "l") {
      cardX = nCardL - selfCardW
      cardY = nCardT + Lp(snappedLeadCard.y - neighborCard.y)
    } else if (edge === "b") {
      cardY = nCardB
      cardX = nCardL + Lp(snappedLeadCard.x - neighborCard.x)
    } else { // 't'
      cardY = nCardT - selfCardH
      cardX = nCardL + Lp(snappedLeadCard.x - neighborCard.x)
    }
    // Frame origin = self card top-left minus self's own top/left physical inset.
    return { x: cardX - Lp(ins.l), y: cardY - Lp(ins.t) }
  }

  // resolveOverlap — the HARD "never overlap" guarantee, layered ON TOP of the
  // forgiving edge magnet (computeEdgeSnap). computeEdgeSnap only clears the ONE
  // neighbour it docks against, so a released window can still land overlapping a
  // SECOND window (or the hub, or a window the peel-cooldown excluded). This is a
  // pure, iterative minimal-push solver: while `rect` overlaps anything in
  // `others`, find the WORST overlap and push `rect` flush-clear of it. Each push
  // lands `rect` flush-adjacent to that neighbour, which can introduce a fresh
  // (smaller) overlap with a different neighbour, so we loop until clear (or
  // maxIter).
  //
  // BOUNDS-AWARENESS — why it matters: the naive "least-penetration axis" push
  // can shove `rect` UP or LEFT off the monitor's work area. macOS then CLAMPS
  // the window back on-screen at setPosition time, which UNDOES the push and
  // re-introduces the very overlap we just resolved (observed live: 3/12 drops
  // stayed overlapping because their minimal clearing move was off-screen). So
  // when a `bounds` rect (the monitor work area, in the SAME card/logical space)
  // is supplied, we prefer the SHORTEST clearing move that keeps `rect` fully
  // inside `bounds`; only if no in-bounds move clears the neighbour do we fall
  // back to the shortest move overall (best effort — can't beat the geometry).
  //
  //   rect   = the window's CARD rect {x,y,w,h}
  //   others = array of other windows' CARD rects {x,y,w,h}
  //   opts   = { maxIter, bounds } — bounds {x,y,w,h} = the allowed region
  //            (monitor work area, card/logical space). Back-compat: `opts` may
  //            also be a NUMBER, treated as maxIter (old callers/tests). Default
  //            maxIter = 12; bounds optional (omit = pure least-movement, the old
  //            behaviour).
  // Returns a CARD top-left {x,y} where `rect` overlaps NONE of `others` (or the
  // best achievable when no in-bounds escape exists), or the original {x,y} when
  // it already overlaps nothing.
  function resolveOverlap(rect, others, opts) {
    var os = others || []
    // Back-compat: a bare number is the old maxIter arg.
    var o = typeof opts === "number" ? { maxIter: opts } : (opts || {})
    var iter = typeof o.maxIter === "number" ? o.maxIter : 12
    var bounds = o.bounds || null
    var x = rect.x, y = rect.y, w = rect.w, h = rect.h
    // STEP 0 — clamp the start position INTO bounds. The upstream edge-snap can
    // pick an off-screen flush target (e.g. "above" a top-row neighbour at a
    // negative y); that reads as zero-overlap in pure geometry, but the OS then
    // CLAMPS the window back on-screen and re-introduces a real overlap the math
    // never saw. Clamping here makes the resolver work on the position the OS
    // will actually use, so it can then push it clear in-bounds.
    if (bounds) {
      var maxX = bounds.x + bounds.w - w, maxY = bounds.y + bounds.h - h
      if (x < bounds.x) x = bounds.x; else if (x > maxX) x = maxX
      if (y < bounds.y) y = bounds.y; else if (y > maxY) y = maxY
    }
    // A candidate rect is in-bounds when it sits fully inside `bounds`.
    function inBounds(cx, cy) {
      if (!bounds) return true
      return (
        cx >= bounds.x &&
        cy >= bounds.y &&
        cx + w <= bounds.x + bounds.w &&
        cy + h <= bounds.y + bounds.h
      )
    }
    for (var k = 0; k < iter; k++) {
      // Find the WORST current overlap (largest overlap area) among others.
      var worst = null
      for (var i = 0; i < os.length; i++) {
        var n = os[i]
        var ox = Math.min(x + w, n.x + n.w) - Math.max(x, n.x)
        var oy = Math.min(y + h, n.y + n.h) - Math.max(y, n.y)
        if (ox > 0 && oy > 0) {
          var area = ox * oy
          // Tie-break: keep the FIRST found (strictly-greater test → stable).
          if (!worst || area > worst.area) worst = { n: n, area: area }
        }
      }
      if (!worst) break // no overlap left → done
      var wn = worst.n
      // The FOUR single-axis moves that each fully clear overlap with wn. Each
      // candidate carries its post-move top-left + the distance travelled on the
      // moved axis (the other coord is unchanged).
      var cands = [
        { x: wn.x + wn.w, y: y, dist: Math.abs(wn.x + wn.w - x) }, // right
        { x: wn.x - w, y: y, dist: Math.abs(wn.x - w - x) },       // left
        { x: x, y: wn.y + wn.h, dist: Math.abs(wn.y + wn.h - y) }, // down
        { x: x, y: wn.y - h, dist: Math.abs(wn.y - h - y) },       // up
      ]
      // Prefer the shortest IN-BOUNDS move; fall back to the shortest move overall
      // when none stays in bounds (best effort). Without bounds, inBounds() is
      // always true → this is exactly the old least-movement choice.
      var bestIn = null, bestAny = null
      for (var c = 0; c < cands.length; c++) {
        var cd = cands[c]
        if (bestAny === null || cd.dist < bestAny.dist) bestAny = cd
        if (inBounds(cd.x, cd.y) && (bestIn === null || cd.dist < bestIn.dist)) bestIn = cd
      }
      var pick = bestIn || bestAny
      x = pick.x
      y = pick.y
    }
    return { x: x, y: y }
  }

  g.LunaDeckSnap = {
    computeSnap: computeSnap,
    computeEdgeSnap: computeEdgeSnap,
    resolveOverlap: resolveOverlap,
    computeLiveDrag: computeLiveDrag,
    logicalToPhysical: logicalToPhysical,
    DEFAULT_THRESHOLD: DEFAULT_THRESHOLD,
    insetRect: insetRect,
    // emergent welding geometry (replaces the Rust dock graph)
    rectsTouch: rectsTouch,
    weldComponents: weldComponents,
    weldClusterOf: weldClusterOf,
    weldOutlineSides: weldOutlineSides,
    weldCorners: weldCorners,
    weldStyle: weldStyle,
    dockOnOpenPosition: dockOnOpenPosition,
    physicalSnapEdge: physicalSnapEdge,
  }
})(typeof globalThis !== "undefined" ? globalThis : this)
