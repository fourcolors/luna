/**
 * thread-drag-session.js — pure Attached/Detached state machine for Moon
 * thread sidebar pull-out (Chrome TabDragController model).
 *
 * docs/chrome-tab-interaction.md Phases A–B.
 *
 * No DOM, no Tauri. Unit-tested without a browser shell.
 *
 * States: not_started → attached → detached → stopped
 *
 * Usage:
 *   var s = LunaThreadDrag.createSession({ threadId: 't1', startClientX, startClientY })
 *   s.pointerMove({ clientX, clientY, stripRect })
 *   s.pointerUp({ clientX, clientY, stripRect })
 */
;(function (g) {
  'use strict';

  /** Chrome-like elasticity before Attached (logical px). */
  var ELASTICITY_PX = 10;
  /** Chrome mouse vertical magnetism beyond strip (logical px). */
  var VERTICAL_MAGNET_PX = 15;

  var STATE = {
    NOT_STARTED: 'not_started',
    ATTACHED: 'attached',
    DETACHED: 'detached',
    STOPPED: 'stopped',
  };

  /**
   * @param {object} stripRect { left, top, right, bottom } in client coords
   * @param {number} cx
   * @param {number} cy
   * @param {number} [magnetY]
   */
  function pointInStripBand(stripRect, cx, cy, magnetY) {
    if (!stripRect) return false;
    var m = typeof magnetY === 'number' ? magnetY : VERTICAL_MAGNET_PX;
    var left = stripRect.left;
    var right = stripRect.right;
    var top = stripRect.top - m;
    var bottom = stripRect.bottom + m;
    return cx >= left && cx <= right && cy >= top && cy <= bottom;
  }

  /**
   * Insert index 0..n for a list of n rows from yRatio 0..1 (top→bottom).
   */
  function insertIndexForRatio(n, yRatio) {
    if (n <= 0) return 0;
    var r = Math.max(0, Math.min(1, Number(yRatio) || 0));
    return Math.min(n, Math.max(0, Math.round(r * n)));
  }

  /**
   * yRatio of clientY within strip rect (0 top, 1 bottom).
   */
  function yRatioInStrip(stripRect, cy) {
    if (!stripRect) return 0.5;
    var h = stripRect.bottom - stripRect.top;
    if (!(h > 1)) return 0.5;
    return Math.max(0, Math.min(1, (cy - stripRect.top) / h));
  }

  function hypot(dx, dy) {
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * @param {object} opts
   * @param {string} opts.threadId
   * @param {number} opts.startClientX
   * @param {number} opts.startClientY
   * @param {number} [opts.elasticityPx]
   * @param {number} [opts.magnetYPx]
   * @param {number} [opts.rowCount] for insert index (default 0)
   */
  function createSession(opts) {
    opts = opts || {};
    var threadId = opts.threadId || null;
    var startX = opts.startClientX || 0;
    var startY = opts.startClientY || 0;
    var elasticity = typeof opts.elasticityPx === 'number' ? opts.elasticityPx : ELASTICITY_PX;
    var magnetY = typeof opts.magnetYPx === 'number' ? opts.magnetYPx : VERTICAL_MAGNET_PX;
    var rowCount = typeof opts.rowCount === 'number' ? opts.rowCount : 0;

    var state = STATE.NOT_STARTED;
    var lastClientX = startX;
    var lastClientY = startY;
    var lastInStrip = true;
    var insertIndex = 0;
    var detachedOnce = false;
    /** Wall-clock ms of last pointerMove (for E2E lag budgets). */
    var lastMoveAt = 0;
    var moveCount = 0;
    var onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;

    function snapshot() {
      return {
        state: state,
        threadId: threadId,
        inStrip: lastInStrip,
        insertIndex: insertIndex,
        detachedOnce: detachedOnce,
        clientX: lastClientX,
        clientY: lastClientY,
        lastMoveAt: lastMoveAt,
        moveCount: moveCount,
      };
    }

    function emit(kind, extra) {
      if (!onEvent) return;
      try {
        onEvent({ kind: kind, session: snapshot(), extra: extra || null });
      } catch (_) { /* debug must never break drag */ }
    }

    /**
     * @param {object} p
     * @param {number} p.clientX
     * @param {number} p.clientY
     * @param {object|null} p.stripRect
     * @param {number} [p.rowCount]
     * @returns {{ state, action, insertIndex, inStrip }}
     *   action: 'none' | 'enter_attached' | 'stay_attached' | 'detach' |
     *           'stay_detached' | 'reenter_attached'
     */
    function pointerMove(p) {
      if (state === STATE.STOPPED) {
        return { state: state, action: 'none', insertIndex: insertIndex, inStrip: lastInStrip };
      }
      lastClientX = p.clientX;
      lastClientY = p.clientY;
      lastMoveAt = Date.now();
      moveCount += 1;
      if (typeof p.rowCount === 'number') rowCount = p.rowCount;

      var inStrip = pointInStripBand(p.stripRect, p.clientX, p.clientY, magnetY);
      lastInStrip = inStrip;
      var yRatio = yRatioInStrip(p.stripRect, p.clientY);
      insertIndex = insertIndexForRatio(rowCount, yRatio);
      var out;

      if (state === STATE.NOT_STARTED) {
        var dist = hypot(p.clientX - startX, p.clientY - startY);
        if (dist <= elasticity) {
          out = { state: state, action: 'none', insertIndex: insertIndex, inStrip: inStrip };
          emit('move', out);
          return out;
        }
        // Past elasticity: attached if still in strip, else detach immediately.
        if (inStrip) {
          state = STATE.ATTACHED;
          out = { state: state, action: 'enter_attached', insertIndex: insertIndex, inStrip: true };
          emit('move', out);
          return out;
        }
        state = STATE.DETACHED;
        detachedOnce = true;
        out = { state: state, action: 'detach', insertIndex: insertIndex, inStrip: false };
        emit('move', out);
        return out;
      }

      if (state === STATE.ATTACHED) {
        if (!inStrip) {
          state = STATE.DETACHED;
          detachedOnce = true;
          out = { state: state, action: 'detach', insertIndex: insertIndex, inStrip: false };
          emit('move', out);
          return out;
        }
        out = { state: state, action: 'stay_attached', insertIndex: insertIndex, inStrip: true };
        emit('move', out);
        return out;
      }

      // DETACHED
      if (inStrip) {
        // Chrome can re-attach mid-drag; we report reenter so UI can preview gap.
        // State stays DETACHED until pointerUp decides (window already exists).
        out = { state: state, action: 'reenter_attached', insertIndex: insertIndex, inStrip: true };
        emit('move', out);
        return out;
      }
      out = { state: state, action: 'stay_detached', insertIndex: insertIndex, inStrip: false };
      emit('move', out);
      return out;
    }

    /**
     * @param {object} p same as pointerMove
     * @returns {{ state, outcome, insertIndex, inStrip, detachedOnce }}
     *   outcome: 'click' | 'reorder' | 'cancel_spawn' | 'keep_floater' | 'redock' | 'noop'
     */
    function pointerUp(p) {
      if (state === STATE.STOPPED) {
        return {
          state: state,
          outcome: 'noop',
          insertIndex: insertIndex,
          inStrip: lastInStrip,
          detachedOnce: detachedOnce,
        };
      }
      // Final sample
      var move = pointerMove(p);
      var outcome = 'noop';

      if (state === STATE.NOT_STARTED) {
        outcome = 'click';
      } else if (state === STATE.ATTACHED) {
        // Dropped still in strip: reorder only, never spawn.
        outcome = 'reorder';
      } else if (state === STATE.DETACHED) {
        if (move.inStrip) {
          // Over strip at release: redock (close floater + adopt).
          outcome = detachedOnce ? 'redock' : 'reorder';
        } else {
          outcome = 'keep_floater';
        }
      }

      state = STATE.STOPPED;
      var up = {
        state: state,
        outcome: outcome,
        insertIndex: insertIndex,
        inStrip: move.inStrip,
        detachedOnce: detachedOnce,
        action: move.action,
      };
      emit('up', up);
      return up;
    }

    function cancel() {
      state = STATE.STOPPED;
      var snap = snapshot();
      emit('cancel', snap);
      return snap;
    }

    return {
      STATE: STATE,
      getState: function () { return state; },
      snapshot: snapshot,
      pointerMove: pointerMove,
      pointerUp: pointerUp,
      cancel: cancel,
      // Expose pure helpers for tests / strip redock
      constants: {
        ELASTICITY_PX: elasticity,
        VERTICAL_MAGNET_PX: magnetY,
      },
    };
  }

  // ── Phase C continuity seed (cross-webview) ─────────────────────────────
  // sessionStorage is isolated per Tauri WebviewWindow / top-level browsing
  // context, so a seed written in the owner would be invisible to a floater.
  // Use a *shared* Storage (localStorage in production). TTL + consume-delete
  // keep seeds from surviving restarts or stale detach paths.
  var SEED_PREFIX = 'luna.threadSeed.';
  var SEED_TTL_MS = 30000;

  /**
   * @param {Storage} storage shared store (localStorage in Moon)
   * @param {string} threadId
   * @param {{ messages: any[], throughSeq?: number }} entry
   * @param {number} [now]
   */
  function writeThreadSeed(storage, threadId, entry, now) {
    if (!storage || !threadId || !entry || !Array.isArray(entry.messages)) return false;
    try {
      storage.setItem(SEED_PREFIX + threadId, JSON.stringify({
        messages: entry.messages,
        throughSeq: entry.throughSeq,
        ts: typeof now === 'number' ? now : Date.now(),
      }));
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Read + delete seed. Returns null if missing, invalid, or expired.
   * @param {Storage} storage
   * @param {string} threadId
   * @param {number} [now]
   * @returns {{ messages: any[], throughSeq: number } | null}
   */
  function consumeThreadSeed(storage, threadId, now) {
    if (!storage || !threadId) return null;
    var key = SEED_PREFIX + threadId;
    var raw = null;
    try { raw = storage.getItem(key); } catch (_) { return null; }
    if (!raw) return null;
    try { storage.removeItem(key); } catch (_) { /* best-effort */ }
    try {
      var seed = JSON.parse(raw);
      if (!seed || !Array.isArray(seed.messages)) return null;
      var ts = Number(seed.ts) || 0;
      var t = typeof now === 'number' ? now : Date.now();
      if (t - ts >= SEED_TTL_MS) return null;
      return {
        messages: seed.messages,
        throughSeq: Number.isFinite(seed.throughSeq) ? seed.throughSeq : -1,
      };
    } catch (_) {
      return null;
    }
  }

  g.LunaThreadDrag = {
    STATE: STATE,
    ELASTICITY_PX: ELASTICITY_PX,
    VERTICAL_MAGNET_PX: VERTICAL_MAGNET_PX,
    SEED_PREFIX: SEED_PREFIX,
    SEED_TTL_MS: SEED_TTL_MS,
    pointInStripBand: pointInStripBand,
    insertIndexForRatio: insertIndexForRatio,
    yRatioInStrip: yRatioInStrip,
    createSession: createSession,
    writeThreadSeed: writeThreadSeed,
    consumeThreadSeed: consumeThreadSeed,
  };
})(typeof window !== 'undefined' ? window : globalThis);
