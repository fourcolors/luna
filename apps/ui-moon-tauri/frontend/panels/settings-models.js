/**
 * panels/settings-models.js — the Models settings panel (PR 1).
 *
 * Registers into window.LunaPanelTypes; loaded by panel.html's per-type
 * loader or preloaded by the jsdom harness.
 *
 * WS-backed: connects via ctx.connectWs and gates on hello capability
 * `modelRouting`. When the capability is absent (old server) a notice is
 * shown and no settings are exposed.
 *
 * Frame flow:
 *   <- hello                  gate on capabilities.modelRouting
 *   <- model-routing-list     providers + roleBindings from server
 *   <- model-routing-status   ack for a save (ok/message, requestId)
 *   -> model-routing-save     { requestId, providers, roleBindings }
 *
 * SECURITY:
 *   - No credential values ever appear here. `credentialRef` is an opaque
 *     pointer (e.g. "env:ANTHROPIC_API_KEY") — shown as monospace chip only.
 *   - Credential ENTRY uses the existing request_secret flow (agent tool),
 *     not this panel. The panel only stores the opaque ref.
 *   - Server strings render via textContent only — never innerHTML.
 *   - The `monthlyCapUsd` field is stored and displayed but NOT enforced.
 *     The UI labels it "not yet enforced (coming in next update)".
 *
 * Role defaults (v1):
 *   advisor      -> claude-opus-4-8   (most capable)
 *   daily-driver -> claude-sonnet-4-6 (balanced)
 *   wake         -> claude-sonnet-4-6 (cheapest capable)
 *   dream        -> claude-haiku-4-5  (cheapest)
 *
 * OpenAI / Google are present-but-gated provider slots: shown with a
 * "validated when key + gateway present" notice; not selectable for wake/dream.
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  // ── Constants ──────────────────────────────────────────────────────────────
  var ROLES = ['advisor', 'daily-driver', 'wake', 'dream'];
  var ROLE_LABELS = {
    'advisor':      'Advisor (pro-level reasoning)',
    'daily-driver': 'Daily Driver (chat & tasks)',
    'wake':         'Wake (morning brief)',
    'dream':        'Dream (nightly synthesis)',
  };
  var DEFAULT_ROLE_MODEL = {
    'advisor':      'claude-opus-4-8',
    'daily-driver': 'claude-sonnet-4-6',
    'wake':         'claude-sonnet-4-6',
    'dream':        'claude-haiku-4-5',
  };

  var PROVIDERS = [
    { kind: 'anthropic',    label: 'Anthropic',    gated: false },
    { kind: 'openai',       label: 'OpenAI',        gated: true  },
    { kind: 'google',       label: 'Google Gemini', gated: true  },
    { kind: 'ollama-cloud', label: 'Ollama Cloud',  gated: false },
    { kind: 'ollama-local', label: 'Ollama Local',  gated: false },
  ];

  var ANTHROPIC_MODELS = [
    { id: 'claude-opus-4-8',   label: 'Claude Opus 4.8 — most capable' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — balanced' },
    { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5 — fastest' },
  ];

  // Roles that require JSON-capable providers (structuredOutput != "none").
  // OpenAI / Google via gateway have structuredOutput="none" and are NOT
  // offered for these lanes to avoid silent parse failures server-side.
  var JSON_LANES = { 'wake': true, 'dream': true };

  g.LunaPanelTypes['settings.models'] = {
    title: 'Models',

    render: function (el, ctx) {
      // ── State ──────────────────────────────────────────────────────────────
      var serverSupports = false;
      var providers = [];      // ProviderSettingsItem[] from server
      var roleBindings = [];   // RoleBindingItem[] from server
      var reqId = null;        // in-flight model-routing-save requestId
      var wsClient = null;

      // Draft edits (not yet sent): mirrors of providers/roleBindings.
      var draftProviders = {};   // kind -> { enabled, credentialRef, monthlyCapUsd }
      var draftRoleModel = {};   // role -> model string (first preference)

      // ── Inline styles ──────────────────────────────────────────────────────
      var style = document.createElement('style');
      style.textContent = [
        '.mr-section { margin-bottom: 18px; }',
        '.mr-label { font-weight: 600; font-size: 0.82rem; color: var(--text); }',
        '.mr-desc { display: block; font-size: 0.68rem; color: var(--muted); line-height: 1.4; margin-top: 2px; margin-bottom: 8px; }',
        '.mr-notice { font-size: 0.7rem; color: #fbbf24; background: rgba(251,191,36,0.08); border-radius: 6px; padding: 6px 10px; margin-bottom: 10px; }',
        '.mr-card { border: 1px solid rgba(138,180,248,0.12); border-radius: 10px; padding: 10px; margin-bottom: 8px; background: rgba(138,180,248,0.04); }',
        '.mr-card-head { display: flex; align-items: center; gap: 10px; }',
        '.mr-card-name { font-size: 0.8rem; font-weight: 600; color: #f1f5f9; flex: 1; }',
        '.mr-card-gated { font-size: 0.62rem; color: #94a3b8; background: rgba(255,255,255,0.05); border-radius: 4px; padding: 1px 6px; }',
        '.mr-toggle { display: flex; align-items: center; gap: 6px; font-size: 0.72rem; color: var(--text); cursor: pointer; }',
        '.mr-field-row { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }',
        '.mr-field-label { font-size: 0.62rem; color: var(--muted); font-weight: 500; }',
        '.mr-input { background: rgba(138,180,248,0.05); border: 1px solid rgba(138,180,248,0.18); border-radius: 6px; padding: 5px 8px; color: var(--text); font-size: 0.75rem; width: 100%; box-sizing: border-box; font-family: inherit; outline: none; }',
        '.mr-input::placeholder { color: var(--muted); }',
        '.mr-ref { font-family: ui-monospace,SFMono-Regular,monospace; font-size: 0.62rem; color: #93b4f8; background: rgba(138,180,248,0.08); border-radius: 4px; padding: 1px 5px; }',
        '.mr-cap-note { font-size: 0.62rem; color: #fbbf24; }',
        '.mr-role-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }',
        '.mr-role-label { font-size: 0.78rem; font-weight: 600; color: #cbd8f0; flex: 1; min-width: 0; }',
        '.mr-role-sub { font-size: 0.62rem; color: var(--muted); }',
        'select.mr-select { background: rgba(138,180,248,0.05); border: 1px solid rgba(138,180,248,0.18); border-radius: 6px; padding: 4px 8px; color: var(--text); font-size: 0.75rem; cursor: pointer; }',
        '.mr-save-row { display: flex; align-items: center; gap: 10px; margin-top: 14px; }',
        '.mr-status { font-size: 0.75rem; }',
        '.mr-blot { width: 22px; height: 22px; flex-shrink: 0; border-radius: 47% 53% 51% 49%/52% 46% 54% 48%; background: radial-gradient(circle closest-side,rgba(150,188,250,0.30) 0%,rgba(138,180,248,0.45) 45%,rgba(104,146,232,0.70) 78%,rgba(96,138,226,0.25) 94%,rgba(96,138,226,0) 100%); box-shadow: 0 0 10px rgba(138,180,248,0.35); }',
      ].join('\n');
      document.head.appendChild(style);

      // ── DOM skeleton ───────────────────────────────────────────────────────
      var mainEl = document.createElement('div');
      mainEl.id = 'mr-main';
      el.appendChild(mainEl);

      // ── Helpers ────────────────────────────────────────────────────────────
      function span(cls, text) {
        var s = document.createElement('span');
        if (cls) s.className = cls;
        if (text) s.textContent = text;
        return s;
      }

      function button(cls, text) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.textContent = text;
        return b;
      }

      function input(type, placeholder) {
        var i = document.createElement('input');
        i.type = type;
        i.className = 'mr-input';
        if (placeholder) i.placeholder = placeholder;
        i.setAttribute('autocomplete', 'off');
        return i;
      }

      function socketOpen() {
        var sock = wsClient && wsClient.socket();
        var OPEN = (g.WebSocket && g.WebSocket.OPEN) !== undefined ? g.WebSocket.OPEN : 1;
        return !!(sock && sock.readyState === OPEN);
      }

      function newReqId(prefix) {
        return prefix + ((g.crypto && g.crypto.randomUUID)
          ? g.crypto.randomUUID().replace(/-/g, '')
          : Math.random().toString(36).slice(2));
      }

      // Initialize draft state from received server data.
      function applyServerState(pList, bList) {
        providers = Array.isArray(pList) ? pList : [];
        roleBindings = Array.isArray(bList) ? bList : [];

        // Populate draft from server state (fill-if-empty guard for mid-edit).
        draftProviders = {};
        providers.forEach(function (p) {
          draftProviders[p.kind] = {
            enabled: !!p.enabled,
            credentialRef: p.credentialRef || '',
            monthlyCapUsd: typeof p.monthlyCapUsd === 'number' ? p.monthlyCapUsd : '',
          };
        });

        // Fill missing provider drafts with disabled defaults.
        PROVIDERS.forEach(function (pd) {
          if (!draftProviders[pd.kind]) {
            draftProviders[pd.kind] = { enabled: false, credentialRef: '', monthlyCapUsd: '' };
          }
        });

        draftRoleModel = {};
        roleBindings.forEach(function (rb) {
          var first = rb.preferenceList && rb.preferenceList[0];
          if (first && first.model) {
            draftRoleModel[rb.role] = first.model;
          }
        });
        ROLES.forEach(function (r) {
          if (!draftRoleModel[r]) {
            draftRoleModel[r] = DEFAULT_ROLE_MODEL[r] || 'claude-sonnet-4-6';
          }
        });
      }

      // Derive provider kind for a model string (simple prefix rules).
      function providerForModel(model) {
        if (/^claude/i.test(model) || /^anthropic/i.test(model)) return 'anthropic';
        if (/^gemini/i.test(model)) return 'google';
        if (/^gpt/i.test(model) || /^o[0-9]/i.test(model)) return 'openai';
        if (/:cloud$/i.test(model)) return 'ollama-cloud';
        if (/^local\//i.test(model)) return 'ollama-local';
        return 'anthropic';
      }

      // Build the payload to send.
      function buildPayload() {
        var payProviders = PROVIDERS.map(function (pd) {
          var d = draftProviders[pd.kind] || { enabled: false };
          var p = { kind: pd.kind, enabled: !!d.enabled };
          if (d.credentialRef && d.credentialRef.trim()) p.credentialRef = d.credentialRef.trim();
          if (typeof d.monthlyCapUsd === 'number' && d.monthlyCapUsd > 0) p.monthlyCapUsd = d.monthlyCapUsd;
          return p;
        });
        var payBindings = ROLES.map(function (r) {
          var model = draftRoleModel[r] || DEFAULT_ROLE_MODEL[r];
          var provider = providerForModel(model);
          return {
            role: r,
            preferenceList: [{ provider: provider, model: model }],
          };
        });
        return { providers: payProviders, roleBindings: payBindings };
      }

      // ── Render ─────────────────────────────────────────────────────────────
      var statusEl = null;

      function setStatus(msg, kind) {
        if (!statusEl) return;
        statusEl.textContent = msg || '';
        statusEl.hidden = !msg;
        statusEl.style.color = kind === 'error' ? '#f87171'
          : kind === 'ok' ? '#4ade80'
          : '#94a3b8';
      }

      function render() {
        mainEl.replaceChildren();

        if (!serverSupports) {
          var notice = document.createElement('div');
          notice.className = 'notice';
          notice.textContent = 'This server does not support model-routing settings.';
          mainEl.appendChild(notice);
          return;
        }

        // ── Providers section ────────────────────────────────────────────────
        var provSec = document.createElement('div');
        provSec.className = 'mr-section';
        provSec.appendChild(span('mr-label', 'Providers'));
        provSec.appendChild(span('mr-desc',
          'Enable providers and optionally set a monthly spend ceiling. ' +
          'Credential entry uses the Luna Vault or the agent\'s request_secret flow.'));

        PROVIDERS.forEach(function (pd) {
          var draft = draftProviders[pd.kind] || { enabled: false };
          var card = document.createElement('div');
          card.className = 'mr-card';

          var head = document.createElement('div');
          head.className = 'mr-card-head';

          var blot = document.createElement('div');
          blot.className = 'mr-blot';
          if (!draft.enabled) {
            blot.style.opacity = '0.3';
            blot.style.filter = 'grayscale(0.8)';
            blot.style.boxShadow = 'none';
          }

          var nameEl = span('mr-card-name', pd.label);

          head.appendChild(blot);
          head.appendChild(nameEl);

          if (pd.gated) {
            head.appendChild(span('mr-card-gated', 'needs gateway'));
          }

          // Enable toggle
          var toggleLabel = document.createElement('label');
          toggleLabel.className = 'mr-toggle';
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !!draft.enabled;
          (function (kind) {
            cb.addEventListener('change', function () {
              if (!draftProviders[kind]) draftProviders[kind] = {};
              draftProviders[kind].enabled = cb.checked;
              render();
            });
          })(pd.kind);
          toggleLabel.appendChild(cb);
          toggleLabel.appendChild(document.createTextNode(draft.enabled ? 'Enabled' : 'Disabled'));
          head.appendChild(toggleLabel);
          card.appendChild(head);

          if (draft.enabled) {
            // Credential ref (opaque pointer — never the raw value)
            var refRow = document.createElement('div');
            refRow.className = 'mr-field-row';
            refRow.appendChild(span('mr-field-label', 'Credential ref (e.g. env:ANTHROPIC_API_KEY)'));
            var refInput = input('text', 'env:MY_API_KEY or luna-op://label/item');
            refInput.value = draft.credentialRef || '';
            (function (kind) {
              refInput.addEventListener('input', function () {
                if (!draftProviders[kind]) draftProviders[kind] = {};
                draftProviders[kind].credentialRef = refInput.value;
              });
            })(pd.kind);
            refRow.appendChild(refInput);
            card.appendChild(refRow);

            // Monthly cap (stored but NOT enforced)
            var capRow = document.createElement('div');
            capRow.className = 'mr-field-row';
            var capLabelEl = document.createElement('div');
            capLabelEl.style.cssText = 'display:flex;align-items:center;gap:6px;';
            capLabelEl.appendChild(span('mr-field-label', 'Monthly cap (USD)'));
            capLabelEl.appendChild(span('mr-cap-note', 'not yet enforced (coming in next update)'));
            capRow.appendChild(capLabelEl);
            var capInput = input('number', '50');
            capInput.min = '0';
            capInput.step = '1';
            capInput.value = draft.monthlyCapUsd !== '' ? String(draft.monthlyCapUsd) : '';
            (function (kind) {
              capInput.addEventListener('input', function () {
                if (!draftProviders[kind]) draftProviders[kind] = {};
                var v = parseFloat(capInput.value);
                draftProviders[kind].monthlyCapUsd = isNaN(v) ? '' : v;
              });
            })(pd.kind);
            capRow.appendChild(capInput);
            card.appendChild(capRow);

            if (pd.gated) {
              var gatNote = document.createElement('div');
              gatNote.className = 'mr-notice';
              gatNote.style.cssText = 'margin-top:8px;margin-bottom:0;';
              gatNote.textContent = pd.label + ' routes via LiteLLM gateway. Set LUNA_LLM_GATEWAY_URL and configure the provider there.';
              card.appendChild(gatNote);
            }
          }

          provSec.appendChild(card);
        });
        mainEl.appendChild(provSec);

        // ── Role bindings section ─────────────────────────────────────────────
        var roleSec = document.createElement('div');
        roleSec.className = 'mr-section';
        roleSec.appendChild(span('mr-label', 'Role Model Assignments'));
        roleSec.appendChild(span('mr-desc',
          'Choose which model Luna uses for each role. Changes take effect after the server restarts.'));

        ROLES.forEach(function (role) {
          var row = document.createElement('div');
          row.className = 'mr-role-row';

          var info = document.createElement('div');
          info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;';
          info.appendChild(span('mr-role-label', ROLE_LABELS[role] || role));
          info.appendChild(span('mr-role-sub', 'current: ' + (draftRoleModel[role] || DEFAULT_ROLE_MODEL[role])));
          row.appendChild(info);

          // Model select
          var select = document.createElement('select');
          select.className = 'mr-select';

          // Anthropic models always available
          ANTHROPIC_MODELS.forEach(function (m) {
            var opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.label;
            opt.selected = draftRoleModel[role] === m.id;
            select.appendChild(opt);
          });

          // Ollama local option
          if (draftProviders['ollama-local'] && draftProviders['ollama-local'].enabled) {
            var olOpt = document.createElement('option');
            olOpt.value = 'local/qwen3:4b';
            olOpt.textContent = 'Ollama Local (e.g. local/qwen3:4b)';
            olOpt.selected = /^local\//i.test(draftRoleModel[role] || '');
            select.appendChild(olOpt);
          }

          // Ollama cloud option
          if (draftProviders['ollama-cloud'] && draftProviders['ollama-cloud'].enabled) {
            var ocOpt = document.createElement('option');
            ocOpt.value = 'qwen3:4b:cloud';
            ocOpt.textContent = 'Ollama Cloud (e.g. qwen3:4b:cloud)';
            ocOpt.selected = /:cloud$/i.test(draftRoleModel[role] || '');
            select.appendChild(ocOpt);
          }

          (function (r) {
            select.addEventListener('change', function () {
              draftRoleModel[r] = select.value;
              render();
            });
          })(role);

          row.appendChild(select);
          roleSec.appendChild(row);
        });
        mainEl.appendChild(roleSec);

        // ── Save ──────────────────────────────────────────────────────────────
        var saveRow = document.createElement('div');
        saveRow.className = 'mr-save-row';
        var saveBtn = button('panel-btn', 'Save & Restart');
        saveBtn.addEventListener('click', submitSave);
        saveRow.appendChild(saveBtn);
        statusEl = span('mr-status mr-desc', '');
        statusEl.hidden = true;
        saveRow.appendChild(statusEl);
        mainEl.appendChild(saveRow);

        var restartNote = span('mr-desc',
          'Saving applies model-routing preferences on the next server restart (a brief pause — connections auto-reconnect).');
        mainEl.appendChild(restartNote);
      }

      // ── Save handler ──────────────────────────────────────────────────────
      function submitSave() {
        if (!serverSupports) {
          setStatus('This server does not support model-routing settings.', 'error');
          return;
        }
        if (!socketOpen()) {
          setStatus('Not connected to a server.', 'error');
          return;
        }

        var payload = buildPayload();
        var rid = newReqId('mr_');
        reqId = rid;

        var ok = wsClient.send({
          type: 'model-routing-save',
          requestId: rid,
          providers: payload.providers,
          roleBindings: payload.roleBindings,
        });
        if (!ok) {
          reqId = null;
          setStatus('Not connected to a server.', 'error');
          return;
        }
        setStatus('Saving…', 'info');
      }

      // ── Initial paint ──────────────────────────────────────────────────────
      render();

      // ── WS frame registry ─────────────────────────────────────────────────
      var registry = g.LunaWS.createFrameRegistry();

      registry.register('hello', function (frame) {
        var caps = g.LunaProtocol.parseHelloCapabilities(frame);
        serverSupports = !!caps.modelRouting;
        if (!serverSupports) {
          mainEl.replaceChildren();
          var notice = document.createElement('div');
          notice.className = 'notice';
          notice.textContent = 'This server does not support model-routing settings.';
          mainEl.appendChild(notice);
        }
      });

      registry.register('model-routing-list', function (frame) {
        applyServerState(frame.providers, frame.roleBindings);
        render();
      });

      registry.register('model-routing-status', function (frame) {
        if (!frame || frame.requestId !== reqId) return;
        reqId = null;
        setStatus(
          frame.ok ? (frame.message || 'Saved. Server restarting…')
                   : (frame.message || 'Could not save settings.'),
          frame.ok ? 'ok' : 'error');
      });

      // ── Connect ───────────────────────────────────────────────────────────
      wsClient = ctx.connectWs(registry, { autoPong: true });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
