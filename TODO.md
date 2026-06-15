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

- [ ] **Moon: widget minimize** — roll a widget window up to its title bar (explicit ask in the Luna Workspace design handoff; the web board already has it). Touches dock-group geometry — the Rust group logic tracks member sizes, so a rolled-up window mid-group needs care + a real-Tauri verify.
- [ ] **Moon: ☆ favorites** — star widgets from the title bar; a favorites surface summons them (web-board parity).

---

## 🟡 Backlog

- [ ] **ui-web: Shiki light theme** — code blocks stay dark slabs in all palettes (github-dark colors are baked inline per token). Re-theme = dual-theme highlighter in ui-shared-solid's CodeBlock keyed off `html[data-theme]`.
- [ ] **ui-web board: design extras** — tomagotchi friend (Pip), agents panel (needs a live-agents wire frame), voice mode, ☾ moon-collapse rest state from the Luna Workspace design.
- [ ] **Watercolor tokens: single source** — `apps/ui-web/src/watercolor.css` duplicates `apps/ui-moon-tauri/frontend/vendor/moon-palette.css` by copy (the moon's static frontend can't import packages). Consider generating both from one source at build time.

---

## ✅ Recently Completed

_(checked items stay briefly for context, then get pruned)_

---

## 📝 Notes

_(architecture decisions, deferred items, reminders)_
