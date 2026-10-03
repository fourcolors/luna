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
    ttsEngine: 'system',  // persisted luna_voice_tts_engine ('system'|'fish')
    fishVoiceId: '',      // persisted luna_voice_fish_id (per-engine pick)
    silenceHangMs: 600,
    modelPresent: false,
    fishKeyConfigured: false, // voice_tts_info — key presence, never the key
    micPaused: false,      // auto mode: set when Rust refused an arm (e.g.
                           // model missing) — the waveform shows inactive
                           // and its click retries the arm
    menuOpen: false,       // #voice-menu quick-setup popover
    modelProgress: null,   // {downloadedBytes,totalBytes} during ensure_model
    _modelDownloading: false,
    _modelError: '',
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
      // The mic cluster is the only voice control in this window — the
      // probe hides it entirely on voice-less builds.
      if (DOM.voiceCluster) DOM.voiceCluster.hidden = !this.available;
      if (!this.available) this.closeVoiceMenu();
    },

    applyStatus(s) {
      const present = !!(s && (s.modelPresent === true || s.model_present === true));
      this.modelPresent = present;
      if (present) this._markModelReady();
      else this._markModelMissing();
      if (s && typeof s.state === 'string') {
        this.onStateEvent({ state: s.state, mode: s.mode });
      }
      this.paintVoiceMenu();
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
      // The menu's inline Download row needs the same progress stream the
      // settings.voice panel listens to (app-wide emit, window-targeted listen).
      W.listen('voice-model-progress', ({ payload }) => this.onModelProgress(payload || {})).catch(() => {});
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
      this.ttsEngine = localStorage.getItem('luna_voice_tts_engine') === 'fish' ? 'fish' : 'system';
      this.fishVoiceId = localStorage.getItem('luna_voice_fish_id') || '';
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
      // Engine BEFORE voice: voice_set_voice targets the active engine, so
      // a persisted fish engine must be applied first (harmless no-op on a
      // pre-router core — invoke() degrades to null, same as voice commands
      // on older builds).
      await this.invoke('voice_set_tts_engine', { engine: this.ttsEngine });
      const vid = this.ttsEngine === 'fish' ? this.fishVoiceId : this.voiceId;
      if (vid) await this.invoke('voice_set_voice', { id: vid });
      await this.invoke('voice_set_config', { silenceHangMs: this.silenceHangMs });
      // Key presence for the fish-key nudge (voice_tts_info reports only
      // fishKeyConfigured — the key itself never crosses IPC).
      await this._refreshTtsInfo();
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
      this.paintMic();
      this.paintVoiceMenu();
    },

    // ── UI wiring (mic cluster + the voice quick-setup menu) ────────────────
    bindUI() {
      if (this._uiBound) return;
      this._uiBound = true;
      const mic = DOM.voiceMicBtn;
      if (mic) {
        mic.addEventListener('click', () => this.onMicClick());
        // Press-and-hold = PTT (ptt mode only). pointerup is window-level
        // so releasing outside the button still ends the capture window.
        mic.addEventListener('pointerdown', (e) => {
          if (this.available && this.mode === 'ptt' && !this._ptt) {
            e.preventDefault();
            this.pttDown();
          }
        });
        window.addEventListener('pointerup', () => this.pttUp());
        mic.addEventListener('pointercancel', () => this.pttUp());
      }
      if (DOM.voiceModeBtn) {
        DOM.voiceModeBtn.addEventListener('click', () => this.onVoiceModeClick());
      }
      const menuBtn = DOM.voiceMenuBtn;
      if (menuBtn) {
        // stopPropagation: the document outside-click closer must not treat
        // the caret itself as "outside" (same guard attach-plus uses).
        menuBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleVoiceMenu();
        });
      }
      const menu = DOM.voiceMenu;
      if (menu) {
        menu.querySelectorAll<HTMLElement>('[data-voice-mode]').forEach((b) => {
          b.addEventListener('click', () => this.setMode(b.dataset.voiceMode));
        });
        menu.querySelectorAll<HTMLElement>('[data-voice-engine]').forEach((b) => {
          b.addEventListener('click', () => this.setTtsEngine(b.dataset.voiceEngine));
        });
      }
      if (DOM.voiceFishSave) DOM.voiceFishSave.addEventListener('click', () => this.saveFishKey());
      if (DOM.voiceFishClear) DOM.voiceFishClear.addEventListener('click', () => this.clearFishKey());
      if (DOM.voiceFishKey) {
        DOM.voiceFishKey.addEventListener('keydown', (e) => {
          // Enter saves (and must NOT bubble to a form submit); Esc closes.
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.saveFishKey(); }
          else e.stopPropagation();
        });
      }
      if (DOM.voiceFishLink) {
        DOM.voiceFishLink.addEventListener('click', () => {
          this.invoke('open_external_url', { url: 'https://fish.audio/app/api-keys/' });
        });
      }
      if (DOM.voiceModelDownload) {
        DOM.voiceModelDownload.addEventListener('click', () => this.ensureModel());
      }
      if (DOM.voiceSettingsLink) {
        DOM.voiceSettingsLink.addEventListener('click', () => {
          this.closeVoiceMenu();
          this.invoke('open_widget', { kind: 'settings.voice' });
        });
      }
      this.paintMic();
      this.paintVoiceMenu();
    },

    // Dictate (ChatGPT's mic): tap starts a dictation capture (ptt mode +
    // ptt_down), tap again stops it, a third tap disarms — hold-to-talk still
    // works while armed. Dictation only needs the speech model; the fish key
    // (a TTS concern) must not detour it into setup.
    onMicClick() {
      if (!this.available) return;
      if (this._ptt) { this.pttUp(); return; }
      if (this.mode === 'ptt') { this.setMode('off'); return; }
      if (this._blockedReason(false)) {
        this.openVoiceMenu();
        return;
      }
      this.setMode('ptt');
      this.pttDown();
    },

    // Voice (ChatGPT's waveform): one click starts/stops the hands-free
    // conversation (auto mode). A blocked start — speech model missing, or
    // the fish engine picked without a key — opens the quick-setup menu
    // instead of a silently-refused set_mode.
    onVoiceModeClick() {
      if (!this.available) return;
      if (this.mode === 'auto' && !this.micPaused) { this.setMode('off'); return; }
      if (this._blockedReason(true)) {
        this.openVoiceMenu();
        return;
      }
      this.setMode('auto');
    },

    // Why a talk-path click detours into setup instead of starting: the
    // states that make a start do nothing (or fail on every reply).
    // includeTts=false for dictate — the key only gates spoken replies.
    _blockedReason(includeTts) {
      if (!this.modelPresent) return 'model';
      if (includeTts && this.ttsEngine === 'fish' && !this.fishKeyConfigured) return 'fish-key';
      return null;
    },

    pttDown() {
      if (!this.available || this.mode !== 'ptt' || this._ptt) return;
      this._ptt = true;
      this.invoke('voice_ptt_down');
    },

    pttUp() {
      if (!this._ptt) return;
      this._ptt = false;
      this.invoke('voice_ptt_up');
    },

    // ── Voice quick-setup menu (#voice-menu) ──────────────────────────────
    toggleVoiceMenu() {
      if (this.menuOpen) this.closeVoiceMenu();
      else this.openVoiceMenu();
    },

    openVoiceMenu() {
      if (!this.available || !DOM.voiceMenu) return;
      this.menuOpen = true;
      DOM.voiceMenu.classList.add('open');
      DOM.voiceMenu.setAttribute('aria-hidden', 'false');
      if (DOM.voiceMenuBtn) DOM.voiceMenuBtn.setAttribute('aria-expanded', 'true');
      this.paintVoiceMenu();
      // The settings.voice panel (another window) may have saved/cleared the
      // key since boot — re-probe rather than trusting the boot snapshot.
      this._refreshTtsInfo();
      // Land the operator in the field they most likely came for.
      if (this.ttsEngine === 'fish' && !this.fishKeyConfigured && DOM.voiceFishKey) {
        try { DOM.voiceFishKey.focus(); } catch (_) { /* jsdom */ }
      }
    },

    closeVoiceMenu() {
      if (!this.menuOpen) return;
      this.menuOpen = false;
      if (DOM.voiceMenu) {
        DOM.voiceMenu.classList.remove('open');
        DOM.voiceMenu.setAttribute('aria-hidden', 'true');
      }
      if (DOM.voiceMenuBtn) DOM.voiceMenuBtn.setAttribute('aria-expanded', 'false');
      // One-shot secret field: never leave a typed key sitting in the DOM.
      if (DOM.voiceFishKey) DOM.voiceFishKey.value = '';
    },

    // Paints BOTH composer buttons: the mic reads dictate-armed (ptt) and
    // the waveform reads conversation-live (auto, not paused).
    paintMic() {
      const mic = DOM.voiceMicBtn;
      if (mic) {
        const armed = this.mode === 'ptt' || this._ptt;
        mic.classList.toggle('armed', armed);
        mic.classList.toggle('voice-mode-off', !armed);
        mic.title = this._ptt ? 'Stop dictating' : (armed ? 'Stop dictation' : 'Dictate');
      }
      const vm = DOM.voiceModeBtn;
      if (vm) {
        const live = this.mode === 'auto' && !this.micPaused;
        vm.classList.toggle('active', live);
        vm.title = live ? 'End voice conversation' : 'Voice conversation';
      }
    },

    paintVoiceMenu() {
      const menu = DOM.voiceMenu;
      if (!menu) return;
      menu.querySelectorAll<HTMLElement>('[data-voice-mode]').forEach((b) => {
        b.classList.toggle('active', b.dataset.voiceMode === this.mode);
      });
      menu.querySelectorAll<HTMLElement>('[data-voice-engine]').forEach((b) => {
        b.classList.toggle('active', b.dataset.voiceEngine === this.ttsEngine);
      });
      if (DOM.voiceFishSection) DOM.voiceFishSection.hidden = this.ttsEngine !== 'fish';
      if (DOM.voiceFishClear) DOM.voiceFishClear.hidden = !this.fishKeyConfigured;
      if (DOM.voiceFishStatus) {
        DOM.voiceFishStatus.textContent = this.fishKeyConfigured
          ? 'Key saved — stored at ~/.luna/fish-api-key'
          : 'No key saved — free tier at fish.audio → API Keys';
        DOM.voiceFishStatus.classList.toggle('ok', this.fishKeyConfigured);
      }
      const needModel = !this.modelPresent;
      if (DOM.voiceModelRow) DOM.voiceModelRow.hidden = !needModel;
      if (needModel && DOM.voiceModelText) {
        if (this._modelDownloading && this.modelProgress && this.modelProgress.totalBytes > 0) {
          const pct = Math.max(0, Math.min(100,
            Math.round((this.modelProgress.downloadedBytes / this.modelProgress.totalBytes) * 100)));
          DOM.voiceModelText.textContent = 'Downloading speech model… ' + pct + '%';
        } else if (this._modelDownloading) {
          DOM.voiceModelText.textContent = 'Downloading speech model…';
        } else if (this._modelError) {
          DOM.voiceModelText.textContent = 'Download failed — try again';
        } else {
          DOM.voiceModelText.textContent = 'Speech model needed to hear you';
        }
      }
      if (DOM.voiceModelDownload) DOM.voiceModelDownload.disabled = !!this._modelDownloading;
    },

    _refreshTtsInfo() {
      return this.invoke('voice_tts_info')
        .then((info) => {
          if (!info || typeof info !== 'object') return;
          this.fishKeyConfigured = info.fishKeyConfigured === true;
          this.paintVoiceMenu();
        });
    },

    setTtsEngine(engine) {
      const e = engine === 'fish' ? 'fish' : 'system';
      this.ttsEngine = e;
      localStorage.setItem('luna_voice_tts_engine', e);
      this.paintVoiceMenu();
      if (!this.available) return;
      // Switch, then re-apply the per-engine saved voice pick (the Rust
      // catalog serves the ACTIVE engine — same ordering rule as boot).
      this.invoke('voice_set_tts_engine', { engine: e })
        .then(() => {
          const vid = e === 'fish' ? this.fishVoiceId : this.voiceId;
          if (vid) return this.invoke('voice_set_voice', { id: vid });
          return null;
        })
        .then(() => this._refreshTtsInfo());
    },

    // Fish key save/clear — same contract as the settings.voice panel: the
    // value lives only in the input until voice_fish_set_key writes
    // ~/.luna/fish-api-key (0600); the field is wiped immediately after.
    saveFishKey() {
      const input = DOM.voiceFishKey;
      const key = ((input && input.value) || '').trim();
      if (!key) return;
      this.invoke('voice_fish_set_key', { key })
        .then(() => {
          if (input) input.value = '';
          return this._refreshTtsInfo();
        });
    },

    clearFishKey() {
      this.invoke('voice_fish_set_key', { key: '' })
        .then(() => this._refreshTtsInfo());
    },

    ensureModel() {
      if (this._modelDownloading) return;
      this._modelDownloading = true;
      this._modelError = '';
      this.paintVoiceMenu();
      this.invoke('voice_ensure_model')
        .then(() => {
          // Resolves when the model is present (idempotent); a rejection is
          // also reported via voice-model-progress{error} → onModelProgress.
          this._modelDownloading = false;
          this.modelPresent = true;
          this.modelProgress = null;
          this.paintVoiceMenu();
        });
    },

    onModelProgress(p) {
      if (p && p.error) {
        this._modelDownloading = false;
        this._modelError = String(p.error);
        this.paintVoiceMenu();
        return;
      }
      if (p && p.done) {
        this._modelDownloading = false;
        this.modelPresent = true;
        this.modelProgress = null;
        this.paintVoiceMenu();
        return;
      }
      this.modelProgress = {
        downloadedBytes: Number.isFinite(p.downloadedBytes) ? p.downloadedBytes : 0,
        totalBytes: Number.isFinite(p.totalBytes) ? p.totalBytes : 0,
      };
      this.paintVoiceMenu();
    },

    // The settings.voice panel writes these keys from ANOTHER window; the
    // storage event only reaches here. Mirror the new value into local state
    // (the panel already invoked the matching Tauri command — the Rust
    // controller is app-global, so re-invoking would double-switch).
    applyExternalMode(m) {
      if (m !== 'off' && m !== 'ptt' && m !== 'auto') return;
      this.mode = m;
      this.micPaused = false;
      this.paintMic();
      this.paintVoiceMenu();
    },

    syncExternalEngine(e) {
      this.ttsEngine = e === 'fish' ? 'fish' : 'system';
      this.paintVoiceMenu();
      this._refreshTtsInfo();
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
      // The composer buttons mirror the moon's voice state (listening wash /
      // transcribing breathe / speaking ripple) — the [data-voice-state] CSS
      // on .mic-btn and .voice-mode-btn.
      if (DOM.voiceMicBtn) DOM.voiceMicBtn.dataset.voiceState = visual;
      if (DOM.voiceModeBtn) DOM.voiceModeBtn.dataset.voiceState = visual;
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
