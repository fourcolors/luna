/**
 * panels/settings-general.js — the General settings panel.
 * Ports the General tabpanel from index.html's SettingsEngine into the
 * standalone panel module shape.  Registers into window.LunaPanelTypes;
 * loaded by panel.html's per-type loader (or preloaded by the jsdom harness).
 *
 * localStorage keys (identical to the hub's SettingsEngine):
 *   luna_always_on_top   — "true" | "false"  (default: "false")
 *   luna_close_on_blur   — "true" | "false"  (default: "false")
 *   luna_global_shortcut — combo string       (default: "⌥Space")
 *
 * Hub-owned side-effects (applying window flags, re-registering the shortcut,
 * starting a new conversation) are signalled via cross-window storage events
 * that the hub already listens to — NOT this panel's responsibility.
 *
 * The one exception is "Start a fresh thread": the hub must act immediately
 * (open the chat + newConversation), so we fire it through hub_event.
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  var DEFAULT_SHORTCUT = '⌥Space';

  g.LunaPanelTypes['settings.general'] = {
    title: 'General',
    render: function (el, ctx) {

      // ── Always on Top ──────────────────────────────────────────────────
      var aotItem = document.createElement('div');
      aotItem.className = 'setting-item';

      var aotInfo = document.createElement('div');
      aotInfo.className = 'setting-info';
      var aotLabel = document.createElement('span');
      aotLabel.className = 'setting-label';
      aotLabel.textContent = 'Always on Top';
      var aotDesc = document.createElement('span');
      aotDesc.className = 'setting-desc';
      aotDesc.textContent = 'Keep Luna and her panels floating above other apps';
      aotInfo.appendChild(aotLabel);
      aotInfo.appendChild(aotDesc);

      var aotSwitch = document.createElement('label');
      aotSwitch.className = 'switch';
      var aotToggle = document.createElement('input');
      aotToggle.type = 'checkbox';
      aotToggle.id = 'always-on-top-toggle';
      var savedAot = localStorage.getItem('luna_always_on_top');
      aotToggle.checked = savedAot !== null ? savedAot === 'true' : false;
      var aotSlider = document.createElement('span');
      aotSlider.className = 'slider';
      aotSwitch.appendChild(aotToggle);
      aotSwitch.appendChild(aotSlider);

      aotItem.appendChild(aotInfo);
      aotItem.appendChild(aotSwitch);
      el.appendChild(aotItem);

      aotToggle.addEventListener('change', function () {
        localStorage.setItem('luna_always_on_top', String(aotToggle.checked));
      });

      // ── Close on Click Away ────────────────────────────────────────────
      var cobItem = document.createElement('div');
      cobItem.className = 'setting-item';

      var cobInfo = document.createElement('div');
      cobInfo.className = 'setting-info';
      var cobLabel = document.createElement('span');
      cobLabel.className = 'setting-label';
      cobLabel.textContent = 'Close on Click Away';
      var cobDesc = document.createElement('span');
      cobDesc.className = 'setting-desc';
      cobDesc.textContent = 'Collapse chat automatically when unfocused';
      cobInfo.appendChild(cobLabel);
      cobInfo.appendChild(cobDesc);

      var cobSwitch = document.createElement('label');
      cobSwitch.className = 'switch';
      var cobToggle = document.createElement('input');
      cobToggle.type = 'checkbox';
      cobToggle.id = 'close-on-blur-toggle';
      var savedCob = localStorage.getItem('luna_close_on_blur');
      cobToggle.checked = savedCob !== null ? savedCob === 'true' : false;
      var cobSlider = document.createElement('span');
      cobSlider.className = 'slider';
      cobSwitch.appendChild(cobToggle);
      cobSwitch.appendChild(cobSlider);

      cobItem.appendChild(cobInfo);
      cobItem.appendChild(cobSwitch);
      el.appendChild(cobItem);

      cobToggle.addEventListener('change', function () {
        localStorage.setItem('luna_close_on_blur', String(cobToggle.checked));
      });

      // ── Global Shortcut ────────────────────────────────────────────────
      var scItem = document.createElement('div');
      scItem.className = 'setting-item';

      var scInfo = document.createElement('div');
      scInfo.className = 'setting-info';
      var scLabel = document.createElement('span');
      scLabel.className = 'setting-label';
      scLabel.textContent = 'Global Shortcut';
      var scDesc = document.createElement('span');
      scDesc.className = 'setting-desc';
      scDesc.textContent = 'Press shortcut to toggle Luna window';
      scInfo.appendChild(scLabel);
      scInfo.appendChild(scDesc);

      var scGroup = document.createElement('div');
      scGroup.className = 'shortcut-recorder-group';
      scGroup.style.display = 'flex';
      scGroup.style.alignItems = 'center';
      scGroup.style.gap = '6px';

      var scInput = document.createElement('input');
      scInput.type = 'text';
      scInput.className = 'shortcut-input';
      scInput.id = 'shortcut-input';
      scInput.readOnly = true;
      var savedShortcut = localStorage.getItem('luna_global_shortcut');
      scInput.value = savedShortcut !== null ? savedShortcut : DEFAULT_SHORTCUT;

      var scRecordBtn = document.createElement('button');
      scRecordBtn.type = 'button';
      scRecordBtn.className = 'panel-btn';
      scRecordBtn.id = 'record-shortcut-btn';
      scRecordBtn.textContent = 'Record';

      scGroup.appendChild(scInput);
      scGroup.appendChild(scRecordBtn);

      scItem.appendChild(scInfo);
      scItem.appendChild(scGroup);
      el.appendChild(scItem);

      // Recording state — local to this render call (matches SettingsEngine.State).
      var isRecording = false;

      function startRecording() {
        isRecording = true;
        scRecordBtn.textContent = 'Cancel';
        scInput.classList.add('recording');
        scInput.value = 'Press keys...';
      }

      function stopRecording(cancelled) {
        isRecording = false;
        scRecordBtn.textContent = 'Record';
        scInput.classList.remove('recording');
        if (cancelled) {
          var saved = localStorage.getItem('luna_global_shortcut') || DEFAULT_SHORTCUT;
          scInput.value = saved;
        }
      }

      scRecordBtn.addEventListener('click', function () {
        if (isRecording) {
          stopRecording(true);
        } else {
          startRecording();
        }
      });

      // Exactly mirrors SettingsEngine.handleKeyDown — same modifier order,
      // same key naming, Escape is NOT special (it records as "ESCAPE").
      // Modifier-only keydowns are silently ignored (wait for a real key).
      // Guard: if our input is no longer in the document (panel replaced /
      // test teardown) we remove this listener and do nothing — prevents
      // stale handlers from firing across panel reloads in tests and in the
      // real app if a panel ever re-mounts.
      function handleKeyDown(e) {
        if (!scInput.isConnected) {
          window.removeEventListener('keydown', handleKeyDown);
          return;
        }
        if (!isRecording) return;

        e.preventDefault();
        e.stopPropagation();

        var key = e.key;
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
          return; // modifier-only: keep waiting
        }

        var shortcut = '';
        if (e.ctrlKey)  shortcut += '⌃';
        if (e.altKey)   shortcut += '⌥';
        if (e.shiftKey) shortcut += '⇧';
        if (e.metaKey)  shortcut += '⌘';

        var keyName = key.toUpperCase();
        if (key === ' ') keyName = 'Space';

        shortcut += keyName;

        scInput.value = shortcut;
        localStorage.setItem('luna_global_shortcut', shortcut);

        stopRecording(false);
      }

      window.addEventListener('keydown', handleKeyDown);

      // ── Start a fresh thread ───────────────────────────────────────────
      var ftItem = document.createElement('div');
      ftItem.className = 'setting-item';

      var ftInfo = document.createElement('div');
      ftInfo.className = 'setting-info';
      var ftLabel = document.createElement('span');
      ftLabel.className = 'setting-label';
      ftLabel.textContent = 'Start a fresh thread';
      var ftDesc = document.createElement('span');
      ftDesc.className = 'setting-desc';
      ftDesc.textContent = 'Luna keeps one ongoing thread. This abandons the current conversation and begins a new one — your history stays on the server.';
      ftInfo.appendChild(ftLabel);
      ftInfo.appendChild(ftDesc);

      var ftBtn = document.createElement('button');
      ftBtn.type = 'button';
      ftBtn.className = 'panel-btn';
      ftBtn.id = 'fresh-thread-btn';
      ftBtn.textContent = 'Start fresh';

      ftItem.appendChild(ftInfo);
      ftItem.appendChild(ftBtn);
      el.appendChild(ftItem);

      ftBtn.addEventListener('click', function () {
        ctx.invoke('hub_event', { name: 'fresh-thread' }).catch(function () {});
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
