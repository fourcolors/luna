/**
 * moon-dock.js — the dock/snap client wiring shared by every widget-page
 * window (widget.html, panel.html). Extracted verbatim from widget.html's
 * wireDeckSnap (Phase 2): snap-on-release against the hub + siblings, flat
 * symmetric dock groups driven entirely by Rust's window-targeted
 * `dock-group` / `dock-link` events, pin-to-detach, seam flash, perimeter
 * outline.
 *
 * Requires in the page: #pin-btn, #seam, #outline elements and a
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

    var pinBtn = document.getElementById('pin-btn');
    var seamEl = document.getElementById('seam');
    var outlineEl = document.getElementById('outline');
    // The seam-badge layer is owned by the dock client, not the page shells —
    // create it once if absent so every widget/panel/chat page gets badges
    // without hand-copying the div into each (it's position:fixed, so we mount
    // it beside #outline to share that stacking context, else on <body>).
    var dockLinksEl = document.getElementById('dock-links');
    if (!dockLinksEl && document.body) {
      dockLinksEl = document.createElement('div');
      dockLinksEl.id = 'dock-links';
      var anchor = outlineEl || seamEl;
      if (anchor && anchor.parentNode) anchor.parentNode.appendChild(dockLinksEl);
      else document.body.appendChild(dockLinksEl);
    }
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
      if (pinBtn) {
        if (grouped && pinBtn.hidden) {
          pinBtn.hidden = false;
          pinBtn.classList.add('pop');
        } else if (!grouped) {
          pinBtn.hidden = true;
          pinBtn.classList.remove('pop');
        }
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
      // Only (re)paint on real data: an ungroup CLEARS; a seams array SETS. A
      // grouped payload with NO seams field is the geometry-free replay reply
      // (dock_group_state, membership only) — leave existing badges UNTOUCHED so
      // a racing seam-bearing re-emit isn't undone (and an older core that never
      // sends seams just shows none). Clearing here would let the replay reply
      // wipe badges the scheduled re-emit had already painted.
      if (!grouped) paintSeams([]);
      else if (Array.isArray(payload.seams)) paintSeams(payload.seams);
    }
    pinBtn && pinBtn.addEventListener('animationend', function () {
      pinBtn.classList.remove('pop');
    });

    // Unpin = leave the group. Rust unparents, ejects us a step past the
    // magnet range, and pushes fresh dock-group state to everyone.
    pinBtn && pinBtn.addEventListener('click', function () {
      setDock(false);
    });

    // ── Dock-link seam badges ──────────────────────────────────────────────
    // Once we're grouped, draw the little chain-link badge on each interior seam
    // we OWN. Rust computes the seams (dock_seams: a window owns only the seams
    // on its right/bottom edges, so every seam gets exactly one badge) and ships
    // them in the dock-group payload; we just place them. The badge nests in our
    // 22px transparent card margin flush against the seam — it cannot straddle
    // into the neighbor window, which clips to its bounds. Clicking it leaves
    // the group (the same primitive as the pin button).
    var LINK_SVG =
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="2.4" stroke-linecap="round" aria-hidden="true">' +
      '<path d="M9 15l6-6"/>' +
      '<path d="M11 6l1.5-1.5a4 4 0 0 1 5.7 5.7L16.5 12"/>' +
      '<path d="M13 18l-1.5 1.5a4 4 0 0 1-5.7-5.7L7.5 12"/></svg>';
    var SEAM_BADGE_R = 11; // half the 22px badge — matches Rust dock_seams BADGE_R

    function onSeamClick(e) {
      e.preventDefault();
      e.stopPropagation();
      // Snip = THIS window leaves its whole group (the only unlink primitive —
      // same as the pin button). Rust ejects us clear and re-pushes dock-group
      // state to everyone, which clears our seams. For a 3+ window line this
      // ejects the clicker rather than cutting just one seam; the aria/title
      // copy ("Unlink these panels") stays honest for the common 2-window dock.
      setDock(false);
    }

    function makeSeamBadge(s, key) {
      var btn = document.createElement('button');
      btn.className = 'dock-link e-' + s.edge;
      btn.type = 'button';
      // Copy kept in lockstep with the ui-web board's .pin-badge (parity).
      btn.title = 'Unlink';
      btn.setAttribute('aria-label', 'Unlink these panels');
      btn.setAttribute('data-seam-key', key);
      btn.innerHTML = LINK_SVG;
      btn.addEventListener('click', onSeamClick);
      return btn;
    }

    function paintSeams(seams) {
      if (!dockLinksEl) return;
      // Lowest a right-edge badge may sit without overlapping the title-bar
      // drag strip = title-bar bottom + badge radius (window-local px). 0 under
      // headless layout (jsdom getBoundingClientRect) → no-op, matching the
      // bare deck-snap clamp; only the real webview triggers the nudge.
      var tb = document.querySelector('.title-bar');
      var titleClear = tb ? Math.round(tb.getBoundingClientRect().bottom) + SEAM_BADGE_R : 0;
      var maxBadgeY = (window.innerHeight || 0) - SEAM_BADGE_R;
      // Diff by partner|edge: a badge that merely MOVES (a regroup or a resize
      // shifts the shared overlap-run midpoint) is repositioned in place, so
      // only a genuinely NEW seam plays the scale-in. Rebuilding wholesale
      // re-popped every badge on each repaint — this mirrors the board, where
      // Solid's keyed <For> reuses nodes and only animates fresh pins.
      var existing = {};
      var kids = dockLinksEl.children;
      for (var i = 0; i < kids.length; i++) {
        existing[kids[i].getAttribute('data-seam-key')] = kids[i];
      }
      var keep = {};
      for (var j = 0; j < seams.length; j++) {
        var s = seams[j];
        var key = s.partner + '|' + s.edge;
        keep[key] = true;
        var el = existing[key];
        if (!el) {
          el = makeSeamBadge(s, key);
          dockLinksEl.appendChild(el);
        }
        // Owner-side flush against the seam, centered on the overlap run — but
        // push a right-edge badge below the title bar if the overlap midpoint
        // lands in it. A 22px button over [data-tauri-drag-region] both
        // dead-zones the native grab AND unlinks on a stray click there; the
        // seam owns the whole right edge, so nudging down keeps it on the seam.
        var by = s.y;
        if (s.edge === 'r' && titleClear) {
          by = Math.max(by, titleClear);
          if (maxBadgeY > SEAM_BADGE_R) by = Math.min(by, maxBadgeY);
        }
        el.style.left = s.x + 'px';
        el.style.top = by + 'px';
      }
      for (var k in existing) {
        if (!keep[k]) dockLinksEl.removeChild(existing[k]);
      }
    }

    // Re-root the group at THIS window the instant it is grabbed, so the
    // native drag carries the whole cluster regardless of which member the
    // user picked up. Capture phase: must precede the native drag region.
    document.addEventListener('pointerdown', function (e) {
      try {
        if (!e.target || !e.target.closest) return;
        // Buttons in the title bar (pin, close) are presses, not grabs — a
        // pin click must not re-root the group first.
        if (e.target.closest('button')) return;
        if (!e.target.closest('[data-tauri-drag-region]')) return;
        if (window.__TAURI__ && window.__TAURI__.core) {
          window.__TAURI__.core.invoke('grab_dock', {}).catch(function () {});
        }
      } catch (_) { /* best-effort */ }
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
    // coherently and thresholds stay the designed 22 logical px.
    async function logicalRect(w) {
      var p = await w.outerPosition();
      var s = await w.outerSize();
      var sf = 1;
      try { sf = (await w.scaleFactor()) || 1; } catch (_) { /* default */ }
      return { x: p.x / sf, y: p.y / sf, w: s.width / sf, h: s.height / sf };
    }

    async function candidateRects() {
      var out = [];
      var TW = window.__TAURI__ && window.__TAURI__.window;
      var skip = groupMembers.slice();
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

    try {
      var snapSettleTimer = null;
      var lastMoveTime = 0;
      var settleGen = 0; // bumped on every move: stale async settles abort
      var THROTTLE_MS = 16;
      var DEBOUNCE_MS = 120;
      var RECHECK_MS = 90; // button-held poll cadence until the real release

      function armSettle(delay) {
        if (snapSettleTimer) { clearTimeout(snapSettleTimer); snapSettleTimer = null; }
        snapSettleTimer = setTimeout(runSettle, delay);
      }

      W.onMoved(function () {
        var now = Date.now();
        settleGen++;
        if (now - lastMoveTime < THROTTLE_MS) return;
        lastMoveTime = now;
        armSettle(DEBOUNCE_MS);
      }).catch(function () { /* onMoved may not exist in all versions */ });
      // No seam re-render on our own resize: Rust re-emits dock-group to the
      // whole group on WindowEvent::Resized, so an owner refreshes even when the
      // NON-owning partner is the one resized — the case the page could never see.

      async function runSettle() {
          try {
            var gen = settleGen;
            var fresh = function () { return settleGen === gen; };
            // SNAP-ON-RELEASE, literally. macOS streams Moved events DURING
            // a drag, so a hover-pause over a neighbor satisfies the
            // debounce while the hand is still down — and used to link the
            // group mid-drag (operator feedback: "a bit aggressive"). The
            // webview never sees pointerup once the native drag loop owns
            // the window, so ask AppKit whether the button is still held
            // and just keep re-checking until the actual drop. An older
            // core without the command fails OPEN (snap now, old behavior).
            var held = false;
            try {
              if (window.__TAURI__ && window.__TAURI__.core) {
                held = !!(await window.__TAURI__.core.invoke('pointer_button_down'));
              }
            } catch (_) { /* command absent — fail open */ }
            if (held) {
              if (!fresh()) return; // a newer move owns the settle now
              armSettle(RECHECK_MS);
              return;
            }
            // Minimize fires a spurious onMoved with nonsense coordinates
            // (tauri#7664) — never snap a minimized window.
            if (typeof W.isMinimized === 'function' && (await W.isMinimized())) return;
            if (!window.LunaDeckSnap) return;

            var widgetRect = await logicalRect(W);

            // Best NEW link across outsiders = smallest move distance,
            // all in logical px.
            var cands = await candidateRects();
            if (!fresh()) return; // the window moved again mid-enumeration
            var best = null;
            for (var i = 0; i < cands.length; i++) {
              var snap = LunaDeckSnap.computeSnap(cands[i].rect, widgetRect, 22);
              if (!snap) continue;
              var d = Math.abs(snap.x - widgetRect.x) + Math.abs(snap.y - widgetRect.y);
              if (!best || d < best.d) best = { label: cands[i].label, snap: snap, d: d };
            }
            if (!best) return; // nothing new in range — groups only change via the pin

            var grouped = groupMembers.length > 0;
            if (!grouped) {
              // Loose window: glide flush, then link (unless it's the hub —
              // alignment-only, groups never include the moon).
              if (best.d > 0 && window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.LogicalPosition) {
                if (!fresh()) return;
                await W.setPosition(new window.__TAURI__.window.LogicalPosition(best.snap.x, best.snap.y));
              }
              if (best.label === 'main') return;
              if (!fresh()) return;
              setDock(true, best.label, best.snap.edge, 0, 0);
            } else {
              // Grouped member: NEVER move yourself (that tears the cluster).
              // Report the merge with the snap delta — Rust translates the
              // WHOLE group so the seam lands flush with the cluster intact.
              if (best.label === 'main') return;
              if (!fresh()) return;
              setDock(true, best.label, best.snap.edge,
                Math.round(best.snap.x - widgetRect.x),
                Math.round(best.snap.y - widgetRect.y));
            }
          } catch (_) { /* best-effort — never throw */ }
      }
    } catch (_) { /* best-effort */ }
  }

  g.LunaDock = { wire: wire };
})(typeof globalThis !== 'undefined' ? globalThis : this);
