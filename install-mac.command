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
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Helper functions
info() { printf "${CYAN}-> %b${NC}\n" "$*"; }
success() { printf "${GREEN}✓ %b${NC}\n" "$*"; }
warn() { printf "${YELLOW}warning: %b${NC}\n" "$*" >&2; }
error() { printf "${RED}error: %b${NC}\n" "$*" >&2; }
die() { error "$*"; exit 1; }

# Claude Code CLI preflight (#24). Options 1 & 4 boot a local Luna server whose
# setup-mode login needs one manual, terminal-only round trip this installer
# cannot do for the user: run `claude setup-token` (browser OAuth), register
# the result with `luna account add --id default --label Default --kind
# anthropic --secret-ref claude-code:login`, then restart the server so the
# boot-time gate (apps/server/src/credential-readiness.ts) re-reads the
# accounts table. Luna Moon's setup wizard only walks through CONNECTING Moon
# to the server - it has no PTY client and cannot itself seed that row - so
# without the `claude` binary this login has no path forward on a clean Mac.
# Mirror the server's own resolver order (scripts/lib/luna-deploy.sh:
# luna_find_claude_executable):
#   1) an explicit, executable LUNA_CLAUDE_CODE_EXECUTABLE, then
#   2) `claude` on PATH, then
#   3) a known install path the official Claude Code installer uses.
# The known-path fallback is load-bearing: double-clicked from Finder this
# script runs with a minimal PATH (~/.local/bin and ~/.claude/local are NOT on
# it), so a correctly-installed `claude` would false-fail a bare `command -v`.
# Use ${VAR:-} so the optional env var doesn't trip `set -u` when unset.
#
# On success the absolute, resolved path is printed to stdout so the caller can
# persist it (see persist_claude_executable). This is required for closure, not
# cosmetic: the launchd-supervised server (scripts/lib/launchd-plist.sh) runs
# with a hardcoded minimal PATH that does NOT include ~/.local/bin or
# ~/.claude/local, so a server that spawns bare `claude` would still dead-end
# even after this preflight "passes" via the known-path fallback.
resolve_claude_cli() {
  if [[ -n "${LUNA_CLAUDE_CODE_EXECUTABLE:-}" && -x "${LUNA_CLAUDE_CODE_EXECUTABLE:-}" ]]; then
    printf '%s\n' "${LUNA_CLAUDE_CODE_EXECUTABLE}"
    return 0
  fi
  if command -v claude >/dev/null 2>&1; then
    command -v claude
    return 0
  fi
  local candidate
  for candidate in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# Fail-fast preflight: die with guidance if no usable `claude` binary exists.
require_claude_cli() {
  if resolve_claude_cli >/dev/null; then
    return 0
  fi
  info "The one-time login runs \`claude setup-token\` in a terminal - this preflight only needs the \`claude\` binary present."
  die "Claude Code CLI required for the one-time login - install it from https://claude.ai/code, then re-run this installer."
}

# Persist the resolved `claude` absolute path into ~/.luna/.env as
# LUNA_CLAUDE_CODE_EXECUTABLE so the launchd-supervised server (which runs with a
# minimal PATH that omits ~/.local/bin and ~/.claude/local) can still spawn the
# binary for `claude setup-token`. chat-server.ts loads ~/.luna/.env on boot and
# only fills keys NOT already in its env; the plist doesn't set this key, so this
# value wins. Must be called AFTER install.sh + the token upsert so it isn't
# clobbered. Always pins the resolved ABSOLUTE path (idempotent upsert) so the
# server never depends on its own PATH containing `claude`; no-ops only if
# nothing resolves (require_claude_cli already died in that case for opts 1/4).
persist_claude_executable() {
  local env_file="$1"
  local resolved
  resolved="$(resolve_claude_cli)" || return 0

  mkdir -p "$(dirname "$env_file")"
  touch "$env_file"
  chmod 600 "$env_file"
  local tmp
  tmp="$(mktemp "$(dirname "$env_file")/env.tmp.XXXXXX")"
  awk -v val="$resolved" '
    BEGIN { replaced = 0 }
    index($0, "LUNA_CLAUDE_CODE_EXECUTABLE=") == 1 { print "LUNA_CLAUDE_CODE_EXECUTABLE=" val; replaced = 1; next }
    { print }
    END { if (replaced == 0) print "LUNA_CLAUDE_CODE_EXECUTABLE=" val }
  ' "$env_file" > "$tmp"
  mv "$tmp" "$env_file"
  chmod 600 "$env_file"
}

# wait_for_readyz <port>
# Poll the chat server's /readyz endpoint (HTTP 200) until it answers, or the
# iteration budget runs out. /readyz is a stronger signal than a bound TCP
# port: it proves the HTTP server inside the process is actually serving
# requests, not just that something is listening. Each attempt is capped at
# --max-time 1s - a listening-but-not-yet-serving socket (the launchd cold-boot
# case this loop exists to catch) otherwise hangs the full --max-time on every
# iteration - plus a 0.5s sleep. A dead port refuses INSTANTLY, so the floor
# is max_wait * 0.5s of wall clock; 60 iterations gives a >=30s budget,
# matching the unit's own TimeoutStartSec=60 order of magnitude rather than
# starving a cold first boot that must import the full module graph before
# binding. Silent on success; returns 1 on timeout so the caller can warn
# without aborting the install - a slow-to-boot server is not a failed one.
wait_for_readyz() {
  local port="$1" max_wait=60 count=0
  until curl -fs --max-time 1 "http://127.0.0.1:$port/readyz" >/dev/null 2>&1; do
    sleep 0.5
    count=$((count + 1))
    (( count < max_wait )) || return 1
  done
  return 0
}

# readyz_is_setup_mode <port>
# Fetch the /readyz body ONCE and report whether the server answered in
# setup-mode (no usable Claude credential yet - see
# apps/server/src/credential-readiness.ts), so callers can gate the one-time
# login hint on the SAME signal the server itself uses to choose its boot
# layer, not a proxy like "does luna.db exist" (a returning user with a lapsed
# `claude-code:login` token has a non-empty luna.db and is STILL in
# setup-mode). Defaults to "setup" when the probe fails OR the body doesn't
# parse, so a transient curl error or a reshaped /readyz payload can only
# over-show the hint, never silently suppress it. Extracts the `mode` value
# with a tolerant regex (whitespace- and key-order-independent) instead of a
# raw substring match, so a pretty-printed or reordered /readyz response can't
# silently flip every install into showing a spurious login hint.
readyz_is_setup_mode() {
  local port="$1" body mode
  body="$(curl -fs --max-time 4 "http://127.0.0.1:$port/readyz" 2>/dev/null)" || return 0
  mode="$(printf '%s' "$body" | sed -n 's/.*"mode"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p')"
  [[ "$mode" != "normal" ]]
}

# print_setup_login_steps <launchd_domain/label>
# Print the numbered one-time Claude login recipe (finding #24), shared by
# options 1 and 4 so the wording a new user reads first never drifts between
# the two entry points. `claude setup-token` needs CLAUDE_CONFIG_DIR pinned to
# the SAME directory the launchd-supervised server reads
# (scripts/lib/launchd-plist.sh: $luna_home/claude, and LUNA_DATA above is
# always $HOME/.luna) - a bare `claude setup-token` writes to the CLI's own
# default (~/.claude) instead, so the credential the server probes would stay
# lapsed and setup-mode would never clear. Step 2 uses the wrapper's absolute
# path, not bare `luna`: install.sh only warns when ~/.local/bin is missing
# from PATH, it does not fix PATH, so a bare `luna` can dead-end with "command
# not found" on a clean Mac. Step 2 is first-login-only - a returning user
# with a lapsed token already has the `default` account row (seeded by
# setup-login.ts), so `luna account add` would hit the id conflict; the
# printed note tells them that failure is fine.
print_setup_login_steps() {
  local launchd_target="$1"
  printf "  1. In Terminal:                    ${CYAN}CLAUDE_CONFIG_DIR=~/.luna/claude claude setup-token${NC}\n"
  printf "  2. Register it (first login only): ${CYAN}~/.local/bin/luna account add --id default --label Default --kind anthropic --secret-ref claude-code:login${NC}\n"
  printf "     Already registered? That's fine - the command above says so. Skip to step 3.\n"
  printf "  3. Restart the server:              ${CYAN}launchctl kickstart -k $launchd_target${NC}\n\n"
}

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
printf "      - Starts the supervised chat server (launchd).\n"
printf "      - Points you at Luna Moon to finish login and chat.\n\n"
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
    # Fail fast BEFORE mutating any launchd/port state: a desktop install boots a
    # local server whose in-app login needs the `claude` CLI (#24).
    require_claude_cli

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

    # Persist the resolved `claude` path so the launchd server (minimal PATH) can
    # run setup-token (#24). Done AFTER the token upsert so neither clobbers the
    # other; both feed the same ~/.luna/.env the server loads on boot.
    persist_claude_executable "$ENV_FILE"

    info "Installing a launchd LaunchAgent so the chat server is supervised..."
    # Supervise the chat server via launchd (finding #2): it survives login and
    # crashes, and the in-app Restart button works — control.restart kickstarts
    # this exact label in the gui/<uid> domain. Replaces the old unsupervised
    # nohup. The server reads its token from ~/.luna/.env via LUNA_HOME (set in
    # the plist), so no token is baked into the LaunchAgent.
    BUN_BIN="$(command -v bun)"
    PLIST_FILE="$LUNA_DATA/$LAUNCHD_LABEL.plist"
    # Plist-render rollback: copy an already-installed plist aside as
    # com.user.luna-chat-server.plist.prev before overwriting it, mirroring
    # write_service's unit backup in scripts/luna-server-install. $LUNA_DATA
    # (~/.luna) is not a launchd scan directory - the plist is only ever
    # loaded by the explicit `launchctl bootstrap` call below - so the .prev
    # copy is inert until a manual restore: cp -f "$PLIST_FILE.prev"
    # "$PLIST_FILE" && launchctl bootstrap ...
    # Backup must land BEFORE the render truncates the plist: continuing past
    # a failed cp would leave a stale .prev that the documented restore recipe
    # would then install. Same hard-fail posture as write_service.
    [[ ! -f "$PLIST_FILE" ]] || cp -f "$PLIST_FILE" "$PLIST_FILE.prev" \
      || die "could not back up the existing plist (aborting before overwriting it)"
    render_launchd_plist "$BUN_BIN" "$LUNA_DIR" "$LUNA_DATA" > "$PLIST_FILE"
    chmod 644 "$PLIST_FILE"
    # bootout any prior instance, clear a lingering disable, then bootstrap into
    # the gui/<uid> domain (modern launchctl; load/unload are deprecated).
    launchctl bootout "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" 2>/dev/null || true
    launchctl enable "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" 2>/dev/null || true
    launchctl bootstrap "$LAUNCHD_DOMAIN" "$PLIST_FILE" \
      || die "Could not load the Luna LaunchAgent. Run manually: launchctl bootstrap $LAUNCHD_DOMAIN '$PLIST_FILE'"
    success "Chat server is supervised by launchd (Restart button now works)."

    # Confirm the daemon is actually serving, not just that launchd accepted
    # the bootstrap - /readyz is the same signal scripts/lib/luna-deploy.sh
    # uses to prove a runtime is up.
    info "Waiting for the chat server to become ready (http://127.0.0.1:4753/readyz)..."
    SERVER_READY=0
    if wait_for_readyz 4753; then
      success "Chat server is ready."
      SERVER_READY=1
    else
      warn "Server is taking longer than expected to become ready; check ~/.luna/logs/server.log."
    fi

    success "Complete desktop installation finished successfully!"
    printf "\n"
    printf "  - Client Wrapper: ${CYAN}luna chat${NC}\n"
    printf "  - Server log:     ${CYAN}tail -f ~/.luna/logs/server.log${NC}\n\n"
    printf "${BOLD}Next step:${NC} launch ${CYAN}Luna Moon${NC} to chat - download the floating-widget\n"
    printf "app from ${CYAN}https://github.com/fourcolors/luna/releases${NC} (Apple Silicon), or - if you\n"
    printf "have the Rust toolchain - re-run this installer and pick ${BOLD}[4]${NC}.\n\n"
    # Gated on SERVER_READY: readyz_is_setup_mode fails open to "setup" on a
    # curl error, so probing a server that never answered /readyz would
    # misdiagnose "not up yet" as "no login yet" (#24).
    if [[ "$SERVER_READY" -eq 1 ]]; then
      if readyz_is_setup_mode 4753; then
        printf "${YELLOW}No usable Claude login yet - Moon can connect, but can't chat until you${NC}\n"
        printf "${YELLOW}finish the one-time login:${NC}\n"
        print_setup_login_steps "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL"
      fi
    else
      warn "Could not confirm the server is ready before the timeout."
      info "Once it's up, check it yourself: curl http://127.0.0.1:4753/readyz"
      # Fail OPEN with the recipe: suppressing it on a slow boot would leave a
      # fresh install with NO path to the one-time login (setup-mode has no
      # interactive client since the web UI's removal).
      printf "${YELLOW}If it comes up in setup-mode (no Claude login yet), finish the one-time login:${NC}\n"
      print_setup_login_steps "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL"
    fi
    ;;

  2)
    info "Starting Remote Server Client Setup..."
    
    # Prompt for remote host credentials
    read -p "Enter remote WebSocket URL [e.g. ws://your-server:4753/ui]: " -r WS_URL
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

    # The Moon widget boots the same local server, so its setup-mode login also
    # needs the `claude` CLI — check before booting anything (#24).
    require_claude_cli

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

    # Persist the resolved `claude` path so the launchd server (minimal PATH) can
    # run setup-token (#24) — same reasoning as option 1.
    persist_claude_executable "$ENV_FILE"

    # Boot the supervised chat server via launchd (same path as option 1).
    LAUNCHD_LABEL="com.user.luna-chat-server"
    LAUNCHD_DOMAIN="gui/$(id -u)"
    launchctl bootout "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" 2>/dev/null || true

    info "Installing a launchd LaunchAgent for the chat server..."
    BUN_BIN="$(command -v bun)"
    PLIST_FILE="$LUNA_DATA/$LAUNCHD_LABEL.plist"
    # Plist-render rollback (see option 1's com.user.luna-chat-server.plist.prev
    # backup above for the restore recipe).
    [[ ! -f "$PLIST_FILE" ]] || cp -f "$PLIST_FILE" "$PLIST_FILE.prev" \
      || die "could not back up the existing plist (aborting before overwriting it)"
    render_launchd_plist "$BUN_BIN" "$LUNA_DIR" "$LUNA_DATA" > "$PLIST_FILE"
    chmod 644 "$PLIST_FILE"
    launchctl bootout  "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" 2>/dev/null || true
    launchctl enable   "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" 2>/dev/null || true
    launchctl bootstrap "$LAUNCHD_DOMAIN" "$PLIST_FILE" \
      || die "Could not load the Luna LaunchAgent. Try: launchctl bootstrap $LAUNCHD_DOMAIN '$PLIST_FILE'"
    success "Chat server is supervised by launchd."

    # Confirm the daemon is actually serving, not just that launchd accepted
    # the bootstrap - /readyz is a stronger signal than a bound TCP port.
    info "Waiting for the chat server to become ready (http://127.0.0.1:4753/readyz)..."
    SERVER_READY=0
    if wait_for_readyz 4753; then
      success "Chat server is ready."
      SERVER_READY=1
    else
      warn "Server is taking longer than expected. Launching the widget anyway..."
    fi

    # First-run credential hint: Moon detects setup-mode itself (the WS hello
    # frame's capabilities.setup) and can CONNECT, but its wizard has no PTY
    # client and cannot complete the login on its own - tell the user the
    # manual steps up front rather than let the widget open to a dead end.
    # Gated on SERVER_READY: readyz_is_setup_mode fails open to "setup" on a
    # curl error, so probing a server that never answered /readyz would
    # misdiagnose "not up yet" as "no login yet" (#24).
    if [[ "$SERVER_READY" -eq 1 ]] && readyz_is_setup_mode 4753; then
      warn "No usable Claude login yet - the server is in setup-mode."
      info "Finish the one-time login before Moon can chat:"
      print_setup_login_steps "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL"
    elif [[ "$SERVER_READY" -ne 1 ]]; then
      info "Could not confirm readiness before the timeout; check it yourself later: curl http://127.0.0.1:4753/readyz"
      # Fail OPEN with the recipe (same rationale as option 1): a slow boot
      # must not strand a fresh install without the one-time login steps.
      printf "${YELLOW}If it comes up in setup-mode (no Claude login yet), finish the one-time login:${NC}\n"
      print_setup_login_steps "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL"
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
