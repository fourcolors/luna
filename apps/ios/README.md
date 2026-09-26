# Luna for iOS

A minimal native iPhone/iPad client for the Luna chat server, written in
SwiftUI. It speaks the same UI WebSocket protocol as the Moon desktop app
(`packages/ui-ws`, protocol v2) and covers the core loop:

- Thread list with previews — create, open, pull-to-refresh, swipe to archive
- Live chat — streaming assistant deltas, tool-call activity rows, markdown
  rendering, image attachments (camera roll → base64)
- Interrupt a running turn, auto-reconnect, ping/pong keepalive
- Model + effort picker on new threads (from the server's `hello` frame)
- Server address/token in Settings (token stored in Keychain)

Intentionally not included (the desktop app owns these): voice pipeline,
widgets/artifacts, connectors, vault management, workflows, and settings
panels beyond the connection itself.

## Requirements

- Xcode 16+ (project uses file-system-synchronized groups)
- iOS 17+ simulator or device
- A reachable Luna chat server (`bun run scripts/luna-chat-server-entry.ts`)

## Connect

The chat server binds `127.0.0.1:4753` by default. For a phone to reach it:

- **Simulator on the same Mac**: host `127.0.0.1`, port `4753` just works.
- **Physical iPhone on LAN**: run the server bound to `0.0.0.0`
  (`--bind 0.0.0.0` / `LUNA_UI_WS_BIND=0.0.0.0`) — it is bearer-token only,
  prefer a tailnet/tunnel for anything beyond a trusted LAN — then set host
  to your machine's LAN IP.
- Token: the server's `UI_WS_TOKEN` (≥16 chars), sent as
  `Authorization: Bearer <token>` on the `/ui` upgrade.

## Build

```sh
xcodebuild -project Luna.xcodeproj -scheme Luna \
  -destination 'platform=iOS Simulator,name=iPhone 17' build
```

or open `Luna.xcodeproj` in Xcode and run.

## Layout

```
Luna/
  LunaApp.swift        entry point + root navigation
  Protocol.swift       wire frames (Codable subset of ui-ws protocol v2)
  LunaClient.swift     URLSessionWebSocketTask transport
  AppState.swift       session store: threads, timelines, streaming, retry
  ThreadListView.swift thread list
  ChatView.swift       chat timeline + input bar
  NewThreadView.swift  create-thread sheet (model/effort)
  SettingsView.swift   host/port/token/TLS
  Keychain.swift       token storage
```
