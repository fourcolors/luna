/**
 * panels/now.js — The live "Now" rail: running work + needs-input answer surface.
 *
 * WS-backed: connects via ctx.connectWs, gates on parseHelloCapabilities
 * (frame).workflows. Renders a compact live rail of workflow rows sorted
 * waiting→running→rest, plus an answer-card surface for job-input-request
 * prompts that stack newest-on-top and survive workflow-list re-renders.
 *
 * Frames consumed (server→client):
 *   hello            — capability gate on .workflows
 *   workflow-list    — full replacement render of the workflow rail
 *   job-input-request — pin an answer card to the top
 *   job-input-status  — settle or clear the matching card
 *
 * Frames sent (client→server):
 *   job-input-result {requestId, answer}          — answer submission
 *   job-input-result {requestId, cancelled:true}  — dismiss
 *
 * Registers into window.LunaPanelTypes; loaded by panel.html's per-type
 * loader (or preloaded by the jsdom harness).
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  g.LunaPanelTypes['now'] = {
    title: 'Now',

    render: function (el, ctx) {
      // ── Inline styles ──────────────────────────────────────────────────────
      var style = document.createElement('style');
      style.textContent = [
        /* ── answer cards ── */
        '.now-cards { display:flex; flex-direction:column; gap:8px; width:100%; margin-bottom:12px; }',
        '.now-answer-card {',
        '  background:rgba(248,201,130,0.07); border:1px solid rgba(248,201,130,0.30);',
        '  border-radius:10px; padding:10px 12px; display:flex; flex-direction:column; gap:8px; }',
        '.now-answer-card-job { font-size:0.68rem; text-transform:uppercase; letter-spacing:0.06em;',
        '  color:#f8c982; font-weight:700; }',
        '.now-answer-card-prompt { font-size:0.78rem; color:#e2e8f0; line-height:1.4; }',
        '.now-answer-card-input-row { display:flex; gap:6px; align-items:center; }',
        '.now-answer-input {',
        '  flex:1; box-sizing:border-box; padding:5px 9px;',
        '  background:rgba(255,255,255,0.05); border:1px solid rgba(248,201,130,0.25);',
        '  border-radius:7px; color:var(--text); font-size:0.78rem; outline:none; }',
        '.now-answer-input:focus { border-color:rgba(248,201,130,0.55); }',
        '.now-answer-input::placeholder { color:var(--muted); }',
        '.now-card-hint { font-size:0.68rem; color:#f8c982; }',
        '.now-card-hint.error { color:#fda4af; }',
        '.now-card-settled { font-size:0.72rem; color:#7ee2a8; }',
        '.now-card-settled.warn { color:var(--muted); }',
        '.now-card-timeout { font-size:0.72rem; color:var(--muted); font-style:italic; }',
        /* ── workflow rail ── */
        '.now-section-label { font-size:0.64rem; text-transform:uppercase; letter-spacing:0.07em;',
        '  color:var(--muted); margin-bottom:6px; }',
        '.now-rail { display:flex; flex-direction:column; gap:5px; width:100%; }',
        '.now-wf-row {',
        '  display:flex; align-items:center; gap:8px;',
        '  background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05);',
        '  border-radius:8px; padding:6px 10px; }',
        '.now-status-dot {',
        '  width:7px; height:7px; border-radius:50%; flex-shrink:0; }',
        '.now-status-dot.success { background:#7ee2a8; }',
        '.now-status-dot.failed  { background:#f08c8c; }',
        '.now-status-dot.running { background:var(--accent); }',
        '.now-status-dot.waiting { background:#f8c982; }',
        '.now-status-dot.queued  { background:var(--muted); }',
        '.now-status-dot.cancelled { background:var(--muted); }',
        '.now-wf-name { flex:1; font-size:0.78rem; color:var(--text);',
        '  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
        '.now-wf-badge { font-size:0.60rem; text-transform:uppercase; letter-spacing:0.05em;',
        '  border-radius:999px; padding:2px 7px; border:1px solid transparent; flex-shrink:0; }',
        '.now-wf-badge.scheduled { color:#94a3b8; background:rgba(255,255,255,0.04); border-color:rgba(255,255,255,0.08); }',
        '.now-wf-badge.on-demand { color:#bae6fd; background:rgba(186,230,253,0.06); border-color:rgba(186,230,253,0.15); }',
        '.now-wf-status-label { font-size:0.68rem; flex-shrink:0; }',
        '.now-wf-status-label.success  { color:#7ee2a8; }',
        '.now-wf-status-label.failed   { color:#f08c8c; }',
        '.now-wf-status-label.running  { color:var(--accent); }',
        '.now-wf-status-label.waiting  { color:#f8c982; }',
        '.now-wf-status-label.queued   { color:var(--muted); }',
        '.now-wf-status-label.cancelled{ color:var(--muted); }',
        '.now-empty { font-size:0.78rem; color:var(--muted); font-style:italic; }',
      ].join('\n');
      document.head.appendChild(style);

      // ── State ──────────────────────────────────────────────────────────────
      var workflows = [];      // WorkflowGalleryItem[]
      var wsClient = null;
      // pending requests: Map-like object keyed by requestId
      // Each entry: { requestId, runId, jobId, jobName, prompt, timeoutMs,
      //               cardEl, timeoutHandle, settled }
      var pendingCards = {};   // requestId → card state

      // ── DOM ────────────────────────────────────────────────────────────────
      var cardsEl = document.createElement('div');
      cardsEl.id = 'now-cards';
      cardsEl.className = 'now-cards';
      el.appendChild(cardsEl);

      var sectionLabel = document.createElement('div');
      sectionLabel.className = 'now-section-label';
      sectionLabel.textContent = 'Running work';
      el.appendChild(sectionLabel);

      var railEl = document.createElement('div');
      railEl.id = 'now-rail';
      railEl.className = 'now-rail';
      el.appendChild(railEl);

      // ── Helpers ────────────────────────────────────────────────────────────
      function normalizeStatus(raw) {
        var s = String(raw || '').toLowerCase();
        if (s === 'success' || s === 'ok' || s === 'completed') return 'success';
        if (s === 'running' || s === 'started') return 'running';
        if (s === 'waiting') return 'waiting';
        if (s === 'failed' || s === 'error') return 'failed';
        if (s === 'queued') return 'queued';
        if (s === 'cancelled' || s === 'canceled') return 'cancelled';
        return 'queued';
      }

      function statusLabel(norm) {
        if (norm === 'success') return 'ok';
        if (norm === 'failed') return 'failed';
        if (norm === 'running') return 'running';
        if (norm === 'waiting') return 'needs input';
        if (norm === 'queued') return 'queued';
        if (norm === 'cancelled') return 'cancelled';
        return norm;
      }

      function sortWorkflows(list) {
        // waiting first, then running, then the rest by recency (lastRun desc, then createdAt desc)
        return list.slice().sort(function (a, b) {
          var aN = normalizeStatus(a.lastStatus);
          var bN = normalizeStatus(b.lastStatus);
          var rank = { waiting: 0, running: 1 };
          var ar = rank[aN] !== undefined ? rank[aN] : 2;
          var br = rank[bN] !== undefined ? rank[bN] : 2;
          if (ar !== br) return ar - br;
          // same tier: sort by recency
          var aT = a.lastRun || a.createdAt || 0;
          var bT = b.lastRun || b.createdAt || 0;
          return bT - aT;
        });
      }

      // ── Workflow rail render ───────────────────────────────────────────────
      function renderRail() {
        if (workflows.length === 0) {
          var empty = document.createElement('span');
          empty.className = 'now-empty';
          empty.textContent = 'No workflows yet.';
          railEl.replaceChildren(empty);
          return;
        }

        var sorted = sortWorkflows(workflows);
        var rows = sorted.map(function (wf) {
          var row = document.createElement('div');
          row.className = 'now-wf-row';

          // status dot
          var norm = normalizeStatus(wf.lastStatus);
          var dot = document.createElement('span');
          dot.className = 'now-status-dot ' + norm;
          row.appendChild(dot);

          // name
          var nameEl = document.createElement('span');
          nameEl.className = 'now-wf-name';
          nameEl.textContent = wf.label || wf.id;
          row.appendChild(nameEl);

          // schedule/on-demand badge
          var badge = document.createElement('span');
          badge.className = 'now-wf-badge';
          if (wf.schedule) {
            badge.className += ' scheduled';
            badge.textContent = wf.schedule;
          } else {
            badge.className += ' on-demand';
            badge.textContent = 'on-demand';
          }
          row.appendChild(badge);

          // status label
          var statEl = document.createElement('span');
          statEl.className = 'now-wf-status-label ' + norm;
          statEl.textContent = statusLabel(norm);
          row.appendChild(statEl);

          return row;
        });

        railEl.replaceChildren.apply(railEl, rows);
      }

      // ── Answer card build ─────────────────────────────────────────────────
      function buildCard(req) {
        var card = document.createElement('div');
        card.className = 'now-answer-card';
        card.setAttribute('data-request-id', req.requestId);

        // job name header
        var jobLabel = document.createElement('div');
        jobLabel.className = 'now-answer-card-job';
        jobLabel.textContent = req.jobName;
        card.appendChild(jobLabel);

        // prompt text
        var promptEl = document.createElement('div');
        promptEl.className = 'now-answer-card-prompt';
        promptEl.textContent = req.prompt;
        card.appendChild(promptEl);

        // input row
        var inputRow = document.createElement('div');
        inputRow.className = 'now-answer-card-input-row';

        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'now-answer-input';
        input.placeholder = 'Your answer…';
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('spellcheck', 'false');

        var answerBtn = document.createElement('button');
        answerBtn.type = 'button';
        answerBtn.className = 'panel-btn primary';
        answerBtn.textContent = 'Answer';

        var dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'panel-btn';
        dismissBtn.textContent = 'Dismiss';

        inputRow.appendChild(input);
        inputRow.appendChild(answerBtn);
        inputRow.appendChild(dismissBtn);
        card.appendChild(inputRow);

        // hint / status line
        var hintEl = document.createElement('div');
        hintEl.className = 'now-card-hint';
        hintEl.hidden = true;
        card.appendChild(hintEl);

        // ── Answer button handler ──────────────────────────────────────────
        answerBtn.addEventListener('click', function () {
          var val = input.value.trim();
          if (!val) {
            hintEl.textContent = 'Please type an answer before submitting.';
            hintEl.className = 'now-card-hint error';
            hintEl.hidden = false;
            return;
          }
          // Clear hint
          hintEl.hidden = true;
          // Disable controls while in-flight
          input.disabled = true;
          answerBtn.disabled = true;
          dismissBtn.disabled = true;
          // Send frame
          if (wsClient) {
            wsClient.send({ type: 'job-input-result', requestId: req.requestId, answer: val });
          }
          // Wipe the input value (clear after send — per spec)
          input.value = '';
        });

        // ── Dismiss button handler ─────────────────────────────────────────
        dismissBtn.addEventListener('click', function () {
          if (wsClient) {
            wsClient.send({ type: 'job-input-result', requestId: req.requestId, cancelled: true });
          }
          removeCard(req.requestId, null);
        });

        return { card: card, input: input, hintEl: hintEl };
      }

      // ── Card lifecycle ────────────────────────────────────────────────────
      function addCard(req) {
        if (pendingCards[req.requestId]) return; // already present

        var built = buildCard(req);
        var card = built.card;

        // Schedule timeout auto-removal
        var handle = null;
        if (req.timeoutMs && req.timeoutMs > 0) {
          handle = setTimeout(function () {
            expireCard(req.requestId);
          }, req.timeoutMs);
        }

        pendingCards[req.requestId] = {
          requestId: req.requestId,
          cardEl: card,
          timeoutHandle: handle,
          hintEl: built.hintEl,
          input: built.input,
          settled: false,
        };

        // Newest on top: prepend
        if (cardsEl.firstChild) {
          cardsEl.insertBefore(card, cardsEl.firstChild);
        } else {
          cardsEl.appendChild(card);
        }
      }

      function removeCard(requestId, message) {
        var state = pendingCards[requestId];
        if (!state) return;
        if (state.timeoutHandle !== null) clearTimeout(state.timeoutHandle);
        delete pendingCards[requestId];
        if (state.cardEl && state.cardEl.parentNode) {
          state.cardEl.parentNode.removeChild(state.cardEl);
        }
      }

      function settleCard(requestId, ok, message) {
        var state = pendingCards[requestId];
        if (!state) return;
        if (state.settled) return;
        state.settled = true;
        if (state.timeoutHandle !== null) clearTimeout(state.timeoutHandle);

        // Replace card content with settled feedback, then remove after delay
        var card = state.cardEl;
        // Clear the card children and show settled message
        var msg = document.createElement('div');
        if (ok) {
          msg.className = 'now-card-settled';
          msg.textContent = 'answered ✓';
        } else {
          msg.className = 'now-card-settled warn';
          msg.textContent = message || 'already answered';
        }
        // Remove input row etc. — just show the message
        while (card.firstChild) card.removeChild(card.firstChild);
        card.appendChild(msg);

        // Remove after brief delay (~2s)
        var handle = setTimeout(function () {
          if (card.parentNode) card.parentNode.removeChild(card);
          delete pendingCards[requestId];
        }, 2000);
        state.timeoutHandle = handle;
      }

      function expireCard(requestId) {
        var state = pendingCards[requestId];
        if (!state) return;
        if (state.settled) return;
        state.settled = true;
        state.timeoutHandle = null;

        var card = state.cardEl;
        var msg = document.createElement('div');
        msg.className = 'now-card-timeout';
        msg.textContent = 'expired';
        while (card.firstChild) card.removeChild(card.firstChild);
        card.appendChild(msg);

        // Remove after brief delay
        var handle = setTimeout(function () {
          if (card.parentNode) card.parentNode.removeChild(card);
          delete pendingCards[requestId];
        }, 2000);
        state.timeoutHandle = handle;
      }

      // ── Initial rail render (disconnected) ────────────────────────────────
      renderRail();

      // ── WS frame registry ─────────────────────────────────────────────────
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
        // Capability present — wait for workflow-list
      });

      registry.register('workflow-list', function (frame) {
        workflows = Array.isArray(frame.workflows) ? frame.workflows : [];
        renderRail();
        // Note: pending cards are NOT cleared on re-render (spec: card state
        // must survive a workflow-list re-render)
      });

      registry.register('job-input-request', function (frame) {
        addCard({
          requestId: frame.requestId,
          runId: frame.runId,
          jobId: frame.jobId,
          jobName: frame.jobName,
          prompt: frame.prompt,
          timeoutMs: frame.timeoutMs,
        });
      });

      registry.register('job-input-status', function (frame) {
        if (frame.ok) {
          settleCard(frame.requestId, true, null);
        } else {
          // e.g. "already answered" — show message then clear
          settleCard(frame.requestId, false, frame.message);
        }
      });

      // ── Connect ───────────────────────────────────────────────────────────
      wsClient = ctx.connectWs(registry, { autoPong: true });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
