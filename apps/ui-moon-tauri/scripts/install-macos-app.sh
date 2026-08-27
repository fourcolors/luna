#!/usr/bin/env bash
# install-macos-app.sh — build a real Luna Moon.app and install it to /Applications.
#
# WHY THIS EXISTS
# ---------------
# With bundle.macOS.signingIdentity = null, `tauri build` skips codesign. The
# Mach-O stays linker-signed (Identifier like luna_moon_ui-<hash>, entitlements
# none, Info.plist=not bound, Sealed Resources=none). macOS then IGNORES ATS +
# NSLocalNetworkUsageDescription in Info.plist — Local Network prompt never
# appears and WKWebView never dials the configured ws:// URL even though curl works.
#
# Copying `target/release/luna-moon-ui` into an existing .app's Contents/MacOS
# produces the same unbound hole. Always install the .app that `tauri build`
# emitted after signing with identity "-" (or APPLE_SIGNING_IDENTITY).
#
# Usage (from repo root or this package):
#   bun run --filter '@luna/ui-moon-tauri' install:macos
#   # or:
#   ./apps/ui-moon-tauri/scripts/install-macos-app.sh
#
# Env:
#   APPLE_SIGNING_IDENTITY  optional override (e.g. "Apple Development: …")
#                           for a stable CDHash / TCC grant across rebuilds.
#   DEST_APP                default: /Applications/Luna Moon.app
#   SKIP_BUILD=1            install an already-built .app from bundle/ (no rebuild)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_APP="${DEST_APP:-/Applications/Luna Moon.app}"
EXPECTED_ID="com.luna.moon"
ENTITLEMENTS="$ROOT/src-tauri/entitlements.plist"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: this script only runs on macOS (got $(uname -s))" >&2
  exit 1
fi

if [[ ! -f "$ROOT/src-tauri/tauri.conf.json" ]]; then
  echo "error: expected tauri.conf.json under $ROOT/src-tauri" >&2
  exit 1
fi

SIGN_ID="${APPLE_SIGNING_IDENTITY:--}"
echo "==> signing identity: ${SIGN_ID} (set APPLE_SIGNING_IDENTITY to use a real cert)"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> bun run build (tauri build — must sign the bundle; do NOT cargo-cp the binary)"
  (
    cd "$ROOT"
    # Prefer the package script so beforeBuildCommand runs.
    bun run build
  )
fi

# Prefer universal / arch-specific release bundle paths tauri emits.
CANDIDATES=(
  "$ROOT/src-tauri/target/release/bundle/macos/Luna Moon.app"
  "$ROOT/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Luna Moon.app"
  "$ROOT/src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Luna Moon.app"
)

SRC_APP=""
for c in "${CANDIDATES[@]}"; do
  if [[ -d "$c" ]]; then
    SRC_APP="$c"
    break
  fi
done

if [[ -z "$SRC_APP" ]]; then
  echo "error: no Luna Moon.app under src-tauri/target/*/release/bundle/macos/" >&2
  echo "       run without SKIP_BUILD, or finish \`bun run build\` first." >&2
  echo "       Do NOT copy target/release/luna-moon-ui into an old .app — that leaves Info.plist unbound." >&2
  exit 1
fi

echo "==> built app: $SRC_APP"

# Belt-and-suspenders: force a consistent ad-hoc (or cert) signature that binds
# Info.plist + entitlements under CFBundleIdentifier com.luna.moon. Harmless if
# tauri already signed correctly; required if someone used an older null-identity
# config or swapped the Mach-O by hand.
echo "==> codesign --force (bind Info.plist + entitlements, identifier $EXPECTED_ID)"
codesign --force --deep --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --sign "$SIGN_ID" \
  --identifier "$EXPECTED_ID" \
  "$SRC_APP"

echo "==> install → $DEST_APP"
# Replace atomically-ish: remove destination then ditto (preserves resource forks).
rm -rf "$DEST_APP"
ditto "$SRC_APP" "$DEST_APP"

echo "==> verify codesign (must show Identifier=$EXPECTED_ID, Info.plist=bound)"
CODESIGN_OUT="$(codesign -dv --verbose=4 "$DEST_APP" 2>&1 || true)"
printf '%s\n' "$CODESIGN_OUT"

fail=0
if ! printf '%s\n' "$CODESIGN_OUT" | grep -q "Identifier=${EXPECTED_ID}$"; then
  echo "FAIL: Identifier is not ${EXPECTED_ID} (linker-signed cargo binary looks like luna_moon_ui-<hash>)" >&2
  fail=1
fi
if printf '%s\n' "$CODESIGN_OUT" | grep -qi "Info.plist=not bound"; then
  echo "FAIL: Info.plist=not bound — ATS / Local Network purpose strings will be ignored" >&2
  fail=1
fi
# A BOUND Info.plist is reported one of two ways depending on the codesign
# version: older ones print the literal "Info.plist=bound", macOS 26's prints
# "Info.plist entries=<N>". Demanding only the literal made every install on
# macOS 26 abort verification on a correctly-signed app — and it contradicted
# the check directly above, which already treats "Info.plist=not bound" as THE
# failure signal. Accept either spelling of success.
if ! printf '%s\n' "$CODESIGN_OUT" | grep -qiE "Info\.plist=bound|Info\.plist entries=[0-9]+"; then
  echo "FAIL: no bound Info.plist in codesign -dv --verbose=4 output" >&2
  echo "      (expected 'Info.plist=bound' or 'Info.plist entries=<N>')" >&2
  fail=1
fi
if printf '%s\n' "$CODESIGN_OUT" | grep -qi "linker-signed"; then
  echo "FAIL: still linker-signed — bundle signing did not take" >&2
  fail=1
fi
if [[ ! -d "$DEST_APP/Contents/_CodeSignature" ]]; then
  echo "FAIL: missing Contents/_CodeSignature (Sealed Resources absent)" >&2
  fail=1
fi

# Plist keys from #544 must be present in the installed bundle.
INSTALLED_PLIST="$DEST_APP/Contents/Info.plist"
if [[ -f "$INSTALLED_PLIST" ]]; then
  if ! grep -q "NSLocalNetworkUsageDescription" "$INSTALLED_PLIST"; then
    echo "FAIL: installed Info.plist missing NSLocalNetworkUsageDescription" >&2
    fail=1
  fi
  if ! grep -q "NSAllowsLocalNetworking" "$INSTALLED_PLIST"; then
    echo "FAIL: installed Info.plist missing NSAllowsLocalNetworking" >&2
    fail=1
  fi
else
  echo "FAIL: no Info.plist at $INSTALLED_PLIST" >&2
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo "" >&2
  echo "Install aborted verification. Do not launch this build expecting the configured WS host to work." >&2
  exit 1
fi

echo ""
echo "OK — $DEST_APP is signed as ${EXPECTED_ID} with Info.plist bound."
echo "Next on Mac:"
echo "  1. Quit any running Luna Moon / WebKit.Networking for the old identity."
echo "  2. Open '$DEST_APP' (right-click → Open once if Gatekeeper complains)."
echo "  3. When Local Network prompts, Allow — or enable Luna Moon under"
echo "     System Settings → Privacy & Security → Local Network."
echo "  4. Confirm Connected on your configured ws:// URL."
