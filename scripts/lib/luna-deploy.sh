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

luna_remove_env() {
  local env_file="$1"
  local key="$2"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    printf 'unset %s\n' "$key"
    return 0
  fi

  [[ -f "$env_file" ]] || return 0

  local tmp
  tmp="$(mktemp)"
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
