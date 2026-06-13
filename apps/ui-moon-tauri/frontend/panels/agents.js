/**
 * panels/agents.js — the live Agents panel (S4 "Agents" panel).
 *
 * WS-backed: connects via ctx.connectWs, gates on parseHelloCapabilities
 * (frame).subagents, renders the live subagent tree for a single chat thread
 * (identified by the `thread` URL param). NEVER sends a `subscribe` frame —
 * subscribing would steal the chat window's interactive bindings. Instead,
 * sends a `subagent-tree-request` on hello (so a panel summoned mid-turn
 * paints immediately) and listens for broadcasted `subagent-tree` frames,
 * ignoring those for other threads.
 *
 * Registers into window.LunaPanelTypes; loaded by panel.html's per-type
 * loader (or preloaded by the jsdom harness).
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  g.LunaPanelTypes['agents'] = {
    title: 'Agents',

    render: function (el, ctx) {
      // ── Inline styles (dark-glass + watercolor blot) ──────────────────────
      var style = document.createElement('style');
      style.textContent = [
        '.agents-list { display:flex; flex-direction:column; gap:6px; width:100%; }',
        '.agent-row { display:flex; align-items:flex-start; gap:10px;',
        '  background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05);',
        '  border-radius:10px; padding:8px 10px; }',
        '.agent-row-info { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }',
        '.agent-row-name { font-size:0.78rem; font-weight:600; color:#f1f5f9;',
        '  display:flex; gap:6px; align-items:center; flex-wrap:wrap; }',
        '.agent-status-badge { font-size:0.56rem; text-transform:uppercase; letter-spacing:0.06em;',
        '  border-radius:4px; padding:1px 5px; }',
        '.agent-status-badge.running { color:#93c5fd; background:rgba(147,197,253,0.12); }',
        '.agent-status-badge.done { color:#86efac; background:rgba(134,239,172,0.10); }',
        '.agent-status-badge.error { color:#fca5a5; background:rgba(252,165,165,0.10); }',
        '.agent-row-desc { font-size:0.66rem; color:#64748b; line-height:1.3;',
        '  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
        '.agent-row-activity { font-size:0.66rem; color:#94a3b8; }',
        /* watercolor blot statuses */
        '@keyframes bead-wash { from { border-radius:47% 53% 51% 49%/52% 46% 54% 48%; }',
        '  to { border-radius:52% 48% 46% 54%/49% 53% 47% 51%; } }',
        '.agent-blot { width:22px; height:22px; flex-shrink:0; position:relative;',
        '  border-radius:47% 53% 51% 49%/52% 46% 54% 48%; }',
        '.agent-blot[data-status="running"] {',
        '  background:radial-gradient(circle closest-side,rgba(150,188,250,0.30) 0%,rgba(138,180,248,0.45) 45%,rgba(104,146,232,0.70) 78%,rgba(96,138,226,0.25) 94%,rgba(96,138,226,0) 100%),radial-gradient(circle at 64% 68%,rgba(165,148,238,0.25) 0%,rgba(165,148,238,0) 60%);',
        '  box-shadow:0 0 10px rgba(138,180,248,0.35);',
        '  animation:bead-wash 7s ease-in-out infinite alternate; }',
        '.agent-blot[data-status="done"] {',
        '  background:radial-gradient(circle closest-side,rgba(134,239,172,0.30) 0%,rgba(74,222,128,0.55) 55%,rgba(34,197,94,0.70) 80%,rgba(21,128,61,0.20) 94%,rgba(21,128,61,0) 100%);',
        '  box-shadow:0 0 8px rgba(74,222,128,0.28); }',
        '.agent-blot[data-status="error"] {',
        '  background:radial-gradient(circle closest-side,rgba(252,165,165,0.30) 0%,rgba(248,113,113,0.55) 55%,rgba(239,68,68,0.70) 80%,rgba(185,28,28,0.20) 94%,rgba(185,28,28,0) 100%);',
        '  box-shadow:0 0 8px rgba(248,113,113,0.28); }',
        '.agent-children { display:flex; flex-direction:column; gap:6px; padding-left:20px; }',
        '.agents-notice { font-size:0.78rem; color:var(--muted); }',
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
      var agents = null;  // null = not yet received; [] = empty; [...] = nodes
      var wsClient = null;

      // ── DOM ───────────────────────────────────────────────────────────────
      var listEl = document.createElement('div');
      listEl.className = 'agents-list';
      el.appendChild(listEl);

      // ── Render ────────────────────────────────────────────────────────────
      function renderStatus() {
        if (agents === null) {
          var conn = document.createElement('span');
          conn.className = 'agents-notice';
          conn.textContent = 'Connecting…';
          listEl.replaceChildren(conn);
          return;
        }
        if (agents.length === 0) {
          var empty = document.createElement('span');
          empty.className = 'agents-notice';
          empty.textContent = 'No subagents yet — this lights up when Luna delegates.';
          listEl.replaceChildren(empty);
          return;
        }
        // Build tree: top-level nodes have parentId === null.
        var topLevel = [];
        for (var i = 0; i < agents.length; i++) {
          if (agents[i].parentId === null) topLevel.push(agents[i]);
        }
        var fragment = document.createDocumentFragment();
        for (var j = 0; j < topLevel.length; j++) {
          fragment.appendChild(buildNode(topLevel[j], 0));
        }
        listEl.replaceChildren(fragment);
      }

      function buildNode(node, depth) {
        var wrap = document.createElement('div');

        var row = document.createElement('div');
        row.className = 'agent-row';

        // Blot
        var blot = document.createElement('div');
        blot.className = 'agent-blot';
        blot.setAttribute('data-status', node.status);

        // Info column
        var info = document.createElement('div');
        info.className = 'agent-row-info';

        // Name + status badge
        var nameEl = document.createElement('span');
        nameEl.className = 'agent-row-name';
        var nameText = document.createTextNode(node.name);
        nameEl.appendChild(nameText);

        var badge = document.createElement('span');
        badge.className = 'agent-status-badge ' + node.status;
        badge.textContent = node.status;
        nameEl.appendChild(badge);

        // Description (muted, single line, ellipsis)
        var descEl = document.createElement('span');
        descEl.className = 'agent-row-desc';
        descEl.textContent = node.description;

        // Activity line: tool + toolCount
        var activityEl = document.createElement('span');
        activityEl.className = 'agent-row-activity';
        if (node.tool) {
          activityEl.textContent = node.tool + ' · ' + node.toolCount + ' tool' + (node.toolCount === 1 ? '' : 's');
        } else if (node.toolCount > 0) {
          activityEl.textContent = node.toolCount + ' tool' + (node.toolCount === 1 ? '' : 's');
        } else {
          activityEl.textContent = 'starting…';
        }

        info.appendChild(nameEl);
        info.appendChild(descEl);
        info.appendChild(activityEl);

        row.appendChild(blot);
        row.appendChild(info);
        wrap.appendChild(row);

        // Children (nodes whose parentId === node.id)
        var children = [];
        for (var i = 0; i < agents.length; i++) {
          if (agents[i].parentId === node.id) children.push(agents[i]);
        }
        if (children.length > 0) {
          var childWrap = document.createElement('div');
          childWrap.className = 'agent-children';
          for (var k = 0; k < children.length; k++) {
            childWrap.appendChild(buildNode(children[k], depth + 1));
          }
          wrap.appendChild(childWrap);
        }

        return wrap;
      }

      // Initial render (connecting state)
      renderStatus();

      // ── WS frame registry ─────────────────────────────────────────────────
      var registry = g.LunaWS.createFrameRegistry();

      registry.register('hello', function (frame) {
        // parseHelloCapabilities covers the core set; `subagents` is read
        // directly because it was added after the function was written.
        var caps = g.LunaProtocol.parseHelloCapabilities(frame);
        var hasSubagents = caps.subagents || !!(frame && frame.capabilities && frame.capabilities.subagents);
        if (!hasSubagents) {
          var notice = document.createElement('div');
          notice.className = 'notice';
          notice.textContent = "This server doesn't report subagents.";
          el.replaceChildren(notice);
          return;
        }
        // Request current tree immediately so a mid-turn open paints at once.
        wsClient.send({ type: 'subagent-tree-request', threadId: threadId });
      });

      registry.register('subagent-tree', function (frame) {
        // Only handle frames for our thread.
        if (frame.threadId !== threadId) return;
        agents = Array.isArray(frame.agents) ? frame.agents : [];
        renderStatus();
      });

      // ── Connect ───────────────────────────────────────────────────────────
      wsClient = ctx.connectWs(registry, { autoPong: true });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
