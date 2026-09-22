---
name: luna-panel-browser-mock
description: Use when verifying Luna's React settings panels (settings.voice, settings.updates, etc.) in a plain browser via the Vite dev server without a real Tauri backend. Covers stubbing window.__TAURI__ before panel.html's inline script captures it, driving win.listen/event.listen events through the real bundled code path, and the gotchas (parse-time ctx capture, global event bus, timed emit timelines). Complements luna-verify's T2 tier.
---

# Verifying Luna settings panels in a plain browser

React-owned panel types (`REACT_PANEL_TYPES` in `apps/ui-moon-tauri/frontend-react/panel.html`)
boot via `src/main-panel.tsx` → `panel-boot.tsx` → `mountReactPanel` using `window.__panelCtx`,
which panel.html's inline script builds **at parse time**. `ctx.win`, `ctx.label`, and
`ctx.hasTauri` are all captured then — a `window.__TAURI__` stub injected *after* load is too
late.

## The working recipe

1. `bun run --cwd apps/ui-moon-tauri dev:frontend` (Vite, port 5175, root `frontend-react/`).
2. Create a TEMPORARY `frontend-react/panel-mock.html`: copy `panel.html` and inject a
   `<script>` stub **as the first child of `<head>`** (before the vendor scripts and the inline
   script). Same relative paths (`/vendor`, `/src/main-panel.tsx`, `?type=` param) all work
   unchanged. Delete the file afterward — never commit it.
3. Stub shape that covers all consumers:
   - `__TAURI__.core.invoke(cmd, args)` — canned per-command promises; reject unhandled cmds
     (mimics off-Tauri so degradation paths still work).
   - `__TAURI__.window.getCurrentWindow()` → `{ label, listen(name, h) }` — capture `h` into a
     map; also Proxy-wrap so other methods (`startDragging`, etc.) return async no-ops
     (`LunaDock.wire` touches the win handle).
   - `__TAURI__.event.listen(name, h)` — the **global** event bus; UpdatesPanel subscribes to
     `update://*` here, NOT `ctx.win.listen` (voice-model-progress IS on ctx.win — check which
     bus the panel's doc comment names).
   - `window.__mockEmit(name, payload)` — fires captured handlers with `{payload}`.
4. Navigate to `http://localhost:5175/panel-mock.html?type=<panel.type>`.

## Driving state

Two options:
- **Timed emits (preferred for recordings):** inside the stub, schedule `setTimeout` emits when
  a trigger invoke fires (e.g. `voice_ensure_model` → tick `voice-model-progress` payloads over
  a few seconds; `update_state` → snapshot DTO then `update://progress`/`update://ready`).
  Self-running demo needing only a page load / one click — no console injection.
- **Manual emits:** call `__mockEmit` via devtools console or CDP. Note `browser_console` may
  refuse ("Chrome is not in the foreground") on Chrome instances the tool didn't launch, and
  Chrome's "Allow JavaScript from Apple Events" (View → Developer) may not persist — don't
  count on either.

## What to assert

- Exact `textContent` on the formatMb-derived nodes (`#voice-model-status`,
  `#update-bytes`, `#update-percent`) plus a true-size screenshot — a broken shared import
  leaves the panel at "Loading…" (title never flips), a wrong formatter fails exact strings.
- Payload key names differ per panel: voice uses `downloadedBytes`/`totalBytes`, update events
  use `downloaded`/`total` — read the reducer's `applyEvent`, don't guess.
