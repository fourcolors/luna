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

  g.LunaDeckSnap = {
    computeSnap: computeSnap,
    computeLiveDrag: computeLiveDrag,
    DEFAULT_THRESHOLD: DEFAULT_THRESHOLD,
  }
})(typeof globalThis !== "undefined" ? globalThis : this)
