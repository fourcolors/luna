/**
 * chatEngine.ts - the composer/turn engine and the voice engine (stack23 S19k).
 *
 * THEY SHARE A FILE BECAUSE THEY REFERENCE EACH OTHER. ChatEngine drives voice
 * feedback on send; VoiceEngine calls back into ChatEngine to submit a
 * transcript. Neither can be constructed without the other, the same shape as
 * the ThreadCache/ThreadDrawerEngine cycle in S19j.
 *
 * THIS IS THE SLICE THAT DELETES GROUP C. LunaChatHost's last three imperative
 * members - appendMessage, newConversation and autoGrowMessageInput - were ALL
 * ChatEngine calls, and existed only so SlashMenu could reach a vanilla const
 * from a module. SlashMenu takes the engine directly now, and the entire
 * "Group C" category is gone from the contract rather than merely smaller.
 *
 * CSS_escape, splitSpeakableSentences and toSpeakable come along as
 * feature-private helpers and are exported because __MoonInternals pins them
 * as test hooks. splitSpeakableSentences in particular is the reason voice
 * does not read half a sentence aloud while the model is still streaming it.
 */
// @ts-nocheck

export function CSS_escape(s) {
  // Escape backslash and double-quote so the value embeds safely
  // inside [data-attr="..."] attribute selectors.
  return String(s).replace(/["\\]/g, '\\$&');
}

export function splitSpeakableSentences(buffer) {
  const text = String(buffer == null ? '' : buffer);
  const sentences = [];
  let start = 0;
  let inFence = false;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('```', i)) {
      inFence = !inFence;
      i += 3;
      continue;
    }
    // A markdown table row (line starting with optional indent + '|') is
    // protected like a fence: sentence punctuation inside cells must not
    // split the table across chunks, or the speakable filter announces
    // the SAME table once per chunk. Hop to the end of the row.
    if (!inFence && (i === 0 || text[i - 1] === '\n') && /^[ \t]{0,3}\|/.test(text.slice(i, i + 5))) {
      const nl = text.indexOf('\n', i);
      if (nl === -1) break; // row still streaming: keep it all in rest
      i = nl + 1;
      continue;
    }
    const ch = text[i];
    if (!inFence && (ch === '.' || ch === '!' || ch === '?')) {
      // Consume any closing quotes/parens hugging the terminator.
      let j = i + 1;
      while (j < text.length && /["'’”)\]]/.test(text[j])) j++;
      if (j < text.length && /\s/.test(text[j])) {
        const candidate = text.slice(start, j);
        const words = candidate.trim().split(/\s+/).filter(Boolean);
        if (words.length >= 2) {
          sentences.push(candidate.trim());
          let k = j;
          while (k < text.length && /\s/.test(text[k])) k++;
          start = k;
          i = k;
          continue;
        }
      }
    }
    i++;
  }
  return { sentences, rest: text.slice(start) };
}

export function toSpeakable(text) {
  const CODE_MSG = "I've put the code in the chat.";
  const TABLE_MSG = "There's a table in the chat.";
  let t = String(text == null ? '' : text);
  // 1) Consecutive runs of CLOSED fenced blocks (whitespace-only between)
  //    collapse to one announcement…
  t = t.replace(
    /```[^\n]*\n?[\s\S]*?```(?:\s*```[^\n]*\n?[\s\S]*?```)*/g,
    '\n' + CODE_MSG + '\n'
  );
  // …and a dangling unclosed fence (message-end flush mid-block) too.
  t = t.replace(/```[\s\S]*$/, '\n' + CODE_MSG + '\n');
  // 2) Tables: a run of lines that start with `|` reads as one table.
  t = t.replace(/(?:^|\n)(?:[ \t]*\|[^\n]*(?:\n|$))+/g, '\n' + TABLE_MSG + '\n');
  // 3) Images → alt text, links → link text (images first: same shape + `!`).
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // 4) Inline code → its literal text.
  t = t.replace(/`([^`\n]+)`/g, '$1');
  // 5) Structural markers: headings, blockquotes, list bullets/numbers.
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  t = t.replace(/^[ \t]*>[ \t]?/gm, '');
  t = t.replace(/^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+/gm, '');
  // 6) Emphasis markers (bold/italic/strikethrough) — keep the words.
  t = t.replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2');
  t = t.replace(/(\*|_)(?=\S)([^*_\n]*\S)\1/g, '$2');
  // 7) Emoji (incl. variation selectors / ZWJ joiners / flags).
  t = t.replace(/\p{Extended_Pictographic}|\uFE0F|\u200D|[\u{1F1E6}-\u{1F1FF}]/gu, '');
  // 8) Speech is one line: collapse all whitespace.
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/**
 * Everything chat.html owns that these two reach. The objects are handed over
 * WHOLE, never narrowed to the members this file's own text calls - S19j lost
 * time to exactly that, because an engine can pass a collaborator straight
 * through to another module that uses more of it.
 */
export interface ChatEngineCtx {
  readonly Logger: {
    info: (m?: unknown, ...a: unknown[]) => void
    warn: (m?: unknown, ...a: unknown[]) => void
    error: (m?: unknown, ...a: unknown[]) => void
  }
  readonly DOM: Record<string, HTMLElement | null>
  /** The LIVE State object, never a copy. */
  readonly State: Record<string, unknown> | undefined
  readonly WebSocketEngine: {
    send: (frame: unknown) => void
    isConnected: () => boolean
    clearTurnTimeout: () => void
    startTurnTimeout: () => void
    sendNewThread: () => void
  }
  readonly ChatState: Record<string, unknown>
  readonly ChatLoop: Record<string, unknown>
  readonly MoonFace: { setBusy: (b: unknown) => void; setVoice: (s: string) => void }
  readonly MoonClient: { CLIENT_INFO: unknown }
  readonly SlashMenu: Record<string, unknown>
  readonly Attachments: Record<string, unknown>
  readonly ThreadCache: { markBusy: (id: string) => void }
  /** Late-bound; see threadDrawer's identical hook. Fired when the viewed
   *  thread changes so per-thread surfaces can re-resolve. */
  readonly onThreadSwitch?: (() => void) | undefined
  /**
   * Single-writer callback for the "new conversation" user-intent clear.
   * Bound in bootChat.ts alongside the threadDrawer's setActiveThread binding
   * so chatEngine.ts does not import state.ts directly.
   * (id: string, reason: string) => void — same param shape for symmetry
   * but reason is the only arg; the function takes (State, reason) internally.
   */
  readonly clearActiveThread?: ((reason: string) => void) | undefined
}

export function createChatEngine(ctx: ChatEngineCtx) {
  const {
    Logger, DOM, State, WebSocketEngine, ChatState, ChatLoop,
    MoonFace, MoonClient, SlashMenu, Attachments, ThreadCache, onThreadSwitch,
    clearActiveThread,
  } = ctx

  const ChatEngine = {
    // ----------------------------------------------------------------------
    // Chat-bubble surface. After the thread-state refactor, this object is
    // a thin adapter: it routes user/banner messages and tool frames into
    // ChatState, then asks ChatLoop to render. It NO LONGER writes to the
    // chat-messages container directly. Legacy method names are preserved
    // so callers (and tests) don't have to change.
    // ----------------------------------------------------------------------

    // Legacy predicate. State has no concept of "visually empty" — empty
    // turns are dropped at finishTurn time. Kept here as `false` so any
    // remaining callers see "this bubble is not empty" and proceed.
    isVisuallyEmpty() { return false; },

    // Legacy sweep. ChatState.finishTurn already drops zero-content turns
    // before the renderer ever paints them, so there's nothing to sweep.
    // Kept as a no-op for backward callers.
    sweepTrailingEmptyAssistantBubbles() {},

    // Route a frame's tool-call into ChatState. Returns the newly-rendered
    // card element (test ergonomics).
    appendToolCallCard(frame) {
      ChatState.applyToolCall(frame.turnId, frame.toolCallId, frame.name, frame.input, frame.parentToolUseId);
      ChatLoop.flush();
      return DOM.chatMessages.querySelector(
        '.tool-call-card[data-tool-call-id="' + CSS_escape(String(frame.toolCallId || '')) + '"]'
      );
    },

    // Route a frame's tool-result into ChatState. Returns the now-updated
    // card element, or null if no matching tool-call had been emitted.
    attachToolResult(frame) {
      ChatState.applyToolResult(
        frame.toolCallId,
        frame.status === 'ok',
        frame.output,
        frame.truncated
      );
      ChatLoop.flush();
      const id = String(frame.toolCallId || '');
      if (!id) return null;
      return DOM.chatMessages.querySelector(
        '.tool-call-card[data-tool-call-id="' + CSS_escape(id) + '"]'
      );
    },

    // Append a user, assistant-banner, or system message. The fourth
    // argument (previews) is honored for user messages.
    appendMessage(role, text, render = false, previews = null) {
      if (role === 'user') {
        ChatState.appendUser(text, previews);
      } else {
        // Assistant role here is used for banners / status lines / errors,
        // NOT streaming assistant turns (those go through the WS handler).
        ChatState.appendBanner(text);
      }
      ChatLoop.flush();
      return DOM.chatMessages.lastElementChild;
    },

    // Auto-grow the message-input textarea (unchanged from pre-refactor).
    autoGrowMessageInput() {
      const ta = DOM.messageInput;
      if (!ta) return;
      ta.style.height = 'auto';
      const MIN = 38, MAX = 320;
      const next = Math.max(MIN, Math.min(MAX, ta.scrollHeight));
      ta.style.height = next + 'px';
    },

    // Push a pending-assistant turn so the renderer paints typing dots
    // immediately after the operator hits send. The first assistant-delta
    // upgrades the placeholder into a real turn keyed by turnId.
    showTypingIndicator() {
      ChatState.beginPendingAssistant();
      ChatLoop.flush();
      return DOM.chatMessages.lastElementChild;
    },

    newConversation() {
      Logger.info("Clearing conversation -> requesting a new thread");
      // USER INTENT → centralized clear. clearActiveThread nulls both
      // activeThreadId and activeTurnId so this path stays consistent with
      // the setActiveThread/clearActiveThread invariants enforced by the
      // allowlist fence test (test/thread-switch-snap.test.ts).
      // Falls back to the direct assignments if the callback is absent (e.g.
      // in tests that do not wire bootChat) — the fence test verifies the
      // production wiring is present.
      if (clearActiveThread) {
        clearActiveThread('new-conversation');
      } else {
        State.activeThreadId = null;
        State.activeTurnId = null;
      }
      WebSocketEngine.clearTurnTimeout();
      // ABANDONING A TURN IS A CLEAR. Without this the face sticks on "busy"
      // forever: activeThreadId is now null, so the old thread's turn-complete
      // early-returns on the threadId mismatch before it reaches setBusy(false),
      // and the watchdog that would have caught it was just cleared above.
      MoonFace.setBusy(false);
      // A NEW CONVERSATION IS A THREAD SWITCH. The suggestion chip is
      // per-thread, and wiring refresh() only into the drawer's row-click left
      // this door open: propose an action on thread A, hit new conversation,
      // and A's chip plus the happy face stay up over an empty thread.
      onThreadSwitch?.();
      State.pendingUserMessage = null;
      // The composer draft and staged attachments deliberately survive the
      // switch - they carry into the fresh thread, ready to send.
      ChatState.reset();
      this.appendMessage('assistant', 'New conversation started. Type a message below!');
      if (WebSocketEngine.isConnected()) {
        State.pendingFreshThread = false;
        WebSocketEngine.sendNewThread();
      } else {
        State.pendingFreshThread = true;
        Logger.warn("Not connected; cleared locally. A new thread is created on next connect.");
      }
    },

    handleSubmit(e) {
      e.preventDefault();
      // Single-fire guard against ANY double-call within the same task tick.
      // Catches: WKWebView quirks where Enter on a textarea inside a form
      // with a `type="submit"` button fires BOTH the textarea's keydown
      // (which calls handleSubmit) AND the form's implicit submit (which
      // also calls handleSubmit); a button double-tap where the click
      // dispatches twice; any future re-wiring that double-binds the
      // submit handler. The textarea-empty check downstream is a soft
      // dedup but won't catch e.g. attachment-only sends or the
      // no-active-thread branch that sends a new-thread frame before
      // clearing state. This flag clears on the next microtask, so two
      // intentional user submits (button click + button click separated
      // by reaction time) still both fire.
      if (this._submitting) return;
      this._submitting = true;
      queueMicrotask(() => { this._submitting = false; });

      const typed = DOM.messageInput.value.trim();

      // Slash-command intercept: a complete "/cmd [args]" submitted with Enter
      // (e.g. "/model sonnet", which has a space so the live menu is closed).
      // _submitting (set above) is a backstop; we return before any WS send.
      if (typed.startsWith('/')) {
        const LC = window.LunaCapabilities;
        const parsed = LC ? LC.parseCommandLine(typed) : null;
        // Only treat it as a command when UNAMBIGUOUS: the argless verbs
        // (clear/new/help) must be the bare line, so "/new feature idea" sends as
        // a normal message instead of wiping the thread and dropping the text.
        // Only /model and /effort accept trailing args.
        // Dispatch a typed "/cmd [args]" + Enter when unambiguous: argless commands
        // (clear/new/help/interrupt) must be the bare line; only commands that declare
        // an argHint (model/effort) take trailing args. Includes backend-advertised
        // commands (buildCommands merges them in).
        const cmd = parsed ? SlashMenu.buildCommands().find((c) => c.id === parsed.name) : null;
        if (cmd && (parsed.args === '' || cmd.arghint)) {
          SlashMenu.dispatch(parsed.name, parsed.args);
          return;
        }
      }

      const folded = Attachments.textBlock();
      const wire = Attachments.wireAttachments();
      const previews = Attachments.previews();

      // The wire text carries typed input PLUS folded file contents; the
      // visible bubble shows only what the user typed (folded files would
      // bury the conversation transcript).
      const wireText = [typed, folded].filter(Boolean).join('\n\n');
      if (!wireText && !wire) return;   // nothing to send

      // A new user send interrupts any spoken reply (voice_stop_speaking)
      // and drops queued speech for the superseded turn. Safe no-op when
      // voice is off/unavailable.
      VoiceEngine.onUserSend();

      // Attempt the send FIRST, then decide whether to mutate the composer, so
      // an offline no-op can't destroy the user's input.
      const _connected = WebSocketEngine.isConnected();

      // Send user message over the real WebSocket!
      if (State.activeThreadId) {
        // Existing thread: only put a frame on the wire when connected.
        // Offline is a pure no-op here; the guard below keeps the composer.
        if (_connected) {
          WebSocketEngine.send({
            type: 'user-message',
            threadId: State.activeThreadId,
            text: wireText,
            client: MoonClient.CLIENT_INFO,
            ...(wire ? { attachments: wire } : {})
          });
        }
      } else if (_connected) {
        // Online, no thread yet: stash + mint; thread-created flushes the stash.
        Logger.warn("No active thread subscribed; queuing message and creating new thread");
        State.pendingUserMessage = { text: wireText, attachments: wire };
        WebSocketEngine.sendNewThread();
      } else {
        // Offline + no thread: queue once for reconnect mint+flush. A second
        // offline submit must NOT overwrite the first queued payload (single
        // slot) or paint another phantom "sent" bubble.
        if (State.pendingUserMessage) {
          Logger.warn('Send while disconnected: already have a queued offline message; keeping the first');
          const _lastDup = DOM.chatMessages && DOM.chatMessages.lastElementChild;
          if (!(_lastDup && _lastDup.getAttribute('data-offline-notice') === 'already-queued')) {
            const _el = this.appendMessage('assistant', "⚠️ Not connected. A message is already queued for reconnect; your new draft is still in the box.");
            if (_el) _el.setAttribute('data-offline-notice', 'already-queued');
            if (DOM.chatMessages) DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
          }
          return;
        }
        Logger.warn("No active thread subscribed; queuing message for reconnect mint");
        State.pendingUserMessage = { text: wireText, attachments: wire };
        // sendNewThread() is a no-op offline; mark pendingFreshThread so
        // syncThread() mints on reconnect (instead of resubscribing a prior
        // thread and stranding the queue).
        State.pendingFreshThread = true;
      }

      // Silent-data-loss guard: while offline, never paint a "sent" bubble.
      //  - Existing thread: nothing was queued — keep composer for retry.
      //  - No thread: we just stashed pendingUserMessage — clear the box
      //    (queue is source of truth for reconnect flush) without a phantom
      //    bubble so the user is not told it already sent.
      if (!_connected) {
        if (State.activeThreadId) {
          Logger.warn('Send while disconnected: preserving composer input for retry');
          const _last = DOM.chatMessages && DOM.chatMessages.lastElementChild;
          if (!(_last && _last.getAttribute('data-offline-notice') === 'not-sent')) {
            const _el = this.appendMessage('assistant', "⚠️ Not connected. Your message wasn't sent; it's still in the box. Try again once you reconnect.");
            if (_el) _el.setAttribute('data-offline-notice', 'not-sent');
            if (DOM.chatMessages) DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
          }
          return;
        }
        Logger.warn('Send while disconnected (new thread): queued for reconnect; no phantom bubble');
        DOM.messageInput.value = '';
        this.autoGrowMessageInput();
        Attachments.clear();
        const _lastQ = DOM.chatMessages && DOM.chatMessages.lastElementChild;
        if (!(_lastQ && _lastQ.getAttribute('data-offline-notice') === 'queued')) {
          const _el = this.appendMessage('assistant', "⚠️ Not connected. Your message is queued and will send when you reconnect.");
          if (_el) _el.setAttribute('data-offline-notice', 'queued');
          if (DOM.chatMessages) DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
        }
        return;
      }

      Logger.info(`Appended user message: "${typed}" (+${previews.length} attachment(s))`);
      this.appendMessage('user', typed, false, previews);
      DOM.messageInput.value = '';
      this.autoGrowMessageInput(); // snap back to the one-line floor after send
      Attachments.clear();
      DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;

      // Show the typing indicator + arm the turn watchdog only when the send
      // actually went out (online path only — offline returned above).
      this.showTypingIndicator();
      MoonFace.setBusy(true);   // a turn is in flight → face goes "thinking"
      // Mark this thread busy for the sidebar pulse so a mid-turn switch
      // still shows background work on the other row.
      if (State.activeThreadId) ThreadCache.markBusy(State.activeThreadId);
      WebSocketEngine.startTurnTimeout();
    }
  }

  const VoiceEngine = {
    MODES: ['off', 'ptt', 'auto'],
    available: false,
    state: 'off',          // last Rust voice-state
    mode: 'off',           // persisted user preference (luna_voice_mode)
    speakReplies: true,
    voiceId: '',
    silenceHangMs: 600,
    modelPresent: false,
    micPaused: false,      // auto mode: mic click parks the pipeline without
                           // rewriting the persisted preference
    rustMode: 'off',       // EFFECTIVE mode (Rust can refuse, e.g. model
                           // missing); fed by voice-state events + the
                           // VoiceStatus returned from voice_set_mode
    _ptt: false,
    _uiBound: false,
    _subscribed: false,
    // Spoken-reply pipeline: per-message cumulative wire text (the server
    // streams CUMULATIVE assistant text — same contract ChatState.applyDelta
    // documents) and the unsplit sentence remainder.
    _cum: new Map(),
    _buf: new Map(),

    // Guarded invoke: resolves null off-Tauri; failures log once per call
    // site but never throw into the UI. Reads __TAURI__ at CALL time.
    invoke(cmd, args) {
      const core = window.__TAURI__ && window.__TAURI__.core;
      if (!core) return Promise.resolve(null);
      return core.invoke(cmd, args).catch((e) => {
        Logger.warn(`Voice command ${cmd} failed:`, e);
        return null;
      });
    },

    // ── Boot ────────────────────────────────────────────────────────────
    // Synchronous up to the availability probe so jsdom (no __TAURI__.core)
    // lands in a deterministic "unavailable" state before any snapshot.
    init() {
      this.loadSettings();
      this.bindUI();
      const core = window.__TAURI__ && window.__TAURI__.core;
      if (!core) { this.setAvailable(false); return; }
      return this._probe(core);
    },

    async _probe(core) {
      let status = null;
      try {
        status = await core.invoke('voice_status');
      } catch (_) {
        // Older Rust core without the voice pipeline: hide/disable the
        // voice surface, exactly once, no console spam.
        this.setAvailable(false);
        Logger.info('Voice pipeline not available in this build (voice_status missing)');
        return;
      }
      this.setAvailable(true);
      this.applyStatus(status);
      this.subscribeEvents();
      await this.applyPersisted();
    },

    setAvailable(av) {
      this.available = !!av;
      // Composer mic removed — availability is for spoken-reply / transcript
      // paths only. Settings → Voice owns the hands-free UI.
    },

    applyStatus(s) {
      const present = !!(s && (s.modelPresent === true || s.model_present === true));
      this.modelPresent = present;
      if (present) this._markModelReady();
      else this._markModelMissing();
      if (s && typeof s.state === 'string') {
        this.onStateEvent({ state: s.state, mode: s.mode });
      }
    },

    subscribeEvents() {
      if (this._subscribed) return;
      // Voice events are broadcast app-wide by the Rust core; use the
      // WINDOW-targeted listen (getCurrentWindow().listen) so this window
      // hears them without the hub's global-event cross-talk surface.
      let W = null;
      try {
        if (window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow) {
          W = window.__TAURI__.window.getCurrentWindow();
        }
      } catch (_) { /* off-Tauri */ }
      if (!W || typeof W.listen !== 'function') return;
      this._subscribed = true;
      W.listen('voice-state', ({ payload }) => this.onStateEvent(payload || {})).catch(() => {});
      W.listen('voice-transcript', ({ payload }) => this.handleTranscript(payload && payload.text)).catch(() => {});
      W.listen('voice-error', ({ payload }) => this.onVoiceError(payload || {})).catch(() => {});
      // (voice-model-progress is the settings.voice panel's concern.)
    },

    // ── Settings (persisted; VOICE.md keys) ─────────────────────────────
    // Boot/hub MUST NOT re-arm hands-free. Settings → Voice can still write
    // luna_voice_mode=auto; the next boot forces off and persists that.
    loadSettings() {
      const m = localStorage.getItem('luna_voice_mode');
      if (m === 'ptt' || m === 'auto') {
        try { localStorage.setItem('luna_voice_mode', 'off'); } catch (_) { /* quota */ }
      }
      this.mode = 'off';
      this.speakReplies = localStorage.getItem('luna_voice_speak_replies') !== '0';
      this.voiceId = localStorage.getItem('luna_voice_id') || '';
      const hang = parseInt(localStorage.getItem('luna_voice_silence_hang_ms') || '', 10);
      this.silenceHangMs = Number.isFinite(hang)
        ? Math.max(300, Math.min(1200, hang))
        : 600;
    },

    // Rust can refuse a requested mode (a missing model forces off):
    // consume the returned VoiceStatus so the UI knows the EFFECTIVE mode.
    _applyModeResult(requested, st) {
      if (!st || typeof st.mode !== 'string') return;
      this.rustMode = st.mode;
      if (requested !== 'off' && st.mode === 'off') this.micPaused = true;
    },

    // Re-apply to the Rust core each session — always off at boot.
    async applyPersisted() {
      const st = await this.invoke('voice_set_mode', { mode: 'off' });
      this._applyModeResult('off', st);
      if (this.voiceId) await this.invoke('voice_set_voice', { id: this.voiceId });
      await this.invoke('voice_set_config', { silenceHangMs: this.silenceHangMs });
    },

    setMode(mode) {
      const m = this.MODES.includes(mode) ? mode : 'off';
      this.mode = m;
      this.micPaused = false;
      localStorage.setItem('luna_voice_mode', m);
      if (this.available) {
        this.invoke('voice_set_mode', { mode: m })
          .then((st) => this._applyModeResult(m, st));
      }
      if (m === 'off') this.stopSpeaking();
    },

    // Composer mic is gone — no UI bind. Settings → Voice owns mode toggles.
    bindUI() {
      if (this._uiBound) return;
      this._uiBound = true;
    },

    // ── Transcript → the EXACT existing send path ───────────────────────
    // Empty composer: fill + auto-send via the same form submit the send
    // button fires (handleSubmit → user-message frame incl. client info).
    // Non-empty draft: append with a space, do NOT send (they were mid-edit).
    handleTranscript(text) {
      // Mode gate: a transcript landing AFTER the user turned voice off
      // (settings toggle) must never auto-send. The Rust side suppresses
      // transcripts whose inference a Stop rode through, but an event already
      // over the IPC bridge still arrives here.
      if (this.mode === 'off' || this.micPaused) return;
      const t = String(text == null ? '' : text).trim();
      if (!t) return;
      const input = DOM.messageInput;
      if (!input) return;
      if (!input.value.trim()) {
        input.value = t;
        ChatEngine.autoGrowMessageInput();
        DOM.chatForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      } else {
        input.value = input.value + (/\s$/.test(input.value) ? '' : ' ') + t;
        ChatEngine.autoGrowMessageInput();
      }
    },

    // ── Spoken replies (delta accumulator → sentences → speak_text) ─────
    shouldSpeak() {
      return this.available && this.mode !== 'off' && this.speakReplies;
    },

    onAssistantDelta(turnId, cumText) {
      if (!this.shouldSpeak()) return;
      const id = String(turnId || 'pending');
      const cum = String(cumText == null ? '' : cumText);
      const prev = this._cum.get(id) || '';
      // Wire deltas are CUMULATIVE (see ChatState.applyDelta): speak only
      // the incremental suffix; a non-monotonic reset falls back to the
      // whole text (better to over-speak than drop the answer).
      let inc;
      if (cum.length >= prev.length && cum.startsWith(prev)) {
        inc = cum.slice(prev.length);
      } else {
        inc = cum;
      }
      this._cum.set(id, cum);
      if (!inc) return;
      const buf = (this._buf.get(id) || '') + inc;
      const res = splitSpeakableSentences(buf);
      this._buf.set(id, res.rest);
      for (const s of res.sentences) this.speakSentence(s);
    },

    onAssistantDone(turnId) {
      const id = String(turnId || 'pending');
      const rest = this._buf.get(id) || '';
      this._buf.delete(id);
      this._cum.delete(id);
      if (!this.shouldSpeak()) return;
      if (rest.trim()) this.speakSentence(rest);
    },

    onTurnComplete() {
      // Safety flush: anything still buffered (a missed assistant-done,
      // a turnId mismatch) gets spoken now rather than swallowed.
      const speak = this.shouldSpeak();
      for (const rest of this._buf.values()) {
        if (speak && rest.trim()) this.speakSentence(rest);
      }
      this._buf.clear();
      this._cum.clear();
    },

    speakSentence(raw) {
      const text = toSpeakable(raw);
      if (!text) return;
      this.invoke('speak_text', { text, interrupt: false });
    },

    stopSpeaking() {
      this._buf.clear();
      this._cum.clear();
      if (!this.available) return;
      this.invoke('voice_stop_speaking');
    },

    onUserSend() { this.stopSpeaking(); },

    // Esc stops the spoken reply UNCONDITIONALLY (VOICE.md stop-speaking
    // triad; stopSpeaking is idempotent). Gating on state==='speaking'
    // left Esc dead after a pipeline error (nothing re-emits 'speaking'
    // once the thread parks in error, but speak_text still plays) and
    // during the ~150ms speech-start latency window.
    handleEscape() {
      if (!this.available) return;
      this.stopSpeaking();
    },

    // ── Rust events → UI state ──────────────────────────────────────────
    onStateEvent(p) {
      const state = (p && typeof p.state === 'string') ? p.state : '';
      this.state = state || 'off';
      if (p && this.MODES.includes(p.mode)) this.rustMode = p.mode;
      const visual = (state && state !== 'off') ? state : '';
      const w = DOM.moonWrapper;
      if (w) {
        w.dataset.voiceState = visual;
        if (state === 'listening' && typeof p.level === 'number' && Number.isFinite(p.level)) {
          w.style.setProperty('--voice-level', String(Math.max(0, Math.min(1, p.level))));
        } else if (state !== 'listening') {
          w.style.removeProperty('--voice-level');
        }
      }
      MoonFace.setVoice(visual);   // wide eyes when listening, chatter when speaking
    },

    onVoiceError(p) {
      const msg = (p && typeof p.message === 'string' && p.message) ? p.message : 'Unknown voice error';
      Logger.warn('Voice error:', msg);
      // Non-blocking transcript banner (the chat keeps working).
      try {
        ChatState.appendBanner(`⚠️ Voice: ${msg}`);
        ChatLoop.flush();
      } catch (_) { /* transcript not ready in early boot — log only */ }
    },

    // ── Whisper model presence (download UI → settings.voice panel) ─────
    _markModelReady() { this.modelPresent = true; },
    _markModelMissing() { this.modelPresent = false; },
  }

  return { ChatEngine, VoiceEngine }
}
