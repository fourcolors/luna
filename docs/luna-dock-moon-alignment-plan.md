# Plan — align Moon's window border/drag/resize to the Luna Dock reference

**Companion to** `docs/luna-dock-window-system.md` (the extracted rules).
**Goal (Mr. Cobb's ask):** make the Moon Tauri dock match the reference border
system — (1) **remove** the jagged-edge overlay, (2) get windows **aligned**
(flush) at welds, and (3) confirm the **per-corner radius** (outer round / inner
square) actually renders correctly.

> **Status — IMPLEMENTED 2026-06-18.** Fix 1 (remove the `wc-wobble` edge filter)
> + Fix 2 (Option B per-side inset collapse) shipped in `moon-theme.css` +
> `moon-dock.js`. Verified in a two-window harness — square, flush, no wobble,
> one silhouette halo — in light **and** dark on the default **studio** skin, plus
> 20/20 Moon weld/dock tests and `typecheck` 0. Built ping-pong (Sonnet impl ↔
> 3 Opus review rounds), with a neighbor-seam bug (a docked-onto neighbour never
> closing its side of the seam) caught and fixed in main-thread review.
> **Deferred:** Fix 3 (one-divider-per-seam for the visible-border classic/aqua
> skins) remains a code TODO — see §4; it is now *unblocked* by the filter removal
> (the ink-ring can become a real `border`). The reference resize-with-alignment
> port (§5) is a separate follow-up. Real-Tauri multi-window drag *feel* is the
> one operator-gated check left.

---

## 0. The headline finding

The radius logic Mr. Cobb wants **is already computed and applied** in Moon —
`moon-dock.js:83-114` (`applyWeldVisuals`) sets `borderTopLeftRadius='0px'` … on
`.widget-shell` + `.title-bar` from `LunaDeckSnap.weldCorners`, which is a
faithful port of the reference `weldRadius`. So this is **not** a "build the
radius system" job. It's a "**stop two things from breaking what's already
there**" job. The two problems are **independent** — one geometric, one aesthetic:

1. **Geometric cause of non-flush welds: the `--card-inset: 22px`.** Each window
   gives its card a 22px transparent margin inside its OS frame
   (`moon-theme.css:39,55-59`), so two OS-window-flush windows leave a **44px gap**
   between painted cards (`moon-theme.css:52-54` calls this "intentional,
   board-like spacing"). A squared corner sitting 22px back from the seam, across
   a 44px gap, reads as a **cut card**, not a weld. *This is why windows don't
   line up.*
2. **Aesthetic roughness: the wc-wobble filter.** `.widget-shell::before`
   (`moon-theme.css:89-95`, `feDisplacementMap scale=6`) roughens the card
   outline (fill + the 1.5px ink ring) by up to ~6px. Because `.widget-shell`
   has **no `overflow:hidden`**, the filtered `::before` is *not* hard-clipped by
   the shell's `border-radius`, so the roughened ink-ring bleeds past the nominal
   corner — a squared corner still paints a wavy edge. Even after the gap is
   closed, the wobble would keep the seam from reading crisp. *This is why the
   edge looks jagged.*

Close the gap **and** remove the wobble, and the existing radius code renders
exactly like the reference. (Codex validation: the gap — not the filter — is the
geometric cause; the two fixes are independent and both required.)

---

## 1. Gap analysis (reference → Moon)

| Aspect | Reference (`docs/luna-dock-window-system.md`) | Moon today | Gap |
|---|---|---|---|
| **Edge filter** | crisp `border-radius`, **no** displacement filter on the outline | `.widget-shell::before { filter: url(#wc-wobble) }` (`moon-theme.css:95`) jags the outline | **REMOVE wobble from the shell edge** |
| **Seam gap** | 0 — card = window, welded cards touch | `--card-inset:22px` → 44px gap between flush windows | **CLOSE the gap at welded edges** (decision below) |
| **Per-corner radius** | `weldRadius`, outer `R` / inner `0`, `IN=6` probe | `weldCorners`+`applyWeldVisuals` already do this (`deck-snap.js:194-227`, `moon-dock.js:90-99`) | **OK** — just blocked by wobble+gap |
| **Magnet** | corner-to-corner, `SNAP=30`, live | `computeSnap`/`computeLiveDrag`, `DEFAULT_THRESHOLD=30` (`deck-snap.js:25,27-98`) | **OK** (parity-tested) |
| **Weld tolerance** | `TOUCH=4` | `WELD_EPS=2` (`deck-snap.js:109`) + Rust `EPS=2` (`main.rs:2045`) | **minor** — 2 vs 4; tighten/align |
| **Overlap min / probe** | `>8` / `IN=6` | `WELD_MIN_OVERLAP=8`, `WELD_IN=6` | **OK** |
| **Cluster tow** | rigid, one delta | `computeLiveDrag` tows members 1:1 (`moon-dock.js:246-255`) | **OK** |
| **Silhouette shadow** | per-edge pieces, non-welded edges only | `applyWeldVisuals` assembles `--dk-edge-*`, omits welded edges (`moon-dock.js:100-109`) | **OK** |
| **One divider per seam** | `[data-weld~="t"] .dock-wash{border-top:0}` etc. | Moon sets `data-weld` but has **no border-drop rule**; studio border is transparent so it's invisible, **classic** (hairline border) would double at seams | **minor** — add the drop rules for visible-border skins |
| **Resize** | custom `l/r/b` strips + `rb` corner, alignment snap `RS=14`, min 228×96 | native OS resize only; **no** alignment snap; min 220×120 / 220×160 (`main.rs:1455,1642`) | **deferred** — see §5 |
| **Skins** | studio 13 / classic 4 / aqua 18 | same (`moon-skins.css:36,108,171`) | **OK** |

---

## 2. Fix 1 — remove the jagged edge overlay (clear win, low risk)

**Change:** stop applying `#wc-wobble` to the window outline.

- `apps/ui-moon-tauri/frontend/vendor/moon-theme.css:95` — delete
  `filter: url(#wc-wobble);` from `.widget-shell::before`. The `::before` keeps
  `border-radius: inherit` and the ink-ring `box-shadow`, so the **crisp rounded
  card stays** — only the roughening goes.
- `moon-theme.css:116-118` — the `html[data-skin='classic'] …::before{filter:none}`
  opt-out becomes redundant (whole-app default is now `none`); leave or remove.
- `.wash-dot` (`moon-theme.css:343-349`), chat-bubble wash (`chat.html:736`), and
  the send-button `#wc-wobble-soft` glyph (`chat.html:2156`) are **decorative,
  not window edges** — the reference keeps comparable decorative softness, so
  **leave those**. Only the *window outline* loses the filter.
- **Triplicated `<svg><defs>` for `#wc-wobble`** (`panel.html:85-92`,
  `widget.html:113-120`, `chat.html:2326`): once nothing on a page references
  `#wc-wobble`, its defs are dead. **panel.html / widget.html** only define
  `#wc-wobble` → safe to delete the block there after a grep. **chat.html is the
  trap (Codex 5d):** its single `<defs>` holds **both** `#wc-wobble` AND
  `#wc-wobble-soft`, and the send-button glyph still uses `#wc-wobble-soft`
  (`chat.html:2156`). **Never delete the chat block wholesale** — remove only the
  `#wc-wobble` path (or split the defs), or the send glyph breaks.

**Why this alone isn't enough:** removing wobble gives crisp corners, but with
the 44px gap still present they're crisp corners across a gap. Fix 2 is required
for the welds to actually look welded.

---

## 3. Fix 2 — close the seam gap (the real decision)

The reference has **zero inset**: the card *is* the window, so welded cards
touch. Moon gives every card a 22px transparent margin inside its OS window (the
wobble + halo needed bleed room). Once the wobble is gone, most of that reason
evaporates — only the **halo** still needs some bleed, and the halo is already
**suppressed on welded edges** (`applyWeldVisuals` omits welded edges from the
silhouette shadow). So the margin is only needed on **free** edges.

Three ways to make welded cards meet, in order of recommendation:

### Option B (recommended) — collapse the card margin to 0 on welded edges
Keep OS windows snapping **flush** (edges touch, as today — no overlap). Make
`.widget-shell`'s margin **per-side**: free edge → `--card-inset`, welded edge →
`0`. Then card A's bottom reaches its OS window's bottom, which touches card B's
OS-window top, where card B's top margin is also 0 → **cards meet flush, no OS
overlap, no pointer ambiguity.** The halo stays on free edges (where it's needed)
and is already gone on welded edges.

- Where: extend `applyWeldVisuals` (`moon-dock.js:83`) to set the shell's
  per-side margin from `outlineSides` — margin `0` on welded sides,
  `var(--card-inset)` on free sides.
- **Size formula is the trap (Codex):** you cannot just zero a margin and leave
  `height: calc(100% - var(--card-inset) * 2)`. `margin-bottom:0` with the old
  height leaves a **22px dead zone** — the card still stops short of the OS-window
  edge. The width/height must be computed **per axis from the actual free
  margins**: `height: calc(100% - topMargin - bottomMargin)`,
  `width: calc(100% - leftMargin - rightMargin)`. Cleanest is to switch the shell
  to `position:absolute` and drive all four sides via `inset` (per-side `0` or
  `--card-inset`) so margin and size can't disagree.
- **Coordinated scope — sibling elements that also use `--card-inset` (Codex
  5e):** `#outline` (`moon-theme.css:430-441`), `#seam` (`:413-420`), and the
  grain `body::after`/overlay (`:210-213`) all derive geometry from a fixed
  `var(--card-inset)`. If the card moves to the OS edge on welded sides, these
  stay 22px inset and **visually misalign**. They must be updated in lockstep
  with the per-side inset, or the weld will look broken on the outline/grain.
- **Do NOT animate the inset during an active weld settle (Codex):** the native
  window `setPosition`s instantly, but a CSS `margin/inset 0.2s` transition would
  paint the card 22px inside the OS edge then slide flush over 200ms — a visible
  flash on every snap. Ease the *radius* (already done), but apply inset changes
  **immediately** on settle (or only transition on explicit user un-dock).
- **Native traffic-light conflict (Codex):** native macOS window buttons are
  pinned at a fixed offset from the OS-window origin (`trafficLightPosition`,
  ~(40,42) from PR #169). Collapsing `margin-top` to 0 moves the card top to
  OS-window row 0, so the card header now shares space with the native buttons —
  check the top-weld case doesn't collide the title/lights with the native
  controls. (Top welds are rare for the anchor, but modules can weld above.)
- Pros: no overlapping OS windows → **no transparent-margin click-capture
  problem**; reuses the weld data already computed.
- Cons: it is a **coordinated geometry change, not a one-line CSS tweak** —
  per-side inset + matching size formula + `#outline`/`#seam`/grain alignment +
  no-animate-on-settle. Still far lower-risk than Option A.

### Option A (purest, higher risk) — card-rect geometry, OS windows overlap
Treat the **inset-adjusted card rect** as the geometric unit for *all*
snap/weld/radius math; position each OS window = card rect **expanded** by
`--card-inset`. Two flush cards ⇒ OS windows overlap by `2×inset`. This is the
reference model exactly (card = unit).

- Pros: most faithful; one coordinate space; the whole system "just is" the
  reference.
- **Cons / risk:** overlapping transparent OS windows. In the overlap band, one
  window's **transparent margin** sits over the other window's **card content**
  (≈22px strips). On macOS a transparent Tauri window still **captures pointer
  events** over transparent pixels by default, so clicks on a card edge under a
  neighbour's margin could be eaten. Mitigable (`setIgnoreCursorEvents` on the
  margin, or shaping), but that's real native work and a likely source of subtle
  bugs. **Validate before committing.**

### Option C (simplest, weakest) — shrink the global inset
Drop `--card-inset` to a few px. Gap shrinks but doesn't close; the halo loses
its bleed and starts to shear at the OS-window bounds. Reads as "two close cards,"
not a weld. **Not recommended** except as a stop-gap.

> **Decision needed from Mr. Cobb / validators:** B vs A. The doc + this plan
> recommend **B** (flush welds without OS-window overlap → avoids the native
> pointer-capture hazard). A is the "single coordinate space" ideal if we're
> willing to solve the overlap click-through.

---

## 4. Fix 3 — confirm the radius actually renders

After Fixes 1+2, the existing `applyWeldVisuals` squaring should render flush.
Things to verify (and likely small follow-ups):

- The `::before` wash inherits radius (`border-radius: inherit`,
  `moon-theme.css:93`) ✅ — squared corners flow to the fill automatically (same
  as the reference `.dock-wash`).
- Titlebar top corners square in lockstep (`moon-dock.js:96-99`) ✅.
- The `transition: border-radius 0.2s` (`moon-theme.css:66`) eases the pop ✅.
- **Add the one-divider-per-seam rules** for visible-border skins (parity with
  dock.css:320-324): `html .widget-shell[data-weld~="t"]::before{border-top:0}`
  etc. — harmless for studio (transparent border), correct for classic's
  hairline. Low priority; do it for skin fidelity.

---

## 5. Fix 4 — resize (capture now, implement later)

Moon uses native OS resize with no neighbour alignment; the reference has custom
`l/r/b` strips + `rb` corner with `RS=14` alignment snapping and min 228×96. This
is the largest behavioural gap but **orthogonal** to the border/radius work and
**not** in Mr. Cobb's three asks. Recommendation: **document the rules now** (done
in the extraction doc §5) and treat the custom resize-with-alignment as a
**separate follow-up** — porting it means JS-driven `setSize`/`setPosition`
edge handles like the hub's grip (`index.html:1186-1222`), plus reconciling
min-sizes (228×96 vs 220×120). Flag for Mr. Cobb whether to bundle or defer.

---

## 6. Secondary parity nits

- **`TOUCH` 4 vs 2:** the reference welds within 4px; Moon within 2
  (`WELD_EPS=2` + Rust `EPS=2`, `main.rs:2045`). With live snap pinning edges
  exactly, 2 is usually fine, but the reference's looser 4px is more forgiving on
  mixed-DPI rounding. If we touch it, change **both** JS and Rust in lockstep
  (the Rust touch predicate is the documented source of truth) and re-run
  `dock_geometry_tests`.
- **Constants are in two languages.** `WELD_EPS`/`WELD_MIN_OVERLAP` are
  duplicated in `deck-snap.js` and `main.rs` and must stay matched; `SNAP=30`
  and `IN=6` live in JS only (no Rust counterpart) — nothing to drift.

**Extra risks surfaced by Codex validation (watch during implementation):**
- **Live-drag repaint lag.** During a live drag, `paintWeldFrom` uses a *static*
  neighbour snapshot and siblings repaint through throttled (rAF) IPC, so a fast
  drag can briefly show the dragged window's weld state ahead of its neighbours'.
  Cosmetic, but if Option B animates inset it would amplify the flash → another
  reason to apply inset instantly on settle, not per-frame.
- **`data-weld` has no geometry consumer yet.** `applyWeldVisuals` *writes*
  `data-weld` but (for studio) nothing reads it for geometry — if Fix 2 or the
  classic border-drop rules key off it, add tests for the grouped → un-welded
  recovery cycle (inline styles must clear back, like the radius `''` reset).
- **Mixed-DPI spawn vs drag coordinate paths.** Open-time docking is computed in
  Rust logical px (`main.rs` `dock_new_panel`), while live drag converts to
  physical px per-monitor (`logicalToPhysical`). A new panel spawned onto a weld
  across a DPI boundary could land a pixel off — regression-check on a mixed-DPI
  setup before shipping the inset change.

---

## 7. Implementation order (small, verifiable steps)

1. **Fix 1** — drop the shell-edge wobble (`moon-theme.css:95`); grep-confirm and
   remove now-dead `#wc-wobble` defs per page (keep `#wc-wobble-soft` in chat).
   *Screenshot* studio + classic, light + dark, single window.
2. **Fix 2 (Option B)** — coordinated geometry change: per-side inset from
   `outlineSides` in `applyWeldVisuals` via `position:absolute; inset` (per-side
   `0`/`--card-inset`, with the matching per-axis size formula); update
   `#outline`/`#seam`/grain to the same per-side inset; apply inset **instantly**
   on settle (no transition — ease only the radius). *Screenshot* a 2-window
   vertical weld and an L-shaped 3-window cluster: corners square **and** flush,
   one silhouette shadow, no gap, outline/grain aligned, no settle flash.
3. **Fix 3 follow-ups** — add the per-seam `border-top/left:0` `::before` rules
   for classic. *Screenshot* classic weld (no doubled hairline).
4. **Secondary** — optionally align `TOUCH` to 4 (JS+Rust), run Rust + Moon
   suites.
5. **Resize (Fix 4)** — separate PR if Mr. Cobb wants it.

Each step is independently revertible. Steps 1-3 are frontend-only (ship via
normal Moon auto-update, no tagged release); a `TOUCH` change touches Rust.

---

## 8. Verification (per project rule — screenshots required)

UI changes need a **screenshot of the real render**, not just passing tests
(jsdom doesn't lay out pixels). Two levels:

- **Fast loop (Chromium / agent-browser):** load the page over `file://`, drive
  `window.__MoonInternals.handleFrame(...)` + set `data-theme`/`data-skin`,
  screenshot. Good for the CSS edge change (Fix 1) and single-window radius.
- **Real-Tauri / WKWebView (required before "done"):** multi-window welds can
  **only** be judged with real OS windows. Use the headless real-Tauri capture
  recipe (`memory: real-tauri-wkwebview-glance-recipe`) — main window = a widget
  page, shared cargo target, Swift `CGWindowList` id → `screencapture -l`. Drive
  two windows into a flush vertical weld and confirm: square inner corners that
  **touch**, rounded outer corners, one halo, no 44px gap, no wobble.

Tests to keep green: Moon vitest (`deck-weld.test.ts`, `moon-dock` tests), Rust
`dock_geometry_tests`, repo `typecheck`.

---

## 9. Open decisions for Mr. Cobb

1. **Seam alignment: Option B (recommended) vs A (purest).** B = flush welds, no
   OS-window overlap, no native pointer-capture risk. A = single coordinate
   space, faithful, but must solve transparent-margin click-through.
2. **Resize:** bundle the custom alignment-resize port now, or defer to a
   follow-up PR?
3. **`TOUCH` 4 vs 2:** match the reference (looser, JS+Rust change) or leave at 2?
4. **The 44px gap was a feature once** — the dock-link "chain-link badge" nested
   in it (`memory: dock-link-badges`). Closing the gap retires that nesting spot;
   confirm the badge affordance isn't wanted there anymore (it likely moves
   on-seam or goes away with true welds).
