#!/usr/bin/env bash
#
# restart-channel.sh — restart a Luna chat-server channel safely.
#
# Refuses to restart if there are active WebSocket connections on the
# channel's port (which would kill the operator's running chat session
# without warning, the failure mode from issue #24). Pass --yes to
# override when you have intentionally accepted the session-kill cost.
#
# Usage:
#   scripts/restart-channel.sh <dev|stable> [--yes]
#
# Detection: counts ESTABLISHED TCP connections on the channel's port.
# Prefers `ss` (Linux). Falls back to `lsof` if ss is unavailable. If
# neither is present we proceed without the guard but print a warning;
# this matches the previous behavior and avoids creating a new failure
# mode in install environments without the network-introspection tools.

set -euo pipefail

if [ "$#" -lt 1 ]; then
  printf 'usage: %s <dev|stable> [--yes]\n' "$0" >&2
  exit 1
fi

CHANNEL="$1"; shift
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --yes) FORCE=1 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2 ; exit 1 ;;
  esac
done

case "$CHANNEL" in
  dev)
    PORT=5753
    RESTART=(incus exec luna-dev -- systemctl restart luna-dev-chat-server.service)
    JOURNAL=(incus exec luna-dev -- journalctl -u luna-dev-chat-server.service --no-pager -n 20)
    HEALTH_URL="http://127.0.0.1:5753/healthz"
    ;;
  stable)
    PORT=5754
    RESTART=(systemctl restart luna-chat-server.service)
    JOURNAL=(journalctl -u luna-chat-server.service --no-pager -n 20)
    HEALTH_URL="http://127.0.0.1:5754/healthz"
    ;;
  *)
    printf 'unknown channel: %s (must be "dev" or "stable")\n' "$CHANNEL" >&2
    exit 1
    ;;
esac

count_connections() {
  if command -v ss >/dev/null 2>&1; then
    # ss prints a header line we skip with tail -n +2.
    ss -tn state established "( sport = :$PORT )" 2>/dev/null \
      | tail -n +2 | wc -l | tr -d ' '
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:ESTABLISHED 2>/dev/null \
      | tail -n +2 | wc -l | tr -d ' '
    return
  fi
  echo "?"  # unknown
}

CONNS="$(count_connections)"

if [ "$CONNS" = "?" ]; then
  printf 'warn: neither ss nor lsof found — cannot check for active connections.\n' >&2
  printf 'warn: proceeding without the guard.\n' >&2
elif [ "$CONNS" -gt 0 ] && [ "$FORCE" -ne 1 ]; then
  printf 'REFUSED: %s active connection(s) on port %s (channel "%s").\n' "$CONNS" "$PORT" "$CHANNEL" >&2
  printf 'Restarting will drop the operator chat session(s) on this channel.\n' >&2
  printf 'If that is intentional, re-run with --yes:\n' >&2
  printf '    %s %s --yes\n' "$0" "$CHANNEL" >&2
  exit 2
fi

printf '→ restarting %s (port %s, %s active connection(s))\n' "$CHANNEL" "$PORT" "$CONNS"
"${RESTART[@]}"

# Give the unit a moment to bind, then health-check.
sleep 2
printf '→ recent journal:\n'
"${JOURNAL[@]}" || true

printf '→ healthz: '
if command -v curl >/dev/null 2>&1; then
  curl -sSf -o /dev/null -w '%{http_code}\n' "$HEALTH_URL" \
    || { printf '(health check failed)\n' >&2 ; exit 3 ; }
else
  printf '(curl not installed; skipping)\n'
fi
