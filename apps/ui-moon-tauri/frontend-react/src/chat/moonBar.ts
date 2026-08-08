/**
 * moonBar.ts - the header's free-space message zone (stack23 S19e).
 *
 * Shows EITHER a rotating idle quip (a playful comment, handwritten) OR a
 * compact suggestion teaser chip mirroring the active `suggest_action`
 * proposal. Clicking the chip opens the full docked panel (wired in boot).
 * The quip line doubles as a connection mood line ("waking up...",
 * "reconnecting...") so the bar always says something honest.
 *
 * A FACTORY, NOT A SINGLETON, and here that is load-bearing rather than
 * stylistic: the bar owns a live 14-second rotation timer, so a module-level
 * singleton would leave one test file's timer running into the next.
 *
 * THE ROTATION IS SELF-RESCHEDULING, NOT setInterval. It stops cleanly the
 * moment #luna-quip leaves the document instead of firing forever on a
 * detached node, and it unref()s under Node so the jsdom harness's event loop
 * can still exit. Both properties are preserved verbatim; they are the reason
 * this timer has never shown up as a hanging test.
 *
 * ITS `init()` MOVED WITH IT, for the reason spelled out in moonFace.ts.
 */

export interface MoonBarDom {
  readonly lunaQuip: HTMLElement | null
  readonly lunaSuggestion: HTMLElement | null
  readonly lunaSuggestionText: HTMLElement | null
}

/** The subset of a suggested action the chip paints. */
export interface MoonBarSuggestion {
  readonly title?: string
}

export interface MoonBarApi {
  init: () => void
  setConnection: (statusClass: string) => void
  showSuggestion: (action: MoonBarSuggestion | null | undefined) => void
  clearSuggestion: () => void
}

/** The literal's own shape; annotated rather than body-edited, see moonFace.ts.
 *  `_quips` is indexed modulo its own length, so the read is always in range -
 *  the index signature says that without a body change. */
interface MoonBarInternal extends MoonBarApi {
  _quips: { readonly [i: number]: string; readonly length: number }
  _qi: number
  _timer: (ReturnType<typeof setTimeout> & { unref?: () => void }) | null
  _conn: string
  _hasSuggestion: boolean
  _scheduleRotate: () => void
  _connQuip: () => string | null
  _renderQuip: (fade: boolean) => void
}

export function createMoonBar(DOM: MoonBarDom): MoonBarApi {
  const MoonBar: MoonBarInternal = {
    _quips: [
      'just vibing ✨',
      'ready when you are 🌙',
      'the night is quiet… I’m here',
      'thinking up something clever…',
      'your friendly moon, reporting in',
      'drifting through some stardust',
      'tap me anytime',
      'all systems calm',
    ],
    _qi: 0,
    _timer: null,
    _conn: 'connecting',   // 'connecting' | 'connected' | 'disconnected'
    _hasSuggestion: false,

    init() {
      if (!DOM.lunaQuip) return;
      this._renderQuip(false);
      this._scheduleRotate();
    },

    // Self-rescheduling (not setInterval) so it stops cleanly the moment the
    // bar leaves the document — e.g. jsdom test teardown — instead of leaking
    // a timer that fires forever on a detached node. The real chat window
    // keeps #luna-quip mounted for its whole life, so quips keep rotating.
    _scheduleRotate() {
      if (this._timer) return;
      this._timer = setTimeout(() => {
        this._timer = null;
        try {
          if (!DOM.lunaQuip || !DOM.lunaQuip.isConnected) return;   // torn down → stop
          if (!this._hasSuggestion && this._connQuip() == null) {
            this._qi = (this._qi + 1) % this._quips.length;
            this._renderQuip(true);
          }
          this._scheduleRotate();
        } catch (_) { /* never let a stray tick surface an unhandled error */ }
      }, 14000);
      // Hygiene: under Node (the jsdom test harness) a long pending timer
      // would keep the event loop alive; unref() lets the loop exit. It's
      // undefined in the browser, where the timer behaves normally.
      if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    },

    setConnection(statusClass) {
      this._conn = (statusClass === 'connected' || statusClass === 'version-warning') ? 'connected'
                 : statusClass === 'connecting' ? 'connecting'
                 : 'disconnected';
      if (!this._hasSuggestion) this._renderQuip(false);
    },

    showSuggestion(action) {
      if (!DOM.lunaSuggestion || !DOM.lunaSuggestionText) return;
      this._hasSuggestion = true;
      const title = (action && action.title) ? action.title : 'Luna has an idea';
      DOM.lunaSuggestionText.textContent = title;
      DOM.lunaSuggestion.title = title;
      // Dynamic accessible name — a static aria-label would override the
      // visible title and hide the actual suggestion from screen readers.
      DOM.lunaSuggestion.setAttribute('aria-label', 'Open Luna’s suggestion: ' + title);
      if (DOM.lunaQuip) DOM.lunaQuip.hidden = true;
      DOM.lunaSuggestion.hidden = false;
    },

    clearSuggestion() {
      this._hasSuggestion = false;
      if (DOM.lunaSuggestion) DOM.lunaSuggestion.hidden = true;
      if (DOM.lunaQuip) { DOM.lunaQuip.hidden = false; this._renderQuip(false); }
    },

    // A non-connected state replaces the playful quip with an honest mood line.
    _connQuip() {
      if (this._conn === 'connecting')   return 'waking up…';
      if (this._conn === 'disconnected') return 'lost the thread… reconnecting';
      return null;
    },
    _renderQuip(fade) {
      const el = DOM.lunaQuip;
      if (!el) return;
      const conn = this._connQuip();
      // The only character this move adds: `_qi` is kept modulo `_quips.length`
    // so the read is always in range, but noUncheckedIndexedAccess cannot see
    // that. `!` is erased at emit, so the shipped JS is still byte-identical.
    const text = conn != null ? conn : this._quips[this._qi % this._quips.length]!;
      if (fade) {
        el.classList.add('fading');
        setTimeout(() => { el.textContent = text; el.classList.remove('fading'); }, 600);
      } else {
        el.textContent = text;
      }
    },
  }
  return MoonBar
}
