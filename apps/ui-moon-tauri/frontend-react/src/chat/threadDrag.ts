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
 * THE TYPES BELOW ARE THE ONLY THING THAT CHANGED (#493). The module carried
 * `@ts-nocheck` until now for the reason above: typing it means editing it, in
 * the one file where a slip cannot be caught by a test. So the structural
 * proof was carried forward rather than abandoned - every edit in this pass is
 * TYPE-LEVEL ONLY (annotations, interfaces, `as` casts), and that claim is
 * mechanically checked, not asserted: tsc emits byte-identical JavaScript from
 * the pre-typing file and this one under `--removeComments`. Nothing that
 * survives to runtime moved. No guard was added or removed, no `?.` or `??`
 * was introduced where the original had a plain access (that would change
 * behaviour on null, not just describe it), no constant or operator changed.
 *
 * Where a precise type would have forced a runtime edit, the type is
 * deliberately the weaker one. `MaybeClosest` exists so the original
 * `e.target && e.target.closest && e.target.closest(...)` ladder could stay
 * exactly as written instead of becoming an `instanceof Element` narrowing.
 *
 * `engine` is the live ThreadDrawerEngine, passed rather than bound because
 * the body both reads and WRITES engine state (`self._ghost`,
 * `self._renderPendingDuringDrag`). `deps` carries the six chat.html globals
 * the body closes over; destructuring them here is what let the body itself
 * stay untouched.
 */

/* eslint-disable */
/** A thread row as the strip hands it over: only these three fields are read. */
export interface ThreadDragRow {
  readonly id: string
  readonly title?: string | null
  readonly lastMessagePreview?: string | null
}

/** Redock chrome published to State for the Rust side and the insert gap. */
export interface RedockPreview {
  threadId: string
  title: string | null
  preview: string | null
  yRatio: number
  over: boolean
  insertIndex: number
}

/** Last insert the drag committed to, read by the redock adopt path. */
export interface RedockInsert {
  threadId: string
  insertIndex: number
  yRatio: number | null
}

/** Strip geometry handed to the native pullout so AppKit can redock. */
export interface StripMetrics {
  readonly stripWidth: number
  readonly stripTopInset: number
  readonly stripHeight: number
}

/** `chat.html`'s State object, narrowed to the keys this gesture touches. */
export interface ThreadDragState {
  /** `true` before the floater label resolves, the label once it does. */
  floatedThreadIds: Record<string, string | true>
  activeThreadId: string | null
  winLabel: string | null
  threadDragActive: boolean
  redockPreview: RedockPreview | null
  _lastRedockInsert: RedockInsert | null
}

/** domMap.ts, narrowed to the two ids this gesture touches. */
export interface ThreadDragDom {
  readonly threadDrawer: HTMLElement | null
  readonly threadDrawerList: HTMLElement | null
}

/** vendor/thread-drag-session.js pointerMove verdicts. */
export type ThreadDragAction =
  | 'none'
  | 'enter_attached'
  | 'stay_attached'
  | 'detach'
  | 'stay_detached'
  | 'reenter_attached'

/** vendor/thread-drag-session.js pointerUp verdicts. */
export type ThreadDragOutcome =
  | 'click'
  | 'reorder'
  | 'cancel_spawn'
  | 'keep_floater'
  | 'redock'
  | 'noop'

export interface ThreadDragSample {
  readonly clientX: number
  readonly clientY: number
  readonly stripRect: DOMRect | null
  readonly rowCount: number
}

export interface ThreadDragMove {
  readonly action: ThreadDragAction
  readonly insertIndex: number
  readonly inStrip: boolean
}

export interface ThreadDragUp {
  readonly outcome: ThreadDragOutcome
  readonly insertIndex: number
  readonly inStrip: boolean
  readonly detachedOnce: boolean
}

export interface ThreadDragSessionEvent {
  readonly kind: string
  readonly session: Record<string, unknown>
  readonly extra: Record<string, unknown> | null
}

export interface ThreadDragSession {
  pointerMove(p: ThreadDragSample): ThreadDragMove
  pointerUp(p: ThreadDragSample): ThreadDragUp
  cancel(): void
}

export interface LunaThreadDragApi {
  createSession(opts: {
    readonly threadId: string
    readonly startClientX: number
    readonly startClientY: number
    readonly rowCount: number
    readonly onEvent?: (ev: ThreadDragSessionEvent) => void
  }): ThreadDragSession
}

/**
 * The live ThreadDrawerEngine, narrowed to what the gesture calls. `_ghost`
 * and `_renderPendingDuringDrag` are writable on purpose: the body owns them
 * for the duration of the drag, which is why the engine is passed rather than
 * bound.
 */
export interface ThreadDragEngine {
  _ghost: HTMLElement | null
  _renderPendingDuringDrag: boolean
  _visibleThreads(): readonly ThreadDragRow[]
  _makeGhost(t: ThreadDragRow): HTMLElement
  _seedFloaterCache(threadId: string): void
  _closeFloater(label: string): void
  _placeInsertGap(preview: RedockPreview): void
  _markRedockSource(threadId: string): void
  applyRedockPreview(opts: { readonly active: boolean }): void
  adoptAtIndex(threadId: string, insertIndex: number): void
  adoptRedockedThread(threadId: string, insertIndex: number | null): void
  measureStripMetrics(): StripMetrics
  onRowClick(threadId: string): void
  openInNewWindow(
    threadId: string,
    x?: number,
    y?: number,
    opts?: { readonly focus: boolean },
  ): Promise<string | null>
  render(): void
}

/**
 * `Event.target` is typed as the bare `EventTarget`, which has no `closest`.
 * Casting to this instead of narrowing with `instanceof Element` is what keeps
 * the original truthiness ladder intact - `closest` genuinely can be absent
 * (a text node, the document), and the ladder already handles that.
 */
type MaybeClosest = EventTarget & { closest(selectors: string): Element | null }

declare global {
  interface Window {
    /** Published by vendor/thread-drag-session.js, loaded by chat.html. */
    LunaThreadDrag?: LunaThreadDragApi
    __TAURI__?: {
      core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
    }
  }
}

export interface ThreadDragDeps {
  readonly State: ThreadDragState
  readonly DOM: ThreadDragDom
  readonly Logger: { warn(...args: unknown[]): void }
  readonly moonDragDebugNote: (kind: string, data?: Record<string, unknown> | null) => void
  /**
   * Destructured and never read - the body reaches for `window.LunaThreadDrag`
   * directly, exactly like the vanilla original did. Typed `unknown` and left
   * in place rather than deleted: removing it would change the emitted
   * destructuring, which is the one thing this module may not do.
   */
  readonly LunaThreadDrag: unknown
}

export function wireThreadRow(
  engine: ThreadDragEngine,
  row: HTMLElement,
  t: ThreadDragRow,
  deps: ThreadDragDeps,
): void {
  const { State, DOM, Logger, moonDragDebugNote, LunaThreadDrag } = deps
  const self = engine
  // Cursor sits this far inside the floater top-left (logical points, y down).
  // Must match begin_native_pullout_drag grab defaults so the window sticks.
  const GRAB_OFF_X = 36;
  const GRAB_OFF_Y = 18;
  const originOffset = (sx: number, sy: number) => ({
    x: Math.round(sx - GRAB_OFF_X),
    y: Math.round(sy - GRAB_OFF_Y),
  });
  let session: ThreadDragSession | null = null;
  let pid: number | null = null;
  let raf = 0;
  let lastX = 0, lastY = 0, lastSX = 0, lastSY = 0;
  let floatedLabel: string | null = null;
  let spawnPromise: Promise<string | null> | null = null;
  let cancelled = false;
  let attachedVisual = false;
  let lastInsertAt = -1;
  /** Sticky insert: require two consecutive samples at a new index. */
  let stickyPendingAt = -1;
  let stickyPendingCount = 0;
  /** Reset on pointerdown and never read - kept because deleting it would be
   * a runtime edit, not a type one. */
  let pendingPos: unknown = null;
  /** First detach spawn start time (for open budget). */
  let detachStartedAt = 0;
  /** Hard promote: only one open_widget; OS owns free motion after. */
  let nativePulloutArmed = false;

  const markFloatedAway = (label: string | true | null) => {
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
  const hardPromoteFloater = (sx: number, sy: number) => {
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
          // THE REDOCK TARGET, and the one line in this file that had no test
          // until thread-drag-detach.test.ts. Nulling it left all 1531 other
          // tests green, and a null owner means the native pullout never arms:
          // the floater stops sticking to the cursor and Redock has nowhere to
          // fold back into.
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

  const showAttachedChrome = (insertAt: number) => {
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

  const onMove = (e: PointerEvent) => {
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

  const blockSelect = (ev: Event) => {
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

  const onUp = (e: PointerEvent) => {
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
    if (e.target && (e.target as MaybeClosest).closest && (e.target as MaybeClosest).closest('.thread-row-pop')) return;
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
