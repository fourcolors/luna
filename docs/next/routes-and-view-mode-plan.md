# Separating "which server" from "how much I see"

Status: plan, revision 4. Not yet implemented.
Revision 1 was reviewed adversarially by codex and sent back; its central claim was wrong.
Revision 2 fixed the claim but kept the structure that produced it: steps opened with assertions about the world instead of commands that re-derive it.
Revision 3 rebuilt the plan from a verification pass (five code readers, three critics, adversarial verification of every proposal) and pre-ran its own Gate 0.2, which came back HOT (issue #528).
Revision 4 folds the second codex review, which sent revision 3 back for rework on twelve defects; the load-bearing ones were independently re-verified before folding.
What changed and why is recorded at the bottom.

## The problem, stated precisely

The word `dev` carries two meanings that have nothing to do with each other.

It names a **deployment channel**: a server instance that takes new code first.
It also implies a **mode**: verbose output, internals visible, "for developers".

Only the first is real in the code.
The second is folklore: `grep -rln "debugMode|verbose|devMode|showRaw" apps/ui-moon-tauri/frontend-react/src` returns nothing.

Conflating them costs the most valuable combination.
The place you most want internals visible is PRODUCTION, because that is where the confusing failures happen.
While "dev" names a server, "dev mode on stable" sounds self-contradictory, so the vocabulary discourages exactly what an operator reaches for during an incident.

## Ground truth, corrected again

Revision 2 said route switching is "split between two stores".
That is true but understated.
The verified behavior is sharper and worse.

**For a migrated user, the Settings channel switch is inert on the connect path, and the UI actively lies about it.**
`set_active_profile` writes only `moon-connection.json`'s `activeProfile` and never touches `client.toml` (`connection.rs:386-400`).
The reconnect that follows re-enters `load_connection`, whose `client.toml` branch keys BOTH the URL and the token off `cfg.default` (`connection.rs:296-317`), which the switch did not change.
Note carefully for later: the `"legacy"` sentinel resolves against the profile NAMED BY `cfg.default` (`connection.rs:304`), not against `activeProfile`; `activeProfile` plays no part in migrated-path resolution.
Meanwhile Settings repaints with the newly selected channel's creds on `profile-switch-succeeded` (`SettingsConnectionPanel.tsx:136-143`).
A control that repaints to show a server it did not connect you to is the 2026-08-11 failure, one layer earlier.
Corollary: the switch also evaporates on restart, since the next boot reads `cfg.default`.

**There are three parallel connect paths, not one.**
The main chat window: `wire.ts:1271-1297`, one `load_connection` call yielding both URL and token.
Panel windows: `frontend-react/panel.html:207-230`, URL from `resolveBootRoute(panelId)` but token from a panel-id-blind `load_connection` that always keys off `cfg.default`.
The hub: `hubEngines.ts:425-462`, a third implementation of the same waterfall.
The panel path is a live defect: a panel bound to a non-default route sends that route's URL with another route's token, no error raised, and `panel-route-binding.test.ts:198` currently PINS that split as expected behavior.

**The pooled engine is the default engine in this tree, and it never resolves the token sentinel.**
`USE_POOL_ENGINE` is on unless explicitly forced off with `luna_pool_engine = '0'` (`wire.ts:1195-1203`; the `pool-engine-contract.test.ts` docblock confirms S18b promoted it from dark to default).
`PoolEngine.connect()` takes `bootRoute.token_ref` verbatim (`wire.ts:696-712`), no TokenResolver is injected (the comment at `wire.ts:748-760` admits it and now carries `TODO(#528)`), and the adapter uses the literal ref as the bearer and dials `?token=<ref>` (`luna-ws.ts:188-193, 258`).
Migration writes `tokenRef = "legacy"` for every migrated route (`client_config.rs:599`, pinned by the Rust test at `connection.rs:597-603`).
Statically the chain is complete, and Gate 0.2 (pre-run, see below) confirmed it dynamically: a migrated boot on this tree dials `?token=legacy`.
That is a ship blocker for this tree independent of this plan, tracked as issue #528.

**A dangling default silently connects to the legacy server.**
`cfg.route.get(&cfg.default)` has no else branch (`connection.rs:296`); a `default` naming a missing route falls through to the legacy `moon-connection.json` path (`connection.rs:327-337`), directly contradicting the stated intent at `connection.rs:283-284` of never silently falling back.
The frontend compounds it: `resolveBootRoute` swallows the hard error from `load_route` into `null` (`moon-session.js:62-69`), and `wire.ts:702-704` then fabricates `routeKey = 'legacy'`.
Contrast the legacy store, where the same invariant IS guarded: a dangling `activeProfile` yields no creds rather than a fallback (`connection.rs:454-471`).

**The credential-bearing URL has four producers, and the inventory must distinguish shipped from legacy code.**
Shipped (the Tauri build uses `frontend-react/dist`): `buildWsUrl` (`moon-protocol.js:59-63`) called from `wire.ts:102`, `hubEngines.ts:194`, and `moon-ws.js:70-73`; the manual probe construction at `hubEngines.ts:739`; and the adapter's own `tokenizedUrl` (`luna-ws.ts:258`).
Legacy tree, superseded but still in-repo: `index.html:2403`.
Any invariant scoped to one producer misses the others.

**Credential sinks are live today, in shipped code.**
`new WebSocket(fullUrl)` throws with the URL embedded in the exception text; this was executed, not inferred (a jsdom probe confirmed the token appears verbatim in the thrown message).
Four panel sinks render `e.message` into the DOM via `showNotice` (`panel.html:225, 229, 240, 285`), and the first three sit in the connect waterfall where `fullUrl` is in scope.
Both shipped engines log the raw exception object on construction failure: `Logger.error("WebSocket creation error:", e)` at `wire.ts:107` and `hubEngines.ts:200`.
Separately, `main.rs:420-429` emits a `luna-config` event whose payload carries `wsToken` as its own JSON field; no URL redactor can touch a sibling field.

**The Settings selector prefers the stale store in both arrival orders.**
`profile-loaded` sets the displayed channel unconditionally, and `routes-loaded` prefers `pendingActiveProfile` over `client.toml`'s `defaultKey` (`connectionReducer.ts:171-195`).
`load_profiles` never returns empty: with no file at all it invents `activeProfile = "stable"` (`connection.rs:55, 369-378`), so `defaultKey` is effectively dead code in production today.
`settings-connection-panel.test.tsx:528-553` pins this preference as intended, and has a twin against the vanilla panel (`panel-connection.test.ts:528-551`).

**Good news, verified rather than assumed.**
Two windows cannot interleave writes to `moon-session.json`: the session commands are sync Tauri commands serialized on the event loop, so the read-modify-write pattern is safe from races in-process.
The remaining gap there is coverage, not concurrency: `set_panel_route` has no tempdir-injectable variant and zero Rust tests, unlike its `last_thread` sibling.

## What is missing, in dependency order

0. **Issue #528 is a release blocker that precedes this plan.** The sentinel-as-bearer fix is extractable and must land (or be landed by Step 1b as its first commit) before anything else here ships.
1. **Route switching does not live in the route model, and the credential does not follow the route.** Everything else builds on this.
2. **A switch does not reach most windows.** `hub_event` fans out to a hardcoded allowlist: `main`, plus the literal label `panel-chat` (`windows.rs:313-336`). Parallel chat panels are `panel-chat-<hash>` (`windows.rs:106-116`) and never hear it, nor do the twelve panel kinds that each own a socket.
3. **Nothing displays which route a window is connected to.** The `connection-changed` payload is `{"for": target, "name": name}` (`windows.rs:331`) and carries no route data.
4. **No view-mode concept exists at all.**

## Scope

IN: make route switching own the socket AND the credential; widen the switch fan-out; a persistent per-window route indicator; a view-mode seam with a redaction contract; fixing the live credential sinks.

IN, forced by the above: removing `load_profiles().activeProfile`'s authority over the Settings display when `client.toml` is present, and inverting the two tests that pin the stale preference.

IN, new API surface, named as such: a route-keyed token-resolution command that returns a Result (refusal needs an error, and `load_connection_in` returns a sentinel string, never an error).

OUT: renaming the `dev` deployment channel in `/etc/luna/servers.toml`, systemd units, or the deploy CLI's `--profile` flag.
That is a real migration with outage risk and buys nothing the client-side change does not.

OUT: designing what verbose SHOWS.
See "Deliberately deferred", which carries a hard constraint rather than a shrug.

## Step 0: observe gates that decide which world this is

Revision 1 died of a plan-time claim nobody re-checked.
These gates run BEFORE any test is written; each names its commands and how to read every outcome.

**Gate 0.1, which world.**
Two commands, run both:
`ls -la ~/.luna/client.toml ~/.luna/moon-connection.json ~/.luna/moon-session.json`
`grep -E '^default|^\[route\.|tokenRef' ~/.luna/client.toml 2>/dev/null || echo NO-CLIENT-TOML`
World (a), `client.toml` present with `tokenRef = "legacy"`: the migrated world, the one Step 1 is scoped to.
World (b), `NO-CLIENT-TOML`: migration is not running as assumed; STOP and return to the migration question before any re-keying work.
World (c), `default` names a route absent from the `[route.*]` tables: the dangling-default fallthrough is a prerequisite bug; fix it before Step 1a, because Step 1a adds a second writer of `default` and a typo would silently repoint every window at legacy creds.

**Gate 0.2, the pool-engine wire probe.**
Boot the chat harness against a migrated fixture (`client.toml` with `tokenRef = "legacy"`, `moon-connection.json` with a real profile token) and inspect the URL the stubbed `WebSocket` captured.
The harness must be EXTENDED, not copied: `pool-engine-contract.test.ts`'s `__TAURI__` stub carries only `window` and `event` keys, and `moon-session.js`'s `_invoke()` returns `null` without `__TAURI__.core`, which routes `resolveBootRoute` into the no-Tauri fallback.
The probe adds `core: { invoke }` stubbing `load_connection`, `list_routes`, and `load_route` with migrated shapes, leaves `luna_pool_engine` unset so the true default engine runs, and reads `FakeWebSocket.instances[].url`.

**Gate 0.2 was pre-run on 2026-08-12, with exactly that extension, and it is HOT.**
Observed: engine `pool`, invoke sequence `migrate_legacy_connection, load_connection, list_routes, load_route`, dialed URL `ws://migrated.host:4753/ui?token=legacy`.
The engine had the real token in hand (the `load_connection` response) and dialed the sentinel anyway.
Filed as issue #528 with the probe recipe to recreate as Step 1b's regression fence; the false comment at `wire.ts:748-760` now carries a `TODO(#528)` marker.
The loop-back fires: the sentinel fix leads the plan rather than following it.

**Gate 0.3, the fan-out probe.**
Open two chat windows plus Settings, switch channel, record which windows receive `hub-event`.
Expected: only `main` and `panel-chat` react (`windows.rs:313-336`); any other window keeps its socket and shows nothing.
If the fan-out unexpectedly reaches every window, Step 2's update transport flips to the cheaper payload extension; the indicator's source of truth does not change either way (see Step 2's DECIDE).

**Gate 0.4, the credential-surface audit.**
Two greps, because `buildWsUrl` is not the only producer:
`grep -rn 'buildWsUrl' apps/ui-moon-tauri/frontend-react/src apps/ui-moon-tauri/frontend/vendor`
`grep -rn "token=" apps/ui-moon-tauri/frontend-react/src packages/ui-transport/src | grep -v test`
Known today: both engines log the token-FREE URL before tokenizing (`wire.ts:98`, `hubEngines.ts:189`) but log the raw EXCEPTION on construction failure (`wire.ts:107`, `hubEngines.ts:200`); four panel notices render `e.message` (`panel.html:225, 229, 240, 285`); `main.rs:420-429` emits `wsToken` as an event-payload field.
Any newly found sink joins the Step 1c fix list.

## The security invariant, which is not deferrable

`moon-protocol.js:62` builds the socket URL as `wsUrl + sep + 'token=' + encodeURIComponent(wsToken)`.
**The credential is in the URL**, and sinks for it are already live (the panel notices and both engines' construction-error logs).

INVARIANT, deny-by-default and independent of producer: a token-bearing URL is passed to the `WebSocket` constructor and nowhere else.
`LunaProtocol` gains a companion `describeWsUrl(wsUrl)` that returns a display string rebuilt by parsing: scheme, host, port and path ONLY, discarding the query string, fragment, and any userinfo wholesale.
If parsing fails, it returns a fixed placeholder, never the input.
Any surface that wants to show a URL calls `describeWsUrl`; no catch downstream of socket construction may render or log `e.message` or the exception object raw.

A token-parameter strip is the wrong shape: it is a denylist, wrong by default for the next credential-bearing parameter, and blind to `wss://user:pass@host`.
Rebuilding from parsed components is right by default and cheaper to test: one assertion that the output contains no `?`.

The invariant names its sinks, with their fixes and owners, because none of them are view-mode surfaces:
the four panel notices rendering `e.message` (`panel.html:225, 229, 240, 285`), fixed in Step 1c by rendering a fixed reason plus `describeWsUrl(endpoint)`;
both engines' `Logger.error("WebSocket creation error:", e)` (`wire.ts:107`, `hubEngines.ts:200`), fixed in Step 1c by logging the error NAME and `describeWsUrl` only;
and the `luna-config` payload carrying `wsToken` as its own field (`main.rs:420-429`), which no URL redactor can reach, handled in Step 1c by its own DECIDE below.
The house rule already exists on both ends of the wire: the server logs failed auth as IP only (`server.ts:1007`), and the adapter promises the resolved token is "never logged" (`luna-ws.ts:186`).

Redaction is enforced at the SEAM, not at each consumer: the view-mode seam of Step 3 hands consumers pre-redacted strings, and raw credential-bearing values never cross it.
A consumer therefore cannot bypass redaction by forgetting to call the redactor, because it never holds the raw value.

## The per-window decision, refined

DECISION: view mode is **per-window and unpersisted**, and it **rides the thread-migration payloads in BOTH directions**.

Reasons, unchanged from revision 2: route is already persisted per panel, a global flag toggled during an incident would silently change windows on other routes, and persistence invites drift back into a per-route setting.
A view is not a preference.

Two facts complicate the boundary, and the decision is only honest once it names them.
First, a window is not the unit an investigation lives in: `redock_thread` emits the thread id and draft to the owner window and then CLOSES the source window (`windows.rs:528-539`), so an operator who enabled verbose on a floater and redocks it would silently lose the view mid-investigation.
Detach has the same hole outbound: `openInNewWindow` sends only `{thread, redockTo}` (`threadDrawer.ts:757-760`, fenced by `chat-window.test.ts:5137-5163`).
So the view rides both payloads: redock carries `viewMode` alongside `threadId` and `draft`, and detach carries it in the `open_widget` params.
Both directions are scenario-fenced below; a wrong implementation that covers redock and forgets detach fails the detach scenario.
The cost is accepted and named: redocking a verbose floater makes the OWNER window verbose, including its other threads, because per-window state has no finer grain.
If that proves wrong in use, the alternative is per-thread scope, and it is decided here rather than discovered in Step 3.

Second, blast radius: destroying `main` destroys every other window (`main.rs:55-68`), so quitting the hub clears every view at once, while a collapse only hides windows (`lifecycle.rs:23-39`) and state survives.
That asymmetry is acceptable for an ephemeral view and is stated so nobody files it as a bug.

The storage hazard is localStorage, not the config files.
Every Moon window shares one `tauri://` origin, and this codebase habitually puts per-pick flags there (`luna_model` and `luna_effort` at `wire.ts:349, 381, 386, 1157, 1160`); a one-line `localStorage.setItem` implementation would be global AND persistent while passing any scenario that names only JSON files.
The scenarios below fence it from both directions: behaviorally, and by naming all three storage locations.

## BDD scenarios

### Feature: the selected route owns the socket and the credential

```gherkin
Scenario: a route switch survives an app restart
  Given a migrated user whose client.toml default is "stable"
  And "canary" resolves to endpoint "ws://canary.host:4753/ui" with token "TOK-CANARY"
  When the user selects the route "canary" in Settings
  And the app is relaunched
  Then client.toml's default key is "canary"
  And the boot connection dials "ws://canary.host:4753/ui" with token query parameter exactly "TOK-CANARY"
```

This is the headline: today the switch writes a key the boot path never reads, so it silently reverts.
The Then names the store (client.toml) and the credential, so neither an in-memory nor a wrong-token implementation passes.

```gherkin
Scenario: the route key and the displayed label do not diverge
  Given routes exist with keys "stable" and "canary"
  When the user selects "canary"
  Then the persisted route key is "canary"
  And no separate profile name is written that disagrees with it
```

```gherkin
Scenario: switching route moves the credential, not just the endpoint
  Given "stable" resolves to endpoint "ws://stable.host:4753/ui" with token "TOK-STABLE"
  And "canary" resolves to endpoint "ws://canary.host:4753/ui" with token "TOK-CANARY"
  And a window connected to "stable"
  When the user selects the route labelled "canary" in Settings
  Then the socket connected to "ws://stable.host:4753/ui" is closed
  And exactly one new WebSocket is constructed
  And its URL begins with "ws://canary.host:4753/ui"
  And its "token" query parameter is exactly "TOK-CANARY"
```

The exact-token and old-socket-closed clauses are load-bearing: without them, an implementation that opens a second socket and keeps the old one, or swaps the URL and keeps the old token, still passes.

```gherkin
Scenario: a panel bound to a non-default route gets that route's credential
  Given client.toml default is "stable" whose token resolves to "TOK-STABLE"
  And a panel is bound to route "canary" whose token resolves to "TOK-CANARY"
  When the panel boots and connects
  Then the constructed URL begins with the "canary" endpoint
  And its "token" query parameter is exactly "TOK-CANARY"
```

Literal tokens on purpose: "the token resolved for canary" as prose would let a third, wrong token pass.
This inverts `panel-route-binding.test.ts:198`, which currently pins the URL/token split as expected; that inversion is deliberate and must not be mistaken for a regression.

```gherkin
Scenario: switching to a profile name that is not a route key is refused visibly
  Given client.toml has routes "prod" and "local" with default "prod"
  And moon-connection.json has activeProfile "my-custom"
  And the Settings selector renders "my-custom" as a selectable option
  When the user selects "my-custom"
  Then the switch does not report success
  And Settings displays an error whose text contains "my-custom"
  And no hub_event is emitted
  And client.toml's default key is still "prod"
  And moon-connection.json is unchanged
```

Trap, named so the implementation cannot fall into it: `MoonSession.setDefaultRoute` swallows the Rust error into `console.warn` and resolves `false`, it never rejects (`moon-session.js:177-187`), so the existing `.catch` in the panel becomes dead code the moment the switch is retargeted.
The implementation must check the boolean return or invoke `set_default_route` directly.

```gherkin
Scenario: switching to a route whose token cannot be resolved is refused, not half-applied
  Given client.toml route "canary" has tokenRef "legacy"
  And moon-connection.json has no profile named "canary"
  When the user attempts to SWITCH to "canary"
  Then the switch is refused with a visible error naming the unpaired route
  And client.toml's default key is unchanged
  And the window stays connected to its previous route
```

```gherkin
Scenario: an unpaired route can still be selected for pairing
  Given client.toml route "canary" has tokenRef "legacy"
  And moon-connection.json has no profile named "canary"
  When the user selects "canary" in Settings WITHOUT confirming a switch
  And pastes a token and saves
  Then the token is stored under the profile keyed "canary"
  And a subsequent switch to "canary" succeeds
```

The pair above resolves the refusal/pairing contradiction explicitly: SELECTION for editing is a view state and always allowed; the SWITCH (writing `default` and reconnecting) is what the resolvability guard protects.
Refusing selection outright would make a new route impossible to pair.
This needs new API surface, named in Step 1b: a route-keyed resolution command returning a Result, because `load_connection_in` returns the literal sentinel today and never an error.

```gherkin
Scenario: saving a token writes it under the selected route's key, durably
  Given the user has selected the route labelled "canary" in Settings
  When the user saves an auth token
  Then re-reading moon-connection.json from disk shows the token under the profile keyed "canary"
  And the token stored under any other profile is unchanged
```

`save_connection` targets `activeProfile` when no explicit profile is passed (`connection.rs:246-249`) and Settings passes none (`SettingsConnectionPanel.tsx:176`); once the switch stops moving that pointer, it freezes, and a token pasted while viewing canary would land in `profiles["stable"]`.
"Re-reading from disk" is the durability clause: an in-memory store passes without it.

```gherkin
Scenario: every connected window follows a route switch
  Given a chat window, a parallel chat panel, and a vault panel, all connected to "stable" with token "TOK-STABLE"
  When the user selects the route labelled "canary" in Settings
  Then each window's socket to the "stable" endpoint is closed
  And each window is connected to the "canary" endpoint with token query parameter exactly "TOK-CANARY"
```

The vault panel is in the Given deliberately: the fan-out gap is about NON-chat windows, so a two-chat-window scenario would under-test it.

```gherkin
Scenario: the selector shows the route the socket is on, not the stale profile name
  Given client.toml has routes "canary" and "prod" with default "canary"
  And moon-connection.json's activeProfile is the stale value "stable"
  When the Settings connection panel finishes loading
  Then the selected channel is "canary"
  And the channel options are exactly "canary" and "prod"
```

"Exactly" on the options set is the sourcing assertion: an implementation that merely deletes the stale option while sourcing the selection from the wrong store cannot pass it.

```gherkin
Scenario: client.toml default names a route that no longer exists
  Given moon-connection.json has activeProfile "stable" with url "ws://stable.host:4753/ui"
  And client.toml has default = "canary" and no [route.canary] table
  When the window boots and resolves its connection
  Then no WebSocket is constructed at all
  And the window reports disconnected
```

```gherkin
Scenario: a route edited under a live window does not silently retarget it
  Given a window whose socket is connected to "ws://canary.host:4753/ui" for route key "canary"
  When the route source begins reporting "ws://other.host:4753/ui" for "canary"
  And no reconnect is triggered
  Then the live socket is still connected to "ws://canary.host:4753/ui"
  And the route indicator still reads the label for "canary"
```

The When is stub-level on purpose, and an implementation that never re-reads route state passes BY DESIGN: this fence pins that not-re-reading is the correct behavior for a live socket.
Nothing re-reads `client.toml` after boot and no fs watcher exists, so a file-edit step would pass vacuously; when re-reading MUST happen is pinned by the switch scenarios, not this one.

```gherkin
Scenario: a panel route write preserves the rest of the session
  Given moon-session.json has panel "panel-chat" with route "stable" and lastThread "t-1"
  When set_panel_route("panel-chat", "canary") is called
  Then panel "panel-chat" has route "canary" and lastThread "t-1"
  And every other panel's entry is unchanged
```

This replaces a proposed concurrency scenario that verification killed: the commands are serialized on the event loop, so there is no race, but `set_panel_route` has zero Rust tests and Step 1 promotes it into the write path.

### Feature: the connected route is always visible

```gherkin
Scenario: the window names the route its socket is on
  Given a window connected to the route labelled "stable"
  Then the window displays a route indicator whose text is exactly "stable"
  And the live socket's URL begins with the endpoint configured for "stable"

Scenario: the indicator follows a route switch
  Given a window displaying route indicator "stable"
  When the user switches to route "canary"
  Then the window displays a route indicator whose text is exactly "canary"
  And the live socket's URL begins with the endpoint configured for "canary"

Scenario: a disconnected window still names its route
  Given a window connected to route "canary"
  When the connection drops
  Then the route indicator is still present
  And it reads "canary"
  And it is marked disconnected
```

The socket-URL clauses tie the indicator to the connection it describes; a static label satisfies the text assertion alone.
An indicator that VANISHES on disconnect is worse than none: absence reads as fine.

```gherkin
Scenario: a window outside the hub-event fan-out still names its own route
  Given a second chat window open alongside the hub and panel-chat
  And that window is connected to the route labelled "canary"
  When the user switches the default route to "stable" in Settings
  Then the second window's indicator still reads exactly "canary"
  And it does not read "stable"
```

This fences the fan-out gap directly: an indicator driven by broadcast would either not update (right, by accident) or update to a route this window never connected to (wrong, and dangerous).

```gherkin
Scenario: switching to a route whose endpoint never accepts a connection
  Given a window connected to the route labelled "stable"
  And route "canary" points at an endpoint that never accepts a connection
  When the user switches to "canary"
  Then the route indicator reads exactly "canary" before any connection has succeeded
  And the indicator is marked disconnected
```

The load-bearing clause is "before any connection has succeeded": an indicator derived from the hello frame or from connected state passes the other scenarios and fails this one.

Constraint carried from ground truth: the indicator must never render a raw `routeKey`, because the fallback path fabricates `routeKey = 'legacy'` (`wire.ts:702-704`); it renders the route LABEL from the window's own resolved route, or a disconnected state, never a synthesized key.

### Feature: view mode is orthogonal to route, and never leaks the credential

```gherkin
Scenario: verbose view on the production route
  Given a window connected to the route labelled "stable"
  When the user enables the verbose view in that window
  Then the view mode for that window is verbose
  And the window's route is still "stable"
  And no reconnection occurs
```

```gherkin
Scenario: verbose is per window
  Given two open windows, A on route "stable" and B on route "canary"
  When the user enables the verbose view in window A
  Then window A is verbose
  And window B is NOT verbose
```

```gherkin
Scenario: enabling verbose in one window leaves a window opened afterwards unaffected
  Given window A has the verbose view enabled
  When a new window B is opened
  Then window B is not verbose
```

The pair above is falsifiable from both directions: the first catches a storage-event implementation, the second catches a plain read-at-boot localStorage implementation the first cannot see.

```gherkin
Scenario: view mode does not survive a window reopen
  Given the verbose view is enabled in a window
  When that window is closed and reopened
  Then the view mode is off
  And no view-mode key exists in client.toml, moon-session.json, or localStorage
```

Test-hygiene constraint, stated because it decides whether this fence is real: the reopen test must NOT clear storage between the two boots; neighbouring suites clear per-test, and a mid-test clear would let a localStorage implementation pass.

```gherkin
Scenario: the view follows a redocked thread
  Given a floating chat panel with the verbose view enabled
  When the user redocks that thread into the owner window
  Then the owner window becomes verbose
  And the source window is closed

Scenario: the view follows a detached thread
  Given a docked window with the verbose view enabled
  When the user drags a thread out into a new floating window
  Then the open_widget params for the new window carry the verbose view
  And the new window boots verbose
```

Written honestly per-window: the owner window as a whole becomes verbose, which can override a deliberately quiet owner; that trade is accepted in "The per-window decision, refined".
The detach scenario exists because the decision requires BOTH directions and a redock-only test would pass an implementation that drops the view on the way out.

```gherkin
Scenario: the display form of a socket URL keeps nothing but scheme, host, port and path
  Given the URL "wss://user:pass@host:4753/ui?token=TOK-SECRET&x=1#frag"
  When that URL is passed to describeWsUrl
  Then the result contains "host:4753/ui"
  And the result contains no "?" character
  And the result contains no "#" character
  And the result contains no occurrence of "user", "pass", or "TOK-SECRET"

Scenario: an unparseable URL redacts to a placeholder
  Given a string that does not parse as a URL and contains "token=TOK-SECRET"
  When it is passed to describeWsUrl
  Then the result is a fixed placeholder containing no occurrence of "TOK-SECRET"
```

```gherkin
Scenario: a failed socket construction never surfaces the credential, on any surface
  Given a route whose endpoint is the malformed URL "ws://:::/ui"
  And the resolved token is "TOK-SECRET"
  When a panel, the chat engine, and the hub engine each attempt to connect and the constructor throws
  Then no notice rendered into any window contains "TOK-SECRET"
  And window.__PanelInternals.lastNotice contains no occurrence of "TOK-SECRET"
  And no Logger or console call made during any attempt contains "TOK-SECRET"
```

This scenario fails TODAY on three shipped surfaces (`panel.html:225-240`, `wire.ts:107`, `hubEngines.ts:200`); it is the live-sink fix, not a future-proofing exercise.

```gherkin
Scenario: the luna-config event payload carries no token
  Given the main window is emitted a luna-config event
  Then the payload contains a wsUrl field and no wsToken field
  And the hub resolves its credential through load_connection instead
```

## TDD order

Each step opens with an observe gate, names its decision and the evidence that would reverse it, and its smallest test-first slice.
The Step 0 gates run once before any of this.

**Step 1b0, extracted: fix issue #528 first.**
The sentinel-as-bearer fix is a release blocker independent of this plan and lands as its own commit, either before this plan starts or as Step 1b's opening move.
Its regression fence is the Gate 0.2 probe recipe (issue #528): no `FakeWebSocket.instances[].url` may contain `token=legacy`.
Everything after this line assumes the default engine dials real tokens.
STATUS: SHIPPED in PR #530 (fence: `pool-engine-token-resolution.test.ts`, 4 tests including refusal-while-connected); the transient-vs-unpaired refusal split is #529 and folds into Step 1b.

**Step 1a. The switch writes the route key, guarded.**
OBSERVE: re-run Gate 0.1; confirm `handleChannelChange` still calls only `set_active_profile` (`SettingsConnectionPanel.tsx:134-148`).
ACT, test first: the restart-survival, key-vs-label, both refusal, pairing, and save-target scenarios, in `settings-connection-panel.test.tsx` (seams: `makeCtx` invoke stub, `channelError()`, a `MoonSession` stub whose `setDefaultRoute` resolves `false`).
Implementation: the switch validates the target is a route key and its token resolves (via the Step 1b command), then writes through `set_default_route`, checking the boolean return; `save_connection` gains the explicit `profile:` argument (it already exists in Rust).
DECIDE, corrected from revision 3: the migrated resolver keys the sentinel by `cfg.default` (`connection.rs:304`), NOT by `activeProfile`, so the dual write buys nothing for token resolution; `activeProfile` is still written alongside ONLY so the un-migrated world (b) and any not-yet-quarantined reader stay coherent.
Reversing evidence: when the world (b) path and the display path are both retired, the `set_active_profile` call goes with them.
ORIENT on ordering: one click writes two files through two unlocked commands and cannot be atomic across files; write `client.toml`'s `default` LAST, because both the URL and the token key off `cfg.default` (`connection.rs:296-317`), so the file written last is the one that decides, and a failure between the writes leaves the connect path fully on the old route.
The display path is quarantined in the same step: when `client.toml` is present the selector's value is `list_routes().default` and nothing else, which means severing BOTH reducer paths (`profile-loaded` and `routes-loaded`, `connectionReducer.ts:171-195`) and INVERTING the two fence tests that pin the stale preference (`settings-connection-panel.test.tsx:528-553` and its vanilla twin `panel-connection.test.ts:528-551`), not adding alongside them.
The vanilla settings panel must move in the same commit or be retired; a third writer is how this bug was born.
LOOP-BACK: if key and profile name cannot move together without changing `set_active_profile`'s return shape, stop and re-scope THIS step (the reducer and API question), because Settings' displayed state depends on that shape (`SettingsConnectionPanel.tsx:136-143`).

**Step 1b. Token resolution is keyed by the route being connected.**
OBSERVE: `grep -n 'tokenRef' ~/.luna/client.toml`; re-read `wire.ts:748-760` against `client_config.rs:599`; confirm #528's fence is green.
NEW API SURFACE, named as such: a command shaped like `resolve_route_token(route_key) -> Result<token, reason>` (or a route-keyed `load_connection` variant that returns an error instead of a sentinel), because refusal needs an error and `load_connection_in` returns the literal sentinel today (`connection.rs:298-313`).
ACT, test first: the unresolvable-route refusal at the Rust seam (`with_tmp_luna_dir` + fixtures at `connection.rs:561-706`), the pairing scenario, and the #528 fence.
Implementation: all three connect paths resolve through the same route-keyed resolution; the false comment at `wire.ts:748-760` is corrected in the same change.
Reversing evidence: none expected; Gate 0.2 already proved the sentinel reaches the wire.
LOOP-BACK: if the resolver's signature change alters what `load_connection` returns to the main path, RETURN TO Step 1a and re-run its assertions.

**Step 1c. The panel path, the fan-out, and the live sinks.**
OBSERVE: confirm the three connect paths still read as described (`wire.ts:1271-1297`, `panel.html:207-230`, `hubEngines.ts:425-462`); re-run Gate 0.3 and Gate 0.4.
ACT, test first: the panel-credential scenario (inverting `panel-route-binding.test.ts:198`, seam: `bootPanel` harness plus `vi.stubGlobal('WebSocket', ...)` as `chat-window.test.ts:160` does), the every-window-follows scenario, the three-surface sink scenario, the luna-config payload scenario, and the `set_panel_route` round-trip (new `set_panel_route_in` mirroring the `last_thread` pair).
Implementation, fan-out mechanism named: `hub_event` stops using an allowlist and enumerates `app.webview_windows()`, emitting to every open label with the same `for` discipline; no socket-ownership registry is needed because the per-window listener already ignores events not addressed to it (`wiring.ts:846-868` guards on `p['for'] !== winLabel`), and non-chat panels gain that listener.
Rust seam: extract a pure `hub_event_targets(name, open_labels)` and unit-test it beside `windows.rs`'s existing tests; JS seam: drive `windowEventHandlers['hub-event']` with a `panel-chat-<hash>` label as `chat-window.test.ts:3796-3817` does.
Implementation, sinks: `describeWsUrl` lands in `LunaProtocol` (seam: `moon-vendor.test.ts`); the four panel notices render a fixed reason plus `describeWsUrl(endpoint)`; both engines' construction-error logs log the error name and `describeWsUrl` only.
DECIDE, luna-config: the payload drops `wsToken` and its consumers resolve creds through `load_connection` like every other path; reversing evidence is a consumer that structurally cannot invoke, and the loop-back is to carry the field but rename it so Gate 0.4's grep keeps finding it, never to leave it silently.
DECIDE, hub duplication: `hubEngines.ts` must converge on the SAME route-keyed resolution as the other two paths in Step 1b (token divergence is already real, per Gate 0.2); what may remain duplicated is waterfall plumbing, never resolution semantics; reversing evidence for keeping the duplicate plumbing is any observed divergence in URL OR token.

**Step 2. The route indicator.**
OBSERVE: re-run Gate 0.3 post-1c; confirm where each window's resolved route is captured (`panel.html:220`, `wire.ts:723`).
DECIDE: the indicator's SOURCE OF TRUTH is the window's own connection state, captured at connect time, in every design; this is not conditional, because only local state can represent disconnected and reconnecting truthfully.
What Gate 0.3 decides is only the update TRANSPORT: if the widened fan-out reliably reaches every window, route changes propagate by event; if not, the payload extension at `windows.rs:331` is moot and each window re-resolves on its own reconnect.
ACT, test first: the five indicator scenarios; drive the drop through the pooled-connection seam, and do NOT extend `live-reconnect.test.ts`, which is opt-in behind `LUNA_LIVE_WS` and needs a human.
LOOP-BACK: if the route a window displays can disagree with the route its socket is on, RETURN TO Step 1c; the indicator is not allowed to be the thing that papers over a substrate disagreement.

**Step 3. The view-mode seam plus its redaction boundary.**
OBSERVE: re-run Gate 0.4; every credential string a surface could render is either produced by `describeWsUrl` or listed as a named sink with a fix.
ACT, test first: every scenario in the view-mode feature block (a count is deliberately not written here, because revision 3's count rotted within one edit), including both redactor scenarios and the reopen/afterwards pair, before any consumer exists.
Implementation: per-window ephemeral state riding the redock and detach payloads; the seam exposes only pre-redacted strings, so raw credential-bearing values never cross it and no consumer can bypass redaction by omission.
LOOP-BACK: if the seam cannot be shaped so that raw values stay behind it, stop and re-choose the boundary before writing any consumer.

**Step 4. One named consumer.**
The route indicator gains a verbose form showing the seam's redacted endpoint string and connection state.
Chosen because it needs no new data, exercises the redaction boundary on a real credential-bearing URL, and is useful on production, which is the whole argument.
Its test asserts the rendered string equals `describeWsUrl(endpoint)` for a credential-bearing fixture, which proves the consumer sits behind the seam rather than beside it.
LOOP-BACK: if this consumer needs any data the indicator does not already have, RETURN TO Step 2; a consumer that needs new plumbing is not the cheap first consumer this step was chosen for.

## Loop-back triggers, collected

A step that hits its trigger stops and returns; it does not carry the surprise forward.

- Gate 0.1 world (b): STOP, the migration question precedes everything.
- Gate 0.1 world (c): the dangling-default fallthrough is fixed before Step 1a.
- Gate 0.2 hot (CONFIRMED): #528 is extracted as Step 1b0 and leads the plan.
- Step 1a: if key and profile name cannot move together without changing `set_active_profile`'s return shape, stop and re-scope Step 1a itself.
- Step 1b: if sentinel resolution changes any connect path's inputs, RETURN TO Step 1a.
- Step 1c: if the three paths cannot agree without a shared resolver, RETURN TO Step 1b; that is a token-resolution change wearing a connect-path costume.
- Step 2: display/socket disagreement RETURNS TO Step 1c.
- Step 3: a seam that cannot keep raw values behind it stops the step.
- Step 4: any new-plumbing need RETURNS TO Step 2.

## Deliberately deferred, with a constraint

WHAT ELSE verbose shows stays unspecified; that list should come from incidents rather than planning.
The constraint that is NOT deferred: every future surface receives only pre-redacted data from the Step 3 seam, so the deferred decision cannot reintroduce a credential leak.

## What changed from revision 3, and why it is worth recording

The second codex review sent revision 3 back on twelve defects; the load-bearing ones were re-verified independently before folding, and one was found to be worse than codex stated.

The deepest cut: revision 3's Step 1a justified keeping the dual write because "the legacy sentinel still resolves against" the profile pointer.
That was false; the migrated resolver keys the sentinel by `cfg.default` (`connection.rs:304`) and ignores `activeProfile` entirely, so the rationale defended a write that does nothing on the path it claimed to protect.
The same error class as revision 1, caught the same way: by reading the resolver instead of the writer.

The sink inventory tripled on verification: four panel `e.message` notices, both shipped engines logging the raw construction exception, and the `luna-config` payload field, none of which a URL redactor placed at one producer could reach.
The response is structural rather than additive: redaction moved from "each consumer calls the redactor" to "raw values never cross the seam".

Falsifiability gaps codex proved: no old-socket-closed clause, prose token assertions instead of literals, no durability clause on the save, no non-chat window in the fan-out scenario, and an options-set assertion missing from the selector scenario.
Each is now an explicit clause, and the refusal/pairing contradiction (a refused switch would have made a new route impossible to pair) is resolved by separating selection-for-editing from the guarded switch, with the new Result-returning API named as new surface.

One codex finding was stale rather than wrong: it read Gate 0.2's harness citation before the pre-run edit landed; the gate now states explicitly that the contract test's stub lacks `__TAURI__.core` and must be extended, which is what the pre-run did.

## Explicitly not claimed

This does not make the deployment channel safer, faster, or better named.
It makes the connected server visible, makes the route model own both the connection and the credential, closes the live credential sinks, and adds a view seam that cannot leak.
The 2026-08-11 incident was not caused by the naming; the naming cost investigation time afterwards.
