/**
 * panels/settings-apps.js — the Apps settings panel (PRD Part C §13).
 *
 * WS-backed: connects via ctx.connectWs, gates on parseHelloCapabilities
 * (frame).artifacts, renders the server's pinned artifact catalog filtered
 * to kind==='mcp-app' || kind==='widget', and provides OPEN / EDIT / DELETE
 * actions plus a composer for creating / replacing artifacts.
 *
 * Registers into window.LunaPanelTypes; loaded by panel.html's per-type
 * loader (or preloaded by the jsdom harness).
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  g.LunaPanelTypes['settings.apps'] = {
    title: 'Apps',

    render: function (el, ctx) {
      // ── Inline styles (dark-glass, matching settings-skills.js aesthetic) ──
      var style = document.createElement('style');
      style.textContent = [
        '.apps-heading { display:flex; align-items:center; gap:8px; margin-bottom:8px; }',
        '.apps-heading-label { font-size:0.82rem; font-weight:600; color:var(--text); }',
        '.apps-count { font-size:0.72rem; color:var(--muted); }',
        '.apps-list { display:flex; flex-direction:column; gap:6px; width:100%;',
        '  max-height:280px; overflow-y:auto; margin-bottom:12px; }',
        '.app-row { display:flex; align-items:center; gap:10px;',
        '  background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05);',
        '  border-radius:10px; padding:8px 10px;',
        '  transition:border-color 0.2s ease; }',
        '.app-row:hover { border-color:rgba(138,180,248,0.25); }',
        '.app-row-info { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }',
        '.app-row-name { font-size:0.78rem; font-weight:600; color:#f1f5f9;',
        '  display:flex; gap:6px; align-items:center; flex-wrap:wrap; }',
        '.app-kind-badge { font-size:0.56rem; text-transform:uppercase; letter-spacing:0.06em;',
        '  color:#94a3b8; background:rgba(255,255,255,0.05); border-radius:4px; padding:1px 5px; }',
        '.app-version { font-size:0.66rem; color:#64748b; }',
        '.app-row-actions { display:flex; gap:5px; flex-shrink:0; }',
        '.app-btn { font-size:0.66rem; padding:3px 9px; border-radius:5px; cursor:pointer;',
        '  border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.04);',
        '  color:#cbd5e1; transition:all 0.15s ease; white-space:nowrap; }',
        '.app-btn:hover { background:rgba(255,255,255,0.09); border-color:rgba(138,180,248,0.3);',
        '  color:#f1f5f9; }',
        '.app-btn.delete:hover { background:rgba(248,113,113,0.12); border-color:rgba(248,113,113,0.4);',
        '  color:#fca5a5; }',
        '.apps-empty { font-size:0.78rem; color:var(--muted); margin-bottom:12px; }',
        '.apps-composer { display:flex; flex-direction:column; gap:7px; width:100%;',
        '  background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06);',
        '  border-radius:10px; padding:10px; }',
        '.apps-composer-title { font-size:0.72rem; font-weight:600; color:#cbd5e1;',
        '  margin-bottom:2px; }',
        '.apps-input { width:100%; box-sizing:border-box; padding:6px 10px;',
        '  background:rgba(255,255,255,0.04); border:1px solid var(--border);',
        '  border-radius:7px; color:var(--text); font-size:0.78rem; outline:none; }',
        '.apps-input::placeholder { color:var(--muted); }',
        '.apps-textarea { width:100%; box-sizing:border-box; padding:6px 10px; min-height:80px;',
        '  resize:vertical; background:rgba(255,255,255,0.04); border:1px solid var(--border);',
        '  border-radius:7px; color:var(--text); font-size:0.72rem; outline:none;',
        '  font-family:monospace; }',
        '.apps-textarea::placeholder { color:var(--muted); }',
        '.apps-select { width:100%; box-sizing:border-box; padding:5px 10px;',
        '  background:rgba(255,255,255,0.04); border:1px solid var(--border);',
        '  border-radius:7px; color:var(--text); font-size:0.78rem; outline:none; }',
        '.apps-save-btn { align-self:flex-end; font-size:0.72rem; padding:5px 14px;',
        '  border-radius:6px; cursor:pointer; border:1px solid rgba(138,180,248,0.3);',
        '  background:rgba(138,180,248,0.1); color:#93c5fd; transition:all 0.15s ease; }',
        '.apps-save-btn:hover { background:rgba(138,180,248,0.2); color:#dbeafe; }',
        '.apps-edit-label { font-size:0.66rem; color:#fbbf24; background:rgba(251,191,36,0.08);',
        '  border:1px solid rgba(251,191,36,0.2); border-radius:4px; padding:2px 7px; }',
        '.notice { font-size:0.78rem; color:var(--muted); padding:12px 0; }',
      ].join('\n');
      document.head.appendChild(style);

      // ── State ─────────────────────────────────────────────────────────────
      var artifacts = [];   // full PinnedArtifactItem[] from server
      var editTarget = null; // null = create mode; string id = edit mode
      var wsClient = null;

      // ── DOM ───────────────────────────────────────────────────────────────
      // Heading row
      var headingEl = document.createElement('div');
      headingEl.className = 'apps-heading';
      var headLabel = document.createElement('span');
      headLabel.className = 'apps-heading-label';
      headLabel.textContent = 'Apps';
      var countEl = document.createElement('span');
      countEl.id = 'apps-count';
      countEl.className = 'apps-count';
      headingEl.appendChild(headLabel);
      headingEl.appendChild(countEl);
      el.appendChild(headingEl);

      // List area
      var listEl = document.createElement('div');
      listEl.id = 'apps-list';
      listEl.className = 'apps-list';
      el.appendChild(listEl);

      // Composer section
      var composerEl = document.createElement('div');
      composerEl.className = 'apps-composer';

      var composerTitle = document.createElement('div');
      composerTitle.className = 'apps-composer-title';
      composerTitle.textContent = 'Create app';
      composerEl.appendChild(composerTitle);

      var editLabel = document.createElement('span');
      editLabel.className = 'apps-edit-label';
      editLabel.id = 'apps-edit-label';
      editLabel.hidden = true;
      editLabel.textContent = 'Editing';
      composerEl.appendChild(editLabel);

      var titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.className = 'apps-input';
      titleInput.id = 'apps-title-input';
      titleInput.placeholder = 'Title';
      titleInput.setAttribute('autocomplete', 'off');
      titleInput.setAttribute('spellcheck', 'false');
      composerEl.appendChild(titleInput);

      var contentArea = document.createElement('textarea');
      contentArea.className = 'apps-textarea';
      contentArea.id = 'apps-content-input';
      contentArea.placeholder = [
        'HTML content for the app.',
        'MCP app: use window.mcp.call("pulse") or window.mcp.call("list-artifacts") to talk to Luna.',
        'Widget: use window.luna.subscribe("chat", fn) to receive live data.',
      ].join('\n');
      composerEl.appendChild(contentArea);

      var kindSelect = document.createElement('select');
      kindSelect.className = 'apps-select';
      kindSelect.id = 'apps-kind-select';
      var optMcp = document.createElement('option');
      optMcp.value = 'mcp-app';
      optMcp.textContent = 'MCP app';
      var optWidget = document.createElement('option');
      optWidget.value = 'widget';
      optWidget.textContent = 'Widget';
      kindSelect.appendChild(optMcp);
      kindSelect.appendChild(optWidget);
      composerEl.appendChild(kindSelect);

      var saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'apps-save-btn';
      saveBtn.id = 'apps-save-btn';
      saveBtn.textContent = 'Save';
      composerEl.appendChild(saveBtn);

      el.appendChild(composerEl);

      // ── Helpers ───────────────────────────────────────────────────────────
      function appArtifacts() {
        return artifacts.filter(function (a) {
          return a.kind === 'mcp-app' || a.kind === 'widget';
        });
      }

      function kindBadge(kind) {
        return kind === 'mcp-app' ? 'app' : 'widget';
      }

      /** Build a slug from a title string. */
      function slugify(title) {
        return title.toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '');
      }

      /** Generate a unique id for a new artifact of a given kind + title. */
      function uniqueId(kind, title) {
        var base = kind + ':' + slugify(title);
        var existing = artifacts.map(function (a) { return a.id; });
        if (existing.indexOf(base) === -1) return base;
        var n = 2;
        while (existing.indexOf(base + '-' + n) !== -1) n++;
        return base + '-' + n;
      }

      function clearComposer() {
        titleInput.value = '';
        contentArea.value = '';
        kindSelect.value = 'mcp-app';
        editTarget = null;
        editLabel.hidden = true;
        composerTitle.textContent = 'Create app';
        // Re-enable title + kind for the next create (edit locks them).
        titleInput.disabled = false;
        kindSelect.disabled = false;
      }

      function loadIntoComposer(artifact) {
        titleInput.value = artifact.title;
        contentArea.value = artifact.content;
        kindSelect.value = artifact.kind;
        editTarget = artifact.id;
        editLabel.hidden = false;
        composerTitle.textContent = 'Edit app';
        // Edit changes CONTENT only (store.update preserves title/kind/caps +
        // the version ledger). Lock title + kind so the UI doesn't imply they
        // can change here — rename = delete + re-create, or ask Luna to iterate.
        titleInput.disabled = true;
        kindSelect.disabled = true;
      }

      function renderList() {
        var apps = appArtifacts();

        countEl.textContent = apps.length ? '· ' + apps.length : '';

        if (artifacts.length === 0) {
          // Not yet connected or no data.
          var waiting = document.createElement('span');
          waiting.className = 'apps-empty';
          waiting.textContent = 'Your apps appear here once Luna connects.';
          listEl.replaceChildren(waiting);
          return;
        }

        if (apps.length === 0) {
          var none = document.createElement('span');
          none.className = 'apps-empty';
          none.textContent = 'No apps yet — create one below.';
          listEl.replaceChildren(none);
          return;
        }

        var rows = apps.map(function (a) {
          var row = document.createElement('div');
          row.className = 'app-row';

          var info = document.createElement('div');
          info.className = 'app-row-info';

          var nameRow = document.createElement('div');
          nameRow.className = 'app-row-name';

          var badge = document.createElement('span');
          badge.className = 'app-kind-badge';
          badge.textContent = kindBadge(a.kind);

          var titleSpan = document.createElement('span');
          titleSpan.textContent = a.title;

          var versionSpan = document.createElement('span');
          versionSpan.className = 'app-version';
          versionSpan.textContent = '· v' + a.version;

          nameRow.appendChild(badge);
          nameRow.appendChild(titleSpan);
          nameRow.appendChild(versionSpan);
          info.appendChild(nameRow);
          row.appendChild(info);

          var actions = document.createElement('div');
          actions.className = 'app-row-actions';

          var openBtn = document.createElement('button');
          openBtn.type = 'button';
          openBtn.className = 'app-btn';
          openBtn.textContent = 'Open';
          openBtn.addEventListener('click', function () {
            ctx.invoke('open_artifact_widget', { artifactId: a.id, title: a.title })
              .catch(function () {});
          });

          var editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'app-btn';
          editBtn.textContent = 'Edit';
          editBtn.addEventListener('click', function () {
            loadIntoComposer(a);
          });

          var delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'app-btn delete';
          delBtn.textContent = 'Delete';
          delBtn.addEventListener('click', function () {
            if (!wsClient) return;
            wsClient.send({ type: 'artifact-unpin', id: a.id });
          });

          actions.appendChild(openBtn);
          actions.appendChild(editBtn);
          actions.appendChild(delBtn);
          row.appendChild(actions);

          return row;
        });

        listEl.replaceChildren.apply(listEl, rows);
      }

      // ── Save handler ──────────────────────────────────────────────────────
      saveBtn.addEventListener('click', function () {
        var title = titleInput.value.trim();
        var html = contentArea.value;
        var kind = kindSelect.value;

        if (!title || !html) return;
        if (!wsClient) return;

        if (editTarget) {
          // Edit mode: route through artifact-edit (store.update) — NOT
          // unpin+re-pin, which would destroy the version ledger and reset the
          // widget's bridgeCaps. update appends a version, preserving both.
          // (Content-only: the store's update changes content, leaving title +
          // caps intact — the title field is locked while editing.)
          wsClient.send({ type: 'artifact-edit', id: editTarget, content: html });
          clearComposer();
        } else {
          // Create mode: generate a unique id.
          var newId = uniqueId(kind, title);
          wsClient.send({ type: 'artifact-pin', id: newId, title: title, content: html, kind: kind });
          clearComposer();
        }
      });

      // ── Initial render (disconnected state) ───────────────────────────────
      renderList();

      // ── WS frame registry ─────────────────────────────────────────────────
      var registry = g.LunaWS.createFrameRegistry();

      registry.register('hello', function (frame) {
        var caps = g.LunaProtocol.parseHelloCapabilities(frame);
        if (!caps.artifacts) {
          var notice = document.createElement('div');
          notice.className = 'notice';
          notice.textContent = "This server doesn't support apps.";
          el.replaceChildren(notice);
          return;
        }
        // Capability present — wait for artifact-list.
      });

      registry.register('artifact-list', function (frame) {
        artifacts = Array.isArray(frame.artifacts) ? frame.artifacts : [];
        renderList();
      });

      // ── Connect ───────────────────────────────────────────────────────────
      wsClient = ctx.connectWs(registry, { autoPong: true });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
