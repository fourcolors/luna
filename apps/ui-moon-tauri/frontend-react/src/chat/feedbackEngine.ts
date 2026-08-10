// @ts-nocheck
/**
 * feedbackEngine.ts - the whole point-at-the-UI feedback feature (stack23 S19c).
 *
 * The crosshair flow: the user points at something in the window, the engine
 * describes the target and captures a cropped screenshot, then mints a durable
 * feedback job over the wire.
 *
 * THE WHOLE CLUSTER MOVED, NOT JUST THE ENGINE. The first attempt at this
 * slice extracted `FeedbackEngine` alone and broke, because its dependency
 * closure is six feature-private helpers deep - describeTarget ->
 * feedbackSelectorPath / feedbackNearestAnchor / feedbackAppearance,
 * plus feedbackTargetLabel and cropAndEncodeFeedbackScreenshot. Those are not
 * shared utilities; they exist only for this feature, and splitting them from
 * it would have left half a feature on each side of the boundary. They were
 * also contiguous in chat.html, so the cut is a single block.
 *
 * THE SCREENSHOT CROP BUDGET CAME WITH THEM, deliberately.
 * `FEEDBACK_SCREENSHOT_TARGET_BYTES` is the one constant S19's spec names by
 * hand as a contract - an unbudgeted capture would put a full-window image on
 * the wire for every report - and it sat inside that same block.
 *
 * MOVED VERBATIM, the method established in threadDrag.ts (S17f) and
 * updateBanner.ts (S19b): every body below is character-identical to
 * chat.html's, proven by diffing the generated text against what was cut out.
 * The only structural change is the wrapper around the engine members - a
 * factory returning the same object literal, so every `this.` resolves as
 * before.
 *
 * THREE INJECTED DEPENDENCIES, and only three, now that the helpers travel
 * with it: `DOM`, `State`, and `WebSocketEngine` (of which it uses only
 * `send`). All three are reachable through the EXISTING LunaChatHost contract,
 * so this needed no new member - which matters because S19 is the slice that
 * DELETES Group C rather than growing it.
 *
 * A LESSON THIS SLICE PAID FOR: the dependency list was first derived by
 * grepping for a GUESSED set of names, which silently missed three free
 * functions. Enumerate free identifiers instead - a missed one shows up as
 * `undefined is not a function` deep inside a handler, far from the cause.
 *
 * @ts-nocheck for the same reason as the other verbatim moves, tracked by the
 * same follow-up (#525): typing the body means editing it, which forfeits the
 * proof.
 */

export interface FeedbackEngineDeps {
  readonly DOM: any
  readonly State: any
  readonly WebSocketEngine: { send: (frame: unknown) => void }
}

function feedbackSelectorPath(el) {
  try {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName &&
           node.tagName.toLowerCase() !== 'html') {
      const tag = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + node.id); break; }
      let nth = 1;
      let sib = node;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === node.tagName) nth++;
      }
      parts.unshift(tag + ':nth-of-type(' + nth + ')');
      node = node.parentElement;
    }
    return parts.join(' > ');
  } catch (_) { return ''; }
}

// Nearest ancestor (incl. self) carrying a stable handle: an [id] or any
// data-* attribute. Stable containers (#title-bar, .composer-bar, …) survive
// re-render, so this is the DURABLE anchor for the note.
function feedbackNearestAnchor(el) {
  try {
    let node = el;
    while (node && node.nodeType === 1) {
      const dataAttrs = {};
      if (node.attributes) {
        for (const a of Array.from(node.attributes)) {
          if (a.name && a.name.indexOf('data-') === 0) dataAttrs[a.name] = a.value;
        }
      }
      if (node.id || Object.keys(dataAttrs).length > 0) {
        return {
          tag: node.tagName ? node.tagName.toLowerCase() : '',
          id: node.id || null,
          dataAttrs: dataAttrs,
        };
      }
      node = node.parentElement;
    }
  } catch (_) { /* fall through */ }
  return null;
}

// Current appearance (palette/theme/chrome/…). Prefers the live
// LunaAppearance API; falls back to the documentElement dataset so it works
// before moon-appearance.js runs and in bare jsdom.
function feedbackAppearance() {
  try {
    if (window.LunaAppearance && typeof window.LunaAppearance.get === 'function') {
      return window.LunaAppearance.get();
    }
  } catch (_) { /* fall through */ }
  try {
    const d = (document.documentElement && document.documentElement.dataset) || {};
    return {
      palette: d.palette || null, theme: d.theme || null,
      chrome: d.chrome || null, skin: d.skin || null,
      grain: d.grain || null, font: d.font || null,
      fontSize: d.fontSize || null,
    };
  } catch (_) { return {}; }
}

// Full JSON-serializable description of the pointed-at element. Every read
// is individually tolerant so one missing field never aborts the capture.
// textContent only (never innerHTML), truncated — limits transcript leakage.
function describeTarget(el) {
  const t = { selectorStability: 'best-effort', capturedAt: Date.now() };
  try { t.selector = feedbackSelectorPath(el); } catch (_) { t.selector = ''; }
  try { t.anchor = feedbackNearestAnchor(el); } catch (_) { t.anchor = null; }
  try { t.tag = (el && el.tagName) ? el.tagName.toLowerCase() : ''; } catch (_) { t.tag = ''; }
  try { t.id = (el && el.id) || null; } catch (_) { t.id = null; }
  try { t.classes = (el && el.classList) ? Array.from(el.classList) : []; } catch (_) { t.classes = []; }
  try {
    t.role = (el && (el.getAttribute('role') || el.getAttribute('aria-label'))) || null;
  } catch (_) { t.role = null; }
  try {
    const raw = ((el && el.textContent) ? el.textContent : '').replace(/\s+/g, ' ').trim();
    t.textLength = raw.length;
    t.text = raw.length > 120 ? (raw.slice(0, 120) + '…') : raw;
  } catch (_) { t.text = ''; t.textLength = 0; }
  try {
    const r = (el && el.getBoundingClientRect) ? el.getBoundingClientRect() : null;
    t.rect = r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
  } catch (_) { t.rect = null; }
  let windowLabel = null;
  try {
    if (window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow) {
      windowLabel = window.__TAURI__.window.getCurrentWindow().label || null;
    }
  } catch (_) { windowLabel = null; }
  try {
    const path = (location.pathname || '').split('/');
    t.route = {
      page: path[path.length - 1] || 'chat.html',
      windowLabel: windowLabel,
      threadId: new URLSearchParams(location.search).get('thread') || null,
      url: location.href,
    };
  } catch (_) { t.route = { page: 'chat.html', windowLabel: windowLabel, threadId: null, url: '' }; }
  try { t.appearance = feedbackAppearance(); } catch (_) { t.appearance = {}; }
  try {
    t.viewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };
  } catch (_) { t.viewport = { w: 0, h: 0, dpr: 1 }; }
  return t;
}

// Short human label for the target chip.
function feedbackTargetLabel(t) {
  if (!t) return '';
  if (t.id) return '#' + t.id;
  let s = t.tag || 'element';
  if (t.classes && t.classes.length) s += '.' + t.classes.slice(0, 2).join('.');
  if (t.text) s += ' — "' + (t.text.length > 40 ? (t.text.slice(0, 40) + '…') : t.text) + '"';
  return s;
}

// Client-side target size for a cropped feedback screenshot. PNG-only
// deliberately: WKWebView's `canvas.toDataURL('image/webp')` support is
// uncertain across macOS versions, while PNG is universally supported.
// PNG has no quality knob, so downscaling the output dimensions is the
// only lever available to stay under this budget — see the retry loop
// in cropAndEncodeFeedbackScreenshot below. This is well under the
// server's SCREENSHOT_MAX_BASE64_CHARS guard (see server.ts).
const FEEDBACK_SCREENSHOT_TARGET_BYTES = 400000; // ~400KB

// Pure: crop `img` (a full-window PNG captured natively) to the CSS-px
// `rectCss` of the picked element, scaled by devicePixelRatio, and
// re-encode as PNG — downscaling the output size if needed to stay
// near FEEDBACK_SCREENSHOT_TARGET_BYTES. Returns null on any failure
// (never throws) so the caller can fall back to no screenshot.
function cropAndEncodeFeedbackScreenshot(img, rectCss, dpr) {
  try {
    const sx = Math.max(0, Math.round(rectCss.x * dpr));
    const sy = Math.max(0, Math.round(rectCss.y * dpr));
    let sw = Math.max(1, Math.round(rectCss.w * dpr));
    let sh = Math.max(1, Math.round(rectCss.h * dpr));
    sw = Math.min(sw, img.naturalWidth - sx);
    sh = Math.min(sh, img.naturalHeight - sy);
    if (sw <= 0 || sh <= 0) return null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    let outW = sw, outH = sh;
    let dataUrl = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      canvas.width = outW;
      canvas.height = outH;
      ctx.clearRect(0, 0, outW, outH);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
      dataUrl = canvas.toDataURL('image/png');
      const approxBytes = Math.ceil((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4);
      if (approxBytes <= FEEDBACK_SCREENSHOT_TARGET_BYTES || (outW <= 60 || outH <= 60)) break;
      outW = Math.max(60, Math.round(outW * 0.75));
      outH = Math.max(60, Math.round(outH * 0.75));
    }
    if (!dataUrl) return null;
    const comma = dataUrl.indexOf(',');
    const base64 = dataUrl.slice(comma + 1);
    return { base64: base64, width: outW, height: outH, bytes: Math.ceil(base64.length * 3 / 4) };
  } catch (_) {
    return null;
  }
}
export function createFeedbackEngine(deps: FeedbackEngineDeps) {
  const { DOM, State, WebSocketEngine } = deps
  return {
  _enabled: false,   // server advertises the `feedback` capability
  _picking: false,   // picker mode active
  _target: null,     // describeTarget() of the picked element
  _reqId: null,      // correlates feedback-ack
  _hideTimer: null,
  _onMove: null,
  _onClick: null,
  _onKey: null,

  applyCapability(on) {
    this._enabled = !!on;
    if (!this._enabled) { this.cancelPicker(); this.hidePanel(); }
    if (DOM.feedbackBtn) DOM.feedbackBtn.hidden = !this._enabled;
  },

  togglePicker() {
    if (!this._enabled) return;
    if (this._picking) { this.cancelPicker(); return; }
    this.enterPicker();
  },

  enterPicker() {
    if (!this._enabled || this._picking) return;
    this._picking = true;
    this._target = null;
    if (DOM.feedbackBtn) DOM.feedbackBtn.classList.add('active');
    if (DOM.feedbackPickerOverlay) DOM.feedbackPickerOverlay.hidden = false;
    this.hidePanel();  // a fresh pick supersedes any open composer

    this._onMove = (e) => this._trackHighlight(e);
    this._onClick = (e) => this._pick(e);
    this._onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancelPicker(); }
    };
    // window CAPTURE phase: fires before the app's own (bubble) listeners —
    // including the window-level Escape→VoiceEngine handler — so a pick
    // pre-empts activation and Escape cancels the picker without leaking to
    // voice. Torn down precisely in cancelPicker().
    window.addEventListener('pointermove', this._onMove, true);
    window.addEventListener('click', this._onClick, true);
    window.addEventListener('keydown', this._onKey, true);
  },

  cancelPicker() {
    this._picking = false;
    if (DOM.feedbackBtn) DOM.feedbackBtn.classList.remove('active');
    if (DOM.feedbackPickerOverlay) DOM.feedbackPickerOverlay.hidden = true;
    if (this._onMove) { window.removeEventListener('pointermove', this._onMove, true); this._onMove = null; }
    if (this._onClick) { window.removeEventListener('click', this._onClick, true); this._onClick = null; }
    if (this._onKey) { window.removeEventListener('keydown', this._onKey, true); this._onKey = null; }
  },

  // Is `el` part of our own picker/composer chrome? Then skip it.
  _isOwnChrome(el) {
    if (!el) return true;
    try {
      if (DOM.feedbackBtn && (el === DOM.feedbackBtn || DOM.feedbackBtn.contains(el))) return true;
      if (DOM.feedbackPickerOverlay && (el === DOM.feedbackPickerOverlay || DOM.feedbackPickerOverlay.contains(el))) return true;
      if (DOM.feedbackPanel && (el === DOM.feedbackPanel || DOM.feedbackPanel.contains(el))) return true;
    } catch (_) { /* ignore */ }
    return false;
  },

  _rawElementAt(e) {
    try { return document.elementFromPoint(e.clientX, e.clientY); } catch (_) { return null; }
  },

  _trackHighlight(e) {
    if (!this._picking) return;
    const box = DOM.feedbackPickerHighlight;
    if (!box) return;
    const raw = this._rawElementAt(e);
    const el = this._isOwnChrome(raw) ? null : raw;
    if (!el) { box.style.width = '0px'; box.style.height = '0px'; return; }
    try {
      const r = el.getBoundingClientRect();
      box.style.top = r.top + 'px';
      box.style.left = r.left + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
    } catch (_) { /* ignore */ }
  },

  _pick(e) {
    if (!this._picking) return;
    const raw = this._rawElementAt(e);
    // Pre-empt the app: this click SELECTS, it must not activate anything.
    try { e.preventDefault(); e.stopPropagation(); } catch (_) { /* ignore */ }
    if (typeof e.stopImmediatePropagation === 'function') {
      try { e.stopImmediatePropagation(); } catch (_) { /* ignore */ }
    }
    // Re-click on the feedback button toggles the picker OFF.
    if (DOM.feedbackBtn && raw && (raw === DOM.feedbackBtn || DOM.feedbackBtn.contains(raw))) {
      this.cancelPicker();
      return;
    }
    if (this._isOwnChrome(raw)) return;  // overlay/composer — ignore, stay picking
    this._target = describeTarget(raw);
    this.cancelPicker();
    this.openPanel();
  },

  openPanel() {
    if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
    this._reqId = null;
    const label = feedbackTargetLabel(this._target);
    if (DOM.feedbackTargetChip) {
      DOM.feedbackTargetChip.textContent = label ? ('Element: ' + label) : '';
      DOM.feedbackTargetChip.hidden = !label;
    }
    this.setStatus('', null);
    if (DOM.feedbackInput) {
      DOM.feedbackInput.value = '';
      try { DOM.feedbackInput.focus(); } catch (_) { /* non-fatal in jsdom */ }
    }
    if (DOM.feedbackSubmit) DOM.feedbackSubmit.disabled = true;
    if (DOM.feedbackPanel) DOM.feedbackPanel.hidden = false;
  },

  onInput() {
    if (!DOM.feedbackSubmit) return;
    const v = ((DOM.feedbackInput && DOM.feedbackInput.value) || '').trim();
    DOM.feedbackSubmit.disabled = v.length === 0;
  },

  async submit() {
    const note = ((DOM.feedbackInput && DOM.feedbackInput.value) || '').trim();
    if (!note) { this.setStatus('Type a note first.', 'error'); return; }
    if (!this._target) { this.setStatus('Pick an element first.', 'error'); return; }
    if (!(State.ws && State.ws.readyState === WebSocket.OPEN)) {
      this.setStatus('Not connected.', 'error');
      return;
    }
    const reqId = 'fb-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    this._reqId = reqId;
    const t = this._target;
    // Copilot review finding: reject empty selector (no actionable pointer)
    const selector = (t.selector || '').trim();
    if (!selector) {
      this.setStatus('Failed to identify element — try clicking a different one.', 'error');
      return;
    }
    const frame = {
      type: 'feedback-submit',
      requestId: reqId,
      ...(State.activeThreadId ? { threadId: State.activeThreadId } : {}),
      note: note,
      target: {
        selector: selector,
        tag: t.tag || '',
        ...(t.id ? { id: t.id } : {}),
        ...(t.classes && t.classes.length ? { classes: t.classes } : {}),
        ...(t.text ? { text: t.text } : {}),
        ...(t.rect ? { rect: t.rect } : {}),
        context: {
          anchor: t.anchor || null,
          route: t.route || null,
          appearance: t.appearance || null,
          viewport: t.viewport || null,
          textLength: t.textLength || 0,
          selectorStability: t.selectorStability || 'best-effort',
          capturedAt: t.capturedAt || null,
        },
      },
      page: (t.route && t.route.page) || 'chat.html',
      ...(State.appVersion ? { appVersion: State.appVersion } : {}),
      clientTs: Date.now(),
    };
    if (DOM.feedbackSubmit) DOM.feedbackSubmit.disabled = true;
    this.setStatus('Sending…', 'info');
    // Screenshot capture is ALWAYS best-effort: any failure (no Tauri
    // runtime, no rect, Screen-Recording permission denied, capture/crop
    // error) must never block or delay submitting the note beyond a
    // normal await — _captureScreenshot never throws.
    const shot = await this._captureScreenshot(t);
    if (shot && shot.base64) {
      frame.screenshot = shot.base64;
    }
    WebSocketEngine.send(frame);
  },

  // Best-effort native window screenshot of the picked element. Returns
  // null (never throws) on any failure so submit() always falls back to
  // sending the note without a screenshot.
  async _captureScreenshot(target) {
    try {
      if (!(window.__TAURI__ && window.__TAURI__.core) || !target || !target.rect) return null;
      const res = await window.__TAURI__.core.invoke('capture_window_screenshot');
      if (!res || typeof res.base64 !== 'string' || !res.base64) return null;
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = 'data:image/png;base64,' + res.base64;
      });
      return cropAndEncodeFeedbackScreenshot(img, target.rect, window.devicePixelRatio || 1);
    } catch (_) {
      return null; // best-effort — never block the note
    }
  },

  cancel() {
    this._reqId = null;
    this.hidePanel();
  },

  setStatus(msg, kind) {
    const el = DOM.feedbackStatus;
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
    el.classList.remove('error', 'ok');
    if (kind === 'error') el.classList.add('error');
    else if (kind === 'ok') el.classList.add('ok');
  },

  handleAck(frame) {
    if (!frame || frame.requestId !== this._reqId) return;  // ignore stale/unmatched
    this._reqId = null;
    this.setStatus(
      frame.ok ? (frame.message || 'Thanks — feedback recorded.')
               : (frame.message || 'Could not record feedback.'),
      frame.ok ? 'ok' : 'error',
    );
    if (frame.ok) {
      if (this._hideTimer) clearTimeout(this._hideTimer);
      this._hideTimer = setTimeout(() => { this._hideTimer = null; this.hidePanel(); }, 1500);
    } else if (DOM.feedbackSubmit) {
      DOM.feedbackSubmit.disabled = false;  // leave the note; let them retry
    }
  },

  hidePanel() {
    if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
    if (DOM.feedbackPanel) DOM.feedbackPanel.hidden = true;
    if (DOM.feedbackInput) DOM.feedbackInput.value = '';
    this.setStatus('', null);
    this._reqId = null;
    this._target = null;
  },
  }
}

// Test hooks. chat.html used to expose these two on `window.__MoonInternals`
// for the feedback suites; now that they live here, the exposure happens on
// the module side instead (see main-chat.tsx). Exported ONLY for that - no
// production code outside this file calls them.
export { describeTarget, cropAndEncodeFeedbackScreenshot }
