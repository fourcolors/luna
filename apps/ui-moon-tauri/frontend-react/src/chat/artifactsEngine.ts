// @ts-nocheck
/**
 * artifactsEngine.ts - the Artifacts overlay panel (stack23 S19d).
 *
 * Pinned + session artifacts, their list rows, and the preview pane that
 * renders one through the audited markdown sanitizer.
 *
 * THE TWO LunaMarkdown CALL SITES ARE INJECTED, NOT IMPORTED, and that is the
 * point of this slice. S19's spec calls them out by name: chat.html aliased
 * `renderMarkdown`/`enhanceCodeBlocks` off the vendor global, and this engine
 * was their LAST production reader, so the alias block goes with it. They
 * arrive through `deps` rather than being reached directly, which keeps the
 * bodies below character-identical.
 *
 * SANITIZING IS THE CONTRACT HERE. `renderMarkdown` is the audited sanitizer
 * (vendor/moon-markdown.js, an Operator hard constraint and frozen), and the
 * preview pane assigns its output to `innerHTML` for artifact content that is
 * UNTRUSTED. Swapping in anything that does not sanitize, or bypassing it,
 * turns this panel into an injection surface - which is why the move is
 * verbatim rather than a rewrite.
 *
 * MOVED VERBATIM, the method established in threadDrag.ts (S17f): every body
 * is character-identical to chat.html's, proven by diffing the generated text
 * against what was cut out. The only structural change is the wrapper - a
 * factory returning the same object literal, so every `this.` resolves as
 * before.
 *
 * FIVE INJECTED DEPENDENCIES, enumerated by scanning the body for FREE
 * identifiers rather than grepping for a guessed list. S19c paid for that
 * lesson: a guessed list missed three helpers and surfaced 521 tests later as
 * `undefined is not a function` deep inside a handler.
 *
 * @ts-nocheck for the same reason as the other verbatim moves, tracked by the
 * same follow-up (#493).
 */

export interface ArtifactsEngineDeps {
  readonly DOM: any
  readonly State: any
  readonly WebSocketEngine: { send: (frame: unknown) => void }
  /** The audited sanitizer from vendor/moon-markdown.js. */
  readonly renderMarkdown: (md: string) => string
  readonly enhanceCodeBlocks: (root: unknown) => void
}

export function createArtifactsEngine(deps: ArtifactsEngineDeps) {
  const { DOM, State, WebSocketEngine, renderMarkdown, enhanceCodeBlocks } = deps
  return {
  _selectedId: null,

  applyCapability(supported) {
    if (DOM.artifactsBtn) DOM.artifactsBtn.hidden = !supported;
    if (!supported) {
      // Channel switched to a server without artifact support — drop all
      // state so stale rows never render.
      State.pinnedArtifacts = [];
      State.sessionArtifacts = [];
      this._selectedId = null;
      if (State.artifactsPanelOpen) this.closePanel();
    }
    this.render();
  },

  applyPinned(list) {
    State.pinnedArtifacts = Array.isArray(list) ? list : [];
    this.render();
  },

  applyUpdate(artifact) {
    if (!artifact) return;
    const idx = State.pinnedArtifacts.findIndex((a) => a.id === artifact.id);
    if (idx >= 0) {
      State.pinnedArtifacts = [
        ...State.pinnedArtifacts.slice(0, idx),
        artifact,
        ...State.pinnedArtifacts.slice(idx + 1),
      ];
    } else {
      // Not yet in the list — prepend (newest first).
      State.pinnedArtifacts = [artifact, ...State.pinnedArtifacts];
    }
    this.render();
  },

  applySession(frame) {
    if (!frame || !Array.isArray(frame.artifacts)) return;
    const messageId = frame.messageId || null;
    if (messageId) {
      // Dedup: drop any prior session artifacts whose id starts with
      // `${messageId}:` (mirrors the web reducer's artifacts-extracted logic —
      // a re-delivered turn replaces its own artifacts but not others').
      State.sessionArtifacts = State.sessionArtifacts.filter(
        (a) => !a.id.startsWith(messageId + ':')
      );
    }
    // Append newest last (session list shows in delivery order).
    State.sessionArtifacts = State.sessionArtifacts.concat(frame.artifacts);
    this.render();
  },

  togglePanel() {
    if (State.artifactsPanelOpen) {
      this.closePanel();
    } else {
      this.openPanel();
    }
  },

  openPanel() {
    State.artifactsPanelOpen = true;
    if (DOM.artifactsPanel) DOM.artifactsPanel.hidden = false;
    this.render();
  },

  closePanel() {
    State.artifactsPanelOpen = false;
    if (DOM.artifactsPanel) DOM.artifactsPanel.hidden = true;
  },

  select(id) {
    this._selectedId = id;
    this.renderPreview();
  },

  pin(artifact) {
    if (!(State.ws && State.ws.readyState === WebSocket.OPEN)) return;
    WebSocketEngine.send({
      type: 'artifact-pin',
      id: artifact.id,
      title: artifact.title,
      content: artifact.content,
      lang: artifact.lang || null,
      origin: artifact.path || State.activeThreadId || null,
    });
  },

  unpin(id) {
    if (!(State.ws && State.ws.readyState === WebSocket.OPEN)) return;
    WebSocketEngine.send({ type: 'artifact-unpin', id });
  },

  _isPinned(id) {
    return State.pinnedArtifacts.some((a) => a.id === id);
  },

  _getSelected() {
    if (!this._selectedId) return null;
    const pinned = State.pinnedArtifacts.find((a) => a.id === this._selectedId);
    if (pinned) return pinned;
    return State.sessionArtifacts.find((a) => a.id === this._selectedId) || null;
  },

  renderPreview() {
    if (!DOM.artifactsPreview) return;
    const artifact = this._getSelected();
    if (!artifact) {
      DOM.artifactsPreview.hidden = true;
      return;
    }
    DOM.artifactsPreview.hidden = false;
    if (DOM.artifactsPreviewTitle) {
      DOM.artifactsPreviewTitle.textContent = artifact.title || 'Artifact';
    }
    if (DOM.artifactsPreviewBody) {
      DOM.artifactsPreviewBody.innerHTML = '';
      const kind = artifact.kind || null;
      const lang = artifact.lang || '';
      const isMarkdown = kind === 'markdown' || lang === 'markdown' || lang === 'md';
      if (isMarkdown) {
        // renderMarkdown sanitizes — safe for untrusted content.
        DOM.artifactsPreviewBody.innerHTML = renderMarkdown(artifact.content || '');
        enhanceCodeBlocks(DOM.artifactsPreviewBody);
      } else {
        // For code/html/plain — set textContent (never innerHTML) then enhance.
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        if (lang) code.className = 'language-' + lang;
        code.textContent = artifact.content || '';
        pre.appendChild(code);
        DOM.artifactsPreviewBody.appendChild(pre);
        enhanceCodeBlocks(DOM.artifactsPreviewBody);
      }
    }
    // Wire the copy button to current content.
    if (DOM.artifactsPreviewCopy) {
      DOM.artifactsPreviewCopy.onclick = () => {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(artifact.content || '').catch(() => {});
        }
        DOM.artifactsPreviewCopy.textContent = 'Copied!';
        setTimeout(() => { if (DOM.artifactsPreviewCopy) DOM.artifactsPreviewCopy.textContent = 'Copy'; }, 1500);
      };
    }
  },

  render() {
    if (!DOM.artifactsPanel) return;

    // Update the header badge (count of pinned).
    const pinnedCount = State.pinnedArtifacts.length;
    if (DOM.artifactsBadge) {
      DOM.artifactsBadge.hidden = pinnedCount === 0;
      DOM.artifactsBadge.textContent = String(pinnedCount);
    }

    if (!State.artifactsPanelOpen) return;

    // ── Pinned section ────────────────────────────────────────────────────
    const hasPinned = State.pinnedArtifacts.length > 0;
    if (DOM.artifactsPinnedSection) DOM.artifactsPinnedSection.hidden = !hasPinned;
    if (hasPinned && DOM.artifactsPinnedList) {
      const rows = State.pinnedArtifacts.map((a) => {
        const row = document.createElement('div');
        row.className = 'artifact-row' + (this._selectedId === a.id ? ' selected' : '');
        row.addEventListener('click', () => this.select(a.id));

        const info = document.createElement('div');
        info.className = 'artifact-row-info';
        const title = document.createElement('div');
        title.className = 'artifact-row-title';
        title.textContent = a.title || 'Untitled';
        const meta = document.createElement('div');
        meta.className = 'artifact-row-meta';
        meta.textContent = (a.kind || 'artifact') + ' · v' + (a.version || 1);
        info.appendChild(title);
        info.appendChild(meta);

        const unpinBtn = document.createElement('button');
        unpinBtn.type = 'button';
        unpinBtn.className = 'artifact-row-btn danger';
        unpinBtn.textContent = 'Unpin';
        unpinBtn.title = 'Remove from pinned';
        unpinBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.unpin(a.id);
        });

        const popOutBtnP = document.createElement('button');
        popOutBtnP.type = 'button';
        popOutBtnP.className = 'artifact-row-btn';
        popOutBtnP.textContent = '⤢';
        popOutBtnP.title = 'Open in widget window';
        popOutBtnP.setAttribute('data-action', 'pop-out');
        popOutBtnP.addEventListener('click', (e) => {
          e.stopPropagation();
          if (window.__TAURI__ && window.__TAURI__.core) {
            // Snap-on-open (Rust) tiles the pop-out flush against the
            // nearest open panel and links it in, so N pop-outs accrete
            // into the stack instead of overlapping — no manual cascade.
            window.__TAURI__.core.invoke('open_artifact_widget', {
              artifactId: a.id, title: a.title || '',
            }).catch(() => {/* best-effort */});
          }
        });

        row.appendChild(info);
        row.appendChild(unpinBtn);
        row.appendChild(popOutBtnP);
        return row;
      });
      DOM.artifactsPinnedList.replaceChildren(...rows);
    }

    // ── Session section ───────────────────────────────────────────────────
    const hasSession = State.sessionArtifacts.length > 0;
    if (DOM.artifactsSessionSection) DOM.artifactsSessionSection.hidden = !hasSession;
    if (hasSession && DOM.artifactsSessionList) {
      const rows = State.sessionArtifacts.map((a) => {
        const row = document.createElement('div');
        row.className = 'artifact-row' + (this._selectedId === a.id ? ' selected' : '');
        row.addEventListener('click', () => this.select(a.id));

        const info = document.createElement('div');
        info.className = 'artifact-row-info';
        const title = document.createElement('div');
        title.className = 'artifact-row-title';
        title.textContent = a.title || a.path || 'Untitled';
        const meta = document.createElement('div');
        meta.className = 'artifact-row-meta';
        meta.textContent = (a.lang || a.source || 'artifact');
        info.appendChild(title);
        info.appendChild(meta);

        const alreadyPinned = this._isPinned(a.id);
        const actionBtn = document.createElement('button');
        actionBtn.type = 'button';
        actionBtn.className = 'artifact-row-btn' + (alreadyPinned ? ' muted' : '');
        actionBtn.textContent = alreadyPinned ? 'Pinned' : 'Pin';
        actionBtn.title = alreadyPinned ? 'Already pinned' : 'Pin this artifact';
        if (!alreadyPinned) {
          actionBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.pin(a);
          });
        }

        const popOutBtnS = document.createElement('button');
        popOutBtnS.type = 'button';
        popOutBtnS.className = 'artifact-row-btn';
        popOutBtnS.textContent = '⤢';
        popOutBtnS.title = 'Open in widget window';
        popOutBtnS.setAttribute('data-action', 'pop-out');
        popOutBtnS.addEventListener('click', (e) => {
          e.stopPropagation();
          if (window.__TAURI__ && window.__TAURI__.core) {
            // Widget windows render PINNED artifacts — pin this session
            // artifact first (popping out IS pinning it as a widget), then
            // spawn. Snap-on-open (Rust) tiles it flush against the nearest
            // open panel; the widget self-heals via the artifact-list
            // broadcast once the pin lands.
            if (!this._isPinned(a.id)) this.pin(a);
            window.__TAURI__.core.invoke('open_artifact_widget', {
              artifactId: a.id, title: a.title || a.path || '',
            }).catch(() => {/* best-effort */});
          }
        });

        row.appendChild(info);
        row.appendChild(actionBtn);
        row.appendChild(popOutBtnS);
        return row;
      });
      DOM.artifactsSessionList.replaceChildren(...rows);
    }

    // ── Empty state ───────────────────────────────────────────────────────
    const isEmpty = !hasPinned && !hasSession;
    if (DOM.artifactsEmpty) DOM.artifactsEmpty.hidden = !isEmpty;

    // ── Preview ───────────────────────────────────────────────────────────
    // Re-validate the selected id still exists (it may have been unpinned).
    if (this._selectedId && !this._getSelected()) {
      this._selectedId = null;
    }
    this.renderPreview();
  },
  }
}
