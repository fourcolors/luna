# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

Moon is a Tauri app whose design language is genuinely macOS-native (traffic lights, independent child windows, deep links, menu-bar presence), while ui-web and widget/panel pages are pure web.
Desktop work follows macOS conventions; browser work follows web conventions.

## Users

The primary user is the Operator: a single technical power user (the product owner) who lives in the product daily.
The Operator does not write code by hand; agents implement, the Operator directs, reviews, and decides.
The public repository is incidental: other developers may self-host, but design decisions optimize for the one power user, not for mass adoption.
A secondary usage mode is family or personal instances (separate containers with their own channel, e.g. Telegram-only), operated on the Operator's behalf.

## Product Purpose

Luna is a locally-hosted personal AI agent OS: a modular framework (Effect-TS, Bun, SQLite) that runs Claude-powered agents on the Operator's own machines with memory, scheduling, cost accounting, multi-account brokering, and multiple chat surfaces.
Success means the Operator can reach a capable, personalized agent from anywhere (desktop widget, web, terminal, Telegram) and trust it to run unattended jobs (dreams, sweeps, schedules) without babysitting.

## Positioning

Claims a neighboring product could not truthfully copy, all confirmed:

- Local-first agent OS: all state lives in `~/.luna/` SQLite on the Operator's box; nothing leaves unless a tool call sends it.
- Runs on your Claude subscription: OAuth token brokering over Claude.ai accounts (via `claude setup-token`), with multi-account rotation, instead of API keys.
- Ambient desktop presence: Moon's floating always-available widget makes the agent a persistent desktop companion, not a browser tab.
- Composable Effect-TS layers: every capability is a swappable Layer, so modules are testable and replaceable in isolation.
- Remote and local at once: the server can run on a remote box while the Operator tunnels in, or run fully local.
- Vibecoded widgets: the Operator can ask the agent to build custom widgets that snap onto the dashboard, Winamp-style (including skins).
- Harness-agnostic: Luna can be used with other agent harnesses (e.g. Hermes) rather than being married to a single one.

## Operating Context

- The Operator runs a home server with `stable` and `dev` deployment channels (systemd/containers) and auto-deploy timers; the desktop apps connect to those channels over WebSocket.
- Surfaces: Moon (Tauri floating widget + panel windows, macOS), Luna Studio web (React + Vite, retiring after the server extraction), the `luna` terminal client, and Telegram.
- Local dev: chat-server on `:4753` plus Vite on `:5174`; Moon pages are standalone HTML loadable over `file://` for screenshot-driven UI verification.
- Unattended operation is a real workflow: scheduled jobs (JobTicker), nightly dreams, maintainer sweeps, and result delivery back into chat threads.
- Releases: Moon ships versioned macOS builds via tag-triggered CI (`moon-v*`); the server self-updates per channel.

## Capabilities and Constraints

- Runtime constraints: Bun (not Node), Effect-TS v3, SQLite as the system of record, Vectorlite for vector search; Tauri v2 with WKWebView on macOS.
- WKWebView quirks are a durable constraint: stale cache across versions, `var()`/`color-mix()` dropped in SVG presentation attributes, borderless-window drag/resize limitations.
- Root `DESIGN.md` is the frozen architecture document, not a visual design system; do not treat it as Impeccable visual authority.
- Identity constraint: the agent presents as Luna, never as Claude or a generic assistant (see `DNA.md`, which is loaded into every thread's system prompt).
- The repository is public: product docs must never contain personal infrastructure details (hostnames, IPs, account identifiers).
- Terminology: "Moon" (floating widget app), "Studio" (retired desktop app; the name survives only in Luna Studio web), "panels/widgets" (snap-on surfaces), "threads" (chat sessions), "channels" (stable/dev deploys), "Operator" (the primary user).
- Undecided: whether the developer/self-hoster audience ever becomes a design target; currently explicitly not.

## Brand Commitments

- Name: Luna; moon iconography (crescent-moon orb) is the established identity of the desktop widget.
- Winamp-era skinnable-widget nostalgia is a confirmed, deliberate product reference for the dashboard/widget system, not an accident.
- Existing committed visual worlds in the apps (e.g. the watercolor theme, paper-grain skins) are incumbent evidence to preserve or consciously replace, not defaults to polish over.
- Hard visual rule from the Operator: never add a crisp ring, border, or outline to Moon's `.widget-shell`.

## Evidence on Hand

- Real shipping apps: `apps/ui-moon-tauri` (releases through `moon-v0.0.65`), `apps/ui-web`, `apps/agent-cli`.
  Studio (`apps/ui-studio-tauri`) was retired in PR #405 (2026-07-31); Moon is the only desktop GUI.
- `DNA.md` (end-user-facing identity and operating contract) and `DESIGN.md` (architecture) are authoritative written sources.
- UI truth is verified by rendered screenshots (project rule): Moon pages drive real HTML via `agent-browser` and `__MoonInternals.handleFrame`; a real-Tauri WKWebView glance precedes releases.
- No customers, testimonials, pricing, or market claims exist; future work must not fabricate any.

## Product Principles

- Optimize for one Operator's daily flow, not for hypothetical adopters; friction the Operator hits daily outweighs generality.
- The agent should feel ambient and persistent: reachable in seconds from any surface, with shared memory and threads across all of them.
- Local ownership is non-negotiable: state stays on Operator-controlled machines, secrets stay in Keychain/1Password tiers.
- Unattended reliability is a feature: jobs, deploys, and self-updates must degrade safely and report honestly.
- Extensibility over configuration: new capability arrives as a vibecoded widget, skill, or swappable layer, not as a settings page.

## Accessibility & Inclusion

No product-specific requirement established; standard platform accessibility expectations apply per surface (macOS conventions on desktop, web standards in browser surfaces).
