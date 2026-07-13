/**
 * panels/settings-connectors.js — the Connectors settings panel (PRD Part A §17).
 *
 * Registers into window.LunaPanelTypes; loaded by panel.html's per-type
 * loader (or preloaded by the jsdom harness).
 *
 * WS-backed: builds a frame registry, connects via ctx.connectWs, gates on
 * the 'connectors' capability from the hello frame.
 *
 * Frame flow:
 *   ← hello           (gate on capabilities.connectors)
 *   ← connector-catalog  (definition list)
 *   ← connector-list     (instance list)
 *   ← connector-status   (ack / error for connect/disconnect)
 *   ← connector-oauth-redirect  (consent URL from server — open browser)
 *   → connector-oauth-begin  { requestId, definitionId, label, capabilityIds, loopbackPort }
 *   → connector-oauth-code   { pendingId, code, state }
 *   → connector-connect      { requestId, definitionId, label, capabilityIds[, secretRef] }
 *   → connector-disconnect   { instanceId }
 *   → connector-set-client   { requestId, definitionId, clientId[, clientSecret] }
 *
 * Tauri commands used:
 *   oauth_loopback_start  → port number
 *   oauth_loopback_wait   { timeoutMs } → { code, state }
 *                         (rejects with the provider's reason on an
 *                          error=… redirect — e.g. access_denied)
 *   oauth_loopback_cancel
 *   open_external_url     { url }
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  g.LunaPanelTypes['settings.connectors'] = {
    title: 'Connectors',

    render: function (el, ctx) {
      // ── State ──────────────────────────────────────────────────────────────
      var catalog = [];       // connector definitions from server
      var instances = [];     // connector instances from server
      var busy = {};          // definitionId → 'authorizing' | 'connecting'
      var consentOpen = null; // definitionId whose consent sheet is expanded
      var clientEditOpen = null; // definitionId whose client-setup edit is open
      var consentDraft = {};  // definitionId → { label, secretRef, caps }
      var reconnectLabel = null; // one-shot label prefill on reconnect
      var plainRequests = {}; // requestId → definitionId for in-flight connector-connect
      var oauthRequestId = null;
      var oauthDefinitionId = null;
      var oauthCodeSent = false; // true only AFTER connector-oauth-code is sent (the completeAuth redemption window)
      var beginTimer = null;

      // ── DOM skeleton ───────────────────────────────────────────────────────
      var errorEl = document.createElement('span');
      errorEl.id = 'connectors-error';
      errorEl.className = 'panel-status warn';
      errorEl.hidden = true;
      el.appendChild(errorEl);

      var listEl = document.createElement('div');
      listEl.id = 'connectors-list';
      el.appendChild(listEl);

      // ── Helpers ────────────────────────────────────────────────────────────
      function setError(msg) {
        errorEl.hidden = !msg;
        errorEl.textContent = msg || '';
      }

      function instanceFor(defId) {
        return instances.find(function (i) { return i.definitionId === defId; }) || null;
      }

      function instancesFor(defId) {
        return instances.filter(function (i) { return i.definitionId === defId; });
      }

      // Client-side mirror of the server's labelSlug (lowercase, non-alnum
      // runs → '_', trimmed) — close enough to preflight the common
      // collision: a second account left on the default label. The server
      // check stays authoritative.
      function labelSlugLite(label) {
        return String(label || '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '');
      }

      function labelTaken(defId, label) {
        var slug = labelSlugLite(label);
        return instances.some(function (i) {
          return i.definitionId === defId && labelSlugLite(i.label) === slug;
        });
      }

      function clearBusy(defId) {
        if (defId) delete busy[defId];
      }

      function cancelOauth(message) {
        if (beginTimer) { clearTimeout(beginTimer); beginTimer = null; }
        ctx.invoke('oauth_loopback_cancel').catch(function () {});
        if (oauthDefinitionId) clearBusy(oauthDefinitionId);
        oauthRequestId = null;
        oauthDefinitionId = null;
        oauthCodeSent = false;
        if (message) setError(message);
        render();
      }

      function disconnect(instanceId) {
        client.send({ type: 'connector-disconnect', instanceId: instanceId });
      }

      function connectOauth(def, capabilityIds, label) {
        if (!ctx.hasTauri) {
          setError('OAuth connect needs the Moon desktop app (the browser cannot capture the redirect).');
          return;
        }
        var resolvedLabel = (label && label.trim()) ? label.trim() : def.name;
        // Preflight the duplicate-label rejection the server would send —
        // BEFORE binding a loopback and opening a browser tab.
        if (labelTaken(def.id, resolvedLabel)) {
          setError('"' + resolvedLabel + '" is already connected — give this account a different label (e.g. personal, work).');
          render();
          return;
        }
        busy[def.id] = 'authorizing';
        consentOpen = null;
        render();
        ctx.invoke('oauth_loopback_start').then(function (port) {
          var requestId = 'oauth_' + (
            (g.crypto && g.crypto.randomUUID)
              ? g.crypto.randomUUID().replace(/-/g, '')
              : Math.random().toString(36).slice(2)
          );
          oauthRequestId = requestId;
          oauthDefinitionId = def.id;
          oauthCodeSent = false;   // fresh flow: not yet in the redemption window
          if (beginTimer) clearTimeout(beginTimer);
          beginTimer = setTimeout(function () {
            cancelOauth('Timed out starting the connection — please try again.');
          }, 30000);
          client.send({
            type: 'connector-oauth-begin',
            requestId: requestId,
            definitionId: def.id,
            label: resolvedLabel,
            capabilityIds: capabilityIds,
            loopbackPort: port,
          });
        }).catch(function (e) {
          clearBusy(def.id);
          setError(String(e));
          render();
        });
      }

      function applyOauthRedirect(frame) {
        if (!frame || frame.requestId !== oauthRequestId) return;
        if (beginTimer) { clearTimeout(beginTimer); beginTimer = null; }
        if (!ctx.hasTauri) return;
        ctx.invoke('open_external_url', { url: frame.authUrl })
          .then(function () {
            return ctx.invoke('oauth_loopback_wait', { timeoutMs: 300000 });
          })
          .then(function (captured) {
            client.send({
              type: 'connector-oauth-code',
              requestId: frame.requestId,   // == oauthRequestId; echoed on the completeAuth status for attribution
              pendingId: frame.pendingId,
              code: captured.code,
              state: captured.state,
            });
            // Now redeeming the code: an unattributed failure (no requestId /
            // instance) on an OLDER server is our completeAuth failing. This
            // flag gates the fallback attribution below so a foreign
            // disconnect-failure during the long consent phase is no longer
            // misread as ours - only during this brief redemption round-trip.
            oauthCodeSent = true;
          })
          .catch(function (e) {
            var msg = typeof e === 'string' ? e : 'The consent flow did not complete.';
            // The classic multi-account trap: a Testing-mode OAuth app only
            // admits listed test users — every other Google account gets
            // access_denied. Say so instead of leaving a bare error code.
            if (/access_denied|not.{0,8}verified/i.test(msg)) {
              msg += ' — if your OAuth app is in Testing mode, add this Google account as a test user (or publish the app) in the Google Cloud Console.';
            }
            cancelOauth(msg);
          });
      }

      function connectPlain(def, capabilityIds, secretRef, label) {
        var resolvedLabel = (label && label.trim()) ? label.trim() : def.name;
        if (labelTaken(def.id, resolvedLabel)) {
          setError('"' + resolvedLabel + '" is already connected — give this account a different label (e.g. personal, work).');
          render();
          return;
        }
        busy[def.id] = 'connecting';
        consentOpen = null;
        var requestId = 'conn_' + Math.random().toString(36).slice(2);
        plainRequests[requestId] = def.id;
        var frame = {
          type: 'connector-connect',
          requestId: requestId,
          definitionId: def.id,
          label: resolvedLabel,
          capabilityIds: capabilityIds,
        };
        if (secretRef) frame.secretRef = secretRef;
        client.send(frame);
        render();
      }

      function setClient(definitionId, clientId, clientSecret) {
        var trimmedId = (clientId || '').trim();
        if (!trimmedId) return;
        var frame = {
          type: 'connector-set-client',
          requestId: 'setclient_' + Math.random().toString(36).slice(2),
          definitionId: definitionId,
          clientId: trimmedId,
        };
        if (clientSecret && clientSecret.trim()) {
          frame.clientSecret = clientSecret.trim();
        }
        client.send(frame);
        clientEditOpen = null;
      }

      function applyStatus(frame) {
        if (!frame) return;

        // Path 1: plain connector-connect response
        if (frame.requestId &&
            Object.prototype.hasOwnProperty.call(plainRequests, frame.requestId)) {
          var defId = plainRequests[frame.requestId];
          delete plainRequests[frame.requestId];
          clearBusy(defId);
          if (frame.ok) {
            setError(null);
            delete consentDraft[defId];
          } else {
            setError(frame.message || 'Connector request failed.');
          }
          render();
          return;
        }

        // Path 2: a connector-status frame that is NOT a tracked plain connect.
        // It may (a) belong to OUR in-flight OAuth flow, or (b) be an ack for a
        // DIFFERENT flow (another account's disconnect/set-client, a late
        // completion) that merely shares this handler. Only (a) may tear down
        // OAuth state; otherwise an unrelated ack silently aborts a consent
        // flow the user is still completing in the browser.
        var attributableToOurOauth = oauthRequestId !== null && (
          // Begin/redirect/timeout failures echo our requestId; the server now
          // also echoes it on completeAuth success + failure.
          (frame.requestId && frame.requestId === oauthRequestId) ||
          // Success completion carries the freshly-created instance for our def.
          (frame.instance && frame.instance.definitionId === oauthDefinitionId) ||
          // completeAuth FAILURE on an OLDER server (no requestId echo) carries
          // neither requestId nor instance; while mid-flow, an unattributed
          // failure is treated as ours (favor teardown over a stuck spinner),
          // but ONLY once we have actually sent connector-oauth-code
          // (oauthCodeSent) - i.e. inside the brief completeAuth redemption
          // window. That phase-gate keeps a foreign disconnect FAILURE
          // ({ok:false}, no requestId/instance) during the long consent phase
          // from being misread as ours. A bare ok:true with no instance is never
          // ours (our success always carries an instance). Residual, now-tiny
          // ambiguity remains only if a foreign disconnect fails during that
          // redemption round-trip on an OLDER server that does not echo our
          // requestId; new servers echo it, so our own failure matches (i).
          (oauthCodeSent && !frame.ok && !frame.requestId && !frame.instance)
        );

        if (attributableToOurOauth) {
          if (beginTimer) { clearTimeout(beginTimer); beginTimer = null; }
          if (!frame.ok) {
            cancelOauth(frame.message || 'Connector request failed.');
            return;
          }
          if (oauthDefinitionId) clearBusy(oauthDefinitionId);
          oauthRequestId = null;
          oauthDefinitionId = null;
          oauthCodeSent = false;
        }
        if (frame.instance) {
          clearBusy(frame.instance.definitionId);
          delete consentDraft[frame.instance.definitionId];
        }
        // A failure ack with no flow to attribute it to (set-client,
        // disconnect, late completeAuth) must still SHOW its message — this
        // tail used to clear the error banner unconditionally, so those
        // failures looked like silent success.
        setError(frame.ok ? null : (frame.message || 'Connector request failed.'));
        render();
      }

      // ── Render ─────────────────────────────────────────────────────────────
      function render() {
        var cards = catalog.map(function (def) {
          var insts = instancesFor(def.id);
          var defBusy = busy[def.id];

          var overallStatus = insts.length === 0 ? 'idle'
            : insts.some(function (i) { return i.status === 'error'; }) ? 'error'
            : insts.some(function (i) { return i.status === 'needs-reauth'; }) ? 'needs-reauth'
            : 'connected';

          var card = document.createElement('div');
          card.className = 'connector-card ' + overallStatus;
          card.style.cssText = [
            'border: 1px solid rgba(138,180,248,0.12)',
            'border-radius: 10px',
            'padding: 10px',
            'margin-bottom: 10px',
            'background: rgba(138,180,248,0.04)',
          ].join(';');

          // ── Card head ────────────────────────────────────────────────────
          var head = document.createElement('div');
          head.className = 'connector-head';
          head.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:6px;';

          var blot = document.createElement('div');
          blot.className = 'skill-blot';
          blot.style.cssText = [
            'width:26px;height:26px;border-radius:50%',
            'background:radial-gradient(circle at 38% 38%,rgba(138,180,248,0.55),rgba(80,120,200,0.22) 60%,transparent)',
            'box-shadow:0 0 8px rgba(138,180,248,0.3)',
            'flex-shrink:0',
          ].join(';');
          if (overallStatus === 'idle' || overallStatus === 'error') {
            blot.style.opacity = '0.3';
            blot.style.filter = 'grayscale(0.8)';
            blot.style.boxShadow = 'none';
          }

          var info = document.createElement('div');
          info.className = 'connector-info';
          info.style.cssText = 'flex:1;min-width:0;';

          var nameEl = document.createElement('div');
          nameEl.className = 'connector-name';
          nameEl.style.cssText = 'font-size:0.8rem;font-weight:600;color:#f1f5f9;';
          nameEl.textContent = def.name;

          var sub = document.createElement('div');
          sub.className = 'connector-sub';
          sub.style.cssText = 'font-size:0.66rem;color:var(--muted);line-height:1.35;';
          sub.textContent = def.blurb || '';

          info.appendChild(nameEl);
          info.appendChild(sub);

          var actions = document.createElement('div');
          actions.className = 'connector-actions';
          actions.style.cssText = 'display:flex;gap:8px;align-items:center;';

          if (defBusy) {
            var busyLbl = document.createElement('span');
            busyLbl.className = 'connector-status-line';
            busyLbl.style.cssText = 'font-size:0.64rem;color:var(--muted);';
            busyLbl.textContent = defBusy === 'authorizing'
              ? 'Waiting for your browser consent…'
              : 'Connecting…';
            actions.appendChild(busyLbl);

            if (defBusy === 'authorizing') {
              var cancelBtn = document.createElement('button');
              cancelBtn.type = 'button';
              cancelBtn.className = 'connector-btn panel-btn';
              cancelBtn.textContent = 'Cancel';
              cancelBtn.addEventListener('click', function () { cancelOauth(null); });
              actions.appendChild(cancelBtn);
            }
          } else {
            var needsClientFirst = !!(def.clientSetup && def.authKind === 'oauth2'
              && !def.clientSetup.configured);
            if (!needsClientFirst) {
              var connectBtn = document.createElement('button');
              connectBtn.type = 'button';
              connectBtn.className = 'connector-btn panel-btn';
              var isAdding = insts.length > 0;
              if (consentOpen === def.id) {
                connectBtn.textContent = 'Cancel';
              } else {
                connectBtn.textContent = isAdding ? 'Add account' : 'Connect';
              }
              (function (d) {
                connectBtn.addEventListener('click', function () {
                  var closing = consentOpen === d.id;
                  consentOpen = closing ? null : d.id;
                  if (closing) {
                    delete consentDraft[d.id];
                    reconnectLabel = null;
                  }
                  setError(null);
                  render();
                });
              })(def);
              actions.appendChild(connectBtn);
            }
          }

          head.appendChild(blot);
          head.appendChild(info);
          head.appendChild(actions);
          card.appendChild(head);

          // ── Per-instance rows ────────────────────────────────────────────
          for (var ii = 0; ii < insts.length; ii++) {
            var inst = insts[ii];
            var row = document.createElement('div');
            row.className = 'connector-instance-row';
            row.style.cssText = [
              'display:flex;align-items:center;gap:8px',
              'padding:6px 0;border-top:1px solid rgba(255,255,255,0.05)',
            ].join(';');

            var rowLabel = document.createElement('div');
            rowLabel.className = 'connector-instance-label';
            rowLabel.style.cssText = 'font-size:0.72rem;font-weight:500;color:#cbd8f0;';
            rowLabel.textContent = inst.label || inst.id;

            var rowStatusText = inst.status === 'connected'
              ? 'Connected · ' + ((inst.grantedScopes && inst.grantedScopes.length) || 'no') + ' scope(s)'
              : inst.status === 'needs-reauth'
                ? 'Needs your approval again — reconnect'
                : 'Error — check the server log';

            var rowStatus = document.createElement('div');
            rowStatus.className = 'connector-status-line'
              + (inst.status === 'needs-reauth' ? ' gold' : '');
            rowStatus.style.cssText = 'font-size:0.64rem;color:'
              + (inst.status === 'needs-reauth' ? '#ffd88a' : 'var(--muted)') + ';';
            rowStatus.textContent = rowStatusText;

            var rowInfo = document.createElement('div');
            rowInfo.className = 'connector-instance-info';
            rowInfo.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;';
            rowInfo.appendChild(rowLabel);
            rowInfo.appendChild(rowStatus);

            if (inst.status === 'connected' && def.authKind === 'oauth2') {
              var hint = document.createElement('div');
              hint.className = 'connector-status-line';
              hint.style.cssText = 'font-size:0.64rem;color:#5d6e92;';
              hint.textContent = 'Requires its local connector server running on this machine.';
              rowInfo.appendChild(hint);
            }

            var rowActions = document.createElement('div');
            rowActions.className = 'connector-instance-actions';
            rowActions.style.cssText = 'display:flex;gap:6px;align-items:center;flex-shrink:0;';

            if (inst.status === 'needs-reauth' && def.authKind === 'oauth2') {
              var reBtn = document.createElement('button');
              reBtn.type = 'button';
              reBtn.className = 'connector-btn panel-btn';
              reBtn.textContent = 'Reconnect';
              (function (d, ins) {
                reBtn.addEventListener('click', function () {
                  disconnect(ins.id);
                  reconnectLabel = ins.label || null;
                  consentOpen = d.id;
                  render();
                });
              })(def, inst);
              rowActions.appendChild(reBtn);
            }

            var disBtn = document.createElement('button');
            disBtn.type = 'button';
            disBtn.className = 'connector-btn panel-btn';
            disBtn.style.cssText = [
              'border-color:rgba(253,164,175,0.4)',
              'background:rgba(253,164,175,0.08)',
              'color:#fda4af',
            ].join(';');
            disBtn.textContent = 'Disconnect';
            (function (insId) {
              disBtn.addEventListener('click', function () { disconnect(insId); });
            })(inst.id);
            rowActions.appendChild(disBtn);

            row.appendChild(rowInfo);
            row.appendChild(rowActions);
            card.appendChild(row);
          }

          // ── Client setup form (M2.6) ─────────────────────────────────────
          if (def.clientSetup && def.authKind === 'oauth2' && !defBusy) {
            var editOpen = clientEditOpen === def.id;
            if (def.clientSetup.configured) {
              var badge = document.createElement('div');
              badge.className = 'connector-client-configured';
              badge.style.cssText = [
                'font-size:0.64rem;color:#6ee7b7',
                'display:flex;align-items:center;gap:5px;padding-top:6px',
              ].join(';');
              var badgeText = document.createElement('span');
              badgeText.textContent = '✓ OAuth client configured';
              badge.appendChild(badgeText);

              var editBtn = document.createElement('button');
              editBtn.type = 'button';
              editBtn.className = 'connector-btn panel-btn';
              editBtn.textContent = editOpen ? 'Close' : 'Edit';
              (function (d) {
                editBtn.addEventListener('click', function () {
                  clientEditOpen = (clientEditOpen === d.id) ? null : d.id;
                  render();
                });
              })(def);
              badge.appendChild(editBtn);
              card.appendChild(badge);
            }

            if (!def.clientSetup.configured || editOpen) {
              var setup = document.createElement('div');
              setup.className = 'connector-client-setup';
              setup.style.cssText = [
                'display:flex;flex-direction:column;gap:8px',
                'border-top:1px dashed rgba(255,255,255,0.08)',
                'padding-top:10px;margin-top:6px',
              ].join(';');

              var explainer = document.createElement('div');
              explainer.className = 'connector-client-explainer';
              explainer.style.cssText = 'font-size:0.64rem;color:var(--muted);line-height:1.5;';
              explainer.textContent =
                'Uses YOUR own Google OAuth client — create one in the Google Cloud Console' +
                ' (Desktop app), then paste it here.';
              setup.appendChild(explainer);

              var idRow = document.createElement('div');
              idRow.className = 'connector-client-row';
              idRow.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
              var idLabel = document.createElement('div');
              idLabel.className = 'connector-client-label';
              idLabel.style.cssText = 'font-size:0.62rem;color:var(--muted);font-weight:500;';
              idLabel.textContent = 'Client ID';
              var clientIdInput = document.createElement('input');
              clientIdInput.type = 'text';
              clientIdInput.className = 'premium-text-input';
              clientIdInput.placeholder = 'e.g. 123456789-abc.apps.googleusercontent.com';
              clientIdInput.style.cssText = [
                'background:rgba(138,180,248,0.05)',
                'border:1px solid rgba(138,180,248,0.18)',
                'border-radius:6px;padding:5px 8px',
                'color:var(--text);font-size:0.75rem;width:100%',
              ].join(';');
              idRow.appendChild(idLabel);
              idRow.appendChild(clientIdInput);
              setup.appendChild(idRow);

              var secRow = document.createElement('div');
              secRow.className = 'connector-client-row';
              secRow.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
              var secLabel = document.createElement('div');
              secLabel.className = 'connector-client-label';
              secLabel.style.cssText = 'font-size:0.62rem;color:var(--muted);font-weight:500;';
              secLabel.textContent = 'Client secret';
              var clientSecretInput = document.createElement('input');
              clientSecretInput.type = 'password';
              clientSecretInput.className = 'premium-text-input';
              clientSecretInput.placeholder = 'Google issues one — paste it too';
              clientSecretInput.style.cssText = [
                'background:rgba(138,180,248,0.05)',
                'border:1px solid rgba(138,180,248,0.18)',
                'border-radius:6px;padding:5px 8px',
                'color:var(--text);font-size:0.75rem;width:100%',
              ].join(';');
              secRow.appendChild(secLabel);
              secRow.appendChild(clientSecretInput);
              setup.appendChild(secRow);

              var saveBtn = document.createElement('button');
              saveBtn.type = 'button';
              saveBtn.className = 'connector-btn panel-btn';
              saveBtn.textContent = 'Save client';
              (function (d, cidIn, csecIn) {
                saveBtn.addEventListener('click', function () {
                  var cid = cidIn.value;
                  var csec = csecIn.value;
                  if (!cid.trim()) return;
                  cidIn.value = '';
                  csecIn.value = '';
                  setClient(d.id, cid, csec);
                });
              })(def, clientIdInput, clientSecretInput);
              setup.appendChild(saveBtn);
              card.appendChild(setup);
            }
          }

          // ── Consent sheet ────────────────────────────────────────────────
          var clientNotReady = def.clientSetup && def.authKind === 'oauth2'
            && !def.clientSetup.configured;
          if (consentOpen === def.id && !defBusy && !clientNotReady) {
            var sheet = document.createElement('div');
            sheet.className = 'connector-consent';
            sheet.style.cssText = [
              'display:flex;flex-direction:column;gap:6px',
              'border-top:1px dashed rgba(255,255,255,0.08)',
              'padding-top:8px;margin-top:6px',
            ].join(';');

            var draft = consentDraft[def.id] || {};

            // Account label input
            var labelRow = document.createElement('div');
            labelRow.className = 'connector-client-row';
            labelRow.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
            var labelLbl = document.createElement('div');
            labelLbl.className = 'connector-client-label';
            labelLbl.style.cssText = 'font-size:0.62rem;color:var(--muted);font-weight:500;';
            labelLbl.textContent = 'Account label';
            var labelInput = document.createElement('input');
            labelInput.type = 'text';
            labelInput.className = 'premium-text-input connector-label-input';
            labelInput.placeholder = 'e.g. personal, flowstay';
            labelInput.style.cssText = [
              'background:rgba(138,180,248,0.05)',
              'border:1px solid rgba(138,180,248,0.18)',
              'border-radius:6px;padding:5px 8px',
              'color:var(--text);font-size:0.75rem;width:100%',
            ].join(';');

            if (reconnectLabel !== null) {
              labelInput.value = reconnectLabel;
              reconnectLabel = null;
            } else if (draft.label !== undefined) {
              labelInput.value = draft.label;
            }

            (function (d) {
              labelInput.addEventListener('input', function () {
                if (!consentDraft[d.id]) consentDraft[d.id] = {};
                consentDraft[d.id].label = labelInput.value;
              });
            })(def);

            labelRow.appendChild(labelLbl);
            labelRow.appendChild(labelInput);
            sheet.appendChild(labelRow);

            // Capability checkboxes
            var boxes = [];
            var draftCaps = Array.isArray(draft.caps) ? draft.caps : null;
            var draftCapsSet = draftCaps ? new g.Set(draftCaps) : null;
            var caps = def.capabilities || [];
            for (var ci = 0; ci < caps.length; ci++) {
              var cap = caps[ci];
              var capRow = document.createElement('label');
              capRow.className = 'connector-cap';
              capRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:0.7rem;color:#cbd8f0;cursor:pointer;';

              var cb = document.createElement('input');
              cb.type = 'checkbox';
              cb.checked = draftCapsSet ? draftCapsSet.has(cap.id) : !!cap.defaultGranted;
              boxes.push({ id: cap.id, cb: cb });

              (function (d, bxs) {
                cb.addEventListener('change', function () {
                  if (!consentDraft[d.id]) consentDraft[d.id] = {};
                  consentDraft[d.id].caps = bxs.filter(function (b) { return b.cb.checked; })
                    .map(function (b) { return b.id; });
                });
              })(def, boxes);

              var capLbl = document.createElement('span');
              capLbl.textContent = cap.label;
              capRow.appendChild(cb);
              capRow.appendChild(capLbl);

              if (cap.scopes && cap.scopes.length) {
                var sc = document.createElement('span');
                sc.className = 'cap-scopes';
                sc.style.cssText = 'font-size:0.58rem;color:var(--muted);';
                sc.textContent = cap.scopes.join(' ');
                capRow.appendChild(sc);
              }
              sheet.appendChild(capRow);
            }

            // Secret ref input (api-key connectors)
            var refInput = null;
            if (def.authKind === 'api-key') {
              refInput = document.createElement('input');
              refInput.type = 'text';
              refInput.className = 'premium-text-input connector-secretref-input';
              refInput.placeholder = 'Secret ref, e.g. env:SLACK_MCP_XOXB_TOKEN (store the value via the Secrets tab first)';
              refInput.style.cssText = [
                'background:rgba(138,180,248,0.05)',
                'border:1px solid rgba(138,180,248,0.18)',
                'border-radius:6px;padding:5px 8px',
                'color:var(--text);font-size:0.75rem;width:100%',
              ].join(';');
              if (draft.secretRef !== undefined) refInput.value = draft.secretRef;
              (function (d) {
                refInput.addEventListener('input', function () {
                  if (!consentDraft[d.id]) consentDraft[d.id] = {};
                  consentDraft[d.id].secretRef = refInput.value;
                });
              })(def);
              sheet.appendChild(refInput);
            }

            var goBtn = document.createElement('button');
            goBtn.type = 'button';
            goBtn.className = 'connector-btn panel-btn primary';
            goBtn.textContent = def.authKind === 'oauth2' ? 'Authorize in browser' : 'Connect';
            (function (d, bxs, lbl, ref) {
              goBtn.addEventListener('click', function () {
                var capabilityIds = bxs.filter(function (b) { return b.cb.checked; })
                  .map(function (b) { return b.id; });
                var accountLabel = lbl.value.trim() || d.name;
                if (d.authKind === 'oauth2') {
                  connectOauth(d, capabilityIds, accountLabel);
                } else {
                  connectPlain(d, capabilityIds, ref ? ref.value.trim() : '', accountLabel);
                }
              });
            })(def, boxes, labelInput, refInput);

            sheet.appendChild(goBtn);
            card.appendChild(sheet);
          }

          return card;
        });

        if (cards.length === 0) {
          var empty = document.createElement('span');
          empty.className = 'notice';
          empty.textContent = 'Not connected — connectors appear when the server sends its catalog.';
          listEl.replaceChildren(empty);
        } else {
          listEl.replaceChildren.apply(listEl, cards);
        }
      }

      // Seed with empty state
      render();

      // ── WS frame registry ─────────────────────────────────────────────────
      var registry = g.LunaWS.createFrameRegistry();

      registry.register('hello', function (frame) {
        var caps = g.LunaProtocol.parseHelloCapabilities(frame);
        if (!caps.connectors) {
          // Server does not advertise the connectors capability — show notice.
          el.replaceChildren();
          var notice = document.createElement('div');
          notice.className = 'notice';
          notice.textContent = 'This server does not support connectors.';
          el.appendChild(notice);
        }
        // If supported, the catalog + list frames will arrive and render();
      });

      registry.register('connector-catalog', function (frame) {
        catalog = Array.isArray(frame.connectors) ? frame.connectors : [];
        render();
      });

      registry.register('connector-list', function (frame) {
        instances = Array.isArray(frame.instances) ? frame.instances : [];
        render();
      });

      registry.register('connector-status', function (frame) {
        applyStatus(frame);
      });

      registry.register('connector-oauth-redirect', function (frame) {
        applyOauthRedirect(frame);
      });

      var client = ctx.connectWs(registry, { autoPong: true });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
