# Parking lot

Work that was started but isn't currently being driven forward.
Each entry has its source preserved on `origin` under `parked/<name>`.

To revive any of these:

```bash
git fetch origin
git checkout -b feat/<name> origin/parked/<name>
git rebase origin/dev   # expect conflicts; that's why it's parked
```

To retire one for good: delete the `parked/<name>` ref on origin.

---

## `parked/setup-mode-1b`

- **Last commit:** `6100c72` (2026-05-29) — _feat(ui-tauri): fix tauri devUrl port mismatch and add solid/websocket unit tests_
- **What it was:** Multi-PR setup-mode + portable installer project. ui-web
  boots into a setup-mode when the credential isn't usable; embedded
  xterm.js pty runs `claude setup-token`; pty frames in ui-ws; dual-runtime
  design (incus on Linux, Podman on Mac); install-script fixes around
  systemd unit form so SIGTERM reaches the chat-server.
- **Scope:** 21 commits across `apps/ui-web`, `apps/ui-moon-tauri`,
  `packages/ui-ws`, `install/`, plus spec docs in `docs/spec/` and
  implementation plans in `docs/plan/`.
- **Why parked:** Project-scale, not a stray feature branch. Spec docs
  remain valuable for the next attempt even if no code lands directly.
- **To revive:** Start with PR0 (systemd unit-form fix), then #1a
  readiness gate, then #1b setup-pty. Treat each as its own PR; do not
  try to ship the whole stack at once.

## `parked/moon-app`

- **Last commit:** `90999be` (2026-05-30) — _feat(moon): clear-conversation button + server-switch thread reset_
- **What it was:** Two Moon UX commits:
  - `90999be` — clear-conversation button + server-switch thread reset
  - `4f455f2` — global shortcut registration, settings toggle panel,
    styled logger, unit tests
- **Why parked:** Both commits conflict on `apps/ui-moon-tauri/src-tauri/`
  (Tauri config, `main.rs`, schemas) and on tests/snapshots. Moon's
  Tauri shell evolved significantly since these were written. Features
  are worth landing — needs a deliberate merge session, not a drive-by.
- **To revive:** Branch from `parked/moon-app`, rebase on current `dev`,
  resolve the Tauri conflicts deliberately. Consider taking just
  `90999be` first (the focused clear-conversation feature) and leaving
  the broader settings-panel commit for a follow-up.
