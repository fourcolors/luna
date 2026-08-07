// @ts-nocheck
/**
 * threadDrag.ts - the thread row's click-vs-drag-out gesture (stack23 S17f).
 *
 * THE BODY BELOW IS THE VANILLA `ThreadDrawerEngine._wireRow` MOVED VERBATIM.
 * That is a deliberate verification strategy, not laziness. This is the most
 * feel-critical code in Moon - pointer capture, a CSS ghost, a sticky
 * insert-index, and a hand-off to a native OS window - and S17's own deployNote
 * says a screenshot cannot prove threshold feel. Mutation testing, the method
 * used on every other module in this arc, returns SILENCE here: deleting the
 * whole `wireRow` call once left 1423 tests green.
 *
 * So instead of behavioural proof, this move offers STRUCTURAL proof. The
 * extraction was performed mechanically, and exactly ONE line differs from the
 * original 430:
 *
 *     const self = this;      ->      const self = engine
 *
 * Everything else - every constant, every threshold, every branch - is
 * character-identical, verified by diffing the generated body against the text
 * cut from chat.html. `GRAB_OFF_X`/`GRAB_OFF_Y` and the elasticity/magnet
 * thresholds inside vendor/thread-drag-session.js are untouched, so the feel
 * this file produces is the feel it produced yesterday.
 *
 * WHAT IS *NOT* CLAIMED: this is not a rewrite, not a React conversion, and
 * not covered by behavioural tests. S17's hands-on detach/redock exercise is
 * still owed, and it is the gate that matters for this file.
 *
 * WHY @ts-nocheck, and why that is the honest choice here. The body is
 * untyped JS that has never been typechecked - it lived inside chat.html's
 * inline script, which sits outside every tsc program - so this flag preserves
 * exactly the status quo rather than hiding a regression. Typing it means
 * EDITING it: roughly thirty `: any` annotations threaded through pointer
 * handlers and closure state, each one a chance to slip in the one file where
 * a slip cannot be caught by a test. The typing is owed as a follow-up AFTER
 * the hands-on gate confirms the move preserved feel, when edits here are
 * cheap to validate again. TODO(#493): drop @ts-nocheck and type this module.
 *
 * `engine` is the live ThreadDrawerEngine, passed rather than bound because
 * the body both reads and WRITES engine state (`self._ghost`,
 * `self._renderPendingDuringDrag`). `deps` carries the six chat.html globals
 * the body closes over; destructuring them here is what let the body itself
 * stay untouched.
 */

/* eslint-disable */
export interface ThreadDragDeps {
  readonly State: any
  readonly DOM: any
  readonly Logger: any
  readonly moonDragDebugNote: (...a: any[]) => void
  readonly LunaThreadDrag: any
  readonly winLabel: string | null
}

export function wireThreadRow(engine: any, row: any, t: any, deps: ThreadDragDeps): void {
  const { State, DOM, Logger, moonDragDebugNote, LunaThreadDrag, winLabel } = deps
  const self = engine
  // Cursor sits this far inside the floater top-left (logical points, y down).
  // Must match begin_native_pullout_drag grab defaults so the window sticks.
  const GRAB_OFF_X = 36;
  const GRAB_OFF_Y = 18;
  const originOffset = (sx, sy) => ({
    x: Math.round(sx - GRAB_OFF_X),
    y: Math.round(sy - GRAB_OFF_Y),
  });
  let session = null;
  let pid = null;
  let raf = 0;
  let lastX = 0, lastY = 0, lastSX = 0, lastSY = 0;
  let floatedLabel = null;
  let spawnPromise = null;
  let cancelled = false;
  let attachedVisual = false;
  let lastInsertAt = -1;
  /** Sticky insert: require two consecutive samples at a new index. */
  let stickyPendingAt = -1;
  let stickyPendingCount = 0;
  let pendingPos = null;
  /** First detach spawn start time (for open budget). */
  let detachStartedAt = 0;
  /** Hard promote: only one open_widget; OS owns free motion after. */
  let nativePulloutArmed = false;

  const markFloatedAway = (label) => {
    if (!State.floatedThreadIds) State.floatedThreadIds = Object.create(null);
    State.floatedThreadIds[t.id] = label || true;
    try { row.classList.add('floated-away'); } catch (_) {}
    // Owner must not keep viewing a thread that just left the strip.
    if (State.activeThreadId === t.id) {
      try {
        const next = self._visibleThreads().find((r) => r.id !== t.id);
        if (next) self.onRowClick(next.id);
      } catch (_) { /* best-effort */ }
    }
  };

  const clearFloatedAway = () => {
    if (State.floatedThreadIds) delete State.floatedThreadIds[t.id];
    try { row.classList.remove('floated-away'); } catch (_) {}
  };

  const stripRect = () => {
    try {
      return DOM.threadDrawer ? DOM.threadDrawer.getBoundingClientRect() : null;
    } catch (_) {
      return null;
    }
  };

  const stripWidth = () => {
    const r = stripRect();
    return r && r.width > 40 ? r.width : 240;
  };

  const rowCount = () => {
    try { return self._visibleThreads().length; } catch (_) { return 0; }
  };

  /**
   * Hard promote: spawn floater ONCE under the cursor, drop the mini ghost,
   * then hand free motion to AppKit (begin_native_pullout_drag). Never
   * chase with open_widget/set_position on later moves.
   * @param {number} sx
   * @param {number} sy
   */
  const hardPromoteFloater = (sx, sy) => {
    if (floatedLabel || spawnPromise || nativePulloutArmed) return spawnPromise;
    const { x, y } = originOffset(sx, sy);
    try { self._seedFloaterCache(t.id); } catch (_) { /* best-effort */ }
    if (!detachStartedAt) detachStartedAt = Date.now();
    // Leave the strip immediately (Chrome detach) even before the window resolves.
    markFloatedAway(true);
    const invokeStarted = Date.now();
    spawnPromise = self.openInNewWindow(t.id, x, y, { focus: false })
      .then((label) => {
        spawnPromise = null;
        if (cancelled) {
          if (label) self._closeFloater(label);
          clearFloatedAway();
          return null;
        }
        floatedLabel = label || floatedLabel;
        markFloatedAway(floatedLabel);
        // Single object under the finger: drop CSS ghost once the OS window exists.
        if (self._ghost) { self._ghost.remove(); self._ghost = null; }
        try {
          moonDragDebugNote('floater', {
            label: floatedLabel,
            focus: false,
            seed: true,
            x: x,
            y: y,
            hardPromote: true,
            grabX: GRAB_OFF_X,
            grabY: GRAB_OFF_Y,
            invokeMs: Date.now() - invokeStarted,
            sinceDetachMs: detachStartedAt ? Date.now() - detachStartedAt : null,
          });
        } catch (_) { /* debug */ }
        if (floatedLabel && window.__TAURI__ && window.__TAURI__.core) {
          nativePulloutArmed = true;
          const title = (t.title && String(t.title).trim()) || null;
          const owner = State.winLabel || null;
          if (owner) {
            const metrics = self.measureStripMetrics();
            window.__TAURI__.core
              .invoke('begin_native_pullout_drag', {
                floaterLabel: floatedLabel,
                ownerLabel: owner,
                threadId: t.id,
                title: title,
                stripWidth: metrics.stripWidth,
                stripTopInset: metrics.stripTopInset,
                stripHeight: metrics.stripHeight,
                grabOffsetX: GRAB_OFF_X,
                grabOffsetY: GRAB_OFF_Y,
              })
              .catch((err) => {
                Logger.warn('begin_native_pullout_drag failed:', err);
                nativePulloutArmed = false;
              });
          }
        }
        return floatedLabel;
      })
      .catch((err) => {
        spawnPromise = null;
        clearFloatedAway();
        try { moonDragDebugNote('floater_error', { message: String(err) }); } catch (_) {}
        Logger.warn('thread drag-out spawn failed:', err);
        return null;
      });
    return spawnPromise;
  };

  const showAttachedChrome = (insertAt) => {
    attachedVisual = true;
    row.classList.add('dragging');
    // Ghost only while still attached (or waiting for promote). After
    // hard promote the OS window is the single object.
    if (!floatedLabel && !self._ghost) self._ghost = self._makeGhost(t);
    // Sticky insert index: avoid thrashing adjacent slots every sample.
    if (insertAt === lastInsertAt && DOM.threadDrawer
        && DOM.threadDrawer.classList.contains('redock-target')) {
      return;
    }
    if (insertAt !== lastInsertAt) {
      if (insertAt === stickyPendingAt) {
        stickyPendingCount += 1;
        if (stickyPendingCount < 2) return;
      } else {
        stickyPendingAt = insertAt;
        stickyPendingCount = 1;
        return;
      }
    }
    lastInsertAt = insertAt;
    stickyPendingAt = -1;
    stickyPendingCount = 0;
    const n = rowCount();
    const yRatio = n > 0 ? Math.min(1, Math.max(0, insertAt / n)) : 0.5;
    State.redockPreview = {
      threadId: t.id,
      title: (t.title && String(t.title).trim()) || null,
      preview: (t.lastMessagePreview && String(t.lastMessagePreview).trim()) || null,
      yRatio,
      over: true,
      insertIndex: insertAt,
    };
    State._lastRedockInsert = {
      threadId: t.id,
      insertIndex: insertAt,
      yRatio,
    };
    if (DOM.threadDrawerList) DOM.threadDrawerList.classList.add('redocking');
    try { self._placeInsertGap(State.redockPreview); } catch (_) {}
    try { self._markRedockSource(t.id); } catch (_) {}
    if (DOM.threadDrawer) DOM.threadDrawer.classList.add('redock-target');
  };

  const clearAttachedChrome = () => {
    attachedVisual = false;
    lastInsertAt = -1;
    stickyPendingAt = -1;
    stickyPendingCount = 0;
    row.classList.remove('dragging');
    // Keep ghost only until hard promote shows a window.
    if (self._ghost && floatedLabel) {
      self._ghost.remove();
      self._ghost = null;
    }
    try { self.applyRedockPreview({ active: false }); } catch (_) {}
  };

  const onMove = (e) => {
    if (!session) return;
    lastX = e.clientX; lastY = e.clientY;
    lastSX = e.screenX; lastSY = e.screenY;
    const move = session.pointerMove({
      clientX: e.clientX,
      clientY: e.clientY,
      stripRect: stripRect(),
      rowCount: rowCount(),
    });

    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        // Ghost only bridges until hard promote; OS owns motion after.
        if (self._ghost && !floatedLabel) {
          self._ghost.style.transform =
            'translate(' + lastX + 'px,' + lastY + 'px) translate(-18px,-14px)';
        }
      });
    }

    if (move.action === 'enter_attached' || move.action === 'stay_attached') {
      showAttachedChrome(move.insertIndex);
      return;
    }
    if (move.action === 'detach') {
      // Hard promote: drop strip chrome, spawn ONCE, OS free motion.
      clearAttachedChrome();
      if (!self._ghost && !floatedLabel) self._ghost = self._makeGhost(t);
      hardPromoteFloater(e.screenX, e.screenY);
      return;
    }
    if (move.action === 'stay_detached') {
      // No IPC chase. Native pullout owns the window; optional ghost bridge.
      if (attachedVisual) clearAttachedChrome();
      if (!floatedLabel && !spawnPromise) {
        if (!self._ghost) self._ghost = self._makeGhost(t);
        hardPromoteFloater(e.screenX, e.screenY);
      }
      return;
    }
    if (move.action === 'reenter_attached') {
      // Strip gap only; floater still OS-driven (redock-preview from Rust).
      showAttachedChrome(move.insertIndex);
      return;
    }
  };

  const blockSelect = (ev) => {
    try { ev.preventDefault(); } catch (_) {}
    return false;
  };

  const clearDomSelection = () => {
    try {
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
    } catch (_) { /* ignore */ }
  };

  const teardown = () => {
    row.removeEventListener('pointermove', onMove);
    row.removeEventListener('pointerup', onUp);
    row.removeEventListener('pointercancel', onCancel);
    try { document.removeEventListener('selectstart', blockSelect, true); } catch (_) {}
    try { document.body.classList.remove('thread-dragging'); } catch (_) {}
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    try { if (pid != null) row.releasePointerCapture(pid); } catch (_) {}
    pid = null;
    session = null;
    State.threadDragActive = false;
    clearDomSelection();
    if (self._renderPendingDuringDrag) {
      self._renderPendingDuringDrag = false;
      self.render();
    }
  };

  const onUp = (e) => {
    if (!session) { teardown(); return; }
    const result = session.pointerUp({
      clientX: e.clientX,
      clientY: e.clientY,
      stripRect: stripRect(),
      rowCount: rowCount(),
    });
    const sx = e.screenX, sy = e.screenY;
    clearAttachedChrome();
    teardown();

    if (result.outcome === 'click') {
      if (e.metaKey || e.ctrlKey) self.openInNewWindow(t.id);
      else self.onRowClick(t.id);
      return;
    }
    if (result.outcome === 'reorder') {
      try { self.adoptAtIndex(t.id, result.insertIndex); } catch (_) {}
      try { self.render(); } catch (_) {}
      return;
    }
    if (result.outcome === 'redock') {
      cancelled = true;
      // Prefer live preview insert under the cursor; fall back to session index.
      if (State.redockPreview && State.redockPreview.over
          && typeof State.redockPreview.insertIndex === 'number') {
        State._lastRedockInsert = {
          threadId: t.id,
          insertIndex: State.redockPreview.insertIndex,
          yRatio: State.redockPreview.yRatio,
        };
      } else {
        State._lastRedockInsert = {
          threadId: t.id,
          insertIndex: result.insertIndex,
          yRatio: null,
        };
      }
      const finishRedock = () => {
        if (floatedLabel) self._closeFloater(floatedLabel);
        try { self.adoptRedockedThread(t.id, null); } catch (_) {
          clearFloatedAway();
          try { self.adoptAtIndex(t.id, result.insertIndex); } catch (__) {}
          try { self.onRowClick(t.id); } catch (__) {}
        }
      };
      if (spawnPromise) {
        spawnPromise.then((label) => {
          if (label) floatedLabel = label;
          finishRedock();
        });
      } else {
        finishRedock();
      }
      return;
    }
    if (result.outcome === 'keep_floater') {
      // Focus once so the user can type. Do not re-chase position.
      // Thread stays out of the strip (floatedThreadIds).
      if (floatedLabel) {
        markFloatedAway(floatedLabel);
        self.openInNewWindow(t.id, undefined, undefined, { focus: true })
          .catch(() => {});
      } else if (spawnPromise) {
        spawnPromise.then((label) => {
          if (label) {
            floatedLabel = label;
            markFloatedAway(label);
            self.openInNewWindow(t.id, undefined, undefined, { focus: true })
              .catch(() => {});
          } else {
            hardPromoteFloater(sx, sy);
          }
        });
      } else {
        hardPromoteFloater(sx, sy);
      }
      // Allow deferred list rebuild now that the row is gone from the strip.
      try { self.render(); } catch (_) {}
      return;
    }
  };

  const onCancel = () => {
    cancelled = true;
    if (session) session.cancel();
    clearAttachedChrome();
    if (spawnPromise) {
      spawnPromise.then((label) => {
        if (label) self._closeFloater(label);
        clearFloatedAway();
        try { self.render(); } catch (_) {}
      });
    } else if (floatedLabel) {
      self._closeFloater(floatedLabel);
      clearFloatedAway();
      try { self.render(); } catch (_) {}
    } else {
      clearFloatedAway();
    }
    teardown();
  };

  row.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('.thread-row-pop')) return;
    if (!(window.LunaThreadDrag && typeof window.LunaThreadDrag.createSession === 'function')) {
      Logger.warn('[ThreadDrawer] LunaThreadDrag missing; drag disabled');
      return;
    }
    // Kill text selection highlight — the #1 "annoying flash" during drag.
    try { e.preventDefault(); } catch (_) {}
    clearDomSelection();
    try { document.addEventListener('selectstart', blockSelect, true); } catch (_) {}
    try { document.body.classList.add('thread-dragging'); } catch (_) {}
    cancelled = false;
    floatedLabel = null;
    spawnPromise = null;
    pendingPos = null;
    attachedVisual = false;
    lastInsertAt = -1;
    stickyPendingAt = -1;
    stickyPendingCount = 0;
    detachStartedAt = 0;
    nativePulloutArmed = false;
    session = window.LunaThreadDrag.createSession({
      threadId: t.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      rowCount: rowCount(),
      onEvent: (ev) => {
        try {
          moonDragDebugNote(ev.kind, {
            action: ev.extra && ev.extra.action,
            outcome: ev.extra && ev.extra.outcome,
            session: ev.session,
          });
        } catch (_) { /* debug */ }
      },
    });
    lastX = e.clientX; lastY = e.clientY;
    lastSX = e.screenX; lastSY = e.screenY;
    pid = e.pointerId;
    State.threadDragActive = true;
    try { moonDragDebugNote('down', { threadId: t.id, clientX: e.clientX, clientY: e.clientY }); } catch (_) {}
    // Capture keeps move events when the pointer leaves the owner window
    // (otherwise drag-out freezes at the edge).
    try { row.setPointerCapture(e.pointerId); } catch (_) {}
    row.addEventListener('pointermove', onMove);
    row.addEventListener('pointerup', onUp);
    row.addEventListener('pointercancel', onCancel);
  });
}
