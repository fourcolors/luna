/**
 * panels/settings-updates.js — the Updates settings panel (Phase 2's probe
 * panel, Phase 3 module form). Registers into window.LunaPanelTypes; loaded
 * by panel.html's per-type loader (or preloaded by the jsdom harness).
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  g.LunaPanelTypes['settings.updates'] = {
    title: 'Updates',
    render: function (el, ctx) {
      var row = document.createElement('div');
      row.className = 'panel-row';
      var btn = document.createElement('button');
      btn.className = 'panel-btn';
      btn.id = 'check-update-btn';
      btn.textContent = 'Check for updates';
      btn.setAttribute('aria-label', 'Check for updates');
      var status = document.createElement('span');
      status.className = 'panel-status';
      status.id = 'update-status';
      status.setAttribute('role', 'status');
      row.appendChild(btn);
      row.appendChild(status);
      el.appendChild(row);

      var installRow = document.createElement('div');
      installRow.className = 'panel-row';
      installRow.hidden = true;
      var installBtn = document.createElement('button');
      installBtn.className = 'panel-btn primary';
      installBtn.id = 'install-update-btn';
      installBtn.textContent = 'Update & Restart';
      installBtn.setAttribute('aria-label', 'Update and restart');
      installRow.appendChild(installBtn);
      el.appendChild(installRow);

      function setStatus(text, cls) {
        status.textContent = text;
        status.className = 'panel-status' + (cls ? ' ' + cls : '');
      }

      btn.addEventListener('click', async function () {
        if (!ctx.hasTauri) { setStatus('Updates are only available in the desktop app.'); return; }
        setStatus('Checking…');
        installRow.hidden = true;
        try {
          var info = await ctx.invoke('check_for_update');
          if (info && info.version) {
            setStatus('Update available: v' + info.version, 'warn');
            installRow.hidden = false;
          } else {
            setStatus('Up to date ✓', 'ok');
          }
        } catch (e) {
          setStatus('Update check failed: ' + e, 'warn');
        }
      });

      installBtn.addEventListener('click', async function () {
        if (!ctx.hasTauri) return;
        installBtn.disabled = true;
        setStatus('Downloading & installing…');
        try {
          await ctx.invoke('install_update');
          // The app restarts on success; this only paints on failure paths.
        } catch (e) {
          installBtn.disabled = false;
          setStatus('Install failed: ' + e, 'warn');
        }
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
