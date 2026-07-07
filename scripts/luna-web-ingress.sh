#!/usr/bin/env bash
# luna-web-ingress.sh — idempotent Tailscale Serve front door for the Luna
# chat-server.
#
# Usage:
#   ./scripts/luna-web-ingress.sh
#
# What it does:
#   Exposes the local chat-server port (default 4753) to your Tailscale tailnet
#   over HTTPS using `tailscale serve`. Tailscale auto-provisions a TLS
#   certificate for the machine's <hostname>.your-tailnet.ts.net URL.
#
# Environment:
#   LUNA_UI_PORT    — chat-server port (default: 4753)
#
# Alternatives (not automated here — see docs/web-client/serving.md):
#   - Caddy + real TLS domain  (Option 2)
#   - Caddy + tls internal     (Option 3)
#   - ngrok / Cloudflare Tunnel (Option 5)
#
# Idempotent: running this script multiple times is safe — `tailscale serve`
# with the same port is a no-op if already configured.
#
# No hardcoded hostnames, IPs, or secrets. All configuration is via env or
# Tailscale's own node identity.

set -euo pipefail

PORT="${LUNA_UI_PORT:-4753}"

# ── Preflight: check tailscale is present ──────────────────────────────────────
if ! command -v tailscale &>/dev/null; then
  echo "ERROR: tailscale not found in PATH." >&2
  echo "Install Tailscale: https://tailscale.com/download" >&2
  echo "" >&2
  echo "Alternatives (no Tailscale required):" >&2
  echo "  Caddy:  see docs/web-client/serving.md option 2/3" >&2
  echo "  ngrok:  ngrok http ${PORT}" >&2
  exit 1
fi

# ── Check tailscaled is running ────────────────────────────────────────────────
if ! tailscale status &>/dev/null; then
  echo "ERROR: tailscaled is not running or you are not logged in." >&2
  echo "Run: tailscale up" >&2
  exit 1
fi

# ── Set up Tailscale Serve (idempotent) ────────────────────────────────────────
echo "[luna/web-ingress] Configuring Tailscale Serve: localhost:${PORT} → tailnet HTTPS"
tailscale serve --bg "localhost:${PORT}"

# ── Show the resulting URL ─────────────────────────────────────────────────────
TAILNET_URL="$(tailscale serve status 2>/dev/null | grep 'https://' | awk '{print $1}' | head -1 || true)"
if [[ -n "$TAILNET_URL" ]]; then
  echo "[luna/web-ingress] Web client available at: ${TAILNET_URL}"
else
  echo "[luna/web-ingress] Done. Check your Tailscale URL with: tailscale serve status"
fi
