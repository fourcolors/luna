# Every Panel is an MCP App — Exploration & Architecture

> Status: **exploration / design synthesis** (2026-06-15). Not a build plan yet —
> this maps where Luna is vs. the "all UI = MCP apps" goal and surfaces the
> decisions that gate the build. Extends `apps/ui-moon-tauri/design/widget-system.md`
> (the canonical plan) and `DESIGN.md §9` (UI system, explicitly *revisable*).

---

## TL;DR

1. **The goal is already this codebase's documented north star.** `widget-system.md`
   v3.1 ("Widgets are MCP Apps") records the operator's own direction: *Luna's
   tools are the core MCP app; building a widget = building your own MCP app that
   works with the full system — and renders in Claude Desktop / ChatGPT / VS Code /
   Goose too.* We are not starting a new direction; we are continuing a staged one.

2. **The substrate already exists and targets the real standard.** Phase 7 (v1,
   commit `4424ca0`, shipped 2026-06-12) built a working **MCP Apps host** —
   client + server + wire protocol — implementing **SEP-1865** (the official MCP
   Apps spec, rev `2026-01-26`, *stable*). It is live as the `mcp-app` artifact
   kind, with one real core app (`ui://luna/workspace-pulse`).

3. **What's missing to reach "*every* panel = MCP app" is well-scoped and already
   enumerated** in the doc's own follow-up list + 3-stage migration plan:
   - **Theming across the sandbox** (the standardization enabler) — *not built*.
   - **Display-mode ↔ Luna's window/dock model** — *not built*.
   - **Action bridge back into Luna** (`ui/update-model-context`, consent) — *partial*.
   - **3rd-party / external MCP-server relay** (the plug-and-play seam) — *named, not built*.
   - **Convergence**: collapse the other panel kinds + the legacy `luna.*` bridge
     onto the one MCP-app path — *not built*.

4. **The one genuine fork** is how far to push: **content-tier convergence**
   (standardize all *content* UI as MCP apps; keep trusted system panels as
   shipped pages) vs. **total** ("*everything* — settings, chat, rails — is an MCP
   app"), which requires a new **trusted/first-party app tier** that breaks
   today's "trust = which host page" firewall. See [Decisions](#decisions).

---

## 1. What MCP Apps are (SEP-1865), briefly

**MCP Apps** is the official Model Context Protocol extension for interactive UI
(extension id `io.modelcontextprotocol/ui`; spec rev `2026-01-26`, **Final/stable**;
repo `modelcontextprotocol/ext-apps`). Co-developed by Anthropic + OpenAI out of
the community **mcp-ui** project (which is now the compliant reference SDK).

The shape:

- A server **predeclares HTML templates as `ui://` resources** with MIME
  `text/html;profile=mcp-app`. A tool links its UI via `_meta.ui.resourceUri`.
- The host renders the template in a **sandboxed iframe** and speaks **JSON-RPC 2.0
  over `window.postMessage`** with it — *no custom protocol*, the same MCP RPC
  machinery.
- Lifecycle: iframe sends `ui/initialize` → host returns an init result (incl.
  **theme/style variables**, display mode, locale, container dims) → iframe sends
  `ui/notifications/initialized`. Host then pushes `tool-input` / `tool-result`;
  the app may call `tools/call`, `ui/update-model-context`, `ui/request-display-mode`,
  `ui/open-link`, `ui/message`.
- **Theming is first-class**: the host injects ~80 standardized CSS variables
  (`--color-background-primary`, `--color-text-primary`, `--font-sans`,
  `--border-radius-md`, …) in the init result and re-pushes them on
  `host-context-changed`. An app written against these variables inherits *any*
  compliant host's theme — Claude, ChatGPT, Goose, **and Luna**.
- **Security**: iframe cannot reach host DOM / cookies / storage; web hosts use a
  double-iframe sandbox-proxy; tool calls are scoped by a **same-server rule**;
  CSP is `connect-src 'none'` by default, widened only by declared
  `_meta.ui.csp` domains (a user-consent moment).

**Why it's the right bet for the stated goals**: standardized variable names →
uniform theming; a published wire contract → 3rd-party apps render without shipping
code into Luna; the same app also runs in every other compliant host.

---

## 2. What Luna already has (Phase 7 v1)

Luna independently built the same shape, then adopted the standard. As-built:

### 2.1 The MCP Apps relay plane (distinct from the agent-tool plane)

Luna has **two** MCP-ish planes — don't conflate them:

| Plane | Who calls tools | Transport | Result |
|---|---|---|---|
| **Agent-tool plane** | the *model* (Claude Agent SDK `query()`) | in-process MCP servers (`packages/adapter-sdk`, `memory-tools`, `local-shell-tools`, `widget-tools`, …) | text content blocks → chat frames |
| **UI MCP Apps plane** | a *rendered panel* (sandboxed iframe) | **UI WebSocket** relay frames (`packages/ui-ws`) | `ui://` HTML + `tools/call` results |

The **UI MCP Apps plane** is the substrate for "panel = app":

- **Client hosts** (turn a sandboxed iframe into an MCP App frame; speak the host
  side of the JSON-RPC):
  - `packages/ui-shared/src/mcp-app-host.ts` — web (Solid), `host({frameEl, uri, html?, transport, onError})`.
  - `apps/ui-moon-tauri/frontend/vendor/mcp-app-host.js` — Moon (`LunaMcpHost`), the original.
- **Server registry** (`apps/ui-web/scripts/core-apps.ts`) — resolves `ui://`
  resources and routes app `tools/call`, with the **same-server rule enforced
  server-side** (`Object.hasOwn` guard). Three provider shapes already exist:
  - `createCoreAppRegistry` — `ui://luna/<name>` core apps that ship real JS tool handlers.
  - `createStoreBackedAppRegistry` — `ui://luna/app/<artifactId>` generated/user apps
    (no server JS → share a fixed **curated read-only** allowlist, `buildCuratedAppTools`).
  - `composeAppRegistries(...)` — chains providers by **disjoint `ui://` namespace**
    (a cross-namespace call can never reach the wrong app's tools).
- **Wire protocol** (`packages/ui-ws/src/protocol.ts`, mirrored in
  `packages/ui-shared/src/wire.ts`) — 4 additive frames gated on the hello
  `mcpApps` capability:
  `mcp-resource-read` / `mcp-resource-result` / `mcp-tool-call` / `mcp-tool-result`,
  routed by `createMcpAppHost` (never-throws, requestId-correlated).
- **Producer** (`packages/widget-tools/src/tools.ts`) — the agent authors a
  `kind="mcp-app"` artifact whose HTML pulls live data via `tools/call`. Auto-opens
  via `open-artifact-widget` frame.

### 2.2 The host JSON-RPC surface (what v1 implements)

From `mcp-app-host.ts` — the host answers `ui/initialize`
(`{protocolVersion: "2026-01-26", host: {name}, capabilities: {serverTools}}`),
accepts `ui/notifications/initialized` then pushes `ui/notifications/tool-input`
(empty args), routes `tools/call` → `transport.callTool`, returns
`method not found` for unknown requests, and trusts **only**
`e.source === frameEl.contentWindow`.

### 2.3 The render path & sandbox cage

`mcp-app` artifacts mount in the **same hard sandbox** as legacy widgets
(`buildMcpSrcdoc` / `buildGeneratedAppSrcdoc` in
`packages/ui-shared/src/widget-sandbox.ts`): `sandbox="allow-scripts"` only (no
`allow-same-origin`), opaque origin, CSP no-network, no `__TAURI__`. Web renders
via `packages/ui-shared-solid/src/ArtifactPanel.tsx` (the `kind==="mcp-app"`
branch with a `props.mcp` relay); Moon via `widget.html` + the vendor host.

### 2.4 v1 deviations from the full spec (the gap, verbatim from the doc)

> no `ui/resource-teardown`, no display-mode negotiation, no
> `ui/update-model-context`, no host-pushed `tool-result` (apps pull),
> `tool-input` pushed once with empty arguments, no `_meta.ui.csp` widening
> (network stays closed) — **and no `styles` / `host-context` (theming)**.

---

## 3. The gap to "every panel = MCP app"

Today panels are **heterogeneous** — three render strategies coexist:

| Artifact kind | Render path | Themed? | Interactive? |
|---|---|---|---|
| `code`, `markdown` | native inline (panel DOM) | ✅ inherits tokens | no |
| `html` | sandboxed iframe preview | ❌ no tokens | no bridge |
| `widget` | sandboxed iframe + legacy `luna.*` bridge | ❌ no tokens | cap-gated |
| `mcp-app` | sandboxed iframe + **MCP Apps host** | ❌ no tokens | `tools/call` |

And **system** surfaces (settings, chat, rails) are shipped HTML pages
(`panel.html` / `chat.html`), not apps at all.

"Every panel is an MCP app, standardized, themeable, 3rd-party-pluggable" requires
closing five gaps — each maps to a stage the doc already planned:

### G1 — Theme injection across the sandbox  *(the standardization keystone)*
CSS variables **do not cross the iframe boundary** (confirmed: zero injection in
any srcdoc builder today). The fix is the spec's own mechanism: extend the host's
`ui/initialize` result with `styles.variables` and push
`ui/notifications/host-context-changed` on theme change. This means **mapping
Luna's watercolor tokens → SEP-1865 standard variable names** once, in the host:

```
Luna token            →  SEP-1865 standard variable
--paper, --paper-2    →  --color-background-{primary,secondary}
--ink, --ink-soft     →  --color-text-{primary,secondary}
--ink-faint           →  --color-border-primary
--accent              →  --color-ring-primary / accent
--font-chat           →  --font-sans
--radius              →  --border-radius-md
```

That mapping table *is* the "standardize all UI so it themes uniformly" deliverable.
Luna's appearance module already broadcasts theme changes via `storage` events
(`appearance.ts` / `moon-appearance.js`) — the host hooks that to push live updates.

### G2 — Display mode ↔ Luna's window/dock model
Luna's native display mode is the **floating window** (Moon) / **docked board
panel** (web) — exactly Goose's `standalone` mode. Wire `ui/request-display-mode`
(`inline` / `fullscreen` / `pip` / `standalone`) to Luna's spawn/dock/pin
machinery so an app can ask to pop out, dock, or go fullscreen. Pin/restore stays
host-side (the spec's biggest gap; Luna already solves it via artifact-pin).

### G3 — Action bridge back into Luna
Add `ui/update-model-context` (inject app output into the chat thread) and
`ui/message`, plus a **consent gate** before either reaches the model. This is the
"ties back into Luna" half — a panel that drives the agent, not just displays.
Today only same-app `tools/call` works.

### G4 — 3rd-party / external MCP-server relay  *(the plug-and-play seam)*
The seam is already named: *"External MCP servers … plug in behind the same
`McpAppHostDeps` seam."* Build a provider that connects an external/connector MCP
server (stdio / streamable-HTTP), lists its `ui://` resources, and proxies its
tools — composed into `composeAppRegistries` under its own namespace, same-server
rule intact. Luna's connectors system (`packages/connectors`) is the natural feed.
**This is the literal "3rd parties plug and play into Luna."**

### G5 — Convergence onto one path
Re-author `code`/`markdown`/`html`/`widget` so there is **one** render path. Two
sub-options (see Decisions): make them **declarative host-rendered kinds**
(`markdown`/`table`/`form`/`live`, per the doc's "AI Widget Tools" section) *or*
make them **core MCP apps** (`ui://luna/markdown`, `ui://luna/code`, …) so
*everything* is uniformly an app and uniformly themed. Retire the legacy `luna.*`
v0 bridge once the probes move over.

---

## 4. Target architecture (one substrate)

```
┌──────────────────────────────────────────────────────────────────────┐
│  PANEL CONTENT  (every panel: settings, chat*, artifact, 3rd-party)    │
│  = an MCP App — HTML behind a ui:// resource, speaking JSON-RPC 2.0    │
│    over postMessage, themed by host-injected SEP-1865 CSS variables    │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ ui/initialize · tool-input/result ·
                                │ tools/call · request-display-mode ·
                                │ update-model-context · host-context-changed
┌───────────────────────────────┴──────────────────────────────────────┐
│  HOST  (Moon vendor host · web shared host)                           │
│  · injects theme vars (G1) · maps display modes → windows/dock (G2)   │
│  · relays tools/call + model-context with consent (G3)                │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ UI-WS relay frames (mcp-resource-read/-result,
                                │ mcp-tool-call/-result) — hello cap `mcpApps`
┌───────────────────────────────┴──────────────────────────────────────┐
│  SERVER REGISTRY  composeAppRegistries(                               │
│    coreAppRegistry,          // ui://luna/<name>     — first-party JS  │
│    storeBackedAppRegistry,   // ui://luna/app/<id>   — generated/user  │
│    externalServerRegistry,   // ui://<connector>/*   — 3rd-party (G4)  │
│  )  · same-server rule · CSP from _meta.ui.csp · provider trust tiers  │
└───────────────────────────────────────────────────────────────────────┘
*chat/settings as apps only under the "total" option — see Decisions.
```

The shape is *already there* through the server registry; G1–G5 fill it in.

---

## 5. Decisions

These are genuine forks (no obvious default) — they shape what gets built and the
security posture. Recommendations are mine; the call is the operator's.

### D1 — How far does "every panel" go?  *(the load-bearing decision)*
- **(A) Content-tier convergence** — standardize all *content* UI as MCP apps
  (G1–G5 for artifacts/mini-apps/3rd-party); keep `system` panels (settings, chat,
  rails) as trusted shipped pages. Preserves today's "trust = which host page"
  firewall. Lower risk, fully delivers theming + 3rd-party plug-and-play for content.
- **(B) Total** — *everything*, including settings/chat/rails, becomes an MCP app.
  Requires a **third trust tier**: a *first-party/trusted* provider
  (`ui://luna-system/*`, served from the app bundle, never from agent/user content)
  that the host grants elevated `luna/*` capabilities (settings mutation, window
  control). Trust shifts from "which host page" → "which provider/namespace served
  the resource." Maximum uniformity (one substrate, themeable, even system UI is
  pluggable), but it reworks the security model and is a bigger build.
- **Recommendation: A now, with the host/registry designed so B is an additive
  tier later.** A delivers the stated goals (uniform theming + 3rd-party) without
  touching the trust firewall; B becomes "add a trusted provider," not a rewrite.

### D2 — Theming standard: adopt SEP variable names, or map Luna's?
- Adopt the **SEP-1865 standard variable names** as the contract (host maps Luna
  tokens → standard names once). 3rd-party apps written for *any* host just work; a
  small Luna-native shim can also expose `--paper`/`--ink` for first-party apps.
- **Recommendation: adopt the standard names** (that's the whole point of
  standardization) + ship a tiny optional Luna-alias layer for our own apps.

### D3 — Raw JSON-RPC vs. the official `@modelcontextprotocol/ext-apps` SDK
- v1 deliberately speaks **raw JSON-RPC** (~100 lines/side) because the official
  SDK is ~3MB and Luna's CSP forbids network (can't CDN it; bundling bloats every
  app). 
- **Recommendation: keep raw JSON-RPC for the host + first-party apps; document
  that 3rd-party apps may inline the SDK if they choose.** Revisit only if the
  spec surface we implement grows past what's comfortable by hand.

### D4 — Migration order / first slice
- **Recommendation:** **G1 (theme injection) first** — highest leverage, smallest
  blast radius, immediately makes the existing `mcp-app` kind (and every future
  app) theme-correct, and produces the reusable token→variable mapping. Then G4
  (external relay — the visible 3rd-party win), then G2/G3, then G5.

---

## 6. Risks & open questions

- **Trust firewall (D1-B).** Elevating any `ui://` content to system powers is the
  single biggest security decision; if we go past A, the provider-trust tier needs
  its own review (the doc's threat-model care points: origin validation,
  same-server scoping, CSP consent, `eval` stays blocked).
- **External-server CSP.** 3rd-party apps may legitimately declare network domains
  (`_meta.ui.csp`) — that's a **user-visible consent moment**, not a silent allow.
  Needs consent UX (a named follow-up).
- **Spec is moving.** A 2026-07-28 RC (SEP-2575) removes the `ui/initialize`
  handshake in favor of per-request `_meta`. Our host abstracts the handshake, so
  this is contained, but the convergence work should track it.
- **Two frontends, parity-pinned.** Moon (vendor JS) and web (shared ES) hosts are
  kept in lockstep by `widget-sandbox.parity.test.ts`; every host change lands twice.
- **Per-client theme.** Appearance prefs are localStorage per client today (no
  server sync). Theme injection inherits that — fine, but a future server-synced
  profile would change where the host reads tokens.

---

## 7. Source map (verified file anchors)

| Concern | Files |
|---|---|
| Canonical plan | `apps/ui-moon-tauri/design/widget-system.md` (§"Widgets are MCP Apps", "As-built Phase 7 v1", "Trust tiers") |
| Client host | `packages/ui-shared/src/mcp-app-host.ts`, `apps/ui-moon-tauri/frontend/vendor/mcp-app-host.js` |
| Server registry | `apps/ui-web/scripts/core-apps.ts`; wired in `apps/ui-web/scripts/chat-server.ts` (`createMcpAppHost`, ~2896) |
| Wire protocol | `packages/ui-ws/src/protocol.ts`, `packages/ui-ws/src/mcp-app-host.ts`, `packages/ui-shared/src/wire.ts` (`ArtifactKind`, relay frames) |
| Render / sandbox | `packages/ui-shared-solid/src/ArtifactPanel.tsx`, `packages/ui-shared/src/widget-sandbox.ts`, `apps/ui-moon-tauri/frontend/widget.html` |
| Producer tools | `packages/widget-tools/src/tools.ts`, `packages/core/src/artifacts/types.ts` |
| Theming tokens | `apps/ui-moon-tauri/frontend/vendor/moon-palette.css`, `apps/ui-web/src/watercolor.css` |
| Theme apply | `apps/ui-moon-tauri/frontend/vendor/moon-appearance.js`, `apps/ui-web/src/appearance.ts` |

## 8. Sources (MCP Apps / SEP-1865)

- SEP-1865 (Final): https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp
- ext-apps spec (rev 2026-01-26): https://github.com/modelcontextprotocol/ext-apps
- Announcement (2026-01-26): https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/
- mcp-ui (reference SDK): https://github.com/MCP-UI-Org/mcp-ui · https://mcpui.dev
- `applyHostStyleVariables` / CSS variable catalog: https://apps.extensions.modelcontextprotocol.io

---

## Addendum — build + spec confirmation (2026-06-15)

**G1 is built and verified this session** (branch `worktree-explore-mcp-app-panels`,
uncommitted). Both hosts (`packages/ui-shared/src/mcp-app-host.ts` +
`apps/ui-moon-tauri/frontend/vendor/mcp-app-host.js`) map Luna's watercolor tokens
→ SEP-1865 standard variables (`LUNA_SEP_MAP`) and ship them in the
`ui/initialize` result + a live `ui/notifications/host-context-changed`
(MutationObserver on `<html>` `data-*`). `workspace-pulse` consumes them. **1133
tests green, 0 tsc errors, screenshot-verified** (real host + cage + app + tokens;
tide dark↔light flips re-theme live). The auto-theming **cage shim** (so *every*
hosted app themes without author code) is the next increment — it touches the
byte-parity-pinned `widget-sandbox.ts`, hence staged second.

**Spec status (confirmed by ecosystem research).** mcp-ui **removed remote-DOM**
after standardization; SEP-1865's MVP is **HTML-only**, and the ratified theming
mechanism is exactly host-pushed CSS variables via `ui/initialize` `styles.variables`
+ `host-context-changed` — i.e. precisely what G1 implements. **There is no
remote-DOM-vs-HTML fork to decide**: raw-HTML + CSS-variable theming *is* the
standard, and Luna was already on that side. D2/D3 stand; the earlier remote-DOM
framing is retired.

**Interop caveat (matters at G4, not now).** For 3rd-party apps to inherit Luna's
theme automatically, `LUNA_SEP_MAP` must target the **exact** SEP variable names
from the ext-apps catalog (`--color-background-primary`, `--color-text-primary`,
`--font-sans`, `--border-radius-md`, …). Sources vary slightly (one shows an
`--mcp-` prefix); verify against `apps.extensions.modelcontextprotocol.io` before
the external relay ships. For Luna's own apps the names are internal and already
consistent on both sides.

**Artifact render contract (confirmed by the end-to-end trace).** 5 kinds; Moon
renders `mcp-app` only in the pop-out `widget.html` window (the `chat.html` overlay
shows source for non-text kinds), web renders all kinds inline in `ArtifactPanel`.
G1's two host edits cover both render paths.

---

## Addendum 2 — G1.5 auto-theming cage shim (2026-06-16)

**Built + verified.** A passive, capability-free `THEME_SHIM` now lives in both
MCP-app cages (`packages/ui-shared/src/widget-sandbox.ts` `buildMcpSrcdoc` +
`buildGeneratedAppSrcdoc`, byte-mirrored in
`apps/ui-moon-tauri/frontend/vendor/widget-sandbox.js`). It applies host-pushed
`styles.variables` (from the `ui/initialize` result and `host-context-changed`)
to the iframe `documentElement`, so **any** hosted app — including a third
party's with *zero theme code* — inherits Luna's palette just by writing
`var(--color-*)`. It sends nothing, opens no network, and references neither
`window.luna` nor `window.mcp` (asserted by the parity test) — so it grants no
capability, only mirrors host-provided CSS custom properties. **1134 tests green,
0 tsc errors, screenshot-verified** with a zero-theme-code "third-party" app in
dark+light. The legacy `luna.*` widget cage (`buildSrcdoc`) is intentionally
untouched — no MCP theme channel feeds it; theming it would need a `luna.*` host
push, a separate step.

**Accent-name correction (research-driven, important for interop).** The SEP
catalog has **no `--color-accent`** — the brand/accent color is
`--color-ring-primary`. `LUNA_SEP_MAP` now emits only exact standard names, so a
spec-compliant 3rd-party app genuinely inherits Luna's accent. This was caught by
reading the ext-apps CSS-variable catalog, *not* by our own tests (the wrong name
"worked" only because our app referenced the same wrong name on both sides) — the
kind of bug that research, not unit tests, surfaces.

**Next: G4 — external-MCP-server relay** (the visible "plug-and-play into Luna"
demo): a `McpAppHostDeps` provider that lists an external server's `ui://`
resources and proxies its tools, composed into `composeAppRegistries`. Theming is
now automatic for whatever it renders.

---

## Addendum 3 — G4 external-server relay CORE (2026-06-16)

**Library pick: `@modelcontextprotocol/sdk` v1.29.0** (official). Chosen over
Vercel AI SDK / `mcp-use` (archived) / FastMCP (server-only) / LangChain adapters
on: first-class `readResource`/`callTool`, stdio **and** Streamable HTTP, custom
`capabilities` in `initialize` (to advertise `extensions.io.modelcontextprotocol/ui`),
and a lean footprint (`zod` + `eventsource-parser`; `zod` already used). Added to
`apps/ui-web`.

**Built + proven (relay core):**
- `apps/ui-web/scripts/example-mcp-ui-server.ts` — a REAL in-repo external MCP
  server (runs over stdio, or links in-memory for tests) serving
  `ui://example/dashboard` (a zero-theme-code app) + an `example-stats` tool.
- `apps/ui-web/scripts/external-mcp-app-registry.ts` — `createExternalMcpAppRegistry`
  (an `McpAppHostDeps` provider: routes `ui://`→owning server, enforces the
  **same-server rule** via each server's tool allowlist, unknown→`ok:false` so it
  composes cleanly) + `connectExternalStdioServer` (SDK `Client` over stdio;
  advertises the UI render capability; snapshots resources+tools). The provider is
  decoupled from the SDK via a structural `ExternalMcpClient` interface.
- Integration test (5 cases): real SDK `Client` ↔ the example server over BOTH
  `InMemoryTransport` AND **real stdio** (spawns `bun run` as a separate process)
  — `readResource` serves the app, `callTool` relays, same-server rejection, clean
  fall-through. **0 tsc errors.** Screenshot-verified: the external app renders +
  auto-themes (G1.5) + populates via the relayed `tools/call`, dark + light.

**Remaining (deliberate, deferred to a focused step):** wire
`createExternalMcpAppRegistry(...)` into `composeAppRegistries` at
`chat-server.ts:2897`, sourcing servers from config (env-gated, **default NONE** →
the provider is inert → production behavior unchanged), with async connect at boot
+ `close()` on shutdown woven into the Effect server lifecycle (the chat-server's
memory-leak history makes the subprocess lifecycle a care-point). Separately, the
SEP's **double-iframe sandbox-proxy** is required on the *web* client before
rendering UNTRUSTED remote servers (Moon/Tauri is exempt; trusted/in-repo servers
are fine on today's single cage).
