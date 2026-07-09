/**
 * moon-dock.js — the dock/snap client wiring shared by every widget-page
 * window (widget.html, panel.html, chat.html).
 *
 * EMERGENT WELDING MODEL (the Luna Dock reference's "manner"): welding is not
 * stored anywhere. A window derives every welding fact it needs — its cluster,
 * its perimeter (free) sides, the corners to square at a seam — LIVE from the
 * rects of its siblings, using the pure geometry in vendor/deck-snap.js
 * (LunaDeckSnap.weld*), which is a byte-for-byte port of the old Rust dock
 * graph. There is no central DockGroups graph, no set_dock bookkeeping, and no
 * per-member dock-group IPC payload; cross-window repaint is coordinated by a
 * single broadcast tick:
 *
 *   any window changes geometry (drag / resize / open) → it emits
 *   `dock-geometry-changed` → every window recomputes its own weld locally.
 *
 * Drag is NATIVE: title-bar pointerdown hands the gesture to the OS window
 * server (begin_cluster_drag → startDragging), with the grab's welded
 * siblings attached as AppKit CHILD WINDOWS so the anchor tows its whole
 * cluster 1:1 (a plain module peels off alone). There is no live magnet —
 * the card glides freely and snaps flush ONCE on release (snapOnRelease),
 * after which the children detach and whatever is flush is welded. The old
 * emulated pointermove loop survives only as a non-Tauri / test fallback.
 *
 * Requires in the page: #seam, #outline elements and a .title-bar (or
 * .chat-header) drag handle, plus vendor/deck-snap.js. Best-effort everywhere:
 * every Tauri call is wrapped so errors never propagate into the page.
 *
 * Usage: LunaDock.wire({ win: getCurrentWindow(), label: win.label })
 */
;(function (g) {
  'use strict';

  var HUB = 'main'; // the moon hub: a snap-alignment target, never a weld member

  // Magnet tunables (card-face px). EDGE_SNAP_THRESHOLD = how far a window edge
  // can be from a neighbour edge and still catch — this is the "magnet zone", so
  // a large value reads as an invisible wall/layer that engages well before the
  // edges meet. Kept TIGHT so the magnet engages near the actual edge. The
  // no-overlap guarantee (resolveOverlap) is INDEPENDENT of this, so a small
  // threshold does NOT reintroduce layering. CORNER_ALIGN_THRESHOLD = how close to
  // a corner before the perpendicular axis snaps flush (vs free); MIN_PERP_OVERLAP
  // = the minimum perpendicular overlap to count as "beside".
  var EDGE_SNAP_THRESHOLD = 30, CORNER_ALIGN_THRESHOLD = 26, MIN_PERP_OVERLAP = 8;
  // macOS menu-bar/notch allowance (logical px). Tauri v2's JS Monitor exposes
  // only the FULL hardware rect, not the OS visible frame (work area), so we
  // hand-inset the top of the primary monitor (global origin y==0) by this much.
  // Without it a card pushed flush to bounds.y lands under the menu bar; macOS
  // then clamps it back down, re-introducing the very overlap resolveOverlap
  // exists to prevent. This is a conservative constant: it covers both the
  // standard ~24pt menu bar AND the taller ~32-38pt menu-bar/notch region on
  // notched MacBooks (2021+), since no visible-frame/work-area is available.
  var MENU_BAR_INSET = 37;

  function wire(opts) {
    var W = opts && opts.win;
    var label = opts && opts.label;
    // Drawer drag-out floaters pass {threadId, ownerLabel}: on a native-drag
    // release whose center lands over the owner window, fold the thread back in
    // (redock_thread) instead of snapping. Null for every ordinary window.
    var redock = opts && opts.redock;
    if (!W) return; // not in Tauri
    if (label === HUB) return; // the hub reports no docks of its own

    // The chat window is the cluster anchor — stamp data-anchor so moon-theme.css
    // gives its title bar the accent fill/title color.
    if (label === 'panel-chat') {
      try { document.documentElement.setAttribute('data-anchor', 'true'); } catch (_) { /* best-effort */ }
    }

    var seamEl = document.getElementById('seam');
    var outlineEl = document.getElementById('outline');
    var groupMembers = []; // my cluster (incl. me) as of the last refresh; [] = ungrouped
    var exMembers = [];    // a just-left cluster, ignored as snap targets…
    var exUntil = 0;       // …until this time (no instant re-link after peeling off)

    function ev() { return window.__TAURI__ && window.__TAURI__.event; }

    // Broadcast "geometry changed" so every other dock window re-squares its
    // welded corners. A global emit (not emit_to) is correct here: this tick is
    // FOR everyone, unlike the old targeted dock-group payloads. Only emitted on
    // settle (drag drop / resize / boot) — never per pointer-move.
    function broadcastGeometry() {
      try { var e = ev(); if (e && e.emit) e.emit('dock-geometry-changed', { from: label }); } catch (_) { /* best-effort */ }
    }

    // The window's TOUCHING side is opposite the anchor-relative edge
    // ("r" = we sit at the anchor's right → our LEFT edge touches).
    function oppositeEdge(edge) {
      return { l: 'r', r: 'l', t: 'b', b: 't' }[edge] || null;
    }

    function flashSeam(side) {
      if (!seamEl || !side) return;
      seamEl.className = '';
      void seamEl.offsetWidth; // restart the animation
      seamEl.className = 'flash-' + side + ' on';
    }
    seamEl && seamEl.addEventListener('animationend', function () {
      seamEl.className = '';
    });

    // ── Apply weld visuals (locally computed) ──────────────────────────────
    // Maps the pure geometry results onto the card: square the flagged CORNERS
    // and cast the perimeter accent edge so a welded cluster reads as a group.
    // It deliberately does NOT touch the card's shape (margins / width / height /
    // padding) — sticking windows together changes corners only, never size or
    // layout. (The old per-side inset collapse that made cards reflow on docking
    // is gone; it was the "weird border state" reported during drag.)
    // Thin DOM applier over the PURE LunaDeckSnap.weldStyle mapping. The weld
    // changes ONLY corners + the perimeter accent edge — never the card's shape
    // (margin/size/padding) — so sticking windows together can't resize or reflow
    // them. Flush docking comes from card-face positioning (see readInsets /
    // computeLiveDrag), not from collapsing margins.
    function applyWeldVisuals(grouped, outlineSides, weldCorners) {
      groupMembers = grouped ? groupMembers : [];
      var style = window.LunaDeckSnap.weldStyle(grouped, outlineSides, weldCorners, label === 'panel-chat');
      if (outlineEl) outlineEl.className = grouped ? style.outlineClass : '';
      var shellEl = document.querySelector('.widget-shell');
      if (!shellEl) return;
      var px = function (on) { return on ? '0px' : ''; };
      shellEl.style.borderTopLeftRadius = px(style.radii.tl);
      shellEl.style.borderTopRightRadius = px(style.radii.tr);
      shellEl.style.borderBottomRightRadius = px(style.radii.br);
      shellEl.style.borderBottomLeftRadius = px(style.radii.bl);
      var barEl = document.querySelector('.title-bar');
      if (barEl) {
        barEl.style.borderTopLeftRadius = px(style.radii.tl);
        barEl.style.borderTopRightRadius = px(style.radii.tr);
      }
      if (style.grouped) {
        shellEl.setAttribute('data-weld', style.weld);
        shellEl.style.boxShadow = style.boxShadow;
      } else {
        shellEl.removeAttribute('data-weld');
        shellEl.style.boxShadow = '';
      }
      if (window.LunaNativeTitlebar && window.LunaNativeTitlebar.syncPosition) {
        window.LunaNativeTitlebar.syncPosition();
      }
    }

    // The card insets (the transparent margin between the OS frame and the
    // visible card) — the SINGLE SOURCE OF TRUTH is the CSS, so geometry and
    // chrome can never disagree. All magnet math runs in card-face space, so a
    // window aligns by what the user sees, not its larger OS frame.
    function readInsets() {
      try {
        var cs = getComputedStyle(document.documentElement);
        var side = parseFloat(cs.getPropertyValue('--card-inset'));
        var top = parseFloat(cs.getPropertyValue('--card-inset-top'));
        return {
          l: isFinite(side) ? side : 22,
          r: isFinite(side) ? side : 22,
          b: isFinite(side) ? side : 22,
          t: isFinite(top) ? top : 4,
        };
      } catch (_) { return { l: 22, r: 22, b: 22, t: 4 }; }
    }

    // Compute + apply this window's weld from a member list [{label, rect}] of OS
    // FRAME rects (which already excludes the hub). Weld detection runs in
    // CARD-FACE space — two windows weld when their visible cards meet flush,
    // which (because faces are inset) means their OS frames OVERLAP by the inset
    // sum. Returns my cluster's labels.
    function paintWeldFrom(members) {
      var S = window.LunaDeckSnap;
      var ins = readInsets();
      var cards = members.map(function (m) { return { label: m.label, rect: S.insetRect(m.rect, ins) }; });
      var cluster = S.weldClusterOf(label, cards);
      var grouped = cluster.length > 1;
      groupMembers = grouped ? cluster : [];
      var outline = grouped ? (S.weldOutlineSides(cards)[label] || []) : [];
      var weld = grouped ? (S.weldCorners(cards)[label] || []) : [];
      applyWeldVisuals(grouped, outline, weld);
      return cluster;
    }

    // ── Logical-px rects ───────────────────────────────────────────────────
    // All snap/weld math runs in LOGICAL px: each window's physical rect ÷ its
    // OWN scale factor, so mixed-DPI monitors compare coherently and the 30-px
    // magnet stays the designed size (LunaDeckSnap.DEFAULT_THRESHOLD).
    async function logicalRect(w) {
      var p = await w.outerPosition();
      var s = await w.outerSize();
      var sf = 1;
      try { sf = (await w.scaleFactor()) || 1; } catch (_) { /* default */ }
      return { x: p.x / sf, y: p.y / sf, w: s.width / sf, h: s.height / sf };
    }

    // Every VISIBLE, non-minimized widget dock window (incl. me) as
    // [{label, rect}] — the hub is never a weld member, and
    // list_widget_windows already excludes it. Hidden / OS-minimized siblings
    // are NOT weld members: their rects describe a card that is no longer on
    // screen, so welding to one painted squared corners and a seam toward a
    // hole (the "ghost weld" after a yellow-light minimize).
    async function weldMembers() {
      var out = [];
      try { out.push({ label: label, rect: await logicalRect(W) }); } catch (_) { return out; }
      var sibs = await visibleDockSiblings();
      for (var i = 0; i < sibs.length; i++) out.push(sibs[i]);
      return out;
    }

    // ── Snap-on-open (JS owns it; replaces the old Rust dock graph) ──────────
    // OTHER dock windows that are VISIBLE + not minimized, as [{label, rect}]
    // (FRAME rects). A fresh panel docks onto this set's nearest/preferred
    // cluster. Mirrors the old Rust nearest_dock_anchor filter (never snap to a
    // minimized/hidden window — its coords are stale).
    async function visibleDockSiblings() {
      var TW = window.__TAURI__ && window.__TAURI__.window;
      var out = [];
      try {
        var labels = await window.__TAURI__.core.invoke('list_widget_windows');
        if (!Array.isArray(labels)) return out;
        for (var i = 0; i < labels.length; i++) {
          if (labels[i] === label) continue;
          try {
            var w = await TW.Window.getByLabel(labels[i]);
            if (!w) continue;
            var vis = true, min = false;
            try { vis = await w.isVisible(); } catch (_) { /* default visible */ }
            try { min = await w.isMinimized(); } catch (_) { /* default not */ }
            if (!vis || min) continue;
            out.push({ label: labels[i], rect: await logicalRect(w) });
          } catch (_) { /* sibling vanished */ }
        }
      } catch (_) { /* listing unavailable */ }
      return out;
    }

    // Logical-px right edge of the monitor under `pt` (a logical point), for the
    // snap-on-open overflow → left fallback. Infinity when the layout is unknown
    // (single monitor / non-Tauri) so we never spuriously flip to the left.
    async function monitorRightFor(pt) {
      var TW = window.__TAURI__ && window.__TAURI__.window;
      try {
        if (TW && typeof TW.availableMonitors === 'function') {
          var mons = await TW.availableMonitors();
          if (Array.isArray(mons) && mons.length) {
            for (var i = 0; i < mons.length; i++) {
              var m = mons[i], sf = m.scaleFactor || 1;
              var lx = m.position.x / sf, lw = m.size.width / sf, ly = m.position.y / sf, lh = m.size.height / sf;
              if (pt.x >= lx && pt.x < lx + lw && pt.y >= ly && pt.y < ly + lh) return lx + lw;
            }
            var f = mons[0], fsf = f.scaleFactor || 1; // off every display → first monitor
            return f.position.x / fsf + f.size.width / fsf;
          }
        }
      } catch (_) { /* unavailable */ }
      return Infinity;
    }

    // The preferred dock anchor passed by Rust on the URL (the "stacks" opener);
    // absent for gear/orb opens, which fall back to the chat anchor's cluster.
    function dockOpenerParam() {
      try {
        var v = new URLSearchParams(g.location.search).get('__dockOpener');
        return v || null;
      } catch (_) { return null; }
    }

    // Compute this freshly-opened panel's flush dock position in JS and ask Rust
    // to position + reveal it (dock_self). Rust builds the window hidden; this is
    // what places it — so it never flashes at the OS-default spot.
    async function dockSelfOnOpen() {
      var invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
      if (!invoke) return;
      try {
        var ins = readInsets();
        var self = await logicalRect(W);
        var members = await visibleDockSiblings();
        var prefer = dockOpenerParam() || 'panel-chat';
        var center = { x: self.x + self.w / 2, y: self.y + self.h / 2 };
        var monRight = await monitorRightFor(center);
        var pos = window.LunaDeckSnap.dockOnOpenPosition(self, members, ins, prefer, monRight);
        if (pos) await invoke('dock_self', { x: pos.x, y: pos.y, anchor: pos.anchor, edge: pos.edge });
        else await invoke('dock_self', {}); // no cluster (first panel) → just reveal in place
      } catch (_) {
        try { await invoke('dock_self', {}); } catch (_) { /* last-ditch: Rust fallback reveals */ }
      }
    }

    // Fresh enumeration → repaint my weld (corner squaring only). Cheap geometry,
    // one IPC round of window reads; runs on a geometry-changed tick / resize /
    // boot, NOT per pointermove. Since the weld no longer mutates card shape,
    // there is nothing to gate mid-drag — it just re-squares corners.
    // Immediate, awaitable weld paint. COALESCE, never DROP: weldMembers() is async
    // (one IPC read per sibling), so if a refresh lands mid-flight, mark it pending
    // and re-run after — the latest geometry wins; a plain early-return would strand
    // the card on a stale result. Callers that await this (boot, the tests) get the
    // weld applied synchronously after the await.
    var refreshing = false, refreshPending = false, weldTimer = null;
    async function refreshWeld() {
      if (refreshing) { refreshPending = true; return; }
      refreshing = true;
      try {
        do {
          refreshPending = false;
          paintWeldFrom(await weldMembers());
        } while (refreshPending);
      } catch (_) { /* best-effort */ }
      finally { refreshing = false; }
    }
    // TRAILING DEBOUNCE for event STORMS. Every window broadcasts
    // `dock-geometry-changed` (and a native resize fires onResized per frame), so a
    // single settle floods every sibling with weld refreshes, each reading async
    // geometry that may still be mid-transit — landing the card on a stale
    // `grouped=false` whose seam-side halo is never suppressed (the visible seam
    // band). Being a race, it resolved differently in dev vs a release build.
    // Coalescing the flood into ONE paint ~80ms after it goes quiet means the read
    // always sees SETTLED (flush) positions, so the weld is deterministic. The weld
    // is a settle-time visual (never per drag-frame), so the delay is imperceptible.
    function scheduleWeld() {
      if (weldTimer) clearTimeout(weldTimer);
      weldTimer = setTimeout(function () { weldTimer = null; refreshWeld(); }, 80);
    }

    // Snap candidates: the hub first (it wins distance ties), then every sibling
    // widget — minus anything in `exclude` (the drag group never re-snaps to
    // itself) and minus a just-peeled cluster during its cooldown.
    //   includeCooldown = true → IGNORE the peel cooldown (do NOT skip exMembers).
    //   The hard no-overlap pass must resolve against EVERYTHING, even a window we
    //   just peeled off, so it can't end up layered on a cooldown-excluded card.
    async function candidateRects(exclude, includeCooldown) {
      var out = [];
      var TW = window.__TAURI__ && window.__TAURI__.window;
      var skip = (exclude || groupMembers).slice();
      if (!includeCooldown && Date.now() < exUntil) skip = skip.concat(exMembers);
      // Monitor union (logical) for the ON-SCREEN filter below. A panel that is
      // mostly OFF-SCREEN must not be a snap target: snapping to its off-screen
      // edge yields a target that the OS clamps back on-screen to a NON-FLUSH
      // position — a large fixed gap that reads as the window "sticking in mid
      // air". (Root cause confirmed by a multi-agent investigation.)
      var union = null, ins = readInsets();
      try {
        if (TW && typeof TW.availableMonitors === 'function') {
          var mons = await TW.availableMonitors();
          if (Array.isArray(mons) && mons.length) {
            union = { x: Infinity, y: Infinity, r: -Infinity, b: -Infinity };
            for (var mi = 0; mi < mons.length; mi++) {
              var m = mons[mi], msf = m.scaleFactor || 1;
              union.x = Math.min(union.x, m.position.x / msf);
              union.y = Math.min(union.y, m.position.y / msf);
              union.r = Math.max(union.r, m.position.x / msf + m.size.width / msf);
              union.b = Math.max(union.b, m.position.y / msf + m.size.height / msf);
            }
          }
        }
      } catch (_) { /* no monitors → skip the on-screen filter */ }
      // The moon hub (orb) is NOT a snap target: it's small and always somewhere
      // on screen, so magneting to it mid-drag reads as an "invisible wall" and a
      // lone window jumps to it on release. Panels snap to other PANELS only.
      try {
        var labels = await window.__TAURI__.core.invoke('list_widget_windows');
        if (Array.isArray(labels)) {
          for (var i = 0; i < labels.length; i++) {
            if (labels[i] === label || labels[i] === HUB || skip.indexOf(labels[i]) !== -1) continue;
            try {
              var w = await TW.Window.getByLabel(labels[i]);
              if (!w) continue;
              // Skip HIDDEN / MINIMIZED windows — a collapsed panel must not act as
              // an unseen magnet target.
              var vis = true, min = false;
              try { vis = await w.isVisible(); } catch (_) { /* default visible */ }
              try { min = await w.isMinimized(); } catch (_) { /* default not */ }
              if (!vis || min) continue;
              var r = await logicalRect(w);
              // Skip only NEARLY-GONE panels (a sliver on screen). A SUBSTANTIALLY
              // visible panel stays dockable — you snap to its VISIBLE edge. The
              // off-screen-clamp gap is prevented at the TARGET level instead
              // (snapOnRelease discards a snap that lands the card off-screen).
              if (union) {
                var cx = r.x + ins.l, cy = r.y + ins.t, cw = r.w - ins.l - ins.r, ch = r.h - ins.t - ins.b;
                var ox = Math.min(cx + cw, union.r) - Math.max(cx, union.x);
                var oy = Math.min(cy + ch, union.b) - Math.max(cy, union.y);
                var onArea = (ox > 0 && oy > 0) ? ox * oy : 0;
                if (cw > 0 && ch > 0 && onArea < 0.15 * cw * ch) continue;
              }
              out.push({ label: labels[i], rect: r });
            } catch (_) { /* sibling vanished mid-enumeration */ }
          }
        }
      } catch (_) { /* listing unavailable */ }
      return out;
    }

    // ── LIVE magnetic drag — a small explicit state machine ────────────────
    // idle → arming (pointerdown captured a handle; the start snapshot is in
    // flight) → dragging (snapshot landed; pointermove flows) → idle (pointerup
    // / cancel settles). This replaces three loose vars (drag/activeHandle/
    // activePid): the once-implicit "arming" state (handle captured but no
    // snapshot yet) is now explicit, so the released-before-armed race is a
    // normal transition (`sm.handle !== handle`) rather than a null-check.
    function dockShell() { return document.querySelector('.widget-shell'); }
    // sm.ctx = the drag snapshot (geometry inputs + live snap results), null
    // until 'dragging'. sm.handle/pid = the captured title bar (cleanup).
    // sm.pendingXY = the latest pointer screen coords awaiting a frame flush;
    // sm.rafPending = a flush is already scheduled for this frame. Together they
    // COALESCE the pointer-move stream to ONE position write per animation frame
    // (see onDragMove/flushDrag): a 120 Hz trackpad otherwise floods the IPC
    // channel with set_position calls the window server can't drain in time, so
    // the card processes a backlog of stale coords and visibly trails the cursor.
    var sm = { phase: 'idle', handle: null, pid: null, ctx: null, pendingXY: null, rafPending: false };

    // Any phase → idle: release capture, detach listeners, drop the affordance
    // classes, and abandon any frame still queued (the guard in flushDrag makes
    // a late rAF a no-op once we are back to 'idle'). Safe to call from 'arming'
    // (no ctx yet) or 'dragging'.
    function endDrag() {
      if (sm.handle) {
        try { sm.handle.releasePointerCapture(sm.pid); } catch (_) {}
        sm.handle.removeEventListener('pointermove', onDragMove);
        sm.handle.removeEventListener('pointerup', onDragUp);
        sm.handle.removeEventListener('pointercancel', onDragUp);
      }
      sm.phase = 'idle'; sm.handle = null; sm.pid = null; sm.ctx = null;
      sm.pendingXY = null; sm.rafPending = false;
      var sh = dockShell();
      if (sh) sh.classList.remove('dragging');
    }

    // pointermove is hot (≤120 Hz). Do NO work here beyond stashing the latest
    // cursor position and arming one rAF — the actual snap math + the (single)
    // IPC move run in flushDrag, at most once per painted frame.
    function onDragMove(e) {
      if (sm.phase !== 'dragging') return;
      sm.pendingXY = { sx: e.screenX, sy: e.screenY };
      if (sm.rafPending) return;
      sm.rafPending = true;
      var raf = g.requestAnimationFrame
        ? function (cb) { g.requestAnimationFrame(cb); }
        : function (cb) { setTimeout(cb, 16); };
      raf(flushDrag);
    }

    // The per-frame drag step: snap the lead, translate the whole group, and
    // hand the WHOLE cluster to Rust in ONE call (dock_move_cluster) — the old
    // path fired a separate setPosition IPC per member EVERY pointer-move, so a
    // 3-window stack cost 3 round trips a frame and the cards trailed the cursor.
    function flushDrag() {
      sm.rafPending = false;
      if (sm.phase !== 'dragging' || !sm.ctx) return; // released before this frame ran
      var xy = sm.pendingXY;
      if (!xy) return;
      sm.pendingXY = null;
      var drag = sm.ctx;
      var S = window.LunaDeckSnap;
      if (!S) return; // dep torn down (page closing mid-drag / test teardown) before this frame ran
      var dx = xy.sx - drag.sx, dy = xy.sy - drag.sy;
      var res = S.computeLiveDrag({
        ox: drag.ox, oy: drag.oy, ow: drag.ow, oh: drag.oh, dx: dx, dy: dy,
        members: drag.members.map(function (m) { return { label: m.label, ox: m.ox, oy: m.oy }; })
      }, drag.cands, EDGE_SNAP_THRESHOLD, drag.insets);
      drag.snapped = res.snapped; drag.anchor = res.anchor; drag.edge = res.edge;
      // Resolve every member's target. Targets are LOGICAL (CSS-point) top-lefts.
      // When we captured a monitor layout, resolve each to a PHYSICAL position
      // using the DESTINATION monitor's DPI and send THOSE — a LogicalPosition
      // write rides the dragged window's live (seam-bistable) scale factor and
      // flickers across a mixed-DPI boundary. No layout (single monitor /
      // non-Tauri) → the LogicalPosition path, byte-for-byte as before.
      var mons = drag.monitors;
      var usePhysical = !!(mons && mons.length);
      var moves = [];
      for (var i = 0; i < res.targets.length; i++) {
        var m = drag.members[i];
        if (!m) continue;
        var t = res.targets[i];
        if (usePhysical) {
          var phys = S.logicalToPhysical(t.x, t.y, mons);
          moves.push({ label: m.label, x: phys ? phys.x : t.x, y: phys ? phys.y : t.y });
        } else {
          moves.push({ label: m.label, x: t.x, y: t.y });
        }
      }
      // ONE batched IPC for the whole cluster. Fire-and-forget (the next frame
      // supersedes it; awaiting would re-serialize the channel we just unclogged).
      // Fall back to the per-window setPosition path when invoke is unavailable
      // (older runtime / tests) so behavior degrades, never breaks.
      var invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
      if (invoke) {
        try { invoke('dock_move_cluster', { moves: moves, physical: usePhysical }); } catch (_) {}
      } else {
        var TW = window.__TAURI__ && window.__TAURI__.window;
        var PP = TW && TW.PhysicalPosition;
        var LP = TW && TW.LogicalPosition;
        for (var k = 0; k < moves.length; k++) {
          var mm = drag.members[k];
          if (!mm || !mm.win) continue;
          try {
            if (usePhysical && PP) mm.win.setPosition(new PP(moves[k].x, moves[k].y));
            else if (LP) mm.win.setPosition(new LP(moves[k].x, moves[k].y));
          } catch (_) {}
        }
      }
      if (g.__LUNA_DOCK_DEBUG) {
        try { console.log('[luna-dock] move', { screenX: xy.sx, screenY: xy.sy, lead: { x: drag.ox + dx, y: drag.oy + dy }, target0: res.targets[0], move0: moves[0], physical: usePhysical }); } catch (_) {}
      }
      // Weld VISUALS (corner squaring, seam silhouette, per-side margins) are
      // FROZEN during the drag and recomputed exactly once on drop
      // (onDragUp → refreshWeld). Repainting them per frame — on the dragged card
      // AND, via a mid-drag broadcast, on every stationary neighbour — is what
      // made the borders flicker/square mid-drag. Nothing is repainted live now:
      // the drag-time snap preview ring was removed (see moon-theme.css), so the
      // window glides freely and only snaps flush on release.
    }

    function onDragUp() {
      var d = sm.ctx;  // null if released while still 'arming' (snapshot not landed)
      endDrag();       // → idle (releases capture, detaches listeners, clears ctx)
      if (!d) return; // released before the start snapshot armed — nothing to commit
      // A module dragged clear of its old cluster ignores it briefly so it does
      // not instantly re-link off a surviving flush seam.
      if (!d.snapped && d.wasGrouped && !d.isAnchor) {
        exMembers = d.startCluster.filter(function (l) { return l !== label; });
        exUntil = Date.now() + 1500;
      }
      // Flash the seam on a fresh link and tell the anchor to flash its side.
      if (d.snapped && d.anchor && d.anchor !== HUB) {
        flashSeam(oppositeEdge(d.edge));
        try {
          var e = ev();
          if (e && e.emit) e.emit('dock-link', { 'for': d.anchor, from: label, edge: d.edge });
        } catch (_) { /* best-effort */ }
      }
      refreshWeld();          // settle my own weld from real rects
      broadcastGeometry();    // neighbours re-square their corners around the new position too
    }

    // ── Native drag + snap-on-release ──────────────────────────────────────
    // The OS window server owns the whole gesture: zero added latency (the
    // emulated loop trailed by ~1 frame). The cost is that the OS owns the
    // position mid-drag, so there is no LIVE magnet — we snap ONCE, on release.
    //
    // CLUSTER TOW: `towed` labels ride along as native CHILD WINDOWS
    // (begin_cluster_drag attaches them via NSWindow addChildWindow:ordered:
    // and then starts the drag). The window server moves children in the SAME
    // transaction as the parent, so the welded cluster tracks the cursor 1:1
    // with zero per-frame IPC — this is what restored "windows stick together"
    // after the native-drag rewrite orphaned the old dock_move_cluster towing.
    // They stay attached through snapOnRelease (the final snap setPosition
    // moves the cluster rigidly) and detach on end_cluster_drag.
    // `peel` = {wasGrouped, isAnchor, startCluster} snapshotted at grab time,
    // for the peel cooldown (see snapOnRelease).
    function startNativeDrag(towed, peel) {
      var tow = (towed || []).slice();
      var invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
      var started = false;
      if (invoke) {
        // Attach children + start the drag in ONE ordered main-thread hop.
        try { invoke('begin_cluster_drag', { members: tow }).catch(function () {}); started = true; } catch (_) {}
      }
      if (!started) {
        // Older runtime / tests: no invoke — plain solo native drag.
        try { W.startDragging(); } catch (_) { return; }
        tow = [];
      }
      var sh = dockShell(); if (sh) sh.classList.add('dragging');
      // Live drop affordance + redock eligibility: a redock-capable SOLO floater
      // tells its owner to show the "drop to redock" strip for the whole drag. A
      // floater towing a welded cluster is NOT redock-eligible (a redock only
      // folds in a lone window), so it drags and snaps like any other cluster.
      var redockArmed = !!(redock && redock.threadId && redock.ownerLabel && tow.length === 0);
      if (redockArmed) {
        try { var _ea = ev(); if (_ea && _ea.emit) _ea.emit('redock-arming', { owner: redock.ownerLabel }); } catch (_) { /* best-effort */ }
      }
      var unlisten = null, done = false;
      // The OS swallows the webview's pointer events mid-drag, so the RELIABLE
      // end signal is a Rust NSEvent mouse-up watcher that emits
      // `luna-drag-released` on the real button release (see main.rs
      // watch_drag_release). `relUnlisten` holds that subscription; `safety` is a
      // long backstop so a missed event can never strand the drag.
      var relUnlisten = null, safety = 0;
      function finish() {
        if (done) return; done = true;
        if (safety) { clearTimeout(safety); safety = 0; }
        if (relUnlisten) { try { relUnlisten(); } catch (_) {} relUnlisten = null; }
        if (unlisten) { try { unlisten(); } catch (_) {} unlisten = null; }
        document.removeEventListener('pointerup', onUp, true);
        document.removeEventListener('pointercancel', onUp, true);
        var s = dockShell();
        if (s) s.classList.remove('dragging');
        // Detach the towed children only AFTER the snap settles — they must
        // ride the final snap setPosition so the cluster stays rigid.
        var detach = function () {
          if (tow.length && invoke) {
            try { invoke('end_cluster_drag', { members: tow }).catch(function () {}); } catch (_) {}
          }
        };
        // Drag-IN redock: a drawer-spawned floater whose center lands over its
        // owner window folds the thread back in — redock_thread emits to the
        // owner and closes THIS window, so there is nothing to snap. If the
        // overlap test says "not over the owner" (or it's an ordinary window),
        // fall through to the normal snap-on-release.
        var settle;
        if (redockArmed) {
          var inv = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
          settle = (inv
            ? inv('redock_thread', { threadId: redock.threadId, ownerLabel: redock.ownerLabel, draft: (redock.getDraft && redock.getDraft()) || '' })
            : Promise.resolve(false)
          ).then(function (redocked) {
            return redocked ? null : snapOnRelease(tow, peel);
          }, function () {
            return snapOnRelease(tow, peel); // redock probe failed → behave like a normal release
          });
          // Clear the owner's drop affordance now the gesture ended (the owner
          // also clears it on redock-thread; this covers the declined case).
          try { var _ed = ev(); if (_ed && _ed.emit) _ed.emit('redock-disarmed', { owner: redock.ownerLabel }); } catch (_) { /* best-effort */ }
        } else {
          settle = snapOnRelease(tow, peel);
        }
        if (settle && settle.then) settle.then(detach, detach);
        else detach();
      }
      // The OS drag loop swallows pointermove/up, so the window's own Moved events
      // serve ONLY to re-arm the inactivity backstop (end-detection is the Rust
      // mouse-up watcher, NOT a motion-stopped timer — a mid-drag pause near a
      // snap target used to fire that timer prematurely).
      function onMovedTick() {
        // Re-arm the safety backstop on every Moved so it measures INACTIVITY,
        // not elapsed time: a slow but continuous drag (careful positioning is
        // easily >5s) keeps pushing the deadline out, so finish() can never fire
        // mid-gesture. It only trips after a genuinely quiet/stuck drag with no
        // Moved for 5s. (`safety` is 0 once finish() has run, so don't re-arm.)
        if (safety) { clearTimeout(safety); safety = setTimeout(finish, 5000); }
      }
      // Secondary fallback: if the webview DOES happen to see a pointerup/cancel
      // (e.g. a grab that never moved into the OS drag), finish directly.
      function onUp() { finish(); }
      document.addEventListener('pointerup', onUp, true);
      document.addEventListener('pointercancel', onUp, true);
      // Primary end signal: ask Rust to watch for the real mouse-button release
      // and finish ONCE on the first `luna-drag-released` for THIS window.
      try { window.__TAURI__.core.invoke('watch_drag_release'); } catch (_) { /* non-macOS / no watcher → pointer + safety fallbacks */ }
      try {
        var listen = (typeof W.listen === 'function')
          ? W.listen.bind(W)
          : (ev() && ev().listen);
        if (listen) {
          var rp = listen('luna-drag-released', function () { finish(); });
          if (rp && rp.then) rp.then(function (u) { if (done) { try { u(); } catch (_) {} } else { relUnlisten = u; } });
        }
      } catch (_) { /* no listener → pointer + safety fallbacks */ }
      // Long safety backstop: only fires if BOTH the release event and the
      // pointerup were somehow missed (far longer than any real drag).
      safety = setTimeout(finish, 5000);
      try {
        var p = W.onMoved(onMovedTick);
        if (p && p.then) p.then(function (u) { if (done) { try { u(); } catch (_) {} } else { unlisten = u; } });
      } catch (_) { /* no onMoved → rely on release event / pointerup */ }
    }

    // Snap my card flush to the nearest neighbour ONCE, on release, then re-weld
    // everyone. Uses the forgiving edge magnet (LunaDeckSnap.computeEdgeSnap) in
    // card-face space: docks flush to whichever neighbour edge is near,
    // preserves the perpendicular offset (unless near a corner), and resolves an
    // overlapping drop to flush-adjacent (anti-layer).
    //   towedLabels — cluster members riding as native child windows: excluded
    //   from snap targets AND obstacles (they move WITH me), and folded into
    //   the de-overlap bbox so the whole cluster stays clear + on-screen.
    //   peel — {wasGrouped, isAnchor, startCluster} from grab time; an
    //   unsnapped module release arms the peel cooldown so the card doesn't
    //   instantly re-link off a surviving flush seam on the next quick drag.
    async function snapOnRelease(towedLabels, peel) {
      var towed = (towedLabels || []).slice();
      try {
        var S = window.LunaDeckSnap;
        var ins = readInsets();
        var self = await logicalRect(W);
        var lead = S.insetRect({ x: self.x, y: self.y, w: self.w, h: self.h }, ins);
        var raw = await candidateRects([label].concat(towed));
        // Panels magnet to other PANELS, not to the moon hub. The orb is small
        // and always somewhere on screen, so including it made a lone window
        // (nothing else around) jump flush to the orb on release — surprising.
        // Drop the hub from the snap candidates; with no sibling panels there's
        // simply nothing to snap to and the window stays where you released it.
        var cards = raw
          .filter(function (c) { return c.label !== HUB; })
          .map(function (c) { return { label: c.label, rect: S.insetRect(c.rect, ins) }; });
        var best = S.computeEdgeSnap(lead, cards, {
          threshold: EDGE_SNAP_THRESHOLD,
          cornerThreshold: CORNER_ALIGN_THRESHOLD,
          minOverlap: MIN_PERP_OVERLAP,
        });
        var TW = window.__TAURI__ && window.__TAURI__.window;
        var LP = TW && TW.LogicalPosition;
        var PP = TW && TW.PhysicalPosition;
        // Hard no-overlap pass: the edge magnet only clears the ONE neighbour it
        // docks against, so resolve against EVERY other card — INCLUDING the hub
        // and IGNORING the peel cooldown (includeCooldown=true) — so a released
        // window can NEVER end up layered on a second window, the hub, or a
        // just-peeled card. tgt = where the magnet wanted me (or my own lead if
        // no magnet); resolved = the nearest non-overlapping card top-left.
        var rawAll = await candidateRects([label].concat(towed), true);
        // Overlap resolution considers only DOCKABLE PANELS, not the moon hub:
        // the orb is small and floats, so wedging a panel against it (or letting
        // it block a clear push) just causes the resolver to oscillate. Panels
        // must never overlap each OTHER; brushing the orb is acceptable.
        var allCards = rawAll
          .filter(function (c) { return c.label !== HUB; })
          .map(function (c) { return S.insetRect(c.rect, ins); });
        var tgt = best ? { x: best.x, y: best.y } : { x: lead.x, y: lead.y };
        // Bound the no-overlap push to THIS monitor's usable rect (logical/card
        // space) so it never shoves the window off-screen — macOS would clamp it
        // back on and re-introduce the overlap. GROUND TRUTH first: the
        // monitor_work_areas command returns NSScreen.visibleFrame per display
        // (screen minus menu bar AND Dock, correct on notched and non-notched
        // Macs and on every secondary display). The old MENU_BAR_INSET=37
        // heuristic over-inset non-notched primaries — a ~12px dead band where
        // every top-of-screen snap was discarded ("magnet line off").
        var bounds = null;
        try {
          var invokeWA = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
          if (invokeWA) {
            var cxw = self.x + self.w / 2, cyw = self.y + self.h / 2;
            var areas = await invokeWA('monitor_work_areas');
            if (Array.isArray(areas) && areas.length) {
              var pickWork = null;
              for (var ai = 0; ai < areas.length; ai++) {
                var fr = areas[ai] && areas[ai].frame, wk = areas[ai] && areas[ai].work;
                if (!fr || !wk) continue;
                if (!pickWork) pickWork = wk; // fallback: first display
                if (cxw >= fr.x && cxw < fr.x + fr.w && cyw >= fr.y && cyw < fr.y + fr.h) { pickWork = wk; break; }
              }
              if (pickWork) bounds = { x: pickWork.x, y: pickWork.y, w: pickWork.w, h: pickWork.h };
            }
          }
        } catch (_) { bounds = null; }
        // Fallback (non-macOS / older runtime / tests): FULL monitor rect from
        // availableMonitors() (the proven path; currentMonitor() returns null
        // under withGlobalTauri here) inset by the conservative menu-bar
        // allowance on the primary. PHYSICAL px → logical by /scaleFactor.
        // Degrade gracefully to no bounds.
        if (!bounds) try {
          if (TW && typeof TW.availableMonitors === 'function') {
            var cx = self.x + self.w / 2, cy = self.y + self.h / 2;
            var mons = await TW.availableMonitors();
            if (Array.isArray(mons) && mons.length) {
              var pick = mons[0];
              for (var mi = 0; mi < mons.length; mi++) {
                var mm = mons[mi], ms = mm.scaleFactor || 1;
                var mx = mm.position.x / ms, my = mm.position.y / ms, mw = mm.size.width / ms, mh = mm.size.height / ms;
                if (cx >= mx && cx < mx + mw && cy >= my && cy < my + mh) { pick = mm; break; }
              }
              var psf = pick.scaleFactor || 1;
              bounds = { x: pick.position.x / psf, y: pick.position.y / psf, w: pick.size.width / psf, h: pick.size.height / psf };
              // Inset the menu bar on the primary monitor only: the macOS menu bar
              // sits at the global top (origin y==0). Raise the top edge and shrink
              // height so a card can't resolve under it; other edges stay full-rect.
              if (bounds.y === 0) { bounds.y += MENU_BAR_INSET; bounds.h -= MENU_BAR_INSET; }
            }
          }
        } catch (_) { bounds = null; }
        // Discard a snap target that would land the CARD off-screen. Snapping to a
        // partly-visible neighbour's VISIBLE edge stays on-screen and flush;
        // snapping to its OFF-SCREEN edge would be clamped by the OS to a NON-flush
        // position (the big gap the user saw). Reject it → no snap, the window
        // rests where it was dropped instead of clamping to a gap.
        if (best && bounds) {
          var offX = best.x < bounds.x || best.x + lead.w > bounds.x + bounds.w;
          var offY = best.y < bounds.y || best.y + lead.h > bounds.y + bounds.h;
          if (offX || offY) { best = null; tgt = { x: lead.x, y: lead.y }; }
        }
        // De-overlap works on the whole RIGID unit: my card plus any towed
        // children (they ride every position write). The union bbox at the
        // target must clear every external card and stay in bounds; the lead
        // then applies the bbox's clearing delta. With no towed members the
        // bbox IS the lead card — byte-for-byte the old single-card maths.
        var unit = { x: lead.x, y: lead.y, w: lead.w, h: lead.h };
        if (towed.length) {
          var live = await weldMembers();
          for (var ti = 0; ti < live.length; ti++) {
            if (towed.indexOf(live[ti].label) === -1) continue;
            var tc = S.insetRect(live[ti].rect, ins);
            var ur = Math.max(unit.x + unit.w, tc.x + tc.w);
            var ub = Math.max(unit.y + unit.h, tc.y + tc.h);
            unit.x = Math.min(unit.x, tc.x);
            unit.y = Math.min(unit.y, tc.y);
            unit.w = ur - unit.x;
            unit.h = ub - unit.y;
          }
        }
        var unitAtTgt = { x: unit.x + (tgt.x - lead.x), y: unit.y + (tgt.y - lead.y), w: unit.w, h: unit.h };
        var resolvedUnit = S.resolveOverlap(unitAtTgt, allCards, bounds ? { maxIter: 12, bounds: bounds } : { maxIter: 12 });
        var resolved = { x: tgt.x + (resolvedUnit.x - unitAtTgt.x), y: tgt.y + (resolvedUnit.y - unitAtTgt.y) };
        var moved = !(resolved.x === tgt.x && resolved.y === tgt.y);
        // Peel cooldown (mirrors the emulated path's onDragUp): a module that
        // left its cluster and released UNSNAPPED briefly ignores its old
        // cluster as a snap target, so the next quick drag can't insta-relink
        // off a surviving flush seam. Anchors never peel (they tow).
        if (peel && peel.wasGrouped && !peel.isAnchor && !best) {
          exMembers = peel.startCluster.filter(function (l) { return l !== label; });
          exUntil = Date.now() + 1500;
        }

        if (best && !moved) {
          // Clean common case — deoverlap didn't move it: keep the pixel-exact
          // physical weld seam unchanged. Anchor my physical frame to the
          // neighbour's ACTUAL physical frame so the touching card edges coincide
          // on the exact same physical pixel (no OS per-window rounding seam),
          // preserving the snapped perpendicular offset. Falls back to
          // LogicalPosition if Tauri types or neighbour reads are unavailable.
          var placed = false;
          if (PP && S.physicalSnapEdge) {
            try {
              var ss = await W.outerSize();
              var nb = await TW.Window.getByLabel(best.label);
              var np = await nb.outerPosition();
              var ns2 = await nb.outerSize();
              var sf = (await W.scaleFactor()) || 1;
              var neighbourPhys = { x: np.x, y: np.y, w: ns2.width, h: ns2.height };
              var neighbourCard = null;
              for (var ci = 0; ci < cards.length; ci++) {
                if (cards[ci].label === best.label) { neighbourCard = cards[ci].rect; break; }
              }
              if (neighbourCard) {
                var o = S.physicalSnapEdge(neighbourPhys, neighbourCard, { x: best.x, y: best.y }, { w: ss.width, h: ss.height }, best.edge, ins, sf);
                await W.setPosition(new PP(o.x, o.y));
                placed = true;
              }
            } catch (_) { /* fall through to logical fallback */ }
          }
          if (!placed && LP) {
            // card target → frame target (subtract my own top/left inset).
            try { await W.setPosition(new LP(best.x - ins.l, best.y - ins.t)); } catch (_) {}
          }
        } else if (LP && (moved || !best)) {
          // Safety path — deoverlap moved me, or there was no edge-snap at all:
          // position at the resolved card top-left as a frame LogicalPosition.
          // The no-overlap guarantee beats sub-pixel weld perfection here.
          try { await W.setPosition(new LP(resolved.x - ins.l, resolved.y - ins.t)); } catch (_) {}
        }

        // Only emit dock-link / flashSeam for a REAL magnet dock (best exists).
        if (best && best.label !== HUB) {
          flashSeam(oppositeEdge(best.edge));
          try { var e2 = ev(); if (e2 && e2.emit) e2.emit('dock-link', { 'for': best.label, from: label, edge: best.edge }); } catch (_) {}
        }
      } catch (_) { /* best-effort */ }
      refreshWeld();          // settle my own weld from the real (snapped) rect
      broadcastGeometry();    // neighbours re-square their corners around me
    }

    document.addEventListener('pointerdown', function (e) {
      if (sm.phase !== 'idle') return;            // a drag is already arming/active
      if (e.button !== 0) return;
      if (!e.target || !e.target.closest) return;
      if (e.target.closest('button')) return;     // buttons are clicks, not grabs
      // Native macOS traffic lights are AppKit views, not DOM <button>s, so the
      // guard above misses them — a mousedown over the light band would arm a
      // window drag and swallow the click. overLights is skin-gated (false unless
      // the native hover-lights are active), so classic is unaffected.
      try {
        if (window.LunaNativeTitlebar && window.LunaNativeTitlebar.overLights &&
            window.LunaNativeTitlebar.overLights(e.clientX, e.clientY)) return;
      } catch (_) { /* never block dragging on a chrome hiccup */ }
      var handle = e.target.closest('.title-bar, .chat-header');
      if (!handle) return;
      e.preventDefault();
      // EVERY drag goes NATIVE: hand it to the OS (zero per-frame IPC) and snap
      // to a neighbour ONCE on RELEASE. The OLD emulated live-magnet path
      // (below) wrote a setPosition every frame and LOCKED the window at a
      // distance from the edge — the "invisible wall" the user hits on a slow
      // drag — and a stale `groupMembers` could route even a lone window onto
      // it. Native has NO live position writes, so it cannot wall; the window
      // tracks the cursor 1:1 and only snaps when you let go. The emulated path
      // is kept solely as a non-Tauri / test fallback (no startDragging).
      if (typeof W.startDragging === 'function') {
        // Same manner as the emulated path: the ANCHOR tows its whole welded
        // cluster (as native child windows — begin_cluster_drag), a plain
        // module peels off alone. `peel` feeds the release-time cooldown.
        var natStartCluster = groupMembers.slice();
        var natGrouped = natStartCluster.length > 1;
        var natIsAnchor = (label === 'panel-chat');
        var natTowed = (natIsAnchor && natGrouped)
          ? natStartCluster.filter(function (l) { return l !== label && l !== HUB; })
          : [];
        startNativeDrag(natTowed, {
          wasGrouped: natGrouped, isAnchor: natIsAnchor, startCluster: natStartCluster,
        });
        return;
      }
      // idle → arming: capture the handle now; the snapshot below promotes us to
      // 'dragging' (or a release mid-snapshot leaves us to be reset by onDragUp).
      sm.phase = 'arming'; sm.handle = handle; sm.pid = e.pointerId;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      handle.addEventListener('pointermove', onDragMove);
      handle.addEventListener('pointerup', onDragUp);
      handle.addEventListener('pointercancel', onDragUp);
      var sh0 = dockShell(); if (sh0) sh0.classList.add('dragging');
      var sx = e.screenX, sy = e.screenY;
      (async function () {
        try {
          var TW = window.__TAURI__ && window.__TAURI__.window;
          var isAnchor = (label === 'panel-chat');
          var startCluster = groupMembers.slice();
          var wasGrouped = startCluster.length > 1;
          // Anchor tows the whole cluster; a plain module peels off alone.
          var groupLabels = (isAnchor && wasGrouped) ? startCluster.slice() : [label];
          var self = await logicalRect(W);
          var members = [];
          for (var i = 0; i < groupLabels.length; i++) {
            var lbl = groupLabels[i];
            if (lbl === label) { members.push({ label: label, win: W, ox: self.x, oy: self.y }); continue; }
            try {
              var w = TW && TW.Window && typeof TW.Window.getByLabel === 'function'
                ? await TW.Window.getByLabel(lbl) : null;
              if (!w) continue;
              var r = await logicalRect(w);
              members.push({ label: lbl, win: w, ox: r.x, oy: r.y });
            } catch (_) { /* member vanished mid-snapshot */ }
          }
          var cands = await candidateRects(groupLabels);
          // Monitor layout, captured ONCE (it can't change mid-drag) so every
          // pointermove can place a target on whatever display it lands on at
          // that display's DPI — PHYSICAL px straight from Tauri:
          // { x, y, w, h, sf } per monitor. Empty/unavailable (single monitor,
          // non-Tauri) → onDragMove keeps writing LogicalPosition.
          var monitors = [];
          try {
            if (TW && typeof TW.availableMonitors === 'function') {
              var mons = await TW.availableMonitors();
              if (Array.isArray(mons)) {
                monitors = mons.map(function (mo) {
                  return { x: mo.position.x, y: mo.position.y, w: mo.size.width, h: mo.size.height, sf: mo.scaleFactor || 1 };
                });
              }
            }
          } catch (_) { /* unavailable → LogicalPosition fallback */ }
          if (sm.phase !== 'arming' || sm.handle !== handle) return; // released/replaced mid-snapshot
          // arming → dragging: sm holds handle/pid; ctx holds the snapshot
          // (geometry inputs + the live snap results filled in by onDragMove).
          sm.ctx = {
            sx: sx, sy: sy,
            ox: self.x, oy: self.y, ow: self.w, oh: self.h,
            members: members, cands: cands, monitors: monitors,
            // card insets captured once so the live snap aligns card FACES, not
            // OS frames (computeLiveDrag runs in card-face space).
            insets: readInsets(),
            isAnchor: isAnchor, wasGrouped: wasGrouped, startCluster: startCluster,
            snapped: false, anchor: null, edge: null
          };
          sm.phase = 'dragging';
        } catch (_) { /* snapshot failed — onDragUp/endDrag clean up */ }
      })();
    }, true);

    // ── Cross-window coordination ──────────────────────────────────────────
    // Recompute my weld whenever ANY dock window reports a geometry change, and
    // whenever I am resized. The seam flash is still a targeted hint from the
    // window that just linked onto me (now emitted by page JS, not Rust).
    try {
      var e = ev();
      if (e && e.listen) {
        // A neighbour's geometry changed (its onDragUp / onResized / boot) — re-
        // square my welded corners against the new positions. No shape mutation,
        // so this is safe to run on any tick.
        e.listen('dock-geometry-changed', function () {
          refreshWeld();  // immediate repaint (responsive; the event can read a
          scheduleWeld(); // mid-settle position, so re-read once it goes quiet —
                          // that trailing pass is what un-sticks the seam band)
        }).catch(function () {});
      }
      if (typeof W.listen === 'function') {
        W.listen('dock-link', function (ev2) {
          var p = ev2 && ev2.payload;
          if (!p || p['for'] !== label) return;
          flashSeam(p.edge); // anchor side: our touching side IS the edge
          // A freshly-spawned sibling just docked — re-square our welded corners
          // now, then again once its position settles (trailing pass).
          refreshWeld();
          scheduleWeld();
        }).catch(function () {});
      }
      // My own native resize changes the weld for my neighbours too.
      if (typeof W.onResized === 'function') {
        W.onResized(function () { refreshWeld(); scheduleWeld(); broadcastGeometry(); }).catch(function () {});
      }
      // OS-miniaturize (the native yellow light) and its restore have no Tauri
      // window event, but WKWebView flips this document's visibilityState both
      // ways. Broadcast so the siblings recompute (weldMembers excludes a
      // minimized member — no more ghost weld toward the hole) and settle my
      // own weld again on restore. Occlusion-driven false positives are
      // harmless: the recompute is idempotent.
      document.addEventListener('visibilitychange', function () {
        refreshWeld();
        scheduleWeld();
        broadcastGeometry();
      });
    } catch (_) { /* best-effort */ }

    // Reference `.dock-win.entering` pop — play once when we land grouped after
    // snap-on-open (or a drag settle that created a fresh link).
    function playEntering() {
      var sh = dockShell();
      if (!sh || groupMembers.length < 2) return;
      sh.classList.add('entering');
      sh.addEventListener('animationend', function () { sh.classList.remove('entering'); }, { once: true });
    }

    // Snap-on-open builds the webview HIDDEN at the OS-default spot. This window
    // now OWNS its placement: it computes the flush dock position in JS
    // (dockSelfOnOpen → LunaDeckSnap.dockOnOpenPosition) and asks Rust to
    // position + reveal it (dock_self). A boot-restored window is already
    // visible — it skips placement and just re-welds. So hidden-at-boot ===
    // fresh snap-on-open (the same invariant the old poll relied on).
    async function bootSettle() {
      var freshSnap = false;
      try { freshSnap = (await W.isVisible()) === false; } catch (_) { /* default: already visible */ }
      if (freshSnap) {
        await dockSelfOnOpen(); // positions + reveals this window flush to its cluster
      }
      try {
        // Two rAFs: let the set_position land before we read rects for the weld.
        await new Promise(function (r) {
          requestAnimationFrame(function () { requestAnimationFrame(r); });
        });
      } catch (_) { /* best-effort */ }
      await refreshWeld();
      broadcastGeometry();
      // Pop-in only for a genuine fresh snap-on-open; boot-restored windows skip it.
      if (freshSnap) { playEntering(); }
    }
    bootSettle();
  }

  g.LunaDock = { wire: wire };
})(typeof globalThis !== 'undefined' ? globalThis : this);
