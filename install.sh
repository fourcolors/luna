#!/usr/bin/env bash
# Luna client installer.
#
# Installs the monorepo locally and places a `luna` wrapper on PATH. This is
# intentionally client-focused: server/systemd and Incus setup live in scripts/.

set -euo pipefail

LUNA_REPO="${LUNA_REPO:-https://github.com/fourcolors/luna.git}"
LUNA_DIR="${LUNA_DIR:-$HOME/Projects/luna}"
LUNA_DATA="${LUNA_DATA:-$HOME/.luna}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
STABLE_WS_URL="${LUNA_STABLE_WS_URL:-ws://jax-box.local:4753/ui}"
DEV_WS_URL="${LUNA_DEV_WS_URL:-ws://jax-box.local:5753/ui}"
STABLE_TOKEN="${LUNA_STABLE_UI_WS_TOKEN:-}"
DEV_TOKEN="${LUNA_DEV_UI_WS_TOKEN:-}"
DRY_RUN=false
SKIP_DEPS=false

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --dry-run                 Print the install plan without changing files.
  --repo <url>              Git repository URL. Default: https://github.com/fourcolors/luna.git
  --luna-dir <path>         Local clone path. Default: ~/Projects/luna
  --data-dir <path>         Luna config/state path. Default: ~/.luna
  --bin-dir <path>          Directory for the luna wrapper. Default: ~/.local/bin
  --stable-url <ws-url>     Stable Luna WebSocket URL. Default: ws://jax-box.local:4753/ui
  --stable-token <token>    Stable UI WebSocket token to write to ~/.luna/.env.
  --dev-url <ws-url>        Dev Luna WebSocket URL. Default: ws://jax-box.local:5753/ui
  --dev-token <token>       Dev UI WebSocket token to write to ~/.luna/.env.
  --skip-deps               Skip bun install.
  -h, --help                Show this help.

The installer never reads or writes Claude OAuth tokens. Server tokens are only
written when explicitly provided.
EOF
}

info() { printf '%s\n' "-> $*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

redact_if_secret() {
  case "$1" in
    *TOKEN*|*token*|*SECRET*|*secret*) printf '<redacted>' ;;
    *) printf '%s' "$2" ;;
  esac
}

print_assignment() {
  local key="$1"
  local value="$2"
  printf '%s=' "$key"
  redact_if_secret "$key" "$value"
  printf '\n'
}

run() {
  if [[ "$DRY_RUN" == true ]]; then
    printf '+'
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf '\n'
  else
    "$@"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --repo) LUNA_REPO="${2:?missing --repo value}"; shift 2 ;;
    --luna-dir) LUNA_DIR="${2:?missing --luna-dir value}"; shift 2 ;;
    --data-dir|--luna-home) LUNA_DATA="${2:?missing --data-dir value}"; shift 2 ;;
    --bin-dir) BIN_DIR="${2:?missing --bin-dir value}"; shift 2 ;;
    --stable-url) STABLE_WS_URL="${2:?missing --stable-url value}"; shift 2 ;;
    --stable-token) STABLE_TOKEN="${2:?missing --stable-token value}"; shift 2 ;;
    --dev-url) DEV_WS_URL="${2:?missing --dev-url value}"; shift 2 ;;
    --dev-token) DEV_TOKEN="${2:?missing --dev-token value}"; shift 2 ;;
    --skip-deps) SKIP_DEPS=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

if [[ "$DRY_RUN" == true ]]; then
  BUN_BIN="${LUNA_TEST_BUN_PATH:-bun}"
else
  command -v git >/dev/null 2>&1 || die "git is required"
  if ! command -v bun >/dev/null 2>&1; then
    warn "Bun not found; installing with https://bun.sh/install"
    run bash -c 'curl -fsSL https://bun.sh/install | bash'
    export PATH="$HOME/.bun/bin:$PATH"
  fi
  BUN_BIN="$(command -v bun)"
fi

info "Luna client install"
printf 'Repo: %s\n' "$LUNA_REPO"
printf 'Clone: %s\n' "$LUNA_DIR"
printf 'Config: %s\n' "$LUNA_DATA"
printf 'Binary: %s/luna\n' "$BIN_DIR"

if [[ -d "$LUNA_DIR/.git" ]]; then
  run git -C "$LUNA_DIR" pull --ff-only
else
  run mkdir -p "$(dirname "$LUNA_DIR")"
  run git clone "$LUNA_REPO" "$LUNA_DIR"
fi

if [[ "$SKIP_DEPS" == false ]]; then
  run "$BUN_BIN" install --cwd "$LUNA_DIR" --frozen-lockfile
fi

ENV_FILE="$LUNA_DATA/.env"
WRAPPER="$BIN_DIR/luna"

upsert_env() {
  local key="$1"
  local value="$2"
  [[ -n "$value" ]] || return 0
  if [[ "$DRY_RUN" == true ]]; then
    print_assignment "$key" "$value"
    return 0
  fi
  mkdir -p "$LUNA_DATA"
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  local tmp
  tmp="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 { print key "=" value; replaced = 1; next }
    { print }
    END { if (replaced == 0) print key "=" value }
  ' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

run mkdir -p "$LUNA_DATA" "$LUNA_DATA/logs" "$LUNA_DATA/run" "$BIN_DIR"
upsert_env "LUNA_STABLE_WS_URL" "$STABLE_WS_URL"
upsert_env "LUNA_DEV_WS_URL" "$DEV_WS_URL"
upsert_env "LUNA_STABLE_UI_WS_TOKEN" "$STABLE_TOKEN"
upsert_env "LUNA_DEV_UI_WS_TOKEN" "$DEV_TOKEN"

write_wrapper() {
  if [[ "$DRY_RUN" == true ]]; then
    printf 'Would write %s:\n' "$WRAPPER"
    cat <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$BUN_BIN" run --cwd "$LUNA_DIR" --filter '@luna/agent-cli' luna -- "\$@"
EOF
    return 0
  fi
  cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$BUN_BIN" run --cwd "$LUNA_DIR" --filter '@luna/agent-cli' luna -- "\$@"
EOF
  chmod +x "$WRAPPER"
}

write_wrapper

info "Installed luna client wrapper"
printf 'Try: luna chat\n'
printf 'Dev: luna chat --dev\n'

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  warn "$BIN_DIR is not on PATH"
fi
