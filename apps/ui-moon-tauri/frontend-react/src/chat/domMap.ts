/**
 * domMap.ts - every element the chat window reaches, resolved once
 * (stack23 S20d).
 *
 * 78 getElementById calls. Resolved EAGERLY, exactly as chat.html resolved
 * them, because that is the contract the engines were written against: a
 * member is either an element or null for the whole life of the window, and
 * several engines cache what they read. Making these lazy getters would be a
 * behaviour change dressed as a refactor.
 *
 * Built per window for the same reason State is.
 */
// @ts-nocheck

export function createDom() {
  return {
      chatPanel: document.getElementById('chat-panel'),
      chatForm: document.getElementById('chat-form'),
      messageInput: document.getElementById('message-input'),
      chatMessages: document.getElementById('chat-messages'),
      fileInput: document.getElementById('file-input'),
      attachPlusBtn: document.getElementById('attach-plus-btn'),
      attachMenu: document.getElementById('attach-menu'),
      attachMenuAttachment: document.getElementById('attach-menu-attachment'),
      toggleSettings: document.getElementById('toggle-settings'),
      connectionStatus: document.getElementById('connection-status'),
      buildSha: document.getElementById('build-sha'),
      // PRD Part C W1: Artifacts panel handles.
      artifactsBtn: document.getElementById('artifacts-btn'),
      artifactsBtnInner: document.getElementById('artifacts-btn-inner'),
      artifactsBadge: document.getElementById('artifacts-badge'),
      artifactsPanel: document.getElementById('artifacts-panel'),
      artifactsPanelClose: document.getElementById('artifacts-panel-close'),
      artifactsPinnedSection: document.getElementById('artifacts-pinned-section'),
      artifactsPinnedList: document.getElementById('artifacts-pinned-list'),
      artifactsSessionSection: document.getElementById('artifacts-session-section'),
      artifactsSessionList: document.getElementById('artifacts-session-list'),
      artifactsEmpty: document.getElementById('artifacts-empty'),
      artifactsPreview: document.getElementById('artifacts-preview'),
      artifactsPreviewTitle: document.getElementById('artifacts-preview-title'),
      artifactsPreviewCopy: document.getElementById('artifacts-preview-copy'),
      artifactsPreviewBody: document.getElementById('artifacts-preview-body'),
      // Thread drawer (slide-out thread switcher) handles.
      threadDrawer:        document.getElementById('thread-drawer'),
      threadDrawerList:    document.getElementById('thread-drawer-list'),
      threadDrawerEmpty:   document.getElementById('thread-drawer-empty'),
      threadDrawerSearch:  document.getElementById('thread-drawer-search-input'),
      threadDrawerClose:   document.getElementById('thread-drawer-close'),
      threadDrawerNew:     document.getElementById('thread-drawer-new'),
      toggleThreads:       document.getElementById('toggle-threads'),
      threadDivider:       document.getElementById('thread-divider'),
      // Phase 3 D3: UserAsk / survey panel handles.
      userAskPanel:   document.getElementById('user-ask-panel'),
      userAskBody:    document.getElementById('user-ask-body'),
      userAskHint:    document.getElementById('user-ask-hint'),
      userAskSubmit:  document.getElementById('user-ask-submit'),
      userAskDismiss: document.getElementById('user-ask-dismiss'),
      // Secure secret-entry panel handles.
      secretPromptPanel:   document.getElementById('secret-prompt-panel'),
      secretPromptPrompt:  document.getElementById('secret-prompt-prompt'),
      secretPromptConsent: document.getElementById('secret-prompt-consent'),
      secretPromptInput:   document.getElementById('secret-prompt-input'),
      secretPromptStatus:  document.getElementById('secret-prompt-status'),
      secretPromptSubmit:  document.getElementById('secret-prompt-submit'),
      secretPromptCancel:  document.getElementById('secret-prompt-cancel'),
      secretPromptCancelX: document.getElementById('secret-prompt-cancel-x'),
      // Point-at-the-UI feedback handles.
      feedbackBtn:             document.getElementById('feedback-btn'),
      feedbackPickerOverlay:   document.getElementById('feedback-picker-overlay'),
      feedbackPickerHighlight: document.getElementById('feedback-picker-highlight'),
      feedbackPickerHint:      document.getElementById('feedback-picker-hint'),
      feedbackPanel:           document.getElementById('feedback-panel'),
      feedbackTargetChip:      document.getElementById('feedback-target-chip'),
      feedbackInput:           document.getElementById('feedback-input'),
      feedbackStatus:          document.getElementById('feedback-status'),
      feedbackSubmit:          document.getElementById('feedback-submit-btn'),
      feedbackCancel:          document.getElementById('feedback-cancel'),
      feedbackCancelX:         document.getElementById('feedback-cancel-x'),
      // Suggested-actions chip handles.
      suggestedActionPanel:     document.getElementById('suggested-action-panel'),
      suggestedActionType:      document.getElementById('suggested-action-type'),
      suggestedActionText:      document.getElementById('suggested-action-text'),
      suggestedActionRationale: document.getElementById('suggested-action-rationale'),
      suggestedActionAccept:    document.getElementById('suggested-action-accept'),
      suggestedActionDismiss:   document.getElementById('suggested-action-dismiss'),
      suggestedActionSeeAll:    document.getElementById('suggested-action-see-all'),
      suggestedActionCancelX:   document.getElementById('suggested-action-cancel-x'),
      // Top-bar redesign: animated Luna face + free-space quip/suggestion bar.
      lunaFace:           document.getElementById('luna-face'),
      lunaBar:            document.getElementById('luna-bar'),
      lunaQuip:           document.getElementById('luna-quip'),
      lunaSuggestion:     document.getElementById('luna-suggestion'),
      lunaSuggestionText: document.getElementById('luna-suggestion-text'),
      // local-shell machine-access scope controls (menu kept; composer toggle removed).
      scopeBtn: document.getElementById('scope-btn'),
      scopeMenu: document.getElementById('scope-menu'),
      scopeFullAccess: document.getElementById('scope-full-access'),
      // Composer config cluster (model + effort switcher). `#composer-config`,
      // `#effort-cfg-sep`, and `#cfg-deferred-hint` are React-owned now
      // (ComposerConfig.tsx, mounted from main-chat.tsx via
      // document.getElementById directly) - the rest stay here because
      // SlashMenu.tsx's /model and /effort no-arg pickers (a separate React
      // module, stack23 S16c) and the Escape handler still reach into them
      // directly. `#slash-menu` itself has no DOM cache entry - SlashMenu.tsx
      // owns that node via its own `document.getElementById` in
      // main-chat.tsx's mount call, not through this cache.
      modelCfgBtn:       document.getElementById('model-cfg-btn'),
      modelCfgMenu:      document.getElementById('model-cfg-menu'),
      effortCfgBtn:      document.getElementById('effort-cfg-btn'),
      effortCfgMenu:     document.getElementById('effort-cfg-menu'),
  }
}

export type ChatWindowDom = ReturnType<typeof createDom>
