/**
 * panels/settings-voice.js — Voice settings panel.
 *
 * Ports the voice tabpanel from index.html (data-tabpanel="voice") and the
 * relevant parts of VoiceEngine into the standalone panel module shape.
 * Speech pipeline logic (mic PTT, transcript→send, spoken-reply accumulator)
 * is NOT included — that lives in the hub window. This panel owns only the
 * settings UI: mode, speak-replies, voice picker, silence hang, and the model
 * download row.
 *
 * Tauri commands used:
 *   voice_status()        → { modelPresent?, model_present?, state?, mode? }
 *   voice_set_mode({ mode })   → { mode? } | null
 *   voice_set_voice({ id })    → void
 *   voice_set_config({ silenceHangMs }) → void
 *   voice_list_voices()   → [{ id, name?, quality? }] | null
 *   voice_ensure_model()  → void (resolves when model is present)
 *
 * Tauri events listened via ctx.win.listen():
 *   voice-state           payload: { state, mode, level? }
 *   voice-model-progress  payload: { done?, error?, downloadedBytes?, totalBytes? }
 *
 * localStorage keys (match VoiceEngine exactly):
 *   luna_voice_mode          'off' | 'ptt' | 'auto'  (default 'off')
 *   luna_voice_speak_replies '1' | '0'               (default '1'/true)
 *   luna_voice_id            voice id string          (absent = system default)
 *   luna_voice_silence_hang_ms  numeric string        (default '600')
 */
;(function (g) {
  'use strict';
  g.LunaPanelTypes = g.LunaPanelTypes || {};

  var MODES = ['off', 'ptt', 'auto'];

  // ── localStorage helpers ─────────────────────────────────────────────────
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (_) {} }

  // ── Safe text helpers ────────────────────────────────────────────────────
  function setText(el, t) { if (el) el.textContent = t; }

  // ── MB formatter (mirrors VoiceEngine.onModelProgress) ──────────────────
  function mb(n) { return (n / (1024 * 1024)).toFixed(1); }

  g.LunaPanelTypes['settings.voice'] = {
    title: 'Voice',

    render: function (el, ctx) {

      // ── Availability notice (shown when voice_status rejects / unavailable)
      var notice = document.createElement('div');
      notice.className = 'notice';
      notice.id = 'voice-unavailable-note';
      notice.textContent = 'Voice is not available in this build.';
      notice.hidden = true;
      el.appendChild(notice);

      // ── Voice mode segmented control ────────────────────────────────────
      var modeRow = document.createElement('div');
      modeRow.className = 'panel-row';

      var modeLabel = document.createElement('span');
      modeLabel.style.cssText = 'color:var(--text);font-size:0.8rem;font-weight:600;min-width:100px;';
      modeLabel.textContent = 'Voice mode';
      modeRow.appendChild(modeLabel);

      var modeSeg = document.createElement('div');
      modeSeg.id = 'voice-mode-seg';
      modeSeg.setAttribute('role', 'radiogroup');
      modeSeg.setAttribute('aria-label', 'Voice mode');
      modeSeg.style.cssText = 'display:flex;gap:4px;';

      var modeLabels = [['off', 'Off'], ['ptt', 'Push-to-talk'], ['auto', 'Hands-free']];
      var modeBtns = {};
      for (var mi = 0; mi < modeLabels.length; mi++) {
        (function (modeVal, modeText) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'panel-btn voice-mode-btn';
          b.setAttribute('data-voice-mode', modeVal);
          b.setAttribute('role', 'radio');
          b.setAttribute('aria-checked', 'false');
          b.textContent = modeText;
          b.style.cssText = 'padding:4px 10px;font-size:0.75rem;';
          modeSeg.appendChild(b);
          modeBtns[modeVal] = b;
        })(modeLabels[mi][0], modeLabels[mi][1]);
      }
      modeRow.appendChild(modeSeg);
      el.appendChild(modeRow);

      // ── Speak replies checkbox row ───────────────────────────────────────
      var speakRow = document.createElement('div');
      speakRow.className = 'panel-row';

      var speakLabel = document.createElement('label');
      speakLabel.style.cssText = 'display:flex;align-items:center;gap:8px;color:var(--text);font-size:0.8rem;cursor:pointer;';

      var speakCb = document.createElement('input');
      speakCb.type = 'checkbox';
      speakCb.id = 'voice-speak-replies-toggle';

      var speakText = document.createElement('span');
      speakText.textContent = 'Speak replies';
      speakLabel.appendChild(speakCb);
      speakLabel.appendChild(speakText);
      speakRow.appendChild(speakLabel);
      el.appendChild(speakRow);

      // ── Voice picker ─────────────────────────────────────────────────────
      var voiceRow = document.createElement('div');
      voiceRow.className = 'panel-row';

      var voicePickLabel = document.createElement('span');
      voicePickLabel.style.cssText = 'color:var(--text);font-size:0.8rem;font-weight:600;min-width:100px;';
      voicePickLabel.textContent = 'Voice';
      voiceRow.appendChild(voicePickLabel);

      var voiceSelect = document.createElement('select');
      voiceSelect.id = 'voice-voice-select';
      voiceSelect.style.cssText = 'background:rgba(138,180,248,0.08);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:0.8rem;';
      var defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = 'System default';
      voiceSelect.appendChild(defOpt);
      voiceRow.appendChild(voiceSelect);
      el.appendChild(voiceRow);

      // ── Silence hang slider ──────────────────────────────────────────────
      var silenceRow = document.createElement('div');
      silenceRow.className = 'panel-row';

      var silenceLabel = document.createElement('span');
      silenceLabel.style.cssText = 'color:var(--text);font-size:0.8rem;font-weight:600;min-width:100px;';
      silenceLabel.textContent = 'Silence hang';
      silenceRow.appendChild(silenceLabel);

      var silenceSlider = document.createElement('input');
      silenceSlider.type = 'range';
      silenceSlider.id = 'voice-silence-slider';
      silenceSlider.min = '300';
      silenceSlider.max = '1200';
      silenceSlider.step = '50';
      silenceSlider.setAttribute('aria-label', 'Silence hang in milliseconds');
      silenceRow.appendChild(silenceSlider);

      var silenceValue = document.createElement('span');
      silenceValue.id = 'voice-silence-value';
      silenceValue.style.cssText = 'font-size:0.78rem;color:var(--muted);min-width:36px;';
      silenceRow.appendChild(silenceValue);

      var silenceUnit = document.createElement('span');
      silenceUnit.style.cssText = 'font-size:0.78rem;color:var(--muted);';
      silenceUnit.textContent = 'ms';
      silenceRow.appendChild(silenceUnit);
      el.appendChild(silenceRow);

      // ── Speech model row (status + progress bar + download button) ───────
      var modelRow = document.createElement('div');
      modelRow.className = 'panel-row';
      modelRow.style.cssText = 'flex-wrap:wrap;gap:8px;';

      var modelInfoCol = document.createElement('div');
      modelInfoCol.style.cssText = 'display:flex;flex-direction:column;gap:4px;flex:1;min-width:0;';

      var modelLabelSpan = document.createElement('span');
      modelLabelSpan.style.cssText = 'color:var(--text);font-size:0.8rem;font-weight:600;';
      modelLabelSpan.textContent = 'Speech model';
      modelInfoCol.appendChild(modelLabelSpan);

      var modelStatus = document.createElement('span');
      modelStatus.id = 'voice-model-status';
      modelStatus.className = 'panel-status';
      modelStatus.textContent = 'Checking…';
      modelInfoCol.appendChild(modelStatus);

      var modelProgress = document.createElement('div');
      modelProgress.id = 'voice-model-progress';
      modelProgress.style.cssText = 'width:100%;height:4px;background:var(--border);border-radius:2px;overflow:hidden;';
      modelProgress.hidden = true;

      var modelProgressFill = document.createElement('div');
      modelProgressFill.id = 'voice-model-progress-fill';
      modelProgressFill.style.cssText = 'height:100%;width:0%;background:var(--accent);border-radius:2px;transition:width 0.15s;';
      modelProgress.appendChild(modelProgressFill);
      modelInfoCol.appendChild(modelProgress);
      modelRow.appendChild(modelInfoCol);

      var modelDownloadBtn = document.createElement('button');
      modelDownloadBtn.type = 'button';
      modelDownloadBtn.className = 'panel-btn';
      modelDownloadBtn.id = 'voice-model-download';
      modelDownloadBtn.textContent = 'Download';
      modelDownloadBtn.hidden = true;
      modelRow.appendChild(modelDownloadBtn);
      el.appendChild(modelRow);

      // ── State ─────────────────────────────────────────────────────────────
      var mode = 'off';
      var silenceHangMs = 600;
      var voiceId = '';
      var available = false;

      // ── Load + reflect initial settings from localStorage ─────────────────
      function loadSettings() {
        var m = lsGet('luna_voice_mode');
        mode = (m === 'ptt' || m === 'auto') ? m : 'off';

        var speakVal = lsGet('luna_voice_speak_replies');
        speakCb.checked = (speakVal !== '0');

        voiceId = lsGet('luna_voice_id') || '';

        var hang = parseInt(lsGet('luna_voice_silence_hang_ms') || '', 10);
        silenceHangMs = Number.isFinite(hang) ? Math.max(300, Math.min(1200, hang)) : 600;

        reflectSettings();
      }

      function reflectSettings() {
        // Mode buttons
        for (var v in modeBtns) {
          var on = (v === mode);
          modeBtns[v].classList.toggle('active', on);
          modeBtns[v].setAttribute('aria-checked', String(on));
          if (on) {
            modeBtns[v].style.background = 'var(--accent)';
            modeBtns[v].style.color = '#0a0e1c';
          } else {
            modeBtns[v].style.background = '';
            modeBtns[v].style.color = '';
          }
        }
        // Silence slider + value display
        silenceSlider.value = String(silenceHangMs);
        setText(silenceValue, String(silenceHangMs));
        // Voice select: keep a saved-but-unlisted pick visible
        if (voiceId && !Array.from(voiceSelect.options).some(function (o) { return o.value === voiceId; })) {
          var savedOpt = document.createElement('option');
          savedOpt.value = voiceId;
          savedOpt.textContent = voiceId + ' (saved)';
          voiceSelect.appendChild(savedOpt);
        }
        voiceSelect.value = voiceId;
      }

      // ── Disable / enable controls (mirrors VoiceEngine.setAvailable) ──────
      function setAvailable(av) {
        available = !!av;
        var dis = !available;
        var controls = [speakCb, voiceSelect, silenceSlider, modelDownloadBtn];
        for (var i = 0; i < controls.length; i++) {
          if (controls[i]) controls[i].disabled = dis;
        }
        var btns = modeSeg.querySelectorAll('.voice-mode-btn');
        for (var j = 0; j < btns.length; j++) { btns[j].disabled = dis; }
        if (!available) {
          setText(modelStatus, 'Unavailable in this build');
          notice.hidden = false;
        }
      }

      // ── Model status helpers (mirrors VoiceEngine._markModelReady/Missing) ─
      function markModelReady() {
        setText(modelStatus, 'Model ready ✓');
        modelDownloadBtn.hidden = true;
        modelProgress.hidden = true;
      }

      function markModelMissing() {
        setText(modelStatus, 'Speech model not downloaded yet');
        modelDownloadBtn.hidden = false;
      }

      // ── applyStatus (mirrors VoiceEngine.applyStatus) ────────────────────
      function applyStatus(s) {
        var present = !!(s && (s.modelPresent === true || s.model_present === true));
        if (present) { markModelReady(); } else { markModelMissing(); }
      }

      // ── Populate voice picker (mirrors VoiceEngine.populateVoices) ────────
      function populateVoices() {
        return ctx.invoke('voice_list_voices').then(function (voices) {
          if (!Array.isArray(voices)) return;
          // Clear and rebuild (keep "System default" sentinel)
          while (voiceSelect.options.length) voiceSelect.remove(0);
          var d = document.createElement('option');
          d.value = '';
          d.textContent = 'System default';
          voiceSelect.appendChild(d);
          for (var i = 0; i < voices.length; i++) {
            var v = voices[i];
            if (!v || typeof v.id !== 'string' || !v.id) continue;
            var o = document.createElement('option');
            o.value = v.id;
            var name = (typeof v.name === 'string' && v.name) ? v.name : v.id;
            var quality = (typeof v.quality === 'string' && v.quality && v.quality !== 'default')
              ? ' · ' + v.quality : '';
            o.textContent = name + quality;
            voiceSelect.appendChild(o);
          }
          if (voiceId && !Array.from(voiceSelect.options).some(function (o) { return o.value === voiceId; })) {
            var savedOpt = document.createElement('option');
            savedOpt.value = voiceId;
            savedOpt.textContent = voiceId + ' (saved)';
            voiceSelect.appendChild(savedOpt);
          }
          voiceSelect.value = voiceId;
        }).catch(function () {});
      }

      // ── Tauri event listeners (guarded — panel window may lack listen) ────
      function subscribeEvents() {
        if (!ctx.win || typeof ctx.win.listen !== 'function') return;
        ctx.win.listen('voice-state', function (ev) {
          var p = (ev && ev.payload) ? ev.payload : {};
          var state = (p && typeof p.state === 'string') ? p.state : 'off';
          // Panel doesn't drive the moon visual, but we can update model row
          // on a future 'state' that indicates model just became ready.
          // (No visible state indicator in this panel — reserved for future.)
          void state;
        }).catch(function () {});
        ctx.win.listen('voice-model-progress', function (ev) {
          var p = (ev && ev.payload) ? ev.payload : {};
          if (p && p.error) {
            setText(modelStatus, 'Download failed: ' + p.error);
            modelProgress.hidden = true;
            modelDownloadBtn.hidden = false;
            return;
          }
          if (p && p.done) {
            markModelReady();
            return;
          }
          var got = (p && Number.isFinite(p.downloadedBytes)) ? p.downloadedBytes : 0;
          var total = (p && Number.isFinite(p.totalBytes)) ? p.totalBytes : 0;
          modelProgress.hidden = false;
          modelDownloadBtn.hidden = true;
          if (total > 0) {
            var pct = Math.max(0, Math.min(100, Math.round((got / total) * 100)));
            modelProgressFill.style.width = pct + '%';
          }
          setText(modelStatus, total > 0
            ? 'Downloading… ' + mb(got) + ' / ' + mb(total) + ' MB'
            : 'Downloading… ' + mb(got) + ' MB');
        }).catch(function () {});
      }

      // ── Wire controls ─────────────────────────────────────────────────────
      modeSeg.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest && e.target.closest('.voice-mode-btn');
        if (!btn || btn.disabled) return;
        var m = btn.getAttribute('data-voice-mode');
        if (!MODES.includes(m)) return;
        mode = m;
        lsSet('luna_voice_mode', m);
        reflectSettings();
        if (available) {
          ctx.invoke('voice_set_mode', { mode: m }).catch(function () {});
        }
      });

      speakCb.addEventListener('change', function () {
        lsSet('luna_voice_speak_replies', speakCb.checked ? '1' : '0');
      });

      voiceSelect.addEventListener('change', function () {
        var id = voiceSelect.value;
        voiceId = id;
        if (id) { lsSet('luna_voice_id', id); } else { lsDel('luna_voice_id'); }
        if (available) {
          ctx.invoke('voice_set_voice', { id: id }).catch(function () {});
        }
      });

      silenceSlider.addEventListener('input', function () {
        setText(silenceValue, silenceSlider.value);
      });

      silenceSlider.addEventListener('change', function () {
        var v = parseInt(silenceSlider.value, 10);
        silenceHangMs = Number.isFinite(v) ? Math.max(300, Math.min(1200, v)) : 600;
        lsSet('luna_voice_silence_hang_ms', String(silenceHangMs));
        if (available) {
          ctx.invoke('voice_set_config', { silenceHangMs: silenceHangMs }).catch(function () {});
        }
      });

      modelDownloadBtn.addEventListener('click', function () {
        if (!available) return;
        modelDownloadBtn.hidden = true;
        modelProgress.hidden = false;
        setText(modelStatus, 'Downloading…');
        ctx.invoke('voice_ensure_model').then(function () {
          markModelReady();
          // Retry persisted mode after model download (mirrors VoiceEngine).
          if (mode !== 'off') {
            ctx.invoke('voice_set_mode', { mode: mode }).catch(function () {});
          }
        }).catch(function (e) {
          setText(modelStatus, 'Download failed — try again');
          modelProgress.hidden = true;
          modelDownloadBtn.hidden = false;
        });
      });

      // ── Boot: probe voice availability ────────────────────────────────────
      loadSettings();

      if (!ctx.hasTauri) {
        setAvailable(false);
        return;
      }

      ctx.invoke('voice_status').then(function (status) {
        setAvailable(true);
        applyStatus(status);
        subscribeEvents();
        // Re-apply persisted settings to the Rust core (mirrors applyPersisted)
        ctx.invoke('voice_set_mode', { mode: mode }).catch(function () {});
        if (voiceId) ctx.invoke('voice_set_voice', { id: voiceId }).catch(function () {});
        ctx.invoke('voice_set_config', { silenceHangMs: silenceHangMs }).catch(function () {});
        return populateVoices();
      }).catch(function () {
        setAvailable(false);
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
