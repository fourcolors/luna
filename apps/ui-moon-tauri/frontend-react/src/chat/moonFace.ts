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
  /** Visually-hidden polite live region. The face itself is aria-hidden, so
   *  without this every state it expresses is invisible to assistive tech. */
  readonly lunaFaceStatus?: HTMLElement | null
}

export interface MoonFaceApi {
  init: () => void
  setConnection: (statusClass: string) => void
  setBusy: (b: unknown) => void
  setVoice: (state: string) => void
  setSuggesting: (b: unknown) => void
  /** Play a transient over the face, then hand control back to the resolver.
   *  The persistent flags have no way to express "something just happened",
   *  which is why secret prompts, surveys and errors reached the face nowhere. */
  pulse: (state: TransientState, ms?: number) => void
  dispose: () => void
}

/** Transients interrupt the face for a fixed time. They are events, not states. */
export type TransientState = "alert" | "eclipse" | "wow"

/** How long each transient holds before releasing. Measured in the prototype:
 *  short enough not to hide the turn, long enough to be seen. */
export const TRANSIENT_MS: Record<TransientState, number> = {
  alert: 2000,
  eclipse: 3000,
  wow: 1150,
}

/** The orbit channel. Rings sit AROUND the moon rather than eating into it, so
 *  the body stays whole whatever the connection is doing. `none` is idle on
 *  purpose: a ring that is always there cannot mean anything when it appears. */
export type OrbitState = "none" | "thinking" | "long" | "connecting" | "offline" | "listening"

/** A turn running longer than this earns the heavier three-ring treatment. */
export const LONG_TURN_MS = 45000

/** The literal's own shape. Annotating it rather than editing the body is what
 *  keeps the move character-identical: every field below was initialised to
 *  null/false in chat.html, which TS would otherwise widen to those literals. */
interface MoonFaceInternal extends MoonFaceApi {
  _conn: string
  _busy: boolean
  _voice: string
  /** The un-coerced Rust voice state. `_voice` keeps only the two values the
   *  face can draw; this keeps the rest ('starting', 'transcribing', 'error')
   *  so a broken mic is at least announced instead of reading as idle. */
  _voiceRaw: string
  _suggesting: boolean
  _el: HTMLElement | null
  _live: HTMLElement | null
  _said: string
  _long: boolean
  _longTimer: ReturnType<typeof setTimeout> | null
  _transient: TransientState | null
  _transientTimer: ReturnType<typeof setTimeout> | null
  _resolve: () => string
  _resolveOrbit: () => OrbitState
  _describe: () => string
  _apply: () => void
}

/** What the live region says for each resolved state. Kept separate from the
 *  state ids so the wording can change without touching the CSS contract. */
const READY = "Luna is ready"
const SPOKEN: Record<string, string> = {
  connecting: "Luna is connecting",
  offline: "Luna is offline",
  busy: "Luna is working",
  listening: "Luna is listening",
  speaking: "Luna is speaking",
  suggesting: "Luna has a suggestion",
  "": READY,
}

export function createMoonFace(DOM: MoonFaceDom): MoonFaceApi {
  const MoonFace: MoonFaceInternal = {
    _conn: 'connecting',   // 'connecting' | 'connected' | 'disconnected'
    _busy: false,          // a turn is in flight
    _voice: '',            // '' | 'listening' | 'speaking'
    _voiceRaw: '',         // whatever Rust actually said
    _suggesting: false,
    _el: null,
    _live: null,
    _said: '',
    _long: false,
    _longTimer: null,
    _transient: null,
    _transientTimer: null,

    init() {
      this._el = DOM.lunaFace
      this._live = DOM.lunaFaceStatus ?? null
      this._apply()
    },

    // statusClass comes straight from WebSocketEngine.updateStatus:
    // 'connected' | 'connecting' | 'disconnected' | 'version-warning'.
    // A version-warning still chats, so it reads as connected (awake).
    setConnection(statusClass) {
      this._conn = statusClass === 'connecting' ? 'connecting'
                 : statusClass === 'disconnected' ? 'disconnected'
                 : 'connected';
      this._apply();
    },
    setBusy(b) {
      const next = !!b
      if (next === this._busy) return
      this._busy = next
      if (this._longTimer) { clearTimeout(this._longTimer); this._longTimer = null }
      if (next) {
        this._long = false
        // A long turn escalates the rings rather than adding a second
        // vocabulary for "this is taking a while".
        this._longTimer = setTimeout(() => {
          this._longTimer = null
          if (this._busy) { this._long = true; this._apply() }
        }, LONG_TURN_MS)
      } else {
        this._long = false
      }
      this._apply()
    },

    pulse(state, ms) {
      this._transient = state
      if (this._transientTimer) clearTimeout(this._transientTimer)
      this._transientTimer = setTimeout(() => {
        this._transientTimer = null
        this._transient = null
        this._apply()
      }, ms ?? TRANSIENT_MS[state])
      this._apply()
    },

    dispose() {
      if (this._longTimer) { clearTimeout(this._longTimer); this._longTimer = null }
      if (this._transientTimer) { clearTimeout(this._transientTimer); this._transientTimer = null }
    },
    setVoice(state)  {
      this._voiceRaw = typeof state === 'string' ? state : ''
      this._voice = (state === 'listening' || state === 'speaking') ? state : ''
      this._apply()
    },
    setSuggesting(b) { this._suggesting = !!b; this._apply(); },

    _resolve() {
      if (this._conn === 'connecting')   return 'connecting';
      if (this._conn === 'disconnected') return 'offline';
      // VOICE OUTRANKS BUSY. `_busy` clears only on `turn-complete`, but TTS
      // starts on the first delta, so with busy first the speaking mouth was
      // unreachable for the whole reply and only appeared for whatever tail of
      // audio outlived the turn. Audio that is actually playing is the more
      // truthful thing to show, so it wins.
      if (this._voice === 'speaking')    return 'speaking';
      if (this._voice === 'listening')   return 'listening';
      if (this._busy)                    return 'busy';
      if (this._suggesting)              return 'suggesting';
      return '';   // awake / idle
    },

    /**
     * The orbit channel, resolved independently of the face. This is the whole
     * point of splitting them: "connecting AND speaking" is now expressible as
     * a searching ring around a chattering mouth, instead of one winning.
     */
    _resolveOrbit() {
      if (this._conn === 'connecting')   return 'connecting'
      if (this._conn === 'disconnected') return 'offline'
      if (this._busy)                    return this._long ? 'long' : 'thinking'
      if (this._voice === 'listening')   return 'listening'
      return 'none'   // idle wears no ring, so a ring always means something
    },

    /** The sentence the live region announces. Voice faults are called out
     *  even though the face cannot draw them, because silently reading as
     *  idle is the one outcome a broken mic must not have. */
    _describe() {
      const raw = this._voiceRaw
      if (raw === 'error') return 'Luna\u2019s microphone has a problem'
      const state = this._resolve()
      return SPOKEN[state] ?? READY
    },
    _apply() {
      const el = this._el || (this._el = DOM.lunaFace);
      if (el) {
        el.dataset.state = this._resolve();
        el.dataset.orbit = this._resolveOrbit();
        // Absent rather than empty, so CSS can use :not([data-transient]).
        if (this._transient) el.dataset.transient = this._transient
        else delete el.dataset.transient;
        // The raw voice state is preserved as an attribute even though nothing
        // paints it yet: it is what a later voice-fault treatment keys off, and
        // it makes the state assertable from a test without a DOM screenshot.
        el.dataset.voice = this._voiceRaw;
      }
      const live = this._live || (this._live = DOM.lunaFaceStatus ?? null);
      if (live) {
        const said = this._describe();
        // Only write on change: rewriting identical text makes a polite live
        // region re-announce, which is worse than saying nothing.
        if (said !== this._said) { this._said = said; live.textContent = said; }
      }
    },
  }
  return MoonFace
}
