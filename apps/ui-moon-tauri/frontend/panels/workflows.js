/**
 * panels/workflows.js — the Workflows gallery panel (PRD Part C W3).
 *
 * The full catalog view over the server's workflow gallery: every scheduled
 * and on-demand job as one row, sorted needs-attention → running → most
 * recent. Clicking a row opens that job's run-history inspector (the 'flow'
 * panel, one window per jobId). Refresh re-pulls the catalog.
 *
 * Inbound frames:   hello (capability gate on .workflows), workflow-list
 * Outbound frames:  workflow-refresh
 * Invoke:           open_widget({ kind: 'flow', params: { jobId } })
 *
 * Status vocabulary: jobs.last_status on the wire is the RAW backend value —
 * "fired" | "errored" | "running" | "scheduled" (jobs-store-types.ts §jobs,
 * written by job-ticker), passed through untranslated by toGalleryItem. The
 * classifier below maps that vocabulary (plus the run-status one, as
 * belt-and-suspenders should the server ever normalize) into dot classes,
 * and statusLabel humanizes it for the meta line ("fired" reads as "ok").
 *
 * Registers into window.LunaPanelTypes; loaded by panel.html's per-type
 * loader (or preloaded by the jsdom harness). Safe DOM methods only.
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  // Bounds on untrusted frame data (the WS peer is a remote server): cap the
  // row count and clamp every rendered string so a misbehaving server cannot
  // freeze the webview with a huge list or multi-megabyte labels.
  var MAX_ROWS = 500;
  var MAX_LABEL = 200;
  var MAX_META = 64;

  g.LunaPanelTypes['workflows'] = {
    title: 'Workflows',

    render: function (el, ctx) {
      // ── Inline styles ────────────────────────────────────────────────────
      var style = document.createElement('style');
      style.textContent = [
        '.wfs-header { display:flex; align-items:center; gap:8px; margin-bottom:10px; }',
        '.wfs-header[hidden] { display:none !important; }',
        '.wfs-count { font-size:0.66rem; color:var(--muted); }',
        '.wfs-count.stale { color:#f8c982; }',
        '.wfs-header .panel-btn { margin-left:auto; }',
        '.wfs-list { display:flex; flex-direction:column; gap:5px; width:100%; }',
        '.wfs-list[hidden] { display:none !important; }',
        /* Token-based card colors (not rgba-white) so rows read on BOTH the
           light and dark watercolor papers. */
        '.wfs-row {',
        '  display:flex; align-items:center; gap:8px; cursor:pointer;',
        '  background:color-mix(in oklab, var(--ink) 3%, transparent);',
        '  border:1px solid var(--ink-faint);',
        '  border-radius:9px; padding:7px 10px; text-align:left; width:100%;',
        '  transition:border-color 0.18s ease, background 0.18s ease; }',
        '.wfs-row:hover { border-color:color-mix(in oklab, var(--accent) 22%, transparent);',
        '  background:color-mix(in oklab, var(--accent) 5%, transparent); }',
        '.wfs-row:focus-visible { outline:1px solid color-mix(in oklab, var(--accent) 45%, transparent); outline-offset:1px; }',
        '.wfs-row.attention { border-color:rgba(248,201,130,0.22); background:rgba(248,201,130,0.05); }',
        '.wfs-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }',
        '.wfs-dot.success   { background:#7ee2a8; }',
        '.wfs-dot.failed    { background:#f08c8c; }',
        '.wfs-dot.running   { background:var(--accent); }',
        '.wfs-dot.waiting   { background:#f8c982; }',
        '.wfs-dot.queued, .wfs-dot.cancelled, .wfs-dot.never { background:var(--muted); }',
        '.wfs-info { flex:1; min-width:0; }',
        '.wfs-name-row { display:flex; align-items:center; gap:6px; }',
        '.wfs-name { font-size:0.78rem; font-weight:600; color:var(--text);',
        '  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
        '.wfs-badge { font-size:0.58rem; font-weight:600; padding:1px 6px; flex-shrink:0;',
        '  border-radius:8px; line-height:1.5; letter-spacing:0.02em; }',
        '.wfs-badge.scheduled { background:color-mix(in oklab, var(--accent) 15%, transparent); color:var(--accent);',
        '  border:1px solid color-mix(in oklab, var(--accent) 25%, transparent); }',
        '.wfs-badge.on-demand { background:rgba(148,163,184,0.10); color:#94a3b8;',
        '  border:1px solid rgba(148,163,184,0.20); }',
        '.wfs-badge.paused { background:rgba(239,68,68,0.10); color:#fca5a5;',
        '  border:1px solid rgba(239,68,68,0.22); }',
        '.wfs-meta { font-size:0.64rem; color:var(--muted); margin-top:1px;',
        '  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
        '.wfs-more { font-size:0.64rem; color:var(--muted); font-style:italic; padding:4px 0; }',
        '.wfs-empty { font-size:0.76rem; color:var(--muted); font-style:italic; padding:10px 0; }',
      ].join('\n');
      document.head.appendChild(style);

      // ── State ────────────────────────────────────────────────────────────
      var workflows = [];        // WorkflowGalleryItem[] — full replacement on workflow-list
      var truncated = 0;         // rows dropped by the MAX_ROWS cap (for the footer)
      var capability = 'unknown'; // 'unknown' | 'enabled' | 'disabled' (from hello)
      var wsClient = null;

      // ── DOM skeleton (toggled, never destroyed — the gate is a switch) ───
      var noticeEl = document.createElement('div');
      noticeEl.className = 'notice';
      noticeEl.id = 'wfs-notice';
      noticeEl.textContent = "This server doesn't expose workflows.";
      noticeEl.hidden = true;
      el.appendChild(noticeEl);

      var headerRow = document.createElement('div');
      headerRow.className = 'wfs-header panel-row';

      var countEl = document.createElement('span');
      countEl.className = 'wfs-count';
      countEl.id = 'wfs-count';
      countEl.textContent = '';

      var refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'panel-btn';
      refreshBtn.id = 'wfs-refresh-btn';
      refreshBtn.textContent = 'Refresh';
      refreshBtn.addEventListener('click', function () {
        requestRefresh();
      });

      headerRow.appendChild(countEl);
      headerRow.appendChild(refreshBtn);
      el.appendChild(headerRow);

      var listEl = document.createElement('div');
      listEl.className = 'wfs-list';
      listEl.id = 'wfs-list';
      el.appendChild(listEl);

      // ── Helpers ──────────────────────────────────────────────────────────
      function clampText(value, max) {
        return String(value == null ? '' : value).slice(0, max);
      }

      function fmtRelative(epochMs) {
        // Past → "2h ago"; future → "in 2h"; invalid → null. Coerce first: a
        // date STRING would pass a new Date() guard but NaN the arithmetic.
        epochMs = Number(epochMs);
        if (!Number.isFinite(epochMs) || epochMs <= 0) return null;
        var diffSec = Math.round((Date.now() - epochMs) / 1000);
        var future = diffSec < 0;
        var s = Math.abs(diffSec);
        var span;
        if (s < 60) span = future ? 'moments' : 'just now';
        else if (s < 3600) span = Math.round(s / 60) + 'm';
        else if (s < 86400) span = Math.round(s / 3600) + 'h';
        else span = Math.round(s / 86400) + 'd';
        if (!future) return s < 60 ? span : span + ' ago';
        return 'in ' + span;
      }

      // jobs.last_status arrives RAW from the backend: "fired" (ran ok),
      // "errored", "running", "scheduled". The run-status vocabulary
      // (success/failed/waiting/…) is accepted too as belt-and-suspenders
      // for servers that normalize before sending.
      function statusClass(rawStatus) {
        var s = String(rawStatus || '').toLowerCase();
        if (s === 'fired' || s === 'success' || s === 'ok' || s === 'completed') return 'success';
        if (s === 'errored' || s === 'failed' || s === 'fail' || s === 'error') return 'failed';
        if (s === 'running' || s === 'started') return 'running';
        if (s === 'waiting') return 'waiting';
        if (s === 'cancelled' || s === 'canceled') return 'cancelled';
        if (!rawStatus || s === 'scheduled') return 'never';
        return 'queued';
      }

      /** Humanized meta copy — "fired" reads as "ok", "errored" as "failed". */
      function statusLabel(rawStatus) {
        var cls = statusClass(rawStatus);
        if (cls === 'success') return 'ok';
        if (cls === 'failed') return 'failed';
        if (cls === 'never') return null;
        return clampText(rawStatus, MAX_META).toLowerCase();
      }

      // Sort rank: needs-attention first, then running, then everything else.
      // A paused job never runs again, so it never needs attention — its stale
      // lastStatus must not outrank live jobs (its badge already says paused).
      function attentionRank(wf) {
        if (!wf.enabled) return 2;
        var c = statusClass(wf.lastStatus);
        if (c === 'waiting' || c === 'failed') return 0;
        if (c === 'running') return 1;
        return 2;
      }

      function makeBadge(wf) {
        var badge = document.createElement('span');
        badge.className = 'wfs-badge';
        if (!wf.enabled) {
          badge.className += ' paused';
          badge.textContent = 'paused';
        } else if (wf.schedule) {
          badge.className += ' scheduled';
          badge.textContent = clampText(wf.schedule, MAX_META);
        } else if (wf.onDemand) {
          badge.className += ' on-demand';
          badge.textContent = 'on-demand';
        } else {
          badge.className += ' on-demand';
          badge.textContent = clampText(wf.kind, MAX_META) || 'workflow';
        }
        return badge;
      }

      function metaText(wf) {
        var parts = [clampText(wf.kind, MAX_META) || 'job'];
        var label = statusLabel(wf.lastStatus);
        if (label) {
          var rel = fmtRelative(wf.lastRun);
          parts.push(label + (rel ? ' ' + rel : ''));
        } else {
          parts.push('never ran');
        }
        if (wf.enabled && wf.nextRunAt) {
          var next = fmtRelative(wf.nextRunAt);
          if (next) parts.push('next ' + next);
        }
        return parts.join(' · ');
      }

      function openFlow(jobId) {
        // One run-history window per job (the 'flow' panel is non-singleton).
        ctx.invoke('open_widget', { kind: 'flow', params: { jobId: jobId } }).catch(function (e) {
          console.warn('open flow panel failed:', e);
        });
      }

      function makeRow(wf) {
        var cls = statusClass(wf.lastStatus);
        var attention = attentionRank(wf) === 0;
        var jobId = wf.id;
        var displayName = clampText(wf.label, MAX_LABEL) || jobId;

        var row = document.createElement('div');
        row.className = 'wfs-row' + (attention ? ' attention' : '');
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.setAttribute('data-job-id', jobId);
        row.setAttribute('aria-label', 'Open run history for ' + displayName);

        var dot = document.createElement('span');
        dot.className = 'wfs-dot ' + cls;
        dot.setAttribute('aria-hidden', 'true');
        row.appendChild(dot);

        var info = document.createElement('div');
        info.className = 'wfs-info';

        var nameRow = document.createElement('div');
        nameRow.className = 'wfs-name-row';
        var name = document.createElement('span');
        name.className = 'wfs-name';
        name.textContent = displayName;
        nameRow.appendChild(name);
        nameRow.appendChild(makeBadge(wf));
        info.appendChild(nameRow);

        var meta = document.createElement('div');
        meta.className = 'wfs-meta';
        meta.textContent = metaText(wf);
        info.appendChild(meta);

        row.appendChild(info);

        row.addEventListener('click', function () { openFlow(jobId); });
        row.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openFlow(jobId);
          }
        });

        return row;
      }

      function setStale(stale) {
        // "disconnected" is truthful and actionable; a plain count when live.
        countEl.classList.toggle('stale', !!stale);
        if (stale) countEl.textContent = 'disconnected';
        else countEl.textContent = workflows.length ? String(workflows.length) : '';
      }

      function requestRefresh() {
        // send() returns false on a closed socket — surface it instead of
        // letting the button be a silent no-op with stale rows on screen.
        var ok = !!(wsClient && wsClient.send({ type: 'workflow-refresh' }));
        setStale(!ok);
        return ok;
      }

      function render() {
        setStale(countEl.classList.contains('stale'));
        while (listEl.firstChild) listEl.removeChild(listEl.firstChild);

        if (workflows.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'wfs-empty';
          empty.textContent = 'No workflows yet.';
          listEl.appendChild(empty);
          return;
        }

        var sorted = workflows.slice().sort(function (a, b) {
          var ra = attentionRank(a);
          var rb = attentionRank(b);
          if (ra !== rb) return ra - rb;
          var ta = Number(a.lastRun) || 0;
          var tb = Number(b.lastRun) || 0;
          if (ta !== tb) return tb - ta;
          return String(a.label || a.id).localeCompare(String(b.label || b.id));
        });

        for (var i = 0; i < sorted.length; i++) {
          listEl.appendChild(makeRow(sorted[i]));
        }

        if (truncated > 0) {
          var more = document.createElement('div');
          more.className = 'wfs-more';
          more.textContent = '+' + truncated + ' more not shown';
          listEl.appendChild(more);
        }
      }

      // ── WS frame registry ────────────────────────────────────────────────
      var registry = g.LunaWS.createFrameRegistry();

      registry.register('hello', function (frame) {
        var caps = g.LunaProtocol.parseHelloCapabilities(frame);
        if (!caps.workflows) {
          // Gate: this server doesn't expose workflows. Toggle, don't destroy
          // — a later hello (profile swap, reconnect) can re-enable the view.
          capability = 'disabled';
          workflows = [];
          truncated = 0;
          noticeEl.hidden = false;
          headerRow.hidden = true;
          listEl.hidden = true;
          return;
        }
        var wasDisabled = capability === 'disabled';
        capability = 'enabled';
        noticeEl.hidden = true;
        headerRow.hidden = false;
        listEl.hidden = false;
        setStale(false);
        render();
        // The server sends workflow-list right after the connect-time hello —
        // nothing to request then. But on a RE-ENABLE transition (profile /
        // capability swap) any list dropped while gated is gone, so re-pull.
        if (wasDisabled) requestRefresh();
      });

      registry.register('workflow-list', function (frame) {
        // The hello gate is a real gate on data, not just on chrome: frames
        // are dropped until this server has declared workflows support.
        if (capability !== 'enabled') return;
        var list = Array.isArray(frame.workflows) ? frame.workflows : [];
        // Boundary validation: only rows with a usable string id are
        // actionable (the id becomes the flow panel's jobId param, the
        // data-job-id attribute, and the display fallback when label is
        // empty — so its length must be bounded too; real job ids are
        // short slugs).
        list = list.filter(function (wf) {
          return wf && typeof wf.id === 'string' && wf.id.length > 0 && wf.id.length <= 256;
        });
        truncated = Math.max(0, list.length - MAX_ROWS);
        workflows = list.slice(0, MAX_ROWS);
        setStale(false);
        render();
      });

      // ── Initial render ───────────────────────────────────────────────────
      render();

      // ── Liveness ─────────────────────────────────────────────────────────
      // Pull model: relative times and the attention sort only move when a
      // frame arrives. Re-render (and re-pull) when the window regains focus
      // so a gallery left open all day doesn't show "next in 5m" an hour late.
      window.addEventListener('focus', function () {
        if (capability !== 'enabled') return;
        render();
        requestRefresh();
      });

      // ── Connect ──────────────────────────────────────────────────────────
      wsClient = ctx.connectWs(registry, {
        autoPong: true,
        onOpen: function () { if (capability === 'enabled') setStale(false); },
        onClose: function () { if (capability === 'enabled') setStale(true); },
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
