/**
 * panels/settings-connection.js — the Connection settings panel.
 * Registers into window.LunaPanelTypes; loaded by panel.html's per-type
 * loader (or preloaded by the jsdom harness).
 *
 * Controls:
 *  - Channel select (stable/dev): load_profiles → set_active_profile + hub_event
 *  - Model select: populated from localStorage luna_available_models; persists luna_model
 *  - WS URL + Auth Token + Save: load_connection on render, save_connection on save + hub_event
 *  - Open setup wizard button: hub_event open-wizard
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  g.LunaPanelTypes['settings.connection'] = {
    title: 'Connection',
    render: function (el, ctx) {

      // ── helpers ─────────────────────────────────────────────────────────

      function makeLabel(text) {
        var span = document.createElement('span');
        span.textContent = text;
        span.style.cssText = 'font-size:0.78rem;font-weight:600;color:var(--text);';
        return span;
      }

      function makeDesc(text) {
        var span = document.createElement('span');
        span.textContent = text;
        span.style.cssText = 'font-size:0.72rem;color:var(--muted);margin-bottom:6px;display:block;';
        return span;
      }

      function makeSelect(id) {
        var sel = document.createElement('select');
        sel.id = id;
        sel.style.cssText = [
          'background:rgba(138,180,248,0.08)',
          'border:1px solid var(--border)',
          'border-radius:6px',
          'color:var(--text)',
          'font-size:0.8rem',
          'padding:4px 8px',
          'cursor:pointer',
        ].join(';');
        return sel;
      }

      function makeTextInput(id, type, placeholder) {
        var inp = document.createElement('input');
        inp.type = type;
        inp.id = id;
        inp.placeholder = placeholder;
        inp.style.cssText = [
          'width:100%',
          'background:rgba(255,255,255,0.05)',
          'border:1px solid var(--border)',
          'border-radius:6px',
          'color:var(--text)',
          'font-size:0.8rem',
          'padding:5px 9px',
        ].join(';');
        return inp;
      }

      function sectionRow() {
        var row = document.createElement('div');
        row.className = 'panel-row';
        row.style.cssText = 'flex-direction:column;align-items:flex-start;gap:4px;';
        return row;
      }

      function splitRow() {
        var row = document.createElement('div');
        row.className = 'panel-row';
        row.style.cssText = 'justify-content:space-between;';
        return row;
      }

      // ── Channel select ───────────────────────────────────────────────────

      var channelRow = splitRow();
      var channelInfo = document.createElement('div');
      channelInfo.style.cssText = 'display:flex;flex-direction:column;gap:2px;flex:1;';
      channelInfo.appendChild(makeLabel('Channel'));
      channelInfo.appendChild(makeDesc('Switch this moon between the stable and dev servers'));

      var channelError = document.createElement('span');
      channelError.id = 'channel-error';
      channelError.className = 'panel-status warn';
      channelError.setAttribute('role', 'alert');
      channelError.hidden = true;
      channelInfo.appendChild(channelError);

      var channelSelect = makeSelect('channel-select');
      // C8: enumerate routes from MoonSession.listRoutes() when available;
      // fall back to the hardcoded ['stable','dev'] list for un-migrated users
      // or off-Tauri environments.  The async population runs after render so
      // the select always has at least the fallback options synchronously.
      (function populateChannelSelect() {
        var FALLBACK = ['stable', 'dev'];
        function addOption(key, label, isDefault) {
          var opt = document.createElement('option');
          opt.value = key;
          opt.textContent = label;
          if (isDefault) opt.selected = true;
          channelSelect.appendChild(opt);
        }
        function addFallback() {
          FALLBACK.forEach(function (v) {
            addOption(v, v.charAt(0).toUpperCase() + v.slice(1), false);
          });
        }
        var ms = (typeof globalThis !== 'undefined') && globalThis.MoonSession;
        if (ms && typeof ms.listRoutes === 'function') {
          ms.listRoutes().then(function (result) {
            if (result && Array.isArray(result.routes) && result.routes.length > 0) {
              // Remove any synchronously-added fallback options first (safe DOM removal).
              while (channelSelect.firstChild) channelSelect.removeChild(channelSelect.firstChild);
              result.routes.forEach(function (r) {
                var key   = r.key   || r.name || String(r);
                var label = r.label || key;
                addOption(key, label, key === result.default);
              });
              // Reflect active profile selection after dynamic population.
              // If the active profile is NOT among the route keys (C8: client.toml
              // keys can diverge from profile names), append it as a dynamic option
              // so it is always present and selectable — mirrors the load_profiles
              // hasOpt/append guard below.
              if (channelSelect._activeProfile) {
                var activeKey = channelSelect._activeProfile;
                var hasActive = Array.from(channelSelect.options).some(function (o) {
                  return o.value === activeKey;
                });
                if (!hasActive) {
                  var dynOpt = document.createElement('option');
                  dynOpt.value = activeKey;
                  dynOpt.textContent = activeKey.charAt(0).toUpperCase() + activeKey.slice(1);
                  channelSelect.appendChild(dynOpt);
                }
                channelSelect.value = activeKey;
              }
            } else {
              // listRoutes returned nothing useful → un-migrated; leave fallback.
            }
          }).catch(function () {
            // listRoutes rejected → leave fallback options in place.
          });
        }
        // Always add synchronous fallback so the select is usable immediately.
        addFallback();
      }());

      channelRow.appendChild(channelInfo);
      channelRow.appendChild(channelSelect);
      el.appendChild(channelRow);

      // ── Model select ─────────────────────────────────────────────────────

      var modelRow = splitRow();
      var modelInfo = document.createElement('div');
      modelInfo.style.cssText = 'display:flex;flex-direction:column;gap:2px;flex:1;';
      modelInfo.appendChild(makeLabel('Model'));
      modelInfo.appendChild(makeDesc('Model for new conversations — existing threads keep theirs'));

      var modelSelect = makeSelect('model-select');
      var defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = 'Server default';
      modelSelect.appendChild(defOpt);

      // Populate from locally-cached available models list.
      // Back-compat: old cache = array of id strings; new cache = array of
      // {id, label, efforts} objects (written by applyAvailableModels in chat.html).
      var availableModels = [];
      try {
        var raw = localStorage.getItem('luna_available_models');
        if (raw) availableModels = JSON.parse(raw);
      } catch (_) { /* malformed — ignore */ }
      // Normalize: accept both string and object entries.
      var normalizedModels = [];
      if (Array.isArray(availableModels)) {
        availableModels.forEach(function (entry) {
          if (!entry) return;
          if (typeof entry === 'string' && entry) {
            normalizedModels.push({ id: entry, label: entry, efforts: [] });
          } else if (typeof entry === 'object' && typeof entry.id === 'string' && entry.id) {
            normalizedModels.push({
              id: entry.id,
              label: (typeof entry.label === 'string' && entry.label) ? entry.label : entry.id,
              efforts: Array.isArray(entry.efforts) ? entry.efforts : [],
            });
          }
        });
      }
      normalizedModels.forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label;
        modelSelect.appendChild(opt);
      });
      // Restore persisted selection (keep even if not in list).
      var savedModel = localStorage.getItem('luna_model') || '';
      if (savedModel && !Array.from(modelSelect.options).some(function (o) { return o.value === savedModel; })) {
        var customOpt = document.createElement('option');
        customOpt.value = savedModel;
        customOpt.textContent = savedModel + ' (custom)';
        modelSelect.appendChild(customOpt);
      }
      modelSelect.value = savedModel;

      modelRow.appendChild(modelInfo);
      modelRow.appendChild(modelSelect);
      el.appendChild(modelRow);

      // ── Effort select ─────────────────────────────────────────────────────
      // Only shown when the selected model has efforts in the extended cache.
      // Hidden when legacy cache (no efforts) or no model selected.

      var selectedModelEntry = normalizedModels.find(function (m) { return m.id === savedModel; }) || null;
      var initialEfforts = (selectedModelEntry && selectedModelEntry.efforts) || [];

      var effortRow = splitRow();
      effortRow.id = 'effort-row';
      effortRow.hidden = initialEfforts.length === 0;
      var effortInfo = document.createElement('div');
      effortInfo.style.cssText = 'display:flex;flex-direction:column;gap:2px;flex:1;';
      effortInfo.appendChild(makeLabel('Effort'));
      effortInfo.appendChild(makeDesc('Thinking effort for the selected model'));

      var effortSelect = makeSelect('effort-select');
      var effortDefOpt = document.createElement('option');
      effortDefOpt.value = '';
      effortDefOpt.textContent = 'Default';
      effortSelect.appendChild(effortDefOpt);
      initialEfforts.forEach(function (ef) {
        var opt = document.createElement('option');
        opt.value = ef;
        opt.textContent = ef.charAt(0).toUpperCase() + ef.slice(1);
        effortSelect.appendChild(opt);
      });
      var savedEffort = localStorage.getItem('luna_effort') || '';
      effortSelect.value = savedEffort;

      effortRow.appendChild(effortInfo);
      effortRow.appendChild(effortSelect);
      el.appendChild(effortRow);

      // ── WS URL input ─────────────────────────────────────────────────────

      var urlRow = sectionRow();
      urlRow.appendChild(makeLabel('WebSocket Server URL'));
      urlRow.appendChild(makeDesc('Luna Central server WebSocket address (for the selected channel)'));
      var wsUrlInput = makeTextInput('ws-url-input', 'text', 'ws://127.0.0.1:4753/ui');
      urlRow.appendChild(wsUrlInput);
      el.appendChild(urlRow);

      // ── Auth Token input ─────────────────────────────────────────────────

      var tokenRow = sectionRow();
      tokenRow.appendChild(makeLabel('Auth Token'));
      tokenRow.appendChild(makeDesc('Optional authentication bearer token'));
      var wsTokenInput = makeTextInput('ws-token-input', 'password', 'Enter token (optional)...');
      tokenRow.appendChild(wsTokenInput);
      el.appendChild(tokenRow);

      // ── Save button + status ─────────────────────────────────────────────

      var saveRow = document.createElement('div');
      saveRow.className = 'panel-row';
      var saveBtn = document.createElement('button');
      saveBtn.className = 'panel-btn primary';
      saveBtn.id = 'save-connection-btn';
      saveBtn.textContent = 'Save';
      saveBtn.setAttribute('aria-label', 'Save connection settings');
      var saveStatus = document.createElement('span');
      saveStatus.className = 'panel-status';
      saveStatus.id = 'save-connection-status';
      saveStatus.setAttribute('role', 'status');
      saveRow.appendChild(saveBtn);
      saveRow.appendChild(saveStatus);
      el.appendChild(saveRow);

      // ── Setup wizard button ──────────────────────────────────────────────

      var wizardRow = splitRow();
      var wizardInfo = document.createElement('div');
      wizardInfo.style.cssText = 'display:flex;flex-direction:column;gap:2px;flex:1;';
      wizardInfo.appendChild(makeLabel('Setup wizard'));
      wizardInfo.appendChild(makeDesc('Guided setup — install Luna on this Mac, on a server, or point at one already running'));
      var wizardBtn = document.createElement('button');
      wizardBtn.className = 'panel-btn';
      wizardBtn.id = 'open-wizard-btn';
      wizardBtn.textContent = 'Open';
      wizardBtn.setAttribute('aria-label', 'Open setup wizard');
      wizardRow.appendChild(wizardInfo);
      wizardRow.appendChild(wizardBtn);
      el.appendChild(wizardRow);

      // ── Internal state ───────────────────────────────────────────────────

      function setChannelError(msg) {
        if (!msg) {
          channelError.hidden = true;
          channelError.textContent = '';
        } else {
          channelError.textContent = msg;
          channelError.hidden = false;
        }
      }

      function setSaveStatus(text, cls) {
        saveStatus.textContent = text;
        saveStatus.className = 'panel-status' + (cls ? ' ' + cls : '');
      }

      // ── Load initial values ──────────────────────────────────────────────

      ctx.invoke('load_connection').then(function (conn) {
        if (!conn) return;
        if (typeof conn.wsUrl === 'string' && conn.wsUrl) wsUrlInput.value = conn.wsUrl;
        if (typeof conn.wsToken === 'string') wsTokenInput.value = conn.wsToken;
      }).catch(function () { /* off-Tauri — inputs stay empty */ });

      ctx.invoke('load_profiles').then(function (prof) {
        if (prof && typeof prof.activeProfile === 'string' && prof.activeProfile) {
          var active = prof.activeProfile;
          // Stash for use by the async listRoutes repopulation (C8).
          channelSelect._activeProfile = active;
          // Add dynamic profile option if not already present.
          var hasOpt = Array.from(channelSelect.options).some(function (o) { return o.value === active; });
          if (!hasOpt) {
            var opt = document.createElement('option');
            opt.value = active;
            opt.textContent = active.charAt(0).toUpperCase() + active.slice(1);
            channelSelect.appendChild(opt);
          }
          channelSelect.value = active;
        }
      }).catch(function () { /* off-Tauri — keep default */ });

      // ── Event handlers ───────────────────────────────────────────────────

      channelSelect.addEventListener('change', async function () {
        var next = channelSelect.value;
        setChannelError(null);
        try {
          var creds = await ctx.invoke('set_active_profile', { name: next });
          setChannelError(null);
          // Update url/token inputs with the now-active channel's stored creds.
          if (creds) {
            wsUrlInput.value = (creds.wsUrl) ? creds.wsUrl : '';
            wsTokenInput.value = (typeof creds.wsToken === 'string') ? creds.wsToken : '';
          }
          // Notify hub so it can reconnect its own socket.
          ctx.invoke('hub_event', { name: 'profile-changed' }).catch(function () {});
        } catch (e) {
          var reason = (e && e.message) ? e.message : String(e);
          setChannelError('Couldn\'t switch to "' + next + '": ' + reason);
        }
      });

      modelSelect.addEventListener('change', function () {
        var v = modelSelect.value;
        if (v) {
          localStorage.setItem('luna_model', v);
        } else {
          localStorage.removeItem('luna_model');
        }
        // Update effort select for the newly selected model.
        var entry = normalizedModels.find(function (m) { return m.id === v; }) || null;
        var efforts = (entry && entry.efforts) || [];
        var effortRowEl = document.getElementById('effort-row');
        if (effortRowEl) effortRowEl.hidden = efforts.length === 0;
        // Rebuild effort options.
        while (effortSelect.children.length > 1) effortSelect.removeChild(effortSelect.lastChild);
        efforts.forEach(function (ef) {
          var opt = document.createElement('option');
          opt.value = ef;
          opt.textContent = ef.charAt(0).toUpperCase() + ef.slice(1);
          effortSelect.appendChild(opt);
        });
        // Keep saved effort if still valid, else reset.
        var curEffort = localStorage.getItem('luna_effort') || '';
        if (curEffort && efforts.indexOf(curEffort) === -1) {
          localStorage.removeItem('luna_effort');
          effortSelect.value = '';
        } else {
          effortSelect.value = curEffort;
        }
      });

      effortSelect.addEventListener('change', function () {
        var v = effortSelect.value;
        if (v) {
          localStorage.setItem('luna_effort', v);
        } else {
          localStorage.removeItem('luna_effort');
        }
      });

      saveBtn.addEventListener('click', async function () {
        var url = wsUrlInput.value.trim() || 'ws://127.0.0.1:4753/ui';
        var token = wsTokenInput.value.trim();
        saveBtn.disabled = true;
        setSaveStatus('Saving…');
        try {
          // Rust param names are `url` and `token` (distinct from file JSON keys wsUrl/wsToken).
          await ctx.invoke('save_connection', { url: url, token: token });
          setSaveStatus('Saved ✓', 'ok');
          // Notify hub so it reconnects with the new credentials.
          ctx.invoke('hub_event', { name: 'connection-changed' }).catch(function () {});
          // Engine does NOT wipe the token field after a successful save —
          // the token remains visible so the operator can confirm what was stored.
        } catch (e) {
          setSaveStatus('Save failed: ' + (e && e.message ? e.message : String(e)), 'warn');
        } finally {
          saveBtn.disabled = false;
        }
      });

      wizardBtn.addEventListener('click', function () {
        ctx.invoke('hub_event', { name: 'open-wizard' }).catch(function () {});
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
