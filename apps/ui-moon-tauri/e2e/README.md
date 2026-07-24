# Moon UI automation (WebdriverIO + Tauri)

End-to-end harness for **macOS** Moon (WKWebView):

- **WebdriverIO** talks to the **embedded** W3C server from `tauri-plugin-wdio-webdriver`
- Binary is spawned by `e2e/spawn-app.mjs` with `TAURI_WEBDRIVER_PORT` (feature `wdio-e2e`)
- We intentionally **do not** use `@wdio/tauri-service` today — its published pin of `@wdio/native-utils@2.4` is broken (missing export). Spawning + direct WebDriver is the supported embedded path from [Tauri docs](https://v2.tauri.app/develop/tests/webdriver/).

See also: `docs/chrome-tab-interaction.md` (UI automation section).

## What this validates

| Spec | Contract |
| --- | --- |
| `specs/smoke.spec.mjs` | App launches; hub loads; `expand_from_moon` opens chat |
| `specs/thread-drag.spec.mjs` | `LunaThreadDrag` session machine (attached→detach); `open_widget` floater path + latency budget |

## What this does **not** claim

- OS-owned `startDragging` free motion smoothness (needs Appium Mac2 / human)
- Chat-server thread list population (server optional; floater uses a synthetic thread id)
- Visual “Chrome-smooth” taste (use video + human checklist)

## Prerequisites

- macOS
- Rust toolchain (same as Moon build)
- Node 18+ / bun
- Debug binary built **with** `--features wdio-e2e` (embeds the WebDriver server)

## Commands

From `apps/ui-moon-tauri`:

```zsh
# Install JS harness deps (once)
bun install

# Build debug app with embedded WebDriver (Cargo feature wdio-e2e)
bun run test:e2e:build

# Run E2E (spawns the binary via WDIO service)
bun run test:e2e
```

Env knobs:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TAURI_WEBDRIVER_PORT` | `4445` | Embedded WebDriver port |
| `MOON_E2E_FLOATER_MS` | `2500` | Max ms for open_widget floater |
| `MOON_E2E_LOG` | `info` | WDIO log level |
| `MOON_E2E_PROFILE` | `debug` | `debug` or `release` binary folder |

## In-app hooks

Chat webviews expose:

- `window.__moonDragDebug` — ring buffer of drag session events + last floater timing
- `window.__moonE2E` — `simulateSessionDetach()`, `openFloater()`, `listThreadIds()`, …

Product path is unchanged; hooks are observe/inject only.

## Production safety

- Plugin is optional Cargo feature `wdio-e2e` (not in `default`)
- Registered only under `#[cfg(feature = "wdio-e2e")]`
- Normal `tauri build` / App Store release **must not** pass `--features wdio-e2e`

## Next layer (optional)

For real mouse drag across multi-window AppKit motion, add **Appium Mac2** (XCTest) driving coordinates while these hooks assert state. Keep WDIO as the in-webview contract suite.
