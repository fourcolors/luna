#!/usr/bin/env bash
# launchd-plist.sh — render a macOS LaunchAgent plist for the Luna chat server.
#
# Sourced by install-mac.command. Defines a function only (no auto-run), so it is
# safe to `source` into a `set -euo pipefail` script and to exercise in tests.
#
# Why this exists (finding #2): the desktop install launched the chat server with
# an unsupervised `nohup … &`, so it died on reboot/crash AND the in-app Restart
# button was inert — control.restart (packages/control-server) shells out to
#   launchctl kickstart -k gui/<uid>/com.user.luna-chat-server
# expecting a launchd-managed LaunchAgent that never existed. This renders that
# LaunchAgent so the server is supervised, survives login, and Restart works —
# parity with the container/systemd path.
#
# NOTE: launchd is NOT systemd. There is no `Restart=OnFailure` key (that was a
# systemd-ism in an early sketch). Supervision is expressed with `KeepAlive`:
# `<true/>` means "always respawn", matching the systemd unit's Restart=always.
#
# KeepAlive was originally `{ SuccessfulExit = false }` ("respawn unless exit
# 0", pairing with the graceful SIGTERM→exit-0 handler). That pairing is the
# exact mechanism that kept the Sol agent dead for 50 days: an fd-exhaustion
# cascade ended in SIGTERM → gracefulShutdown() → exit(0), and launchd
# treated the clean exit as "stay stopped" — a graceful shutdown is precisely
# the case a supervisor must NOT interpret as intentional. Intentional stops
# have their own verb (`launchctl bootout`), which removes the job entirely
# and is unaffected by KeepAlive. `launchctl kickstart -k` force-restarts
# regardless.

# render_launchd_plist <bun_bin> <luna_dir> <luna_home>
# Print the LaunchAgent plist XML to stdout.
render_launchd_plist() {
  local bun_bin="$1" luna_dir="$2" luna_home="$3"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.luna-chat-server</string>
    <key>ProgramArguments</key>
    <array>
        <string>$bun_bin</string>
        <string>run</string>
        <string>--cwd</string>
        <string>$luna_dir/apps/ui-web</string>
        <string>scripts/chat-server.ts</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$luna_home/logs/server.log</string>
    <key>StandardErrorPath</key>
    <string>$luna_home/logs/server.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>LUNA_HOME</key>
        <string>$luna_home</string>
        <key>CLAUDE_CONFIG_DIR</key>
        <string>$luna_home/claude</string>
        <key>PATH</key>
        <string>$(dirname "$bun_bin"):/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF
}
