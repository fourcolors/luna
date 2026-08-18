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
        // F3 (opus review): tri-state, mirroring the React port's routesKnown
        // exactly. Starts "unknown" and the select is DISABLED while it is -
        // a change event fired before boot's listRoutes settles must never
        // be guessed at (guarded vs legacy); see the change handler below.
        channelSelect._routesKnown = 'unknown';
        channelSelect.disabled = true;
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
              // Step 1a quarantine (docs/next/routes-and-view-mode-plan.md),
              // INVERTED from the pre-Step-1a C8 behavior this replaces: once
              // client.toml routes are known, the select's value AND options
              // come from them alone - a possibly-stale/divergent
              // activeProfile (moon-connection.json) is no longer appended as
              // a dynamic option, in EITHER arrival order relative to
              // load_profiles. `_routesKnown` is what makes this stick even
              // when load_profiles resolves AFTER this callback (see its
              // guard in the load_profiles handler below).
              //
              // F1 (opus review): do NOT ALSO assign channelSelect.value =
              // result.default here. addOption's `isDefault` flag above
              // already marks the matching <option>.selected = true when
              // one exists; if NO option matches (a dangling default - Gate
              // 0.1 world (c) - or an empty-string default), an explicit
              // .value assignment would BLANK the select (selectedIndex -1,
              // jsdom-verified) instead of falling back to the first option,
              // which is what happens naturally here since nothing was
              // marked .selected in that case.
              channelSelect._routesKnown = 'routes';
              channelSelect._currentChannel = channelSelect.value;
            } else {
              // listRoutes returned nothing useful → confirmed un-migrated
              // (F3: "unknown" → "none", never left dangling).
              channelSelect._routesKnown = 'none';
            }
            channelSelect.disabled = false;
          }).catch(function () {
            // listRoutes rejected → same as "nothing useful": confirmed
            // un-migrated, not left "unknown" forever.
            channelSelect._routesKnown = 'none';
            channelSelect.disabled = false;
          });
        } else {
          // No MoonSession/listRoutes at all (off-Tauri, or an old build) →
          // confirmed un-migrated immediately; nothing async to wait for.
          channelSelect._routesKnown = 'none';
          channelSelect.disabled = false;
        }
        // Always add synchronous fallback so the select is usable immediately.
        addFallback();
        if (!channelSelect._currentChannel) channelSelect._currentChannel = channelSelect.value;
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

      // ── Machine target (jax-box / Custom) — This Mac CUT until jax-box Connected ─

      // Gate: do not offer This Mac → 127.0.0.1 as the path to Connected.
      var THIS_MAC_TARGET_ENABLED = false;
      function portForChannel(channel) {
        return channel === 'dev' ? 5753 : 4753;
      }
      function urlForMachineTarget(target, channel) {
        var port = portForChannel(channel);
        if (target === 'this-mac') {
          if (!THIS_MAC_TARGET_ENABLED) return 'ws://jax-box:' + port + '/ui';
          return 'ws://127.0.0.1:' + port + '/ui';
        }
        return 'ws://jax-box:' + port + '/ui';
      }
      function detectMachineTarget(url) {
        var trimmed = (url || '').trim();
        if (/^wss?:\/\/jax-box(?:\.local)?:\d+\/ui\/?$/i.test(trimmed)) return 'jax-box';
        if (/^wss?:\/\/127\.0\.0\.1:\d+\/ui\/?$/i.test(trimmed)) {
          return THIS_MAC_TARGET_ENABLED ? 'this-mac' : 'custom';
        }
        return 'custom';
      }
      var DEFAULT_WS_URL = urlForMachineTarget('jax-box', 'stable');

      var machineRow = splitRow();
      var machineInfo = document.createElement('div');
      machineInfo.style.cssText = 'display:flex;flex-direction:column;gap:2px;flex:1;';
      machineInfo.appendChild(makeLabel('Machine'));
      machineInfo.appendChild(makeDesc('Which box Moon and luna chat dial — jax-box (remote default) or a custom URL. This Mac (127.0.0.1) is disabled until jax-box Connected is proven.'));
      var machineSelect = makeSelect('machine-target-select');
      var machineOpts = [
        { value: 'jax-box', label: 'jax-box (default)' },
        { value: 'custom', label: 'Custom URL' },
      ];
      if (THIS_MAC_TARGET_ENABLED) {
        machineOpts.splice(1, 0, { value: 'this-mac', label: 'This Mac' });
      }
      machineOpts.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        machineSelect.appendChild(opt);
      });
      machineSelect.value = 'jax-box';
      machineRow.appendChild(machineInfo);
      machineRow.appendChild(machineSelect);
      el.appendChild(machineRow);

      // ── WS URL input ─────────────────────────────────────────────────────

      var urlRow = sectionRow();
      urlRow.appendChild(makeLabel('WebSocket Server URL'));
      urlRow.appendChild(makeDesc('Luna Central server WebSocket address (for the selected channel)'));
      var wsUrlInput = makeTextInput('ws-url-input', 'text', DEFAULT_WS_URL);
      urlRow.appendChild(wsUrlInput);
      el.appendChild(urlRow);

      // ── Auth Token input ─────────────────────────────────────────────────

      var tokenRow = sectionRow();
      tokenRow.appendChild(makeLabel('Auth Token'));
      tokenRow.appendChild(makeDesc('Optional authentication bearer token'));
      var wsTokenInput = makeTextInput('ws-token-input', 'password', 'Enter token (optional)...');
      tokenRow.appendChild(wsTokenInput);
      el.appendChild(tokenRow);

      // ── Activate-on-save (mirrors luna pair --activate) ──────────────────

      var activateRow = splitRow();
      var activateInfo = document.createElement('div');
      activateInfo.style.cssText = 'display:flex;flex-direction:column;gap:2px;flex:1;';
      activateInfo.appendChild(makeLabel('Activate this channel'));
      activateInfo.appendChild(makeDesc('Also switch Moon\'s active channel (same as luna pair --activate). Leave off to update creds without hijacking the other channel.'));
      var activateCheckbox = document.createElement('input');
      activateCheckbox.type = 'checkbox';
      activateCheckbox.id = 'activate-on-save';
      activateCheckbox.setAttribute('data-testid', 'activate-on-save');
      activateCheckbox.checked = false;
      activateRow.appendChild(activateInfo);
      activateRow.appendChild(activateCheckbox);
      el.appendChild(activateRow);

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
      wizardInfo.appendChild(makeDesc('First-run only — install Luna on this Mac, on a server, or point at one already running'));
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
        if (typeof conn.wsUrl === 'string' && conn.wsUrl) {
          wsUrlInput.value = conn.wsUrl;
          machineSelect.value = detectMachineTarget(conn.wsUrl);
        }
        if (typeof conn.wsToken === 'string') wsTokenInput.value = conn.wsToken;
      }).catch(function () { /* off-Tauri — inputs stay empty */ });

      ctx.invoke('load_profiles').then(function (prof) {
        if (prof && typeof prof.activeProfile === 'string' && prof.activeProfile) {
          var active = prof.activeProfile;
          // Stash regardless - some callers may still want the pointer -
          // but see the routesKnown guard immediately below.
          channelSelect._activeProfile = active;
          if (channelSelect._routesKnown === 'routes') {
            // Step 1a quarantine: routes are already CONFIRMED and own the
            // select entirely - do not reappend an option or move the
            // value for a possibly-stale/divergent activeProfile.
            return;
          }
          // _routesKnown is "unknown" or "none": legacy behavior. Applying
          // it while still "unknown" is safe even for a migrated user -
          // if listRoutes later confirms "routes", that callback REBUILDS
          // the select from scratch and overwrites whatever this appended.
          var hasOpt = Array.from(channelSelect.options).some(function (o) { return o.value === active; });
          if (!hasOpt) {
            var opt = document.createElement('option');
            opt.value = active;
            opt.textContent = active.charAt(0).toUpperCase() + active.slice(1);
            channelSelect.appendChild(opt);
          }
          channelSelect.value = active;
          channelSelect._currentChannel = active;
        }
      }).catch(function () { /* off-Tauri — keep default */ });

      // ── Event handlers ───────────────────────────────────────────────────

      // F4 (opus review): a closure-scoped counter, live for the lifetime of
      // this panel instance - the same role useRef plays in the React port.
      // Bumped once per change-handler invocation; every checkpoint after an
      // await re-reads it and abandons silently (no write, no DOM update)
      // the instant it no longer matches what that invocation bumped it to.
      var switchGen = 0;

      // Step 1a (docs/next/routes-and-view-mode-plan.md): once client.toml
      // routes are CONFIRMED (_routesKnown === 'routes'), the switch becomes
      // a GUARDED dual write instead of a bare set_active_profile call.
      // '_routesKnown' === 'unknown' (still discovering, F3) is refused
      // outright; only 'none' (confirmed un-migrated) takes the legacy path.
      //
      // F2 pins two DIFFERENT honest outcomes for a refusal:
      //   (a) UNPAIRED (guard 2 finds no resolvable token): selection STAYS
      //       on the target - the pairing UX, paste a token and Save (which
      //       always targets the selected channel - see the save handler
      //       below), then retry - but the URL/token fields update to the
      //       TARGET route's real endpoint and an empty token.
      //   (b) EVERY OTHER refusal: the select REVERTS to `previous` - the
      //       switch did not happen, so the UI must not keep claiming it did.
      channelSelect.addEventListener('change', async function () {
        var next = channelSelect.value;
        var previous = channelSelect._currentChannel || next;
        setChannelError(null);
        var myGen = ++switchGen;
        function superseded() { return myGen !== switchGen; }

        if (channelSelect._routesKnown === 'unknown') {
          // F3 defense in depth: the select is disabled while 'unknown' (see
          // populateChannelSelect above), so a real user cannot reach this -
          // only a programmatic driver (a race, or a test) can. Refuse and
          // revert exactly like any other non-pairing refusal (F2b) rather
          // than guessing which branch (guarded vs legacy) applies.
          channelSelect.value = previous;
          setChannelError('Couldn\'t switch to "' + next + '": still discovering routes');
          return;
        }

        if (channelSelect._routesKnown === 'none') {
          // Un-migrated world (b): byte-compatible with pre-Step-1a behavior
          // - no generation guard, no disabling. A single un-guarded write
          // cannot leave the two stores half-moved the way the guarded dual
          // write can, so F4's race has nothing to protect here.
          try {
            var legacyCreds = await ctx.invoke('set_active_profile', { name: next });
            setChannelError(null);
            if (legacyCreds) {
              wsUrlInput.value = (legacyCreds.wsUrl) ? legacyCreds.wsUrl : '';
              wsTokenInput.value = (typeof legacyCreds.wsToken === 'string') ? legacyCreds.wsToken : '';
              machineSelect.value = detectMachineTarget(wsUrlInput.value);
            }
            channelSelect._currentChannel = next;
            ctx.invoke('hub_event', { name: 'profile-changed' }).catch(function () {});
          } catch (e) {
            var legacyReason = (e && e.message) ? e.message : String(e);
            setChannelError('Couldn\'t switch to "' + next + '": ' + legacyReason);
          }
          return;
        }

        // _routesKnown === 'routes' from here on: the guarded dual write.
        // Lock BOTH controls for the flight: the select against concurrent
        // switches (F4), and Save against the narrow race where a mid-switch
        // save would write profile = the optimistically-selected target while
        // the fields still hold the previous route's creds (review residual).
        var saveButton = document.getElementById('save-connection-btn');
        var setSwitchLock = function (on) {
          channelSelect.disabled = on;
          if (saveButton) saveButton.disabled = on;
        };
        setSwitchLock(true);

        // GUARD 1: target must be a route key. Defense in depth, not the
        // primary gate - once routes are known the select is rebuilt to hold
        // EXACTLY the route keys, so a non-route-key value can only reach
        // here via stale DOM state or a race, never normal use.
        var isKnownRoute = Array.from(channelSelect.options).some(function (o) { return o.value === next; });
        if (!isKnownRoute) {
          channelSelect.value = previous;
          setChannelError('Couldn\'t switch to "' + next + '": not a known route');
          setSwitchLock(false);
          return;
        }

        // GUARD 2: the route's token must be resolvable before committing to
        // it. Resolution now lives in ONE place: connection.rs's
        // resolve_route_token (Step 1b, docs/next/routes-and-view-mode-plan.md)
        // - no more mirroring connection.rs's sentinel logic on the
        // frontend. load_route is still needed here for `endpoints[0]`,
        // which the pairing prompt (F2a) shows.
        var route;
        try {
          route = await ctx.invoke('load_route', { routeKey: next });
        } catch (e) {
          if (superseded()) return;
          var loadReason = (e && e.message) ? e.message : String(e);
          channelSelect.value = previous;
          setChannelError('Couldn\'t switch to "' + next + '": ' + loadReason);
          setSwitchLock(false);
          return;
        }
        if (superseded()) return;

        var routeEndpoint = (route && Array.isArray(route.endpoints) && typeof route.endpoints[0] === 'string')
          ? route.endpoints[0]
          : '';

        try {
          await ctx.invoke('resolve_route_token', { routeKey: next });
        } catch (e) {
          if (superseded()) return;
          var resolveReason = (e && e.message) ? e.message : String(e);
          if (resolveReason.indexOf('not-paired:') === 0) {
            // F2(a): UNPAIRED refusal. Selection stays on `next`; the fields
            // shown are the TARGET route's real endpoint and an EMPTY
            // token - never the previous channel's creds, which would
            // describe the wrong server under the new channel's name.
            wsUrlInput.value = routeEndpoint;
            wsTokenInput.value = '';
            machineSelect.value = detectMachineTarget(wsUrlInput.value);
            setChannelError('"' + next + '" is not paired yet - paste a token and save to pair it');
            channelSelect._currentChannel = next;
          } else {
            // Every other cause (store-read, route-missing,
            // unresolvable-scheme, route-config-invalid) is a durable
            // refusal a retry from here cannot fix - F2(b): revert.
            channelSelect.value = previous;
            setChannelError('Couldn\'t switch to "' + next + '": ' + resolveReason);
          }
          setSwitchLock(false);
          return;
        }
        if (superseded()) return;

        // ORDER IS LOAD-BEARING (plan Step 1a). One click writes two files
        // through two unlocked commands and cannot be atomic across files, so
        // client.toml's `default` is written LAST: both the URL and the
        // token key off cfg.default (connection.rs), so whichever file is
        // written last is the one that decides, and a failure between the
        // two writes leaves the connect path fully on the OLD route rather
        // than half switched. set_active_profile goes first for
        // un-migrated-world (b) coherence and because it returns the creds
        // this panel displays.
        var switchedCreds;
        try {
          switchedCreds = await ctx.invoke('set_active_profile', { name: next });
        } catch (e) {
          if (superseded()) return;
          var switchReason = (e && e.message) ? e.message : String(e);
          channelSelect.value = previous;
          setChannelError('Couldn\'t switch to "' + next + '": ' + switchReason);
          setSwitchLock(false);
          return;
        }
        if (superseded()) return;

        // MoonSession.setDefaultRoute NEVER rejects - it swallows the Rust
        // error into console.warn and resolves false (moon-session.js) - so
        // the boolean return is the ONLY refusal signal here (plan Step 1a's
        // named trap; a .catch on this call would be dead code).
        var ms = (typeof globalThis !== 'undefined') && globalThis.MoonSession;
        var ok = (ms && typeof ms.setDefaultRoute === 'function') ? await ms.setDefaultRoute(next) : false;
        if (superseded()) return;
        if (!ok) {
          // F2(b): setDefaultRoute resolving false leaves the two stores
          // intentionally half-moved - moon-connection.json's activeProfile
          // already advanced to `next` (set_active_profile above succeeded),
          // but client.toml's default did not. Default is what rules the
          // connect path for a migrated user (connection.rs), so the SELECT
          // reverting to `previous` matches what the socket is actually
          // still doing, even though the activeProfile pointer did move.
          channelSelect.value = previous;
          setChannelError('Couldn\'t switch to "' + next + '": failed to set the default route');
          setSwitchLock(false);
          return;
        }

        setChannelError(null);
        if (switchedCreds) {
          wsUrlInput.value = (switchedCreds.wsUrl) ? switchedCreds.wsUrl : '';
          wsTokenInput.value = (typeof switchedCreds.wsToken === 'string') ? switchedCreds.wsToken : '';
          machineSelect.value = detectMachineTarget(wsUrlInput.value);
        }
        channelSelect._currentChannel = next;
        setSwitchLock(false);
        // hub_event fires only after BOTH writes succeeded.
        ctx.invoke('hub_event', { name: 'profile-changed' }).catch(function () {});
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
        // Visible URL is authoritative (named targets fill the field; typing
        // flips to Custom). Fallback only when empty.
        var url = wsUrlInput.value.trim();
        if (!url) {
          url = machineSelect.value === 'custom'
            ? DEFAULT_WS_URL
            : urlForMachineTarget(machineSelect.value, channelSelect.value);
          wsUrlInput.value = url;
        }
        var token = wsTokenInput.value.trim();
        saveBtn.disabled = true;
        setSaveStatus('Saving…');
        try {
          // Rust param names are `url` and `token` (distinct from file JSON
          // keys wsUrl/wsToken). `profile` always targets the
          // currently-selected channel (plan Step 1a) - without it,
          // save_connection falls back to moon-connection.json's
          // activeProfile (connection.rs), which the Step 1a quarantine no
          // longer keeps in sync with the selector, so a token typed while
          // viewing an unpaired route would silently land under the WRONG
          // profile.
          //
          // Unified write (same as React): also upserts ~/.luna/.env and
          // client.toml endpoints[0]. `activate` mirrors luna pair --activate.
          await ctx.invoke('save_connection', {
            url: url,
            token: token,
            profile: channelSelect.value,
            activate: !!activateCheckbox.checked,
          });
          setSaveStatus('Saved ✓ — Moon + luna chat will dial this host (reconnect if already connected)', 'ok');
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

      machineSelect.addEventListener('change', function () {
        var target = machineSelect.value;
        if (target === 'this-mac' && !THIS_MAC_TARGET_ENABLED) {
          target = 'jax-box';
          machineSelect.value = 'jax-box';
        }
        if (target === 'custom') return;
        wsUrlInput.value = urlForMachineTarget(target, channelSelect.value);
      });

      wsUrlInput.addEventListener('input', function () {
        // Typing freely flips to Custom so the named target doesn't fight the field.
        machineSelect.value = 'custom';
      });

      wizardBtn.addEventListener('click', function () {
        ctx.invoke('hub_event', { name: 'open-wizard' }).catch(function () {});
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
