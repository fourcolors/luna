/**
 * panels/settings-vault.js — the Vault settings panel (Luna Vault V1).
 *
 * WS-backed: connects via ctx.connectWs and gates on parseHelloCapabilities
 * (frame).vault. Capability present → the Vault credential registry (list is
 * METADATA + POINTERS only — `vault-list` never carries values) + add form +
 * 1Password sync section. Capability absent (old server) → the legacy
 * op-token-only form, behavior-identical to the old Secrets tab.
 *
 * SECURITY — the typed value lives in exactly one place: the password input,
 * and only until the OPEN-guarded send. It is wiped one-shot on submit and on
 * socket close (client.registerCloseHook — the seam exists exactly so this
 * policy travels with whichever window hosts the secret inputs). Secrets are
 * NEVER logged and never appear in any frame except `vault-put`'s value field
 * (and the legacy `register-op-token`'s token field). Server strings render
 * via textContent only.
 *
 * Faithful port of VaultEngine + SettingsEngine.submitOpToken/setOpStatus
 * from index.html, adapted to the panel context.
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  g.LunaPanelTypes['settings.vault'] = {
    title: 'Vault',

    render: function (el, ctx) {
      // ── Inline styles (dark-glass) ────────────────────────────────────────
      var style = document.createElement('style');
      style.textContent = [
        '.vault-label { font-weight:600; font-size:0.82rem; color:var(--text); }',
        '.vault-desc { display:block; font-size:0.68rem; color:var(--muted); line-height:1.4; margin-top:2px; }',
        '.vault-input { width:100%; box-sizing:border-box; padding:6px 10px; margin-bottom:6px;',
        '  background:rgba(255,255,255,0.04); border:1px solid var(--border); border-radius:7px;',
        '  color:var(--text); font-size:0.8rem; outline:none; font-family:inherit; }',
        '.vault-input::placeholder { color:var(--muted); }',
        '.sp-vault-list { display:flex; flex-direction:column; gap:6px; margin:8px 0 10px;',
        '  max-height:220px; overflow-y:auto; }',
        '.vault-row { display:flex; align-items:center; gap:10px;',
        '  background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05);',
        '  border-radius:10px; padding:8px 10px; }',
        '.vault-row.shadowed { opacity:0.65; }',
        '@keyframes bead-wash { from { border-radius:47% 53% 51% 49%/52% 46% 54% 48%; }',
        '  to { border-radius:52% 48% 46% 54%/49% 53% 47% 51%; } }',
        '.skill-blot { width:22px; height:22px; flex-shrink:0; position:relative;',
        '  border-radius:47% 53% 51% 49%/52% 46% 54% 48%;',
        '  background:radial-gradient(circle closest-side,rgba(150,188,250,0.30) 0%,rgba(138,180,248,0.45) 45%,rgba(104,146,232,0.70) 78%,rgba(96,138,226,0.25) 94%,rgba(96,138,226,0) 100%),radial-gradient(circle at 64% 68%,rgba(165,148,238,0.25) 0%,rgba(165,148,238,0) 60%);',
        '  box-shadow:0 0 10px rgba(138,180,248,0.35);',
        '  animation:bead-wash 7s ease-in-out infinite alternate; }',
        '.vault-row-info { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }',
        '.vault-row-name { font-size:0.78rem; font-weight:600; color:#f1f5f9;',
        '  display:flex; gap:6px; align-items:center; flex-wrap:wrap; }',
        '.skill-row-badge { font-size:0.56rem; text-transform:uppercase; letter-spacing:0.06em;',
        '  color:#94a3b8; background:rgba(255,255,255,0.05); border-radius:4px; padding:1px 5px; }',
        '.skill-row-desc { font-size:0.66rem; color:#64748b; line-height:1.3;',
        '  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
        '.vault-row-sub { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }',
        '.vault-ref { font-family:ui-monospace,SFMono-Regular,monospace; font-size:0.62rem;',
        '  color:#93b4f8; background:rgba(138,180,248,0.08); border-radius:4px; padding:1px 5px; }',
        '.vault-source { font-size:0.62rem; color:#64748b; }',
        '.vault-chip { font-size:0.56rem; border-radius:4px; padding:1px 5px; }',
        '.vault-chip.synced { color:#93c5fd; background:rgba(138,180,248,0.12); }',
        '.vault-chip.shadowed { color:#fbbf24; background:rgba(251,191,36,0.10); }',
        '.connector-actions { display:flex; gap:6px; align-items:center; flex-shrink:0; flex-wrap:wrap; }',
        '.connector-btn { font-size:0.66rem; padding:3px 9px; border-radius:6px;',
        '  border:1px solid var(--border); background:rgba(255,255,255,0.04);',
        '  color:var(--text); cursor:pointer; }',
        '.connector-btn.danger { color:#fda4af; border-color:rgba(248,113,113,0.35); }',
        '.vault-confirm-note { font-size:0.62rem; color:#fbbf24; }',
        '.vault-link-btn { background:none; border:none; color:var(--accent); font-size:0.66rem;',
        '  cursor:pointer; padding:0; text-decoration:underline; }',
        '.vault-var-row { display:flex; align-items:center; gap:6px; margin-bottom:6px; flex-wrap:wrap; }',
        '.vault-var-row .vault-desc { margin-top:0; display:inline; }',
        '.vault-inline { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px; }',
        '.vault-status { font-size:0.75rem; }',
        '.vault-sync-section { margin-top:14px; padding-top:10px; border-top:1px solid var(--border);',
        '  display:flex; flex-direction:column; gap:6px; }',
        '.vault-sync-header { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }',
        '.vault-sync-label { font-weight:600; font-size:0.78rem; color:var(--text); }',
        '.vault-sync-state { font-size:0.65rem; color:#64748b; }',
        '.vault-sync-error { font-size:0.65rem; color:#f87171; word-break:break-all; }',
        '.vault-sync-fields { display:flex; flex-direction:column; gap:6px; }',
        '.vault-sync-helper { font-size:0.62rem; color:#64748b; }',
        '.vault-sync-import-note { font-size:0.62rem; color:#64748b; font-style:italic; }',
        '.vault-check { display:flex; align-items:center; gap:8px; font-size:0.72rem;',
        '  color:var(--text); cursor:pointer; }',
        '.vault-section-gap { margin-top:8px; }',
      ].join('\n');
      document.head.appendChild(style);

      // ── State (closure-scoped; mirrors VaultEngine's slots) ───────────────
      var serverSupportsVault = false;
      var vaultItems = [];
      var vaultSync = null;
      var reqId = null;            // in-flight vault-put / vault-delete requestId
      var reqKind = null;          // 'put' | 'put-op-token' | 'delete'
      var syncReqId = null;        // separate slot for an in-flight vault-sync-config
      var confirmId = null;        // row id currently showing the inline delete confirm
      var varOverride = false;     // advanced env-var override input revealed
      var syncCheckboxDirty = false; // user toggled the checkbox since the last successful save
      var opReqId = null;          // legacy register-op-token requestId
      var wsClient = null;

      var KIND_BADGE = { 'env-secret': 'API key', 'op-token': '1P token', 'op-item': '1P item' };
      var SOURCE_LABEL = {
        'manual': 'added by you',
        'agent': 'added by Luna',
        '1password': 'from 1Password',
        'apple-import': 'Apple import',
      };

      // ── DOM helpers (safe methods only — no innerHTML, ever) ──────────────
      function input(id, type, placeholder) {
        var i = document.createElement('input');
        i.type = type;
        i.id = id;
        i.className = 'vault-input';
        if (placeholder) i.placeholder = placeholder;
        i.setAttribute('autocomplete', 'off');
        i.setAttribute('spellcheck', 'false');
        return i;
      }
      function span(cls, text) {
        var s = document.createElement('span');
        if (cls) s.className = cls;
        if (text) s.textContent = text;
        return s;
      }
      function button(id, cls, text) {
        var b = document.createElement('button');
        b.type = 'button';
        if (id) b.id = id;
        b.className = cls;
        b.textContent = text;
        return b;
      }

      // ── Vault section (capability-gated; hidden until hello says vault) ───
      var vaultSection = document.createElement('div');
      vaultSection.id = 'vault-section';
      vaultSection.hidden = true;

      var head = document.createElement('div');
      head.appendChild(span('vault-label', 'Vault'));
      head.appendChild(span('vault-desc',
        'Keys and tokens Luna can use. Values are stored safely on the server — once saved, they never appear here again.'));
      vaultSection.appendChild(head);

      var listEl = document.createElement('div');
      listEl.id = 'vault-list';
      listEl.className = 'sp-vault-list';
      vaultSection.appendChild(listEl);

      // Add form
      var nameInput = input('vault-name-input', 'text', 'Name (e.g. Notion API Key)');
      nameInput.maxLength = 64;
      vaultSection.appendChild(nameInput);

      var kindSelect = document.createElement('select');
      kindSelect.id = 'vault-kind-select';
      kindSelect.className = 'vault-input';
      var optEnv = document.createElement('option');
      optEnv.value = 'env-secret';
      optEnv.textContent = 'API key / secret';
      optEnv.selected = true;
      var optOp = document.createElement('option');
      optOp.value = 'op-token';
      optOp.textContent = '1Password service-account token';
      kindSelect.appendChild(optEnv);
      kindSelect.appendChild(optOp);
      vaultSection.appendChild(kindSelect);

      var varRow = document.createElement('div');
      varRow.id = 'vault-var-row';
      varRow.className = 'vault-var-row';
      var storedAs = span('vault-desc', 'Stored as ');
      var varPreview = document.createElement('code');
      varPreview.id = 'vault-var-preview';
      varPreview.className = 'vault-ref';
      varPreview.textContent = 'ENV_VAR_NAME';
      storedAs.appendChild(varPreview);
      varRow.appendChild(storedAs);
      var varEdit = button('vault-var-edit', 'vault-link-btn', 'change');
      varRow.appendChild(varEdit);
      var varInput = input('vault-var-input', 'text', 'ENV_VAR_NAME');
      varInput.hidden = true;
      varRow.appendChild(varInput);
      vaultSection.appendChild(varRow);

      var labelInput = input('vault-label-input', 'text', 'Account label (e.g. primary)');
      labelInput.hidden = true;
      vaultSection.appendChild(labelInput);

      var valueInput = input('vault-value-input', 'password', 'Paste the secret value');
      vaultSection.appendChild(valueInput);

      var descInput = input('vault-desc-input', 'text', 'Note (optional)');
      vaultSection.appendChild(descInput);

      var restartNote = span('vault-desc', 'Saving verifies the token and briefly restarts the server.');
      restartNote.id = 'vault-restart-note';
      restartNote.hidden = true;
      vaultSection.appendChild(restartNote);

      var addRow = document.createElement('div');
      addRow.className = 'vault-inline';
      var addBtn = button('vault-add-btn', 'panel-btn', 'Save to server');
      addRow.appendChild(addBtn);
      var statusLine = span('vault-status vault-desc', '');
      statusLine.id = 'vault-status-line';
      statusLine.hidden = true;
      addRow.appendChild(statusLine);
      vaultSection.appendChild(addRow);

      // 1Password sync sub-section
      var syncSection = document.createElement('div');
      syncSection.id = 'vault-sync-section';
      syncSection.className = 'vault-sync-section';
      var syncHeader = document.createElement('div');
      syncHeader.className = 'vault-sync-header';
      syncHeader.appendChild(span('vault-sync-label', '1Password Sync'));
      var syncState = span('vault-sync-state', 'Sync: off');
      syncState.id = 'vault-sync-state';
      syncHeader.appendChild(syncState);
      syncSection.appendChild(syncHeader);

      var syncError = span('vault-sync-error', '');
      syncError.id = 'vault-sync-error';
      syncError.hidden = true;
      syncSection.appendChild(syncError);

      var syncFields = document.createElement('div');
      syncFields.id = 'vault-sync-fields';
      syncFields.className = 'vault-sync-fields';
      syncFields.hidden = true;

      var syncCheckLabel = document.createElement('label');
      syncCheckLabel.className = 'vault-check';
      syncCheckLabel.title = 'Enable 1Password sync';
      var syncEnabled = document.createElement('input');
      syncEnabled.type = 'checkbox';
      syncEnabled.id = 'vault-sync-enabled';
      syncCheckLabel.appendChild(syncEnabled);
      syncCheckLabel.appendChild(span(null, 'Enable 1Password sync'));
      syncFields.appendChild(syncCheckLabel);

      var syncOpLabel = input('vault-sync-op-label', 'text', 'Service-account label (e.g. primary)');
      syncFields.appendChild(syncOpLabel);
      var syncOpVault = input('vault-sync-op-vault', 'text', 'Vault name (e.g. Luna)');
      syncOpVault.value = 'Luna';
      syncFields.appendChild(syncOpVault);
      syncFields.appendChild(span('vault-sync-helper',
        'Create this vault in 1Password and share it with your service account'));

      var pollRow = document.createElement('div');
      pollRow.className = 'vault-inline';
      pollRow.appendChild(span('vault-sync-helper', 'Poll every'));
      var syncPoll = document.createElement('input');
      syncPoll.type = 'number';
      syncPoll.id = 'vault-sync-poll';
      syncPoll.className = 'vault-input';
      syncPoll.min = '60';
      syncPoll.value = '300';
      syncPoll.style.width = '72px';
      syncPoll.style.textAlign = 'right';
      syncPoll.style.marginBottom = '0';
      pollRow.appendChild(syncPoll);
      pollRow.appendChild(span('vault-sync-helper', 'seconds'));
      syncFields.appendChild(pollRow);

      var syncSaveRow = document.createElement('div');
      syncSaveRow.className = 'vault-inline';
      var syncSaveBtn = button('vault-sync-save-btn', 'panel-btn', 'Save sync settings');
      syncSaveRow.appendChild(syncSaveBtn);
      var syncStatus = span('vault-status vault-desc', '');
      syncStatus.id = 'vault-sync-status';
      syncStatus.hidden = true;
      syncSaveRow.appendChild(syncStatus);
      syncFields.appendChild(syncSaveRow);

      var syncImportNote = span('vault-sync-import-note', 'Import Apple Passwords exports from the web client.');
      syncImportNote.id = 'vault-sync-import-note';
      syncImportNote.hidden = true;
      syncFields.appendChild(syncImportNote);

      syncSection.appendChild(syncFields);
      vaultSection.appendChild(syncSection);
      el.appendChild(vaultSection);

      // ── Legacy op-token-only section (old servers; visible pre-hello — the
      //     hub's default markup state, byte-identical behavior) ─────────────
      var legacySection = document.createElement('div');
      legacySection.id = 'legacy-op-token-section';

      var legacyHead = document.createElement('div');
      legacyHead.appendChild(span('vault-label', '1Password Service Account'));
      var legacyDesc = span('vault-desc', 'Send an ');
      var opsCode = document.createElement('code');
      opsCode.className = 'vault-ref';
      opsCode.textContent = 'ops_…';
      legacyDesc.appendChild(opsCode);
      legacyDesc.appendChild(document.createTextNode(
        ' service-account token to the server securely. It is verified and stored on the server — never kept in chat history or on this device.'));
      legacyHead.appendChild(legacyDesc);
      legacySection.appendChild(legacyHead);

      var opLabelInput = input('op-label-input', 'text', 'Account label (e.g. primary)');
      opLabelInput.classList.add('vault-section-gap');
      legacySection.appendChild(opLabelInput);
      var opTokenInput = input('op-token-input', 'password', 'ops_… service-account token');
      legacySection.appendChild(opTokenInput);

      var opRow = document.createElement('div');
      opRow.className = 'vault-inline';
      var opSaveBtn = button('save-op-token-btn', 'panel-btn', 'Save to server');
      opRow.appendChild(opSaveBtn);
      var opStatus = span('vault-status vault-desc', '');
      opStatus.id = 'op-token-status';
      opStatus.hidden = true;
      opRow.appendChild(opStatus);
      legacySection.appendChild(opRow);
      legacySection.appendChild(span('vault-desc', 'Saving verifies the token and briefly restarts the server.'));
      el.appendChild(legacySection);

      // ── Engine helpers (ported verbatim from VaultEngine) ─────────────────

      /** 'Notion API Key' → 'NOTION_API_KEY' (best-effort; validated before send). */
      function deriveVarName(name) {
        var v = String(name || '')
          .trim()
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '');
        if (/^[0-9]/.test(v)) v = '_' + v;
        return v;
      }

      function effectiveVarName() {
        var override = varOverride ? (varInput.value || '').trim() : '';
        return override || deriveVarName(nameInput.value);
      }

      function newReqId(prefix) {
        return prefix + ((g.crypto && g.crypto.randomUUID)
          ? g.crypto.randomUUID().replace(/-/g, '')
          : Math.random().toString(36).slice(2));
      }

      /** The send path is OPEN-guarded: the LunaWS client never logs frames,
       *  but the guard keeps the typed secret in the input (for retry) instead
       *  of wiping it on a send that never happened. */
      function socketOpen() {
        var sock = wsClient && wsClient.socket();
        var OPEN = (g.WebSocket && g.WebSocket.OPEN) !== undefined ? g.WebSocket.OPEN : 1;
        return !!(sock && sock.readyState === OPEN);
      }

      function setStatus(msg, kind) {
        statusLine.textContent = msg || '';   // textContent only — server-controlled string
        statusLine.hidden = !msg;
        statusLine.style.color = kind === 'error' ? '#f87171'
          : kind === 'ok' ? '#4ade80'
          : '#94a3b8';
      }

      function setSyncStatus(msg, kind) {
        syncStatus.textContent = msg || '';   // textContent — server-controlled string
        syncStatus.hidden = !msg;
        syncStatus.style.color = kind === 'error' ? '#f87171'
          : kind === 'ok' ? '#4ade80'
          : '#94a3b8';
      }

      /** The ONE place the credential value lives is this input — wipe it.
       *  Called on send, socket close, capability loss. */
      function wipeValue() {
        valueInput.value = '';
      }

      /** Full form reset after a confirmed save. */
      function clearForm() {
        nameInput.value = '';
        varInput.value = '';
        labelInput.value = '';
        descInput.value = '';
        wipeValue();   // defensive — already wiped on send
        if (varOverride) toggleVarOverride();
        updateKindUI();
      }

      function toggleVarOverride() {
        varOverride = !varOverride;
        varInput.hidden = !varOverride;
        if (varOverride) {
          if (!varInput.value) varInput.value = deriveVarName(nameInput.value);
          try { varInput.focus(); } catch (_) { /* non-fatal in jsdom */ }
        }
        varEdit.textContent = varOverride ? 'auto' : 'change';
        updateVarPreview();
      }

      function updateVarPreview() {
        varPreview.textContent = effectiveVarName() || 'ENV_VAR_NAME';
      }

      /** Kind choice drives which extra field shows: derived-var preview for
       *  env-secret, account label + restart warning for op-token. */
      function updateKindUI() {
        var kind = kindSelect.value || 'env-secret';
        var isOp = kind === 'op-token';
        varRow.hidden = isOp;
        labelInput.hidden = !isOp;
        restartNote.hidden = !isOp;
        valueInput.placeholder = isOp
          ? 'ops_… service-account token'
          : 'Paste the secret value';
        updateVarPreview();
      }

      /** hello gating: vault UI when the server speaks it, legacy op-token
       *  form (pre-vault behavior) when it does not. */
      function applyCapability(supported) {
        serverSupportsVault = !!supported;
        vaultSection.hidden = !supported;
        legacySection.hidden = !!supported;
        if (!supported) {
          // Channel switch to an older server: drop stale registry state and
          // any in-flight request — its vault-status will never arrive.
          vaultItems = [];
          vaultSync = null;
          confirmId = null;
          reqId = null;
          reqKind = null;
          syncReqId = null;
          syncCheckboxDirty = false;
          wipeValue();
          setStatus('', null);
          setSyncStatus('', null);
        }
        renderList();
      }

      /** Idempotent rebuild — vault-list arrives after hello AND is broadcast
       *  after every successful mutation. */
      function applyList(frame) {
        vaultItems = frame && Array.isArray(frame.items) ? frame.items : [];
        vaultSync = (frame && frame.sync) || null;
        // An armed delete-confirm survives an unrelated broadcast, but dies
        // with its row (e.g. the delete actually happened elsewhere).
        if (confirmId && !vaultItems.some(function (i) { return i && i.id === confirmId; })) {
          confirmId = null;
        }
        renderList();
        renderSync();
      }

      /** Validate locally, then send vault-put with the OPEN-socket guard and
       *  one-shot wipe the value input. Validation failures stay local. */
      function submitAdd() {
        var name = (nameInput.value || '').trim();
        var kind = kindSelect.value || 'env-secret';
        var value = valueInput.value || '';
        var description = (descInput.value || '').trim();

        if (!name || name.length > 64) {
          setStatus('Give it a name (1–64 characters).', 'error');
          return;
        }
        var frame = { type: 'vault-put', name: name, kind: kind };
        if (kind === 'op-token') {
          frame.label = (labelInput.value || '').trim() || 'primary';
          if (!value.trim()) {
            setStatus('Paste the ops_… token first.', 'error');
            return;
          }
        } else {
          var varName = effectiveVarName();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
            setStatus('That name can’t become a key — add some letters, or set one under “change”.', 'error');
            return;
          }
          frame.varName = varName;
          if (!value) {
            setStatus('Paste the secret value first.', 'error');
            return;
          }
          if (/[\r\n]/.test(value)) {
            setStatus('The value can’t contain line breaks.', 'error');
            return;
          }
        }
        if (description) frame.description = description;

        if (!serverSupportsVault) {
          setStatus("This server doesn't support the Vault.", 'error');
          return;
        }
        if (!socketOpen()) {
          setStatus('Not connected to a server.', 'error');
          return;
        }
        var rid = newReqId('vlt_');
        reqId = rid;
        // 'put-op-token' lets the socket-close hook leave the status alone
        // (op-token saves deliberately restart the server; the drop is expected).
        reqKind = kind === 'op-token' ? 'put-op-token' : 'put';
        frame.requestId = rid;
        frame.value = value;   // the ONLY frame a secret ever rides on
        if (!wsClient.send(frame)) {
          // The socket died between the guard and the send (client.send never
          // logs the frame) — keep the typed value for retry.
          reqId = null;
          reqKind = null;
          setStatus('Not connected to a server.', 'error');
          return;
        }
        wipeValue();   // one-shot — the value is never retained client-side
        setStatus(kind === 'op-token'
          ? 'Verifying… the server will restart briefly.'
          : 'Saving…', 'info');
      }

      /** Two-step inline confirm (no window.confirm): the first click arms the
       *  row (re-rendered with Delete/Keep), only the second click sends. */
      function requestDelete(id) {
        if (confirmId !== id) {
          confirmId = id;
          renderList();
          return;
        }
        if (!serverSupportsVault) {
          setStatus("This server doesn't support the Vault.", 'error');
          return;
        }
        if (!socketOpen()) {
          setStatus('Not connected to a server.', 'error');
          return;
        }
        var rid = newReqId('vlt_');
        reqId = rid;
        reqKind = 'delete';
        confirmId = null;
        wsClient.send({ type: 'vault-delete', requestId: rid, id: id });
        setStatus('Removing…', 'info');
        renderList();
      }

      function cancelDelete() {
        confirmId = null;
        renderList();
      }

      /** vault-status ack — correlate by requestId; stale/unmatched is ignored.
       *  Sync saves use the separate syncReqId slot so a racing add-form put and
       *  a sync save can both be in-flight without orphaning each other. */
      function handleStatus(frame) {
        if (!frame) return;
        // ── sync slot (independent from the add-form slot) ──────────────────
        if (syncReqId && frame.requestId === syncReqId) {
          syncReqId = null;
          if (frame.ok) syncCheckboxDirty = false;   // server ack clears dirty
          setSyncStatus(
            frame.ok ? (frame.message || 'Saved.')
                     : (frame.message || "That didn’t work — try again."),
            frame.ok ? 'ok' : 'error');
          return;
        }
        // ── add-form / delete slot ───────────────────────────────────────────
        if (!reqId || frame.requestId !== reqId) return;
        var wasPut = reqKind === 'put' || reqKind === 'put-op-token';
        reqId = null;
        reqKind = null;
        setStatus(
          frame.ok ? (frame.message || 'Saved.')
                   : (frame.message || "That didn’t work — try again."),
          frame.ok ? 'ok' : 'error');
        if (frame.ok && wasPut) clearForm();
      }

      /** Rebuild the list rows from vaultItems — createElement + textContent
       *  only (server-controlled strings; defence-in-depth). */
      function renderList() {
        var rows = vaultItems.map(function (item) {
          var row = document.createElement('div');
          row.className = 'vault-row' + (item.shadowed ? ' shadowed' : '');

          var blot = document.createElement('div');
          blot.className = 'skill-blot';

          var info = document.createElement('div');
          info.className = 'vault-row-info';
          var nameLine = span('vault-row-name', String(item.name == null ? '' : item.name));
          var kindStr = String(item.kind == null ? '' : item.kind);
          nameLine.appendChild(span('skill-row-badge', KIND_BADGE[kindStr] || kindStr));
          if (item.synced) {
            var chip = span('vault-chip synced', '1P');
            chip.title = 'Synced with 1Password';
            nameLine.appendChild(chip);
          }
          if (item.shadowed) {
            var warn = span('vault-chip shadowed', '⚠ shadowed');
            warn.title = "Defined by the server's environment — edits here won't take effect";
            nameLine.appendChild(warn);
          }
          var sub = span('vault-row-sub', '');
          var ref = document.createElement('code');
          ref.className = 'vault-ref';
          ref.textContent = String(item.ref == null ? '' : item.ref);   // opaque pointer, never a value
          sub.appendChild(ref);
          var srcStr = String(item.source == null ? '' : item.source);
          sub.appendChild(span('vault-source', SOURCE_LABEL[srcStr] || srcStr));
          info.appendChild(nameLine);
          info.appendChild(sub);
          if (item.description) {
            info.appendChild(span('skill-row-desc', String(item.description)));
          }

          var actions = document.createElement('div');
          actions.className = 'connector-actions';
          if (confirmId === item.id) {
            actions.appendChild(span('vault-confirm-note', item.kind === 'op-token'
              ? 'Remove? The server restarts.'
              : 'Remove this credential?'));
            var yes = button(null, 'connector-btn danger', 'Delete');
            yes.addEventListener('click', function () { requestDelete(item.id); });
            var no = button(null, 'connector-btn', 'Keep');
            no.addEventListener('click', function () { cancelDelete(); });
            actions.appendChild(yes);
            actions.appendChild(no);
          } else {
            var del = button(null, 'connector-btn danger', 'Delete');
            del.addEventListener('click', function () { requestDelete(item.id); });
            actions.appendChild(del);
          }

          row.appendChild(blot);
          row.appendChild(info);
          row.appendChild(actions);
          return row;
        });
        if (rows.length === 0) {
          listEl.replaceChildren(span('vault-desc', 'Nothing stored yet — add your first key below.'));
        } else {
          listEl.replaceChildren.apply(listEl, rows);
        }
      }

      /** Idempotent rebuild of the 1Password sync sub-section from vaultSync.
       *  Called by applyList(). Does NOT touch the add form. */
      function renderSync() {
        var sync = vaultSync || null;

        // 1. Status line: "Sync: on / off" + relative last-synced time.
        var stateText = sync && sync.enabled ? 'Sync: on' : 'Sync: off';
        if (sync && sync.lastSyncedAt) {
          var diffSec = Math.floor((Date.now() - sync.lastSyncedAt) / 1000);
          var rel;
          if (diffSec < 60) rel = diffSec + 's ago';
          else if (diffSec < 3600) rel = Math.floor(diffSec / 60) + 'm ago';
          else if (diffSec < 86400) rel = Math.floor(diffSec / 3600) + 'h ago';
          else rel = Math.floor(diffSec / 86400) + 'd ago';
          stateText += ' · ' + rel;
        }
        syncState.textContent = stateText;   // textContent — never innerHTML

        // 2. Last error (warn color, textContent only).
        var err = (sync && sync.lastError) ? String(sync.lastError) : '';
        syncError.textContent = err;
        syncError.hidden = !err;

        // 3. Reveal the editable fields (sync section shows whenever the vault
        //    capability is present).
        syncFields.hidden = false;

        // 4. Populate editable controls from server state.
        //    Text inputs: fill-if-empty guard (never overwrite mid-edit).
        //    Checkbox: only apply server state when the user has not toggled it
        //    since the last successful save (syncCheckboxDirty flag).
        if (!syncCheckboxDirty) {
          syncEnabled.checked = !!(sync && sync.enabled);
        }
        var opTokenItem = vaultItems.filter(function (i) { return i && i.kind === 'op-token'; })[0] || null;
        syncOpLabel.placeholder = opTokenItem
          ? (String(opTokenItem.ref || '').replace(/^luna-op:\/\//, '').split('/')[0] || 'primary')
          : 'primary';
        if (!syncOpLabel.value && sync && sync.opLabel) {
          syncOpLabel.value = String(sync.opLabel);
        }
        if (!syncOpVault.value && sync && sync.opVault) {
          syncOpVault.value = String(sync.opVault);
        }
        if (!syncPoll.value || syncPoll.value === '300') {
          var ps = sync && sync.pollSeconds ? Number(sync.pollSeconds) : 300;
          syncPoll.value = String(Math.max(60, ps));
        }

        // 5. When sync is enabled show the Apple Passwords import nudge.
        syncImportNote.hidden = !(sync && sync.enabled);
      }

      /** Send vault-sync-config with the OPEN-socket guard.
       *  Does NOT touch the add form at all. No secret rides on this frame. */
      function submitSyncConfig() {
        if (!serverSupportsVault) {
          setSyncStatus("This server doesn't support the Vault.", 'error');
          return;
        }
        if (!socketOpen()) {
          setSyncStatus('Not connected to a server.', 'error');
          return;
        }
        var enabled = !!syncEnabled.checked;
        var opLabel = (syncOpLabel.value || '').trim();
        var opVault = (syncOpVault.value || '').trim() || 'Luna';
        var pollRaw = parseInt(syncPoll.value || '300', 10);
        var pollSeconds = isNaN(pollRaw) ? 300 : Math.max(60, pollRaw);

        var rid = newReqId('vlt_');
        syncReqId = rid;   // dedicated slot — keeps add-form and sync acks independent
        wsClient.send({
          type: 'vault-sync-config',
          requestId: rid,
          enabled: enabled,
          opLabel: opLabel,
          opVault: opVault,
          pollSeconds: pollSeconds,
        });
        setSyncStatus('Saving sync settings…', 'info');
      }

      // ── Legacy op-token form (SettingsEngine.submitOpToken/setOpStatus) ───
      function setOpStatus(msg, kind) {
        opStatus.textContent = msg || '';
        opStatus.hidden = !msg;
        opStatus.style.color = kind === 'error' ? '#f87171'
          : kind === 'ok' ? '#4ade80'
          : '#94a3b8';
      }

      function submitOpToken() {
        var label = (opLabelInput.value || '').trim() || 'primary';
        var token = opTokenInput.value || '';
        if (!token.trim()) { setOpStatus('Enter a token first.', 'error'); return; }
        // OPEN guard before send — keeps the token in the input when there is
        // no connection (the client's send never logs the frame either way).
        if (!socketOpen()) {
          setOpStatus('Not connected to a server.', 'error');
          return;
        }
        var rid = newReqId('op_');
        opReqId = rid;
        if (!wsClient.send({ type: 'register-op-token', requestId: rid, label: label, token: token })) {
          opReqId = null;
          setOpStatus('Not connected to a server.', 'error');
          return;
        }
        opTokenInput.value = '';        // one-shot — never retained client-side
        setOpStatus('Verifying…', 'info');
      }

      function handleOpTokenStatus(frame) {
        if (!frame || frame.requestId !== opReqId) return;  // ignore stale/unmatched
        opReqId = null;
        setOpStatus(
          frame.ok ? (frame.message || 'Saved. Restarting…')
                   : (frame.message || 'Could not save the token.'),
          frame.ok ? 'ok' : 'error');
      }

      // ── Event wiring (mirrors the hub's listener block) ───────────────────
      addBtn.addEventListener('click', submitAdd);
      kindSelect.addEventListener('change', updateKindUI);
      nameInput.addEventListener('input', updateVarPreview);
      varInput.addEventListener('input', updateVarPreview);
      varEdit.addEventListener('click', toggleVarOverride);
      syncSaveBtn.addEventListener('click', submitSyncConfig);
      // Mark the checkbox dirty whenever the user toggles it manually so a
      // concurrent vault-list broadcast does not clobber their intent.
      syncEnabled.addEventListener('change', function () { syncCheckboxDirty = true; });
      opSaveBtn.addEventListener('click', submitOpToken);

      // ── Initial paint ──────────────────────────────────────────────────────
      updateKindUI();
      renderList();

      // ── WS frame registry ─────────────────────────────────────────────────
      var registry = g.LunaWS.createFrameRegistry();

      registry.register('hello', function (frame) {
        var caps = g.LunaProtocol.parseHelloCapabilities(frame);
        // Re-evaluated on every hello so a channel switch to an older server
        // flips back to the legacy form (and drops all vault state).
        applyCapability(caps.vault);
      });

      registry.register('vault-list', function (frame) {
        // The credential registry (metadata + pointers ONLY — never values).
        applyList(frame);
      });

      registry.register('vault-status', function (frame) {
        // Ack for a vault-put / vault-delete / vault-sync-config. Never
        // carries the value.
        handleStatus(frame);
      });

      registry.register('register-op-token-status', function (frame) {
        // Secure-entry ack (legacy 1Password form). Never carries the token.
        handleOpTokenStatus(frame);
      });

      // ── Connect + close-hook hygiene (the registerCloseHook seam) ─────────
      wsClient = ctx.connectWs(registry, {});

      wsClient.registerCloseHook(function () {
        // SECRET HYGIENE on socket drop (hub WebSocketEngine close-hook parity):
        // never retain a typed secret across a socket drop. Clear the VALUES
        // only — leave statuses readable so the op-token success flow (server
        // restarts → socket closes → reconnect) isn't killed early.
        wipeValue();
        opTokenInput.value = '';
        // Clear any stale in-flight Vault request. The ack will never arrive
        // on this session, so a stale reqId/syncReqId would block future
        // submits from correlating. For env-secret puts and deletes also
        // replace the status text with an actionable message. Op-token saves
        // deliberately restart the server so their 'Verifying…' status stays.
        if (reqId) {
          var lostKind = reqKind;
          reqId = null;
          reqKind = null;
          if (lostKind && lostKind !== 'put-op-token') {
            setStatus('Connection lost — check the list after reconnecting.', 'error');
          }
        }
        if (syncReqId) {
          syncReqId = null;
          setSyncStatus('Connection lost — check sync state after reconnecting.', 'error');
        }
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
