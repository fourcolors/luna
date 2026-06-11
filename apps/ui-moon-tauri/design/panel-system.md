# Luna Panel System — Design v2

_Status: accepted direction · Date: 2026-06-11_
_Supersedes the v1 draft (single fullscreen-overlay model — rejected, see "Why not an overlay window")._

---

## Goal

Panels become **the** app model, not a feature. Instead of one small moon window
that morphs into a chat rectangle, Luna is a constellation of independent floating
panels — chat, live jobs, briefings, workflow inspectors, agent direct lines,
AI-spawned artifacts — each draggable, pinnable, closeable, snapping together
magnetically. The moon stays as the hub: small, always present, ambient.

There is no fixed panel count. Panels spawn on demand (by the user from the moon,
or by the AI mid-turn) and are fully independent of each other.

---

## Window Model

**One OS window per panel.** The moon keeps its small always-on-top window
(140×185) as the hub. Every panel is its own frameless, transparent,
always-on-top Tauri window hosting a small dedicated page.

```
moon hub window (140×185, label "main")
  ├─ moon render + parallax + drag
  ├─ re-tether string episode (unchanged)
  ├─ ambient ladder: pip / orbit motes / toast   ← deck design language
  ├─ settings modal (incl. Vault/Skills/Connectors tabs)  [phase 1]
  ├─ setup wizard, updater, boot/token plumbing
  └─ voice pipeline ownership (hands-free works with no panels open)

panel windows (one each, labels "panel-*" / "widget-*")
  ├─ chat            chat.html        the conversation; owns the thread
  ├─ now rail        panel.html?type=now
  ├─ briefing        panel.html?type=briefing
  ├─ workflow        panel.html?type=flow&id=…
  ├─ agent line      chat.html?thread=…          [phase 6]
  └─ artifacts       widget.html?id=…            (already shipped)
```

### Why one-window-per-panel

- **Click-through is free.** Each window is exactly its own rectangle; the OS does
  hit-testing. A transparent overlay window, by contrast, is an opaque rectangle
  to the OS hit-tester (documented at `src-tauri/src/main.rs:864`) and needs the
  cursor-poll/`set_ignore_cursor_events` machinery running permanently.
- **"Separate from each other" is literal.** Any monitor, over other apps,
  independent crash domains, native drag.
- **Master already ships the substrate**: `open_artifact_widget` /
  `close_widget` / `list_widget_windows` (`main.rs:791-866`), `widget.html`
  (a complete standalone WS-connected panel host), fail-closed
  `capabilities/widgets.json`, `vendor/deck-snap.js` (tested snap math),
  `vendor/widget-sandbox.js` (the agent-content trust boundary).
- Matches the connector-PRD §13/W2 decision (deck design language on the
  multi-window substrate).

### Why not an overlay window

The v1 draft assumed `pointer-events: none` lets clicks pass through transparent
areas to the desktop. It does not — CSS pointer-events only routes events inside
the webview. A fullscreen overlay would need the Rust cursor poll always-on with
every panel rect mirrored into it, breaks multi-monitor (fullscreen covers one
display), and puts every panel plus the moon in one crash domain. The bounded
"deck window" variant dies on the same goal: freely scattered panels make its
bounding box approach fullscreen anyway.

### Accepted platform constraints (macOS, researched 2026-06-11)

| Constraint | Consequence |
|---|---|
| `onMoved` fires at drag **end** on macOS (`windowDidMove`; Apple forums thread/69721). WinAmp's continuous `WM_MOVING` is Win32-only. | **Snap-on-release**, like Rectangle/Photoshop. No live snap-during-drag in v1. Ghost preview only if real-Tauri verification shows mid-drag move events (operator-verify; evidence is mixed). |
| No relative z-order among always-on-top windows (Tauri #5656 closed-not-planned); last-focused wins. | Accepted (already accepted in PRD §23). Hub gets a **gather** action (raise + regroup all panels). Global shortcut must show/hide **all** windows, not just `main` (`main.rs:1252` today targets only main). |
| `visibleOnAllWorkspaces` doesn't float over fullscreen apps (Tauri #11488). `tauri-nspanel` fixes Spaces behavior but its high panel level can block IME input (nspanel #104) — fatal for the chat composer. | v1 ships plain always-on-top windows. nspanel is a later, per-panel-type opt-in for **non-text** panels only. |
| Each window = one WKWebView = own WebContent process, ~50–100 MB; process pooling is no longer controllable (Apple WKProcessPool docs). Closed webviews linger ~30 min in WebKit's process cache. | Panel budget: lazy spawn, **hide instead of destroy** for prebuilt panels, soft cap ~8–10 concurrently open. Profile with Instruments before raising. |
| Tauri exits when the last window closes if no lifecycle handler (the historical "moon vanished" failure). | Explicit policy in `main.rs`: hub is the owning window — closing it closes all panels; closing a panel never exits the app. |

---

## Connection Model

**N independent WS connections** — every panel window connects to the server
itself, exactly as `widget.html` already does (`load_connection` →
`ws://…/ui?token=`). The server handles unlimited clients today: per-connection
hello/capabilities/fibers (`server.ts:801-1016`), global broadcasts to all
sockets (artifact-list, skill-catalog, connector-list, vault-list, workflow-list),
idempotent survey submission.

**The one hard rule — thread ownership:** agent-interactive frames bind to a
single client per thread. `secret-request` goes to the *last* subscriber
(`secret-request-bridge.ts:131-141` — a wrong window silently eats it and the
agent's `request_secret` times out); local-shell *rejects* a second client
(`local-shell-bridge.ts:100-112`). Therefore:

- **Only a chat panel subscribes to a thread** (and runs thread bootstrap,
  local-shell, secret entry, survey UI). One chat panel ↔ one thread.
- **Hub and all other panels never send `subscribe-thread` / `new-thread`.**
  They live off broadcasts and the obs event stream (which fans out to every
  connection) for ambient state — the notification ladder derives from obs,
  not from thread frames.
- Hub "reattached" signal becomes *hello on its own connection* (today it waits
  for `thread-snapshot`, `index.html:7060`, which the hub will no longer get).
- Hardening (later): an explicit `interactive: true` flag on the subscribe frame
  so the binding is declared, not implied by subscription order.

Why not one hub connection multiplexed over Tauri events: it builds a router the
server doesn't need, funnels token-rate deltas through webview→Rust→webview hops,
makes the hub webview a single point of failure, and coexists awkwardly with the
per-window connections widget.html already ships.

---

## Panel Taxonomy

### Prebuilt panels
Ship with Luna; designed UI; live data subscriptions. Opened from the moon
(or spawned by events); user can close, reopen, pin.

| Panel | Page | Data | Notes |
|---|---|---|---|
| Chat | `chat.html` | own thread subscription | owns interactive frames; the snap anchor |
| NOW rail | `panel.html?type=now` | `workflow-list` broadcast + obs | live job list, mini-moon phases |
| Briefing | `panel.html?type=briefing` | workflow runs + obs digest | "while you were away" |
| Workflow inspector | `panel.html?type=flow&id=…` | `workflow-runs` (+ request frame) | per-job step view |
| Agent direct line | `chat.html?thread=…` | own thread subscription | phase 6; a chat panel pointed at another thread |
| Artifact widget | `widget.html?id=…` | artifact broadcasts | **already shipped** |

Settings (incl. Vault/Skills/Connectors tabs) is **not** a panel in phase 1 —
it stays a hub overlay (it already is body-level DOM independent of chat).
It can become `panel.html?type=settings` later; VaultEngine is the cleanest-cut
engine in the monolith (own state slice, zero Tauri commands) when that day comes.

### AI artifact panels
Spawned at runtime by the agent. **This extends the shipped artifact pipeline —
it does not fork it.** `widget_write` (`packages/widget-tools/src/tools.ts:74`)
already gives the agent create + versioned-update of sandboxed panels, registered
into every thread; `ArtifactStore` (luna.db) already persists pin state and
broadcasts changes to every client.

| Tier | Behavior | Backed by |
|---|---|---|
| ephemeral | AI-owned; gone when the AI closes it or the turn's session ends | extracted artifacts (exists) |
| session | survives until app quit | new: in-memory artifact flag |
| pinned | persists, restores on launch | `artifacts` table (exists) |

---

## AI Panel Tools (Phase 5)

Evolve the `widget_*` tool family rather than introducing a parallel `*_panel`
vocabulary:

| Tool | Status | Work |
|---|---|---|
| `widget_write(spec)` | shipped | add declarative `kind`s (below); add `tier`; add position `hint` |
| update (same slug re-write) | shipped | — |
| `widget_append({id, content})` | missing | new store op + frame |
| `widget_close({id})` | missing | new tool; **ignored if user has pinned** (rule does not exist anywhere today — must be enforced server-side) |

**Content kinds.** Today the store has `html` (sandboxed via
`widget-sandbox.js`: `allow-scripts`-only iframe, no-network CSP, cap-gated
`luna.*` bridge — agent JS is allowed *only* inside this boundary) and code
(escaped + highlighted). Add declarative kinds rendered by the panel host,
no agent JS: `markdown`, `table` (JSON → sortable), `form` (field defs;
submit routes back like `survey-response` — `request_secret`/survey are the
shipped precedents for action-events-back-to-the-agent), `live`
(obs-subscribed, already half-exists via the sandbox bridge caps).

Window placement: the existing `open_artifact_widget` honors x/y — the panel
manager (below) supplies positions from `hint` ("right-of-chat", "near-moon")
resolved against the live layout.

---

## Snap / Stick

- **Math:** `vendor/deck-snap.js` `computeSnap` stays the *only* snap
  implementation (pure, unit-tested). Iterate it over candidate anchors,
  pick the minimum gap.
- **Anchors:** chat panel (primary — hub-and-spoke, per the blessed deck
  concept), the moon hub, screen edges, then sibling panels.
- **Trigger:** settle-snap — on `onMoved`, debounce ~120 ms after movement
  stops, then snap (the pattern `widget.html:418-464` already implements).
  Guard against the spurious `onMoved` from minimize (Tauri #7664) and from
  programmatic `setPosition` (suppression flag — the feedback-loop trap is
  documented at `index.html:10470`).
- **Group-drag** (dragging a docked cluster as one): deferred. Requires a
  Rust-side registry — `WindowEvent::Moved` handler in `main.rs` maintaining a
  label→rect map + dock graph, applying follower deltas with the suppression
  flag. JS-side follower dragging would oscillate (two windows self-snapping at
  each other) and lag per IPC tick. Native `addChildWindow` is a future option
  (macOSPrivateApi already on) but kills independent drag while parented.
- ⚠️ **Phase 0 blocker:** the shipped self-snap has never run — `widget.html:438`
  misses `await` on `Window.getByLabel('main')` (async in Tauri 2), so
  `mainWin.outerPosition()` throws into the swallow-catch at `:460`. Fix,
  then operator-verify on real Tauri before stacking anything on it.
- The snap anchor label must be parameterized (widgets currently hard-code
  `'main'`; the chat panel becomes the natural anchor).

---

## Persistence

Two stores, deliberately split:

- **Pin state / artifact content: server-side** in luna.db via the shipped
  `artifact-pin`/`unpin` frames. Single source of truth; do not duplicate
  pinned-ness into a client file.
- **Layout: client-side** `~/.luna/panels.json` — which prebuilt panels are
  open + window positions/sizes, written by the panel manager on settle/close
  (follow the `moon-connection.json` write pattern):

```json
{ "panels": [
    { "id": "chat",        "x": 420, "y": 200, "w": 560, "h": 520, "open": true },
    { "id": "now",         "x": 165, "y": 200, "w": 140, "h": 320, "open": true },
    { "id": "widget-xyz",  "x": 990, "y": 200, "w": 360, "h": 440, "open": false }
] }
```

On launch: restore open panels at saved positions, **clamped to visible monitor
bounds** (saved coords can be stale after a display change).
`list_widget_windows`' docstring already anticipates exactly this reconciliation
(`main.rs:852-861`).

---

## Monolith Decomposition

`frontend/index.html` is 11,585 lines (post-Vault). Extraction follows the
proven `widget.html` pattern — chat becomes a **new page**, not an in-place
carve-up. No build step: shared code lands as plain files in `frontend/vendor/`.

**Shared modules (S0/S1):**
- `vendor/moon-protocol.js` — protocol version literal (currently hand-duplicated
  from `packages/ui-ws/src/protocol.ts`; a third copy would be malpractice),
  `CLIENT_INFO`, hello-capability parsing.
- `vendor/moon-markdown.js` — the markdown/streaming/highlight pipeline
  (`index.html:7185-7503`, already pure).
- `vendor/moon-theme.css` — watercolor tokens + shared chrome.
- `vendor/moon-ws.js` — WS client core (connect/gen-gating/reconnect/watchdogs/
  send) with a **frame-handler registry** replacing the 30-case hard-wired
  switch, and a `registerCloseHook` seam (the Vault/secret wipe policy currently
  baked into the close handler at `index.html:6487-6513` must travel with
  whichever window hosts those inputs).

**Moves to `chat.html` (S2/S3):** the `#chat-panel` subtree + ChatState /
ChatRenderer / ChatLoop / ChatEngine + Attachments + SurveyEngine +
SecretPromptEngine + ArtifactsEngine + WorkflowsEngine + LocalShell.

**Stays in the hub:** moon render/parallax, MoonString + tether (+ its
`set_interactive_region` click-through, unchanged), settings modal + Vault tab,
SetupWizard, updater (its "Update & Restart" banner needs a hub-side home —
today it injects into `#chat-messages`), boot/token plumbing.

**Voice splits (S4):** hub owns the pipeline (`voice_*` commands, mode
persistence, hands-free wake, the moon's `data-voice-state` watercolor states);
chat panel hosts the mic button, transcript→composer injection, spoken-reply
accumulation off its own delta stream. Rust voice emits are currently
`emit_to("main")` (`main.rs:959-965` etc.) — switch to app-wide emit or a
window registry.

**Known traps:**
- Capabilities are fail-closed per window label: a `panel-*`/chat window matches
  no capability file and gets **zero** IPC. New `capabilities/panels.json`
  mirroring `widgets.json`'s narrow-grant philosophy, before anything else.
- Thread bootstrap (`index.html:7000-7012`) auto-creates a thread when none
  exist — must run **only** in the chat panel or N windows race and spawn
  duplicate threads.
- The 282-test jsdom suite keys off `window.__MoonInternals` — exports must be
  preserved per page; `chat.html` needs its own harness mirroring
  `test/moon-app.test.ts`.
- `toggleChat`'s resize/tether choreography (`index.html:10011-10072`) is
  replaced by spawn/focus of the chat window; the "string only when collapsed"
  invariant restates as "string whenever the hub socket is detached".

---

## Build Phases

**Phase 0 — unbreak the foundation** (small, do first)
- Fix the `widget.html:438` missing-await; operator-verify snap on real Tauri.
- `capabilities/panels.json`; global shortcut + show/hide iterate all windows;
  hub-owns-exit lifecycle policy in `main.rs`.

**Phase 1 — shared modules (S0/S1)** — extract `moon-protocol/markdown/theme/ws`,
consume from `index.html`, frame switch → registry. Pure refactor, tests green,
zero behavior change. Ship alone.

**Phase 2 — chat panel (S2/S3)** — `chat.html` + `open_chat_panel` command;
moon click spawns/focuses it; sub-engines move; snap anchor parameterized to
chat; `panels.json` save/restore; hub reattach signal redefined. The overhaul's
riskiest slice; everything after it is additive.

**Phase 3 — prebuilt panels + hub ambient** — `panel.html` host for NOW rail /
briefing / inspector (data already on the wire); hub ambient ladder (pip →
motes → toast) driven by the obs stream, ported from the deck prototype branch
(`worktree-moon-agent-dropdown`, kept as reference); toast renders via the
envelope-grow machinery (it cannot fit the 140px window — the prototype's toast
is clipped to a 7px sliver).

**Phase 4 — voice split + hub cleanup (S4/S5).**

**Phase 5 — AI panel tools** — `kind: markdown|table|form`, `tier`,
`widget_append`, `widget_close` (+ pin-respect rule), placement hints.

**Phase 6 — agent direct lines** — `chat.html?thread=…`; protocol already
multi-thread (`subscribe-thread`/`thread-list`/`threadId` on every frame);
needs an agent-identity/thread mapping, honors one-window-per-thread.

**Server track (parallel, required for the deck's golden path):** a real
"needs input" job status — `JobRunStatus` is `queued|running|success|failed|
cancelled`; the waiting state the whole notification ladder keys on does not
exist — plus an answer channel into a running job (the `request_secret` bridge
is the template). Without this, NOW/briefing/toast only ever demo on fake data.

---

## Deck design language — what survives the window split

Watercolor chrome, blots, mini-moon phase glyphs, pip/orbit-motes/toast on the
hub: all live inside single windows and port directly from the prototype branch.
**Mote-flight from moon into the NOW rail** crossed panel boundaries in the
one-window prototype and cannot render across OS windows — replaced by a
hub-side burst + a spawn/settle animation inside the arriving panel.
