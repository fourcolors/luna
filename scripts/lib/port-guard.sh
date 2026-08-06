#!/usr/bin/env bash
# port-guard.sh — free a local port for the desktop install, safely.
#
# Sourced by install-mac.command. Defines functions only (no auto-run), so it is
# safe to `source` into a `set -euo pipefail` script and to exercise in tests.
#
# Why this exists (finding #7): the old inline `check_port` ran
#   kill -9 "$pid"
# on whatever process held the port. That is dangerous on two counts:
#   1. It never checks WHAT it is killing. On a machine that reaches a remote
#      Luna over Tailscale, the Tailscale daemon binds :4753 on the tailnet
#      address — so the installer would offer to SIGKILL Tailscale. The Vite UI
#      port (5174) collides with unrelated dev servers too.
#   2. SIGKILL is wrong even for a genuine stale Luna server: it cannot be
#      trapped, so it bypasses chat-server.ts's SIGTERM handler (installShutdown)
#      → runtime.dispose() / db.close() never runs → the vectorlite HNSW sidecar
#      (memory.db.hnsw.bin) is not serialized → the next boot pays a full
#      backfill.
#
# Policy (identity-checked + graceful): only stop a process we can positively
# tie to THIS install ($luna_dir), and stop it with SIGTERM first, escalating to
# SIGKILL only if it refuses to exit. Anything foreign → refuse and explain.

# port_guard_is_luna_cmd "<command>" "<luna_dir>"
# Pure predicate. Returns 0 (true) ONLY when <command> clearly belongs to this
# Luna install. Safety-biased: when unsure, returns 1 (foreign → do not touch).
port_guard_is_luna_cmd() {
  local cmd="$1"
  local luna_dir="${2:-}"
  # Must reference THIS install dir — a foreign process (Tailscale, another app,
  # or a different Luna checkout) won't be running out of the user's install path.
  [[ -n "$luna_dir" && "$cmd" == *"$luna_dir"* ]] || return 1
  # …and be our known server entrypoint (see install-mac.command): the
  # chat-server daemon for :4753 - `*chat-server*` covers both the
  # path-independent launcher (scripts/luna-chat-server-entry.ts) and the
  # transitional `scripts/chat-server.ts` direct-run shape, so this predicate
  # does not go stale the moment the launcher lands.
  case "$cmd" in
    *chat-server*) return 0 ;;
    *) return 1 ;;
  esac
}

# Diagnostics to stderr. install-mac.command has its own colored info()/warn();
# these plain helpers keep the lib self-contained and testable on its own.
port_guard_warn() { printf 'port-guard: %s\n' "$*" >&2; }
port_guard_info() { printf 'port-guard: %s\n' "$*" >&2; }

# port_guard_conflicting_pid <port>
# PID of a LISTEN whose bind address would block a fresh LOCAL bind: loopback
# (127.0.0.1 / [::1]) or wildcard (* / 0.0.0.0 / [::]). A listener on a specific
# non-loopback address (e.g. a Tailscale tailnet IP) does NOT conflict — our
# server binds loopback (chat-server) or wildcard (vite), and those never collide
# with a tailnet-address bind. Prints the first conflicting PID, or nothing.
#
# Why classify the address instead of filtering with lsof's `@host`: `@host`
# cannot express "loopback-or-wildcard but not a specific address". `@127.0.0.1`
# misses a `*:port` (vite) bind; `@0.0.0.0` matches ANY address (re-catching
# Tailscale). So we read the bind address out of the listing ($9, NAME=addr:port)
# and decide per row. macOS lsof NAME examples: `*:5174` and `127.0.0.1:4753`
# conflict; `100.x.y.z:4753` / `[fd7a:115c:...]:4753` (Tailscale)
# do not. Scans every row — a leading tailnet row must not hide a later loopback.
port_guard_conflicting_pid() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk '
    NR > 1 { a=$9; sub(/:[0-9]+$/, "", a)
      if (a=="127.0.0.1"||a=="[::1]"||a=="*"||a=="0.0.0.0"||a=="[::]") { print $2; exit } }'
}

# port_guard_port_free <port>
# True when nothing that would block our own bind is LISTENing on <port> — i.e.
# no loopback/wildcard listener (see port_guard_conflicting_pid). A tailnet-only
# listener (Tailscale serving the port on a tailnet address) does NOT count: it
# never collides with our bind. Probes the PORT (not `kill -0 <pid>`) so liveness
# checking and signalling stay independent.
port_guard_port_free() {
  [[ -z "$(port_guard_conflicting_pid "$1" || true)" ]]
}

# port_guard_stop_pid <pid> <port>
# Graceful stop: SIGTERM, then wait up to LUNA_PORT_GUARD_TIMEOUT seconds
# (re-checking the port), escalating to SIGKILL only if it refuses to exit.
# SIGTERM lets chat-server.ts run its shutdown (db.close → HNSW sidecar). Returns
# non-zero if the port is still held. Failed signals are surfaced, not swallowed.
port_guard_stop_pid() {
  local pid="$1" port="$2"
  # Default 10s (override: LUNA_PORT_GUARD_TIMEOUT). Generous on purpose — the
  # point of SIGTERM-first is to let chat-server.ts finish db.close() → vectorlite
  # HNSW sidecar serialization; too short an escalation would SIGKILL mid-shutdown
  # and force the full backfill next boot (exactly the cost we are avoiding).
  local timeout="${LUNA_PORT_GUARD_TIMEOUT:-10}"

  if ! kill -TERM "$pid" 2>/dev/null; then
    port_guard_warn "Could not send SIGTERM to PID $pid (already gone?)."
  fi

  local waited=0
  while (( waited < timeout )); do
    port_guard_port_free "$port" && return 0
    sleep 1
    waited=$(( waited + 1 ))
  done

  port_guard_warn "PID $pid did not exit after ${timeout}s; escalating to SIGKILL."
  if ! kill -KILL "$pid" 2>/dev/null; then
    port_guard_warn "SIGKILL to PID $pid failed."
  fi
  sleep 1
  port_guard_port_free "$port" && return 0
  port_guard_warn "Port $port is still in use after SIGKILL."
  return 1
}

# ensure_port_free <port> <name> <luna_dir>
# Make <port> available for our own server to bind. Returns 0 when the port is
# free (or a stale Luna instance was stopped). Returns non-zero — the caller
# should abort — when a foreign process holds it, the user declines to stop a
# stale Luna, or the stop fails.
ensure_port_free() {
  local port="$1" name="$2" luna_dir="$3"

  # Only a listener that would actually block our own bind counts: a loopback
  # (chat-server → 127.0.0.1) or wildcard (vite → *) bind. A listener on a
  # *different* address — e.g. Tailscale serving :"$port" on a tailnet address —
  # does NOT conflict and must not trip the guard (which would otherwise refuse
  # the install). port_guard_conflicting_pid does that address classification.
  local pid
  pid="$(port_guard_conflicting_pid "$port" || true)"
  [[ -n "$pid" ]] || return 0 # nothing conflicting on the port — free for our bind

  local cmd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"

  if ! port_guard_is_luna_cmd "$cmd" "$luna_dir"; then
    port_guard_warn "Port $port ($name) is held by another process (PID $pid):"
    port_guard_warn "    ${cmd:-<unknown command>}"
    port_guard_warn "Luna will not stop a process it did not start. Free the port"
    port_guard_warn "(quit that app, or stop the service) and run the installer again."
    return 1
  fi

  port_guard_info "Port $port ($name) is held by a previous Luna instance (PID $pid)."
  printf 'Stop it and continue? [y/N]: '
  local ans=""
  read -r ans || true
  if [[ ! "$ans" =~ ^[Yy]$ ]]; then
    port_guard_warn "Left the existing process running; cannot continue on port $port."
    return 1
  fi

  port_guard_stop_pid "$pid" "$port"
}
