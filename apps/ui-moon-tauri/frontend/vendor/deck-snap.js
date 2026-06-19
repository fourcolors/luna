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


  g.LunaDeckSnap = {
    computeSnap: computeSnap,
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
  }
})(typeof globalThis !== "undefined" ? globalThis : this)
