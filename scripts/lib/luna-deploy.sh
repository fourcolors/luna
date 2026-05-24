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

  local tmp
  tmp="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 { print key "=" value; replaced = 1; next }
    { print }
    END { if (replaced == 0) print key "=" value }
  ' "$env_file" > "$tmp"
  mv "$tmp" "$env_file"
  chmod 600 "$env_file"
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
