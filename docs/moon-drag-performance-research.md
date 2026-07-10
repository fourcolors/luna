# Live Magnetic Window Snapping — Optimization Research

> **Historical (superseded 2026-07-10):** Moon no longer performs magnetic
> snapping or cluster towing. Each panel now uses a direct native macOS drag.
> See `apps/ui-moon-tauri/docs/window-drag-snap.md` for the active behavior.

> Research output (2026-06-19) for the Moon card-drag performance question:
> "can we optimize this for high performance, maybe Rust? is anyone else doing this already?"
> Method: 7 parallel research streams (Tauri/tao internals, all-Rust drag loop, macOS
> snapping apps, cross-platform docking, compositor latency, Tauri/Electron prior art,
> our own latency budget) → 21 load-bearing API claims adversarially verified against
> primary sources → ranked synthesis. Builds on the rAF-coalesce + batched
> `dock_move_cluster` fix already shipped (see `moon-dock.js` / `main.rs`).

## 1. Bottom line

**(a) How much smoothness is left to win by going more-Rust?** Not much on the dragged-card
path, and the easy gains are already banked. Our per-frame JS snap math is microsecond-class
for realistic clusters (1–4 cards), so porting `deck-snap.js` back to Rust saves ~0.05–0.2ms/
frame — real but imperceptible. The actual remaining cost is the **N `setFrameTopLeftPoint:`
calls** that cross the AppKit main-thread boundary, and that cost is **identical whether JS or
Rust issues them**. The single genuinely transformative lever is **`NSWindow.addChildWindow`
cluster towing**: it collapses N programmatic moves into ONE OS operation when the lead card
drags — but it carries a real, unresolved risk (§3/§5) because the child offset is fixed at
attach-time, which fights live re-welding.

**(b) Is anyone else doing this?** Effectively no. Across Tauri, Electron, npm, and crates.io
there is **zero prior art for live inter-window magnetic snap in a web-shell desktop app** —
every macOS tool surveyed (Rectangle, Magnet, Moom, Loop, yabai, Hammerspoon) snaps **on
release**, not during drag. The only true live-during-drag prior art is native Win32
(`WM_MOVING` — Winamp/OBS), which **has no macOS equivalent in the public API**. Our current
rAF-coalesced batched-IPC approach is, as far as the survey found, the state of the art for
this problem class. The orb already proving native drag works (`startDragging()`) is our most
useful asset.

## 2. Where the latency actually is

Per-frame path today (post rAF+batch), confirmed against worktree source:

1. **JS `computeLiveDrag`** — O(candidates × 8) AABB+hypot arithmetic. Microsecond-class for ≤6 candidates. *Not the bottleneck.*
2. **JS `logicalToPhysical`** — O(monitors) walk. Also microsecond-class.
3. **ONE `invoke('dock_move_cluster')`** — fire-and-forget, no `await` (`moon-dock.js:408`; rationale `:402–405`: *"awaiting would re-serialize the channel we just unclogged"*). One IPC hop per frame regardless of cluster size.
4. **N synchronous `set_position` calls in Rust** (`main.rs` `dock_move_cluster`, plain sync `for` loop). **This is the wall-clock cost.**

What rAF+batch already captured: it killed the IPC backlog (N invokes → 1) and the per-event
flood (coalesced to 1/frame). That was the big win and it's done.

Remaining floor, in order:

- **NSWindow frame-move boundary (the actual floor).** Each `set_position` → `WindowMessage::SetPosition` → tao `set_outer_position` → `setFrameTopLeftPoint:` dispatched via `DispatchQueue::main().exec_async` — **two async hops per window, no coalescing at any layer** (confirmed in tao 0.35.3 + tauri-runtime-wry 2.11.2 source). For a cluster of N, that's N per frame.
- **⚠️ The "Sonoma v-syncs every window move, 2× for 2 windows / 32ms double-buffer" claim is NOT solid** (came back `partly-true`/`refuted`):
  - The 2× / v-sync claim traces to **a single Apple-forum post ([thread/731769](https://developer.apple.com/forums/thread/731769)) from the macOS 14 *first developer preview*, zero Apple replies, hedged "seem to"** — and it discusses `setFrame:`, NOT the `setFrameTopLeftPoint:` our code calls. Persistence to shipping macOS 14/15/26 unconfirmed.
  - The "32ms / two 60Hz frames" figure was **refuted**: it originates from a MacRumors forum user's *speculation* about **cursor input lag** (a different phenomenon — the HW cursor is drawn independently), and double-buffering is one frame (~16ms), not two. **Do not quote 32ms as fact.**
  - **Implication:** the per-window AppKit cost is real, but its magnitude is uncertain. **Measure it on our actual hardware before betting an architecture on it.**
- **IPC hop: effectively already solved.** One fire-and-forget invoke/frame is not the bottleneck. An all-Rust loop saves the hop but inherits the same N AppKit moves — and is structurally hard.

## 3. Options, ranked (by payoff-per-effort)

| Option | What it changes | Effort | Payoff | Risk | Verdict |
|---|---|---|---|---|---|
| **A. Keep JS, micro-opt** (port snap math into `dock_move_cluster`; JS sends raw cursor delta) | Removes JS↔IPC coordinate math | Low–Med | **Marginal** (~0.05–0.2ms/frame; bottleneck untouched) | Low; Rust surface to keep in sync with `deck-snap.js` fixtures | **confirmed** (low value, safe) |
| **B. `addChildWindow` cluster tow** (lead native-drags; welded satellites attached as children → OS moves cluster as one op) | N moves → **1** when lead drags | Medium | **Large** *if it fits our model* | **⚠️ HIGH/uncertain** — child offset fixed at attach-time; live re-weld needs remove+re-add (glitch). Towing confirmed only for *static* drawers. Spaces/Mission-Control child-stranding bugs. Tauri parent API is construction-time only → custom Rust plugin | **uncertain** (spike it) |
| **C. Native `startDragging` + snap-on-release** (lead drags OS-native; Rust snaps once at settle) | Drag OS-owned & perfectly smooth | Low | **Large** (native smoothness, trivial) | Medium — **loses live magnetism**; needs ghost-preview overlay | **confirmed** (what every shipping macOS tool does) |
| **D. All-Rust drag loop** (Rust owns mousedown→mouseup; CGEventTap or modal loop) | No JS in hot path | **Very High** | Transformative *in theory*; **still hits same N AppKit moves** | **HIGH** — CGEventTap needs Accessibility perm (App-Store/UX blocker; `rdev` crashes on Tauri); modal loop blocks the thread running WKWebView JS → seam/`.snapping` freeze. tao *does* expose `CursorMoved` but tauri-runtime-wry **strips it** → needs raw objc2 FFI | **uncertain** (high cost, ceiling unchanged) |
| **E. Single-window DOM docking** (collapse cards into one window; dockview-style DnD) | Drag never crosses a process boundary | Very High | Marginal **for us** | Abandons multi-monitor / always-on-top / independent-window UX that *defines* Moon | **confirmed but wrong direction** |

**Ranking by payoff-per-effort: C > B > A > D > E.**

## 4. Prior art

| Project | Approach | Native / web-shell | Live or on-release | Smooth? |
|---|---|---|---|---|
| [Winamp](https://www.codeproject.com/Articles/27811/Snapping-Window) | Win32 `WM_MOVING` mutates proposed RECT mid-drag; `SetWindowPos` on all members in one handler | Native (Win32) | **Live** | Yes (no IPC; no macOS equiv) |
| [OBS Studio](https://github.com/obsproject/obs-studio/issues/2387) | Qt `QDockWidget` in one process | Native (Qt) | Live (in-process) | Yes |
| [Rectangle](https://github.com/rxhanson/Rectangle) | NSEvent monitor + AX; footprint preview during drag, `setFrame` **on mouseUp** | Native macOS | **On-release** | N/A |
| [Magnet](https://magnet.crowdcafe.com/) / [Moom](https://manytricks.com/moom/) / [Loop](https://github.com/MrKai77/Loop) | AX `kAXPositionAttribute` on release; greyed preview | Native macOS | **On-release** | N/A |
| [yabai](https://github.com/koekeishiya/yabai) | AX tiling; live drag via private `SLSMoveWindowWithGroup` (scripting addition, SIP-disable) | Native macOS | Command-driven | Fast (private SPI) |
| [electron-snapping](https://github.com/mattkenefick/electron-snapping) | renderer mousemove → IPC → `setBounds`; screen-edge zones only | Web-shell (Electron) | Live but **no inter-window** | Abandoned |
| [dockview](https://dockview.dev/) / [golden-layout](https://golden-layout.github.io/golden-layout/) | DOM panes in one window; popout = `window.open`, no cross-window drag | Web (in-process) | Live (in-DOM) | Yes (single window) |
| **Luna Moon (us)** | rAF-coalesced JS snap → batched `dock_move_cluster` Rust set_position | Web-shell (Tauri) | **Live inter-window** | Good — **only known live-snap web-shell impl** |

**Corrections flagged by verification:**
- **yabai DOES have a faster-than-AX live-drag path** (`scripting_addition_move_window` → private `SLSMoveWindowWithGroup`). The original "no faster geometry path" claim was **refuted**. Still SIP-disable → non-starter for us, but the record is corrected.
- **`addChildWindow` "atomic / single OS operation" was `refuted` as wording** — no primary source says "atomic." Towing is real for *fixed-offset* children; **not** validated for the dynamic per-snap re-offset our live weld needs. This is the crux risk in Option B.

## 5. Recommendation

**Next step: measure the real per-window AppKit move cost on our hardware before any architecture change** — and, separately, decide whether to spike the one live-snap-preserving lever (Option B). Concretely:

1. **Instrument first (cheap, do regardless).** Add a Rust timer around the `dock_move_cluster` loop and log per-window `set_position` wall-clock at cluster sizes 1 / 2 / 4 on real Sonoma+ hardware. This turns the "v-sync wall" from an *uncertain forum rumor* into a number. If the N-window cost is small → **Option A is all we ever need and we're basically done.** If large → that's the evidence to greenlight Option B.
2. **If measurement says cluster moves are expensive, spike Option B** (`addChildWindow` towing via a small custom Rust plugin) and find out whether the fixed-offset re-weld glitch is tolerable. This is the only path that both preserves **live** snapping (Mr. Cobb's locked requirement) and lowers the AppKit ceiling.

**Explicitly do NOT:**
- **Do NOT port the snap math to Rust as a perf play** — easiest port, smallest win. Only do it as a side-effect of a spike already moving the loop.
- **Do NOT build the all-Rust CGEventTap loop (D)** — Accessibility-permission friction, `rdev` crashes on Tauri, modal loop can freeze WKWebView, and it **does not lower the AppKit ceiling**.
- **Do NOT design around the "Sonoma 2× / 32ms" numbers** — one is a dev-preview forum post (wrong API, no Apple confirmation), the other is refuted cursor-lag speculation. **Measure first.**
- **Do NOT adopt Option C (snap-on-release)** unless we reverse the earlier "keep live magnetism" decision — it's the report's top *general* pick but it trades away the Winamp feel we deliberately kept.
- **Do NOT collapse to a single DOM window (E)** — it trades away the independent-OS-window UX that is Moon's identity.

## 6. How to run the measurement + the child-window spike

Both are built into the worktree (`claude/great-babbage-8ccbff`) and are inert unless you turn them on.

### Measurement — get real numbers from a drag

Two complementary meters; neither affects normal use:

- **JS frame-pacing meter (the felt-cost signal).** In a card window's devtools console:
  ```js
  window.__LUNA_DOCK_PERF = true
  ```
  Then drag a single card around, release, and read the one-line summary:
  ```
  [dock-perf] cluster=1 frames=84 mean=16.7ms p50=16.6 p95=18.1 max=22.0ms janky(>20ms)=2%
  ```
  Repeat after welding 2 and 4 cards into a cluster and dragging the **anchor** (chat) so it tows them. **If `mean`/`p95` stay ~16.7ms (60fps) as `cluster` grows → cluster size is cheap and we're essentially done. If they climb with `cluster` → the N AppKit moves are the cost → greenlight the child-window approach.** Raw deltas land on `window.__LUNA_DOCK_PERF_LAST`.
- **Rust enqueue timer (secondary).** Launch the app with `LUNA_DOCK_PERF=1` (e.g. `LUNA_DOCK_PERF=1 npm run dev` in `apps/ui-moon-tauri`). Each frame logs to stderr: `[dock-perf] move N=3 enqueue=41us (13us/win)`. This is the IPC/enqueue cost only (tao dispatches the real `setFrameTopLeftPoint:` async), so expect it to be tiny — confirming the per-frame *enqueue* is not the bottleneck.

### Spike — validate `addChildWindow` cluster towing (Option B)

Open the chat window plus at least one other card (a panel or artifact widget). In the **chat window** devtools console:
```js
await window.__TAURI__.core.invoke('dock_spike_attach')                 // chat adopts every other card as a child window
await window.__TAURI__.core.invoke('dock_spike_nudge', { dx: 200, dy: 0 }) // move ONLY chat (one set_position)
```
**What to watch:** if the other cards slide right by 200px *with* chat — even though we only moved chat — then macOS is towing the children for free, and Option B's "N moves → 1" is real on our borderless/transparent windows. Then check the crux risk: does re-welding (detach + re-attach at a new offset) glitch?
```js
await window.__TAURI__.core.invoke('dock_spike_detach')                 // release them back to independent windows
```
The commands are macOS-only, `panel-chat`-anchored, and **not** wired into the production drag path. Remove `permissions/allow-dock-spike.toml` + its capability entries (`panels.json`, `default.json`) and the `dock_spike_*` fns when the spike concludes.
