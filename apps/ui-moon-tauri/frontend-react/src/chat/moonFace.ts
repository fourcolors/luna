/**
 * moonFace.ts - the animated header avatar's expression (stack23 S19e).
 *
 * The face reacts to four orthogonal signals, resolved by a fixed priority so
 * conflicting signals never fight over [data-state]:
 *   connection (connecting/offline) > thinking (a turn in flight) >
 *   voice (listening/speaking) > suggesting > idle.
 * All the actual motion lives in CSS keyframes keyed off [data-state]; this
 * controller only flips that one attribute.
 *
 * A FACTORY, NOT A SINGLETON, for the same reason as ResultToasts: it holds
 * real per-instance state, and a module-level singleton would bleed one test
 * file's face state into the next through a shared jsdom global.
 *
 * ITS `init()` MOVED WITH IT. chat.html called `MoonFace.init()` at classic
 * top level, which a module-published global cannot satisfy (see the
 * BOOT-ORDER RULE in docs/next/stack23-slices.md). The answer is not a shim -
 * it is calling init() at the CONSTRUCTION site in main-chat.tsx, which runs
 * strictly later and is equally correct because init() only reads the DOM.
 *
 * It reaches nothing but its one element, which is what made it the natural
 * first half of the pair that unblocks SuggestedActionsEngine: that engine
 * calls MoonBar and MoonFace, so both had to become reachable FROM a module
 * before it could move (the OUTBOUND-EDGE RULE).
 */

/** WebSocketEngine.updateStatus's vocabulary. A version-warning still chats,
 *  so it reads as connected (awake). */
export type ConnectionStatusClass =
  | "connected"
  | "connecting"
  | "disconnected"
  | "version-warning"

export interface MoonFaceDom {
  readonly lunaFace: HTMLElement | null
}

export interface MoonFaceApi {
  init: () => void
  setConnection: (statusClass: string) => void
  setBusy: (b: unknown) => void
  setVoice: (state: string) => void
  setSuggesting: (b: unknown) => void
}

/** The literal's own shape. Annotating it rather than editing the body is what
 *  keeps the move character-identical: every field below was initialised to
 *  null/false in chat.html, which TS would otherwise widen to those literals. */
interface MoonFaceInternal extends MoonFaceApi {
  _conn: string
  _busy: boolean
  _voice: string
  _suggesting: boolean
  _el: HTMLElement | null
  _resolve: () => string
  _apply: () => void
}

export function createMoonFace(DOM: MoonFaceDom): MoonFaceApi {
  const MoonFace: MoonFaceInternal = {
    _conn: 'connecting',   // 'connecting' | 'connected' | 'disconnected'
    _busy: false,          // a turn is in flight
    _voice: '',            // '' | 'listening' | 'speaking'
    _suggesting: false,
    _el: null,

    init() { this._el = DOM.lunaFace; this._apply(); },

    // statusClass comes straight from WebSocketEngine.updateStatus:
    // 'connected' | 'connecting' | 'disconnected' | 'version-warning'.
    // A version-warning still chats, so it reads as connected (awake).
    setConnection(statusClass) {
      this._conn = statusClass === 'connecting' ? 'connecting'
                 : statusClass === 'disconnected' ? 'disconnected'
                 : 'connected';
      this._apply();
    },
    setBusy(b)       { this._busy = !!b; this._apply(); },
    setVoice(state)  { this._voice = (state === 'listening' || state === 'speaking') ? state : ''; this._apply(); },
    setSuggesting(b) { this._suggesting = !!b; this._apply(); },

    _resolve() {
      if (this._conn === 'connecting')   return 'connecting';
      if (this._conn === 'disconnected') return 'offline';
      if (this._busy)                    return 'busy';
      if (this._voice === 'listening')   return 'listening';
      if (this._voice === 'speaking')    return 'speaking';
      if (this._suggesting)              return 'suggesting';
      return '';   // awake / idle
    },
    _apply() {
      const el = this._el || (this._el = DOM.lunaFace);
      if (el) el.dataset.state = this._resolve();
    },
  }
  return MoonFace
}
