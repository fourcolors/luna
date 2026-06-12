/**
 * panels/briefing.js — "While you were away" workflow digest (PRD Part C W3).
 *
 * WS-backed: connects via ctx.connectWs, gates on parseHelloCapabilities(frame).workflows.
 * On workflow-list it renders three grouped sections:
 *   1. Needs attention  — lastStatus 'waiting' or 'failed' (amber accent rows + Open button)
 *   2. Ran recently     — lastStatus 'success' or 'cancelled', most-recent first, relative times
 *   3. Scheduled next   — has a schedule string, sorted by nextRunAt asc (null last)
 *
 * Outbound frames:  workflow-refresh
 * Inbound frames:   hello, workflow-list
 * Invoke:           open_widget({ kind: 'flow', params: { jobId } })
 *
 * Registers into window.LunaPanelTypes; loaded by panel.html or preloaded by the jsdom harness.
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  g.LunaPanelTypes['briefing'] = {
    title: 'Briefing',

    render: function (el, ctx) {

      // ── Inline styles ────────────────────────────────────────────────────
      var style = document.createElement('style');
      style.textContent = [
        '.bf-section { margin-bottom: 14px; }',
        '.bf-section-label {',
        '  font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.07em;',
        '  color: var(--muted); margin-bottom: 6px; }',
        '.bf-row {',
        '  display: flex; align-items: center; gap: 8px;',
        '  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05);',
        '  border-radius: 9px; padding: 7px 10px; margin-bottom: 5px; }',
        '.bf-row.attention {',
        '  border-color: rgba(248,201,130,0.22);',
        '  background: rgba(248,201,130,0.05); }',
        '.bf-row-info { flex: 1; min-width: 0; }',
        '.bf-row-name {',
        '  font-size: 0.78rem; font-weight: 600; color: var(--text);',
        '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
        '.bf-row-meta {',
        '  font-size: 0.66rem; color: var(--muted); margin-top: 1px;',
        '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
        '.bf-status-dot {',
        '  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }',
        '.bf-status-dot.waiting  { background: #f8c982; }',
        '.bf-status-dot.failed   { background: #f08c8c; }',
        '.bf-status-dot.success  { background: #7ee2a8; }',
        '.bf-status-dot.running  { background: var(--accent); }',
        '.bf-status-dot.queued, .bf-status-dot.cancelled { background: var(--muted); }',
        '.bf-open-btn {',
        '  padding: 4px 10px; border: 1px solid rgba(248,201,130,0.35);',
        '  border-radius: 6px; background: rgba(248,201,130,0.10);',
        '  color: #f8c982; font-size: 0.7rem; font-weight: 600; cursor: pointer;',
        '  flex-shrink: 0; transition: background 0.15s; }',
        '.bf-open-btn:hover { background: rgba(248,201,130,0.20); }',
        '.bf-empty {',
        '  font-size: 0.72rem; color: var(--muted); font-style: italic;',
        '  padding: 4px 0 8px; }',
        '.bf-refresh-row { display: flex; justify-content: flex-end; margin-bottom: 10px; }',
      ].join('\n');
      document.head.appendChild(style);

      // ── DOM skeleton ──────────────────────────────────────────────────────
      var refreshRow = document.createElement('div');
      refreshRow.className = 'bf-refresh-row';
      var refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'panel-btn';
      refreshBtn.textContent = 'Refresh';
      refreshRow.appendChild(refreshBtn);
      el.appendChild(refreshRow);

      var bodyEl = document.createElement('div');
      bodyEl.id = 'bf-body';
      el.appendChild(bodyEl);

      // ── State ──────────────────────────────────────────────────────────────
      var workflows = [];
      var wsClient = null;

      // ── Helpers ────────────────────────────────────────────────────────────

      function relativeTime(epochMs) {
        // Returns a human-readable relative string like "2h ago", "just now", "3d ago".
        if (!epochMs) return null;
        var now = Date.now();
        var diff = Math.max(0, now - epochMs);
        var secs = Math.floor(diff / 1000);
        if (secs < 60) return 'just now';
        var mins = Math.floor(secs / 60);
        if (mins < 60) return mins + 'm ago';
        var hours = Math.floor(mins / 60);
        if (hours < 24) return hours + 'h ago';
        var days = Math.floor(hours / 24);
        return days + 'd ago';
      }

      function scheduleLabel(wf) {
        // Build a terse meta line for scheduled-next rows.
        var parts = [];
        if (wf.schedule) parts.push(wf.schedule);
        if (wf.nextRunAt) {
          var rel = relativeTime(wf.nextRunAt);
          if (rel) parts.push('next ' + rel);
        }
        return parts.join(' · ') || null;
      }

      function statusDotClass(status) {
        if (!status) return null;
        var s = String(status).toLowerCase();
        if (s === 'waiting') return 'waiting';
        if (s === 'failed' || s === 'error') return 'failed';
        if (s === 'success' || s === 'ok' || s === 'completed') return 'success';
        if (s === 'running' || s === 'started') return 'running';
        if (s === 'cancelled') return 'cancelled';
        return 'queued';
      }

      function makeRow(wf, opts) {
        opts = opts || {};
        var row = document.createElement('div');
        row.className = 'bf-row' + (opts.attention ? ' attention' : '');
        row.setAttribute('data-job-id', wf.id);

        // status dot
        var dotClass = statusDotClass(wf.lastStatus);
        if (dotClass) {
          var dot = document.createElement('span');
          dot.className = 'bf-status-dot ' + dotClass;
          dot.setAttribute('aria-hidden', 'true');
          row.appendChild(dot);
        }

        // info
        var info = document.createElement('div');
        info.className = 'bf-row-info';

        var name = document.createElement('div');
        name.className = 'bf-row-name';
        name.textContent = wf.label || wf.id;
        info.appendChild(name);

        if (opts.meta) {
          var meta = document.createElement('div');
          meta.className = 'bf-row-meta';
          meta.textContent = opts.meta;
          info.appendChild(meta);
        }

        row.appendChild(info);

        // Open button for attention rows
        if (opts.attention) {
          var openBtn = document.createElement('button');
          openBtn.type = 'button';
          openBtn.className = 'bf-open-btn';
          openBtn.textContent = 'Open';
          openBtn.setAttribute('data-job-id', wf.id);
          openBtn.setAttribute('aria-label', 'Open ' + (wf.label || wf.id));
          var jobId = wf.id;
          openBtn.addEventListener('click', function () {
            ctx.invoke('open_widget', { kind: 'flow', params: { jobId: jobId } }).catch(function () {});
          });
          row.appendChild(openBtn);
        }

        return row;
      }

      function makeSection(labelText, rows) {
        var section = document.createElement('div');
        section.className = 'bf-section';

        var lbl = document.createElement('div');
        lbl.className = 'bf-section-label';
        lbl.textContent = labelText;
        section.appendChild(lbl);

        if (rows.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'bf-empty';
          empty.textContent = 'None';
          section.appendChild(empty);
        } else {
          for (var i = 0; i < rows.length; i++) {
            section.appendChild(rows[i]);
          }
        }

        return section;
      }

      function render() {
        // Group workflows into three buckets.
        var attention = [];
        var recent = [];
        var scheduled = [];

        for (var i = 0; i < workflows.length; i++) {
          var wf = workflows[i];
          var s = wf.lastStatus ? String(wf.lastStatus).toLowerCase() : null;
          var isWaiting = (s === 'waiting');
          var isFailed = (s === 'failed' || s === 'error');
          var isSuccess = (s === 'success' || s === 'ok' || s === 'completed');
          var isCancelled = (s === 'cancelled');

          if (isWaiting || isFailed) {
            attention.push(wf);
          } else if (isSuccess || isCancelled) {
            recent.push(wf);
          }

          if (wf.schedule) {
            scheduled.push(wf);
          }
        }

        // Sort recent: most-recent lastRun first (null last).
        recent.sort(function (a, b) {
          var ta = a.lastRun || 0;
          var tb = b.lastRun || 0;
          return tb - ta;
        });

        // Sort scheduled: soonest nextRunAt first (null last).
        scheduled.sort(function (a, b) {
          if (a.nextRunAt == null && b.nextRunAt == null) return 0;
          if (a.nextRunAt == null) return 1;
          if (b.nextRunAt == null) return -1;
          return a.nextRunAt - b.nextRunAt;
        });

        // Build DOM rows.
        var attnRows = attention.map(function (wf) {
          var s = wf.lastStatus ? String(wf.lastStatus).toLowerCase() : '';
          var metaParts = [];
          if (s === 'waiting') metaParts.push('Waiting for input');
          else if (s === 'failed' || s === 'error') metaParts.push('Failed');
          if (wf.lastRun) {
            var rel = relativeTime(wf.lastRun);
            if (rel) metaParts.push(rel);
          }
          return makeRow(wf, { attention: true, meta: metaParts.join(' · ') || null });
        });

        var recentRows = recent.map(function (wf) {
          var rel = wf.lastRun ? relativeTime(wf.lastRun) : null;
          return makeRow(wf, { meta: rel });
        });

        var scheduledRows = scheduled.map(function (wf) {
          return makeRow(wf, { meta: scheduleLabel(wf) });
        });

        bodyEl.replaceChildren(
          makeSection('Needs attention', attnRows),
          makeSection('Ran recently', recentRows),
          makeSection('Scheduled next', scheduledRows)
        );
      }

      // ── Refresh button ─────────────────────────────────────────────────────
      refreshBtn.addEventListener('click', function () {
        if (wsClient) {
          wsClient.send({ type: 'workflow-refresh' });
        }
      });

      // ── WS frame registry ──────────────────────────────────────────────────
      var registry = g.LunaWS.createFrameRegistry();

      registry.register('hello', function (frame) {
        var caps = g.LunaProtocol.parseHelloCapabilities(frame);
        if (!caps.workflows) {
          var notice = document.createElement('div');
          notice.className = 'notice';
          notice.textContent = "This server doesn't expose workflows.";
          el.replaceChildren(notice);
          return;
        }
        // Capability present — content renders when workflow-list arrives.
      });

      registry.register('workflow-list', function (frame) {
        workflows = Array.isArray(frame.workflows) ? frame.workflows : [];
        render();
      });

      // ── Connect ────────────────────────────────────────────────────────────
      wsClient = ctx.connectWs(registry, { autoPong: true });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
