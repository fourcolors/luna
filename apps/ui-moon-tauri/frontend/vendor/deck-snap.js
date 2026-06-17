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
  function computeLiveDrag(drag, candidates, threshold) {
    var lead = { x: drag.ox + drag.dx, y: drag.oy + drag.dy, w: drag.ow, h: drag.oh }
    var best = null
    var cands = candidates || []
    for (var i = 0; i < cands.length; i++) {
      var s = computeSnap(cands[i].rect, lead, threshold)
      if (!s) continue
      var d = Math.hypot(s.x - lead.x, s.y - lead.y)
      if (best === null || d < best.d) {
        best = { x: s.x, y: s.y, edge: s.edge, label: cands[i].label, d: d }
      }
    }
    var tx = best ? best.x : lead.x
    var ty = best ? best.y : lead.y
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
  function logicalToPhysical(x, y, monitors) {
    if (!monitors || !monitors.length) return null
    var pick = null
    for (var i = 0; i < monitors.length; i++) {
      var m = monitors[i]
      var lx = m.x / m.sf,
        ly = m.y / m.sf
      if (x >= lx && x < lx + m.w / m.sf && y >= ly && y < ly + m.h / m.sf) {
        pick = m
        break
      }
    }
    if (!pick) {
      // Off every display (a gap between monitors, or dragged past an outer
      // edge): pick the nearest by logical-center distance so the mapping stays
      // continuous instead of snapping to monitors[0].
      var best = Infinity
      for (var j = 0; j < monitors.length; j++) {
        var mm = monitors[j]
        var d = Math.hypot(x - (mm.x + mm.w / 2) / mm.sf, y - (mm.y + mm.h / 2) / mm.sf)
        if (d < best) {
          best = d
          pick = mm
        }
      }
    }
    // physical = monitorPhysOrigin + (point − monitorLogicalOrigin) × sf, which
    // reduces exactly to point × sf because a monitor's physical origin IS its
    // logical origin × its own scale factor.
    return { x: Math.round(x * pick.sf), y: Math.round(y * pick.sf) }
  }

  g.LunaDeckSnap = {
    computeSnap: computeSnap,
    computeLiveDrag: computeLiveDrag,
    logicalToPhysical: logicalToPhysical,
    DEFAULT_THRESHOLD: DEFAULT_THRESHOLD,
    // emergent welding geometry (replaces the Rust dock graph)
    rectsTouch: rectsTouch,
    weldComponents: weldComponents,
    weldClusterOf: weldClusterOf,
    weldOutlineSides: weldOutlineSides,
    weldCorners: weldCorners,
  }
})(typeof globalThis !== "undefined" ? globalThis : this)
