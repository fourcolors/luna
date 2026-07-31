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
# Returns non-zero when the count cannot be established. This is load-bearing:
# an unavailable `ss`, an installed-but-FAILING `ss`, a stopped Incus instance,
# or a failed exec is UNKNOWN, never "zero sessions". Unattended callers must
# fail closed and defer; an operator can still use their explicit force lever.
# The count is now also consumed by the deploy engine's in-primitive session
# guard (scripts/luna-update-server restart_session_guard), where a false
# "zero sessions" would authorize a restart — so a present-but-failing ss
# pipeline must report UNKNOWN, never 0.
#
# Test seam: if LUNA_TEST_WS_COUNT is set, a decimal value is returned verbatim;
# the literal `unknown` simulates an unavailable probe. Empty/garbage values are
# rejected instead of silently becoming zero.
luna_active_ws_count() {
  local port="$1"
  local incus="${2:-}"
  local n

  if [[ "${LUNA_TEST_WS_COUNT+set}" == "set" ]]; then
    n="$LUNA_TEST_WS_COUNT"
    [[ "$n" =~ ^[0-9]+$ ]] || return 1
    printf '%s' "$n"
    return
  fi

  if [[ -n "$incus" ]]; then
    command -v incus >/dev/null 2>&1 || return 1
    local out
    out="$(incus exec "$incus" -- sh -c "command -v ss >/dev/null 2>&1 || exit 9; ss -tnH state established '( sport = :$port )' 2>/dev/null" 2>/dev/null)" || return 1
    if [[ -n "$out" ]]; then n="$(printf '%s\n' "$out" | wc -l)"; else n=0; fi
  else
    command -v ss >/dev/null 2>&1 || return 1
    local out
    out="$(ss -tnH state established "( sport = :$port )" 2>/dev/null)" || return 1
    if [[ -n "$out" ]]; then n="$(printf '%s\n' "$out" | wc -l)"; else n=0; fi
  fi
  n="$(printf '%s' "$n" | tr -d '[:space:]')"
  [[ "$n" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$n"
}

# Classify `systemctl is-active` output. Empty means the command never reached
# systemd (incus exec died, or systemctl is missing) — verified on this host
# that a *missing unit* still prints "inactive" with rc=4, so non-empty output
# is a sound proof of transport, and only empty output is INCONCLUSIVE.
#
# Every other state, transitional ones included, is an answer that was read
# successfully and says "not serving". Transitional states are precisely the
# shape a crash loop takes: the runtime unit is Type=notify/Restart=always with
# TimeoutStartSec+RestartSec ≈ 65s (scripts/luna-server-install), so a build
# that cannot send READY=1 reports `activating` for almost the whole cycle and
# `failed` only briefly. Classifying those as INCONCLUSIVE would mean a wedged
# server is essentially never counted as a strike. The bounded tolerance a
# legitimate restart needs comes from the caller's K-of-N debounce, not from
# pretending the state is unknowable.
luna_runtime_unit_state_class() {
  case "${1:-}" in
    active) return 0 ;;
    "") return 3 ;;
    *) return 1 ;;
  esac
}

# Prove that the declared runtime is serving the exact checkout HEAD in normal
# mode. This is the shared trust gate for deploy verification and control-plane
# migration: neither may adopt executable code merely because it exists in a
# mutable checkout.
#
# Signature: luna_runtime_matches_checkout <repo> <port> [incus] [service]
#
# Exit codes are TRI-STATE. Callers that only test zero/non-zero keep their old
# behaviour, because every non-zero code still means "not proven":
#   0  HEALTHY      — the server answered and the answer proves this HEAD.
#   1  NEGATIVE     — the server answered and the answer was WRONG (wrong or
#                     unidentifiable build, mode != normal, or the supervisor
#                     unit reported any state other than active).
#   3  INCONCLUSIVE — we got no usable answer (curl timeout, connection refused,
#                     incus exec failure, unreadable repo, empty or unparseable
#                     body). This means "we do not know" and on its own must
#                     never justify a repair.
# The distinction exists because scripts/luna-guardian escalates a NEGATIVE to
# `luna-autodeploy --repair`, which honours the engine's in-primitive session
# guard fail-closed and pages instead of dropping the operator.
#
# Test seam: LUNA_TEST_RUNTIME_MATCHES_CHECKOUT accepts "true" (0),
# "inconclusive"/"unknown" (3), and anything else including "false" (1).
luna_runtime_matches_checkout() {
  local repo="$1" port="$2" incus="${3:-}" service="${4:-luna-chat-server.service}"
  local expected active ready mode build rc=0

  if [[ "${LUNA_TEST_RUNTIME_MATCHES_CHECKOUT+set}" == "set" ]]; then
    case "$LUNA_TEST_RUNTIME_MATCHES_CHECKOUT" in
      true) return 0 ;;
      inconclusive|unknown) return 3 ;;
      *) return 1 ;;
    esac
  fi

  expected="$(git -C "$repo" rev-parse HEAD 2>/dev/null)" || return 3
  [[ -n "$expected" ]] || return 3
  if [[ -n "$incus" ]]; then
    command -v incus >/dev/null 2>&1 || return 3
    active="$(incus exec "$incus" -- systemctl is-active "$service" 2>/dev/null || true)"
    luna_runtime_unit_state_class "$active" || rc=$?
    (( rc == 0 )) || return "$rc"
    incus exec "$incus" -- curl -fsS --max-time 4 \
      "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 || return 3
    ready="$(incus exec "$incus" -- curl -fsS --max-time 4 \
      "http://127.0.0.1:$port/readyz" 2>/dev/null)" || return 3
  else
    active="$(systemctl is-active "$service" 2>/dev/null || true)"
    luna_runtime_unit_state_class "$active" || rc=$?
    (( rc == 0 )) || return "$rc"
    curl -fsS --max-time 4 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 || return 3
    ready="$(curl -fsS --max-time 4 "http://127.0.0.1:$port/readyz" 2>/dev/null)" || return 3
  fi
  [[ -n "$ready" ]] || return 3
  mode="$(printf '%s' "$ready" | sed -n 's/.*"mode":"\([^"]*\)".*/\1/p')"
  build="$(printf '%s' "$ready" | sed -n 's/.*"buildSha":"\([^"]*\)".*/\1/p')"
  # An unparseable body is not an answer; a parseable body that says the wrong
  # thing is. Note the buildSha capture is deliberately NOT restricted to hex:
  # chat-server resolves BUILD_SHA to the literal "unknown" when git metadata is
  # unavailable in the container, and a server that cannot identify its own
  # build is a wrong answer (NEGATIVE, repairable by a redeploy) rather than an
  # absent one — matching only hex here would silently classify it INCONCLUSIVE
  # forever and paralyse the guardian.
  [[ -n "$mode" && -n "$build" ]] || return 3
  [[ "$mode" == "normal" ]] || return 1
  [[ "$build" =~ ^[0-9a-fA-F]+$ ]] || return 1
  [[ "$expected" == "$build"* || "$build" == "$expected"* ]]
}

# Portable lowercase: bash 3.2 (macOS /bin/bash) rejects ${var,,} at expansion
# time with "bad substitution", killing the whole script under set -e. The
# hermetic test suite runs these scripts on dev Macs, so no bash-4isms.
luna_lc() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
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
