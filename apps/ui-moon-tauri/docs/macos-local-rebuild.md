# macOS local rebuild — Info.plist must be codesign-bound

## The unbound-plist hole (proven 2026-08-18)

Sterling rebuilt Moon with the #544 ATS / Local Network keys present in
`/Applications/Luna Moon.app/Contents/Info.plist`, but:

- Local Network prompt **never** appeared
- WebKit.Networking still opened **no TCP** to `luna-server:4753`
- `codesign -dv` showed: `adhoc,linker-signed`, `Info.plist=not bound`,
  `Sealed Resources=none`, `entitlements=none`
- Identifier was `luna_moon_ui-<hash>` — the Cargo package name — **not**
  `com.luna.moon`

When Info.plist is **not bound** into the code signature, macOS ignores
`NSLocalNetworkUsageDescription` and `NSAppTransportSecurity`. TCC grants for
display name “Luna Moon” / `com.luna.moon` also do not apply to that ad-hoc
linker identity.

### How you get there

1. **`signingIdentity: null`** in `tauri.conf.json` — Tauri skips bundle
   signing entirely. The Mach-O keeps the linker’s ad-hoc stamp only.
2. **Copying** `target/release/luna-moon-ui` (or `cargo build` output) into an
   existing `.app`’s `Contents/MacOS/` — same unbound hole, even if you edited
   Info.plist by hand.

Host `curl` to `luna-server:4753` still works; only the webview path dies.

## Correct rebuild (binds Info.plist)

Committed config now sets `"signingIdentity": "-"`. Prefer the installer script:

```bash
cd apps/ui-moon-tauri
bun run install:macos
```

That runs `tauri build`, force-codesigns with `com.luna.moon` +
`entitlements.plist`, installs to `/Applications/Luna Moon.app`, and **fails**
if Identifier ≠ `com.luna.moon` or `Info.plist=not bound`.

### Manual equivalent

```bash
cd apps/ui-moon-tauri
bun run build   # NOT: cargo build && cp into Contents/MacOS

APP="src-tauri/target/release/bundle/macos/Luna Moon.app"
# arch-specific targets also ok under target/<triple>/release/bundle/macos/

codesign --force --deep --options runtime \
  --entitlements src-tauri/entitlements.plist \
  --sign "${APPLE_SIGNING_IDENTITY:--}" \
  --identifier com.luna.moon \
  "$APP"

rm -rf "/Applications/Luna Moon.app"
ditto "$APP" "/Applications/Luna Moon.app"
```

Optional: set `APPLE_SIGNING_IDENTITY` to an Apple Development cert so the
CDHash stays stable across rebuilds (TCC Local Network / Screen Recording
grants survive). Ad-hoc `-` works for ATS/plist binding but rotates CDHash.

## Verify before chasing WS bugs

```bash
codesign -dv --verbose=4 "/Applications/Luna Moon.app" 2>&1 | egrep 'Identifier=|Info.plist=|Signature=|linker-signed|Sealed Resources|TeamIdentifier'
plutil -p "/Applications/Luna Moon.app/Contents/Info.plist" | egrep 'CFBundleIdentifier|NSLocalNetwork|NSAllowsLocalNetworking|ts.net'
ls "/Applications/Luna Moon.app/Contents/_CodeSignature"
```

Expect:

| Field | Good | Bad (ignore ATS / no Local Network prompt) |
|-------|------|--------------------------------------------|
| Identifier | `com.luna.moon` | `luna_moon_ui-<hash>` |
| Info.plist | `bound` | `not bound` |
| Signature | adhoc (or Developer) **without** `linker-signed` | `adhoc,linker-signed` |
| Sealed Resources | present (`_CodeSignature/`) | `none` |
| Entitlements | from `entitlements.plist` | `none` |

Then launch the app, Allow Local Network, and confirm Connected on **your
configured server's `ws://` URL** — the host you gave the installer, e.g.
`ws://<your-host>:4753/ui`.

**Do not retarget localhost to make this pass.** Loopback is exempt from
Local Network TCC and from the ATS/bound-plist machinery, so a loopback
"Connected" proves nothing about the bundle — it is the precise failure this
page exists to catch. That is also why the This Mac target ships gated off
(`THIS_MAC_TARGET_ENABLED = false`).

There is no default host to fall back on: #588 removed it and the installer
prompts instead, so an unconfigured Moon has nothing to dial and must be
pointed at a server first.

## Round 3 — boot must reach `new WebSocket` (in-app)

Even with a bound plist + Local Network on, the chat UI can stay on HTML
**Disconnected** + MoonBar default **“waking up…”** with **zero** SYN from
WebKit.Networking if boot awaits `migrate_legacy_connection` /
`load_connection` / `resolveBootRoute` forever before `connect()`.

In-app fix (not another plist string):

- `frontend-react/src/tauriBoot.ts` — `invokeWithTimeout` (2s) + `pickBootWsUrl`
  keeps `luna_ws_url` (e.g. `ws://luna-server:4753/ui`) when invoke times out
- hub `loadSettings` + chat `loadConnectionAndConnect` / PoolEngine use it
- CSP `connect-src` explicitly includes `ipc:` / `http://ipc.localhost` so boot
  invokes are not CSP-starved

What unblocks the SYN: boot reaches `new WebSocket(...)` instead of hanging
on a Tauri invoke before the constructor runs.
