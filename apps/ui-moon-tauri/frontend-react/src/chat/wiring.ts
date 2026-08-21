/**
 * wiring.ts - the DOM event wiring and the boot parameters (stack23 S20c).
 *
 * Everything that turns a rendered chat window into a live one: 33 element
 * listeners, the `?thread=` / `?redockTo=` derivation, the Phase C detach
 * seed, and the window-label resolution. It is the LAST layer to move because
 * it touches every engine and every element - which is also why it is a single
 * verbatim block rather than a rewrite.
 *
 * IT RETURNS THE BOOT PARAMS RATHER THAN RE-DERIVING THEM. `?thread=new` is a
 * SENTINEL meaning "mint your own fresh thread", not a real id, and until this
 * slice main-chat.tsx carried a second copy of that rule so the wire could be
 * built. Now there is one derivation, here, and the wire is built from what it
 * returns.
 *
 * ORDER: it runs AFTER every engine (its listeners call them) and BEFORE the
 * wire (which needs the params, and whose boot reads State.pinnedThread that
 * this sets). Nothing here touches the wire itself, which is what makes that
 * position available at all.
 */
// @ts-nocheck

export interface WiringCtx {
  readonly Logger: {
    info: (m?: unknown, ...a: unknown[]) => void
    warn: (m?: unknown, ...a: unknown[]) => void
    error: (m?: unknown, ...a: unknown[]) => void
  }
  readonly DOM: Record<string, HTMLElement | null>
  /** The LIVE State object - this sets pinnedThread and winLabel on it. */
  readonly State: Record<string, unknown>
  /** Every engine a listener can reach, handed over WHOLE. */
  readonly engines: Record<string, unknown>
}

export function installMoonE2E() {
  window.__moonE2E = {
    version: 1,
    getDragDebug() {
      return window.__moonDragDebug || null;
    },
    listThreadIds() {
      try {
        return (ThreadDrawerEngine._visibleThreads() || []).map((t) => t.id);
      } catch (_) {
        return [];
      }
    },
    hasLunaThreadDrag() {
      return !!(window.LunaThreadDrag && typeof window.LunaThreadDrag.createSession === 'function');
    },
    /**
     * Pure session walk: elasticity → attached → detach. Does not open windows.
     * Used to prove the in-app state machine under WebDriver without OS mouse.
     */
    simulateSessionDetach() {
      if (!window.LunaThreadDrag) return null;
      const strip = { left: 0, top: 0, right: 200, bottom: 400 };
      const s = window.LunaThreadDrag.createSession({
        threadId: 'e2e-sim',
        startClientX: 40,
        startClientY: 40,
        rowCount: 3,
        onEvent: (ev) => moonDragDebugNote(ev.kind, {
          action: ev.extra && ev.extra.action,
          outcome: ev.extra && ev.extra.outcome,
          session: ev.session,
        }),
      });
      // Stay inside strip past elasticity → attached
      let m = s.pointerMove({ clientX: 40, clientY: 80, stripRect: strip, rowCount: 3 });
      // Leave strip → detach
      m = s.pointerMove({ clientX: 360, clientY: 80, stripRect: strip, rowCount: 3 });
      const up = s.pointerUp({ clientX: 360, clientY: 80, stripRect: strip, rowCount: 3 });
      return { lastMove: m, up: up, snapshot: s.snapshot() };
    },
    /**
     * Open a floater via the same open_widget path as drag-out (focus:false).
     * Returns a Promise of the window label.
     */
    openFloater(threadId, x, y) {
      const id = threadId || (this.listThreadIds()[0]) || 'e2e-thread';
      try { ThreadDrawerEngine._seedFloaterCache(id); } catch (_) { /* ok empty */ }
      return ThreadDrawerEngine.openInNewWindow(
        id,
        typeof x === 'number' ? x : 420,
        typeof y === 'number' ? y : 220,
        { focus: false },
      );
    },
    closeFloater(label) {
      try { ThreadDrawerEngine._closeFloater(label); } catch (_) {}
    },
  };
}

export function installWiring(ctx: WiringCtx) {
  const { Logger, DOM, State } = ctx
  const {
    ArtifactsEngine, Attachments, ChatEngine, ChatLoop, ChatState,
    ComposerConfig, FeedbackEngine, formatRelTime, buildMessageMeta,
    LocalShell, SecretPromptEngine, SlashMenu, SuggestedActionsEngine,
    SurveyEngine, ThreadCache, ThreadDrawerEngine, VoiceEngine,
    moonDragDebugNote,
  } = ctx.engines

  // (StreamRender stayed in chat.html: it is a test-hook alias this file
  // never used, and LunaMarkdown is still reachable there.)

  // Copy-message affordance ─────────────────────────────────────────────
  // Lucide-style inline SVG glyphs (two overlapping squares = copy; a
  // checkmark = the brief "copied" confirmation). EXPLICIT width/height are
  // load-bearing: these are injected via innerHTML at runtime, and WKWebView
  // (Tauri's webview) computes an SVG's intrinsic size from its attributes —
  // a viewBox-only SVG sized purely by CSS renders blank/wrong there, unlike
  // Chromium. Matching the static header icons (chat.html ~1633-1668), which
  // all carry explicit width/height, is what makes them render. Explicit
  // close tags keep the HTML parser from treating the foreign elements as
  // containers.
  // The message-meta cluster - MSG_COPY_GLYPH/MSG_CHECK_GLYPH/
  // MSG_COPY_FLASH_MS, buildMessageCopyButton, formatRelTime and
  // buildMessageMeta - converted to a typed module (stack23 S19i):
  // src/chat/messageMeta.ts, moved verbatim apart from three signatures
  // gaining types. It was a PURE LEAF: nothing in it referenced anything
  // outside itself.
  //
  // Moving it DELETED LunaChatHost.buildMessageMeta. MessageList.tsx reached
  // it through the host only because it lived here; it imports the function
  // now. That took Group C from 4 to 3; S19k took it to ZERO.
  //
  // Only formatRelTime is still read from this file (the drawer's relative
  // stamps and the msg-time refresh listener), both late-bound.
  // formatRelTime arrives through ctx.engines now (S20c); its chat.html forward
  // declaration travelled inside this span and is no longer needed here.
  // buildMessageMeta arrives through ctx.engines now (S20c); its chat.html forward
  // declaration travelled inside this span and is no longer needed here.
  var buildMessageCopyButton;   // read only by the __MoonInternals test hook

  // Wire UserAsk panel buttons (Submit / Dismiss). Safe to bind here because
  // the DOM is already parsed by the time this <script> executes (inline at
  // bottom of <body>), and the DOM map captured the handles a few lines up.
  if (DOM.userAskSubmit) {
    DOM.userAskSubmit.addEventListener('click', () => SurveyEngine.submit());
  }
  if (DOM.userAskDismiss) {
    DOM.userAskDismiss.addEventListener('click', () => SurveyEngine.dismiss());
  }

  // S4: luna:// links in assistant prose open a widget. The Rust open_widget
  // registry is the actual gate (an unknown kind no-ops), so this only
  // parses kind + scalar params and forwards. Delegated on the persistent
  // #chat-messages container (cards are rebuilt every paint), so it survives
  // re-renders without re-binding.
  if (DOM.chatMessages) {
    DOM.chatMessages.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[data-luna-link]') : null;
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      // luna://artifact/<id> → reopen a pinned artifact in its own widget
      // window. The title comes from the client's pinned-artifact cache
      // (populated by the artifact-list frame); open_artifact_widget tolerates
      // an empty/unknown title and renders by id, so an uncached id still opens.
      const artMatch = /^luna:\/\/artifact\/([^?\s]+)$/i.exec(href);
      if (artMatch) {
        // decodeURIComponent throws on malformed percent-encoding (e.g. "%E0%").
        // Bail out rather than letting the exception abort the whole handler.
        let id;
        try { id = decodeURIComponent(artMatch[1]); }
        catch (_) { Logger.warn('luna-link artifact: malformed id, ignoring'); return; }
        const known = State.pinnedArtifacts.find((p) => p.id === id);
        if (window.__TAURI__ && window.__TAURI__.core) {
          window.__TAURI__.core.invoke('open_artifact_widget', {
            artifactId: id,
            title: (known && known.title) || '',
          }).catch((err) => Logger.warn('luna-link artifact open failed:', err));
        }
        return;
      }
      const m = /^luna:\/\/widget\/([a-z0-9.]+)(?:\?(.*))?$/i.exec(href);
      if (!m) return;
      const args = { kind: m[1] };
      if (m[2]) {
        const params = {};
        m[2].split('&').forEach((kv) => {
          const i = kv.indexOf('=');
          if (i <= 0) return;
          const k = decodeURIComponent(kv.slice(0, i));
          const v = decodeURIComponent(kv.slice(i + 1));
          if (/^[a-zA-Z0-9_]+$/.test(k)) params[k] = v;
        });
        if (Object.keys(params).length) args.params = params;
      }
      if (window.__TAURI__ && window.__TAURI__.core) {
        window.__TAURI__.core.invoke('open_widget', args)
          .catch((err) => Logger.warn('luna-link open failed:', err));
      }
    });
  }

  // Refresh-on-interaction (no timer): clicking or focusing a message
  // recomputes its relative send-time from the stored epoch, so an idle
  // "9m ago" updates the moment you touch it. `focusin` bubbles, so tabbing
  // onto the copy button refreshes that message's time for free. One
  // delegated listener on the stable container survives bubble rebuilds.
  if (DOM.chatMessages) {
    const refreshMsgTime = (e) => {
      const t = e.target;
      const msg = t && t.closest ? t.closest('.msg') : null;
      if (!msg) return;
      const span = msg.querySelector('.msg-time[data-ts]');
      if (!span) return;
      const ts = Number(span.dataset.ts);
      if (isFinite(ts)) span.textContent = formatRelTime(ts);
    };
    DOM.chatMessages.addEventListener('click', refreshMsgTime);
    DOM.chatMessages.addEventListener('focusin', refreshMsgTime);
  }

  // Wire the Artifacts panel close button and header toggle.
  if (DOM.artifactsPanelClose) {
    DOM.artifactsPanelClose.addEventListener('click', () => ArtifactsEngine.closePanel());
  }
  if (DOM.artifactsBtnInner) {
    DOM.artifactsBtnInner.addEventListener('click', () => ArtifactsEngine.togglePanel());
  }

  // Wire the secure secret-entry panel buttons (Submit / Cancel / × ).
  if (DOM.secretPromptSubmit) {
    DOM.secretPromptSubmit.addEventListener('click', () => SecretPromptEngine.submit());
  }
  if (DOM.secretPromptCancel) {
    DOM.secretPromptCancel.addEventListener('click', () => SecretPromptEngine.cancel());
  }
  if (DOM.secretPromptCancelX) {
    DOM.secretPromptCancelX.addEventListener('click', () => SecretPromptEngine.cancel());
  }
  // Enter in the password field submits (matches a single-field form's feel).
  if (DOM.secretPromptInput) {
    DOM.secretPromptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); SecretPromptEngine.submit(); }
    });
  }

  // ── Point-at-the-UI feedback wiring ───────────────────────────────────
  if (DOM.feedbackBtn) {
    DOM.feedbackBtn.addEventListener('click', () => FeedbackEngine.togglePicker());
  }
  if (DOM.feedbackSubmit) {
    DOM.feedbackSubmit.addEventListener('click', () => FeedbackEngine.submit());
  }
  if (DOM.feedbackCancel) {
    DOM.feedbackCancel.addEventListener('click', () => FeedbackEngine.cancel());
  }
  if (DOM.feedbackCancelX) {
    DOM.feedbackCancelX.addEventListener('click', () => FeedbackEngine.cancel());
  }
  if (DOM.feedbackInput) {
    DOM.feedbackInput.addEventListener('input', () => FeedbackEngine.onInput());
    DOM.feedbackInput.addEventListener('keydown', (e) => {
      // Cmd/Ctrl+Enter submits; Escape closes the composer.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); FeedbackEngine.submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); FeedbackEngine.cancel(); }
    });
  }

  // ── Suggested-actions chip click handlers ─────────────────────────────
  if (DOM.suggestedActionAccept) {
    DOM.suggestedActionAccept.addEventListener('click', () => {
      const actionId = DOM.suggestedActionPanel && DOM.suggestedActionPanel.dataset.actionId;
      if (actionId) SuggestedActionsEngine._respond(actionId, 'accept');
    });
  }
  if (DOM.suggestedActionDismiss) {
    DOM.suggestedActionDismiss.addEventListener('click', () => {
      const actionId = DOM.suggestedActionPanel && DOM.suggestedActionPanel.dataset.actionId;
      if (actionId) SuggestedActionsEngine._respond(actionId, 'dismiss');
    });
  }
  if (DOM.suggestedActionCancelX) {
    // X button = dismiss the shown action (same as Dismiss).
    DOM.suggestedActionCancelX.addEventListener('click', () => {
      const actionId = DOM.suggestedActionPanel && DOM.suggestedActionPanel.dataset.actionId;
      if (actionId) SuggestedActionsEngine._respond(actionId, 'dismiss');
      else if (DOM.suggestedActionPanel) DOM.suggestedActionPanel.hidden = true;
    });
  }
  if (DOM.suggestedActionSeeAll) {
    DOM.suggestedActionSeeAll.addEventListener('click', () => {
      const thread = State.activeThreadId || '';
      if (window.__TAURI__) {
        window.__TAURI__.core.invoke('open_widget', { kind: 'actions', params: { thread } })
          .catch(() => {});
      }
    });
  }

  // Top-bar redesign: the header suggestion chip is a teaser; clicking it
  // reveals the full docked panel (rationale + accept/dismiss/see-all),
  // which _show() has already painted with the active action.
  if (DOM.lunaSuggestion) {
    DOM.lunaSuggestion.addEventListener('click', () => {
      if (DOM.suggestedActionPanel) {
        DOM.suggestedActionPanel.hidden = false;
        try { DOM.suggestedActionPanel.scrollIntoView({ block: 'nearest' }); } catch (_) { /* jsdom */ }
      }
    });
  }

  // (The animated face + free-space bar boot themselves at construction in
  // main-chat.tsx now - stack23 S19e.)

  /**
   * File / image attachment composer state - converted to a typed React
   * module (stack23 S16a). The decode/classify/downscale pipeline and the
   * exact legacy method surface (addFiles/remove/clear/hasAny/
   * wireAttachments/textBlock/previews/setError/classify/IMAGE_TYPES, plus
   * a plain items get/set) now live in src/chat/Attachments.tsx, which
   * paints #attachments-strip / #attach-error directly via React - the
   * manual per-chip document.createElement render() is gone.
   *
   * `Attachments` is a forward-declared `var` - for a classic (non-module)
   * script this IS `window.Attachments`, so every call site below (submit/
   * addFiles/paste/drop/clear) keeps calling the same bare identifier. Safe
   * for the same reason the ChatState/ChatLoop `var`s further down are (see
   * that comment): main-chat.tsx's module script always finishes running
   * after this classic script, and every call site below runs from inside
   * an async event handler, never synchronously before that mount.
   */
  // Attachments arrives through ctx.engines now (S20c); its chat.html forward
  // declaration travelled inside this span and is no longer needed here.
  /**
   * Chat Messaging & WebSocket submission engine.
   */

  // ========================================================================
  // CHAT MODEL / RENDERER / LOOP - converted to a pure typed reducer + a
  // React reconciler (stack23 S15). The turn/segment data structure, the
  // wire-frame vocabulary (applyDelta/applyToolCall/finishTurn/...), and
  // the run-grouping/timeline planning all now live in
  // src/chat/chatModel.ts (pure, no DOM access); the DOM diff + rAF-loop
  // are gone, replaced by src/chat/MessageList.tsx mounted straight into
  // #chat-messages.
  //
  // `ChatState` / `ChatLoop` are forward-declared `var` bindings - for a
  // classic (non-module) script these ARE `window.ChatState` /
  // `window.ChatLoop`, so every frame handler below keeps calling the
  // exact same bare identifiers. main-chat.tsx (a `type="module"` script,
  // which always runs after every classic script on the page - see
  // boot.tsx's header comment) assigns the real bridge once React mounts.
  // No code path here calls either SYNCHRONOUSLY before that mount - every
  // call site is inside an async WS/event handler - so there is no
  // TDZ/race (same reasoning chat-chrome-mount.tsx's module-mounted title
  // bar already relies on, just consumer- instead of producer-side there).
  // ========================================================================
  // Attribute-selector escaping for tool-call-card lookups keyed by
  // server-provided ids. ".tool-call-card[data-tool-call-id="${esc(id)}"]" is
  // safe against quote / backslash injection. We avoid window.CSS.escape
  // because tauri's older WebKit on some macOS versions doesn't expose it.
  // CSS_escape arrives through ctx.engines now (S20c); its chat.html forward
  // declaration travelled inside this span and is no longer needed here.
  // ChatState arrives through ctx.engines now (S20c); its chat.html forward
  // declaration travelled inside this span and is no longer needed here.
  // ChatLoop arrives through ctx.engines now (S20c); its chat.html forward
  // declaration travelled inside this span and is no longer needed here.
  // Converted to a typed module (stack23 S19k): src/chat/chatEngine.ts.
  // ChatEngine and VoiceEngine moved TOGETHER because they reference each
  // other - ChatEngine drives voice feedback on send, VoiceEngine calls
  // back to submit a transcript. Same shape as the S19j drawer cycle.
  //
  // THIS IS THE SLICE THAT DELETED GROUP C. appendMessage, newConversation
  // and autoGrowMessageInput were all ChatEngine calls, and existed only so
  // SlashMenu could reach this const from a module. It takes the engine
  // directly now, and the category is gone from LunaChatHost.
  // ChatEngine arrives through ctx.engines now (S20c); its chat.html forward
  // declaration travelled inside this span and is no longer needed here.
  // ════════════════════════════════════════════════════════════════════════
  // ── VOICE (local pipeline lives in the Rust core; see VOICE.md) ─────────
  // ════════════════════════════════════════════════════════════════════════

  /**
   * PURE sentence splitter for the spoken-reply stream.
   *
   * Given the accumulated (not-yet-spoken) buffer, returns the complete
   * speakable sentences plus the remainder to keep buffering. Contract
   * (VOICE.md): a boundary is `[.!?]`, optionally followed by closing
   * quotes/parens, then whitespace; at least 2 words must precede the
   * boundary (so "Dr." / "e.g." style fragments don't split); boundaries
   * inside an UNCLOSED ``` fence never split (the whole fenced block stays
   * in one chunk for the speakable filter to summarize); markdown table
   * rows (leading `|`) are protected the same way so a table reads as ONE
   * table, not one announcement per row. End-of-buffer is NOT a boundary —
   * the caller flushes the remainder on message end.
   */
  // splitSpeakableSentences arrives through ctx.engines now (S20c); its chat.html forward
  // declaration travelled inside this span and is no longer needed here.
  /**
   * PURE speakable filter: markdown → something worth saying aloud.
   *
   * Fenced code (a consecutive run of blocks counts ONCE) → "I've put the
   * code in the chat."; tables → "There's a table in the chat."; inline
   * code → its literal text; links/images → their text; heading/emphasis/
   * list/blockquote markers stripped; emoji stripped; whitespace collapsed.
   * Returns '' when nothing speakable remains (caller skips speak_text).
   */
  // toSpeakable arrives through ctx.engines now (S20c); its chat.html forward
  // declaration travelled inside this span and is no longer needed here.
  /**
   * VoiceEngine — webview half of the local voice pipeline (VOICE.md).
   *
   * Owns: the availability probe (degrades silently on an older Rust core),
   * persisted settings (localStorage) + their boot re-apply, the mic button,
   * the moon's data-voice-state visuals, the transcript → send-path rule,
   * and the assistant-delta → sentence → speak_text pipeline. Every Tauri
   * surface is guarded (window.__TAURI__ && …) so jsdom and plain-browser
   * dev keep working with voice simply unavailable.
   */
  // VoiceEngine arrives through ctx.engines now (S20c); its chat.html forward
  // declaration travelled inside this span and is no longer needed here.
  // =========================================================================
  // ── INITIALIZATION & BINDINGS ────────────────────────────────────────────
  // =========================================================================

  // Local-shell machine-access controls (computer-icon button in the composer
  // + its popover).
  // (LocalShell.refreshPlatform() moved to the construction site in
  // main-chat.tsx - stack23 S19h. A classic-top-level call cannot see a
  // module-published global, and the platform string is only read when the
  // capability frame goes out after hello, which is far later either way.)
  if (DOM.scopeBtn) {
    DOM.scopeBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't let the document outside-click handler re-close it
      const willOpen = !DOM.scopeMenu.classList.contains('open');
      if (willOpen && typeof SlashMenu !== 'undefined' && SlashMenu) SlashMenu.close(); // same anchor — mutually exclusive
      LocalShell.openMenu(willOpen);
    });
  }
  if (DOM.scopeFullAccess) {
    DOM.scopeFullAccess.addEventListener('click', () => LocalShell.toggleFullAccess());
    DOM.scopeFullAccess.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); LocalShell.toggleFullAccess(); }
    });
  }
  // Close the scope menu on an outside click (clicks inside it are ignored).
  document.addEventListener('click', (e) => {
    if (!DOM.scopeMenu || !DOM.scopeMenu.classList.contains('open')) return;
    if (DOM.scopeMenu.contains(e.target) || (DOM.scopeBtn && DOM.scopeBtn.contains(e.target))) return;
    LocalShell.openMenu(false);
  });

  DOM.chatForm.addEventListener('submit', (e) => ChatEngine.handleSubmit(e));
  /**
   * Slash-command menu (UI-owned client commands) - drives the /command
   * popover above the composer. Converted to a typed React module (stack23
   * S16c): the open/filter/arrow-nav/Tab-complete/Enter-accept/mousedown-
   * accept state and the backend-advertised-command merge now live in
   * src/chat/SlashMenu.tsx, which paints `#slash-menu` directly via React -
   * the manual per-row `document.createElement` building is gone. Command
   * parsing/filtering/completion still come from window.LunaCapabilities
   * (the bundled @luna/capabilities) - untouched. Command ids carry NO
   * leading '/'.
   *
   * `SlashMenu` is a forward-declared `var` - for a classic (non-module)
   * script this IS `window.SlashMenu`, so every call site below (keydown,
   * input, blur, the global Esc handler, ChatEngine.handleSubmit's typed
   * "/cmd args" intercept) keeps calling the same bare identifier. Safe for
   * the same reason the ChatState/ChatLoop/Attachments/ComposerConfig
   * `var`s are (see those comments): main-chat.tsx's module script always
   * finishes running after this classic script, and every call site below
   * runs from inside an async event handler, never synchronously before
   * that mount.
   */
  // SlashMenu arrives through ctx.engines now (S20c); its chat.html forward
  // declaration travelled inside this span and is no longer needed here.
  // Textarea: Enter sends, Shift+Enter inserts a newline. When the slash menu is
  // open, Arrow/Tab/Enter/Esc drive the menu instead (and never send/newline).
  DOM.messageInput.addEventListener('keydown', (e) => {
    if (SlashMenu.isOpen() && !e.isComposing) {
      if (e.key === 'ArrowDown') { e.preventDefault(); SlashMenu.move(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); SlashMenu.move(-1); return; }
      // Tab only consumes the key when it actually completes; a no-op Tab falls
      // through to native focus movement (no keyboard trap, WCAG 2.1.2).
      if (e.key === 'Tab')       { if (SlashMenu.complete()) e.preventDefault(); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); e.stopPropagation(); SlashMenu.accept(); return;
      }
      if (e.key === 'Escape')    { e.preventDefault(); e.stopPropagation(); SlashMenu.close(); return; }
      // other keys fall through; the 'input' event re-filters the menu.
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ChatEngine.handleSubmit(e);
    }
  });
  // Auto-grow on every content change: typing, deleting, IME composition.
  // Also re-filter the slash menu (no-op unless the line starts with '/').
  DOM.messageInput.addEventListener('input', () => {
    ChatEngine.autoGrowMessageInput();
    SlashMenu.onInput();
  });
  // Close the menu when the composer loses focus so its aria-expanded /
  // aria-activedescendant never go stale on an unfocused control (Tab-out, click
  // elsewhere). Row mousedown preventDefaults focus, so mouse-accept doesn't trip this.
  DOM.messageInput.addEventListener('blur', () => SlashMenu.close());
  // Markdown links must never navigate the webview in place (that would replace
  // this window's UI). preventDefault() keeps the page intact; window.open is
  // best-effort.
  DOM.chatMessages.addEventListener('click', (e) => {
    // Activity-timeline collapse toggle. State lives on the turn
    // (ChatModel), not the DOM, so it survives the per-frame re-render.
    // Delegated here because MessageList.tsx rebuilds the header node
    // every paint.
    const tlSummary = e.target.closest && e.target.closest('.timeline-summary');
    if (tlSummary) {
      const node = tlSummary.closest('[data-turn-key]');
      // `turnKey` is the run's ANCHOR turn — it owns the collapse override.
      const turnKey = node && node.dataset.turnKey;
      if (turnKey) {
        // Pin the OPPOSITE of what's currently rendered. Reading the DOM's
        // `.collapsed` class (rather than recomputing the auto-default) keeps
        // the toggle correct regardless of whether the auto value is settled-
        // driven or a prior explicit pin.
        const currentlyCollapsed = node.classList.contains('collapsed');
        ChatState.toggleTimelineCollapsed(turnKey, currentlyCollapsed);
        ChatLoop.schedule();
      }
      return;
    }
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    // luna:// widget/artifact links are owned by the delegated handler above
    // (open_widget / open_artifact_widget). Leave them to it.
    if (a.hasAttribute('data-luna-link')) return;
    e.preventDefault();
    // In a Tauri webview window.open() can't reach the system browser, so
    // route through the native opener (https + mailto only, enforced in Rust).
    // Outside Tauri (dev-in-a-browser) window.open is still the right fallback.
    const url = a.href;
    // Match the Rust open_external_url allowlist (https + mailto only): any
    // other scheme (http:, file:, javascript:, custom) is already prevented
    // from navigating above and is dropped here, so we never waste an IPC
    // round-trip or log a warn on a link Rust would refuse.
    if (!/^(https:|mailto:)/i.test(url)) return;
    if (window.__TAURI__ && window.__TAURI__.core) {
      window.__TAURI__.core.invoke('open_external_url', { url })
        .catch((err) => Logger.warn('open link failed:', err));
    } else {
      try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (_) { /* inert link; UI preserved */ }
    }
  });

  // ---- Attachment composer wiring ----
  // (The hub's suppressBlurClose guard around the native picker is gone:
  // this window has no close-on-blur behavior to trip.)
  DOM.attachBtn.addEventListener('click', () => {
    DOM.fileInput.click();
  });
  DOM.fileInput.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files && files.length) Attachments.addFiles(files);
    e.target.value = '';            // allow re-picking the same file
  });

  // Paste an image straight into the composer (e.g. a screenshot).
  DOM.messageInput.addEventListener('paste', (e) => {
    queueMicrotask(() => ChatEngine.autoGrowMessageInput());
    const cd = e.clipboardData;
    if (!cd) return;
    const imageFiles = Array.from(cd.items)
      .filter((it) => Attachments.IMAGE_TYPES.has(it.type))
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (imageFiles.length > 0) {
      e.preventDefault();           // don't also paste the filename string
      Attachments.addFiles(imageFiles);
    }
  });

  // Drag-and-drop onto the chat panel. dragDropEnabled:false in tauri.conf
  // hands OS file drops to the webview, so these HTML5 events fire normally.
  // A depth counter avoids flicker as the pointer crosses child elements.
  let dragDepth = 0;
  DOM.chatPanel.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    DOM.chatPanel.classList.add('drag-over');
  });
  DOM.chatPanel.addEventListener('dragover', (e) => {
    e.preventDefault();             // required to allow a drop
  });
  DOM.chatPanel.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) DOM.chatPanel.classList.remove('drag-over');
  });
  DOM.chatPanel.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    DOM.chatPanel.classList.remove('drag-over');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) Attachments.addFiles(files);
  });

  // GEAR → the settings launcher panel window (the hub's modal is gone from
  // this page; settings are system widgets now).
  if (DOM.toggleSettings) {
    DOM.toggleSettings.addEventListener('click', () => {
      if (window.__TAURI__ && window.__TAURI__.core) {
        window.__TAURI__.core.invoke('open_widget', { kind: 'settings' })
          .catch((e) => Logger.warn('open_widget failed:', e));
      }
    });
  }

  // Esc — layered dismissal: an OPEN composer-config popover consumes the
  // key (close it, done); otherwise Esc stops the spoken reply as before
  // (unconditional + idempotent — it must work even when the pipeline died
  // and no 'speaking' state will be emitted again). A second Esc after
  // closing a menu still reaches VoiceEngine.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (SlashMenu.isOpen()) { SlashMenu.close(); return; }
    if (ComposerConfig.anyMenuOpen()) {
      ComposerConfig.closeAllMenus();
      return;
    }
    VoiceEngine.handleEscape();
  });

  // Cross-window storage fan-out: the settings.voice panel persists the
  // speak-replies preference; flipping it off must silence an in-flight
  // reply here (same hook the hub wires).
  window.addEventListener('storage', (e) => {
    if (!e || !e.key) return;
    if (e.key === 'luna_voice_speak_replies' && e.newValue === '0') {
      VoiceEngine.stopSpeaking();
    }
  });

  // Voice boot: probe the Rust core for the voice pipeline (older cores
  // degrade to "unavailable" silently), re-apply persisted voice settings,
  // and subscribe to the voice-* events (window-targeted).
  // (VoiceEngine.init() moved to the construction site in main-chat.tsx -
  // stack23 S19k. Unconditional and already non-fatal on failure, so a
  // tick later is equivalent; a classic-top-level call cannot see a
  // module-published global.)

  // Phase 8 — direct lines: chat.html?thread=<id> pins this WINDOW to one
  // thread (its own open_widget instance label). Null = the main line.
  // Declared here, consumed at runtime by syncThread / the snapshot
  // persist (same IIFE scope; TDZ is safe — both run after evaluation).
  // A spawned "new thread" panel arrives as ?thread=new — a SENTINEL, not a
  // real id: it mints its OWN fresh thread on its own socket (see syncThread)
  // rather than subscribing. Any other value is a Phase 8 direct line pinned
  // to that thread; null = the main line.
  const _threadParam = new URLSearchParams(location.search).get('thread') || null;
  const SPAWN_FRESH = _threadParam === 'new';
  const PINNED_THREAD = SPAWN_FRESH ? null : _threadParam;
  // Owner label for a drag-out floater (#380). When set, the Redock button
  // folds this window back into that owner via redock_thread.
  const REDOCK_TO = new URLSearchParams(location.search).get('redockTo') || null;
  // View mode (plan Step 3): a detached floater's open_widget params carry
  // 'viewMode' when its SOURCE window was verbose at the moment of detach
  // (see threadDrawer.ts's openInNewWindow) - this window boots verbose
  // from it. Read once, here, alongside every other `?`-derived boot param;
  // applied later in bootChat.ts once wire.ViewMode exists (installWiring
  // runs before createWire - see this file's module doc on ordering).
  const INITIAL_VIEW_MODE = new URLSearchParams(location.search).get('viewMode') === 'true';
  // Max stall-recovery rounds before we give up and surface "Reattach stalled".
  // 3 rounds covers: one tombstone advance + one validation miss + one final retry.
  const MAX_REATTACH_ROUNDS = 3;

  // Wire the injectable State.pinnedThread from the URL-derived PINNED_THREAD.
  // Tests set m.State.pinnedThread directly to exercise the pinned guard without
  // needing to reload the page with a ?thread= param.
  State.pinnedThread = PINNED_THREAD;

  // Phase C: consume ThreadCache seed written by the owner on detach so a
  // floater paints transcript immediately (before first WS snapshot).
  // localStorage is shared across Tauri webviews; sessionStorage is not.
  if (PINNED_THREAD) {
    try {
      const seed = (window.LunaThreadDrag && typeof window.LunaThreadDrag.consumeThreadSeed === 'function')
        ? window.LunaThreadDrag.consumeThreadSeed(localStorage, PINNED_THREAD)
        : null;
      if (seed && Array.isArray(seed.messages)) {
        ThreadCache.put(PINNED_THREAD, seed.messages, seed.throughSeq);
        State.activeThreadId = PINNED_THREAD;
        ThreadCache.paint(PINNED_THREAD);
      }
    } catch (_) { /* best-effort continuity */ }
  }

  // ── Widget-window chrome (panel.html conventions) ──────────────────────
  let W = null;
  let winLabel = null;
  try {
    if (window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow) {
      W = window.__TAURI__.window.getCurrentWindow();
      winLabel = W.label;
    }
  } catch (_) { /* not in Tauri (tests/browser) */ }
  State.winLabel = winLabel;

  // Collapse-into-moon: React-owned now (src/chat/chat-chrome-mount.tsx,
  // mounted by main-chat.tsx into #collapse-moon-btn-root) - this inline
  // script no longer touches that DOM or wires its click handler.

  // New-thread lives ONLY in the thread drawer ("+ New", wired further down).
  // The title bar's duplicate + button was removed.

  // View mode (plan Step 3) rides BOTH redock call sites below. Read the
  // BARE window.ViewMode global at call time, not window.__MoonInternals.
  // ViewMode: __MoonInternals is a TEST-ONLY bridge object - bootChat.ts's
  // assignBridge only copies onto it when it already exists (chat-harness.ts
  // pre-creates the empty object; production never does), while
  // `window.<Name>` is the one assignBridge ALWAYS sets, production
  // included. The hub-event handler further down this file reads the
  // __MoonInternals copy and is consequently a no-op in production (a
  // pre-existing, separately tracked gap - #525) - this deliberately does
  // not repeat that mistake.
  function currentViewModeEnabled() {
    const vm = window.ViewMode;
    return !!(vm && typeof vm.isEnabled === 'function' && vm.isEnabled());
  }

  // Redock button (#380) — only on pinned floaters that know their owner.
  const redockBtn = document.getElementById('redock-btn');
  if (redockBtn) {
    const canRedock = !!(State.pinnedThread && REDOCK_TO);
    redockBtn.hidden = !canRedock;
    if (canRedock) {
      redockBtn.addEventListener('click', () => {
        if (!(window.__TAURI__ && window.__TAURI__.core)) return;
        const draft = (DOM.messageInput && DOM.messageInput.value) || '';
        window.__TAURI__.core
          .invoke('redock_thread', {
            threadId: State.pinnedThread,
            ownerLabel: REDOCK_TO,
            draft: draft || null,
            viewMode: currentViewModeEnabled(),
          })
          .then((ok) => {
            // If owner is gone, just close this floater so the user is not stuck.
            if (!ok && W && typeof W.close === 'function') {
              W.close().catch(() => {});
            }
          })
          .catch((e) => Logger.warn('redock_thread failed:', e));
      });
    }
  }

  // ── Thread sidebar wiring ───────────────────────────────────────────────
  // Pinned ?thread=<id> windows are single-thread: hide the toggle + divider
  // and skip wiring so the switcher can never open there.
  if (State.pinnedThread) {
    if (DOM.toggleThreads) DOM.toggleThreads.hidden = true;
    // Floater: native startDragging + redock-drag-ended (no CSS scale - it
    // misaligns AppKit traffic lights relative to the panel card).
    try {
      if (W && typeof W.listen === 'function' && REDOCK_TO) {
        W.listen('redock-drag-ended', (e) => {
          const p = e && e.payload;
          if (!(p && p.over && window.__TAURI__ && window.__TAURI__.core)) return;
          const draft = (DOM.messageInput && DOM.messageInput.value) || '';
          window.__TAURI__.core
            .invoke('redock_thread', {
              threadId: State.pinnedThread || p.threadId,
              ownerLabel: REDOCK_TO || p.ownerLabel,
              draft: draft || null,
              yRatio: typeof p.yRatio === 'number' ? p.yRatio : null,
              viewMode: currentViewModeEnabled(),
            })
            .then((ok) => {
              if (!ok && W && typeof W.close === 'function') W.close().catch(() => {});
            })
            .catch((err) => Logger.warn('redock_thread failed:', err));
        }).catch(() => {});
      }
    } catch (_) { /* off-Tauri */ }
  } else {
    if (DOM.toggleThreads) DOM.toggleThreads.addEventListener('click', () => ThreadDrawerEngine.togglePanel());
    // A shrinking window must never leave the sidebar wider than MAX_FRAC of
    // the panel; re-clamp on resize (rAF-throttled). Non-pinned windows only.
    let _sidebarResizeRAF = 0;
    window.addEventListener('resize', () => {
      if (_sidebarResizeRAF) return;
      const raf = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
      _sidebarResizeRAF = raf(() => { _sidebarResizeRAF = 0; ThreadDrawerEngine.reclampWidth(); });
    });
    if (DOM.threadDrawerClose) DOM.threadDrawerClose.addEventListener('click', () => ThreadDrawerEngine.closePanel());
    // Drawer "+ New" mints a fresh thread IN THIS window (single-window model).
    // The pinnedThread guard is belt-and-braces: this whole block is skipped at
    // boot for a pinned ?thread=<id> window, but the guard keeps the
    // one-thread-forever invariant true even if the pin is set later. It moved
    // here from the title-bar + button, which was removed.
    if (DOM.threadDrawerNew) DOM.threadDrawerNew.addEventListener('click', () => {
      if (State.pinnedThread) return;
      try { ChatEngine.newConversation(); } catch (_) { /* best-effort */ }
    });
    if (DOM.threadDrawerSearch) DOM.threadDrawerSearch.addEventListener('input', (e) => ThreadDrawerEngine.setSearch(e.target.value));
    // Redock return channel (#380): floater Redock button / native drag-release.
    try {
      if (W && typeof W.listen === 'function') {
        W.listen('redock-thread', (e) => {
          const p = e && e.payload;
          const id = p && p.threadId;
          if (!id) return;
          // Snapshot insert under cursor BEFORE chrome teardown.
          ThreadDrawerEngine.applyRedockPreview({ active: false });
          ThreadDrawerEngine.adoptRedockedThread(
            id,
            typeof p.yRatio === 'number' ? p.yRatio : null,
          );
          const draft = p && p.draft;
          if (draft && DOM.messageInput && !DOM.messageInput.value) {
            DOM.messageInput.value = draft;
            try { ChatEngine.autoGrowMessageInput(); } catch (_) {}
          }
          // View mode (plan Step 3): a verbose floater redocking here makes
          // THIS (owner) window verbose - the accepted per-window trade
          // named in the plan's "per-window decision, refined" (the owner's
          // OTHER threads go verbose too; per-thread scope is the documented
          // fallback if that proves wrong in use). Only ENABLE, never
          // disable: a non-verbose floater redocking into an already-verbose
          // owner must not silently quiet it - the payload only ever carries
          // a positive assertion, never an explicit "turn it off".
          if (p.viewMode) {
            const vm = window.ViewMode; // bare global - see currentViewModeEnabled's doc above
            if (vm && typeof vm.enable === 'function') vm.enable();
          }
        }).catch(() => {});
        // Live drag preview from a redock-capable floater (Rust NSEvent path).
        W.listen('redock-preview', (e) => {
          ThreadDrawerEngine.applyRedockPreview((e && e.payload) || { active: false });
        }).catch(() => {});
      }
    } catch (_) { /* off-Tauri */ }
  }

  // Title-bar drag is always AppKit-native. Redock floaters also arm
  // begin_redock_drag so Rust can preview the dock without hijacking motion.
  if (window.LunaDock) {
    const redockOpts = (State.pinnedThread && REDOCK_TO)
      ? {
          owner: REDOCK_TO,
          threadId: State.pinnedThread,
          // Owner cannot measure the strip from the floater webview; use
          // last-known metrics if the owner stamped them, else sensible defaults.
          stripMetrics: () => {
            try {
              if (window.__moonStripMetrics) return window.__moonStripMetrics;
              const raw = localStorage.getItem('luna.moonStripMetrics');
              if (raw) return JSON.parse(raw);
            } catch (_) { /* ignore */ }
            return { stripWidth: 240, stripTopInset: 80, stripHeight: 400 };
          },
          title: () => {
            // #bar-title-root is React-owned now (chat-chrome-mount.tsx);
            // its textContent still reflects the rendered title (recursive
            // text-node concatenation), so this read-only lookup is unchanged.
            try {
              const t = document.getElementById('bar-title-root');
              return (t && t.textContent && t.textContent.trim()) || null;
            } catch (_) { return null; }
          },
        }
      : null;
    LunaDock.wire({ win: W, label: winLabel, redock: redockOpts });
  }

  // ── hub-event return channel ────────────────────────────────────────────
  // Rust delivers window-targeted hub-events with strict `for:` discipline.
  // 'fresh-thread' (from settings.general) starts a new
  // conversation in THIS window — it owns the thread now.
  try {
    if (W && typeof W.listen === 'function') {
      W.listen('hub-event', (e) => {
        const p = e && e.payload;
        if (!p || p['for'] !== winLabel) return; // targeted-event discipline
        if (p.name === 'fresh-thread') {
          Promise.resolve()
            .then(() => ChatEngine.newConversation())
            .catch((err) => Logger.warn('hub-event fresh-thread failed:', err));
        } else if (p.name === 'profile-changed' || p.name === 'connection-changed') {
          // The settings.connection panel swapped creds/channel. This
          // window owns the THREAD socket — re-read the secure file and
          // reconnect, resetting thread state exactly like the hub's
          // switchChannel did (thread ids are scoped to a server's DB).
          //
          // loadConnectionAndConnect lives inside wire.ts's createWire()
          // closure, and installWiring() (this function) runs BEFORE
          // createWire() in bootChat.ts's construction order, so it cannot
          // be received as a constructor param here. bootChat.ts bridges it
          // onto the BARE window.loadConnectionAndConnect global (assignBridge
          // sets that UNCONDITIONALLY, production included) right after
          // createWire() returns - by the time this handler actually FIRES
          // (an event arriving well after boot completes), that global is
          // always populated. A bare reference here would be a
          // ReferenceError, silently swallowed by the .catch below, which
          // is exactly the bug Step 1c's fan-out testing caught: the chat
          // window never actually reconnected on a real profile switch.
          //
          // CORRECTNESS FIX (found reviewing plan Step 3): this used to read
          // window.__MoonInternals.loadConnectionAndConnect instead of the
          // bare global. __MoonInternals is a TEST-ONLY observability mirror
          // - chat-harness.ts pre-creates it before bootChat() runs so
          // assignBridge's `if (w.__MoonInternals)` branch also mirrors onto
          // it; production never creates that object at all, so the mirror
          // read was ALWAYS undefined outside tests. The one existing test
          // that looked like it proved the happy path only passed because it
          // calls evalChatInlineScriptWithBridge() TWICE in one test (a
          // second boot, whose assignBridge call finds __MoonInternals
          // already populated by the first boot's harness setup) - a shape
          // that cannot occur in a real, single-boot window. In production
          // this meant EVERY profile switch hit the "unavailable" branch
          // below and silently kept the window on its OLD credentials with
          // the status pill claiming "Reconnect failed" - the exact failure
          // this bridge was built to prevent, just relocated one field over.
          // Production code must never read through __MoonInternals; it is
          // written to, never read from, outside tests.
          Promise.resolve()
            .then(async () => {
              State.activeThreadId = null;
              State.activeTurnId = null;
              State.pendingUserMessage = null;
              State.skipLastThreadFile = true;
              ChatState.reset();
              ChatLoop.flush();
              const bridge = window.loadConnectionAndConnect;
              if (typeof bridge !== 'function') {
                // F2 (opus review): this must NEVER be a silent no-op - the
                // exact same swallow shape as the ReferenceError bug this
                // bridge fixed. If bootChat.ts's assignBridge ordering (see
                // its invariant comment) or this file's construction-order
                // assumption ever breaks, the window is left holding OLD
                // credentials after a profile switch with no visible signal
                // at all - Logger.error names the consequence explicitly so
                // a real user (not just a console reader) can tell.
                Logger.error(
                  `hub-event ${p.name}: window.loadConnectionAndConnect is unavailable - `
                    + 'this window keeps OLD credentials after a profile switch',
                );
                const engine = window.WebSocketEngine;
                if (engine && typeof engine.updateStatus === 'function') {
                  engine.updateStatus('disconnected', 'Reconnect failed');
                }
                return;
              }
              await bridge();
            })
            .catch((err) => Logger.warn(`hub-event ${p.name} failed:`, err));
        }
      }).catch(() => {});
    }
  } catch (_) { /* off-Tauri */ }

  // ── Connection boot ─────────────────────────────────────────────────────
  // The token must NOT live in localStorage (XSS-reachable). Under Tauri it
  // is read from the mode-600 ~/.luna/moon-connection.json via
  // load_connection; the (non-secret) URL may still be cached in
  // localStorage as a convenience. Outside Tauri we degrade to localStorage
  // so frontend dev keeps working. (Profile switching, token seeding and
  // the legacy-token migration stay with the hub + settings.connection
  // panel — this window just reads the stored creds and connects.)
  // (The connection boot moved to src/chat/wire.ts and is ignited by
  // main-chat.tsx - stack23 S20a. See the note on `var WebSocketEngine`.)

  return { SPAWN_FRESH, PINNED_THREAD, REDOCK_TO, INITIAL_VIEW_MODE }
}
