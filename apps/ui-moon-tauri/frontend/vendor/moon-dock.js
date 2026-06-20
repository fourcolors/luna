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
 * Drag is the design's live model: title-bar pointerdown captures the drag
 * group (the anchor tows its whole cluster; a plain module peels off alone),
 * every pointermove runs LunaDeckSnap.computeLiveDrag and setPositions the
 * group 1:1 so it glides into place and welds the instant it falls within
 * magnet range, and pointerup just stops — whatever is flush is welded.
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

  function wire(opts) {
    var W = opts && opts.win;
    var label = opts && opts.label;
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

    // Every WIDGET dock window (incl. me) as [{label, rect}] — the hub is never
    // a weld member, and list_widget_windows already excludes it.
    async function weldMembers() {
      var TW = window.__TAURI__ && window.__TAURI__.window;
      var out = [];
      try { out.push({ label: label, rect: await logicalRect(W) }); } catch (_) { return out; }
      try {
        var labels = await window.__TAURI__.core.invoke('list_widget_windows');
        if (Array.isArray(labels)) {
          for (var i = 0; i < labels.length; i++) {
            if (labels[i] === label) continue;
            try {
              var w = await TW.Window.getByLabel(labels[i]);
              if (!w) continue;
              out.push({ label: labels[i], rect: await logicalRect(w) });
            } catch (_) { /* sibling vanished mid-enumeration */ }
          }
        }
      } catch (_) { /* listing unavailable */ }
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
    var refreshing = false;
    async function refreshWeld() {
      if (refreshing) return;
      refreshing = true;
      try { paintWeldFrom(await weldMembers()); }
      catch (_) { /* best-effort */ }
      finally { refreshing = false; }
    }

    // Snap candidates: the hub first (it wins distance ties), then every sibling
    // widget — minus anything in `exclude` (the drag group never re-snaps to
    // itself) and minus a just-peeled cluster during its cooldown.
    async function candidateRects(exclude) {
      var out = [];
      var TW = window.__TAURI__ && window.__TAURI__.window;
      var skip = (exclude || groupMembers).slice();
      if (Date.now() < exUntil) skip = skip.concat(exMembers);
      try {
        if (skip.indexOf(HUB) === -1) {
          var mainWin = TW && TW.Window && typeof TW.Window.getByLabel === 'function'
            ? await TW.Window.getByLabel(HUB) : null;
          if (mainWin) out.push({ label: HUB, rect: await logicalRect(mainWin) });
        }
      } catch (_) { /* hub unavailable — keep going */ }
      try {
        var labels = await window.__TAURI__.core.invoke('list_widget_windows');
        if (Array.isArray(labels)) {
          for (var i = 0; i < labels.length; i++) {
            if (labels[i] === label || skip.indexOf(labels[i]) !== -1) continue;
            try {
              var w = await TW.Window.getByLabel(labels[i]);
              if (!w) continue;
              out.push({ label: labels[i], rect: await logicalRect(w) });
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
    var sm = { phase: 'idle', handle: null, pid: null, ctx: null };

    // Any phase → idle: release capture, detach listeners, drop the affordance
    // classes. Safe to call from 'arming' (no ctx yet) or 'dragging'.
    function endDrag() {
      if (sm.handle) {
        try { sm.handle.releasePointerCapture(sm.pid); } catch (_) {}
        sm.handle.removeEventListener('pointermove', onDragMove);
        sm.handle.removeEventListener('pointerup', onDragUp);
        sm.handle.removeEventListener('pointercancel', onDragUp);
      }
      sm.phase = 'idle'; sm.handle = null; sm.pid = null; sm.ctx = null;
      var sh = dockShell();
      if (sh) {
        sh.classList.remove('dragging');
        setTimeout(function () { var s = dockShell(); if (s) s.classList.remove('snapping'); }, 200);
      }
    }

    function onDragMove(e) {
      if (sm.phase !== 'dragging') return;
      var drag = sm.ctx;
      var S = window.LunaDeckSnap;
      var dx = e.screenX - drag.sx, dy = e.screenY - drag.sy;
      var res = S.computeLiveDrag({
        ox: drag.ox, oy: drag.oy, ow: drag.ow, oh: drag.oh, dx: dx, dy: dy,
        members: drag.members.map(function (m) { return { label: m.label, ox: m.ox, oy: m.oy }; })
      }, drag.cands, undefined, drag.insets);
      drag.snapped = res.snapped; drag.anchor = res.anchor; drag.edge = res.edge;
      // Position every member. Targets are LOGICAL (CSS-point) top-lefts. When
      // we captured a monitor layout, resolve each to a PHYSICAL position using
      // the DESTINATION monitor's DPI and write THAT — a LogicalPosition write
      // rides the dragged window's live (seam-bistable) scale factor and
      // flickers across a mixed-DPI boundary. No layout (single monitor /
      // non-Tauri) → the original LogicalPosition path, byte-for-byte.
      var TW = window.__TAURI__ && window.__TAURI__.window;
      var PP = TW && TW.PhysicalPosition;
      var LP = TW && TW.LogicalPosition;
      var mons = drag.monitors;
      for (var i = 0; i < res.targets.length; i++) {
        var m = drag.members[i];
        if (!m || !m.win) continue;
        var t = res.targets[i];
        var phys = (PP && mons && mons.length) ? LunaDeckSnap.logicalToPhysical(t.x, t.y, mons) : null;
        try {
          if (phys) m.win.setPosition(new PP(phys.x, phys.y));
          else if (LP) m.win.setPosition(new LP(t.x, t.y));
        } catch (_) {}
      }
      if (g.__LUNA_DOCK_DEBUG) {
        try { console.log('[luna-dock] move', { screenX: e.screenX, screenY: e.screenY, lead: { x: drag.ox + dx, y: drag.oy + dy }, target0: res.targets[0], phys0: (mons && mons.length ? LunaDeckSnap.logicalToPhysical(res.targets[0].x, res.targets[0].y, mons) : null), monitors: mons }); } catch (_) {}
      }
      // Weld VISUALS (corner squaring, seam silhouette, per-side margins) are
      // FROZEN during the drag and recomputed exactly once on drop
      // (onDragUp → refreshWeld). Repainting them per pointer-move — on the
      // dragged card AND, via a mid-drag broadcast, on every stationary
      // neighbour — is what made the borders flicker/square mid-drag. The only
      // live affordance kept is the predictive snap ring (.snapping), which is a
      // pure box-shadow and never touches geometry.
      var sh = dockShell();
      if (sh) sh.classList.toggle('snapping', !!res.snapped);
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
          refreshWeld();
        }).catch(function () {});
      }
      if (typeof W.listen === 'function') {
        W.listen('dock-link', function (ev2) {
          var p = ev2 && ev2.payload;
          if (!p || p['for'] !== label) return;
          flashSeam(p.edge); // anchor side: our touching side IS the edge
          // A freshly-spawned sibling just docked — re-square our welded corners
          // immediately (don't wait for its boot broadcast).
          refreshWeld();
        }).catch(function () {});
      }
      // My own native resize changes the weld for my neighbours too.
      if (typeof W.onResized === 'function') {
        W.onResized(function () { refreshWeld(); broadcastGeometry(); }).catch(function () {});
      }
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
