/**
 * suggestedActionsEngine.ts - the inline suggestion chip controller
 * (stack23 S19f).
 *
 * Shows the LATEST `proposed` action for the active thread. Stacking
 * precedence is secret > survey > suggestion: if a higher-priority panel is
 * visible the chip stays hidden. That rule is the reason all three panels
 * moved in ONE slice - it reads the other two panels' `hidden` flags, so
 * splitting them would have put a precedence rule across the boundary.
 *
 * IT WAS BLOCKED ON S19e. This engine calls MoonBar and MoonFace, and a module
 * cannot reach a chat.html-private const (the OUTBOUND-EDGE RULE), so both had
 * to become modules first. Now they arrive as the very same instances
 * main-chat.tsx constructed - module to module, no bridge in between.
 *
 * The chip is per-thread: it clears whenever State.activeThreadId changes.
 *
 * Wire frames:
 *   server->client  suggested-action-set    { threadId, actions[] }
 *   server->client  suggested-action-update { threadId, action }
 *   client->server  suggested-action-respond { threadId, actionId, decision }
 */
// @ts-nocheck

export interface SuggestedActionsEngineCtx {
  readonly DOM: Record<string, HTMLElement | null>
  /** The LIVE State object - activeThreadId changes under this engine. */
  readonly State: { activeThreadId: string | null } | undefined
  readonly WebSocketEngine: { send: (frame: unknown) => void }
  readonly MoonBar: { showSuggestion: (a: { title?: string } | null | undefined) => void; clearSuggestion: () => void }
  readonly MoonFace: { setSuggesting: (b: unknown) => void }
}

export function createSuggestedActionsEngine(ctx: SuggestedActionsEngineCtx) {
  const { DOM, State, WebSocketEngine, MoonBar, MoonFace } = ctx
  const SuggestedActionsEngine = {
    // Map of threadId → SuggestedActionWire[]
    _store: {},
    // Whether the server advertises suggestedActions capability.
    _capable: false,

    applyCapability(hasCapability) {
      this._capable = !!hasCapability;
      if (!this._capable) this._hide();
    },

    applySet(frame) {
      if (!frame || !frame.threadId) return;
      this._store[frame.threadId] = Array.isArray(frame.actions) ? frame.actions : [];
      this.refresh();
    },

    applyUpdate(frame) {
      if (!frame || !frame.action || !frame.action.threadId) return;
      const tid = frame.action.threadId;
      const current = this._store[tid] || [];
      const idx = current.findIndex((a) => a.id === frame.action.id);
      if (idx >= 0) {
        this._store[tid] = current.slice();
        this._store[tid][idx] = Object.assign({}, current[idx], frame.action);
      } else {
        this._store[tid] = [frame.action].concat(current);
      }
      this.refresh();
    },

    refresh() {
      if (!this._capable) { this._hide(); return; }
      // Stacking precedence: secret > survey > suggestion.
      // If a higher-priority panel is currently visible, keep chip hidden.
      const secretVisible = DOM.secretPromptPanel && !DOM.secretPromptPanel.hidden;
      const surveyVisible = DOM.userAskPanel && !DOM.userAskPanel.hidden;
      if (secretVisible || surveyVisible) { this._hide(); return; }

      const tid = State.activeThreadId;
      if (!tid) { this._hide(); return; }
      const actions = this._store[tid] || [];
      // Find the most-recently-created proposed action.
      const proposed = actions
        .filter((a) => a.status === 'proposed')
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
      if (!proposed) { this._hide(); return; }
      this._show(proposed);
    },

    _show(action) {
      if (!DOM.suggestedActionPanel) return;
      const typeLabels = {
        task: 'Task',
        research: 'Research',
        create_skill: 'Create Skill',
        create_workflow: 'Create Workflow',
        run_workflow: 'Run Workflow',
      };
      if (DOM.suggestedActionType) DOM.suggestedActionType.textContent = typeLabels[action.actionType] || (action.actionType || '');
      if (DOM.suggestedActionText) DOM.suggestedActionText.textContent = action.title || '';
      if (DOM.suggestedActionRationale) {
        if (action.rationale) {
          DOM.suggestedActionRationale.textContent = action.rationale;
          DOM.suggestedActionRationale.hidden = false;
        } else {
          DOM.suggestedActionRationale.textContent = '';
          DOM.suggestedActionRationale.hidden = true;
        }
      }
      // Store current actionId on panel so buttons always act on the shown action.
      DOM.suggestedActionPanel.dataset.actionId = action.id;
      // Top-bar redesign: the suggestion now surfaces as a compact teaser
      // chip in the header's free space (MoonBar). The full docked panel
      // (rationale + accept/dismiss/see-all) stays painted but hidden until
      // the user clicks the chip — so the bar is the glance and the panel is
      // the detail, instead of two suggestion surfaces showing at once.
      MoonBar.showSuggestion(action);
      MoonFace.setSuggesting(true);
    },

    _hide() {
      if (DOM.suggestedActionPanel) DOM.suggestedActionPanel.hidden = true;
      MoonBar.clearSuggestion();
      MoonFace.setSuggesting(false);
    },

    _respond(actionId, decision) {
      const tid = State.activeThreadId;
      if (!tid || !actionId) return;
      WebSocketEngine.send({ type: 'suggested-action-respond', threadId: tid, actionId: actionId, decision: decision });
      // Optimistic flip — update the local store immediately so refresh()
      // picks up the new status without waiting for a server round-trip.
      const current = this._store[tid] || [];
      const newStatus = decision === 'accept' ? 'accepted' : 'dismissed';
      const idx = current.findIndex((a) => a.id === actionId);
      if (idx >= 0) {
        this._store[tid] = current.slice();
        this._store[tid][idx] = Object.assign({}, current[idx], { status: newStatus });
      }
      this.refresh();
    },
  }
  return SuggestedActionsEngine
}
