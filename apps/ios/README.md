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

**QR pairing (recommended):** on the machine running the chat server,

```sh
bun run apps/server/scripts/pair-qr.ts            # auto-detects LAN IP
bun run apps/server/scripts/pair-qr.ts --host 100.x.y.z   # tailnet/manual
```

then in the app: Settings → **Pair** → **Scan code** (or **Paste link**).
The `luna://connect?host&port&token&tls` payload fills all four fields and
connects. The link carries your `UI_WS_TOKEN` — treat it like the token
itself. The printed QR defaults to the machine's first LAN IPv4 — it is only
dialable if the server actually binds that interface (see below).

**Manual:** the chat server binds `127.0.0.1:4753` by default. For a phone to reach it:

- **Simulator on the same Mac**: host `127.0.0.1`, port `4753` just works.
- **Physical iPhone on LAN**: run the server bound to `0.0.0.0`
  (`LUNA_UI_WS_HOST=0.0.0.0`) — it is bearer-token only,
  prefer a tailnet/tunnel for anything beyond a trusted LAN — then set host
  to your machine's LAN IP. The app declares `NSLocalNetworkUsageDescription`
  for this case.
- Token: the server's `UI_WS_TOKEN` (≥16 chars), sent as
  `Authorization: Bearer <token>` on the `/ui` upgrade.

## Build

```sh
xcodebuild -project Luna.xcodeproj -scheme Luna \
  -destination 'platform=iOS Simulator,name=iPhone 17' build
```

or open `Luna.xcodeproj` in Xcode and run.

## Test

```sh
xcodebuild -project Luna.xcodeproj -scheme Luna \
  -destination 'platform=iOS Simulator,name=iPhone 17' test
```

`LunaTests` covers the `luna://connect` pairing parser and the wire codec
(`FrameCodec`), including the archive-error path.

## Layout

```
Luna/
  LunaApp.swift        entry point + root navigation
  Protocol.swift       wire frames (Codable subset of ui-ws protocol v2)
  LunaClient.swift     URLSessionWebSocketTask transport
  AppState.swift       session store: threads, timelines, streaming, retry
  ThreadListView.swift thread list
  ChatView.swift       chat timeline + input bar
  NewChatView.swift    new-chat draft screen (model/effort picker)
  QRScannerView.swift  camera scanner for luna://connect payloads
  Pairing.swift        luna://connect link parser
  SettingsView.swift   host/port/token/TLS
  Keychain.swift       token storage
```
