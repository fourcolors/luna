# Separating "which server" from "how much I see"

Status: plan, revision 2. Not yet implemented.
Revision 1 was reviewed adversarially by codex and sent back for rework; its central architectural claim was WRONG. What changed is recorded at the bottom, because the error is instructive.

## The problem, stated precisely

The word `dev` carries two meanings that have nothing to do with each other.

It names a **deployment channel**: a server instance that takes new code first.
It also implies a **mode**: verbose output, internals visible, "for developers".

Only the first is real in the code.
The second is folklore, and the affordance it implies does not exist anywhere: `grep -rln "debugMode|verbose|devMode|showRaw" apps/ui-moon-tauri/frontend-react/src` returns nothing.

Conflating them costs the most valuable combination.
The place you most want internals visible is PRODUCTION, because that is where the confusing failures happen.
While "dev" names a server, "dev mode on stable" sounds self-contradictory, so the vocabulary discourages exactly what an operator reaches for during an incident.

## What is actually there, corrected

Revision 1 claimed routes were the settled model and `moon-connection.json` was legacy.
That is FALSE, and it invalidated the plan's ordering.

TWO stores are live at once.

`~/.luna/client.toml` (`fileFormatVersion = 3`) holds **routes**: `RouteInfo` is `{label, key, endpoints, token_ref, expect, transport}` (`apps/ui-moon-tauri/src-tauri/src/client_config.rs:52-61`). No mode semantics. Good.

`~/.luna/moon-connection.json` is NOT legacy. `connection.rs:41` describes it as the mode-600 store for the `(url, token)` pair, and `load_connection_in` resolves the `"legacy"` `tokenRef` sentinel by reading the token out of it. Settings still switches route through `set_active_profile`, which writes only this file and never calls `setDefaultRoute` / `setPanelRoute`.

So route switching today is **split between two stores**, and the route model is not yet the thing that owns the socket.
An existing test at `settings-connection-panel.test.tsx:528-553` already documents the route-key versus profile-name divergence as a known issue.

This is the finding that reorders the whole plan.
Revision 1 proposed building an indicator on top of route switching, assuming it was a solved substrate. It is not.

## What is missing, in dependency order

1. **Route switching does not fully live in the route model.** Everything else builds on this.
2. **Nothing displays which route a window is connected to.** The `connection-changed` event payload is `{"for": target, "name": name}` (`windows.rs:331`) and carries NO route data, so this is real plumbing, not a render.
3. **No view-mode concept exists at all.**

Item 2 is the sharpest operational hazard: on 2026-08-11 two servers 154 commits apart were both live and reachable.
Revision 1 said nothing in the UI would distinguish them; that was overstated. Chat renders a build SHA and Settings shows the raw WS URL. What is missing is a PERSISTENT, glanceable indicator, not all identity information.

## Scope

IN: make route switching own the socket; a persistent per-window route indicator; a view-mode seam with a redaction contract.

OUT: renaming the `dev` deployment channel in `/etc/luna/servers.toml`, systemd units, or the deploy CLI's `--profile` flag. That is a real migration with outage risk and buys nothing the client-side change does not.

OUT: designing what verbose SHOWS. See "Deliberately deferred", which now carries a hard constraint rather than a shrug.

## The security invariant, which is not deferrable

`moon-protocol.js:62` builds the socket URL as `wsUrl + sep + 'token=' + encodeURIComponent(wsToken)`.
**The credential is in the URL.**

So any view that renders transport internals - a raw frame, a URL, a reconnect log line - leaks the token by default.
This cannot be deferred alongside "what verbose shows", because the seam's very first consumer could leak it.

INVARIANT: no view-mode surface may render a URL, frame, or header without passing it through a redactor that removes the `token` parameter.
This ships in step 3 WITH the seam, tested before any consumer exists.

## The per-window decision, made explicitly

Revision 1 said "app-level" without arguing it. Codex was right that this is under-specified.

DECISION: view mode is **per-window and ephemeral**. Not persisted, not global.

Reasons. Moon spawns one window per widget kind and per distinct param set (`windows.rs:338-386`), and route is ALREADY persisted per panel (`set_panel_route`). A global flag toggled during a production incident would silently change every open window, including ones pointed at other routes. And persisting it invites it drifting back into a per-route setting, which is the coupling this whole change removes.

A view is not a preference. It resets when the window closes.

## BDD scenarios

### Feature: the selected route owns the socket

```gherkin
Scenario: switching route in Settings changes the connected endpoint
  Given a window connected to the route labelled "stable"
  When the user selects the route labelled "canary" in Settings
  Then the window's socket endpoint is the one configured for "canary"
  And the route model reports "canary" as this window's route
```

```gherkin
Scenario: the route key and the displayed label do not diverge
  Given routes exist with keys "stable" and "canary"
  When the user selects "canary"
  Then the persisted route key is "canary"
  And no separate profile name is written that disagrees with it
```

The second scenario is the regression fence for the divergence already documented at `settings-connection-panel.test.tsx:528-553`.

### Feature: the connected route is always visible

```gherkin
Scenario: the window names its route
  Given a window connected to the route labelled "stable"
  Then the window displays a route indicator whose text is exactly "stable"

Scenario: the indicator follows a route switch
  Given a window displaying route indicator "stable"
  When the user switches to route "canary"
  Then the window displays a route indicator whose text is exactly "canary"

Scenario: a disconnected window still names its route
  Given a window connected to route "canary"
  When the connection drops
  Then the route indicator is still present
  And it reads "canary"
  And it is marked disconnected
```

"whose text is exactly" is deliberate. Revision 1 said "displays 'stable'", which unrelated text elsewhere in the window could satisfy.

The third scenario matters because the failure being guarded against is acting on a window believed to be live. An indicator that VANISHES on disconnect is worse than none: absence reads as fine.

### Feature: view mode is orthogonal to route, and never leaks the token

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
Scenario: the redactor removes the credential
  Given a socket URL containing a token query parameter
  When that URL is passed to the view-mode redactor
  Then the result contains no token value
  And the result still shows the host and route path
```

```gherkin
Scenario: view mode is not persisted anywhere
  Given the verbose view is enabled in a window
  When the window is closed and reopened
  Then the view mode is off
  And neither client.toml nor moon-session.json contains a view-mode key
```

The last line names BOTH files. Revision 1 asserted only "client.toml has no view-mode key", which codex correctly showed proves nothing: the structs lack `deny_unknown_fields`, and `moon-session.json` is already the per-panel persistence surface, so an implementation could store it there and pass.

## TDD order, reordered

Revision 1's order assumed route switching worked. It does not, so it comes first.

**Step 1. Route switching owns the socket.**
Test first: the two route-ownership scenarios, extending `settings-connection-panel.test.tsx` where the divergence is already documented.
Implementation: route Settings' switch through `setDefaultRoute` / `setPanelRoute` rather than `set_active_profile`, keeping `moon-connection.json` as the token store it actually is.
This is the largest step and the one with real risk, because it touches live credential resolution.

**Step 2. The route indicator.**
Test first: the three indicator scenarios.
Implementation: this DOES need plumbing. The `connection-changed` payload (`windows.rs:331`) must carry the route key, or the frontend must query it on the event. Revision 1's "no new plumbing" claim was wrong.
For the disconnected scenario, do NOT extend `live-reconnect.test.ts`: it is opt-in behind `LUNA_LIVE_WS` and needs a human to restart a server. Drive the drop through the existing pooled-connection test seam instead.

**Step 3. The view-mode seam plus its redactor.**
Test first: the four view-mode scenarios, INCLUDING the redactor, before any consumer exists.
Implementation: per-window ephemeral state, plus a redactor applied at the boundary.

**Step 4. One named consumer.**
Not "a cheap consumer" as revision 1 hand-waved. Name it: the route indicator gains a verbose form showing the resolved endpoint host and connection state, with the URL passed through the redactor.
This is chosen because it needs no new data, exercises the redactor on a real credential-bearing URL, and is useful on production, which is the whole argument.

## Deliberately deferred, with a constraint

WHAT ELSE verbose shows stays unspecified. That list should come from incidents rather than planning.

The constraint that is NOT deferred: every future surface goes through the redactor from step 3. The seam ships with the safety property already tested, so the deferred decision cannot reintroduce a credential leak.

## What changed from revision 1, and why it is worth recording

Revision 1 asserted that routes were the current model and `moon-connection.json` was legacy. Codex checked it against `connection.rs` and found the file is the ACTIVE token store, and that Settings still switches through the profile path.

Everything downstream inherited that error: the ordering put the indicator before the substrate it renders, and step 3 claimed "no new plumbing" for an event that carries no route data.

The lesson is narrow and worth keeping. The claim was grounded in a real file read - `client.toml` genuinely exists, `RouteInfo` genuinely has no mode field, `migrate_legacy_connection` genuinely exists. Reading the NEW thing and finding it real is not evidence that the OLD thing is dead. Confirming a migration has finished requires reading the consumers, not the destination.

## Explicitly not claimed

This does not make the deployment channel safer, faster, or better named.
It makes the connected server visible, makes the route model actually own the connection, and adds a view seam that cannot leak a credential.
The 2026-08-11 incident was not caused by the naming; the naming cost investigation time afterwards.
