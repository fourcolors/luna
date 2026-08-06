# 🌙 Luna — TODO

> Canonical task list for Luna development.
> Keep this current. One section per area. Checked items stay briefly for context then get pruned.

---

## 🚧 In Progress

_(move items here when actively working on them)_

---

## 🔴 Blocked

_(items that can't move forward without a decision, dependency, or external factor)_

---

## ⬜ Next Up

- [ ] **Moon: widget minimize** — roll a widget window up to its title bar (explicit ask in the Luna Workspace design handoff). Touches dock-group geometry — the Rust group logic tracks member sizes, so a rolled-up window mid-group needs care + a real-Tauri verify.
- [ ] **Moon: ☆ favorites** — star widgets from the title bar; a favorites surface summons them.

---

## 🟡 Backlog

_(nothing queued)_

---

## ✅ Recently Completed

_(checked items stay briefly for context, then get pruned)_

- [x] **ui-web: Shiki light theme** - resolved by deletion: `apps/ui-web` and `packages/design-system` were removed (stack23 S12); there is no longer a web board to re-theme.
- [x] **ui-web board: design extras** - resolved by deletion: `apps/ui-web` was removed (stack23 S12); the web board these extras targeted no longer exists.
- [x] **Watercolor tokens: single source** - resolved by deletion: `apps/ui-web/src/styles/astryx-watercolor-theme.css` and `packages/design-system` were removed (stack23 S12); `apps/ui-moon-tauri/frontend/vendor/moon-palette.css` is now the single source of watercolor tokens.

---

## 📝 Notes

_(architecture decisions, deferred items, reminders)_
