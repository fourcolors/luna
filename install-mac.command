#!/usr/bin/env bash
# macOS Double-Click Installer for Luna
#
# Sets up Luna client, server, or both natively on macOS.
# Can be double-clicked in Finder or executed from Terminal.

set -euo pipefail

# Ensure working directory is set to the folder containing this script
cd "$(dirname "$0")" || exit 1

# Colors for premium CLI aesthetics
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Helper functions
info() { printf "${CYAN}-> %b${NC}\n" "$*"; }
success() { printf "${GREEN}✓ %b${NC}\n" "$*"; }
warn() { printf "${YELLOW}warning: %b${NC}\n" "$*" >&2; }
error() { printf "${RED}error: %b${NC}\n" "$*" >&2; }
die() { error "$*"; exit 1; }

# Shared, SIGPIPE-safe UI-WS-token generator (defines gen_ui_ws_token).
# Sourced, not executed (the script already cd'd to its own dir above).
source scripts/lib/gen-token.sh

# Identity-checked, graceful port-conflict guard (defines ensure_port_free).
# Supersedes the old preflight that force-killed whatever held the port —
# including, on a Tailscale box, the daemon that reaches a remote Luna (#7).
source scripts/lib/port-guard.sh

# Renders the launchd LaunchAgent that supervises the chat server, so it survives
# login/crash and the in-app Restart button works (defines render_launchd_plist, #2).
source scripts/lib/launchd-plist.sh

clear
# Premium ASCII Banner with Luna Moon
printf "${CYAN}%s${NC}\n" "
██╗     ██╗   ██╗███╗   ██╗ █████╗       _.._
██║     ██║   ██║████╗  ██║██╔══██╗    .' .-'\\\`
██║     ██║   ██║██╔██╗ ██║███████║   /  /
██║     ██║   ██║██║╚██╗██║██╔══██║  |  |
███████╗╚██████╔╝██║ ╚████║██║  ██║   \\\\  \\\\
╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝    '. '-,_
                                         \\\`''\\\`
"
printf "${BOLD}${GREEN}      Luna Premium macOS Onboarding & Installer${NC}\n"
printf "--------------------------------------------------------\n\n"

# Requirement check: Git
if ! command -v git >/dev/null 2>&1; then
  info "Git is required to download/update Luna dependencies."
  warn "Git not found on your system."
  info "Prompting for macOS Command Line Tools installation..."
  xcode-select --install || true
  die "Please follow the on-screen dialog to install Xcode Command Line Tools, then open this installer again."
fi
success "Git is available."

# Requirement check: Bun
if ! command -v bun >/dev/null 2>&1 && [[ ! -x "$HOME/.bun/bin/bun" ]]; then
  info "Bun (runtime manager) is required but not installed."
  info "Installing Bun via https://bun.sh/install..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
else
  export PATH="$HOME/.bun/bin:$PATH"
fi
success "Bun is available ($(bun --version))."

# Render the interactive menu
printf "${BOLD}Please select your installation profile:${NC}\n\n"
printf "  ${BOLD}[1] Complete Desktop Install (Recommended)${NC}\n"
printf "      - Runs client and server natively on your Mac.\n"
printf "      - Automatically opens the web UI browser tab.\n"
printf "      - Guides you through the Claude subscription login.\n\n"
printf "  ${BOLD}[2] Remote Server Client (Client-Only)${NC}\n"
printf "      - Connects your Mac CLI to a remote Luna server.\n"
printf "      - Configures URLs and access tokens.\n\n"
printf "  ${BOLD}[3] Separated Client / Server (Advanced / Custom)${NC}\n"
printf "      - Installs client wrapper only.\n"
printf "      - Prints manual server deployment instructions.\n\n"
printf "  ${BOLD}[4] Luna Moon — native floating widget (Recommended)${NC}\n"
printf "      - Installs and starts the supervised local server (launchd).\n"
printf "      - Launches the Luna Moon floating widget.\n"
printf "      - Token is auto-configured — no settings to paste.\n"
printf "      - Requires Rust/cargo + cargo-tauri.\n\n"

read -p "Selection [1-4]: " -r SELECTION
printf "\n"

LUNA_DIR="$(pwd)"
LUNA_DATA="$HOME/.luna"
ENV_FILE="$LUNA_DATA/.env"

case "$SELECTION" in
  1)
    # launchd identifiers for the supervised chat server (#2). Defined up front so
    # the early bootout below and the bootstrap later share them.
    LAUNCHD_LABEL="com.user.luna-chat-server"
    LAUNCHD_DOMAIN="gui/$(id -u)"
    # If a prior install left a launchd-supervised chat server, remove it FIRST so
    # the port guard below isn't fighting launchd's KeepAlive respawn (#2/#7).
    launchctl bootout "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" 2>/dev/null || true

    info "Probing local ports to prevent conflict crash-loops..."
    # Identity-checked + graceful: only stop a stale instance of THIS install
    # (SIGTERM-first); refuse and abort if a FOREIGN process holds the port —
    # e.g. on a box where Tailscale binds :4753 to reach a remote Luna (#7).
    ensure_port_free 4753 "Luna Chat Server" "$LUNA_DIR" || exit 1
    ensure_port_free 5174 "Vite Web UI" "$LUNA_DIR" || exit 1

    info "Starting Complete Desktop Install..."
    
    # Run the core installer script against current directory
    chmod +x install.sh
    # Finding #4: a desktop install runs the server locally, so point the CLI at
    # the local server instead of install.sh's remote jax-box default. Override
    # BOTH the primary and fallback URL — leaving the fallback default would
    # re-leak ws://jax-box.local:4753/ui as the CLI's second connection target.
    # Use 127.0.0.1 (not localhost): the server binds IPv4 127.0.0.1, and
    # `localhost` can resolve to IPv6 ::1 first on macOS and miss it. The two
    # identical URLs dedup to a single entry in the CLI's url list.
    ./install.sh --luna-dir "$LUNA_DIR" \
      --stable-url ws://127.0.0.1:4753/ui \
      --stable-fallback-url ws://127.0.0.1:4753/ui

    # Make sure required state paths exist
    mkdir -p "$LUNA_DATA" "$LUNA_DATA/logs" "$LUNA_DATA/run" "$LUNA_DATA/claude"
    
    # Seed a secure, random UI WebSocket token if one doesn't exist
    # Anchor ^UI_WS_TOKEN= so a pre-existing .env carrying only a profiled
    # LUNA_*_UI_WS_TOKEN= line doesn't substring-match and suppress the seed (#6).
    if [[ ! -f "$ENV_FILE" ]] || ! grep -q "^UI_WS_TOKEN=" "$ENV_FILE" 2>/dev/null; then
      info "Generating a secure, random 32-character UI WebSocket token..."
      # Clean 32-char hex via the shared SIGPIPE-safe generator.
      TOKEN="$(gen_ui_ws_token)"
      
      # Use temp file to safely upsert
      touch "$ENV_FILE"
      chmod 600 "$ENV_FILE"
      
      # Upsert the CANONICAL single-box token (finding #6). UI_WS_TOKEN is the
      # server's own secret AND the value the CLI's default "stable" profile
      # resolves via its UI_WS_TOKEN dotenv fallback — so on this one-box install
      # this single write feeds both reader and writer. No redundant per-profile
      # LUNA_STABLE_UI_WS_TOKEN copy is needed (that name is for REMOTE clients,
      # written by install.sh, where a client box has no local server token).
      tmp_env="$(mktemp "$LUNA_DATA/env.tmp.XXXXXX")"
      awk -v token="$TOKEN" '
        BEGIN { replaced = 0 }
        index($0, "UI_WS_TOKEN=") == 1 { print "UI_WS_TOKEN=" token; replaced = 1; next }
        { print }
        END { if (replaced == 0) print "UI_WS_TOKEN=" token }
      ' "$ENV_FILE" > "$tmp_env"
      mv "$tmp_env" "$ENV_FILE"
      chmod 600 "$ENV_FILE"
    fi
    
    # Read the token for background startup injection
    TOKEN=$(awk -F= '$1 == "UI_WS_TOKEN" {print $2}' "$ENV_FILE")
    
    info "Installing a launchd LaunchAgent so the chat server is supervised..."
    # Supervise the chat server via launchd (finding #2): it survives login and
    # crashes, and the in-app Restart button works — control.restart kickstarts
    # this exact label in the gui/<uid> domain. Replaces the old unsupervised
    # nohup. The server reads its token from ~/.luna/.env via LUNA_HOME (set in
    # the plist), so no token is baked into the LaunchAgent.
    BUN_BIN="$(command -v bun)"
    PLIST_FILE="$LUNA_DATA/$LAUNCHD_LABEL.plist"
    render_launchd_plist "$BUN_BIN" "$LUNA_DIR" "$LUNA_DATA" > "$PLIST_FILE"
    chmod 644 "$PLIST_FILE"
    # bootout any prior instance, clear a lingering disable, then bootstrap into
    # the gui/<uid> domain (modern launchctl; load/unload are deprecated).
    launchctl bootout "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" 2>/dev/null || true
    launchctl enable "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" 2>/dev/null || true
    launchctl bootstrap "$LAUNCHD_DOMAIN" "$PLIST_FILE" \
      || die "Could not load the Luna LaunchAgent. Run manually: launchctl bootstrap $LAUNCHD_DOMAIN '$PLIST_FILE'"
    success "Chat server is supervised by launchd (Restart button now works)."
    
    info "Launching local Vite web UI dev server in the background..."
    # Start the Vite dev server on :5174 — the port vite.config.ts actually
    # binds (an earlier installer assumed the wrong port and never reached it).
    VITE_UI_WS_TOKEN="$TOKEN" nohup bun run --cwd "$LUNA_DIR/apps/ui-web" dev > "$LUNA_DATA/logs/ui.log" 2>&1 &
    UI_PID=$!
    disown $UI_PID

    success "Local processes booted successfully."
    info "Waiting for web UI server to start (http://localhost:5174)..."
    count=0
    max_wait=20
    while ! curl -fs http://localhost:5174 >/dev/null 2>&1; do
      sleep 0.5
      count=$((count + 1))
      if [[ $count -ge $max_wait ]]; then
        warn "Web UI server is taking longer than expected to start. Launching browser anyway..."
        break
      fi
    done
    
    info "Opening your default browser to the web chat interface..."
    open "http://localhost:5174"
    
    success "Complete desktop installation finished successfully!"
    printf "\n"
    printf "  - Client Wrapper: ${CYAN}luna chat${NC}\n"
    printf "  - Server log:     ${CYAN}tail -f ~/.luna/logs/server.log${NC}\n"
    printf "  - UI log:         ${CYAN}tail -f ~/.luna/logs/ui.log${NC}\n"
    printf "  - Web Chat URL:   ${CYAN}http://localhost:5174${NC}\n\n"
    printf "${GREEN}If the credential was missing, the web page will guide you through Claude subscription login in setup-mode. Paste the authorization token into the embedded terminal to complete onboarding!${NC}\n"
    ;;

  2)
    info "Starting Remote Server Client Setup..."
    
    # Prompt for remote host credentials
    read -p "Enter remote WebSocket URL [e.g. ws://jax-box:4753/ui]: " -r WS_URL
    read -p "Enter remote UI WebSocket Token: " -r WS_TOKEN
    
    if [[ -z "$WS_URL" || -z "$WS_TOKEN" ]]; then
      die "WebSocket URL and access token are both required."
    fi
    
    # Run the client installer
    chmod +x install.sh
    ./install.sh --luna-dir "$LUNA_DIR" \
      --stable-url "$WS_URL" \
      --stable-token "$WS_TOKEN"
      
    success "Remote client configuration loaded."
    printf "\n"
    printf "  - Config File:    ${CYAN}~/.luna/.env${NC}\n"
    printf "  - Command:        ${CYAN}luna chat${NC}\n\n"
    ;;

  3)
    info "Starting Separated Client Installation..."
    
    # Run the core installer client-only
    chmod +x install.sh
    ./install.sh --luna-dir "$LUNA_DIR" --skip-deps
    
    success "Local client installed."
    printf "\n"
    printf "${BOLD}To deploy the Luna server separately, follow these steps:${NC}\n\n"
    printf "  1. On your remote Linux host/container, clone this repository:\n"
    printf "     ${CYAN}git clone https://github.com/fourcolors/luna.git /root/luna${NC}\n\n"
    printf "  2. Run the server installer script:\n"
    printf "     ${CYAN}scripts/luna-server-install --profile stable --token '<ui-ws-token>'${NC}\n\n"
    printf "  3. Set up the local Mac client to point to the remote host:\n"
    printf "     ${CYAN}luna chat --stable-url ws://<remote-ip>:4753/ui${NC}\n\n"
    ;;

  4)
    info "Starting Luna Moon native widget install..."

    # Prerequisites: Rust toolchain + cargo-tauri CLI.
    command -v cargo >/dev/null 2>&1 \
      || die "Rust/cargo is required. Install it from https://rustup.rs and re-run."
    command -v cargo-tauri >/dev/null 2>&1 \
      || die "cargo-tauri CLI is required: cargo install tauri-cli  (then re-run)"

    # Core client install: clone/pull, bun install, write .env with localhost URLs.
    chmod +x install.sh
    ./install.sh --luna-dir "$LUNA_DIR" \
      --stable-url ws://127.0.0.1:4753/ui \
      --stable-fallback-url ws://127.0.0.1:4753/ui

    # Ensure state dirs exist.
    mkdir -p "$LUNA_DATA" "$LUNA_DATA/logs" "$LUNA_DATA/run" "$LUNA_DATA/claude"

    # Seed the canonical token if not already present.
    if [[ ! -f "$ENV_FILE" ]] || ! grep -q "^UI_WS_TOKEN=" "$ENV_FILE" 2>/dev/null; then
      info "Generating a secure UI WebSocket token..."
      TOKEN="$(gen_ui_ws_token)"
      touch "$ENV_FILE"
      chmod 600 "$ENV_FILE"
      tmp_env="$(mktemp "$LUNA_DATA/env.tmp.XXXXXX")"
      awk -v t="$TOKEN" '
        BEGIN { r=0 }
        index($0, "UI_WS_TOKEN=") == 1 { print "UI_WS_TOKEN=" t; r=1; next }
        { print }
        END { if (r == 0) print "UI_WS_TOKEN=" t }
      ' "$ENV_FILE" > "$tmp_env"
      mv "$tmp_env" "$ENV_FILE"
      chmod 600 "$ENV_FILE"
    fi
    TOKEN="$(awk -F= '$1 == "UI_WS_TOKEN" {print $2}' "$ENV_FILE")"

    # Boot the supervised chat server via launchd (same path as option 1).
    LAUNCHD_LABEL="com.user.luna-chat-server"
    LAUNCHD_DOMAIN="gui/$(id -u)"
    launchctl bootout "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" 2>/dev/null || true

    info "Installing a launchd LaunchAgent for the chat server..."
    BUN_BIN="$(command -v bun)"
    PLIST_FILE="$LUNA_DATA/$LAUNCHD_LABEL.plist"
    render_launchd_plist "$BUN_BIN" "$LUNA_DIR" "$LUNA_DATA" > "$PLIST_FILE"
    chmod 644 "$PLIST_FILE"
    launchctl bootout  "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" 2>/dev/null || true
    launchctl enable   "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" 2>/dev/null || true
    launchctl bootstrap "$LAUNCHD_DOMAIN" "$PLIST_FILE" \
      || die "Could not load the Luna LaunchAgent. Try: launchctl bootstrap $LAUNCHD_DOMAIN '$PLIST_FILE'"
    success "Chat server is supervised by launchd."

    # Wait for the server to bind on loopback.
    info "Waiting for chat server to start (ws://127.0.0.1:4753)..."
    count=0
    max_wait=30
    while ! lsof -t -i @127.0.0.1:4753 -sTCP:LISTEN >/dev/null 2>&1; do
      sleep 0.5
      count=$((count + 1))
      if [[ $count -ge $max_wait ]]; then
        warn "Server is taking longer than expected. Launching the widget anyway..."
        break
      fi
    done

    # First-run credential hint: if luna.db doesn't exist the server is in
    # setup-mode and the moon widget won't be able to chat yet.
    if [[ ! -s "$LUNA_DATA/luna.db" ]]; then
      warn "No Claude account found — the server is in setup-mode."
      warn "Open the web UI to log in first, then the widget will be ready to chat."
      info "Starting Vite web UI for one-time Claude login..."
      VITE_UI_WS_TOKEN="$TOKEN" nohup bun run --cwd "$LUNA_DIR/apps/ui-web" dev \
        > "$LUNA_DATA/logs/ui.log" 2>&1 &
      disown $!
      open "http://localhost:5174"
      info "Log in via the browser, then relaunch the installer to start Luna Moon."
    fi

    # Launch the Luna Moon native widget via tauri dev.
    # The Rust backend will emit a 'luna-config' event to the webview, seeding
    # the token from ~/.luna/.env so no manual settings-panel input is needed.
    info "Launching Luna Moon native widget (this may take a moment on first compile)..."
    cargo tauri dev \
      --manifest-path "$LUNA_DIR/apps/ui-moon-tauri/src-tauri/Cargo.toml" \
      > "$LUNA_DATA/logs/moon.log" 2>&1 &
    MOON_PID=$!
    disown $MOON_PID

    success "Luna Moon is starting!"
    printf "\n"
    printf "  - The floating moon widget will appear shortly (press CmdOrCtrl+Shift+K to toggle).\n"
    printf "  - Server log: ${CYAN}tail -f ~/.luna/logs/server.log${NC}\n"
    printf "  - Moon log:   ${CYAN}tail -f ~/.luna/logs/moon.log${NC}\n\n"
    ;;

  *)
    die "Invalid selection: $SELECTION"
    ;;
esac
