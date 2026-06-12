# Luna Widget System — Design v3

_Status: accepted direction · Date: 2026-06-11_
_v3 (same day, post-probe verdict): **widgets become the main interaction mode.**
Settings panels become widgets, every widget gets a registry name + trust tier,
related widgets form stacks, and the agent can summon any widget by name. Chat
extraction is unchanged in content but now rides on the proven platform. See
"First-Class Widgets" and the revised Build Phases._
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

**v3 — widgets are the main interaction mode, not a side feature.** Every
surface the app shows is a widget: settings panels, the chat itself, rails,
documents, mini-apps. Being a widget makes a surface **addressable** — each one
has a registry name, so instead of digging through a modal the user can say
"open the voice settings" and the agent summons the panel. The moon hub is the
one non-widget: the launcher/anchor that owns the app lifecycle.

**v3.1 — content widgets are MCP apps.** The mini-app tier adopts the official
**MCP Apps** standard (SEP-1865, stable 2026-01-26) as its contract instead of
a private bridge dialect. The thesis: Luna's tools form **the core MCP app**;
building a widget is **building your own MCP app** that works with the full
system — and with the rest of the world, because the same app renders in
Claude Desktop, ChatGPT, VS Code, and Goose. Moon becomes an MCP Apps *host*
whose native display mode is the floating window. See "Widgets are MCP Apps".

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

> **v3.1 supersession note:** this roadmap predates the MCP Apps decision. The
> *principle* (capability-gated, fail-closed, never privilege) stands, but the
> vocabulary is replaced by the MCP Apps standard — see "Widgets are MCP Apps"
> for the mapping (`action`/`invoke` → spec `tools/call` with visibility
> scopes; `events:read`/`kv` → `luna/*` host extensions). Kept for the
> rationale and as the cap-thinking governor.

The bridge grows by **capability, never by privilege** — widgets never gain
webview powers or Tauri access. Each cap is declared on the widget artifact,
fail-closed, and individually grantable:

| Cap | API | Status | Enables |
|---|---|---|---|
| `events:read` | `luna.subscribe(kinds, cb)`, `luna.refresh()`, `luna.ready()` | **shipped** | live data widgets (workspace views, NOW-style dashboards) |
| `action` | `luna.action(event, payload)` → routes to chat/agent as an event | phase 7 | buttons, forms, "approve/skip" — the survey/`request_secret` frames are the shipped precedent |
| `kv` | `luna.store.get/set` (artifact-scoped, size-capped, host-persisted) | phase 7 | stateful mini-apps — the Tamagotchi's hunger survives restart |
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
  ├─ settings modal — shrinks tab-by-tab into settings.* panels [phases 2-3]
  ├─ setup wizard, updater, boot/token plumbing
  └─ voice pipeline ownership (hands-free works with no widgets open)

widget windows (one each)
  ├─ chat (main widget)  chat.html            owns the thread; voice UI lives here
  ├─ settings panels     panel.html?type=settings.updates | .voice | …  [phases 2-3]
  ├─ now rail            panel.html?type=now
  ├─ briefing            panel.html?type=briefing
  ├─ workflow            panel.html?type=flow&id=…
  ├─ agent line          chat.html?thread=…    [phase 8]
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
| Agent direct line | `chat.html?thread=…` | own thread subscription | phase 8; a chat widget pointed at another thread |

### System widgets: settings panels (v3)

The settings modal (7 tabs today, inventoried from `index.html` 2026-06-11)
decomposes into one **system widget per tab**, migrated tab-by-tab — the modal
keeps serving unmigrated tabs and dies when empty; the gear then becomes a
launcher. Each panel keeps its existing engine + backend wiring; only the
window changes:

| Kind | Today's tab | Backend channel | Migration order |
|---|---|---|---|
| `settings.updates` | Updates | Tauri `check_for_update` | **1st — smallest; proves the panel host** |
| `settings.voice` | Voice | Tauri `voice_*` + localStorage | 2nd — the summon-by-name demo ("open voice settings") |
| `settings.general` | General | localStorage + always-on-top | 3rd — exercises cross-window state fan-out |
| `settings.connection` | Connection | Tauri `save_connection`/`set_active_profile` | 4th — touches reconnect choreography |
| `settings.skills` | Skills | `skill-*` WS frames (broadcast) | 5th |
| `settings.connectors` | Connectors | `connector-*` WS frames (broadcast) | 6th |
| `settings.vault` | Vault | `vault-*` WS frames | **last — secret hygiene must travel** (wipe-on-close policy moves with the window; values never leave the panel) |

None of these violate thread ownership: settings frames (`vault-put`,
`register-op-token`, catalog broadcasts) are not thread-bound, so a settings
panel on its own WS connection is safe by construction.

### Mini-app widgets
Sandboxed HTML mini-apps hosted by `widget.html` — agent-authored today via
`widget_write`, user/operator-authored tomorrow. **This extends the shipped
artifact pipeline — it does not fork it.** `widget_write`
(`packages/widget-tools/src/tools.ts:74`) already gives the agent create +
versioned-update of sandboxed widgets, registered into every thread;
`ArtifactStore` (luna.db) already persists pin state and broadcasts changes to
every client. **v3.1: this family's contract is the MCP Apps standard** (see
"Widgets are MCP Apps") — a mini-app widget IS an MCP app: live workspace
views (event push), documents (no powers at all), interactive dashboards and
CLI/MCP-connected tools (mediated `tools/call`), persistent toys like the
Tamagotchi (`luna/kv` extension). Third-party MCP apps render here too;
agent-authored widgets via `widget_write` emit the same shape.

| Tier | Behavior | Backed by |
|---|---|---|
| ephemeral | AI-owned; gone when the AI closes it or the turn's session ends | extracted artifacts (exists) |
| session | survives until app quit | new: in-memory artifact flag |
| pinned | persists, restores on launch | `artifacts` table (exists) |

---

## First-Class Widgets (v3): Registry, Trust Tiers, Stacks, Summon-by-Name

The abstractions that make "everything is a widget" real. Four pieces, each
small; together they turn surfaces into addressable, relatable, AI-summonable
objects.

### Widget registry

One declarative table — **the single source of truth for what widgets exist** —
shipped with the app (single JSON, read by both the JS hosts and Rust via
`include_str!`). Every entry is a `WidgetDescriptor`:

```json
{ "kind": "settings.voice",
  "title": "Voice",
  "page": "panel.html?type=settings.voice",
  "trust": "system",
  "singleton": true,
  "description": "Voice mode, TTS voice, silence timing, speech model" }
```

- `kind` — the addressable name, dot-namespaced. This is what users, the hub
  launcher, and the agent all use to refer to a widget.
- `page` — which host page serves it. Only registry entries can resolve to
  trusted pages (see trust tiers).
- `singleton` — open = focus the existing window instead of spawning a twin
  (right default for every settings panel and rail).
- `description` — written for the **agent directory** (see summon-by-name);
  one line that lets a model pick the right widget from a user request.
- Parameterized kinds (`chat?thread=…`, `flow&id=…`) declare their params in
  the descriptor; instances get labels like `panel-settings-voice` /
  `chat-<thread>`.

A single Rust command `open_widget(kind, params, opener?)` replaces ad-hoc
spawning for everything except artifacts: resolve descriptor → enforce
singleton → place near opener (see stacks) → create/focus window. The shipped
`open_artifact_widget` stays as the **content-tier** path; it never consults
the registry.

### Trust tiers — the careful boundary

Two tiers, decided by **which host page serves the widget**, never by content:

| | **system** | **content** |
|---|---|---|
| Examples | settings.*, chat, rails, inspector | artifacts, mini-apps, probes |
| Host page | `panel.html` / `chat.html` (shipped HTML) | `widget.html` (sandboxed iframe) |
| Powers | Tauri IPC per window-label capability file, own WS connection, full frames | `luna.*` bridge only, cap-gated, CSP no-network |
| Window label | `panel-*` / `chat-*` | `widget-*` |
| Authored by | us, shipped in the app bundle | agent (`widget_write`) / user, stored server-side |

Hard rules: the registry only ever maps kinds to shipped pages, so **no
agent-authored artifact can become a system widget** — there is no input that
turns content into a `panel-*` window. And system pages never render
server-supplied HTML outside the sandbox. The dock/snap layer treats both
tiers identically (label allowlist in `set_dock` widens from `widget-*` to
include `panel-*`/`chat-*`; the moon stays alignment-only).

### Stacks — relationships between widgets

A **stack is a dock group plus provenance**. No new window-management
machinery — the live-verified group system (native parenting, flat symmetric
groups, pin-to-detach, perimeter highlight) *is* the stack mechanic. v3 adds
only the relationship data:

- **`openedBy` edge:** the host records which widget spawned which
  (`open_widget`'s `opener` arg). Default placement: a widget opened *from*
  another widget spawns docked to its opener's free edge, already joined to
  its group — open three settings panels from the gear and you naturally get
  a settings stack that drags as one and unpins like everything else.
- **Closing stays per-widget** (the ✕-closes-one rule, already shipped);
  survivors regroup by geometry. No cascade-close in v1 of stacks.
- Singleton + opener placement replaces the blind x/y cascade for system
  widgets.
- Later (not now): named/persisted stacks in `layout.json`, a hub "gather"
  raise, and a `widget-state` report (host → server: what's open, how
  grouped) so the agent can also *close* or arrange by name. Deferred until
  summon-by-name proves out.

### Summon-by-name (the AI opens widgets)

The user's ask: "open that settings panel" should be a sentence, not a hunt.
Three small pieces, all riding the existing server-agnostic seam:

1. **Directory in hello (client → server):** the hub reports its registry —
   `widgets: [{kind, description, params?}]` — as a hello capability. The
   server learns what's openable from the client, so it never hardcodes
   Moon's widget list (a different host can offer a different directory; a
   different server can ignore it).
2. **`widget-open` frame (server → client):** `{type: "widget-open", kind,
   params?}` → host resolves through the registry → `open_widget`. Unknown
   kind = reject, log, tell the agent.
3. **`open_widget` agent tool (server-side):** registered alongside the
   `widget_*` family, described from the directory the client sent. Two
   verbs, deliberately distinct: `widget_write` **creates content** (sandboxed,
   content tier); `open_widget` **summons existing surfaces by name** (any
   tier). The agent never composes a system widget — it can only name one.

**Safety default — the agent summons UI, it does not operate it.** Opening
`settings.vault` shows the panel; every mutation in it remains a user gesture.
Agent-driven settings *changes* are a separate, later design gate (they'd ride
the `action` cap review), and secret values never appear in any frame the
agent can read either way.

### Cross-window settings state (operator-verify before depending on it)

Settings panels mutate state other windows consume (always-on-top, shortcut,
model choice). Tauri-command-backed settings fan out naturally (Rust owns the
state and can emit app-wide — but note the cross-talk trap: targeted events
reach every global listener, so app-wide settings emits must carry the same
`for:`/scope discipline as `dock-group`). **ANSWERED (Phase 2 live probe,
2026-06-12): cross-window `storage` events DO fire between windows on real
Tauri/WKWebView** (hub wrote `luna_voice_mode=ptt`, an open panel received
the storage event) — Phase 3's fan-out for localStorage-backed settings rides
native storage events; command-backed state uses Rust emits. Per-window
semantics still need deciding per setting (e.g. "always on top" today means
the hub; as a panel setting it should mean *all* Luna windows).

---

## Widgets are MCP Apps (v3.1)

_Researched 2026-06-11 (spec, ecosystem, host-implementation tracks; citations
inline). Direction set by Mr. Cobb: "the core MCP app which is Luna's tools…
building a widget is effectively creating your own MCP app… that works with
the full system."_

### The standard, briefly

**MCP Apps** (SEP-1865; extension id `io.modelcontextprotocol/ui`; spec rev
`2026-01-26`, stable; repo `modelcontextprotocol/ext-apps`) is the official
MCP extension for interactive UIs, co-developed by Anthropic + OpenAI out of
the community mcp-ui project. An MCP server registers HTML templates as
`ui://` resources (`text/html;profile=mcp-app`); a tool links its UI via
`_meta.ui.resourceUri`; the host renders the template in a sandboxed iframe
and speaks **JSON-RPC 2.0 over postMessage** with it (`ui/initialize`
handshake → `ui/notifications/tool-input` / `tool-result` pushes; the app may
call `tools/call`, `ui/update-model-context`, `ui/request-display-mode`).
Hosts rendering today: Claude.ai/Claude Desktop, ChatGPT (Apps SDK converged
on the same wire protocol), VS Code/Copilot, Goose, Cursor, Postman. Official
SDK: `@modelcontextprotocol/ext-apps` (~v1.7) — app-side `App` class, host-side
`AppBridge` class. Day-one apps: Figma, Canva, Slack, Asana, Box, Hex.

### Why this fits Luna almost embarrassingly well

We independently built the same shape. The mapping is nearly 1:1:

| Luna today | MCP Apps standard |
|---|---|
| `vendor/widget-sandbox.js` — allow-scripts-only iframe, CSP no-network | Spec sandbox: no `allow-same-origin`; CSP `connect-src 'none'` **by default**, widened only by declared `_meta.ui.csp` domains |
| `luna.*` postMessage bridge, `bridge_caps` fail-closed | JSON-RPC postMessage bridge; tool `visibility` scopes (`["app"]`/`["model"]`/both), same-server-only tool calls |
| one floating window per widget | Goose's `standalone` display mode — **our native mode**; spec modes inline/fullscreen/pip |
| pinned artifacts restore on launch | **not in spec** (its biggest gap) — pinning = store the `ui://` URI + last `tool-input` and re-mount, which is exactly the artifact-pin model |
| `invoke` cap (was design-gated) | answered by the standard: `tools/call` mediated by the host, consent gates, app-only visibility |
| design-doc-only `action`/`kv` caps | `ui/update-model-context` + `tools/call` cover `action`; `kv` stays a Luna extension (spec has no persistence — ChatGPT's `widgetState` is proprietary) |

Two structural wins beyond the mapping:

1. **The host's MCP client can live anywhere.** The bridge is transport-
   agnostic, and `AppBridge` explicitly supports `client: null` with manual
   handlers (`oncalltool`, resource reads) — designed for exactly our
   topology: widget windows relay over **UI-WS to the Luna server, which owns
   every MCP session** (auth, allowlists, one session authority — this also
   sidesteps the ext-apps #481 dual-session bug Claude Desktop hit). The
   server-agnostic seam and the industry standard snap together.
2. **Two roles, one standard.** Moon as **host**: any MCP app anyone ships
   becomes a Luna widget — instant ecosystem (connectors PRD's MCP-primary
   bet pays off again). Luna server as **the core app**: its own tools gain
   `ui://` templates, so Luna's UIs render in Moon *and* in Claude Desktop /
   VS Code for free. No Tauri MCP Apps host exists as of June 2026 — Moon
   would be the reference implementation.

### What stays Luna-specific (host extensions, namespaced + degradable)

The spec doesn't cover everything our probes already use. These become
`luna/*` extension methods on the same bridge (hosts extending is normal —
Goose added `standalone`, ChatGPT added `window.openai.*`), advertised in
host capabilities so a portable app can feature-detect and degrade:

- **`luna/notifications/event`** — push obs-event stream (today's
  `events:read` / `luna.subscribe`). Portable apps poll via app-visible
  tools; Luna-native apps get push.
- **`luna/kv`** — artifact-scoped persistence (the Tamagotchi's hunger).
  The spec's #1 practitioner complaint ("the Mermaid your user edited? gone")
  is something we already solve server-side.
- **Pin/restore semantics** — host-side, invisible to apps.

### Trust model — unchanged

MCP apps are **content tier**, full stop. The registry still maps system
kinds only to shipped pages; no `ui://` resource can become a settings panel.
New care points from the spec's threat model: validate message origin against
the iframe `contentWindow`; enforce same-server tool scoping; build CSP from
declared `_meta.ui.csp` (reject or prominently warn on undeclared
`connectDomains` — our current widgets are no-network, MCP apps may
legitimately declare domains and that's a **user-visible consent moment**);
`eval` stays blocked (some libs need `unsafe-eval` — refuse by default).
Tool-side: `visibility:["app"]`-scoped tools never enter the model's tool
list, so prompt injection can't trigger them.

### Migration shape (staged like Archestra: render first, proxy second)

_(Estimates below are AI-build-speed — sessions of agent work + live
verification on the real build, which is the actual bottleneck — not the
human-team weeks the ecosystem writeups cite. Calibration: Phases 0+0.5 ≈ one
day; the 9-finding dock sweep incl. live verification ≈ one evening.)_

1. **Render-only host** (~1 session + live verify): widget.html grows an
   `AppBridge(client: null)` path; new UI-WS relay frames
   (`mcp-resource-read`, tool-input/result push); server resolves `ui://`
   reads against its MCP sessions. Third-party MCP apps render as widgets;
   no tool calls yet. (Ecosystem signal: one PR cycle for Archestra's team.)
2. **Full bridge** (~1–2 days incl. adversarial review + consent UX live
   verification): `tools/call` proxying through the server with visibility
   enforcement + consent UX; `ui/update-model-context` routed into the
   thread; host-context (theme vars from moon-theme, display modes).
3. **Convergence**: the three probes re-author onto the standard App API +
   `luna/*` extensions; `luna.*` v0 bridge retires (only the probes use it);
   `widget_write` keeps authoring sandboxed HTML but emits spec-shaped
   apps; Luna server registers `ui://` templates for its own core tools.

Practical notes: the app SDK is ~3MB and our CSP forbids network — bundled
apps must inline it (or speak raw JSON-RPC, which the probes can); hosts
prefetch templates at `tools/list` time, which our artifact pipeline already
approximates; MCPJam Inspector + the ext-apps `basic-host` are the dev rigs.

### As-built (Phase 7 v1, 2026-06-12)

The render-only host + same-app tool calls shipped, **core-app-provider
first**: the Luna server is the first MCP-app provider via an in-process
`CoreAppRegistry` (`apps/ui-web/scripts/core-apps.ts`) — no external MCP
session involved yet. Four additive UI-WS frames carry the relay
(`mcp-resource-read`/`-result`, `mcp-tool-call`/`-result`, hello cap
`mcpApps`; 43 server / 34 client), routed through
`@luna/ui-ws createMcpAppHost` (never-throws, requestId-correlated, same
connection). Artifacts gained kind `mcp-app` (content = the `ui://` URI);
widget.html renders them via `vendor/mcp-app-host.js` (`LunaMcpHost`) into
the SAME sandbox cage via `buildMcpSrcdoc` — identical CSP, **no `luna.*`
shim**. We deliberately speak **raw JSON-RPC, not the ~3MB official SDK**
(CSP forbids network; the needed surface is ~100 lines/side). First core
app: `ui://luna/workspace-pulse` (`pulse-snapshot` tool over the
EventCounter→TelemetryService counters; seeded as artifact
`probe-mcp-pulse`). Spec deviations (v1): no `ui/resource-teardown`, no
display-mode negotiation, no `ui/update-model-context`, no host-pushed
`tool-result` (apps pull), `tool-input` pushed once with empty arguments,
no `_meta.ui.csp` widening (network stays closed). **Follow-ups:**
external-MCP-server relay behind the same deps seam, `luna/*` push
extensions (event stream, kv), consent UX for declared CSP domains, full
probe convergence + `luna.*` v0 retirement.

---

## AI Widget Tools (Phase 7)

Evolve the `widget_*` tool family rather than introducing a parallel vocabulary.
(`open_widget` — summoning *existing* widgets by registry name — is a separate,
earlier verb; see "Summon-by-name". This section is the agent **creating**
content-tier widgets.)

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
Declarative kinds are the cheap path for simple content; `html` + the MCP Apps
contract is the full mini-app path. Both land in the same store, tiers, and
windows.

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
- **Group-drag** (dragging a docked cluster as one): **shipped, native, v3**
  (Phase 0.5 operator feedback, three rounds). Round 1 applied drag deltas to
  followers per `Moved` event — laggy. Round 2 went native
  (`NSWindow addChildWindow:ordered:` — the compositor carries the cluster in
  the same window-server transaction, zero lag) but exposed the parent/child
  hierarchy to the user: dragging different members did different things, and
  drag-detach caused phantom re-snaps. Round 3 made groups **flat and
  symmetric**: a star parented under one root that is silently **re-rooted at
  whichever member is grabbed** (`grab_dock` on drag-region pointerdown), so
  dragging anything carries everything. The ONLY detach is the **pin**
  (standard Lucide icon) in every grouped member's title bar — click to leave;
  Rust ejects the leaver past the magnet range, away from the group centroid.
  A grouped window never snaps against its own group (groups merge only with
  outsiders). All link UI is event-driven from Rust (`dock-group`): pin
  visibility plus a **very low perimeter highlight rendered only on
  outward-facing sides** (pure rect geometry decides which sides are
  interior) — the group reads as one piece without highlighting the seams.
- ✅ **Fixed in Phase 0** (was the v2 blocker): the shipped self-snap had never run — `widget.html:438`
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

## Build Phases (v3 ordering)

v3 reorders v2: the widget platform + settings migration land **before** chat
extraction, because settings panels prove the system-widget path (registry,
panel host, capabilities, stacks, summon-by-name) on small low-risk surfaces —
then the riskiest slice, chat, rides proven machinery. v2→v3 mapping: old
Phase 2 (chat) → 4; old 3/4/5/6 → 5/6/7/8.

**Phase 0 — unbreak the foundation. ✅ DONE 2026-06-11** (`43d35e3`) — await
fix, lifecycle policy, all-window shortcut, capability entries.

**Phase 0.5 — mini-app probes. ✅ DONE 2026-06-11** — three probes built +
seeded; group-drag iterated three rounds on live feedback to the native flat
symmetric dock-group system; full bug sweep live-verified (`60fad82`).
**Operator verdict 2026-06-11: positive** ("I like this panel system. It seems
to be working well") → widgets confirmed as the main interaction mode (this v3).
Long-horizon items (memory at 10-30 windows via Instruments, days-long ambient
feel) remain open and ride along during phases 1-3.

**Phase 1 — shared modules (S0/S1)** — extract `moon-protocol/theme/ws`
(frame switch → registry), consume from `index.html`. Pure refactor, tests
green, zero behavior change. Scope note: `moon-markdown` extraction can slide
to Phase 4 (chat) — panel.html doesn't need it; the first three modules are
exactly what panel.html consumes.
_As-built decisions (2026-06-11):_ the hub adopts the **registry + close-hook
seam + protocol constants** but keeps its bespoke transport (turn watchdogs /
tether choreography are too entangled to move before the chat extraction);
`LunaWS.createClient` is the shared transport for the widget-page family —
widget.html converged now, panel.html consumes it in Phase 2. And
`moon-theme.css` is linked by the widget-page family ONLY: index.html has its
own `.close-btn` (chat header) that the shared chrome would silently restyle —
the hub joins the shared theme when Phase 4 strips its stylesheet to hub-only.

**Phase 2 — widget platform core + first panel.**
- `vendor/widget-registry.json` + descriptor loading (JS + Rust `include_str!`).
- `panel.html` system-widget host (theme + moon-ws + a per-type module slot).
- `open_widget(kind, params, opener?)` command: singleton focus, opener-edge
  placement + stack join (`openedBy`), `panel-*` labels; capability file for
  `panel-*`; widen `set_dock`'s anchor allowlist to `panel-*` (moon stays
  alignment-only).
- `layout.json` save/restore for open system widgets (clamped to monitor).
- Migrate **`settings.updates`** end-to-end: its modal tab becomes a launcher
  button → panel opens docked to nothing, singleton, fully functional.
- Verify cross-window `storage` event delivery on real Tauri (decides the
  settings fan-out mechanism).

**Phase 3 — settings migration + summon-by-name. ✅ DONE 2026-06-12**
(`91de7cd`, live-verified on the rig).
- All seven tabs are panels (frontend/panels/*.js modules, 82 panel tests);
  the modal died → a pure launcher; hub fan-out = `hub_event` (allowlisted
  names, `for:` discipline) + cross-window storage events (live-verified) +
  an available-models localStorage cache; voice events broadcast app-wide
  (Phase 6 item pulled forward); the vault panel carries its wipe policy on
  its own connection via the LunaWS close-hook seam.
- Summon-by-name shipped: `widget-directory` / `widget-open` frames,
  WidgetSummonBridge (last-announcer-wins, kind-validated), `open_widget`
  agent tool in widget_tools. Live: the hub announces 7 widgets on every
  hello (server log). The full spoken *"open the voice settings"* demo
  needs a model-bearing server — operator-verify on the real moon.

**Phase 4 — chat widget (S2/S3). ✅ DONE 2026-06-12** (`8f08d6d`, live-verified) — `chat.html` as registry kind `chat`;
moon click → `open_widget("chat")`; sub-engines move; snap anchor
parameterized to chat; hub reattach signal redefined. Still the overhaul's
riskiest slice — but now on a platform that's been carrying settings panels
for two phases.
_As-built decisions (2026-06-12):_ the chat window's label is `panel-chat`
(rides the panel-* dock/layout/capability surface; an ADDITIVE chat.json
capability grants attachments/local-shell/thread-persistence/voice-surface/
open_widget on that exact label). Once chat leaves, the hub is permanently
moon-sized — so the Phase 3 launcher modal becomes a **`settings` launcher
PANEL** and the gear lives in the chat header. `hub_event('fresh-thread')`
routes to `panel-chat` when open (the chat window owns the thread), falling
back to the hub, which opens the chat. Extraction is copy-based: the hub's
chat code goes dormant in Phase 4 and is deleted in Phase 6 (S5), so every
commit stays green. `moon-markdown.js` extracts now (chat.html consumes it).

**Phase 5 — prebuilt widgets + hub ambient. ✅ DONE 2026-06-12** (server `6ae66ad`, client `006cc2c`, live-verified; needs-input answer-card E2E = model-bearing operator item) — NOW rail / briefing / inspector
as registry kinds on `panel.html` (data already on the wire); hub ambient
ladder (pip → motes → toast) ported from the deck prototype branch; toast
renders via the envelope-grow machinery (it cannot fit the 140px window — the
prototype's toast is clipped to a 7px sliver).

**Phase 6 — voice split + hub cleanup (S4/S5). ✅ DONE 2026-06-12** (`86226f9`; voice broadcast landed early in Phase 3; index.html 11,164 → 3,237 lines, hub registry = hello/job-input-request/job-input-status/widget-open).

**Phase 7 — MCP Apps host + AI widget tools. ✅ DONE 2026-06-12 (v1 as-built — see the section note)** (`4424ca0`; ui://luna/workspace-pulse live on the rig; external-server relay + luna/* push + remaining probe convergence = documented follow-ups). The content tier adopts the
standard (see "Widgets are MCP Apps"), staged: render-only host → full tool
proxy + consent UX → probe convergence + `luna.*` v0 retirement; `luna/*`
extensions (event push, kv) land here. The `widget_*` authoring tools evolve
alongside — `kind: markdown|table|form`, `tier`, `widget_append`,
`widget_close` (+ pin-respect rule), placement hints; declarative kinds are
host-rendered and orthogonal to the app contract. (The old `action`/`kv`/
`invoke` bridge-cap track is superseded; `invoke`'s design gate is satisfied
by the spec's mediated `tools/call` + visibility scopes + consent.) **This
phase is independent of phases 4–6** — it touches widget.html + server relay
only, not the monolith — and can be pulled forward if MCP-app demand arrives
before chat extraction. Candidate rider: `widget-state` report + agent
close-by-name, if summon-by-name proves demand.

**Phase 8 — agent direct lines. ✅ DONE 2026-06-12** (`ebd2ec3`, two pinned chat windows live-verified) — `chat.html?thread=…`; protocol already
multi-thread (`subscribe-thread`/`thread-list`/`threadId` on every frame);
needs an agent-identity/thread mapping, honors one-window-per-thread.

**Server track (parallel):**
- `open_widget` agent tool + `widget-open` frame + hello `widgets` capability
  (Phase 3's server half — small; the directory arrives client-side).
- **MCP Apps relay** (Phase 7's server half): UI-WS frames for `ui://`
  resource reads + `tools/call` proxy against the server's MCP sessions
  (single session authority — the server already owns all MCP connections),
  tool-input/result push routed to the owning widget connection; later, Luna's
  own core tools register `ui://` templates (the "core MCP app").
- A real "needs input" job status — `JobRunStatus` is `queued|running|success|
  failed|cancelled`; the waiting state the whole notification ladder keys on
  does not exist — plus an answer channel into a running job (the
  `request_secret` bridge is the template). Without this, NOW/briefing/toast
  only ever demo on fake data.

---

## Deck design language — what survives the window split

Watercolor chrome, blots, mini-moon phase glyphs, pip/orbit-motes/toast on the
hub: all live inside single windows and port directly from the prototype branch.
**Mote-flight from moon into the NOW rail** crossed panel boundaries in the
one-window prototype and cannot render across OS windows — replaced by a
hub-side burst + a spawn/settle animation inside the arriving widget.
