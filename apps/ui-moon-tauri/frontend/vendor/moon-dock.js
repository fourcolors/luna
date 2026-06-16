/**
 * moon-dock.js — the dock/snap client wiring shared by every widget-page
 * window (widget.html, panel.html). Extracted verbatim from widget.html's
 * wireDeckSnap (Phase 2): snap-on-release against the hub + siblings, flat
 * symmetric dock groups driven entirely by Rust's window-targeted
 * `dock-group` / `dock-link` events, pin-to-detach, seam flash, perimeter
 * outline.
 *
 * Requires in the page: #seam, #outline elements and a
 * [data-tauri-drag-region] title bar. Requires vendor/deck-snap.js
 * (LunaDeckSnap) for the pure snap math.
 *
 * Usage: LunaDock.wire({ win: getCurrentWindow(), label: win.label })
 * Best-effort everywhere: every Tauri call is wrapped so errors never
 * propagate into the page.
 */
;(function (g) {
  'use strict';

  function wire(opts) {
    var W = opts && opts.win;
    var label = opts && opts.label;
    if (!W) return; // not in Tauri

    // The chat window is the cluster anchor — stamp data-anchor so moon-theme.css
    // gives its title bar the accent fill/title color (chat keeps its MoonFace
    // bar; this only re-tints the chrome, generically by attribute).
    if (label === 'panel-chat') {
      try { document.documentElement.setAttribute('data-anchor', 'true'); } catch (_) { /* best-effort */ }
    }

    var seamEl = document.getElementById('seam');
    var outlineEl = document.getElementById('outline');
    var groupMembers = []; // my group's labels (incl. me); [] = ungrouped
    var exMembers = [];    // just-left group, ignored as snap targets…
    var exUntil = 0;       // …until this time (no instant re-link after unpin)

    function setDock(docked, anchor, edge, dx, dy) {
      try {
        if (window.__TAURI__ && window.__TAURI__.core) {
          window.__TAURI__.core.invoke('set_dock', {
            docked: docked,
            anchor: docked ? anchor : null,
            edge: docked ? edge : null,
            dx: dx || 0,
            dy: dy || 0,
          }).then(function () {
            // Flash only on a CONFIRMED link — a swallowed error (anchor
            // closed mid-settle) must not fake the animation.
            if (docked) flashSeam(oppositeEdge(edge));
          }).catch(function () {});
        }
      } catch (_) { /* best-effort */ }
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

    // All link state renders from Rust's dock-group events — single source
    // of truth, no local pin/outline bookkeeping to drift out of sync.
    function applyGroupState(payload) {
      var grouped = !!(payload && payload.grouped);
      groupMembers = grouped && Array.isArray(payload.members) ? payload.members : [];
      if (!grouped && payload && Array.isArray(payload.exMembers) && payload.exMembers.length) {
        exMembers = payload.exMembers;
        exUntil = Date.now() + 1500;
      }
      if (outlineEl) {
        var sides = grouped && Array.isArray(payload.outlineSides) ? payload.outlineSides : [];
        outlineEl.className = sides.map(function (s) { return 'g' + s; }).join(' ');
      }
      // Per-corner weld radius: square ONLY the corners Rust flagged at an
      // interior seam (a partial weld keeps its still-exposed corners round);
      // clearing the inline value when ungrouped restores the skin's --dk-radius
      // rule. The wobbled ::before follows via border-radius:inherit, and the
      // title bar squares its matching TOP corners so the header tracks the card.
      var weld = grouped && Array.isArray(payload.weldCorners) ? payload.weldCorners : [];
      var shellEl = document.querySelector('.widget-shell');
      if (shellEl) {
        var radius = function (corner) { return weld.indexOf(corner) !== -1 ? '0px' : ''; };
        shellEl.style.borderTopLeftRadius = radius('tl');
        shellEl.style.borderTopRightRadius = radius('tr');
        shellEl.style.borderBottomRightRadius = radius('br');
        shellEl.style.borderBottomLeftRadius = radius('bl');
        var barEl = document.querySelector('.title-bar');
        if (barEl) {
          barEl.style.borderTopLeftRadius = radius('tl');
          barEl.style.borderTopRightRadius = radius('tr');
        }
        // Per-window silhouette shadow: a welded window drops the soft lip on
        // its interior (welded) edges and casts depth only from its EXPOSED
        // edges, so a docked cluster reads as one card rather than stacked
        // ones. Exposed edges == outlineSides (the perimeter); welded edges are
        // the complement. Inline wins over the skin/dark box-shadow rule; an
        // ungroup clears it so --dk-win-shadow (the solo lift) returns. The
        // dragged-window solo-lift opt-out is a documented v1 follow-up — this
        // ships the always-unified silhouette.
        if (grouped) {
          var outlineSides = Array.isArray(payload.outlineSides) ? payload.outlineSides : [];
          var isAnchor = label === 'panel-chat';
          var pieces = ['var(--dk-edge-amb)'];
          if (outlineSides.indexOf('t') !== -1) pieces.push('var(--dk-edge-t)');
          if (outlineSides.indexOf('b') !== -1) pieces.push(isAnchor ? 'var(--dk-edge-b-anchor)' : 'var(--dk-edge-b)');
          if (outlineSides.indexOf('l') !== -1) pieces.push('var(--dk-edge-l)');
          if (outlineSides.indexOf('r') !== -1) pieces.push('var(--dk-edge-r)');
          var welded = ['t', 'b', 'l', 'r'].filter(function (e) { return outlineSides.indexOf(e) === -1; });
          shellEl.setAttribute('data-weld', welded.join(''));
          shellEl.style.boxShadow = pieces.join(', ');
        } else {
          shellEl.removeAttribute('data-weld');
          shellEl.style.boxShadow = '';
        }
      }
      // Render the owned seam badges Rust placed for us — Rust is the single
      // source of truth for badge geometry (it has every member's rect in one
      // place and re-emits on resize), so the page does NO geometry fan-out and
      // never goes stale on a partner's resize.
      //
    }


    // ── LIVE magnetic drag (the design's onMove model) ─────────────────────
    // JS owns the drag now (data-tauri-drag-region is gone). pointerdown on a
    // title bar starts a JS drag; every pointermove computes the snapped target
    // for this window + its drag group via LunaDeckSnap.computeLiveDrag and
    // setPositions them, so the cluster glides into place LIVE and welds the
    // instant it falls within magnet range. pointerup links (if snapped) or
    // detaches a module dragged clear of its cluster. This replaces the old
    // grab_dock / native-drag / settle-on-release machinery.
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
      var dx = e.screenX - drag.sx, dy = e.screenY - drag.sy;
      var res = LunaDeckSnap.computeLiveDrag({
        ox: drag.ox, oy: drag.oy, ow: drag.ow, oh: drag.oh, dx: dx, dy: dy,
        members: drag.members.map(function (m) { return { label: m.label, ox: m.ox, oy: m.oy }; })
      }, drag.cands);
      drag.snapped = res.snapped; drag.anchor = res.anchor; drag.edge = res.edge;
      var LP = window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.LogicalPosition;
      if (LP) {
        for (var i = 0; i < res.targets.length; i++) {
          var m = drag.members[i];
          if (m && m.win) { try { m.win.setPosition(new LP(res.targets[i].x, res.targets[i].y)); } catch (_) {} }
        }
      }
      var sh = dockShell();
      if (sh) sh.classList.toggle('snapping', !!res.snapped);
    }

    function onDragUp() {
      var d = drag; drag = null;
      detachDrag();
      if (!d) return; // released before the start snapshot armed — nothing to commit
      if (d.snapped && d.anchor && d.anchor !== 'main') {
        setDock(true, d.anchor, d.edge, 0, 0);   // link — windows are already flush
      } else if (!d.snapped && d.wasGrouped && !d.isAnchor) {
        setDock(false);                           // detach — a module dragged clear
      }
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
          var wasGrouped = groupMembers.length > 1;
          // Anchor tows the whole cluster; a plain module peels off alone.
          var groupLabels = (isAnchor && wasGrouped) ? groupMembers.slice() : [label];
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
          if (activeHandle !== handle) return;    // released/replaced before we armed
          drag = {
            pointerId: pid, handle: handle, sx: sx, sy: sy,
            ox: self.x, oy: self.y, ow: self.w, oh: self.h,
            members: members, cands: cands, isAnchor: isAnchor, wasGrouped: wasGrouped,
            snapped: false, anchor: null, edge: null
          };
        } catch (_) { /* snapshot failed — onDragUp/detachDrag clean up */ }
      })();
    }, true);

    try {
      // W.listen (window-targeted), NOT the global event.listen: the global
      // API also delivers emit_to events aimed at OTHER windows, which made
      // third-party widgets adopt phantom group state (live-confirmed).
      // The payload's `for` field is the second lock on the same door.
      if (typeof W.listen === 'function') {
        W.listen('dock-link', function (e) {
          var p = e && e.payload;
          if (!p || p['for'] !== label) return;
          flashSeam(p.edge); // anchor side: our touching side IS the edge
        }).catch(function () {});
        W.listen('dock-group', function (e) {
          var p = e && e.payload;
          if (!p || p['for'] !== label) return;
          applyGroupState(p); // also schedules the seam-badge repaint
        }).catch(function () {});
      }
    } catch (_) { /* best-effort */ }

    // Replay-on-subscribe: a window whose dock-group event fired BEFORE this
    // webview finished loading (a boot-restored cluster races the page load)
    // pulls its current membership once, now that the listeners are wired — so
    // the pin button + self-snap skip reflect a restored group immediately
    // instead of only after the next membership change reaches it.
    try {
      if (window.__TAURI__ && window.__TAURI__.core) {
        window.__TAURI__.core.invoke('dock_group_state').then(function (p) {
          if (p && p['for'] === label) applyGroupState(p);
        }).catch(function () {});
      }
    } catch (_) { /* best-effort */ }

    // Snap candidates: the hub first (it wins distance ties), then every
    // sibling widget — minus anything already in our group (a group never
    // re-snaps against itself; that was round 2's "random movements").
    // All snap math runs in LOGICAL px: every window's physical rect is
    // divided by ITS OWN scale factor, so mixed-DPI monitor setups compare
    // coherently and the snap threshold stays the designed 30 logical px
    // (deck-snap DEFAULT_THRESHOLD = design SNAP = Rust MAGNET, all in lockstep).
    async function logicalRect(w) {
      var p = await w.outerPosition();
      var s = await w.outerSize();
      var sf = 1;
      try { sf = (await w.scaleFactor()) || 1; } catch (_) { /* default */ }
      return { x: p.x / sf, y: p.y / sf, w: s.width / sf, h: s.height / sf };
    }

    async function candidateRects(exclude) {
      var out = [];
      var TW = window.__TAURI__ && window.__TAURI__.window;
      var skip = (exclude || groupMembers).slice();
      if (Date.now() < exUntil) skip = skip.concat(exMembers);
      try {
        if (skip.indexOf('main') === -1) {
          var mainWin = TW && TW.Window && typeof TW.Window.getByLabel === 'function'
            ? await TW.Window.getByLabel('main')
            : null;
          if (mainWin) out.push({ label: 'main', rect: await logicalRect(mainWin) });
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

  }

  g.LunaDock = { wire: wire };
})(typeof globalThis !== 'undefined' ? globalThis : this);
