# Project: Luna Dock and Workspace Verification

> **Historical (superseded 2026-07-10):** the docking system described below
> was retired. Moon panels are now independent native macOS windows with no
> snapping, and `deck-snap.js` / `deck-weld.test.ts` no longer exist.
> See `apps/ui-moon-tauri/docs/window-drag-snap.md` for the active behavior.

## Architecture
- **Docking System**: Manages window snapping, group docking, and seam/weld styles for webviews in Tauri. Primarily implemented in `deck-snap.js`, `moon-dock.js`, `moon-skins.css`, and `moon-theme.css`.
- **Chat Window**: The frontend application for user chat interfaces, defined in `apps/ui-moon-tauri/frontend/chat.html` and tested in `chat-window.test.ts`.
- **UI Models**: Model listing and capability calculation for LLM backends, defined in `apps/server/src/chat-server.ts` and tested in `ui-models.test.ts`.
- **Update Server**: The system update coordinator, defined in `scripts/luna-update-server` and tested in `update-server.test.ts`.

## Code Layout
- `apps/ui-moon-tauri/frontend/vendor/`: Vendor JS modules for window docking/snapping (`deck-snap.js`, `moon-dock.js`).
- `apps/ui-moon-tauri/frontend/vendor/`: CSS files styling the theme and skins (`moon-theme.css`, `moon-skins.css`).
- `apps/ui-moon-tauri/test/`: Test suites for Tauri window behaviors and docking (`chat-window.test.ts`, `deck-weld.test.ts`).
- `apps/server/src/`: Backend server logic for UI models (`chat-server.ts`).
- `apps/server/src/__tests__/`: Unit tests for backend UI models (`ui-models.test.ts`).
- `scripts/`: System updater script (`luna-update-server`).
- `test/`: Integration tests for system updater (`update-server.test.ts`).

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Verify PR 185 Styling | Verify CSS/JS changes for ambient shadows, buried shadows, outline alignment, paper grain scaling, and resize pointer events | None | DONE |
| 2 | Fix Chat Window Tests | Resolve 4 failing tests in `chat-window.test.ts` (async `list_widget_windows` pollution and `opener` param verification) | M1 | DONE |
| 3 | Fix UI Models Tests | Resolve 2 failing tests in `ui-models.test.ts` (add `"ultracode"` effort expected outputs) | M1 | DONE |
| 4 | Fix Update Server Tests | Resolve 3 failing tests in `update-server.test.ts` (error message matching and `bunLog` existence check logic) | M1 | DONE |
| 5 | Fix DPI Jumps & Test Flakes | Resolve mixed-DPI logicalToPhysical translation bug, WebSocket smart-bar assertion flakiness, and Telegram polling tight-loop CPU starvation | M2, M3, M4 | DONE |
| 6 | Verify & Push Workspace | Run full workspace test and build pipeline, verify no regressions, commit and push branch | M5 | IN_PROGRESS |
