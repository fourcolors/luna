/**
 * panels/settings-launcher.js — the Settings LAUNCHER panel (widget kind
 * 'settings', title 'Settings'). The hub's gear modal died in Phase 3; this
 * panel is its windowed replacement: a vertical list of launcher buttons,
 * one per settings panel, each opening its system widget via open_widget.
 *
 * Skills/Connectors are ALWAYS visible here (v1): this panel has no WS
 * connection of its own, so it cannot read the hello capability gates the
 * hub used to toggle those launchers — acceptable, since the target panels
 * themselves degrade gracefully against servers without the capability.
 *
 * Registers into window.LunaPanelTypes; loaded by panel.html's per-type
 * loader (or preloaded by the jsdom harness). Safe DOM methods only.
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  // The settings panels, in the hub launcher's order.
  var PANELS = [
    { kind: 'settings.general',     label: 'General' },
    { kind: 'settings.appearance',  label: 'Appearance' },
    { kind: 'settings.connection',  label: 'Connection' },
    { kind: 'settings.voice',      label: 'Voice' },
    { kind: 'settings.models',     label: 'Models' },
    { kind: 'settings.accounts',   label: 'Accounts' },
    { kind: 'settings.vault',      label: 'Vault' },
    { kind: 'settings.skills',     label: 'Skills' },
    { kind: 'settings.connectors', label: 'Connectors' },
    { kind: 'settings.apps',       label: 'Apps' },
    { kind: 'settings.updates',    label: 'Updates' },
  ];

  // Ambient widgets (Phase 5): a manual way to open the rails — the deck
  // also summons them by itself (needs-input auto-opens Now) and the agent
  // can summon any of them by name.
  var WIDGETS = [
    { kind: 'now',       label: 'Now' },
    { kind: 'briefing',  label: 'Briefing' },
    { kind: 'workflows', label: 'Workflows' },
  ];

  var mod = {
    title: 'Settings',
    render: function (el, ctx) {
      var makeSection = function (id, entries, suffix) {
        var list = document.createElement('div');
        list.id = id;
        list.setAttribute('role', 'menu');
        list.style.display = 'flex';
        list.style.flexDirection = 'column';
        list.style.gap = '6px';
        entries.forEach(function (p) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'panel-btn launcher-btn';
          btn.setAttribute('role', 'menuitem');
          btn.setAttribute('data-panel-kind', p.kind);
          btn.setAttribute('aria-label', 'Open ' + p.label + suffix);
          btn.style.textAlign = 'left';
          btn.style.width = '100%';
          btn.textContent = p.label + ' ↗';
          btn.addEventListener('click', function () {
            // Best-effort: off-Tauri (browser dev / jsdom) the invoke rejects
            // and the launcher simply stays put. macOS owns the placement of
            // the new panel window.
            ctx.invoke('open_widget', { kind: p.kind }).catch(function () {});
          });
          list.appendChild(btn);
        });
        return list;
      };
      el.appendChild(makeSection('launcher-list', PANELS, ' settings'));
      var divider = document.createElement('div');
      divider.style.cssText = 'border-top:1px solid var(--border);margin:10px 0;';
      el.appendChild(divider);
      el.appendChild(makeSection('launcher-widgets', WIDGETS, ''));
    },
  };

  // Registered under BOTH names: 'settings' is the widget KIND (what the
  // chat gear and the agent's open_widget use); 'settings-launcher' matches
  // this FILE's name so panel.html's per-type loader (which fetches
  // panels/<type-with-dashes>.js) can resolve it if the registry points the
  // kind at panel.html?type=settings-launcher.
  g.LunaPanelTypes['settings'] = mod;
  g.LunaPanelTypes['settings-launcher'] = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this);
