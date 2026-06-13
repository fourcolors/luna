/**
 * panels/actions.js — Suggested Actions panel.
 *
 * WS-backed: connects via ctx.connectWs, gates on capabilities.suggestedActions
 * (raw-fallback pattern: `!!(frame.capabilities && frame.capabilities.suggestedActions)`
 * — do NOT rely on parseHelloCapabilities knowing the new flag).
 *
 * Renders the full set of suggested actions for a single chat thread
 * (identified by the `thread` URL param). Accepts `suggested-action-set`
 * (full replacement) and `suggested-action-update` (single delta) frames,
 * both filtered to this panel's threadId.
 *
 * SuggestedActionWire:
 *   { id, threadId, actionType, title, detail?, rationale?, status,
 *     source, createdAt, executionId?, error? }
 *
 * Frames sent (client→server):
 *   suggested-action-respond { threadId, actionId, decision:'accept'|'dismiss' }
 *
 * Registers into window.LunaPanelTypes; loaded by panel.html's per-type
 * loader (or preloaded by the jsdom harness).
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  g.LunaPanelTypes['actions'] = {
    title: 'Suggested Actions',

    render: function (el, ctx) {
      // ── Inline styles (watercolor aesthetic, mirrors agents.js) ──────────────
      var style = document.createElement('style');
      style.textContent = [
        '.actions-list { display:flex; flex-direction:column; gap:6px; width:100%; }',
        '.action-row {',
        '  display:flex; flex-direction:column; gap:6px;',
        '  background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05);',
        '  border-radius:10px; padding:10px 12px; }',
        '.action-row-header { display:flex; align-items:flex-start; gap:8px; }',
        '.action-row-info { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }',
        '.action-row-title { font-size:0.80rem; font-weight:600; color:#f1f5f9;',
        '  display:flex; gap:6px; align-items:center; flex-wrap:wrap; }',
        '.action-status-badge { font-size:0.56rem; text-transform:uppercase; letter-spacing:0.06em;',
        '  border-radius:4px; padding:1px 5px; flex-shrink:0; }',
        '.action-status-badge.proposed { color:#93c5fd; background:rgba(147,197,253,0.12); }',
        '.action-status-badge.accepted { color:#86efac; background:rgba(134,239,172,0.10); }',
        '.action-status-badge.in_progress { color:#fde68a; background:rgba(253,230,138,0.10); }',
        '.action-status-badge.completed { color:#86efac; background:rgba(134,239,172,0.10); }',
        '.action-status-badge.failed { color:#fca5a5; background:rgba(252,165,165,0.10); }',
        '.action-status-badge.dismissed { color:#64748b; background:rgba(100,116,139,0.10); }',
        '.action-type-label { font-size:0.62rem; color:#64748b; flex-shrink:0; }',
        '.action-row-rationale { font-size:0.66rem; color:#94a3b8; line-height:1.3; }',
        '.action-row-actions { display:flex; gap:6px; }',
        '.action-btn {',
        '  padding:4px 10px; border-radius:6px; font-size:0.72rem; font-weight:600;',
        '  cursor:pointer; border:1px solid transparent; transition:filter 0.15s,transform 0.1s; }',
        '.action-btn:active { transform:translateY(1px); }',
        '.action-btn.accept {',
        '  background:color-mix(in oklab,var(--accent) 28%,transparent);',
        '  border-color:color-mix(in oklab,var(--accent) 55%,transparent);',
        '  color:var(--ink); }',
        '.action-btn.accept:hover { filter:brightness(1.1); }',
        '.action-btn.dismiss {',
        '  background:rgba(255,255,255,0.04); border-color:rgba(255,255,255,0.08);',
        '  color:#64748b; }',
        '.action-btn.dismiss:hover { background:rgba(255,255,255,0.07); color:#94a3b8; }',
        /* watercolor blot for source indication */
        '@keyframes action-bead-wash {',
        '  from { border-radius:47% 53% 51% 49%/52% 46% 54% 48%; }',
        '  to   { border-radius:52% 48% 46% 54%/49% 53% 47% 51%; } }',
        '.action-blot { width:20px; height:20px; flex-shrink:0; position:relative;',
        '  border-radius:47% 53% 51% 49%/52% 46% 54% 48%; margin-top:1px; }',
        '.action-blot[data-source="agent"] {',
        '  background:radial-gradient(circle closest-side,rgba(150,188,250,0.30) 0%,rgba(138,180,248,0.45) 45%,rgba(104,146,232,0.70) 78%,rgba(96,138,226,0.25) 94%,rgba(96,138,226,0) 100%);',
        '  box-shadow:0 0 8px rgba(138,180,248,0.28);',
        '  animation:action-bead-wash 7s ease-in-out infinite alternate; }',
        '.action-blot[data-source="dream"] {',
        '  background:radial-gradient(circle closest-side,rgba(192,148,238,0.30) 0%,rgba(165,110,220,0.55) 55%,rgba(139,75,200,0.70) 80%,rgba(90,40,140,0.20) 94%,rgba(90,40,140,0) 100%);',
        '  box-shadow:0 0 8px rgba(165,110,220,0.28); }',
        '.actions-notice { font-size:0.78rem; color:var(--muted); }',
      ].join('\n');
      document.head.appendChild(style);

      // ── Thread param ──────────────────────────────────────────────────────
      var threadId = new URLSearchParams(location.search).get('thread') || '';

      if (!threadId) {
        var noThread = document.createElement('div');
        noThread.className = 'notice';
        noThread.textContent = 'No conversation selected.';
        el.appendChild(noThread);
        return;
      }

      // ── State ─────────────────────────────────────────────────────────────
      var actions = null;  // null = not yet received; [] = empty; [...] = rows
      var wsClient = null;

      // ── DOM ───────────────────────────────────────────────────────────────
      var listEl = document.createElement('div');
      listEl.className = 'actions-list';
      el.appendChild(listEl);

      // ── Helpers ───────────────────────────────────────────────────────────
      function typeLabel(actionType) {
        var labels = {
          task: 'Task',
          research: 'Research',
          create_skill: 'Create Skill',
          create_workflow: 'Create Workflow',
          run_workflow: 'Run Workflow',
        };
        return labels[actionType] || actionType || '';
      }

      // ── Render ────────────────────────────────────────────────────────────
      function renderStatus() {
        if (actions === null) {
          var conn = document.createElement('span');
          conn.className = 'actions-notice';
          conn.textContent = 'Connecting…';
          listEl.replaceChildren(conn);
          return;
        }
        if (actions.length === 0) {
          var empty = document.createElement('span');
          empty.className = 'actions-notice';
          empty.textContent = 'No suggested actions — Luna will propose here when it has recommendations.';
          listEl.replaceChildren(empty);
          return;
        }
        var fragment = document.createDocumentFragment();
        for (var i = 0; i < actions.length; i++) {
          fragment.appendChild(buildRow(actions[i]));
        }
        listEl.replaceChildren(fragment);
      }

      function buildRow(action) {
        var row = document.createElement('div');
        row.className = 'action-row';
        row.setAttribute('data-action-id', action.id);

        // Header row: blot + info
        var header = document.createElement('div');
        header.className = 'action-row-header';

        // Blot (source indicator)
        var blot = document.createElement('div');
        blot.className = 'action-blot';
        blot.setAttribute('data-source', action.source || 'agent');

        // Info column
        var info = document.createElement('div');
        info.className = 'action-row-info';

        // Title + status badge + type label
        var titleEl = document.createElement('span');
        titleEl.className = 'action-row-title';
        var titleText = document.createTextNode(action.title || '');
        titleEl.appendChild(titleText);

        var badge = document.createElement('span');
        badge.className = 'action-status-badge ' + (action.status || '');
        badge.textContent = (action.status || '').replace(/_/g, ' ');
        titleEl.appendChild(badge);

        var typeEl = document.createElement('span');
        typeEl.className = 'action-type-label';
        typeEl.textContent = typeLabel(action.actionType);

        info.appendChild(titleEl);
        info.appendChild(typeEl);

        // Rationale (optional, muted)
        if (action.rationale) {
          var rationaleEl = document.createElement('span');
          rationaleEl.className = 'action-row-rationale';
          rationaleEl.textContent = action.rationale;
          info.appendChild(rationaleEl);
        }

        header.appendChild(blot);
        header.appendChild(info);
        row.appendChild(header);

        // Accept / Dismiss buttons only when status === 'proposed'
        if (action.status === 'proposed') {
          var btnRow = document.createElement('div');
          btnRow.className = 'action-row-actions';

          var acceptBtn = document.createElement('button');
          acceptBtn.type = 'button';
          acceptBtn.className = 'action-btn accept';
          acceptBtn.textContent = 'Accept';
          // Closure capture — avoid stale action reference after upsert
          ;(function (actionId) {
            acceptBtn.addEventListener('click', function () {
              wsClient.send({ type: 'suggested-action-respond', threadId: threadId, actionId: actionId, decision: 'accept' });
              // Optimistic: remove from proposed state immediately
              upsertAction({ id: actionId, status: 'accepted' });
            });
          })(action.id);

          var dismissBtn = document.createElement('button');
          dismissBtn.type = 'button';
          dismissBtn.className = 'action-btn dismiss';
          dismissBtn.textContent = 'Dismiss';
          ;(function (actionId) {
            dismissBtn.addEventListener('click', function () {
              wsClient.send({ type: 'suggested-action-respond', threadId: threadId, actionId: actionId, decision: 'dismiss' });
              // Optimistic: mark dismissed immediately
              upsertAction({ id: actionId, status: 'dismissed' });
            });
          })(action.id);

          btnRow.appendChild(acceptBtn);
          btnRow.appendChild(dismissBtn);
          row.appendChild(btnRow);
        }

        return row;
      }

      // ── State mutation helpers ─────────────────────────────────────────────
      function upsertAction(delta) {
        if (!actions) return;
        var idx = -1;
        for (var i = 0; i < actions.length; i++) {
          if (actions[i].id === delta.id) { idx = i; break; }
        }
        if (idx >= 0) {
          actions[idx] = Object.assign({}, actions[idx], delta);
        } else {
          // New action arriving via update frame — prepend
          actions = [delta].concat(actions);
        }
        renderStatus();
      }

      // Initial render (connecting state)
      renderStatus();

      // ── WS frame registry ─────────────────────────────────────────────────
      var registry = g.LunaWS.createFrameRegistry();

      registry.register('hello', function (frame) {
        // Raw-fallback pattern (capability was added after parseHelloCapabilities
        // was written — do not rely on it knowing the flag).
        var hasSuggestedActions = !!(frame && frame.capabilities && frame.capabilities.suggestedActions);
        if (!hasSuggestedActions) {
          var notice = document.createElement('div');
          notice.className = 'notice';
          notice.textContent = "This server doesn't support suggested actions.";
          el.replaceChildren(notice);
          return;
        }
        // Capability present — nothing more to do: the server will push
        // suggested-action-set on subscribe/replay automatically.
      });

      registry.register('suggested-action-set', function (frame) {
        // Full replacement — only handle frames for our thread.
        if (frame.threadId !== threadId) return;
        actions = Array.isArray(frame.actions) ? frame.actions : [];
        renderStatus();
      });

      registry.register('suggested-action-update', function (frame) {
        // Single delta — only handle frames for our thread.
        if (!frame.action || frame.threadId !== threadId) return;
        upsertAction(frame.action);
      });

      // ── Connect ───────────────────────────────────────────────────────────
      wsClient = ctx.connectWs(registry, { autoPong: true });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
