/**
 * secretPromptEngine.ts - the secure secret-entry controller (stack23 S19f).
 *
 * The agent pushes `secret-request` when it needs a value it cannot or should
 * not synthesise. This paints the prompt plus a consent line showing WHERE the
 * value will be stored, collects it in a password field, sends one
 * `secret-result` frame, and IMMEDIATELY wipes the input.
 *
 * SECURITY - THE TYPED SECRET LIVES IN EXACTLY ONE PLACE: the input value, and
 * only until the OPEN-guarded send. It is NEVER written to localStorage, a
 * Tauri command, the chat transcript, or anywhere else.
 *
 * THE CONNECTIVITY GUARD IS LOAD-BEARING. Both engines' send() log the WHOLE
 * FRAME when not connected, which would put the secret in the console. So the
 * guard must run BEFORE send, not inside it.
 *
 * IT IS ENGINE-AWARE, NOT SOCKET-AWARE (#500). It used to read
 * `State.ws.readyState`, which ONLY the legacy WebSocketEngine ever assigns -
 * PoolEngine, the default since #489, does not assign it at all. So on the
 * shipped engine the guard could never pass: the operator saw "Not connected."
 * while fully connected, and the secret was never sent. It now asks the same
 * predicate chat.html patches to delegate to whichever engine is live, and it
 * asks at CALL time so the answer is the one true at submit.
 *
 * Wire frames (defined server-side; do not change):
 *   server->client  secret-request { requestId, prompt, destinationLabel }
 *   client->server  secret-result  { requestId, secret? , cancelled? }
 *   server->client  secret-status  { requestId, ok, message }
 *
 * `prompt` and `destinationLabel` are server-controlled strings and are
 * written with textContent, never innerHTML.
 */
// @ts-nocheck

export interface SecretPromptEngineCtx {
  readonly Logger: { info: (m?: unknown, ...a: unknown[]) => void; warn: (m?: unknown, ...a: unknown[]) => void }
  readonly DOM: Record<string, HTMLElement | null>
  /** ENGINE-AWARE connectivity, evaluated at CALL time. */
  readonly isConnected: () => boolean
  readonly WebSocketEngine: { send: (frame: unknown) => void }
}

export function createSecretPromptEngine(ctx: SecretPromptEngineCtx) {
  const { Logger, DOM, isConnected, WebSocketEngine } = ctx
  const SecretPromptEngine = {
    _reqId: null,
    _hideTimer: null,

    show(frame) {
      if (!frame || !frame.requestId) {
        Logger.warn('SecretPromptEngine.show: malformed secret-request frame', frame);
        return;
      }
      // A fresh request supersedes any pending auto-hide from a prior ok.
      if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
      this._reqId = frame.requestId;

      // textContent (never innerHTML) — prompt + destinationLabel are
      // server-controlled strings.
      if (DOM.secretPromptPrompt) {
        DOM.secretPromptPrompt.textContent = frame.prompt || 'Luna needs a secret value.';
      }
      if (DOM.secretPromptConsent) {
        const label = (frame.destinationLabel || '').trim();
        if (label) {
          DOM.secretPromptConsent.textContent = 'Will be stored as: ' + label;
          DOM.secretPromptConsent.hidden = false;
        } else {
          DOM.secretPromptConsent.textContent = '';
          DOM.secretPromptConsent.hidden = true;
        }
      }
      this.setStatus('', null);
      if (DOM.secretPromptInput) {
        DOM.secretPromptInput.value = '';
        try { DOM.secretPromptInput.focus(); } catch (_) { /* non-fatal in jsdom */ }
      }
      if (DOM.secretPromptPanel) DOM.secretPromptPanel.hidden = false;
      // (The hub auto-opened its collapsed chat here; the chat WINDOW is
      // always visible, so there is nothing to open.)
      Logger.info('SecretPromptEngine: shown for request', this._reqId);
    },

    submit() {
      if (!this._reqId) return;
      const value = (DOM.secretPromptInput && DOM.secretPromptInput.value) || '';
      if (!value) { this.setStatus('Enter a value first.', 'error'); return; }
      // OPEN-socket guard BEFORE send: WebSocketEngine.send() logs the whole
      // frame when the socket is NOT open (which would leak the secret). When
      // OPEN it never logs the frame, so this is the only safe path.
      if (!isConnected()) {
        this.setStatus('Not connected.', 'error');
        return;
      }
      WebSocketEngine.send({ type: 'secret-result', requestId: this._reqId, secret: value });
      if (DOM.secretPromptInput) DOM.secretPromptInput.value = '';  // one-shot — never retained
      this.setStatus('Saving…', 'info');
    },

    cancel() {
      if (this._reqId && isConnected()) {
        WebSocketEngine.send({ type: 'secret-result', requestId: this._reqId, cancelled: true });
      }
      if (DOM.secretPromptInput) DOM.secretPromptInput.value = '';
      this.hide();
    },

    setStatus(msg, kind) {
      const el = DOM.secretPromptStatus;
      if (!el) return;
      el.textContent = msg || '';
      el.hidden = !msg;
      el.classList.remove('error', 'ok');
      if (kind === 'error') el.classList.add('error');
      else if (kind === 'ok') el.classList.add('ok');
    },

    handleStatus(frame) {
      if (!frame || frame.requestId !== this._reqId) return;  // ignore stale/unmatched
      this.setStatus(
        frame.ok ? (frame.message || 'Saved.') : (frame.message || 'Could not save the secret.'),
        frame.ok ? 'ok' : 'error',
      );
      // Terminal either way: the server's request is one-shot — it has already
      // resolved and discarded this requestId, so retyping here cannot retry
      // against it. Clear _reqId so a stray submit() is inert; if another
      // attempt is needed the agent re-calls request_secret, and show()
      // replaces this panel with a fresh request.
      this._reqId = null;
      if (frame.ok) {
        // Brief "saved" message, then hide. The server typically restarts
        // after storing a secret; the client auto-reconnects on its own.
        if (this._hideTimer) clearTimeout(this._hideTimer);
        this._hideTimer = setTimeout(() => { this._hideTimer = null; this.hide(); }, 1500);
      }
      // On error: leave the message + panel visible (now inert) so the
      // operator can read it; they dismiss with Cancel, or the agent
      // re-prompts with a fresh panel.
    },

    hide() {
      if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
      if (DOM.secretPromptPanel) DOM.secretPromptPanel.hidden = true;
      if (DOM.secretPromptInput) DOM.secretPromptInput.value = '';  // defensive
      this.setStatus('', null);
      this._reqId = null;
    },
  }
  return SecretPromptEngine
}
