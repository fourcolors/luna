# Luna Widget System — Design v2

_Status: accepted direction · Date: 2026-06-11_
_Supersedes the v1 "panel system" draft (single fullscreen-overlay model — rejected,
see "Why not an overlay window")._

---

## Vision

**Luna's UI is a widget system. Chat is the main widget.**

Widgets are little mini-apps — independent floating windows that render HTML and
connect back into the Luna system. A live view of your workspace. A Tamagotchi
pet idling in a corner. A document (this design doc, rendered). An artifact the
agent just made, popped out where you can drag it. A NOW rail of running jobs.
The conversation itself — with voice integrated — is simply the primary widget
among them, the way Things 3 treats every to-do list as its own real window.

Two principles bound the scope:

1. **Enhance the OS, don't replace it.** Widgets are real OS windows managed by
   the real OS. Anything the OS already does well — opening files, notifications,
   window switching, browsers — widgets delegate to it (`open_external_url` /
   `tauri-plugin-opener`), never reimplement. The widget system's job is only:
   spawn, snap, persist, and feed widgets data. The moment a feature smells like
   window management beyond snapping, or like a virtual desktop, it's out of scope.
2. **Server-agnostic by layering.** The server behind the protocol must remain
   swappable without rewriting the UI (see "The two contracts"). Widgets never
   know what server exists at all.

There is no fixed widget count. Widgets spawn on demand — by the user from the
moon, by the agent mid-turn, or by events — and are fully independent of each
other.

---

## The Two Contracts (server-agnostic seam)

Everything in the system programs against one of exactly two interfaces, and the
layering is what keeps the server swappable and the OS-creep contained:

```
┌─ widget content (agent/user-authored HTML mini-app) ─┐
│   speaks ONLY:  window.luna.*   (cap-gated bridge)   │
└──────────────────────┬───────────────────────────────┘
                       │ postMessage, fail-closed caps
┌─ widget host (widget.html / chat.html / panel.html) ─┐
│   speaks ONLY:  UI-WS protocol (packages/ui-ws)      │
└──────────────────────┬───────────────────────────────┘
                       │ WebSocket frames + hello capability negotiation
┌─ server (today: luna chat-server; tomorrow: whatever)─┐
└──────────────────────────────────────────────────────┘
```

- **Widget content ↔ `luna.*` bridge.** Mini-apps run in a hard sandbox
  (`vendor/widget-sandbox.js`: `allow-scripts`-only iframe, opaque origin, CSP
  forbids all network, no `__TAURI__`) and reach the world solely through the
  postMessage bridge, gated per-widget by a `bridge_caps` allowlist. A widget
  that only uses the bridge is portable across hosts AND servers by construction.
- **Widget host ↔ UI-WS protocol.** Hosts are thin pages that own a WebSocket,
  negotiate hello capabilities, and translate frames → bridge events. The
  protocol (`packages/ui-ws/src/protocol.ts`, mirrored client-side as
  `vendor/moon-protocol.js` after Phase 1) is the **only** server boundary.
  Swapping the server = reimplementing the frame protocol server-side; zero
  widget changes, minimal host changes.
- Tauri commands (window spawn, snap, persistence, `load_connection`) are host
  furniture, not part of either contract — they're identical no matter what
  server is connected.

### Bridge capability roadmap

The bridge grows by **capability, never by privilege** — widgets never gain
webview powers or Tauri access. Each cap is declared on the widget artifact,
fail-closed, and individually grantable:

| Cap | API | Status | Enables |
|---|---|---|---|
| `events:read` | `luna.subscribe(kinds, cb)`, `luna.refresh()`, `luna.ready()` | **shipped** | live data widgets (workspace views, NOW-style dashboards) |
| `action` | `luna.action(event, payload)` → routes to chat/agent as an event | phase 5 | buttons, forms, "approve/skip" — the survey/`request_secret` frames are the shipped precedent |
| `kv` | `luna.store.get/set` (artifact-scoped, size-capped, host-persisted) | phase 5 | stateful mini-apps — the Tamagotchi's hunger survives restart |
| `invoke` | `luna.invoke(tool, args)` → server-side allowlisted MCP/CLI calls | later, design-gated | widgets that tie back into CLI/MCP; needs per-widget tool allowlists + rate limits server-side |

This table is the OS-creep governor: every "could a widget…?" question is
answered by which cap it would need and whether that cap's blast radius is
acceptable — not by ad-hoc holes in the sandbox.

---

## Window Model

**One OS window per widget.** The moon keeps its small always-on-top window
(140×185) as the hub. Every widget is its own frameless, transparent,
always-on-top Tauri window hosting a small dedicated host page.

```
moon hub window (140×185, label "main")
  ├─ moon render + parallax + drag
  ├─ re-tether string episode (unchanged)
  ├─ ambient ladder: pip / orbit motes / toast   ← deck design language
  ├─ settings modal (incl. Vault/Skills/Connectors tabs)  [phase 1]
  ├─ setup wizard, updater, boot/token plumbing
  └─ voice pipeline ownership (hands-free works with no widgets open)

widget windows (one each)
  ├─ chat (main widget)  chat.html            owns the thread; voice UI lives here
  ├─ now rail            panel.html?type=now
  ├─ briefing            panel.html?type=briefing
  ├─ workflow            panel.html?type=flow&id=…
  ├─ agent line          chat.html?thread=…    [phase 6]
  └─ mini-apps           widget.html?id=…      (already shipped: artifact widgets)
```

### Why one-window-per-widget

- **Click-through is free.** Each window is exactly its own rectangle; the OS
  does hit-testing. A transparent overlay window, by contrast, is an opaque
  rectangle to the OS hit-tester (documented at `src-tauri/src/main.rs:864`)
  and needs the cursor-poll/`set_ignore_cursor_events` machinery running
  permanently.
- **"Separate from each other" is literal.** Any monitor, over other apps,
  independent crash domains, native drag. This is the Things 3 model: every
  document is a real window.
- **Master already ships the substrate**: `open_artifact_widget` /
  `close_widget` / `list_widget_windows` (`main.rs:791-866`), `widget.html`
  (a complete standalone WS-connected widget host), fail-closed
  `capabilities/widgets.json`, `vendor/deck-snap.js` (tested snap math),
  `vendor/widget-sandbox.js` (the mini-app trust boundary).
- Matches the connector-PRD §13/W2 decision (deck design language on the
  multi-window substrate).

### Why not an overlay window

The v1 draft assumed `pointer-events: none` lets clicks pass through transparent
areas to the desktop. It does not — CSS pointer-events only routes events inside
the webview. A fullscreen overlay would need the Rust cursor poll always-on with
every widget rect mirrored into it, breaks multi-monitor (fullscreen covers one
display), and puts every widget plus the moon in one crash domain. The bounded
"deck window" variant dies on the same goal: freely scattered widgets make its
bounding box approach fullscreen anyway. Both also violate "enhance the OS":
they reimplement window management the OS already provides.

### Accepted platform constraints (macOS, researched 2026-06-11)

| Constraint | Consequence |
|---|---|
| `onMoved` fires at drag **end** on macOS (`windowDidMove`; Apple forums thread/69721). WinAmp's continuous `WM_MOVING` is Win32-only. | **Snap-on-release**, like Rectangle/Photoshop. No live snap-during-drag in v1. Ghost preview only if real-Tauri verification shows mid-drag move events (operator-verify; evidence is mixed). |
| No relative z-order among always-on-top windows (Tauri #5656 closed-not-planned); last-focused wins. | Accepted (already accepted in PRD §23). Hub gets a **gather** action (raise + regroup all widgets). Global shortcut must show/hide **all** windows, not just `main` (`main.rs:1252` today targets only main). |
| `visibleOnAllWorkspaces` doesn't float over fullscreen apps (Tauri #11488). `tauri-nspanel` fixes Spaces behavior but its high panel level can block IME input (nspanel #104) — fatal for the chat composer. | v1 ships plain always-on-top windows. nspanel is a later, per-widget-type opt-in for **non-text** widgets only. |
| Each window = one WKWebView = own WebContent process, ~50–100 MB; process pooling is no longer controllable (Apple WKProcessPool docs). Closed webviews linger ~30 min in WebKit's process cache. | Widget budget: lazy spawn, **hide instead of destroy** for prebuilt widgets, soft cap ~8–10 concurrently open. Profile with Instruments before raising. |
| Tauri exits when the last window closes if no lifecycle handler (the historical "moon vanished" failure). | Explicit policy in `main.rs`: hub is the owning window — closing it closes all widgets; closing a widget never exits the app. |

---

## Connection Model

**N independent WS connections** — every widget host connects to the server
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

- **Only a chat widget subscribes to a thread** (and runs thread bootstrap,
  local-shell, secret entry, survey UI). One chat widget ↔ one thread.
- **Hub and all other widgets never send `subscribe-thread` / `new-thread`.**
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

## Widget Taxonomy

### Prebuilt widgets
Ship with Luna; designed UI; live data subscriptions. Opened from the moon
(or spawned by events); user can close, reopen, pin.

| Widget | Page | Data | Notes |
|---|---|---|---|
| Chat (main widget) | `chat.html` | own thread subscription | owns interactive frames; voice UI; the snap anchor |
| NOW rail | `panel.html?type=now` | `workflow-list` broadcast + obs | live job list, mini-moon phases |
| Briefing | `panel.html?type=briefing` | workflow runs + obs digest | "while you were away" |
| Workflow inspector | `panel.html?type=flow&id=…` | `workflow-runs` (+ request frame) | per-job step view |
| Agent direct line | `chat.html?thread=…` | own thread subscription | phase 6; a chat widget pointed at another thread |

Settings (incl. Vault/Skills/Connectors tabs) is **not** a widget in phase 1 —
it stays a hub overlay (it already is body-level DOM independent of chat).
It can become `panel.html?type=settings` later; VaultEngine is the cleanest-cut
engine in the monolith (own state slice, zero Tauri commands) when that day comes.

### Mini-app widgets
Sandboxed HTML mini-apps hosted by `widget.html` — agent-authored today via
`widget_write`, user/operator-authored tomorrow. **This extends the shipped
artifact pipeline — it does not fork it.** `widget_write`
(`packages/widget-tools/src/tools.ts:74`) already gives the agent create +
versioned-update of sandboxed widgets, registered into every thread;
`ArtifactStore` (luna.db) already persists pin state and broadcasts changes to
every client. Examples of what this family covers as bridge caps land:
live workspace views (`events:read`, shipped), documents (no caps at all),
interactive dashboards (`action`), persistent toys like the Tamagotchi (`kv`),
CLI/MCP-connected tools (`invoke`).

| Tier | Behavior | Backed by |
|---|---|---|
| ephemeral | AI-owned; gone when the AI closes it or the turn's session ends | extracted artifacts (exists) |
| session | survives until app quit | new: in-memory artifact flag |
| pinned | persists, restores on launch | `artifacts` table (exists) |

---

## AI Widget Tools (Phase 5)

Evolve the `widget_*` tool family rather than introducing a parallel vocabulary:

| Tool | Status | Work |
|---|---|---|
| `widget_write(spec)` | shipped | add declarative `kind`s (below); add `tier`; add position `hint` |
| update (same slug re-write) | shipped | — |
| `widget_append({id, content})` | missing | new store op + frame |
| `widget_close({id})` | missing | new tool; **ignored if user has pinned** (rule does not exist anywhere today — must be enforced server-side) |

**Content kinds.** Today the store has `html` (the full sandboxed mini-app path)
and code (escaped + highlighted). Add declarative kinds rendered by the host,
no widget JS needed: `markdown`, `table` (JSON → sortable), `form` (field defs;
submit routes back like `survey-response`), `live` (obs-subscribed views).
Declarative kinds are the cheap path for simple content; `html` + bridge caps
is the full mini-app path. Both land in the same store, tiers, and windows.

Window placement: the existing `open_artifact_widget` honors x/y — the widget
manager supplies positions from `hint` ("right-of-chat", "near-moon") resolved
against the live layout.

---

## Snap / Stick

- **Math:** `vendor/deck-snap.js` `computeSnap` stays the *only* snap
  implementation (pure, unit-tested). Iterate it over candidate anchors,
  pick the minimum gap.
- **Anchors:** chat widget (primary — hub-and-spoke, per the blessed deck
  concept), the moon hub, screen edges, then sibling widgets.
- **Trigger:** settle-snap — on `onMoved`, debounce ~120 ms after movement
  stops, then snap (the pattern `widget.html:418-464` already implements).
  Guard against the spurious `onMoved` from minimize (Tauri #7664) and from
  programmatic `setPosition` (suppression flag — the feedback-loop trap is
  documented at `index.html:10470`).
- **Group-drag** (dragging a docked cluster as one): **shipped** (Phase 0.5
  operator feedback). Rust-side dock graph in `main.rs`: widgets report dock
  state after every settle-snap (`set_dock`); the `WindowEvent::Moved` arm
  applies the hub's drag delta to every docked widget, with per-label
  suppression *counters* so follower echoes don't re-propagate. WinAmp
  semantics: dragging the hub carries the group; dragging a docked widget by
  itself moves only that widget — that is the detach gesture. (JS-side
  follower dragging was rejected: it would oscillate and lag per IPC tick.
  Native `addChildWindow` remains a future option but kills independent drag
  while parented.)
- ⚠️ **Phase 0 blocker:** the shipped self-snap has never run — `widget.html:438`
  misses `await` on `Window.getByLabel('main')` (async in Tauri 2), so
  `mainWin.outerPosition()` throws into the swallow-catch at `:460`. Fix,
  then operator-verify on real Tauri before stacking anything on it.
- The snap anchor label must be parameterized (widgets currently hard-code
  `'main'`; the chat widget becomes the natural anchor).

---

## Persistence

Two stores, deliberately split:

- **Pin state / widget content: server-side** in luna.db via the shipped
  `artifact-pin`/`unpin` frames. Single source of truth; do not duplicate
  pinned-ness into a client file.
- **Layout: client-side** `~/.luna/layout.json` — which widgets are open +
  window positions/sizes, written by the widget manager on settle/close
  (follow the `moon-connection.json` write pattern):

```json
{ "widgets": [
    { "id": "chat",        "x": 420, "y": 200, "w": 560, "h": 520, "open": true },
    { "id": "now",         "x": 165, "y": 200, "w": 140, "h": 320, "open": true },
    { "id": "widget-xyz",  "x": 990, "y": 200, "w": 360, "h": 440, "open": false }
] }
```

On launch: restore open widgets at saved positions, **clamped to visible monitor
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
  `CLIENT_INFO`, hello-capability parsing. **This file is the client half of the
  server-agnostic seam** — keep it free of anything luna-server-specific.
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
the chat widget hosts the mic button, transcript→composer injection,
spoken-reply accumulation off its own delta stream — voice-to-voice is part of
the main widget's surface, not a separate widget. Rust voice emits are currently
`emit_to("main")` (`main.rs:959-965` etc.) — switch to app-wide emit or a
window registry.

**Known traps:**
- Capabilities are fail-closed per window label: a new chat/panel window matches
  no capability file and gets **zero** IPC. Extend the capability set (mirroring
  `widgets.json`'s narrow-grant philosophy) before anything else.
- Thread bootstrap (`index.html:7000-7012`) auto-creates a thread when none
  exist — must run **only** in the chat widget or N windows race and spawn
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
- Capability entries for new window labels; global shortcut + show/hide iterate
  all windows; hub-owns-exit lifecycle policy in `main.rs`.

**Phase 0.5 — mini-app probes (gates Phase 2).** Prove the widget thesis on the
**shipped pipeline** — not lorem windows. Author three probe widgets as pinned
artifacts (via `widget_write` or seeded directly) and pop them out through the
real `open_artifact_widget` path:

1. **Live workspace widget** (`html` + `events:read`) — renders live data off
   the obs stream. Proves: the bridge data path, live updates, a real mini-app
   with zero new platform code.
2. **Tamagotchi** (`html`, local-state-only for now) — an ambient toy with
   timers and animation. Proves: long-lived widget processes, idle CPU/memory
   behavior, whether an always-on-top companion *feels* good. (Its hunger
   resets on restart until the `kv` cap exists — that's fine for the probe.)
3. **Document widget** — this design doc rendered as HTML. Proves: the
   throwaway-document use case end-to-end, content ergonomics, scrolling/read
   feel in a frameless window.

Live with all three plus chat for a few days. Operator verdict on: spawn
latency, snap-on-release feel, last-touched-wins z-order livability, memory at
10/20/30 windows (Instruments). Prototype the risk, not the product — the
platform unknowns and the mini-app thesis get answered for days of work before
the expensive extraction bet, using machinery that ships either way. Delete the
probe widgets after the verdict; keep the numbers in this doc.

**Phase 1 — shared modules (S0/S1)** — extract `moon-protocol/markdown/theme/ws`,
consume from `index.html`, frame switch → registry. Pure refactor, tests green,
zero behavior change. Ship alone — worth it even if the probe verdict changes
the widget plan, because the 11.5k-line monolith is a liability either way.

**Phase 2 — chat widget (S2/S3)** — `chat.html` + `open_chat_panel` command;
moon click spawns/focuses it; sub-engines move; snap anchor parameterized to
chat; `layout.json` save/restore; hub reattach signal redefined. The overhaul's
riskiest slice; everything after it is additive.

**Phase 3 — prebuilt widgets + hub ambient** — `panel.html` host for NOW rail /
briefing / inspector (data already on the wire); hub ambient ladder (pip →
motes → toast) driven by the obs stream, ported from the deck prototype branch
(`worktree-moon-agent-dropdown`, kept as reference); toast renders via the
envelope-grow machinery (it cannot fit the 140px window — the prototype's toast
is clipped to a 7px sliver).

**Phase 4 — voice split + hub cleanup (S4/S5).**

**Phase 5 — AI widget tools + bridge caps** — `kind: markdown|table|form`,
`tier`, `widget_append`, `widget_close` (+ pin-respect rule), placement hints;
bridge `action` and `kv` caps. (`invoke` stays design-gated behind its own
review — it's the cap that turns widgets into tool-callers.)

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
hub-side burst + a spawn/settle animation inside the arriving widget.
