/**
 * panels/settings-updates.js — the Updates settings panel.
 *
 * This is the FULL staged-update narrative (the richest of the three update
 * surfaces; the composer banner and the orb pip are the quieter nudges). It
 * tells the whole story in one place: we check quietly, auto-download with a
 * live progress bar, verify the signature, then HOLD the staged bytes until
 * the user presses "Restart to update" — nothing restarts on its own.
 *
 * WHY a panel-local phase machine instead of imperative button handlers:
 * the Rust UpdateManager is the source of truth and drives everything via
 * `update://*` events. The panel is a pure projection of one phase string +
 * a few numbers. We listen to every event, fold it into local state, and
 * re-render. We also call `update_state` once on open (replay-on-open) so a
 * freshly-opened panel syncs immediately instead of waiting for the next
 * event — the download may already be staged before this window ever exists.
 *
 * Updates are GOOD NEWS: this panel uses the accent/positive palette only,
 * never red/warning styling. Release notes are remote-ish text, so they go in
 * via textContent (never innerHTML) and are capped to a few lines.
 *
 * Registers into window.LunaPanelTypes; loaded by panel.html's per-type loader
 * (or preloaded by the jsdom harness).
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  // The phases mirror UpdateStateDto.phase in the Rust UpdateManager.
  // "verifying" is an optional transient between download-finish and ready;
  // we treat it as a downloading-tail so the bar/labels stay coherent.
  var PHASES = ['idle', 'checking', 'available', 'downloading', 'verifying', 'ready', 'error'];

  // Per-phase status-pill copy. Updates read as positive; "error" is the only
  // muted case and still avoids alarm language (we never go red).
  var PILL = {
    idle: 'Up to date',
    checking: 'Checking…',
    available: 'Update found',
    downloading: 'Downloading…',
    verifying: 'Verifying…',
    ready: 'Ready to update',
    error: "Couldn't check",
  };

  // MB formatter (mirrors VoiceEngine.onModelProgress / the voice panel).
  function mb(n) { return (Number(n) / (1024 * 1024)).toFixed(1); }

  // The panel uses ONLY watercolor tokens for color (--paper/--paper-2/--ink/
  // --ink-soft/--ink-faint/--accent). The progress fill and card chrome need a
  // small inline <style> on top of the shared panel-* classes. Injected once.
  var STYLE_ID = 'luna-updates-style';
  var STYLE_CSS = [
    '.upd-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:14px;}',
    '.upd-app{font-size:0.92rem;font-weight:700;color:var(--ink);}',
    '.upd-cur{font-size:0.72rem;color:var(--ink-soft);margin-top:2px;}',
    // Status pill — accent-tinted regardless of phase (never red); a touch
    // brighter when ready so the eye lands on it.
    '.upd-pill{flex:0 0 auto;font-size:0.7rem;font-weight:600;padding:3px 10px;border-radius:999px;',
    'color:var(--accent);background:color-mix(in oklab, var(--accent) 14%, transparent);',
    'border:1px solid color-mix(in oklab, var(--accent) 30%, transparent);white-space:nowrap;}',
    '.upd-pill.ready{color:var(--paper);background:var(--accent);border-color:transparent;}',
    // Update card — a soft paper-2 surface that only shows once an update exists.
    '.upd-card{background:var(--paper-2);border:1px solid var(--ink-faint);border-radius:10px;',
    'padding:12px;margin-bottom:14px;}',
    '.upd-card-ver{font-size:0.84rem;font-weight:700;color:var(--ink);}',
    '.upd-card-sub{font-size:0.7rem;color:var(--ink-soft);margin-top:1px;}',
    '.upd-notes-label{font-size:0.68rem;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;',
    'color:var(--ink-soft);margin:10px 0 5px;}',
    '.upd-notes{list-style:none;margin:0;padding:0;}',
    '.upd-notes li{font-size:0.76rem;color:var(--ink);line-height:1.45;padding-left:12px;position:relative;}',
    // Hand-drawn-ish dot bullet in accent — positive, painterly.
    '.upd-notes li::before{content:"";position:absolute;left:2px;top:0.6em;width:4px;height:4px;',
    'border-radius:50%;background:var(--accent);}',
    // Progress section.
    '.upd-prog-track{width:100%;height:6px;background:color-mix(in oklab, var(--ink-faint) 60%, transparent);',
    'border-radius:3px;overflow:hidden;}',
    '.upd-prog-fill{height:100%;width:0%;background:var(--accent);border-radius:3px;transition:width 0.18s ease;}',
    '.upd-prog-row{display:flex;align-items:center;justify-content:space-between;gap:8px;',
    'font-size:0.72rem;color:var(--ink-soft);margin-top:6px;}',
    // "Signature verified" — accent text + a check, reassuring not loud.
    '.upd-verified{display:flex;align-items:center;gap:6px;font-size:0.74rem;font-weight:600;',
    'color:var(--accent);margin-top:8px;}',
    '.upd-foot{font-size:0.68rem;color:var(--ink-faint);margin-top:14px;}',
    // The "Later" secondary button is a plain ghost (no accent fill).
    '.panel-btn.ghost{background:transparent;}',
  ].join('\n');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = STYLE_CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  g.LunaPanelTypes['settings.updates'] = {
    title: 'Updates',

    render: function (el, ctx) {
      ensureStyle();

      // ── Local phase state (a projection of UpdateStateDto) ────────────────
      var state = {
        phase: 'idle',
        version: null,
        notes: null,
        downloaded: 0,
        total: null,
      };

      // Once-per-version guard for maybeAutoDownload(): a manual check leaves us
      // at "available" with no further motion (check_for_update is auto_download
      // =false by contract), so the panel advances it into the staged download
      // itself. Tracked per version so we kick exactly once; reset on a fresh
      // manual check so a retry after an error can re-trigger.
      var kickedVersion = null;

      // ── Header: app name + current version (left), status pill (right) ────
      var head = document.createElement('div');
      head.className = 'upd-head';

      var headLeft = document.createElement('div');
      var appName = document.createElement('div');
      appName.className = 'upd-app';
      appName.textContent = 'Luna Moon';
      var curLine = document.createElement('div');
      curLine.className = 'upd-cur';
      curLine.id = 'update-current';
      // The current version is stamped by the build; in the panel we read it
      // from the document if present, else show a neutral placeholder. The
      // staged "what's new" card carries the NEW version regardless.
      curLine.textContent = 'Current version —';
      headLeft.appendChild(appName);
      headLeft.appendChild(curLine);

      var pill = document.createElement('span');
      pill.className = 'upd-pill';
      pill.id = 'update-pill';
      pill.setAttribute('role', 'status');
      pill.textContent = PILL.idle;

      head.appendChild(headLeft);
      head.appendChild(pill);
      el.appendChild(head);

      // ── Update card (hidden until an update is available) ──────────────────
      var card = document.createElement('div');
      card.className = 'upd-card';
      card.id = 'update-card';
      card.hidden = true;

      var cardVer = document.createElement('div');
      cardVer.className = 'upd-card-ver';
      cardVer.id = 'update-card-version';
      var cardSub = document.createElement('div');
      cardSub.className = 'upd-card-sub';
      cardSub.id = 'update-card-sub';
      cardSub.textContent = 'A new version is available.';

      var notesLabel = document.createElement('div');
      notesLabel.className = 'upd-notes-label';
      notesLabel.textContent = "What's new";
      var notesList = document.createElement('ul');
      notesList.className = 'upd-notes';
      notesList.id = 'update-notes';

      card.appendChild(cardVer);
      card.appendChild(cardSub);
      card.appendChild(notesLabel);
      card.appendChild(notesList);
      el.appendChild(card);

      // ── Progress section (shown while downloading / once ready) ────────────
      var prog = document.createElement('div');
      prog.id = 'update-progress';
      prog.hidden = true;

      var track = document.createElement('div');
      track.className = 'upd-prog-track';
      // Expose download progress to assistive tech (the visible bytes/percent
      // row is sighted-only). aria-valuenow/valuetext are updated in render().
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-label', 'Update download progress');
      var fill = document.createElement('div');
      fill.className = 'upd-prog-fill';
      fill.id = 'update-progress-fill';
      track.appendChild(fill);

      var progRow = document.createElement('div');
      progRow.className = 'upd-prog-row';
      var bytesSpan = document.createElement('span');
      bytesSpan.id = 'update-bytes';
      var pctSpan = document.createElement('span');
      pctSpan.id = 'update-percent';
      progRow.appendChild(bytesSpan);
      progRow.appendChild(pctSpan);

      var verified = document.createElement('div');
      verified.className = 'upd-verified';
      verified.id = 'update-verified';
      verified.hidden = true;
      var check = document.createElement('span');
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      var verifiedText = document.createElement('span');
      verifiedText.textContent = 'Signature verified';
      verified.appendChild(check);
      verified.appendChild(verifiedText);

      prog.appendChild(track);
      prog.appendChild(progRow);
      prog.appendChild(verified);
      el.appendChild(prog);

      // ── Action row ─────────────────────────────────────────────────────────
      // Two faces: idle/up-to-date shows "Check for updates"; ready shows the
      // primary "Restart to update" + a "Later" ghost. We keep all three buttons
      // in the DOM and toggle visibility per phase so tests can find them.
      var actionRow = document.createElement('div');
      actionRow.className = 'panel-row';

      var checkBtn = document.createElement('button');
      checkBtn.type = 'button';
      checkBtn.className = 'panel-btn';
      checkBtn.id = 'check-update-btn';
      checkBtn.textContent = 'Check for updates';
      checkBtn.setAttribute('aria-label', 'Check for updates');

      var restartBtn = document.createElement('button');
      restartBtn.type = 'button';
      restartBtn.className = 'panel-btn primary';
      restartBtn.id = 'restart-update-btn';
      restartBtn.textContent = 'Restart to update';
      restartBtn.setAttribute('aria-label', 'Restart to apply the update');
      restartBtn.hidden = true;

      var laterBtn = document.createElement('button');
      laterBtn.type = 'button';
      laterBtn.className = 'panel-btn ghost';
      laterBtn.id = 'later-update-btn';
      laterBtn.textContent = 'Later';
      laterBtn.setAttribute('aria-label', 'Apply the update later');
      laterBtn.hidden = true;

      actionRow.appendChild(checkBtn);
      actionRow.appendChild(restartBtn);
      actionRow.appendChild(laterBtn);
      el.appendChild(actionRow);

      // ── Error line (muted, never red) ──────────────────────────────────────
      var errLine = document.createElement('div');
      errLine.className = 'panel-status';
      errLine.id = 'update-error';
      errLine.setAttribute('role', 'status');
      errLine.hidden = true;
      el.appendChild(errLine);

      // ── Footer ─────────────────────────────────────────────────────────────
      var foot = document.createElement('div');
      foot.className = 'upd-foot';
      foot.textContent = 'Checks automatically in the background.';
      el.appendChild(foot);

      // ── Pure state → DOM projection ───────────────────────────────────────
      // Everything funnels through here so the panel is always a faithful
      // picture of `state`, no matter whether it changed via an event, the
      // replay snapshot, or a button click.
      function render() {
        var p = state.phase;
        pill.textContent = PILL[p] || PILL.idle;
        pill.classList.toggle('ready', p === 'ready');

        // Card visibility: any phase that knows a target version.
        var hasUpdate = (p === 'available' || p === 'downloading' ||
                         p === 'verifying' || p === 'ready') && !!state.version;
        card.hidden = !hasUpdate;
        if (hasUpdate) {
          cardVer.textContent = 'Version ' + state.version;
          renderNotes(state.notes);
        }

        // Progress section: visible while downloading and at ready.
        var showProg = (p === 'downloading' || p === 'verifying' || p === 'ready');
        prog.hidden = !showProg;
        if (showProg) {
          var pct = 0;
          if (p === 'ready') {
            pct = 100;
          } else if (state.total && state.total > 0) {
            pct = Math.max(0, Math.min(100, Math.round((state.downloaded / state.total) * 100)));
          }
          fill.style.width = pct + '%';
          if (state.total && state.total > 0) {
            bytesSpan.textContent = mb(p === 'ready' ? state.total : state.downloaded) +
              ' / ' + mb(state.total) + ' MB';
          } else {
            bytesSpan.textContent = mb(state.downloaded) + ' MB';
          }
          pctSpan.textContent = pct + '%';
          track.setAttribute('aria-valuenow', String(pct));
          track.setAttribute('aria-valuetext', bytesSpan.textContent);
          verified.hidden = (p !== 'ready');
        }

        // Action row faces.
        var ready = (p === 'ready');
        var busy = (p === 'checking' || p === 'downloading' || p === 'verifying');
        restartBtn.hidden = !ready;
        laterBtn.hidden = !ready;
        // "Check for updates" hides once we're committed to an update; it stays
        // for idle/error so the user can re-check.
        checkBtn.hidden = ready || busy || (p === 'available');
        checkBtn.disabled = busy;

        // Error line.
        errLine.hidden = (p !== 'error');

        // No dead-end at "Update found": advance a manually-discovered update
        // into the staged download so the user always sees progress, never a
        // button-less card. (See maybeAutoDownload.)
        maybeAutoDownload();
      }

      // Advance "available" → "downloading" exactly once per version. A manual
      // check (check_for_update, auto_download=false) parks at "available" with
      // no further events; without this the panel would dead-end. The background
      // discovery path is already "downloading" by the time its "available"
      // event reaches us, so the Rust in-flight guard makes this a harmless
      // no-op there. Deduped per version so render()'s repeated calls fire once.
      function maybeAutoDownload() {
        if (!ctx.hasTauri) return;
        if (state.phase !== 'available' || !state.version) return;
        if (kickedVersion === state.version) return;
        kickedVersion = state.version;
        invoke('start_update_download').catch(function () {
          /* the update://error event (or a later check) will reflect failures */
        });
      }

      function renderNotes(notes) {
        notesList.textContent = '';
        var label = notesList.previousElementSibling; // the "What's new" label
        var lines = String(notes == null ? '' : notes)
          .split('\n')
          .map(function (s) { return s.trim(); })
          .filter(function (s) { return s.length > 0; })
          .slice(0, 6); // cap to a short list
        if (lines.length === 0) {
          if (label) label.hidden = true;
          return;
        }
        if (label) label.hidden = false;
        for (var i = 0; i < lines.length; i++) {
          var li = document.createElement('li');
          li.textContent = lines[i]; // safe: remote-ish text never via innerHTML
          notesList.appendChild(li);
        }
      }

      // ── Fold an UpdateStateDto snapshot into local state ───────────────────
      function applyState(dto) {
        if (!dto || typeof dto !== 'object') return;
        // The running build version only rides the replay snapshot (events don't
        // carry it). Stamp the header line so it reads "Current version 0.0.32".
        if (typeof dto.current === 'string' && dto.current) {
          curLine.textContent = 'Current version ' + dto.current;
        }
        if (typeof dto.phase === 'string' && PHASES.indexOf(dto.phase) !== -1) {
          state.phase = dto.phase;
        }
        if ('version' in dto) state.version = dto.version != null ? String(dto.version) : null;
        if ('notes' in dto) state.notes = dto.notes != null ? String(dto.notes) : null;
        if (Number.isFinite(dto.downloaded)) state.downloaded = dto.downloaded;
        if (dto.total == null) {
          if ('total' in dto) state.total = null;
        } else if (Number.isFinite(dto.total)) {
          state.total = dto.total;
        }
        render();
      }

      // ── Fold one update://* event into local state ─────────────────────────
      // The Rust side is authoritative; we just translate each event name into
      // a phase + whatever numbers it carries. Unknown events are ignored.
      function applyEvent(name, payload) {
        var pl = payload || {};
        switch (name) {
          case 'update://checking':
            state.phase = 'checking';
            errLine.textContent = '';
            break;
          case 'update://available':
            state.phase = 'available';
            if (pl.version != null) state.version = String(pl.version);
            state.notes = pl.notes != null ? String(pl.notes) : null;
            break;
          case 'update://progress':
            state.phase = 'downloading';
            if (Number.isFinite(pl.downloaded)) state.downloaded = pl.downloaded;
            state.total = (pl.total != null && Number.isFinite(pl.total)) ? pl.total : null;
            break;
          case 'update://verifying':
            state.phase = 'verifying';
            break;
          case 'update://ready':
            state.phase = 'ready';
            if (pl.version != null) state.version = String(pl.version);
            if (pl.notes != null) state.notes = String(pl.notes);
            break;
          case 'update://none':
            state.phase = 'idle';
            break;
          case 'update://error':
            state.phase = 'error';
            errLine.textContent = pl.message ? String(pl.message) : "Update check failed.";
            break;
          default:
            return; // not ours
        }
        render();
      }

      // ── Commands (guarded — jsdom / non-Tauri degrade silently) ───────────
      function invoke(cmd) {
        if (!ctx.hasTauri) return Promise.reject(new Error('not in Tauri'));
        return ctx.invoke(cmd);
      }

      checkBtn.addEventListener('click', function () {
        if (!ctx.hasTauri) { state.phase = 'idle'; render(); return; }
        // A fresh manual check may re-trigger the staged download for the same
        // version (e.g. retry after a download error), so clear the once-guard.
        kickedVersion = null;
        // Optimistic checking state; the event stream will correct us.
        state.phase = 'checking';
        render();
        // check_for_update drives the event stream AND returns Option<UpdateInfo>;
        // we lean on the events, but fold the return value as a fallback so the
        // panel still updates even if events are somehow missed.
        invoke('check_for_update').then(function (info) {
          if (info && info.version) {
            // Only adopt if the events haven't already moved us past "available".
            if (state.phase === 'checking') {
              state.phase = 'available';
              state.version = String(info.version);
              state.notes = info.notes != null ? String(info.notes) : null;
              render();
            }
          } else if (state.phase === 'checking') {
            state.phase = 'idle';
            render();
          }
        }).catch(function (e) {
          if (state.phase === 'checking') {
            state.phase = 'error';
            errLine.textContent = String(e);
            render();
          }
        });
      });

      restartBtn.addEventListener('click', function () {
        if (!ctx.hasTauri) return;
        restartBtn.disabled = true;
        // apply_update saves the panel layout + marks reopen, installs the
        // STAGED bytes and relaunches — it never returns on success. We only
        // paint on the failure path.
        invoke('apply_update').catch(function (e) {
          restartBtn.disabled = false;
          state.phase = 'error';
          errLine.textContent = String(e);
          render();
        });
      });

      laterBtn.addEventListener('click', function () {
        // "Later" just closes the panel — the staged bytes stay held, the orb
        // pip + composer banner keep nudging. Best-effort window close.
        try {
          if (ctx.hasTauri && ctx.label) {
            ctx.invoke('close_widget', { label: ctx.label }).catch(function () {});
          }
        } catch (_) { /* best-effort */ }
      });

      // ── Replay-on-open: sync to the live snapshot immediately ─────────────
      if (ctx.hasTauri) {
        invoke('update_state').then(applyState).catch(function () { /* off-Tauri / not ready */ });
      }

      // ── Subscribe to every update://* event ────────────────────────────────
      // The panel window may lack the global event bus (older shells / tests);
      // guard the whole subscription. Each listen returns an unlisten promise.
      var unlisteners = [];
      function subscribe() {
        var ev = window.__TAURI__ && window.__TAURI__.event;
        if (!ev || typeof ev.listen !== 'function') return;
        var names = ['update://checking', 'update://available', 'update://progress',
                     'update://verifying', 'update://ready', 'update://none', 'update://error'];
        names.forEach(function (name) {
          try {
            ev.listen(name, function (e) {
              applyEvent(name, e && e.payload);
            }).then(function (un) { unlisteners.push(un); }).catch(function () {});
          } catch (_) { /* ignore */ }
        });
      }
      subscribe();

      // ── Test seam ──────────────────────────────────────────────────────────
      // Panels don't share __MoonInternals with chat, so we expose the
      // controller on the panel element. Tests drive the panel by dispatching
      // fake events (onEvent) or applying a snapshot (setState), then asserting
      // on the projected DOM. `dispose` lets a test tear listeners down.
      el.__updatesController = {
        onEvent: applyEvent,
        setState: applyState,
        getState: function () { return Object.assign({}, state); },
        dispose: function () {
          unlisteners.forEach(function (un) { try { un(); } catch (_) {} });
          unlisteners = [];
        },
      };

      // Initial paint.
      render();
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
