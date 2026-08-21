/**
 * messageMeta.ts - the `.msg-meta` row under each message (stack23 S19i).
 *
 * The copy button, the relative timestamp, and the delivery marker. A PURE
 * LEAF: the whole cluster references nothing outside itself, which is why it
 * moves as plain exported functions rather than a factory - there is no
 * per-instance state and nothing to inject.
 *
 * MOVING IT DELETES A GROUP C MEMBER. MessageList.tsx - a module since S15 -
 * reached this through `LunaChatHost.buildMessageMeta` for the sole reason
 * that it lived in chat.html. It imports the function now, and the contract
 * loses a member. Group C is 4 -> 3.
 *
 * WHY IT IS STILL VANILLA DOM INSIDE A REACT APP, unchanged by this move:
 * MessageList hosts this row imperatively (see its own note). Rewriting it as
 * JSX is a different change with a different risk profile, and doing it in the
 * same commit as a move would have made the move unprovable.
 *
 * The two innerHTML writes are to MSG_COPY_GLYPH / MSG_CHECK_GLYPH, which are
 * literal SVG constants in this file - no input reaches them. Everything that
 * carries message text uses textContent.
 */
import type { Delivery } from "./chatModel"

const MSG_COPY_GLYPH =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>'
  + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const MSG_CHECK_GLYPH =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M20 6 9 17l-5-5"></path></svg>';

// How long the copy button shows its "copied" checkmark before reverting.
const MSG_COPY_FLASH_MS = 1200;

// Build the small always-visible "copy this message" button for a bubble.
// Copies `text` (the message's RAW source — markdown for assistant turns,
// the typed text for user turns) so a paste preserves structure/code,
// mirroring both apps/ui-web's MessageBubble and the code-block copy.
// Returns a fresh <button>; callers append it on every paint (the
// reconciler rebuilds bubble contents, so the button is re-created too).
export function buildMessageCopyButton(text: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-copy';
  btn.title = 'Copy message';
  btn.setAttribute('aria-label', 'Copy message');
  btn.innerHTML = MSG_COPY_GLYPH;

  const flashDone = () => {
    btn.innerHTML = MSG_CHECK_GLYPH;
    btn.dataset.copied = '1';
    btn.title = 'Copied!';
    btn.setAttribute('aria-label', 'Copied');
    setTimeout(() => {
      btn.innerHTML = MSG_COPY_GLYPH;
      delete btn.dataset.copied;
      btn.title = 'Copy message';
      btn.setAttribute('aria-label', 'Copy message');
    }, MSG_COPY_FLASH_MS);
  };

  // execCommand fallback: used both when the async Clipboard API is
  // entirely absent (older WKWebView) AND — regression fix — when
  // navigator.clipboard.writeText EXISTS but REJECTS at runtime. That
  // reject case is real and common now that chat panels are independent
  // floating native windows (#274/#320): a copy click can land on a
  // panel that isn't the OS's key window yet, and WKWebView denies the
  // async Clipboard write for a non-key window. The synchronous
  // execCommand path isn't gated on key-window status, so it recovers
  // the copy in exactly that case instead of silently doing nothing.
  const legacyCopy = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    if (ok) flashDone();
  };

  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    // Deliberately DON'T stopPropagation: WKWebView doesn't focus a
    // <button> on click (so no `focusin` fires), so we let the click
    // bubble to the delegated #chat-messages listener that refreshes this
    // message's relative time. The bubble-level handlers it reaches are
    // safe for the copy button (the luna-link handler ignores non-links).
    if (navigator.clipboard && navigator.clipboard.writeText) {
      // On success, confirm normally. On rejection, retry via the
      // execCommand fallback rather than swallowing the failure — see
      // legacyCopy() above for why a reject is recoverable here.
      navigator.clipboard.writeText(text).then(flashDone, legacyCopy);
    } else {
      legacyCopy();
    }
  });
  return btn;
}

// Compact relative send-time for the message meta stamp: "just now",
// "9m ago", "2h ago", "5d ago". `now` is injectable for deterministic
// tests (mirrors humanizeRelTime in ui-shared-solid, but compact — that
// one can't be imported into this standalone page). Luna always knows
// "now"; each message carries its send-time — we render the difference.
export function formatRelTime(ts: number, now?: number): string {
  if (typeof ts !== 'number' || !isFinite(ts)) return '';
  const ref = typeof now === 'number' ? now : Date.now();
  const sec = Math.max(0, Math.floor((ref - ts) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  return Math.floor(hr / 24) + 'd ago';
}

// The per-message action row: an always-visible footer holding the copy
// button + the relative send-time. Built fresh each paint (like the copy
// button) so it survives the reconciler's node rebuild. The row is an
// extensible flex container — future actions (undo / branch) slot in here.
// `ts` may be undefined (pre-`ts` server, or image-only) — the time span
// is then omitted; the refresh handler re-reads data-ts on focus/click.
export function buildMessageMeta(
  text: string,
  ts: number | undefined,
  delivery: Delivery | null,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'msg-meta';
  // #124: provenance chip for a delivered background-job result. Sits
  // first in the row so "from a background task" reads before the actions.
  if (delivery && typeof delivery === 'object') {
    const chip = document.createElement('span');
    chip.className = 'msg-delivery';
    chip.title = 'Delivered by a background task'
      + (delivery.label ? ': ' + delivery.label : '');
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = '↩';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = delivery.label
      ? 'from ' + delivery.label
      : 'from a background task';
    chip.appendChild(glyph);
    chip.appendChild(label);
    row.appendChild(chip);
  }
  row.appendChild(buildMessageCopyButton(text));
  if (typeof ts === 'number' && isFinite(ts)) {
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.dataset.ts = String(ts);
    time.textContent = formatRelTime(ts);
    row.appendChild(time);
  }
  return row;
}
