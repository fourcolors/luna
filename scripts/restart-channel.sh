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

# Post-stop settle (deploy-reliability; mirrors scripts/luna-update-server's
# RESTART_SETTLE_SECS). We restart the unit as a CLEAN stop -> settle -> start,
# NOT a fast `systemctl restart`: a fast restart can start the new chat-server
# before the outgoing one releases its DuckDB/SQLite WAL/SHM handles, crashing
# the boot with "unable to open database file" (SQLITE_CANTOPEN) — the 2026-06-08
# stable-deploy incident. The settle covers that lagging handle release. Override
# with LUNA_RESTART_SETTLE_SECS (0 disables the wait; the hermetic test sets 0).
RESTART_SETTLE_SECS="${LUNA_RESTART_SETTLE_SECS:-6}"

# Build the stop/start as separate command arrays (NOT one `restart`) so we can
# wait between them. Each array is always non-empty, so "${STOP[@]}" / "${START[@]}"
# are safe under `set -u` (no empty-array expansion gotcha).
case "$CHANNEL" in
  dev)
    PORT=5753
    STOP=(incus exec luna-dev -- systemctl stop luna-dev-chat-server.service)
    START=(incus exec luna-dev -- systemctl start luna-dev-chat-server.service)
    JOURNAL=(incus exec luna-dev -- journalctl -u luna-dev-chat-server.service --no-pager -n 20)
    HEALTH_URL="http://127.0.0.1:5753/healthz"
    ;;
  stable)
    # Stable is the production HOST service (no container indirection): the
    # chat-server runs on the host itself and is restarted with a bare
    # `systemctl ... luna-chat-server.service`. This matches the live topology
    # (see .workspace/workspace.md "Stable ... on the host") and the rollback
    # `case` in docs/container-runtime.md.
    #
    # PORT is the stable WebSocket port — the SAME port operators connect their
    # chat sessions to AND where /healthz is served (mirroring the dev branch,
    # which uses 5753, its WS port — NOT a control port). Both jobs below need
    # this port:
    #   1. the connection-guard counts ESTABLISHED sessions here to refuse a
    #      restart that would kill the operator's live chat (issue #24);
    #   2. the post-restart health probe verifies the stable chat-server.
    # It must therefore be 4753, the stable WS port — NOT 5754, which is dev's
    # *control* port (host 5754 -> luna-dev:4754; see the port tables in
    # docs/install.md / docs/container-runtime.md). The old 5754 left the guard
    # watching a port with no stable sessions (so it never refused) and health-
    # checked dev's control server instead of the stable chat-server.
    #
    # NOTE on the future container cutover: the `luna-stable` candidate container
    # is reachable on host port 6753 (-> luna-stable:4753) during its
    # verification window. Cutting stable over to that container is NOT a bare
    # port swap here — it would also require routing STOP/START through
    # `incus exec luna-stable -- systemctl ...` (like the dev branch does for
    # luna-dev). Until that cutover lands, stable is the host service on 4753;
    # post-cutover the operator-facing stable WS port is still 4753 (the proxy
    # moves to the container), so this guard/health port stays correct either way.
    PORT=4753
    STOP=(systemctl stop luna-chat-server.service)
    START=(systemctl start luna-chat-server.service)
    JOURNAL=(journalctl -u luna-chat-server.service --no-pager -n 20)
    HEALTH_URL="http://127.0.0.1:4753/healthz"
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
# Restart as a CLEAN stop -> settle -> start (see RESTART_SETTLE_SECS above), not
# a fast `systemctl restart`. `systemctl stop` is synchronous (it returns once the
# unit is torn down), so the process is gone; the settle then covers the lagging
# WAL/SHM handle release before start reopens the DBs. The settle is a HOST-side
# wall-clock wait: even on the dev channel (which runs `incus exec`), the DB files
# are bind-mounted from the host, so what matters is the elapsed real time, not
# where `sleep` runs — and a host-side sleep avoids an extra `incus exec` round-trip.
#
# `|| true` on stop: under `set -e` a non-zero stop (e.g. it times out, or the
# unit is already stopped on some systemd versions) would otherwise abort the
# script BEFORE start and leave the service DOWN — a failure mode the atomic
# `systemctl restart` did not have. Proceeding to start regardless makes this
# STRICTLY more robust than the old restart (start is idempotent: a no-op if the
# unit is already active) and matches the recovery path's `;`-sequence semantics.
# The stop's stderr still surfaces, and the post-start health check below is the
# real verdict.
"${STOP[@]}" || true
if [ "$RESTART_SETTLE_SECS" != "0" ]; then
  # Validate BEFORE sleeping. A bare `sleep "$bad" || true` would swallow an
  # invalid/negative/empty value and skip the settle SILENTLY — reintroducing the
  # WAL/SHM race the operator believes they configured away, with no signal. So
  # reject anything that is not a non-negative number of seconds and WARN loudly,
  # but still proceed to start (a bad knob must never leave the service down).
  # Mirrors scripts/luna-update-server's settle_after_stop validation.
  if [[ "$RESTART_SETTLE_SECS" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    printf '→ settling %ss after stop so DuckDB/SQLite release WAL/SHM before start\n' "$RESTART_SETTLE_SECS"
    # Belt-and-suspenders: if sleep STILL fails, warn (do not swallow silently)
    # but proceed to start anyway.
    if ! sleep "$RESTART_SETTLE_SECS"; then
      printf 'warn: post-stop settle sleep failed (LUNA_RESTART_SETTLE_SECS=%s); starting WITHOUT a settle — the WAL/SHM race may recur.\n' "$RESTART_SETTLE_SECS" >&2
    fi
  else
    printf 'warn: LUNA_RESTART_SETTLE_SECS=%s is not a non-negative number of seconds; SKIPPING the post-stop settle — the WAL/SHM race may recur. Set it to a valid value (e.g. 6).\n' "$RESTART_SETTLE_SECS" >&2
  fi
fi
"${START[@]}"

# Give the unit a moment to bind, then health-check. (This is the start->health
# gap, distinct from the stop->start settle above — keep it.)
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
