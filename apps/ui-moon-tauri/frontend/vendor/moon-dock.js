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

    // Broadcast "geometry changed" so every other dock window recomputes its
    // weld. A global emit (not emit_to) is correct here: this tick is FOR
    // everyone, unlike the old targeted dock-group payloads.
    // `settled` distinguishes a mid-drag tick (false → neighbours repaint
    // radius only, no inset resize while someone is dragging) from a settle
    // tick (true → neighbours also collapse/restore their per-side inset so a
    // docked-onto neighbour's seam closes flush, not just the dragged window).
    function broadcastGeometry(settled) {
      try { var e = ev(); if (e && e.emit) e.emit('dock-geometry-changed', { from: label, settled: !!settled }); } catch (_) { /* best-effort */ }
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
    // Maps the pure geometry results onto the card: square the flagged corners,
    // draw the perimeter outline, and cast the unified silhouette shadow so a
    // welded cluster reads as one card. Identical DOM contract to the old
    // applyGroupState — only the SOURCE moved from a Rust IPC payload to the
    // local LunaDeckSnap.weld* computation.
    //
    // applyInset (boolean, default false):
    //   When true AND grouped: collapses per-side margin to 0 on welded sides
    //   and recomputes height/width per axis so welded OS windows produce zero
    //   gap between painted cards (Fix 2 Option B). Free sides keep --card-inset.
    //   When true AND NOT grouped: clears all six inline styles back to '' so
    //   the CSS class defaults restore (mirrors the radius '' clear).
    //   When false: margin/size styles are left untouched — mid-drag calls
    //   (paintWeldFrom from onDragMove) pass false so the card never resizes
    //   per-frame during a live drag.
    //   NO CSS transition for margin/width/height — inset changes are instant.
    function applyWeldVisuals(grouped, outlineSides, weldCorners, applyInset) {
      groupMembers = grouped ? groupMembers : [];
      if (outlineEl) {
        outlineEl.className = grouped ? outlineSides.map(function (s) { return 'g' + s; }).join(' ') : '';
      }
      var shellEl = document.querySelector('.widget-shell');
      if (!shellEl) return;
      var radius = function (corner) { return grouped && weldCorners.indexOf(corner) !== -1 ? '0px' : ''; };
      shellEl.style.borderTopLeftRadius = radius('tl');
      shellEl.style.borderTopRightRadius = radius('tr');
      shellEl.style.borderBottomRightRadius = radius('br');
      shellEl.style.borderBottomLeftRadius = radius('bl');
      var barEl = document.querySelector('.title-bar');
      if (barEl) {
        barEl.style.borderTopLeftRadius = radius('tl');
        barEl.style.borderTopRightRadius = radius('tr');
      }
      if (grouped) {
        var isAnchor = label === 'panel-chat';
        var pieces = ['var(--dk-edge-amb)'];
        if (outlineSides.indexOf('t') !== -1) pieces.push('var(--dk-edge-t)');
        if (outlineSides.indexOf('b') !== -1) pieces.push(isAnchor ? 'var(--dk-edge-b-anchor)' : 'var(--dk-edge-b)');
        if (outlineSides.indexOf('l') !== -1) pieces.push('var(--dk-edge-l)');
        if (outlineSides.indexOf('r') !== -1) pieces.push('var(--dk-edge-r)');
        var welded = ['t', 'b', 'l', 'r'].filter(function (e) { return outlineSides.indexOf(e) === -1; });
        shellEl.setAttribute('data-weld', welded.join(''));
        shellEl.style.boxShadow = pieces.join(', ');
        // Fix 2b — sync #seam flash bar offsets to match the per-side inset.
        // #seam is position:fixed (resolves to the OS-window viewport, not the
        // .widget-shell), so when Fix 2 collapses a welded side's card margin to
        // 0px the CSS `var(--card-inset)` offset on the matching flash bar lands
        // 22px INSIDE the now-flush card face. We override per-side with 0px on
        // welded sides via CSS custom properties; the flash-* rules use
        // `var(--seam-<side>, var(--card-inset))` so only the welded sides move.
        if (seamEl) {
          seamEl.style.setProperty('--seam-t', welded.indexOf('t') !== -1 ? '0px' : '');
          seamEl.style.setProperty('--seam-r', welded.indexOf('r') !== -1 ? '0px' : '');
          seamEl.style.setProperty('--seam-b', welded.indexOf('b') !== -1 ? '0px' : '');
          seamEl.style.setProperty('--seam-l', welded.indexOf('l') !== -1 ? '0px' : '');
        }
        // Fix 2 — per-side inset collapse on welded edges (settle/boot/resize only;
        // mid-drag calls pass applyInset=false to avoid per-frame card resizing).
        if (applyInset) {
          var mt = outlineSides.indexOf('t') !== -1 ? 'var(--card-inset)' : '0px';
          var mr = outlineSides.indexOf('r') !== -1 ? 'var(--card-inset)' : '0px';
          var mb = outlineSides.indexOf('b') !== -1 ? 'var(--card-inset)' : '0px';
          var ml = outlineSides.indexOf('l') !== -1 ? 'var(--card-inset)' : '0px';
          shellEl.style.marginTop    = mt;
          shellEl.style.marginRight  = mr;
          shellEl.style.marginBottom = mb;
          shellEl.style.marginLeft   = ml;
          // Must recompute per axis from the ACTUAL per-side margins; leaving the
          // CSS default `calc(100% - var(--card-inset)*2)` while one margin is 0
          // produces a 22px dead zone where the card stops short of the OS edge.
          shellEl.style.height = 'calc(100% - ' + mt + ' - ' + mb + ')';
          shellEl.style.width  = 'calc(100% - ' + ml + ' - ' + mr + ')';
          // macOS traffic-light guard: when margin-top collapses to 0 on a TOP
          // weld, the title bar shifts to y=0 while native lights stay at y=42
          // (main.rs traffic_light_position), floating them into content.
          // Add padding-top here (inline, same timing as margin collapse) rather
          // than in CSS keyed on [data-weld] — data-weld is stamped mid-drag too,
          // which would cause a transient 22px title-bar growth during live drag
          // (the margin-top only collapses at settle, not mid-drag).
          var barEl = shellEl.querySelector('.title-bar');
          if (barEl) {
            barEl.style.paddingTop = welded.indexOf('t') !== -1 ? 'var(--card-inset)' : '';
          }
          // Fix: grain overlay (body::after position:fixed) uses --seam-* props
          // already written above; body::after CSS reads them via per-side custom
          // properties (set on the #seam element). Instead, propagate the same
          // inset values onto document.documentElement so body::after can read them.
          var root = document.documentElement;
          root.style.setProperty('--grain-t', welded.indexOf('t') !== -1 ? '0px' : '');
          root.style.setProperty('--grain-r', welded.indexOf('r') !== -1 ? '0px' : '');
          root.style.setProperty('--grain-b', welded.indexOf('b') !== -1 ? '0px' : '');
          root.style.setProperty('--grain-l', welded.indexOf('l') !== -1 ? '0px' : '');
        }
      } else {
        shellEl.removeAttribute('data-weld');
        shellEl.style.boxShadow = '';
        // Fix 2b — clear seam offsets when ungrouped so the flash bars revert
        // to the CSS default (var(--card-inset)) via the cascade fallback.
        if (seamEl) {
          seamEl.style.removeProperty('--seam-t');
          seamEl.style.removeProperty('--seam-r');
          seamEl.style.removeProperty('--seam-b');
          seamEl.style.removeProperty('--seam-l');
        }
        // Fix 2 — restore CSS class defaults when ungrouped ('' = clear inline,
        // restoring the class-level `margin: var(--card-inset)` and calc sizes).
        // UNCONDITIONAL (no applyInset guard) — mirrors the unconditional radius
        // reset above. When a card peels away mid-drag its corners un-square
        // immediately; if inset were still gated behind applyInset=false the
        // previously-collapsed margin would stay at 0px until onDragUp, producing
        // a rounded corner flush against the OS window edge for the drag duration.
        shellEl.style.marginTop    = '';
        shellEl.style.marginRight  = '';
        shellEl.style.marginBottom = '';
        shellEl.style.marginLeft   = '';
        shellEl.style.height       = '';
        shellEl.style.width        = '';
        // Clear title-bar padding-top guard (set inline in the grouped branch).
        var barEl = shellEl.querySelector('.title-bar');
        if (barEl) { barEl.style.paddingTop = ''; }
        // Clear grain overlay per-side props on documentElement.
        var root = document.documentElement;
        root.style.removeProperty('--grain-t');
        root.style.removeProperty('--grain-r');
        root.style.removeProperty('--grain-b');
        root.style.removeProperty('--grain-l');
      }
    }

    // Compute + apply this window's weld from a member list [{label, rect}]
    // (which already excludes the hub). Returns my cluster's labels.
    // applyInset: when true, also collapses/restores per-side card margin for
    // welded/ungrouped state (Fix 2). Mid-drag calls omit this (default false)
    // so the card never resizes per-frame during a live drag.
    function paintWeldFrom(members, applyInset) {
      var S = window.LunaDeckSnap;
      var cluster = S.weldClusterOf(label, members);
      var grouped = cluster.length > 1;
      groupMembers = grouped ? cluster : [];
      var outline = grouped ? (S.weldOutlineSides(members)[label] || []) : [];
      var weld = grouped ? (S.weldCorners(members)[label] || []) : [];
      applyWeldVisuals(grouped, outline, weld, applyInset);
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

    // Fresh enumeration → repaint my weld. Cheap geometry, one IPC round of
    // window reads; runs on a geometry-changed tick / resize / boot, NOT per
    // pointermove (the drag paints locally from its start snapshot instead).
    // applyInset (default true): passed through to paintWeldFrom/applyWeldVisuals.
    //   false is used by the dock-geometry-changed listener so that a NEIGHBOR
    //   window's live-drag broadcast does NOT collapse this window's card margin
    //   mid-drag (avoids the asymmetric half-closed-seam while dragging). The
    //   dragged window's own onDragUp→refreshWeld() still passes true (default)
    //   so the full inset collapses correctly at settle.
    var refreshing = false;
    async function refreshWeld(applyInset) {
      if (refreshing) return;
      refreshing = true;
      var doInset = (applyInset === undefined) ? true : !!applyInset;
      try { paintWeldFrom(await weldMembers(), /*applyInset=*/doInset); }
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

    // ── LIVE magnetic drag ─────────────────────────────────────────────────
    function dockShell() { return document.querySelector('.widget-shell'); }
    var drag = null;          // active drag (after the start snapshot)
    var activeHandle = null;  // the title bar we captured (for cleanup)
    var activePid = null;

    function detachDrag() {
      if (activeHandle) {
        try { activeHandle.releasePointerCapture(activePid); } catch (_) {}
        activeHandle.removeEventListener('pointermove', onDragMove);
        activeHandle.removeEventListener('pointerup', onDragUp);
        activeHandle.removeEventListener('pointercancel', onDragUp);
      }
      activeHandle = null; activePid = null;
      var sh = dockShell();
      if (sh) {
        sh.classList.remove('dragging');
        setTimeout(function () { var s = dockShell(); if (s) s.classList.remove('snapping'); }, 200);
      }
    }

    function onDragMove(e) {
      if (!drag) return;
      var S = window.LunaDeckSnap;
      var dx = e.screenX - drag.sx, dy = e.screenY - drag.sy;
      var res = S.computeLiveDrag({
        ox: drag.ox, oy: drag.oy, ow: drag.ow, oh: drag.oh, dx: dx, dy: dy,
        members: drag.members.map(function (m) { return { label: m.label, ox: m.ox, oy: m.oy }; })
      }, drag.cands);
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
      // Paint MY seam live from the start snapshot (synchronous, no IPC): my
      // lead rect against the static neighbour rects captured at drag start.
      var lead = res.targets.length ? res.targets[0] : { x: drag.ox + dx, y: drag.oy + dy };
      paintWeldFrom(drag.weldNeighbors.concat([{ label: label, rect: { x: lead.x, y: lead.y, w: drag.ow, h: drag.oh } }]));
      var sh = dockShell();
      if (sh) sh.classList.toggle('snapping', !!res.snapped);
      // Let the window we're approaching repaint too — throttled to one tick
      // per animation frame so we don't flood the event bus mid-drag.
      if (!drag.tick) {
        drag.tick = true;
        requestAnimationFrame(function () { if (drag) { drag.tick = false; broadcastGeometry(); } });
      }
    }

    function onDragUp() {
      var d = drag; drag = null;
      detachDrag();
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
      broadcastGeometry(/*settled=*/true); // neighbours settle their per-side inset around the new position too
    }

    document.addEventListener('pointerdown', function (e) {
      if (activeHandle) return;                   // a drag is already in progress
      if (e.button !== 0) return;
      if (!e.target || !e.target.closest) return;
      if (e.target.closest('button')) return;     // buttons are clicks, not grabs
      var handle = e.target.closest('.title-bar, .chat-header');
      if (!handle) return;
      e.preventDefault();
      activeHandle = handle; activePid = e.pointerId;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      handle.addEventListener('pointermove', onDragMove);
      handle.addEventListener('pointerup', onDragUp);
      handle.addEventListener('pointercancel', onDragUp);
      var sh0 = dockShell(); if (sh0) sh0.classList.add('dragging');
      var sx = e.screenX, sy = e.screenY, pid = e.pointerId;
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
          if (activeHandle !== handle) return;    // released/replaced before we armed
          drag = {
            pointerId: pid, handle: handle, sx: sx, sy: sy,
            ox: self.x, oy: self.y, ow: self.w, oh: self.h,
            members: members, cands: cands, monitors: monitors,
            // weld neighbours = snap candidates minus the hub (hub never welds)
            weldNeighbors: cands.filter(function (c) { return c.label !== HUB; }),
            isAnchor: isAnchor, wasGrouped: wasGrouped, startCluster: startCluster,
            snapped: false, anchor: null, edge: null, tick: false
          };
        } catch (_) { /* snapshot failed — onDragUp/detachDrag clean up */ }
      })();
    }, true);

    // ── Cross-window coordination ──────────────────────────────────────────
    // Recompute my weld whenever ANY dock window reports a geometry change, and
    // whenever I am resized. The seam flash is still a targeted hint from the
    // window that just linked onto me (now emitted by page JS, not Rust).
    try {
      var e = ev();
      if (e && e.listen) {
        // A mid-drag tick (payload.settled=false, one per rAF) does a RADIUS-ONLY
        // repaint — collapsing this window's card margin while a NEIGHBOUR is being
        // dragged would resize a stationary card every frame. The SETTLE tick
        // (payload.settled=true, from a neighbour's onDragUp / onResized / boot)
        // DOES collapse/restore this window's per-side inset, so when a window docks
        // onto me MY side of the seam closes flush too — not just the dragged one.
        e.listen('dock-geometry-changed', function (evt) {
          var settled = !!(evt && evt.payload && evt.payload.settled);
          refreshWeld(/*applyInset=*/settled);
        }).catch(function () {});
      }
      if (typeof W.listen === 'function') {
        W.listen('dock-link', function (ev2) {
          var p = ev2 && ev2.payload;
          if (!p || p['for'] !== label) return;
          flashSeam(p.edge); // anchor side: our touching side IS the edge
        }).catch(function () {});
      }
      // My own native resize changes the weld for my neighbours too.
      if (typeof W.onResized === 'function') {
        W.onResized(function () { refreshWeld(); broadcastGeometry(/*settled=*/true); }).catch(function () {});
      }
    } catch (_) { /* best-effort */ }

    // Boot: paint my weld from current geometry and let neighbours repaint
    // around me (covers a boot-restored cluster and a freshly-spawned panel).
    refreshWeld();
    broadcastGeometry(/*settled=*/true);
  }

  g.LunaDock = { wire: wire };
})(typeof globalThis !== 'undefined' ? globalThis : this);
