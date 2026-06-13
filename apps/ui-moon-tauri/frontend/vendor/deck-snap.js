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

  // ── Dock-link seams ────────────────────────────────────────────────────
  // Once two widget windows are DOCKED (flush, in the same group), we draw a
  // little chain-link badge sitting on each interior seam — the visible
  // "these are linked" affordance from the Luna Workspace design. Because
  // every panel is its own OS window, the badge can't straddle the boundary
  // (a window clips its webview to its bounds), so the LEFT/TOP window of a
  // seam owns and renders it, nested in its 22px transparent card margin
  // flush against the seam.
  //
  // computeSeams returns ONLY the seams `self` owns: it inspects self's RIGHT
  // and BOTTOM edges for a flush, overlapping partner. The mirror window
  // inspects ITS right/bottom (which face away from this seam) and finds
  // nothing — so each seam is reported by exactly one window, no dedup pass.
  //
  // EPS / MIN_OVERLAP mirror the Rust `dock_rects_touch` predicate so the
  // badge appears for precisely the seams Rust counts as touching.
  var SEAM_EPS = 2 // px flush tolerance (matches dock_rects_touch)
  var SEAM_MIN_OVERLAP = 8 // px shared run required to count as a real seam
  var BADGE_R = 11 // half the 22px badge — the inset that keeps it on-window

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v
  }

  // self/partner rects are `{ x, y, w, h }` in the SAME logical-px space.
  // `others` is `[{ label, rect }]` — the rest of self's dock group. Returns
  // `[{ partner, edge, x, y }]`: edge ∈ 'r'|'b' (which of self's edges the
  // seam lies on) and (x, y) the badge CENTER in self-LOCAL px (origin at
  // self's top-left), clamped so the 22px badge stays fully inside self.
  function computeSeams(self, others) {
    if (!self || !others || !others.length) return []
    var selfRight = self.x + self.w
    var selfBottom = self.y + self.h
    var out = []
    for (var i = 0; i < others.length; i++) {
      var o = others[i]
      var r = o && o.rect
      if (!r) continue
      var oRight = r.x + r.w
      var oBottom = r.y + r.h

      // Vertical seam: self is the LEFT window (self.right flush to o.left).
      var vOverlap = Math.min(selfBottom, oBottom) - Math.max(self.y, r.y)
      if (Math.abs(selfRight - r.x) <= SEAM_EPS && vOverlap >= SEAM_MIN_OVERLAP) {
        var midY = (Math.max(self.y, r.y) + Math.min(selfBottom, oBottom)) / 2 - self.y
        out.push({
          partner: o.label,
          edge: "r",
          x: self.w - BADGE_R,
          y: clamp(Math.round(midY), BADGE_R, self.h - BADGE_R),
        })
        continue // a non-overlapping partner can be flush on only one side
      }

      // Horizontal seam: self is the TOP window (self.bottom flush to o.top).
      var hOverlap = Math.min(selfRight, oRight) - Math.max(self.x, r.x)
      if (Math.abs(selfBottom - r.y) <= SEAM_EPS && hOverlap >= SEAM_MIN_OVERLAP) {
        var midX = (Math.max(self.x, r.x) + Math.min(selfRight, oRight)) / 2 - self.x
        out.push({
          partner: o.label,
          edge: "b",
          x: clamp(Math.round(midX), BADGE_R, self.w - BADGE_R),
          y: self.h - BADGE_R,
        })
      }
    }
    return out
  }

  g.LunaDeckSnap = {
    computeSnap: computeSnap,
    computeSeams: computeSeams,
    DEFAULT_THRESHOLD: DEFAULT_THRESHOLD,
  }
})(typeof globalThis !== "undefined" ? globalThis : this)
