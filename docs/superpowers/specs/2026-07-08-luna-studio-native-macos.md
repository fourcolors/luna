# Luna Studio Native (macOS): daily-driver app plan

Status: PROPOSED (awaiting owner review).
Date: 2026-07-08.
Research: 5-finder codebase map + 3 design variants + judge (workflow run), plus external Tauri v2 ecosystem research, cross-verified against code at `f1ca92d`.

## Goal

Ship a native macOS Luna Studio app, based on the existing `apps/ui-web` React app, good enough to be the owner's daily-driver Luna client.
Native means: OS notifications (turn finished, background job done, needs input, suggested action), dock unread badge, launch at login, tray, deep links, signed auto-update, and WS reconnect resilience.

## Decision: new sibling Tauri app

Build `apps/ui-studio-tauri`, a second Tauri v2 macOS app (identifier `com.luna.studio`) whose single WKWebView loads the existing ui-web Vite build unchanged.
Both Opus design variants and the judge converged on this independently.

Rejected: Studio window inside Moon.
Moon has no bundler (`apps/ui-moon-tauri/src-tauri/tauri.conf.json:7-10`: empty build commands, `frontendDist: "../frontend"` of hand-authored HTML).
Hosting a React SPA there bolts a Vite step onto an app that deliberately avoids one, welds Studio onto the `moon-v*` release train (a Studio-only fix forces a full orb re-sign/release, a red ui-web build blocks orb releases), and lands the largest-WKWebView-payload-in-the-repo risk on the shipping orb.

Rejected: PWA/browser as the daily driver.
A macOS WKWebView PWA has no reliable closed-window notifications (needs APNs), no Badging API, no launch-at-login, no OS deep links, no signed auto-update.
Instead, the browser path stays as graceful degradation inside the same code: every native call feature-detects `window.__TAURI__` and no-ops (or falls back to the web Notification API) in a plain tab.

## Verified facts that shaped the plan

- ui-web is already Tauri-shaped: `packages/ui-shared/src/transport.ts:9-12` explicitly anticipates the Tauri swap behind the `Transport` interface, and `useLunaData.onServerFrame` (`apps/ui-web/src/data/useLunaData.ts:190-194`) is a ready side-channel for the frames the reducer no-ops (`reducer.ts:508,560`).
- The wire protocol already carries every notification trigger: `assistant-done` with `message.delivery` (background deliveries, stamped at `chat-service.ts:1742-1754`, broadcast at `server.ts:1458-1490`), `turn-complete`, `result-delivered`, `suggested-action-set/update`, `secret-request` (targeted), and `job-input-request` (broadcast, `job-input-bridge.ts:109-190`). Zero new server surface needed for v1.
- `JobRunStatus` now includes `waiting` (`packages/core/src/jobs/jobs-store-types.ts:77`), and `request_input` flips running to waiting and back; the claim in `apps/ui-moon-tauri/design/widget-system.md:814-817` that this is missing is STALE and should be corrected.
- Moon's notification pipeline is proven and portable: `notify` Rust command (`main.rs:1004-1017`, 140-char truncation), least-privilege `allow-notify.toml` capability, and the client-side Notifier gates (`chat.html:2755-2814`: focus suppression, cross-window dedupe, opt-out).
- Dock badge needs NO custom FFI: the workspace resolves Tauri 2.11.2, and `setBadgeCount()` shipped in Tauri 2.2.0 (macOS supported; `setBadgeLabel()` is macOS-only for text).
- Plain `ws://` to a remote host works from the Tauri origin: Moon ships CSP `connect-src 'self' ws: wss:` and connects over plain `ws://` in production, so no TLS termination is required.
- Notification CLICK routing does NOT work on macOS desktop with the official plugin: the Actions API is mobile-only (open upstream request since 2021).
  macOS still activates (focuses) the app when a banner is clicked, but the app cannot learn WHICH notification was clicked without custom `UNUserNotificationCenter` delegate glue (`objc2`), which is real work and only testable in an installed `.app`.
- ui-web today has no reconnect (transport only reports status; `final-app.jsx:517-526` pops Settings on disconnect), but `packages/ui-transport/src/adapters/luna-ws.ts:129-158` already implements exponential backoff with terminal-auth vs transient-drop distinction; adoption, not a build.
- The reducer's `seq`/`throughSeq` dedupe (`reducer.ts:6-7,371-401`) makes resume-after-reconnect idempotent.
- `SessionSummary` has no read/seen marker (`packages/core/src/session/types.ts:96-118`); unread state is 100% new client-side work (persisted last-seen watermark per thread).
- Multi-client hazard: secret-entry and local-shell approval are last-subscriber-wins per thread (`secret-request-bridge.ts:131-150`, `local-shell-bridge.ts:63-114`); Studio auto-subscribing a thread Moon has open silently steals those prompts.
- Token model: the bearer token IS the session (`config.ts:5-6`), lives in plain localStorage, with a build guard refusing to bake `VITE_UI_WS_TOKEN` into dist (`apps/ui-web/package.json`).

## Architecture

Shell: `apps/ui-studio-tauri/src-tauri/tauri.conf.json` with `frontendDist: "../../ui-web/dist"`, `devUrl: "http://localhost:5174"` (ui-web's pinned dev port), `beforeBuildCommand` running ui-web's vite build.
ui-web needs zero code changes to render.
A new `apps/ui-web/src/data/tauri-bridge.ts` feature-detects `window.__TAURI__` so ui-web stays a plain web app in a browser.

Notification flow: server event -> existing WS frame -> `useStudioNotifier` (new, hooked on `onServerFrame`) -> Moon-ported gates (focus/dedupe/opt-out) -> `notify_thread` Rust command -> Notification Center.
Click on a banner activates Studio (OS default); a focus-regain handler routes to the pending attention thread (in-app attention model is the navigation surface, matching what mature Tauri chat apps ship).
Dock badge: `useUnreadBadge` (new) persists per-thread last-seen seq/ts to app-data, computes unread-thread count, calls `setBadgeCount()`.

Resilience: swap `browserWebSocketTransport` for the existing `LunaWsAdapter` backoff transport; add app-level auto-pong to the JSON ping frame (`server.ts:2083`).
Token: keychain-backed via small Rust `load_token`/`save_token` commands (vault-secret-store precedent); localStorage path kept for the browser.
Deep link: register `luna://thread/<id>` (`tauri-plugin-deep-link`) + `tauri-plugin-single-instance` so a second launch focuses and routes.

Distribution: clone Moon's pipeline with its own identity end to end: `bump-studio.ts` (four-file lockstep, `studio-v*` tags), `release-studio.yml` (macos-14, tauri-action, updater JSON), a NEW minisign keypair (never Moon's), updater feed on the public GitHub releases `latest.json`, Latest-flag re-anchor scoped so Moon and Studio never steal each other's feed.
Port Moon's WKWebView cache-purge-on-version-change verbatim (`main.rs:2979-3020`) with a `~/.luna/.studio-webview-version` stamp, or auto-updates serve stale assets.

## Phases and gates

Phase 0 - shell spike (de-risk WKWebView first; no notifications).
Scaffold the app, embed the ui-web dist, port the cache purge, launch the real window.
GATE: in the actual WKWebView (not agent-browser Chromium): a live thread streams over WS, a vibe-coded widget renders inside its sandbox (`WidgetFrame.jsx` srcdoc + CSP `default-src 'none'` + `sandbox="allow-scripts"`, no `__TAURI__` leak into widgets), clipboard write works with the capability declared.
Screenshot proof required.

Phase 1 - resilience spine.
LunaWsAdapter adoption + auto-pong; keychain token (preserve the `VITE_UI_WS_TOKEN` build guard, mirror it in CI); `luna://` deep link + single-instance; last-thread persistence and restore.
GATE: kill the server, show backoff reconnect and a resumed transcript with no duplicates; cold-launch with `luna://thread/<id>` lands on that thread; token verified in keychain, not localStorage.

Phase 2 - notifications (the headline).
`useStudioNotifier` mapping four categories: turn/job done (`assistant-done` + `delivery` marker distinguishes background from live; live replies deliberately not notified), suggested action (`suggested-action-set/update`), needs input (`job-input-request` broadcast + `secret-request` targeted).
Port Moon's gates; request permission on first run, fail soft.
Rust `notify_thread(kind, title, body, threadId)` via a per-command capability.
Click handling: banner click focuses Studio; on focus regain Studio routes to the single pending attention thread (or shows an attention strip when several are pending).
Web fallback: same hook uses the web Notification API in a browser tab.
GATE: with the window backgrounded, capture a real Notification Center banner for EACH category; show focus suppression and no double-banner across Studio + Moon on the same thread.

Phase 3 - daily-driver shell.
`useUnreadBadge` + `setBadgeCount()`; `tauri-plugin-autostart`; tray icon with unread tooltip and open/quit.
GATE: badge shows an accurate count that survives relaunch; login-item relaunch works; tray works.

Phase 4 - distribution.
Staged updater port (persist session before `app.restart()`), new keypair, `bump-studio.ts`, `release-studio.yml`.
GATE: install a signed build, publish `studio-v(x+1)`, show the full auto-update round trip with the WKWebView serving the NEW dist (stamp bumped).

Phase 5 (optional, post-daily-driver) - true banner-click routing.
`objc2` + `UNUserNotificationCenterDelegate` module threading threadId through `userInfo`, delivering real click-to-thread.
Decide after living with the Phase 2 UX; only testable in an installed `.app`.

Cross-cutting (server, separate slice, pending decision): per-connection multi-registration for secret-request/local-shell so Studio and Moon can coexist on one thread without prompt stealing; benefits Moon too.

## Test plan

Unit: `useStudioNotifier` gating (focus, opt-out, dedupe, category mapping) against synthetic ServerFrames; `useUnreadBadge` watermark math + persistence; reuse existing luna-ws backoff tests; widget-sandbox parity assertion following `widget-sandbox.parity.test.ts`; Rust: port `truncate_notification_body` test.
Every UI/OS gate above is a rendered screenshot or a real banner, never just a green test (vitest neither typechecks nor lays out pixels).

## Risks

- WKWebView drift at React scale (srcdoc/CSP sandbox, clipboard) is the top hazard; Phase 0 exists to expose it before any feature work.
- Prompt stealing between Studio and Moon (last-subscriber-wins) is a correctness bug waiting to happen until the coexistence decision is made.
- Focus-regain routing is a heuristic; multiple simultaneous attention events need the in-app attention strip to be honest.
- Two release trains double CI/signing surface; strict identity separation (identifier, keypair, tag prefix, Latest re-anchor) is what keeps them from corrupting each other.
- The repo is public: no personal hostnames or tokens in any committed file; connection config is always user-entered at runtime.

## Open decisions (owner)

1. Moon coexistence policy for interactive prompts (pick one): one client at a time; Studio avoids auto-subscribing threads with pending prompts; or invest in server-side per-connection multi-registration now.
2. Badge semantics: unread threads, unread messages, or attention-only (needs-input/suggested) - and whether the tray mirrors it.
3. Phase 5 click routing: accept focus-regain routing for v1, or pull the UN-delegate work earlier because banner-click-to-thread is a hard requirement.
4. Long-term: is Studio the eventual replacement for Moon's chat surface (orb becomes ambient dock), or permanent siblings? Decides whether Phase 4's separation is permanent.
5. First-run token provisioning UX: manual paste into Settings (exists today) vs a provisioning helper (e.g. `ui-ws-token.ts` emitting a `luna://connect?...` deep link).

## Estimates (AI build speed, per phase, each ending at its gate)

Phase 0: one session.
Phase 1: one to two sessions.
Phase 2: one to two sessions (live banner verification included).
Phase 3: one session.
Phase 4: one to two sessions (includes a real release round trip).
Total: roughly six to eight working sessions before Phase 5, each phase independently shippable and verified.
