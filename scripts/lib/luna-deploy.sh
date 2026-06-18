#!/usr/bin/env bash
# Shared helpers for repo-local Luna deployment scripts.

luna_info() { printf '%s\n' "-> $*"; }
luna_warn() { printf 'warning: %s\n' "$*" >&2; }
luna_die() { printf 'error: %s\n' "$*" >&2; exit 1; }

luna_run() {
  if [[ "${DRY_RUN:-false}" == true ]]; then
    printf '+'
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf '\n'
  else
    "$@"
  fi
}

luna_redact_if_secret() {
  case "$1" in
    *TOKEN*|*token*|*SECRET*|*secret*) printf '<redacted>' ;;
    *) printf '%s' "$2" ;;
  esac
}

luna_print_assignment() {
  local key="$1"
  local value="$2"
  printf '%s=' "$key"
  luna_redact_if_secret "$key" "$value"
  printf '\n'
}

luna_upsert_env() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  [[ -n "$value" ]] || return 0

  if [[ "${DRY_RUN:-false}" == true ]]; then
    luna_print_assignment "$key" "$value"
    return 0
  fi

  mkdir -p "$(dirname "$env_file")"
  touch "$env_file"
  chmod 600 "$env_file"

  # Create the temp file beside the target so the rename below is an atomic,
  # same-filesystem operation. A system `mktemp` (e.g. /tmp) can be on a
  # different filesystem, turning `mv` into a non-atomic copy-then-delete that
  # can lose the .env entirely if the process is killed mid-write.
  local tmp
  tmp="$(mktemp "$env_file.XXXXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 { print key "=" value; replaced = 1; next }
    { print }
    END { if (replaced == 0) print key "=" value }
  ' "$env_file" > "$tmp"
  mv "$tmp" "$env_file"
  chmod 600 "$env_file"
}

luna_remove_env() {
  local env_file="$1"
  local key="$2"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    printf 'unset %s\n' "$key"
    return 0
  fi

  [[ -f "$env_file" ]] || return 0

  # Temp file beside the target → atomic same-filesystem rename (see luna_upsert_env).
  local tmp
  tmp="$(mktemp "$env_file.XXXXXXXX")"
  awk -v key="$key" '
    index($0, key "=") == 1 { next }
    { print }
  ' "$env_file" > "$tmp"
  mv "$tmp" "$env_file"
  chmod 600 "$env_file"
}

luna_env_value() {
  local env_file="$1"
  local key="$2"
  [[ -f "$env_file" ]] || return 1

  awk -F= -v key="$key" '
    $1 == key {
      print substr($0, length(key) + 2)
      found = 1
      exit
    }
    END { exit found ? 0 : 1 }
  ' "$env_file"
}

luna_find_claude_executable() {
  local repo_dir="$1"
  local candidate

  if command -v claude >/dev/null 2>&1; then
    command -v claude
    return 0
  fi

  [[ -d "$repo_dir/node_modules" ]] || return 1
  candidate="$(
    find "$repo_dir/node_modules" \
      -path '*/@anthropic-ai/claude-agent-sdk-linux-x64/claude' \
      -type f -perm -111 2>/dev/null |
      sort |
      tail -n 1
  )"
  [[ -n "$candidate" ]] || return 1
  printf '%s\n' "$candidate"
}

luna_configure_claude_executable() {
  local env_file="$1"
  local repo_dir="$2"
  local value
  value="$(luna_env_value "$env_file" LUNA_CLAUDE_CODE_EXECUTABLE || true)"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    return 0
  fi

  if [[ -n "$value" && -x "$value" ]]; then
    return 0
  fi

  if [[ -n "$value" ]]; then
    luna_warn "removing stale LUNA_CLAUDE_CODE_EXECUTABLE ($value is not executable)"
    luna_remove_env "$env_file" "LUNA_CLAUDE_CODE_EXECUTABLE"
  fi

  local detected
  detected="$(luna_find_claude_executable "$repo_dir" || true)"
  if [[ -n "$detected" ]]; then
    luna_upsert_env "$env_file" "LUNA_CLAUDE_CODE_EXECUTABLE" "$detected"
  fi
}

luna_env_has_nonempty_key() {
  local env_file="$1"
  shift
  [[ -f "$env_file" ]] || return 1

  local key
  for key in "$@"; do
    if awk -F= -v key="$key" '
      $1 == key {
        value = substr($0, length(key) + 2)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        if (value != "") found = 1
      }
      END { exit found ? 0 : 1 }
    ' "$env_file"; then
      return 0
    fi
  done
  return 1
}

# True if the server's UI WebSocket secret is present in the given .env.
# UI_WS_TOKEN is the canonical name; LUNA_UI_WS_TOKEN is a back-compat alias.
# Accept BOTH — never drop a name, so older on-disk .env files still pass (#6).
luna_env_has_token() {
  luna_env_has_nonempty_key "$1" UI_WS_TOKEN LUNA_UI_WS_TOKEN
}

luna_profile_env_name() {
  printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | sed 's/[^A-Z0-9]/_/g'
}

luna_validate_profile() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] ||
    luna_die "profile must contain only letters, numbers, dot, underscore, or dash"
}

luna_service_name() {
  if [[ "$1" == "stable" ]]; then
    printf 'luna-chat-server.service\n'
  else
    printf 'luna-%s-chat-server.service\n' "$1"
  fi
}

luna_chat_server_name() {
  local service_name
  service_name="$(luna_service_name "$1")"
  printf '%s\n' "${service_name%.service}"
}

# Resolve a safe default bind/listen address for a remote-serving install when
# the operator did NOT choose one explicitly. Returns the host's Tailscale IPv4
# if a tailnet is present (the normal remote-serving case: reachable by tailnet
# peers over an encrypted link, never exposed on the public wire), else loopback
# 127.0.0.1 with a warning that the server will be local-only. Explicit
# env/flag/--i-understand-public always win in the caller; this only fills the
# unset default. The IP is printed to stdout; any warning goes to stderr
# (luna_warn), so `addr="$(luna_resolve_bind_addr)"` captures only the address.
#
# Why auto-detect: the primary Luna deployment is "server on a Linux box, reached
# from the Mac over Tailscale." A loopback-only default would make that documented
# path bind 127.0.0.1 and refuse every tailnet peer — a fresh remote install dead
# out of the box. Binding the tailnet interface makes the primary case Just Work
# while staying off any public interface.
#
# Test seam: if LUNA_TAILSCALE_IP is set (even to empty), its value is used
# verbatim instead of shelling out to `tailscale` — lets tests pin the outcome
# deterministically (same pattern as LUNA_TEST_BUN_PATH below). An empty value
# forces the loopback fallback; a tailnet IP exercises the detected path.
luna_resolve_bind_addr() {
  local ts=""
  if [[ "${LUNA_TAILSCALE_IP+set}" == "set" ]]; then
    ts="$LUNA_TAILSCALE_IP"
  elif command -v tailscale >/dev/null 2>&1; then
    ts="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  fi
  if [[ -n "$ts" ]]; then
    printf '%s' "$ts"
    return 0
  fi
  luna_warn "no Tailscale interface detected — binding to loopback (127.0.0.1); the server will be reachable only from this machine. To serve remote clients, bring Tailscale up and re-run, pass an explicit address (--bind-host/--listen-addr <tailnet-ip>), or pass --i-understand-public for an (unsafe) public 0.0.0.0 bind."
  printf '127.0.0.1'
}

# Count ESTABLISHED TCP connections on a given server port, optionally through
# an Incus container boundary.
#
# Why a shared helper: both luna-autodeploy (systemd poll-deploy) and the
# forthcoming `luna update` CLI (Slice 4) need the same connect-aware deferral
# logic — "don't restart the server while the operator is mid-conversation."
# Centralising here means one implementation to audit and one set of tests.
#
# Signature: luna_active_ws_count <port> [incus_container]
#   <port>             — the server's WebSocket listen port (e.g. 4753)
#   [incus_container]  — when non-empty, run ss(8) INSIDE the named Incus
#                        instance. Dev terminates connections inside the container
#                        (the host-side incusd proxy is transparent to ss), so
#                        checking the host would always return 0 and defeat the
#                        deferral guard.
#
# Test seam: if LUNA_TEST_WS_COUNT is set (even to empty), its value is used
# verbatim instead of shelling out to ss(8). CI environments have no established
# sockets, so without the seam every test assertion would be comparing against
# a live (and unpredictable) socket count. This mirrors the LUNA_TAILSCALE_IP /
# LUNA_TEST_BUN_PATH seams already in this file: set the variable to pin the
# outcome; leave it unset for production behavior.
luna_active_ws_count() {
  local port="$1"
  local incus="${2:-}"
  local n

  if [[ "${LUNA_TEST_WS_COUNT+set}" == "set" ]]; then
    n="$LUNA_TEST_WS_COUNT"
    n="$(printf '%s' "$n" | tr -dc '0-9')"
    printf '%s' "${n:-0}"
    return 0
  fi

  if [[ -n "$incus" ]]; then
    n="$(incus exec "$incus" -- sh -c "ss -tnH state established '( sport = :$port )' 2>/dev/null | wc -l" 2>/dev/null || echo 0)"
  else
    n="$(ss -tnH state established "( sport = :$port )" 2>/dev/null | wc -l || echo 0)"
  fi
  n="$(printf '%s' "$n" | tr -dc '0-9')"
  printf '%s' "${n:-0}"
}

luna_find_bun() {
  if [[ -n "${LUNA_TEST_BUN_PATH:-}" ]]; then
    printf '%s\n' "$LUNA_TEST_BUN_PATH"
    return 0
  fi
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  if [[ -x "$HOME/.bun/bin/bun" ]]; then
    printf '%s\n' "$HOME/.bun/bin/bun"
    return 0
  fi
  printf '%s\n' "$HOME/.bun/bin/bun"
}
