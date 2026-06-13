/**
 * deck-snap.js — the WinAmp-style magnetic snap math for the Moon Deck
 * (PRD Part C / W2). Pure, framework-free, side-effect-free so it can be
 * unit-tested in isolation and shared by the widget window + (later) the
 * window manager. Ported from the approved deck-concept.html snap model:
 * a widget glues to the chat anchor's edge when its matching edge falls
 * within a magnet threshold AND it overlaps the anchor on the perpendicular
 * axis (so a widget far above-right of the chat doesn't snap to the side).
 *
 * Exposes `globalThis.LunaDeckSnap.computeSnap`. All rects are
 * `{ x, y, w, h }` in the SAME coordinate space (screen px). Returns the
 * snapped top-left `{ x, y, edge }` (edge ∈ 'l'|'r'|'t'|'b') or null when no
 * edge is within threshold.
 */
;(function (g) {
  "use strict"

  var DEFAULT_THRESHOLD = 22 // px — matches deck-concept.html's magnet

  function computeSnap(anchor, widget, threshold) {
    if (!anchor || !widget) return null
    var t = typeof threshold === "number" ? threshold : DEFAULT_THRESHOLD
    var aRight = anchor.x + anchor.w
    var aBottom = anchor.y + anchor.h
    var wRight = widget.x + widget.w
    var wBottom = widget.y + widget.h

    // Perpendicular-axis overlap: only snap to a side the widget actually
    // sits beside, not diagonally off the corner.
    var vOverlap = widget.y < aBottom && wBottom > anchor.y
    var hOverlap = widget.x < aRight && wRight > anchor.x

    var cands = []
    if (vOverlap) {
      // RIGHT: widget's left edge ~ anchor's right edge.
      cands.push({ edge: "r", gap: Math.abs(widget.x - aRight), x: aRight, y: widget.y })
      // LEFT: widget's right edge ~ anchor's left edge.
      cands.push({ edge: "l", gap: Math.abs(wRight - anchor.x), x: anchor.x - widget.w, y: widget.y })
    }
    if (hOverlap) {
      // TOP: widget's bottom edge ~ anchor's top edge.
      cands.push({ edge: "t", gap: Math.abs(wBottom - anchor.y), x: widget.x, y: anchor.y - widget.h })
      // BOTTOM: widget's top edge ~ anchor's bottom edge.
      cands.push({ edge: "b", gap: Math.abs(widget.y - aBottom), x: widget.x, y: aBottom })
    }

    var best = null
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].gap <= t && (best === null || cands[i].gap < best.gap)) {
        best = cands[i]
      }
    }
    if (!best) return null
    return { x: Math.round(best.x), y: Math.round(best.y), edge: best.edge }
  }

  // NOTE: dock-link SEAM placement (the chain-link badge between two docked
  // windows) used to live here as computeSeams, but it now lives in Rust
  // (main.rs dock_seams), which already holds every member's rect when it
  // builds the dock-group payload — one source of truth, no client geometry
  // fan-out. This module keeps only the pure SNAP math.

  g.LunaDeckSnap = {
    computeSnap: computeSnap,
    DEFAULT_THRESHOLD: DEFAULT_THRESHOLD,
  }
})(typeof globalThis !== "undefined" ? globalThis : this)
