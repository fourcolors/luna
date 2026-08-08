/**
 * notifier.ts - OS notifications for background results (stack23 S19h).
 *
 * Every entry point is wrapped in try/catch on purpose: this runs in a
 * WebView where Notification may be absent, permission may be denied, and
 * localStorage may throw outright (Safari private mode, and any embedder that
 * blocks storage). A notification failing must never take a chat turn with it,
 * so `enabled()` fails OPEN - a storage read that throws means notifications
 * stay on rather than silently switching themselves off.
 */

// @ts-nocheck

export interface NotifierCtx {
  readonly Logger: { info: (m?: unknown, ...a: unknown[]) => void; warn: (m?: unknown, ...a: unknown[]) => void; error: (m?: unknown, ...a: unknown[]) => void }
}

/** Annotated rather than body-edited, so the move stays character-identical. */
interface NotifierInternal {
  enabled: () => boolean
  notify: (title: string, body: string) => void
  [k: string]: unknown
}

export function createNotifier(ctx: NotifierCtx) {
  const { Logger } = ctx
  const Notifier: NotifierInternal = {
    enabled() {
      try {
        return localStorage.getItem('luna_notifications_enabled') !== 'false';
      } catch (_e) {
        return true;
      }
    },
    notify(title, body) {
      if (!this.enabled()) return;
      const core = window.__TAURI__ && window.__TAURI__.core;
      if (!core) return;
      try {
        Promise.resolve(core.invoke('notify', { title: title || 'Luna', body: body || '' }))
          .catch((e) => Logger.warn('notify command failed:', e));
      } catch (e) {
        Logger.warn('notify invoke threw:', e);
      }
    },
    /**
     * Cross-window dedupe. Parallel chat panels (panel-chat-*) on the same
     * thread each receive the same delivery frame; localStorage is shared
     * across the app's windows, so the first UNFOCUSED window to claim a
     * delivery's signature notifies and the rest skip. Best-effort (a
     * cross-process race can in theory double-claim) — acceptable for a
     * notification banner. Fails open: a storage error never suppresses.
     */
    claimed(sig) {
      try {
        const KEY = 'luna_notify_last_delivery';
        if (localStorage.getItem(KEY) === sig) return true;
        localStorage.setItem(KEY, sig);
        return false;
      } catch (_e) {
        return false;
      }
    },
    /**
     * Notify for a background-delivered assistant message. Title names the
     * delivering task when known ("Luna · <label>"); body is the reply text
     * (the Rust side truncates to a banner-sized preview).
     */
    notifyDelivered(message) {
      if (!message || typeof message !== 'object') return;
      // The user is watching THIS window: the chat bubble + #124 result
      // toast already surface the delivery — an OS banner would be noise.
      // Each window checks its OWN focus, so a focused panel stays quiet
      // while an unfocused sibling (checked before any dedupe claim) can
      // still raise the banner.
      if (document.hasFocus()) return;
      const body = typeof message.text === 'string' && message.text.trim()
        ? message.text.trim()
        : 'A background task finished.';
      const sig = (message.ts || 0) + ':' + body.length + ':' + body.slice(0, 40);
      if (this.claimed(sig)) return;
      const label = message.delivery && message.delivery.label;
      const title = label ? 'Luna · ' + label : 'Luna';
      this.notify(title, body);
    },
  }
  return Notifier
}
