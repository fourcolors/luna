// @ts-nocheck
/**
 * updateBanner.ts - the in-chat staged-update nudge (stack23 S19b).
 *
 * A slim accent bar inserted directly before `.composer-input-wrap`, so it
 * lands above the textarea where the user's eye already is. It appears only
 * once the Rust updater has DOWNLOADED AND VERIFIED a build (`update://ready`);
 * the download/apply split is deliberate - nothing restarts on its own, the
 * user presses Restart when ready.
 *
 * Dismissal persists `luna_update_dismissed = <version>`, so a version waved
 * off stays hidden until a NEWER build lands. Updates are good news: accent
 * palette, gentle copy, never alarming.
 *
 * MOVED VERBATIM, same method as threadDrag.ts (S17f): the member bodies below
 * are character-identical to chat.html's, verified by diffing the generated
 * text against what was cut out. The only structural change is the wrapper -
 * a factory returning the same object literal, so every `this.` still resolves
 * exactly as before.
 *
 * ONE INJECTED DEPENDENCY. Everything this touches is a real global
 * (`document`, `localStorage`, `window.__TAURI__`) EXCEPT `Logger`, which is
 * chat.html-private, so it arrives through `deps`. Notably it needs no `DOM`
 * object at all - `_anchor()` queries the document itself - which is why this
 * one has no outbound edges in the sense of the OUTBOUND-EDGE RULE.
 *
 * @ts-nocheck for the same reason as threadDrag.ts and tracked by the same
 * follow-up (#525): the body is untyped JS that never passed through a tsc
 * program, and typing it means editing it, which would forfeit the verbatim
 * proof this move rests on.
 */

export interface UpdateBannerDeps {
  readonly Logger: { warn: (...a: any[]) => void }
}

export function createUpdateBanner(deps: UpdateBannerDeps) {
  const { Logger } = deps
  return {
  _el: null,
  _version: null,

  // Where the bar lives: directly before .composer-input-wrap inside the
  // flex-column .chat-input-area. Returns null if the composer isn't present
  // (e.g. a stripped test DOM) so callers degrade silently.
  _anchor() {
    return document.querySelector('.chat-input-area .composer-input-wrap')
      || document.querySelector('.composer-input-wrap');
  },

  // True when this version was explicitly dismissed and no newer one exists.
  _isDismissed(version) {
    try {
      const seen = localStorage.getItem('luna_update_dismissed');
      // Hidden only while the dismissed version is still the newest one we
      // know about; a different (newer) version re-shows the bar.
      return !!seen && !!version && seen === version;
    } catch (_) { return false; }
  },

  // Build (once) and reveal the bar for `frame.version`. No-op when dismissed
  // for this exact version. Re-showing for a NEWER version refreshes the copy.
  onReady(frame) {
    const f = frame || {};
    const version = (f && f.version != null) ? String(f.version) : '';
    if (this._isDismissed(version)) return;

    const anchor = this._anchor();
    if (!anchor || !anchor.parentNode) return; // no composer → nothing to do

    this._version = version;

    // Reuse an existing bar (idempotent re-show on a newer version), else mint.
    let bar = this._el;
    if (!bar || !document.body.contains(bar)) {
      bar = document.createElement('div');
      bar.className = 'update-banner';
      bar.id = 'update-banner';

      const dot = document.createElement('div');
      dot.className = 'ub-dot';
      dot.setAttribute('aria-hidden', 'true');

      const text = document.createElement('div');
      text.className = 'ub-text';
      const title = document.createElement('div');
      title.className = 'ub-title';
      const sub = document.createElement('div');
      sub.className = 'ub-sub';
      // textContent only — release version/notes are remote-ish data.
      sub.textContent = 'Downloaded and verified — restart to apply';
      text.appendChild(title);
      text.appendChild(sub);

      const actions = document.createElement('div');
      actions.className = 'ub-actions';
      const restart = document.createElement('button');
      restart.type = 'button';
      restart.className = 'ub-btn primary';
      restart.textContent = 'Restart';
      restart.addEventListener('click', () => this.onApply());
      const whatsNew = document.createElement('button');
      whatsNew.type = 'button';
      whatsNew.className = 'ub-btn';
      whatsNew.textContent = "What's new";
      whatsNew.addEventListener('click', () => this._openUpdates());
      actions.appendChild(restart);
      actions.appendChild(whatsNew);

      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'ub-dismiss';
      dismiss.setAttribute('aria-label', 'Dismiss update notice');
      dismiss.textContent = '×'; // ×
      dismiss.addEventListener('click', () => this.dismiss(this._version));

      bar.appendChild(dot);
      bar.appendChild(text);
      bar.appendChild(actions);
      bar.appendChild(dismiss);

      // Insert as a sibling directly BEFORE the input wrap (above the input).
      anchor.parentNode.insertBefore(bar, anchor);
      this._el = bar;
    }

    // (Re)fill the version-bearing title via textContent (safe DOM).
    const titleEl = bar.querySelector('.ub-title');
    if (titleEl) {
      titleEl.textContent = version
        ? ('Update ready · v' + version)
        : 'Update ready';
    }
    bar.classList.remove('leaving');
    bar.hidden = false;
  },

  // Restart-to-update: persist nothing here (Rust apply_update saves the
  // layout + writes the reopen marker), just ask the core to install the
  // STAGED bytes and relaunch. On success the app re-execs (invoke never
  // resolves); guarded so off-Tauri / pre-Slice-A builds no-op cleanly.
  onApply() {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!core) return;
    core.invoke('apply_update').catch((e) => Logger.warn('apply_update failed:', e));
  },

  // "What's new" → open the full staged-narrative Updates panel.
  _openUpdates() {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!core) return;
    core.invoke('open_widget', { kind: 'settings.updates' })
      .catch((e) => Logger.warn('open updates panel failed:', e));
  },

  // Dismiss: hide + remember the version so it stays hidden until a NEWER
  // build lands. The orb pip in the hub keeps the ambient hint.
  dismiss(version) {
    const v = (version != null) ? String(version) : (this._version || '');
    try { if (v) localStorage.setItem('luna_update_dismissed', v); } catch (_) { /* best-effort */ }
    this.hide();
  },

  hide() {
    const bar = this._el;
    if (!bar) return;
    bar.classList.add('leaving');
    bar.hidden = true;
  },
  }
}
