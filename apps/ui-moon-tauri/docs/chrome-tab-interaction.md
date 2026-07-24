# Chrome-tab interaction model for Luna Moon

_Status: guiding principles + phased plan · Date: 2026-07-23_  
_Scope: thread sidebar pull-out, multi-window floaters, redock_  
_Companion contracts: `docs/window-drag-snap.md` (OS window drag/resize), `design/widget-system.md` Phase 8_

This document is the **rulebook** for high-quality Chrome-like tab detach / reattach in Moon.
Agents and humans should read it before changing drag-out, redock, or thread-window UX.
It is derived from Chromium’s real architecture, not product folklore.

## Why this exists

Moon tried several shortcuts (HTML5 DnD, JS `setPosition`/`setSize` loops, cold `open_widget` on every detach).
They felt glitchy because they violate how Chrome actually works.
The target is not “looks like Chrome once.”
The target is **Chrome’s interaction contract**: continuous content, OS-owned free motion, strip-only attach.

## Primary references (Chromium)

Treat these as the source of truth for the interaction model:

1. **`TabDragController` header** - state machine, attach/detach API surface  
   https://chromium.googlesource.com/chromium/src/+/e3bffecfec78/chrome/browser/ui/views/tabs/tab_drag_controller.h

2. **`TabDragController` implementation** - attach, detach, `RunMoveLoop`, strip hit-test  
   https://chromium.googlesource.com/chromium/src/+/e3bffecfec78/chrome/browser/ui/views/tabs/tab_drag_controller.cc

3. **Tab strip** - where drag sessions start from the strip UI  
   https://chromium.googlesource.com/chromium/src/+/45d901b56f57/chrome/browser/ui/views/tabs/tab_strip.cc

4. **Moon OS window contract** (local) - never reintroduce live magnet / JS window drag  
   `apps/ui-moon-tauri/docs/window-drag-snap.md`

Key Chromium facts that drive our rules:

| Fact | Evidence (conceptual) | Moon implication |
| --- | --- | --- |
| Two modes: attached tabs vs detached window | `DragState::kDraggingTabs` vs `kDraggingWindow` | Separate strip reorder from free window motion |
| Free motion uses nested OS move loop | `RunMoveLoop` / `Widget::RunMoveLoop` | AppKit `startDragging` (or equivalent); never JS geometry loops |
| Content moves without reload | `WebContents` ownership transfer in Detach/Attach | Prefer ThreadCache paint + prewarm; never celebrate cold boot as “done” |
| Attach targets the **tab strip band**, not whole window | `DoesTabStripContain` + vertical magnetism (~15px mouse) | Redock hit-test is sidebar strip only |
| While attached, strip layout mutates live | `MoveAttached` / `LayoutDraggedViewsAt` | Insert-gap / row shift only in ATTACHED mode |
| Skia is not the gesture system | Views + OS move loop | Do not adopt CanvasKit/Skia for drag/redock |

---

## Guiding principles (non-negotiable)

These are **rules**.
Violating them for a demo is allowed only if labeled temporary and not merged as the long-term design.

### P1 - OS owns free window motion

When a thread is **detached**, AppKit (via Tauri `startDragging` / native monitors) owns the gesture end-to-end.

**Forbidden:**

- Per-frame `setPosition` / `setSize` from JS or hot-path IPC
- Emulated drag loops that re-implement window movement in the webview
- “Shrink the real window” mid-drag via geometry to fake attraction

**Allowed:**

- CSS transforms on the **page content** for subtle cues (GPU only; never OS frame size)
- Throttled native-side preview emits (NSEvent monitors), same family as `begin_native_resize`

### P2 - Two phases: ATTACHED then DETACHED

Model the session explicitly:

```text
NotStarted → Attached (in strip) → Detached (OS window) → Stopped
```

| Phase | User intent | What moves | What animates |
| --- | --- | --- | --- |
| **Attached** | Reorder / aim within sidebar | Pointer + row/ghost in strip coords | Other rows slide; insert gap |
| **Detached** | Free multi-window placement | Real OS window | Strip only when cursor re-enters strip band |

Do not mix phases (e.g. spawning a window on first pixel of drag, then fighting it with JS).

### P3 - Content continuity beats paint engines

Chrome feels continuous because **`WebContents` is transferred**, not because of a special renderer for drag.

Moon priorities (highest first):

1. Instant paint from `ThreadCache` (already used for in-window switch)
2. Prewarmed / pooled chat webviews so detach does not cold-boot `chat.html`
3. Skeleton chrome with known title/preview under the cursor during transition
4. Only then: full subscribe / snapshot

**Forbidden as the “quality” answer:** CanvasKit, Skia, or a new UI stack to paper over cold webview boot.

### P4 - Redock targets the strip, not the whole card

Match Chromium’s strip-band hit test + magnetism:

- Horizontal: sidebar / tab-drag area only (not the transcript)
- Vertical: strip bounds expanded by a small magnet (Chrome mouse default is on the order of **15 DIP**)
- Insertion index from cursor Y relative to the strip list, not whole window height

**Forbidden:** treating any overlap with the owner window as redock (too easy to trigger; failed historically in Moon #274).

### P5 - Live strip feedback only while Attached (or re-entering strip)

While detached and far from the strip: **do not** thrash the owner DOM every frame.

While over the strip band:

- One insert-gap node (move it; do not rebuild the whole list every sample)
- Optional source-row dimming
- No full `render()` of the thread list on every mouse sample

### P6 - Detach is a single promotion, not a continuous morph

Chrome detaches once into a browser of real size, then runs the OS move loop.

Moon:

- Detach when leaving the strip band past elasticity + magnetism
- Promote to a pinned `?thread=&redockTo=` floater **once**
- Do not resize the OS window every frame to “feel like a tab”

### P7 - Explicit affordances are a safety net, not the primary model

An explicit **Redock** control is acceptable fallback (and shipped for reliability after #274).

Primary path must still be **drag-to-strip** once the Chrome model is implemented.
Do not remove the button until drag-to-strip is as reliable as Chromium’s attach.

### P8 - Prefer reliability over replaying fragile dock geometry

History: geometry redock strips and cluster towing were removed for real multi-window flakiness (#274, `window-drag-snap.md`).

New work may hit-test the **sidebar strip**, not resurrect magnetic weld/cluster systems.

### P9 - Prove it like Chrome would

Every PR that touches this space needs:

1. A short state diagram (Attached / Detached / Stopped)
2. A human Tauri pass checklist (below)
3. Tests that lock the **contract** (native drag arming, no JS move-loop reintroduction, strip hit rules)

Screenshot / video proof remains a Moon release bar for multi-window UX.

---

## Architecture plan (phased)

### Current baseline (as of 2026-07-23, Phases A–F PR)

What is true today (do not regress):

- Free **window** drag: AppKit via `moon-dock.js` → `startDragging` (`window-drag-snap.md`)
- Free **window** resize: `begin_native_resize` NSEvent path (not JS)
- Redock floaters arm `begin_redock_drag` before `startDragging` for native-side strip preview
- Phase 8 pinned windows: `open_widget('chat', { thread, redockTo })`
- Explicit Redock button still valid
- **`LunaThreadDrag` session** (`frontend/vendor/thread-drag-session.js`): `not_started | attached | detached | stopped`
- Pull-out uses pointer capture + session (HTML5 DnD forbidden); **`open_widget` only on `detach`**
- Attached drop reorders session-local (`adoptAtIndex`); no spawn
- Detach seeds `localStorage` ThreadCache (shared across Tauri webviews; sessionStorage is isolated per window) for floater first-paint
- Strip-band geometry: elasticity 10px, vertical magnet 15px; native redock strip ~300pt

Still open follow-ups (not blocking):

- Prewarmed chat webview pool (Phase C “should”)
- Multi-monitor human Tauri pass evidence on every release

### Phase A - Session contract (foundational)

**Goal:** One `ThreadDragSession` owns the gesture.

Deliverables:

- Explicit states: `NotStarted | Attached | Detached | Stopped`
- Elasticity threshold before Attached (~10px, Chrome-like)
- Vertical magnetism before Detached (~15 logical px beyond strip)
- Unit tests for state transitions (pure logic, no Tauri)

**Exit:** All new drag code goes through the session; no ad-hoc listeners reimplementing detach.

### Phase B - Attached strip quality

**Goal:** Reorder / gap feels like Chrome **before** any window exists.

Deliverables:

- Ghost or lifted row follows pointer in strip coordinates
- Other rows shift; single insert-gap node
- No `open_widget` until Detached
- Dropping back inside strip = reorder only (no spawn)

**Exit:** Human can reorder without ever creating a second window.

### Phase C - Detach with content continuity

**Goal:** Leaving the strip promotes a window that is already meaningful.

Deliverables (pick highest feasible, do not stop at lowest):

1. **Must:** paint title + preview + ThreadCache transcript immediately on floater show  
2. **Should:** prewarm pool of hidden chat webviews; detach = show + bind thread  
3. **Could:** protocol/session handoff that avoids full reconnect when possible  

**Exit:** No multi-second empty card is the normal path on a warm cache.

### Phase D - Detached free motion (native only)

**Goal:** Match `RunMoveLoop` quality.

Deliverables:

- Detached motion only via AppKit (`startDragging` or equivalent)
- Native monitors for strip hit-test / end (pattern: `begin_native_resize` / `begin_redock_drag`)
- Throttled preview events only when over strip band or on state change
- No JS window geometry on the hot path

**Exit:** Floater motion feels identical to any other Moon panel drag.

### Phase E - Reattach (strip redock)

**Goal:** Chrome attach semantics.

Deliverables:

- Hit-test owner **sidebar band** + magnetism
- On release over strip: adopt thread, restore draft, close floater, session-local order optional
- On release elsewhere: leave floater pinned
- Keep Redock button until this path is proven in real multi-monitor use

**Exit:** Drag-to-strip is the default; button is backup.

### Phase F - Hardening

Deliverables:

- Multi-monitor, scaled displays, full-screen spaces
- Escape cancels when attached; defined behavior when detached
- One-window-per-thread for secrets/local-shell still holds
- Do not regress in-window A→B→A ThreadCache switch (#356)

---

## Anti-patterns (do not reintroduce)

| Anti-pattern | Why it fails | Prefer |
| --- | --- | --- |
| HTML5 DnD for strip rows | Broken under `-webkit-user-drag: none`; bad OS integration | Pointer capture in Attached |
| JS `setPosition`/`setSize` every frame | Same lag class Moon already removed for dock/resize | AppKit move loop |
| Full list `render()` on every preview sample | DOM thrash | Move one gap node |
| Redock on whole-window overlap | Accidental redock; #274 history | Strip band + magnetism |
| Cold `open_widget` as the happy path | Empty flash; not Chrome | Prewarm + ThreadCache |
| CanvasKit/Skia for drag | Wrong layer; huge cost | Continuity + native motion |
| Magnetic weld / cluster tow for redock | Explicitly retired in `window-drag-snap.md` | Independent windows + strip attach |

---

## Implementation map (where code should live)

| Concern | Home |
| --- | --- |
| OS window drag / redock arm | `frontend/vendor/moon-dock.js`, `src-tauri` native commands |
| Attached strip session | `frontend-react/chat.html` ThreadDrawer / future `thread-drag-session` module |
| Native strip hit-test / drag end | `src-tauri/src/main.rs` (NSEvent monitors; follow `begin_native_resize`) |
| ThreadCache instant paint | Existing ThreadCache paths in `chat.html` |
| Prewarm pool | New small module + Tauri show/hide; not a second product |
| Tests | `test/moon-dock.test.ts`, `test/chat-window.test.ts`, Rust geometry unit tests |
| UI automation (macOS) | `e2e/` WebdriverIO + embedded `tauri-plugin-wdio-webdriver` (debug only) |

---

## UI automation (validate interactions)

Moon is hybrid: JS owns the session machine; AppKit owns free window motion.
Automation is therefore layered:

| Layer | Tool | Proves |
| --- | --- | --- |
| Unit | vitest / pure `LunaThreadDrag` | State machine, seed TTL, strip math |
| E2E in-webview | WebdriverIO + Tauri **embedded** WebDriver (`--features wdio-e2e`) | App boot, expand, session sim, `open_widget` floater budget, `__moonDragDebug` |
| E2E OS mouse (optional next) | Appium Mac2 / XCUITest | Real multi-window drag coordinates + focus |
| Human | Dev build checklist below | Taste, traffic lights, jank feel |

### Run E2E (macOS)

```zsh
cd apps/ui-moon-tauri
bun install
bun run test:e2e:ci
```

Details: `e2e/README.md`.

### In-app observe hooks

- `window.__moonDragDebug` — ring buffer of drag events + last floater open timings
- `window.__moonE2E` — `simulateSessionDetach()`, `openFloater()`, …

### Budgets (E2E defaults)

| Metric | Default | Env |
| --- | --- | --- |
| Floater `open_widget` complete | 2500 ms | `MOON_E2E_FLOATER_MS` |

Tighten once the path is stable on CI hardware.

---

## Human Tauri pass checklist

Run on a real Mac build (Dev is fine):

1. **Attached only:** drag a row a few pixels - no new window; rows make space  
2. **Detach:** drag past strip - one floater appears under cursor with title/content quickly  
3. **Free motion:** floater drag feels like any Moon panel (no stutter)  
4. **Redock:** drop on sidebar band - thread returns; draft preserved if any  
5. **Miss:** drop outside strip - floater stays; owner strip preview clears  
6. **Button:** Redock control still works  
7. **Regression:** A→B→A switch, busy rows, ⤢ / ⌘-click still work  
8. **Ownership:** secrets/local-shell still one window per thread  

---

## Decision log (short)

| Date | Decision |
| --- | --- |
| 2026-07-23 | Adopt Chromium TabDragController two-phase model as Moon’s north star for thread multi-window |
| 2026-07-23 | Reject CanvasKit/Skia as the fix for drag/redock quality |
| 2026-07-23 | Keep AppKit ownership of free window motion (`window-drag-snap.md`) |
| 2026-07-23 | Explicit Redock button remains until Phase E is proven |
| 2026-07-23 | Adopt WDIO + embedded WebDriver for macOS E2E; OS mouse drag deferred to Mac2/human |
| 2026-07-24 | Hard promote on strip detach: single open_widget then begin_native_pullout_drag (no IPC set_position chase); shared strip width + magnet for redock hit |

---

## Maintenance

- Update this file when the session state machine or anti-patterns change.
- Keep `window-drag-snap.md` as the OS-window law; this file is the **thread tab-interaction** law.
- Point issues/PRs at phase letters (A–F) so work stays grabbable.
- Keep `e2e/` budgets and hooks in sync when drag contracts change.
