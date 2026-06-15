/**
 * panels/settings-skills.js — the Skills settings panel (PRD Part B §12).
 *
 * WS-backed: connects via ctx.connectWs, gates on parseHelloCapabilities
 * (frame).skills, renders the server's skill catalog as watercolor-blot
 * toggle rows with client-side search + category/source/enabledOnly filter
 * chips. Faithfully ports SkillsEngine from index.html to the panel context.
 *
 * Registers into window.LunaPanelTypes; loaded by panel.html's per-type
 * loader (or preloaded by the jsdom harness).
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  g.LunaPanelTypes['settings.skills'] = {
    title: 'Skills',

    render: function (el, ctx) {
      // ── Inline styles (dark-glass + skills watercolor) ────────────────────
      var style = document.createElement('style');
      style.textContent = [
        '.skills-search { width:100%; box-sizing:border-box; padding:6px 10px; margin-bottom:8px;',
        '  background:rgba(255,255,255,0.04); border:1px solid var(--border);',
        '  border-radius:7px; color:var(--text); font-size:0.8rem; outline:none; }',
        '.skills-search::placeholder { color:var(--muted); }',
        '.skills-chips { display:flex; flex-wrap:wrap; gap:6px; width:100%; margin-bottom:8px; }',
        '.skills-chip { font-size:0.66rem; letter-spacing:0.04em; color:#94a3b8;',
        '  background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08);',
        '  border-radius:999px; padding:3px 10px; cursor:pointer; transition:all 0.2s ease; }',
        '.skills-chip.on { color:#dbeafe; border-color:rgba(138,180,248,0.55);',
        '  background:rgba(138,180,248,0.12); }',
        '.sp-skills-list { display:flex; flex-direction:column; gap:6px; width:100%;',
        '  max-height:320px; overflow-y:auto; }',
        '.skill-row { display:flex; align-items:center; gap:10px;',
        '  background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05);',
        '  border-radius:10px; padding:8px 10px; cursor:pointer;',
        '  transition:border-color 0.2s ease,opacity 0.25s ease; }',
        '.skill-row:hover { border-color:rgba(138,180,248,0.25); }',
        '.skill-row.off { opacity:0.55; }',
        '.skill-row-info { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }',
        '.skill-row-name { font-size:0.78rem; font-weight:600; color:#f1f5f9;',
        '  display:flex; gap:6px; align-items:center; flex-wrap:wrap; }',
        '.skill-row-badge { font-size:0.56rem; text-transform:uppercase; letter-spacing:0.06em;',
        '  color:#94a3b8; background:rgba(255,255,255,0.05); border-radius:4px; padding:1px 5px; }',
        '.skill-row-desc { font-size:0.66rem; color:#64748b; line-height:1.3;',
        '  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
        '@keyframes bead-wash { from { border-radius:47% 53% 51% 49%/52% 46% 54% 48%; }',
        '  to { border-radius:52% 48% 46% 54%/49% 53% 47% 51%; } }',
        '.skill-blot { width:22px; height:22px; flex-shrink:0; position:relative;',
        '  border-radius:47% 53% 51% 49%/52% 46% 54% 48%;',
        '  background:radial-gradient(circle closest-side,rgba(150,188,250,0.30) 0%,rgba(138,180,248,0.45) 45%,rgba(104,146,232,0.70) 78%,rgba(96,138,226,0.25) 94%,rgba(96,138,226,0) 100%),radial-gradient(circle at 64% 68%,rgba(165,148,238,0.25) 0%,rgba(165,148,238,0) 60%);',
        '  box-shadow:0 0 10px rgba(138,180,248,0.35);',
        '  animation:bead-wash 7s ease-in-out infinite alternate;',
        '  transition:opacity 0.3s ease,filter 0.3s ease,box-shadow 0.3s ease; }',
        '.skill-row.off .skill-blot { opacity:0.35; filter:grayscale(0.7); box-shadow:none; animation:none; }',
        '.skill-row.pending .skill-blot { filter:blur(1px); }',
        '.skills-count-line { font-size:0.72rem; color:var(--muted); margin-bottom:6px; }',
        '.skills-error-line { font-size:0.72rem; color:#fda4af; margin-bottom:6px; }',
      ].join('\n');
      document.head.appendChild(style);

      // ── State ─────────────────────────────────────────────────────────────
      var skills = [];          // current catalog
      var skillsPending = {};   // id → requested enabled value (in-flight toggle)
      var filter = { q: '', category: 'all', source: 'all', enabledOnly: false };
      var wsClient = null;

      // ── DOM ───────────────────────────────────────────────────────────────
      // Heading row
      var heading = document.createElement('div');
      heading.className = 'panel-row';
      var headLabel = document.createElement('span');
      headLabel.textContent = 'Skills';
      headLabel.style.fontWeight = '600';
      headLabel.style.fontSize = '0.82rem';
      var countSpan = document.createElement('span');
      countSpan.id = 'skills-count';
      countSpan.className = 'skills-count-line';
      countSpan.style.display = 'inline';
      countSpan.style.marginLeft = '6px';
      heading.appendChild(headLabel);
      heading.appendChild(countSpan);
      el.appendChild(heading);

      // Search input
      var searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.id = 'skills-search-input';
      searchInput.className = 'skills-search';
      searchInput.placeholder = 'Search skills…';
      searchInput.setAttribute('autocomplete', 'off');
      searchInput.setAttribute('spellcheck', 'false');
      el.appendChild(searchInput);

      // Filter chips container
      var chipsEl = document.createElement('div');
      chipsEl.id = 'skills-chips';
      chipsEl.className = 'skills-chips';
      el.appendChild(chipsEl);

      // Error line
      var errorEl = document.createElement('span');
      errorEl.id = 'skills-error';
      errorEl.className = 'skills-error-line';
      errorEl.hidden = true;
      el.appendChild(errorEl);

      // Skill list
      var listEl = document.createElement('div');
      listEl.id = 'skills-list';
      listEl.className = 'sp-skills-list';
      el.appendChild(listEl);

      // ── Helpers ───────────────────────────────────────────────────────────
      function setError(message) {
        errorEl.hidden = !message;
        errorEl.textContent = message || '';
      }

      function visible() {
        var q = filter.q.trim().toLowerCase();
        return skills.filter(function (s) {
          if (filter.category !== 'all' && s.category !== filter.category) return false;
          if (filter.source !== 'all' && s.source !== filter.source) return false;
          if (filter.enabledOnly && !s.enabled) return false;
          if (!q) return true;
          var hay = (s.name + ' ' + s.description + ' ' + (s.tags || []).join(' ')).toLowerCase();
          return hay.includes(q);
        });
      }

      function makeChip(label, on, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'skills-chip' + (on ? ' on' : '');
        b.setAttribute('aria-pressed', String(!!on));
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
      }

      function render() {
        // count badge
        if (skills.length) {
          var on = skills.filter(function (s) { return s.enabled; }).length;
          countSpan.textContent = '· ' + on + '/' + skills.length + ' on';
        } else {
          countSpan.textContent = '';
        }

        // chips
        var cats = ['all'].concat(
          Array.from(new Set(skills.map(function (s) { return s.category; }))).sort()
        );
        if (!cats.includes(filter.category)) filter.category = 'all';

        var chipNodes = cats.map(function (c) {
          return makeChip(c, filter.category === c, function () {
            filter.category = c;
            render();
          });
        });
        chipNodes.push(makeChip('built-in', filter.source === 'builtin', function () {
          filter.source = filter.source === 'builtin' ? 'all' : 'builtin';
          render();
        }));
        chipNodes.push(makeChip('yours', filter.source === 'user', function () {
          filter.source = filter.source === 'user' ? 'all' : 'user';
          render();
        }));
        chipNodes.push(makeChip('enabled only', filter.enabledOnly, function () {
          filter.enabledOnly = !filter.enabledOnly;
          render();
        }));
        chipsEl.replaceChildren.apply(chipsEl, chipNodes);

        // rows
        var vis = visible();
        if (vis.length === 0) {
          var empty = document.createElement('span');
          empty.style.fontSize = '0.78rem';
          empty.style.color = 'var(--muted)';
          empty.textContent = skills.length
            ? 'No skills match.'
            : 'Not connected — skills appear when the server sends its catalog.';
          listEl.replaceChildren(empty);
          return;
        }

        var rows = vis.map(function (s) {
          var pending = s.id in skillsPending;
          var row = document.createElement('div');
          row.className = 'skill-row' + (s.enabled ? '' : ' off') + (pending ? ' pending' : '');
          row.setAttribute('role', 'switch');
          row.setAttribute('aria-checked', String(!!s.enabled));
          row.tabIndex = 0;
          if (pending) row.setAttribute('aria-busy', 'true');
          row.title = s.enabled ? 'Click to disable' : 'Click to enable';

          row.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              doToggle(s.id);
            }
          });
          row.addEventListener('click', function () { doToggle(s.id); });

          var blot = document.createElement('div');
          blot.className = 'skill-blot';

          var info = document.createElement('div');
          info.className = 'skill-row-info';

          var name = document.createElement('span');
          name.className = 'skill-row-name';
          name.textContent = s.name;

          var badge = document.createElement('span');
          badge.className = 'skill-row-badge';
          badge.textContent = s.source === 'user' ? 'yours' : s.source;
          name.appendChild(badge);

          var cat = document.createElement('span');
          cat.className = 'skill-row-badge';
          cat.textContent = s.category;
          name.appendChild(cat);

          var desc = document.createElement('span');
          desc.className = 'skill-row-desc';
          desc.textContent = s.description;

          info.appendChild(name);
          info.appendChild(desc);
          row.appendChild(blot);
          row.appendChild(info);
          return row;
        });

        listEl.replaceChildren.apply(listEl, rows);
      }

      function doToggle(id) {
        var skill = null;
        for (var i = 0; i < skills.length; i++) {
          if (skills[i].id === id) { skill = skills[i]; break; }
        }
        if (!skill || id in skillsPending) return;
        if (!wsClient) {
          setError('Not connected to a server.');
          return;
        }
        skillsPending[id] = !skill.enabled;
        // Exact frame shape the original engine sends:
        wsClient.send({ type: 'skill-toggle', id: id, enabled: !skill.enabled });
        render();
      }

      function applyCatalog(incomingSkills) {
        skills = Array.isArray(incomingSkills) ? incomingSkills : [];
        // Settle only confirmed in-flight toggles (preserves concurrent
        // second-toggle pending state per original review finding).
        var settled = {};
        for (var id in skillsPending) {
          if (!Object.prototype.hasOwnProperty.call(skillsPending, id)) continue;
          var desired = skillsPending[id];
          var row = null;
          for (var i = 0; i < skills.length; i++) {
            if (skills[i].id === id) { row = skills[i]; break; }
          }
          if (row && row.enabled !== desired) settled[id] = desired;
        }
        skillsPending = settled;
        setError(null);
        render();
      }

      function applyStatus(frame) {
        if (!frame || typeof frame.id !== 'string') return;
        delete skillsPending[frame.id];
        if (frame.ok) {
          skills = skills.map(function (s) {
            return s.id === frame.id ? Object.assign({}, s, { enabled: frame.enabled }) : s;
          });
          setError(null);
        } else {
          setError(frame.message || 'Could not change that skill.');
        }
        render();
      }

      // ── Initial render (disconnected state) ───────────────────────────────
      render();

      // ── Search wire-up ────────────────────────────────────────────────────
      searchInput.addEventListener('input', function (e) {
        filter.q = e.target.value || '';
        render();
      });

      // ── WS frame registry ─────────────────────────────────────────────────
      var registry = g.LunaWS.createFrameRegistry();

      registry.register('hello', function (frame) {
        var caps = g.LunaProtocol.parseHelloCapabilities(frame);
        // Clear in-flight pending from any previous connection.
        skillsPending = {};
        if (!caps.skills) {
          // Show notice and stop — do not render controls.
          var notice = document.createElement('div');
          notice.className = 'notice';
          notice.textContent = "This server doesn't list skills.";
          el.replaceChildren(notice);
          return;
        }
        // Capability present — nothing further until skill-catalog arrives.
      });

      registry.register('skill-catalog', function (frame) {
        applyCatalog(frame.skills || []);
      });

      registry.register('skill-status', function (frame) {
        applyStatus(frame);
      });

      // ── Connect ───────────────────────────────────────────────────────────
      wsClient = ctx.connectWs(registry, { autoPong: true });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
