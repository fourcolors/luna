#!/usr/bin/env bash
# Luna — install script
# Usage: curl -fsSL https://raw.githubusercontent.com/fourcolors/luna/master/install.sh | bash
# Or:    bash install.sh
#
# What this does:
#   1. Checks prerequisites (macOS, Bun, git)
#   2. Clones or updates the Luna repo
#   3. Installs dependencies
#   4. Creates ~/.luna/ directory structure
#   5. Sets up a personal DNA.md
#   6. Installs the launchd daemon (background service)
#   7. Installs the web UI launch script
#   8. Prints next steps

set -euo pipefail

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${BLUE}→${RESET} $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET} $*"; }
error()   { echo -e "${RED}✗${RESET} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}$*${RESET}"; }

# ── config ────────────────────────────────────────────────────────────────────
LUNA_REPO="https://github.com/fourcolors/luna.git"
LUNA_DIR="${LUNA_DIR:-$HOME/Projects/luna}"
LUNA_DATA="$HOME/.luna"
LAUNCHD_LABEL="com.user.luna-web"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"

# ── checks ────────────────────────────────────────────────────────────────────
header "🌙 Luna Installer"
echo "  Repo:  $LUNA_DIR"
echo "  Data:  $LUNA_DATA"

# macOS only
[[ "$(uname)" == "Darwin" ]] || error "Luna requires macOS."

# Bun
if ! command -v bun &>/dev/null; then
  warn "Bun not found. Installing..."
  curl -fsSL https://bun.sh/install | bash
  # shellcheck disable=SC1090
  source "$HOME/.bun/env" 2>/dev/null || export PATH="$HOME/.bun/bin:$PATH"
fi
BUN_VERSION=$(bun --version)
success "Bun $BUN_VERSION"

# git
command -v git &>/dev/null || error "git is required. Install Xcode Command Line Tools: xcode-select --install"
success "git $(git --version | awk '{print $3}')"

# Anthropic API key
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  warn "ANTHROPIC_API_KEY not set."
  echo "  You'll need to set it before starting Luna:"
  echo "  export ANTHROPIC_API_KEY=sk-ant-..."
  echo "  Or add it to ~/.luna/.env"
fi

# ── clone / update ────────────────────────────────────────────────────────────
header "📦 Luna source"
if [[ -d "$LUNA_DIR/.git" ]]; then
  info "Updating existing repo at $LUNA_DIR..."
  git -C "$LUNA_DIR" pull --ff-only
  success "Updated"
else
  info "Cloning $LUNA_REPO → $LUNA_DIR"
  mkdir -p "$(dirname "$LUNA_DIR")"
  git clone "$LUNA_REPO" "$LUNA_DIR"
  success "Cloned"
fi

# ── dependencies ──────────────────────────────────────────────────────────────
header "📦 Dependencies"
info "Running bun install..."
bun install --cwd "$LUNA_DIR" --frozen-lockfile
success "Dependencies installed"

# ── directory structure ───────────────────────────────────────────────────────
header "📁 ~/.luna/ structure"
dirs=(
  "$LUNA_DATA/workspace"
  "$LUNA_DATA/scratch"
  "$LUNA_DATA/state"
  "$LUNA_DATA/logs"
  "$LUNA_DATA/run"
  "$LUNA_DATA/backups"
)
for d in "${dirs[@]}"; do
  mkdir -p "$d"
  success "$d"
done

# ── .env ─────────────────────────────────────────────────────────────────────
if [[ ! -f "$LUNA_DATA/.env" ]]; then
  info "Creating $LUNA_DATA/.env..."
  cat > "$LUNA_DATA/.env" <<EOF
# Luna environment
# Add your Anthropic API key here if not set in your shell profile
# ANTHROPIC_API_KEY=sk-ant-...
EOF
  success ".env created (edit to add your API key)"
else
  success ".env already exists"
fi

# ── personal DNA.md ───────────────────────────────────────────────────────────
header "🧬 Identity (DNA.md)"
if [[ ! -f "$LUNA_DATA/DNA.md" ]]; then
  info "Creating personal DNA.md at $LUNA_DATA/DNA.md"
  cp "$LUNA_DIR/DNA.md" "$LUNA_DATA/DNA.md"

  # Prompt for personalisation
  echo ""
  echo "  Luna's identity file has been copied to $LUNA_DATA/DNA.md"
  echo "  You can personalise it — add your name, handles, preferences."
  echo "  Luna will use this file instead of the repo default."
  echo ""
  read -rp "  Enter your name (or press Enter to skip): " USER_NAME
  if [[ -n "$USER_NAME" ]]; then
    # Append user section
    cat >> "$LUNA_DATA/DNA.md" <<EOF

## User

- **${USER_NAME}**
- Repo: \`~/Projects/luna/\`. User data: \`~/.luna/\`.
- Communication style: friendly, practical, markdown with structure.
EOF
    success "DNA.md personalised for $USER_NAME"
  else
    success "DNA.md copied (edit ~/.luna/DNA.md to personalise)"
  fi
else
  success "DNA.md already exists at $LUNA_DATA/DNA.md"
fi

# ── build ─────────────────────────────────────────────────────────────────────
header "🔨 Build"
info "Type-checking..."
if bun run --cwd "$LUNA_DIR" typecheck 2>/dev/null; then
  success "Typecheck passed"
else
  warn "Typecheck had warnings — Luna may still run fine"
fi

# ── launchd daemon (web UI) ───────────────────────────────────────────────────
header "🚀 launchd service"
LOG_OUT="$LUNA_DATA/logs/luna-web.log"
LOG_ERR="$LUNA_DATA/logs/luna-web-error.log"

cat > "$LAUNCHD_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v bun)</string>
    <string>run</string>
    <string>--filter</string>
    <string>@luna/ui-web</string>
    <string>dev:server:chat</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${LUNA_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:$(dirname "$(command -v bun)")</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_OUT}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_ERR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
EOF
success "Plist written to $LAUNCHD_PLIST"

# Load (or reload) the service
if launchctl list | grep -q "$LAUNCHD_LABEL" 2>/dev/null; then
  info "Reloading existing service..."
  launchctl unload "$LAUNCHD_PLIST" 2>/dev/null || true
fi
launchctl load "$LAUNCHD_PLIST"
success "Service loaded: $LAUNCHD_LABEL"

# ── web UI launch script ──────────────────────────────────────────────────────
header "🖥  Web UI"
LUNA_OPEN="$HOME/.local/bin/luna"
mkdir -p "$(dirname "$LUNA_OPEN")"
cat > "$LUNA_OPEN" <<'SCRIPT'
#!/usr/bin/env bash
# Open Luna web UI in the default browser
open http://localhost:5174
SCRIPT
chmod +x "$LUNA_OPEN"
success "luna command installed at $LUNA_OPEN"
echo "  Run 'luna' to open the web UI (once the backend starts)"

# ── done ─────────────────────────────────────────────────────────────────────
header "✅ Installation complete"
echo ""
echo -e "  ${BOLD}Luna is now running as a background service.${RESET}"
echo ""
echo "  Next steps:"
echo "    1. Set your API key in ~/.luna/.env or export ANTHROPIC_API_KEY=..."
echo "    2. Restart the service: launchctl kickstart -k gui/\$(id -u)/${LAUNCHD_LABEL}"
echo "    3. Open the UI:         luna"
echo "    4. Personalise:         edit ~/.luna/DNA.md"
echo ""
echo "  Logs: $LOG_OUT"
echo "  Data: $LUNA_DATA"
echo ""
echo -e "  ${GREEN}🌙 Luna installed successfully.${RESET}"
