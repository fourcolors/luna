/**
 * panels/flow.js — per-job run inspector panel (PRD Part C W3).
 *
 * Opened from briefing/now with a ?jobId= URL param. Fetches and renders
 * the full run history for one job; re-fetches on Refresh. Listens for
 * workflow-list broadcasts to keep the subtitle (name/schedule chip) live.
 *
 * Registers into window.LunaPanelTypes; loaded by panel.html's per-type
 * loader (or preloaded by the jsdom harness).
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  g.LunaPanelTypes['flow'] = {
    title: 'Run history',

    render: function (el, ctx) {
      // ── Inline styles ───────────────────────────────────────────────────────
      var style = document.createElement('style');
      style.textContent = [
        '.flow-header { display:flex; align-items:center; gap:8px; margin-bottom:8px; }',
        '.flow-job-id { flex:1; font-size:0.76rem; font-weight:600; color:#f1f5f9;',
        '  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
        '.flow-subtitle { font-size:0.62rem; color:var(--muted); margin-bottom:10px;',
        '  display:flex; align-items:center; gap:6px; }',
        '.flow-subtitle[hidden] { display:none !important; }',
        '.flow-badge { font-size:0.58rem; font-weight:600; padding:1px 6px;',
        '  border-radius:8px; line-height:1.5; letter-spacing:0.02em; }',
        '.flow-badge.scheduled { background:rgba(138,180,248,0.15); color:#8ab4f8;',
        '  border:1px solid rgba(138,180,248,0.25); }',
        '.flow-badge.on-demand { background:rgba(148,163,184,0.10); color:#94a3b8;',
        '  border:1px solid rgba(148,163,184,0.20); }',
        '.flow-badge.paused { background:rgba(239,68,68,0.10); color:#fca5a5;',
        '  border:1px solid rgba(239,68,68,0.22); }',
        '.flow-runs { display:flex; flex-direction:column; gap:5px; width:100%; }',
        '.flow-run-row { display:flex; flex-direction:column; gap:2px;',
        '  background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05);',
        '  border-radius:8px; padding:7px 10px;',
        '  transition:border-color 0.18s ease; }',
        '.flow-run-row:hover { border-color:rgba(138,180,248,0.20); }',
        '.flow-run-top { display:flex; align-items:center; gap:7px; }',
        '.flow-run-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }',
        '.flow-run-dot.success { background:#7ee2a8; }',
        '.flow-run-dot.failed  { background:#f08c8c; }',
        '.flow-run-dot.running { background:var(--accent); }',
        '.flow-run-dot.waiting { background:#f8c982; }',
        '.flow-run-dot.queued  { background:var(--muted); }',
        '.flow-run-dot.cancelled { background:var(--muted); }',
        '.flow-run-status { font-size:0.72rem; font-weight:600; flex-shrink:0; min-width:54px; }',
        '.flow-run-status.success { color:#7ee2a8; }',
        '.flow-run-status.failed  { color:#f08c8c; }',
        '.flow-run-status.running { color:var(--accent); }',
        '.flow-run-status.waiting { color:#f8c982; }',
        '.flow-run-status.queued  { color:var(--muted); }',
        '.flow-run-status.cancelled { color:var(--muted); }',
        '.flow-run-meta { display:flex; align-items:baseline; gap:6px;',
        '  font-size:0.62rem; color:#64748b; flex:1; }',
        '.flow-run-time { flex-shrink:0; }',
        '.flow-run-dur  { flex-shrink:0; }',
        '.flow-run-attempt { flex-shrink:0; font-size:0.58rem; color:#475569; }',
        '.flow-run-err { font-size:0.62rem; color:#f08c8c; margin-top:2px;',
        '  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:0.85; }',
        '.flow-empty { font-size:0.76rem; color:var(--muted); font-style:italic; padding:10px 0; }',
      ].join('\n');
      document.head.appendChild(style);

      // ── Read jobId from URL param ────────────────────────────────────────────
      var jobId = new URLSearchParams(location.search).get('jobId');

      if (!jobId) {
        var noJob = document.createElement('div');
        noJob.className = 'notice';
        noJob.textContent = 'No job selected.';
        el.appendChild(noJob);
        return;
      }

      // ── State ────────────────────────────────────────────────────────────────
      var runs = [];        // WorkflowRunItem[]
      var jobMeta = null;   // WorkflowGalleryItem for this job (from workflow-list)
      var wsClient = null;

      // ── DOM ──────────────────────────────────────────────────────────────────
      // Header: job id label + Refresh button
      var headerRow = document.createElement('div');
      headerRow.className = 'flow-header panel-row';

      var jobIdLabel = document.createElement('span');
      jobIdLabel.className = 'flow-job-id';
      jobIdLabel.textContent = jobId;
      jobIdLabel.id = 'flow-job-id';

      var refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'panel-btn';
      refreshBtn.id = 'flow-refresh-btn';
      refreshBtn.textContent = 'Refresh';
      refreshBtn.addEventListener('click', function () {
        if (wsClient) wsClient.send({ type: 'workflow-runs-request', jobId: jobId });
      });

      headerRow.appendChild(jobIdLabel);
      headerRow.appendChild(refreshBtn);
      el.appendChild(headerRow);

      // Subtitle: job name + schedule/on-demand chip (populated by workflow-list)
      var subtitleRow = document.createElement('div');
      subtitleRow.className = 'flow-subtitle';
      subtitleRow.id = 'flow-subtitle';
      subtitleRow.hidden = true;
      el.appendChild(subtitleRow);

      // Runs list container
      var listEl = document.createElement('div');
      listEl.className = 'flow-runs';
      listEl.id = 'flow-runs-list';
      el.appendChild(listEl);

      // ── Helpers ──────────────────────────────────────────────────────────────
      function fmtRelative(epochMs) {
        if (!epochMs) return '—';
        var d = new Date(epochMs);
        if (Number.isNaN(d.getTime())) return '—';
        var now = Date.now();
        var diffSec = Math.round((now - epochMs) / 1000);
        if (diffSec < 5) return 'just now';
        if (diffSec < 60) return diffSec + 's ago';
        var diffMin = Math.round(diffSec / 60);
        if (diffMin < 60) return diffMin + 'm ago';
        var diffHr = Math.round(diffMin / 60);
        if (diffHr < 24) return diffHr + 'h ago';
        return Math.round(diffHr / 24) + 'd ago';
      }

      function fmtDur(startMs, endMs) {
        if (!startMs || !endMs) return null;
        var s = Math.round((endMs - startMs) / 1000);
        if (s < 60) return s + 's';
        return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
      }

      function statusClass(rawStatus) {
        var s = String(rawStatus || '').toLowerCase();
        if (s === 'success' || s === 'ok' || s === 'completed') return 'success';
        if (s === 'failed' || s === 'fail' || s === 'error') return 'failed';
        if (s === 'running' || s === 'started') return 'running';
        if (s === 'waiting') return 'waiting';
        if (s === 'cancelled' || s === 'canceled') return 'cancelled';
        return 'queued';
      }

      function statusLabel(rawStatus) {
        var s = String(rawStatus || '').toLowerCase();
        if (s === 'success' || s === 'ok' || s === 'completed') return 'success';
        if (s === 'failed' || s === 'fail' || s === 'error') return 'failed';
        if (s === 'running' || s === 'started') return 'running';
        if (s === 'waiting') return 'waiting';
        if (s === 'cancelled' || s === 'canceled') return 'cancelled';
        return rawStatus || 'queued';
      }

      function renderSubtitle() {
        // Clear and rebuild the subtitle node from jobMeta.
        subtitleRow.hidden = !jobMeta;
        while (subtitleRow.firstChild) subtitleRow.removeChild(subtitleRow.firstChild);
        if (!jobMeta) return;

        var nameSpan = document.createElement('span');
        nameSpan.textContent = jobMeta.label || jobId;
        subtitleRow.appendChild(nameSpan);

        var badge = document.createElement('span');
        badge.className = 'flow-badge';
        if (!jobMeta.enabled) {
          badge.className += ' paused';
          badge.textContent = 'paused';
        } else if (jobMeta.schedule) {
          badge.className += ' scheduled';
          badge.textContent = 'scheduled · ' + jobMeta.schedule;
        } else if (jobMeta.onDemand) {
          badge.className += ' on-demand';
          badge.textContent = 'on-demand';
        } else {
          badge.className += ' on-demand';
          badge.textContent = jobMeta.kind || 'workflow';
        }
        subtitleRow.appendChild(badge);
      }

      function renderRuns() {
        while (listEl.firstChild) listEl.removeChild(listEl.firstChild);

        if (runs.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'flow-empty';
          empty.textContent = 'No runs yet.';
          listEl.appendChild(empty);
          return;
        }

        // Newest first
        var sorted = runs.slice().sort(function (a, b) { return b.startedAt - a.startedAt; });

        sorted.forEach(function (run) {
          var cls = statusClass(run.status);
          var lbl = statusLabel(run.status);

          var row = document.createElement('div');
          row.className = 'flow-run-row';
          row.setAttribute('data-run-id', String(run.id));

          // Top line: dot + status label + meta (time, duration, attempt)
          var top = document.createElement('div');
          top.className = 'flow-run-top';

          var dot = document.createElement('span');
          dot.className = 'flow-run-dot ' + cls;
          dot.setAttribute('aria-hidden', 'true');

          var statusEl = document.createElement('span');
          statusEl.className = 'flow-run-status ' + cls;
          statusEl.textContent = lbl;

          var meta = document.createElement('div');
          meta.className = 'flow-run-meta';

          var timeEl = document.createElement('span');
          timeEl.className = 'flow-run-time';
          timeEl.textContent = fmtRelative(run.startedAt);

          meta.appendChild(timeEl);

          var dur = fmtDur(run.startedAt, run.finishedAt);
          if (dur) {
            var sep = document.createElement('span');
            sep.textContent = '·';
            meta.appendChild(sep);
            var durEl = document.createElement('span');
            durEl.className = 'flow-run-dur';
            durEl.textContent = dur;
            meta.appendChild(durEl);
          }

          if (run.attempt && run.attempt > 1) {
            var sep2 = document.createElement('span');
            sep2.textContent = '·';
            meta.appendChild(sep2);
            var attEl = document.createElement('span');
            attEl.className = 'flow-run-attempt';
            attEl.textContent = 'attempt ' + run.attempt;
            meta.appendChild(attEl);
          }

          top.appendChild(dot);
          top.appendChild(statusEl);
          top.appendChild(meta);
          row.appendChild(top);

          // Error line (truncated to 120 chars, muted red)
          if (run.error) {
            var errEl = document.createElement('div');
            errEl.className = 'flow-run-err';
            errEl.textContent = String(run.error).slice(0, 120);
            row.appendChild(errEl);
          }

          listEl.appendChild(row);
        });
      }

      // ── WS frame registry ─────────────────────────────────────────────────────
      var registry = g.LunaWS.createFrameRegistry();

      registry.register('hello', function (frame) {
        var caps = g.LunaProtocol.parseHelloCapabilities(frame);
        if (!caps.workflows) {
          // Gate: this server doesn't expose workflows.
          var notice = document.createElement('div');
          notice.className = 'notice';
          notice.textContent = "This server doesn't expose workflows.";
          el.replaceChildren(notice);
          return;
        }
        // Request run history for our job.
        wsClient.send({ type: 'workflow-runs-request', jobId: jobId });
      });

      registry.register('workflow-runs', function (frame) {
        // Guard: only accept runs for our job.
        if (!frame || frame.jobId !== jobId) return;
        runs = Array.isArray(frame.runs) ? frame.runs : [];
        renderRuns();
      });

      registry.register('workflow-list', function (frame) {
        // Update subtitle if this broadcast includes our job.
        var list = Array.isArray(frame.workflows) ? frame.workflows : [];
        var found = null;
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === jobId) { found = list[i]; break; }
        }
        if (found) {
          jobMeta = found;
          renderSubtitle();
        }
      });

      // ── Initial render ────────────────────────────────────────────────────────
      renderRuns();

      // ── Connect ───────────────────────────────────────────────────────────────
      wsClient = ctx.connectWs(registry, { autoPong: true });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
