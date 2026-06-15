/**
 * panels/settings-appearance.js — the Appearance settings panel.
 * Ports watercolor palette, light/dark theme, panel chrome, and paper grain
 * controls into the standalone panel module shape.  Registers into
 * window.LunaPanelTypes under key 'settings.appearance'; loaded by
 * panel.html's per-type loader (or preloaded by the jsdom harness).
 *
 * localStorage keys (read and written via window.LunaAppearance):
 *   luna_palette — 'dawn' | 'meadow' | 'tide'      (default 'tide')
 *   luna_theme   — 'light' | 'dark'                (default 'dark')
 *   luna_chrome  — 'wash' | 'ink'                  (default 'wash')
 *   luna_grain   — 'true' | 'false'                (default 'false')
 *
 * Cross-window sync is handled by LunaAppearance's own storage listener;
 * this panel additionally listens to 'storage' events so it can refresh
 * active-state classes/checkbox when another window changes appearance.
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  // Swatch color sets — 5 LIGHT washes per palette (left→right).
  var PALETTE_COLORS = {
    dawn:    ['#e8a7b0', '#f2c29a', '#ecd29a', '#c9b6d9', '#a8c5c0'],
    meadow:  ['#b5c9a3', '#ecd9a0', '#aac9cf', '#d9c3a8', '#c2b4d6'],
    tide:    ['#a9b8dc', '#93c2c4', '#d9b3bd', '#b8cde0', '#cfc3a4'],
  };

  var PALETTES = ['dawn', 'meadow', 'tide'];

  g.LunaPanelTypes['settings.appearance'] = {
    title: 'Appearance',
    render: function (el, ctx) {

      // Guard: LunaAppearance is loaded separately; if unavailable show a
      // notice and bail (degraded embed or test stub).
      if (!g.LunaAppearance) {
        var notice = document.createElement('div');
        notice.className = 'notice';
        notice.textContent = 'Appearance controls are unavailable in this window.';
        el.appendChild(notice);
        return;
      }

      var appearance = g.LunaAppearance;

      // ── Swatch helpers ─────────────────────────────────────────────────

      /** Returns the live active palette / theme / chrome / grain state. */
      function current() {
        return appearance.get();
      }

      // ── a. Watercolor palette ──────────────────────────────────────────
      var palLabel = document.createElement('div');
      palLabel.className = 'section-label';
      palLabel.textContent = 'Watercolor palette';
      el.appendChild(palLabel);

      var swatchRow = document.createElement('div');
      swatchRow.className = 'swatch-row';

      // Keep references so the storage-event handler can update active class.
      var swatchBtns = {};

      PALETTES.forEach(function (name) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'swatch' + (current().palette === name ? ' active' : '');
        btn.title = name;
        btn.setAttribute('aria-label', name);

        PALETTE_COLORS[name].forEach(function (color) {
          var span = document.createElement('span');
          span.style.background = color;
          btn.appendChild(span);
        });

        btn.addEventListener('click', function () {
          appearance.set('palette', name);
          PALETTES.forEach(function (p) {
            swatchBtns[p].classList.toggle('active', p === name);
          });
        });

        swatchBtns[name] = btn;
        swatchRow.appendChild(btn);
      });

      el.appendChild(swatchRow);

      // ── b. Appearance (light / dark) ───────────────────────────────────
      var themeLabel = document.createElement('div');
      themeLabel.className = 'section-label';
      themeLabel.textContent = 'Appearance';
      el.appendChild(themeLabel);

      var themeChipRow = document.createElement('div');
      themeChipRow.className = 'chip-row';

      var themeChips = {};
      ['light', 'dark'].forEach(function (val) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (current().theme === val ? ' on' : '');
        chip.textContent = val;
        chip.addEventListener('click', function () {
          appearance.set('theme', val);
          ['light', 'dark'].forEach(function (v) {
            themeChips[v].classList.toggle('on', v === val);
          });
        });
        themeChips[val] = chip;
        themeChipRow.appendChild(chip);
      });

      el.appendChild(themeChipRow);

      // ── c. Panel chrome (wash / ink) ───────────────────────────────────
      var chromeLabel = document.createElement('div');
      chromeLabel.className = 'section-label';
      chromeLabel.textContent = 'Panel chrome';
      el.appendChild(chromeLabel);

      var chromeChipRow = document.createElement('div');
      chromeChipRow.className = 'chip-row';

      var CHROME_OPTIONS = [
        { value: 'wash', label: 'soft wash' },
        { value: 'ink',  label: 'ink outline' },
      ];
      var chromeChips = {};
      CHROME_OPTIONS.forEach(function (opt) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (current().chrome === opt.value ? ' on' : '');
        chip.textContent = opt.label;
        chip.addEventListener('click', function () {
          appearance.set('chrome', opt.value);
          CHROME_OPTIONS.forEach(function (o) {
            chromeChips[o.value].classList.toggle('on', o.value === opt.value);
          });
        });
        chromeChips[opt.value] = chip;
        chromeChipRow.appendChild(chip);
      });

      el.appendChild(chromeChipRow);

      // ── d. Paper grain toggle ──────────────────────────────────────────
      var grainItem = document.createElement('div');
      grainItem.className = 'setting-item';

      var grainInfo = document.createElement('div');
      grainInfo.className = 'setting-info';
      var grainLabel = document.createElement('span');
      grainLabel.className = 'setting-label';
      grainLabel.textContent = 'Paper grain';
      var grainDesc = document.createElement('span');
      grainDesc.className = 'setting-desc';
      grainDesc.textContent = 'Subtle fractal-noise texture over every window';
      grainInfo.appendChild(grainLabel);
      grainInfo.appendChild(grainDesc);

      var grainSwitch = document.createElement('label');
      grainSwitch.className = 'switch';
      var grainToggle = document.createElement('input');
      grainToggle.type = 'checkbox';
      grainToggle.id = 'grain-toggle';
      grainToggle.checked = current().grain;
      var grainSlider = document.createElement('span');
      grainSlider.className = 'slider';
      grainSwitch.appendChild(grainToggle);
      grainSwitch.appendChild(grainSlider);

      grainItem.appendChild(grainInfo);
      grainItem.appendChild(grainSwitch);
      el.appendChild(grainItem);

      grainToggle.addEventListener('change', function () {
        appearance.set('grain', String(grainToggle.checked));
      });

      // ── e. Chat font family ────────────────────────────────────────────
      // Re-skins the chat reading/writing surfaces only (bubbles + composer)
      // via --font-chat; each chip previews in its own typeface.
      var FONT_OPTIONS = [
        { value: 'sans',  label: 'sans',  token: 'var(--font-body)' },
        { value: 'serif', label: 'serif', token: 'var(--font-serif)' },
        { value: 'mono',  label: 'mono',  token: 'var(--font-mono)' },
        { value: 'hand',  label: 'hand',  token: 'var(--font-hand)' },
      ];

      var fontLabel = document.createElement('div');
      fontLabel.className = 'section-label';
      fontLabel.textContent = 'Chat font';
      el.appendChild(fontLabel);

      var fontChipRow = document.createElement('div');
      fontChipRow.className = 'chip-row';

      var fontChips = {};
      FONT_OPTIONS.forEach(function (opt) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (current().font === opt.value ? ' on' : '');
        chip.textContent = opt.label;
        chip.style.fontFamily = opt.token;
        chip.addEventListener('click', function () {
          appearance.set('font', opt.value);
          FONT_OPTIONS.forEach(function (o) {
            fontChips[o.value].classList.toggle('on', o.value === opt.value);
          });
        });
        fontChips[opt.value] = chip;
        fontChipRow.appendChild(chip);
      });

      el.appendChild(fontChipRow);

      // ── f. Chat text size ──────────────────────────────────────────────
      var SIZE_OPTIONS = [
        { value: 'small',  label: 'small' },
        { value: 'medium', label: 'medium' },
        { value: 'large',  label: 'large' },
        { value: 'xlarge', label: 'x-large' },
      ];

      var sizeLabel = document.createElement('div');
      sizeLabel.className = 'section-label';
      sizeLabel.textContent = 'Chat text size';
      el.appendChild(sizeLabel);

      var sizeChipRow = document.createElement('div');
      sizeChipRow.className = 'chip-row';

      var sizeChips = {};
      SIZE_OPTIONS.forEach(function (opt) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (current().fontSize === opt.value ? ' on' : '');
        chip.textContent = opt.label;
        chip.addEventListener('click', function () {
          appearance.set('fontSize', opt.value);
          SIZE_OPTIONS.forEach(function (o) {
            sizeChips[o.value].classList.toggle('on', o.value === opt.value);
          });
        });
        sizeChips[opt.value] = chip;
        sizeChipRow.appendChild(chip);
      });

      el.appendChild(sizeChipRow);

      // ── g. Instant-apply note ──────────────────────────────────────────
      var note = document.createElement('div');
      note.className = 'setting-desc';
      note.style.marginTop = '10px';
      note.textContent = 'Changes apply to every open Luna window instantly.';
      el.appendChild(note);

      // ── Storage event: sync active states when another window changes ──
      // Guard: if el is removed from the document (panel unmounted or test
      // teardown), silently remove this listener to prevent stale updates.
      function onStorage(e) {
        if (!el.isConnected) {
          g.removeEventListener('storage', onStorage);
          return;
        }
        var keys = appearance.KEYS;
        if (e.key === null ||
            e.key === keys.palette || e.key === keys.theme ||
            e.key === keys.chrome  || e.key === keys.grain ||
            e.key === keys.font    || e.key === keys.fontSize) {
          var now = appearance.get();
          PALETTES.forEach(function (p) {
            swatchBtns[p].classList.toggle('active', p === now.palette);
          });
          ['light', 'dark'].forEach(function (v) {
            themeChips[v].classList.toggle('on', v === now.theme);
          });
          CHROME_OPTIONS.forEach(function (o) {
            chromeChips[o.value].classList.toggle('on', o.value === now.chrome);
          });
          grainToggle.checked = now.grain;
          FONT_OPTIONS.forEach(function (o) {
            fontChips[o.value].classList.toggle('on', o.value === now.font);
          });
          SIZE_OPTIONS.forEach(function (o) {
            sizeChips[o.value].classList.toggle('on', o.value === now.fontSize);
          });
        }
      }

      g.addEventListener('storage', onStorage);
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
