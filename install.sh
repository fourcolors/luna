#!/usr/bin/env bash
# Luna — install script
# Usage: curl -fsSL https://raw.githubusercontent.com/example-org/luna/master/install.sh | bash
# Or:    bash install.sh
#
# What this does:
#   1. Checks prerequisites (macOS, Bun, git, Claude Code)
#   2. Detects or sets up Claude Code authentication
#   3. Clones or updates the Luna repo
#   4. Installs dependencies
#   5. Creates ~/.luna/ directory structure
#   6. Sets up a personal DNA.md
#   7. Registers a Luna account using your Claude Code session
#   8. Installs the launchd daemon (background service)
#   9. Installs the luna CLI shortcut
#  10. Prints next steps

set -euo pipefail

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${BLUE}→${RESET} $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET} $*"; }
error()   { echo -e "${RED}✗${RESET} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}$*${RESET}"; }

# ── banner ────────────────────────────────────────────────────────────────────
echo ""
echo "    ██╗     ██╗   ██╗███╗   ██╗ █████╗ "
echo "    ██║     ██║   ██║████╗  ██║██╔══██╗"
echo "    ██║     ██║   ██║██╔██╗ ██║███████║"
echo "    ██║     ██║   ██║██║╚██╗██║██╔══██║"
echo "    ███████╗╚██████╔╝██║ ╚████║██║  ██║"
echo "    ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝"
echo "    installer"
echo ""

# ── config ────────────────────────────────────────────────────────────────────
LUNA_REPO="https://github.com/example-org/luna.git"
LUNA_DIR="${LUNA_DIR:-$HOME/Projects/luna}"
LUNA_DATA="$HOME/.luna"
LAUNCHD_LABEL="com.user.luna-web"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"

header "Prerequisites"
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
success "Bun $(bun --version)"

# git
command -v git &>/dev/null || error "git is required. Install Xcode Command Line Tools: xcode-select --install"
success "git $(git --version | awk '{print $3}')"

# ── Claude Code authentication ────────────────────────────────────────────────
header "🔑 Claude Code authentication"

# Check if claude CLI is installed
if ! command -v claude &>/dev/null; then
  echo ""
  echo "  Claude Code is not installed."
  echo "  Luna runs on your Claude.ai subscription via the Claude Code Agent SDK."
  echo ""
  echo "  Install Claude Code from: https://claude.ai/code"
  echo "  Then re-run this installer."
  echo ""
  read -rp "  Press Enter to open https://claude.ai/code in your browser, or Ctrl+C to exit: "
  open "https://claude.ai/code" 2>/dev/null || true
  error "Please install Claude Code and re-run the installer."
fi
success "Claude Code $(claude --version 2>/dev/null | head -1 || echo 'installed')"

# Check if already logged in by looking for an OAuth token
CLAUDE_TOKEN_FILE="$HOME/.claude/.credentials.json"
CLAUDE_CONFIG_DIR="$HOME/.claude"
TOKEN_FOUND=false
OAUTH_TOKEN=""

# Try to read token from Claude Code's credentials file
if [[ -f "$CLAUDE_TOKEN_FILE" ]]; then
  # Extract oauth token if present (claude stores it as JSON)
  OAUTH_TOKEN=$(python3 -c "
import json, sys
try:
    data = json.load(open('$CLAUDE_TOKEN_FILE'))
    # Try common key names
    for key in ['oauth_token', 'token', 'access_token', 'claudeAiOauthToken']:
        if key in data:
            print(data[key])
            sys.exit(0)
    # Nested structures
    if 'primaryAccount' in data:
        acc = data['primaryAccount']
        for key in ['oauth_token', 'token', 'access_token', 'claudeAiOauthToken']:
            if key in acc:
                print(acc[key])
                sys.exit(0)
except Exception:
    pass
" 2>/dev/null || true)
fi

# Also check if CLAUDE_CODE_OAUTH_TOKEN is already in environment
if [[ -z "$OAUTH_TOKEN" && -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN"
fi

# Try running claude to get the token via setup-token
if [[ -n "$OAUTH_TOKEN" ]]; then
  TOKEN_FOUND=true
  success "Claude Code session detected — reusing existing login"
else
  warn "No active Claude Code session found."
  echo ""
  echo "  Luna uses your Claude.ai subscription (Pro or higher)."
  echo "  You need to log in to Claude Code to continue."
  echo ""
  echo "  Running: claude login"
  echo ""

  if claude login 2>/dev/null; then
    success "Logged in to Claude Code"

    # Re-check for token after login
    if [[ -f "$CLAUDE_TOKEN_FILE" ]]; then
      OAUTH_TOKEN=$(python3 -c "
import json, sys
try:
    data = json.load(open('$CLAUDE_TOKEN_FILE'))
    for key in ['oauth_token', 'token', 'access_token', 'claudeAiOauthToken']:
        if key in data:
            print(data[key])
            sys.exit(0)
    if 'primaryAccount' in data:
        acc = data['primaryAccount']
        for key in ['oauth_token', 'token', 'access_token', 'claudeAiOauthToken']:
            if key in acc:
                print(acc[key])
                sys.exit(0)
except Exception:
    pass
" 2>/dev/null || true)
    fi

    if [[ -n "$OAUTH_TOKEN" ]]; then
      TOKEN_FOUND=true
    fi
  fi

  if [[ "$TOKEN_FOUND" == false ]]; then
    echo ""
    warn "Could not automatically retrieve your OAuth token."
    echo ""
    echo "  You can get it manually by running:"
    echo "    claude setup-token"
    echo ""
    read -rp "  Paste your OAuth token here (or press Enter to skip and configure later): " MANUAL_TOKEN
    if [[ -n "$MANUAL_TOKEN" ]]; then
      OAUTH_TOKEN="$MANUAL_TOKEN"
      TOKEN_FOUND=true
      success "Token accepted"
    else
      warn "Skipping auth setup — you'll need to configure this before Luna can run."
      warn "See: bun run --filter '@luna/agent-cli' luna-account add"
    fi
  fi
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
# OAuth token is managed via Claude Code — do not paste it here.
# To re-authenticate: claude login

# Store Claude Code session history, memory, and settings under ~/.luna/
# so everything Luna-related stays in one place.
CLAUDE_CONFIG_DIR=$LUNA_DATA/claude
EOF
  success ".env created"
else
  # Add CLAUDE_CONFIG_DIR to existing .env if not already present
  if ! grep -q "CLAUDE_CONFIG_DIR" "$LUNA_DATA/.env" 2>/dev/null; then
    printf '\n# Store Claude Code session history, memory, and settings under ~/.luna/\nCLAUDE_CONFIG_DIR=%s/claude\n' "$LUNA_DATA" >> "$LUNA_DATA/.env"
    success ".env updated with CLAUDE_CONFIG_DIR"
  else
    success ".env already exists"
  fi
fi

# Ensure the Claude config directory exists
mkdir -p "$LUNA_DATA/claude"

# ── personal DNA.md ───────────────────────────────────────────────────────────
header "🧬 Identity (DNA.md)"
echo ""
echo "  Luna's identity file tells it who you are and how you like to work."
echo "  It's loaded into every chat thread as part of the system prompt."
echo ""

if [[ -f "$LUNA_DATA/DNA.md" ]]; then
  success "DNA.md already exists at $LUNA_DATA/DNA.md"
  read -rp "  Re-configure it now? [y/N] " RECONFIGURE
  [[ "${RECONFIGURE,,}" == "y" ]] || { echo "  Keeping existing DNA.md."; DNA_DONE=true; }
fi

if [[ "${DNA_DONE:-false}" == false ]]; then
  # Copy the base template
  cp "$LUNA_DIR/DNA.md" "$LUNA_DATA/DNA.md"

  echo "  Answer a few questions to personalise Luna for you."
  echo "  (Press Enter to skip any field.)"
  echo ""

  read -rp "  Your name:                " DNA_NAME
  read -rp "  GitHub username:          " DNA_GITHUB
  read -rp "  Discord username:         " DNA_DISCORD
  read -rp "  Preferred communication   "
  read -rp "    style (e.g. 'concise,   "
  read -rp "    bullet points'):        " DNA_STYLE

  # Build the User section
  USER_SECTION=""
  if [[ -n "$DNA_NAME" || -n "$DNA_GITHUB" || -n "$DNA_DISCORD" || -n "$DNA_STYLE" ]]; then
    USER_SECTION+="\n## User\n\n"
    [[ -n "$DNA_NAME" ]]    && USER_SECTION+="- **${DNA_NAME}**\n"
    [[ -n "$DNA_GITHUB" ]]  && USER_SECTION+="- GitHub: \`${DNA_GITHUB}\`\n"
    [[ -n "$DNA_DISCORD" ]] && USER_SECTION+="- Discord: \`${DNA_DISCORD}\`\n"
    USER_SECTION+="- Repo: \`~/Projects/luna/\`. User data: \`~/.luna/\`.\n"
    if [[ -n "$DNA_STYLE" ]]; then
      USER_SECTION+="- Communication style: ${DNA_STYLE}.\n"
    else
      USER_SECTION+="- Communication style: friendly, practical, markdown with structure.\n"
    fi
  fi

  if [[ -n "$USER_SECTION" ]]; then
    printf "\n%b" "$USER_SECTION" >> "$LUNA_DATA/DNA.md"
    NAME_DISPLAY="${DNA_NAME:-user}"
    success "DNA.md personalised for $NAME_DISPLAY"
  else
    success "DNA.md created from template (edit ~/.luna/DNA.md to personalise)"
  fi

  echo ""
  echo "  ✏️  You can edit it anytime: open ~/.luna/DNA.md"
fi

# ── TODO.md ───────────────────────────────────────────────────────────────────
header "📋 Task list (TODO.md)"
if [[ -f "$LUNA_DATA/TODO.md" ]]; then
  success "TODO.md already exists at $LUNA_DATA/TODO.md"
else
  cp "$LUNA_DIR/TODO.md" "$LUNA_DATA/TODO.md"
  success "TODO.md created at $LUNA_DATA/TODO.md"
  echo "  ✏️  Your task list: open ~/.luna/TODO.md"
fi

# ── agent definitions ─────────────────────────────────────────────────────────
header "🤖 Agent definitions"
mkdir -p "$LUNA_DATA/agents"
# Copy each bundled agent only if it doesn't already exist in ~/.luna/agents/
# This lets users customise their agents without getting them overwritten on re-install,
# while still picking up new bundled agents added in future Luna versions.
for agent_src in "$LUNA_DIR/agents/"*.md; do
  agent_name="$(basename "$agent_src")"
  agent_dst="$LUNA_DATA/agents/$agent_name"
  if [[ -f "$agent_dst" ]]; then
    info "Keeping existing $agent_name"
  else
    cp "$agent_src" "$agent_dst"
    success "Installed agent: $agent_name"
  fi
done
echo "  ✏️  Customise agents: open ~/.luna/agents/"

# ── register Luna account ─────────────────────────────────────────────────────
header "🔐 Luna account setup"
if [[ "$TOKEN_FOUND" == true && -n "$OAUTH_TOKEN" ]]; then
  # Write token to a temp env and register the account
  info "Registering your Claude.ai account with Luna..."

  # Store token reference in .env for the CLI to use
  if ! grep -q "CLAUDE_CODE_OAUTH_TOKEN" "$LUNA_DATA/.env" 2>/dev/null; then
    echo "" >> "$LUNA_DATA/.env"
    echo "# Claude Code OAuth token (managed by installer — update via: claude login)" >> "$LUNA_DATA/.env"
    echo "CLAUDE_CODE_OAUTH_TOKEN=$OAUTH_TOKEN" >> "$LUNA_DATA/.env"
  fi

  CLAUDE_CODE_OAUTH_TOKEN="$OAUTH_TOKEN" \
    bun run --cwd "$LUNA_DIR" --filter '@luna/agent-cli' luna-account add \
      --id default \
      --label "Claude.ai" \
      --kind anthropic \
      --secret-ref "env:CLAUDE_CODE_OAUTH_TOKEN" 2>/dev/null && \
    success "Account registered: Claude.ai (default)" || \
    warn "Account registration skipped — you can register manually later"
else
  warn "Skipping account registration (no token available)"
  echo "  Run after install: bun run --filter '@luna/agent-cli' luna-account add"
fi

# ── launchd daemon ────────────────────────────────────────────────────────────
header "🚀 Background service"
LOG_OUT="$LUNA_DATA/logs/luna-web.log"
LOG_ERR="$LUNA_DATA/logs/luna-web-error.log"

BUN_PATH="$(command -v bun)"
BUN_DIR="$(dirname "$BUN_PATH")"

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
    <string>${BUN_PATH}</string>
    <string>run</string>
    <string>--filter</string>
    <string>@luna/ui-web</string>
    <string>server:chat</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${LUNA_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:${BUN_DIR}</string>
    <key>CLAUDE_CONFIG_DIR</key>
    <string>${LUNA_DATA}/claude</string>
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
success "Service plist written"

if launchctl list 2>/dev/null | grep -q "$LAUNCHD_LABEL"; then
  info "Reloading existing service..."
  launchctl unload "$LAUNCHD_PLIST" 2>/dev/null || true
fi
launchctl load "$LAUNCHD_PLIST"
success "Service started: $LAUNCHD_LABEL"

# ── luna CLI shortcut ─────────────────────────────────────────────────────────
header "🖥  Luna CLI"
LUNA_OPEN="$HOME/.local/bin/luna"
mkdir -p "$(dirname "$LUNA_OPEN")"
cat > "$LUNA_OPEN" <<'SCRIPT'
#!/usr/bin/env bash
# Open Luna web UI
open http://localhost:5174
SCRIPT
chmod +x "$LUNA_OPEN"
success "luna command → $LUNA_OPEN"

# Remind about PATH if needed
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  warn "Add ~/.local/bin to your PATH:"
  echo "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
fi

# ── done ─────────────────────────────────────────────────────────────────────
header "✅ Luna installed"
echo ""
echo -e "  ${BOLD}Luna is running as a background service.${RESET}"
echo ""
echo "  Open the UI:    luna   (or visit http://localhost:5174)"
echo "  Logs:           $LOG_OUT"
echo "  Identity:       edit ~/.luna/DNA.md"
echo "  Re-auth:        claude login  (then restart Luna)"
echo "  Restart:        launchctl kickstart -k gui/\$(id -u)/${LAUNCHD_LABEL}"
echo ""
echo -e "  ${GREEN}🌙 Welcome to Luna.${RESET}"
echo ""
