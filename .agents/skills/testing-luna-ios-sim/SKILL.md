---
name: testing-luna-ios-sim
description: End-to-end test the apps/ios Luna SwiftUI app in an iPhone simulator against a real local chat server.
---

# Testing the Luna iOS app (apps/ios) in the Simulator

## Bring up a credentialed chat server

```sh
cd ~/repos/luna
# Seed the default account pointer once (idempotent). Requires CLAUDE_CODE_OAUTH_TOKEN in env.
bun run apps/server/scripts/seed-default-account.ts ~/.luna/luna.db
# Boot with a test WS token. Pin the claude binary — the SDK's auto-detect only
# finds the linux-x64 package on darwin, and `claude` is not on PATH.
UI_WS_TOKEN=<16+ chars> \
LUNA_CLAUDE_CODE_EXECUTABLE="$PWD/node_modules/.bun/@anthropic-ai+claude-agent-sdk-darwin-arm64@<ver>/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude" \
bun run scripts/luna-chat-server-entry.ts
```

Verify: `curl 127.0.0.1:4753/readyz` → `{"mode":"normal","credentialOk":true}`.

## Build / install / launch

```sh
xcodebuild -project apps/ios/Luna.xcodeproj -scheme Luna \
  -destination 'platform=iOS Simulator,name=iPhone 17' -configuration Debug \
  CODE_SIGNING_ALLOWED=NO build
xcrun simctl install <udid> ~/Library/Developer/Xcode/DerivedData/Luna-*/Build/Products/Debug-iphonesimulator/Luna.app
xcrun simctl launch <udid> com.fourcolors.luna.ios
xcrun simctl io <udid> screenshot /tmp/shot.png   # device-res evidence
```

Gotchas:
- Multiple booted sims make `booted` ambiguous — use explicit UDIDs; `simctl shutdown <other>` extra devices.
- If no iOS runtime: `xcodebuild -downloadPlatform iOS`.
- `open -a Simulator` to see the window; computer-tool clicks/type work once the sim window has focus (screenshots can lag — re-shoot before concluding a tap missed).
- **Unsigned builds can't use the Keychain:** `CODE_SIGNING_ALLOWED=NO` produces no keychain entitlement, so `SecItem*` calls fail ("Requestor lacks required entitlement" in `simctl spawn <udid> log show`). The app falls back to UserDefaults for the token — expected on sim, not a bug.
- Slow stepped drags (`left_mouse_down` + several `mouse_move`) are needed for List swipe actions; quick `left_click_drag` misses.
- Prefer a full swipe for Archive (auto-commits); thread rows use onTapGesture navigation so the revealed swipe button also works.

## Server-side protocol checks (corroborate UI claims)

```sh
bun -e 'import WebSocket from "ws";
  const ws = new WebSocket("ws://127.0.0.1:4753/ui", {headers:{Authorization:"Bearer <token>"}});
  ws.on("message", d => { const f = JSON.parse(d); if (f.type==="thread-list"||f.type==="thread-snapshot") console.log(JSON.stringify(f).slice(0,2000)); });
  ws.on("open", () => ws.send(JSON.stringify({type:"list-threads",limit:10})));'
```

- `list-threads` excludes threads with zero user messages by design (`hasUserMessage: true`) — an empty list right after `new-thread` is expected, not a bug.
- `thread-snapshot` is bounded to the most recent 500 stored messages (`DEFAULT_SNAPSHOT_MESSAGE_LIMIT`) — long turns can push earlier messages out of reopen view. Server-side known limitation, not an app bug.
