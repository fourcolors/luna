/**
 * surveyEngine.ts - the UserAsk / alignment-survey panel (stack23 S19f).
 *
 * The server fires a `survey-request` frame right after `hello` when a
 * check-in is due. This paints the prompt into the docked user-ask-panel,
 * collects answers via click handlers, and on Submit sends one
 * `survey-response` frame carrying the wire-shape verdicts.
 *
 * buildSurveyVerdicts MOVED WITH IT rather than to a shared utils module, for
 * the reason S19c recorded when the feedback cluster moved: it is a
 * feature-private helper, and splitting it out would leave half a feature on
 * each side of the boundary. It stays EXPORTED because
 * __MoonInternals.buildSurveyVerdicts is a test hook chat.html published, and
 * because it is the half of this file with a cross-client contract.
 *
 * THAT CONTRACT IS THE REASON THE HELPER IS PURE. It mirrors the TUI's
 * apps/agent-cli/src/chat/headless.ts buildSurveyVerdicts so both clients
 * submit IDENTICAL frames for identical answers. Every emitted verdict stamps
 * `at = issuedAt` so the server's idempotency key (ref, signalKind, at) is
 * stable on retry (spec D-LOCK-5). Neither property survives a rewrite, which
 * is why this is a verbatim move.
 */
// @ts-nocheck

export interface SurveyItem {
  readonly id: string
  readonly kind: string
  readonly ref?: unknown
  readonly beliefId?: string
  readonly prompt?: string
}

export interface SurveyAnswers {
  likert: number | null
  beliefAnswers: Record<string, string>
}

/**
 * Pure helper: map a SurveyAnswers payload + SurveyItems to the wire-shape
 * SurveyVerdict[] expected by the server. Mirrors the TUI's
 * apps/agent-cli/src/chat/headless.ts -> buildSurveyVerdicts so both
 * clients submit identical frames for identical answers.
 *
 *   - task_quality:    score = (n - 1) / 4 for n in {1..5}; omitted if null.
 *   - belief_validation: verdict = "confirmed" | "corrected" | "rejected";
 *     omitted if no answer was selected for that beliefId.
 *
 * Every emitted verdict stamps `at = issuedAt` so the server's idempotency
 * key (ref, signalKind, at) is stable on retry (spec D-LOCK-5).
 */
export function buildSurveyVerdicts(items, answers, issuedAt) {
  const out = [];
  for (const item of items || []) {
    if (item.kind === 'task_quality') {
      const n = answers.likert;
      if (n !== null && n !== undefined) {
        out.push({
          itemId: item.id,
          kind: 'task_quality',
          ref: item.ref,
          score: (n - 1) / 4,
          via: 'survey',
          at: issuedAt,
        });
      }
    } else if (item.kind === 'belief_validation' && item.beliefId !== undefined) {
      const ans = answers.beliefAnswers[item.beliefId];
      if (ans !== undefined) {
        out.push({
          itemId: item.id,
          kind: 'belief_validation',
          ref: item.ref,
          beliefId: item.beliefId,
          verdict: ans,
          via: 'survey',
          at: issuedAt,
        });
      }
    }
  }
  return out;
}

/** Everything this engine reaches that chat.html owns. Handed over rather
 *  than imported, because a module cannot see chat.html's consts. */
export interface SurveyEngineCtx {
  readonly Logger: { info: (m?: unknown, ...a: unknown[]) => void; warn: (m?: unknown, ...a: unknown[]) => void }
  readonly DOM: Record<string, HTMLElement | null>
  readonly WebSocketEngine: { send: (frame: unknown) => void }
  readonly ChatState: { appendBanner: (text: string) => void }
  readonly ChatLoop: { flush: () => void }
}

export function createSurveyEngine(ctx: SurveyEngineCtx) {
  const { Logger, DOM, WebSocketEngine, ChatState, ChatLoop } = ctx
  const SurveyEngine = {
    pending: null,                     // { surveyId, issuedAt, items } | null
    answers: { likert: null, beliefAnswers: {} },

    show(frame) {
      if (!frame || !Array.isArray(frame.items)) {
        Logger.warn('SurveyEngine.show: malformed survey-request frame', frame);
        return;
      }
      this.pending = {
        surveyId: frame.surveyId || ('survey-' + (frame.issuedAt || Date.now())),
        issuedAt: frame.issuedAt || Date.now(),
        items: frame.items,
      };
      this.answers = { likert: null, beliefAnswers: {} };
      this._render();
      if (DOM.userAskPanel) DOM.userAskPanel.hidden = false;
      // (The hub auto-opened its collapsed chat here; the chat WINDOW is
      // always visible, so there is nothing to open.)
      Logger.info('SurveyEngine: shown', this.pending);
    },

    hide() {
      if (DOM.userAskPanel) DOM.userAskPanel.hidden = true;
      if (DOM.userAskBody) DOM.userAskBody.innerHTML = '';
      this.pending = null;
      this.answers = { likert: null, beliefAnswers: {} };
    },

    submit() {
      if (!this.pending) return;
      if (this.answers.likert === null) {
        // Mandatory task_quality unanswered — guarded by disabled button,
        // but defend in depth for keyboard / test paths.
        if (DOM.userAskHint) {
          DOM.userAskHint.textContent = 'Rate task quality (1–5) before submitting';
          DOM.userAskHint.classList.add('error');
        }
        return;
      }
      const verdicts = buildSurveyVerdicts(
        this.pending.items, this.answers, this.pending.issuedAt
      );
      WebSocketEngine.send({
        type: 'survey-response',
        surveyId: this.pending.surveyId,
        issuedAt: this.pending.issuedAt,
        verdicts: verdicts,
      });
      this.hide();
      // Light confirmation in the transcript so the operator sees their
      // answer landed (banner = non-streaming assistant bubble).
      try { ChatState.appendBanner('✓ Thanks — feedback recorded.'); ChatLoop.flush(); }
      catch (_) { /* ChatState wiring not present in early-boot edge cases */ }
    },

    dismiss() {
      // No wire frame. The survey re-surfaces on the next connection-time
      // due-check (alignment spec Execution Correction #1).
      this.hide();
    },

    // Build the panel body: one task_quality row + N belief rows.
    _render() {
      const body = DOM.userAskBody;
      if (!body || !this.pending) return;
      body.innerHTML = '';

      for (const item of this.pending.items) {
        const row = document.createElement('div');
        row.className = 'user-ask-item';
        row.dataset.itemId = item.id;
        if (item.beliefId) row.dataset.beliefId = item.beliefId;
        row.dataset.kind = item.kind;

        const prompt = document.createElement('div');
        prompt.className = 'user-ask-prompt';
        prompt.textContent = item.prompt || '';
        row.appendChild(prompt);

        const choices = document.createElement('div');
        choices.className = 'user-ask-choices';
        row.appendChild(choices);

        if (item.kind === 'task_quality') {
          const sub = document.createElement('div');
          sub.className = 'user-ask-prompt-sub';
          sub.textContent = 'How did Luna do? 1 = poor, 5 = great';
          prompt.appendChild(sub);
          for (let n = 1; n <= 5; n++) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'user-ask-choice';
            btn.dataset.likert = String(n);
            btn.setAttribute('aria-label', 'Rate ' + n + ' out of 5');
            btn.textContent = String(n);
            btn.addEventListener('click', () => this._setLikert(n));
            choices.appendChild(btn);
          }
        } else if (item.kind === 'belief_validation' && item.beliefId) {
          const beliefId = item.beliefId;
          const verdicts = [
            { v: 'confirmed', label: 'Confirm' },
            { v: 'corrected', label: 'Needs tweak' },
            { v: 'rejected',  label: 'Reject' },
          ];
          for (const { v, label } of verdicts) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'user-ask-choice';
            btn.dataset.verdict = v;
            btn.textContent = label;
            btn.addEventListener('click', () => this._setBelief(beliefId, v));
            choices.appendChild(btn);
          }
        }

        body.appendChild(row);
      }
      this._refreshSelection();
    },

    _setLikert(n) {
      this.answers.likert = n;
      if (DOM.userAskHint) {
        DOM.userAskHint.classList.remove('error');
        DOM.userAskHint.textContent = 'Ready — press Submit';
      }
      this._refreshSelection();
    },

    _setBelief(beliefId, verdict) {
      this.answers.beliefAnswers[beliefId] = verdict;
      this._refreshSelection();
    },

    // Reflect the current `answers` onto button states + Submit enablement.
    _refreshSelection() {
      const body = DOM.userAskBody;
      if (!body) return;
      const rows = body.querySelectorAll('.user-ask-item');
      rows.forEach((row) => {
        const kind = row.dataset.kind;
        row.querySelectorAll('.user-ask-choice').forEach((btn) => btn.classList.remove('selected'));
        if (kind === 'task_quality' && this.answers.likert !== null) {
          const sel = row.querySelector('.user-ask-choice[data-likert="' + this.answers.likert + '"]');
          if (sel) sel.classList.add('selected');
        } else if (kind === 'belief_validation') {
          const beliefId = row.dataset.beliefId;
          const ans = this.answers.beliefAnswers[beliefId];
          if (ans) {
            const sel = row.querySelector('.user-ask-choice[data-verdict="' + ans + '"]');
            if (sel) sel.classList.add('selected');
          }
        }
      });
      if (DOM.userAskSubmit) {
        DOM.userAskSubmit.disabled = (this.answers.likert === null);
      }
    },
  }
  return SurveyEngine
}
